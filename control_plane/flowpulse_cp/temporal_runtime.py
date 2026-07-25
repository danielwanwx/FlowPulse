"""Temporal client starter and a bounded local worker dispatcher."""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Protocol

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import ControlActivityDispatcher, build_temporal_activities
from .models import AuthContext, IncidentCase, IncidentIntake, TemporalActivityPacket, TemporalCaseDescriptor, TemporalCaseRequest
from .postgres import PostgresCaseRepository
from .repository import LocalArtifactStore
from .temporal_workflow import DiagnosisTemporalWorkflow


class TemporalStarter:
    def __init__(self, address: str, task_queue: str) -> None:
        self.address = address
        self.task_queue = task_queue

    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        now = datetime.now(timezone.utc)
        workflow_id = "flowpulse.diagnosis:{}:{}".format(actor.tenant_id, intake.external_incident_id)
        case = IncidentCase(
            case_id="case-{}-{}".format(actor.tenant_id, intake.external_incident_id),
            tenant_id=actor.tenant_id,
            workflow_id=workflow_id,
            workflow_run_id=workflow_id,
            severity=intake.severity,
            environment=intake.environment,
            affected_entities=intake.affected_entities,
            created_at=now,
            updated_at=now,
        )
        client = await Client.connect(self.address)
        handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run,
            TemporalCaseRequest(
                case=TemporalCaseDescriptor(
                    case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                    workflow_run_id=case.workflow_run_id, severity=case.severity,
                    environment=case.environment, affected_entities=case.affected_entities,
                ),
                actor=actor,
            ).dict(),
            id=workflow_id,
            task_queue=self.task_queue,
        )
        return case.copy(update={"workflow_run_id": handle.result_run_id})


class LocalP0Dispatcher(ControlActivityDispatcher):
    """Safe local dispatcher for Compose/replay: it has no write capability."""

    async def dispatch(self, stage: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = TemporalActivityPacket.parse_obj(packet_data)
        if stage == "critic_activity":
            return {"decision": "PASS", "identity": "critic:p0:activity"}
        if stage == "independent_verify_activity":
            return {"decision": "PASS", "identity": "verifier:p0:activity"}
        if stage == "owner_gate_activity":
            return {"state": "AWAITING_OWNER", "identity": "owner-gate:p0:activity"}
        return {"decision": "PASS", "stage": stage, "case_id": packet.case_id}


class PostgresActivityDispatcher(LocalP0Dispatcher):
    def __init__(self, repository: PostgresCaseRepository, artifacts: LocalArtifactStore) -> None:
        self.repository = repository
        self.artifacts = artifacts

    async def dispatch(self, stage: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = TemporalActivityPacket.parse_obj(packet_data)
        if stage == "route_case_activity":
            await self.repository.insert_case_if_absent(packet)
        result = await super().dispatch(stage, packet_data)
        # P0's local fake object store is content-addressed and tenant-bound.
        # Production supplies the equivalent S3ObjectStore port at this seam.
        artifact_key = self.artifacts.put(
            packet.tenant_id, json.dumps(packet.dict(), sort_keys=True, default=str).encode("utf-8")
        )
        await self.repository.append_activity_event(packet, result, artifact_key)
        if stage == "independent_verify_activity":
            await self.repository.append_verification(packet, result)
        return result


async def run_worker(address: str, task_queue: str, postgres_dsn: str) -> None:
    client = await Client.connect(address)
    repository = PostgresCaseRepository(postgres_dsn)
    await repository.connect()
    artifacts = LocalArtifactStore(Path(os.environ.get("FLOWPULSE_LOCAL_ARTIFACT_ROOT", "/tmp/flowpulse-artifacts")))
    async with Worker(
        client,
        task_queue=task_queue,
        workflows=[DiagnosisTemporalWorkflow],
        activities=build_temporal_activities(PostgresActivityDispatcher(repository, artifacts)),
    ):
        try:
            await asyncio.Future()
        finally:
            await repository.close()

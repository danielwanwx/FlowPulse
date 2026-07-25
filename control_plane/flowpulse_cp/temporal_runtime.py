"""Temporal starter, real domain activities, and production worker wiring."""

import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, Optional

import boto3
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from .activities import ControlActivityDispatcher, build_temporal_activities
from .integrity import (
    DeterministicCritic,
    EvidenceGateway,
    EvidenceReadbackPort,
    IndependentEvidenceVerifier,
    REQUIRED_COVERAGE,
)
from .models import (
    ActivityOutcome,
    AuthContext,
    CaseState,
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    IncidentIntake,
    InvestigatorAssignment,
    ProofScope,
    SourceKind,
    TemporalActivityPacket,
    TemporalCaseDescriptor,
    TemporalCaseRequest,
    OwnerCommandReceipt,
    OwnerGateCommand,
    VerificationDecision,
)
from .object_store import S3ObjectStore
from .policy import PolicyViolation, validate_owner_gate
from .postgres import PostgresCaseRepository
from .repository import InMemoryCaseRepository
from .source_readback import LocalDeterministicSourceReadback, S3SourceReadback
from .temporal_workflow import DiagnosisTemporalWorkflow


class TemporalStarter:
    def __init__(self, address: str, task_queue: str, local_deterministic_evidence: bool = False) -> None:
        self.address = address
        self.task_queue = task_queue
        self.local_deterministic_evidence = local_deterministic_evidence

    def _local_records(self, case: IncidentCase, actor: AuthContext):
        """Compose-only deterministic fixture; production supplies real adapters."""
        now = case.created_at
        content = "local-current-observation:{}:{}".format(case.case_id, case.case_revision)
        evidence = EvidenceEnvelope(
            evidence_id="evidence-{}".format(case.case_id), case_id=case.case_id,
            case_revision=case.case_revision, tenant_id=case.tenant_id, acl_subjects=[actor.subject_id],
            source_kind=SourceKind.SOURCE_READBACK, source_uri="local://current/{}".format(case.case_id),
            source_anchor="deterministic:1", observed_at=now, effective_at=now, source_version="local-v1",
            content_hash=sha256(content.encode("utf-8")).hexdigest(), authority=EvidenceAuthority.T0,
            freshness=FreshnessStatus.CURRENT, independence_key="local-source:{}".format(case.case_id),
            schema_binding="local.current.v1", proof_scope=ProofScope.CURRENT_OBSERVATION,
        )
        claim = ClaimRecord(
            claim_id="claim-{}".format(case.case_id), case_id=case.case_id, case_revision=case.case_revision,
            tenant_id=case.tenant_id, claim_type="suspected_root_cause", statement="Local deterministic current observation.",
            evidence_ids=[evidence.evidence_id], created_by="primary:p0:deterministic-fake",
        )
        coverage = [
            CoverageEntry(case_id=case.case_id, tenant_id=case.tenant_id, field=field, status=CoverageStatus.FILLED)
            for field in sorted(REQUIRED_COVERAGE)
        ]
        return [evidence], [claim], coverage

    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        now = datetime.now(timezone.utc)
        workflow_id = "flowpulse.diagnosis:{}:{}".format(actor.tenant_id, intake.external_incident_id)
        case = IncidentCase(
            case_id="case-{}-{}".format(actor.tenant_id, intake.external_incident_id), tenant_id=actor.tenant_id,
            workflow_id=workflow_id, workflow_run_id="pending", severity=intake.severity,
            environment=intake.environment, affected_entities=intake.affected_entities, created_at=now, updated_at=now,
        )
        evidence, claims, coverage = ([], [], [])
        if self.local_deterministic_evidence:
            evidence, claims, coverage = self._local_records(case, actor)
        client = await Client.connect(self.address)
        handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run,
            TemporalCaseRequest(
                case=TemporalCaseDescriptor(
                    case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                    workflow_id=case.workflow_id, workflow_run_id="pending", severity=case.severity, environment=case.environment,
                    affected_entities=case.affected_entities,
                ),
                actor=actor, evidence=evidence, claims=claims, coverage=coverage,
            ).dict(),
            id=workflow_id, task_queue=self.task_queue,
        )
        return case.copy(update={"workflow_run_id": handle.result_run_id})

    async def submit_owner_command(
        self, case: IncidentCase, command: OwnerGateCommand,
    ) -> OwnerCommandReceipt:
        if case.workflow_run_id == "pending":
            raise RuntimeError("temporal_workflow_run_not_started")
        client = await Client.connect(self.address)
        handle = client.get_workflow_handle(case.workflow_id, run_id=case.workflow_run_id)
        response = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command.dict())
        receipt = OwnerCommandReceipt.parse_obj(response)
        if not receipt.accepted:
            raise PolicyViolation(receipt.phase.removeprefix("rejected:"))
        return receipt


class DomainActivityEngine:
    """Runs the same deterministic domain gates used by tests inside activities."""

    def __init__(self, source_readback: EvidenceReadbackPort) -> None:
        self.source_readback = source_readback

    def _repository(self, packet: TemporalActivityPacket) -> InMemoryCaseRepository:
        now = datetime.now(timezone.utc)
        repository = InMemoryCaseRepository()
        repository.put_case(IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            severity=packet.severity, environment=packet.environment, affected_entities=packet.affected_entities,
            created_at=now, updated_at=now,
        ))
        gateway = EvidenceGateway(repository, packet.actor_subject_id)
        for item in packet.evidence:
            gateway.admit(item)
        for claim in packet.claims:
            gateway.admit_claim(claim)
        for entry in packet.coverage:
            repository.put_coverage(entry)
        return repository

    def execute(self, packet: TemporalActivityPacket) -> ActivityOutcome:
        try:
            repository = self._repository(packet)
            if packet.stage in {"primary_investigator", "specialist"}:
                role = "primary" if packet.stage == "primary_investigator" else packet.specialist_role
                if role is None:
                    raise PolicyViolation("specialist_role_required")
                repository.put_assignment(InvestigatorAssignment(
                    assignment_id="assignment-{}-{}-{}".format(packet.case_id, packet.sequence, role),
                    case_id=packet.case_id, case_revision=packet.case_revision, tenant_id=packet.tenant_id,
                    role=role, question="bounded diagnosis", allowed_tools=["read_evidence"],
                    allowed_entities=packet.affected_entities, dispatched_at=datetime.now(timezone.utc),
                ))
            if packet.stage == "critic":
                critic = DeterministicCritic().review(repository, packet.case_id)
                return ActivityOutcome(
                    decision=critic.decision,
                    state=CaseState.NEEDS_HUMAN if critic.decision != VerificationDecision.PASS else None,
                    identity=critic.identity, reason_codes=critic.reason_codes, critic=critic,
                )
            if packet.stage == "independent_verify":
                report = IndependentEvidenceVerifier(self.source_readback).verify(
                    repository, packet.case_id, packet.workflow_run_id, subject_id=packet.actor_subject_id
                )
                return ActivityOutcome(
                    decision=report.decision,
                    state=CaseState.ABSTAINED if report.decision != VerificationDecision.PASS else None,
                    identity=report.verifier_identity, reason_codes=report.reason_codes,
                    verification=report,
                )
            if packet.stage == "owner_wait":
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, state=CaseState.AWAITING_OWNER,
                    identity="owner-wait:p0:temporal-durable",
                )
            if packet.stage == "owner_gate":
                if packet.proposal is None:
                    return ActivityOutcome(
                        decision=VerificationDecision.AMBIGUOUS, state=CaseState.NEEDS_HUMAN,
                        identity="owner-gate:p0:exact", reason_codes=["proposal_required"],
                    )
                if packet.approval is None:
                    return ActivityOutcome(
                        decision=VerificationDecision.AMBIGUOUS, state=CaseState.AWAITING_OWNER,
                        identity="owner-gate:p0:exact", reason_codes=["owner_approval_required"],
                    )
                validate_owner_gate(
                    approval=packet.approval, proposal=packet.proposal,
                    current_case_revision=packet.case_revision, current_witness=packet.current_witness,
                    now=datetime.now(timezone.utc), authenticated_subject=packet.actor_subject_id,
                    authenticated_roles=packet.actor_roles, action_allowlist=(),
                )
                return ActivityOutcome(
                    decision=VerificationDecision.PASS, state=CaseState.AWAITING_OWNER,
                    identity="owner-gate:p0:exact",
                )
            return ActivityOutcome(decision=VerificationDecision.PASS, identity="{}:p0:domain".format(packet.stage))
        except PolicyViolation as error:
            terminal = CaseState.BLOCKED if packet.stage == "owner_gate" else CaseState.NEEDS_HUMAN
            return ActivityOutcome(
                decision=VerificationDecision.FAIL, state=terminal,
                identity="{}:p0:domain".format(packet.stage), reason_codes=[str(error)],
            )


class PostgresActivityDispatcher(ControlActivityDispatcher):
    def __init__(
        self, repository: PostgresCaseRepository, artifacts: S3ObjectStore, source_readback: EvidenceReadbackPort,
    ) -> None:
        self.repository = repository
        self.artifacts = artifacts
        self.engine = DomainActivityEngine(source_readback)

    async def _persist_domain(self, packet: TemporalActivityPacket) -> None:
        now = datetime.now(timezone.utc)
        await self.repository.put_case(IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            severity=packet.severity, environment=packet.environment, affected_entities=packet.affected_entities,
            created_at=now, updated_at=now,
        ))
        for evidence in packet.evidence:
            await self.repository.put_evidence(evidence, packet.actor_subject_id)
        for claim in packet.claims:
            await self.repository.put_claim(claim, packet.actor_subject_id)
        for coverage in packet.coverage:
            await self.repository.put_coverage(coverage)
        if packet.stage in {"primary_investigator", "specialist"}:
            role = "primary" if packet.stage == "primary_investigator" else packet.specialist_role
            if role is None:
                raise PolicyViolation("specialist_role_required")
            await self.repository.put_assignment(InvestigatorAssignment(
                assignment_id="assignment-{}-{}-{}".format(packet.case_id, packet.sequence, role),
                case_id=packet.case_id, case_revision=packet.case_revision, tenant_id=packet.tenant_id,
                role=role, question="bounded diagnosis", allowed_tools=["read_evidence"],
                allowed_entities=packet.affected_entities, dispatched_at=datetime.now(timezone.utc),
            ))

    async def dispatch(self, stage: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        packet = TemporalActivityPacket.parse_obj(packet_data)
        if packet.stage != stage.removesuffix("_activity"):
            raise PolicyViolation("temporal_activity_stage_mismatch")
        await self._persist_domain(packet)
        outcome = self.engine.execute(packet)
        if packet.stage == "owner_gate":
            outcome = await self.repository.record_owner_gate(packet, outcome)
        elif outcome.state is not None:
            await self.repository.project_case_state(packet, outcome.state, outcome.reason_codes)
        encoded = packet.json(sort_keys=True).encode("utf-8")
        artifact_key = self.artifacts.put(packet.tenant_id, encoded)
        if self.artifacts.get(packet.tenant_id, artifact_key) != encoded:
            raise PolicyViolation("object_store_readback_mismatch")
        activity_id = activity.info().activity_id
        await self.repository.append_activity_event(packet, activity_id, outcome.dict(), artifact_key)
        if outcome.verification is not None:
            await self.repository.append_verification(packet, outcome.verification)
        return outcome.dict()


def _s3_store(endpoint: str, bucket: str, access_key: str, secret_key: str) -> S3ObjectStore:
    client = boto3.client(
        "s3", endpoint_url=endpoint, aws_access_key_id=access_key, aws_secret_access_key=secret_key,
        region_name="us-east-1",
    )
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        client.create_bucket(Bucket=bucket)
    return S3ObjectStore(client, bucket)


async def run_worker(
    address: str, task_queue: str, postgres_dsn: str, object_endpoint: str, object_bucket: str,
    object_access_key: str, object_secret_key: str, local_deterministic_evidence: bool = False,
) -> None:
    client = await Client.connect(address)
    repository = PostgresCaseRepository(postgres_dsn)
    await repository.connect()
    artifacts = _s3_store(object_endpoint, object_bucket, object_access_key, object_secret_key)
    source_readback = (
        LocalDeterministicSourceReadback()
        if local_deterministic_evidence
        else S3SourceReadback(boto3.client(
            "s3", endpoint_url=object_endpoint, aws_access_key_id=object_access_key,
            aws_secret_access_key=object_secret_key, region_name="us-east-1",
        ))
    )
    async with Worker(
        client, task_queue=task_queue, workflows=[DiagnosisTemporalWorkflow],
        activities=build_temporal_activities(PostgresActivityDispatcher(repository, artifacts, source_readback)),
    ):
        try:
            await asyncio.Future()
        finally:
            await repository.close()

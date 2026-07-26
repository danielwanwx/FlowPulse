"""Postgres transaction proof for Gate 1 projection/outbox retries."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityName,
    CapabilityRegistry,
    CapabilityResult,
    EmptyCapabilityInput,
)
from flowpulse_cp.models import IncidentCase
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_actions import (
    Gate1Lease,
    Gate1LeaseStatus,
    NextBestActionGenerator,
    WorkspaceActionCommit,
    WorkspaceActionReceipt,
    canonical_evidence_set_hash,
)
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
)


class MetricsAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="not called")


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_WORKSPACE_ACTION_ATOMICITY") == "1",
    "requires the local Compose Postgres stack",
)
class LiveWorkspaceActionAtomicityTests(unittest.TestCase):
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )

    def test_every_action_persistence_checkpoint_rolls_back_then_retries_one_complete_set(self):
        async def run():
            now = datetime.now(timezone.utc)
            registry = CapabilityRegistry(
                descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
            )
            for boundary in ("after_projection", "after_lease", "after_cards", "after_receipt", "after_event", "after_transition"):
                suffix = uuid4().hex
                tenant = "tenant-action-{}".format(suffix)
                binding = IncidentRunBinding(
                    tenant_id=tenant, incident_id="incident-{}".format(suffix), run_id="run-{}".format(suffix),
                    topology_revision="topology-{}".format(suffix), case_id="case-{}".format(suffix),
                    case_revision=1, workflow_id="workspace-{}".format(suffix), workflow_run_id="temporal-{}".format(suffix),
                    created_at=now,
                )
                initial = IncidentProjection(
                    **binding.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
                    status="provider_unavailable", generated_at=now,
                    graph=IncidentGraph(nodes=[IncidentGraphNode(
                        component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
                        runtime_status="unknown", impact_status="unknown",
                    )]), evidence_revision=1, gate_revision=1, action_revision=1,
                )
                updated = initial.copy(update={
                    "projection_revision": 2, "sequence": 2, "gate_revision": 2, "action_revision": 2,
                })
                command_hash = sha256((suffix + ":command").encode("utf-8")).hexdigest()
                lease = Gate1Lease(
                    **binding.dict(), lease_id="gate1-" + command_hash, lease_revision=1, subject_id="owner-{}".format(suffix),
                    required_permission="incident:read", component_id="checkout", capability=CapabilityName.METRICS.value,
                    data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
                    projection_revision=2, evidence_revision=1, capability_registry_revision=registry.policy_version,
                    precondition_version="workspace-precondition.v1",
                    precondition_hash=NextBestActionGenerator._precondition_hash(updated),
                    issuance_command_fingerprint=command_hash, evidence_set_hash=canonical_evidence_set_hash([]),
                    issued_at=now, expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
                )
                cards = NextBestActionGenerator(registry).generate_after_gate1(updated, lease, now)
                receipt = WorkspaceActionReceipt(
                    **binding.dict(), action_id="gate-request-{}".format(suffix), idempotency_key="idem-{}".format(suffix),
                    status="GATE1_GRANTED", gate1_lease_id=lease.lease_id, reason="test-atomic",
                )
                event = IncidentEvent(
                    **binding.dict(), projection_revision=2, sequence=2, event_type="workspace.action.gate1_granted",
                    occurred_at=now, payload={"action_id": receipt.action_id, "idempotency_key": receipt.idempotency_key,
                    "command_fingerprint": command_hash, "activity_identity": "activity-{}".format(suffix)}, evidence_refs=[],
                )
                commit = WorkspaceActionCommit(
                    activity_identity="activity-{}".format(suffix), command_fingerprint=command_hash,
                    projection=updated, receipt=receipt, event=event, lease=lease, actions=cards,
                )

                def fail(checkpoint, target=boundary):
                    if checkpoint == target:
                        raise RuntimeError("injected:" + checkpoint)

                repository = PostgresCaseRepository(self.dsn, failure_injector=fail)
                await repository.connect()
                try:
                    await repository.put_case(IncidentCase(
                        case_id=binding.case_id, tenant_id=binding.tenant_id, case_revision=1,
                        workflow_id=binding.workflow_id, workflow_run_id=binding.workflow_run_id,
                        severity="SEV2", environment="local", affected_entities=["checkout"],
                        created_at=now, updated_at=now,
                    ))
                    await repository.put_workspace_binding(binding)
                    await repository.put_workspace_projection(initial)
                    with self.subTest(boundary=boundary), self.assertRaisesRegex(RuntimeError, "injected:" + boundary):
                        await repository.commit_workspace_action_transition(commit)

                    async def partial_counts(connection):
                        return await connection.fetchrow(
                            """SELECT
                                 (SELECT count(*) FROM incident_projections WHERE tenant_id=$1 AND case_id=$2 AND projection_revision=2) AS projection,
                                 (SELECT count(*) FROM workspace_gate1_leases WHERE tenant_id=$1 AND case_id=$2) AS lease,
                                 (SELECT count(*) FROM next_best_actions WHERE tenant_id=$1 AND case_id=$2) AS card,
                                 (SELECT count(*) FROM workspace_action_receipts WHERE tenant_id=$1 AND case_id=$2) AS receipt,
                                 (SELECT count(*) FROM incident_projection_events WHERE tenant_id=$1 AND case_id=$2 AND sequence=2) AS event,
                                 (SELECT count(*) FROM workspace_action_transitions WHERE tenant_id=$1 AND case_id=$2) AS transition""",
                            tenant, binding.case_id,
                        )
                    self.assertEqual((0, 0, 0, 0, 0, 0), tuple(await repository._tenant(tenant, partial_counts)))

                    repository.failure_injector = None
                    accepted = await repository.commit_workspace_action_transition(commit)
                    self.assertEqual(commit, accepted)
                    retried = await repository.commit_workspace_action_transition(commit)
                    self.assertEqual(commit, retried)
                    self.assertEqual((1, 1, 1, 1, 1, 1), tuple(await repository._tenant(tenant, partial_counts)))
                finally:
                    await repository.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

"""Postgres transaction proof for Gate 1 projection/outbox retries."""

import asyncio
import json
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
    CapabilityAuditRecord,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityName,
    CapabilityRegistry,
    CapabilityResult,
    CapabilityScope,
    EmptyCapabilityInput,
)
from flowpulse_cp.models import (
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    ProofScope,
    SourceKind,
)
from flowpulse_cp.policy import PolicyViolation
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
                gate_card = NextBestActionGenerator(registry).generate(initial, now)[0]
                command_hash = sha256((suffix + ":command").encode("utf-8")).hexdigest()
                lease = Gate1Lease(
                    **binding.dict(), lease_id="gate1-" + command_hash, lease_revision=1, subject_id="owner-{}".format(suffix),
                    required_permission="incident:read", component_id="checkout", capability=CapabilityName.METRICS.value,
                    data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
                    projection_revision=2, evidence_revision=1, capability_registry_revision=registry.policy_version,
                    precondition_version="workspace-precondition.v1",
                    precondition_hash=NextBestActionGenerator._precondition_hash(updated),
                    issuance_command_fingerprint=command_hash,
                    issuance_action_id=gate_card.action_id,
                    issuance_card_version=gate_card.card_version,
                    issuance_idempotency_key="idem-{}".format(suffix),
                    evidence_set_hash=canonical_evidence_set_hash([]),
                    issued_at=now, expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
                )
                cards = NextBestActionGenerator(registry).generate_after_gate1(updated, lease, now)
                receipt = WorkspaceActionReceipt(
                    **binding.dict(), action_id=gate_card.action_id, idempotency_key="idem-{}".format(suffix),
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
                    issued_action=gate_card,
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
                    await repository.append_next_best_action(gate_card)
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
                    self.assertEqual((0, 0, 1, 0, 0, 0), tuple(await repository._tenant(tenant, partial_counts)))

                    repository.failure_injector = None
                    accepted = await repository.commit_workspace_action_transition(commit)
                    self.assertEqual(commit, accepted)
                    retried = await repository.commit_workspace_action_transition(commit)
                    self.assertEqual(commit, retried)
                    self.assertEqual((1, 1, 2, 1, 1, 1), tuple(await repository._tenant(tenant, partial_counts)))
                finally:
                    await repository.close()
        asyncio.run(run())

    def test_postgres_transition_kind_and_coverage_conflicts_fail_closed(self):
        async def run():
            now = datetime.now(timezone.utc)
            suffix = uuid4().hex
            tenant = "tenant-coverage-{}".format(suffix)
            binding = IncidentRunBinding(
                tenant_id=tenant, incident_id="incident-{}".format(suffix), run_id="run-{}".format(suffix),
                topology_revision="topology-{}".format(suffix), case_id="case-{}".format(suffix),
                case_revision=1, workflow_id="workspace-{}".format(suffix), workflow_run_id="temporal-{}".format(suffix),
                created_at=now,
            )
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                await repository.put_case(IncidentCase(
                    case_id=binding.case_id, tenant_id=binding.tenant_id, case_revision=1,
                    workflow_id=binding.workflow_id, workflow_run_id=binding.workflow_run_id,
                    severity="SEV2", environment="local", affected_entities=["checkout"],
                    created_at=now, updated_at=now,
                ))
                coverage = CoverageEntry(
                    tenant_id=tenant, case_id=binding.case_id, field="telemetry_symptom",
                    status=CoverageStatus.FILLED, evidence_ids=["evidence-{}".format(suffix)],
                )
                await repository.put_coverage(coverage)
                await repository.put_coverage(coverage)
                with self.assertRaisesRegex(PolicyViolation, "workspace_action_coverage_immutable"):
                    await repository.put_coverage(coverage.copy(update={"note": "conflicting"}))
                await repository.put_coverage(coverage)

                async def coverage_rows(connection):
                    return await connection.fetch(
                        """SELECT entry_id, payload FROM coverage_entries
                           WHERE tenant_id=$1 AND case_id=$2 AND field=$3 AND status=$4""",
                        coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value,
                    )
                rows = await repository._tenant(tenant, coverage_rows)
                self.assertEqual(1, len(rows))
                payload = rows[0]["payload"]
                self.assertEqual(coverage, CoverageEntry.parse_obj(
                    json.loads(payload) if isinstance(payload, str) else payload,
                ))

                command_hash = sha256((suffix + ":invalid").encode("utf-8")).hexdigest()
                active = Gate1Lease(
                    **binding.dict(), lease_id="gate1-" + command_hash, lease_revision=2,
                    subject_id="owner-{}".format(suffix), required_permission="incident:read",
                    component_id="checkout", capability=CapabilityName.METRICS.value,
                    data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
                    projection_revision=1, evidence_revision=1, capability_registry_revision="capability-policy.v2",
                    precondition_version="workspace-precondition.v1", precondition_hash="a" * 64,
                    issuance_command_fingerprint=command_hash, evidence_set_hash=canonical_evidence_set_hash([]),
                    issued_at=now, expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.CONSUMED,
                    consumed_by_activity_id="invalid-activity", consumed_command_fingerprint=command_hash,
                    consumed_evidence_set_hash=canonical_evidence_set_hash([]), consumed_evidence_revision=1,
                )
                receipt = WorkspaceActionReceipt(
                    **binding.dict(), action_id="read-card-{}".format(suffix), idempotency_key="invalid-{}".format(suffix),
                    status="FRESH_READ_COMPLETED", gate1_lease_id=active.lease_id, reason="invalid-probe",
                )
                bypassed = WorkspaceActionCommit.construct(
                    receipt=receipt, lease=active, actions=[], issued_action=None,
                    capability_result=None, capability_audit=None,
                )
                with self.assertRaisesRegex(PolicyViolation, "fresh_read_transition_artifacts_required"):
                    await repository.commit_workspace_action_transition(bypassed)
            finally:
                await repository.close()
        asyncio.run(run())

    def test_postgres_fresh_read_rejects_empty_or_rebound_artifacts_before_consuming(self):
        """The Postgres boundary repeats the in-memory fresh-read invariants."""
        async def run():
            now = datetime.now(timezone.utc)
            suffix = uuid4().hex
            tenant = "tenant-fresh-{}".format(suffix)
            subject = "owner-{}".format(suffix)
            binding = IncidentRunBinding(
                tenant_id=tenant, incident_id="incident-{}".format(suffix), run_id="run-{}".format(suffix),
                topology_revision="topology-{}".format(suffix), case_id="case-{}".format(suffix),
                case_revision=1, workflow_id="workspace-{}".format(suffix), workflow_run_id="temporal-{}".format(suffix),
                created_at=now,
            )
            registry = CapabilityRegistry(
                descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
            )
            initial = IncidentProjection(
                **binding.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
                status="provider_unavailable", generated_at=now,
                graph=IncidentGraph(nodes=[IncidentGraphNode(
                    component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
                    runtime_status="unknown", impact_status="unknown",
                )]), evidence_revision=1, gate_revision=1, action_revision=1,
            )
            granted_projection = initial.copy(update={
                "projection_revision": 2, "sequence": 2, "gate_revision": 2, "action_revision": 2,
            })
            gate_card = NextBestActionGenerator(registry).generate(initial, now)[0]
            grant_fingerprint = sha256((suffix + ":grant").encode("utf-8")).hexdigest()
            lease = Gate1Lease(
                **binding.dict(), lease_id="gate1-" + grant_fingerprint, lease_revision=1, subject_id=subject,
                required_permission="incident:read", component_id="checkout", capability=CapabilityName.METRICS.value,
                data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
                projection_revision=2, evidence_revision=1, capability_registry_revision=registry.policy_version,
                precondition_version="workspace-precondition.v1",
                precondition_hash=NextBestActionGenerator._precondition_hash(granted_projection),
                issuance_command_fingerprint=grant_fingerprint, issuance_action_id=gate_card.action_id,
                issuance_card_version=gate_card.card_version, issuance_idempotency_key="grant-{}".format(suffix),
                evidence_set_hash=canonical_evidence_set_hash([]), issued_at=now,
                expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
            )
            read_card = NextBestActionGenerator(registry).generate_after_gate1(granted_projection, lease, now)[0]
            grant_receipt = WorkspaceActionReceipt(
                **binding.dict(), action_id=gate_card.action_id, idempotency_key=lease.issuance_idempotency_key,
                status="GATE1_GRANTED", gate1_lease_id=lease.lease_id, reason="test-grant",
            )
            grant = WorkspaceActionCommit(
                activity_identity="grant-{}".format(suffix), command_fingerprint=grant_fingerprint,
                projection=granted_projection, receipt=grant_receipt, lease=lease, actions=[read_card],
                issued_action=gate_card, event=IncidentEvent(
                    **binding.dict(), projection_revision=2, sequence=2, event_type="workspace.action.gate1_granted",
                    occurred_at=now, payload={
                        "action_id": gate_card.action_id, "idempotency_key": grant_receipt.idempotency_key,
                        "command_fingerprint": grant_fingerprint, "activity_identity": "grant-{}".format(suffix),
                    }, evidence_refs=[],
                ),
            )
            evidence = EvidenceEnvelope(
                evidence_id="evidence-{}".format(suffix), tenant_id=tenant, case_id=binding.case_id, case_revision=1,
                acl_subjects=[subject], source_kind=SourceKind.METRIC, source_uri="metric://checkout/latency",
                source_anchor="window:1", observed_at=now, effective_at=now, source_version="v1",
                content_hash=sha256((suffix + ":evidence").encode("utf-8")).hexdigest(),
                authority=EvidenceAuthority.T1, freshness=FreshnessStatus.CURRENT,
                independence_key="metrics:{}".format(suffix), schema_binding="metrics.v1",
                proof_scope=ProofScope.CURRENT_OBSERVATION,
            )
            result = CapabilityResult(
                summary="current checkout latency", evidence=[evidence],
                claims=[ClaimRecord(
                    claim_id="claim-{}".format(suffix), tenant_id=tenant, case_id=binding.case_id,
                    case_revision=1, claim_type="symptom", statement="Current checkout latency is elevated.",
                    evidence_ids=[evidence.evidence_id], created_by="test:postgres-fresh",
                )],
                coverage=[CoverageEntry(
                    tenant_id=tenant, case_id=binding.case_id, field="telemetry_symptom",
                    status=CoverageStatus.FILLED, evidence_ids=[evidence.evidence_id],
                )],
            )
            fresh_fingerprint = sha256((suffix + ":fresh").encode("utf-8")).hexdigest()
            fresh_idempotency = "fresh-{}".format(suffix)
            activity_id = "workspace-gate1:{}:{}:{}".format(
                binding.workflow_run_id, read_card.action_id, fresh_idempotency,
            )
            audit = CapabilityAuditRecord(
                **binding.dict(), audit_id=uuid4(), projection_revision=2, evidence_revision=1,
                activity_id=activity_id, scope=CapabilityScope.USER_QA, subject_id=subject,
                audience=CapabilityAudience.USER_QA, capability=CapabilityName.METRICS,
                component_id="checkout", capability_version="metrics.v1",
                data_class=CapabilityDataClass.CURRENT_INCIDENT, required_gate=CapabilityGate.GATE1,
                policy_version=registry.policy_version, request_hash=sha256((suffix + ":request").encode("utf-8")).hexdigest(),
                input_evidence_refs=[], evidence_refs=[evidence.evidence_id],
            )
            consumed = lease.copy(update={
                "lease_revision": 2, "status": Gate1LeaseStatus.CONSUMED,
                "consumed_by_activity_id": activity_id, "consumed_command_fingerprint": fresh_fingerprint,
                "consumed_evidence_set_hash": canonical_evidence_set_hash([]), "consumed_evidence_revision": 1,
            })
            fresh_projection = granted_projection.copy(update={
                "projection_revision": 3, "sequence": 3, "evidence_revision": 2, "action_revision": 3,
                "evidence_refs": [evidence.evidence_id], "generated_at": now,
            })
            receipt = WorkspaceActionReceipt(
                **binding.dict(), action_id=read_card.action_id, idempotency_key=fresh_idempotency,
                status="FRESH_READ_COMPLETED", gate1_lease_id=lease.lease_id, reason="test-fresh",
            )
            fresh = WorkspaceActionCommit(
                activity_identity="fresh-{}".format(suffix), command_fingerprint=fresh_fingerprint,
                projection=fresh_projection, receipt=receipt, lease=consumed,
                capability_result=result, capability_audit=audit, event=IncidentEvent(
                    **binding.dict(), projection_revision=3, sequence=3, event_type="workspace.action.fresh_read_completed",
                    occurred_at=now, payload={
                        "action_id": read_card.action_id, "idempotency_key": fresh_idempotency,
                        "command_fingerprint": fresh_fingerprint, "activity_identity": "fresh-{}".format(suffix),
                    }, evidence_refs=[evidence.evidence_id],
                ),
            )
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                await repository.put_case(IncidentCase(
                    case_id=binding.case_id, tenant_id=tenant, case_revision=1,
                    workflow_id=binding.workflow_id, workflow_run_id=binding.workflow_run_id,
                    severity="SEV2", environment="local", affected_entities=["checkout"],
                    created_at=now, updated_at=now,
                ))
                await repository.put_workspace_binding(binding)
                await repository.put_workspace_projection(initial)
                await repository.grant_workspace_subject(binding, subject)
                await repository.append_next_best_action(gate_card)
                await repository.commit_workspace_action_transition(grant)

                for field in ("evidence", "claims", "coverage"):
                    with self.subTest(empty_domain_field=field):
                        incomplete = WorkspaceActionCommit.construct(**{
                            **fresh.__dict__,
                            "capability_result": fresh.capability_result.copy(update={field: []}),
                        })
                        with self.assertRaisesRegex(PolicyViolation, "fresh_read_current_evidence_artifacts_required"):
                            await repository.commit_workspace_action_transition(incomplete)
                for label, changed in {
                    "subject": {"capability_audit": audit.copy(update={"subject_id": "intruder"})},
                    "activity": {"capability_audit": audit.copy(update={"activity_id": "other-activity"})},
                    "evidence_refs": {"capability_audit": audit.copy(update={"evidence_refs": []})},
                    "issuance": {"lease": consumed.copy(update={"issuance_action_id": "other-card"})},
                    "precondition": {"lease": consumed.copy(update={"precondition_hash": "e" * 64})},
                }.items():
                    with self.subTest(rebound=label):
                        with self.assertRaisesRegex(PolicyViolation, "fresh_read_audit_|gate1_consumed_lease_transition_invalid"):
                            await repository.commit_workspace_action_transition(fresh.copy(update=changed))

                async def counts(connection):
                    return await connection.fetchrow(
                        """SELECT
                             (SELECT count(*) FROM workspace_gate1_leases WHERE tenant_id=$1 AND case_id=$2) AS leases,
                             (SELECT count(*) FROM evidence_envelopes WHERE tenant_id=$1 AND case_id=$2) AS evidence,
                             (SELECT count(*) FROM claim_records WHERE tenant_id=$1 AND case_id=$2) AS claims,
                             (SELECT count(*) FROM coverage_entries WHERE tenant_id=$1 AND case_id=$2) AS coverage,
                             (SELECT count(*) FROM tool_calls WHERE tenant_id=$1 AND case_id=$2) AS audits,
                             (SELECT count(*) FROM workspace_action_transitions WHERE tenant_id=$1 AND case_id=$2) AS transitions""",
                        tenant, binding.case_id,
                    )
                self.assertEqual((1, 0, 0, 0, 0, 1), tuple(await repository._tenant(tenant, counts, subject_id=subject)))
                active = await repository.workspace_gate1_lease(tenant, binding.case_id, lease.lease_id)
                self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))

                self.assertEqual(fresh, await repository.commit_workspace_action_transition(fresh))
                self.assertEqual(fresh, await repository.commit_workspace_action_transition(fresh))
                self.assertEqual((2, 1, 1, 1, 1, 2), tuple(await repository._tenant(tenant, counts, subject_id=subject)))
            finally:
                await repository.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

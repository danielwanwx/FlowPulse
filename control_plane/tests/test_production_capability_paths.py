"""Production-facing Task 4 proof: one registry serves diagnosis and Q&A."""

import asyncio
import hashlib
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityInvocationContext,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityScope,
    ToolCallBudget,
)
from flowpulse_cp.capability_adapters import (
    CurrentEvidenceCapabilityAdapter,
    DomainEvidenceAdmission,
    RecordedContextCapabilityAdapter,
)
from flowpulse_cp.conversation_manager import ConversationManager
from flowpulse_cp.integrity import FrozenSourceReadback
from flowpulse_cp.models import (
    AuthContext,
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    ProofScope,
    SourceKind,
    TemporalActivityPacket,
)
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.provider_gateway import DeterministicConversationProvider
from flowpulse_cp.repository import InMemoryCaseRepository
from flowpulse_cp.temporal_runtime import DomainActivityEngine
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def evidence(**updates):
    values = {
        "evidence_id": "evidence-a", "tenant_id": "tenant-a", "case_id": "case-a", "case_revision": 1,
        "acl_subjects": ["owner-a"], "source_kind": SourceKind.METRIC,
        "source_uri": "metric://checkout", "source_anchor": "line:1", "observed_at": NOW,
        "effective_at": NOW, "source_version": "v1", "content_hash": digest("evidence-a"),
        "authority": EvidenceAuthority.T0, "freshness": FreshnessStatus.CURRENT,
        "independence_key": "metric-origin", "schema_binding": "metric.v1",
        "proof_scope": ProofScope.CURRENT_OBSERVATION,
    }
    values.update(updates)
    return EvidenceEnvelope(**values)


class BoundScopeAuthority:
    def __init__(self):
        self.calls = []

    async def assert_scope(self, context):
        self.calls.append(context)
        if (
            context.tenant_id != "tenant-a" or context.incident_id != "incident-a"
            or context.run_id != "run-public-a" or context.topology_revision != "topology-v1-a"
            or context.case_id != "case-a" or context.case_revision != 1
            or context.workflow_id != "workflow-a" or context.workflow_run_id != "temporal-run-a"
        ):
            raise PolicyViolation("capability_scope_authoritative_binding_mismatch")


class AuditSink:
    def __init__(self):
        self.records = []

    async def append_capability_audit(self, audit):
        self.records.append(audit)
        return audit


class ControlledAcquirer:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def acquire(self, item, subject_id):
        self.calls.append((item, subject_id))
        return self.result


class ProductionCapabilityPathTests(unittest.TestCase):
    def binding(self):
        return IncidentRunBinding(
            tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
            topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
            workflow_id="workflow-a", workflow_run_id="temporal-run-a", created_at=NOW,
        )

    def acquisition_result(self):
        item = evidence()
        return type("Acquisition", (), {
            "evidence": [item],
            "claims": [ClaimRecord(
                claim_id="claim-a", tenant_id="tenant-a", case_id="case-a", case_revision=1,
                claim_type="root", statement="current", evidence_ids=[item.evidence_id], created_by="primary",
            )],
            "coverage": [CoverageEntry(
                tenant_id="tenant-a", case_id="case-a", field="telemetry_symptom", status=CoverageStatus.FILLED,
            )],
        })()

    def registry(self, acquirer):
        self.authority = BoundScopeAuthority()
        self.audit = AuditSink()
        return CapabilityRegistry(
            descriptors=[CurrentEvidenceCapabilityAdapter.descriptor, RecordedContextCapabilityAdapter.descriptor],
            adapters={
                CurrentEvidenceCapabilityAdapter.descriptor.capability: CurrentEvidenceCapabilityAdapter(acquirer),
                RecordedContextCapabilityAdapter.descriptor.capability: RecordedContextCapabilityAdapter(),
            },
            audit_sink=self.audit, scope_authority=self.authority,
        )

    def autonomous_packet(self):
        return TemporalActivityPacket(
            case_id="case-a", case_revision=1, tenant_id="tenant-a", workflow_id="workflow-a",
            workflow_run_id="temporal-run-a", public_incident_id="incident-a", public_run_id="run-public-a",
            public_topology_revision="topology-v1-a", capability_scope_created_at=NOW,
            actor_subject_id="owner-a", actor_roles=["owner"], severity="SEV2", environment="local",
            affected_entities=["checkout"], stage="acquire_current_evidence", sequence=1,
        )

    def test_actual_autonomous_and_user_qa_paths_share_registry_scope_and_durable_audit(self):
        acquirer = ControlledAcquirer(self.acquisition_result())
        registry = self.registry(acquirer)
        engine = DomainActivityEngine(FrozenSourceReadback([]), authorization=None, evidence_acquirer=acquirer,
                                      capability_registry=registry)
        acquired = asyncio.run(engine.execute_async(self.autonomous_packet()))
        self.assertEqual("PASS", acquired.decision.value)
        self.assertEqual("capability:current-evidence:v1", acquired.identity)

        item = self.binding()
        projection = IncidentProjection(
            **item.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
            status="provider_unavailable", generated_at=NOW,
            graph=IncidentGraph(nodes=[IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
                runtime_status="unknown", impact_status="unknown",
            )]), impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
            evidence_refs=[], degraded_code="provider_unavailable",
        )
        managed = asyncio.run(ConversationManager(
            DeterministicConversationProvider(), registry,
        ).explain(
            item, projection, NodeExplanationStart(
                incident_id="incident-a", run_id="run-public-a", topology_revision="topology-v1-a",
                projection_revision=1, component_id="checkout", idempotency_key="click-a",
            ), actor=AuthContext(tenant_id="tenant-a", subject_id="owner-a", roles=["owner"]),
        ))
        self.assertEqual("TEST_DETERMINISTIC", managed.truth_label.value)
        self.assertEqual(1, managed.trace.recorded_context_accesses)
        self.assertEqual(0, managed.trace.tool_calls)
        self.assertEqual(
            [CapabilityScope.AUTONOMOUS_DIAGNOSIS, CapabilityScope.USER_QA],
            [record.scope for record in self.audit.records],
        )
        self.assertIs(engine.capability_registry, registry)
        self.assertIsNotNone(acquirer.calls[0][0])

    def test_returned_evidence_is_rejected_before_audit_for_tenant_acl_or_revision_mismatch(self):
        for bad in (
            evidence(tenant_id="tenant-b"),
            evidence(acl_subjects=["other-subject"]),
            evidence(case_revision=2),
        ):
            acquirer = ControlledAcquirer(type("Acquisition", (), {
                "evidence": [bad], "claims": [ClaimRecord(
                    claim_id="claim-a", tenant_id=bad.tenant_id, case_id=bad.case_id,
                    case_revision=bad.case_revision, claim_type="root", statement="current",
                    evidence_ids=[bad.evidence_id], created_by="primary",
                )], "coverage": [CoverageEntry(
                    tenant_id=bad.tenant_id, case_id=bad.case_id, field="telemetry_symptom", status=CoverageStatus.FILLED,
                )],
            })())
            registry = self.registry(acquirer)
            repository = InMemoryCaseRepository()
            repository.put_case(IncidentCase(
                case_id="case-a", tenant_id="tenant-a", workflow_id="workflow-a", workflow_run_id="temporal-run-a",
                severity="SEV2", environment="local", affected_entities=["checkout"], created_at=NOW, updated_at=NOW,
            ))
            context = CapabilityInvocationContext(
                **self.binding().dict(), projection_revision=1, evidence_revision=1, component_ids=["checkout"],
                activity_id="activity-a", scope=CapabilityScope.AUTONOMOUS_DIAGNOSIS, subject_id="owner-a",
                subject_roles=["owner"], authorized_subjects=["owner-a"], data_class=CapabilityDataClass.CURRENT_INCIDENT,
                recorded_evidence_ids=[], system_authorized=True,
            )
            with self.assertRaisesRegex(PolicyViolation, "capability_result_evidence_(scope_mismatch|acl_denied)"):
                asyncio.run(registry.invoke(
                    CapabilityAudience.AUTONOMOUS_DIAGNOSIS, context,
                    CapabilityRequest(
                        capability=CurrentEvidenceCapabilityAdapter.descriptor.capability, component_id="checkout",
                        data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
                    ), ToolCallBudget(max_calls=1), evidence_admission=DomainEvidenceAdmission(repository, "owner-a"),
                ))
            self.assertEqual([], self.audit.records)

    def test_authority_rejects_a_wrong_public_run_before_adapter_or_audit(self):
        registry = self.registry(ControlledAcquirer(self.acquisition_result()))
        context = CapabilityInvocationContext(
            **self.binding().copy(update={"run_id": "run-other"}).dict(), projection_revision=1, evidence_revision=1,
            component_ids=["checkout"], activity_id="activity-a", scope=CapabilityScope.AUTONOMOUS_DIAGNOSIS,
            subject_id="owner-a", subject_roles=["owner"], authorized_subjects=["owner-a"],
            data_class=CapabilityDataClass.CURRENT_INCIDENT, recorded_evidence_ids=[], system_authorized=True,
        )
        with self.assertRaisesRegex(PolicyViolation, "capability_scope_authoritative_binding_mismatch"):
            asyncio.run(registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS, context,
                CapabilityRequest(
                    capability=CurrentEvidenceCapabilityAdapter.descriptor.capability, component_id="checkout",
                    data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
                ), ToolCallBudget(max_calls=1),
            ))
        self.assertEqual([], self.audit.records)

    def test_returned_evidence_unknown_parent_is_rejected_at_lineage_admission_before_audit(self):
        bad = evidence(parent_evidence_ids=["unknown-parent"])
        acquirer = ControlledAcquirer(type("Acquisition", (), {
            "evidence": [bad], "claims": [ClaimRecord(
                claim_id="claim-a", tenant_id="tenant-a", case_id="case-a", case_revision=1,
                claim_type="root", statement="current", evidence_ids=[bad.evidence_id], created_by="primary",
            )], "coverage": [CoverageEntry(
                tenant_id="tenant-a", case_id="case-a", field="telemetry_symptom", status=CoverageStatus.FILLED,
            )],
        })())
        registry = self.registry(acquirer)
        repository = InMemoryCaseRepository()
        repository.put_case(IncidentCase(
            case_id="case-a", tenant_id="tenant-a", workflow_id="workflow-a", workflow_run_id="temporal-run-a",
            severity="SEV2", environment="local", affected_entities=["checkout"], created_at=NOW, updated_at=NOW,
        ))
        context = CapabilityInvocationContext(
            **self.binding().dict(), projection_revision=1, evidence_revision=1, component_ids=["checkout"],
            activity_id="activity-a", scope=CapabilityScope.AUTONOMOUS_DIAGNOSIS, subject_id="owner-a",
            subject_roles=["owner"], authorized_subjects=["owner-a"], data_class=CapabilityDataClass.CURRENT_INCIDENT,
            recorded_evidence_ids=[], system_authorized=True,
        )
        with self.assertRaisesRegex(PolicyViolation, "unknown_parent_evidence"):
            asyncio.run(registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS, context,
                CapabilityRequest(
                    capability=CurrentEvidenceCapabilityAdapter.descriptor.capability, component_id="checkout",
                    data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
                ), ToolCallBudget(max_calls=1), evidence_admission=DomainEvidenceAdmission(repository, "owner-a"),
            ))
        self.assertEqual([], self.audit.records)

    def test_production_adapter_rejects_wrong_revision_data_class_and_unknown_input_before_source_read(self):
        acquirer = ControlledAcquirer(self.acquisition_result())
        registry = self.registry(acquirer)
        base = CapabilityInvocationContext(
            **self.binding().dict(), projection_revision=1, evidence_revision=1, component_ids=["checkout"],
            activity_id="activity-a", scope=CapabilityScope.AUTONOMOUS_DIAGNOSIS,
            subject_id="owner-a", subject_roles=["owner"], authorized_subjects=["owner-a"],
            data_class=CapabilityDataClass.CURRENT_INCIDENT, recorded_evidence_ids=[], system_authorized=True,
        )
        request = CapabilityRequest(
            capability=CurrentEvidenceCapabilityAdapter.descriptor.capability, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        with self.assertRaisesRegex(PolicyViolation, "capability_scope_authoritative_binding_mismatch"):
            asyncio.run(registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS, base.copy(update={"case_revision": 2}), request,
                ToolCallBudget(max_calls=1),
            ))
        with self.assertRaisesRegex(PolicyViolation, "capability_data_class_not_allowed"):
            asyncio.run(registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS,
                base.copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}),
                request.copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}),
                ToolCallBudget(max_calls=1),
            ))
        with self.assertRaisesRegex(PolicyViolation, "capability_input_schema_invalid"):
            asyncio.run(registry.invoke(
                CapabilityAudience.AUTONOMOUS_DIAGNOSIS, base,
                request.copy(update={"parameters": {"misspelled": "reject"}}), ToolCallBudget(max_calls=1),
            ))
        self.assertEqual([], acquirer.calls)
        self.assertEqual([], self.audit.records)


if __name__ == "__main__":
    unittest.main()

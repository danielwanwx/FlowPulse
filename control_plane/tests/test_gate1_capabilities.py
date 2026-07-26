"""Gate 1 is an exact Temporal lease, never a browser capability flag."""

import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityResult,
    CapabilityScope,
    EmptyCapabilityInput,
    ToolCallBudget,
)
from flowpulse_cp.models import EvidenceAuthority, EvidenceEnvelope, FreshnessStatus, ProofScope, SourceKind
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    Gate1LeaseAuthority,
    Gate1LeaseStatus,
    NextBestActionGenerator,
    WorkspaceActionPacket,
)
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)
HASH = "a" * 64


def binding(tenant_id="tenant-a"):
    return IncidentRunBinding(
        tenant_id=tenant_id, incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def context(item, **changes):
    from flowpulse_cp.capabilities import CapabilityInvocationContext

    values = dict(
        **item.dict(), projection_revision=1, evidence_revision=1,
        component_ids=["checkout"], activity_id="activity-gate1", scope=CapabilityScope.USER_QA,
        subject_id="subject-a", subject_roles=["viewer"], authorized_subjects=["subject-a"],
        subject_permissions=["incident:read"], data_class=CapabilityDataClass.CURRENT_INCIDENT,
        max_tool_calls=1, capability_registry_revision="capability-registry.v3",
        precondition_version="workspace-precondition.v1", precondition_hash=HASH,
        gate1_lease_id="lease-a",
    )
    values.update(changes)
    return CapabilityInvocationContext(**values)


def lease(item, **changes):
    values = dict(
        **item.dict(), lease_id="lease-a", lease_revision=1, subject_id="subject-a",
        required_permission="incident:read", component_id="checkout", capability=CapabilityName.METRICS.value,
        data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
        projection_revision=1, evidence_revision=1, capability_registry_revision="capability-registry.v3",
        precondition_version="workspace-precondition.v1", precondition_hash=HASH,
        issued_at=NOW, expires_at=NOW + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
    )
    values.update(changes)
    return Gate1Lease(**values)


class MetricsAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="test")


class CurrentMetricsAdapter(MetricsAdapter):
    async def invoke(self, parsed_input, invocation_context):
        evidence = EvidenceEnvelope(
            evidence_id="metric-evidence-a", tenant_id=invocation_context.tenant_id,
            case_id=invocation_context.case_id, case_revision=invocation_context.case_revision,
            acl_subjects=[invocation_context.subject_id], source_kind=SourceKind.METRIC,
            source_uri="metric://checkout/latency", source_anchor="window:1",
            observed_at=NOW, effective_at=NOW, source_version="metrics-v1", content_hash="b" * 64,
            authority=EvidenceAuthority.T1, freshness=FreshnessStatus.CURRENT,
            independence_key="metrics:checkout", schema_binding="metrics.v1",
            proof_scope=ProofScope.CURRENT_OBSERVATION,
        )
        return CapabilityResult(summary="current metric", evidence=[evidence])


class AcceptingScope:
    async def assert_scope(self, invocation_context):
        return None


class AcceptingAdmission:
    async def admit(self, result, invocation_context):
        return result


def projection(item):
    return IncidentProjection(
        **item.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="degraded", generated_at=NOW, graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
            runtime_status="unknown", impact_status="unknown",
        )]), evidence_revision=1, gate_revision=1, action_revision=1,
    )


class Gate1CapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_lease_is_single_fresh_read_capability_and_only_retries_same_activity(self):
        item = binding()
        repository = InMemoryWorkspaceRepository()
        await repository.put_binding(item)
        await repository.append_gate1_lease(lease(item))
        authority = Gate1LeaseAuthority(repository, now=lambda: NOW)
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        first = await authority.assert_active(context(item), request, MetricsAdapter.descriptor)
        self.assertEqual(Gate1LeaseStatus.CONSUMED, first.status)
        self.assertEqual("activity-gate1", first.consumed_by_activity_id)
        retry = await authority.assert_active(context(item), request, MetricsAdapter.descriptor)
        self.assertEqual(first, retry)
        with self.assertRaisesRegex(PolicyViolation, "gate1_lease_not_active"):
            await authority.assert_active(context(item, activity_id="activity-other"), request, MetricsAdapter.descriptor)

    async def test_shared_registry_requires_and_consumes_the_exact_gate1_lease_before_fresh_read_audit(self):
        item = binding()
        repository = InMemoryWorkspaceRepository()
        await repository.put_binding(item)
        await repository.append_gate1_lease(lease(item))
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor],
            adapters={CapabilityName.METRICS: CurrentMetricsAdapter()},
            audit_sink=repository, scope_authority=AcceptingScope(),
            gate1_authority=Gate1LeaseAuthority(repository, now=lambda: NOW),
        )
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        first = await registry.invoke(
            CapabilityAudience.USER_QA, context(item), request, ToolCallBudget(max_calls=1),
            evidence_admission=AcceptingAdmission(),
        )
        self.assertEqual(["metric-evidence-a"], first.audit.evidence_refs)
        self.assertEqual(1, len(repository.capability_audits))
        with self.assertRaisesRegex(PolicyViolation, "gate1_lease_not_active"):
            await registry.invoke(
                CapabilityAudience.USER_QA, context(item, activity_id="gate1-second"), request,
                ToolCallBudget(max_calls=1), evidence_admission=AcceptingAdmission(),
            )

    async def test_exact_lease_permits_one_bound_fresh_read_and_every_stale_axis_fails_closed(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        await repository.put_binding(item)
        authority = Gate1LeaseAuthority(repository, now=lambda: NOW)
        await repository.append_gate1_lease(lease(item))
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        await authority.assert_active(context(item), request)

        invalid = {
            "expiry": (lease(item, expires_at=NOW), context(item)),
            "revocation": (lease(item, status=Gate1LeaseStatus.REVOKED, lease_revision=2), context(item)),
            "tenant": (lease(item), context(item, tenant_id="tenant-b")),
            "run": (lease(item), context(item, run_id="run-public-b")),
            "topology": (lease(item), context(item, topology_revision="topology-v1-b")),
            "projection": (lease(item), context(item, projection_revision=2)),
            "evidence": (lease(item), context(item, evidence_revision=2)),
            "registry": (lease(item), context(item, capability_registry_revision="capability-registry.v4")),
            "component": (lease(item), context(item, component_ids=["payments"])),
            "permission": (lease(item), context(item, subject_permissions=[])),
            "precondition": (lease(item), context(item, precondition_hash="b" * 64)),
        }
        for label, (replacement, scoped) in invalid.items():
            with self.subTest(label=label):
                isolated = InMemoryWorkspaceRepository()
                await isolated.put_binding(item)
                await isolated.append_gate1_lease(replacement)
                with self.assertRaises(PolicyViolation):
                    await Gate1LeaseAuthority(isolated, now=lambda: NOW).assert_active(scoped, request)

        for label, wrong_request in {
            "capability": request.copy(update={"capability": CapabilityName.LOGS}),
            "data_class": request.copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}),
            "component": request.copy(update={"component_id": "payments"}),
        }.items():
            with self.subTest(label=label):
                with self.assertRaises(PolicyViolation):
                    await authority.assert_active(context(item), wrong_request)

    async def test_temporal_action_activity_issues_one_lease_and_invalidates_the_old_card(self):
        item = binding()
        repository = InMemoryWorkspaceRepository()
        await repository.put_binding(item)
        current = projection(item)
        await repository.put_projection(current)
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
        )
        card = NextBestActionGenerator(registry).generate(current, datetime.now(timezone.utc))[0]
        await repository.append_next_best_action(card)
        dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
        command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, action_id=card.action_id, idempotency_key="gate1-click-a",
        )
        result = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
            **item.dict(), projection=current, event_sequence=2, command=command,
            actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        ).dict())
        self.assertEqual("GATE1_GRANTED", result["receipt"]["status"])
        self.assertEqual(2, result["projection"]["projection_revision"])
        lease_id = result["receipt"]["gate1_lease_id"]
        active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, lease_id)
        self.assertIsNotNone(active)
        retry = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
            **item.dict(), projection=result["projection"], event_sequence=3, command=command,
            actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        ).dict())
        self.assertEqual("GATE1_GRANTED", retry["receipt"]["status"])
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_idempotency_conflict"):
            await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
                **item.dict(), projection=result["projection"], event_sequence=3,
                command=command.copy(update={"action_id": "other-card"}),
                actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
            ).dict())


if __name__ == "__main__":
    unittest.main()

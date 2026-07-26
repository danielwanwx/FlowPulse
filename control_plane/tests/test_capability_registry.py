"""Shared strict capability-policy seams for autonomous and user conversation paths."""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import (
    CapabilityAdapter,
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityEvidenceAdmission,
    CapabilityGate,
    CapabilityInvocationContext,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityResult,
    CapabilityScope,
    CapabilityScopeAuthority,
    EmptyCapabilityInput,
    RecordedContextInput,
    ToolCallBudget,
)
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_models import IncidentRunBinding
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def context():
    return CapabilityInvocationContext(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
        projection_revision=1, evidence_revision=1, component_ids=["checkout"], activity_id="conversation:checkout",
        scope=CapabilityScope.USER_QA, subject_id="viewer-a", authorized_subjects=["viewer-a"],
        data_class=CapabilityDataClass.RECORDED_CONTEXT, recorded_evidence_ids=["evidence-current"],
        gate1_authorized=False,
    )


class AcceptingAuthority:
    def __init__(self):
        self.contexts = []

    async def assert_scope(self, invocation_context):
        self.contexts.append(invocation_context)


class GatewayAdmission:
    def __init__(self, repository, subject_id):
        self.repository = repository
        self.subject_id = subject_id

    async def admit(self, result, invocation_context):
        from flowpulse_cp.integrity import EvidenceGateway

        gateway = EvidenceGateway(self.repository, self.subject_id)
        for evidence in result.evidence:
            gateway.admit(evidence)
        for claim in result.claims:
            gateway.admit_claim(claim)
        return result


class RecordedContextAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.RECORDED_CONTEXT, version="recorded-context.v1",
        fresh_read=False, enabled=True, data_classes=[CapabilityDataClass.RECORDED_CONTEXT],
        required_gate=CapabilityGate.NONE, input_schema="recorded-context-input.v1",
        audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
    )

    input_model = RecordedContextInput
    result_model = CapabilityResult

    async def invoke(self, request, invocation_context):
        return CapabilityResult(summary="Recorded context only.")


class CapabilityRegistryTests(unittest.TestCase):
    def registry(self):
        return CapabilityRegistry(
            descriptors=[
                RecordedContextAdapter.descriptor,
                CapabilityDescriptor(
                    capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True,
                    data_classes=[CapabilityDataClass.CURRENT_INCIDENT], required_gate=CapabilityGate.GATE1,
                    input_schema="empty.v1",
                    enabled=True, audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
                ),
                CapabilityDescriptor(
                    capability=CapabilityName.LOGS, version="logs.v1", fresh_read=True,
                    data_classes=[CapabilityDataClass.CURRENT_INCIDENT], required_gate=CapabilityGate.GATE1,
                    input_schema="empty.v1",
                    enabled=False, audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
                ),
            ],
            adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextAdapter()},
            policy_version="capability-policy.v1", scope_authority=AcceptingAuthority(),
        )

    def test_disabled_or_unbound_adapter_is_omitted_from_every_shared_tool_list(self):
        registry = self.registry()
        autonomous = registry.available(CapabilityAudience.AUTONOMOUS_DIAGNOSIS)
        user_qa = registry.available(CapabilityAudience.USER_QA)
        self.assertEqual([CapabilityName.RECORDED_CONTEXT], [item.capability for item in autonomous])
        self.assertEqual(autonomous, user_qa)
        self.assertNotIn(CapabilityName.METRICS, [item.capability for item in autonomous])
        self.assertNotIn(CapabilityName.LOGS, [item.capability for item in autonomous])

    def test_autonomous_and_user_qa_use_one_policy_and_one_strict_audit_record_shape(self):
        registry = self.registry()
        request = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout",
            data_class=CapabilityDataClass.RECORDED_CONTEXT, parameters={"evidence_ids": ["evidence-current"]},
        )
        autonomous = asyncio.run(registry.invoke(
            CapabilityAudience.AUTONOMOUS_DIAGNOSIS, context(), request, ToolCallBudget(max_calls=1),
        ))
        user = asyncio.run(registry.invoke(
            CapabilityAudience.USER_QA, context(), request, ToolCallBudget(max_calls=1),
        ))
        self.assertEqual("Recorded context only.", autonomous.result.summary)
        self.assertEqual("Recorded context only.", user.result.summary)
        self.assertEqual("capability-policy.v1", autonomous.audit.policy_version)
        self.assertEqual(["evidence-current"], autonomous.audit.evidence_refs)
        self.assertEqual(type(autonomous.audit), type(user.audit))
        self.assertEqual(CapabilityAudience.AUTONOMOUS_DIAGNOSIS, autonomous.audit.audience)
        self.assertEqual(CapabilityAudience.USER_QA, user.audit.audience)

    def test_tool_inputs_component_scope_and_budget_are_fail_closed(self):
        registry = self.registry()
        with self.assertRaisesRegex(PolicyViolation, "capability_input_schema_invalid"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context(), CapabilityRequest(
                    capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout",
                    data_class=CapabilityDataClass.RECORDED_CONTEXT,
                    parameters={"evidence_ids": ["evidence-current"], "misspelled": "reject"},
                ), ToolCallBudget(max_calls=1),
            ))
        forged_component = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="payments",
            data_class=CapabilityDataClass.RECORDED_CONTEXT, parameters={"evidence_ids": ["evidence-current"]},
        )
        with self.assertRaisesRegex(PolicyViolation, "capability_component_not_canonical"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context(), forged_component, ToolCallBudget(max_calls=1),
            ))
        budget = ToolCallBudget(max_calls=1)
        valid = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout",
            data_class=CapabilityDataClass.RECORDED_CONTEXT, parameters={"evidence_ids": ["evidence-current"]},
        )
        asyncio.run(registry.invoke(CapabilityAudience.USER_QA, context(), valid, budget))
        with self.assertRaisesRegex(PolicyViolation, "capability_tool_budget_exhausted"):
            asyncio.run(registry.invoke(CapabilityAudience.USER_QA, context(), valid, budget))
        with self.assertRaisesRegex(PolicyViolation, "capability_tool_budget_exceeds_authoritative_scope"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context(), valid, ToolCallBudget(max_calls=2),
            ))

    def test_capability_audit_is_appended_to_the_same_workspace_binding(self):
        repository = InMemoryWorkspaceRepository()
        invocation = context()
        asyncio.run(repository.put_binding(IncidentRunBinding.parse_obj({
            field: getattr(invocation, field) for field in IncidentRunBinding.__fields__
        })))
        registry = CapabilityRegistry(
            descriptors=[RecordedContextAdapter.descriptor],
            adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextAdapter()},
            policy_version="capability-policy.v1", audit_sink=repository, scope_authority=AcceptingAuthority(),
        )
        result = asyncio.run(registry.invoke(
            CapabilityAudience.USER_QA,
            invocation,
            CapabilityRequest(
                capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout",
                data_class=CapabilityDataClass.RECORDED_CONTEXT,
                parameters={"evidence_ids": ["evidence-current"]},
            ),
            ToolCallBudget(max_calls=1),
        ))
        self.assertEqual(result.audit, repository.capability_audits[result.audit.audit_id])

    def test_scope_data_class_and_subject_acl_fail_before_any_adapter_invocation(self):
        registry = self.registry()
        wrong_run = context().copy(update={"run_id": "temporal-run-a"})
        request = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout",
            data_class=CapabilityDataClass.RECORDED_CONTEXT, parameters={"evidence_ids": ["evidence-current"]},
        )
        with self.assertRaisesRegex(PolicyViolation, "capability_public_run_must_not_be_temporal_identity"):
            asyncio.run(registry.invoke(CapabilityAudience.USER_QA, wrong_run, request, ToolCallBudget(max_calls=1)))
        with self.assertRaisesRegex(PolicyViolation, "capability_subject_acl_denied"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context().copy(update={"authorized_subjects": ["other-subject"]}),
                request, ToolCallBudget(max_calls=1),
            ))
        with self.assertRaisesRegex(PolicyViolation, "capability_data_class_not_allowed"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context().copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}),
                request.copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}), ToolCallBudget(max_calls=1),
            ))


if __name__ == "__main__":
    unittest.main()

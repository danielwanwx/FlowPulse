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
    CapabilityDescriptor,
    CapabilityInvocationContext,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityResult,
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
        projection_revision=1, component_ids=["checkout"], activity_id="conversation:checkout",
        gate1_authorized=False,
    )


class RecordedContextAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.RECORDED_CONTEXT, version="recorded-context.v1",
        fresh_read=False, enabled=True,
        audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
    )

    async def invoke(self, request, invocation_context):
        return CapabilityResult(summary="Recorded context only.", evidence_refs=["evidence-current"])


class CapabilityRegistryTests(unittest.TestCase):
    def registry(self):
        return CapabilityRegistry(
            descriptors=[
                RecordedContextAdapter.descriptor,
                CapabilityDescriptor(
                    capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True,
                    enabled=True, audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
                ),
                CapabilityDescriptor(
                    capability=CapabilityName.LOGS, version="logs.v1", fresh_read=True,
                    enabled=False, audiences=[CapabilityAudience.AUTONOMOUS_DIAGNOSIS, CapabilityAudience.USER_QA],
                ),
            ],
            adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextAdapter()},
            policy_version="capability-policy.v1",
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
            capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout", parameters={"window": "recorded"},
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
        with self.assertRaises(ValidationError):
            CapabilityRequest.parse_obj({
                "capability": "RECORDED_CONTEXT", "component_id": "checkout", "parameters": {"window": 5},
            })
        forged_component = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="payments", parameters={"window": "recorded"},
        )
        with self.assertRaisesRegex(PolicyViolation, "capability_component_not_canonical"):
            asyncio.run(registry.invoke(
                CapabilityAudience.USER_QA, context(), forged_component, ToolCallBudget(max_calls=1),
            ))
        budget = ToolCallBudget(max_calls=1)
        valid = CapabilityRequest(
            capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout", parameters={"window": "recorded"},
        )
        asyncio.run(registry.invoke(CapabilityAudience.USER_QA, context(), valid, budget))
        with self.assertRaisesRegex(PolicyViolation, "capability_tool_budget_exhausted"):
            asyncio.run(registry.invoke(CapabilityAudience.USER_QA, context(), valid, budget))

    def test_capability_audit_is_appended_to_the_same_workspace_binding(self):
        repository = InMemoryWorkspaceRepository()
        invocation = context()
        asyncio.run(repository.put_binding(IncidentRunBinding.parse_obj({
            field: getattr(invocation, field) for field in IncidentRunBinding.__fields__
        })))
        registry = CapabilityRegistry(
            descriptors=[RecordedContextAdapter.descriptor],
            adapters={CapabilityName.RECORDED_CONTEXT: RecordedContextAdapter()},
            policy_version="capability-policy.v1", audit_sink=repository,
        )
        result = asyncio.run(registry.invoke(
            CapabilityAudience.USER_QA,
            invocation,
            CapabilityRequest(
                capability=CapabilityName.RECORDED_CONTEXT, component_id="checkout", parameters={"window": "recorded"},
            ),
            ToolCallBudget(max_calls=1),
        ))
        self.assertEqual(result.audit, repository.capability_audits[result.audit.audit_id])


if __name__ == "__main__":
    unittest.main()

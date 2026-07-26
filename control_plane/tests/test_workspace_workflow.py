"""Temporal-owned NodeExplanation behavior, including the pre-Gate-1 degraded boundary."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher, build_workspace_activities
from flowpulse_cp.workspace_models import NodeExplanationStart, WorkspaceNodeExplanationInvocation, WorkspaceWorkflowRequest
from flowpulse_cp.workspace_actions import ActionInvocationCommand, WorkspaceActionInvocation
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow
from flowpulse_cp.models import AuthContext
from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.capabilities import (
    CapabilityAudience, CapabilityDataClass, CapabilityDescriptor, CapabilityGate,
    CapabilityName, CapabilityRegistry, CapabilityResult, EmptyCapabilityInput,
)


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def request():
    return WorkspaceWorkflowRequest(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a", workflow_run_id="pending",
        created_at=NOW, actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
        title="Checkout degraded", severity="SEV2", environment="prod", affected_entities=["checkout"],
        summary="test",
    )


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_TEST_TEMPORAL") == "1",
    "requires an installed Temporal test server; Compose is the live workflow proof",
)
class WorkspaceWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_gate1_card_is_authorized_and_advanced_only_by_temporal_update(self):
        class MetricsAdapter:
            descriptor = CapabilityDescriptor(
                capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
                audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
                required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
            )
            input_model = EmptyCapabilityInput
            result_model = CapabilityResult

            async def invoke(self, parsed_input, invocation_context):
                return CapabilityResult(summary="test metrics")

        repository = InMemoryWorkspaceRepository()
        authority = HmacAuthorizationAuthority("workspace-workflow-action-test-secret")
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-action-contract-test"
            async with Worker(
                environment.client, task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(WorkspaceActivityDispatcher(
                    repository, authorization=authority, capability_registry=registry,
                )),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run, request().dict(), id="workspace-action-test", task_queue=task_queue,
                )
                for _ in range(50):
                    current = await repository.get_projection("tenant-a", "case-a")
                    cards = await repository.workspace_next_best_actions("tenant-a", "case-a")
                    if current is not None and cards:
                        break
                    await asyncio.sleep(0.01)
                self.assertIsNotNone(current)
                self.assertEqual(1, len(cards))
                command = ActionInvocationCommand(
                    incident_id=current.incident_id, run_id=current.run_id,
                    topology_revision=current.topology_revision,
                    projection_revision=current.projection_revision,
                    action_id=cards[0].action_id, idempotency_key="gate1-temporal-a",
                )
                assertion = authority.issue_workspace_action_intent(
                    await repository.create_workspace_action_intent(request().actor, current, command)
                )
                accepted = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.invoke_next_best_action,
                    WorkspaceActionInvocation(command=command, authorization=assertion).dict(),
                )
                self.assertEqual("GATE1_GRANTED", accepted["status"])
                lease = await repository.workspace_gate1_lease("tenant-a", "case-a", accepted["gate1_lease_id"])
                self.assertIsNotNone(lease)
                self.assertEqual("ACTIVE", lease.status.value)
                rejected = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.invoke_next_best_action, command.dict(),
                )
                self.assertFalse(rejected["accepted"])
                self.assertEqual(1, len(repository.gate1_leases))

    async def test_same_key_node_updates_reuse_one_degraded_read_only_explanation(self):
        repository = InMemoryWorkspaceRepository()
        authority = HmacAuthorizationAuthority("workspace-workflow-test-secret")
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-contract-test"
            async with Worker(
                environment.client, task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(WorkspaceActivityDispatcher(repository, authorization=authority)),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run, request().dict(), id="workspace-test-a", task_queue=task_queue,
                )
                for _ in range(50):
                    projection = await repository.get_projection("tenant-a", "case-a")
                    if projection is not None:
                        break
                    await asyncio.sleep(0.01)
                self.assertIsNotNone(projection)
                command = NodeExplanationStart(
                    incident_id="incident-a", run_id="run-public-a", topology_revision="topology-v1-a",
                    projection_revision=1, component_id="checkout", idempotency_key="click-a",
                )
                first_assertion = authority.issue_workspace_node_explanation_intent(
                    await repository.create_workspace_node_explanation_intent(request().actor, projection, command)
                )
                second_assertion = authority.issue_workspace_node_explanation_intent(
                    await repository.create_workspace_node_explanation_intent(request().actor, projection, command)
                )
                first, second = await asyncio.gather(
                    handle.execute_update(
                        IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
                        WorkspaceNodeExplanationInvocation(command=command, authorization=first_assertion).dict(),
                    ),
                    handle.execute_update(
                        IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
                        WorkspaceNodeExplanationInvocation(command=command, authorization=second_assertion).dict(),
                    ),
                )
                self.assertEqual(first["explanation"]["explanation_id"], second["explanation"]["explanation_id"])
                self.assertIn(first["reused"], (True, False))
                explanation = first["explanation"]
                self.assertEqual("DEGRADED", explanation["state"])
                self.assertFalse(explanation["fresh_read_performed"])
                self.assertFalse(explanation["fresh_diagnosis_claimed"])
                self.assertEqual("provider_unavailable", explanation["degraded_code"])


if __name__ == "__main__":
    unittest.main()

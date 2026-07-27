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
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    Gate1LeaseAuthority,
    WorkspaceActionInvocation,
)
from flowpulse_cp.workspace_investigation import (
    DeterministicInvestigationCritic,
    DeterministicInvestigationSynthesizer,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.models import AuthContext
from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.capabilities import (
    CapabilityAudience, CapabilityDataClass, CapabilityDescriptor, CapabilityGate,
    CapabilityName, CapabilityRegistry, CapabilityResult, EmptyCapabilityInput,
)
from tests.test_gate1_capabilities import AcceptingScope, CurrentMetricsAdapter


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
    async def test_test_mode_initialization_persists_and_returns_the_full_topology(self):
        repository = InMemoryWorkspaceRepository()
        dispatcher = WorkspaceActivityDispatcher(
            repository,
            topology_provider=CapturedAstronomyTopologyProvider(ProviderMode.TEST),
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-topology-snapshot-test"
            async with Worker(
                environment.client,
                task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(dispatcher),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    request().dict(),
                    id="workspace-topology-snapshot",
                    task_queue=task_queue,
                )
                returned = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.await_workspace_projection,
                )
                persisted = await repository.get_projection("tenant-a", "case-a")
                self.assertEqual(persisted.dict(), returned)
                self.assertEqual(22, len(persisted.graph.nodes))
                self.assertEqual(26, len(persisted.graph.edges))
                self.assertEqual(
                    [
                        "frontend", "checkout", "payment",
                        "kafka", "accounting", "fraud-detection",
                    ],
                    persisted.impacted_path,
                )

    async def test_explanation_then_gate1_advances_the_single_event_sequence(self):
        repository = InMemoryWorkspaceRepository()
        authority = HmacAuthorizationAuthority("workspace-explanation-gate1-sequence-secret")
        adapter = CurrentMetricsAdapter()
        registry = CapabilityRegistry(
            descriptors=[adapter.descriptor],
            adapters={CapabilityName.METRICS: adapter},
        )
        dispatcher = WorkspaceActivityDispatcher(
            repository, authorization=authority, capability_registry=registry,
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-explanation-gate1-sequence-test"
            async with Worker(
                environment.client, task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(dispatcher),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    request().dict(), id="workspace-explanation-gate1-sequence",
                    task_queue=task_queue,
                )
                for _ in range(50):
                    current = await repository.get_projection("tenant-a", "case-a")
                    cards = await repository.workspace_next_best_actions("tenant-a", "case-a")
                    if current is not None and cards:
                        break
                    await asyncio.sleep(0.01)
                explanation_command = NodeExplanationStart(
                    incident_id=current.incident_id, run_id=current.run_id,
                    topology_revision=current.topology_revision,
                    projection_revision=current.projection_revision,
                    component_id="checkout", idempotency_key="explain-before-gate1",
                )
                explanation_assertion = authority.issue_workspace_node_explanation_intent(
                    await repository.create_workspace_node_explanation_intent(
                        request().actor, current, explanation_command,
                    ),
                )
                explained = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
                    WorkspaceNodeExplanationInvocation(
                        command=explanation_command,
                        authorization=explanation_assertion,
                    ).dict(),
                )
                self.assertFalse(explained["reused"])

                gate_card = cards[0]
                gate_command = ActionInvocationCommand(
                    incident_id=current.incident_id, run_id=current.run_id,
                    topology_revision=current.topology_revision,
                    projection_revision=current.projection_revision,
                    action_id=gate_card.action_id, idempotency_key="gate1-after-explanation",
                )
                gate_assertion = authority.issue_workspace_action_intent(
                    await repository.create_workspace_action_intent(
                        request().actor, current, gate_command,
                    ),
                )
                granted = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.invoke_next_best_action,
                    WorkspaceActionInvocation(
                        command=gate_command, authorization=gate_assertion,
                    ).dict(),
                )
                self.assertEqual("GATE1_GRANTED", granted["status"])
                projected = await repository.get_projection("tenant-a", "case-a")
                self.assertEqual(4, projected.sequence)
                self.assertEqual(
                    [1, 2, 3, 4],
                    [
                        event.sequence
                        for event in await repository.workspace_events_after(
                            "tenant-a", "case-a", 0,
                        )
                    ],
                )

    async def test_fresh_read_runs_synthesis_and_independent_critic_before_decide(self):
        repository = InMemoryWorkspaceRepository()
        authority = HmacAuthorizationAuthority("workspace-investigation-workflow-secret")
        synthesizer = DeterministicInvestigationSynthesizer()
        critic = DeterministicInvestigationCritic()
        adapter = CurrentMetricsAdapter()
        registry = CapabilityRegistry(
            descriptors=[adapter.descriptor], adapters={CapabilityName.METRICS: adapter},
            scope_authority=AcceptingScope(), gate1_authority=Gate1LeaseAuthority(repository),
        )
        dispatcher = WorkspaceActivityDispatcher(
            repository, authorization=authority, capability_registry=registry,
            investigation_synthesizer=synthesizer, investigation_critic=critic,
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-investigation-workflow-test"
            async with Worker(
                environment.client, task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(dispatcher),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    request().dict(), id="workspace-investigation-test", task_queue=task_queue,
                )
                for _ in range(50):
                    current = await repository.get_projection("tenant-a", "case-a")
                    cards = await repository.workspace_next_best_actions("tenant-a", "case-a")
                    if current is not None and cards:
                        break
                    await asyncio.sleep(0.01)
                gate_card = cards[0]
                grant_command = ActionInvocationCommand(
                    incident_id=current.incident_id, run_id=current.run_id,
                    topology_revision=current.topology_revision,
                    projection_revision=current.projection_revision,
                    action_id=gate_card.action_id, idempotency_key="investigation-gate1",
                )
                grant_assertion = authority.issue_workspace_action_intent(
                    await repository.create_workspace_action_intent(
                        request().actor, current, grant_command,
                    ),
                )
                grant = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.invoke_next_best_action,
                    WorkspaceActionInvocation(
                        command=grant_command, authorization=grant_assertion,
                    ).dict(),
                )
                self.assertEqual("GATE1_GRANTED", grant["status"])
                granted_projection = await repository.get_projection("tenant-a", "case-a")
                read_card = next(
                    card for card in await repository.workspace_next_best_actions("tenant-a", "case-a")
                    if card.cta.value == "run_read_capability"
                )
                read_command = ActionInvocationCommand(
                    incident_id=granted_projection.incident_id,
                    run_id=granted_projection.run_id,
                    topology_revision=granted_projection.topology_revision,
                    projection_revision=granted_projection.projection_revision,
                    action_id=read_card.action_id,
                    idempotency_key="investigation-fresh-read",
                )
                read_assertion = authority.issue_workspace_action_intent(
                    await repository.create_workspace_action_intent(
                        request().actor, granted_projection, read_command,
                    ),
                )
                receipt = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.invoke_next_best_action,
                    WorkspaceActionInvocation(
                        command=read_command, authorization=read_assertion,
                    ).dict(),
                )
                self.assertEqual("FRESH_READ_COMPLETED", receipt["status"])
                projected = await repository.get_projection("tenant-a", "case-a")
                self.assertEqual("DECIDE", projected.lifecycle_stage.value)
                self.assertEqual("ACCEPTED", projected.investigation_result.disposition.value)
                self.assertEqual(1, synthesizer.call_count)
                self.assertEqual(1, critic.call_count)
                reloaded = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.await_workspace_projection,
                )
                self.assertEqual(projected, type(projected).parse_obj(reloaded))
                events = await repository.workspace_events_after("tenant-a", "case-a", 0)
                self.assertEqual(
                    1,
                    sum(event.event_type == "workspace.investigation.accepted" for event in events),
                )

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

"""Continue-as-new proof for the live V2 Incident Workspace contract."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from flowpulse_cp.models import AuthContext
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.workspace_activities import (
    WorkspaceActivityDispatcher,
    build_workspace_activities,
)
from flowpulse_cp.workspace_models import IncidentRunBinding, WorkspaceWorkflowRequest, initial_projection
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider
from flowpulse_cp.workspace_v3_models import TemporalExecutionPointerV3
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


NOW = datetime(2026, 7, 30, 22, 0, tzinfo=timezone.utc)


def request():
    return WorkspaceWorkflowRequest(
        tenant_id="tenant-a",
        incident_id="incident-a",
        run_id="run-public-a",
        topology_revision="topology-a",
        case_id="case-a",
        case_revision=1,
        workflow_id="workspace-v2-rollover-test",
        workflow_run_id="pending",
        created_at=NOW,
        actor=AuthContext(tenant_id="tenant-a", subject_id="owner-a", roles=["owner"]),
        title="Checkout degraded",
        severity="SEV2",
        environment="test",
        affected_entities=["checkout"],
        summary="Continue-as-new must preserve this public incident.",
    )


class WorkspaceV2RolloverCarryTests(unittest.TestCase):
    def test_rollover_drops_disposable_receipt_caches(self):
        workflow_instance = IncidentWorkspaceTemporalWorkflow()
        workflow_request = request()
        binding = IncidentRunBinding.parse_obj({
            field: getattr(workflow_request, field)
            for field in IncidentRunBinding.__fields__
        })
        workflow_instance._execution_pointer = TemporalExecutionPointerV3(
            tenant_id=binding.tenant_id,
            incident_run_id=binding.run_id,
            temporal_workflow_id=binding.workflow_id,
            temporal_run_id="temporal-run-a",
            temporal_generation=1,
            updated_at=NOW,
        )
        workflow_instance._projection = initial_projection(
            binding,
            workflow_request.affected_entities,
            workflow_request.created_at,
            workflow_request.title,
            workflow_request.summary,
        )
        workflow_instance._event_sequence = 1
        large_receipt = {"payload": "x" * 3_000_000}
        workflow_instance._explanations = {"explanation": large_receipt}
        workflow_instance._actions = {"action": large_receipt}
        workflow_instance._action_receipts = {"action-receipt": large_receipt}
        workflow_instance._realtime_receipts = {"realtime-receipt": large_receipt}

        carry = workflow_instance._rollover_carry()

        self.assertEqual({}, carry.explanations)
        self.assertEqual({}, carry.actions)
        self.assertEqual({}, carry.action_receipts)
        self.assertEqual({}, carry.realtime_receipts)
        self.assertLess(len(carry.json().encode("utf-8")), 2_000_000)


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_TEST_TEMPORAL") == "1",
    "requires the Temporal test server",
)
class WorkspaceV2RolloverTests(unittest.IsolatedAsyncioTestCase):
    async def test_rollover_preserves_projection_and_advances_execution_pointer(self):
        repository = InMemoryWorkspaceRepository()
        dispatcher = WorkspaceActivityDispatcher(
            repository,
            topology_provider=CapturedAstronomyTopologyProvider(ProviderMode.TEST),
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "workspace-v2-rollover"
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(dispatcher),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    request().dict(),
                    id=request().workflow_id,
                    task_queue=queue,
                )
                for _ in range(100):
                    state = await handle.query(
                        IncidentWorkspaceTemporalWorkflow.workspace_runtime_state,
                    )
                    if state.get("initialized"):
                        break
                    await asyncio.sleep(0.01)
                self.assertTrue(state["rollover_enabled"])
                first = await repository.current_temporal_execution_v3(
                    "tenant-a", "run-public-a",
                )
                self.assertEqual(1, first.temporal_generation)
                initial_projection = await repository.get_projection("tenant-a", "case-a")

                await handle.signal(
                    IncidentWorkspaceTemporalWorkflow.request_workspace_rollover,
                )
                for _ in range(200):
                    current = await repository.current_temporal_execution_v3(
                        "tenant-a", "run-public-a",
                    )
                    if current is not None and current.temporal_generation == 2:
                        break
                    await asyncio.sleep(0.01)

                self.assertEqual(2, current.temporal_generation)
                self.assertNotEqual(first.temporal_run_id, current.temporal_run_id)
                self.assertEqual(initial_projection, await repository.get_projection("tenant-a", "case-a"))
                await environment.client.get_workflow_handle(request().workflow_id).cancel()


if __name__ == "__main__":
    unittest.main()

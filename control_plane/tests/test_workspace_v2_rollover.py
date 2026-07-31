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
from flowpulse_cp.workspace_models import WorkspaceWorkflowRequest
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider
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

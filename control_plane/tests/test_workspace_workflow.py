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
from flowpulse_cp.workspace_models import NodeExplanationStart, WorkspaceWorkflowRequest
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow
from flowpulse_cp.models import AuthContext


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
    async def test_same_key_node_updates_reuse_one_degraded_read_only_explanation(self):
        repository = InMemoryWorkspaceRepository()
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            task_queue = "workspace-contract-test"
            async with Worker(
                environment.client, task_queue=task_queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=build_workspace_activities(WorkspaceActivityDispatcher(repository)),
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
                first, second = await asyncio.gather(
                    handle.execute_update(IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation, command.dict()),
                    handle.execute_update(IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation, command.dict()),
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

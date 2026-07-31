import asyncio
import os
import unittest
from datetime import datetime, timezone

from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from flowpulse_cp.workspace_v3_models import (
    IncidentExecutionIdentityV3,
    WorkspaceExecutionRegistrationV3,
    WorkspaceWorkflowRequestV3,
)
from flowpulse_cp.workspace_v3_workflow import (
    IncidentWorkspaceTemporalWorkflowV3,
)


NOW = datetime(2026, 7, 30, 22, 0, tzinfo=timezone.utc)


def request():
    return WorkspaceWorkflowRequestV3(
        identity=IncidentExecutionIdentityV3(
            tenant_id="tenant-a",
            incident_id="incident-a",
            incident_run_id="run-public-a",
            topology_revision="topology-a",
            case_id="case-a",
            case_revision=1,
            temporal_workflow_id="workspace-v3-rollover-test",
            created_at=NOW,
        ),
        projection_ref="projection:case-a:1",
        projection_revision=1,
        signal_revision=1,
        decision_revision=1,
        workspace_revision=1,
        case_event_sequence=1,
    )


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_TEST_TEMPORAL") == "1",
    "requires the Temporal test server",
)
class WorkspaceV3WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_manual_rollover_registers_second_generation_without_reset(self):
        registrations = []

        @activity.defn(name="workspace_register_execution_v3_activity")
        async def register(packet):
            parsed = WorkspaceExecutionRegistrationV3.parse_obj(packet)
            registrations.append(parsed)
            return parsed.current.dict()

        async with await WorkflowEnvironment.start_time_skipping() as environment:
            async with Worker(
                environment.client,
                task_queue="workspace-v3-rollover",
                workflows=[IncidentWorkspaceTemporalWorkflowV3],
                activities=[register],
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflowV3.run,
                    request().dict(),
                    id="workspace-v3-rollover-test",
                    task_queue="workspace-v3-rollover",
                )
                for _ in range(100):
                    state = await handle.query(
                        IncidentWorkspaceTemporalWorkflowV3.workspace_runtime_state_v3,
                    )
                    if state.get("initialized"):
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(1, state["state"]["current_execution"]["temporal_generation"])
                await handle.signal(
                    IncidentWorkspaceTemporalWorkflowV3.request_workspace_rollover_v3,
                )
                for _ in range(200):
                    if len(registrations) == 2:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(2, len(registrations))
                self.assertEqual(2, registrations[1].current.temporal_generation)
                self.assertEqual(
                    registrations[0].current.temporal_run_id,
                    registrations[1].prior.temporal_run_id,
                )
                await environment.client.get_workflow_handle(
                    "workspace-v3-rollover-test",
                ).cancel()


if __name__ == "__main__":
    unittest.main()

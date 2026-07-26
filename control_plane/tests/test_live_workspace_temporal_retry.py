"""Real Temporal retry proof for the workspace_initialize activity's lost-ACK seam."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker

from flowpulse_cp.models import AuthContext
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher, build_workspace_activities
from flowpulse_cp.workspace_models import WorkspaceWorkflowRequest
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


class LoseFirstWorkspaceInitializeCompletion:
    """Persists normally, then models a worker completion response lost in transit once."""

    def __init__(self, repository):
        self.delegate = WorkspaceActivityDispatcher(repository)
        self.initialize_attempts = 0

    async def dispatch(self, activity_name, packet):
        result = await self.delegate.dispatch(activity_name, packet)
        if activity_name == "workspace_initialize_activity":
            self.initialize_attempts += 1
            if self.initialize_attempts == 1:
                raise ApplicationError("test_lost_activity_completion", non_retryable=False)
        return result


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_WORKSPACE_TEMPORAL_RETRY") == "1",
    "requires the local Compose Temporal/Postgres stack",
)
class LiveWorkspaceTemporalRetryTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN", "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse",
    )

    def test_lost_activity_completion_retries_without_blocking_projection_read_after_start(self):
        async def run():
            suffix = uuid4().hex
            request = WorkspaceWorkflowRequest(
                tenant_id="tenant-workspace-temporal-{}".format(suffix),
                incident_id="incident-workspace-temporal-{}".format(suffix),
                run_id="public-workspace-run-{}".format(suffix),
                topology_revision="topology-v1-workspace-{}".format(suffix),
                case_id="workspace-case-temporal-{}".format(suffix), case_revision=1,
                workflow_id="flowpulse.workspace.retry.{}".format(suffix), workflow_run_id="pending",
                created_at=datetime.now(timezone.utc),
                actor=AuthContext(
                    tenant_id="tenant-workspace-temporal-{}".format(suffix),
                    subject_id="viewer-workspace-retry", roles=["viewer"],
                ),
                title="Lost activity completion retry", severity="SEV2", environment="local",
                affected_entities=["checkout"], summary="Live retry proof.",
            )
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            client = await Client.connect(self.address)
            dispatcher = LoseFirstWorkspaceInitializeCompletion(repository)
            queue = "flowpulse-workspace-retry-{}".format(suffix)
            try:
                async with Worker(
                    client, task_queue=queue, workflows=[IncidentWorkspaceTemporalWorkflow],
                    activities=build_workspace_activities(dispatcher),
                ):
                    handle = await client.start_workflow(
                        IncidentWorkspaceTemporalWorkflow.run, request.dict(), id=request.workflow_id, task_queue=queue,
                    )
                    projection = await asyncio.wait_for(
                        handle.execute_update(IncidentWorkspaceTemporalWorkflow.await_workspace_projection), timeout=30,
                    )
                    self.assertEqual(request.case_id, projection["case_id"])
                    self.assertEqual(request.run_id, projection["run_id"])
                    self.assertEqual(2, dispatcher.initialize_attempts)

                    async def counts(connection):
                        return await connection.fetchrow(
                            """SELECT
                                 (SELECT count(*) FROM incident_projections WHERE tenant_id=$1 AND case_id=$2) AS projections,
                                 (SELECT count(*) FROM incident_projection_events WHERE tenant_id=$1 AND case_id=$2) AS events""",
                            request.tenant_id, request.case_id,
                        )
                    self.assertEqual((1, 1), tuple(await repository._tenant(request.tenant_id, counts)))
                    await handle.terminate(reason="live_workspace_retry_test_complete")
            finally:
                await repository.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

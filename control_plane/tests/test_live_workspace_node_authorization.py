"""Live Temporal proof that a bare legacy node command cannot reach provider work."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client

from flowpulse_cp.models import AuthContext
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_models import NodeExplanationStart, WorkspaceWorkflowRequest
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_WORKSPACE_AUTHORIZATION") == "1",
    "requires isolated local Compose Temporal/Postgres",
)
class LiveWorkspaceNodeAuthorizationTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")
    queue = os.environ.get("FLOWPULSE_TEMPORAL_TASK_QUEUE", "flowpulse-diagnosis-p0")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN", "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse",
    )

    def test_direct_temporal_bare_legacy_command_is_rejected_without_auth_or_explanation_activity(self):
        async def run():
            suffix = uuid4().hex
            tenant = "tenant-workspace-direct-{}".format(suffix)
            request = WorkspaceWorkflowRequest(
                tenant_id=tenant, incident_id="incident-{}".format(suffix), run_id="run-{}".format(suffix),
                topology_revision="topology-v1-{}".format(suffix), case_id="case-{}".format(suffix),
                case_revision=1, workflow_id="flowpulse.workspace.direct.{}".format(suffix), workflow_run_id="pending",
                created_at=datetime.now(timezone.utc),
                actor=AuthContext(tenant_id=tenant, subject_id="authorized-subject", roles=["viewer"]),
                title="Direct legacy command", severity="SEV2", environment="local", affected_entities=["checkout"],
                summary="Live authorization boundary proof.",
            )
            client = await Client.connect(self.address)
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            handle = await client.start_workflow(
                IncidentWorkspaceTemporalWorkflow.run, request.dict(), id=request.workflow_id, task_queue=self.queue,
            )
            try:
                response = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
                    NodeExplanationStart(
                        incident_id=request.incident_id, run_id=request.run_id,
                        topology_revision=request.topology_revision, projection_revision=1,
                        component_id="checkout", idempotency_key="bare-legacy",
                    ).dict(),
                )
                self.assertFalse(response["accepted"])
                self.assertIn("field required", response["reason"])
                history = (await handle.fetch_history()).to_json()
                self.assertNotIn("workspace_authorize_node_explanation_activity", history)
                self.assertNotIn("workspace_node_explanation_activity", history)

                async def counts(connection):
                    return await connection.fetchrow(
                        """SELECT
                             (SELECT count(*) FROM node_explanations WHERE tenant_id=$1 AND case_id=$2) AS explanations,
                             (SELECT count(*) FROM tool_calls WHERE tenant_id=$1 AND case_id=$2) AS audits""",
                        tenant, request.case_id,
                    )
                self.assertEqual((0, 0), tuple(await repository._tenant(tenant, counts)))
            finally:
                await handle.terminate(reason="live_workspace_auth_test_complete")
                await repository.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

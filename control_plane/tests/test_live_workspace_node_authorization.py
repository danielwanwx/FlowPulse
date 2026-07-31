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

from flowpulse_cp.authorization import HttpAuthorizationClient
from flowpulse_cp.models import AuthContext
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_models import (
    NodeExplanationStart,
    WorkspaceNodeExplanationInvocation,
    WorkspaceWorkflowRequest,
)
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

    async def _counts(self, repository, tenant, case_id):
        async def counts(connection):
            return await connection.fetchrow(
                """SELECT
                     (SELECT count(*) FROM node_explanations WHERE tenant_id=$1 AND case_id=$2) AS explanations,
                     (SELECT count(*) FROM tool_calls WHERE tenant_id=$1 AND case_id=$2) AS audits""",
                tenant, case_id,
            )
        return tuple(await repository._tenant(tenant, counts))

    async def _assert_rejected_without_explanation(self, handle, invocation, repository, tenant, case_id):
        before = await self._counts(repository, tenant, case_id)
        with self.assertRaises(Exception):
            await handle.execute_update(
                IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation, invocation.dict(),
            )
        self.assertEqual(before, await self._counts(repository, tenant, case_id))
        history = (await handle.fetch_history()).to_json()
        self.assertNotIn("workspace_node_explanation_activity", history)

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

                self.assertEqual((0, 0), await self._counts(repository, tenant, request.case_id))
            finally:
                await handle.terminate(reason="live_workspace_auth_test_complete")
                await repository.close()

        asyncio.run(run())

    def test_forged_scope_replay_and_empty_evidence_never_reach_explanation_activity(self):
        """All live direct-Temporal variants remain behind server-minted authorization."""
        async def run():
            suffix = uuid4().hex
            tenant = "tenant-workspace-assertion-{}".format(suffix)
            actor = AuthContext(tenant_id=tenant, subject_id="authorized-subject", roles=["viewer"])
            request = WorkspaceWorkflowRequest(
                tenant_id=tenant, incident_id="incident-{}".format(suffix), run_id="run-{}".format(suffix),
                topology_revision="topology-v1-{}".format(suffix), case_id="case-{}".format(suffix),
                case_revision=1, workflow_id="flowpulse.workspace.assertion.{}".format(suffix),
                workflow_run_id="pending", created_at=datetime.now(timezone.utc), actor=actor,
                title="Direct assertion boundary", severity="SEV2", environment="local",
                affected_entities=["checkout"], summary="Live authorization boundary proof.",
            )
            command = NodeExplanationStart(
                incident_id=request.incident_id, run_id=request.run_id,
                topology_revision=request.topology_revision, projection_revision=1,
                component_id="checkout", idempotency_key="assertion-proof",
            )
            client = await Client.connect(self.address)
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            handle = await client.start_workflow(
                IncidentWorkspaceTemporalWorkflow.run, request.dict(), id=request.workflow_id, task_queue=self.queue,
            )
            try:
                await handle.execute_update(IncidentWorkspaceTemporalWorkflow.await_workspace_projection)
                binding = await repository.workspace_binding(tenant, request.case_id)
                projection = await repository.workspace_projection(tenant, request.case_id)
                self.assertIsNotNone(binding)
                self.assertIsNotNone(projection)
                authority = HttpAuthorizationClient(
                    os.environ.get("FLOWPULSE_AUTHORIZATION_SERVICE_URL", "http://authz:8091"),
                    "api", os.environ["FLOWPULSE_AUTHZ_API_SERVICE_TOKEN"],
                )

                # An empty projection has no recorded evidence, but an
                # unauthorised subject still cannot create the server intent.
                intruder = AuthContext(tenant_id=tenant, subject_id="empty-evidence-intruder", roles=["viewer"])
                with self.assertRaisesRegex(PolicyViolation, "workspace_authorization_subject_acl_denied"):
                    await repository.create_workspace_node_explanation_intent(intruder, projection, command)
                self.assertEqual((0, 0), await self._counts(repository, tenant, request.case_id))

                for forged in (
                    "tenant",
                    "subject",
                ):
                    intent = await repository.create_workspace_node_explanation_intent(actor, projection, command)
                    assertion = authority.issue_workspace_node_explanation_intent(intent)
                    if forged == "tenant":
                        assertion = assertion.copy(update={"tenant_id": "tenant-forged"})
                    else:
                        assertion = assertion.copy(update={"subject_id": "subject-forged"})
                    await self._assert_rejected_without_explanation(
                        handle, WorkspaceNodeExplanationInvocation(command=command, authorization=assertion),
                        repository, tenant, request.case_id,
                    )

                # A genuine server-created assertion can run once. Its replay
                # is rejected by the same trusted activity without appending a
                # second explanation or capability audit.
                intent = await repository.create_workspace_node_explanation_intent(actor, projection, command)
                assertion = authority.issue_workspace_node_explanation_intent(intent)
                invocation = WorkspaceNodeExplanationInvocation(command=command, authorization=assertion)
                receipt = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation, invocation.dict(),
                )
                self.assertIn("explanation", receipt)
                after_valid = await self._counts(repository, tenant, request.case_id)
                self.assertEqual(1, after_valid[0])
                with self.assertRaises(Exception):
                    await handle.execute_update(
                        IncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation, invocation.dict(),
                    )
                self.assertEqual(after_valid, await self._counts(repository, tenant, request.case_id))
            finally:
                await handle.terminate(reason="live_workspace_assertion_test_complete")
                await repository.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

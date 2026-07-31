"""Authorization seams for live Workspace node explanations.

Each negative stops before the explanation/provider activity.  The only
permitted pre-provider activity is trusted assertion validation.
"""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.models import AuthContext
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanationStart,
    ProjectionState,
    WorkspaceActivityPacket,
    WorkspaceNodeExplanationAuthorizationPacket,
    WorkspaceNodeExplanationInvocation,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def projection(item):
    return IncidentProjection(
        **item.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CLASSIFIED,
            classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )


def command(item):
    return NodeExplanationStart(
        incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
        projection_revision=1, component_id="checkout", idempotency_key="click-a",
    )


class WorkspaceNodeAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = InMemoryWorkspaceRepository()
        self.binding = binding()
        self.projection = projection(self.binding)
        self.command = command(self.binding)
        self.actor = AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"])
        await self.repository.put_binding(self.binding)
        await self.repository.put_projection(self.projection)
        await self.repository.grant_workspace_subject(self.binding, self.actor.subject_id)
        self.authority = HmacAuthorizationAuthority("workspace-test-secret")
        self.dispatcher = WorkspaceActivityDispatcher(self.repository, authorization=self.authority)

    async def _assertion(self, actor=None):
        intent = await self.repository.create_workspace_node_explanation_intent(
            actor or self.actor, self.projection, self.command,
        )
        return self.authority.issue_workspace_node_explanation_intent(intent)

    async def _authorize(self, assertion):
        return await self.dispatcher.dispatch(
            "workspace_authorize_node_explanation_activity",
            WorkspaceNodeExplanationAuthorizationPacket(
                **self.binding.dict(), command=self.command, authorization=assertion,
                projection_revision=self.projection.projection_revision,
            ).dict(),
        )

    async def test_bare_legacy_shape_is_not_a_live_invocation_and_has_no_explanation_side_effect(self):
        with self.assertRaises(ValidationError):
            WorkspaceNodeExplanationInvocation.parse_obj(self.command.dict())
        self.assertEqual({}, self.repository.explanations)
        self.assertEqual({}, self.repository.capability_audits)

    async def test_forged_tenant_or_subject_assertion_stops_before_explanation_activity(self):
        valid = await self._assertion()
        for forged in (
            valid.copy(update={"tenant_id": "tenant-b"}),
            valid.copy(update={"subject_id": "attacker"}),
        ):
            with self.assertRaisesRegex(PolicyViolation, "(scope_mismatch|signature_invalid)"):
                await self._authorize(forged)
        self.assertEqual({}, self.repository.explanations)
        self.assertEqual({}, self.repository.capability_audits)

    async def test_replayed_assertion_is_rejected_before_a_second_explanation_activity(self):
        assertion = await self._assertion()
        authorized = await self._authorize(assertion)
        self.assertEqual(self.actor.dict(), authorized["actor"])
        with self.assertRaisesRegex(PolicyViolation, "auth_assertion_replayed"):
            await self._authorize(assertion)
        self.assertEqual({}, self.repository.explanations)
        self.assertEqual({}, self.repository.capability_audits)

    async def test_empty_evidence_does_not_bypass_workspace_subject_authorization(self):
        intruder = AuthContext(tenant_id="tenant-a", subject_id="intruder", roles=["viewer"])
        with self.assertRaisesRegex(PolicyViolation, "workspace_authorization_subject_acl_denied"):
            await self.repository.create_workspace_node_explanation_intent(intruder, self.projection, self.command)
        self.assertEqual({}, self.repository.explanations)
        self.assertEqual({}, self.repository.capability_audits)


if __name__ == "__main__":
    unittest.main()

"""HTTP may submit a card command; Temporal owns every Gate 1 transition."""

import asyncio
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.capabilities import CapabilityAudience, CapabilityDataClass, CapabilityDescriptor, CapabilityGate, CapabilityName, CapabilityRegistry, CapabilityResult, EmptyCapabilityInput
from flowpulse_cp.models import AuthContext
from flowpulse_cp.workspace_actions import NextBestActionGenerator, WorkspaceActionReceipt
from flowpulse_cp.workspace_models import GraphMembership, IncidentGraph, IncidentGraphNode, IncidentProjection, IncidentRunBinding, ProjectionState
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository


NOW = datetime.now(timezone.utc)


class MetricsAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="test")


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-public-a", topology_revision="topology-a",
        case_id="case-a", case_revision=1, workflow_id="workspace-a", workflow_run_id="temporal-a", created_at=NOW,
    )


def projection(revision=1, sequence=1):
    return IncidentProjection(
        **binding().dict(), projection_revision=revision, sequence=sequence, lifecycle_state=ProjectionState.DEGRADED,
        status="degraded", generated_at=NOW, graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CLASSIFIED,
            classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), evidence_revision=revision, gate_revision=1, action_revision=1,
    )


class RecordingStarter:
    def __init__(self):
        self.calls = []

    async def invoke_next_best_action(self, item, command, authorization):
        self.calls.append((item, command, authorization))
        return WorkspaceActionReceipt(
            **binding().dict(), action_id=command.action_id, idempotency_key=command.idempotency_key,
            status="GATE1_REQUESTED", reason="submitted_to_temporal",
        )


class IncidentWorkspaceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.repository = InMemoryWorkspaceRepository()
        self.starter = RecordingStarter()
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
        )
        self.card = NextBestActionGenerator(registry).generate(projection(), NOW)[0]
        asyncio.run(self.repository.put_binding(binding()))
        asyncio.run(self.repository.grant_workspace_subject(binding(), "subject-a"))
        asyncio.run(self.repository.put_projection(projection()))
        asyncio.run(self.repository.append_next_best_action(self.card))
        self.app = create_app(
            workspace_repository=self.repository, workspace_starter=self.starter,
            authorization=HmacAuthorizationAuthority("workspace-action-test-secret"),
        )
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"],
        )
        self.client = TestClient(self.app)

    def _body(self, **changes):
        body = {
            "incident_id": self.card.incident_id, "run_id": self.card.run_id,
            "topology_revision": self.card.topology_revision,
            "projection_revision": self.card.projection_revision,
            "action_id": self.card.action_id, "idempotency_key": "click-a",
        }
        body.update(changes)
        return body

    def test_generic_action_reloads_card_and_rejects_browser_scope_or_stale_card(self):
        cards = self.client.get("/v1/incidents/case-a/actions")
        self.assertEqual(200, cards.status_code, cards.text)
        self.assertEqual([self.card.action_id], [item["action_id"] for item in cards.json()])
        accepted = self.client.post(
            "/v1/incidents/case-a/actions/{}".format(self.card.action_id), json=self._body(),
        )
        self.assertEqual(202, accepted.status_code, accepted.text)
        self.assertEqual("GATE1_REQUESTED", accepted.json()["status"])
        self.assertEqual(1, len(self.starter.calls))
        for field in ("capability", "scope", "tool", "proposal", "outcome", "approval"):
            with self.subTest(field=field):
                self.assertEqual(422, self.client.post(
                    "/v1/incidents/case-a/actions/{}".format(self.card.action_id),
                    json=self._body(**{field: "browser-forged"}),
                ).status_code)

        asyncio.run(self.repository.put_projection(projection(revision=2, sequence=2)))
        stale = self.client.post(
            "/v1/incidents/case-a/actions/{}".format(self.card.action_id), json=self._body(idempotency_key="click-b"),
        )
        self.assertEqual(409, stale.status_code, stale.text)
        self.assertEqual(1, len(self.starter.calls))
        self.assertEqual([], self.client.get("/v1/incidents/case-a/actions").json())


if __name__ == "__main__":
    unittest.main()

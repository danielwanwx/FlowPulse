"""FastAPI seams for Temporal-authoritative workspace projections and SSE."""

import asyncio
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.models import AuthContext
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    NodeExplanation,
    NodeExplanationReceipt,
    NodeExplanationState,
    ProjectionState,
    WorkspaceIntake,
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
        schema_version="flowpulse.incident-projection.v1", **item.dict(),
        projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CONNECTED,
            runtime_status="unknown", impact_status="unknown",
        )]), impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )


class FakeWorkspaceStarter:
    def __init__(self, repository):
        self.repository = repository

    async def start_workspace(self, intake, actor):
        item = binding()
        result = projection(item)
        await self.repository.put_binding(item)
        await self.repository.put_projection(result)
        await self.repository.append_event(IncidentEvent(
            **item.dict(), projection_revision=1, sequence=1, event_type="workspace.initialized",
            occurred_at=NOW, payload={"state": "provider_unavailable"},
        ))
        return result

    async def start_or_reuse_node_explanation(self, item, command, actor):
        selection_key = command.selection_key(item.tenant_id)
        explanation = NodeExplanation(
            **binding().dict(), explanation_id="node-a", selection_key=selection_key,
            projection_revision=1, component_id=command.component_id,
            conversation_schema_version=command.conversation_schema_version,
            state=NodeExplanationState.DEGRADED, summary="No provider; no fresh read.", evidence_refs=[],
            fresh_read_performed=False, fresh_diagnosis_claimed=False, degraded_code="provider_unavailable",
        )
        stored, reused = await self.repository.start_or_reuse_explanation(explanation)
        return NodeExplanationReceipt(explanation=stored, reused=reused)


class IncidentWorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.workspace = InMemoryWorkspaceRepository()
        self.app = create_app(
            workspace_repository=self.workspace,
            workspace_starter=FakeWorkspaceStarter(self.workspace),
        )
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"],
        )
        self.client = TestClient(self.app)

    def test_routes_preserve_public_identity_and_sse_resumes_strictly_after(self):
        intake = WorkspaceIntake(
            incident_id="incident-a", title="Checkout degraded", severity="SEV2", environment="prod",
            affected_entities=["checkout"], observed_at=NOW, summary="test",
        )
        response = self.client.post("/v1/incidents", json=json.loads(intake.json()))
        self.assertEqual(202, response.status_code, response.text)
        body = response.json()
        self.assertEqual("run-public-a", body["run_id"])
        self.assertNotEqual(body["run_id"], body["workflow_run_id"])
        self.assertEqual("topology-v1-a", body["topology_revision"])
        explanation = self.client.post("/v1/incidents/case-a/node-explanations", json={
            "incident_id": "incident-a", "run_id": "run-public-a", "topology_revision": "topology-v1-a",
            "projection_revision": 1, "component_id": "checkout", "idempotency_key": "click-a",
        })
        self.assertEqual(202, explanation.status_code, explanation.text)
        self.assertEqual("DEGRADED", explanation.json()["explanation"]["state"])
        stream = self.client.get("/v1/incidents/case-a/events?after=0")
        self.assertEqual(200, stream.status_code, stream.text)
        self.assertIn("id: 1", stream.text)
        resumed = self.client.get("/v1/incidents/case-a/events?after=1")
        self.assertNotIn("id: 1", resumed.text)

    def test_cross_tenant_or_mismatched_public_identity_fails_closed(self):
        asyncio.run(self.workspace.put_binding(binding()))
        asyncio.run(self.workspace.put_projection(projection(binding())))
        response = self.client.post("/v1/incidents/case-a/node-explanations", json={
            "incident_id": "incident-a", "run_id": "temporal-run-a", "topology_revision": "topology-v1-a",
            "projection_revision": 1, "component_id": "checkout", "idempotency_key": "forged",
        })
        self.assertEqual(409, response.status_code, response.text)


if __name__ == "__main__":
    unittest.main()

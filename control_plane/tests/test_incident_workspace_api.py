"""FastAPI seams for Temporal-authoritative workspace projections and SSE."""

import asyncio
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.models import AuthContext
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentEvent,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ExplanationEventStatus,
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


def projection(item, title="Incident active", summary="An active incident requires attention."):
    return IncidentProjection(
        schema_version="flowpulse.incident-projection.v1", **item.dict(),
        projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", operator_title=title, operator_summary=summary, generated_at=NOW,
        graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CLASSIFIED,
            classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )


class FakeWorkspaceStarter:
    def __init__(self, repository):
        self.repository = repository

    async def start_workspace(self, intake, actor):
        item = binding()
        result = projection(item, intake.title, intake.summary)
        await self.repository.put_binding(item)
        await self.repository.grant_workspace_subject(item, actor.subject_id)
        await self.repository.put_projection(result)
        await self.repository.append_event(IncidentEvent(
            **item.dict(), projection_revision=1, sequence=1, event_type="workspace.initialized",
            occurred_at=NOW, payload={"state": "provider_unavailable"},
        ))
        return result

    async def start_or_reuse_node_explanation(self, item, command, authorization):
        selection_key = command.selection_key(item.tenant_id)
        await self.repository.append_event(IncidentEvent(
            **binding().dict(), projection_revision=1, sequence=2, event_type="node_explanation.started",
            occurred_at=NOW, payload={"component_id": command.component_id, "selection_key": selection_key},
            explanation_status=ExplanationEventStatus.STARTED,
        ))
        explanation = NodeExplanation(
            **binding().dict(), explanation_id="node-a", selection_key=selection_key,
            projection_revision=1, component_id=command.component_id,
            conversation_schema_version=command.conversation_schema_version,
            state=NodeExplanationState.DEGRADED, summary="No provider; no fresh read.", evidence_refs=[],
            fresh_read_performed=False, fresh_diagnosis_claimed=False, degraded_code="provider_unavailable",
        )
        stored, reused = await self.repository.start_or_reuse_explanation(explanation)
        await self.repository.append_event(IncidentEvent(
            **binding().dict(), projection_revision=1, sequence=3, event_type="node_explanation.degraded",
            occurred_at=NOW, payload={"explanation_id": stored.explanation_id, "truth_label": "DEGRADED"},
            explanation_status=ExplanationEventStatus.DEGRADED,
        ))
        return NodeExplanationReceipt(explanation=stored, reused=reused)


class IncidentWorkspaceApiTests(unittest.TestCase):
    def setUp(self):
        self.workspace = InMemoryWorkspaceRepository()
        self.app = create_app(
            workspace_repository=self.workspace,
            workspace_starter=FakeWorkspaceStarter(self.workspace),
            authorization=HmacAuthorizationAuthority("test-secret"),
        )
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"],
        )
        self.app.state.workspace_sse_poll_seconds = 0.005
        self.app.state.workspace_sse_heartbeat_seconds = 0.02
        self.client = TestClient(self.app)

    def _stream_request(self):
        disconnected = {"value": False}

        async def receive():
            if disconnected["value"]:
                return {"type": "http.disconnect"}
            return {"type": "http.request", "body": b"", "more_body": False}

        return Request({"type": "http", "app": self.app, "headers": []}, receive), disconnected

    async def _case_event_chunks(self, after, count):
        endpoint = next(
            route.endpoint for route in self.app.routes
            if getattr(route, "name", "") == "workspace_events"
        )
        request, _ = self._stream_request()
        response = await endpoint(
            case_id="case-a", request=request, after=after, last_event_id=None,
            actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
        )
        iterator = response.body_iterator
        chunks = [await asyncio.wait_for(iterator.__anext__(), timeout=0.2) for _ in range(count)]
        await iterator.aclose()
        return "".join(chunks)

    async def _notification_chunk(self, last_event_id=None):
        endpoint = next(
            route.endpoint for route in self.app.routes
            if getattr(route, "name", "") == "workspace_incident_notifications"
        )
        request, _ = self._stream_request()
        response = await endpoint(
            request=request, after=None, last_event_id=last_event_id,
            actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
        )
        iterator = response.body_iterator
        chunk = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
        await iterator.aclose()
        return chunk

    def test_global_notification_stream_stays_live_resumes_and_delivers_without_reconnect(self):
        intake = WorkspaceIntake(
            incident_id="incident-a", title="Checkout latency", severity="SEV2", environment="prod",
            affected_entities=["checkout"], observed_at=NOW, summary="Checkout requests are degraded.",
        )
        self.assertEqual(202, self.client.post("/v1/incidents", json=json.loads(intake.json())).status_code)

        async def exercise():
            endpoint = next(
                route.endpoint for route in self.app.routes
                if getattr(route, "name", "") == "workspace_incident_notifications"
            )
            first_request, _ = self._stream_request()
            first_response = await endpoint(
                request=first_request, after=None, last_event_id=None,
                actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
            )
            first_iterator = first_response.body_iterator
            first_body = await asyncio.wait_for(first_iterator.__anext__(), timeout=0.2)
            await first_iterator.aclose()
            first_id = next(
                line.removeprefix("id: ")
                for line in first_body.splitlines()
                if line.startswith("id: ")
            )
            await self.workspace.append_event(IncidentEvent(
                **binding().dict(), projection_revision=1, sequence=2,
                event_type="workspace.updated", occurred_at=NOW, payload={"state": "updated"},
            ))
            request, disconnected = self._stream_request()
            response = await endpoint(
                request=request, after=None, last_event_id=first_id,
                actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
            )
            iterator = response.body_iterator
            replayed = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            heartbeat = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            await self.workspace.append_event(IncidentEvent(
                **binding().dict(), projection_revision=1, sequence=3,
                event_type="workspace.updated", occurred_at=NOW, payload={"state": "updated-again"},
            ))
            newly_durable = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            disconnected["value"] = True
            with self.assertRaises(StopAsyncIteration):
                await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            return first_id, replayed, heartbeat, newly_durable

        first_id, replayed, heartbeat, newly_durable = asyncio.run(exercise())
        self.assertNotIn("id: " + first_id + "\n", replayed)
        self.assertIn("event: incident-notification", replayed)
        self.assertTrue(heartbeat.startswith(": heartbeat"))
        self.assertIn("event: incident-notification", newly_durable)
        self.assertNotEqual(replayed, newly_durable)

    def test_case_event_stream_stays_live_resumes_and_delivers_without_reconnect(self):
        intake = WorkspaceIntake(
            incident_id="incident-a", title="Checkout latency", severity="SEV2", environment="prod",
            affected_entities=["checkout"], observed_at=NOW, summary="Checkout requests are degraded.",
        )
        self.assertEqual(202, self.client.post("/v1/incidents", json=json.loads(intake.json())).status_code)

        async def exercise():
            endpoint = next(
                route.endpoint for route in self.app.routes
                if getattr(route, "name", "") == "workspace_events"
            )
            await self.workspace.append_event(IncidentEvent(
                **binding().dict(), projection_revision=1, sequence=2,
                event_type="workspace.updated", occurred_at=NOW, payload={"state": "updated"},
            ))
            request, disconnected = self._stream_request()
            response = await endpoint(
                case_id="case-a", request=request, after=1, last_event_id=None,
                actor=AuthContext(tenant_id="tenant-a", subject_id="subject-a", roles=["viewer"]),
            )
            iterator = response.body_iterator
            replayed = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            heartbeat = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            await self.workspace.append_event(IncidentEvent(
                **binding().dict(), projection_revision=1, sequence=3,
                event_type="workspace.updated", occurred_at=NOW, payload={"state": "updated-again"},
            ))
            newly_durable = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            disconnected["value"] = True
            with self.assertRaises(StopAsyncIteration):
                await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            return replayed, heartbeat, newly_durable

        replayed, heartbeat, newly_durable = asyncio.run(exercise())
        self.assertIn("id: 2\n", replayed)
        self.assertNotIn("id: 1\n", replayed)
        self.assertTrue(heartbeat.startswith(": heartbeat"))
        self.assertIn("id: 3\n", newly_durable)

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
        stream = asyncio.run(self._case_event_chunks(0, 3))
        self.assertIn("id: 1", stream)
        resumed = asyncio.run(self._case_event_chunks(1, 2))
        self.assertNotIn("id: 1", resumed)

    def test_cross_tenant_or_mismatched_public_identity_fails_closed(self):
        asyncio.run(self.workspace.put_binding(binding()))
        asyncio.run(self.workspace.put_projection(projection(binding())))
        response = self.client.post("/v1/incidents/case-a/node-explanations", json={
            "incident_id": "incident-a", "run_id": "temporal-run-a", "topology_revision": "topology-v1-a",
            "projection_revision": 1, "component_id": "checkout", "idempotency_key": "forged",
        })
        self.assertEqual(409, response.status_code, response.text)

    def test_browser_hydrates_active_incident_and_resumes_global_notifications_without_side_effects(self):
        """Discovery is a tenant-scoped read seam; focus never creates a turn."""
        intake = WorkspaceIntake(
            incident_id="incident-a", title="Checkout latency", severity="SEV2", environment="prod",
            affected_entities=["checkout"], observed_at=NOW, summary="Checkout requests are degraded.",
        )
        accepted = self.client.post("/v1/incidents", json=json.loads(intake.json()))
        self.assertEqual(202, accepted.status_code, accepted.text)
        # This is the browser's toast hydration read.  It must neither accept a
        # tenant parameter nor issue another Temporal start/update.
        discovered = self.client.get("/v1/incidents?state=active&tenant_id=tenant-attacker")
        self.assertEqual(200, discovered.status_code, discovered.text)
        summaries = discovered.json()
        self.assertEqual(1, len(summaries))
        summary = summaries[0]
        self.assertEqual("case-a", summary["case_id"])
        self.assertEqual("incident-a", summary["incident_id"])
        self.assertEqual("run-public-a", summary["run_id"])
        self.assertEqual("Checkout latency", summary["title"])
        self.assertEqual("Checkout requests are degraded.", summary["summary"])
        projected = self.client.get("/v1/incidents/case-a/projection")
        self.assertEqual(200, projected.status_code, projected.text)
        self.assertEqual("Checkout", projected.json()["graph"]["nodes"][0]["display_name"])

        notifications = asyncio.run(self._notification_chunk())
        self.assertIn("event: incident-notification", notifications)
        notification_id = next(
            line.removeprefix("id: ") for line in notifications.splitlines() if line.startswith("id: ")
        )
        resumed = asyncio.run(self._notification_chunk(notification_id))
        self.assertTrue(resumed.startswith(": heartbeat"))
        self.assertEqual(0, len(self.workspace.explanations))

    def test_explanation_events_are_bounded_status_records_and_receipt_remains_content_source(self):
        intake = WorkspaceIntake(
            incident_id="incident-a", title="Checkout latency", severity="SEV2", environment="prod",
            affected_entities=["checkout"], observed_at=NOW, summary="Checkout requests are degraded.",
        )
        self.assertEqual(202, self.client.post("/v1/incidents", json=json.loads(intake.json())).status_code)
        started = self.client.post("/v1/incidents/case-a/node-explanations", json={
            "incident_id": "incident-a", "run_id": "run-public-a", "topology_revision": "topology-v1-a",
            "projection_revision": 1, "component_id": "checkout", "idempotency_key": "click-status-a",
        })
        self.assertEqual(202, started.status_code, started.text)
        receipt = started.json()
        stream = asyncio.run(self._case_event_chunks(1, 2))
        self.assertIn('"event_type": "node_explanation.started"', stream)
        self.assertIn('"event_type": "node_explanation.degraded"', stream)
        self.assertIn(receipt["explanation"]["explanation_id"], stream)
        self.assertNotIn(receipt["explanation"]["summary"], stream)


if __name__ == "__main__":
    unittest.main()

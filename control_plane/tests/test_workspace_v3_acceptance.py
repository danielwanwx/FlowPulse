"""Acceptance seams for the public V3 workflow, SSE, and Live contracts."""

import asyncio
import copy
import json
import unittest
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.requests import Request

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.models import AuthContext
from flowpulse_cp.realtime_models import MetricSeriesCollectionV3
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_v3_guided import GuidedWorkflowCoordinatorV3
from flowpulse_cp.workspace_v3_models import (
    ActionApprovalCommandV3,
    AgentRunCommandV3,
    IncidentEventV3,
    IncidentProjectionV3,
    LiveEventV3,
    LiveIncidentSummaryV3,
    LiveSnapshotV3,
    WorkflowCommandNameV3,
    WorkflowCommandReceiptV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowEventTypeV3,
    WorkflowRerunCommandV3,
    WorkflowStageV3,
    WorkflowTemporalOperationV3,
)


EXAMPLES_PATH = (
    Path(__file__).resolve().parents[1]
    / "openapi"
    / "flowpulse-incident-workflow-v3.examples.json"
)


def examples():
    return json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))


def actor():
    return AuthContext(
        tenant_id="tenant-a",
        subject_id="subject-a",
        roles=["owner"],
    )


def stream_request(app):
    disconnected = {"value": False}

    async def receive():
        if disconnected["value"]:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {"type": "http", "app": app, "headers": []},
        receive,
    ), disconnected


def route_endpoint(app, name):
    return next(
        route.endpoint
        for route in app.routes
        if getattr(route, "name", "") == name
    )


class BoundaryRepository:
    """Small public repository boundary used by the HTTP acceptance tests."""

    def __init__(self):
        payload = examples()
        self.projection = IncidentProjectionV3.parse_obj(payload["projection"])
        self.legacy_projection = object()
        event = IncidentEventV3.parse_obj(payload["event"])
        self.incident_events = [
            event.copy(update={
                "event_id": "event-six",
                "sequence": 6,
            }),
            event.copy(update={
                "event_id": "event-seven",
                "sequence": 7,
            }),
        ]
        summary = LiveSnapshotV3.parse_obj(payload["live_snapshot"]).incidents[0]
        self.live_events = [
            LiveEventV3(
                event_id="live-event-six",
                sequence=6,
                event_type="workflow.stage.progress",
                occurred_at=event.occurred_at,
                incident=summary,
            ),
            LiveEventV3(
                event_id="live-event-seven",
                sequence=7,
                event_type="workflow.stage.completed",
                occurred_at=event.occurred_at,
                incident=summary,
            ),
        ]
        self.incident_checkpoints = []
        self.live_checkpoints = []
        self.mutation_calls = []

    async def workspace_projection_v3(self, tenant_id, case_id):
        if tenant_id == "tenant-a" and case_id == "case-a":
            return self.projection
        return None

    async def workspace_projection(self, tenant_id, case_id):
        if tenant_id == "tenant-a" and case_id == "case-a":
            return self.legacy_projection
        return None

    async def workspace_active_projections_v3(self, tenant_id, limit=100):
        return [self.projection] if tenant_id == "tenant-a" else []

    async def workspace_live_cursor_v3(self, tenant_id):
        return 7 if tenant_id == "tenant-a" else 0

    async def workspace_live_snapshot_v3(self, tenant_id, limit=100):
        if tenant_id != "tenant-a":
            return LiveSnapshotV3(
                generated_at=self.projection.generated_at,
                sequence=0,
                incidents=[],
            )
        return LiveSnapshotV3(
            generated_at=self.projection.generated_at,
            sequence=7,
            incidents=[LiveIncidentSummaryV3.from_projection(self.projection)][:limit],
        )

    async def workspace_events_v3_after(self, tenant_id, case_id, after):
        self.incident_checkpoints.append(after)
        return [item for item in self.incident_events if item.sequence > after]

    async def workspace_event_bounds_v3(self, tenant_id, case_id):
        records = (
            self.incident_events
            if tenant_id == "tenant-a" and case_id == "case-a" else []
        )
        return (
            (records[0].sequence, records[-1].sequence)
            if records else (None, None)
        )

    async def workspace_live_events_v3_after(self, tenant_id, after):
        self.live_checkpoints.append(after)
        return [item for item in self.live_events if item.sequence > after]

    async def workspace_live_event_bounds_v3(self, tenant_id):
        records = self.live_events if tenant_id == "tenant-a" else []
        return (
            (records[0].sequence, records[-1].sequence)
            if records else (None, None)
        )

    async def commit_workspace_transition_v3(self, *args, **kwargs):
        self.mutation_calls.append((args, kwargs))
        raise AssertionError("HTTP must not perform a workflow transition directly")


class RecordingTemporalStarter:
    def __init__(self):
        self.calls = []

    async def submit_workflow_command_v3(self, projection, invocation):
        self.calls.append((projection, invocation))
        receipt = copy.deepcopy(examples()["command_receipt"])
        receipt["actor_subject_id"] = invocation.actor_subject_id
        receipt["command_name"] = {
            WorkflowTemporalOperationV3.ADVANCE: WorkflowCommandNameV3.NEXT.value,
            WorkflowTemporalOperationV3.RERUN: WorkflowCommandNameV3.RERUN_FROM_STAGE.value,
            WorkflowTemporalOperationV3.ESCALATE: WorkflowCommandNameV3.ESCALATE.value,
            WorkflowTemporalOperationV3.AGENT_RUN: WorkflowCommandNameV3.START_AGENT_RUN.value,
            WorkflowTemporalOperationV3.ACTION_APPROVAL: WorkflowCommandNameV3.APPROVE_ACTION.value,
        }[invocation.operation]
        return WorkflowCommandReceiptV3.parse_obj(receipt)


class WorkspaceV3HttpAuthorityAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.repository = BoundaryRepository()
        self.starter = RecordingTemporalStarter()
        self.app = create_app(
            workspace_repository=self.repository,
            workspace_starter=self.starter,
            trusted_fixture_identities={"owner-token": actor()},
        )
        self.app.state.workspace_sse_poll_seconds = 0.005
        self.app.state.workspace_sse_heartbeat_seconds = 0.02
        self.client = TestClient(self.app)
        self.headers = {"authorization": "Bearer owner-token"}

    def test_authenticated_commands_delegate_server_owned_identity_to_temporal(self):
        payload = examples()["commands"]
        cases = [
            (
                "/v3/incidents/case-a/workflow/advance",
                payload["advance"],
                WorkflowTemporalOperationV3.ADVANCE,
                None,
                None,
            ),
            (
                "/v3/incidents/case-a/workflow/stages/TRIAGE/rerun",
                payload["rerun"],
                WorkflowTemporalOperationV3.RERUN,
                WorkflowStageV3.TRIAGE,
                None,
            ),
            (
                "/v3/incidents/case-a/workflow/escalations",
                payload["escalation"],
                WorkflowTemporalOperationV3.ESCALATE,
                None,
                None,
            ),
            (
                "/v3/incidents/case-a/agent-runs",
                payload["agent_run"],
                WorkflowTemporalOperationV3.AGENT_RUN,
                None,
                None,
            ),
            (
                "/v3/incidents/case-a/actions/action-a/approval",
                payload["approval"],
                WorkflowTemporalOperationV3.ACTION_APPROVAL,
                None,
                "action-a",
            ),
        ]

        for path, body, operation, target_stage, action_id in cases:
            with self.subTest(path=path):
                before = len(self.starter.calls)
                response = self.client.post(path, json=body, headers=self.headers)
                self.assertEqual(202, response.status_code, response.text)
                self.assertEqual(before + 1, len(self.starter.calls))
                legacy_projection, invocation = self.starter.calls[-1]
                self.assertIs(self.repository.legacy_projection, legacy_projection)
                self.assertEqual(operation, invocation.operation)
                self.assertEqual("tenant-a", invocation.tenant_id)
                self.assertEqual("case-a", invocation.case_id)
                self.assertEqual("subject-a", invocation.actor_subject_id)
                self.assertEqual(["owner"], invocation.actor_roles)
                self.assertEqual(target_stage, invocation.target_stage)
                self.assertEqual(action_id, invocation.action_id)
                self.assertNotIn("tenant_id", invocation.command)
                self.assertNotIn("actor_subject_id", invocation.command)

        self.assertEqual([], self.repository.mutation_calls)

    def test_command_without_authenticated_identity_is_rejected_before_temporal(self):
        response = self.client.post(
            "/v3/incidents/case-a/workflow/advance",
            json=examples()["commands"]["advance"],
        )
        self.assertEqual(401, response.status_code, response.text)
        self.assertEqual([], self.starter.calls)

    def test_command_body_cannot_forge_tenant_actor_or_roles(self):
        forged = {
            **examples()["commands"]["advance"],
            "tenant_id": "tenant-attacker",
            "actor_subject_id": "attacker",
            "actor_roles": ["owner"],
        }
        response = self.client.post(
            "/v3/incidents/case-a/workflow/advance",
            json=forged,
            headers=self.headers,
        )
        self.assertEqual(422, response.status_code, response.text)
        self.assertEqual([], self.starter.calls)

    def test_cross_tenant_incident_reads_streams_and_commands_fail_closed(self):
        tenant_b = AuthContext(
            tenant_id="tenant-b", subject_id="owner-b", roles=["owner"],
        )
        app = create_app(
            workspace_repository=self.repository,
            workspace_starter=self.starter,
            trusted_fixture_identities={
                "tenant-a-token": actor(),
                "tenant-b-token": tenant_b,
            },
        )
        client = TestClient(app)
        headers = {"authorization": "Bearer tenant-b-token"}
        reads = (
            "/v3/incidents/case-a/projection",
            "/v3/incidents/case-a/series",
            "/v3/incidents/case-a/events?after=0",
        )
        for path in reads:
            with self.subTest(path=path):
                response = client.get(path, headers=headers)
                self.assertEqual(404, response.status_code, response.text)
                self.assertEqual(
                    "workflow_v3_projection_not_found", response.json()["detail"],
                )

        commands = (
            (
                "/v3/incidents/case-a/workflow/advance",
                examples()["commands"]["advance"],
            ),
            (
                "/v3/incidents/case-a/actions/action-a/approval",
                examples()["commands"]["approval"],
            ),
        )
        before = len(self.starter.calls)
        for path, body in commands:
            with self.subTest(path=path):
                response = client.post(path, json=body, headers=headers)
                self.assertEqual(404, response.status_code, response.text)
                self.assertEqual(
                    "workflow_v3_projection_not_found", response.json()["detail"],
                )
        self.assertEqual(before, len(self.starter.calls))

    def test_temporal_unavailable_fails_closed_without_direct_coordinator_fallback(self):
        app = create_app(
            workspace_repository=self.repository,
            trusted_fixture_identities={"owner-token": actor()},
        )
        response = TestClient(app).post(
            "/v3/incidents/case-a/workflow/advance",
            json=examples()["commands"]["advance"],
            headers=self.headers,
        )
        self.assertEqual(503, response.status_code, response.text)
        self.assertEqual(
            "workspace_temporal_v3_update_unavailable",
            response.json()["detail"],
        )
        self.assertEqual([], self.repository.mutation_calls)

    def test_invalid_last_event_id_is_rejected_before_opening_stream(self):
        for path in (
            "/v3/incidents/case-a/events?after=0",
            "/v3/live/events?after=0",
        ):
            for value in ("not-a-cursor", "-1"):
                with self.subTest(path=path, value=value):
                    response = self.client.get(
                        path,
                        headers={**self.headers, "Last-Event-ID": value},
                    )
                    self.assertEqual(400, response.status_code, response.text)

    def test_eventsource_last_event_id_overrides_older_fixed_url_cursor(self):
        async def exercise():
            incident_endpoint = route_endpoint(self.app, "incident_events_v3")
            incident_request, _ = stream_request(self.app)
            incident_response = await incident_endpoint(
                case_id="case-a",
                request=incident_request,
                after=2,
                last_event_id="5",
                actor=actor(),
            )
            incident_iterator = incident_response.body_iterator
            incident_chunk = await asyncio.wait_for(
                incident_iterator.__anext__(), timeout=0.2,
            )
            await incident_iterator.aclose()

            live_endpoint = route_endpoint(self.app, "live_events_v3")
            live_request, _ = stream_request(self.app)
            live_response = await live_endpoint(
                request=live_request,
                after=2,
                last_event_id="5",
                actor=actor(),
            )
            live_iterator = live_response.body_iterator
            live_chunk = await asyncio.wait_for(
                live_iterator.__anext__(), timeout=0.2,
            )
            await live_iterator.aclose()
            return incident_chunk, live_chunk

        incident_chunk, live_chunk = asyncio.run(exercise())
        self.assertEqual([5], self.repository.incident_checkpoints)
        self.assertEqual([5], self.repository.live_checkpoints)
        self.assertIn("id: 6\n", incident_chunk)
        self.assertNotIn("id: 2\n", incident_chunk)
        self.assertIn("id: 6\n", live_chunk)
        self.assertNotIn("id: 2\n", live_chunk)

    def test_expired_or_ahead_sse_cursor_emits_reset_instead_of_heartbeats(self):
        async def exercise():
            incident_endpoint = route_endpoint(self.app, "incident_events_v3")
            incident_request, _ = stream_request(self.app)
            incident_response = await incident_endpoint(
                case_id="case-a", request=incident_request, after=1,
                last_event_id=None, actor=actor(),
            )
            incident_chunk = await asyncio.wait_for(
                incident_response.body_iterator.__anext__(), timeout=0.2,
            )
            await incident_response.body_iterator.aclose()

            live_endpoint = route_endpoint(self.app, "live_events_v3")
            live_request, _ = stream_request(self.app)
            live_response = await live_endpoint(
                request=live_request, after=99,
                last_event_id=None, actor=actor(),
            )
            live_chunk = await asyncio.wait_for(
                live_response.body_iterator.__anext__(), timeout=0.2,
            )
            await live_response.body_iterator.aclose()
            return incident_chunk, live_chunk

        incident_chunk, live_chunk = asyncio.run(exercise())
        self.assertIn("event: stream-reset-v3", incident_chunk)
        self.assertIn('\"reason\":\"cursor_expired\"', incident_chunk)
        self.assertIn("event: stream-reset-v3", live_chunk)
        self.assertIn('\"reason\":\"cursor_ahead\"', live_chunk)


def initial_projection(
    case_id,
    incident_id,
    run_id,
    generated_offset_seconds=0,
    tenant_id="tenant-a",
):
    raw = copy.deepcopy(examples()["projection"])
    raw.update({
        "case_id": case_id,
        "incident_id": incident_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
        "projection_revision": 1,
        "sequence": 1,
        "workflow_revision": 1,
    })
    raw["current_attempt"].update({
        "attempt_id": "attempt-{}".format(case_id),
        "current_stage": "DETECT",
        "workflow_revision": 1,
        "stage_runs": [raw["current_attempt"]["stage_runs"][0]],
    })
    run = raw["current_attempt"]["stage_runs"][0]
    run.update({
        "stage_run_id": "detect-run-{}".format(case_id),
        "attempt_id": "attempt-{}".format(case_id),
        "input_workflow_revision": 1,
    })
    raw["available_commands"] = ["NEXT", "RERUN_FROM_STAGE"]
    raw["available_rerun_stages"] = ["DETECT"]
    raw["agent_activity"] = []
    raw["hypotheses"] = []
    raw["actions"] = []
    if generated_offset_seconds:
        generated_at = IncidentProjectionV3.parse_obj(raw).generated_at + timedelta(
            seconds=generated_offset_seconds,
        )
        raw["generated_at"] = generated_at.isoformat()
    return IncidentProjectionV3.parse_obj(raw)


def initial_event(projection):
    stage_run = projection.current_attempt.stage_runs[0]
    return IncidentEventV3(
        event_id="initial-event-{}".format(projection.case_id),
        tenant_id=projection.tenant_id,
        case_id=projection.case_id,
        sequence=1,
        event_type=WorkflowEventTypeV3.STAGE_COMPLETED,
        occurred_at=projection.generated_at,
        projection_revision=1,
        workflow_revision=1,
        attempt_id=projection.current_attempt.attempt_id,
        stage=WorkflowStageV3.DETECT,
        stage_run_id=stage_run.stage_run_id,
        actor_subject_id="flowpulse-realtime",
        summary=stage_run.summary,
        progress=100,
        evidence_refs=stage_run.evidence_refs,
    )


class WorkspaceV3LiveCursorAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = InMemoryWorkspaceRepository()
        self.case_a = initial_projection("case-a", "incident-a", "run-a")
        self.case_b = initial_projection(
            "case-b", "incident-b", "run-b", generated_offset_seconds=1,
        )
        await self.repository.initialize_workspace_v3(
            self.case_a, initial_event(self.case_a),
        )
        await self.repository.initialize_workspace_v3(
            self.case_b, initial_event(self.case_b),
        )
        coordinator = GuidedWorkflowCoordinatorV3(self.repository)
        await coordinator.advance(
            "tenant-a",
            "case-a",
            WorkflowCommandV3(
                attempt_id=self.case_a.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.DETECT,
                expected_workflow_revision=1,
                idempotency_key="advance-case-a",
            ),
            "subject-a",
            self.case_a.generated_at + timedelta(seconds=2),
        )
        self.app = create_app(workspace_repository=self.repository)
        self.app.dependency_overrides[trusted_auth_context] = actor
        self.app.state.workspace_sse_poll_seconds = 0.005
        self.app.state.workspace_sse_heartbeat_seconds = 0.02

    async def test_snapshot_and_resume_share_one_monotonic_multi_incident_cursor(self):
        cursor = await self.repository.workspace_live_cursor_v3("tenant-a")
        self.assertEqual(4, cursor)

        snapshot = TestClient(self.app).get("/v3/live/snapshot")
        self.assertEqual(200, snapshot.status_code, snapshot.text)
        self.assertEqual(cursor, snapshot.json()["sequence"])
        self.assertEqual(
            ["case-a", "case-b"],
            [item["case_id"] for item in snapshot.json()["incidents"]],
        )

        endpoint = route_endpoint(self.app, "live_events_v3")
        request, _ = stream_request(self.app)
        response = await endpoint(
            request=request,
            after=1,
            last_event_id=None,
            actor=actor(),
        )
        iterator = response.body_iterator
        chunks = [
            await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
            for _ in range(3)
        ]
        await iterator.aclose()

        self.assertEqual(
            ["id: 2", "id: 3", "id: 4"],
            [chunk.splitlines()[0] for chunk in chunks],
        )
        events = [
            json.loads(next(
                line.removeprefix("data: ")
                for line in chunk.splitlines()
                if line.startswith("data: ")
            ))
            for chunk in chunks
        ]
        self.assertEqual(
            ["case-b", "case-a", "case-a"],
            [item["incident"]["case_id"] for item in events],
        )

    async def test_interleaved_tenants_each_receive_a_contiguous_private_cursor(self):
        repository = InMemoryWorkspaceRepository()
        tenant_a_first = initial_projection(
            "case-a-first", "incident-a-first", "run-a-first",
        )
        tenant_b = initial_projection(
            "case-b-only", "incident-b-only", "run-b-only",
            generated_offset_seconds=1,
            tenant_id="tenant-b",
        )
        tenant_a_second = initial_projection(
            "case-a-second", "incident-a-second", "run-a-second",
            generated_offset_seconds=2,
        )
        for projection in (tenant_a_first, tenant_b, tenant_a_second):
            await repository.initialize_workspace_v3(
                projection, initial_event(projection),
            )

        tenant_a_events = await repository.workspace_live_events_v3_after(
            "tenant-a", 0,
        )
        tenant_b_events = await repository.workspace_live_events_v3_after(
            "tenant-b", 0,
        )
        self.assertEqual([1, 2], [item.sequence for item in tenant_a_events])
        self.assertEqual([1], [item.sequence for item in tenant_b_events])
        self.assertEqual(
            2, await repository.workspace_live_cursor_v3("tenant-a"),
        )
        self.assertEqual(
            1, await repository.workspace_live_cursor_v3("tenant-b"),
        )


class WorkspaceV3CrossLanguageContractAcceptanceTests(unittest.TestCase):
    def test_canonical_json_examples_parse_through_every_python_public_model(self):
        payload = examples()
        projection = IncidentProjectionV3.parse_obj(payload["projection"])
        snapshot = LiveSnapshotV3.parse_obj(payload["live_snapshot"])
        series = MetricSeriesCollectionV3.parse_obj(payload["series"])
        event = IncidentEventV3.parse_obj(payload["event"])
        receipt = WorkflowCommandReceiptV3.parse_obj(payload["command_receipt"])
        commands = payload["commands"]
        parsed_commands = {
            "advance": WorkflowCommandV3.parse_obj(commands["advance"]),
            "rerun": WorkflowRerunCommandV3.parse_obj(commands["rerun"]),
            "escalation": WorkflowEscalationCommandV3.parse_obj(commands["escalation"]),
            "agent_run": AgentRunCommandV3.parse_obj(commands["agent_run"]),
            "approval": ActionApprovalCommandV3.parse_obj(commands["approval"]),
        }

        self.assertEqual("case-a", projection.case_id)
        self.assertEqual(projection.case_id, snapshot.incidents[0].case_id)
        self.assertEqual(projection.case_id, series.case_id)
        self.assertEqual(projection.case_id, event.case_id)
        self.assertEqual(projection, receipt.projection)
        self.assertEqual(
            {
                "advance": "TRIAGE",
                "rerun": "TRIAGE",
                "escalation": "TRIAGE",
                "agent_run": "TRIAGE",
                "approval": "RESPOND",
            },
            {
                key: item.expected_stage.value
                for key, item in parsed_commands.items()
            },
        )


if __name__ == "__main__":
    unittest.main()

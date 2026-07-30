"""Temporal activity and public V2 contract coverage for one accepted source fact."""

import asyncio
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import asyncpg
from fastapi.testclient import TestClient
from starlette.requests import Request
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.models import AuthContext, IncidentCase
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.realtime_activities import (
    RealtimeActivityDispatcher,
    build_realtime_activities,
)
from flowpulse_cp.realtime_adapters import PrometheusNormalizer
from flowpulse_cp.realtime_models import (
    ConnectorDispatch,
    ConnectorDispatchState,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorPollResult,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
    ExternalIdentityBinding,
    RealtimeCommitActivityPacket,
    RealtimeEventType,
    RealtimeIncidentEvent,
    RealtimePollActivityPacket,
    RealtimeUpdateCommand,
    RealtimeUpdateOutcome,
)
from flowpulse_cp.realtime_repository import InMemoryRealtimeRepository
from flowpulse_cp.realtime_scheduler import RealtimeIngestScheduler
from flowpulse_cp.workspace_models import (
    IncidentRunBinding,
    WorkspaceWorkflowRequest,
    WorkspaceIntake,
    initial_projection,
)
from flowpulse_cp.workspace_activities import (
    WorkspaceActivityDispatcher,
    build_workspace_activities,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow


NOW = datetime(2026, 7, 29, 20, 0, tzinfo=timezone.utc)


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-a",
        incident_id="incident-a",
        run_id="run-a",
        topology_revision="topology-a",
        case_id="case-a",
        case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-a",
        workflow_run_id="temporal-run-a",
        created_at=NOW,
    )


def workspace_projection():
    return CapturedAstronomyTopologyProvider(ProviderMode.TEST).snapshot(
        initial_projection(
            binding(), ["checkout"], NOW,
            "Checkout errors rising",
            "Checkout requests are failing.",
        ),
    )


async def accepted_transition(repository):
    prior = workspace_projection()
    registration = ConnectorRegistration(
        connector_id="connector-prometheus-primary",
        tenant_id="tenant-a",
        provider=ConnectorProvider.PROMETHEUS,
        adapter_version="prometheus-read.v1",
        data_classes=["METRIC"],
        capabilities=["METRICS"],
        freshness_sla_seconds=60,
        enabled=True,
        truth_label=ConnectorTruthLabel.TEST_DETERMINISTIC,
    )
    source_binding = ExternalIdentityBinding(
        binding_id="binding-prometheus-run-a-checkout",
        binding_revision=1,
        tenant_id="tenant-a",
        connector_id=registration.connector_id,
        provider=registration.provider,
        external_resource_type="metric",
        external_resource_id="flowpulse_checkout_error_rate",
        case_id=prior.case_id,
        incident_id=prior.incident_id,
        run_id=prior.run_id,
        topology_revision=prior.topology_revision,
        component_ids=["checkout"],
        edge_ids=["frontend->checkout", "checkout->payment"],
        valid_from=NOW,
        status="ACTIVE",
        provenance_source="SERVER_CONNECTOR_CONFIG",
    )
    await repository.register_connector(registration)
    await repository.append_binding(source_binding)
    raw = json.dumps({
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [{
                "metric": {"__name__": "flowpulse_checkout_error_rate", "service": "checkout"},
                "value": [NOW.timestamp(), "0.084"],
            }],
        },
    }, sort_keys=True).encode()
    content_hash = sha256(raw).hexdigest()
    source = PrometheusNormalizer().normalize(
        payload=json.loads(raw),
        registration=registration,
        binding=source_binding,
        provider_event_id="poll:cursor-a",
        received_at=NOW,
        raw_artifact_ref="tenant-a/sha256/" + content_hash,
        raw_content_hash=content_hash,
        acl_subjects=["owner-a"],
    )
    dispatch = ConnectorDispatch(
        dispatch_id="dispatch-" + source.normalization_hash[:24],
        tenant_id=source.tenant_id,
        connector_id=source.connector_id,
        source_event_id=source.source_event_id,
        case_id=source.case_id,
        run_id=source.run_id,
        normalization_hash=source.normalization_hash,
        state=ConnectorDispatchState.PENDING,
        attempt=1,
        created_at=NOW,
    )
    await repository.admit_source_event(source, dispatch)
    health = ConnectorHealth(
        connector_id=registration.connector_id,
        tenant_id=registration.tenant_id,
        provider=registration.provider,
        state=ConnectorHealthState.CONNECTED,
        checked_at=NOW,
        last_success_at=NOW,
        last_event_observed_at=NOW,
        fresh_until=NOW,
        cursor="cursor-a",
        consecutive_failures=0,
        lag_seconds=0,
        adapter_version=registration.adapter_version,
        health_revision=1,
        truth_label=registration.truth_label,
    )
    await repository.append_connector_health(health)
    command = RealtimeUpdateCommand(
        tenant_id=prior.tenant_id,
        actor_subject_id="owner-a",
        case_id=prior.case_id,
        incident_id=prior.incident_id,
        run_id=prior.run_id,
        topology_revision=prior.topology_revision,
        connector_id=registration.connector_id,
        source_event_id=source.source_event_id,
        dispatch_id=dispatch.dispatch_id,
        idempotency_key="reconcile-a",
    )
    packet = RealtimeCommitActivityPacket(
        command=command,
        projection=prior,
        first_event_sequence=2,
        poll_result=ConnectorPollResult(
            registration=registration,
            health=health,
            receipt=(
                await repository.admit_source_event(source, dispatch)
            ).receipt,
            source_event=source,
            dispatch=dispatch,
        ),
    )
    dispatcher = RealtimeActivityDispatcher(repository, {})
    outcome = RealtimeUpdateOutcome.parse_obj(
        await dispatcher.dispatch(
            "workspace_commit_realtime_source_event_activity",
            packet.dict(),
        ),
    )
    return prior, outcome, packet


class RealtimeActivityTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_requires_the_durable_workspace_subject_before_adapter_call(self):
        facts = InMemoryRealtimeRepository()
        prior, _, packet = await accepted_transition(facts)
        workspace = InMemoryWorkspaceRepository()
        await workspace.put_binding(binding())
        await workspace.grant_workspace_subject(
            binding(), "owner-a", roles=["owner"], permissions=["incident:read"],
        )

        class Adapter:
            def __init__(self):
                self.calls = 0

            async def poll(self, projection, *, acl_subjects):
                self.calls += 1
                self.acl_subjects = acl_subjects
                return packet.poll_result

        adapter = Adapter()
        dispatcher = RealtimeActivityDispatcher(
            workspace, {packet.command.connector_id: adapter},
        )
        accepted = await dispatcher.dispatch(
            "workspace_poll_realtime_connector_activity",
            RealtimePollActivityPacket(
                command=packet.command, projection=prior,
            ).dict(),
        )
        self.assertEqual(packet.poll_result, ConnectorPollResult.parse_obj(accepted))
        self.assertEqual(["owner-a"], adapter.acl_subjects)
        with self.assertRaisesRegex(Exception, "realtime_poll_subject_not_authorized"):
            await dispatcher.dispatch(
                "workspace_poll_realtime_connector_activity",
                RealtimePollActivityPacket(
                    command=packet.command.copy(update={"actor_subject_id": "intruder"}),
                    projection=prior,
                ).dict(),
            )
        self.assertEqual(1, adapter.calls)

    async def test_one_fact_produces_one_evidence_signal_pulse_activity_and_transition(self):
        repository = InMemoryRealtimeRepository()
        prior, outcome, packet = await accepted_transition(repository)
        self.assertTrue(outcome.accepted)
        projection = outcome.projection
        self.assertEqual(prior.projection_revision + 1, projection.projection_revision)
        self.assertEqual(8, projection.sequence)
        self.assertEqual(1, projection.source_revision)
        self.assertEqual(1, len(projection.realtime_signals))
        self.assertEqual(1, len(projection.active_graph_pulses))
        self.assertEqual(2, len(projection.agent_workspace.activities))
        self.assertEqual("MONITOR", projection.agent_workspace.activities[0].role.value)
        self.assertFalse(projection.agent_workspace.activities[0].external_write_performed)
        self.assertEqual(
            projection.realtime_signals[0].evidence_refs,
            projection.agent_workspace.activities[0].evidence_refs,
        )
        duplicate = RealtimeUpdateOutcome.parse_obj(
            await RealtimeActivityDispatcher(repository, {}).dispatch(
                "workspace_commit_realtime_source_event_activity",
                packet.dict(),
            ),
        )
        self.assertEqual(outcome, duplicate)
        self.assertEqual(7, len(await repository.realtime_events_after("tenant-a", "case-a", 0)))

    async def test_cross_run_commit_fails_without_projection_or_event(self):
        repository = InMemoryRealtimeRepository()
        _, _, packet = await accepted_transition(repository)
        fresh = InMemoryRealtimeRepository()
        with self.assertRaisesRegex(Exception, "realtime_commit_projection_binding_mismatch"):
            await RealtimeActivityDispatcher(fresh, {}).dispatch(
                "workspace_commit_realtime_source_event_activity",
                packet.copy(update={
                    "command": packet.command.copy(update={"run_id": "run-b"}),
                }).dict(),
            )
        self.assertIsNone(await fresh.realtime_projection("tenant-a", "case-a"))

    async def test_fact_commit_cannot_patch_lifecycle_or_forge_evidence_lineage(self):
        repository = InMemoryRealtimeRepository()
        _, _, packet = await accepted_transition(repository)
        commit = next(iter(repository.commits.values()))
        fresh = InMemoryRealtimeRepository()
        await fresh.register_connector(packet.poll_result.registration)
        source = packet.poll_result.source_event
        await fresh.append_binding(ExternalIdentityBinding(
            binding_id=source.binding_id,
            binding_revision=source.binding_revision,
            tenant_id=source.tenant_id,
            connector_id=source.connector_id,
            provider=source.provider,
            external_resource_type="metric",
            external_resource_id="flowpulse_checkout_error_rate",
            case_id=source.case_id,
            incident_id=source.incident_id,
            run_id=source.run_id,
            topology_revision=source.topology_revision,
            component_ids=source.component_ids,
            edge_ids=source.edge_ids,
            valid_from=NOW,
            status="ACTIVE",
            provenance_source="SERVER_CONNECTOR_CONFIG",
        ))
        await fresh.admit_source_event(source, packet.poll_result.dispatch)
        forged_projection = commit.v1_projection.copy(update={
            "lifecycle_state": "RESOLVED",
        })
        forged = commit.copy(update={
            "v1_projection": forged_projection,
            "projection": commit.projection.copy(update={
                "lifecycle_state": "RESOLVED",
            }),
        })
        with self.assertRaisesRegex(ValueError, "lifecycle_successor_invalid"):
            await fresh.commit_realtime_transition(forged)
        with self.assertRaisesRegex(ValueError, "evidence_lineage_mismatch"):
            await fresh.commit_realtime_transition(commit.copy(update={
                "evidence": commit.evidence.copy(update={"content_hash": "f" * 64}),
            }))
        self.assertIsNone(await fresh.realtime_projection("tenant-a", "case-a"))


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_TEST_TEMPORAL") == "1",
    "requires an installed Temporal test server",
)
class RealtimeTemporalWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_duplicate_update_produces_one_temporal_projection_and_event(self):
        prepared = InMemoryRealtimeRepository()
        _, _, packet = await accepted_transition(prepared)
        poll = packet.poll_result
        facts = InMemoryRealtimeRepository()
        await facts.register_connector(poll.registration)
        source = poll.source_event
        await facts.append_binding(ExternalIdentityBinding(
            binding_id=source.binding_id,
            binding_revision=source.binding_revision,
            tenant_id=source.tenant_id,
            connector_id=source.connector_id,
            provider=source.provider,
            external_resource_type="metric",
            external_resource_id="flowpulse_checkout_error_rate",
            case_id=source.case_id,
            incident_id=source.incident_id,
            run_id=source.run_id,
            topology_revision=source.topology_revision,
            component_ids=source.component_ids,
            edge_ids=source.edge_ids,
            valid_from=NOW,
            status="ACTIVE",
            provenance_source="SERVER_CONNECTOR_CONFIG",
        ))
        await facts.admit_source_event(source, poll.dispatch)
        await facts.append_connector_health(poll.health)
        workspace = InMemoryWorkspaceRepository()

        class CombinedRepository:
            def __getattr__(self, name):
                if hasattr(facts, name):
                    return getattr(facts, name)
                return getattr(workspace, name)

        class Adapter:
            async def poll(self, projection, *, acl_subjects):
                self.acl_subjects = acl_subjects
                return poll

        combined = CombinedRepository()
        realtime_dispatcher = RealtimeActivityDispatcher(
            combined, {poll.registration.connector_id: Adapter()},
        )
        workspace_dispatcher = WorkspaceActivityDispatcher(
            workspace,
            topology_provider=CapturedAstronomyTopologyProvider(ProviderMode.TEST),
        )
        workflow_request = WorkspaceWorkflowRequest(
            **binding().dict(),
            actor=AuthContext(
                tenant_id="tenant-a", subject_id="owner-a", roles=["owner"],
            ),
            title="Checkout errors rising",
            severity="SEV2",
            environment="test",
            affected_entities=["checkout"],
            summary="Realtime connector Temporal proof.",
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "phase1a-realtime-update"
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=(
                    build_workspace_activities(workspace_dispatcher)
                    + build_realtime_activities(realtime_dispatcher)
                ),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request.dict(),
                    id=workflow_request.workflow_id,
                    task_queue=queue,
                )
                await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.await_workspace_projection,
                )
                command = packet.command
                first = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.reconcile_realtime_connector,
                    command.dict(),
                )
                duplicate = await handle.execute_update(
                    IncidentWorkspaceTemporalWorkflow.reconcile_realtime_connector,
                    command.dict(),
                )
                self.assertEqual(first, duplicate)
                self.assertEqual(
                    7, len(await facts.realtime_events_after("tenant-a", "case-a", 0)),
                )
                self.assertEqual(
                    1,
                    len([
                        commit.v1_event
                        for commit in facts.commits.values()
                        if commit.v1_event.event_type
                        == "workspace.realtime.source_event.accepted"
                    ]),
                )


class FakeRealtimeStarter:
    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = 0

    async def reconcile_realtime_connector(
        self, projection, connector_id, idempotency_key, actor_subject_id,
        source_event_id, dispatch_id,
    ):
        self.calls += 1
        self.actor_subject_id = actor_subject_id
        return self.outcome


class RealtimeApiTests(unittest.TestCase):
    def setUp(self):
        self.realtime = InMemoryRealtimeRepository()
        self.workspace = InMemoryWorkspaceRepository()
        prior, outcome, _ = asyncio.run(accepted_transition(self.realtime))
        for revisions in self.realtime.dispatch_revisions.values():
            if revisions[-1].state == ConnectorDispatchState.ACCEPTED:
                revisions.pop()
        asyncio.run(self.workspace.put_binding(binding()))
        asyncio.run(self.workspace.put_projection(prior))
        self.outcome = outcome
        self.starter = FakeRealtimeStarter(outcome)
        self.app = create_app(
            workspace_repository=self.workspace,
            realtime_repository=self.realtime,
            workspace_starter=self.starter,
        )
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a",
            subject_id="owner-a",
            roles=["owner"],
        )
        self.app.state.workspace_sse_poll_seconds = 0.005
        self.app.state.workspace_sse_heartbeat_seconds = 0.02
        self.client = TestClient(self.app)

    def test_v2_projection_discovery_health_and_evidence_are_tenant_scoped(self):
        response = self.client.get("/v2/incidents?state=active&limit=20")
        self.assertEqual(200, response.status_code)
        self.assertEqual(["case-a"], [item["case_id"] for item in response.json()])
        projection = self.client.get("/v2/incidents/case-a/projection")
        self.assertEqual(200, projection.status_code)
        payload = projection.json()
        self.assertEqual("flowpulse.incident-projection.v2", payload["schema_version"])
        self.assertEqual("TEST_DETERMINISTIC", payload["agent_workspace"]["activities"][0]["truth_label"])
        evidence_id = payload["realtime_signals"][0]["evidence_refs"][0]
        evidence = self.client.get("/v2/incidents/case-a/evidence/" + evidence_id)
        self.assertEqual(200, evidence.status_code)
        self.assertNotIn("raw_payload", evidence.text)
        health = self.client.get("/v2/connectors")
        self.assertEqual(200, health.status_code)
        self.assertEqual("STALE", health.json()[0]["state"])
        self.assertEqual("freshness_sla_exceeded", health.json()[0]["reason_code"])
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-b",
            subject_id="incident-team",
            roles=["owner"],
        )
        self.assertEqual(404, self.client.get("/v2/incidents/case-a/projection").status_code)

    def test_v2_public_reads_materialize_v1_baseline_without_event(self):
        realtime = InMemoryRealtimeRepository()
        asyncio.run(realtime.register_connector(ConnectorRegistration(
            connector_id="connector-otel-primary",
            tenant_id="tenant-a",
            provider="OTEL",
            adapter_version="otel-read.v1",
            data_classes=["TRACE"],
            capabilities=["TRACES"],
            freshness_sla_seconds=60,
            enabled=True,
            truth_label="TEST_DETERMINISTIC",
        )))
        app = create_app(
            workspace_repository=self.workspace,
            realtime_repository=realtime,
            workspace_starter=self.starter,
        )
        app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="owner-a", roles=["owner"],
        )
        client = TestClient(app)
        discovered = client.get("/v2/incidents?state=active&limit=20")
        self.assertEqual(200, discovered.status_code)
        self.assertEqual(["case-a"], [item["case_id"] for item in discovered.json()])
        hydrated = client.get("/v2/incidents/case-a/projection")
        self.assertEqual(200, hydrated.status_code)
        payload = hydrated.json()
        self.assertEqual([], payload["realtime_signals"])
        self.assertEqual([], payload["active_graph_pulses"])
        self.assertEqual([], payload["agent_workspace"]["activities"])
        self.assertEqual("UNAVAILABLE", payload["connector_health"][0]["state"])
        self.assertEqual(
            [], asyncio.run(realtime.realtime_events_after("tenant-a", "case-a", 0)),
        )

    def test_reconcile_body_cannot_supply_tenant_url_query_or_provider(self):
        invalid = self.client.post(
            "/v2/connectors/connector-prometheus-primary/reconcile?case_id=case-a",
            json={
                "idempotency_key": "reconcile-a",
                "tenant_id": "tenant-b",
                "url": "http://127.0.0.1",
                "query": "up",
                "provider": "PROMETHEUS",
            },
        )
        self.assertEqual(422, invalid.status_code)
        accepted = self.client.post(
            "/v2/connectors/connector-prometheus-primary/reconcile?case_id=case-a",
            json={"idempotency_key": "reconcile-a"},
        )
        self.assertEqual(202, accepted.status_code)
        self.assertEqual("owner-a", self.starter.actor_subject_id)
        self.app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="viewer-a", roles=["viewer"],
        )
        denied = self.client.post(
            "/v2/connectors/connector-prometheus-primary/reconcile?case_id=case-a",
            json={"idempotency_key": "reconcile-denied"},
        )
        self.assertEqual(403, denied.status_code)
        self.assertEqual(1, self.starter.calls)

    def _stream_request(self):
        disconnected = {"value": False}

        async def receive():
            if disconnected["value"]:
                return {"type": "http.disconnect"}
            return {"type": "http.request", "body": b"", "more_body": False}

        return Request({"type": "http", "app": self.app, "headers": []}, receive), disconnected

    async def _chunk(self, route_name, **kwargs):
        endpoint = next(
            route.endpoint for route in self.app.routes
            if getattr(route, "name", "") == route_name
        )
        request, _ = self._stream_request()
        response = await endpoint(
            request=request,
            actor=AuthContext(
                tenant_id="tenant-a", subject_id="owner-a", roles=["viewer"],
            ),
            **kwargs,
        )
        iterator = response.body_iterator
        chunk = await asyncio.wait_for(iterator.__anext__(), timeout=0.2)
        await iterator.aclose()
        return chunk

    def test_v2_sse_is_ordered_and_resumable(self):
        case_chunk = asyncio.run(self._chunk(
            "realtime_case_events",
            case_id="case-a", after=0, last_event_id=None,
        ))
        self.assertIn("id: 2", case_chunk)
        self.assertIn("connector.health.changed", case_chunk)
        global_chunk = asyncio.run(self._chunk(
            "realtime_incident_notifications",
            after=None, last_event_id=None,
        ))
        self.assertIn("incident-realtime-notification", global_chunk)
        notification_id = asyncio.run(
            self.realtime.realtime_notifications_after("tenant-a"),
        )[-1].notification_id
        resumed_global = asyncio.run(self._chunk(
            "realtime_incident_notifications",
            after=notification_id, last_event_id=None,
        ))
        resumed_case = asyncio.run(self._chunk(
            "realtime_case_events",
            case_id="case-a", after=8, last_event_id=None,
        ))
        self.assertEqual(": heartbeat\n\n", resumed_global)
        self.assertEqual(": heartbeat\n\n", resumed_case)
        openapi = self.client.get("/openapi.json").json()
        self.assertIn("/v2/incidents", openapi["paths"])
        self.assertIn("RealtimeNotification", openapi["components"]["schemas"])
        self.assertIn("RealtimeIncidentEvent", openapi["components"]["schemas"])


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_REALTIME_POSTGRES") == "1",
    "requires local Compose Postgres",
)
class LiveRealtimePostgresTests(unittest.TestCase):
    app_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
    admin_dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_ADMIN_DSN",
        "postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres",
    )

    def test_fact_outbox_projection_and_rls_are_one_append_only_tenant_transition(self):
        async def run():
            database = "flowpulse_realtime_{}".format(uuid4().hex)
            target_app_dsn = self.app_dsn.rsplit("/", 1)[0] + "/" + database
            target_admin_dsn = self.admin_dsn.rsplit("/", 1)[0] + "/" + database
            admin = await asyncpg.connect(self.admin_dsn)
            await admin.execute("CREATE DATABASE " + database)
            try:
                bootstrap = await asyncpg.connect(target_admin_dsn)
                try:
                    migrations = Path(__file__).resolve().parents[1] / "migrations"
                    for path in sorted(migrations.glob("[0-9][0-9][0-9]_*.sql")):
                        await bootstrap.execute(path.read_text(encoding="utf-8"))
                finally:
                    await bootstrap.close()
                repository = PostgresCaseRepository(target_app_dsn)
                await repository.connect()
                try:
                    run_binding = binding()
                    case = IncidentCase(
                        case_id=run_binding.case_id,
                        tenant_id=run_binding.tenant_id,
                        workflow_id=run_binding.workflow_id,
                        workflow_run_id=run_binding.workflow_run_id,
                        public_incident_id=run_binding.incident_id,
                        public_run_id=run_binding.run_id,
                        public_topology_revision=run_binding.topology_revision,
                        severity="SEV2",
                        environment="test",
                        affected_entities=["checkout"],
                        created_at=NOW,
                        updated_at=NOW,
                    )
                    await repository.put_case(case)
                    await repository.put_workspace_binding(run_binding)
                    await repository.grant_workspace_subject(
                        run_binding,
                        "owner-a",
                        roles=["owner"],
                        permissions=["incident:read"],
                    )
                    await repository.put_workspace_projection(workspace_projection())

                    _, outcome, packet = await accepted_transition(repository)
                    self.assertTrue(outcome.accepted)
                    duplicate = await RealtimeActivityDispatcher(repository, {}).dispatch(
                        "workspace_commit_realtime_source_event_activity",
                        packet.dict(),
                    )
                    self.assertEqual(outcome, RealtimeUpdateOutcome.parse_obj(duplicate))

                    source = packet.poll_result.source_event
                    second = source.copy(update={
                        "provider_event_id": "poll:cursor-b",
                        "normalization_hash": "0" * 64,
                    })
                    second = second.copy(update={"normalization_hash": second.canonical_hash()})
                    second = second.copy(update={
                        "source_event_id": "source-" + second.normalization_hash[:24],
                        "delivery_id": "delivery-" + second.normalization_hash[:24],
                    })
                    invalid_dispatch = packet.poll_result.dispatch.copy(update={
                        "dispatch_id": "dispatch-" + second.normalization_hash[:24],
                        "source_event_id": second.source_event_id,
                        "normalization_hash": second.normalization_hash,
                        "run_id": "run-other",
                    })
                    with self.assertRaisesRegex(ValueError, "dispatch_source_binding_mismatch"):
                        await repository.admit_source_event(second, invalid_dispatch)

                    async def counts(connection):
                        return await connection.fetchrow(
                            """SELECT
                               (SELECT count(*) FROM connector_delivery_receipts) AS deliveries,
                               (SELECT count(*) FROM connector_source_events) AS sources,
                               (SELECT count(*) FROM connector_dispatch_outbox) AS outbox,
                               (SELECT count(*) FROM connector_dispatch_revisions) AS dispatch_revisions,
                               (SELECT count(*) FROM connector_poll_cursors) AS cursors,
                               (SELECT count(*) FROM connector_reconciliation_runs) AS reconciliations,
                               (SELECT count(*) FROM incident_realtime_transitions) AS transitions,
                               (SELECT count(*) FROM incident_realtime_events) AS events,
                               (SELECT count(*) FROM realtime_signal_records) AS signals,
                               (SELECT count(*) FROM realtime_graph_pulses) AS pulses,
                               (SELECT count(*) FROM realtime_agent_activities) AS activities"""
                        )

                    row = await repository._tenant("tenant-a", counts, subject_id="owner-a")
                    self.assertEqual(
                        (1, 1, 1, 2, 1, 1, 1, 7, 1, 1, 2),
                        tuple(row.values()),
                    )
                    projection_v2 = outcome.projection
                    health_event = packet.poll_result.health

                    async def seed_notifications(connection):
                        for offset in range(275):
                            sequence = 100 + offset
                            event = RealtimeIncidentEvent(
                                **{
                                    field: getattr(projection_v2, field)
                                    for field in (
                                        "tenant_id", "incident_id", "run_id",
                                        "topology_revision", "case_id",
                                        "case_revision", "workflow_id",
                                        "workflow_run_id", "created_at",
                                    )
                                },
                                source_event_id=source.source_event_id,
                                projection_revision=projection_v2.projection_revision,
                                sequence=sequence,
                                event_type=RealtimeEventType.CONNECTOR_HEALTH_CHANGED,
                                occurred_at=NOW + timedelta(
                                    milliseconds=sequence,
                                ),
                                health=health_event,
                            )
                            await connection.execute(
                                """INSERT INTO incident_realtime_events
                                   (event_id, tenant_id, incident_id, run_id,
                                    topology_revision, case_id, case_revision,
                                    workflow_id, workflow_run_id,
                                    source_event_id, projection_revision,
                                    sequence, event_type, payload, occurred_at)
                                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                                           $12,$13,$14::jsonb,$15)""",
                                uuid4(), event.tenant_id, event.incident_id,
                                event.run_id, event.topology_revision,
                                event.case_id, event.case_revision,
                                event.workflow_id, event.workflow_run_id,
                                event.source_event_id,
                                event.projection_revision, event.sequence,
                                event.event_type.value, event.json(),
                                event.occurred_at,
                            )

                    await repository._tenant(
                        "tenant-a", seed_notifications, subject_id="owner-a",
                    )
                    page1 = await repository.realtime_notifications_after(
                        "tenant-a",
                    )
                    page2 = await repository.realtime_notifications_after(
                        "tenant-a", page1[-1].notification_id,
                    )
                    page3 = await repository.realtime_notifications_after(
                        "tenant-a", page2[-1].notification_id,
                    )
                    self.assertEqual([100, 100, 82], [
                        len(page1), len(page2), len(page3),
                    ])
                    self.assertEqual(282, len({
                        item.notification_id
                        for page in (page1, page2, page3)
                        for item in page
                    }))
                    valid_dispatch = invalid_dispatch.copy(update={
                        "run_id": second.run_id,
                    })
                    admitted = await repository.admit_source_event(
                        second, valid_dispatch,
                    )

                    class TemporalDispatch:
                        def __init__(self):
                            self.calls = 0
                            self.fail = True

                        async def __call__(self, accepted_source, accepted_dispatch):
                            self.calls += 1
                            if self.fail:
                                raise RuntimeError("temporal_unavailable")
                            current = await repository.workspace_projection(
                                accepted_source.tenant_id,
                                accepted_source.case_id,
                            )
                            current_v2 = await repository.realtime_projection(
                                accepted_source.tenant_id,
                                accepted_source.case_id,
                            )
                            family = await repository.load_connector_fact_family(
                                accepted_source.tenant_id,
                                accepted_source.source_event_id,
                                accepted_dispatch.dispatch_id,
                            )
                            return await RealtimeActivityDispatcher(
                                repository, {},
                            ).dispatch(
                                "workspace_commit_realtime_source_event_activity",
                                RealtimeCommitActivityPacket(
                                    command=RealtimeUpdateCommand(
                                        tenant_id=accepted_source.tenant_id,
                                        actor_subject_id="owner-a",
                                        case_id=accepted_source.case_id,
                                        incident_id=accepted_source.incident_id,
                                        run_id=accepted_source.run_id,
                                        topology_revision=accepted_source.topology_revision,
                                        connector_id=accepted_source.connector_id,
                                        source_event_id=accepted_source.source_event_id,
                                        dispatch_id=accepted_dispatch.dispatch_id,
                                        idempotency_key=accepted_dispatch.dispatch_id,
                                    ),
                                    projection=current,
                                    prior_realtime_projection=current_v2,
                                    first_event_sequence=current.sequence + 1,
                                    poll_result=family,
                                ).dict(),
                            )

                    temporal_dispatch = TemporalDispatch()
                    scheduler = RealtimeIngestScheduler(
                        repository=repository,
                        connectors={},
                        temporal_dispatch=temporal_dispatch,
                        tenant_id="tenant-a",
                        binding_templates=[],
                    )
                    await scheduler.dispatch_pending_once()
                    self.assertEqual(
                        ConnectorDispatchState.PENDING,
                        (
                            await repository.authoritative_dispatch(
                                "tenant-a", admitted.dispatch.dispatch_id,
                            )
                        ).state,
                    )
                    temporal_dispatch.fail = False
                    await scheduler.dispatch_pending_once()
                    await scheduler.dispatch_pending_once()
                    self.assertEqual(2, temporal_dispatch.calls)
                    self.assertEqual(
                        ConnectorDispatchState.ACCEPTED,
                        (
                            await repository.authoritative_dispatch(
                                "tenant-a", admitted.dispatch.dispatch_id,
                            )
                        ).state,
                    )
                    acknowledged_retry = await repository.admit_source_event(
                        second, valid_dispatch,
                    )
                    self.assertEqual(
                        ConnectorDispatchState.ACCEPTED,
                        acknowledged_retry.dispatch.state,
                    )
                    self.assertEqual(second, acknowledged_retry.source_event)
                    self.assertEqual(admitted.receipt, acknowledged_retry.receipt)
                    self.assertIsNone(
                        await repository.realtime_projection("tenant-b", run_binding.case_id),
                    )

                    async def forbidden_update(connection):
                        await connection.execute(
                            "UPDATE connector_source_events SET payload=payload "
                            "WHERE tenant_id='tenant-a'",
                        )

                    with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                        await repository._tenant(
                            "tenant-a", forbidden_update, subject_id="owner-a",
                        )
                finally:
                    await repository.close()
            finally:
                await admin.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
                    database,
                )
                await admin.execute("DROP DATABASE IF EXISTS " + database)
                await admin.close()

        asyncio.run(run())

"""Acceptance regressions for the Phase 1A fact-plane correction."""

import json
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from unittest.mock import AsyncMock, patch

from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.realtime_activities import RealtimeActivityDispatcher
from flowpulse_cp.realtime_adapters import (
    ConnectorReadError,
    ConfiguredPrometheusConnector,
    PrometheusNormalizer,
)
from flowpulse_cp.realtime_models import (
    AgentActivityState,
    ConfiguredBindingTemplate,
    ConnectorDispatch,
    ConnectorDispatchState,
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
    ExternalIdentityBinding,
    RealtimeCommitActivityPacket,
    RealtimeDeliveryMode,
    RealtimeEventType,
    RealtimeIncidentEvent,
    RealtimeTrend,
    RealtimeUpdateCommand,
)
from flowpulse_cp.realtime_repository import (
    InMemoryRealtimeRepository,
    _is_pre_truth_v2_projection,
)
from flowpulse_cp.realtime_scheduler import RealtimeIngestScheduler
from flowpulse_cp.workspace_models import IncidentRunBinding, initial_projection
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider


NOW = datetime(2026, 7, 29, 20, 0, tzinfo=timezone.utc)


def registration() -> ConnectorRegistration:
    return ConnectorRegistration(
        connector_id="connector-prometheus-local",
        tenant_id="tenant-a",
        provider=ConnectorProvider.PROMETHEUS,
        adapter_version="prometheus-read.v2",
        data_classes=["METRIC"],
        capabilities=["METRICS"],
        freshness_sla_seconds=60,
        enabled=True,
        truth_label=ConnectorTruthLabel.TEST_DETERMINISTIC,
    )


def projection():
    binding = IncidentRunBinding(
        tenant_id="tenant-a",
        incident_id="incident-a",
        run_id="run-a",
        topology_revision="topology-a",
        case_id="case-a",
        case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-a",
        workflow_run_id="temporal-run-a",
        created_at=NOW - timedelta(minutes=2),
    )
    return CapturedAstronomyTopologyProvider(ProviderMode.TEST).snapshot(
        initial_projection(
            binding,
            ["checkout"],
            NOW - timedelta(minutes=2),
            "Checkout error rate",
            "Checkout requests are failing.",
        ),
    )


def external_binding(*, suffix="a", edges=None, valid_from=None):
    return ExternalIdentityBinding(
        binding_id="binding-" + suffix,
        binding_revision=1,
        tenant_id="tenant-a",
        connector_id=registration().connector_id,
        provider=ConnectorProvider.PROMETHEUS,
        external_resource_type="metric",
        external_resource_id="flowpulse_checkout_error_rate",
        case_id="case-a",
        incident_id="incident-a",
        run_id="run-a",
        topology_revision="topology-a",
        component_ids=["checkout"],
        edge_ids=list(edges or []),
        valid_from=valid_from or NOW - timedelta(minutes=5),
        status="ACTIVE",
        provenance_source="SERVER_CONNECTOR_CONFIG",
    )


def payload(observed_at=NOW, value="0.084"):
    return {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [{
                "metric": {
                    "__name__": "flowpulse_checkout_error_rate",
                    "service": "checkout",
                },
                "value": [observed_at.timestamp(), value],
            }],
        },
    }


class Reader:
    max_response_bytes = 1024 * 1024

    def __init__(self, value):
        self.value = value
        self.calls = 0

    def read(self, url):
        self.calls += 1
        return json.dumps(self.value, sort_keys=True).encode()


class ArtifactStore:
    def put(self, tenant_id, raw):
        return "{}/sha256/{}".format(tenant_id, sha256(raw).hexdigest())


class BindingAndFreshnessTruthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = InMemoryRealtimeRepository()
        await self.repository.register_connector(registration())

    def connector(self, reader):
        return ConfiguredPrometheusConnector(
            registration=registration(),
            base_url="https://metrics.example.test",
            expression="flowpulse_checkout_error_rate",
            reader=reader,
            artifact_store=ArtifactStore(),
            repository=self.repository,
        )

    async def test_runtime_poll_does_not_freeze_receive_time_before_provider_read(self):
        await self.repository.append_binding(external_binding(edges=[]))
        expected = object()
        with patch(
            "flowpulse_cp.realtime_adapters.PrometheusReadAdapter.poll",
            new=AsyncMock(return_value=expected),
        ) as adapter_poll:
            actual = await self.connector(Reader(payload())).poll(
                projection(),
                acl_subjects=["owner-a"],
            )
        self.assertIs(expected, actual)
        self.assertIsNone(adapter_poll.await_args.kwargs["now"])

    async def test_missing_or_ambiguous_binding_is_unassigned_without_provider_or_fact(self):
        reader = Reader(payload())
        missing = await self.connector(reader).poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )
        self.assertFalse(missing.accepted)
        self.assertEqual("external_identity_binding_unassigned", missing.reason_code)
        self.assertEqual(ConnectorHealthState.UNAVAILABLE, missing.health.state)
        self.assertEqual(0, reader.calls)
        self.assertEqual({}, self.repository.source_events)
        self.assertEqual({}, self.repository.dispatches)

        await self.repository.append_binding(external_binding(suffix="a"))
        await self.repository.append_binding(external_binding(suffix="b"))
        ambiguous = await self.connector(reader).poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )
        self.assertFalse(ambiguous.accepted)
        self.assertEqual("external_identity_binding_ambiguous", ambiguous.reason_code)
        self.assertEqual(0, reader.calls)
        self.assertEqual({}, self.repository.source_events)

    async def test_component_only_current_sample_has_unknown_trend_and_no_path_pulse(self):
        await self.repository.append_binding(external_binding(edges=[]))
        polled = await self.connector(Reader(payload())).poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )
        self.assertTrue(polled.accepted)
        self.assertEqual(RealtimeTrend.UNKNOWN, polled.source_event.trend)
        command = RealtimeUpdateCommand(
            tenant_id="tenant-a",
            actor_subject_id="owner-a",
            case_id="case-a",
            incident_id="incident-a",
            run_id="run-a",
            topology_revision="topology-a",
            connector_id=registration().connector_id,
            source_event_id=polled.source_event.source_event_id,
            dispatch_id=polled.dispatch.dispatch_id,
            idempotency_key="dispatch-a",
        )
        outcome = await RealtimeActivityDispatcher(
            self.repository, {},
        ).dispatch(
            "workspace_commit_realtime_source_event_activity",
            RealtimeCommitActivityPacket(
                command=command,
                projection=projection(),
                first_event_sequence=2,
                poll_result=polled,
            ).dict(),
        )
        self.assertTrue(outcome["accepted"])
        accepted = outcome["projection"]
        self.assertEqual([], accepted["active_graph_pulses"])
        self.assertEqual("UNKNOWN", accepted["realtime_signals"][0]["trend"])
        types = [
            item.event_type
            for item in await self.repository.realtime_events_after(
                "tenant-a", "case-a", 0,
            )
        ]
        self.assertNotIn(RealtimeEventType.GRAPH_PULSE_STARTED, types)

    async def test_trend_requires_an_earlier_admitted_ordered_sample(self):
        await self.repository.append_binding(
            external_binding(valid_from=NOW - timedelta(minutes=10)),
        )
        first_at = NOW - timedelta(seconds=20)
        first = await self.connector(Reader(payload(first_at, "0.050"))).poll(
            projection(), acl_subjects=["owner-a"], now=first_at,
        )
        self.assertEqual(RealtimeTrend.UNKNOWN, first.source_event.trend)
        second = await self.connector(Reader(payload(NOW, "0.084"))).poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )
        self.assertEqual(RealtimeTrend.RISING, second.source_event.trend)

    async def test_current_backfill_never_emits_a_live_path_pulse(self):
        await self.repository.append_binding(
            external_binding(edges=["frontend->checkout"]),
        )
        polled = await self.connector(Reader(payload())).poll(
            projection(),
            acl_subjects=["owner-a"],
            now=NOW,
            delivery_mode=RealtimeDeliveryMode.BACKFILL,
        )
        outcome = await RealtimeActivityDispatcher(
            self.repository, {},
        ).dispatch(
            "workspace_commit_realtime_source_event_activity",
            RealtimeCommitActivityPacket(
                command=RealtimeUpdateCommand(
                    tenant_id="tenant-a",
                    actor_subject_id="owner-a",
                    case_id="case-a",
                    incident_id="incident-a",
                    run_id="run-a",
                    topology_revision="topology-a",
                    connector_id=registration().connector_id,
                    source_event_id=polled.source_event.source_event_id,
                    dispatch_id=polled.dispatch.dispatch_id,
                    idempotency_key="dispatch-backfill",
                ),
                projection=projection(),
                first_event_sequence=2,
                poll_result=polled,
            ).dict(),
        )
        self.assertEqual([], outcome["projection"]["active_graph_pulses"])
        self.assertNotIn(
            RealtimeEventType.GRAPH_PULSE_STARTED,
            [
                item.event_type
                for item in await self.repository.realtime_events_after(
                    "tenant-a", "case-a", 0,
                )
            ],
        )

    async def test_stale_sample_is_reference_only_and_never_emits_live_pulse(self):
        await self.repository.append_binding(
            external_binding(edges=["frontend->checkout"]),
        )
        polled = await self.connector(
            Reader(payload(NOW - timedelta(minutes=3))),
        ).poll(
            projection(),
            acl_subjects=["owner-a"],
            now=NOW,
            delivery_mode=RealtimeDeliveryMode.BACKFILL,
        )
        self.assertTrue(polled.accepted)
        self.assertEqual("STALE", polled.source_event.freshness.value)
        self.assertEqual("REFERENCE_ONLY", polled.source_event.proof_scope.value)
        self.assertNotEqual(
            "T0_AUTHORITATIVE_CURRENT", polled.source_event.authority.value,
        )
        self.assertEqual(ConnectorHealthState.STALE, polled.health.state)

    async def test_malformed_sample_is_degraded_without_admitted_fact(self):
        await self.repository.append_binding(external_binding())
        malformed = payload()
        malformed["data"]["result"][0]["value"][1] = "not-a-number"
        with self.assertRaisesRegex(
            ConnectorReadError, "prometheus_normalization_failed",
        ):
            await self.connector(Reader(malformed)).poll(
                projection(), acl_subjects=["owner-a"], now=NOW,
            )
        health = await self.repository.connector_health("tenant-a")
        self.assertEqual(ConnectorHealthState.DEGRADED, health[0].state)
        self.assertEqual({}, self.repository.source_events)
        self.assertEqual({}, self.repository.dispatches)


class BaselineAndRetryTests(unittest.IsolatedAsyncioTestCase):
    def test_legacy_projection_predicate_is_exact_and_does_not_mask_current_invalid_data(self):
        legacy = {
            "schema_version": "flowpulse.incident-projection.v2",
            "agent_workspace": {
                "activities": [{
                    "activity_id": "legacy-activity",
                    "state": "COMPLETED",
                }],
            },
        }
        self.assertTrue(_is_pre_truth_v2_projection(legacy))
        self.assertFalse(_is_pre_truth_v2_projection({
            **legacy,
            "agent_workspace": {
                "activities": [{
                    "activity_id": "current-but-invalid",
                    "activity_key": "activity-key",
                }],
            },
        }))
        self.assertFalse(_is_pre_truth_v2_projection({
            "schema_version": "flowpulse.incident-projection.v2",
            "agent_workspace": {"activities": []},
        }))

    async def test_v1_case_materializes_empty_v2_without_lifecycle_transition(self):
        repository = InMemoryRealtimeRepository()
        await repository.register_connector(registration())
        baseline = await repository.materialize_realtime_baseline(
            projection(), now=NOW,
        )
        self.assertEqual(projection().projection_revision, baseline.projection_revision)
        self.assertEqual(projection().sequence, baseline.sequence)
        self.assertEqual([], baseline.realtime_signals)
        self.assertEqual([], baseline.active_graph_pulses)
        self.assertEqual([], baseline.agent_workspace.activities)
        self.assertEqual(ConnectorHealthState.UNAVAILABLE, baseline.connector_health[0].state)
        self.assertEqual([], await repository.realtime_events_after("tenant-a", "case-a", 0))

    async def test_lost_ack_duplicate_returns_stored_source_dispatch_and_receipt(self):
        repository = InMemoryRealtimeRepository()
        await repository.register_connector(registration())
        await repository.append_binding(external_binding())
        source = PrometheusNormalizer().normalize(
            payload=payload(),
            registration=registration(),
            binding=external_binding(),
            provider_event_id="poll:cursor-a",
            received_at=NOW,
            raw_artifact_ref="tenant-a/sha256/" + "a" * 64,
            raw_content_hash="a" * 64,
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
        first = await repository.admit_source_event(source, dispatch)
        retry = await repository.admit_source_event(
            source.copy(update={"received_at": NOW + timedelta(seconds=5)}),
            dispatch.copy(update={"created_at": NOW + timedelta(seconds=5)}),
        )
        self.assertEqual(first.receipt, retry.receipt)
        self.assertEqual(first.source_event, retry.source_event)
        self.assertEqual(first.dispatch, retry.dispatch)
        self.assertEqual(NOW, retry.source_event.received_at)
        self.assertEqual(NOW, retry.dispatch.created_at)


class EventAndPaginationTests(unittest.IsolatedAsyncioTestCase):
    async def test_notifications_resume_after_two_hundred_and_fifty_events(self):
        repository = InMemoryRealtimeRepository()
        await repository.seed_notification_fixture(
            projection(), count=275, started_at=NOW,
        )
        first = await repository.realtime_notifications_after("tenant-a")
        second = await repository.realtime_notifications_after(
            "tenant-a", first[-1].notification_id,
        )
        third = await repository.realtime_notifications_after(
            "tenant-a", second[-1].notification_id,
        )
        self.assertEqual([100, 100, 75], list(map(len, (first, second, third))))
        ids = [item.notification_id for page in (first, second, third) for item in page]
        self.assertEqual(275, len(set(ids)))

    def test_typed_events_allow_health_only_and_reject_mismatched_payloads(self):
        values = {
            **{
                field: getattr(projection(), field)
                for field in (
                    "tenant_id", "incident_id", "run_id", "topology_revision",
                    "case_id", "case_revision", "workflow_id",
                    "workflow_run_id", "created_at",
                )
            },
            "schema_version": "flowpulse.incident-realtime-event.v2",
            "source_event_id": None,
            "projection_revision": 1,
            "sequence": 1,
            "event_type": RealtimeEventType.CONNECTOR_HEALTH_CHANGED,
            "occurred_at": NOW,
            "health": {
                "connector_id": registration().connector_id,
                "tenant_id": "tenant-a",
                "provider": "PROMETHEUS",
                "state": "UNAVAILABLE",
                "checked_at": NOW,
                "consecutive_failures": 0,
                "lag_seconds": 0,
                "reason_code": "external_identity_binding_unassigned",
                "adapter_version": "prometheus-read.v2",
                "health_revision": 1,
                "truth_label": "TEST_DETERMINISTIC",
            },
        }
        event = RealtimeIncidentEvent.parse_obj(values)
        self.assertIsNone(event.signal)
        with self.assertRaisesRegex(ValueError, "realtime_event_payload_mismatch"):
            RealtimeIncidentEvent.parse_obj({
                **values,
                "event_type": RealtimeEventType.GRAPH_PULSE_STARTED,
            })

    def test_activity_started_must_precede_completed(self):
        with self.assertRaisesRegex(ValueError, "activity_state_sequence_invalid"):
            RealtimeActivityDispatcher.validate_activity_sequence([
                AgentActivityState.COMPLETED,
                AgentActivityState.STARTED,
            ])

    async def test_next_fact_emits_expiry_and_reload_omits_expired_pulse(self):
        repository = InMemoryRealtimeRepository()
        await repository.register_connector(registration())
        await repository.append_binding(
            external_binding(edges=["frontend->checkout"]),
        )
        connector = ConfiguredPrometheusConnector(
            registration(),
            "https://metrics.example.test",
            "flowpulse_checkout_error_rate",
            Reader(payload()),
            ArtifactStore(),
            repository,
        )
        first = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )
        first_outcome = await RealtimeActivityDispatcher(
            repository, {},
        ).dispatch(
            "workspace_commit_realtime_source_event_activity",
            RealtimeCommitActivityPacket(
                command=RealtimeUpdateCommand(
                    tenant_id="tenant-a",
                    actor_subject_id="owner-a",
                    case_id="case-a",
                    incident_id="incident-a",
                    run_id="run-a",
                    topology_revision="topology-a",
                    connector_id=registration().connector_id,
                    source_event_id=first.source_event.source_event_id,
                    dispatch_id=first.dispatch.dispatch_id,
                    idempotency_key="dispatch-first",
                ),
                projection=projection(),
                first_event_sequence=2,
                poll_result=first,
            ).dict(),
        )
        connector.reader = Reader(payload(NOW + timedelta(seconds=20), "0.090"))
        second = await connector.poll(
            projection(),
            acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=20),
        )
        second_outcome = await RealtimeActivityDispatcher(
            repository, {},
        ).dispatch(
            "workspace_commit_realtime_source_event_activity",
            RealtimeCommitActivityPacket(
                command=RealtimeUpdateCommand(
                    tenant_id="tenant-a",
                    actor_subject_id="owner-a",
                    case_id="case-a",
                    incident_id="incident-a",
                    run_id="run-a",
                    topology_revision="topology-a",
                    connector_id=registration().connector_id,
                    source_event_id=second.source_event.source_event_id,
                    dispatch_id=second.dispatch.dispatch_id,
                    idempotency_key="dispatch-second",
                ),
                projection=first_outcome["workspace_projection"],
                prior_realtime_projection=first_outcome["projection"],
                first_event_sequence=first_outcome["projection"]["sequence"] + 1,
                poll_result=second,
            ).dict(),
        )
        second_events = [
            item for item in await repository.realtime_events_after(
                "tenant-a", "case-a", first_outcome["projection"]["sequence"],
            )
        ]
        self.assertEqual(
            RealtimeEventType.GRAPH_PULSE_EXPIRED,
            second_events[0].event_type,
        )
        active = second_outcome["projection"]["active_graph_pulses"]
        self.assertEqual(1, len(active))
        self.assertEqual(second.source_event.source_event_id, active[0]["source_event_id"])


class OutboxDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_temporal_unavailable_leaves_pending_then_retry_dispatches_once(self):
        repository = InMemoryRealtimeRepository()
        await repository.register_connector(registration())
        await repository.append_binding(external_binding())
        await repository.materialize_realtime_baseline(projection(), now=NOW)
        connector = ConfiguredPrometheusConnector(
            registration(),
            "https://metrics.example.test",
            "flowpulse_checkout_error_rate",
            Reader(payload()),
            ArtifactStore(),
            repository,
        )
        polled = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW,
        )

        class Temporal:
            def __init__(self):
                self.calls = 0
                self.fail = True

            async def dispatch(self, source, dispatch):
                self.calls += 1
                if self.fail:
                    raise RuntimeError("temporal_unavailable")
                return await repository.accept_pending_dispatch(
                    projection(), source, dispatch, first_event_sequence=2,
                )

        temporal = Temporal()
        scheduler = RealtimeIngestScheduler(
            repository=repository,
            connectors={},
            temporal_dispatch=temporal.dispatch,
            tenant_id="tenant-a",
            binding_templates=[],
        )
        await scheduler.dispatch_pending_once()
        self.assertEqual(
            ConnectorDispatchState.PENDING,
            (await repository.authoritative_dispatch(
                "tenant-a", polled.dispatch.dispatch_id,
            )).state,
        )
        temporal.fail = False
        await scheduler.dispatch_pending_once()
        await scheduler.dispatch_pending_once()
        self.assertEqual(
            ConnectorDispatchState.ACCEPTED,
            (await repository.authoritative_dispatch(
                "tenant-a", polled.dispatch.dispatch_id,
            )).state,
        )
        duplicate = await repository.admit_source_event(
            polled.source_event, polled.dispatch,
        )
        self.assertEqual(ConnectorDispatchState.ACCEPTED, duplicate.dispatch.state)
        self.assertEqual(polled.source_event, duplicate.source_event)
        self.assertEqual(polled.receipt, duplicate.receipt)
        self.assertEqual(2, temporal.calls)
        self.assertEqual(1, len(repository.commits))

    async def test_one_bad_case_does_not_starve_pending_temporal_dispatch(self):
        repository = InMemoryRealtimeRepository()
        await repository.register_connector(registration())
        await repository.append_binding(external_binding())
        polled = await ConfiguredPrometheusConnector(
            registration(),
            "https://metrics.example.test",
            "flowpulse_checkout_error_rate",
            Reader(payload()),
            ArtifactStore(),
            repository,
        ).poll(projection(), acl_subjects=["owner-a"], now=NOW)

        async def workspace_active_incidents(tenant_id, limit):
            return [type("Summary", (), {"case_id": "case-a"})()]

        async def workspace_projection(tenant_id, case_id):
            return projection()

        repository.workspace_active_incidents = workspace_active_incidents
        repository.workspace_projection = workspace_projection

        seen_poll_kwargs = {}

        class FailingConnector:
            registration = registration()

            async def poll(self, *args, **kwargs):
                seen_poll_kwargs.update(kwargs)
                raise ValueError("bad_case_binding")

        dispatched = 0

        async def temporal_dispatch(source, dispatch):
            nonlocal dispatched
            dispatched += 1
            return await repository.accept_pending_dispatch(
                projection(), source, dispatch, first_event_sequence=2,
            )

        result = await RealtimeIngestScheduler(
            repository=repository,
            connectors={"failing": FailingConnector()},
            temporal_dispatch=temporal_dispatch,
            tenant_id="tenant-a",
            binding_templates=[],
        ).run_once()
        self.assertEqual(
            {"polled": 0, "unavailable": 1, "dispatched": 1},
            result,
        )
        self.assertEqual(1, dispatched)
        self.assertEqual(
            ConnectorDispatchState.ACCEPTED,
            (await repository.authoritative_dispatch(
                "tenant-a", polled.dispatch.dispatch_id,
            )).state,
        )
        self.assertNotIn("now", seen_poll_kwargs)


class ServerBindingTemplateTests(unittest.TestCase):
    def test_binding_template_is_explicit_and_caller_cannot_supply_scope(self):
        template = ConfiguredBindingTemplate(
            binding_key="checkout-errors",
            external_resource_type="metric",
            external_resource_id="flowpulse_checkout_error_rate",
            component_ids=["checkout"],
            edge_ids=[],
            provenance_source="SERVER_CONNECTOR_CONFIG",
        )
        materialized = template.materialize(
            registration(), projection(), valid_from=NOW,
        )
        self.assertEqual(["checkout"], materialized.component_ids)
        self.assertEqual([], materialized.edge_ids)

"""Phase 1A connector facts, security boundary, and V2 read model."""

import unittest
import logging
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

from flowpulse_cp.realtime_adapters import (
    BoundedJsonReader,
    ConnectorReadError,
    ConnectorEndpointPolicy,
    PrometheusNormalizer,
)
from flowpulse_cp.realtime_models import (
    ConnectorHealthState,
    ConnectorDispatch,
    ConnectorDispatchState,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
    ExternalIdentityBinding,
    RealtimeSourceEvent,
)
from flowpulse_cp.realtime_repository import InMemoryRealtimeRepository
from flowpulse_cp.realtime_observability import RealtimeTelemetry


NOW = datetime(2026, 7, 29, 20, 0, tzinfo=timezone.utc)
HASH_A = "a" * 64
HASH_B = "b" * 64


def registration() -> ConnectorRegistration:
    return ConnectorRegistration(
        connector_id="connector-prometheus-local",
        tenant_id="tenant-a",
        provider=ConnectorProvider.PROMETHEUS,
        adapter_version="prometheus-read.v1",
        data_classes=["METRIC"],
        capabilities=["METRICS"],
        freshness_sla_seconds=60,
        enabled=True,
        truth_label=ConnectorTruthLabel.TEST_DETERMINISTIC,
    )


def binding() -> ExternalIdentityBinding:
    return ExternalIdentityBinding(
        binding_id="binding-prometheus-checkout",
        binding_revision=1,
        tenant_id="tenant-a",
        connector_id="connector-prometheus-local",
        provider=ConnectorProvider.PROMETHEUS,
        external_resource_type="metric",
        external_resource_id="flowpulse_checkout_error_rate",
        case_id="case-a",
        incident_id="incident-a",
        run_id="run-a",
        topology_revision="topology-a",
        component_ids=["checkout"],
        edge_ids=["frontend->checkout"],
        valid_from=NOW - timedelta(minutes=5),
        status="ACTIVE",
        provenance_source="OWNER_CONFIG",
    )


class ConnectorSecurityAndNormalizerTests(unittest.TestCase):
    def test_endpoint_policy_rejects_ssrf_unless_exact_origin_is_allowlisted(self):
        resolver = lambda host, port, **_: [
            (None, None, None, None, (
                "127.0.0.1" if host in {"127.0.0.1", "169.254.169.254"} else "8.8.8.8",
                port,
            )),
        ]
        policy = ConnectorEndpointPolicy(
            allowed_origins=["https://metrics.example.test"],
            resolver=resolver,
        )
        self.assertEqual(
            policy.validate("https://metrics.example.test/api/v1/query"),
            "https://metrics.example.test/api/v1/query",
        )
        for url in (
            "http://127.0.0.1:9090/api/v1/query",
            "http://169.254.169.254/latest/meta-data",
            "file:///etc/passwd",
            "https://evil.example.test/api/v1/query",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                policy.validate(url)
        local = ConnectorEndpointPolicy(
            allowed_origins=["http://127.0.0.1:9090"],
            allow_private_origins=True,
            resolver=resolver,
        )
        self.assertEqual(
            local.validate("http://127.0.0.1:9090/api/v1/query"),
            "http://127.0.0.1:9090/api/v1/query",
        )

    def test_prometheus_normalizer_is_bounded_strict_and_deterministic(self):
        normalizer = PrometheusNormalizer(max_series=2, max_samples=4)
        payload = {
            "status": "success",
            "data": {
                "resultType": "vector",
                "result": [{
                    "metric": {"__name__": "flowpulse_checkout_error_rate", "service": "checkout"},
                    "value": [NOW.timestamp(), "0.084"],
                }],
            },
        }
        first = normalizer.normalize(
            payload=payload, registration=registration(), binding=binding(),
            provider_event_id="poll:cursor-1", received_at=NOW,
            raw_artifact_ref="tenant-a/sha256/" + HASH_A, raw_content_hash=HASH_A,
            acl_subjects=["owner-a"],
        )
        second = normalizer.normalize(
            payload=payload, registration=registration(), binding=binding(),
            provider_event_id="poll:cursor-1", received_at=NOW,
            raw_artifact_ref="tenant-a/sha256/" + HASH_A, raw_content_hash=HASH_A,
            acl_subjects=["owner-a"],
        )
        self.assertEqual(first, second)
        self.assertEqual(first.display_value, "8.4%")
        self.assertEqual(first.normalization_hash, first.canonical_hash())
        self.assertNotIn("payload", first.json())
        with self.assertRaises(ValueError):
            PrometheusNormalizer(max_series=0, max_samples=4)
        with self.assertRaises(ValueError):
            normalizer.normalize(
                payload={"status": "success", "data": {"resultType": "vector", "result": [{}, {}, {}]}},
                registration=registration(), binding=binding(),
                provider_event_id="poll:too-many", received_at=NOW,
                raw_artifact_ref="tenant-a/sha256/" + HASH_A, raw_content_hash=HASH_A,
                acl_subjects=["owner-a"],
            )

    def test_connector_contracts_reject_unknown_fields(self):
        with self.assertRaises(ValidationError):
            ConnectorRegistration.parse_obj({
                **registration().dict(),
                "endpoint_url": "http://caller-controlled.example",
            })

    def test_reader_and_normalizer_fail_closed_on_size_time_and_malformed_data(self):
        resolver = lambda host, port, **_: [
            (None, None, None, None, ("8.8.8.8", port)),
        ]
        policy = ConnectorEndpointPolicy(
            allowed_origins=["https://metrics.example.test"],
            resolver=resolver,
        )
        with self.assertRaisesRegex(ValueError, "timeout_out_of_bounds"):
            BoundedJsonReader(policy, timeout_seconds=11)
        reader = BoundedJsonReader(policy, max_response_bytes=8)

        class Response:
            def read(self, size):
                return b"x" * size

        class Opener:
            def open(self, request, timeout):
                return Response()

        reader.opener = Opener()
        with self.assertRaisesRegex(ConnectorReadError, "response_size_exceeded"):
            reader.read("https://metrics.example.test/api/v1/query")
        with self.assertRaisesRegex(ValueError, "result_empty_or_malformed"):
            PrometheusNormalizer().normalize(
                payload={
                    "status": "success",
                    "data": {"resultType": "vector", "result": []},
                },
                registration=registration(),
                binding=binding(),
                provider_event_id="poll:empty",
                received_at=NOW,
                raw_artifact_ref="tenant-a/sha256/" + HASH_A,
                raw_content_hash=HASH_A,
                acl_subjects=["owner-a"],
            )

    def test_observability_exposes_bounded_red_and_lag_without_raw_or_secret_values(self):
        messages = []

        class Capture(logging.Handler):
            def emit(self, record):
                messages.append(record.getMessage())

        logger = logging.getLogger("flowpulse.realtime.test")
        logger.handlers = [Capture()]
        logger.setLevel(logging.INFO)
        telemetry = RealtimeTelemetry(logger)
        telemetry.record(
            "PROMETHEUS",
            "poll",
            "success",
            duration_ms=12,
            lag_seconds=3,
            queue_depth=1,
            correlation={"delivery_id": "delivery-safe", "raw_payload": "secret-body"},
        )
        with self.assertRaisesRegex(RuntimeError, "induced_provider_failure"):
            with telemetry.span("PROMETHEUS", "poll"):
                raise RuntimeError("induced_provider_failure")
        snapshot = telemetry.snapshot()
        self.assertEqual(1, snapshot["counters"]["PROMETHEUS:poll:success"])
        self.assertEqual(1, snapshot["counters"]["PROMETHEUS:poll:error"])
        serialized = "\n".join(messages)
        self.assertIn("delivery-safe", serialized)
        self.assertNotIn("secret-body", serialized)
        self.assertNotIn("raw_payload", serialized)


class RealtimeRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = InMemoryRealtimeRepository()
        await self.repository.register_connector(registration())
        await self.repository.append_binding(binding())

    async def test_same_identity_same_hash_is_idempotent_different_hash_conflicts(self):
        event = PrometheusNormalizer().normalize(
            payload={
                "status": "success",
                "data": {
                    "resultType": "vector",
                    "result": [{"metric": {}, "value": [NOW.timestamp(), "0.084"]}],
                },
            },
            registration=registration(),
            binding=binding(),
            provider_event_id="poll:cursor-1",
            received_at=NOW,
            raw_artifact_ref="tenant-a/sha256/" + HASH_A,
            raw_content_hash=HASH_A,
            acl_subjects=["incident-team"],
        )
        dispatch = ConnectorDispatch(
            dispatch_id="dispatch-" + event.normalization_hash[:24],
            tenant_id=event.tenant_id,
            connector_id=event.connector_id,
            source_event_id=event.source_event_id,
            case_id=event.case_id,
            run_id=event.run_id,
            normalization_hash=event.normalization_hash,
            state=ConnectorDispatchState.PENDING,
            attempt=1,
            created_at=NOW,
        )
        first = await self.repository.admit_source_event(event, dispatch)
        duplicate = await self.repository.admit_source_event(event, dispatch)
        lost_ack_retry = await self.repository.admit_source_event(
            event.copy(update={"received_at": NOW + timedelta(seconds=1)}),
            dispatch.copy(update={"created_at": NOW + timedelta(seconds=1)}),
        )
        self.assertEqual(first.source_event_id, duplicate.source_event_id)
        self.assertTrue(first.accepted)
        self.assertEqual(first.receipt, duplicate.receipt)
        self.assertEqual(first.receipt, lost_ack_retry.receipt)
        self.assertEqual(
            NOW,
            (
                await self.repository.source_event(
                    "tenant-a", event.source_event_id,
                )
            ).received_at,
        )
        conflict = event.copy(update={
            "raw_content_hash": "c" * 64,
            "raw_artifact_ref": "tenant-a/sha256/" + "c" * 64,
            "normalization_hash": "0" * 64,
        })
        conflict = conflict.copy(update={"normalization_hash": conflict.canonical_hash()})
        with self.assertRaisesRegex(ValueError, "connector_delivery_identity_conflict"):
            await self.repository.admit_source_event(
                conflict,
                dispatch.copy(update={
                    "source_event_id": conflict.source_event_id,
                    "normalization_hash": conflict.normalization_hash,
                }),
            )
        cross_run = event.copy(update={
            "run_id": "run-b",
            "provider_event_id": "poll:cursor-cross-run",
            "normalization_hash": "0" * 64,
        })
        cross_run = cross_run.copy(update={"normalization_hash": cross_run.canonical_hash()})
        cross_run = cross_run.copy(update={
            "source_event_id": "source-" + cross_run.normalization_hash[:24],
            "delivery_id": "delivery-" + cross_run.normalization_hash[:24],
        })
        with self.assertRaisesRegex(ValueError, "realtime_binding_tenant_or_run_mismatch"):
            await self.repository.admit_source_event(
                cross_run,
                dispatch.copy(update={
                    "source_event_id": cross_run.source_event_id,
                    "run_id": cross_run.run_id,
                    "normalization_hash": cross_run.normalization_hash,
                }),
            )

    async def test_unbound_connector_is_truthfully_unavailable(self):
        health = await self.repository.connector_health("tenant-a")
        self.assertEqual(health[0].state, ConnectorHealthState.UNAVAILABLE)

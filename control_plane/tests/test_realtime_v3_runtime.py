"""V3 realtime truth-plane acceptance tests.

These tests keep the realtime loop bounded: immutable telemetry in, typed
series/topology/freshness facts out, with restart-safe cursors and no inferred
dependency edges.
"""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

from pydantic import ValidationError

from flowpulse_cp.models import EvidenceAuthority, FreshnessStatus, SourceKind
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.realtime_adapters import (
    ConfiguredOtelSpoolConnector,
    OtelSpoolNormalizer,
)
from flowpulse_cp.realtime_activities import RealtimeActivityDispatcher
from flowpulse_cp.realtime_models import (
    ConfiguredBindingTemplate,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
    MetricPointV3,
    MetricSeriesCollectionV3,
    MetricSeriesV3,
    MetricThresholdV3,
    RealtimeEventType,
    RealtimeCommitActivityPacket,
    RealtimeSignal,
    RealtimeSignalStatus,
    RealtimeTrend,
    RealtimeUpdateCommand,
)
from flowpulse_cp.realtime_repository import (
    InMemoryRealtimeRepository,
    _validate_realtime_commit_artifacts,
)
from flowpulse_cp.realtime_scheduler import RealtimeIngestScheduler
from flowpulse_cp.realtime_series import build_metric_series_collection
from flowpulse_cp.workspace_models import IncidentRunBinding, initial_projection
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider


NOW = datetime(2026, 7, 31, 19, 0, tzinfo=timezone.utc)


class ArtifactStore:
    def put(self, tenant_id, raw):
        return "{}/sha256/{}".format(tenant_id, sha256(raw).hexdigest())


def registration(
    connector_id="connector-otel-traces",
    data_class="TRACE",
):
    return ConnectorRegistration(
        connector_id=connector_id,
        tenant_id="tenant-a",
        provider=ConnectorProvider.OTEL,
        adapter_version="otel-jsonl-spool.v3",
        data_classes=[data_class],
        capabilities=[data_class + "S"],
        freshness_sla_seconds=30,
        enabled=True,
        truth_label=ConnectorTruthLabel.LIVE,
    )


def projection(
    *,
    case_id="case-a",
    incident_id="incident-a",
    run_id="run-a",
):
    binding = IncidentRunBinding(
        tenant_id="tenant-a",
        incident_id=incident_id,
        run_id=run_id,
        topology_revision="topology-a",
        case_id=case_id,
        case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:" + run_id,
        workflow_run_id="temporal-" + run_id,
        created_at=NOW - timedelta(minutes=2),
    )
    return CapturedAstronomyTopologyProvider(ProviderMode.DEMO).snapshot(
        initial_projection(
            binding,
            ["checkout", "payment"],
            NOW - timedelta(minutes=2),
            "Checkout cannot reach payment",
            "Checkout requests fail at payment.",
        ),
    )


def binding_template():
    return ConfiguredBindingTemplate(
        binding_key="astronomy-checkout-payment-traces",
        external_resource_type="otel_trace_edge",
        external_resource_id="astronomy.checkout-payment",
        component_ids=["checkout", "payment"],
        edge_ids=["checkout->payment"],
    )


def resource_spans(service, spans):
    return {
        "resourceSpans": [{
            "resource": {"attributes": [{
                "key": "service.name",
                "value": {"stringValue": service},
            }]},
            "scopeSpans": [{"scope": {"name": "test"}, "spans": spans}],
        }],
    }


def span(trace_id, span_id, parent_span_id, start_ns, end_ns, *, error=False):
    return {
        "traceId": trace_id,
        "spanId": span_id,
        "parentSpanId": parent_span_id,
        "name": "oteldemo.PaymentService/Charge",
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "status": ({"code": 2, "message": "unavailable"} if error else {}),
    }


def checkout_payment_metric(
    observed_at,
    *,
    ok_count,
    ok_sum,
    failed_count,
    failed_sum,
):
    observed_ns = str(int(observed_at.timestamp() * 1_000_000_000))

    def point(status, count, total):
        return {
            "attributes": [
                {
                    "key": "rpc.method",
                    "value": {"stringValue": "oteldemo.PaymentService/Charge"},
                },
                {
                    "key": "rpc.response.status_code",
                    "value": {"stringValue": status},
                },
                {
                    "key": "rpc.system.name",
                    "value": {"stringValue": "grpc"},
                },
            ],
            "startTimeUnixNano": str(int(NOW.timestamp() * 1_000_000_000)),
            "timeUnixNano": observed_ns,
            "count": str(count),
            "sum": total,
            "bucketCounts": ["0", str(count)],
            "explicitBounds": [0.005],
        }

    return {
        "resourceMetrics": [{
            "resource": {"attributes": [{
                "key": "service.name",
                "value": {"stringValue": "checkout"},
            }]},
            "scopeMetrics": [{
                "scope": {
                    "name": "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc",
                },
                "metrics": [{
                    "name": "rpc.client.call.duration",
                    "description": "Measures the duration of an outgoing RPC.",
                    "unit": "s",
                    "histogram": {
                        "dataPoints": [
                            point("OK", ok_count, ok_sum),
                            point("UNAVAILABLE", failed_count, failed_sum),
                        ],
                        "aggregationTemporality": 2,
                    },
                }],
            }],
        }],
    }


def checkout_logs(*records):
    return {
        "resourceLogs": [{
            "resource": {"attributes": [{
                "key": "service.name",
                "value": {"stringValue": "checkout"},
            }]},
            "scopeLogs": [{
                "scope": {"name": "go.opentelemetry.io/checkout"},
                "logRecords": list(records),
            }],
        }],
    }


def log_record(observed_at, trace_id, severity_number, severity_text):
    return {
        "timeUnixNano": str(int(observed_at.timestamp() * 1_000_000_000)),
        "observedTimeUnixNano": str(
            int(observed_at.timestamp() * 1_000_000_000) + 10,
        ),
        "severityNumber": severity_number,
        "severityText": severity_text,
        "body": {"stringValue": "[PlaceOrder]"},
        "traceId": trace_id,
        "spanId": "span-" + trace_id,
    }


class TypedSeriesContractTests(unittest.TestCase):
    def test_typed_points_require_value_xor_gap_and_retain_evidence(self):
        point = MetricPointV3(
            sequence=1,
            timestamp=NOW,
            value=0.084,
            evidence_refs=["evidence-1"],
            freshness=FreshnessStatus.CURRENT,
        )
        gap = MetricPointV3(
            sequence=2,
            timestamp=NOW + timedelta(seconds=2),
            missing_reason="connector_stale",
            evidence_refs=[],
            freshness=FreshnessStatus.STALE,
        )
        for invalid in (
            {"sequence": 1, "timestamp": NOW, "freshness": "CURRENT"},
            {
                "sequence": 1, "timestamp": NOW, "value": 1.0,
                "missing_reason": "also-set", "freshness": "CURRENT",
            },
        ):
            with self.assertRaises(ValidationError):
                MetricPointV3.parse_obj(invalid)
        series = MetricSeriesV3(
            series_id="checkout.error_rate:checkout",
            metric_key="checkout.error_rate",
            component_id="checkout",
            label="Checkout error rate",
            unit="ratio",
            thresholds=MetricThresholdV3(warning=0.02, critical=0.05),
            points=[point, gap],
            observed_window_start=NOW,
            observed_window_end=NOW + timedelta(seconds=2),
            freshness=FreshnessStatus.STALE,
            source_connector_id="connector-prometheus-primary",
        )
        wrapper = MetricSeriesCollectionV3(
            case_id="case-a",
            signal_revision=2,
            generated_at=NOW + timedelta(seconds=2),
            series=[series],
        )
        payload = json.loads(wrapper.json(exclude_none=True))
        self.assertEqual(0.084, payload["series"][0]["points"][0]["value"])
        self.assertEqual("connector_stale", payload["series"][0]["points"][1]["missing_reason"])
        self.assertNotIn("display_value", payload["series"][0]["points"][0])

    def test_series_rejects_out_of_order_or_duplicate_points(self):
        base = {
            "series_id": "s", "metric_key": "m", "component_id": "checkout",
            "label": "Latency", "unit": "ms", "thresholds": {},
            "observed_window_start": NOW,
            "observed_window_end": NOW + timedelta(seconds=2),
            "freshness": "CURRENT", "source_connector_id": "connector-a",
        }
        with self.assertRaises(ValidationError):
            MetricSeriesV3.parse_obj({
                **base,
                "points": [
                    {"sequence": 2, "timestamp": NOW, "value": 1.0, "evidence_refs": [], "freshness": "CURRENT"},
                    {"sequence": 1, "timestamp": NOW + timedelta(seconds=2), "value": 2.0, "evidence_refs": [], "freshness": "CURRENT"},
                ],
            })

    def test_real_trace_facts_project_four_evidence_bound_changing_series(self):
        reg = registration()
        bound = binding_template().materialize(
            reg, projection(), valid_from=NOW - timedelta(minutes=1),
        )
        normalizer = OtelSpoolNormalizer()
        sources = []
        for index, offset in enumerate((0, 2, 7), 1):
            start_at = NOW + timedelta(seconds=offset)
            duration_ms = 400 + index * 125
            start_ns = int(start_at.timestamp() * 1_000_000_000)
            end_ns = start_ns + duration_ms * 1_000_000
            digest = sha256("trace-source-{}".format(index).encode()).hexdigest()
            sources.append(normalizer.normalize_component_error(
                registration=reg,
                binding=bound,
                span=span(
                    "trace-{}".format(index), "span-{}".format(index),
                    "parent-{}".format(index), start_ns, end_ns, error=True,
                ),
                service="checkout",
                received_at=datetime.fromtimestamp(
                    end_ns / 1_000_000_000, tz=timezone.utc,
                ) + timedelta(milliseconds=50),
                raw_artifact_ref="tenant-a/sha256/" + digest,
                raw_content_hash=digest,
                acl_subjects=["owner-a"],
            ))
        collection = build_metric_series_collection(
            case_id="case-a",
            sources=sources,
            signal_revision=3,
            generated_at=NOW + timedelta(seconds=8),
        )
        by_key = {item.metric_key: item for item in collection.series}
        self.assertEqual({
            "trace.client.duration",
            "trace.error_indicator",
            "dependency.availability",
            "trace.request_rate",
        }, set(by_key))
        self.assertEqual(3, len(set(
            point.value for point in by_key["trace.client.duration"].points
        )))
        self.assertEqual(2, len(set(
            point.value for point in by_key["trace.request_rate"].points
        )))
        self.assertTrue(all(
            point.evidence_refs
            for series in collection.series
            for point in series.points
            if point.value is not None
        ))

    def test_failed_client_then_healthy_edge_has_one_continuous_derived_series(self):
        """A repair changes the raw trace kind, not the incident-series identity."""
        reg = registration()
        bound = binding_template().materialize(
            reg, projection(), valid_from=NOW - timedelta(minutes=1),
        )
        normalizer = OtelSpoolNormalizer()

        failed_start = int(NOW.timestamp() * 1_000_000_000)
        failed_end = failed_start + 900_000_000
        failed_digest = sha256(b"failed-client-trace").hexdigest()
        failed = normalizer.normalize_component_error(
            registration=reg,
            binding=bound,
            span=span(
                "trace-failed", "span-failed", "checkout-parent",
                failed_start, failed_end, error=True,
            ),
            service="checkout",
            received_at=datetime.fromtimestamp(
                failed_end / 1_000_000_000, tz=timezone.utc,
            ) + timedelta(milliseconds=50),
            raw_artifact_ref="tenant-a/sha256/" + failed_digest,
            raw_content_hash=failed_digest,
            acl_subjects=["owner-a"],
        )

        healthy_start = int(
            (NOW + timedelta(seconds=3)).timestamp() * 1_000_000_000,
        )
        healthy_end = healthy_start + 180_000_000
        healthy_digest = sha256(b"healthy-parent-child-trace").hexdigest()
        parent = span(
            "trace-healthy", "span-parent", "",
            healthy_start - 50_000_000, healthy_start + 10_000_000,
        )
        healthy = normalizer.normalize(
            registration=reg,
            binding=bound,
            parent=parent,
            child=span(
                "trace-healthy", "span-child", "span-parent",
                healthy_start, healthy_end,
            ),
            parent_service="checkout",
            child_service="payment",
            edge_id="checkout->payment",
            received_at=datetime.fromtimestamp(
                healthy_end / 1_000_000_000, tz=timezone.utc,
            ) + timedelta(milliseconds=50),
            raw_artifact_ref="tenant-a/sha256/" + healthy_digest,
            raw_content_hash=healthy_digest,
            acl_subjects=["owner-a"],
        )

        collection = build_metric_series_collection(
            case_id="case-a",
            sources=[failed, healthy],
            signal_revision=2,
            generated_at=NOW + timedelta(seconds=4),
        )
        series_ids = [item.series_id for item in collection.series]
        self.assertEqual(len(series_ids), len(set(series_ids)))

        by_key = {}
        for item in collection.series:
            by_key.setdefault(item.metric_key, []).append(item)
        for derived_key in (
            "trace.error_indicator",
            "dependency.availability",
            "trace.request_rate",
        ):
            self.assertEqual(1, len(by_key[derived_key]), derived_key)

        self.assertEqual(
            [1.0, 0.0],
            [point.value for point in by_key["trace.error_indicator"][0].points],
        )
        self.assertEqual(
            [0.0, 1.0],
            [point.value for point in by_key["dependency.availability"][0].points],
        )
        self.assertEqual(1, len(by_key["trace.request_rate"][0].points))
        self.assertTrue(all(
            point.evidence_refs
            for key in (
                "trace.error_indicator",
                "dependency.availability",
                "trace.request_rate",
            )
            for series in by_key[key]
            for point in series.points
        ))


class OtelSpoolConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repository = InMemoryRealtimeRepository()
        self.registration = registration()
        await self.repository.register_connector(self.registration)
        self.binding = binding_template().materialize(
            self.registration, projection(), valid_from=NOW - timedelta(minutes=5),
        )
        await self.repository.append_binding(self.binding)

    async def asyncTearDown(self):
        self.temp.cleanup()

    def write(self, *records):
        path = self.root / "traces.jsonl"
        path.write_text("".join(json.dumps(item) + "\n" for item in records))
        return path

    @staticmethod
    def trace_record(trace_id, start):
        checkout = resource_spans("checkout", [
            span(trace_id, "parent-" + trace_id, "", start, start + 10),
        ])
        payment = resource_spans("payment", [
            span(
                trace_id, "child-" + trace_id, "parent-" + trace_id,
                start + 1, start + 20, error=True,
            ),
        ])
        return {
            "resourceSpans": (
                checkout["resourceSpans"] + payment["resourceSpans"]
            ),
        }

    def build_commit(self, result, prior, prior_realtime=None):
        return RealtimeActivityDispatcher(self.repository, {})._build_commit(
            RealtimeCommitActivityPacket(
                command=RealtimeUpdateCommand(
                    tenant_id=prior.tenant_id,
                    actor_subject_id="owner-a",
                    case_id=prior.case_id,
                    incident_id=prior.incident_id,
                    run_id=prior.run_id,
                    topology_revision=prior.topology_revision,
                    connector_id=result.registration.connector_id,
                    source_event_id=result.source_event.source_event_id,
                    dispatch_id=result.dispatch.dispatch_id,
                    idempotency_key=result.dispatch.dispatch_id,
                ),
                projection=prior,
                prior_realtime_projection=prior_realtime,
                first_event_sequence=prior.sequence + 1,
                poll_result=result,
            ),
        )

    async def out_of_order_commits(self, *, saturate_citations=False):
        newer = int((NOW + timedelta(seconds=2)).timestamp() * 1_000_000_000)
        older = int((NOW + timedelta(seconds=1)).timestamp() * 1_000_000_000)
        path = self.write(self.trace_record("trace-newer", newer))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=self.repository,
            max_lines_per_poll=32,
        )
        first_result = await connector.poll(
            projection(), acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=3),
        )
        first = self.build_commit(first_result, projection())
        prior_realtime = first.projection
        if saturate_citations:
            prior_realtime = prior_realtime.copy(update={
                "agent_workspace": prior_realtime.agent_workspace.copy(update={
                    "citations": [first.citation] + [
                        first.citation.copy(update={
                            "citation_id": "unused-citation-{}".format(index),
                        })
                        for index in range(63)
                    ],
                }),
            })
        with path.open("a") as stream:
            stream.write(json.dumps(self.trace_record("trace-older", older)) + "\n")
        second_result = await connector.poll(
            first.v1_projection,
            acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=4),
        )
        return first, self.build_commit(
            second_result, first.v1_projection, prior_realtime,
        )

    async def test_out_of_order_fact_commits_without_regressing_current_stream(self):
        first, second = await self.out_of_order_commits()

        _validate_realtime_commit_artifacts(second)
        self.assertEqual(
            [first.source_event.source_event_id],
            [item.source_event_id for item in second.projection.realtime_signals],
        )

    async def test_bounded_citations_keep_references_used_by_retained_signals(self):
        first, second = await self.out_of_order_commits(
            saturate_citations=True,
        )

        _validate_realtime_commit_artifacts(second)
        self.assertIn(
            first.citation,
            second.projection.agent_workspace.citations,
        )

    async def test_parent_child_trace_is_the_only_source_of_edge_and_pulse(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        self.write(
            resource_spans("checkout", [
                span("trace-a", "parent-a", "", start, start + 100_000_000),
            ]),
            resource_spans("payment", [
                span("trace-a", "child-a", "parent-a", start + 1, start + 900_000_000, error=True),
            ]),
        )
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=self.root / "traces.jsonl",
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=self.repository,
            max_lines_per_poll=32,
        )
        result = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1),
        )
        self.assertTrue(result.accepted)
        self.assertEqual("TRACE_PARENT_CHILD_OBSERVED", result.source_event.event_kind)
        self.assertEqual(["checkout->payment"], result.source_event.edge_ids)
        self.assertEqual(["checkout", "payment"], result.source_event.component_ids)
        self.assertEqual(RealtimeSignalStatus.CRITICAL, result.source_event.signal_status)

    async def test_restart_cursor_deduplicates_trace_and_advances_to_new_line(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        path = self.write(
            resource_spans("checkout", [span("trace-a", "parent-a", "", start, start + 10)]),
            resource_spans("payment", [span("trace-a", "child-a", "parent-a", start + 1, start + 20)]),
        )
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        first = await connector.poll(projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1))
        self.assertEqual(RealtimeSignalStatus.INFO, first.source_event.signal_status)
        restarted = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        duplicate = await restarted.poll(projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=2))
        self.assertFalse(duplicate.accepted)
        self.assertEqual("otel_spool_no_new_evidence", duplicate.reason_code)
        with path.open("a") as stream:
            stream.write(json.dumps(resource_spans("checkout", [span("trace-b", "parent-b", "", start + 30, start + 40)])) + "\n")
            stream.write(json.dumps(resource_spans("payment", [span("trace-b", "child-b", "parent-b", start + 31, start + 50)])) + "\n")
        second = await restarted.poll(projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=3))
        self.assertTrue(second.accepted)
        self.assertNotEqual(first.source_event.source_event_id, second.source_event.source_event_id)
        self.assertEqual(2, len(self.repository.source_events))

    async def test_restart_drains_every_trace_from_one_collector_record(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        checkout = resource_spans("checkout", [
            span("trace-a", "parent-a", "", start, start + 10),
            span("trace-b", "parent-b", "", start + 100, start + 110),
        ])
        payment = resource_spans("payment", [
            span(
                "trace-a", "child-a", "parent-a",
                start + 1, start + 20,
            ),
            span(
                "trace-b", "child-b", "parent-b",
                start + 101, start + 120,
            ),
        ])
        path = self.write({
            "resourceSpans": (
                checkout["resourceSpans"] + payment["resourceSpans"]
            ),
        })
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        first = await connector.poll(
            projection(), acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=1),
        )
        partial = await self.repository.latest_spool_cursor(
            "tenant-a", self.registration.connector_id,
            "traces.jsonl:case-a:run-a",
        )
        self.assertTrue(first.accepted)
        self.assertEqual(0, partial.byte_offset)
        self.assertEqual(1, partial.record_item_index)

        restarted = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        second = await restarted.poll(
            projection(), acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=2),
        )
        drained = await self.repository.latest_spool_cursor(
            "tenant-a", self.registration.connector_id,
            "traces.jsonl:case-a:run-a",
        )
        self.assertTrue(second.accepted)
        self.assertEqual(path.stat().st_size, drained.byte_offset)
        self.assertEqual(0, drained.record_item_index)
        self.assertEqual(1, drained.line_number)
        self.assertEqual(
            {
                "trace:trace-a:parent-a:child-a",
                "trace:trace-b:parent-b:child-b",
            },
            {
                item.source_event.provider_event_id.split(":binding:")[0]
                for item in (first, second)
            },
        )
        self.assertEqual(2, len(self.repository.source_events))
        exhausted = await restarted.poll(
            projection(), acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=3),
        )
        self.assertFalse(exhausted.accepted)
        self.assertEqual("otel_spool_no_new_evidence", exhausted.reason_code)

    async def test_bounded_lookback_never_starves_or_regresses_new_cursor(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        self.write(*(
            resource_spans("email", [
                span(
                    "trace-{}".format(index), "span-{}".format(index), "",
                    start + index * 100, start + index * 100 + 10,
                ),
            ])
            for index in range(12)
        ))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=self.root / "traces.jsonl",
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=4, max_bytes_per_poll=8192,
            lookback_bytes=2048,
        )
        await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1),
        )
        first = await self.repository.latest_spool_cursor(
            "tenant-a", self.registration.connector_id,
            "traces.jsonl:case-a:run-a",
        )
        await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=2),
        )
        second = await self.repository.latest_spool_cursor(
            "tenant-a", self.registration.connector_id,
            "traces.jsonl:case-a:run-a",
        )
        self.assertGreater(second.byte_offset, first.byte_offset)
        self.assertEqual(first.line_number + 4, second.line_number)

    async def test_partial_jsonl_record_is_retried_after_newline_arrives(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        parent = json.dumps(resource_spans("checkout", [
            span("trace-a", "parent-a", "", start, start + 10),
        ])).encode()
        child = json.dumps(resource_spans("payment", [
            span("trace-a", "child-a", "parent-a", start + 1, start + 20),
        ])).encode()
        path = self.root / "traces.jsonl"
        path.write_bytes(parent + b"\n" + child)
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        first = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1),
        )
        self.assertFalse(first.accepted)
        with path.open("ab") as stream:
            stream.write(b"\n")
        second = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=2),
        )
        self.assertTrue(second.accepted)
        self.assertEqual("TRACE_PARENT_CHILD_OBSERVED", second.source_event.event_kind)

    async def test_one_poll_never_checkpoints_past_a_later_trace_fact(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        path = self.write(resource_spans("email", [
            span("trace-seed", "span-seed", "", start, start + 10),
        ]))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1),
        )
        records = []
        for index in (1, 2):
            records.extend((
                resource_spans("checkout", [span(
                    "trace-{}".format(index), "parent-{}".format(index), "",
                    start + index * 100, start + index * 100 + 10,
                )]),
                resource_spans("payment", [span(
                    "trace-{}".format(index), "child-{}".format(index),
                    "parent-{}".format(index),
                    start + index * 100 + 1, start + index * 100 + 20,
                )]),
            ))
        with path.open("a") as stream:
            for record in records:
                stream.write(json.dumps(record) + "\n")
        first = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=2),
        )
        second = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=3),
        )
        self.assertTrue(first.accepted)
        self.assertTrue(second.accepted)
        self.assertNotEqual(
            first.source_event.source_event_id, second.source_event.source_event_id,
        )
        self.assertEqual(2, len(self.repository.source_events))

    async def test_cold_start_enters_large_live_spool_at_latest_bounded_fact(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        prefix = [resource_spans("email", [span(
            "trace-prefix-{}".format(index), "span-prefix-{}".format(index), "",
            start + index * 100, start + index * 100 + 10,
        )]) for index in range(40)]
        suffix = []
        for index in (1, 2):
            suffix.extend((
                resource_spans("checkout", [span(
                    "trace-tail-{}".format(index), "parent-tail-{}".format(index), "",
                    start + index * 1000, start + index * 1000 + 10,
                )]),
                resource_spans("payment", [span(
                    "trace-tail-{}".format(index), "child-tail-{}".format(index),
                    "parent-tail-{}".format(index),
                    start + index * 1000 + 1, start + index * 1000 + 20,
                )]),
            ))
        path = self.write(*(prefix + suffix))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32, max_bytes_per_poll=4096,
            lookback_bytes=1024,
        )
        result = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=3),
        )
        self.assertTrue(result.accepted)
        self.assertIn("trace-tail-2", result.source_event.provider_event_id)
        cursor = await self.repository.latest_spool_cursor(
            "tenant-a", self.registration.connector_id,
            "traces.jsonl:case-a:run-a",
        )
        self.assertGreater(cursor.byte_offset, path.stat().st_size - 4096)

    async def test_unrelated_services_do_not_invent_canonical_edges(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        self.write(
            resource_spans("checkout", [span("trace-a", "parent-a", "", start, start + 10)]),
            resource_spans("email", [span("trace-a", "child-a", "parent-a", start + 1, start + 20)]),
        )
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration, spool_path=self.root / "traces.jsonl",
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(), repository=self.repository,
            max_lines_per_poll=32,
        )
        result = await connector.poll(projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1))
        self.assertFalse(result.accepted)
        self.assertEqual("otel_spool_no_matching_parent_child", result.reason_code)
        self.assertEqual({}, self.repository.source_events)

    async def test_failed_checkout_client_span_proves_bound_payment_edge(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        self.write(resource_spans("checkout", [
            span(
                "trace-error", "client-error", "checkout-parent",
                start, start + 850_000_000, error=True,
            ),
        ]))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=self.root / "traces.jsonl",
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=self.repository,
            max_lines_per_poll=32,
        )
        result = await connector.poll(
            projection(), acl_subjects=["owner-a"], now=NOW + timedelta(seconds=1),
        )
        self.assertTrue(result.accepted)
        self.assertEqual("TRACE_COMPONENT_ERROR_OBSERVED", result.source_event.event_kind)
        self.assertEqual(RealtimeSignalStatus.CRITICAL, result.source_event.signal_status)
        self.assertEqual(["checkout", "payment"], result.source_event.component_ids)
        self.assertEqual(["checkout->payment"], result.source_event.edge_ids)

    async def test_shared_collector_fact_fans_out_to_two_case_scoped_cursors(self):
        start = int(NOW.timestamp() * 1_000_000_000)
        path = self.write(resource_spans("checkout", [
            span(
                "trace-shared", "client-shared", "checkout-parent",
                start, start + 850_000_000, error=True,
            ),
        ]))
        second_projection = projection(
            case_id="case-b", incident_id="incident-b", run_id="run-b",
        )
        await self.repository.append_binding(binding_template().materialize(
            self.registration,
            second_projection,
            valid_from=NOW - timedelta(minutes=5),
        ))
        connector = ConfiguredOtelSpoolConnector(
            registration=self.registration,
            spool_path=path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=self.repository,
        )
        first = await connector.poll(
            projection(), acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=1),
        )
        second = await connector.poll(
            second_projection, acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=1),
        )
        self.assertTrue(first.accepted)
        self.assertTrue(second.accepted)
        self.assertEqual({"case-a", "case-b"}, {
            first.source_event.case_id, second.source_event.case_id,
        })
        self.assertNotEqual(
            first.source_event.provider_event_id,
            second.source_event.provider_event_id,
        )
        for stream_id in (
            "traces.jsonl:case-a:run-a",
            "traces.jsonl:case-b:run-b",
        ):
            cursor = await self.repository.latest_spool_cursor(
                "tenant-a", self.registration.connector_id, stream_id,
            )
            self.assertEqual(path.stat().st_size, cursor.byte_offset)


class OtelMetricAndLogSpoolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def configured(self, data_class):
        repository = InMemoryRealtimeRepository()
        registration_value = registration(
            "connector-otel-" + data_class.lower(), data_class,
        )
        await repository.register_connector(registration_value)
        await repository.append_binding(binding_template().materialize(
            registration_value,
            projection(),
            valid_from=NOW - timedelta(minutes=5),
        ))
        return repository, registration_value

    async def test_actual_astronomy_histogram_shape_yields_three_changing_series(self):
        repository, registration_value = await self.configured("METRIC")
        path = self.root / "metrics.jsonl"
        samples = (
            (2, 0.20, 8, 0.08),
            (4, 0.50, 12, 0.18),
            (9, 1.20, 12, 0.24),
        )
        for sample_index, sample in enumerate(samples):
            observed_at = NOW + timedelta(seconds=sample_index * 10)
            with path.open("a") as stream:
                stream.write(json.dumps(checkout_payment_metric(
                    observed_at,
                    ok_count=sample[0],
                    ok_sum=sample[1],
                    failed_count=sample[2],
                    failed_sum=sample[3],
                )) + "\n")
            # One OTLP record contains three independently durable scalar
            # observations. Recreate the connector between every read to prove
            # the sub-record cursor survives process restarts.
            for _ in range(3):
                connector = ConfiguredOtelSpoolConnector(
                    registration=registration_value,
                    spool_path=path,
                    external_resource_id="astronomy.checkout-payment",
                    artifact_store=ArtifactStore(),
                    repository=repository,
                    max_bytes_per_poll=8 * 1024 * 1024,
                    lookback_bytes=0,
                )
                result = await connector.poll(
                    projection(), acl_subjects=["owner-a"],
                    now=observed_at + timedelta(seconds=1),
                )
                self.assertTrue(result.accepted)
        self.assertEqual(9, len(repository.source_events))
        collection = build_metric_series_collection(
            case_id="case-a",
            sources=list(repository.source_events.values()),
            signal_revision=9,
            generated_at=NOW + timedelta(seconds=21),
        )
        by_key = {item.metric_key: item for item in collection.series}
        self.assertEqual(
            [10.0, 6.0, 5.0],
            [
                point.value
                for point in by_key["checkout.payment.request_count"].points
            ],
        )
        self.assertEqual(3, len(set(
            point.value
            for point in by_key["checkout.payment.error_rate"].points
        )))
        self.assertEqual(3, len(set(
            point.value
            for point in by_key["checkout.payment.mean_latency"].points
        )))
        self.assertTrue(all(
            point.evidence_refs
            for key in (
                "checkout.payment.error_rate",
                "checkout.payment.request_count",
                "checkout.payment.mean_latency",
            )
            for point in by_key[key].points
        ))
        cursor = await repository.latest_spool_cursor(
            "tenant-a", registration_value.connector_id,
            "metrics.jsonl:case-a:run-a",
        )
        self.assertEqual(path.stat().st_size, cursor.byte_offset)
        self.assertEqual(0, cursor.record_item_index)

    async def test_multiple_logs_in_one_record_survive_restart_without_edge_claim(self):
        repository, registration_value = await self.configured("LOG")
        path = self.root / "logs.jsonl"
        path.write_text(json.dumps(checkout_logs(
            log_record(NOW, "trace-log-a", 9, "INFO"),
            log_record(
                NOW + timedelta(seconds=1), "trace-log-b", 17, "ERROR",
            ),
        )) + "\n")
        observed = []
        for offset in (2, 3):
            connector = ConfiguredOtelSpoolConnector(
                registration=registration_value,
                spool_path=path,
                external_resource_id="astronomy.checkout-payment",
                artifact_store=ArtifactStore(),
                repository=repository,
                lookback_bytes=0,
            )
            result = await connector.poll(
                projection(), acl_subjects=["owner-a"],
                now=NOW + timedelta(seconds=offset),
            )
            self.assertTrue(result.accepted)
            observed.append(result.source_event)
        self.assertEqual([9.0, 17.0], [item.numeric_value for item in observed])
        self.assertEqual(
            [RealtimeSignalStatus.INFO, RealtimeSignalStatus.CRITICAL],
            [item.signal_status for item in observed],
        )
        self.assertTrue(all(item.component_ids == ["checkout"] for item in observed))
        self.assertTrue(all(item.edge_ids == [] for item in observed))
        cursor = await repository.latest_spool_cursor(
            "tenant-a", registration_value.connector_id,
            "logs.jsonl:case-a:run-a",
        )
        self.assertEqual(path.stat().st_size, cursor.byte_offset)
        self.assertEqual(0, cursor.record_item_index)

    async def test_benign_metric_and_log_do_not_clear_fault_on_severity_or_edge(self):
        repository = InMemoryRealtimeRepository()
        registrations = {
            kind: registration("connector-otel-" + kind.lower(), kind)
            for kind in ("TRACE", "METRIC", "LOG")
        }
        initial = projection()
        for item in registrations.values():
            await repository.register_connector(item)
            await repository.append_binding(binding_template().materialize(
                item, initial, valid_from=NOW - timedelta(minutes=5),
            ))
        dispatcher = RealtimeActivityDispatcher(repository, {})
        prior = initial
        prior_realtime = None

        def commit(result, key):
            command = RealtimeUpdateCommand(
                tenant_id=prior.tenant_id,
                actor_subject_id="owner-a",
                case_id=prior.case_id,
                incident_id=prior.incident_id,
                run_id=prior.run_id,
                topology_revision=prior.topology_revision,
                connector_id=result.registration.connector_id,
                source_event_id=result.source_event.source_event_id,
                dispatch_id=result.dispatch.dispatch_id,
                idempotency_key=key,
            )
            return dispatcher._build_commit(RealtimeCommitActivityPacket(
                command=command,
                projection=prior,
                prior_realtime_projection=prior_realtime,
                first_event_sequence=prior.sequence + 1,
                poll_result=result,
            ))

        start = int(NOW.timestamp() * 1_000_000_000)
        trace_path = self.root / "traces.jsonl"
        trace_path.write_text(json.dumps(resource_spans("checkout", [span(
            "trace-fault-on", "client-fault-on", "checkout-parent",
            start, start + 850_000_000, error=True,
        )])) + "\n")
        trace_connector = ConfiguredOtelSpoolConnector(
            registration=registrations["TRACE"],
            spool_path=trace_path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=repository,
        )
        result = await trace_connector.poll(
            prior, acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=1),
        )
        built = commit(result, "commit-critical-trace")
        prior, prior_realtime = built.v1_projection, built.projection

        metric_path = self.root / "metrics.jsonl"
        metric_path.write_text(json.dumps(checkout_payment_metric(
            NOW + timedelta(seconds=2),
            ok_count=2, ok_sum=0.2,
            failed_count=8, failed_sum=0.08,
        )) + "\n")
        metric_connector = ConfiguredOtelSpoolConnector(
            registration=registrations["METRIC"],
            spool_path=metric_path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=repository,
            max_bytes_per_poll=8 * 1024 * 1024,
            lookback_bytes=0,
        )
        metric_evidence_kinds = []
        for index in range(3):
            result = await metric_connector.poll(
                prior, acl_subjects=["owner-a"],
                now=NOW + timedelta(seconds=3 + index),
            )
            built = commit(result, "commit-metric-{}".format(index))
            metric_evidence_kinds.append(built.evidence.source_kind)
            prior, prior_realtime = built.v1_projection, built.projection

        log_path = self.root / "logs.jsonl"
        log_path.write_text(json.dumps(checkout_logs(log_record(
            NOW + timedelta(seconds=5), "trace-benign-log", 9, "INFO",
        ))) + "\n")
        log_connector = ConfiguredOtelSpoolConnector(
            registration=registrations["LOG"],
            spool_path=log_path,
            external_resource_id="astronomy.checkout-payment",
            artifact_store=ArtifactStore(),
            repository=repository,
            lookback_bytes=0,
        )
        result = await log_connector.poll(
            prior, acl_subjects=["owner-a"],
            now=NOW + timedelta(seconds=6),
        )
        built = commit(result, "commit-benign-log")
        prior, prior_realtime = built.v1_projection, built.projection

        self.assertEqual([SourceKind.METRIC] * 3, metric_evidence_kinds)
        self.assertEqual(SourceKind.LOG, built.evidence.source_kind)
        self.assertEqual("SEV-1", prior.status)
        checkout = next(
            item for item in prior.graph.nodes if item.component_id == "checkout"
        )
        payment = next(
            item for item in prior.graph.nodes if item.component_id == "payment"
        )
        edge = next(
            item for item in prior.graph.edges
            if item.edge_id == "checkout->payment"
        )
        self.assertEqual("critical", checkout.runtime_status)
        self.assertEqual("critical", payment.runtime_status)
        self.assertEqual("impacted", edge.status)
        titles = {item.title for item in prior_realtime.realtime_signals}
        self.assertTrue({
            "Checkout to Payment error rate",
            "Checkout to Payment mean latency",
            "Checkout to Payment request count",
            "Checkout log severity",
        }.issubset(titles))
        self.assertEqual(
            set(item.connector_id for item in registrations.values()),
            {item.connector_id for item in prior_realtime.connector_health},
        )


class DurableFreshnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_scheduler_is_not_a_second_freshness_authority(self):
        class Repository:
            async def expire_freshness_deadlines(self, *args, **kwargs):
                raise AssertionError("freshness expiry belongs to Temporal")

            async def workspace_active_incidents(self, tenant_id, limit):
                return []

            async def pending_dispatches(self, tenant_id, *, limit, now):
                return []

        scheduler = RealtimeIngestScheduler(
            repository=Repository(),
            connectors={},
            temporal_dispatch=lambda source, dispatch: None,
            tenant_id="tenant-a",
            binding_templates=[],
            clock=lambda: NOW,
        )
        self.assertEqual({
            "polled": 0,
            "unavailable": 0,
            "ineligible": 0,
            "dispatched": 0,
        }, await scheduler.run_once())

    async def test_scoped_old_timer_cannot_expire_a_rearmed_connector(self):
        repository = InMemoryRealtimeRepository()
        reg = registration()
        await repository.register_connector(reg)
        await repository.materialize_realtime_baseline(projection(), now=NOW)
        first = await repository.arm_freshness_deadline(
            tenant_id="tenant-a",
            case_id="case-a",
            connector_id=reg.connector_id,
            deadline=NOW + timedelta(seconds=30),
            source_event_id="source-a",
        )
        second = await repository.arm_freshness_deadline(
            tenant_id="tenant-a",
            case_id="case-a",
            connector_id=reg.connector_id,
            deadline=NOW + timedelta(seconds=31),
            source_event_id="source-b",
        )
        stale = await repository.expire_freshness_deadlines(
            NOW + timedelta(seconds=60),
            tenant_id="tenant-a",
            case_id="case-a",
            connector_id=reg.connector_id,
            expected_deadline_revision=first.deadline_revision,
            expected_source_event_id=first.source_event_id,
        )
        self.assertEqual([], stale)
        self.assertEqual(
            second,
            await repository.latest_freshness_deadline(
                "tenant-a", "case-a", reg.connector_id,
            ),
        )

    async def test_deadline_emits_stale_once_then_recovers_on_new_sample(self):
        repository = InMemoryRealtimeRepository()
        reg = registration()
        await repository.register_connector(reg)
        await repository.materialize_realtime_baseline(projection(), now=NOW)
        await repository.arm_freshness_deadline(
            tenant_id="tenant-a", case_id="case-a", connector_id=reg.connector_id,
            deadline=NOW + timedelta(seconds=30), source_event_id="source-a",
        )
        before = await repository.expire_freshness_deadlines(NOW + timedelta(seconds=29))
        first = await repository.expire_freshness_deadlines(NOW + timedelta(seconds=30))
        repeated = await repository.expire_freshness_deadlines(NOW + timedelta(seconds=60))
        self.assertEqual([], before)
        self.assertEqual(1, len(first))
        self.assertEqual([], repeated)
        self.assertEqual(
            RealtimeEventType.CONNECTOR_HEALTH_CHANGED,
            first[0].event_type,
        )
        self.assertEqual(ConnectorHealthState.STALE, first[0].health.state)
        await repository.recover_freshness_deadline(
            tenant_id="tenant-a", case_id="case-a", connector_id=reg.connector_id,
            observed_at=NOW + timedelta(seconds=61), source_event_id="source-b",
        )
        deadline = await repository.latest_freshness_deadline("tenant-a", "case-a", reg.connector_id)
        self.assertEqual("ARMED", deadline.state)
        self.assertEqual("source-b", deadline.source_event_id)

    async def test_evicted_stream_signal_stales_only_its_connector_health(self):
        repository = InMemoryRealtimeRepository()
        trace = registration("connector-otel-primary", "TRACE")
        metrics = registration("connector-otel-metrics", "METRIC")
        for item in (trace, metrics):
            await repository.register_connector(item)
            await repository.append_connector_health(ConnectorHealth(
                connector_id=item.connector_id,
                tenant_id=item.tenant_id,
                provider=item.provider,
                state=ConnectorHealthState.CONNECTED,
                checked_at=NOW,
                last_success_at=NOW,
                last_event_observed_at=NOW,
                fresh_until=NOW + timedelta(days=1),
                cursor="byte:1",
                consecutive_failures=0,
                lag_seconds=0,
                adapter_version=item.adapter_version,
                health_revision=1,
                truth_label=item.truth_label,
            ))
        baseline = await repository.materialize_realtime_baseline(
            projection(), now=NOW,
        )
        trace_signal = RealtimeSignal(
            signal_id="signal-trace-current",
            source_event_id="source-trace-current",
            provider=ConnectorProvider.OTEL,
            source_label="OpenTelemetry",
            signal_kind="TRACE_STATUS",
            title="Checkout dependency trace",
            display_value="100 ms",
            status=RealtimeSignalStatus.CRITICAL,
            trend=RealtimeTrend.STABLE,
            component_ids=["checkout", "payment"],
            edge_ids=["checkout->payment"],
            observed_at=NOW,
            fresh_until=NOW + timedelta(days=1),
            freshness=FreshnessStatus.CURRENT,
            authority=EvidenceAuthority.T0,
            evidence_refs=["evidence-trace-current"],
            citation_refs=["citation-trace-current"],
            connector_state=ConnectorHealthState.CONNECTED,
            sequence=baseline.sequence + 1,
        )
        repository.projections[("tenant-a", "case-a")].append(
            baseline.copy(update={
                "projection_revision": baseline.projection_revision + 1,
                "sequence": baseline.sequence + 1,
                "realtime_signals": [trace_signal],
                "incident_clock": baseline.incident_clock.copy(update={
                    "last_signal_at": NOW,
                    "freshness": FreshnessStatus.CURRENT,
                    "fresh_until": NOW + timedelta(days=1),
                }),
            }),
        )
        await repository.arm_freshness_deadline(
            tenant_id="tenant-a",
            case_id="case-a",
            connector_id=metrics.connector_id,
            deadline=NOW + timedelta(seconds=30),
            source_event_id="source-metric-evicted",
        )

        events = await repository.expire_freshness_deadlines(
            NOW + timedelta(seconds=30),
            tenant_id="tenant-a",
            case_id="case-a",
            connector_id=metrics.connector_id,
        )

        self.assertEqual(1, len(events))
        self.assertEqual(
            RealtimeEventType.CONNECTOR_HEALTH_CHANGED,
            events[0].event_type,
        )
        current = repository.projections[("tenant-a", "case-a")][-1]
        self.assertEqual([trace_signal], current.realtime_signals)
        self.assertEqual(FreshnessStatus.CURRENT, current.incident_clock.freshness)
        health_by_id = {
            item.connector_id: item for item in current.connector_health
        }
        self.assertEqual(
            ConnectorHealthState.CONNECTED,
            health_by_id[trace.connector_id].state,
        )
        self.assertEqual(
            ConnectorHealthState.STALE,
            health_by_id[metrics.connector_id].state,
        )

    def test_severity_order_is_critical_warning_info(self):
        values = [
            RealtimeSignalStatus.WARNING,
            RealtimeSignalStatus.INFO,
            RealtimeSignalStatus.CRITICAL,
        ]
        self.assertEqual(
            [RealtimeSignalStatus.CRITICAL, RealtimeSignalStatus.WARNING, RealtimeSignalStatus.INFO],
            sorted(values, key=lambda item: item.priority, reverse=True),
        )


class RuntimeProfileTests(unittest.TestCase):
    def test_real_profile_uses_two_second_poll_and_contains_no_wave(self):
        compose = Path(__file__).parents[1] / "docker-compose.yml"
        payload = compose.read_text()
        self.assertIn("FLOWPULSE_REALTIME_SCHEDULER_INTERVAL_SECONDS: ${FLOWPULSE_REALTIME_SCHEDULER_INTERVAL_SECONDS:-2}", payload)
        self.assertIn("FLOWPULSE_OTEL_SPOOL_ROOT", payload)
        self.assertNotIn("sin(vector(time()", (compose.parent / "prometheus" / "phase1a.rules.yml").read_text())


if __name__ == "__main__":
    unittest.main()

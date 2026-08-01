"""Bounded restart-safe OpenTelemetry JSONL spool connector."""

import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import EvidenceAuthority, FreshnessStatus, ProofScope
from .realtime_connector_errors import ConnectorReadError
from .realtime_models import (
    ConnectorAdmissionResult,
    ConnectorDispatch,
    ConnectorDispatchState,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorPollResult,
    ConnectorProvider,
    ConnectorRegistration,
    ExternalIdentityBinding,
    RealtimeDeliveryMode,
    RealtimeSignalStatus,
    RealtimeSourceEvent,
    RealtimeTrend,
    SpoolCursor,
)
from .realtime_observability import realtime_telemetry
from .workspace_models import IncidentProjection

def _otel_attribute_value(value: Any) -> Any:
    if not isinstance(value, dict):
        return None
    for field in (
        "stringValue", "intValue", "doubleValue", "boolValue", "bytesValue",
    ):
        if field in value:
            return value[field]
    return None


def _otel_service_name(resource: Dict[str, Any]) -> Optional[str]:
    attributes = resource.get("attributes", []) if isinstance(resource, dict) else []
    for attribute in attributes:
        if isinstance(attribute, dict) and attribute.get("key") == "service.name":
            value = _otel_attribute_value(attribute.get("value"))
            if isinstance(value, str) and value:
                return value.strip().lower().replace("_", "-")
    return None


def _otel_attributes(attributes: Any) -> Dict[str, Any]:
    """Decode the bounded scalar subset used by the incident bindings."""
    decoded = {}
    for attribute in attributes if isinstance(attributes, list) else []:
        if not isinstance(attribute, dict):
            continue
        key = attribute.get("key")
        if not isinstance(key, str) or not key:
            continue
        decoded[key] = _otel_attribute_value(attribute.get("value"))
    return decoded


def _otel_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        return None
    return parsed


def _otel_nanos(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("otel_span_timestamp_invalid") from error
    if parsed <= 0:
        raise ValueError("otel_span_timestamp_invalid")
    return parsed


def _bound_provider_event_id(
    provider_identity: str,
    binding: ExternalIdentityBinding,
) -> str:
    """Scope one immutable provider fact to its server-owned case binding."""
    return "{}:binding:{}".format(
        provider_identity,
        sha256(binding.binding_id.encode("utf-8")).hexdigest()[:16],
    )


def _metric_observations(
    payload: Any,
    binding: ExternalIdentityBinding,
) -> List[Dict[str, Any]]:
    """Extract only deployment-bound, incident-facing Astronomy metrics.

    These values are calculated from an exact OTLP histogram exported by the
    Checkout service.  No wall-clock interpolation or generated sample is
    admitted: each point retains the contributing OTLP data points as its raw
    evidence artifact.
    """
    if not isinstance(payload, dict):
        return []
    observations = []
    for resource_group in payload.get("resourceMetrics", []):
        if not isinstance(resource_group, dict):
            continue
        service = _otel_service_name(resource_group.get("resource", {}))
        if service != "checkout" or service not in binding.component_ids:
            continue
        for scope_group in resource_group.get("scopeMetrics", []):
            if not isinstance(scope_group, dict):
                continue
            for metric in scope_group.get("metrics", []):
                if (
                    not isinstance(metric, dict)
                    or metric.get("name") != "rpc.client.call.duration"
                ):
                    continue
                histogram = metric.get("histogram")
                points = (
                    histogram.get("dataPoints", [])
                    if isinstance(histogram, dict) else []
                )
                payment_points = []
                for point in points:
                    if not isinstance(point, dict):
                        continue
                    attributes = _otel_attributes(point.get("attributes"))
                    if attributes.get("rpc.method") != "oteldemo.PaymentService/Charge":
                        continue
                    count = _otel_number(point.get("count"))
                    total = _otel_number(point.get("sum"))
                    try:
                        observed_ns = _otel_nanos(point.get("timeUnixNano"))
                    except ValueError:
                        continue
                    if count is None or count < 0 or total is None or total < 0:
                        continue
                    payment_points.append({
                        "attributes": point.get("attributes", []),
                        "count": count,
                        "sum": total,
                        "startTimeUnixNano": str(point.get("startTimeUnixNano", "")),
                        "timeUnixNano": str(observed_ns),
                    })
                if not payment_points:
                    continue
                observed_ns = max(int(item["timeUnixNano"]) for item in payment_points)
                total_count = sum(item["count"] for item in payment_points)
                if total_count <= 0:
                    continue
                failed_count = sum(
                    item["count"]
                    for item in payment_points
                    if str(_otel_attributes(item["attributes"]).get(
                        "rpc.response.status_code", "UNKNOWN",
                    )).upper() != "OK"
                )
                total_duration_seconds = sum(item["sum"] for item in payment_points)
                start_values = []
                for item in payment_points:
                    try:
                        start_values.append(_otel_nanos(item["startTimeUnixNano"]))
                    except ValueError:
                        continue
                interval_start_ns = min(start_values) if start_values else observed_ns
                raw_base = {
                    "service": service,
                    "metric": metric.get("name"),
                    "unit": metric.get("unit"),
                    "dataPoints": payment_points,
                }
                values = (
                    (
                        "checkout.payment.error_rate",
                        failed_count / total_count,
                        "ratio",
                        0.01,
                        0.05,
                    ),
                    (
                        "checkout.payment.request_count",
                        total_count,
                        "requests",
                        None,
                        None,
                    ),
                    (
                        "checkout.payment.mean_latency",
                        total_duration_seconds / total_count * 1000.0,
                        "ms",
                        500.0,
                        1500.0,
                    ),
                )
                for metric_key, value, unit, warning, critical in values:
                    raw_payload = dict(raw_base, derived_metric_key=metric_key)
                    raw_hash = sha256(json.dumps(
                        raw_payload, sort_keys=True, separators=(",", ":"),
                    ).encode("utf-8")).hexdigest()
                    observations.append({
                        "identity": (metric_key, observed_ns, raw_hash),
                        "observed_ns": observed_ns,
                        "service": service,
                        "metric_key": metric_key,
                        "value": float(value),
                        "unit": unit,
                        "warning_threshold": warning,
                        "critical_threshold": critical,
                        "cumulative_request_count": float(total_count),
                        "cumulative_failed_count": float(failed_count),
                        "cumulative_duration_seconds": float(total_duration_seconds),
                        "sample_interval_start_ns": interval_start_ns,
                        "raw_payload": raw_payload,
                    })
    observations.sort(key=lambda item: item["identity"])
    return observations


def _interval_metric_observations(
    observations: List[Dict[str, Any]],
    prior_sources: List[RealtimeSourceEvent],
) -> List[Dict[str, Any]]:
    """Convert cumulative OTLP histograms into reset-aware interval facts.

    Every emitted scalar retains the exact cumulative counters, but its public
    numeric value covers only calls since the preceding admitted snapshot. A
    first snapshot or a Collector reset is explicitly bounded by the OTLP
    start timestamp, allowing Verify to reject intervals that began before the
    repair receipt.
    """
    if not observations:
        return []
    current = observations[0]
    current_observed_ns = current["observed_ns"]
    current_observed_at = datetime.fromtimestamp(
        current_observed_ns / 1_000_000_000, tz=timezone.utc,
    )
    prior = next((
        item for item in sorted(
            prior_sources,
            key=lambda item: (item.observed_at, item.source_event_id),
            reverse=True,
        )
        if item.observed_at < current_observed_at
        and item.event_kind == "METRIC_OBSERVED"
        and item.cumulative_request_count is not None
        and item.cumulative_failed_count is not None
        and item.cumulative_duration_seconds is not None
    ), None)
    totals = (
        current["cumulative_request_count"],
        current["cumulative_failed_count"],
        current["cumulative_duration_seconds"],
    )
    reset = prior is None or any(
        current_value < prior_value
        for current_value, prior_value in zip(totals, (
            prior.cumulative_request_count if prior is not None else 0.0,
            prior.cumulative_failed_count if prior is not None else 0.0,
            prior.cumulative_duration_seconds if prior is not None else 0.0,
        ))
    )
    if reset:
        baseline = (0.0, 0.0, 0.0)
        interval_start_ns = current["sample_interval_start_ns"]
    else:
        baseline = (
            prior.cumulative_request_count,
            prior.cumulative_failed_count,
            prior.cumulative_duration_seconds,
        )
        interval_start_ns = int(prior.observed_at.timestamp() * 1_000_000_000)
    request_count = totals[0] - baseline[0]
    failed_count = totals[1] - baseline[1]
    duration_seconds = totals[2] - baseline[2]
    if request_count <= 0 or failed_count < 0 or duration_seconds < 0:
        return []
    interval_values = {
        "checkout.payment.error_rate": failed_count / request_count,
        "checkout.payment.request_count": request_count,
        "checkout.payment.mean_latency": duration_seconds / request_count * 1000.0,
    }
    return [{
        **item,
        "value": float(interval_values[item["metric_key"]]),
        "sample_interval_start_ns": interval_start_ns,
    } for item in observations]


def _log_observations(
    payload: Any,
    binding: ExternalIdentityBinding,
) -> List[Dict[str, Any]]:
    """Extract bound Checkout/Payment log records without inventing topology."""
    if not isinstance(payload, dict):
        return []
    observations = []
    for resource_group in payload.get("resourceLogs", []):
        if not isinstance(resource_group, dict):
            continue
        service = _otel_service_name(resource_group.get("resource", {}))
        if service not in binding.component_ids:
            continue
        for scope_group in resource_group.get("scopeLogs", []):
            if not isinstance(scope_group, dict):
                continue
            for record in scope_group.get("logRecords", []):
                if not isinstance(record, dict):
                    continue
                timestamp = record.get("timeUnixNano") or record.get(
                    "observedTimeUnixNano",
                )
                try:
                    observed_ns = _otel_nanos(timestamp)
                except ValueError:
                    continue
                severity = _otel_number(record.get("severityNumber"))
                if severity is None or severity < 0:
                    continue
                raw_payload = {
                    "service": service,
                    "scope": scope_group.get("scope", {}),
                    "record": record,
                }
                raw_hash = sha256(json.dumps(
                    raw_payload, sort_keys=True, separators=(",", ":"),
                ).encode("utf-8")).hexdigest()
                observations.append({
                    "identity": (
                        observed_ns,
                        str(record.get("traceId", "")),
                        str(record.get("spanId", "")),
                        raw_hash,
                    ),
                    "observed_ns": observed_ns,
                    "service": service,
                    "metric_key": "log.severity_number",
                    "value": float(severity),
                    "unit": "severity",
                    "warning_threshold": 13.0,
                    "critical_threshold": 17.0,
                    "raw_payload": raw_payload,
                })
    observations.sort(key=lambda item: item["identity"])
    return observations


class OtelSpoolNormalizer:
    """Normalize only a proved OTel parent-child service relation."""

    def normalize(
        self,
        *,
        registration: ConnectorRegistration,
        binding: ExternalIdentityBinding,
        parent: Dict[str, Any],
        child: Dict[str, Any],
        parent_service: str,
        child_service: str,
        edge_id: str,
        received_at: datetime,
        raw_artifact_ref: str,
        raw_content_hash: str,
        acl_subjects: List[str],
    ) -> RealtimeSourceEvent:
        if registration.provider != ConnectorProvider.OTEL:
            raise ValueError("otel_registration_provider_mismatch")
        trace_id = child.get("traceId")
        child_span_id = child.get("spanId")
        parent_span_id = child.get("parentSpanId")
        if (
            not all(isinstance(item, str) and item for item in (
                trace_id, child_span_id, parent_span_id,
            ))
            or parent.get("traceId") != trace_id
            or parent.get("spanId") != parent_span_id
        ):
            raise ValueError("otel_parent_child_not_proven")
        if (
            parent_service not in binding.component_ids
            or child_service not in binding.component_ids
            or edge_id not in binding.edge_ids
        ):
            raise ValueError("otel_relation_not_server_bound")
        start_ns = _otel_nanos(child.get("startTimeUnixNano"))
        end_ns = _otel_nanos(child.get("endTimeUnixNano"))
        if end_ns < start_ns:
            raise ValueError("otel_span_interval_invalid")
        observed_at = datetime.fromtimestamp(end_ns / 1_000_000_000, tz=timezone.utc)
        current = observed_at + timedelta(
            seconds=registration.freshness_sla_seconds,
        ) >= received_at
        duration_ms = float((end_ns - start_ns) / 1_000_000)
        status = child.get("status") if isinstance(child.get("status"), dict) else {}
        status_code = status.get("code")
        error = status_code in {2, "2", "STATUS_CODE_ERROR", "ERROR"}
        event_values = {
            "source_event_id": "pending",
            "tenant_id": registration.tenant_id,
            "connector_id": registration.connector_id,
            "provider": registration.provider,
            "provider_event_id": _bound_provider_event_id(
                "trace:{}:{}:{}".format(
                    trace_id, parent_span_id, child_span_id,
                ),
                binding,
            ),
            "delivery_id": "pending",
            "raw_artifact_ref": raw_artifact_ref,
            "raw_content_hash": raw_content_hash,
            "event_kind": "TRACE_PARENT_CHILD_OBSERVED",
            "binding_id": binding.binding_id,
            "binding_revision": binding.binding_revision,
            "case_id": binding.case_id,
            "incident_id": binding.incident_id,
            "run_id": binding.run_id,
            "topology_revision": binding.topology_revision,
            "component_ids": [parent_service, child_service],
            "edge_ids": [edge_id],
            "observed_at": observed_at,
            "effective_at": observed_at,
            "received_at": received_at,
            "display_value": "{:.0f} ms".format(duration_ms),
            "numeric_value": duration_ms,
            "metric_key": "trace.edge.duration",
            "unit": "ms",
            "warning_threshold": 500.0,
            "critical_threshold": 1500.0,
            "signal_status": (
                RealtimeSignalStatus.CRITICAL
                if error or duration_ms >= 1500.0
                else RealtimeSignalStatus.WARNING
                if duration_ms >= 500.0
                else RealtimeSignalStatus.INFO
            ),
            "trend": RealtimeTrend.UNKNOWN,
            "delivery_mode": RealtimeDeliveryMode.LIVE,
            "freshness": (
                FreshnessStatus.CURRENT if current else FreshnessStatus.STALE
            ),
            "authority": EvidenceAuthority.T0 if current else EvidenceAuthority.T1,
            "proof_scope": (
                ProofScope.CURRENT_OBSERVATION if current else ProofScope.REFERENCE_ONLY
            ),
            "acl_subjects": acl_subjects,
            "normalizer_version": "otel-jsonl-parent-child.v1",
            "normalization_hash": "0" * 64,
            "truth_label": registration.truth_label,
        }
        provisional = RealtimeSourceEvent.parse_obj(event_values)
        normalization_hash = provisional.canonical_hash()
        identity = normalization_hash[:24]
        return provisional.copy(update={
            "source_event_id": "source-" + identity,
            "delivery_id": "delivery-" + identity,
            "normalization_hash": normalization_hash,
        })

    def normalize_scalar_observation(
        self,
        *,
        registration: ConnectorRegistration,
        binding: ExternalIdentityBinding,
        service: str,
        observed_ns: int,
        metric_key: str,
        numeric_value: float,
        unit: str,
        warning_threshold: Optional[float],
        critical_threshold: Optional[float],
        event_kind: str,
        received_at: datetime,
        raw_artifact_ref: str,
        raw_content_hash: str,
        acl_subjects: List[str],
        sample_interval_start_ns: Optional[int] = None,
        cumulative_request_count: Optional[float] = None,
        cumulative_failed_count: Optional[float] = None,
        cumulative_duration_seconds: Optional[float] = None,
    ) -> RealtimeSourceEvent:
        """Normalize a real metric/log scalar without claiming an edge."""
        if registration.provider != ConnectorProvider.OTEL:
            raise ValueError("otel_registration_provider_mismatch")
        if service not in binding.component_ids:
            raise ValueError("otel_component_not_server_bound")
        observed_at = datetime.fromtimestamp(
            _otel_nanos(observed_ns) / 1_000_000_000,
            tz=timezone.utc,
        )
        current = observed_at + timedelta(
            seconds=registration.freshness_sla_seconds,
        ) >= received_at
        value = float(numeric_value)
        sample_interval_start_at = (
            datetime.fromtimestamp(
                _otel_nanos(sample_interval_start_ns) / 1_000_000_000,
                tz=timezone.utc,
            )
            if sample_interval_start_ns is not None else None
        )
        signal_status = (
            RealtimeSignalStatus.CRITICAL
            if critical_threshold is not None and value >= critical_threshold
            else RealtimeSignalStatus.WARNING
            if warning_threshold is not None and value >= warning_threshold
            else RealtimeSignalStatus.INFO
        )
        provisional = RealtimeSourceEvent.parse_obj({
            "source_event_id": "pending",
            "tenant_id": registration.tenant_id,
            "connector_id": registration.connector_id,
            "provider": registration.provider,
            "provider_event_id": _bound_provider_event_id(
                "{}:{}:{}:{}".format(
                    event_kind.lower(), service, metric_key,
                    raw_content_hash[:24],
                ),
                binding,
            ),
            "delivery_id": "pending",
            "raw_artifact_ref": raw_artifact_ref,
            "raw_content_hash": raw_content_hash,
            "event_kind": event_kind,
            "binding_id": binding.binding_id,
            "binding_revision": binding.binding_revision,
            "case_id": binding.case_id,
            "incident_id": binding.incident_id,
            "run_id": binding.run_id,
            "topology_revision": binding.topology_revision,
            "component_ids": [service],
            # A scalar metric/log proves a component observation, not a
            # dependency relation. Only normalized trace facts can pulse an edge.
            "edge_ids": [],
            "observed_at": observed_at,
            "effective_at": observed_at,
            "received_at": received_at,
            "display_value": "{:.4g} {}".format(value, unit),
            "numeric_value": value,
            "metric_key": metric_key,
            "unit": unit,
            "warning_threshold": warning_threshold,
            "critical_threshold": critical_threshold,
            "sample_interval_start_at": sample_interval_start_at,
            "cumulative_request_count": cumulative_request_count,
            "cumulative_failed_count": cumulative_failed_count,
            "cumulative_duration_seconds": cumulative_duration_seconds,
            "signal_status": signal_status,
            "trend": RealtimeTrend.UNKNOWN,
            "delivery_mode": RealtimeDeliveryMode.LIVE,
            "freshness": (
                FreshnessStatus.CURRENT if current else FreshnessStatus.STALE
            ),
            "authority": EvidenceAuthority.T0 if current else EvidenceAuthority.T1,
            "proof_scope": (
                ProofScope.CURRENT_OBSERVATION if current
                else ProofScope.REFERENCE_ONLY
            ),
            "acl_subjects": acl_subjects,
            "normalizer_version": "otel-jsonl-scalar.v1",
            "normalization_hash": "0" * 64,
            "truth_label": registration.truth_label,
        })
        normalization_hash = provisional.canonical_hash()
        identity = normalization_hash[:24]
        return provisional.copy(update={
            "source_event_id": "source-" + identity,
            "delivery_id": "delivery-" + identity,
            "normalization_hash": normalization_hash,
        })

    def normalize_component_error(
        self,
        *,
        registration: ConnectorRegistration,
        binding: ExternalIdentityBinding,
        span: Dict[str, Any],
        service: str,
        target_service: Optional[str] = None,
        edge_id: Optional[str] = None,
        received_at: datetime,
        raw_artifact_ref: str,
        raw_content_hash: str,
        acl_subjects: List[str],
    ) -> RealtimeSourceEvent:
        """Normalize a failed client span with only server-bound attribution."""
        if service not in binding.component_ids:
            raise ValueError("otel_component_not_server_bound")
        if bool(target_service) != bool(edge_id):
            raise ValueError("otel_bound_client_error_attribution_incomplete")
        if target_service is not None and (
            target_service not in binding.component_ids
            or edge_id not in binding.edge_ids
        ):
            raise ValueError("otel_bound_client_error_relation_not_bound")
        trace_id = span.get("traceId")
        span_id = span.get("spanId")
        if not all(isinstance(item, str) and item for item in (trace_id, span_id)):
            raise ValueError("otel_span_identity_invalid")
        start_ns = _otel_nanos(span.get("startTimeUnixNano"))
        end_ns = _otel_nanos(span.get("endTimeUnixNano"))
        if end_ns < start_ns:
            raise ValueError("otel_span_interval_invalid")
        status = span.get("status") if isinstance(span.get("status"), dict) else {}
        if status.get("code") not in {2, "2", "STATUS_CODE_ERROR", "ERROR"}:
            raise ValueError("otel_component_error_not_proven")
        observed_at = datetime.fromtimestamp(end_ns / 1_000_000_000, tz=timezone.utc)
        current = observed_at + timedelta(
            seconds=registration.freshness_sla_seconds,
        ) >= received_at
        duration_ms = float((end_ns - start_ns) / 1_000_000)
        provisional = RealtimeSourceEvent.parse_obj({
            "source_event_id": "pending",
            "tenant_id": registration.tenant_id,
            "connector_id": registration.connector_id,
            "provider": registration.provider,
            "provider_event_id": _bound_provider_event_id(
                "trace:{}:span:{}".format(trace_id, span_id),
                binding,
            ),
            "delivery_id": "pending",
            "raw_artifact_ref": raw_artifact_ref,
            "raw_content_hash": raw_content_hash,
            "event_kind": "TRACE_COMPONENT_ERROR_OBSERVED",
            "binding_id": binding.binding_id,
            "binding_revision": binding.binding_revision,
            "case_id": binding.case_id,
            "incident_id": binding.incident_id,
            "run_id": binding.run_id,
            "topology_revision": binding.topology_revision,
            "component_ids": (
                [service, target_service]
                if target_service is not None else [service]
            ),
            "edge_ids": [edge_id] if edge_id is not None else [],
            "observed_at": observed_at,
            "effective_at": observed_at,
            "received_at": received_at,
            "display_value": "{:.0f} ms · error".format(duration_ms),
            "numeric_value": duration_ms,
            "metric_key": "trace.client.duration",
            "unit": "ms",
            "warning_threshold": 500.0,
            "critical_threshold": 1500.0,
            "signal_status": RealtimeSignalStatus.CRITICAL,
            "trend": RealtimeTrend.UNKNOWN,
            "delivery_mode": RealtimeDeliveryMode.LIVE,
            "freshness": (
                FreshnessStatus.CURRENT if current else FreshnessStatus.STALE
            ),
            "authority": EvidenceAuthority.T0 if current else EvidenceAuthority.T1,
            "proof_scope": (
                ProofScope.CURRENT_OBSERVATION if current else ProofScope.REFERENCE_ONLY
            ),
            "acl_subjects": acl_subjects,
            "normalizer_version": "otel-jsonl-component-error.v2",
            "normalization_hash": "0" * 64,
            "truth_label": registration.truth_label,
        })
        normalization_hash = provisional.canonical_hash()
        identity = normalization_hash[:24]
        return provisional.copy(update={
            "source_event_id": "source-" + identity,
            "delivery_id": "delivery-" + identity,
            "normalization_hash": normalization_hash,
        })


class ConfiguredOtelSpoolConnector:
    """Bounded, restart-safe reader for Collector JSONL exports.

    The connector reads append-only files. It may look behind the durable byte
    cursor to recover a parent span that was exported in the preceding batch,
    but only a relation containing newly appended bytes can be admitted.
    """

    def __init__(
        self,
        *,
        registration: ConnectorRegistration,
        spool_path: Path,
        external_resource_id: str,
        artifact_store: Any,
        repository: Any,
        max_lines_per_poll: int = 256,
        max_bytes_per_poll: int = 2 * 1024 * 1024,
        lookback_bytes: int = 512 * 1024,
        poll_burst: int = 1,
    ) -> None:
        if registration.provider != ConnectorProvider.OTEL:
            raise ValueError("otel_spool_registration_provider_mismatch")
        if max_lines_per_poll < 1 or max_lines_per_poll > 2048:
            raise ValueError("otel_spool_line_limit_invalid")
        if max_bytes_per_poll < 1024 or max_bytes_per_poll > 8 * 1024 * 1024:
            raise ValueError("otel_spool_byte_limit_invalid")
        if lookback_bytes < 0 or lookback_bytes > max_bytes_per_poll:
            raise ValueError("otel_spool_lookback_invalid")
        if poll_burst < 1 or poll_burst > 64:
            raise ValueError("otel_spool_poll_burst_invalid")
        self.registration = registration
        self.spool_path = Path(spool_path)
        self.external_resource_id = external_resource_id
        self.artifact_store = artifact_store
        self.repository = repository
        self.max_lines_per_poll = max_lines_per_poll
        self.max_bytes_per_poll = max_bytes_per_poll
        self.lookback_bytes = lookback_bytes
        self.poll_burst = poll_burst
        self.normalizer = OtelSpoolNormalizer()
        try:
            self.stream_kind = {
                "traces.jsonl": "traces",
                "metrics.jsonl": "metrics",
                "logs.jsonl": "logs",
            }[self.spool_path.name]
        except KeyError as error:
            raise ValueError("otel_spool_stream_unsupported") from error

    def _cursor_stream_id(self, projection: IncidentProjection) -> str:
        # A Collector stream is shared by all incidents. Each incident needs a
        # durable read position so the first active case cannot consume facts
        # away from the next one. The run identity also isolates reruns.
        return "{}:{}:{}".format(
            self.spool_path.name, projection.case_id, projection.run_id,
        )

    async def _health(
        self,
        *,
        checked_at: datetime,
        state: ConnectorHealthState,
        reason_code: Optional[str],
        last_event_observed_at: Optional[datetime] = None,
        cursor: Optional[str] = None,
        lag_seconds: int = 0,
    ) -> ConnectorHealth:
        prior = None
        load_health = getattr(
            self.repository, "realtime_connector_health", None,
        ) or getattr(self.repository, "connector_health", None)
        if callable(load_health):
            prior = next((
                item for item in await load_health(self.registration.tenant_id)
                if item.connector_id == self.registration.connector_id
                and item.last_event_observed_at is not None
            ), None)
        last_event_observed_at = (
            last_event_observed_at
            or (prior.last_event_observed_at if prior is not None else None)
        )
        fresh_until = (
            last_event_observed_at
            + timedelta(seconds=self.registration.freshness_sla_seconds)
            if last_event_observed_at is not None
            else (prior.fresh_until if prior is not None else None)
        )
        requested_state = state
        if (
            state == ConnectorHealthState.CONNECTED
            and fresh_until is not None
            and checked_at >= fresh_until
        ):
            state = ConnectorHealthState.STALE
            reason_code = "freshness_sla_exceeded"
        effective_lag = max(0, lag_seconds)
        if last_event_observed_at is not None:
            effective_lag = max(
                effective_lag,
                int(max(
                    0.0,
                    (checked_at - last_event_observed_at).total_seconds(),
                )),
            )
        health = ConnectorHealth(
            connector_id=self.registration.connector_id,
            tenant_id=self.registration.tenant_id,
            provider=self.registration.provider,
            state=state,
            checked_at=checked_at,
            last_success_at=(
                checked_at
                if requested_state == ConnectorHealthState.CONNECTED
                else (prior.last_success_at if prior is not None else None)
            ),
            last_event_observed_at=last_event_observed_at,
            fresh_until=fresh_until,
            cursor=cursor or (prior.cursor if prior is not None else None),
            consecutive_failures=(
                1 if state in {ConnectorHealthState.DEGRADED, ConnectorHealthState.UNAVAILABLE} else 0
            ),
            lag_seconds=effective_lag,
            reason_code=reason_code,
            adapter_version=self.registration.adapter_version,
            health_revision=await self.repository.next_health_revision(
                self.registration.tenant_id, self.registration.connector_id,
            ),
            truth_label=self.registration.truth_label,
        )
        return await self.repository.append_connector_health(health)

    async def _poll_scalar_stream(
        self,
        projection: IncidentProjection,
        *,
        acl_subjects: List[str],
        checked_at: datetime,
    ) -> ConnectorPollResult:
        """Read one real metric/log fact and checkpoint only after admission."""
        try:
            binding = await self.repository.resolve_external_identity_binding(
                projection,
                self.registration.connector_id,
                self.external_resource_id,
                checked_at,
            )
        except ValueError as error:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.UNAVAILABLE,
                reason_code=str(error),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=str(error),
                registration=self.registration,
                health=health,
            )
        try:
            stat = self.spool_path.stat()
        except OSError:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.UNAVAILABLE,
                reason_code="otel_spool_unavailable",
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_unavailable",
                registration=self.registration,
                health=health,
            )
        file_identity = "{}:{}".format(stat.st_dev, stat.st_ino)
        stream_id = self._cursor_stream_id(projection)
        cursor = await self.repository.latest_spool_cursor(
            self.registration.tenant_id,
            self.registration.connector_id,
            stream_id,
        )
        cursor_matches_file = (
            cursor is not None
            and cursor.file_identity == file_identity
            and cursor.byte_offset <= stat.st_size
        )
        if cursor_matches_file:
            prior_offset = cursor.byte_offset
        else:
            prior_offset = max(0, stat.st_size - self.max_bytes_per_poll)
            if prior_offset:
                try:
                    with self.spool_path.open("rb") as stream:
                        stream.seek(prior_offset)
                        stream.readline()
                        prior_offset = stream.tell()
                except OSError:
                    prior_offset = 0
        prior_item_index = (
            cursor.record_item_index if cursor_matches_file else 0
        )
        if stat.st_size <= prior_offset:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_no_new_evidence",
                cursor="byte:{}".format(prior_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_no_new_evidence",
                registration=self.registration,
                health=health,
            )

        records = []
        new_line_ends = []
        new_offset = prior_offset
        total = 0
        try:
            with self.spool_path.open("rb") as stream:
                stream.seek(prior_offset)
                for _ in range(self.max_lines_per_poll):
                    line_start = stream.tell()
                    remaining = self.max_bytes_per_poll - total
                    if remaining <= 0:
                        break
                    raw_line = stream.readline(remaining + 1)
                    if not raw_line:
                        break
                    if len(raw_line) > remaining:
                        break
                    if not raw_line.endswith(b"\n"):
                        break
                    total += len(raw_line)
                    line_end = stream.tell()
                    new_offset = line_end
                    new_line_ends.append(line_end)
                    try:
                        payload = json.loads(raw_line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        realtime_telemetry.record(
                            "OTEL", "normalize", "error",
                            reason_code="otel_spool_line_malformed",
                            correlation={"case_id": projection.case_id},
                        )
                        continue
                    extractor = (
                        _metric_observations
                        if self.stream_kind == "metrics"
                        else _log_observations
                    )
                    observations = extractor(payload, binding)
                    records.append((
                        line_start, line_end, observations,
                    ))
        except OSError as error:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.DEGRADED,
                reason_code=type(error).__name__,
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_read_failed",
                registration=self.registration,
                health=health,
            )

        line_number = cursor.line_number if cursor_matches_file else 0

        async def save_cursor(
            advance_offset: int,
            *,
            record_item_index: int = 0,
        ) -> None:
            if advance_offset < prior_offset:
                return
            if (
                advance_offset == prior_offset
                and record_item_index <= prior_item_index
            ):
                return
            await self.repository.save_spool_cursor(SpoolCursor(
                tenant_id=self.registration.tenant_id,
                connector_id=self.registration.connector_id,
                stream_id=stream_id,
                cursor_revision=(cursor.cursor_revision + 1 if cursor else 1),
                byte_offset=advance_offset,
                record_item_index=record_item_index,
                line_number=line_number + sum(
                    1 for line_end in new_line_ends
                    if prior_offset < line_end <= advance_offset
                ),
                file_identity=file_identity,
                updated_at=checked_at,
            ))

        if new_offset <= prior_offset:
            reason = "otel_spool_no_complete_record"
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code=reason,
                cursor="byte:{}".format(prior_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=reason,
                registration=self.registration,
                health=health,
            )
        matching = [item for item in records if item[2]]
        if not matching:
            if prior_item_index:
                reason = "otel_spool_partial_record_changed"
                health = await self._health(
                    checked_at=checked_at,
                    state=ConnectorHealthState.DEGRADED,
                    reason_code=reason,
                    cursor="byte:{}#item:{}".format(
                        prior_offset, prior_item_index,
                    ),
                )
                return ConnectorPollResult(
                    accepted=False,
                    reason_code=reason,
                    registration=self.registration,
                    health=health,
                )
            await save_cursor(new_offset)
            reason = "otel_spool_no_matching_{}".format(
                "metric" if self.stream_kind == "metrics" else "log",
            )
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code=reason,
                cursor="byte:{}".format(new_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=reason,
                registration=self.registration,
                health=health,
            )
        accepted_record = (
            min(matching, key=lambda item: item[1])
            if cursor_matches_file
            else max(matching, key=lambda item: item[1])
        )
        accepted_start, accepted_end, observations = accepted_record
        if prior_item_index and accepted_start != prior_offset:
            reason = "otel_spool_partial_record_changed"
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.DEGRADED,
                reason_code=reason,
                cursor="byte:{}#item:{}".format(
                    prior_offset, prior_item_index,
                ),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=reason,
                registration=self.registration,
                health=health,
            )
        if self.stream_kind == "metrics":
            prior_sources = await self.repository.recent_source_events_for_binding(
                self.registration.tenant_id, binding.binding_id, limit=256,
            )
            observations = _interval_metric_observations(
                observations, prior_sources,
            )
            if not observations:
                await save_cursor(accepted_end)
                health = await self._health(
                    checked_at=checked_at,
                    state=ConnectorHealthState.CONNECTED,
                    reason_code="otel_spool_metric_interval_empty",
                    cursor="byte:{}".format(accepted_end),
                )
                return ConnectorPollResult(
                    accepted=False,
                    reason_code="otel_spool_metric_interval_empty",
                    registration=self.registration,
                    health=health,
                )
        observation_index = prior_item_index if accepted_start == prior_offset else 0
        if observation_index >= len(observations):
            await save_cursor(accepted_end)
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_record_drained",
                cursor="byte:{}".format(accepted_end),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_record_drained",
                registration=self.registration,
                health=health,
            )
        observation = observations[observation_index]
        raw_fact = json.dumps(
            observation["raw_payload"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        raw_hash = sha256(raw_fact).hexdigest()
        artifact_ref = self.artifact_store.put(
            self.registration.tenant_id, raw_fact,
        )
        event_kind = (
            "METRIC_OBSERVED"
            if self.stream_kind == "metrics"
            else "LOG_RECORD_OBSERVED"
        )
        try:
            source = self.normalizer.normalize_scalar_observation(
                registration=self.registration,
                binding=binding,
                service=observation["service"],
                observed_ns=observation["observed_ns"],
                metric_key=observation["metric_key"],
                numeric_value=observation["value"],
                unit=observation["unit"],
                warning_threshold=observation["warning_threshold"],
                critical_threshold=observation["critical_threshold"],
                sample_interval_start_ns=observation.get(
                    "sample_interval_start_ns",
                ),
                cumulative_request_count=observation.get(
                    "cumulative_request_count",
                ),
                cumulative_failed_count=observation.get(
                    "cumulative_failed_count",
                ),
                cumulative_duration_seconds=observation.get(
                    "cumulative_duration_seconds",
                ),
                event_kind=event_kind,
                received_at=checked_at,
                raw_artifact_ref=artifact_ref,
                raw_content_hash=raw_hash,
                acl_subjects=acl_subjects,
            )
        except ValueError as error:
            next_item_index = observation_index + 1
            if next_item_index < len(observations):
                await save_cursor(
                    accepted_start,
                    record_item_index=next_item_index,
                )
            else:
                await save_cursor(accepted_end)
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.DEGRADED,
                reason_code=str(error),
                cursor="byte:{}".format(accepted_end),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=str(error),
                registration=self.registration,
                health=health,
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
            created_at=checked_at,
        )
        admitted = await self.repository.admit_source_event(source, dispatch)
        source = admitted.source_event
        next_item_index = observation_index + 1
        if next_item_index < len(observations):
            cursor_offset = accepted_start
            await save_cursor(
                cursor_offset,
                record_item_index=next_item_index,
            )
        else:
            cursor_offset = accepted_end
            next_item_index = 0
            await save_cursor(cursor_offset)
        lag = max(0, int((checked_at - source.observed_at).total_seconds()))
        state = (
            ConnectorHealthState.CONNECTED
            if source.freshness == FreshnessStatus.CURRENT
            else ConnectorHealthState.STALE
        )
        health = await self._health(
            checked_at=checked_at,
            state=state,
            reason_code=(
                None if state == ConnectorHealthState.CONNECTED
                else "freshness_sla_exceeded"
            ),
            last_event_observed_at=source.observed_at,
            cursor=(
                "byte:{}#item:{}".format(cursor_offset, next_item_index)
                if next_item_index
                else "byte:{}".format(cursor_offset)
            ),
            lag_seconds=lag,
        )
        realtime_telemetry.record(
            "OTEL", "poll", "success",
            lag_seconds=lag,
            correlation={
                "source_event_id": source.source_event_id,
                "case_id": source.case_id,
                "run_id": source.run_id,
            },
        )
        return ConnectorPollResult(
            registration=self.registration,
            health=health,
            receipt=admitted.receipt,
            source_event=source,
            dispatch=admitted.dispatch,
        )

    async def poll(
        self,
        projection: IncidentProjection,
        *,
        acl_subjects: List[str],
        now: Optional[datetime] = None,
        delivery_mode: RealtimeDeliveryMode = RealtimeDeliveryMode.LIVE,
    ) -> ConnectorPollResult:
        checked_at = now or datetime.now(timezone.utc)
        if delivery_mode != RealtimeDeliveryMode.LIVE:
            raise ConnectorReadError("otel_spool_backfill_not_supported")
        if self.stream_kind in {"metrics", "logs"}:
            return await self._poll_scalar_stream(
                projection,
                acl_subjects=acl_subjects,
                checked_at=checked_at,
            )
        try:
            binding = await self.repository.resolve_external_identity_binding(
                projection,
                self.registration.connector_id,
                self.external_resource_id,
                checked_at,
            )
        except ValueError as error:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.UNAVAILABLE,
                reason_code=str(error),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=str(error),
                registration=self.registration,
                health=health,
            )
        try:
            stat = self.spool_path.stat()
        except OSError:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.UNAVAILABLE,
                reason_code="otel_spool_unavailable",
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_unavailable",
                registration=self.registration,
                health=health,
            )
        file_identity = "{}:{}".format(stat.st_dev, stat.st_ino)
        stream_id = self._cursor_stream_id(projection)
        cursor = await self.repository.latest_spool_cursor(
            self.registration.tenant_id,
            self.registration.connector_id,
            stream_id,
        )
        cursor_matches_file = (
            cursor is not None
            and cursor.file_identity == file_identity
            and cursor.byte_offset <= stat.st_size
        )
        if cursor_matches_file:
            prior_offset = cursor.byte_offset
        else:
            # This is a LIVE connector, not a backfill reader. On first start
            # or file rotation, enter through a bounded tail window so a large
            # retained Collector spool cannot delay current incident data for
            # thousands of scheduler ticks.
            prior_offset = max(0, stat.st_size - self.max_bytes_per_poll)
            if prior_offset:
                try:
                    with self.spool_path.open("rb") as stream:
                        stream.seek(prior_offset)
                        stream.readline()
                        prior_offset = stream.tell()
                except OSError:
                    prior_offset = 0
        if stat.st_size <= prior_offset:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_no_new_evidence",
                cursor="byte:{}".format(prior_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_no_new_evidence",
                registration=self.registration,
                health=health,
            )
        start_offset = max(0, prior_offset - self.lookback_bytes)
        records = []
        new_offset = prior_offset
        new_line_ends = []
        line_number = cursor.line_number if cursor_matches_file else 0

        def decode_record(line_start, line_end, raw_line):
            try:
                payload = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                realtime_telemetry.record(
                    "OTEL", "normalize", "error",
                    reason_code="otel_spool_line_malformed",
                    correlation={"case_id": projection.case_id},
                )
                return
            records.append((line_start, line_end, payload))

        try:
            with self.spool_path.open("rb") as stream:
                # Read a byte-bounded history window solely to resolve a parent
                # referenced by a newly appended child span. The line limit is
                # intentionally reserved for new bytes so lookback can never
                # starve or move the durable cursor backwards.
                stream.seek(start_offset)
                if start_offset:
                    stream.readline()
                    start_offset = stream.tell()
                while stream.tell() < prior_offset:
                    line_start = stream.tell()
                    raw_line = stream.readline(prior_offset - line_start)
                    if not raw_line:
                        break
                    line_end = stream.tell()
                    if line_end > prior_offset:
                        break
                    decode_record(line_start, line_end, raw_line)

                stream.seek(prior_offset)
                total = 0
                for _ in range(self.max_lines_per_poll):
                    line_start = stream.tell()
                    raw_line = stream.readline(self.max_bytes_per_poll - total + 1)
                    if not raw_line:
                        break
                    if total + len(raw_line) > self.max_bytes_per_poll:
                        break
                    # A Collector may still be writing the final JSON object.
                    # Do not parse or checkpoint a partial JSONL record.
                    if not raw_line.endswith(b"\n"):
                        break
                    total += len(raw_line)
                    line_end = stream.tell()
                    new_offset = line_end
                    new_line_ends.append(line_end)
                    decode_record(line_start, line_end, raw_line)
        except OSError as error:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.DEGRADED,
                reason_code=type(error).__name__,
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_read_failed",
                registration=self.registration,
                health=health,
            )

        prior_item_index = (
            cursor.record_item_index if cursor_matches_file else 0
        )

        async def save_cursor(
            advance_offset: int,
            *,
            record_item_index: int = 0,
        ) -> None:
            if advance_offset < prior_offset:
                return
            if (
                advance_offset == prior_offset
                and record_item_index <= prior_item_index
            ):
                return
            await self.repository.save_spool_cursor(SpoolCursor(
                tenant_id=self.registration.tenant_id,
                connector_id=self.registration.connector_id,
                stream_id=stream_id,
                cursor_revision=(cursor.cursor_revision + 1 if cursor else 1),
                byte_offset=advance_offset,
                record_item_index=record_item_index,
                line_number=line_number + sum(
                    1 for line_end in new_line_ends
                    if prior_offset < line_end <= advance_offset
                ),
                file_identity=file_identity,
                updated_at=checked_at,
            ))

        if new_offset <= prior_offset:
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_no_complete_record",
                cursor="byte:{}".format(prior_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_no_complete_record",
                registration=self.registration,
                health=health,
            )
        spans = {}
        for line_start, line_end, payload in records:
            groups = payload.get("resourceSpans", []) if isinstance(payload, dict) else []
            for group in groups:
                if not isinstance(group, dict):
                    continue
                service = _otel_service_name(group.get("resource", {}))
                if service is None:
                    continue
                for scope in group.get("scopeSpans", []):
                    if not isinstance(scope, dict):
                        continue
                    for span in scope.get("spans", []):
                        if not isinstance(span, dict):
                            continue
                        trace_id = span.get("traceId")
                        span_id = span.get("spanId")
                        if isinstance(trace_id, str) and isinstance(span_id, str):
                            spans[(trace_id, span_id)] = (
                                service, span, line_start, line_end,
                            )
        known_edges = {
            (edge.source_component_id, edge.target_component_id): edge.edge_id
            for edge in projection.graph.edges
            if edge.edge_id in binding.edge_ids
        }
        bound_payment_edges = {
            source: (target, edge_id)
            for (source, target), edge_id in known_edges.items()
            if target == "payment"
        }
        candidates = []
        component_errors = []
        for (trace_id, _), child_record in spans.items():
            child_service, child, child_start, child_end = child_record
            status = child.get("status") if isinstance(child.get("status"), dict) else {}
            if (
                child_end > prior_offset
                and child_service in bound_payment_edges
                and status.get("code") in {2, "2", "STATUS_CODE_ERROR", "ERROR"}
                and child.get("name") == "oteldemo.PaymentService/Charge"
            ):
                target_service, bound_edge_id = bound_payment_edges[child_service]
                component_errors.append((
                    child_end, child, child_service, trace_id,
                    str(child.get("spanId", "")), target_service,
                    bound_edge_id,
                ))
            parent_id = child.get("parentSpanId")
            parent_record = spans.get((trace_id, parent_id))
            if parent_record is None:
                continue
            parent_service, parent, parent_start, parent_end = parent_record
            edge_id = known_edges.get((parent_service, child_service))
            if edge_id is None or max(parent_end, child_end) <= prior_offset:
                continue
            candidates.append((
                max(parent_end, child_end), parent, child,
                parent_service, child_service, edge_id,
                trace_id, str(parent.get("spanId", "")),
                str(child.get("spanId", "")),
            ))
        if not candidates and not component_errors:
            if prior_item_index:
                health = await self._health(
                    checked_at=checked_at,
                    state=ConnectorHealthState.DEGRADED,
                    reason_code="otel_spool_partial_record_changed",
                    cursor="byte:{}#item:{}".format(
                        prior_offset, prior_item_index,
                    ),
                )
                return ConnectorPollResult(
                    accepted=False,
                    reason_code="otel_spool_partial_record_changed",
                    registration=self.registration,
                    health=health,
                )
            await save_cursor(new_offset)
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_no_matching_parent_child",
                cursor="byte:{}".format(new_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_no_matching_parent_child",
                registration=self.registration,
                health=health,
            )
        selector = min if cursor_matches_file else max
        accepted_offset = selector(
            {item[0] for item in component_errors}
            | {item[0] for item in candidates}
        )
        line_start_by_end = {
            line_end: line_start for line_start, line_end, _ in records
        }
        accepted_line_start = line_start_by_end[accepted_offset]

        def observation_timestamp(span: Dict[str, Any]) -> int:
            try:
                return int(span.get("endTimeUnixNano", 0))
            except (TypeError, ValueError):
                return 0

        observations = []
        identities = set()
        for (
            line_end, error_span, error_service, trace_id, span_id,
            target_service, bound_edge_id,
        ) in component_errors:
            if line_end != accepted_offset:
                continue
            identity = (
                "component_error", trace_id, span_id, error_service,
                target_service, bound_edge_id,
            )
            if identity in identities:
                continue
            identities.add(identity)
            observations.append((
                observation_timestamp(error_span), identity,
                "component_error", error_span, error_service,
                target_service, bound_edge_id,
            ))
        for (
            line_end, parent, child, parent_service, child_service, edge_id,
            trace_id, parent_span_id, child_span_id,
        ) in candidates:
            if line_end != accepted_offset:
                continue
            identity = (
                "relation", trace_id, parent_span_id, child_span_id, edge_id,
            )
            if identity in identities:
                continue
            identities.add(identity)
            observations.append((
                observation_timestamp(child), identity, "relation",
                parent, child, parent_service, child_service, edge_id,
            ))
        observations.sort(key=lambda item: (item[0], item[1]))
        observation_index = (
            prior_item_index
            if prior_item_index and accepted_line_start == prior_offset
            else 0
        )
        if observation_index >= len(observations):
            # The durable sub-record index proves every observation in this
            # immutable line was already admitted.  Normalize the cursor to
            # the next byte without replaying or skipping a fact.
            await save_cursor(accepted_offset, record_item_index=0)
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.CONNECTED,
                reason_code="otel_spool_record_drained",
                cursor="byte:{}".format(accepted_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code="otel_spool_record_drained",
                registration=self.registration,
                health=health,
            )
        observation = observations[observation_index]
        component_error = observation[2] == "component_error"
        if component_error:
            (
                _, _, _, error_span, error_service,
                target_service, bound_edge_id,
            ) = observation
            raw_payload = {
                "service": error_service,
                "target_service": target_service,
                "edge_id": bound_edge_id,
                "span": error_span,
            }
        else:
            (
                _, _, _, parent, child, parent_service, child_service, edge_id,
            ) = observation
            raw_payload = {
                "parent_service": parent_service,
                "child_service": child_service,
                "edge_id": edge_id,
                "parent": parent,
                "child": child,
            }
        raw_fact = json.dumps(
            raw_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        raw_hash = sha256(raw_fact).hexdigest()
        artifact_ref = self.artifact_store.put(
            self.registration.tenant_id, raw_fact,
        )
        try:
            if component_error:
                source = self.normalizer.normalize_component_error(
                    registration=self.registration,
                    binding=binding,
                    span=error_span,
                    service=error_service,
                    target_service=target_service,
                    edge_id=bound_edge_id,
                    received_at=checked_at,
                    raw_artifact_ref=artifact_ref,
                    raw_content_hash=raw_hash,
                    acl_subjects=acl_subjects,
                )
            else:
                source = self.normalizer.normalize(
                    registration=self.registration,
                    binding=binding,
                    parent=parent,
                    child=child,
                    parent_service=parent_service,
                    child_service=child_service,
                    edge_id=edge_id,
                    received_at=checked_at,
                    raw_artifact_ref=artifact_ref,
                    raw_content_hash=raw_hash,
                    acl_subjects=acl_subjects,
                )
        except ValueError as error:
            # A deterministic normalization rejection must not poison the
            # append-only stream forever.
            next_item_index = observation_index + 1
            if next_item_index < len(observations):
                await save_cursor(
                    accepted_line_start,
                    record_item_index=next_item_index,
                )
            else:
                await save_cursor(accepted_offset, record_item_index=0)
            health = await self._health(
                checked_at=checked_at,
                state=ConnectorHealthState.DEGRADED,
                reason_code=str(error),
                cursor="byte:{}".format(accepted_offset),
            )
            return ConnectorPollResult(
                accepted=False,
                reason_code=str(error),
                registration=self.registration,
                health=health,
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
            created_at=checked_at,
        )
        admitted = await self.repository.admit_source_event(source, dispatch)
        source = admitted.source_event
        # Persist the cursor only after the evidence and dispatch are durable.
        # A lost cursor ACK therefore retries an idempotent source event;
        # persisting it earlier could silently discard evidence.
        next_item_index = observation_index + 1
        if next_item_index < len(observations):
            cursor_offset = accepted_line_start
            await save_cursor(
                cursor_offset,
                record_item_index=next_item_index,
            )
        else:
            cursor_offset = accepted_offset
            next_item_index = 0
            await save_cursor(cursor_offset, record_item_index=0)
        lag = max(0, int((checked_at - source.observed_at).total_seconds()))
        state = (
            ConnectorHealthState.CONNECTED
            if source.freshness == FreshnessStatus.CURRENT
            else ConnectorHealthState.STALE
        )
        health = await self._health(
            checked_at=checked_at,
            state=state,
            reason_code=(
                None if state == ConnectorHealthState.CONNECTED
                else "freshness_sla_exceeded"
            ),
            last_event_observed_at=source.observed_at,
            cursor=(
                "byte:{}#item:{}".format(cursor_offset, next_item_index)
                if next_item_index
                else "byte:{}".format(cursor_offset)
            ),
            lag_seconds=lag,
        )
        realtime_telemetry.record(
            "OTEL", "poll", "success",
            lag_seconds=lag,
            correlation={
                "source_event_id": source.source_event_id,
                "case_id": source.case_id,
                "run_id": source.run_id,
            },
        )
        return ConnectorPollResult(
            registration=self.registration,
            health=health,
            receipt=admitted.receipt,
            source_event=source,
            dispatch=admitted.dispatch,
        )

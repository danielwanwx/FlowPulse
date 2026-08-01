"""Bounded V3 typed-series projection from immutable connector facts."""

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from .models import FreshnessStatus
from .realtime_models import (
    ConnectorProvider,
    FreshnessDeadline,
    FreshnessDeadlineState,
    MetricPointV3,
    MetricSeriesCollectionV3,
    MetricSeriesV3,
    MetricThresholdV3,
    RealtimeSourceEvent,
    RealtimeSignalStatus,
)


def build_metric_series_collection(
    *,
    case_id: str,
    sources: List[RealtimeSourceEvent],
    signal_revision: int,
    generated_at: datetime,
    expired_connectors: Optional[Dict[str, FreshnessDeadline]] = None,
) -> MetricSeriesCollectionV3:
    """Build the canonical browser wire contract without parsing display text."""
    expired_connectors = expired_connectors or {}
    grouped: Dict[Tuple[str, str, str], List[RealtimeSourceEvent]] = defaultdict(list)
    otel_grouped: Dict[Tuple[str, str], List[RealtimeSourceEvent]] = defaultdict(list)
    for source in sources:
        if source.case_id != case_id:
            continue
        component_id = source.component_ids[0]
        grouped[(source.metric_key, component_id, source.connector_id)].append(source)
        if (
            source.provider == ConnectorProvider.OTEL
            and source.event_kind.startswith("TRACE_")
        ):
            otel_grouped[(component_id, source.connector_id)].append(source)
    series = []

    def evidence_ref(item: RealtimeSourceEvent) -> str:
        return "evidence-realtime-" + item.normalization_hash[:24]

    def add_gap(points, deadline):
        if deadline is None or deadline.state != FreshnessDeadlineState.EXPIRED:
            return points
        gap_at = max(deadline.deadline, points[-1].timestamp + timedelta(microseconds=1))
        return points + [MetricPointV3(
            sequence=len(points) + 1,
            timestamp=gap_at,
            interval_start_at=gap_at,
            missing_reason="connector_stale",
            evidence_refs=[],
            freshness=FreshnessStatus.STALE,
        )]

    def append_series(
        *,
        series_id: str,
        metric_key: str,
        component_id: str,
        connector_id: str,
        label: str,
        unit: str,
        thresholds: MetricThresholdV3,
        points: List[MetricPointV3],
        deadline: Optional[FreshnessDeadline],
    ) -> None:
        if not points:
            return
        points = add_gap(points[-359:], deadline)
        freshness = (
            FreshnessStatus.STALE
            if deadline is not None and deadline.state == FreshnessDeadlineState.EXPIRED
            else points[-1].freshness
        )
        series.append(MetricSeriesV3(
            series_id=series_id,
            metric_key=metric_key,
            component_id=component_id,
            label=label,
            unit=unit,
            thresholds=thresholds,
            points=points,
            observed_window_start=points[0].timestamp,
            observed_window_end=points[-1].timestamp,
            freshness=freshness,
            source_connector_id=connector_id,
        ))

    for (metric_key, component_id, connector_id), records in sorted(grouped.items()):
        ordered = sorted(records, key=lambda item: (item.observed_at, item.source_event_id))
        unique_by_time = {}
        for item in ordered:
            unique_by_time[item.observed_at] = item
        ordered = list(unique_by_time.values())[-359:]
        points = [
            MetricPointV3(
                sequence=index,
                timestamp=item.observed_at,
                interval_start_at=(
                    item.sample_interval_start_at or item.observed_at
                ),
                value=item.numeric_value,
                evidence_refs=[evidence_ref(item)],
                freshness=item.freshness,
            )
            for index, item in enumerate(ordered, 1)
        ]
        deadline = expired_connectors.get(connector_id)
        latest = ordered[-1]
        append_series(
            series_id="{}:{}:{}".format(metric_key, component_id, connector_id),
            metric_key=metric_key,
            component_id=component_id,
            connector_id=connector_id,
            label=metric_key.replace(".", " ").replace("_", " ").title(),
            unit=latest.unit,
            thresholds=MetricThresholdV3(
                warning=latest.warning_threshold,
                critical=latest.critical_threshold,
            ),
            points=points,
            deadline=deadline,
        )

    # Derive incident-facing rates and health indicators only from the timing
    # and outcome of admitted trace facts. Group across raw OTel metric kinds so
    # a transition from failed client spans to healthy parent-child spans still
    # produces one continuous recovery series instead of duplicate cards.
    for (component_id, connector_id), records in sorted(otel_grouped.items()):
        ordered_by_identity = sorted(
            {item.source_event_id: item for item in records}.values(),
            key=lambda item: (item.observed_at, item.source_event_id),
        )
        unique_by_time = {}
        for item in ordered_by_identity:
            unique_by_time[item.observed_at] = item
        ordered = list(unique_by_time.values())[-359:]
        deadline = expired_connectors.get(connector_id)
        error_points = [
            MetricPointV3(
                sequence=index,
                timestamp=item.observed_at,
                interval_start_at=item.observed_at,
                value=(
                    1.0 if item.signal_status == RealtimeSignalStatus.CRITICAL else 0.0
                ),
                evidence_refs=[evidence_ref(item)],
                freshness=item.freshness,
            )
            for index, item in enumerate(ordered, 1)
        ]
        append_series(
            series_id="trace.error-indicator:{}:{}".format(component_id, connector_id),
            metric_key="trace.error_indicator",
            component_id=component_id,
            connector_id=connector_id,
            label="Request error indicator",
            unit="ratio",
            thresholds=MetricThresholdV3(warning=0.01, critical=0.05),
            points=error_points,
            deadline=deadline,
        )
        availability_points = [
            MetricPointV3(
                sequence=index,
                timestamp=item.observed_at,
                interval_start_at=item.observed_at,
                value=(
                    0.0 if item.signal_status == RealtimeSignalStatus.CRITICAL else 1.0
                ),
                evidence_refs=[evidence_ref(item)],
                freshness=item.freshness,
            )
            for index, item in enumerate(ordered, 1)
        ]
        append_series(
            series_id="dependency.availability:{}:{}".format(component_id, connector_id),
            metric_key="dependency.availability",
            component_id=component_id,
            connector_id=connector_id,
            label="Dependency availability",
            unit="ratio",
            thresholds=MetricThresholdV3(),
            points=availability_points,
            deadline=deadline,
        )
        rate_points = []
        for prior, current in zip(ordered, ordered[1:]):
            interval = (current.observed_at - prior.observed_at).total_seconds()
            if interval <= 0:
                continue
            rate_points.append(MetricPointV3(
                sequence=len(rate_points) + 1,
                timestamp=current.observed_at,
                interval_start_at=prior.observed_at,
                value=float(1.0 / interval),
                evidence_refs=[evidence_ref(prior), evidence_ref(current)],
                freshness=current.freshness,
            ))
        append_series(
            series_id="trace.request-rate:{}:{}".format(component_id, connector_id),
            metric_key="trace.request_rate",
            component_id=component_id,
            connector_id=connector_id,
            label="Observed trace arrival rate",
            unit="requests/s",
            thresholds=MetricThresholdV3(),
            points=rate_points,
            deadline=deadline,
        )
    return MetricSeriesCollectionV3(
        case_id=case_id,
        signal_revision=max(1, signal_revision),
        generated_at=generated_at,
        series=series[:16],
    )

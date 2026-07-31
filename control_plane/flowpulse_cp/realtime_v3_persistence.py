"""Focused V3 persistence for typed series, OTel cursors, and freshness.

The existing V1/V2 repository stays compatible; this mixin adds only
append-only V3 facts and restart-safe timer/cursor state.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from uuid import NAMESPACE_URL, uuid5

from .models import FreshnessStatus
from .realtime_models import (
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorRegistration,
    FreshnessDeadline,
    FreshnessDeadlineState,
    IncidentProjectionV2,
    MetricPointV3,
    MetricSeriesCollectionV3,
    RealtimeCommit,
    RealtimeEventType,
    RealtimeIncidentEvent,
    RealtimeSignal,
    RealtimeSignalStatus,
    RealtimeSourceEvent,
    SpoolCursor,
)
from .realtime_observability import realtime_telemetry
from .realtime_series import build_metric_series_collection
from .workspace_models import IncidentEvent, IncidentProjection


def _decode(value):
    return json.loads(value) if isinstance(value, str) else value


def _payload(value) -> str:
    return value.json(sort_keys=True, exclude_none=False, separators=(",", ":"))


def _clock_after_connector_expiry(
    projection: IncidentProjectionV2,
    health_items: List[ConnectorHealth],
    *,
    now: datetime,
    expired_at: datetime,
):
    """One stale stream must not make fresh sibling OTel streams stale."""
    live_until = [
        item.fresh_until for item in health_items
        if item.state == ConnectorHealthState.CONNECTED
        and item.fresh_until is not None
        and item.fresh_until > now
    ]
    if live_until:
        return projection.incident_clock.copy(update={
            "as_of": now,
            "freshness": FreshnessStatus.CURRENT,
            "fresh_until": max(live_until),
        })
    return projection.incident_clock.copy(update={
        "as_of": now,
        "freshness": FreshnessStatus.STALE,
        "fresh_until": expired_at,
    })


async def persist_realtime_v3_commit_artifacts(connection, commit: RealtimeCommit) -> None:
    """Persist one typed point and re-arm freshness in the commit transaction."""
    source = commit.source_event
    series_id = "{}:{}:{}".format(
        source.metric_key, source.component_ids[0], source.connector_id,
    )
    point_sequence = await connection.fetchval(
        """SELECT coalesce(max(point_sequence), 0) + 1
           FROM realtime_metric_points
           WHERE tenant_id=$1 AND case_id=$2 AND series_id=$3""",
        source.tenant_id, source.case_id, series_id,
    )
    point = MetricPointV3(
        sequence=point_sequence,
        timestamp=source.observed_at,
        value=source.numeric_value,
        evidence_refs=[commit.evidence.evidence_id],
        freshness=source.freshness,
    )
    await connection.execute(
        """INSERT INTO realtime_metric_points
           (tenant_id, case_id, series_id, source_event_id, point_sequence,
            observed_at, metric_key, component_id, unit, payload, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)""",
        source.tenant_id, source.case_id, series_id, source.source_event_id,
        point_sequence, source.observed_at, source.metric_key,
        source.component_ids[0], source.unit, _payload(point),
        commit.events[-1].occurred_at,
    )
    await connection.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        "freshness-deadline:{}:{}:{}".format(
            source.tenant_id, source.case_id, source.connector_id,
        ),
    )
    deadline_revision = await connection.fetchval(
        """SELECT coalesce(max(deadline_revision), 0) + 1
           FROM realtime_freshness_deadlines
           WHERE tenant_id=$1 AND case_id=$2 AND connector_id=$3""",
        source.tenant_id, source.case_id, source.connector_id,
    )
    deadline = FreshnessDeadline(
        tenant_id=source.tenant_id,
        case_id=source.case_id,
        connector_id=source.connector_id,
        deadline_revision=deadline_revision,
        state=FreshnessDeadlineState.ARMED,
        deadline=commit.signal.fresh_until,
        source_event_id=source.source_event_id,
        recorded_at=commit.events[-1].occurred_at,
    )
    await connection.execute(
        """INSERT INTO realtime_freshness_deadlines
           (tenant_id, case_id, connector_id, deadline_revision, state,
            deadline, source_event_id, payload, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)""",
        deadline.tenant_id, deadline.case_id, deadline.connector_id,
        deadline.deadline_revision, deadline.state.value, deadline.deadline,
        deadline.source_event_id, _payload(deadline), deadline.recorded_at,
    )


class RealtimeV3InMemoryMixin:
    """Deterministic seam mirroring the append-only Postgres V3 methods."""

    async def latest_spool_cursor(
        self, tenant_id: str, connector_id: str, stream_id: str,
    ) -> Optional[SpoolCursor]:
        records = self.spool_cursor_records[(tenant_id, connector_id, stream_id)]
        return records[-1] if records else None

    async def save_spool_cursor(self, cursor: SpoolCursor) -> SpoolCursor:
        if (cursor.tenant_id, cursor.connector_id) not in self.registrations:
            raise ValueError("otel_spool_cursor_connector_unknown")
        records = self.spool_cursor_records[
            (cursor.tenant_id, cursor.connector_id, cursor.stream_id)
        ]
        if cursor.cursor_revision != len(records) + 1:
            prior = next(
                (item for item in records if item.cursor_revision == cursor.cursor_revision),
                None,
            )
            if prior == cursor:
                return prior
            raise ValueError("otel_spool_cursor_revision_not_contiguous")
        records.append(cursor)
        return cursor


    async def arm_freshness_deadline(
        self,
        *,
        tenant_id: str,
        case_id: str,
        connector_id: str,
        deadline: datetime,
        source_event_id: str,
    ) -> FreshnessDeadline:
        key = (tenant_id, case_id, connector_id)
        records = self.freshness_deadline_records[key]
        if records and (
            records[-1].state == FreshnessDeadlineState.ARMED
            and records[-1].deadline == deadline
            and records[-1].source_event_id == source_event_id
        ):
            return records[-1]
        record = FreshnessDeadline(
            tenant_id=tenant_id,
            case_id=case_id,
            connector_id=connector_id,
            deadline_revision=len(records) + 1,
            state=FreshnessDeadlineState.ARMED,
            deadline=deadline,
            source_event_id=source_event_id,
            recorded_at=datetime.now(timezone.utc),
        )
        records.append(record)
        return record

    async def recover_freshness_deadline(
        self,
        *,
        tenant_id: str,
        case_id: str,
        connector_id: str,
        observed_at: datetime,
        source_event_id: str,
    ) -> FreshnessDeadline:
        registration = self.registrations.get((tenant_id, connector_id))
        if registration is None:
            raise ValueError("freshness_deadline_connector_unknown")
        return await self.arm_freshness_deadline(
            tenant_id=tenant_id,
            case_id=case_id,
            connector_id=connector_id,
            deadline=observed_at + timedelta(
                seconds=registration.freshness_sla_seconds,
            ),
            source_event_id=source_event_id,
        )

    async def latest_freshness_deadline(
        self, tenant_id: str, case_id: str, connector_id: str,
    ) -> Optional[FreshnessDeadline]:
        records = self.freshness_deadline_records[
            (tenant_id, case_id, connector_id)
        ]
        return records[-1] if records else None

    async def expire_freshness_deadlines(
        self,
        now: datetime,
        tenant_id: Optional[str] = None,
        *,
        case_id: Optional[str] = None,
        connector_id: Optional[str] = None,
        expected_deadline_revision: Optional[int] = None,
        expected_source_event_id: Optional[str] = None,
    ) -> List[RealtimeIncidentEvent]:
        expired_events = []
        for key, records in list(self.freshness_deadline_records.items()):
            if tenant_id is not None and key[0] != tenant_id:
                continue
            if case_id is not None and key[1] != case_id:
                continue
            if connector_id is not None and key[2] != connector_id:
                continue
            current = records[-1]
            if (
                expected_deadline_revision is not None
                and current.deadline_revision != expected_deadline_revision
            ):
                continue
            if (
                expected_source_event_id is not None
                and current.source_event_id != expected_source_event_id
            ):
                continue
            if current.state != FreshnessDeadlineState.ARMED or now < current.deadline:
                continue
            expired = current.copy(update={
                "deadline_revision": current.deadline_revision + 1,
                "state": FreshnessDeadlineState.EXPIRED,
                "recorded_at": now,
            })
            records.append(expired)
            record_tenant_id, case_id, connector_id = key
            projection_records = self.projections.get((record_tenant_id, case_id), [])
            if not projection_records:
                continue
            projection = projection_records[-1]
            registration = self.registrations[(record_tenant_id, connector_id)]
            prior_health_records = self.health_records[(record_tenant_id, connector_id)]
            prior_health = prior_health_records[-1] if prior_health_records else None
            health = ConnectorHealth(
                connector_id=connector_id,
                tenant_id=record_tenant_id,
                provider=registration.provider,
                state=ConnectorHealthState.STALE,
                checked_at=now,
                last_success_at=(prior_health.last_success_at if prior_health else None),
                last_event_observed_at=(
                    prior_health.last_event_observed_at if prior_health else None
                ),
                fresh_until=current.deadline,
                cursor=(prior_health.cursor if prior_health else None),
                consecutive_failures=0,
                lag_seconds=max(0, int((now - current.deadline).total_seconds())),
                reason_code="freshness_deadline_expired",
                adapter_version=registration.adapter_version,
                health_revision=len(prior_health_records) + 1,
                truth_label=registration.truth_label,
            )
            await self.append_connector_health(health)
            existing = next((
                item for item in reversed(projection.realtime_signals)
                if item.source_event_id == current.source_event_id
            ), None)
            next_sequence = projection.sequence + 1
            signal = (
                existing.copy(update={
                    "freshness": FreshnessStatus.STALE,
                    "connector_state": ConnectorHealthState.STALE,
                    "sequence": next_sequence,
                })
                if existing is not None else None
            )
            event = RealtimeIncidentEvent(
                **{
                    field: getattr(projection, field)
                    for field in (
                        "tenant_id", "incident_id", "run_id",
                        "topology_revision", "case_id", "case_revision",
                        "workflow_id", "workflow_run_id", "created_at",
                    )
                },
                source_event_id=current.source_event_id,
                projection_revision=projection.projection_revision + 1,
                sequence=next_sequence,
                event_type=(
                    RealtimeEventType.SIGNAL_STALE
                    if signal is not None
                    else RealtimeEventType.CONNECTOR_HEALTH_CHANGED
                ),
                occurred_at=now,
                signal=signal,
                health=(health if signal is None else None),
            )
            self.events[(record_tenant_id, case_id)].append(event)
            expired_events.append(event)
            signals = [
                signal if (
                    signal is not None and item.signal_id == existing.signal_id
                ) else item
                for item in projection.realtime_signals
            ]
            health_items = [
                item for item in projection.connector_health
                if item.connector_id != connector_id
            ] + [health]
            successor = projection.copy(update={
                "projection_revision": projection.projection_revision + 1,
                "sequence": next_sequence,
                "generated_at": now,
                "connector_revision": max(
                    projection.connector_revision, health.health_revision,
                ),
                "connector_health": health_items,
                "realtime_signals": signals,
                "active_graph_pulses": [
                    item for item in projection.active_graph_pulses
                    if item.expires_at > now
                ],
                "incident_clock": _clock_after_connector_expiry(
                    projection, health_items,
                    now=now, expired_at=current.deadline,
                ),
            })
            projection_records.append(successor)
        return expired_events


    async def realtime_series(
        self, tenant_id: str, case_id: str,
    ) -> MetricSeriesCollectionV3:
        committed_source_ids = {
            item.source_event.source_event_id
            for (record_tenant, _), item in self.commits.items()
            if record_tenant == tenant_id and item.source_event.case_id == case_id
        }
        # Tests and spool ingestion may inspect the typed facts before Temporal
        # commits them; production callers only see committed transitions when
        # at least one commit exists for the case.
        candidates = [
            item for (record_tenant, _), item in self.source_events.items()
            if record_tenant == tenant_id
            and item.case_id == case_id
            and (not committed_source_ids or item.source_event_id in committed_source_ids)
        ]
        deadlines = {
            connector_id: records[-1]
            for (record_tenant, record_case, connector_id), records
            in self.freshness_deadline_records.items()
            if record_tenant == tenant_id and record_case == case_id and records
        }
        projection_records = self.projections.get((tenant_id, case_id), [])
        signal_revision = (
            projection_records[-1].source_revision
            if projection_records else len(candidates) or 1
        )
        return build_metric_series_collection(
            case_id=case_id,
            sources=candidates,
            signal_revision=signal_revision,
            generated_at=datetime.now(timezone.utc),
            expired_connectors=deadlines,
        )





class RealtimeV3PostgresMixin:
    async def latest_spool_cursor(
        self, tenant_id: str, connector_id: str, stream_id: str,
    ) -> Optional[SpoolCursor]:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM otel_spool_cursors
                   WHERE tenant_id=$1 AND connector_id=$2 AND stream_id=$3
                   ORDER BY cursor_revision DESC LIMIT 1""",
                tenant_id, connector_id, stream_id,
            )
            return SpoolCursor.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    async def save_spool_cursor(self, cursor: SpoolCursor) -> SpoolCursor:
        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "otel-spool-cursor:{}:{}:{}".format(
                    cursor.tenant_id, cursor.connector_id, cursor.stream_id,
                ),
            )
            registration = await connection.fetchval(
                """SELECT EXISTS(SELECT 1 FROM connector_registrations
                     WHERE tenant_id=$1 AND connector_id=$2)""",
                cursor.tenant_id, cursor.connector_id,
            )
            if not registration:
                raise ValueError("otel_spool_cursor_connector_unknown")
            row = await connection.fetchrow(
                """SELECT payload FROM otel_spool_cursors
                   WHERE tenant_id=$1 AND connector_id=$2 AND stream_id=$3
                     AND cursor_revision=$4""",
                cursor.tenant_id, cursor.connector_id, cursor.stream_id,
                cursor.cursor_revision,
            )
            if row is not None:
                prior = SpoolCursor.parse_obj(_decode(row["payload"]))
                if prior != cursor:
                    raise ValueError("otel_spool_cursor_immutable")
                return prior
            latest = await connection.fetchval(
                """SELECT max(cursor_revision) FROM otel_spool_cursors
                   WHERE tenant_id=$1 AND connector_id=$2 AND stream_id=$3""",
                cursor.tenant_id, cursor.connector_id, cursor.stream_id,
            )
            if cursor.cursor_revision != (latest or 0) + 1:
                raise ValueError("otel_spool_cursor_revision_not_contiguous")
            await connection.execute(
                """INSERT INTO otel_spool_cursors
                   (tenant_id, connector_id, stream_id, cursor_revision,
                    byte_offset, line_number, file_identity, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)""",
                cursor.tenant_id, cursor.connector_id, cursor.stream_id,
                cursor.cursor_revision, cursor.byte_offset, cursor.line_number,
                cursor.file_identity, _payload(cursor), cursor.updated_at,
            )
            return cursor
        return await self._tenant(cursor.tenant_id, operation)

    async def arm_freshness_deadline(
        self,
        *,
        tenant_id: str,
        case_id: str,
        connector_id: str,
        deadline: datetime,
        source_event_id: str,
    ) -> FreshnessDeadline:
        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "freshness-deadline:{}:{}:{}".format(
                    tenant_id, case_id, connector_id,
                ),
            )
            source_exists = await connection.fetchval(
                """SELECT EXISTS(SELECT 1 FROM connector_source_events
                     WHERE tenant_id=$1 AND case_id=$2 AND connector_id=$3
                       AND source_event_id=$4)""",
                tenant_id, case_id, connector_id, source_event_id,
            )
            if not source_exists:
                raise ValueError("freshness_deadline_source_unknown")
            row = await connection.fetchrow(
                """SELECT payload FROM realtime_freshness_deadlines
                   WHERE tenant_id=$1 AND case_id=$2 AND connector_id=$3
                   ORDER BY deadline_revision DESC LIMIT 1""",
                tenant_id, case_id, connector_id,
            )
            prior = (
                FreshnessDeadline.parse_obj(_decode(row["payload"])) if row else None
            )
            if prior is not None and (
                prior.state == FreshnessDeadlineState.ARMED
                and prior.deadline == deadline
                and prior.source_event_id == source_event_id
            ):
                return prior
            record = FreshnessDeadline(
                tenant_id=tenant_id,
                case_id=case_id,
                connector_id=connector_id,
                deadline_revision=(prior.deadline_revision + 1 if prior else 1),
                state=FreshnessDeadlineState.ARMED,
                deadline=deadline,
                source_event_id=source_event_id,
                recorded_at=datetime.now(timezone.utc),
            )
            await connection.execute(
                """INSERT INTO realtime_freshness_deadlines
                   (tenant_id, case_id, connector_id, deadline_revision, state,
                    deadline, source_event_id, payload, recorded_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)""",
                tenant_id, case_id, connector_id, record.deadline_revision,
                record.state.value, record.deadline, record.source_event_id,
                _payload(record), record.recorded_at,
            )
            return record
        return await self._tenant(tenant_id, operation)

    async def recover_freshness_deadline(
        self,
        *,
        tenant_id: str,
        case_id: str,
        connector_id: str,
        observed_at: datetime,
        source_event_id: str,
    ) -> FreshnessDeadline:
        async def registration_operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM connector_registrations
                   WHERE tenant_id=$1 AND connector_id=$2""",
                tenant_id, connector_id,
            )
            if row is None:
                raise ValueError("freshness_deadline_connector_unknown")
            return ConnectorRegistration.parse_obj(_decode(row["payload"]))
        registration = await self._tenant(tenant_id, registration_operation)
        return await self.arm_freshness_deadline(
            tenant_id=tenant_id,
            case_id=case_id,
            connector_id=connector_id,
            deadline=observed_at + timedelta(
                seconds=registration.freshness_sla_seconds,
            ),
            source_event_id=source_event_id,
        )

    async def latest_freshness_deadline(
        self, tenant_id: str, case_id: str, connector_id: str,
    ) -> Optional[FreshnessDeadline]:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM realtime_freshness_deadlines
                   WHERE tenant_id=$1 AND case_id=$2 AND connector_id=$3
                   ORDER BY deadline_revision DESC LIMIT 1""",
                tenant_id, case_id, connector_id,
            )
            return (
                FreshnessDeadline.parse_obj(_decode(row["payload"])) if row else None
            )
        return await self._tenant(tenant_id, operation)

    async def realtime_series(
        self, tenant_id: str, case_id: str,
    ) -> MetricSeriesCollectionV3:
        async def operation(connection):
            rows = await connection.fetch(
                """SELECT s.payload
                   FROM realtime_metric_points p
                   JOIN connector_source_events s
                     ON s.tenant_id=p.tenant_id
                    AND s.case_id=p.case_id
                    AND s.source_event_id=p.source_event_id
                   WHERE p.tenant_id=$1 AND p.case_id=$2
                   ORDER BY p.observed_at, p.source_event_id""",
                tenant_id, case_id,
            )
            deadline_rows = await connection.fetch(
                """SELECT DISTINCT ON (connector_id) connector_id, payload
                   FROM realtime_freshness_deadlines
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY connector_id, deadline_revision DESC""",
                tenant_id, case_id,
            )
            projection = await connection.fetchrow(
                """SELECT source_revision FROM incident_realtime_projections
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY projection_revision DESC LIMIT 1""",
                tenant_id, case_id,
            )
            return build_metric_series_collection(
                case_id=case_id,
                sources=[
                    RealtimeSourceEvent.parse_obj(_decode(row["payload"]))
                    for row in rows
                ],
                signal_revision=(projection["source_revision"] if projection else 1),
                generated_at=datetime.now(timezone.utc),
                expired_connectors={
                    row["connector_id"]: FreshnessDeadline.parse_obj(
                        _decode(row["payload"]),
                    )
                    for row in deadline_rows
                },
            )
        return await self._tenant(tenant_id, operation)

    async def expire_freshness_deadlines(
        self,
        now: datetime,
        tenant_id: Optional[str] = None,
        *,
        case_id: Optional[str] = None,
        connector_id: Optional[str] = None,
        expected_deadline_revision: Optional[int] = None,
        expected_source_event_id: Optional[str] = None,
    ) -> List[RealtimeIncidentEvent]:
        if not tenant_id:
            raise ValueError("freshness_deadline_tenant_required")

        async def operation(connection):
            rows = await connection.fetch(
                """SELECT DISTINCT ON (case_id, connector_id) payload
                   FROM realtime_freshness_deadlines
                   WHERE tenant_id=$1
                   ORDER BY case_id, connector_id, deadline_revision DESC""",
                tenant_id,
            )
            events = []
            for row in rows:
                current = FreshnessDeadline.parse_obj(_decode(row["payload"]))
                if case_id is not None and current.case_id != case_id:
                    continue
                if connector_id is not None and current.connector_id != connector_id:
                    continue
                if (
                    expected_deadline_revision is not None
                    and current.deadline_revision != expected_deadline_revision
                ):
                    continue
                if (
                    expected_source_event_id is not None
                    and current.source_event_id != expected_source_event_id
                ):
                    continue
                if current.state != FreshnessDeadlineState.ARMED or now < current.deadline:
                    continue
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    "realtime-projection:{}:{}".format(tenant_id, current.case_id),
                )
                latest_deadline_row = await connection.fetchrow(
                    """SELECT payload FROM realtime_freshness_deadlines
                       WHERE tenant_id=$1 AND case_id=$2 AND connector_id=$3
                       ORDER BY deadline_revision DESC LIMIT 1""",
                    tenant_id, current.case_id, current.connector_id,
                )
                current = FreshnessDeadline.parse_obj(
                    _decode(latest_deadline_row["payload"]),
                )
                if (
                    expected_deadline_revision is not None
                    and current.deadline_revision != expected_deadline_revision
                ):
                    continue
                if (
                    expected_source_event_id is not None
                    and current.source_event_id != expected_source_event_id
                ):
                    continue
                if current.state != FreshnessDeadlineState.ARMED or now < current.deadline:
                    continue
                expired = current.copy(update={
                    "deadline_revision": current.deadline_revision + 1,
                    "state": FreshnessDeadlineState.EXPIRED,
                    "recorded_at": now,
                })
                await connection.execute(
                    """INSERT INTO realtime_freshness_deadlines
                       (tenant_id, case_id, connector_id, deadline_revision,
                        state, deadline, source_event_id, payload, recorded_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)""",
                    tenant_id, current.case_id, current.connector_id,
                    expired.deadline_revision, expired.state.value,
                    expired.deadline, expired.source_event_id,
                    _payload(expired), expired.recorded_at,
                )
                projection_row = await connection.fetchrow(
                    """SELECT payload FROM incident_realtime_projections
                       WHERE tenant_id=$1 AND case_id=$2
                       ORDER BY projection_revision DESC LIMIT 1""",
                    tenant_id, current.case_id,
                )
                if projection_row is None:
                    continue
                projection = IncidentProjectionV2.parse_obj(
                    _decode(projection_row["payload"]),
                )
                signal = next((
                    item for item in projection.realtime_signals
                    if item.source_event_id == current.source_event_id
                ), None)
                registration_row = await connection.fetchrow(
                    """SELECT payload FROM connector_registrations
                       WHERE tenant_id=$1 AND connector_id=$2""",
                    tenant_id, current.connector_id,
                )
                registration = ConnectorRegistration.parse_obj(
                    _decode(registration_row["payload"]),
                )
                health_row = await connection.fetchrow(
                    """SELECT payload FROM connector_health_snapshots
                       WHERE tenant_id=$1 AND connector_id=$2
                       ORDER BY health_revision DESC LIMIT 1""",
                    tenant_id, current.connector_id,
                )
                prior_health = (
                    ConnectorHealth.parse_obj(_decode(health_row["payload"]))
                    if health_row else None
                )
                health = ConnectorHealth(
                    connector_id=current.connector_id,
                    tenant_id=tenant_id,
                    provider=registration.provider,
                    state=ConnectorHealthState.STALE,
                    checked_at=now,
                    last_success_at=(prior_health.last_success_at if prior_health else None),
                    last_event_observed_at=(
                        prior_health.last_event_observed_at if prior_health else None
                    ),
                    fresh_until=current.deadline,
                    cursor=(prior_health.cursor if prior_health else None),
                    consecutive_failures=0,
                    lag_seconds=max(0, int((now - current.deadline).total_seconds())),
                    reason_code="freshness_deadline_expired",
                    adapter_version=registration.adapter_version,
                    health_revision=(prior_health.health_revision + 1 if prior_health else 1),
                    truth_label=registration.truth_label,
                )
                await connection.execute(
                    """INSERT INTO connector_health_snapshots
                       (tenant_id, connector_id, health_revision, state,
                        checked_at, fresh_until, payload)
                       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)""",
                    tenant_id, current.connector_id, health.health_revision,
                    health.state.value, health.checked_at, health.fresh_until,
                    _payload(health),
                )
                next_sequence = projection.sequence + 1
                stale_signal = (
                    signal.copy(update={
                        "freshness": FreshnessStatus.STALE,
                        "connector_state": ConnectorHealthState.STALE,
                        "sequence": next_sequence,
                    })
                    if signal is not None else None
                )
                health_items = [
                    item for item in projection.connector_health
                    if item.connector_id != current.connector_id
                ] + [health]
                successor = projection.copy(update={
                    "projection_revision": projection.projection_revision + 1,
                    "sequence": next_sequence,
                    "generated_at": now,
                    "connector_revision": max(
                        projection.connector_revision, health.health_revision,
                    ),
                    "connector_health": health_items,
                    "realtime_signals": [
                        stale_signal if (
                            stale_signal is not None
                            and item.signal_id == signal.signal_id
                        ) else item
                        for item in projection.realtime_signals
                    ],
                    "active_graph_pulses": [
                        item for item in projection.active_graph_pulses
                        if item.expires_at > now
                    ],
                    "incident_clock": _clock_after_connector_expiry(
                        projection, health_items,
                        now=now, expired_at=current.deadline,
                    ),
                })
                event = RealtimeIncidentEvent(
                    **{
                        field: getattr(successor, field)
                        for field in (
                            "tenant_id", "incident_id", "run_id",
                            "topology_revision", "case_id", "case_revision",
                            "workflow_id", "workflow_run_id", "created_at",
                        )
                    },
                    source_event_id=current.source_event_id,
                    projection_revision=successor.projection_revision,
                    sequence=successor.sequence,
                    event_type=(
                        RealtimeEventType.SIGNAL_STALE
                        if stale_signal is not None
                        else RealtimeEventType.CONNECTOR_HEALTH_CHANGED
                    ),
                    occurred_at=now,
                    signal=stale_signal,
                    health=(health if stale_signal is None else None),
                )
                workspace_row = await connection.fetchrow(
                    """SELECT payload FROM incident_projections
                       WHERE tenant_id=$1 AND case_id=$2
                       ORDER BY projection_revision DESC LIMIT 1""",
                    tenant_id, current.case_id,
                )
                if workspace_row is None:
                    raise ValueError(
                        "realtime_freshness_workspace_projection_missing",
                    )
                prior_workspace = IncidentProjection.parse_obj(
                    _decode(workspace_row["payload"]),
                )
                if (
                    prior_workspace.projection_revision
                    != projection.projection_revision
                    or prior_workspace.sequence != projection.sequence
                ):
                    raise ValueError(
                        "realtime_freshness_workspace_projection_diverged",
                    )
                workspace_successor = IncidentProjection.parse_obj({
                    field: getattr(successor, field)
                    for field in IncidentProjection.__fields__
                    if field != "schema_version"
                })
                workspace_event = IncidentEvent(
                    **{
                        field: getattr(workspace_successor, field)
                        for field in (
                            "tenant_id", "incident_id", "run_id",
                            "topology_revision", "case_id", "case_revision",
                            "workflow_id", "workflow_run_id", "created_at",
                        )
                    },
                    projection_revision=workspace_successor.projection_revision,
                    sequence=workspace_successor.sequence,
                    event_type="workspace.realtime.freshness.expired",
                    occurred_at=now,
                    payload={
                        "connector_id": current.connector_id,
                        "source_event_id": current.source_event_id,
                        "deadline_revision": str(current.deadline_revision),
                    },
                    evidence_refs=(
                        list(stale_signal.evidence_refs)
                        if stale_signal is not None else []
                    ),
                )
                await connection.execute(
                    """INSERT INTO incident_projections
                       (tenant_id, incident_id, run_id, topology_revision,
                        case_id, case_revision, workflow_id, workflow_run_id,
                        projection_revision, sequence, payload, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)""",
                    workspace_successor.tenant_id,
                    workspace_successor.incident_id,
                    workspace_successor.run_id,
                    workspace_successor.topology_revision,
                    workspace_successor.case_id,
                    workspace_successor.case_revision,
                    workspace_successor.workflow_id,
                    workspace_successor.workflow_run_id,
                    workspace_successor.projection_revision,
                    workspace_successor.sequence,
                    _payload(workspace_successor),
                    now,
                )
                await connection.execute(
                    """INSERT INTO incident_projection_events
                       (event_id, tenant_id, incident_id, run_id,
                        topology_revision, case_id, case_revision, workflow_id,
                        workflow_run_id, projection_revision, sequence,
                        event_type, payload, occurred_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                    uuid5(NAMESPACE_URL, "v1:{}:{}:{}".format(
                        workspace_event.tenant_id,
                        workspace_event.run_id,
                        workspace_event.sequence,
                    )),
                    workspace_event.tenant_id,
                    workspace_event.incident_id,
                    workspace_event.run_id,
                    workspace_event.topology_revision,
                    workspace_event.case_id,
                    workspace_event.case_revision,
                    workspace_event.workflow_id,
                    workspace_event.workflow_run_id,
                    workspace_event.projection_revision,
                    workspace_event.sequence,
                    workspace_event.event_type,
                    _payload(workspace_event),
                    now,
                )
                await connection.execute(
                    """INSERT INTO incident_realtime_projections
                       (tenant_id, incident_id, run_id, topology_revision,
                        case_id, case_revision, workflow_id, workflow_run_id,
                        projection_revision, sequence, source_revision,
                        connector_revision, payload, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                    successor.tenant_id, successor.incident_id, successor.run_id,
                    successor.topology_revision, successor.case_id,
                    successor.case_revision, successor.workflow_id,
                    successor.workflow_run_id, successor.projection_revision,
                    successor.sequence, successor.source_revision,
                    successor.connector_revision, _payload(successor), now,
                )
                await connection.execute(
                    """INSERT INTO incident_realtime_events
                       (event_id, tenant_id, incident_id, run_id,
                        topology_revision, case_id, case_revision, workflow_id,
                        workflow_run_id, source_event_id, projection_revision,
                        sequence, event_type, payload, occurred_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                    uuid5(NAMESPACE_URL, "{}:{}:{}".format(
                        event.tenant_id, event.run_id, event.sequence,
                    )),
                    event.tenant_id, event.incident_id, event.run_id,
                    event.topology_revision, event.case_id, event.case_revision,
                    event.workflow_id, event.workflow_run_id,
                    event.source_event_id, event.projection_revision,
                    event.sequence, event.event_type.value, _payload(event), now,
                )
                realtime_telemetry.record(
                    registration.provider.value,
                    "freshness",
                    "stale",
                    lag_seconds=health.lag_seconds,
                    correlation={
                        "case_id": event.case_id,
                        "run_id": event.run_id,
                        "source_event_id": event.source_event_id,
                    },
                )
                events.append(event)
            return events
        return await self._tenant(tenant_id, operation)

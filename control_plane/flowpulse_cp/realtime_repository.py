"""Append-only Phase 1 connector facts and Temporal-owned V2 projections."""

import copy
import json
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
from typing import Dict, List, Optional, Tuple
from uuid import NAMESPACE_URL, uuid5

from .models import EvidenceEnvelope
from .policy import validate_evidence_admission
from .realtime_models import (
    ConnectorDeliveryReceipt,
    ConnectorDeliveryStatus,
    ConnectorDispatch,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorRegistration,
    ExternalIdentityBinding,
    IncidentProjectionV2,
    RealtimeCommit,
    RealtimeIncidentEvent,
    RealtimeNotification,
    RealtimeSourceEvent,
    RealtimeSummary,
)
from .workspace_models import IncidentProjection


def _payload(value) -> str:
    return value.json(sort_keys=True, exclude_none=False, separators=(",", ":"))


def _decode(value):
    if isinstance(value, str):
        return json.loads(value)
    return value


def _delivery_key(event: RealtimeSourceEvent) -> Tuple[str, str, str]:
    return (event.tenant_id, event.connector_id, event.provider_event_id)


def _same_normalized_delivery(
    prior: RealtimeSourceEvent, candidate: RealtimeSourceEvent,
) -> bool:
    return prior.dict(exclude={"received_at"}) == candidate.dict(
        exclude={"received_at"},
    )


def _same_dispatch_retry(
    prior: ConnectorDispatch, candidate: ConnectorDispatch,
) -> bool:
    return prior.dict(exclude={"created_at"}) == candidate.dict(
        exclude={"created_at"},
    )


def _binding_matches_event(binding: ExternalIdentityBinding, event: RealtimeSourceEvent) -> bool:
    return (
        binding.tenant_id == event.tenant_id
        and binding.connector_id == event.connector_id
        and binding.provider == event.provider
        and binding.binding_id == event.binding_id
        and binding.binding_revision == event.binding_revision
        and binding.case_id == event.case_id
        and binding.incident_id == event.incident_id
        and binding.run_id == event.run_id
        and binding.topology_revision == event.topology_revision
        and set(event.component_ids).issubset(binding.component_ids)
        and set(event.edge_ids).issubset(binding.edge_ids)
        and binding.valid_from <= event.effective_at
        and (binding.valid_to is None or event.effective_at < binding.valid_to)
    )


def _validate_source_event_integrity(event: RealtimeSourceEvent) -> None:
    if event.normalization_hash != event.canonical_hash():
        raise ValueError("realtime_source_event_normalization_hash_mismatch")
    if event.raw_artifact_ref != "{}/sha256/{}".format(
        event.tenant_id, event.raw_content_hash,
    ):
        raise ValueError("realtime_source_event_artifact_binding_mismatch")
    if event.observed_at > event.received_at:
        raise ValueError("realtime_source_event_observed_after_received")


def _validate_realtime_commit_artifacts(commit: RealtimeCommit) -> None:
    source = commit.source_event
    evidence = commit.evidence
    expected_evidence_id = "evidence-realtime-" + source.normalization_hash[:24]
    validate_evidence_admission(evidence, source.acl_subjects[0])
    if (
        evidence.evidence_id != expected_evidence_id
        or evidence.tenant_id != source.tenant_id
        or evidence.case_id != source.case_id
        or evidence.case_revision != commit.prior_projection.case_revision
        or evidence.acl_subjects != source.acl_subjects
        or evidence.content_hash != source.raw_content_hash
        or evidence.observed_at != source.observed_at
        or evidence.effective_at != source.effective_at
        or evidence.proof_scope.value != source.proof_scope.value
        or evidence.freshness.value != source.freshness.value
        or evidence.authority.value != source.authority.value
        or evidence.raw_artifact_key != source.raw_artifact_ref
    ):
        raise ValueError("realtime_transition_evidence_lineage_mismatch")
    event = commit.event
    if (
        event.source_event_id != source.source_event_id
        or event.signal.source_event_id != source.source_event_id
        or event.pulse.source_event_id != source.source_event_id
        or event.citation.source_event_id != source.source_event_id
        or event.citation.evidence_id != evidence.evidence_id
        or event.signal.evidence_refs != [evidence.evidence_id]
        or event.pulse.evidence_refs != [evidence.evidence_id]
        or event.activity.source_event_ids != [source.source_event_id]
        or event.activity.evidence_refs != [evidence.evidence_id]
        or event.activity.citation_refs != [event.citation.citation_id]
        or event.activity.external_write_performed
        or event.activity.truth_label != source.truth_label
    ):
        raise ValueError("realtime_transition_signal_activity_lineage_mismatch")
    expected = commit.prior_projection.copy(update={
        "projection_revision": commit.prior_projection.projection_revision + 1,
        "sequence": event.sequence,
        "generated_at": commit.health.checked_at,
        "evidence_revision": commit.prior_projection.evidence_revision + 1,
        "evidence_refs": list(dict.fromkeys(
            commit.prior_projection.evidence_refs + [evidence.evidence_id],
        )),
    })
    if commit.v1_projection != expected:
        raise ValueError("realtime_transition_lifecycle_successor_invalid")


def _notification_id(event: RealtimeIncidentEvent) -> str:
    return "{}|{}|{:010d}".format(
        event.occurred_at.isoformat(), event.run_id, event.sequence,
    )


def _health_at(health: ConnectorHealth, now: datetime) -> ConnectorHealth:
    if (
        health.state == ConnectorHealthState.CONNECTED
        and health.fresh_until is not None
        and now > health.fresh_until
    ):
        return health.copy(update={
            "state": ConnectorHealthState.STALE,
            "reason_code": "freshness_sla_exceeded",
            "lag_seconds": max(
                health.lag_seconds,
                int((now - health.fresh_until).total_seconds()),
            ),
        })
    return health


def _projection_freshness_at(
    projection: IncidentProjectionV2, now: datetime,
) -> IncidentProjectionV2:
    return projection.copy(update={
        "connector_health": [
            _health_at(item, now) for item in projection.connector_health
        ],
        "realtime_signals": [
            item.copy(update={"freshness": "STALE"})
            if now > item.fresh_until else item
            for item in projection.realtime_signals
        ],
    })


class InMemoryRealtimeRepository:
    """Deterministic fact-plane seam with the same immutable transition rules."""

    def __init__(self) -> None:
        self.registrations: Dict[Tuple[str, str], ConnectorRegistration] = {}
        self.bindings: Dict[Tuple[str, str, int], ExternalIdentityBinding] = {}
        self.health_records: Dict[Tuple[str, str], List[ConnectorHealth]] = defaultdict(list)
        self.source_events: Dict[Tuple[str, str], RealtimeSourceEvent] = {}
        self.delivery_events: Dict[Tuple[str, str, str], str] = {}
        self.delivery_receipts: Dict[Tuple[str, str, str], ConnectorDeliveryReceipt] = {}
        self.dispatches: Dict[Tuple[str, str], ConnectorDispatch] = {}
        self.cursor_records: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
        self.reconciliation_records: Dict[Tuple[str, str], dict] = {}
        self.commits: Dict[Tuple[str, str], RealtimeCommit] = {}
        self.projections: Dict[Tuple[str, str], List[IncidentProjectionV2]] = defaultdict(list)
        self.events: Dict[Tuple[str, str], List[RealtimeIncidentEvent]] = defaultdict(list)
        self.evidence: Dict[Tuple[str, str, str], EvidenceEnvelope] = {}

    async def register_connector(self, registration: ConnectorRegistration) -> ConnectorRegistration:
        key = (registration.tenant_id, registration.connector_id)
        prior = self.registrations.get(key)
        if prior is not None and prior != registration:
            raise ValueError("connector_registration_immutable")
        self.registrations[key] = registration
        return registration

    register_realtime_connector = register_connector

    async def append_binding(self, binding: ExternalIdentityBinding) -> ExternalIdentityBinding:
        registration = self.registrations.get((binding.tenant_id, binding.connector_id))
        if registration is None or registration.provider != binding.provider:
            raise ValueError("external_identity_binding_connector_unknown")
        key = (binding.tenant_id, binding.binding_id, binding.binding_revision)
        prior = self.bindings.get(key)
        if prior is not None and prior != binding:
            raise ValueError("external_identity_binding_immutable")
        latest = [
            item for item in self.bindings.values()
            if item.tenant_id == binding.tenant_id and item.binding_id == binding.binding_id
        ]
        if latest and binding.binding_revision != max(item.binding_revision for item in latest) + 1:
            raise ValueError("external_identity_binding_revision_not_contiguous")
        self.bindings[key] = binding
        return binding

    append_external_identity_binding = append_binding

    async def next_health_revision(self, tenant_id: str, connector_id: str) -> int:
        return len(self.health_records[(tenant_id, connector_id)]) + 1

    next_connector_health_revision = next_health_revision

    async def append_connector_health(self, health: ConnectorHealth) -> ConnectorHealth:
        registration = self.registrations.get((health.tenant_id, health.connector_id))
        if registration is None or registration.provider != health.provider:
            raise ValueError("connector_health_registration_mismatch")
        records = self.health_records[(health.tenant_id, health.connector_id)]
        if health.health_revision != len(records) + 1:
            prior = next(
                (item for item in records if item.health_revision == health.health_revision),
                None,
            )
            if prior == health:
                return prior
            raise ValueError("connector_health_revision_not_contiguous")
        records.append(health)
        return health

    async def connector_health(self, tenant_id: str) -> List[ConnectorHealth]:
        result = []
        now = datetime.now(timezone.utc)
        for (registration_tenant, connector_id), registration in self.registrations.items():
            if registration_tenant != tenant_id:
                continue
            records = self.health_records[(tenant_id, connector_id)]
            if records:
                result.append(_health_at(records[-1], now))
            else:
                result.append(ConnectorHealth(
                    connector_id=connector_id,
                    tenant_id=tenant_id,
                    provider=registration.provider,
                    state=(
                        ConnectorHealthState.UNAVAILABLE
                        if registration.enabled else ConnectorHealthState.DISABLED
                    ),
                    checked_at=now,
                    consecutive_failures=0,
                    lag_seconds=0,
                    reason_code="connector_not_polled",
                    adapter_version=registration.adapter_version,
                    health_revision=1,
                    truth_label=registration.truth_label,
                ))
        return sorted(result, key=lambda item: item.connector_id)

    realtime_connector_health = connector_health

    def _binding_for_event(self, event: RealtimeSourceEvent) -> Optional[ExternalIdentityBinding]:
        return next((
            item for item in self.bindings.values()
            if item.tenant_id == event.tenant_id
            and item.connector_id == event.connector_id
            and item.binding_revision == event.binding_revision
            and _binding_matches_event(item, event)
        ), None)

    async def admit_source_event(
        self, event: RealtimeSourceEvent, dispatch: Optional[ConnectorDispatch] = None,
    ) -> ConnectorDeliveryReceipt:
        _validate_source_event_integrity(event)
        if dispatch is None:
            raise ValueError("connector_dispatch_required")
        registration = self.registrations.get((event.tenant_id, event.connector_id))
        if registration is None or registration.provider != event.provider:
            raise ValueError("realtime_source_event_connector_unknown")
        if registration.truth_label != event.truth_label:
            raise ValueError("realtime_source_event_truth_label_mismatch")
        if self._binding_for_event(event) is None:
            raise ValueError("realtime_binding_tenant_or_run_mismatch")
        identity = _delivery_key(event)
        prior_id = self.delivery_events.get(identity)
        if prior_id is not None:
            prior = self.source_events[(event.tenant_id, prior_id)]
            prior_dispatch = self.dispatches.get((event.tenant_id, dispatch.dispatch_id))
            if (
                prior.raw_content_hash != event.raw_content_hash
                or prior.normalization_hash != event.normalization_hash
                or not _same_normalized_delivery(prior, event)
                or prior_dispatch is None
                or not _same_dispatch_retry(prior_dispatch, dispatch)
            ):
                raise ValueError("connector_delivery_identity_conflict")
            return ConnectorDeliveryReceipt(
                receipt_id="receipt-" + prior.normalization_hash[:24],
                tenant_id=event.tenant_id,
                connector_id=event.connector_id,
                provider_event_id=event.provider_event_id,
                source_event_id=prior.source_event_id,
                status=ConnectorDeliveryStatus.DUPLICATE,
                accepted=True,
                duplicate=True,
                normalization_hash=prior.normalization_hash,
                created_at=prior.received_at,
            )
        if (event.tenant_id, event.source_event_id) in self.source_events:
            raise ValueError("source_event_id_conflict")
        if (
            dispatch.tenant_id != event.tenant_id
            or dispatch.connector_id != event.connector_id
            or dispatch.source_event_id != event.source_event_id
            or dispatch.case_id != event.case_id
            or dispatch.run_id != event.run_id
            or dispatch.normalization_hash != event.normalization_hash
        ):
            raise ValueError("connector_dispatch_source_binding_mismatch")
        receipt = ConnectorDeliveryReceipt(
            receipt_id="receipt-" + event.normalization_hash[:24],
            tenant_id=event.tenant_id,
            connector_id=event.connector_id,
            provider_event_id=event.provider_event_id,
            source_event_id=event.source_event_id,
            status=ConnectorDeliveryStatus.ACCEPTED,
            accepted=True,
            duplicate=False,
            normalization_hash=event.normalization_hash,
            created_at=event.received_at,
        )
        self.source_events[(event.tenant_id, event.source_event_id)] = event
        self.delivery_events[identity] = event.source_event_id
        self.delivery_receipts[identity] = receipt
        self.dispatches[(dispatch.tenant_id, dispatch.dispatch_id)] = dispatch
        cursor_records = self.cursor_records[(event.tenant_id, event.connector_id)]
        cursor_records.append({
            "cursor_revision": len(cursor_records) + 1,
            "cursor_hash": sha256(event.provider_event_id.encode("utf-8")).hexdigest(),
            "source_event_id": event.source_event_id,
        })
        reconciliation_id = "reconcile-" + event.normalization_hash[:24]
        self.reconciliation_records[(event.tenant_id, reconciliation_id)] = {
            "connector_id": event.connector_id,
            "source_event_id": event.source_event_id,
            "case_id": event.case_id,
            "run_id": event.run_id,
        }
        return receipt

    admit_realtime_source_event = admit_source_event

    async def source_event(self, tenant_id: str, source_event_id: str) -> Optional[RealtimeSourceEvent]:
        return self.source_events.get((tenant_id, source_event_id))

    realtime_source_event = source_event

    async def commit_realtime_transition(self, commit: RealtimeCommit) -> RealtimeCommit:
        _validate_realtime_commit_artifacts(commit)
        tenant_id = commit.source_event.tenant_id
        key = (tenant_id, commit.transition_key)
        prior = self.commits.get(key)
        if prior is not None:
            if prior != commit:
                raise ValueError("realtime_transition_idempotency_conflict")
            return prior
        source = await self.source_event(tenant_id, commit.source_event.source_event_id)
        if source != commit.source_event:
            raise ValueError("realtime_transition_source_not_authoritative")
        dispatch = self.dispatches.get((tenant_id, commit.dispatch.dispatch_id))
        if dispatch != commit.dispatch:
            raise ValueError("realtime_transition_dispatch_not_authoritative")
        projection = commit.projection
        if (
            projection.tenant_id != source.tenant_id
            or projection.case_id != source.case_id
            or projection.incident_id != source.incident_id
            or projection.run_id != source.run_id
            or projection.topology_revision != source.topology_revision
            or commit.event.source_event_id != source.source_event_id
            or commit.event.projection_revision != projection.projection_revision
            or commit.event.sequence != projection.sequence
            or commit.evidence.evidence_id not in projection.evidence_refs
        ):
            raise ValueError("realtime_transition_binding_mismatch")
        records = self.projections[(tenant_id, source.case_id)]
        if records and (
            projection.projection_revision <= records[-1].projection_revision
            or projection.sequence <= records[-1].sequence
        ):
            raise ValueError("realtime_projection_revision_or_sequence_not_monotonic")
        self.evidence[(tenant_id, source.case_id, commit.evidence.evidence_id)] = commit.evidence
        records.append(projection)
        self.events[(tenant_id, source.case_id)].append(commit.event)
        self.commits[key] = commit
        return commit

    async def realtime_projection(
        self, tenant_id: str, case_id: str,
    ) -> Optional[IncidentProjectionV2]:
        records = self.projections.get((tenant_id, case_id), [])
        return (
            _projection_freshness_at(records[-1], datetime.now(timezone.utc))
            if records else None
        )

    async def realtime_events_after(
        self, tenant_id: str, case_id: str, after: int,
    ) -> List[RealtimeIncidentEvent]:
        return [
            item for item in self.events.get((tenant_id, case_id), [])
            if item.sequence > after
        ]

    async def realtime_active_incidents(
        self, tenant_id: str, limit: int = 20,
    ) -> List[RealtimeSummary]:
        latest = [
            values[-1] for (item_tenant, _), values in self.projections.items()
            if item_tenant == tenant_id and values
        ]
        return [
            RealtimeSummary.from_projection(
                _projection_freshness_at(item, datetime.now(timezone.utc)),
            )
            for item in sorted(latest, key=lambda value: value.sequence, reverse=True)[:limit]
        ]

    async def realtime_notifications_after(
        self, tenant_id: str, after: Optional[str] = None,
    ) -> List[RealtimeNotification]:
        records = []
        for (item_tenant, case_id), events in self.events.items():
            if item_tenant != tenant_id:
                continue
            projections = self.projections[(tenant_id, case_id)]
            by_revision = {item.projection_revision: item for item in projections}
            for event in events:
                projection = by_revision.get(event.projection_revision)
                if projection is not None:
                    records.append(RealtimeNotification(
                        notification_id=_notification_id(event),
                        event_type=event.event_type,
                        occurred_at=event.occurred_at,
                        source_event_id=event.source_event_id,
                        incident=RealtimeSummary.from_projection(projection),
                    ))
        records.sort(key=lambda item: item.notification_id)
        if after is not None:
            positions = [
                index for index, item in enumerate(records)
                if item.notification_id == after
            ]
            if not positions:
                raise ValueError("realtime_notification_checkpoint_unknown")
            records = records[positions[0] + 1:]
        return records[:100]

    async def realtime_evidence(
        self, tenant_id: str, case_id: str, evidence_id: str, subject_id: str,
    ) -> Optional[EvidenceEnvelope]:
        evidence = self.evidence.get((tenant_id, case_id, evidence_id))
        if evidence is None or subject_id not in evidence.acl_subjects:
            return None
        return evidence


class RealtimePostgresMixin:
    """Postgres methods mixed into ``PostgresCaseRepository``."""

    async def register_realtime_connector(
        self, registration: ConnectorRegistration,
    ) -> ConnectorRegistration:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM connector_registrations
                   WHERE tenant_id=$1 AND connector_id=$2""",
                registration.tenant_id, registration.connector_id,
            )
            if row is not None:
                prior = ConnectorRegistration.parse_obj(_decode(row["payload"]))
                if prior != registration:
                    raise ValueError("connector_registration_immutable")
                return prior
            await connection.execute(
                """INSERT INTO connector_registrations
                   (tenant_id, connector_id, provider, enabled, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6)""",
                registration.tenant_id, registration.connector_id,
                registration.provider.value, registration.enabled,
                _payload(registration), datetime.now(timezone.utc),
            )
            return registration
        return await self._tenant(registration.tenant_id, operation)

    register_connector = register_realtime_connector

    async def append_external_identity_binding(
        self, binding: ExternalIdentityBinding,
    ) -> ExternalIdentityBinding:
        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "external-binding:{}:{}".format(binding.tenant_id, binding.binding_id),
            )
            registration = await connection.fetchrow(
                """SELECT payload FROM connector_registrations
                   WHERE tenant_id=$1 AND connector_id=$2""",
                binding.tenant_id, binding.connector_id,
            )
            if registration is None or ConnectorRegistration.parse_obj(
                _decode(registration["payload"])
            ).provider != binding.provider:
                raise ValueError("external_identity_binding_connector_unknown")
            prior = await connection.fetchrow(
                """SELECT payload FROM external_identity_bindings
                   WHERE tenant_id=$1 AND binding_id=$2 AND binding_revision=$3""",
                binding.tenant_id, binding.binding_id, binding.binding_revision,
            )
            if prior is not None:
                stored = ExternalIdentityBinding.parse_obj(_decode(prior["payload"]))
                if stored != binding:
                    raise ValueError("external_identity_binding_immutable")
                return stored
            latest = await connection.fetchval(
                """SELECT max(binding_revision) FROM external_identity_bindings
                   WHERE tenant_id=$1 AND binding_id=$2""",
                binding.tenant_id, binding.binding_id,
            )
            if binding.binding_revision != (latest or 0) + 1:
                raise ValueError("external_identity_binding_revision_not_contiguous")
            await connection.execute(
                """INSERT INTO external_identity_bindings
                   (tenant_id, binding_id, binding_revision, connector_id, provider,
                    case_id, incident_id, run_id, topology_revision, effective_from,
                    effective_to, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)""",
                binding.tenant_id, binding.binding_id, binding.binding_revision,
                binding.connector_id, binding.provider.value, binding.case_id,
                binding.incident_id, binding.run_id, binding.topology_revision,
                binding.valid_from, binding.valid_to, _payload(binding),
                datetime.now(timezone.utc),
            )
            return binding
        return await self._tenant(binding.tenant_id, operation)

    append_binding = append_external_identity_binding

    async def next_connector_health_revision(self, tenant_id: str, connector_id: str) -> int:
        async def operation(connection):
            value = await connection.fetchval(
                """SELECT max(health_revision) FROM connector_health_snapshots
                   WHERE tenant_id=$1 AND connector_id=$2""",
                tenant_id, connector_id,
            )
            return (value or 0) + 1
        return await self._tenant(tenant_id, operation)

    next_health_revision = next_connector_health_revision

    async def append_connector_health(self, health: ConnectorHealth) -> ConnectorHealth:
        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "connector-health:{}:{}".format(health.tenant_id, health.connector_id),
            )
            prior = await connection.fetchrow(
                """SELECT payload FROM connector_health_snapshots
                   WHERE tenant_id=$1 AND connector_id=$2 AND health_revision=$3""",
                health.tenant_id, health.connector_id, health.health_revision,
            )
            if prior is not None:
                stored = ConnectorHealth.parse_obj(_decode(prior["payload"]))
                if stored != health:
                    raise ValueError("connector_health_immutable")
                return stored
            latest = await connection.fetchval(
                """SELECT max(health_revision) FROM connector_health_snapshots
                   WHERE tenant_id=$1 AND connector_id=$2""",
                health.tenant_id, health.connector_id,
            )
            if health.health_revision != (latest or 0) + 1:
                raise ValueError("connector_health_revision_not_contiguous")
            await connection.execute(
                """INSERT INTO connector_health_snapshots
                   (tenant_id, connector_id, health_revision, state, checked_at,
                    fresh_until, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)""",
                health.tenant_id, health.connector_id, health.health_revision,
                health.state.value, health.checked_at, health.fresh_until,
                _payload(health),
            )
            return health
        return await self._tenant(health.tenant_id, operation)

    async def realtime_connector_health(self, tenant_id: str) -> List[ConnectorHealth]:
        async def operation(connection):
            rows = await connection.fetch(
                """SELECT DISTINCT ON (r.connector_id)
                          r.payload AS registration, h.payload AS health
                   FROM connector_registrations r
                   LEFT JOIN connector_health_snapshots h
                     ON h.tenant_id=r.tenant_id AND h.connector_id=r.connector_id
                   WHERE r.tenant_id=$1
                   ORDER BY r.connector_id, h.health_revision DESC NULLS LAST""",
                tenant_id,
            )
            now = datetime.now(timezone.utc)
            result = []
            for row in rows:
                registration = ConnectorRegistration.parse_obj(_decode(row["registration"]))
                if row["health"] is not None:
                    result.append(_health_at(
                        ConnectorHealth.parse_obj(_decode(row["health"])),
                        now,
                    ))
                else:
                    result.append(ConnectorHealth(
                        connector_id=registration.connector_id,
                        tenant_id=registration.tenant_id,
                        provider=registration.provider,
                        state=(
                            ConnectorHealthState.UNAVAILABLE
                            if registration.enabled else ConnectorHealthState.DISABLED
                        ),
                        checked_at=now,
                        consecutive_failures=0,
                        lag_seconds=0,
                        reason_code="connector_not_polled",
                        adapter_version=registration.adapter_version,
                        health_revision=1,
                        truth_label=registration.truth_label,
                    ))
            return result
        return await self._tenant(tenant_id, operation)

    connector_health = realtime_connector_health

    async def admit_realtime_source_event(
        self, event: RealtimeSourceEvent, dispatch: Optional[ConnectorDispatch] = None,
    ) -> ConnectorDeliveryReceipt:
        _validate_source_event_integrity(event)
        if dispatch is None:
            raise ValueError("connector_dispatch_required")

        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "connector-delivery:{}:{}:{}".format(*_delivery_key(event)),
            )
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "connector-cursor:{}:{}".format(event.tenant_id, event.connector_id),
            )
            registration_row = await connection.fetchrow(
                """SELECT payload FROM connector_registrations
                   WHERE tenant_id=$1 AND connector_id=$2""",
                event.tenant_id, event.connector_id,
            )
            if registration_row is None:
                raise ValueError("realtime_source_event_connector_unknown")
            registration = ConnectorRegistration.parse_obj(_decode(registration_row["payload"]))
            if (
                registration.provider != event.provider
                or registration.truth_label != event.truth_label
            ):
                raise ValueError("realtime_source_event_connector_or_truth_mismatch")
            binding_rows = await connection.fetch(
                """SELECT payload FROM external_identity_bindings
                   WHERE tenant_id=$1 AND connector_id=$2 AND binding_revision=$3
                     AND binding_id=$4 AND case_id=$5 AND run_id=$6""",
                event.tenant_id, event.connector_id, event.binding_revision,
                event.binding_id, event.case_id, event.run_id,
            )
            if not any(
                _binding_matches_event(
                    ExternalIdentityBinding.parse_obj(_decode(row["payload"])), event,
                )
                for row in binding_rows
            ):
                raise ValueError("realtime_binding_tenant_or_run_mismatch")
            prior = await connection.fetchrow(
                """SELECT s.payload FROM connector_source_events s
                   WHERE s.tenant_id=$1 AND s.connector_id=$2 AND s.provider_event_id=$3""",
                event.tenant_id, event.connector_id, event.provider_event_id,
            )
            if prior is not None:
                stored = RealtimeSourceEvent.parse_obj(_decode(prior["payload"]))
                prior_dispatch = await connection.fetchrow(
                    """SELECT payload FROM connector_dispatch_outbox
                       WHERE tenant_id=$1 AND source_event_id=$2""",
                    event.tenant_id, stored.source_event_id,
                )
                if (
                    not _same_normalized_delivery(stored, event)
                    or prior_dispatch is None
                    or not _same_dispatch_retry(
                        ConnectorDispatch.parse_obj(
                            _decode(prior_dispatch["payload"]),
                        ),
                        dispatch,
                    )
                ):
                    raise ValueError("connector_delivery_identity_conflict")
                return ConnectorDeliveryReceipt(
                    receipt_id="receipt-" + stored.normalization_hash[:24],
                    tenant_id=stored.tenant_id,
                    connector_id=stored.connector_id,
                    provider_event_id=stored.provider_event_id,
                    source_event_id=stored.source_event_id,
                    status=ConnectorDeliveryStatus.DUPLICATE,
                    accepted=True,
                    duplicate=True,
                    normalization_hash=stored.normalization_hash,
                    created_at=stored.received_at,
                )
            receipt = ConnectorDeliveryReceipt(
                receipt_id="receipt-" + event.normalization_hash[:24],
                tenant_id=event.tenant_id,
                connector_id=event.connector_id,
                provider_event_id=event.provider_event_id,
                source_event_id=event.source_event_id,
                status=ConnectorDeliveryStatus.ACCEPTED,
                accepted=True,
                duplicate=False,
                normalization_hash=event.normalization_hash,
                created_at=event.received_at,
            )
            await connection.execute(
                """INSERT INTO connector_delivery_receipts
                   (tenant_id, connector_id, provider_event_id, receipt_id,
                    raw_content_hash, status, payload, received_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)""",
                event.tenant_id, event.connector_id, event.provider_event_id,
                receipt.receipt_id, event.raw_content_hash, receipt.status.value,
                _payload(receipt), event.received_at,
            )
            await connection.execute(
                """INSERT INTO connector_source_events
                   (tenant_id, connector_id, provider_event_id, source_event_id,
                    case_id, incident_id, run_id, topology_revision,
                    binding_id, binding_revision, normalization_hash, raw_content_hash,
                    observed_at, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)""",
                event.tenant_id, event.connector_id, event.provider_event_id,
                event.source_event_id, event.case_id, event.incident_id,
                event.run_id, event.topology_revision, event.binding_id,
                event.binding_revision, event.normalization_hash, event.raw_content_hash,
                event.observed_at, _payload(event),
            )
            if (
                dispatch.tenant_id != event.tenant_id
                or dispatch.connector_id != event.connector_id
                or dispatch.source_event_id != event.source_event_id
                or dispatch.case_id != event.case_id
                or dispatch.run_id != event.run_id
                or dispatch.normalization_hash != event.normalization_hash
            ):
                raise ValueError("connector_dispatch_source_binding_mismatch")
            await connection.execute(
                """INSERT INTO connector_dispatch_outbox
                   (tenant_id, dispatch_id, connector_id, source_event_id,
                    case_id, run_id, state, attempt, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)""",
                dispatch.tenant_id, dispatch.dispatch_id, dispatch.connector_id,
                dispatch.source_event_id, dispatch.case_id, dispatch.run_id,
                dispatch.state.value, dispatch.attempt, _payload(dispatch),
                dispatch.created_at,
            )
            cursor_revision = await connection.fetchval(
                """SELECT coalesce(max(cursor_revision), 0) + 1
                   FROM connector_poll_cursors
                   WHERE tenant_id=$1 AND connector_id=$2""",
                event.tenant_id, event.connector_id,
            )
            cursor_payload = {
                "schema_version": "flowpulse.connector-cursor.v1",
                "cursor_revision": cursor_revision,
                "source_event_id": event.source_event_id,
            }
            await connection.execute(
                """INSERT INTO connector_poll_cursors
                   (tenant_id, connector_id, cursor_revision, cursor_hash,
                    payload, created_at)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6)""",
                event.tenant_id, event.connector_id, cursor_revision,
                sha256(event.provider_event_id.encode("utf-8")).hexdigest(),
                json.dumps(cursor_payload, sort_keys=True), event.received_at,
            )
            reconciliation_id = "reconcile-" + event.normalization_hash[:24]
            reconciliation_payload = {
                "schema_version": "flowpulse.connector-reconciliation.v1",
                "reconciliation_id": reconciliation_id,
                "source_event_id": event.source_event_id,
                "case_id": event.case_id,
                "run_id": event.run_id,
            }
            await connection.execute(
                """INSERT INTO connector_reconciliation_runs
                   (tenant_id, connector_id, reconciliation_id, payload, created_at)
                   VALUES ($1,$2,$3,$4::jsonb,$5)""",
                event.tenant_id, event.connector_id, reconciliation_id,
                json.dumps(reconciliation_payload, sort_keys=True),
                event.received_at,
            )
            return receipt
        return await self._tenant(event.tenant_id, operation)

    admit_source_event = admit_realtime_source_event

    async def realtime_source_event(
        self, tenant_id: str, source_event_id: str,
    ) -> Optional[RealtimeSourceEvent]:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM connector_source_events
                   WHERE tenant_id=$1 AND source_event_id=$2""",
                tenant_id, source_event_id,
            )
            return RealtimeSourceEvent.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation)

    source_event = realtime_source_event

    async def commit_realtime_transition(self, commit: RealtimeCommit) -> RealtimeCommit:
        _validate_realtime_commit_artifacts(commit)
        source = commit.source_event

        async def operation(connection):
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "realtime-transition:{}:{}".format(source.tenant_id, commit.transition_key),
            )
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                "realtime-projection:{}:{}".format(source.tenant_id, source.case_id),
            )
            prior = await connection.fetchrow(
                """SELECT payload FROM incident_realtime_transitions
                   WHERE tenant_id=$1 AND transition_key=$2""",
                source.tenant_id, commit.transition_key,
            )
            if prior is not None:
                stored = RealtimeCommit.parse_obj(_decode(prior["payload"]))
                if stored != commit:
                    raise ValueError("realtime_transition_idempotency_conflict")
                return stored
            source_row = await connection.fetchrow(
                """SELECT payload FROM connector_source_events
                   WHERE tenant_id=$1 AND source_event_id=$2""",
                source.tenant_id, source.source_event_id,
            )
            dispatch_row = await connection.fetchrow(
                """SELECT payload FROM connector_dispatch_outbox
                   WHERE tenant_id=$1 AND dispatch_id=$2""",
                source.tenant_id, commit.dispatch.dispatch_id,
            )
            if (
                source_row is None
                or RealtimeSourceEvent.parse_obj(_decode(source_row["payload"])) != source
                or dispatch_row is None
                or ConnectorDispatch.parse_obj(_decode(dispatch_row["payload"])) != commit.dispatch
            ):
                raise ValueError("realtime_transition_fact_or_dispatch_not_authoritative")
            projection = commit.projection
            binding_row = await connection.fetchrow(
                """SELECT payload FROM incident_run_bindings
                   WHERE tenant_id=$1 AND case_id=$2""",
                source.tenant_id, source.case_id,
            )
            if binding_row is None:
                raise ValueError("realtime_transition_workspace_binding_missing")
            if (
                projection.tenant_id != source.tenant_id
                or projection.case_id != source.case_id
                or projection.incident_id != source.incident_id
                or projection.run_id != source.run_id
                or projection.topology_revision != source.topology_revision
                or commit.event.projection_revision != projection.projection_revision
                or commit.event.sequence != projection.sequence
                or commit.event.source_event_id != source.source_event_id
                or commit.evidence.evidence_id not in projection.evidence_refs
            ):
                raise ValueError("realtime_transition_binding_mismatch")
            latest_v1 = await connection.fetchrow(
                """SELECT payload FROM incident_projections
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY projection_revision DESC LIMIT 1""",
                source.tenant_id, source.case_id,
            )
            if latest_v1 is None:
                raise ValueError("realtime_transition_v1_projection_missing")
            current_v1 = IncidentProjection.parse_obj(_decode(latest_v1["payload"]))
            if (
                current_v1 != commit.prior_projection
                or commit.v1_projection.projection_revision != current_v1.projection_revision + 1
                or commit.v1_projection.sequence <= current_v1.sequence
                or commit.v1_event.sequence != commit.v1_projection.sequence
            ):
                raise ValueError("realtime_transition_v1_successor_invalid")
            latest = await connection.fetchrow(
                """SELECT projection_revision, sequence FROM incident_realtime_projections
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY projection_revision DESC LIMIT 1""",
                source.tenant_id, source.case_id,
            )
            if latest is not None and (
                projection.projection_revision <= latest["projection_revision"]
                or projection.sequence <= latest["sequence"]
            ):
                raise ValueError("realtime_projection_revision_or_sequence_not_monotonic")
            evidence = commit.evidence
            await connection.execute(
                "SELECT set_config('app.subject_id', $1, true)",
                evidence.acl_subjects[0],
            )
            await connection.execute(
                """INSERT INTO evidence_envelopes
                   (evidence_id, case_id, tenant_id, case_revision, acl_subjects,
                    proof_scope, source_uri, source_anchor, content_hash,
                    independence_key, payload)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)""",
                evidence.evidence_id, evidence.case_id, evidence.tenant_id,
                evidence.case_revision, json.dumps(evidence.acl_subjects),
                evidence.proof_scope.value, evidence.source_uri,
                evidence.source_anchor, evidence.content_hash,
                evidence.independence_key, _payload(evidence),
            )
            await connection.execute(
                """INSERT INTO workspace_evidence_bindings
                   (tenant_id, incident_id, run_id, topology_revision, case_id,
                    case_revision, workflow_id, workflow_run_id, evidence_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                projection.tenant_id, projection.incident_id, projection.run_id,
                projection.topology_revision, projection.case_id,
                projection.case_revision, projection.workflow_id,
                projection.workflow_run_id, evidence.evidence_id,
            )
            await connection.execute(
                """INSERT INTO incident_projections
                   (tenant_id, incident_id, run_id, topology_revision, case_id,
                    case_revision, workflow_id, workflow_run_id,
                    projection_revision, sequence, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)""",
                commit.v1_projection.tenant_id,
                commit.v1_projection.incident_id,
                commit.v1_projection.run_id,
                commit.v1_projection.topology_revision,
                commit.v1_projection.case_id,
                commit.v1_projection.case_revision,
                commit.v1_projection.workflow_id,
                commit.v1_projection.workflow_run_id,
                commit.v1_projection.projection_revision,
                commit.v1_projection.sequence,
                _payload(commit.v1_projection),
                commit.v1_projection.generated_at,
            )
            await connection.execute(
                """INSERT INTO incident_projection_events
                   (event_id, tenant_id, incident_id, run_id, topology_revision,
                    case_id, case_revision, workflow_id, workflow_run_id,
                    projection_revision, sequence, event_type, payload, occurred_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                uuid5(NAMESPACE_URL, "v1:{}:{}:{}".format(
                    commit.v1_event.tenant_id,
                    commit.v1_event.run_id,
                    commit.v1_event.sequence,
                )),
                commit.v1_event.tenant_id,
                commit.v1_event.incident_id,
                commit.v1_event.run_id,
                commit.v1_event.topology_revision,
                commit.v1_event.case_id,
                commit.v1_event.case_revision,
                commit.v1_event.workflow_id,
                commit.v1_event.workflow_run_id,
                commit.v1_event.projection_revision,
                commit.v1_event.sequence,
                commit.v1_event.event_type,
                _payload(commit.v1_event),
                commit.v1_event.occurred_at,
            )
            await connection.execute(
                """INSERT INTO incident_realtime_projections
                   (tenant_id, incident_id, run_id, topology_revision, case_id,
                    case_revision, workflow_id, workflow_run_id,
                    projection_revision, sequence, source_revision,
                    connector_revision, payload, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)""",
                projection.tenant_id, projection.incident_id, projection.run_id,
                projection.topology_revision, projection.case_id,
                projection.case_revision, projection.workflow_id,
                projection.workflow_run_id, projection.projection_revision,
                projection.sequence, projection.source_revision,
                projection.connector_revision, _payload(projection),
                projection.generated_at,
            )
            event = commit.event
            await connection.execute(
                """INSERT INTO incident_realtime_events
                   (event_id, tenant_id, incident_id, run_id, topology_revision,
                    case_id, case_revision, workflow_id, workflow_run_id,
                    source_event_id, projection_revision, sequence, event_type,
                    payload, occurred_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)""",
                uuid5(NAMESPACE_URL, "{}:{}:{}".format(
                    event.tenant_id, event.run_id, event.sequence,
                )),
                event.tenant_id, event.incident_id, event.run_id,
                event.topology_revision, event.case_id, event.case_revision,
                event.workflow_id, event.workflow_run_id, event.source_event_id,
                event.projection_revision, event.sequence, event.event_type,
                _payload(event), event.occurred_at,
            )
            for table, identifier, item in (
                ("realtime_signal_records", event.signal.signal_id, event.signal),
                ("realtime_graph_pulses", event.pulse.pulse_id, event.pulse),
                ("realtime_citations", event.citation.citation_id, event.citation),
                ("realtime_agent_activities", event.activity.activity_id, event.activity),
            ):
                await connection.execute(
                    """INSERT INTO {} (tenant_id, case_id, record_id,
                       source_event_id, sequence, payload, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)""".format(table),
                    event.tenant_id, event.case_id, identifier,
                    event.source_event_id, event.sequence, _payload(item),
                    event.occurred_at,
                )
            await connection.execute(
                """INSERT INTO incident_realtime_transitions
                   (tenant_id, case_id, run_id, transition_key, source_event_id,
                    dispatch_id, projection_revision, event_sequence, payload,
                    created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)""",
                source.tenant_id, source.case_id, source.run_id,
                commit.transition_key, source.source_event_id,
                commit.dispatch.dispatch_id, projection.projection_revision,
                event.sequence, _payload(commit), event.occurred_at,
            )
            return commit
        return await self._tenant(source.tenant_id, operation)

    async def realtime_projection(
        self, tenant_id: str, case_id: str,
    ) -> Optional[IncidentProjectionV2]:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM incident_realtime_projections
                   WHERE tenant_id=$1 AND case_id=$2
                   ORDER BY projection_revision DESC LIMIT 1""",
                tenant_id, case_id,
            )
            return (
                _projection_freshness_at(
                    IncidentProjectionV2.parse_obj(_decode(row["payload"])),
                    datetime.now(timezone.utc),
                )
                if row else None
            )
        return await self._tenant(tenant_id, operation)

    async def realtime_events_after(
        self, tenant_id: str, case_id: str, after: int,
    ) -> List[RealtimeIncidentEvent]:
        async def operation(connection):
            rows = await connection.fetch(
                """SELECT payload FROM incident_realtime_events
                   WHERE tenant_id=$1 AND case_id=$2 AND sequence>$3
                   ORDER BY sequence LIMIT 100""",
                tenant_id, case_id, after,
            )
            return [
                RealtimeIncidentEvent.parse_obj(_decode(row["payload"]))
                for row in rows
            ]
        return await self._tenant(tenant_id, operation)

    async def realtime_active_incidents(
        self, tenant_id: str, limit: int = 20,
    ) -> List[RealtimeSummary]:
        async def operation(connection):
            rows = await connection.fetch(
                """SELECT DISTINCT ON (case_id) payload
                   FROM incident_realtime_projections
                   WHERE tenant_id=$1
                   ORDER BY case_id, projection_revision DESC""",
                tenant_id,
            )
            projections = [
                IncidentProjectionV2.parse_obj(_decode(row["payload"])) for row in rows
            ]
            projections.sort(key=lambda item: item.sequence, reverse=True)
            now = datetime.now(timezone.utc)
            return [
                RealtimeSummary.from_projection(_projection_freshness_at(item, now))
                for item in projections[:limit]
            ]
        return await self._tenant(tenant_id, operation)

    async def realtime_notifications_after(
        self, tenant_id: str, after: Optional[str] = None,
    ) -> List[RealtimeNotification]:
        async def operation(connection):
            rows = await connection.fetch(
                """SELECT e.payload AS event, p.payload AS projection
                   FROM incident_realtime_events e
                   JOIN incident_realtime_projections p
                     ON p.tenant_id=e.tenant_id
                    AND p.run_id=e.run_id
                    AND p.topology_revision=e.topology_revision
                    AND p.projection_revision=e.projection_revision
                   WHERE e.tenant_id=$1
                   ORDER BY e.occurred_at, e.run_id, e.sequence
                   LIMIT 200""",
                tenant_id,
            )
            records = []
            for row in rows:
                event = RealtimeIncidentEvent.parse_obj(_decode(row["event"]))
                projection = IncidentProjectionV2.parse_obj(_decode(row["projection"]))
                records.append(RealtimeNotification(
                    notification_id=_notification_id(event),
                    event_type=event.event_type,
                    occurred_at=event.occurred_at,
                    source_event_id=event.source_event_id,
                    incident=RealtimeSummary.from_projection(projection),
                ))
            if after is not None:
                positions = [
                    index for index, item in enumerate(records)
                    if item.notification_id == after
                ]
                if not positions:
                    raise ValueError("realtime_notification_checkpoint_unknown")
                records = records[positions[0] + 1:]
            return records[:100]
        return await self._tenant(tenant_id, operation)

    async def realtime_evidence(
        self, tenant_id: str, case_id: str, evidence_id: str, subject_id: str,
    ) -> Optional[EvidenceEnvelope]:
        async def operation(connection):
            row = await connection.fetchrow(
                """SELECT payload FROM evidence_envelopes
                   WHERE tenant_id=$1 AND case_id=$2 AND evidence_id=$3""",
                tenant_id, case_id, evidence_id,
            )
            return EvidenceEnvelope.parse_obj(_decode(row["payload"])) if row else None
        return await self._tenant(tenant_id, operation, subject_id)

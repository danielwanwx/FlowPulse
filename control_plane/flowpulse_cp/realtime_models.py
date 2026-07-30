"""Strict additive contracts for the Phase 1 read-only connector fact plane."""

from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import List, Optional

from pydantic import Field, StrictBool, StrictStr, conint, root_validator, validator

from .models import (
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    Hash,
    NonEmpty,
    PositiveInt,
    ProofScope,
    StrictModel,
)
from .workspace_models import (
    IncidentEvent,
    IncidentLifecycleStage,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
)


NonNegativeInt = conint(strict=True, ge=0)
FreshnessSeconds = conint(strict=True, ge=15, le=300)
InterpolationSeconds = conint(strict=True, ge=1, le=60)


class ConnectorProvider(str, Enum):
    PROMETHEUS = "PROMETHEUS"
    OTEL = "OTEL"


class ConnectorTruthLabel(str, Enum):
    LIVE = "LIVE"
    TEST_DETERMINISTIC = "TEST_DETERMINISTIC"


class ConnectorHealthState(str, Enum):
    CONNECTED = "CONNECTED"
    DEGRADED = "DEGRADED"
    STALE = "STALE"
    UNAVAILABLE = "UNAVAILABLE"
    MISCONFIGURED = "MISCONFIGURED"
    DISABLED = "DISABLED"


class ConnectorDeliveryStatus(str, Enum):
    ACCEPTED = "ACCEPTED"
    DUPLICATE = "DUPLICATE"
    CONFLICTED = "CONFLICTED"
    REJECTED = "REJECTED"


class ConnectorDispatchState(str, Enum):
    PENDING = "PENDING"
    DISPATCHED = "DISPATCHED"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"


class RealtimeSignalStatus(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AgentRole(str, Enum):
    MONITOR = "MONITOR"
    TRIAGE = "TRIAGE"


class AgentActivityState(str, Enum):
    STARTED = "STARTED"
    COMPLETED = "COMPLETED"
    DEGRADED = "DEGRADED"
    REJECTED = "REJECTED"


class IncidentClockState(str, Enum):
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    RESOLVED = "RESOLVED"


class ConnectorRegistration(StrictModel):
    schema_version: NonEmpty = "flowpulse.connector-registration.v1"
    connector_id: NonEmpty
    tenant_id: NonEmpty
    provider: ConnectorProvider
    adapter_version: NonEmpty
    data_classes: List[NonEmpty] = Field(min_items=1, max_items=8)
    capabilities: List[NonEmpty] = Field(min_items=1, max_items=8)
    freshness_sla_seconds: FreshnessSeconds
    enabled: StrictBool
    truth_label: ConnectorTruthLabel

    @validator("data_classes", "capabilities", allow_reuse=True)
    def unique_bounded_names(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("connector_descriptor_values_must_be_unique")
        return value


class ExternalIdentityBinding(StrictModel):
    schema_version: NonEmpty = "flowpulse.external-identity-binding.v1"
    binding_id: NonEmpty
    binding_revision: PositiveInt
    tenant_id: NonEmpty
    connector_id: NonEmpty
    provider: ConnectorProvider
    external_resource_type: NonEmpty
    external_resource_id: NonEmpty
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    valid_from: datetime
    valid_to: Optional[datetime] = None
    status: NonEmpty
    provenance_source: NonEmpty

    @root_validator(allow_reuse=True)
    def interval_and_identity_are_valid(cls, values):
        if values.get("valid_to") is not None and values["valid_to"] <= values.get("valid_from"):
            raise ValueError("external_identity_binding_interval_invalid")
        for field in ("component_ids", "edge_ids"):
            items = values.get(field, [])
            if len(items) != len(set(items)):
                raise ValueError("external_identity_binding_values_must_be_unique")
        if values.get("status") != "ACTIVE":
            raise ValueError("external_identity_binding_status_unsupported")
        return values


class ConnectorHealth(StrictModel):
    schema_version: NonEmpty = "flowpulse.connector-health.v1"
    connector_id: NonEmpty
    tenant_id: NonEmpty
    provider: ConnectorProvider
    state: ConnectorHealthState
    checked_at: datetime
    last_success_at: Optional[datetime] = None
    last_event_observed_at: Optional[datetime] = None
    fresh_until: Optional[datetime] = None
    cursor: Optional[StrictStr] = None
    consecutive_failures: NonNegativeInt
    lag_seconds: NonNegativeInt
    reason_code: Optional[StrictStr] = None
    adapter_version: NonEmpty
    health_revision: PositiveInt
    truth_label: ConnectorTruthLabel


class RealtimeSourceEvent(StrictModel):
    source_event_id: NonEmpty
    schema_version: NonEmpty = "flowpulse.connector-source-event.v1"
    tenant_id: NonEmpty
    connector_id: NonEmpty
    provider: ConnectorProvider
    provider_event_id: NonEmpty
    delivery_id: NonEmpty
    raw_artifact_ref: NonEmpty
    raw_content_hash: Hash
    event_kind: NonEmpty
    binding_id: NonEmpty
    binding_revision: PositiveInt
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    observed_at: datetime
    effective_at: datetime
    received_at: datetime
    display_value: NonEmpty
    signal_status: RealtimeSignalStatus
    freshness: FreshnessStatus
    authority: EvidenceAuthority
    proof_scope: ProofScope
    acl_subjects: List[NonEmpty] = Field(min_items=1, max_items=64)
    normalizer_version: NonEmpty
    normalization_hash: Hash
    truth_label: ConnectorTruthLabel

    @root_validator(allow_reuse=True)
    def current_fact_is_bounded_and_authoritative(cls, values):
        if values.get("proof_scope") != ProofScope.CURRENT_OBSERVATION:
            raise ValueError("realtime_source_event_requires_current_observation")
        if values.get("freshness") != FreshnessStatus.CURRENT:
            raise ValueError("realtime_source_event_requires_current_freshness")
        if values.get("authority") not in {EvidenceAuthority.T0, EvidenceAuthority.T1}:
            raise ValueError("realtime_source_event_requires_trusted_authority")
        if values.get("observed_at") and values.get("received_at"):
            if values["observed_at"] > values["received_at"]:
                raise ValueError("realtime_source_event_observed_after_received")
        for field in ("component_ids", "edge_ids", "acl_subjects"):
            items = values.get(field, [])
            if len(items) != len(set(items)):
                raise ValueError("realtime_source_event_values_must_be_unique")
        return values

    def canonical_hash(self) -> str:
        encoded = self.json(
            sort_keys=True,
            exclude={
                "normalization_hash",
                "source_event_id",
                "delivery_id",
                # Arrival time is recorded on the first immutable delivery but
                # cannot make a lost-ACK retry into a different normalized fact.
                "received_at",
            },
            separators=(",", ":"),
        ).encode("utf-8")
        return sha256(encoded).hexdigest()


class ConnectorDeliveryReceipt(StrictModel):
    receipt_id: NonEmpty
    tenant_id: NonEmpty
    connector_id: NonEmpty
    provider_event_id: NonEmpty
    source_event_id: Optional[StrictStr] = None
    status: ConnectorDeliveryStatus
    accepted: StrictBool
    duplicate: StrictBool
    normalization_hash: Optional[Hash] = None
    created_at: datetime


class ConnectorDispatch(StrictModel):
    dispatch_id: NonEmpty
    tenant_id: NonEmpty
    connector_id: NonEmpty
    source_event_id: NonEmpty
    case_id: NonEmpty
    run_id: NonEmpty
    normalization_hash: Hash
    state: ConnectorDispatchState
    attempt: PositiveInt
    created_at: datetime


class RealtimeCitation(StrictModel):
    citation_id: NonEmpty
    provider: ConnectorProvider
    evidence_id: NonEmpty
    source_event_id: NonEmpty
    label: NonEmpty
    observed_at: datetime
    freshness: FreshnessStatus
    safe_detail_path: NonEmpty


class RealtimeSignal(StrictModel):
    signal_id: NonEmpty
    source_event_id: NonEmpty
    provider: ConnectorProvider
    source_label: NonEmpty
    signal_kind: NonEmpty
    title: NonEmpty
    display_value: NonEmpty
    status: RealtimeSignalStatus
    trend: NonEmpty
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    observed_at: datetime
    fresh_until: datetime
    freshness: FreshnessStatus
    authority: EvidenceAuthority
    evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=32)
    citation_refs: List[NonEmpty] = Field(min_items=1, max_items=32)
    connector_state: ConnectorHealthState
    sequence: PositiveInt


class GraphPulse(StrictModel):
    pulse_id: NonEmpty
    source_event_id: NonEmpty
    event_sequence: PositiveInt
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    pulse_kind: NonEmpty
    severity: RealtimeSignalStatus
    started_at: datetime
    expires_at: datetime
    evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=32)

    @root_validator(allow_reuse=True)
    def pulse_interval_is_positive(cls, values):
        if values.get("expires_at") <= values.get("started_at"):
            raise ValueError("graph_pulse_interval_invalid")
        return values


class AgentActivity(StrictModel):
    activity_id: NonEmpty
    sequence: PositiveInt
    role: AgentRole
    state: AgentActivityState
    trigger: NonEmpty
    capability: NonEmpty
    capability_version: NonEmpty
    tool_label: NonEmpty
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    started_at: datetime
    completed_at: Optional[datetime] = None
    summary: NonEmpty
    source_event_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=32)
    citation_refs: List[NonEmpty] = Field(min_items=1, max_items=32)
    truth_label: ConnectorTruthLabel
    external_write_performed: StrictBool = False
    degraded_code: Optional[StrictStr] = None

    @root_validator(allow_reuse=True)
    def read_only_activity_is_truthful(cls, values):
        if values.get("external_write_performed"):
            raise ValueError("phase1_agent_activity_external_write_forbidden")
        if values.get("state") == AgentActivityState.COMPLETED and values.get("completed_at") is None:
            raise ValueError("completed_agent_activity_requires_completed_at")
        return values


class AgentWorkspace(StrictModel):
    workspace_revision: PositiveInt
    mode: NonEmpty = "READ_ONLY"
    activities: List[AgentActivity] = Field(default_factory=list, max_items=64)
    citations: List[RealtimeCitation] = Field(default_factory=list, max_items=64)


class IncidentClock(StrictModel):
    state: IncidentClockState
    started_at: datetime
    last_signal_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    as_of: datetime
    elapsed_seconds: NonNegativeInt
    freshness: FreshnessStatus
    fresh_until: datetime
    max_interpolation_seconds: InterpolationSeconds


class IncidentProjectionV2(IncidentProjection):
    schema_version: NonEmpty = "flowpulse.incident-projection.v2"
    source_revision: PositiveInt
    connector_revision: PositiveInt
    incident_clock: IncidentClock
    connector_health: List[ConnectorHealth] = Field(default_factory=list, max_items=16)
    realtime_signals: List[RealtimeSignal] = Field(default_factory=list, max_items=12)
    active_graph_pulses: List[GraphPulse] = Field(default_factory=list, max_items=32)
    agent_workspace: AgentWorkspace

    @root_validator(allow_reuse=True)
    def realtime_artifacts_bind_to_projection(cls, values):
        graph = values.get("graph")
        if graph is None:
            return values
        nodes = {node.component_id for node in graph.nodes}
        edges = {edge.edge_id for edge in graph.edges}
        evidence = set(values.get("evidence_refs", []))
        signals = values.get("realtime_signals", [])
        citations = {
            item.citation_id: item for item in values.get("agent_workspace").citations
        } if values.get("agent_workspace") else {}
        for signal in signals:
            if not set(signal.component_ids).issubset(nodes) or not set(signal.edge_ids).issubset(edges):
                raise ValueError("realtime_signal_graph_binding_mismatch")
            if not set(signal.evidence_refs).issubset(evidence):
                raise ValueError("realtime_signal_evidence_binding_mismatch")
            if not set(signal.citation_refs).issubset(citations):
                raise ValueError("realtime_signal_citation_binding_mismatch")
        return values


class RealtimeIncidentEvent(IncidentRunBinding):
    schema_version: NonEmpty = "flowpulse.incident-realtime-event.v2"
    source_event_id: NonEmpty
    projection_revision: PositiveInt
    sequence: PositiveInt
    event_type: NonEmpty
    occurred_at: datetime
    signal: RealtimeSignal
    pulse: GraphPulse
    activity: AgentActivity
    citation: RealtimeCitation


class RealtimeCommit(StrictModel):
    transition_key: NonEmpty
    source_event: RealtimeSourceEvent
    evidence: EvidenceEnvelope
    prior_projection: IncidentProjection
    v1_projection: IncidentProjection
    v1_event: IncidentEvent
    projection: IncidentProjectionV2
    event: RealtimeIncidentEvent
    health: ConnectorHealth
    dispatch: ConnectorDispatch

    @root_validator(allow_reuse=True)
    def v1_and_v2_are_one_temporal_transition(cls, values):
        v1 = values.get("v1_projection")
        v2 = values.get("projection")
        event = values.get("v1_event")
        realtime_event = values.get("event")
        if any(item is None for item in (v1, v2, event, realtime_event)):
            return values
        for field in IncidentProjection.__fields__:
            if field == "schema_version":
                continue
            if getattr(v1, field) != getattr(v2, field):
                raise ValueError("realtime_v1_v2_projection_delta_mismatch")
        if (
            event.sequence != v1.sequence
            or event.projection_revision != v1.projection_revision
            or realtime_event.sequence != v2.sequence
            or realtime_event.projection_revision != v2.projection_revision
            or event.event_type != "workspace.realtime.source_event.accepted"
        ):
            raise ValueError("realtime_v1_v2_event_delta_mismatch")
        return values


class RealtimeUpdateCommand(StrictModel):
    tenant_id: NonEmpty
    actor_subject_id: NonEmpty
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    connector_id: NonEmpty
    idempotency_key: NonEmpty


class ConnectorReconcileRequest(StrictModel):
    idempotency_key: NonEmpty


class RealtimeUpdateOutcome(StrictModel):
    accepted: StrictBool
    reason: Optional[StrictStr] = None
    projection: Optional[IncidentProjectionV2] = None
    source_event_id: Optional[StrictStr] = None
    transition_key: Optional[StrictStr] = None
    workspace_projection: Optional[IncidentProjection] = None


class ConnectorPollResult(StrictModel):
    registration: ConnectorRegistration
    health: ConnectorHealth
    source_event: RealtimeSourceEvent
    dispatch: ConnectorDispatch


class RealtimePollActivityPacket(StrictModel):
    command: RealtimeUpdateCommand
    projection: IncidentProjection


class RealtimeCommitActivityPacket(StrictModel):
    command: RealtimeUpdateCommand
    projection: IncidentProjection
    prior_realtime_projection: Optional[IncidentProjectionV2] = None
    event_sequence: PositiveInt
    poll_result: ConnectorPollResult


class RealtimeSummary(StrictModel):
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    projection_revision: PositiveInt
    sequence: PositiveInt
    lifecycle_state: ProjectionState
    lifecycle_stage: IncidentLifecycleStage
    title: NonEmpty
    summary: NonEmpty
    incident_clock: IncidentClock
    latest_signal_status: Optional[RealtimeSignalStatus] = None
    connector_freshness: FreshnessStatus

    @classmethod
    def from_projection(cls, projection: IncidentProjectionV2) -> "RealtimeSummary":
        return cls(
            case_id=projection.case_id,
            incident_id=projection.incident_id,
            run_id=projection.run_id,
            topology_revision=projection.topology_revision,
            projection_revision=projection.projection_revision,
            sequence=projection.sequence,
            lifecycle_state=projection.lifecycle_state,
            lifecycle_stage=projection.lifecycle_stage,
            title=projection.operator_title,
            summary=projection.operator_summary,
            incident_clock=projection.incident_clock,
            latest_signal_status=(
                projection.realtime_signals[0].status
                if projection.realtime_signals else None
            ),
            connector_freshness=(
                FreshnessStatus.CURRENT
                if any(item.state == ConnectorHealthState.CONNECTED for item in projection.connector_health)
                else FreshnessStatus.STALE
            ),
        )


class RealtimeNotification(StrictModel):
    notification_id: NonEmpty
    event_type: NonEmpty
    occurred_at: datetime
    source_event_id: NonEmpty
    incident: RealtimeSummary

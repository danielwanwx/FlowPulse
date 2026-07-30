"""Strict additive contracts for the Phase 1 read-only connector fact plane."""

from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import List, Optional

from pydantic import (
    Field,
    StrictBool,
    StrictFloat,
    StrictStr,
    conint,
    root_validator,
    validator,
)

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


class RealtimeDeliveryMode(str, Enum):
    LIVE = "LIVE"
    BACKFILL = "BACKFILL"


class RealtimeTrend(str, Enum):
    UNKNOWN = "UNKNOWN"
    STABLE = "STABLE"
    RISING = "RISING"
    FALLING = "FALLING"


class RealtimeEventType(str, Enum):
    CONNECTOR_HEALTH_CHANGED = "connector.health.changed"
    CONNECTOR_SOURCE_ACCEPTED = "connector.source.accepted"
    SIGNAL_OBSERVED = "incident.signal.observed"
    SIGNAL_STALE = "incident.signal.stale"
    GRAPH_PULSE_STARTED = "graph.pulse.started"
    GRAPH_PULSE_EXPIRED = "graph.pulse.expired"
    AGENT_ACTIVITY_STARTED = "agent.activity.started"
    AGENT_ACTIVITY_COMPLETED = "agent.activity.completed"
    AGENT_ACTIVITY_DEGRADED = "agent.activity.degraded"
    INCIDENT_CLOCK_CHANGED = "incident.clock.changed"


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


class ConfiguredBindingTemplate(StrictModel):
    """Deployment-owned identity mapping; never accepted from browser/model input."""

    schema_version: NonEmpty = "flowpulse.configured-binding-template.v1"
    binding_key: NonEmpty
    external_resource_type: NonEmpty
    external_resource_id: NonEmpty
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    provenance_source: NonEmpty = "SERVER_CONNECTOR_CONFIG"

    @validator("component_ids", "edge_ids", allow_reuse=True)
    def template_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("configured_binding_template_values_must_be_unique")
        return value

    def materialize(
        self,
        registration: ConnectorRegistration,
        projection: IncidentProjection,
        *,
        valid_from: datetime,
    ) -> ExternalIdentityBinding:
        nodes = {node.component_id for node in projection.graph.nodes}
        edges = {edge.edge_id for edge in projection.graph.edges}
        if not set(self.component_ids).issubset(nodes):
            raise ValueError("configured_binding_template_component_unknown")
        if not set(self.edge_ids).issubset(edges):
            raise ValueError("configured_binding_template_edge_unknown")
        return ExternalIdentityBinding(
            binding_id="binding:{}:{}:{}".format(
                registration.connector_id,
                projection.run_id,
                self.binding_key,
            ),
            binding_revision=1,
            tenant_id=projection.tenant_id,
            connector_id=registration.connector_id,
            provider=registration.provider,
            external_resource_type=self.external_resource_type,
            external_resource_id=self.external_resource_id,
            case_id=projection.case_id,
            incident_id=projection.incident_id,
            run_id=projection.run_id,
            topology_revision=projection.topology_revision,
            component_ids=self.component_ids,
            edge_ids=self.edge_ids,
            valid_from=valid_from,
            status="ACTIVE",
            provenance_source=self.provenance_source,
        )


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
    numeric_value: StrictFloat
    signal_status: RealtimeSignalStatus
    trend: RealtimeTrend = RealtimeTrend.UNKNOWN
    delivery_mode: RealtimeDeliveryMode = RealtimeDeliveryMode.LIVE
    freshness: FreshnessStatus
    authority: EvidenceAuthority
    proof_scope: ProofScope
    acl_subjects: List[NonEmpty] = Field(min_items=1, max_items=64)
    normalizer_version: NonEmpty
    normalization_hash: Hash
    truth_label: ConnectorTruthLabel

    @root_validator(allow_reuse=True)
    def fact_is_bounded_and_truthful(cls, values):
        freshness = values.get("freshness")
        scope = values.get("proof_scope")
        authority = values.get("authority")
        if freshness == FreshnessStatus.CURRENT:
            if scope != ProofScope.CURRENT_OBSERVATION:
                raise ValueError("realtime_current_source_requires_current_observation")
            if authority not in {EvidenceAuthority.T0, EvidenceAuthority.T1}:
                raise ValueError("realtime_source_event_requires_trusted_authority")
        elif freshness == FreshnessStatus.STALE:
            if scope != ProofScope.REFERENCE_ONLY:
                raise ValueError("realtime_stale_source_requires_reference_scope")
            if authority == EvidenceAuthority.T0:
                raise ValueError("realtime_stale_source_cannot_be_t0")
        else:
            raise ValueError("realtime_source_event_freshness_unsupported")
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


class ConnectorAdmissionResult(StrictModel):
    receipt: ConnectorDeliveryReceipt
    source_event: RealtimeSourceEvent
    dispatch: "ConnectorDispatch"

    @property
    def source_event_id(self) -> str:
        return self.receipt.source_event_id

    @property
    def accepted(self) -> bool:
        return self.receipt.accepted

    @property
    def duplicate(self) -> bool:
        return self.receipt.duplicate


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


class ConnectorDispatchRevision(StrictModel):
    schema_version: NonEmpty = "flowpulse.connector-dispatch-revision.v1"
    tenant_id: NonEmpty
    dispatch_id: NonEmpty
    state_revision: PositiveInt
    state: ConnectorDispatchState
    attempt: PositiveInt
    receipt_id: Optional[StrictStr] = None
    transition_key: Optional[StrictStr] = None
    created_at: datetime
    reason_code: Optional[StrictStr] = None


ConnectorAdmissionResult.update_forward_refs(ConnectorDispatch=ConnectorDispatch)


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
    trend: RealtimeTrend
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
    activity_key: NonEmpty
    state_revision: PositiveInt
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
        if values.get("state") == AgentActivityState.STARTED and values.get("completed_at") is not None:
            raise ValueError("started_agent_activity_cannot_be_completed")
        if values.get("state") == AgentActivityState.COMPLETED and values.get("completed_at") is None:
            raise ValueError("completed_agent_activity_requires_completed_at")
        if values.get("state") == AgentActivityState.DEGRADED and values.get("degraded_code") is None:
            raise ValueError("degraded_agent_activity_requires_code")
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
    source_event_id: Optional[StrictStr] = None
    projection_revision: PositiveInt
    sequence: PositiveInt
    event_type: RealtimeEventType
    occurred_at: datetime
    signal: Optional[RealtimeSignal] = None
    pulse: Optional[GraphPulse] = None
    activity: Optional[AgentActivity] = None
    citation: Optional[RealtimeCitation] = None
    health: Optional[ConnectorHealth] = None
    incident_clock: Optional[IncidentClock] = None

    @root_validator(allow_reuse=True)
    def event_payload_matches_type(cls, values):
        event_type = values.get("event_type")
        required = {
            RealtimeEventType.CONNECTOR_HEALTH_CHANGED: "health",
            RealtimeEventType.SIGNAL_OBSERVED: "signal",
            RealtimeEventType.SIGNAL_STALE: "signal",
            RealtimeEventType.GRAPH_PULSE_STARTED: "pulse",
            RealtimeEventType.GRAPH_PULSE_EXPIRED: "pulse",
            RealtimeEventType.AGENT_ACTIVITY_STARTED: "activity",
            RealtimeEventType.AGENT_ACTIVITY_COMPLETED: "activity",
            RealtimeEventType.AGENT_ACTIVITY_DEGRADED: "activity",
            RealtimeEventType.INCIDENT_CLOCK_CHANGED: "incident_clock",
        }
        field = required.get(event_type)
        if field and values.get(field) is None:
            raise ValueError("realtime_event_payload_mismatch")
        allowed = {
            RealtimeEventType.CONNECTOR_HEALTH_CHANGED: {"health"},
            RealtimeEventType.CONNECTOR_SOURCE_ACCEPTED: set(),
            RealtimeEventType.SIGNAL_OBSERVED: {"signal", "citation"},
            RealtimeEventType.SIGNAL_STALE: {"signal", "citation"},
            RealtimeEventType.GRAPH_PULSE_STARTED: {"pulse", "citation"},
            RealtimeEventType.GRAPH_PULSE_EXPIRED: {"pulse"},
            RealtimeEventType.AGENT_ACTIVITY_STARTED: {"activity", "citation"},
            RealtimeEventType.AGENT_ACTIVITY_COMPLETED: {"activity", "citation"},
            RealtimeEventType.AGENT_ACTIVITY_DEGRADED: {"activity", "citation"},
            RealtimeEventType.INCIDENT_CLOCK_CHANGED: {"incident_clock"},
        }.get(event_type, set())
        populated = {
            name for name in (
                "signal", "pulse", "activity", "citation", "health",
                "incident_clock",
            )
            if values.get(name) is not None
        }
        if not populated.issubset(allowed):
            raise ValueError("realtime_event_payload_mismatch")
        if event_type == RealtimeEventType.CONNECTOR_SOURCE_ACCEPTED:
            if not values.get("source_event_id"):
                raise ValueError("realtime_event_payload_mismatch")
        activity = values.get("activity")
        expected_activity_state = {
            RealtimeEventType.AGENT_ACTIVITY_STARTED: AgentActivityState.STARTED,
            RealtimeEventType.AGENT_ACTIVITY_COMPLETED: AgentActivityState.COMPLETED,
            RealtimeEventType.AGENT_ACTIVITY_DEGRADED: AgentActivityState.DEGRADED,
        }.get(event_type)
        if expected_activity_state and (
            activity is None or activity.state != expected_activity_state
        ):
            raise ValueError("realtime_event_payload_mismatch")
        if event_type in {
            RealtimeEventType.GRAPH_PULSE_STARTED,
            RealtimeEventType.GRAPH_PULSE_EXPIRED,
        } and values.get("pulse") is not None and not values["pulse"].edge_ids:
            raise ValueError("realtime_event_path_pulse_requires_edges")
        return values


class RealtimeCommit(StrictModel):
    transition_key: NonEmpty
    source_event: RealtimeSourceEvent
    evidence: EvidenceEnvelope
    prior_projection: IncidentProjection
    v1_projection: IncidentProjection
    v1_event: IncidentEvent
    projection: IncidentProjectionV2
    events: List[RealtimeIncidentEvent] = Field(min_items=5, max_items=16)
    signal: RealtimeSignal
    pulse: Optional[GraphPulse] = None
    citation: RealtimeCitation
    activities: List[AgentActivity] = Field(min_items=2, max_items=2)
    health: ConnectorHealth
    dispatch: ConnectorDispatch

    @root_validator(allow_reuse=True)
    def v1_and_v2_are_one_temporal_transition(cls, values):
        v1 = values.get("v1_projection")
        v2 = values.get("projection")
        event = values.get("v1_event")
        realtime_events = values.get("events")
        if any(item is None for item in (v1, v2, event, realtime_events)):
            return values
        for field in IncidentProjection.__fields__:
            if field == "schema_version":
                continue
            if getattr(v1, field) != getattr(v2, field):
                raise ValueError("realtime_v1_v2_projection_delta_mismatch")
        if (
            event.sequence != v1.sequence
            or event.projection_revision != v1.projection_revision
            or realtime_events[-1].sequence != v2.sequence
            or any(
                item.projection_revision != v2.projection_revision
                for item in realtime_events
            )
            or event.event_type != "workspace.realtime.source_event.accepted"
        ):
            raise ValueError("realtime_v1_v2_event_delta_mismatch")
        if [item.sequence for item in realtime_events] != list(range(
            realtime_events[0].sequence,
            realtime_events[-1].sequence + 1,
        )):
            raise ValueError("realtime_event_sequence_not_contiguous")
        return values


class RealtimeUpdateCommand(StrictModel):
    tenant_id: NonEmpty
    actor_subject_id: NonEmpty
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    connector_id: NonEmpty
    source_event_id: Optional[StrictStr] = None
    dispatch_id: Optional[StrictStr] = None
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
    accepted: StrictBool = True
    reason_code: Optional[StrictStr] = None
    registration: ConnectorRegistration
    health: ConnectorHealth
    receipt: Optional[ConnectorDeliveryReceipt] = None
    source_event: Optional[RealtimeSourceEvent] = None
    dispatch: Optional[ConnectorDispatch] = None

    @root_validator(allow_reuse=True)
    def accepted_poll_has_authoritative_fact_family(cls, values):
        family = (
            values.get("receipt"),
            values.get("source_event"),
            values.get("dispatch"),
        )
        if values.get("accepted") and any(item is None for item in family):
            raise ValueError("accepted_connector_poll_requires_fact_family")
        if not values.get("accepted") and any(item is not None for item in family):
            raise ValueError("rejected_connector_poll_cannot_carry_fact_family")
        if not values.get("accepted") and not values.get("reason_code"):
            raise ValueError("rejected_connector_poll_requires_reason")
        return values


class RealtimePollActivityPacket(StrictModel):
    command: RealtimeUpdateCommand
    projection: IncidentProjection


class RealtimeCommitActivityPacket(StrictModel):
    command: RealtimeUpdateCommand
    projection: IncidentProjection
    prior_realtime_projection: Optional[IncidentProjectionV2] = None
    first_event_sequence: Optional[PositiveInt] = None
    event_sequence: Optional[PositiveInt] = None
    poll_result: ConnectorPollResult

    @root_validator(pre=True, allow_reuse=True)
    def accept_frozen_single_event_packet(cls, values):
        if values.get("first_event_sequence") is None:
            values["first_event_sequence"] = values.get("event_sequence")
        return values

    @root_validator(allow_reuse=True)
    def sequence_is_present(cls, values):
        if values.get("first_event_sequence") is None:
            raise ValueError("realtime_first_event_sequence_required")
        return values


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
    source_event_id: Optional[StrictStr] = None
    incident: RealtimeSummary

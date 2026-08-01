"""V3 identity and command contracts for long-running Incident Workspaces.

These models are additive. Frozen V2 projection, binding, and action schemas
remain unchanged while the persistence and Temporal migration is implemented.
"""

from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import Any, Dict, List, Optional

from pydantic import Field, StrictBool, StrictStr, conint, root_validator, validator

from .models import FreshnessStatus, NonEmpty, PositiveInt, StrictModel, UnitIntervalFloat
from .realtime_models import (
    ConnectorHealth,
    GraphPulse,
    IncidentClock,
    MetricSeriesCollectionV3,
)
from .workspace_models import IncidentGraph, IncidentGraphEdge, IncidentGraphNode


class IncidentExecutionIdentityV3(StrictModel):
    """Stable public identity that survives Temporal continue-as-new."""

    schema_version: NonEmpty = "flowpulse.incident-execution-identity.v3"
    tenant_id: NonEmpty
    incident_id: NonEmpty
    incident_run_id: NonEmpty
    topology_revision: NonEmpty
    case_id: NonEmpty
    case_revision: PositiveInt
    temporal_workflow_id: NonEmpty
    created_at: datetime

    @root_validator(allow_reuse=True)
    def public_run_is_not_temporal_workflow_identity(cls, values):
        if values.get("incident_run_id") == values.get("temporal_workflow_id"):
            raise ValueError("incident_run_id_must_not_equal_temporal_workflow_id")
        return values


class TemporalExecutionPointerV3(StrictModel):
    """Current physical Temporal execution for one stable incident run."""

    schema_version: NonEmpty = "flowpulse.temporal-execution-pointer.v3"
    tenant_id: NonEmpty
    incident_run_id: NonEmpty
    temporal_workflow_id: NonEmpty
    temporal_run_id: NonEmpty
    temporal_generation: PositiveInt
    updated_at: datetime

    @root_validator(allow_reuse=True)
    def physical_run_is_not_stable_identity(cls, values):
        temporal_run_id = values.get("temporal_run_id")
        if temporal_run_id in {
            values.get("incident_run_id"),
            values.get("temporal_workflow_id"),
        }:
            raise ValueError("temporal_run_id_must_be_physical_execution_identity")
        return values


class TemporalExecutionRolloverV3(StrictModel):
    """Compare-and-swap input for an exact execution-generation rollover."""

    identity: IncidentExecutionIdentityV3
    expected: TemporalExecutionPointerV3
    replacement: TemporalExecutionPointerV3

    @root_validator(allow_reuse=True)
    def replacement_is_exact_next_generation(cls, values):
        identity = values.get("identity")
        expected = values.get("expected")
        replacement = values.get("replacement")
        if identity is None or expected is None or replacement is None:
            return values
        stable = (
            identity.tenant_id,
            identity.incident_run_id,
            identity.temporal_workflow_id,
        )
        if stable != (
            expected.tenant_id,
            expected.incident_run_id,
            expected.temporal_workflow_id,
        ) or stable != (
            replacement.tenant_id,
            replacement.incident_run_id,
            replacement.temporal_workflow_id,
        ):
            raise ValueError("temporal_rollover_stable_identity_mismatch")
        if replacement.temporal_generation != expected.temporal_generation + 1:
            raise ValueError("temporal_rollover_generation_must_increment_once")
        if replacement.temporal_run_id == expected.temporal_run_id:
            raise ValueError("temporal_rollover_requires_new_physical_run")
        return values


class TemporalExecutionTargetV3(StrictModel):
    """Resolved execution target used immediately before describe/signal."""

    temporal_workflow_id: NonEmpty
    temporal_run_id: NonEmpty
    temporal_generation: PositiveInt
    source: NonEmpty


class WorkspaceExecutionRegistrationV3(StrictModel):
    """Activity input used by every V3 workflow execution generation."""

    identity: IncidentExecutionIdentityV3
    current: TemporalExecutionPointerV3
    prior: TemporalExecutionPointerV3 = None

    @root_validator(allow_reuse=True)
    def registration_generation_matches_prior(cls, values):
        identity = values.get("identity")
        current = values.get("current")
        prior = values.get("prior")
        if identity is None or current is None:
            return values
        stable = (
            identity.tenant_id,
            identity.incident_run_id,
            identity.temporal_workflow_id,
        )
        if stable != (
            current.tenant_id,
            current.incident_run_id,
            current.temporal_workflow_id,
        ):
            raise ValueError("workspace_v3_execution_registration_identity_mismatch")
        if prior is None:
            if current.temporal_generation != 1:
                raise ValueError("workspace_v3_first_execution_must_be_generation_one")
            return values
        TemporalExecutionRolloverV3(
            identity=identity,
            expected=prior,
            replacement=current,
        )
        return values


class WorkspaceRolloverStateV3(StrictModel):
    """Bounded durable state carried into the next physical execution."""

    schema_version: NonEmpty = "flowpulse.workspace-rollover-state.v3"
    identity: IncidentExecutionIdentityV3
    current_execution: TemporalExecutionPointerV3
    projection_ref: NonEmpty
    projection_revision: PositiveInt
    signal_revision: PositiveInt
    decision_revision: PositiveInt
    workspace_revision: PositiveInt
    case_event_sequence: PositiveInt
    recent_idempotency_fingerprints: List[NonEmpty] = Field(
        default_factory=list, max_items=128,
    )
    connector_cursor_watermarks: Dict[NonEmpty, NonEmpty] = Field(
        default_factory=dict,
    )
    active_timer_descriptors: List[Dict[NonEmpty, NonEmpty]] = Field(
        default_factory=list, max_items=32,
    )

    @root_validator(allow_reuse=True)
    def carry_state_is_bound_and_bounded(cls, values):
        identity = values.get("identity")
        execution = values.get("current_execution")
        if identity is not None and execution is not None and (
            identity.tenant_id != execution.tenant_id
            or identity.incident_run_id != execution.incident_run_id
            or identity.temporal_workflow_id != execution.temporal_workflow_id
        ):
            raise ValueError("workspace_v3_rollover_state_identity_mismatch")
        fingerprints = values.get("recent_idempotency_fingerprints", [])
        if len(fingerprints) != len(set(fingerprints)):
            raise ValueError("workspace_v3_rollover_fingerprints_must_be_unique")
        if len(values.get("connector_cursor_watermarks", {})) > 32:
            raise ValueError("workspace_v3_rollover_cursor_watermarks_exceed_limit")
        return values


class WorkspaceWorkflowRequestV3(StrictModel):
    """First-start or continue-as-new input for the V3 runtime owner."""

    identity: IncidentExecutionIdentityV3
    carry: Optional[WorkspaceRolloverStateV3] = None
    projection_ref: NonEmpty
    projection_revision: PositiveInt
    signal_revision: PositiveInt
    decision_revision: PositiveInt
    workspace_revision: PositiveInt
    case_event_sequence: PositiveInt

    @root_validator(allow_reuse=True)
    def carry_matches_request_identity(cls, values):
        carry = values.get("carry")
        identity = values.get("identity")
        if carry is not None and identity is not None and carry.identity != identity:
            raise ValueError("workspace_v3_request_carry_identity_mismatch")
        return values


class WorkspaceRevisionAdvanceV3(StrictModel):
    """One accepted durable transition reflected in the V3 workflow state."""

    expected_case_event_sequence: PositiveInt
    case_event_sequence: PositiveInt
    projection_ref: NonEmpty
    projection_revision: PositiveInt
    signal_revision: PositiveInt
    decision_revision: PositiveInt
    workspace_revision: PositiveInt

    @root_validator(allow_reuse=True)
    def transition_is_exact_successor(cls, values):
        expected = values.get("expected_case_event_sequence")
        current = values.get("case_event_sequence")
        if expected is not None and current != expected + 1:
            raise ValueError("workspace_v3_event_sequence_must_increment_once")
        return values


async def resolve_temporal_execution_target_v3(
    repository: Any, binding: Any,
) -> TemporalExecutionTargetV3:
    """Prefer the V3 current pointer and fall back to a frozen V2 binding."""
    resolver = getattr(repository, "current_temporal_execution_v3", None)
    pointer = (
        await resolver(binding.tenant_id, binding.run_id)
        if callable(resolver)
        else None
    )
    if pointer is not None:
        if (
            pointer.tenant_id != binding.tenant_id
            or pointer.incident_run_id != binding.run_id
            or pointer.temporal_workflow_id != binding.workflow_id
        ):
            raise ValueError("workspace_v3_execution_target_binding_mismatch")
        return TemporalExecutionTargetV3(
            temporal_workflow_id=pointer.temporal_workflow_id,
            temporal_run_id=pointer.temporal_run_id,
            temporal_generation=pointer.temporal_generation,
            source="V3_CURRENT_POINTER",
        )
    return TemporalExecutionTargetV3(
        temporal_workflow_id=binding.workflow_id,
        temporal_run_id=binding.workflow_run_id,
        temporal_generation=1,
        source="V2_IMMUTABLE_BINDING",
    )


class ActionInvocationCommandV3(StrictModel):
    """V3 opaque action command, independent of realtime projection ticks."""

    schema_version: NonEmpty = "flowpulse.action-invocation-command.v3"
    incident_id: NonEmpty
    incident_run_id: NonEmpty
    topology_revision: NonEmpty
    decision_revision: PositiveInt
    action_id: NonEmpty
    idempotency_key: NonEmpty
    idempotency_valid_until: datetime

    def canonical_hash(self) -> str:
        return sha256(
            self.json(sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ).hexdigest()


# ---------------------------------------------------------------------------
# Guided V3 Incident workflow public contracts
# ---------------------------------------------------------------------------


class WorkflowStageV3(str, Enum):
    DETECT = "DETECT"
    TRIAGE = "TRIAGE"
    INVESTIGATE = "INVESTIGATE"
    DECIDE = "DECIDE"
    RESPOND = "RESPOND"
    VERIFY = "VERIFY"


WORKFLOW_STAGE_ORDER_V3 = (
    WorkflowStageV3.DETECT,
    WorkflowStageV3.TRIAGE,
    WorkflowStageV3.INVESTIGATE,
    WorkflowStageV3.DECIDE,
    WorkflowStageV3.RESPOND,
    WorkflowStageV3.VERIFY,
)


class WorkflowStageStateV3(str, Enum):
    LOCKED = "LOCKED"
    READY = "READY"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    NEEDS_HUMAN = "NEEDS_HUMAN"
    SUPERSEDED = "SUPERSEDED"


class WorkflowAttemptStateV3(str, Enum):
    ACTIVE = "ACTIVE"
    NEEDS_HUMAN = "NEEDS_HUMAN"
    COMPLETED = "COMPLETED"
    SUPERSEDED = "SUPERSEDED"


class IncidentLifecycleStateV3(str, Enum):
    ACTIVE = "ACTIVE"
    DEGRADED = "DEGRADED"
    AWAITING_OWNER = "AWAITING_OWNER"
    EXECUTING = "EXECUTING"
    MONITORING = "MONITORING"
    RESOLVED = "RESOLVED"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class WorkflowCommandNameV3(str, Enum):
    NEXT = "NEXT"
    RETRY = "RETRY"
    ESCALATE = "ESCALATE"
    RERUN_FROM_STAGE = "RERUN_FROM_STAGE"
    START_AGENT_RUN = "START_AGENT_RUN"
    APPROVE_ACTION = "APPROVE_ACTION"
    REJECT_ACTION = "REJECT_ACTION"
    COMPLETE_INCIDENT = "COMPLETE_INCIDENT"


class WorkflowEventTypeV3(str, Enum):
    SIGNAL_OBSERVED = "signal.observed"
    SIGNAL_STALE = "signal.stale"
    CONNECTOR_HEALTH_CHANGED = "connector.health.changed"
    GRAPH_PULSE_STARTED = "graph.pulse.started"
    GRAPH_PULSE_EXPIRED = "graph.pulse.expired"
    STAGE_STARTED = "workflow.stage.started"
    STAGE_PROGRESS = "workflow.stage.progress"
    STAGE_COMPLETED = "workflow.stage.completed"
    STAGE_FAILED = "workflow.stage.failed"
    ADVANCED = "workflow.advanced"
    STAGE_SUPERSEDED = "workflow.stage.superseded"
    ATTEMPT_BRANCHED = "workflow.attempt.branched"
    ESCALATED = "workflow.escalated"
    AGENT_RUN_STARTED = "agent.run.started"
    AGENT_RUN_PROGRESS = "agent.run.progress"
    AGENT_RUN_COMPLETED = "agent.run.completed"
    AGENT_RUN_FAILED = "agent.run.failed"
    EVIDENCE_QUERY_STARTED = "evidence.query.started"
    EVIDENCE_QUERY_COMPLETED = "evidence.query.completed"
    EVIDENCE_QUERY_FAILED = "evidence.query.failed"
    ACTION_APPROVED = "action.approved"
    ACTION_REJECTED = "action.rejected"
    ACTION_PROPOSED = "action.proposed"
    ACTION_STARTED = "action.started"
    ACTION_COMPLETED = "action.completed"
    ACTION_FAILED = "action.failed"
    VERIFICATION_STARTED = "verification.started"
    VERIFICATION_COMPLETED = "verification.completed"
    VERIFICATION_FAILED = "verification.failed"
    INCIDENT_COMPLETED = "incident.completed"


class AgentRunStateV3(str, Enum):
    READY = "READY"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class EvidenceQueryStateV3(str, Enum):
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class EvidenceQueryNameV3(str, Enum):
    """Closed server-owned query allowlist; these are not model-provided SQL."""

    CURRENT_INCIDENT_SIGNALS = "incident.current-signals.v1"


class ActionApprovalStateV3(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    REVALIDATION_REQUIRED = "REVALIDATION_REQUIRED"


class ActionExecutionStateV3(str, Enum):
    NOT_STARTED = "NOT_STARTED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    ROLLED_BACK = "ROLLED_BACK"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class IncidentActionStatusV3(str, Enum):
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    EXECUTING = "EXECUTING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    REVALIDATION_REQUIRED = "REVALIDATION_REQUIRED"
    ROLLED_BACK = "ROLLED_BACK"
    NEEDS_HUMAN = "NEEDS_HUMAN"


WorkflowProgressV3 = conint(strict=True, ge=0, le=100)
WorkflowReplanCountV3 = conint(strict=True, ge=0, le=1)


class StageFactV3(StrictModel):
    fact_id: NonEmpty
    label: NonEmpty
    value: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=32)


class DecisionDryRunStateV3(str, Enum):
    PASSED = "PASSED"
    FAILED = "FAILED"


class DecisionActionCandidateV3(StrictModel):
    """Code-owned, reviewable action candidate emitted by Decide.

    This is not an execution request.  It records the exact allowlisted
    command that passed deterministic preflight and the decision revision to
    which a later approval must remain bound.
    """

    candidate_id: NonEmpty
    command_id: NonEmpty
    component_id: NonEmpty
    title: NonEmpty
    summary: NonEmpty
    blast_radius: NonEmpty
    risk: NonEmpty
    rollback_plan: NonEmpty
    verification_conditions: List[NonEmpty] = Field(min_items=1, max_items=32)
    dry_run_state: DecisionDryRunStateV3
    dry_run_summary: NonEmpty
    preflight_receipt_id: NonEmpty
    preflight_manifest_hash: NonEmpty
    preflight_checked_at: datetime
    expected_before: NonEmpty
    observed_before: NonEmpty
    mutation_targets: List[NonEmpty] = Field(min_items=1, max_items=16)
    decision_revision: PositiveInt


class StageOutputV3(StrictModel):
    """Bounded current/past result; future stages have no run or output."""

    summary: NonEmpty
    facts: List[StageFactV3] = Field(default_factory=list, max_items=32)
    unknowns: List[NonEmpty] = Field(default_factory=list, max_items=32)
    questions: List[NonEmpty] = Field(default_factory=list, max_items=32)
    hypothesis_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    action_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    observed_at: Optional[datetime] = None
    root_cause: Optional[StrictStr] = None
    recommendation: Optional[StrictStr] = None
    risk: Optional[StrictStr] = None
    rollback: Optional[StrictStr] = None
    verification_conditions: List[NonEmpty] = Field(default_factory=list, max_items=32)
    action_candidate: Optional[DecisionActionCandidateV3] = None
    premise_fingerprint: Optional[StrictStr] = None

    @validator(
        "unknowns", "questions", "hypothesis_ids", "action_ids", "evidence_refs",
        allow_reuse=True,
    )
    def output_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("workflow_v3_stage_output_values_must_be_unique")
        return value


class StageRunV3(StrictModel):
    """One immutable stage-run identity as represented in a projection revision."""

    schema_version: NonEmpty = "flowpulse.workflow-stage-run.v3"
    stage_run_id: NonEmpty
    attempt_id: NonEmpty
    stage: WorkflowStageV3
    status: WorkflowStageStateV3
    run_number: PositiveInt
    input_workflow_revision: PositiveInt
    input_signal_revision: PositiveInt
    input_decision_revision: PositiveInt
    progress_percent: WorkflowProgressV3
    replan_count: WorkflowReplanCountV3 = 0
    summary: Optional[StrictStr] = None
    output: Optional[StageOutputV3] = None
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    failure_code: Optional[StrictStr] = None
    started_at: Optional[datetime] = None
    verification_deadline_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime

    @validator("evidence_refs", allow_reuse=True)
    def evidence_refs_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("workflow_v3_stage_evidence_refs_must_be_unique")
        return value

    @root_validator(allow_reuse=True)
    def lifecycle_fields_match_state(cls, values):
        state = values.get("status")
        started_at = values.get("started_at")
        completed_at = values.get("completed_at")
        verification_deadline_at = values.get("verification_deadline_at")
        stage = values.get("stage")
        if stage == WorkflowStageV3.VERIFY:
            if verification_deadline_at is None:
                raise ValueError("workflow_v3_verify_deadline_required")
            if started_at is None or verification_deadline_at <= started_at:
                raise ValueError("workflow_v3_verification_deadline_invalid")
        elif verification_deadline_at is not None:
            raise ValueError("workflow_v3_verification_deadline_stage_mismatch")
        if state == WorkflowStageStateV3.READY and (
            started_at is not None or completed_at is not None or values.get("progress_percent") != 0
        ):
            raise ValueError("workflow_v3_ready_stage_must_not_be_started")
        if state == WorkflowStageStateV3.RUNNING and (
            started_at is None or completed_at is not None
        ):
            raise ValueError("workflow_v3_running_stage_interval_invalid")
        if state in {
            WorkflowStageStateV3.SUCCEEDED,
            WorkflowStageStateV3.FAILED,
            WorkflowStageStateV3.NEEDS_HUMAN,
            WorkflowStageStateV3.SUPERSEDED,
        } and (started_at is None or completed_at is None):
            raise ValueError("workflow_v3_terminal_stage_requires_interval")
        if completed_at is not None and started_at is not None and completed_at < started_at:
            raise ValueError("workflow_v3_stage_interval_invalid")
        if state == WorkflowStageStateV3.SUCCEEDED and values.get("progress_percent") != 100:
            raise ValueError("workflow_v3_succeeded_stage_requires_complete_progress")
        if state == WorkflowStageStateV3.SUCCEEDED and values.get("output") is None:
            raise ValueError("workflow_v3_succeeded_stage_requires_output")
        if state == WorkflowStageStateV3.SUCCEEDED and not values.get("summary"):
            raise ValueError("workflow_v3_succeeded_stage_requires_summary")
        if state in {WorkflowStageStateV3.READY, WorkflowStageStateV3.RUNNING} and values.get("output") is not None:
            raise ValueError("workflow_v3_incomplete_stage_cannot_publish_output")
        if state == WorkflowStageStateV3.FAILED and not values.get("failure_code"):
            raise ValueError("workflow_v3_failed_stage_requires_failure_code")
        if state not in {WorkflowStageStateV3.FAILED, WorkflowStageStateV3.NEEDS_HUMAN} and values.get("failure_code"):
            raise ValueError("workflow_v3_failure_code_state_mismatch")
        return values


class WorkflowAttemptV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.workflow-attempt.v3"
    attempt_id: NonEmpty
    parent_attempt_id: Optional[StrictStr] = None
    attempt_number: PositiveInt
    current_stage: WorkflowStageV3
    status: WorkflowAttemptStateV3
    workflow_revision: PositiveInt
    created_reason: NonEmpty
    created_at: datetime
    completed_at: Optional[datetime] = None
    stage_runs: List[StageRunV3] = Field(min_items=1, max_items=64)
    action_executed: StrictBool = False
    action_receipt_id: Optional[StrictStr] = None

    @root_validator(allow_reuse=True)
    def stage_history_is_ordered_and_does_not_leak_future_work(cls, values):
        runs = values.get("stage_runs", [])
        attempt_id = values.get("attempt_id")
        current_stage = values.get("current_stage")
        ids = [item.stage_run_id for item in runs]
        if len(ids) != len(set(ids)) or any(item.attempt_id != attempt_id for item in runs):
            raise ValueError("workflow_v3_attempt_stage_run_identity_invalid")
        stage_indexes = {stage: index for index, stage in enumerate(WORKFLOW_STAGE_ORDER_V3)}
        if any(
            stage_indexes[item.stage] > stage_indexes[current_stage]
            and item.status != WorkflowStageStateV3.SUPERSEDED
            for item in runs
        ):
            raise ValueError("workflow_v3_future_stage_run_forbidden")
        current = [item for item in runs if item.stage == current_stage and item.status != WorkflowStageStateV3.SUPERSEDED]
        if values.get("status") == WorkflowAttemptStateV3.SUPERSEDED:
            current = [item for item in runs if item.stage == current_stage]
            if not current:
                raise ValueError("workflow_v3_superseded_attempt_stage_run_required")
        elif len(current) != 1:
            raise ValueError("workflow_v3_current_stage_run_required")
        if values.get("action_executed") != bool(values.get("action_receipt_id")):
            raise ValueError("workflow_v3_action_receipt_execution_mismatch")
        if values.get("status") == WorkflowAttemptStateV3.COMPLETED:
            if current_stage != WorkflowStageV3.VERIFY or current[0].status != WorkflowStageStateV3.SUCCEEDED:
                raise ValueError("workflow_v3_completed_attempt_requires_verified_stage")
            if values.get("completed_at") is None:
                raise ValueError("workflow_v3_completed_attempt_requires_timestamp")
        elif values.get("status") == WorkflowAttemptStateV3.SUPERSEDED:
            if values.get("completed_at") is None:
                raise ValueError("workflow_v3_superseded_attempt_requires_timestamp")
        elif values.get("completed_at") is not None:
            raise ValueError("workflow_v3_active_attempt_cannot_have_completed_at")
        return values


class AgentActivityV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.agent-activity.v3"
    activity_id: NonEmpty
    agent_run_id: NonEmpty
    stage_run_id: NonEmpty
    stage: WorkflowStageV3
    role: NonEmpty
    selected_component_id: Optional[StrictStr] = None
    question: Optional[StrictStr] = None
    bridge_request: Optional["GuidedAgentBridgeRequestV3"] = None
    state: AgentRunStateV3
    label: NonEmpty
    progress_percent: WorkflowProgressV3
    summary: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    occurred_at: datetime
    started_at: datetime
    completed_at: Optional[datetime] = None
    failure_code: Optional[StrictStr] = None

    @root_validator(allow_reuse=True)
    def terminal_agent_activity_is_complete(cls, values):
        state = values.get("state")
        terminal = state in {
            AgentRunStateV3.SUCCEEDED,
            AgentRunStateV3.FAILED,
            AgentRunStateV3.NEEDS_HUMAN,
        }
        if terminal != (values.get("completed_at") is not None):
            raise ValueError("workflow_v3_agent_activity_interval_invalid")
        if state == AgentRunStateV3.SUCCEEDED and values.get("progress_percent") != 100:
            raise ValueError("workflow_v3_agent_success_requires_complete_progress")
        if state == AgentRunStateV3.FAILED and not values.get("failure_code"):
            raise ValueError("workflow_v3_agent_failure_requires_code")
        question = values.get("question")
        if question is not None and len(question) > 1000:
            raise ValueError("workflow_v3_agent_question_too_long")
        bridge_request = values.get("bridge_request")
        if bridge_request is not None and (
            bridge_request.stage_run_id != values.get("stage_run_id")
            or bridge_request.stage != values.get("stage")
            or bridge_request.role != str(values.get("role", "")).lower()
            or (
                values.get("selected_component_id") is not None
                and bridge_request.selected_component
                != values.get("selected_component_id")
            )
            or bridge_request.question != question
        ):
            raise ValueError("workflow_v3_agent_bridge_snapshot_scope_invalid")
        return values


class EvidenceQueryResultV3(StrictModel):
    """Persisted typed result from one code-owned allowlisted evidence query."""

    schema_version: NonEmpty = "flowpulse.evidence-query-result.v3"
    query_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    stage: WorkflowStageV3
    worker_activity_id: NonEmpty
    query_name: EvidenceQueryNameV3
    state: EvidenceQueryStateV3
    parameters_hash: NonEmpty
    result_summary: NonEmpty
    component_ids: List[NonEmpty] = Field(default_factory=list, max_items=64)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=128)
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    observation_timestamps: List[datetime] = Field(default_factory=list, max_items=128)
    triggered_replan: StrictBool = False
    started_at: datetime
    completed_at: Optional[datetime] = None
    failure_code: Optional[StrictStr] = None

    @validator(
        "component_ids", "edge_ids", "evidence_refs", "observation_timestamps",
        allow_reuse=True,
    )
    def evidence_query_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("workflow_v3_evidence_query_values_must_be_unique")
        return value

    @root_validator(allow_reuse=True)
    def evidence_query_state_is_consistent(cls, values):
        state = values.get("state")
        completed_at = values.get("completed_at")
        failure_code = values.get("failure_code")
        if state == EvidenceQueryStateV3.RUNNING:
            if completed_at is not None or failure_code is not None:
                raise ValueError("workflow_v3_running_evidence_query_is_terminal")
            if values.get("triggered_replan"):
                raise ValueError("workflow_v3_running_evidence_query_cannot_replan")
        elif state == EvidenceQueryStateV3.SUCCEEDED:
            if completed_at is None or failure_code is not None:
                raise ValueError("workflow_v3_successful_evidence_query_interval_invalid")
            if not values.get("evidence_refs") or not values.get("observation_timestamps"):
                raise ValueError("workflow_v3_successful_evidence_query_result_required")
        elif state == EvidenceQueryStateV3.FAILED:
            if completed_at is None or not failure_code:
                raise ValueError("workflow_v3_failed_evidence_query_reason_required")
            if values.get("triggered_replan"):
                raise ValueError("workflow_v3_failed_evidence_query_cannot_replan")
        if (
            completed_at is not None
            and values.get("started_at") is not None
            and completed_at < values.get("started_at")
        ):
            raise ValueError("workflow_v3_evidence_query_interval_invalid")
        return values


class WorkflowHypothesisV3(StrictModel):
    hypothesis_id: NonEmpty
    stage_run_id: NonEmpty
    statement: NonEmpty
    confidence: UnitIntervalFloat
    supporting_evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=64)
    contradicting_evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=64)
    falsification_condition: NonEmpty
    status: NonEmpty


class IncidentActionV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.incident-action.v3"
    action_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    title: NonEmpty
    summary: NonEmpty
    component_id: NonEmpty
    command_id: NonEmpty
    command_label: NonEmpty
    decision_revision: PositiveInt
    required_permission: NonEmpty
    approval_state: ActionApprovalStateV3
    execution_state: ActionExecutionStateV3
    status: IncidentActionStatusV3
    blast_radius: NonEmpty
    risk: NonEmpty
    rollback_plan: NonEmpty
    verification_conditions: List[NonEmpty] = Field(min_items=1, max_items=32)
    receipt: Optional["ActionExecutionReceiptV3"] = None
    rollback_receipt: Optional["ActionRollbackReceiptV3"] = None

    @root_validator(allow_reuse=True)
    def execution_requires_approval_and_receipt(cls, values):
        execution_state = values.get("execution_state")
        executed = execution_state in {
            ActionExecutionStateV3.SUCCEEDED,
            ActionExecutionStateV3.FAILED,
            ActionExecutionStateV3.ROLLED_BACK,
            ActionExecutionStateV3.NEEDS_HUMAN,
        }
        if executed and values.get("approval_state") != ActionApprovalStateV3.APPROVED:
            raise ValueError("workflow_v3_action_execution_requires_approval")
        if executed != bool(values.get("receipt")):
            raise ValueError("workflow_v3_action_execution_receipt_mismatch")
        if (
            execution_state == ActionExecutionStateV3.ROLLED_BACK
        ) != bool(values.get("rollback_receipt")):
            raise ValueError("workflow_v3_action_rollback_receipt_mismatch")
        expected_status = {
            ActionApprovalStateV3.PENDING: IncidentActionStatusV3.AWAITING_APPROVAL,
            ActionApprovalStateV3.REJECTED: IncidentActionStatusV3.REJECTED,
            ActionApprovalStateV3.REVALIDATION_REQUIRED: IncidentActionStatusV3.REVALIDATION_REQUIRED,
        }.get(values.get("approval_state"))
        if values.get("approval_state") == ActionApprovalStateV3.APPROVED:
            expected_status = {
                ActionExecutionStateV3.NOT_STARTED: IncidentActionStatusV3.APPROVED,
                ActionExecutionStateV3.RUNNING: IncidentActionStatusV3.EXECUTING,
                ActionExecutionStateV3.SUCCEEDED: IncidentActionStatusV3.SUCCEEDED,
                ActionExecutionStateV3.FAILED: IncidentActionStatusV3.FAILED,
                ActionExecutionStateV3.ROLLED_BACK: IncidentActionStatusV3.ROLLED_BACK,
                ActionExecutionStateV3.NEEDS_HUMAN: IncidentActionStatusV3.NEEDS_HUMAN,
            }.get(values.get("execution_state"))
        if expected_status is not None and values.get("status") != expected_status:
            raise ValueError("workflow_v3_action_status_mismatch")
        return values


class ActionExecutionReceiptV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.action-execution-receipt.v3"
    receipt_id: NonEmpty
    executor_id: NonEmpty
    command_id: NonEmpty
    status: ActionExecutionStateV3
    started_at: datetime
    completed_at: datetime
    output_summary: NonEmpty
    rollback_status: Optional[StrictStr] = None

    @root_validator(allow_reuse=True)
    def execution_interval_is_ordered(cls, values):
        if values.get("completed_at") < values.get("started_at"):
            raise ValueError("workflow_v3_action_receipt_interval_invalid")
        if values.get("status") not in {
            ActionExecutionStateV3.SUCCEEDED,
            ActionExecutionStateV3.FAILED,
            ActionExecutionStateV3.ROLLED_BACK,
            ActionExecutionStateV3.NEEDS_HUMAN,
        }:
            raise ValueError("workflow_v3_action_receipt_requires_terminal_status")
        return values


class ActionRollbackReceiptV3(StrictModel):
    """Immutable receipt returned by the independent safe-rollback port."""

    schema_version: NonEmpty = "flowpulse.action-rollback-receipt.v3"
    rollback_receipt_id: NonEmpty
    execution_key: NonEmpty
    action_id: NonEmpty
    command_id: NonEmpty
    status: ActionExecutionStateV3
    started_at: datetime
    completed_at: datetime
    output_summary: NonEmpty

    @root_validator(allow_reuse=True)
    def rollback_receipt_is_terminal_and_ordered(cls, values):
        if values.get("status") != ActionExecutionStateV3.ROLLED_BACK:
            raise ValueError("workflow_v3_safe_rollback_not_terminal")
        if values.get("completed_at") < values.get("started_at"):
            raise ValueError("workflow_v3_safe_rollback_interval_invalid")
        return values


IncidentActionV3.update_forward_refs(
    ActionExecutionReceiptV3=ActionExecutionReceiptV3,
    ActionRollbackReceiptV3=ActionRollbackReceiptV3,
)


class WorkflowAuditRecordTypeV3(str, Enum):
    ATTEMPT_CREATED = "ATTEMPT_CREATED"
    STAGE_COMPLETED = "STAGE_COMPLETED"
    STAGE_FAILED = "STAGE_FAILED"
    STAGE_SUPERSEDED = "STAGE_SUPERSEDED"
    ATTEMPT_BRANCHED = "ATTEMPT_BRANCHED"
    APPROVAL_RECORDED = "APPROVAL_RECORDED"
    ACTION_RECEIPT_RECORDED = "ACTION_RECEIPT_RECORDED"
    VERIFICATION_RECORDED = "VERIFICATION_RECORDED"
    ESCALATION_RECORDED = "ESCALATION_RECORDED"
    ROLLBACK_OUTCOME = "ROLLBACK_OUTCOME"
    INCIDENT_COMPLETED = "INCIDENT_COMPLETED"


class WorkflowAuditRecordV3(StrictModel):
    """Append-only audit material retained across attempt branches."""

    schema_version: NonEmpty = "flowpulse.workflow-audit-record.v3"
    audit_id: NonEmpty
    record_type: WorkflowAuditRecordTypeV3
    attempt_id: NonEmpty
    parent_attempt_id: Optional[StrictStr] = None
    stage: Optional[WorkflowStageV3] = None
    stage_run_id: Optional[StrictStr] = None
    action_id: Optional[StrictStr] = None
    actor_subject_id: Optional[StrictStr] = None
    workflow_revision: PositiveInt
    decision_revision: PositiveInt
    summary: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    stage_output: Optional[StageOutputV3] = None
    approval_decision: Optional[StrictStr] = None
    action_receipt: Optional[ActionExecutionReceiptV3] = None
    rollback_receipt: Optional[ActionRollbackReceiptV3] = None
    recorded_at: datetime

    @validator("evidence_refs", allow_reuse=True)
    def audit_evidence_refs_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("workflow_v3_audit_evidence_refs_must_be_unique")
        return value

    @validator("approval_decision", allow_reuse=True)
    def audit_approval_decision_is_bounded(cls, value):
        if value is not None and value not in {"APPROVE", "REJECT"}:
            raise ValueError("workflow_v3_audit_approval_decision_invalid")
        return value


class IncidentAuditReportV3(StrictModel):
    """Immutable report descriptor generated only after Verify succeeds."""

    schema_version: NonEmpty = "flowpulse.incident-audit-report.v3"
    report_id: NonEmpty
    attempt_id: NonEmpty
    attempt_lineage: List[NonEmpty] = Field(min_items=1, max_items=32)
    workflow_revision: PositiveInt
    decision_revision: PositiveInt
    stage_output_audit_ids: List[NonEmpty] = Field(min_items=1, max_items=64)
    action_receipt_audit_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    verification_evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=128)
    generated_at: datetime
    content_hash: NonEmpty

    @validator(
        "attempt_lineage", "stage_output_audit_ids", "action_receipt_audit_ids",
        "verification_evidence_refs", allow_reuse=True,
    )
    def report_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("workflow_v3_report_values_must_be_unique")
        return value


class FreshnessV3(StrictModel):
    state: FreshnessStatus
    observed_at: datetime
    fresh_until: datetime

    @root_validator(allow_reuse=True)
    def interval_is_ordered(cls, values):
        observed_at = values.get("observed_at")
        fresh_until = values.get("fresh_until")
        if observed_at is not None and fresh_until is not None and fresh_until < observed_at:
            raise ValueError("workflow_v3_freshness_interval_invalid")
        return values


class ConnectorStatusV3(StrictModel):
    connector_id: NonEmpty
    provider: NonEmpty
    state: NonEmpty
    observed_at: datetime
    fresh_until: Optional[datetime] = None
    lag_seconds: conint(strict=True, ge=0) = 0
    truth_label: NonEmpty


class IncidentGraphV3(StrictModel):
    nodes: List[IncidentGraphNode]
    edges: List[IncidentGraphEdge]
    active_pulses: List[GraphPulse] = Field(default_factory=list, max_items=32)

    @root_validator(allow_reuse=True)
    def topology_and_pulses_are_canonical(cls, values):
        graph = IncidentGraph(
            nodes=values.get("nodes", []),
            edges=values.get("edges", []),
        )
        edge_ids = {item.edge_id for item in graph.edges}
        if any(not set(item.edge_ids).issubset(edge_ids) for item in values.get("active_pulses", [])):
            raise ValueError("workflow_v3_graph_pulse_edge_unknown")
        return values


class IncidentProjectionV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.incident-projection.v3"
    tenant_id: NonEmpty
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    projection_revision: PositiveInt
    sequence: PositiveInt
    signal_revision: PositiveInt
    decision_revision: PositiveInt
    workspace_revision: PositiveInt
    workflow_revision: PositiveInt
    current_premise_fingerprint: Optional[StrictStr] = None
    title: NonEmpty
    summary: NonEmpty
    severity: NonEmpty
    owner_subject_id: NonEmpty
    lifecycle_state: IncidentLifecycleStateV3
    incident_clock: IncidentClock
    freshness: FreshnessV3
    graph: IncidentGraphV3
    impacted_path: List[NonEmpty] = Field(default_factory=list, max_items=64)
    connectors: List[ConnectorStatusV3] = Field(default_factory=list, max_items=16)
    current_attempt: WorkflowAttemptV3
    attempt_history: List[WorkflowAttemptV3] = Field(default_factory=list, max_items=31)
    available_commands: List[WorkflowCommandNameV3] = Field(default_factory=list, max_items=8)
    available_rerun_stages: List[WorkflowStageV3] = Field(default_factory=list, max_items=6)
    agent_activity: List[AgentActivityV3] = Field(default_factory=list, max_items=128)
    evidence_queries: List[EvidenceQueryResultV3] = Field(default_factory=list, max_items=128)
    hypotheses: List[WorkflowHypothesisV3] = Field(default_factory=list, max_items=64)
    actions: List[IncidentActionV3] = Field(default_factory=list, max_items=32)
    audit_records: List[WorkflowAuditRecordV3] = Field(default_factory=list, max_items=256)
    final_report: Optional[IncidentAuditReportV3] = None
    resolved_series_snapshot: Optional[MetricSeriesCollectionV3] = None
    generated_at: datetime

    @root_validator(allow_reuse=True)
    def attempt_and_outputs_are_current_or_historical_only(cls, values):
        attempt = values.get("current_attempt")
        if attempt is None:
            return values
        if attempt.workflow_revision != values.get("workflow_revision"):
            raise ValueError("workflow_v3_projection_attempt_revision_mismatch")
        history = values.get("attempt_history", [])
        attempt_ids = [item.attempt_id for item in history]
        if len(attempt_ids) != len(set(attempt_ids)) or attempt.attempt_id in set(attempt_ids):
            raise ValueError("workflow_v3_attempt_history_identity_invalid")
        known_attempts = {item.attempt_id: item for item in [*history, attempt]}
        if any(
            item.parent_attempt_id is not None
            and item.parent_attempt_id not in known_attempts
            for item in [*history, attempt]
        ):
            raise ValueError("workflow_v3_attempt_parent_unknown")
        known_stage_runs = {
            item.stage_run_id
            for known_attempt in known_attempts.values()
            for item in known_attempt.stage_runs
        }
        stage_run_attempts = {
            item.stage_run_id: known_attempt.attempt_id
            for known_attempt in known_attempts.values()
            for item in known_attempt.stage_runs
        }
        if any(item.stage_run_id not in known_stage_runs for item in values.get("agent_activity", [])):
            raise ValueError("workflow_v3_agent_activity_stage_run_unknown")
        activity_by_id = {
            item.activity_id: item for item in values.get("agent_activity", [])
        }
        evidence_queries = values.get("evidence_queries", [])
        query_ids = [item.query_id for item in evidence_queries]
        if len(query_ids) != len(set(query_ids)):
            raise ValueError("workflow_v3_evidence_query_identity_invalid")
        if any(
            item.stage_run_id not in known_stage_runs
            or item.attempt_id not in known_attempts
            or stage_run_attempts.get(item.stage_run_id) != item.attempt_id
            or item.worker_activity_id not in activity_by_id
            or activity_by_id[item.worker_activity_id].stage_run_id != item.stage_run_id
            or activity_by_id[item.worker_activity_id].role != "EVIDENCE_WORKER"
            for item in evidence_queries
        ):
            raise ValueError("workflow_v3_evidence_query_scope_invalid")
        if any(item.stage_run_id not in known_stage_runs for item in values.get("hypotheses", [])):
            raise ValueError("workflow_v3_hypothesis_stage_run_unknown")
        if any(
            item.stage_run_id not in known_stage_runs
            or item.attempt_id not in known_attempts
            or stage_run_attempts.get(item.stage_run_id) != item.attempt_id
            for item in values.get("actions", [])
        ):
            raise ValueError("workflow_v3_action_attempt_or_stage_run_unknown")
        graph = values.get("graph")
        if graph is not None:
            nodes = {node.component_id for node in graph.nodes}
            if not set(values.get("impacted_path", [])).issubset(nodes):
                raise ValueError("workflow_v3_impacted_path_component_unknown")
        commands = values.get("available_commands", [])
        if len(commands) != len(set(commands)):
            raise ValueError("workflow_v3_available_commands_must_be_unique")
        rerun_stages = values.get("available_rerun_stages", [])
        if (
            not rerun_stages
            and WorkflowCommandNameV3.RERUN_FROM_STAGE in commands
        ):
            if attempt.action_executed:
                rerun_stages = [
                    WorkflowStageV3.INVESTIGATE, WorkflowStageV3.DECIDE,
                ]
            else:
                current_index = WORKFLOW_STAGE_ORDER_V3.index(attempt.current_stage)
                known = {item.stage for item in attempt.stage_runs}
                rerun_stages = [
                    stage for stage in WORKFLOW_STAGE_ORDER_V3[:current_index + 1]
                    if stage in known
                ]
            values["available_rerun_stages"] = rerun_stages
        if len(rerun_stages) != len(set(rerun_stages)):
            raise ValueError("workflow_v3_available_rerun_stages_must_be_unique")
        if bool(rerun_stages) != (
            WorkflowCommandNameV3.RERUN_FROM_STAGE in commands
        ):
            raise ValueError("workflow_v3_available_rerun_stages_command_mismatch")
        audit_records = values.get("audit_records", [])
        audit_ids = [item.audit_id for item in audit_records]
        if len(audit_ids) != len(set(audit_ids)):
            raise ValueError("workflow_v3_audit_record_identity_invalid")
        if any(item.attempt_id not in known_attempts for item in audit_records):
            raise ValueError("workflow_v3_audit_attempt_unknown")
        final_report = values.get("final_report")
        if final_report is not None:
            if (
                values.get("lifecycle_state") != IncidentLifecycleStateV3.RESOLVED
                or attempt.status != WorkflowAttemptStateV3.COMPLETED
                or final_report.attempt_id != attempt.attempt_id
                or not set(final_report.stage_output_audit_ids).issubset(set(audit_ids))
                or not set(final_report.action_receipt_audit_ids).issubset(set(audit_ids))
            ):
                raise ValueError("workflow_v3_final_report_scope_invalid")
        resolved_series = values.get("resolved_series_snapshot")
        if resolved_series is not None and (
            values.get("lifecycle_state") != IncidentLifecycleStateV3.RESOLVED
            or attempt.status != WorkflowAttemptStateV3.COMPLETED
            or resolved_series.case_id != values.get("case_id")
            or resolved_series.signal_revision != values.get("signal_revision")
        ):
            raise ValueError("workflow_v3_resolved_series_scope_invalid")
        return values


class WorkflowCommandV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.workflow-command.v3"
    attempt_id: NonEmpty
    expected_stage: WorkflowStageV3
    expected_workflow_revision: PositiveInt
    idempotency_key: NonEmpty

    @validator("idempotency_key", allow_reuse=True)
    def idempotency_key_is_bounded(cls, value):
        if len(value) > 200:
            raise ValueError("workflow_v3_idempotency_key_too_long")
        return value

    def canonical_hash(self) -> str:
        return sha256(self.json(sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


class WorkflowRerunCommandV3(WorkflowCommandV3):
    reason: NonEmpty

    @validator("reason", allow_reuse=True)
    def reason_is_bounded(cls, value):
        if len(value) > 500:
            raise ValueError("workflow_v3_reason_too_long")
        return value


class WorkflowEscalationCommandV3(WorkflowRerunCommandV3):
    pass


class AgentRunCommandV3(WorkflowCommandV3):
    component_id: Optional[StrictStr] = None
    question: Optional[StrictStr] = None

    @validator("question", allow_reuse=True)
    def question_is_bounded(cls, value):
        if value is not None and len(value) > 1000:
            raise ValueError("workflow_v3_agent_question_too_long")
        return value


class ActionApprovalDecisionV3(str, Enum):
    APPROVE = "APPROVE"
    REJECT = "REJECT"


class WorkflowTemporalOperationV3(str, Enum):
    ADVANCE = "ADVANCE"
    RERUN = "RERUN"
    ESCALATE = "ESCALATE"
    AGENT_RUN = "AGENT_RUN"
    ACTION_APPROVAL = "ACTION_APPROVAL"


class ActionApprovalCommandV3(WorkflowCommandV3):
    decision: ActionApprovalDecisionV3
    expected_decision_revision: PositiveInt
    reason: Optional[StrictStr] = None

    @validator("reason", allow_reuse=True)
    def optional_reason_is_bounded(cls, value):
        if value is not None and len(value) > 500:
            raise ValueError("workflow_v3_reason_too_long")
        return value


class WorkflowTemporalCommandV3(StrictModel):
    """Server-created Temporal activity packet; browser authority is excluded."""

    operation: WorkflowTemporalOperationV3
    tenant_id: NonEmpty
    case_id: NonEmpty
    actor_subject_id: NonEmpty
    actor_roles: List[NonEmpty] = Field(default_factory=list, max_items=16)
    command: Dict[str, Any]
    target_stage: Optional[WorkflowStageV3] = None
    action_id: Optional[StrictStr] = None

    @root_validator(allow_reuse=True)
    def path_owned_target_matches_operation(cls, values):
        operation = values.get("operation")
        if (operation == WorkflowTemporalOperationV3.RERUN) != bool(values.get("target_stage")):
            raise ValueError("workflow_v3_temporal_rerun_target_mismatch")
        if (operation == WorkflowTemporalOperationV3.ACTION_APPROVAL) != bool(values.get("action_id")):
            raise ValueError("workflow_v3_temporal_action_target_mismatch")
        return values


class GuidedStageActivityPacketV3(StrictModel):
    """Temporal-owned request to run only the already-started current stage."""

    schema_version: NonEmpty = "flowpulse.guided-stage-activity.v3"
    tenant_id: NonEmpty
    case_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    stage: WorkflowStageV3
    expected_workflow_revision: PositiveInt
    actor_subject_id: NonEmpty
    verification_deadline_reached: StrictBool = False


class GuidedStageActivityStatusV3(str, Enum):
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    WAITING = "WAITING"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    NEEDS_HUMAN = "NEEDS_HUMAN"


class GuidedStageActivityOutcomeV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-stage-activity-outcome.v3"
    status: GuidedStageActivityStatusV3
    projection: IncidentProjectionV3
    reason: Optional[StrictStr] = None


class GuidedAgentEvidenceFactV3(StrictModel):
    """A bounded, redacted canonical signal safe for explanatory model context."""

    fact_id: NonEmpty
    label: NonEmpty
    value: NonEmpty
    observed_at: datetime
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=32)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=32)
    evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=32)


class GuidedAgentBridgeRequestV3(StrictModel):
    """Redacted exact-schema request sent to the hardened Node Codex bridge."""

    schema_version: NonEmpty = "flowpulse.guided-agent-bridge-request.v3"
    request_id: NonEmpty
    case_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    stage: WorkflowStageV3
    role: NonEmpty
    selected_component: NonEmpty
    question: Optional[StrictStr] = None
    incident_title: NonEmpty
    incident_summary: NonEmpty
    freshness: FreshnessV3
    component_ids: List[NonEmpty] = Field(min_items=1, max_items=64)
    edge_ids: List[NonEmpty] = Field(default_factory=list, max_items=128)
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    evidence_facts: List[GuidedAgentEvidenceFactV3] = Field(default_factory=list, max_items=32)
    query_outcomes: List[EvidenceQueryResultV3] = Field(default_factory=list, max_items=16)
    hypotheses: List[WorkflowHypothesisV3] = Field(default_factory=list, max_items=32)

    @validator("question", allow_reuse=True)
    def question_is_bounded(cls, value):
        if value is not None and len(value) > 1000:
            raise ValueError("workflow_v3_agent_question_too_long")
        return value

    @root_validator(allow_reuse=True)
    def safe_context_is_bounded_to_canonical_identity(cls, values):
        components = set(values.get("component_ids", []))
        edges = set(values.get("edge_ids", []))
        evidence = set(values.get("evidence_refs", []))
        for fact in values.get("evidence_facts", []):
            if (
                not set(fact.component_ids).issubset(components)
                or not set(fact.edge_ids).issubset(edges)
                or not set(fact.evidence_refs).issubset(evidence)
            ):
                raise ValueError("workflow_v3_agent_fact_not_canonical")
        for query in values.get("query_outcomes", []):
            if (
                not set(query.component_ids).issubset(components)
                or not set(query.edge_ids).issubset(edges)
                or not set(query.evidence_refs).issubset(evidence)
            ):
                raise ValueError("workflow_v3_agent_query_not_canonical")
        for hypothesis in values.get("hypotheses", []):
            if not (
                set(hypothesis.supporting_evidence_refs)
                | set(hypothesis.contradicting_evidence_refs)
            ).issubset(evidence):
                raise ValueError("workflow_v3_agent_hypothesis_not_canonical")
        return values


AgentActivityV3.update_forward_refs(
    GuidedAgentBridgeRequestV3=GuidedAgentBridgeRequestV3,
)


class GuidedAgentBridgeResponseV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-agent-bridge-response.v3"
    request_id: NonEmpty
    provider: NonEmpty
    model: NonEmpty
    answer: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)
    tool_requests: List[Dict[str, Any]] = Field(default_factory=list, max_items=2)


class GuidedActionPreflightRequestV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-action-preflight-request.v3"
    request_id: NonEmpty
    case_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    command_id: NonEmpty
    target_component_id: NonEmpty
    decision_revision: PositiveInt
    expected_before: NonEmpty = "paymentUnreachable=on"


class GuidedActionPreflightResponseV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-action-preflight-response.v3"
    request_id: NonEmpty
    receipt_id: NonEmpty
    command_id: NonEmpty
    target_component_id: NonEmpty
    flag_name: NonEmpty
    expected_variant: NonEmpty
    observed_variant: NonEmpty
    mutation_targets: List[NonEmpty] = Field(min_items=1, max_items=16)
    blast_radius: NonEmpty
    manifest_hash: NonEmpty
    rollback_supported: StrictBool
    passed: StrictBool
    summary: NonEmpty
    checked_at: datetime


class GuidedActionActivityPacketV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-action-activity.v3"
    tenant_id: NonEmpty
    case_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    action_id: NonEmpty
    expected_workflow_revision: PositiveInt
    actor_subject_id: NonEmpty


class GuidedAgentActivityPacketV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-agent-activity.v3"
    tenant_id: NonEmpty
    case_id: NonEmpty
    attempt_id: NonEmpty
    stage_run_id: NonEmpty
    agent_run_id: NonEmpty
    expected_workflow_revision: PositiveInt
    actor_subject_id: NonEmpty


class GuidedActionBridgeRequestV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-action-bridge-request.v3"
    execution_key: NonEmpty
    action_id: NonEmpty
    attempt_id: NonEmpty
    command_id: NonEmpty
    decision_revision: PositiveInt
    expected_before: NonEmpty = "paymentUnreachable=on"
    expected_after: NonEmpty = "paymentUnreachable=off"


class GuidedActionBridgeResponseV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.guided-action-bridge-response.v3"
    execution_key: NonEmpty
    command_id: NonEmpty
    reused: StrictBool
    started_at: datetime
    completed_at: datetime
    output_summary: NonEmpty
    before: NonEmpty
    after: NonEmpty

    @root_validator(allow_reuse=True)
    def bridge_execution_is_ordered_and_exact(cls, values):
        if values.get("completed_at") < values.get("started_at"):
            raise ValueError("workflow_v3_action_bridge_interval_invalid")
        if values.get("before") != "paymentUnreachable=on" or values.get("after") != "paymentUnreachable=off":
            raise ValueError("workflow_v3_action_bridge_precondition_mismatch")
        return values


class GuidedRollbackBridgeResponseV3(ActionRollbackReceiptV3):
    schema_version: NonEmpty = "flowpulse.guided-rollback-bridge-response.v3"


class WorkflowCommandReceiptV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.workflow-command-receipt.v3"
    command_id: NonEmpty
    command_name: WorkflowCommandNameV3
    accepted: StrictBool
    reused: StrictBool = False
    reason: Optional[StrictStr] = None
    actor_subject_id: NonEmpty
    attempt_id: NonEmpty
    workflow_revision: PositiveInt
    projection: IncidentProjectionV3
    recorded_at: datetime

    @root_validator(allow_reuse=True)
    def command_attempt_is_in_result_lineage(cls, values):
        projection = values.get("projection")
        attempt_id = values.get("attempt_id")
        if projection is None or attempt_id is None:
            return values
        lineage = {
            projection.current_attempt.attempt_id,
            *[item.attempt_id for item in projection.attempt_history],
        }
        if attempt_id not in lineage:
            raise ValueError("workflow_v3_receipt_attempt_not_in_lineage")
        if values.get("workflow_revision") != projection.workflow_revision:
            raise ValueError("workflow_v3_receipt_revision_mismatch")
        return values


class IncidentEventV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.incident-event.v3"
    event_id: NonEmpty
    tenant_id: NonEmpty
    case_id: NonEmpty
    sequence: PositiveInt
    event_type: WorkflowEventTypeV3
    occurred_at: datetime
    projection_revision: PositiveInt
    workflow_revision: PositiveInt
    attempt_id: Optional[StrictStr] = None
    stage: Optional[WorkflowStageV3] = None
    stage_run_id: Optional[StrictStr] = None
    actor_subject_id: Optional[StrictStr] = None
    summary: Optional[StrictStr] = None
    progress: Optional[WorkflowProgressV3] = None
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=128)


class LiveIncidentSummaryV3(StrictModel):
    case_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    projection_revision: PositiveInt
    sequence: PositiveInt
    title: NonEmpty
    summary: NonEmpty
    severity: NonEmpty
    lifecycle_state: IncidentLifecycleStateV3
    freshness: FreshnessV3
    impacted_components: List[NonEmpty] = Field(min_items=1, max_items=64)
    current_stage: WorkflowStageV3

    @classmethod
    def from_projection(cls, projection: IncidentProjectionV3) -> "LiveIncidentSummaryV3":
        return cls(
            case_id=projection.case_id,
            incident_id=projection.incident_id,
            run_id=projection.run_id,
            topology_revision=projection.topology_revision,
            projection_revision=projection.projection_revision,
            sequence=projection.sequence,
            title=projection.title,
            summary=projection.summary,
            severity=projection.severity,
            lifecycle_state=projection.lifecycle_state,
            freshness=projection.freshness,
            impacted_components=projection.impacted_path,
            current_stage=projection.current_attempt.current_stage,
        )


class LiveSnapshotV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.live-snapshot.v3"
    generated_at: datetime
    sequence: conint(strict=True, ge=0)
    incidents: List[LiveIncidentSummaryV3] = Field(default_factory=list, max_items=100)


class LiveEventV3(StrictModel):
    schema_version: NonEmpty = "flowpulse.live-event.v3"
    event_id: NonEmpty
    sequence: PositiveInt
    event_type: NonEmpty
    occurred_at: datetime
    incident: LiveIncidentSummaryV3


class WorkflowTransitionCommitV3(StrictModel):
    """Atomic repository packet for a command result and ordered event batch."""

    tenant_id: NonEmpty
    case_id: NonEmpty
    idempotency_key: NonEmpty
    command_hash: NonEmpty
    expected_workflow_revision: PositiveInt
    projection: IncidentProjectionV3
    events: List[IncidentEventV3] = Field(min_items=1, max_items=64)
    receipt: WorkflowCommandReceiptV3

    @root_validator(allow_reuse=True)
    def commit_is_one_ordered_transition(cls, values):
        projection = values.get("projection")
        events = values.get("events", [])
        receipt = values.get("receipt")
        if projection is None or receipt is None:
            return values
        if (
            projection.tenant_id != values.get("tenant_id")
            or projection.case_id != values.get("case_id")
            or receipt.projection != projection
            or receipt.workflow_revision != projection.workflow_revision
        ):
            raise ValueError("workflow_v3_commit_scope_mismatch")
        if [item.sequence for item in events] != list(range(events[0].sequence, events[-1].sequence + 1)):
            raise ValueError("workflow_v3_commit_events_not_contiguous")
        if any(
            item.tenant_id != projection.tenant_id
            or item.case_id != projection.case_id
            or item.workflow_revision != projection.workflow_revision
            for item in events
        ):
            raise ValueError("workflow_v3_commit_event_scope_mismatch")
        if events[-1].sequence != projection.sequence:
            raise ValueError("workflow_v3_commit_projection_sequence_mismatch")
        return values


class WorkflowRealtimeSyncCommitV3(StrictModel):
    """Signal-domain CAS that never changes workflow or decision revision."""

    tenant_id: NonEmpty
    case_id: NonEmpty
    sync_key: NonEmpty
    sync_hash: NonEmpty
    expected_projection_revision: PositiveInt
    projection: IncidentProjectionV3
    events: List[IncidentEventV3] = Field(min_items=1, max_items=4)

    @root_validator(allow_reuse=True)
    def sync_is_signal_only_and_ordered(cls, values):
        projection = values.get("projection")
        events = values.get("events", [])
        if projection is None or not events:
            return values
        if (
            projection.tenant_id != values.get("tenant_id")
            or projection.case_id != values.get("case_id")
            or events[-1].sequence != projection.sequence
            or [item.sequence for item in events]
            != list(range(events[0].sequence, events[-1].sequence + 1))
        ):
            raise ValueError("workflow_v3_realtime_sync_scope_or_order_invalid")
        if any(
            item.tenant_id != projection.tenant_id
            or item.case_id != projection.case_id
            or item.projection_revision != projection.projection_revision
            or item.workflow_revision != projection.workflow_revision
            for item in events
        ):
            raise ValueError("workflow_v3_realtime_sync_event_scope_invalid")
        return values

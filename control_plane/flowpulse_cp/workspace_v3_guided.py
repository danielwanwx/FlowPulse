"""Deterministic, append-only command layer for the guided V3 workflow.

Temporal may replay these transitions because identifiers and decisions depend
only on the canonical projection, command, and workflow clock supplied by the
caller. Repository commits remain the durable compare-and-swap boundary.
"""

import json
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Iterable, List, Optional, Sequence

from .models import EvidenceAuthority, FreshnessStatus
from .policy import PolicyViolation
from .realtime_models import (
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorTruthLabel,
    IncidentClockState,
    IncidentProjectionV2,
    RealtimeSignal,
    RealtimeSignalStatus,
)
from .workspace_v3_models import (
    ActionApprovalCommandV3,
    ActionApprovalDecisionV3,
    ActionApprovalStateV3,
    ActionExecutionReceiptV3,
    ActionRollbackReceiptV3,
    ActionExecutionStateV3,
    AgentActivityV3,
    AgentRunCommandV3,
    AgentRunStateV3,
    GuidedAgentBridgeRequestV3,
    ConnectorStatusV3,
    DecisionActionCandidateV3,
    EvidenceQueryResultV3,
    EvidenceQueryStateV3,
    FreshnessV3,
    IncidentAuditReportV3,
    IncidentActionV3,
    IncidentEventV3,
    IncidentLifecycleStateV3,
    IncidentActionStatusV3,
    IncidentGraphV3,
    IncidentProjectionV3,
    StageFactV3,
    StageOutputV3,
    StageRunV3,
    WorkflowAuditRecordTypeV3,
    WorkflowAuditRecordV3,
    WorkflowAttemptStateV3,
    WorkflowAttemptV3,
    WorkflowCommandNameV3,
    WorkflowCommandReceiptV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowEventTypeV3,
    WorkflowRerunCommandV3,
    WorkflowRealtimeSyncCommitV3,
    WorkflowStageStateV3,
    WorkflowStageV3,
    WorkflowTransitionCommitV3,
    WorkflowHypothesisV3,
    WORKFLOW_STAGE_ORDER_V3,
)


def _stable_id(prefix: str, *parts: object) -> str:
    material = ":".join(str(part) for part in parts)
    return "{}-{}".format(prefix, sha256(material.encode("utf-8")).hexdigest()[:24])


ASTRONOMY_REPAIR_COMMAND_V3 = "astronomy.restore-payment-and-recreate-checkout"

DETECT_METRIC_SIGNAL_KINDS_V3 = (
    "CHECKOUT_PAYMENT_ERROR_RATE",
    "CHECKOUT_PAYMENT_MEAN_LATENCY",
    "CHECKOUT_PAYMENT_REQUEST_COUNT",
)
DETECT_OBSERVATION_SUMMARY_V3 = (
    "Current telemetry shows Checkout to Payment request failures with live "
    "error-rate, latency, and request-count samples."
)


def _stage_index(stage: WorkflowStageV3) -> int:
    return WORKFLOW_STAGE_ORDER_V3.index(stage)


def _latest_signal(signals: Sequence[RealtimeSignal]) -> RealtimeSignal:
    return max(
        signals,
        key=lambda item: (item.observed_at, item.sequence, item.signal_id),
    )


def _qualified_detect_signals_v3(
    source: IncidentProjectionV2,
    current_signals: Sequence[RealtimeSignal],
) -> List[RealtimeSignal]:
    """Return the four observed facts that are sufficient to finish Detect.

    A generic log, an isolated component metric, or connector health alone is
    not an incident-detection result.  The accepted V2 projection must contain
    a current T0 OTel client failure on the canonical Checkout -> Payment edge
    and one current T0 OTel sample for each metric card rendered by Detect.
    Scalar metric observations deliberately carry no edge IDs in the V2 truth
    plane; the trace is the only fact allowed to prove the dependency failure.
    """

    checkout_payment_edges = {
        edge.edge_id
        for edge in source.graph.edges
        if edge.source_component_id == "checkout"
        and edge.target_component_id == "payment"
    }
    if not checkout_payment_edges:
        return []

    failure_candidates = [
        signal for signal in current_signals
        if signal.provider == ConnectorProvider.OTEL
        and signal.authority == EvidenceAuthority.T0
        and signal.signal_kind == "TRACE_STATUS"
        and signal.status == RealtimeSignalStatus.CRITICAL
        and {"checkout", "payment"}.issubset(set(signal.component_ids))
        and bool(checkout_payment_edges.intersection(signal.edge_ids))
        and bool(signal.evidence_refs)
    ]
    if not failure_candidates:
        return []

    metrics_by_kind = {}
    for metric_kind in DETECT_METRIC_SIGNAL_KINDS_V3:
        candidates = [
            signal for signal in current_signals
            if signal.provider == ConnectorProvider.OTEL
            and signal.authority == EvidenceAuthority.T0
            and signal.signal_kind == metric_kind
            and "checkout" in signal.component_ids
            and not signal.edge_ids
            and bool(signal.evidence_refs)
        ]
        if not candidates:
            return []
        metrics_by_kind[metric_kind] = _latest_signal(candidates)

    return [
        _latest_signal(failure_candidates),
        *(metrics_by_kind[kind] for kind in DETECT_METRIC_SIGNAL_KINDS_V3),
    ]


def decision_premise_fingerprint_v3(source: IncidentProjectionV2) -> str:
    """Hash material incident premises while ignoring equivalent sample churn.

    Cursor, evidence IDs, timestamps, and numeric display values change on each
    two-second sample.  They are intentionally excluded.  Severity, impacted
    scope, evidenced dependency shape, and the classification of each admitted
    signal are the premises whose change invalidates a reviewed decision.
    """

    material = {
        "severity": source.status,
        "impacted_path": list(source.impacted_path),
        "nodes": sorted(
            (
                item.component_id,
                item.runtime_status,
                item.impact_status,
                item.membership.value,
            )
            for item in source.graph.nodes
        ),
        "edges": sorted(
            (
                item.edge_id,
                item.source_component_id,
                item.target_component_id,
                item.status,
            )
            for item in source.graph.edges
        ),
        "evidence_shape": sorted({
            (
                item.provider.value,
                item.signal_kind,
                item.title,
                item.status.value,
                item.trend.value,
                tuple(sorted(item.component_ids)),
                tuple(sorted(item.edge_ids)),
                item.authority.value,
            )
            for item in source.realtime_signals
            if item.freshness == FreshnessStatus.CURRENT
        }),
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(encoded).hexdigest()


def _audit_record(
    *,
    record_type: WorkflowAuditRecordTypeV3,
    attempt_id: str,
    workflow_revision: int,
    decision_revision: int,
    summary: str,
    recorded_at: datetime,
    stage: Optional[WorkflowStageV3] = None,
    stage_run_id: Optional[str] = None,
    parent_attempt_id: Optional[str] = None,
    action_id: Optional[str] = None,
    actor_subject_id: Optional[str] = None,
    evidence_refs: Optional[List[str]] = None,
    stage_output: Optional[StageOutputV3] = None,
    approval_decision: Optional[str] = None,
    action_receipt: Optional[ActionExecutionReceiptV3] = None,
    rollback_receipt: Optional[ActionRollbackReceiptV3] = None,
) -> WorkflowAuditRecordV3:
    identity = ":".join([
        record_type.value,
        attempt_id,
        stage_run_id or "",
        action_id or "",
        str(workflow_revision),
        str(len(evidence_refs or [])),
    ])
    return WorkflowAuditRecordV3(
        audit_id=_stable_id("audit", identity),
        record_type=record_type,
        attempt_id=attempt_id,
        parent_attempt_id=parent_attempt_id,
        stage=stage,
        stage_run_id=stage_run_id,
        action_id=action_id,
        actor_subject_id=actor_subject_id,
        workflow_revision=workflow_revision,
        decision_revision=decision_revision,
        summary=summary,
        evidence_refs=list(dict.fromkeys(evidence_refs or [])),
        stage_output=stage_output,
        approval_decision=approval_decision,
        action_receipt=action_receipt,
        rollback_receipt=rollback_receipt,
        recorded_at=recorded_at,
    )


def _current_run(projection: IncidentProjectionV3) -> StageRunV3:
    attempt = projection.current_attempt
    candidates = [
        item for item in attempt.stage_runs
        if item.stage == attempt.current_stage
        and item.status != WorkflowStageStateV3.SUPERSEDED
    ]
    if len(candidates) != 1:
        raise PolicyViolation("workflow_v3_current_stage_run_invalid")
    return candidates[0]


def _available_commands(projection: IncidentProjectionV3) -> List[WorkflowCommandNameV3]:
    attempt = projection.current_attempt
    current = _current_run(projection)
    if attempt.status == WorkflowAttemptStateV3.COMPLETED:
        return []
    if any(
        item.stage_run_id == current.stage_run_id
        and item.state == AgentRunStateV3.RUNNING
        for item in projection.agent_activity
    ):
        return [WorkflowCommandNameV3.ESCALATE]
    if current.status == WorkflowStageStateV3.NEEDS_HUMAN:
        if projection.current_attempt.action_executed:
            # An ambiguous or completed external mutation is an irreversible
            # boundary. Retrying the same stage could execute it twice; only a
            # new diagnostic branch is safe.
            return [WorkflowCommandNameV3.RERUN_FROM_STAGE]
        commands = [WorkflowCommandNameV3.RETRY]
        if _candidate_rerun_stages(projection):
            commands.append(WorkflowCommandNameV3.RERUN_FROM_STAGE)
        return commands
    if current.status == WorkflowStageStateV3.FAILED:
        if projection.current_attempt.action_executed:
            return [
                WorkflowCommandNameV3.RERUN_FROM_STAGE,
                WorkflowCommandNameV3.ESCALATE,
            ]
        if (
            current.stage == WorkflowStageV3.DECIDE
            and current.failure_code == "REVALIDATION_REQUIRED"
        ):
            return [
                WorkflowCommandNameV3.RERUN_FROM_STAGE,
                WorkflowCommandNameV3.ESCALATE,
            ]
        if current.stage == WorkflowStageV3.VERIFY:
            return [WorkflowCommandNameV3.RERUN_FROM_STAGE]
        commands = [
            WorkflowCommandNameV3.RETRY,
            WorkflowCommandNameV3.ESCALATE,
        ]
        if _candidate_rerun_stages(projection):
            commands.append(WorkflowCommandNameV3.RERUN_FROM_STAGE)
        return commands
    commands: List[WorkflowCommandNameV3] = []
    if current.status == WorkflowStageStateV3.RUNNING:
        commands.append(WorkflowCommandNameV3.ESCALATE)
        if _candidate_rerun_stages(projection):
            commands.append(WorkflowCommandNameV3.RERUN_FROM_STAGE)
        if current.stage in {
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        }:
            commands.append(WorkflowCommandNameV3.START_AGENT_RUN)
    if current.status == WorkflowStageStateV3.SUCCEEDED:
        commands.extend([
            WorkflowCommandNameV3.COMPLETE_INCIDENT
            if current.stage == WorkflowStageV3.VERIFY
            else WorkflowCommandNameV3.NEXT,
            WorkflowCommandNameV3.RERUN_FROM_STAGE,
        ])
        if current.stage == WorkflowStageV3.INVESTIGATE:
            commands.append(WorkflowCommandNameV3.START_AGENT_RUN)
    if current.stage == WorkflowStageV3.RESPOND:
        pending = [
            item for item in projection.actions
            if item.attempt_id == attempt.attempt_id
            and item.stage_run_id == current.stage_run_id
            and item.approval_state == ActionApprovalStateV3.PENDING
        ]
        if pending:
            commands.extend([
                WorkflowCommandNameV3.APPROVE_ACTION,
                WorkflowCommandNameV3.REJECT_ACTION,
            ])
    return list(dict.fromkeys(commands))


def _require_command_authority(
    projection: IncidentProjectionV3,
    command_name: WorkflowCommandNameV3,
) -> None:
    if projection.current_attempt.status == WorkflowAttemptStateV3.COMPLETED:
        raise PolicyViolation("workflow_v3_completed_attempt_immutable")
    if command_name not in _available_commands(projection):
        raise PolicyViolation("workflow_v3_command_not_available")


def _available_rerun_stages(
    projection: IncidentProjectionV3,
    commands: Optional[Sequence[WorkflowCommandNameV3]] = None,
) -> List[WorkflowStageV3]:
    commands = list(commands if commands is not None else _available_commands(projection))
    if WorkflowCommandNameV3.RERUN_FROM_STAGE not in commands:
        return []
    return _candidate_rerun_stages(projection)


def _candidate_rerun_stages(
    projection: IncidentProjectionV3,
) -> List[WorkflowStageV3]:
    if projection.current_attempt.action_executed:
        # A post-action return is a new attempt, never another execution or
        # verification loop.  Expose concrete diagnostic branch targets so a
        # client cannot render a dead-end generic Rerun button.
        return [WorkflowStageV3.INVESTIGATE, WorkflowStageV3.DECIDE]
    current = _current_run(projection)
    current_index = _stage_index(current.stage)
    completed = {
        item.stage for item in projection.current_attempt.stage_runs
        if item.status in {
            WorkflowStageStateV3.SUCCEEDED,
            WorkflowStageStateV3.SUPERSEDED,
        }
    }
    if current.status != WorkflowStageStateV3.SUCCEEDED:
        completed.discard(current.stage)
    if (
        current.status == WorkflowStageStateV3.FAILED
        and current.stage == WorkflowStageV3.DECIDE
        and current.failure_code == "REVALIDATION_REQUIRED"
    ):
        completed.add(current.stage)
    return [
        stage for stage in WORKFLOW_STAGE_ORDER_V3
        if _stage_index(stage) <= current_index and stage in completed
    ]


def _validated_projection(projection: IncidentProjectionV3, **updates) -> IncidentProjectionV3:
    return IncidentProjectionV3.parse_obj({**projection.dict(), **updates})


def _impacted_components(source: IncidentProjectionV2) -> List[str]:
    return list(dict.fromkeys([
        *source.impacted_path,
        *[
            node.component_id for node in source.graph.nodes
            if node.impact_status == "impacted"
        ],
    ]))


def bootstrap_projection_v3(
    source: IncidentProjectionV2,
    *,
    actor_subject_id: str,
    now: datetime,
) -> tuple[IncidentProjectionV3, IncidentEventV3]:
    """Create a V3 Detect checkpoint from accepted V2 realtime facts."""
    live_connectors = [
        item for item in source.connector_health
        if item.state == ConnectorHealthState.CONNECTED
        and item.truth_label == ConnectorTruthLabel.LIVE
    ]
    live_providers = {item.provider for item in live_connectors}
    current_signals = [
        item for item in source.realtime_signals
        if item.freshness == FreshnessStatus.CURRENT
        and item.fresh_until > now
        and item.connector_state == ConnectorHealthState.CONNECTED
        and item.provider in live_providers
        and source.incident_clock.freshness == FreshnessStatus.CURRENT
        and source.incident_clock.fresh_until > now
    ]
    detect_signals = _qualified_detect_signals_v3(source, current_signals)
    detect_succeeded = bool(live_connectors and detect_signals)
    attempt_id = _stable_id("attempt", source.tenant_id, source.case_id, 1)
    stage_run_id = _stable_id("stage-run", attempt_id, WorkflowStageV3.DETECT.value, 1)
    evidence_refs = list(dict.fromkeys(
        evidence for signal in detect_signals for evidence in signal.evidence_refs
    ))
    output = None
    if detect_succeeded:
        output = StageOutputV3(
            summary=DETECT_OBSERVATION_SUMMARY_V3,
            facts=[
                StageFactV3(
                    fact_id=signal.signal_id,
                    label=signal.title,
                    value=signal.display_value,
                    evidence_refs=signal.evidence_refs,
                )
                for signal in detect_signals
            ],
            evidence_refs=evidence_refs,
        )
    stage_run = StageRunV3(
        stage_run_id=stage_run_id,
        attempt_id=attempt_id,
        stage=WorkflowStageV3.DETECT,
        status=(
            WorkflowStageStateV3.SUCCEEDED
            if detect_succeeded else WorkflowStageStateV3.RUNNING
        ),
        run_number=1,
        input_workflow_revision=1,
        input_signal_revision=source.source_revision,
        input_decision_revision=max(1, source.action_revision),
        progress_percent=100 if detect_succeeded else 10,
        summary=output.summary if output is not None else None,
        output=output,
        evidence_refs=evidence_refs,
        started_at=source.incident_clock.started_at,
        completed_at=now if detect_succeeded else None,
        created_at=now,
    )
    initial_audit = [
        _audit_record(
            record_type=WorkflowAuditRecordTypeV3.ATTEMPT_CREATED,
            attempt_id=attempt_id,
            workflow_revision=1,
            decision_revision=max(1, source.action_revision),
            summary="Initial incident workflow attempt created.",
            recorded_at=now,
        ),
    ]
    if output is not None:
        initial_audit.append(_audit_record(
            record_type=WorkflowAuditRecordTypeV3.STAGE_COMPLETED,
            attempt_id=attempt_id,
            workflow_revision=1,
            decision_revision=max(1, source.action_revision),
            summary=output.summary,
            recorded_at=now,
            stage=WorkflowStageV3.DETECT,
            stage_run_id=stage_run_id,
            evidence_refs=evidence_refs,
            stage_output=output,
        ))
    observed_at = source.incident_clock.last_signal_at or source.generated_at
    projection = IncidentProjectionV3(
        tenant_id=source.tenant_id,
        case_id=source.case_id,
        incident_id=source.incident_id,
        run_id=source.run_id,
        topology_revision=source.topology_revision,
        projection_revision=1,
        sequence=1,
        signal_revision=source.source_revision,
        decision_revision=max(1, source.action_revision),
        workspace_revision=source.agent_workspace.workspace_revision,
        workflow_revision=1,
        current_premise_fingerprint=decision_premise_fingerprint_v3(source),
        title=source.operator_title,
        summary=source.operator_summary,
        severity=source.status,
        owner_subject_id=actor_subject_id,
        lifecycle_state=(
            IncidentLifecycleStateV3.ACTIVE
            if detect_succeeded else IncidentLifecycleStateV3.DEGRADED
        ),
        incident_clock=source.incident_clock,
        freshness=FreshnessV3(
            state=source.incident_clock.freshness,
            observed_at=observed_at,
            fresh_until=source.incident_clock.fresh_until,
        ),
        graph=IncidentGraphV3(
            **source.graph.dict(), active_pulses=source.active_graph_pulses,
        ),
        impacted_path=_impacted_components(source),
        connectors=[ConnectorStatusV3(
            connector_id=item.connector_id,
            provider=item.provider.value,
            state=item.state.value,
            observed_at=item.last_event_observed_at or item.checked_at,
            fresh_until=item.fresh_until,
            lag_seconds=item.lag_seconds,
            truth_label=item.truth_label.value,
        ) for item in source.connector_health],
        current_attempt=WorkflowAttemptV3(
            attempt_id=attempt_id,
            attempt_number=1,
            current_stage=WorkflowStageV3.DETECT,
            status=WorkflowAttemptStateV3.ACTIVE,
            workflow_revision=1,
            created_reason="INITIAL_INCIDENT_DETECTION",
            created_at=now,
            stage_runs=[stage_run],
        ),
        available_commands=[],
        audit_records=initial_audit,
        generated_at=now,
    )
    commands = _available_commands(projection)
    projection = _validated_projection(
        projection,
        available_commands=commands,
        available_rerun_stages=_available_rerun_stages(projection, commands),
    )
    event = IncidentEventV3(
        event_id=_stable_id("event", source.case_id, 1),
        tenant_id=source.tenant_id,
        case_id=source.case_id,
        sequence=1,
        event_type=(
            WorkflowEventTypeV3.STAGE_COMPLETED
            if detect_succeeded else WorkflowEventTypeV3.STAGE_STARTED
        ),
        occurred_at=now,
        projection_revision=projection.projection_revision,
        workflow_revision=projection.workflow_revision,
        attempt_id=attempt_id,
        stage=WorkflowStageV3.DETECT,
        stage_run_id=stage_run_id,
        actor_subject_id=actor_subject_id,
        summary=output.summary if output is not None else "Detecting current incident signals.",
        progress=stage_run.progress_percent,
        evidence_refs=evidence_refs,
    )
    return projection, event


class GuidedWorkflowCoordinatorV3:
    """Command coordinator used by Temporal activities and HTTP tests."""

    def __init__(self, repository) -> None:
        self.repository = repository

    async def bootstrap(
        self,
        source: IncidentProjectionV2,
        *,
        actor_subject_id: str,
        now: datetime,
    ) -> IncidentProjectionV3:
        existing = await self.repository.workspace_projection_v3(
            source.tenant_id, source.case_id,
        )
        if existing is not None:
            return existing
        projection, event = bootstrap_projection_v3(
            source, actor_subject_id=actor_subject_id, now=now,
        )
        return await self.repository.initialize_workspace_v3(projection, event)

    async def sync_realtime(
        self,
        source: IncidentProjectionV2,
        *,
        actor_subject_id: str,
        now: datetime,
    ) -> IncidentProjectionV3:
        """Refresh telemetry facts without advancing or unlocking a stage.

        The V2 projection is the accepted connector truth snapshot. This
        signal-domain commit deliberately preserves workflow and decision
        revisions so periodic samples cannot behave like a user ``Next``.
        """
        sync_key = "realtime:{}:{}:{}".format(
            source.run_id, source.projection_revision, source.sequence,
        )
        sync_hash = sha256(
            source.json(sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ).hexdigest()
        existing = await self.repository.workspace_realtime_sync_v3(
            source.tenant_id, source.case_id, sync_key,
        )
        if existing is not None:
            if existing.sync_hash != sync_hash:
                raise PolicyViolation("workflow_v3_realtime_sync_conflict")
            return existing.projection

        prior = await self._required_projection(source.tenant_id, source.case_id)
        if (
            source.incident_id != prior.incident_id
            or source.run_id != prior.run_id
            or source.topology_revision != prior.topology_revision
        ):
            raise PolicyViolation("workflow_v3_realtime_identity_mismatch")
        if (
            prior.lifecycle_state == IncidentLifecycleStateV3.RESOLVED
            or prior.current_attempt.status == WorkflowAttemptStateV3.COMPLETED
        ):
            return prior

        live_connectors = [
            item for item in source.connector_health
            if item.state == ConnectorHealthState.CONNECTED
            and item.truth_label == ConnectorTruthLabel.LIVE
        ]
        live_providers = {item.provider for item in live_connectors}
        current_signals = [
            item for item in source.realtime_signals
            if item.freshness == FreshnessStatus.CURRENT
            and item.fresh_until > now
            and item.connector_state == ConnectorHealthState.CONNECTED
            and item.provider in live_providers
            and source.incident_clock.freshness == FreshnessStatus.CURRENT
            and source.incident_clock.fresh_until > now
        ]
        detect_signals = _qualified_detect_signals_v3(source, current_signals)
        current = _current_run(prior)
        completed_detect = (
            current.stage == WorkflowStageV3.DETECT
            and current.status == WorkflowStageStateV3.RUNNING
            and bool(live_connectors and detect_signals)
        )
        evidence_refs = list(dict.fromkeys(
            evidence for signal in current_signals for evidence in signal.evidence_refs
        ))
        attempt = prior.current_attempt
        if completed_detect:
            detect_evidence_refs = list(dict.fromkeys(
                evidence
                for signal in detect_signals
                for evidence in signal.evidence_refs
            ))
            output = StageOutputV3(
                summary=DETECT_OBSERVATION_SUMMARY_V3,
                facts=[
                    StageFactV3(
                        fact_id=signal.signal_id,
                        label=signal.title,
                        value=signal.display_value,
                        evidence_refs=signal.evidence_refs,
                    )
                    for signal in detect_signals
                ],
                evidence_refs=detect_evidence_refs,
            )
            completed = current.copy(update={
                "status": WorkflowStageStateV3.SUCCEEDED,
                "progress_percent": 100,
                "summary": output.summary,
                "output": output,
                "evidence_refs": detect_evidence_refs,
                "completed_at": now,
            })
            attempt = prior.current_attempt.copy(update={
                "stage_runs": [
                    completed if item.stage_run_id == current.stage_run_id else item
                    for item in prior.current_attempt.stage_runs
                ],
            })

        audit_records = prior.audit_records
        if completed_detect:
            audit_records = [*audit_records, _audit_record(
                record_type=WorkflowAuditRecordTypeV3.STAGE_COMPLETED,
                attempt_id=attempt.attempt_id,
                workflow_revision=prior.workflow_revision,
                decision_revision=prior.decision_revision,
                summary=DETECT_OBSERVATION_SUMMARY_V3,
                recorded_at=now,
                stage=WorkflowStageV3.DETECT,
                stage_run_id=current.stage_run_id,
                evidence_refs=detect_evidence_refs,
                stage_output=output,
            )]

        event_count = 2 if completed_detect else 1
        observed_at = (
            source.incident_clock.last_signal_at
            or source.incident_clock.started_at
        )
        lifecycle = prior.lifecycle_state
        if lifecycle in {
            IncidentLifecycleStateV3.ACTIVE,
            IncidentLifecycleStateV3.DEGRADED,
        }:
            lifecycle = (
                IncidentLifecycleStateV3.ACTIVE
                if current_signals and live_connectors
                else IncidentLifecycleStateV3.DEGRADED
            )
        projection = IncidentProjectionV3.parse_obj({
            **prior.dict(),
            "projection_revision": prior.projection_revision + 1,
            "sequence": prior.sequence + event_count,
            "signal_revision": max(prior.signal_revision, source.source_revision),
            "current_premise_fingerprint": decision_premise_fingerprint_v3(source),
            "title": source.operator_title,
            "summary": source.operator_summary,
            "severity": prior.severity,
            "lifecycle_state": lifecycle,
            "incident_clock": source.incident_clock,
            "freshness": FreshnessV3(
                state=source.incident_clock.freshness,
                observed_at=observed_at,
                fresh_until=source.incident_clock.fresh_until,
            ),
            "graph": IncidentGraphV3(
                **source.graph.dict(), active_pulses=source.active_graph_pulses,
            ),
            "impacted_path": _impacted_components(source),
            "connectors": [ConnectorStatusV3(
                connector_id=item.connector_id,
                provider=item.provider.value,
                state=item.state.value,
                observed_at=item.last_event_observed_at or item.checked_at,
                fresh_until=item.fresh_until,
                lag_seconds=item.lag_seconds,
                truth_label=item.truth_label.value,
            ) for item in source.connector_health],
            "current_attempt": attempt,
            "audit_records": audit_records,
            "available_commands": [],
            "available_rerun_stages": [],
            "generated_at": now,
        })
        commands = _available_commands(projection)
        projection = _validated_projection(
            projection, available_commands=commands,
            available_rerun_stages=_available_rerun_stages(projection, commands),
        )
        signal_event = self._event(
            projection,
            prior.sequence + 1,
            (
                WorkflowEventTypeV3.SIGNAL_OBSERVED
                if current_signals else WorkflowEventTypeV3.SIGNAL_STALE
            ),
            now,
            actor_subject_id,
            run=_current_run(projection),
            summary=(
                "Accepted {} current telemetry signal(s).".format(len(current_signals))
                if current_signals else "No fresh telemetry sample is available."
            ),
            evidence_refs=evidence_refs,
        )
        events = [signal_event]
        if completed_detect:
            events.append(self._event(
                projection,
                prior.sequence + 2,
                WorkflowEventTypeV3.STAGE_COMPLETED,
                now,
                actor_subject_id,
                run=_current_run(projection),
                summary=DETECT_OBSERVATION_SUMMARY_V3,
                evidence_refs=detect_evidence_refs,
            ))
        commit = WorkflowRealtimeSyncCommitV3(
            tenant_id=prior.tenant_id,
            case_id=prior.case_id,
            sync_key=sync_key,
            sync_hash=sync_hash,
            expected_projection_revision=prior.projection_revision,
            projection=projection,
            events=events,
        )
        stored = await self.repository.commit_workspace_realtime_sync_v3(commit)
        return stored.projection

    @staticmethod
    def _validate_command(
        projection: IncidentProjectionV3,
        command: WorkflowCommandV3,
    ) -> None:
        attempt = projection.current_attempt
        if command.attempt_id != attempt.attempt_id:
            raise PolicyViolation("workflow_v3_attempt_mismatch")
        if command.expected_stage != attempt.current_stage:
            raise PolicyViolation("workflow_v3_stage_mismatch")
        if command.expected_workflow_revision != projection.workflow_revision:
            raise PolicyViolation("workflow_v3_revision_conflict")

    async def _replay(
        self, tenant_id: str, case_id: str, idempotency_key: str, command_hash: str,
    ) -> Optional[WorkflowCommandReceiptV3]:
        record = await self.repository.workspace_command_v3(
            tenant_id, case_id, idempotency_key,
        )
        if record is None:
            return None
        if record.command_hash != command_hash:
            raise PolicyViolation("workflow_v3_idempotency_conflict")
        return record.receipt.copy(update={"reused": True})

    async def _commit_command(
        self,
        *,
        prior: IncidentProjectionV3,
        projection: IncidentProjectionV3,
        events: Sequence[IncidentEventV3],
        command: WorkflowCommandV3,
        command_name: WorkflowCommandNameV3,
        actor_subject_id: str,
        now: datetime,
        command_hash: Optional[str] = None,
        accepted: bool = True,
        reason: Optional[str] = None,
    ) -> WorkflowCommandReceiptV3:
        command_hash = command_hash or command.canonical_hash()
        replay = await self._replay(
            prior.tenant_id, prior.case_id, command.idempotency_key, command_hash,
        )
        if replay is not None:
            return replay
        receipt = WorkflowCommandReceiptV3(
            command_id=_stable_id(
                "workflow-command", prior.tenant_id, prior.case_id,
                command.idempotency_key, command_hash,
            ),
            command_name=command_name,
            accepted=accepted,
            reason=reason,
            actor_subject_id=actor_subject_id,
            # Receipt scope is the attempt named by the command. A post-action
            # rerun can create a child attempt, which is carried by projection;
            # rewriting this field to the child breaks request/receipt binding.
            attempt_id=command.attempt_id,
            workflow_revision=projection.workflow_revision,
            projection=projection,
            recorded_at=now,
        )
        commit = WorkflowTransitionCommitV3(
            tenant_id=prior.tenant_id,
            case_id=prior.case_id,
            idempotency_key=command.idempotency_key,
            command_hash=command_hash,
            expected_workflow_revision=prior.workflow_revision,
            projection=projection,
            events=list(events),
            receipt=receipt,
        )
        stored = await self.repository.commit_workspace_transition_v3(commit)
        return stored.receipt

    @staticmethod
    def _next_base(
        prior: IncidentProjectionV3,
        *,
        event_count: int,
        now: datetime,
        attempt: WorkflowAttemptV3,
        **updates,
    ) -> IncidentProjectionV3:
        data = {
            **prior.dict(),
            "projection_revision": prior.projection_revision + 1,
            "sequence": prior.sequence + event_count,
            "workflow_revision": prior.workflow_revision + 1,
            "current_attempt": {
                **attempt.dict(),
                "workflow_revision": prior.workflow_revision + 1,
            },
            "generated_at": now,
            **updates,
        }
        data["available_commands"] = []
        data["available_rerun_stages"] = []
        projection = IncidentProjectionV3.parse_obj(data)
        commands = _available_commands(projection)
        return _validated_projection(
            projection,
            available_commands=commands,
            available_rerun_stages=_available_rerun_stages(projection, commands),
        )

    @staticmethod
    def _event(
        projection: IncidentProjectionV3,
        sequence: int,
        event_type: WorkflowEventTypeV3,
        now: datetime,
        actor_subject_id: Optional[str],
        *,
        run: Optional[StageRunV3] = None,
        summary: Optional[str] = None,
        evidence_refs: Optional[List[str]] = None,
    ) -> IncidentEventV3:
        return IncidentEventV3(
            event_id=_stable_id("event", projection.case_id, sequence),
            tenant_id=projection.tenant_id,
            case_id=projection.case_id,
            sequence=sequence,
            event_type=event_type,
            occurred_at=now,
            projection_revision=projection.projection_revision,
            workflow_revision=projection.workflow_revision,
            attempt_id=projection.current_attempt.attempt_id,
            stage=run.stage if run is not None else projection.current_attempt.current_stage,
            stage_run_id=run.stage_run_id if run is not None else None,
            actor_subject_id=actor_subject_id,
            summary=summary,
            progress=run.progress_percent if run is not None else None,
            evidence_refs=evidence_refs or [],
        )

    async def advance(
        self,
        tenant_id: str,
        case_id: str,
        command: WorkflowCommandV3,
        actor_subject_id: str,
        now: datetime,
    ) -> WorkflowCommandReceiptV3:
        prior = await self._required_projection(tenant_id, case_id)
        replay = await self._replay(
            tenant_id, case_id, command.idempotency_key, command.canonical_hash(),
        )
        if replay is not None:
            return replay
        self._validate_command(prior, command)
        current = _current_run(prior)
        if current.status != WorkflowStageStateV3.SUCCEEDED:
            raise PolicyViolation("workflow_v3_current_stage_not_succeeded")
        _require_command_authority(
            prior,
            WorkflowCommandNameV3.COMPLETE_INCIDENT
            if current.stage == WorkflowStageV3.VERIFY
            else WorkflowCommandNameV3.NEXT,
        )
        if current.stage == WorkflowStageV3.DECIDE and (
            current.output is None
            or not current.output.premise_fingerprint
            or current.output.premise_fingerprint != prior.current_premise_fingerprint
            or current.output.action_candidate is None
            or current.output.action_candidate.decision_revision != prior.decision_revision
        ):
            invalidated = current.copy(update={
                "status": WorkflowStageStateV3.FAILED,
                "failure_code": "REVALIDATION_REQUIRED",
                "completed_at": now,
            })
            attempt = prior.current_attempt.copy(update={
                "stage_runs": [
                    invalidated if item.stage_run_id == current.stage_run_id else item
                    for item in prior.current_attempt.stage_runs
                ],
            })
            audit = _audit_record(
                record_type=WorkflowAuditRecordTypeV3.STAGE_FAILED,
                attempt_id=prior.current_attempt.attempt_id,
                workflow_revision=prior.workflow_revision + 1,
                decision_revision=prior.decision_revision,
                summary="Decision premises changed; rerun Decide before Respond.",
                recorded_at=now,
                stage=WorkflowStageV3.DECIDE,
                stage_run_id=current.stage_run_id,
                actor_subject_id=actor_subject_id,
                evidence_refs=current.evidence_refs,
                stage_output=current.output,
            )
            projection = self._next_base(
                prior, event_count=1, now=now, attempt=attempt,
                lifecycle_state=IncidentLifecycleStateV3.DEGRADED,
                audit_records=[*prior.audit_records, audit],
            )
            event = self._event(
                projection, projection.sequence, WorkflowEventTypeV3.STAGE_FAILED,
                now, actor_subject_id, run=invalidated,
                summary="REVALIDATION_REQUIRED",
                evidence_refs=current.evidence_refs,
            )
            return await self._commit_command(
                prior=prior, projection=projection, events=[event], command=command,
                command_name=WorkflowCommandNameV3.NEXT,
                actor_subject_id=actor_subject_id, now=now,
                accepted=False, reason="REVALIDATION_REQUIRED",
            )
        if current.stage == WorkflowStageV3.VERIFY:
            attempt = prior.current_attempt.copy(update={
                "status": WorkflowAttemptStateV3.COMPLETED,
                "completed_at": now,
            })
            completion_audit = _audit_record(
                record_type=WorkflowAuditRecordTypeV3.INCIDENT_COMPLETED,
                attempt_id=attempt.attempt_id,
                workflow_revision=prior.workflow_revision + 1,
                decision_revision=prior.decision_revision,
                summary="Incident verification completed.",
                recorded_at=now,
                actor_subject_id=actor_subject_id,
                stage=WorkflowStageV3.VERIFY,
                stage_run_id=current.stage_run_id,
                evidence_refs=current.evidence_refs,
            )
            audit_records = [*prior.audit_records, completion_audit]
            stage_audit_ids = [
                item.audit_id for item in audit_records
                if item.stage_output is not None
            ]
            receipt_audit_ids = [
                item.audit_id for item in audit_records
                if item.action_receipt is not None
            ]
            if not receipt_audit_ids:
                raise PolicyViolation("workflow_v3_final_report_action_receipt_required")
            lineage = [
                *[item.attempt_id for item in prior.attempt_history],
                attempt.attempt_id,
            ]
            lineage = list(dict.fromkeys(lineage))
            report_material = {
                "attempt_id": attempt.attempt_id,
                "attempt_lineage": lineage,
                "workflow_revision": prior.workflow_revision + 1,
                "decision_revision": prior.decision_revision,
                "stage_output_audit_ids": stage_audit_ids,
                "action_receipt_audit_ids": receipt_audit_ids,
                "verification_evidence_refs": current.evidence_refs,
            }
            content_hash = sha256(json.dumps(
                report_material, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            final_report = IncidentAuditReportV3(
                report_id=_stable_id("incident-report", prior.case_id, content_hash),
                generated_at=now,
                content_hash=content_hash,
                **report_material,
            )
            incident_clock = prior.incident_clock.copy(update={
                "state": IncidentClockState.RESOLVED,
                "resolved_at": now,
                "as_of": now,
                "elapsed_seconds": max(
                    prior.incident_clock.elapsed_seconds,
                    int((now - prior.incident_clock.started_at).total_seconds()),
                ),
            })
            resolved_series = await self.repository.realtime_series(
                tenant_id, case_id,
            )
            projection = self._next_base(
                prior, event_count=1, now=now, attempt=attempt,
                signal_revision=resolved_series.signal_revision,
                lifecycle_state=IncidentLifecycleStateV3.RESOLVED,
                incident_clock=incident_clock,
                audit_records=audit_records,
                final_report=final_report,
                resolved_series_snapshot=resolved_series,
            )
            event = self._event(
                projection, projection.sequence,
                WorkflowEventTypeV3.INCIDENT_COMPLETED, now, actor_subject_id,
                run=current, summary="Incident verification completed.",
                evidence_refs=current.evidence_refs,
            )
            return await self._commit_command(
                prior=prior, projection=projection, events=[event], command=command,
                command_name=WorkflowCommandNameV3.COMPLETE_INCIDENT,
                actor_subject_id=actor_subject_id, now=now,
            )
        next_stage = WORKFLOW_STAGE_ORDER_V3[_stage_index(current.stage) + 1]
        if next_stage == WorkflowStageV3.VERIFY and not prior.current_attempt.action_executed:
            raise PolicyViolation("workflow_v3_response_action_not_executed")
        run_number = 1 + sum(
            1 for item in prior.current_attempt.stage_runs if item.stage == next_stage
        )
        next_run = StageRunV3(
            stage_run_id=_stable_id(
                "stage-run", prior.current_attempt.attempt_id,
                next_stage.value, run_number,
            ),
            attempt_id=prior.current_attempt.attempt_id,
            stage=next_stage,
            status=WorkflowStageStateV3.RUNNING,
            run_number=run_number,
            input_workflow_revision=prior.workflow_revision + 1,
            input_signal_revision=prior.signal_revision,
            input_decision_revision=prior.decision_revision,
            progress_percent=0,
            started_at=now,
            verification_deadline_at=(
                now + timedelta(seconds=30)
                if next_stage == WorkflowStageV3.VERIFY else None
            ),
            created_at=now,
        )
        attempt = prior.current_attempt.copy(update={
            "current_stage": next_stage,
            "stage_runs": [*prior.current_attempt.stage_runs, next_run],
        })
        lifecycle = {
            WorkflowStageV3.RESPOND: IncidentLifecycleStateV3.AWAITING_OWNER,
            WorkflowStageV3.VERIFY: IncidentLifecycleStateV3.MONITORING,
        }.get(next_stage, IncidentLifecycleStateV3.ACTIVE)
        projection = self._next_base(
            prior, event_count=2, now=now, attempt=attempt,
            lifecycle_state=lifecycle,
        )
        advanced_event = self._event(
            projection, prior.sequence + 1,
            WorkflowEventTypeV3.ADVANCED, now, actor_subject_id,
            run=current,
            summary="Advanced from {} to {}.".format(current.stage.value, next_stage.value),
        )
        started_event = self._event(
            projection, prior.sequence + 2,
            WorkflowEventTypeV3.STAGE_STARTED, now, actor_subject_id,
            run=next_run,
            summary="{} stage started.".format(next_stage.value.title()),
        )
        return await self._commit_command(
            prior=prior, projection=projection,
            events=[advanced_event, started_event], command=command,
            command_name=WorkflowCommandNameV3.NEXT,
            actor_subject_id=actor_subject_id, now=now,
        )

    async def complete_current_stage(
        self,
        tenant_id: str,
        case_id: str,
        *,
        success: bool,
        summary: str,
        evidence_refs: List[str],
        now: datetime,
        failure_code: Optional[str] = None,
        facts: Optional[List[StageFactV3]] = None,
        unknowns: Optional[List[str]] = None,
        questions: Optional[List[str]] = None,
        hypotheses: Optional[List[WorkflowHypothesisV3]] = None,
        root_cause: Optional[str] = None,
        recommendation: Optional[str] = None,
        risk: Optional[str] = None,
        rollback: Optional[str] = None,
        verification_conditions: Optional[List[str]] = None,
        action_candidate: Optional[DecisionActionCandidateV3] = None,
        premise_fingerprint: Optional[str] = None,
        evidence_observed_at: Optional[datetime] = None,
        expected_stage_run_id: Optional[str] = None,
    ) -> IncidentProjectionV3:
        prior = await self._required_projection(tenant_id, case_id)
        current = _current_run(prior)
        if (
            expected_stage_run_id is not None
            and current.stage_run_id != expected_stage_run_id
        ):
            raise PolicyViolation("workflow_v3_stage_run_superseded")
        key = "internal-stage-terminal:{}:{}".format(current.stage_run_id, success)
        replay = await self.repository.workspace_command_v3(tenant_id, case_id, key)
        if replay is not None:
            return replay.projection
        if current.status != WorkflowStageStateV3.RUNNING:
            raise PolicyViolation("workflow_v3_current_stage_not_running")
        facts = facts or []
        unknowns = unknowns or []
        questions = questions or []
        hypotheses = hypotheses or []
        verification_conditions = verification_conditions or []
        canonical_refs = set(evidence_refs)
        if success and current.stage in {
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        }:
            if not facts or not canonical_refs:
                raise PolicyViolation("workflow_v3_canonical_stage_evidence_required")
            if any(
                not item.evidence_refs
                or not set(item.evidence_refs).issubset(canonical_refs)
                for item in facts
            ):
                raise PolicyViolation("workflow_v3_stage_fact_evidence_invalid")
        if success and current.stage == WorkflowStageV3.TRIAGE and not questions:
            raise PolicyViolation("workflow_v3_triage_questions_required")
        if success and current.stage == WorkflowStageV3.INVESTIGATE:
            if not hypotheses:
                raise PolicyViolation("workflow_v3_investigation_hypothesis_required")
            if any(
                item.stage_run_id != current.stage_run_id
                or not item.supporting_evidence_refs
                or not set(item.supporting_evidence_refs).issubset(canonical_refs)
                or not set(item.contradicting_evidence_refs).issubset(canonical_refs)
                for item in hypotheses
            ):
                raise PolicyViolation("workflow_v3_investigation_hypothesis_evidence_invalid")
            roles = {
                item.role
                for item in prior.agent_activity
                if item.stage_run_id == current.stage_run_id
                and item.state == AgentRunStateV3.SUCCEEDED
            }
            query_results = [
                item for item in prior.evidence_queries
                if item.stage_run_id == current.stage_run_id
                and item.state == EvidenceQueryStateV3.SUCCEEDED
            ]
            query_refs = {
                ref for item in query_results for ref in item.evidence_refs
            }
            query_timestamps = {
                observed_at for item in query_results
                for observed_at in item.observation_timestamps
            }
            if not {
                "EVIDENCE_WORKER", "INVESTIGATOR", "CRITIC",
            }.issubset(roles):
                raise PolicyViolation("workflow_v3_investigation_independent_critic_missing")
            if (
                not query_results
                or not canonical_refs.issubset(query_refs)
                or len(query_timestamps) < 2
            ):
                raise PolicyViolation("workflow_v3_investigation_typed_query_missing")
        if success and current.stage == WorkflowStageV3.DECIDE:
            investigated_run_ids = {
                item.stage_run_id for item in prior.current_attempt.stage_runs
                if item.stage == WorkflowStageV3.INVESTIGATE
                and item.status == WorkflowStageStateV3.SUCCEEDED
            }
            supported_root_causes = {
                item.statement for item in prior.hypotheses
                if item.stage_run_id in investigated_run_ids
                and item.supporting_evidence_refs
            }
            canonical_edges = {
                (item.source_component_id, item.target_component_id)
                for item in prior.graph.edges
            }
            if (
                not root_cause
                or root_cause not in supported_root_causes
                or not recommendation
                or not risk
                or not rollback
                or not verification_conditions
                or action_candidate is None
                or action_candidate.dry_run_state.value != "PASSED"
                or action_candidate.decision_revision != prior.decision_revision + 1
                or not premise_fingerprint
                or premise_fingerprint != prior.current_premise_fingerprint
                or action_candidate.command_id != ASTRONOMY_REPAIR_COMMAND_V3
                or action_candidate.component_id != "checkout"
                or action_candidate.expected_before != "paymentUnreachable=on"
                or action_candidate.observed_before != "paymentUnreachable=on"
                or ("checkout", "payment") not in canonical_edges
                or recommendation != action_candidate.summary
                or risk != action_candidate.risk
                or rollback != action_candidate.rollback_plan
                or verification_conditions != action_candidate.verification_conditions
            ):
                raise PolicyViolation("workflow_v3_decision_output_invalid")
        if success and current.stage == WorkflowStageV3.RESPOND and not prior.current_attempt.action_executed:
            raise PolicyViolation("workflow_v3_response_action_not_executed")
        if success and current.stage == WorkflowStageV3.VERIFY:
            if not prior.current_attempt.action_executed:
                raise PolicyViolation("workflow_v3_verify_action_receipt_required")
            if not evidence_refs:
                raise PolicyViolation("workflow_v3_verify_fresh_evidence_required")
            receipt = next(
                (
                    action.receipt for action in prior.actions
                    if action.receipt is not None
                    and action.receipt.receipt_id == prior.current_attempt.action_receipt_id
                ),
                None,
            )
            if (
                receipt is None
                or evidence_observed_at is None
                or evidence_observed_at <= receipt.completed_at
            ):
                raise PolicyViolation("workflow_v3_verify_post_action_evidence_required")
        if not success and not failure_code:
            raise PolicyViolation("workflow_v3_stage_failure_code_required")
        output = StageOutputV3(
            summary=summary,
            facts=facts,
            unknowns=unknowns,
            questions=questions,
            hypothesis_ids=[item.hypothesis_id for item in hypotheses],
            action_ids=(
                [action_candidate.candidate_id]
                if action_candidate is not None else []
            ),
            evidence_refs=evidence_refs,
            observed_at=evidence_observed_at,
            root_cause=root_cause,
            recommendation=recommendation,
            risk=risk,
            rollback=rollback,
            verification_conditions=verification_conditions,
            action_candidate=action_candidate,
            premise_fingerprint=premise_fingerprint,
        ) if success else None
        terminal = current.copy(update={
            "status": (
                WorkflowStageStateV3.SUCCEEDED
                if success else WorkflowStageStateV3.FAILED
            ),
            "progress_percent": 100,
            # A failed stage is still an immutable, operator-facing result.
            # Preserve the bounded diagnostic summary instead of replacing it
            # with a generic client-side error label.
            "summary": summary,
            "output": output,
            "evidence_refs": evidence_refs,
            "failure_code": None if success else failure_code,
            "completed_at": now,
        })
        runs = [
            terminal if item.stage_run_id == current.stage_run_id else item
            for item in prior.current_attempt.stage_runs
        ]
        attempt = prior.current_attempt.copy(update={"stage_runs": runs})
        next_decision_revision = (
            prior.decision_revision + 1
            if success and current.stage == WorkflowStageV3.DECIDE
            else prior.decision_revision
        )
        next_hypotheses = prior.hypotheses
        if success and current.stage == WorkflowStageV3.INVESTIGATE:
            existing_ids = {item.hypothesis_id for item in hypotheses}
            next_hypotheses = [
                item for item in prior.hypotheses
                if item.hypothesis_id not in existing_ids
            ] + hypotheses
        audit_type = (
            WorkflowAuditRecordTypeV3.VERIFICATION_RECORDED
            if current.stage == WorkflowStageV3.VERIFY
            else WorkflowAuditRecordTypeV3.STAGE_COMPLETED
            if success
            else WorkflowAuditRecordTypeV3.STAGE_FAILED
        )
        audit = _audit_record(
            record_type=audit_type,
            attempt_id=prior.current_attempt.attempt_id,
            workflow_revision=prior.workflow_revision + 1,
            decision_revision=next_decision_revision,
            summary=summary,
            recorded_at=now,
            stage=current.stage,
            stage_run_id=current.stage_run_id,
            evidence_refs=evidence_refs,
            stage_output=output,
        )
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            decision_revision=next_decision_revision,
            hypotheses=next_hypotheses,
            audit_records=[*prior.audit_records, audit],
            lifecycle_state=(
                prior.lifecycle_state if success else IncidentLifecycleStateV3.DEGRADED
            ),
        )
        event = self._event(
            projection, projection.sequence,
            WorkflowEventTypeV3.STAGE_COMPLETED if success else WorkflowEventTypeV3.STAGE_FAILED,
            now, None, run=terminal, summary=summary, evidence_refs=evidence_refs,
        )
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def record_stage_progress(
        self,
        tenant_id: str,
        case_id: str,
        *,
        progress_percent: int,
        summary: str,
        evidence_refs: List[str],
        now: datetime,
        expected_stage_run_id: Optional[str] = None,
    ) -> IncidentProjectionV3:
        if progress_percent <= 0 or progress_percent >= 100:
            raise PolicyViolation("workflow_v3_stage_progress_out_of_range")
        prior = await self._required_projection(tenant_id, case_id)
        current = _current_run(prior)
        if (
            expected_stage_run_id is not None
            and current.stage_run_id != expected_stage_run_id
        ):
            raise PolicyViolation("workflow_v3_stage_run_superseded")
        key = "internal-stage-progress:{}:{}".format(
            current.stage_run_id, progress_percent,
        )
        replay = await self.repository.workspace_command_v3(tenant_id, case_id, key)
        if replay is not None:
            return replay.projection
        if current.status != WorkflowStageStateV3.RUNNING:
            raise PolicyViolation("workflow_v3_current_stage_not_running")
        if progress_percent <= current.progress_percent:
            raise PolicyViolation("workflow_v3_stage_progress_not_monotonic")
        progressed = current.copy(update={
            "progress_percent": progress_percent,
            "summary": summary,
            "evidence_refs": list(dict.fromkeys([
                *current.evidence_refs, *evidence_refs,
            ])),
        })
        attempt = prior.current_attempt.copy(update={
            "stage_runs": [
                progressed if item.stage_run_id == current.stage_run_id else item
                for item in prior.current_attempt.stage_runs
            ],
        })
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.STAGE_PROGRESS,
            now, "flowpulse-worker", run=progressed, summary=summary,
            evidence_refs=progressed.evidence_refs,
        )
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def rerun(
        self,
        tenant_id: str,
        case_id: str,
        target_stage: WorkflowStageV3,
        command: WorkflowRerunCommandV3,
        actor_subject_id: str,
        now: datetime,
    ) -> WorkflowCommandReceiptV3:
        prior = await self._required_projection(tenant_id, case_id)
        command_hash = sha256(
            "{}:{}".format(command.canonical_hash(), target_stage.value).encode("utf-8"),
        ).hexdigest()
        replay = await self._replay(tenant_id, case_id, command.idempotency_key, command_hash)
        if replay is not None:
            return replay
        self._validate_command(prior, command)
        branched = prior.current_attempt.action_executed
        current = _current_run(prior)
        if prior.current_attempt.status == WorkflowAttemptStateV3.COMPLETED:
            raise PolicyViolation("workflow_v3_completed_attempt_immutable")
        if branched and target_stage in {
            WorkflowStageV3.RESPOND,
            WorkflowStageV3.VERIFY,
        }:
            raise PolicyViolation(
                "workflow_v3_post_action_branch_requires_diagnostic_stage",
            )
        if _stage_index(target_stage) > _stage_index(prior.current_attempt.current_stage):
            raise PolicyViolation("workflow_v3_future_stage_rerun_forbidden")
        available = set(_available_commands(prior))
        rerun_authorized = (
            WorkflowCommandNameV3.RERUN_FROM_STAGE in available
            and target_stage in prior.available_rerun_stages
        )
        retry_authorized = (
            WorkflowCommandNameV3.RETRY in available
            and target_stage == current.stage
        )
        if not (rerun_authorized or retry_authorized):
            raise PolicyViolation("workflow_v3_command_not_available")
        target_runs = [
            item for item in prior.current_attempt.stage_runs
            if item.stage == target_stage
        ]
        run_number = len(target_runs) + 1
        attempt_history = prior.attempt_history
        if branched:
            attempt_id = _stable_id(
                "attempt", prior.tenant_id, prior.case_id,
                prior.current_attempt.attempt_number + 1, command.idempotency_key,
            )
            next_run = StageRunV3(
                stage_run_id=_stable_id("stage-run", attempt_id, target_stage.value, 1),
                attempt_id=attempt_id,
                stage=target_stage,
                status=WorkflowStageStateV3.RUNNING,
                run_number=1,
                input_workflow_revision=prior.workflow_revision + 1,
                input_signal_revision=prior.signal_revision,
                input_decision_revision=prior.decision_revision + 1,
                progress_percent=0,
                started_at=now,
                created_at=now,
            )
            attempt = WorkflowAttemptV3(
                attempt_id=attempt_id,
                parent_attempt_id=prior.current_attempt.attempt_id,
                attempt_number=prior.current_attempt.attempt_number + 1,
                current_stage=target_stage,
                status=WorkflowAttemptStateV3.ACTIVE,
                workflow_revision=prior.workflow_revision + 1,
                created_reason=command.reason,
                created_at=now,
                stage_runs=[next_run],
            )
            parent_current = _current_run(prior)
            superseded_parent_run = parent_current.copy(update={
                "status": WorkflowStageStateV3.SUPERSEDED,
                "started_at": parent_current.started_at or parent_current.created_at,
                "completed_at": now,
                "failure_code": None,
            })
            parent_attempt = prior.current_attempt.copy(update={
                "status": WorkflowAttemptStateV3.SUPERSEDED,
                "completed_at": now,
                "stage_runs": [
                    superseded_parent_run
                    if item.stage_run_id == parent_current.stage_run_id else item
                    for item in prior.current_attempt.stage_runs
                ],
            })
            attempt_history = [*prior.attempt_history, parent_attempt]
        else:
            superseded_runs = []
            for item in prior.current_attempt.stage_runs:
                if (
                    _stage_index(item.stage) >= _stage_index(target_stage)
                    and item.status != WorkflowStageStateV3.SUPERSEDED
                ):
                    started_at = item.started_at or item.created_at
                    item = item.copy(update={
                        "status": WorkflowStageStateV3.SUPERSEDED,
                        "started_at": started_at,
                        "completed_at": now,
                        "failure_code": None,
                    })
                # Retain every old run in the canonical projection.  The
                # explicit SUPERSEDED state makes it historical/read-only;
                # clients derive locked future stages from the one new active
                # run rather than losing old outputs or audit scope.
                superseded_runs.append(item)
            next_run = StageRunV3(
                stage_run_id=_stable_id(
                    "stage-run", prior.current_attempt.attempt_id,
                    target_stage.value, run_number,
                ),
                attempt_id=prior.current_attempt.attempt_id,
                stage=target_stage,
                status=WorkflowStageStateV3.RUNNING,
                run_number=run_number,
                input_workflow_revision=prior.workflow_revision + 1,
                input_signal_revision=prior.signal_revision,
                input_decision_revision=(
                    prior.decision_revision + 1
                    if _stage_index(target_stage) <= _stage_index(WorkflowStageV3.DECIDE)
                    else prior.decision_revision
                ),
                progress_percent=0,
                started_at=now,
                created_at=now,
            )
            attempt = prior.current_attempt.copy(update={
                "current_stage": target_stage,
                "status": WorkflowAttemptStateV3.ACTIVE,
                "stage_runs": [*superseded_runs, next_run],
                "action_executed": False,
                "action_receipt_id": None,
            })
        affected = [
            item for item in prior.current_attempt.stage_runs
            if _stage_index(item.stage) >= _stage_index(target_stage)
            and item.status != WorkflowStageStateV3.SUPERSEDED
        ]
        event_count = len(affected) + 1
        if branched:
            event_count = 2
        decision_revision = (
            prior.decision_revision + 1
            if _stage_index(target_stage) <= _stage_index(WorkflowStageV3.DECIDE)
            else prior.decision_revision
        )
        audit_records = prior.audit_records
        affected_stage_run_ids = {
            item.stage_run_id for item in affected
        }
        if branched:
            affected_stage_run_ids.add(parent_current.stage_run_id)
        agent_activity = [
            item.copy(update={
                "state": AgentRunStateV3.NEEDS_HUMAN,
                "summary": "Activity stopped because its stage run was superseded.",
                "occurred_at": now,
                "completed_at": now,
                "failure_code": "stage_run_superseded",
            })
            if item.stage_run_id in affected_stage_run_ids
            and item.state == AgentRunStateV3.RUNNING
            else item
            for item in prior.agent_activity
        ]
        if branched:
            audit_records = [*audit_records, _audit_record(
                record_type=WorkflowAuditRecordTypeV3.ATTEMPT_BRANCHED,
                attempt_id=attempt.attempt_id,
                parent_attempt_id=prior.current_attempt.attempt_id,
                workflow_revision=prior.workflow_revision + 1,
                decision_revision=decision_revision,
                summary=command.reason,
                recorded_at=now,
                stage=target_stage,
                stage_run_id=next_run.stage_run_id,
                actor_subject_id=actor_subject_id,
                evidence_refs=parent_current.evidence_refs,
            )]
        else:
            audit_records = [*audit_records, *[
                _audit_record(
                    record_type=WorkflowAuditRecordTypeV3.STAGE_SUPERSEDED,
                    attempt_id=prior.current_attempt.attempt_id,
                    workflow_revision=prior.workflow_revision + 1,
                    decision_revision=decision_revision,
                    summary=command.reason,
                    recorded_at=now,
                    stage=item.stage,
                    stage_run_id=item.stage_run_id,
                    actor_subject_id=actor_subject_id,
                    evidence_refs=item.evidence_refs,
                    stage_output=item.output,
                )
                for item in affected
            ]]
        projection = self._next_base(
            prior, event_count=event_count, now=now, attempt=attempt,
            decision_revision=decision_revision,
            lifecycle_state=IncidentLifecycleStateV3.ACTIVE,
            attempt_history=attempt_history,
            audit_records=audit_records,
            agent_activity=agent_activity,
            evidence_queries=prior.evidence_queries,
            hypotheses=prior.hypotheses,
            actions=prior.actions,
        )
        events: List[IncidentEventV3] = []
        sequence = prior.sequence
        if branched:
            sequence += 1
            events.append(self._event(
                projection, sequence, WorkflowEventTypeV3.ATTEMPT_BRANCHED,
                now, actor_subject_id, run=next_run, summary=command.reason,
            ))
        else:
            for item in affected:
                sequence += 1
                events.append(self._event(
                    projection, sequence, WorkflowEventTypeV3.STAGE_SUPERSEDED,
                    now, actor_subject_id, run=item, summary=command.reason,
                    evidence_refs=item.evidence_refs,
                ))
        sequence += 1
        events.append(self._event(
            projection, sequence, WorkflowEventTypeV3.STAGE_STARTED,
            now, actor_subject_id, run=next_run,
            summary="{} stage rerun started.".format(target_stage.value.title()),
        ))
        return await self._commit_command(
            prior=prior, projection=projection, events=events, command=command,
            command_name=WorkflowCommandNameV3.RERUN_FROM_STAGE,
            actor_subject_id=actor_subject_id, now=now, command_hash=command_hash,
        )

    async def escalate(
        self,
        tenant_id: str,
        case_id: str,
        command: WorkflowEscalationCommandV3,
        actor_subject_id: str,
        now: datetime,
    ) -> WorkflowCommandReceiptV3:
        prior = await self._required_projection(tenant_id, case_id)
        replay = await self._replay(
            tenant_id, case_id, command.idempotency_key, command.canonical_hash(),
        )
        if replay is not None:
            return replay
        self._validate_command(prior, command)
        _require_command_authority(prior, WorkflowCommandNameV3.ESCALATE)
        current = _current_run(prior)
        terminal = current.copy(update={
            "status": WorkflowStageStateV3.NEEDS_HUMAN,
            "completed_at": now,
            "failure_code": "operator_escalation",
        })
        runs = [
            terminal if item.stage_run_id == current.stage_run_id else item
            for item in prior.current_attempt.stage_runs
        ]
        attempt = prior.current_attempt.copy(update={
            "status": WorkflowAttemptStateV3.NEEDS_HUMAN,
            "stage_runs": runs,
        })
        agent_activity = [
            item.copy(update={
                "state": AgentRunStateV3.NEEDS_HUMAN,
                "summary": "Activity stopped by operator escalation.",
                "occurred_at": now,
                "completed_at": now,
                "failure_code": "operator_escalation",
            })
            if item.stage_run_id == current.stage_run_id
            and item.state == AgentRunStateV3.RUNNING
            else item
            for item in prior.agent_activity
        ]
        escalation_audit = _audit_record(
            record_type=WorkflowAuditRecordTypeV3.ESCALATION_RECORDED,
            attempt_id=prior.current_attempt.attempt_id,
            workflow_revision=prior.workflow_revision + 1,
            decision_revision=prior.decision_revision,
            summary=command.reason,
            recorded_at=now,
            stage=current.stage,
            stage_run_id=current.stage_run_id,
            actor_subject_id=actor_subject_id,
            evidence_refs=current.evidence_refs,
            stage_output=current.output,
        )
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            lifecycle_state=IncidentLifecycleStateV3.NEEDS_HUMAN,
            audit_records=[*prior.audit_records, escalation_audit],
            agent_activity=agent_activity,
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.ESCALATED,
            now, actor_subject_id, run=terminal, summary=command.reason,
        )
        return await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.ESCALATE,
            actor_subject_id=actor_subject_id, now=now,
        )

    async def start_agent_run(
        self,
        tenant_id: str,
        case_id: str,
        command: AgentRunCommandV3,
        actor_subject_id: str,
        now: datetime,
        role_override: Optional[str] = None,
    ) -> WorkflowCommandReceiptV3:
        prior = await self._required_projection(tenant_id, case_id)
        replay = await self._replay(
            tenant_id, case_id, command.idempotency_key, command.canonical_hash(),
        )
        if replay is not None:
            return replay
        self._validate_command(prior, command)
        _require_command_authority(prior, WorkflowCommandNameV3.START_AGENT_RUN)
        current = _current_run(prior)
        if current.stage not in {
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        }:
            raise PolicyViolation("workflow_v3_agent_run_stage_forbidden")
        if command.component_id is not None and command.component_id not in {
            node.component_id for node in prior.graph.nodes
        }:
            raise PolicyViolation("workflow_v3_agent_component_not_canonical")
        default_role = {
            WorkflowStageV3.TRIAGE: "TRIAGE",
            WorkflowStageV3.INVESTIGATE: "INVESTIGATOR",
            WorkflowStageV3.DECIDE: "EVALUATOR",
        }[current.stage]
        role = role_override or default_role
        allowed_roles = {
            WorkflowStageV3.TRIAGE: {"TRIAGE", "OBSERVER"},
            WorkflowStageV3.INVESTIGATE: {
                "EVIDENCE_WORKER", "INVESTIGATOR", "CRITIC",
            },
            WorkflowStageV3.DECIDE: {"EVALUATOR"},
        }[current.stage]
        if role not in allowed_roles:
            raise PolicyViolation("workflow_v3_agent_role_invalid")
        agent_run = AgentActivityV3(
            activity_id=_stable_id(
                "agent-activity", prior.case_id, current.stage_run_id, command.idempotency_key,
            ),
            agent_run_id=_stable_id(
                "agent-run", prior.case_id, current.stage_run_id, command.idempotency_key,
            ),
            stage_run_id=current.stage_run_id,
            stage=current.stage,
            role=role,
            selected_component_id=(
                command.component_id
                or (prior.impacted_path[0] if prior.impacted_path else prior.graph.nodes[0].component_id)
            ),
            state=AgentRunStateV3.RUNNING,
            label={
                "TRIAGE": "Triage agent",
                "OBSERVER": "Triage observer",
                "INVESTIGATOR": "Investigator agent",
                "CRITIC": "Independent critic",
                "EVIDENCE_WORKER": "Evidence worker",
                "EVALUATOR": "Decision evaluator",
            }[role],
            progress_percent=0,
            summary=command.question or "Agent investigation started.",
            evidence_refs=[],
            occurred_at=now,
            started_at=now,
        )
        attempt = prior.current_attempt
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            workspace_revision=prior.workspace_revision + 1,
            agent_activity=[*prior.agent_activity, agent_run],
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.AGENT_RUN_STARTED,
            now, actor_subject_id, run=current, summary=agent_run.summary,
        )
        return await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.START_AGENT_RUN,
            actor_subject_id=actor_subject_id, now=now,
        )

    async def update_agent_run(
        self,
        tenant_id: str,
        case_id: str,
        agent_run_id: str,
        *,
        state: AgentRunStateV3,
        progress_percent: int,
        summary: str,
        evidence_refs: List[str],
        now: datetime,
        failure_code: Optional[str] = None,
        bridge_request: Optional[GuidedAgentBridgeRequestV3] = None,
    ) -> IncidentProjectionV3:
        prior = await self._required_projection(tenant_id, case_id)
        existing = next((
            item for item in prior.agent_activity
            if item.agent_run_id == agent_run_id
        ), None)
        if existing is None:
            raise PolicyViolation("workflow_v3_agent_run_not_found")
        current = _current_run(prior)
        if existing.stage_run_id != current.stage_run_id:
            # A late bridge response belongs to an immutable superseded run.
            # Return canonical state without emitting or mutating anything.
            return prior
        key = "internal-agent:{}:{}:{}".format(
            agent_run_id, state.value, progress_percent,
        )
        replay = await self.repository.workspace_command_v3(tenant_id, case_id, key)
        if replay is not None:
            return prior
        if existing.state != AgentRunStateV3.RUNNING:
            return prior
        if (
            bridge_request is not None
            and existing.bridge_request is not None
            and bridge_request != existing.bridge_request
        ):
            raise PolicyViolation("workflow_v3_agent_bridge_snapshot_immutable")
        if state == AgentRunStateV3.RUNNING:
            if progress_percent <= existing.progress_percent or progress_percent >= 100:
                raise PolicyViolation("workflow_v3_agent_progress_not_monotonic")
            completed_at = None
            event_type = WorkflowEventTypeV3.AGENT_RUN_PROGRESS
        elif state in {
            AgentRunStateV3.SUCCEEDED,
            AgentRunStateV3.FAILED,
            AgentRunStateV3.NEEDS_HUMAN,
        }:
            if state == AgentRunStateV3.SUCCEEDED and progress_percent != 100:
                raise PolicyViolation("workflow_v3_agent_success_requires_complete_progress")
            completed_at = now
            event_type = {
                AgentRunStateV3.SUCCEEDED: WorkflowEventTypeV3.AGENT_RUN_COMPLETED,
                AgentRunStateV3.FAILED: WorkflowEventTypeV3.AGENT_RUN_FAILED,
                AgentRunStateV3.NEEDS_HUMAN: WorkflowEventTypeV3.AGENT_RUN_FAILED,
            }[state]
        else:
            raise PolicyViolation("workflow_v3_agent_state_transition_invalid")
        changed = existing.copy(update={
            "state": state,
            "progress_percent": progress_percent,
            "summary": summary,
            "evidence_refs": list(dict.fromkeys(evidence_refs)),
            "occurred_at": now,
            "completed_at": completed_at,
            "failure_code": failure_code,
            "bridge_request": existing.bridge_request or bridge_request,
        })
        # Agent prose is append-only explanatory activity.  It must never be
        # promoted into StageFactV3 or mutate an already-published stage output.
        attempt = prior.current_attempt
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            workspace_revision=prior.workspace_revision + 1,
            agent_activity=[
                changed if item.agent_run_id == agent_run_id else item
                for item in prior.agent_activity
            ],
        )
        event = self._event(
            projection, projection.sequence, event_type, now, "flowpulse-worker",
            run=_current_run(projection), summary=summary,
            evidence_refs=changed.evidence_refs,
        )
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def record_evidence_query(
        self,
        tenant_id: str,
        case_id: str,
        result: EvidenceQueryResultV3,
        *,
        now: datetime,
    ) -> IncidentProjectionV3:
        """Persist one server-owned allowlisted query transition.

        A terminal result is immutable.  Only a successful refresh containing
        evidence that the current stage-run did not already hold may consume
        the single automatic replan budget.
        """

        prior = await self._required_projection(tenant_id, case_id)
        current = _current_run(prior)
        if (
            current.stage != WorkflowStageV3.INVESTIGATE
            or current.status != WorkflowStageStateV3.RUNNING
            or result.attempt_id != prior.current_attempt.attempt_id
            or result.stage_run_id != current.stage_run_id
            or result.stage != current.stage
        ):
            raise PolicyViolation("workflow_v3_evidence_query_scope_mismatch")
        worker = next((
            item for item in prior.agent_activity
            if item.activity_id == result.worker_activity_id
        ), None)
        if (
            worker is None
            or worker.role != "EVIDENCE_WORKER"
            or worker.stage_run_id != current.stage_run_id
        ):
            raise PolicyViolation("workflow_v3_evidence_query_worker_mismatch")
        existing = next((
            item for item in prior.evidence_queries
            if item.query_id == result.query_id
        ), None)
        if existing is None:
            if result.state != EvidenceQueryStateV3.RUNNING:
                raise PolicyViolation("workflow_v3_evidence_query_must_start_running")
        else:
            if existing.state != EvidenceQueryStateV3.RUNNING:
                if existing == result:
                    return prior
                raise PolicyViolation("workflow_v3_evidence_query_result_immutable")
            immutable_identity = (
                "attempt_id", "stage_run_id", "stage", "worker_activity_id",
                "query_name", "parameters_hash", "started_at",
            )
            if any(
                getattr(existing, field) != getattr(result, field)
                for field in immutable_identity
            ):
                raise PolicyViolation("workflow_v3_evidence_query_identity_immutable")
            if result.state == EvidenceQueryStateV3.RUNNING:
                if existing == result:
                    return prior
                raise PolicyViolation("workflow_v3_evidence_query_progress_forbidden")

        newly_observed = set(result.evidence_refs) - set(current.evidence_refs)
        if result.triggered_replan and (
            result.state != EvidenceQueryStateV3.SUCCEEDED
            or not newly_observed
            or current.replan_count >= 1
        ):
            raise PolicyViolation("workflow_v3_evidence_replan_not_new_or_exhausted")
        next_run = current
        if result.state == EvidenceQueryStateV3.SUCCEEDED:
            next_run = current.copy(update={
                "evidence_refs": list(dict.fromkeys([
                    *current.evidence_refs, *result.evidence_refs,
                ])),
                "replan_count": current.replan_count + int(result.triggered_replan),
            })
        attempt = prior.current_attempt.copy(update={
            "stage_runs": [
                next_run if item.stage_run_id == current.stage_run_id else item
                for item in prior.current_attempt.stage_runs
            ],
        })
        queries = [
            result if item.query_id == result.query_id else item
            for item in prior.evidence_queries
        ] if existing is not None else [*prior.evidence_queries, result]
        event_type = {
            EvidenceQueryStateV3.RUNNING: WorkflowEventTypeV3.EVIDENCE_QUERY_STARTED,
            EvidenceQueryStateV3.SUCCEEDED: WorkflowEventTypeV3.EVIDENCE_QUERY_COMPLETED,
            EvidenceQueryStateV3.FAILED: WorkflowEventTypeV3.EVIDENCE_QUERY_FAILED,
        }[result.state]
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            workspace_revision=prior.workspace_revision + 1,
            evidence_queries=queries,
        )
        event = self._event(
            projection, projection.sequence, event_type, now,
            "flowpulse-evidence-worker", run=next_run,
            summary=result.result_summary,
            evidence_refs=result.evidence_refs,
        )
        key = "internal-evidence-query:{}:{}".format(
            result.query_id, result.state.value,
        )
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-evidence-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def add_action(
        self, tenant_id: str, case_id: str, action: IncidentActionV3, now: datetime,
    ) -> IncidentProjectionV3:
        prior = await self._required_projection(tenant_id, case_id)
        current = _current_run(prior)
        if current.stage != WorkflowStageV3.RESPOND:
            raise PolicyViolation("workflow_v3_action_requires_respond_stage")
        if (
            action.attempt_id != prior.current_attempt.attempt_id
            or action.stage_run_id != current.stage_run_id
            or action.decision_revision != prior.decision_revision
        ):
            raise PolicyViolation("workflow_v3_action_scope_mismatch")
        decide_run = next((
            item for item in reversed(prior.current_attempt.stage_runs)
            if item.stage == WorkflowStageV3.DECIDE
            and item.status == WorkflowStageStateV3.SUCCEEDED
            and item.output is not None
            and item.output.action_candidate is not None
        ), None)
        candidate = decide_run.output.action_candidate if decide_run is not None else None
        if candidate is None or any((
            action.command_id != candidate.command_id,
            action.component_id != candidate.component_id,
            action.title != candidate.title,
            action.summary != candidate.summary,
            action.decision_revision != candidate.decision_revision,
            action.blast_radius != candidate.blast_radius,
            action.risk != candidate.risk,
            action.rollback_plan != candidate.rollback_plan,
            action.verification_conditions != candidate.verification_conditions,
        )):
            raise PolicyViolation("workflow_v3_action_not_derived_from_decision")
        if any(item.action_id == action.action_id and item != action for item in prior.actions):
            raise PolicyViolation("workflow_v3_action_immutable")
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=prior.current_attempt,
            actions=list({item.action_id: item for item in [*prior.actions, action]}.values()),
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.STAGE_PROGRESS,
            now, None, run=current, summary="Response action proposal recorded.",
        )
        key = "internal-action:{}".format(action.action_id)
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def approve_action(
        self,
        tenant_id: str,
        case_id: str,
        action_id: str,
        command: ActionApprovalCommandV3,
        actor_subject_id: str,
        roles: Iterable[str],
        now: datetime,
    ) -> WorkflowCommandReceiptV3:
        prior = await self._required_projection(tenant_id, case_id)
        command_hash = sha256(
            "{}:{}".format(command.canonical_hash(), action_id).encode("utf-8"),
        ).hexdigest()
        replay = await self._replay(tenant_id, case_id, command.idempotency_key, command_hash)
        if replay is not None:
            return replay
        self._validate_command(prior, command)
        if not set(roles).intersection({"owner", "local-test-owner"}):
            raise PolicyViolation("owner_role_required")
        _require_command_authority(
            prior,
            WorkflowCommandNameV3.APPROVE_ACTION
            if command.decision == ActionApprovalDecisionV3.APPROVE
            else WorkflowCommandNameV3.REJECT_ACTION,
        )
        if prior.current_attempt.current_stage != WorkflowStageV3.RESPOND:
            raise PolicyViolation("workflow_v3_action_approval_stage_mismatch")
        action = next((item for item in prior.actions if item.action_id == action_id), None)
        if action is None:
            raise PolicyViolation("workflow_v3_action_not_found")
        current = _current_run(prior)
        if (
            action.attempt_id != prior.current_attempt.attempt_id
            or action.stage_run_id != current.stage_run_id
        ):
            raise PolicyViolation("workflow_v3_action_approval_scope_mismatch")
        if (
            command.expected_decision_revision != prior.decision_revision
            or action.decision_revision != prior.decision_revision
        ):
            raise PolicyViolation("workflow_v3_action_revalidation_required")
        if action.approval_state != ActionApprovalStateV3.PENDING:
            raise PolicyViolation("workflow_v3_action_already_decided")
        approved = command.decision == ActionApprovalDecisionV3.APPROVE
        changed = action.copy(update={
            "approval_state": (
                ActionApprovalStateV3.APPROVED
                if approved else ActionApprovalStateV3.REJECTED
            ),
            "status": (
                IncidentActionStatusV3.APPROVED
                if approved else IncidentActionStatusV3.REJECTED
            ),
        })
        actions = [changed if item.action_id == action_id else item for item in prior.actions]
        approval_audit = _audit_record(
            record_type=WorkflowAuditRecordTypeV3.APPROVAL_RECORDED,
            attempt_id=prior.current_attempt.attempt_id,
            workflow_revision=prior.workflow_revision + 1,
            decision_revision=prior.decision_revision,
            summary=command.reason or ("Action approved." if approved else "Action rejected."),
            recorded_at=now,
            stage=WorkflowStageV3.RESPOND,
            stage_run_id=_current_run(prior).stage_run_id,
            action_id=action_id,
            actor_subject_id=actor_subject_id,
            approval_decision=command.decision.value,
        )
        attempt = prior.current_attempt
        event_count = 1
        audit_records = [*prior.audit_records, approval_audit]
        if not approved:
            terminal = current.copy(update={
                "status": WorkflowStageStateV3.FAILED,
                "completed_at": now,
                "failure_code": "action_rejected",
                "output": None,
            })
            attempt = prior.current_attempt.copy(update={
                "stage_runs": [
                    terminal if item.stage_run_id == current.stage_run_id else item
                    for item in prior.current_attempt.stage_runs
                ],
            })
            event_count = 2
            audit_records.append(_audit_record(
                record_type=WorkflowAuditRecordTypeV3.STAGE_FAILED,
                attempt_id=prior.current_attempt.attempt_id,
                workflow_revision=prior.workflow_revision + 1,
                decision_revision=prior.decision_revision,
                summary=command.reason or "Owner rejected the proposed response action.",
                recorded_at=now,
                stage=WorkflowStageV3.RESPOND,
                stage_run_id=current.stage_run_id,
                action_id=action_id,
                actor_subject_id=actor_subject_id,
            ))
        projection = self._next_base(
            prior, event_count=event_count, now=now, attempt=attempt,
            actions=actions,
            audit_records=audit_records,
            lifecycle_state=(
                prior.lifecycle_state if approved else IncidentLifecycleStateV3.DEGRADED
            ),
        )
        events = [self._event(
            projection, prior.sequence + 1,
            WorkflowEventTypeV3.ACTION_APPROVED if approved else WorkflowEventTypeV3.ACTION_REJECTED,
            now, actor_subject_id, run=_current_run(projection),
            summary=command.reason or ("Action approved." if approved else "Action rejected."),
        )]
        if not approved:
            events.append(self._event(
                projection, prior.sequence + 2, WorkflowEventTypeV3.STAGE_FAILED,
                now, actor_subject_id, run=_current_run(projection),
                summary=command.reason or "Owner rejected the proposed response action.",
            ))
        return await self._commit_command(
            prior=prior, projection=projection, events=events, command=command,
            command_name=(
                WorkflowCommandNameV3.APPROVE_ACTION
                if approved else WorkflowCommandNameV3.REJECT_ACTION
            ),
            actor_subject_id=actor_subject_id, now=now, command_hash=command_hash,
        )

    async def record_action_execution(
        self,
        tenant_id: str,
        case_id: str,
        action_id: str,
        receipt: ActionExecutionReceiptV3,
        *, now: datetime,
    ) -> IncidentProjectionV3:
        """Record an executor receipt; this method never performs or fakes repair."""
        prior = await self._required_projection(tenant_id, case_id)
        action = next((item for item in prior.actions if item.action_id == action_id), None)
        if action is None:
            raise PolicyViolation("workflow_v3_action_not_found")
        current = _current_run(prior)
        if (
            current.stage != WorkflowStageV3.RESPOND
            or action.attempt_id != prior.current_attempt.attempt_id
            or action.stage_run_id != current.stage_run_id
        ):
            raise PolicyViolation("workflow_v3_action_execution_scope_mismatch")
        if action.approval_state != ActionApprovalStateV3.APPROVED:
            raise PolicyViolation("workflow_v3_action_execution_requires_approval")
        if receipt.command_id != action.command_id:
            raise PolicyViolation("workflow_v3_action_receipt_command_mismatch")
        if action.receipt is not None:
            if action.receipt == receipt:
                return prior
            raise PolicyViolation("workflow_v3_action_receipt_immutable")
        if action.execution_state not in {
            ActionExecutionStateV3.NOT_STARTED,
            ActionExecutionStateV3.RUNNING,
        }:
            raise PolicyViolation("workflow_v3_action_execution_already_terminal")
        success = receipt.status == ActionExecutionStateV3.SUCCEEDED
        action_boundary_crossed = receipt.status in {
            ActionExecutionStateV3.SUCCEEDED,
            ActionExecutionStateV3.NEEDS_HUMAN,
        }
        changed = action.copy(update={
            "execution_state": receipt.status,
            "status": {
                ActionExecutionStateV3.SUCCEEDED: IncidentActionStatusV3.SUCCEEDED,
                ActionExecutionStateV3.FAILED: IncidentActionStatusV3.FAILED,
                ActionExecutionStateV3.ROLLED_BACK: IncidentActionStatusV3.ROLLED_BACK,
                ActionExecutionStateV3.NEEDS_HUMAN: IncidentActionStatusV3.NEEDS_HUMAN,
            }[receipt.status],
            "receipt": receipt,
        })
        attempt = prior.current_attempt.copy(update={
            # NEEDS_HUMAN means the adapter could not prove whether the
            # external mutation committed. Treat that as an irreversible
            # action boundary so no retry can issue a second execution key.
            "action_executed": action_boundary_crossed,
            "action_receipt_id": (
                receipt.receipt_id if action_boundary_crossed else None
            ),
        })
        receipt_audit = _audit_record(
            record_type=WorkflowAuditRecordTypeV3.ACTION_RECEIPT_RECORDED,
            attempt_id=prior.current_attempt.attempt_id,
            workflow_revision=prior.workflow_revision + 1,
            decision_revision=prior.decision_revision,
            summary=receipt.output_summary,
            recorded_at=now,
            stage=WorkflowStageV3.RESPOND,
            stage_run_id=action.stage_run_id,
            action_id=action.action_id,
            actor_subject_id="flowpulse-worker",
            action_receipt=receipt,
        )
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            lifecycle_state=(
                IncidentLifecycleStateV3.EXECUTING
                if success else IncidentLifecycleStateV3.NEEDS_HUMAN
            ),
            actions=[changed if item.action_id == action_id else item for item in prior.actions],
            audit_records=[*prior.audit_records, receipt_audit],
        )
        event = self._event(
            projection, projection.sequence,
            WorkflowEventTypeV3.ACTION_COMPLETED if success else WorkflowEventTypeV3.ACTION_FAILED,
            now, "flowpulse-worker", run=_current_run(projection),
            summary=receipt.output_summary,
        )
        key = "internal-action-execution:{}:{}".format(action_id, receipt.receipt_id)
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def mark_action_execution_started(
        self,
        tenant_id: str,
        case_id: str,
        action_id: str,
        *,
        now: datetime,
    ) -> IncidentProjectionV3:
        """Persist the idempotent execution claim before any external mutation."""
        prior = await self._required_projection(tenant_id, case_id)
        action = next((item for item in prior.actions if item.action_id == action_id), None)
        if action is None:
            raise PolicyViolation("workflow_v3_action_not_found")
        current = _current_run(prior)
        if (
            current.stage != WorkflowStageV3.RESPOND
            or action.attempt_id != prior.current_attempt.attempt_id
            or action.stage_run_id != current.stage_run_id
        ):
            raise PolicyViolation("workflow_v3_action_execution_scope_mismatch")
        if action.approval_state != ActionApprovalStateV3.APPROVED:
            raise PolicyViolation("workflow_v3_action_execution_requires_approval")
        if action.execution_state == ActionExecutionStateV3.RUNNING:
            return prior
        if action.execution_state != ActionExecutionStateV3.NOT_STARTED:
            raise PolicyViolation("workflow_v3_action_execution_already_terminal")
        changed = action.copy(update={
            "execution_state": ActionExecutionStateV3.RUNNING,
            "status": IncidentActionStatusV3.EXECUTING,
        })
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=prior.current_attempt,
            lifecycle_state=IncidentLifecycleStateV3.EXECUTING,
            actions=[
                changed if item.action_id == action_id else item
                for item in prior.actions
            ],
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.ACTION_STARTED,
            now, "flowpulse-worker", run=_current_run(projection),
            summary="Approved response action execution started.",
        )
        key = "internal-action-execution-started:{}".format(action_id)
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def record_action_rollback_outcome(
        self,
        tenant_id: str,
        case_id: str,
        action_id: str,
        *,
        succeeded: bool,
        summary: str,
        rollback_receipt: Optional[ActionRollbackReceiptV3] = None,
        now: datetime,
    ) -> IncidentProjectionV3:
        """Persist one bounded Verify rollback outcome without re-execution."""

        prior = await self._required_projection(tenant_id, case_id)
        action = next((item for item in prior.actions if item.action_id == action_id), None)
        if action is None or action.receipt is None:
            raise PolicyViolation("workflow_v3_rollback_action_receipt_required")
        expected_state = (
            ActionExecutionStateV3.ROLLED_BACK
            if succeeded else ActionExecutionStateV3.NEEDS_HUMAN
        )
        expected_execution_key = _stable_id(
            "action-rollback", prior.case_id, action.action_id,
            action.decision_revision,
        )
        if succeeded:
            if (
                rollback_receipt is None
                or rollback_receipt.execution_key != expected_execution_key
                or rollback_receipt.action_id != action.action_id
                or rollback_receipt.command_id != action.command_id
            ):
                raise PolicyViolation("workflow_v3_rollback_receipt_scope_mismatch")
        elif rollback_receipt is not None:
            raise PolicyViolation("workflow_v3_failed_rollback_cannot_publish_receipt")
        if action.execution_state in {
            ActionExecutionStateV3.ROLLED_BACK,
            ActionExecutionStateV3.NEEDS_HUMAN,
        }:
            if (
                action.execution_state == expected_state
                and action.rollback_receipt == rollback_receipt
            ):
                return prior
            raise PolicyViolation("workflow_v3_rollback_outcome_immutable")
        if action.execution_state != ActionExecutionStateV3.SUCCEEDED:
            raise PolicyViolation("workflow_v3_rollback_requires_succeeded_action")
        changed = action.copy(update={
            "execution_state": expected_state,
            "status": (
                IncidentActionStatusV3.ROLLED_BACK
                if succeeded else IncidentActionStatusV3.NEEDS_HUMAN
            ),
            "rollback_receipt": rollback_receipt,
        })
        current = _current_run(prior)
        human_run = current.copy(update={
            "status": WorkflowStageStateV3.NEEDS_HUMAN,
            "completed_at": now,
            "failure_code": (
                "verification_failed_action_safely_rolled_back"
                if succeeded else "verification_failed_rollback_unavailable"
            ),
        })
        attempt = prior.current_attempt.copy(update={
            "status": WorkflowAttemptStateV3.NEEDS_HUMAN,
            "stage_runs": [
                human_run if item.stage_run_id == current.stage_run_id else item
                for item in prior.current_attempt.stage_runs
            ],
        })
        audit = _audit_record(
            record_type=WorkflowAuditRecordTypeV3.ROLLBACK_OUTCOME,
            attempt_id=prior.current_attempt.attempt_id,
            workflow_revision=prior.workflow_revision + 1,
            decision_revision=prior.decision_revision,
            summary=summary,
            recorded_at=now,
            stage=WorkflowStageV3.VERIFY,
            stage_run_id=current.stage_run_id,
            action_id=action_id,
            actor_subject_id="flowpulse-worker",
            action_receipt=action.receipt,
            rollback_receipt=rollback_receipt,
        )
        projection = self._next_base(
            prior, event_count=1, now=now, attempt=attempt,
            lifecycle_state=IncidentLifecycleStateV3.NEEDS_HUMAN,
            actions=[
                changed if item.action_id == action_id else item
                for item in prior.actions
            ],
            audit_records=[*prior.audit_records, audit],
        )
        event = self._event(
            projection, projection.sequence, WorkflowEventTypeV3.ACTION_FAILED,
            now, "flowpulse-worker", run=human_run, summary=summary,
        )
        key = "internal-action-rollback:{}:{}".format(
            action_id, "succeeded" if succeeded else "failed",
        )
        command = WorkflowCommandV3(
            attempt_id=prior.current_attempt.attempt_id,
            expected_stage=prior.current_attempt.current_stage,
            expected_workflow_revision=prior.workflow_revision,
            idempotency_key=key,
        )
        await self._commit_command(
            prior=prior, projection=projection, events=[event], command=command,
            command_name=WorkflowCommandNameV3.RETRY,
            actor_subject_id="flowpulse-worker", now=now,
            command_hash=sha256(key.encode("utf-8")).hexdigest(),
        )
        return projection

    async def _required_projection(
        self, tenant_id: str, case_id: str,
    ) -> IncidentProjectionV3:
        projection = await self.repository.workspace_projection_v3(tenant_id, case_id)
        if projection is None:
            raise PolicyViolation("workflow_v3_projection_not_found")
        return projection

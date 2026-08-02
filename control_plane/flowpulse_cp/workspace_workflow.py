"""Temporal workflow for the additive, public-identity Incident Workspace."""

import asyncio
from datetime import timedelta
from typing import Any, Dict, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

# Pydantic v1 model inheritance deep-copies datetime field descriptors during
# Temporal's sandbox import. The contracts are immutable parsing utilities, so
# pass this dependency through exactly as the worker/importer loaded it.
with workflow.unsafe.imports_passed_through():
    from pydantic import Field, ValidationError, root_validator
    from .models import NonEmpty, PositiveInt, StrictModel
    from .workspace_models import (
        IncidentRunBinding,
        IncidentProjection,
        NodeExplanationReceipt,
        NodeExplanationStart,
        WorkspaceNodeExplanationInvocation,
        WorkspaceNodeExplanationAuthorizationOutcome,
        WorkspaceNodeExplanationAuthorizationPacket,
        WorkspaceActivityOutcome,
        WorkspaceActivityPacket,
        WorkspaceWorkflowRequest,
        initial_projection,
    )
    from .workspace_actions import (
        ActionInvocationCommand,
        WorkspaceActionAuthorizationOutcome,
        WorkspaceActionAuthorizationPacket,
        WorkspaceActionGenerationOutcome,
        WorkspaceActionGenerationPacket,
        WorkspaceActionInvocation,
        WorkspaceActionOutcome,
        WorkspaceActionPacket,
        WorkspaceActionReceipt,
    )
    from .workspace_investigation import (
        InvestigationCriticOutcome,
        InvestigationSynthesisDisposition,
        InvestigationSynthesisOutcome,
        WorkspaceInvestigationCriticPacket,
        WorkspaceInvestigationFinalizePacket,
        WorkspaceInvestigationOutcome,
        WorkspaceInvestigationSynthesisPacket,
        temporal_investigation_finalize_activity,
    )
    from .workspace_versions import WORKSPACE_V2_WORKFLOW_TYPE
    from .realtime_models import (
        ConnectorPollResult,
        IncidentProjectionV2,
        RealtimeCommitActivityPacket,
        RealtimeFreshnessExpiryActivityOutcome,
        RealtimeFreshnessExpiryActivityPacket,
        RealtimeFreshnessTimerLoadPacket,
        RealtimePollActivityPacket,
        RealtimeUpdateCommand,
        RealtimeUpdateOutcome,
        TemporalFreshnessTimer,
    )
    from .workspace_v3_models import (
        ActionApprovalCommandV3,
        ActionApprovalDecisionV3,
        ActionExecutionStateV3,
        AgentRunStateV3,
        GuidedActionActivityPacketV3,
        GuidedAgentActivityPacketV3,
        GuidedStageActivityOutcomeV3,
        GuidedStageActivityPacketV3,
        GuidedStageActivityStatusV3,
        IncidentExecutionIdentityV3,
        TemporalExecutionPointerV3,
        WorkflowCommandReceiptV3,
        WorkflowStageStateV3,
        WorkflowStageV3,
        WorkflowTemporalCommandV3,
        WorkflowTemporalOperationV3,
        WorkspaceExecutionRegistrationV3,
    )


WORKSPACE_V2_ACTIONS_PATCH = "workspace-v2-gate1-next-best-actions"
WORKSPACE_V2_ACTION_COMMIT_PATCH = "workspace-v2-gate1-atomic-action-commit"
WORKSPACE_V2_INVESTIGATION_PATCH = "workspace-v2-investigation-decide-handoff"
WORKSPACE_V2_STAFF_INCIDENT_CONTRACT_PATCH = "workspace-v2-staff-incident-contract-v1"
WORKSPACE_V2_REALTIME_ROLLOVER_PATCH = "workspace-v2-realtime-continue-as-new-v1"
WORKSPACE_V3_TEMPORAL_FRESHNESS_PATCH = "workspace-v3-temporal-freshness-authority-v1"

ROLLOVER_HISTORY_LENGTH_LIMIT = 1_500
ROLLOVER_HISTORY_SIZE_LIMIT = 24 * 1024 * 1024
ROLLOVER_TRANSITION_LIMIT = 500
GUIDED_ACTIVITY_MAX_ATTEMPTS = 3
_LEGACY_PROJECTION_ABSENT_FIELDS = {
    "operator_title", "operator_summary", "lifecycle_stage", "gate1_state",
    "investigation_result",
}


def _parse_workspace_activity_outcome(result: Dict[str, Any]) -> WorkspaceActivityOutcome:
    """Keep the one malformed initializer shape already stored in Temporal readable."""
    try:
        return WorkspaceActivityOutcome.parse_obj(result)
    except ValidationError:
        projection = result.get("projection") if isinstance(result, dict) else None
        graph = projection.get("graph") if isinstance(projection, dict) else None
        nodes = graph.get("nodes") if isinstance(graph, dict) else None
        legacy = (
            projection is not None
            and projection.get("schema_version") == "flowpulse.incident-projection.v1"
            and not any(field in projection for field in _LEGACY_PROJECTION_ABSENT_FIELDS)
            and projection.get("lifecycle_state") == "DEGRADED"
            and projection.get("status") == "provider_unavailable"
            and projection.get("degraded_code") == "provider_unavailable"
            and projection.get("impacted_path") == []
            and isinstance(graph, dict)
            and graph.get("edges") == []
            and isinstance(nodes, list)
            and bool(nodes)
            and all(
                isinstance(node, dict)
                and "display_name" not in node
                and node.get("membership") == "CONNECTED"
                and node.get("classification_reason") is None
                and node.get("runtime_status") == "unknown"
                and node.get("impact_status") == "unknown"
                for node in nodes
            )
        )
        if not legacy:
            raise
        compatible = dict(result)
        compatible["projection"] = dict(projection)
        compatible["projection"]["graph"] = dict(graph)
        compatible["projection"]["graph"]["nodes"] = [
            {**node, "membership": "CLASSIFIED", "classification_reason": "Relationship unavailable"}
            for node in nodes
        ]
        return WorkspaceActivityOutcome.parse_obj(compatible)


def _guided_activity_retry_policy() -> RetryPolicy:
    """Bound transient/lost-response retries around durable V3 activity keys."""

    return RetryPolicy(
        initial_interval=timedelta(seconds=1),
        maximum_interval=timedelta(seconds=5),
        backoff_coefficient=2.0,
        maximum_attempts=GUIDED_ACTIVITY_MAX_ATTEMPTS,
    )


class _InterleavableGuidedScope:
    """No-op scope: durable repository CAS serializes guided commands.

    Verify intentionally stays interleavable so realtime connector updates can
    commit the post-repair samples its Temporal timer is observing.
    """

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class WorkspaceV2RolloverCarry(StrictModel):
    """Bounded V2 state carried into the next physical Temporal execution."""

    schema_version: NonEmpty = "flowpulse.workspace-v2-rollover.v1"
    execution: TemporalExecutionPointerV3
    projection: IncidentProjection
    realtime_projection: Optional[IncidentProjectionV2] = None
    event_sequence: PositiveInt
    explanations: Dict[NonEmpty, Dict[str, Any]] = Field(default_factory=dict)
    actions: Dict[NonEmpty, Dict[str, Any]] = Field(default_factory=dict)
    action_receipts: Dict[NonEmpty, Dict[str, Any]] = Field(default_factory=dict)
    realtime_receipts: Dict[NonEmpty, Dict[str, Any]] = Field(default_factory=dict)
    freshness_timers: Dict[NonEmpty, TemporalFreshnessTimer] = Field(
        default_factory=dict,
    )

    @root_validator(allow_reuse=True)
    def carry_maps_are_bounded(cls, values):
        for field, limit in {
            "explanations": 64,
            "actions": 64,
            "action_receipts": 64,
            "realtime_receipts": 128,
            "freshness_timers": 16,
        }.items():
            if len(values.get(field, {})) > limit:
                raise ValueError("workspace_v2_rollover_{}_exceeds_limit".format(field))
        return values


@workflow.defn(name=WORKSPACE_V2_WORKFLOW_TYPE)
class IncidentWorkspaceTemporalWorkflow:
    """Authenticated v2 Temporal owner for new workspace executions."""

    def __init__(self) -> None:
        self._initialized = False
        self._rollover_enabled = False
        self._rollover_requested = False
        self._active_updates = 0
        self._accepted_realtime_transitions = 0
        self._binding = None
        self._execution_pointer = None
        self._projection = None
        self._event_sequence = 0
        self._explanations: Dict[str, Dict[str, Any]] = {}
        self._actions: Dict[str, Dict[str, Any]] = {}
        self._action_receipts: Dict[str, Dict[str, Any]] = {}
        self._realtime_projection = None
        self._realtime_receipts: Dict[str, Dict[str, Any]] = {}
        self._temporal_freshness_enabled = False
        self._freshness_timers: Dict[str, TemporalFreshnessTimer] = {}
        self._freshness_timer_epoch = 0
        self._freshness_expiration_active = False
        self._lock = asyncio.Lock()

    def _rollover_due(self) -> bool:
        info = workflow.info()
        return (
            self._accepted_realtime_transitions >= ROLLOVER_TRANSITION_LIMIT
            or info.get_current_history_length() >= ROLLOVER_HISTORY_LENGTH_LIMIT
            or info.get_current_history_size() >= ROLLOVER_HISTORY_SIZE_LIMIT
        )

    def _can_rollover(self) -> bool:
        return (
            self._rollover_requested
            and self._active_updates == 0
            and not self._freshness_expiration_active
            and all(
                timer.deadline.deadline > workflow.now()
                for timer in self._freshness_timers.values()
            )
        )

    def _rollover_carry(self) -> WorkspaceV2RolloverCarry:
        return WorkspaceV2RolloverCarry(
            execution=self._execution_pointer,
            projection=self._projection,
            realtime_projection=self._realtime_projection,
            event_sequence=self._event_sequence,
            # These are disposable workflow caches; their durable source is Postgres.
            # Carrying full projection receipts can exceed Temporal's 2 MB input limit.
            explanations={},
            actions={},
            action_receipts={},
            realtime_receipts={},
            freshness_timers=dict(self._freshness_timers),
        )

    def _packet(self, stage: str, *, command: NodeExplanationStart = None, actor=None) -> WorkspaceActivityPacket:
        return WorkspaceActivityPacket(
            **self._binding.dict(), stage=stage, projection=self._projection,
            event_sequence=self._event_sequence, node_explanation=command, actor=actor,
        )

    @staticmethod
    def _activity_packet_contract(packet: Dict[str, Any]) -> Dict[str, Any]:
        """Keep pre-v1.3 v2 histories byte-compatible while new runs carry the additive contract."""
        if workflow.patched(WORKSPACE_V2_STAFF_INCIDENT_CONTRACT_PATCH):
            return packet
        projection = packet.get("projection")
        if projection is None:
            return packet
        projection.pop("incident_focus", None)
        projection.pop("conversation_items", None)
        critic = (projection.get("investigation_result") or {}).get("critic")
        if critic is not None:
            critic.pop("operator_status", None)
        return packet

    async def _activity(self, stage: str, *, command: NodeExplanationStart = None, actor=None) -> WorkspaceActivityOutcome:
        packet = self._activity_packet_contract(
            self._packet(stage, command=command, actor=actor).dict(),
        )
        # Keep parent workspace activity inputs byte-compatible when the old
        # direct update form carried no trusted actor packet.
        if packet.get("actor") is None:
            packet.pop("actor", None)
        result = await workflow.execute_activity(
            stage + "_activity", packet,
            start_to_close_timeout=timedelta(minutes=2),
        )
        return _parse_workspace_activity_outcome(result)

    async def _action_activity(self, name: str, packet: Dict[str, Any]) -> Dict[str, Any]:
        return await workflow.execute_activity(
            name, self._activity_packet_contract(packet),
            start_to_close_timeout=timedelta(minutes=2),
        )

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request_payload = dict(request_data)
        carry_payload = request_payload.pop("rollover_carry", None)
        request = WorkspaceWorkflowRequest.parse_obj(request_payload)
        request_values = request.copy(update={"workflow_run_id": workflow.info().run_id}).dict()
        self._binding = IncidentRunBinding.parse_obj({
            field: request_values[field] for field in IncidentRunBinding.__fields__
        })
        self._rollover_enabled = workflow.patched(WORKSPACE_V2_REALTIME_ROLLOVER_PATCH)
        self._temporal_freshness_enabled = workflow.patched(
            WORKSPACE_V3_TEMPORAL_FRESHNESS_PATCH,
        )
        carry = (
            WorkspaceV2RolloverCarry.parse_obj(carry_payload)
            if carry_payload is not None else None
        )
        if carry is not None and not self._rollover_enabled:
            raise ValueError("workspace_v2_rollover_carry_requires_patch")
        if self._rollover_enabled:
            prior = carry.execution if carry is not None else None
            current = TemporalExecutionPointerV3(
                tenant_id=self._binding.tenant_id,
                incident_run_id=self._binding.run_id,
                temporal_workflow_id=self._binding.workflow_id,
                temporal_run_id=workflow.info().run_id,
                temporal_generation=(
                    1 if prior is None else prior.temporal_generation + 1
                ),
                updated_at=workflow.now(),
            )
            registered = await workflow.execute_activity(
                "workspace_register_execution_v3_activity",
                WorkspaceExecutionRegistrationV3(
                    identity=IncidentExecutionIdentityV3(
                        tenant_id=self._binding.tenant_id,
                        incident_id=self._binding.incident_id,
                        incident_run_id=self._binding.run_id,
                        topology_revision=self._binding.topology_revision,
                        case_id=self._binding.case_id,
                        case_revision=self._binding.case_revision,
                        temporal_workflow_id=self._binding.workflow_id,
                        created_at=self._binding.created_at,
                    ),
                    prior=prior,
                    current=current,
                ).dict(),
                start_to_close_timeout=timedelta(minutes=1),
            )
            self._execution_pointer = TemporalExecutionPointerV3.parse_obj(registered)
        if carry is not None:
            self._projection = carry.projection
            self._realtime_projection = carry.realtime_projection
            self._event_sequence = carry.event_sequence
            self._explanations = dict(carry.explanations)
            self._actions = dict(carry.actions)
            self._action_receipts = dict(carry.action_receipts)
            self._realtime_receipts = dict(carry.realtime_receipts)
            self._freshness_timers = dict(carry.freshness_timers)
        else:
            self._event_sequence = 1
            self._projection = initial_projection(
                self._binding, request.affected_entities, request.created_at, request.title, request.summary,
            )
            # The initializer receives only the trusted intake identity and appends
            # its durable workspace-subject grant before the projection is readable.
            initialized = await self._activity("workspace_initialize", actor=request.actor)
            self._projection = initialized.projection or self._projection
            # Existing v2 histories have no marker and replay their frozen
            # initializer exactly. New starts record the marker before Gate 1/card
            # activities become part of their command history.
            if workflow.patched(WORKSPACE_V2_ACTIONS_PATCH):
                generated = await self._action_activity(
                    "workspace_generate_actions_activity",
                    WorkspaceActionGenerationPacket(**self._binding.dict(), projection=self._projection).dict(),
                )
                actions = WorkspaceActionGenerationOutcome.parse_obj(generated).actions
                self._actions = {action.action_id: action.dict() for action in actions}
        self._initialized = True
        if not self._rollover_enabled:
            await workflow.wait_condition(lambda: False)
            return {"state": "unreachable"}
        while not self._can_rollover():
            observed_epoch = self._freshness_timer_epoch
            timer_item = (
                min(
                    self._freshness_timers.items(),
                    key=lambda item: (
                        item[1].deadline.deadline,
                        item[0],
                    ),
                )
                if self._temporal_freshness_enabled
                and self._freshness_timers
                else None
            )
            if timer_item is None:
                await workflow.wait_condition(lambda: (
                    self._can_rollover()
                    or self._freshness_timer_epoch != observed_epoch
                ))
                continue
            connector_id, timer = timer_item
            delay = max(
                0.0,
                (timer.deadline.deadline - workflow.now()).total_seconds(),
            )
            try:
                await workflow.wait_condition(
                    lambda: (
                        self._can_rollover()
                        or self._freshness_timer_epoch != observed_epoch
                    ),
                    timeout=delay,
                    timeout_summary="incident connector freshness deadline",
                )
                continue
            except asyncio.TimeoutError:
                pass
            async with self._lock:
                current = self._freshness_timers.get(connector_id)
                if current != timer or workflow.now() < timer.deadline.deadline:
                    continue
                self._freshness_expiration_active = True
                try:
                    raw = await workflow.execute_activity(
                        "workspace_expire_realtime_freshness_activity",
                        RealtimeFreshnessExpiryActivityPacket(
                            deadline=timer.deadline,
                            actor_subject_id=timer.actor_subject_id,
                            fired_at=workflow.now(),
                        ).dict(),
                        start_to_close_timeout=timedelta(minutes=1),
                    )
                    expired = RealtimeFreshnessExpiryActivityOutcome.parse_obj(raw)
                    if expired.expired:
                        if (
                            expired.projection is None
                            or expired.workspace_projection is None
                        ):
                            raise ValueError(
                                "realtime_freshness_expiry_projection_missing",
                            )
                        self._realtime_projection = expired.projection
                        self._projection = expired.workspace_projection
                        self._event_sequence = expired.projection.sequence
                finally:
                    self._freshness_expiration_active = False
                if self._freshness_timers.get(connector_id) == timer:
                    self._freshness_timers.pop(connector_id, None)
                    self._freshness_timer_epoch += 1
        next_request = request.dict()
        next_request["rollover_carry"] = self._rollover_carry().dict()
        workflow.continue_as_new(next_request)
        return {"state": "unreachable"}

    @workflow.update(name="await_workspace_projection")
    async def await_workspace_projection(self) -> Dict[str, Any]:
        """Read-after-start barrier: activity persistence precedes API success."""
        await workflow.wait_condition(lambda: self._initialized)
        return self._projection.dict()

    @workflow.update(name="start_or_reuse_node_explanation")
    async def start_or_reuse_node_explanation(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        self._active_updates += 1
        try:
            # v1's unauthenticated bare command decoder lives exclusively in
            # ``legacy_workspace_workflow`` for archived-history replay. A
            # current live update cannot reach an activity/provider without a
            # typed, server-minted command assertion.
            invocation = WorkspaceNodeExplanationInvocation.parse_obj(command_data)
            command = invocation.command
            await workflow.wait_condition(lambda: self._initialized)
            self._validate_node_command(command)
            authorization = await workflow.execute_activity(
                "workspace_authorize_node_explanation_activity",
                WorkspaceNodeExplanationAuthorizationPacket(
                    **self._binding.dict(), command=command, authorization=invocation.authorization,
                    projection_revision=self._projection.projection_revision,
                ).dict(),
                start_to_close_timeout=timedelta(minutes=1),
                # An invalid or replayed command is a policy decision, never
                # transient work to retry; a second attempt might consume a
                # one-time assertion or obscure the rejection boundary.
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            actor = WorkspaceNodeExplanationAuthorizationOutcome.parse_obj(authorization).actor
            if actor.tenant_id != self._binding.tenant_id:
                raise ValueError("workspace_authorization_actor_tenant_mismatch")
            async with self._lock:
                self._validate_node_command(command)
                selection_key = command.selection_key(self._binding.tenant_id)
                existing = self._explanations.get(selection_key)
                if existing is not None:
                    return NodeExplanationReceipt.parse_obj({"explanation": existing, "reused": True}).dict()
                # The activity emits bounded STARTED and terminal explanation
                # status records.  It owns their durable ordering; the
                # workflow reserves both sequence slots before it runs.
                self._event_sequence += 1
                outcome = await self._activity("workspace_node_explanation", command=command, actor=actor)
                self._event_sequence += 1
                if outcome.explanation is None:
                    raise ValueError("workspace_node_explanation_activity_missing_result")
                payload = outcome.explanation.dict()
                self._explanations[selection_key] = payload
                return NodeExplanationReceipt(explanation=outcome.explanation, reused=False).dict()
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}
        finally:
            self._active_updates -= 1

    def _validate_node_command(self, command: NodeExplanationStart) -> None:
        if (
            command.incident_id != self._binding.incident_id or command.run_id != self._binding.run_id
            or command.topology_revision != self._binding.topology_revision
            or command.projection_revision != self._projection.projection_revision
        ):
            raise ValueError("workspace_node_explanation_identity_or_revision_mismatch")
        if command.component_id not in {node.component_id for node in self._projection.graph.nodes}:
            raise ValueError("workspace_node_explanation_component_not_canonical")

    @workflow.update(name="invoke_next_best_action")
    async def invoke_next_best_action(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        """The sole live CTA update: asserted, revalidated, and Temporal-owned."""
        self._active_updates += 1
        try:
            invocation = WorkspaceActionInvocation.parse_obj(command_data)
            command = invocation.command
            await workflow.wait_condition(lambda: self._initialized)
            self._validate_action_command(command)
            authorized = await self._action_activity(
                "workspace_authorize_action_activity",
                WorkspaceActionAuthorizationPacket(
                    **self._binding.dict(), command=command, authorization=invocation.authorization,
                    projection_revision=self._projection.projection_revision,
                ).dict(),
            )
            actor = WorkspaceActionAuthorizationOutcome.parse_obj(authorized)
            if actor.actor_tenant_id != self._binding.tenant_id:
                raise ValueError("workspace_action_authorization_actor_tenant_mismatch")
            async with self._lock:
                existing = self._action_receipts.get(command.idempotency_key)
                if existing is not None:
                    receipt = WorkspaceActionReceipt.parse_obj(existing)
                    if receipt.action_id != command.action_id:
                        raise ValueError("workspace_action_idempotency_conflict")
                    return receipt.dict()
                self._validate_action_command(command)
                if command.action_id not in self._actions:
                    raise ValueError("workspace_action_not_current")
                self._event_sequence += 1
                action_packet = WorkspaceActionPacket(
                    **self._binding.dict(), projection=self._projection, event_sequence=self._event_sequence,
                    command=command, actor_tenant_id=actor.actor_tenant_id,
                    actor_subject_id=actor.actor_subject_id, actor_roles=actor.actor_roles,
                )
                # Existing Task 5 update histories did not carry an explicit
                # transition key. Preserve their commands exactly; every new
                # history records the durable activity/command identity.
                if workflow.patched(WORKSPACE_V2_ACTION_COMMIT_PATCH):
                    action_packet = action_packet.copy(update={
                        "activity_identity": "workspace-action:{}:{}".format(
                            self._binding.workflow_run_id, command.canonical_hash(),
                        ),
                    })
                outcome_data = await self._action_activity(
                    "workspace_execute_action_activity",
                    action_packet.dict(),
                )
                outcome = WorkspaceActionOutcome.parse_obj(outcome_data)
                if outcome.projection is not None:
                    self._projection = outcome.projection
                for action in outcome.actions:
                    self._actions[action.action_id] = action.dict()
                if (
                    outcome.receipt.status == "FRESH_READ_COMPLETED"
                    and workflow.patched(WORKSPACE_V2_INVESTIGATION_PATCH)
                ):
                    source_action = self._actions.get(command.action_id)
                    if source_action is None:
                        raise ValueError("workspace_investigation_source_action_missing")
                    component_id = source_action["component_id"]
                    synthesis_activity_id = "investigation-synthesis:{}".format(
                        action_packet.activity_identity,
                    )
                    synthesis = InvestigationSynthesisOutcome.parse_obj(
                        await self._action_activity(
                            "workspace_synthesize_investigation_activity",
                            WorkspaceInvestigationSynthesisPacket(
                                **self._binding.dict(),
                                projection=self._projection,
                                component_id=component_id,
                                actor_subject_id=actor.actor_subject_id,
                                source_action_id=command.action_id,
                                source_idempotency_key=command.idempotency_key,
                                synthesis_activity_id=synthesis_activity_id,
                            ).dict(),
                        ),
                    )
                    critic = None
                    if synthesis.disposition == InvestigationSynthesisDisposition.CANDIDATE:
                        critic_activity_id = "investigation-critic:{}".format(
                            action_packet.activity_identity,
                        )
                        critic = InvestigationCriticOutcome.parse_obj(
                            await self._action_activity(
                                "workspace_critic_investigation_activity",
                                WorkspaceInvestigationCriticPacket(
                                    **self._binding.dict(),
                                    projection=self._projection,
                                    component_id=component_id,
                                    actor_subject_id=actor.actor_subject_id,
                                    source_action_id=command.action_id,
                                    source_idempotency_key=command.idempotency_key,
                                    critic_activity_id=critic_activity_id,
                                    synthesis=synthesis,
                                ).dict(),
                            ),
                        )
                    final_activity = temporal_investigation_finalize_activity(synthesis, critic)
                    self._event_sequence += 1
                    finalized = WorkspaceInvestigationOutcome.parse_obj(
                        await self._action_activity(
                            final_activity,
                            WorkspaceInvestigationFinalizePacket(
                                **self._binding.dict(),
                                projection=self._projection,
                                component_id=component_id,
                                actor_subject_id=actor.actor_subject_id,
                                source_action_id=command.action_id,
                                source_idempotency_key=command.idempotency_key,
                                transition_key="investigation:{}".format(
                                    action_packet.activity_identity,
                                ),
                                event_sequence=self._event_sequence,
                                synthesis=synthesis,
                                critic=critic,
                            ).dict(),
                        ),
                    )
                    self._projection = finalized.projection
                    self._actions = {
                        action.action_id: action.dict() for action in finalized.actions
                    }
                self._action_receipts[command.idempotency_key] = outcome.receipt.dict()
                return outcome.receipt.dict()
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}
        finally:
            self._active_updates -= 1

    def _validate_action_command(self, command: ActionInvocationCommand) -> None:
        if (
            command.incident_id != self._binding.incident_id or command.run_id != self._binding.run_id
            or command.topology_revision != self._binding.topology_revision
            or command.projection_revision != self._projection.projection_revision
        ):
            raise ValueError("workspace_action_identity_or_revision_mismatch")

    @workflow.update(name="reconcile_realtime_connector")
    async def reconcile_realtime_connector(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        """Read one server-registered connector and accept one typed fact transition."""
        self._active_updates += 1
        try:
            command = RealtimeUpdateCommand.parse_obj(command_data)
            await workflow.wait_condition(lambda: self._initialized)
            self._validate_realtime_command(command)
            async with self._lock:
                prior = self._realtime_receipts.get(command.idempotency_key)
                if prior is not None:
                    return prior
                self._validate_realtime_command(command)
                fact_plane_outbox = workflow.patched(
                    "workspace-v2-realtime-fact-plane-outbox-v1",
                )
                if fact_plane_outbox and (
                    command.source_event_id is None
                    or command.dispatch_id is None
                ):
                    raise ValueError(
                        "realtime_connector_dispatch_identity_required",
                    )
                polled = ConnectorPollResult.parse_obj(
                    await self._action_activity(
                        (
                            "workspace_load_realtime_dispatch_activity"
                            if fact_plane_outbox
                            else "workspace_poll_realtime_connector_activity"
                        ),
                        RealtimePollActivityPacket(
                            command=command, projection=self._projection,
                        ).dict(),
                    ),
                )
                first_event_sequence = self._event_sequence + 1
                outcome = RealtimeUpdateOutcome.parse_obj(
                    await self._action_activity(
                        "workspace_commit_realtime_source_event_activity",
                        RealtimeCommitActivityPacket(
                            command=command,
                            projection=self._projection,
                            prior_realtime_projection=self._realtime_projection,
                            first_event_sequence=first_event_sequence,
                            poll_result=polled,
                        ).dict(),
                    ),
                )
                if not outcome.accepted or outcome.projection is None or outcome.workspace_projection is None:
                    raise ValueError(outcome.reason or "realtime_connector_event_not_accepted")
                if self._temporal_freshness_enabled:
                    timer = TemporalFreshnessTimer.parse_obj(
                        await self._action_activity(
                            "workspace_load_realtime_freshness_timer_activity",
                            RealtimeFreshnessTimerLoadPacket(
                                command=command,
                                committed_source_event_id=outcome.source_event_id,
                            ).dict(),
                        ),
                    )
                    if (
                        timer.deadline.tenant_id != command.tenant_id
                        or timer.deadline.case_id != command.case_id
                        or timer.deadline.connector_id != command.connector_id
                        or timer.deadline.source_event_id
                        != outcome.source_event_id
                    ):
                        raise ValueError(
                            "realtime_freshness_timer_binding_mismatch",
                        )
                    self._freshness_timers[command.connector_id] = timer
                    self._freshness_timer_epoch += 1
                self._projection = outcome.workspace_projection
                self._realtime_projection = outcome.projection
                self._event_sequence = outcome.projection.sequence
                payload = outcome.dict()
                self._realtime_receipts[command.idempotency_key] = payload
                self._accepted_realtime_transitions += 1
                if self._rollover_enabled and self._rollover_due():
                    self._rollover_requested = True
                return payload
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}
        finally:
            self._active_updates -= 1

    @workflow.signal(name="request_workspace_rollover")
    def request_workspace_rollover(self) -> None:
        """Operator/test escape hatch; normal rollovers are history-budget driven."""
        if self._rollover_enabled:
            self._rollover_requested = True

    @workflow.query(name="workspace_runtime_state")
    def workspace_runtime_state(self) -> Dict[str, Any]:
        if not self._initialized:
            return {"initialized": False}
        return {
            "initialized": True,
            "rollover_enabled": self._rollover_enabled,
            "rollover_requested": self._rollover_requested,
            "active_updates": self._active_updates,
            "accepted_realtime_transitions": self._accepted_realtime_transitions,
            "temporal_freshness_enabled": self._temporal_freshness_enabled,
            "freshness_timers": {
                connector_id: timer.dict()
                for connector_id, timer in self._freshness_timers.items()
            },
            "temporal_generation": (
                self._execution_pointer.temporal_generation
                if self._execution_pointer is not None else 1
            ),
            "temporal_run_id": (
                self._execution_pointer.temporal_run_id
                if self._execution_pointer is not None else self._binding.workflow_run_id
            ),
        }

    def _validate_realtime_command(self, command: RealtimeUpdateCommand) -> None:
        if (
            command.tenant_id != self._binding.tenant_id
            or command.case_id != self._binding.case_id
            or command.incident_id != self._binding.incident_id
            or command.run_id != self._binding.run_id
            or command.topology_revision != self._binding.topology_revision
        ):
            raise ValueError("realtime_connector_command_binding_mismatch")

    @workflow.update(name="workflow_command_v3")
    async def workflow_command_v3(
        self, invocation_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Own one authenticated guided command and its bounded stage work.

        No stage activity is scheduled until ``dispatch_command`` has durably
        accepted an explicit advance/rerun/approval command. Repository CAS
        and activity idempotency make duplicate Temporal updates safe.
        """
        self._active_updates += 1
        try:
            invocation = WorkflowTemporalCommandV3.parse_obj(invocation_data)
            await workflow.wait_condition(lambda: self._initialized)
            if (
                invocation.tenant_id != self._binding.tenant_id
                or invocation.case_id != self._binding.case_id
            ):
                raise ValueError("workflow_v3_temporal_binding_mismatch")
            async with _InterleavableGuidedScope():
                receipt = WorkflowCommandReceiptV3.parse_obj(
                    await workflow.execute_activity(
                        "workspace_workflow_command_v3_activity",
                        invocation.dict(),
                        start_to_close_timeout=timedelta(minutes=2),
                        retry_policy=_guided_activity_retry_policy(),
                    ),
                )
                # The first accepted command owns all downstream work. A
                # duplicate receipt is an acknowledgement only; re-running a
                # provider or action from its historical projection would
                # violate exactly-once user intent.
                if receipt.reused:
                    return receipt.dict()
                projection = receipt.projection
                current = next(
                    item for item in reversed(projection.current_attempt.stage_runs)
                    if item.stage == projection.current_attempt.current_stage
                    and item.status != WorkflowStageStateV3.SUPERSEDED
                )

                if invocation.operation in {
                    WorkflowTemporalOperationV3.ADVANCE,
                    WorkflowTemporalOperationV3.RERUN,
                } and (
                    current.status == WorkflowStageStateV3.RUNNING
                    and current.stage != WorkflowStageV3.DETECT
                ):
                    packet = GuidedStageActivityPacketV3(
                        tenant_id=projection.tenant_id,
                        case_id=projection.case_id,
                        attempt_id=projection.current_attempt.attempt_id,
                        stage_run_id=current.stage_run_id,
                        stage=current.stage,
                        expected_workflow_revision=projection.workflow_revision,
                        actor_subject_id=invocation.actor_subject_id,
                    )
                    outcome = GuidedStageActivityOutcomeV3.parse_obj(
                        await workflow.execute_activity(
                            "workspace_run_guided_stage_v3_activity",
                            packet.dict(),
                            start_to_close_timeout=timedelta(minutes=6),
                            retry_policy=_guided_activity_retry_policy(),
                        ),
                    )
                    # Verify is a bounded Temporal observation window. It only
                    # accepts post-action samples and never busy-waits inside an
                    # activity, so restart/replay preserves the timer history.
                    if current.stage == WorkflowStageV3.VERIFY:
                        # The deadline is part of the canonical stage run so the
                        # UI and Temporal use the same durable observation window.
                        deadline = current.verification_deadline_at
                        while (
                            outcome.status == GuidedStageActivityStatusV3.WAITING
                            and workflow.now() < deadline
                        ):
                            await workflow.sleep(timedelta(seconds=2))
                            outcome = GuidedStageActivityOutcomeV3.parse_obj(
                                await workflow.execute_activity(
                                    "workspace_run_guided_stage_v3_activity",
                                    packet.dict(),
                                    start_to_close_timeout=timedelta(minutes=6),
                                    retry_policy=_guided_activity_retry_policy(),
                                ),
                            )
                        if outcome.status == GuidedStageActivityStatusV3.WAITING:
                            outcome = GuidedStageActivityOutcomeV3.parse_obj(
                                await workflow.execute_activity(
                                    "workspace_run_guided_stage_v3_activity",
                                    packet.copy(update={
                                        "verification_deadline_reached": True,
                                    }).dict(),
                                    start_to_close_timeout=timedelta(minutes=6),
                                    retry_policy=_guided_activity_retry_policy(),
                                ),
                            )
                    receipt = receipt.copy(update={
                        "projection": outcome.projection,
                        "workflow_revision": outcome.projection.workflow_revision,
                    })

                elif invocation.operation == WorkflowTemporalOperationV3.AGENT_RUN:
                    agent = next((
                        item for item in reversed(projection.agent_activity)
                        if item.stage_run_id == current.stage_run_id
                        and item.state == AgentRunStateV3.RUNNING
                    ), None)
                    if agent is None:
                        raise ValueError("workflow_v3_agent_run_not_active")
                    outcome = GuidedStageActivityOutcomeV3.parse_obj(
                        await workflow.execute_activity(
                            "workspace_run_guided_agent_v3_activity",
                            GuidedAgentActivityPacketV3(
                                tenant_id=projection.tenant_id,
                                case_id=projection.case_id,
                                attempt_id=projection.current_attempt.attempt_id,
                                stage_run_id=current.stage_run_id,
                                agent_run_id=agent.agent_run_id,
                                expected_workflow_revision=projection.workflow_revision,
                                actor_subject_id=invocation.actor_subject_id,
                            ).dict(),
                            start_to_close_timeout=timedelta(minutes=3),
                            retry_policy=_guided_activity_retry_policy(),
                        ),
                    )
                    receipt = receipt.copy(update={
                        "projection": outcome.projection,
                        "workflow_revision": outcome.projection.workflow_revision,
                    })

                elif invocation.operation == WorkflowTemporalOperationV3.ACTION_APPROVAL:
                    approval = ActionApprovalCommandV3.parse_obj(invocation.command)
                    action = next((
                        item for item in projection.actions
                        if item.action_id == invocation.action_id
                    ), None)
                    if (
                        approval.decision == ActionApprovalDecisionV3.APPROVE
                        and action is not None
                        and action.execution_state
                        in {ActionExecutionStateV3.NOT_STARTED, ActionExecutionStateV3.RUNNING}
                    ):
                        outcome = GuidedStageActivityOutcomeV3.parse_obj(
                            await workflow.execute_activity(
                                "workspace_execute_guided_action_v3_activity",
                                GuidedActionActivityPacketV3(
                                    tenant_id=projection.tenant_id,
                                    case_id=projection.case_id,
                                    attempt_id=projection.current_attempt.attempt_id,
                                    stage_run_id=current.stage_run_id,
                                    action_id=action.action_id,
                                    expected_workflow_revision=projection.workflow_revision,
                                    actor_subject_id=invocation.actor_subject_id,
                                ).dict(),
                                start_to_close_timeout=timedelta(minutes=3),
                                retry_policy=_guided_activity_retry_policy(),
                            ),
                        )
                        receipt = receipt.copy(update={
                            "projection": outcome.projection,
                            "workflow_revision": outcome.projection.workflow_revision,
                        })

                self._accepted_realtime_transitions += 1
                if self._rollover_enabled and self._rollover_due():
                    self._rollover_requested = True
                return receipt.dict()
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}
        finally:
            self._active_updates -= 1

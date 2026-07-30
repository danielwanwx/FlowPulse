"""Temporal workflow for the additive, public-identity Incident Workspace."""

import asyncio
from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow
from temporalio.common import RetryPolicy

# Pydantic v1 model inheritance deep-copies datetime field descriptors during
# Temporal's sandbox import. The contracts are immutable parsing utilities, so
# pass this dependency through exactly as the worker/importer loaded it.
with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError
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
        RealtimeCommitActivityPacket,
        RealtimePollActivityPacket,
        RealtimeUpdateCommand,
        RealtimeUpdateOutcome,
    )


WORKSPACE_V2_ACTIONS_PATCH = "workspace-v2-gate1-next-best-actions"
WORKSPACE_V2_ACTION_COMMIT_PATCH = "workspace-v2-gate1-atomic-action-commit"
WORKSPACE_V2_INVESTIGATION_PATCH = "workspace-v2-investigation-decide-handoff"
WORKSPACE_V2_STAFF_INCIDENT_CONTRACT_PATCH = "workspace-v2-staff-incident-contract-v1"


@workflow.defn(name=WORKSPACE_V2_WORKFLOW_TYPE)
class IncidentWorkspaceTemporalWorkflow:
    """Authenticated v2 Temporal owner for new workspace executions."""

    def __init__(self) -> None:
        self._initialized = False
        self._binding = None
        self._projection = None
        self._event_sequence = 0
        self._explanations: Dict[str, Dict[str, Any]] = {}
        self._actions: Dict[str, Dict[str, Any]] = {}
        self._action_receipts: Dict[str, Dict[str, Any]] = {}
        self._realtime_projection = None
        self._realtime_receipts: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()

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
        return WorkspaceActivityOutcome.parse_obj(result)

    async def _action_activity(self, name: str, packet: Dict[str, Any]) -> Dict[str, Any]:
        return await workflow.execute_activity(
            name, self._activity_packet_contract(packet),
            start_to_close_timeout=timedelta(minutes=2),
        )

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = WorkspaceWorkflowRequest.parse_obj(request_data)
        request_values = request.copy(update={"workflow_run_id": workflow.info().run_id}).dict()
        self._binding = IncidentRunBinding.parse_obj({
            field: request_values[field] for field in IncidentRunBinding.__fields__
        })
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
        await workflow.wait_condition(lambda: False)
        return {"state": "unreachable"}

    @workflow.update(name="await_workspace_projection")
    async def await_workspace_projection(self) -> Dict[str, Any]:
        """Read-after-start barrier: activity persistence precedes API success."""
        await workflow.wait_condition(lambda: self._initialized)
        return self._projection.dict()

    @workflow.update(name="start_or_reuse_node_explanation")
    async def start_or_reuse_node_explanation(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
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
        try:
            command = RealtimeUpdateCommand.parse_obj(command_data)
            await workflow.wait_condition(lambda: self._initialized)
            self._validate_realtime_command(command)
            async with self._lock:
                prior = self._realtime_receipts.get(command.idempotency_key)
                if prior is not None:
                    return prior
                self._validate_realtime_command(command)
                polled = ConnectorPollResult.parse_obj(
                    await self._action_activity(
                        "workspace_poll_realtime_connector_activity",
                        RealtimePollActivityPacket(
                            command=command, projection=self._projection,
                        ).dict(),
                    ),
                )
                self._event_sequence += 1
                outcome = RealtimeUpdateOutcome.parse_obj(
                    await self._action_activity(
                        "workspace_commit_realtime_source_event_activity",
                        RealtimeCommitActivityPacket(
                            command=command,
                            projection=self._projection,
                            prior_realtime_projection=self._realtime_projection,
                            event_sequence=self._event_sequence,
                            poll_result=polled,
                        ).dict(),
                    ),
                )
                if not outcome.accepted or outcome.projection is None or outcome.workspace_projection is None:
                    raise ValueError(outcome.reason or "realtime_connector_event_not_accepted")
                self._projection = outcome.workspace_projection
                self._realtime_projection = outcome.projection
                payload = outcome.dict()
                self._realtime_receipts[command.idempotency_key] = payload
                return payload
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}

    def _validate_realtime_command(self, command: RealtimeUpdateCommand) -> None:
        if (
            command.tenant_id != self._binding.tenant_id
            or command.case_id != self._binding.case_id
            or command.incident_id != self._binding.incident_id
            or command.run_id != self._binding.run_id
            or command.topology_revision != self._binding.topology_revision
        ):
            raise ValueError("realtime_connector_command_binding_mismatch")

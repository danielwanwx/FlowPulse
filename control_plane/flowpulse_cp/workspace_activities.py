"""Activities for the additive Incident Workspace workflow.

Conversation/provider work is bounded inside this Temporal activity.  No
fresh capability invocation is permitted before the later Gate 1 increment.
"""

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, List

from .models import CaseState, IncidentCase
from .workspace_models import (
    IncidentEvent,
    IncidentRunBinding,
    NodeExplanation,
    NodeExplanationState,
    WorkspaceActivityOutcome,
    WorkspaceActivityPacket,
    WorkspaceNodeExplanationAuthorizationOutcome,
    WorkspaceNodeExplanationAuthorizationPacket,
)


def workspace_activity_surface() -> List[str]:
    return [
        "workspace_initialize_activity",
        "workspace_authorize_node_explanation_activity",
        "workspace_node_explanation_activity",
    ]


def build_workspace_activities(dispatcher: "WorkspaceActivityDispatcher") -> List[Any]:
    from temporalio import activity
    from temporalio.exceptions import ApplicationError

    def definition(name: str):
        @activity.defn(name=name)
        async def run(packet: Dict[str, Any]) -> Dict[str, Any]:
            try:
                return await dispatcher.dispatch(name, packet)
            except Exception as error:
                # Authorization/policy denials are terminal at the activity
                # boundary. Do not let Temporal replay a forged command.
                from .policy import PolicyViolation
                if isinstance(error, PolicyViolation):
                    raise ApplicationError(str(error), non_retryable=True) from error
                raise
        return run

    return [definition(name) for name in workspace_activity_surface()]


class WorkspaceActivityDispatcher:
    """Writes only Temporal-derived public projections and safe degraded records."""

    def __init__(self, repository: Any, conversation_manager: Any = None, authorization: Any = None) -> None:
        self.repository = repository
        self.conversation_manager = conversation_manager
        self.authorization = authorization

    async def _persist_case(self, packet: WorkspaceActivityPacket) -> None:
        if not hasattr(self.repository, "put_case"):
            return
        now = datetime.now(timezone.utc)
        case = IncidentCase(
            case_id=packet.case_id, tenant_id=packet.tenant_id, case_revision=packet.case_revision,
            workflow_id=packet.workflow_id, workflow_run_id=packet.workflow_run_id,
            state=CaseState.NEEDS_HUMAN, severity=packet.projection.status,
            environment="workspace", affected_entities=[node.component_id for node in packet.projection.graph.nodes] or ["workspace"],
            created_at=packet.created_at, updated_at=now, blocker_code="provider_unavailable",
            human_question="No provider or read capability is configured for this workspace checkpoint.",
        )
        result = self.repository.put_case(case)
        if hasattr(result, "__await__"):
            await result
    async def _grant_initializer_subject(self, packet: WorkspaceActivityPacket) -> None:
        if packet.actor is None:
            # Frozen v1/replay-only histories did not carry a trusted actor.
            # Current live workflows always include one at initialization.
            return
        grant = getattr(self.repository, "grant_workspace_subject", None)
        if grant is None:
            raise RuntimeError("workspace_subject_grant_repository_required")
        binding = IncidentRunBinding.parse_obj({
            name: getattr(packet, name) for name in IncidentRunBinding.__fields__
        })
        result = grant(binding, packet.actor.subject_id)
        if hasattr(result, "__await__"):
            await result

    async def _append_event(self, packet: WorkspaceActivityPacket, event_type: str, payload: Dict[str, str]) -> None:
        event = IncidentEvent(
            **{name: getattr(packet, name) for name in packet.__fields__ if name in {
                "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
                "workflow_id", "workflow_run_id", "created_at",
            }},
            projection_revision=packet.projection.projection_revision,
            sequence=packet.event_sequence, event_type=event_type,
            occurred_at=datetime.now(timezone.utc), payload=payload,
            evidence_refs=list(packet.projection.evidence_refs),
        )
        await self.repository.append_workspace_event(event)

    async def dispatch(self, activity_name: str, packet_data: Dict[str, Any]) -> Dict[str, Any]:
        if activity_name == "workspace_authorize_node_explanation_activity":
            packet = WorkspaceNodeExplanationAuthorizationPacket.parse_obj(packet_data)
            if self.authorization is None:
                raise RuntimeError("workspace_authorization_port_unconfigured")
            binding = IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            })
            actor = self.authorization.resolve_workspace_node_explanation(
                packet.authorization, binding, packet.command,
            )
            if hasattr(actor, "__await__"):
                actor = await actor
            if actor.tenant_id != binding.tenant_id:
                raise RuntimeError("workspace_authorization_actor_tenant_mismatch")
            return WorkspaceNodeExplanationAuthorizationOutcome(actor=actor).dict()
        packet = WorkspaceActivityPacket.parse_obj(packet_data)
        expected = packet.stage + "_activity"
        if activity_name != expected:
            raise RuntimeError("workspace_activity_stage_mismatch")
        if packet.stage == "workspace_initialize":
            await self._persist_case(packet)
            await self.repository.put_workspace_binding(IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            }))
            await self._grant_initializer_subject(packet)
            await self.repository.put_workspace_projection(packet.projection)
            await self._append_event(packet, "workspace.initialized", {"state": packet.projection.status})
            return WorkspaceActivityOutcome(projection=packet.projection).dict()
        if packet.stage == "workspace_node_explanation":
            command = packet.node_explanation
            if command is None:
                raise RuntimeError("workspace_node_explanation_command_required")
            known = {node.component_id for node in packet.projection.graph.nodes}
            if command.component_id not in known:
                raise RuntimeError("workspace_node_explanation_component_not_canonical")
            if packet.actor is None or packet.actor.tenant_id != packet.tenant_id:
                raise RuntimeError("workspace_node_explanation_actor_not_authorized")
            selection_key = command.selection_key(packet.tenant_id)
            conversation = None
            if self.conversation_manager is not None:
                binding = IncidentRunBinding.parse_obj({
                    name: getattr(packet, name) for name in IncidentRunBinding.__fields__
                })
                conversation = await self.conversation_manager.explain(
                    binding, packet.projection, command, actor=packet.actor,
                )
            explanation = NodeExplanation(
                **{name: getattr(packet, name) for name in packet.__fields__ if name in {
                    "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
                    "workflow_id", "workflow_run_id", "created_at",
                }},
                explanation_id="node-explanation-{}".format(sha256(selection_key.encode("utf-8")).hexdigest()[:24]),
                selection_key=selection_key, projection_revision=command.projection_revision,
                component_id=command.component_id, conversation_schema_version=command.conversation_schema_version,
                state=(
                    NodeExplanationState.COMPLETED
                    if conversation is not None and conversation.truth_label.value != "DEGRADED"
                    else NodeExplanationState.DEGRADED
                ),
                summary=(
                    conversation.summary if conversation is not None
                    else "No provider or read capability is configured; no fresh read or diagnosis was performed."
                ),
                evidence_refs=(
                    conversation.evidence_refs if conversation is not None else list(packet.projection.evidence_refs)
                ),
                fresh_read_performed=False, fresh_diagnosis_claimed=False,
                truth_label=(conversation.truth_label if conversation is not None else "DEGRADED"),
                conversation_trace=(conversation.trace if conversation is not None else None),
                degraded_code=(conversation.degraded_code if conversation is not None else "provider_unavailable"),
            )
            stored, _ = await self.repository.start_or_reuse_workspace_explanation(explanation)
            await self._append_event(
                packet,
                "node_explanation.completed" if stored.state == NodeExplanationState.COMPLETED else "node_explanation.degraded",
                {"explanation_id": stored.explanation_id, "truth_label": stored.truth_label.value},
            )
            return WorkspaceActivityOutcome(explanation=stored).dict()
        raise RuntimeError("workspace_activity_unknown")

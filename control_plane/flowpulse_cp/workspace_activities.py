"""Activities for the additive Incident Workspace workflow.

Conversation/provider work is bounded inside this Temporal activity.  No
fresh capability invocation is permitted before the later Gate 1 increment.
"""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any, Dict, List

from .models import CaseState, IncidentCase
from .policy import PolicyViolation
from .capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityInvocationContext,
    CapabilityRequest,
    CapabilityScope,
    ToolCallBudget,
)
from .capability_adapters import DomainEvidenceAdmission
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
from .workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    Gate1LeaseStatus,
    NextBestActionGenerator,
    WorkspaceActionAuthorizationOutcome,
    WorkspaceActionAuthorizationPacket,
    WorkspaceActionGenerationOutcome,
    WorkspaceActionGenerationPacket,
    WorkspaceActionOutcome,
    WorkspaceActionPacket,
    WorkspaceActionReceipt,
    validate_current_action_card,
)


def workspace_activity_surface() -> List[str]:
    return [
        "workspace_initialize_activity",
        "workspace_authorize_node_explanation_activity",
        "workspace_node_explanation_activity",
        "workspace_authorize_action_activity",
        "workspace_generate_actions_activity",
        "workspace_execute_action_activity",
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

    def __init__(
        self, repository: Any, conversation_manager: Any = None, authorization: Any = None,
        capability_registry: Any = None,
    ) -> None:
        self.repository = repository
        self.conversation_manager = conversation_manager
        self.authorization = authorization
        self.capability_registry = capability_registry

    @staticmethod
    def _permissions(actor) -> list:
        return ["incident:read"] if set(actor.roles).intersection({"viewer", "owner", "local-test-owner"}) else []

    async def _append_action_event(self, packet: WorkspaceActionPacket, action: str) -> None:
        event = IncidentEvent(
            **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
            projection_revision=packet.projection.projection_revision, sequence=packet.event_sequence,
            event_type=action, occurred_at=datetime.now(timezone.utc),
            payload={"action_id": packet.command.action_id, "idempotency_key": packet.command.idempotency_key},
            evidence_refs=list(packet.projection.evidence_refs),
        )
        await self.repository.append_workspace_event(event)

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
        if activity_name == "workspace_authorize_action_activity":
            packet = WorkspaceActionAuthorizationPacket.parse_obj(packet_data)
            if self.authorization is None:
                raise RuntimeError("workspace_authorization_port_unconfigured")
            binding = IncidentRunBinding.parse_obj({
                name: getattr(packet, name) for name in IncidentRunBinding.__fields__
            })
            actor = self.authorization.resolve_workspace_action(packet.authorization, binding, packet.command)
            if hasattr(actor, "__await__"):
                actor = await actor
            if actor.tenant_id != binding.tenant_id:
                raise RuntimeError("workspace_action_authorization_actor_tenant_mismatch")
            return WorkspaceActionAuthorizationOutcome(
                actor_tenant_id=actor.tenant_id, actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            ).dict()
        if activity_name == "workspace_generate_actions_activity":
            packet = WorkspaceActionGenerationPacket.parse_obj(packet_data)
            if self.capability_registry is None:
                return WorkspaceActionGenerationOutcome().dict()
            actions = NextBestActionGenerator(
                self.capability_registry, registry_revision=self.capability_registry.policy_version,
            ).generate(packet.projection, datetime.now(timezone.utc))
            for action in actions:
                await self.repository.append_next_best_action(action)
            return WorkspaceActionGenerationOutcome(actions=actions).dict()
        if activity_name == "workspace_execute_action_activity":
            packet = WorkspaceActionPacket.parse_obj(packet_data)
            prior = await self.repository.workspace_action_receipt(
                packet.tenant_id, packet.case_id, packet.command.idempotency_key,
            )
            if prior is not None:
                if prior.action_id != packet.command.action_id:
                    raise PolicyViolation("workspace_action_idempotency_conflict")
                current = await self.repository.workspace_projection(packet.tenant_id, packet.case_id)
                if current is None:
                    raise PolicyViolation("workspace_action_projection_not_authoritative")
                actions = await self.repository.workspace_next_best_actions(packet.tenant_id, packet.case_id)
                return WorkspaceActionOutcome(receipt=prior, projection=current, actions=actions[:3]).dict()
            action = await self.repository.workspace_next_best_action(
                packet.tenant_id, packet.case_id, packet.command.action_id,
            )
            if action is None:
                raise PolicyViolation("workspace_action_not_found")
            from .models import AuthContext
            actor = AuthContext(
                tenant_id=packet.actor_tenant_id, subject_id=packet.actor_subject_id, roles=packet.actor_roles,
            )
            validate_current_action_card(
                action, packet.projection, packet.command, self._permissions(actor), datetime.now(timezone.utc),
            )
            if self.capability_registry is None:
                raise PolicyViolation("workspace_action_capability_registry_unconfigured")
            if action.capability_registry_revision != self.capability_registry.policy_version:
                raise PolicyViolation("workspace_action_registry_revision_stale")
            descriptor = next((item for item in self.capability_registry.available(CapabilityAudience.USER_QA)
                               if item.capability.value == action.capability), None)
            if (
                descriptor is None or not descriptor.fresh_read or descriptor.required_gate.value != "GATE1"
                or descriptor.input_schema != action.tool_schema_version
                or action.data_class not in {item.value for item in descriptor.data_classes}
            ):
                raise PolicyViolation("workspace_action_capability_not_bound")
            now = datetime.now(timezone.utc)
            if action.cta.value == "run_read_capability":
                if action.gate1_lease_id is None:
                    raise PolicyViolation("workspace_action_gate1_lease_required")
                invocation_context = CapabilityInvocationContext(
                    **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                    projection_revision=packet.projection.projection_revision,
                    evidence_revision=packet.projection.evidence_revision,
                    component_ids=[action.component_id],
                    activity_id="workspace-gate1:{}:{}:{}".format(
                        packet.workflow_run_id, action.action_id, packet.command.idempotency_key,
                    ),
                    scope=CapabilityScope.USER_QA, subject_id=actor.subject_id,
                    subject_roles=actor.roles, subject_permissions=self._permissions(actor),
                    authorized_subjects=[actor.subject_id],
                    data_class=CapabilityDataClass(action.data_class),
                    recorded_evidence_ids=list(packet.projection.evidence_refs), max_tool_calls=1,
                    capability_registry_revision=action.capability_registry_revision,
                    precondition_version=action.precondition_version, precondition_hash=action.precondition_hash,
                    gate1_lease_id=action.gate1_lease_id,
                )
                invocation = await self.capability_registry.invoke(
                    CapabilityAudience.USER_QA, invocation_context,
                    CapabilityRequest(
                        capability=descriptor.capability, component_id=action.component_id,
                        data_class=CapabilityDataClass(action.data_class), parameters={},
                    ),
                    ToolCallBudget(max_calls=1),
                    evidence_admission=DomainEvidenceAdmission(self.repository, actor.subject_id),
                )
                evidence_refs = list(packet.projection.evidence_refs)
                for evidence in invocation.result.evidence:
                    if evidence.evidence_id not in evidence_refs:
                        evidence_refs.append(evidence.evidence_id)
                updated_projection = packet.projection.copy(update={
                    "projection_revision": packet.projection.projection_revision + 1,
                    "sequence": packet.projection.sequence + 1,
                    "evidence_revision": packet.projection.evidence_revision + 1,
                    "action_revision": packet.projection.action_revision + 1,
                    "evidence_refs": evidence_refs, "generated_at": now,
                })
                await self.repository.put_workspace_projection(updated_projection)
                receipt = WorkspaceActionReceipt(
                    **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                    action_id=action.action_id, idempotency_key=packet.command.idempotency_key,
                    status="FRESH_READ_COMPLETED", gate1_lease_id=action.gate1_lease_id,
                    reason="temporal_gate1_bound_read_completed",
                )
                receipt = await self.repository.record_workspace_action_receipt(receipt)
                await self._append_action_event(
                    packet.copy(update={"projection": updated_projection}),
                    "workspace.action.fresh_read_completed",
                )
                return WorkspaceActionOutcome(receipt=receipt, projection=updated_projection).dict()
            if action.cta.value != "request_gate_1":
                raise PolicyViolation("workspace_action_cta_not_enabled_p0")
            updated_projection = packet.projection.copy(update={
                "projection_revision": packet.projection.projection_revision + 1,
                "sequence": packet.projection.sequence + 1,
                "gate_revision": packet.projection.gate_revision + 1,
                "action_revision": packet.projection.action_revision + 1,
                "generated_at": now,
            })
            lease_id = "gate1-{}".format(sha256(
                "{}:{}:{}".format(packet.tenant_id, packet.command.action_id, packet.command.idempotency_key).encode("utf-8")
            ).hexdigest()[:24])
            lease = Gate1Lease(
                **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                lease_id=lease_id, lease_revision=1, subject_id=actor.subject_id,
                required_permission=action.required_permission, component_id=action.component_id,
                capability=action.capability, data_class=action.data_class,
                tool_schema_version=action.tool_schema_version,
                projection_revision=updated_projection.projection_revision,
                evidence_revision=updated_projection.evidence_revision,
                capability_registry_revision=action.capability_registry_revision,
                precondition_version=action.precondition_version, precondition_hash=NextBestActionGenerator._precondition_hash(updated_projection),
                issued_at=now, expires_at=now + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
            )
            await self.repository.put_workspace_projection(updated_projection)
            await self.repository.append_gate1_lease(lease)
            next_actions = NextBestActionGenerator(
                self.capability_registry, registry_revision=self.capability_registry.policy_version,
            ).generate_after_gate1(updated_projection, lease, now)
            for next_action in next_actions:
                await self.repository.append_next_best_action(next_action)
            receipt = WorkspaceActionReceipt(
                **{name: getattr(packet, name) for name in IncidentRunBinding.__fields__},
                action_id=action.action_id, idempotency_key=packet.command.idempotency_key,
                status="GATE1_GRANTED", gate1_lease_id=lease.lease_id,
                reason="temporal_gate1_lease_accepted",
            )
            receipt = await self.repository.record_workspace_action_receipt(receipt)
            await self._append_action_event(packet.copy(update={"projection": updated_projection}), "workspace.action.gate1_granted")
            return WorkspaceActionOutcome(receipt=receipt, projection=updated_projection, actions=next_actions).dict()
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

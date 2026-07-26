"""Append-only workspace projections used by Temporal activities and API reads."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

from .capabilities import CapabilityAuditRecord
from .models import AuthCommandIntent, AuthCommandKind, AuthContext

from .policy import PolicyViolation
from .workspace_models import IncidentEvent, IncidentProjection, IncidentRunBinding, NodeExplanation, NodeExplanationStart
from .workspace_actions import ActionInvocationCommand, Gate1Lease, NextBestAction, WorkspaceActionReceipt


BindingKey = Tuple[str, str, str]


def _binding_key(item: IncidentRunBinding) -> BindingKey:
    return (item.tenant_id, item.run_id, item.topology_revision)


def _same_binding(left: IncidentRunBinding, right: IncidentRunBinding) -> bool:
    return (
        left.tenant_id, left.incident_id, left.run_id, left.topology_revision,
        left.case_id, left.case_revision, left.workflow_id, left.workflow_run_id,
    ) == (
        right.tenant_id, right.incident_id, right.run_id, right.topology_revision,
        right.case_id, right.case_revision, right.workflow_id, right.workflow_run_id,
    )


class InMemoryWorkspaceRepository:
    """Deterministic test/query projection; it never advances workflow state."""

    def __init__(self) -> None:
        self.bindings: Dict[BindingKey, IncidentRunBinding] = {}
        self.projections: Dict[BindingKey, List[IncidentProjection]] = defaultdict(list)
        self.events: Dict[BindingKey, List[IncidentEvent]] = defaultdict(list)
        self.explanations: Dict[str, NodeExplanation] = {}
        self.explanation_by_selection: Dict[str, str] = {}
        self.capability_audits: Dict[object, CapabilityAuditRecord] = {}
        self.workspace_subject_grants = set()
        self.workspace_auth_intents: Dict[str, AuthCommandIntent] = {}
        self.gate1_leases: Dict[Tuple[str, str, str], List[Gate1Lease]] = defaultdict(list)
        self.next_best_actions: Dict[Tuple[str, str, str], NextBestAction] = {}
        self.workspace_action_receipts: Dict[Tuple[str, str, str], WorkspaceActionReceipt] = {}
        self.workspace_action_idempotency: Dict[Tuple[str, str, str], str] = {}

    async def put_binding(self, binding: IncidentRunBinding) -> IncidentRunBinding:
        key = _binding_key(binding)
        existing = self.bindings.get(key)
        if existing is not None and not _same_binding(existing, binding):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        for current_key, current in self.bindings.items():
            if current.tenant_id == binding.tenant_id and current.case_id == binding.case_id and (
                current.workflow_id != binding.workflow_id or current.workflow_run_id != binding.workflow_run_id
            ):
                raise PolicyViolation("workspace_case_rebound_to_different_temporal_run")
            if current.tenant_id == binding.tenant_id and current.run_id == binding.run_id and current_key != key:
                raise PolicyViolation("workspace_run_rebound_to_different_topology")
        self.bindings[key] = binding
        return binding

    put_workspace_binding = put_binding

    async def grant_workspace_subject(self, binding: IncidentRunBinding, subject_id: str) -> None:
        stored = await self.get_binding(binding.tenant_id, binding.case_id)
        if stored != binding:
            raise PolicyViolation("workspace_subject_grant_binding_mismatch")
        self.workspace_subject_grants.add((binding.tenant_id, binding.case_id, subject_id))

    async def workspace_subject_authorized(self, tenant_id: str, case_id: str, subject_id: str) -> bool:
        return (tenant_id, case_id, subject_id) in self.workspace_subject_grants

    async def get_binding(self, tenant_id: str, case_id: str) -> Optional[IncidentRunBinding]:
        for item in self.bindings.values():
            if item.tenant_id == tenant_id and item.case_id == case_id:
                return item
        return None

    async def get_binding_by_public_identity(
        self, tenant_id: str, incident_id: str, run_id: str, topology_revision: str,
    ) -> Optional[IncidentRunBinding]:
        item = self.bindings.get((tenant_id, run_id, topology_revision))
        return item if item is not None and item.incident_id == incident_id else None

    async def put_projection(self, projection: IncidentProjection) -> IncidentProjection:
        key = _binding_key(projection)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        records = self.projections[key]
        if records:
            latest = records[-1]
            if projection.projection_revision <= latest.projection_revision or projection.sequence <= latest.sequence:
                if projection == latest:
                    return latest
                raise PolicyViolation("workspace_projection_revision_or_sequence_not_monotonic")
        records.append(projection)
        return projection

    put_workspace_projection = put_projection

    async def get_projection(self, tenant_id: str, case_id: str) -> Optional[IncidentProjection]:
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None:
            return None
        records = self.projections.get(_binding_key(binding), [])
        return records[-1] if records else None

    workspace_projection = get_projection

    async def create_workspace_node_explanation_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: NodeExplanationStart,
    ) -> AuthCommandIntent:
        binding = await self.get_binding(actor.tenant_id, projection.case_id)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_authorization_binding_not_authoritative")
        current = await self.get_projection(actor.tenant_id, projection.case_id)
        if current != projection:
            raise PolicyViolation("workspace_authorization_projection_not_authoritative")
        if (
            command.incident_id != binding.incident_id or command.run_id != binding.run_id
            or command.topology_revision != binding.topology_revision
            or command.projection_revision != projection.projection_revision
            or command.component_id not in {node.component_id for node in projection.graph.nodes}
        ):
            raise PolicyViolation("workspace_authorization_command_scope_mismatch")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_authorization_subject_acl_denied")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_NODE_EXPLANATION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_component_id=command.component_id, workspace_command_hash=command.canonical_hash(),
        )
        self.workspace_auth_intents[intent.intent_id] = intent
        return intent

    async def append_event(self, event: IncidentEvent) -> IncidentEvent:
        key = _binding_key(event)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, event):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        records = self.events[key]
        if records and event.sequence <= records[-1].sequence:
            prior = next((item for item in records if item.sequence == event.sequence), None)
            if prior is not None and prior.copy(update={"occurred_at": event.occurred_at}) == event:
                return prior
            raise PolicyViolation("workspace_event_sequence_not_monotonic")
        records.append(event)
        return event

    append_workspace_event = append_event

    async def events_after(self, tenant_id: str, case_id: str, after: int) -> List[IncidentEvent]:
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None:
            return []
        return [event for event in self.events.get(_binding_key(binding), []) if event.sequence > after]

    workspace_events_after = events_after

    async def start_or_reuse_explanation(self, explanation: NodeExplanation) -> Tuple[NodeExplanation, bool]:
        key = _binding_key(explanation)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, explanation):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        existing_id = self.explanation_by_selection.get(explanation.selection_key)
        if existing_id is not None:
            return self.explanations[existing_id], True
        self.explanations[explanation.explanation_id] = explanation
        self.explanation_by_selection[explanation.selection_key] = explanation.explanation_id
        return explanation, False

    start_or_reuse_workspace_explanation = start_or_reuse_explanation

    async def get_explanation(self, tenant_id: str, case_id: str, explanation_id: str) -> Optional[NodeExplanation]:
        explanation = self.explanations.get(explanation_id)
        if explanation is None:
            return None
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None or not _same_binding(binding, explanation):
            return None
        return explanation

    workspace_explanation = get_explanation

    async def append_gate1_lease(self, lease: Gate1Lease) -> Gate1Lease:
        """Append a Temporal-derived lease revision; never overwrite a grant."""
        binding = self.bindings.get(_binding_key(lease))
        if binding is None or not _same_binding(binding, lease):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        key = (lease.tenant_id, lease.case_id, lease.lease_id)
        records = self.gate1_leases[key]
        if records:
            latest = records[-1]
            if lease.lease_revision <= latest.lease_revision:
                if lease == latest:
                    return latest
                raise PolicyViolation("gate1_lease_revision_not_monotonic")
        records.append(lease)
        return lease

    async def workspace_gate1_lease(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[Gate1Lease]:
        records = self.gate1_leases.get((tenant_id, case_id, lease_id), [])
        return records[-1] if records else None

    async def append_next_best_action(self, action: NextBestAction) -> NextBestAction:
        binding = self.bindings.get(_binding_key(action))
        if binding is None or not _same_binding(binding, action):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        key = (action.tenant_id, action.case_id, action.action_id)
        existing = self.next_best_actions.get(key)
        if existing is not None and existing != action:
            raise PolicyViolation("next_best_action_immutable")
        self.next_best_actions[key] = action
        return action

    async def workspace_next_best_action(
        self, tenant_id: str, case_id: str, action_id: str,
    ) -> Optional[NextBestAction]:
        return self.next_best_actions.get((tenant_id, case_id, action_id))

    async def workspace_next_best_actions(self, tenant_id: str, case_id: str) -> List[NextBestAction]:
        return sorted(
            [item for (item_tenant, item_case, _), item in self.next_best_actions.items()
             if (item_tenant, item_case) == (tenant_id, case_id)],
            key=lambda item: item.display_order,
        )

    async def create_workspace_action_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: ActionInvocationCommand,
    ) -> AuthCommandIntent:
        binding = await self.get_binding(actor.tenant_id, projection.case_id)
        action = await self.workspace_next_best_action(actor.tenant_id, projection.case_id, command.action_id)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_action_binding_not_authoritative")
        current = await self.get_projection(actor.tenant_id, projection.case_id)
        if current != projection:
            raise PolicyViolation("workspace_action_projection_not_authoritative")
        if action is None:
            raise PolicyViolation("workspace_action_not_found")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_action_subject_acl_denied")
        if (
            command.incident_id != binding.incident_id or command.run_id != binding.run_id
            or command.topology_revision != binding.topology_revision
            or command.projection_revision != projection.projection_revision
        ):
            raise PolicyViolation("workspace_action_command_scope_mismatch")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-action-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_ACTION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_action_id=action.action_id, workspace_action_command_hash=command.canonical_hash(),
        )
        self.workspace_auth_intents[intent.intent_id] = intent
        return intent

    async def record_workspace_action_receipt(self, receipt: WorkspaceActionReceipt) -> WorkspaceActionReceipt:
        binding = self.bindings.get(_binding_key(receipt))
        if binding is None or not _same_binding(binding, receipt):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        identity_key = (receipt.tenant_id, receipt.case_id, receipt.idempotency_key)
        action_id = self.workspace_action_idempotency.get(identity_key)
        if action_id is not None and action_id != receipt.action_id:
            raise PolicyViolation("workspace_action_idempotency_conflict")
        key = (receipt.tenant_id, receipt.case_id, receipt.idempotency_key)
        existing = self.workspace_action_receipts.get(key)
        if existing is not None:
            if existing != receipt:
                raise PolicyViolation("workspace_action_receipt_immutable")
            return existing
        self.workspace_action_idempotency[identity_key] = receipt.action_id
        self.workspace_action_receipts[key] = receipt
        return receipt

    async def workspace_action_receipt(
        self, tenant_id: str, case_id: str, idempotency_key: str,
    ) -> Optional[WorkspaceActionReceipt]:
        return self.workspace_action_receipts.get((tenant_id, case_id, idempotency_key))

    async def append_capability_audit(self, audit: CapabilityAuditRecord) -> CapabilityAuditRecord:
        """Append the shared capability audit under the immutable workspace binding."""
        key = _binding_key(audit)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, audit):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        existing = self.capability_audits.get(audit.audit_id)
        if existing is not None:
            if existing != audit:
                raise PolicyViolation("workspace_capability_audit_immutable")
            return existing
        self.capability_audits[audit.audit_id] = audit
        return audit

    append_workspace_capability_audit = append_capability_audit

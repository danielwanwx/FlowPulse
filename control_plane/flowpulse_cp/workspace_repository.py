"""Append-only workspace projections used by Temporal activities and API reads."""

from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from .policy import PolicyViolation
from .workspace_models import IncidentEvent, IncidentProjection, IncidentRunBinding, NodeExplanation


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

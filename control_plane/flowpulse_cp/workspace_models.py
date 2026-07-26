"""Strict public contracts for the Temporal-owned Incident Workspace."""

from datetime import datetime
from enum import Enum
from hashlib import sha256
import json
from typing import Dict, List, Optional

from pydantic import Field, StrictBool, StrictStr, root_validator, validator

from .models import AuthContext, NonEmpty, PositiveInt, StrictModel


class GraphMembership(str, Enum):
    CONNECTED = "CONNECTED"
    CLASSIFIED = "CLASSIFIED"


class ClassifiedNodeReason(str, Enum):
    EXTERNAL_DEPENDENCY = "External dependency"
    DATA_STORE = "Data store"
    CONTROL_PLANE = "Control plane"
    OBSERVED_BOUNDARY = "Observed boundary"
    RELATIONSHIP_UNAVAILABLE = "Relationship unavailable"


class ProjectionState(str, Enum):
    INITIALIZING = "INITIALIZING"
    DEGRADED = "DEGRADED"
    AWAITING_OWNER = "AWAITING_OWNER"
    BLOCKED = "BLOCKED"
    NEEDS_HUMAN = "NEEDS_HUMAN"
    ABSTAINED = "ABSTAINED"


class NodeExplanationState(str, Enum):
    DEGRADED = "DEGRADED"
    COMPLETED = "COMPLETED"
    BLOCKED = "BLOCKED"


class IncidentGraphNode(StrictModel):
    component_id: NonEmpty
    canonical_identity: NonEmpty
    membership: GraphMembership
    classification_reason: Optional[ClassifiedNodeReason] = None
    runtime_status: NonEmpty
    impact_status: NonEmpty

    @root_validator(allow_reuse=True)
    def classified_nodes_have_exact_reason(cls, values):
        membership = values.get("membership")
        reason = values.get("classification_reason")
        if membership == GraphMembership.CLASSIFIED and reason is None:
            raise ValueError("classified_node_requires_reason")
        if membership == GraphMembership.CONNECTED and reason is not None:
            raise ValueError("connected_node_must_not_have_classification_reason")
        return values


class IncidentGraphEdge(StrictModel):
    edge_id: NonEmpty
    source_component_id: NonEmpty
    target_component_id: NonEmpty
    status: NonEmpty


class IncidentGraph(StrictModel):
    nodes: List[IncidentGraphNode] = Field(default_factory=list)
    edges: List[IncidentGraphEdge] = Field(default_factory=list)

    @validator("nodes", allow_reuse=True)
    def component_ids_are_unique(cls, value):
        ids = [item.component_id for item in value]
        if len(ids) != len(set(ids)):
            raise ValueError("graph_component_ids_must_be_unique")
        return value

    @root_validator(allow_reuse=True)
    def edges_reference_known_nodes(cls, values):
        nodes = {item.component_id for item in values.get("nodes", [])}
        for edge in values.get("edges", []):
            if edge.source_component_id not in nodes or edge.target_component_id not in nodes:
                raise ValueError("graph_edge_references_unknown_component")
        return values


class IncidentRunBinding(StrictModel):
    """Public run identity and its immutable internal Temporal correlation."""

    tenant_id: NonEmpty
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    case_id: NonEmpty
    case_revision: PositiveInt
    workflow_id: NonEmpty
    workflow_run_id: NonEmpty
    created_at: datetime

    @root_validator(allow_reuse=True)
    def public_run_is_not_a_temporal_identifier(cls, values):
        run_id = values.get("run_id")
        if run_id and run_id in {values.get("workflow_id"), values.get("workflow_run_id")}:
            raise ValueError("run_id_must_not_equal_temporal_identity")
        return values


class IncidentProjection(IncidentRunBinding):
    schema_version: NonEmpty = "flowpulse.incident-projection.v1"
    projection_revision: PositiveInt
    sequence: PositiveInt
    lifecycle_state: ProjectionState
    status: NonEmpty
    generated_at: datetime
    graph: IncidentGraph
    impacted_path: List[NonEmpty] = Field(default_factory=list)
    evidence_revision: PositiveInt
    gate_revision: PositiveInt
    action_revision: PositiveInt
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    degraded_code: Optional[StrictStr] = None

    @validator("impacted_path", allow_reuse=True)
    def impacted_path_is_canonical(cls, value, values):
        graph = values.get("graph")
        if graph is not None:
            known = {node.component_id for node in graph.nodes}
            if any(component_id not in known for component_id in value):
                raise ValueError("impacted_path_references_unknown_component")
        return value


class WorkspaceIntake(StrictModel):
    """Browser-safe intake: tenant and actor come only from trusted auth."""

    incident_id: NonEmpty
    title: NonEmpty
    severity: NonEmpty
    environment: NonEmpty
    affected_entities: List[NonEmpty] = Field(min_items=1)
    observed_at: datetime
    summary: NonEmpty

    @validator("affected_entities", allow_reuse=True)
    def affected_entities_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("affected_entities_must_be_unique")
        return value


class WorkspaceWorkflowRequest(IncidentRunBinding):
    actor: AuthContext
    title: NonEmpty
    severity: NonEmpty
    environment: NonEmpty
    affected_entities: List[NonEmpty] = Field(min_items=1)
    summary: NonEmpty


class NodeExplanationStart(StrictModel):
    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    projection_revision: PositiveInt
    component_id: NonEmpty
    idempotency_key: NonEmpty
    conversation_schema_version: NonEmpty = "flowpulse.node-explanation.v1"

    def selection_key(self, tenant_id: str) -> str:
        return "node_explanation:{}:{}:{}:{}:{}".format(
            tenant_id, self.run_id, self.projection_revision, self.component_id,
            self.conversation_schema_version,
        )


class NodeExplanation(IncidentRunBinding):
    explanation_id: NonEmpty
    selection_key: NonEmpty
    projection_revision: PositiveInt
    component_id: NonEmpty
    conversation_schema_version: NonEmpty
    state: NodeExplanationState
    summary: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    fresh_read_performed: StrictBool = False
    fresh_diagnosis_claimed: StrictBool = False
    degraded_code: Optional[StrictStr] = None
    created_at: datetime

    @root_validator(allow_reuse=True)
    def pre_gate_explanation_is_read_only(cls, values):
        if values.get("fresh_read_performed"):
            raise ValueError("node_explanation_fresh_read_forbidden_before_gate1")
        if values.get("fresh_diagnosis_claimed"):
            raise ValueError("node_explanation_fresh_diagnosis_forbidden_before_gate1")
        return values


class NodeExplanationReceipt(StrictModel):
    explanation: NodeExplanation
    reused: StrictBool


class IncidentEvent(IncidentRunBinding):
    schema_version: NonEmpty = "flowpulse.incident-event.v1"
    projection_revision: PositiveInt
    sequence: PositiveInt
    event_type: NonEmpty
    occurred_at: datetime
    payload: Dict[NonEmpty, StrictStr] = Field(default_factory=dict)
    evidence_refs: List[NonEmpty] = Field(default_factory=list)


class WorkspaceActivityPacket(IncidentRunBinding):
    stage: NonEmpty
    projection: IncidentProjection
    event_sequence: PositiveInt
    node_explanation: Optional[NodeExplanationStart] = None


class WorkspaceActivityOutcome(StrictModel):
    projection: Optional[IncidentProjection] = None
    explanation: Optional[NodeExplanation] = None


def initial_topology_revision(tenant_id: str, incident_id: str, run_id: str, entities: List[str]) -> str:
    """Public graph revision is independently derived, never a Temporal identifier."""
    canonical = json.dumps(
        {"tenant_id": tenant_id, "incident_id": incident_id, "run_id": run_id, "entities": sorted(entities)},
        separators=(",", ":"), sort_keys=True,
    )
    return "topology-v1-{}".format(sha256(canonical.encode("utf-8")).hexdigest()[:20])


def initial_projection(binding: IncidentRunBinding, entities: List[str], generated_at: datetime) -> IncidentProjection:
    return IncidentProjection(
        schema_version="flowpulse.incident-projection.v1", **binding.dict(),
        projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="provider_unavailable", generated_at=generated_at,
        graph=IncidentGraph(nodes=[
            IncidentGraphNode(
                component_id=entity, canonical_identity="service:{}".format(entity),
                membership=GraphMembership.CONNECTED, runtime_status="unknown", impact_status="unknown",
            ) for entity in entities
        ]),
        impacted_path=[], evidence_revision=1, gate_revision=1, action_revision=1,
        evidence_refs=[], degraded_code="provider_unavailable",
    )

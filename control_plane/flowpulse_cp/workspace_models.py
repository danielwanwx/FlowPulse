"""Strict public contracts for the Temporal-owned Incident Workspace."""

from datetime import datetime
from enum import Enum
from hashlib import sha256
import json
from typing import Dict, List, Optional

from pydantic import Field, StrictBool, StrictStr, root_validator, validator

from .models import AuthAssertion, AuthContext, Hash, NonEmpty, NonNegativeInt, PositiveInt, StrictModel


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


class ProviderTruthLabel(str, Enum):
    """Truth label surfaced with every conversation result, never inferred by a client."""

    DEGRADED = "DEGRADED"
    TEST_DETERMINISTIC = "TEST_DETERMINISTIC"
    DEMO = "DEMO"
    LIVE = "LIVE"


class ConversationRole(str, Enum):
    """Server-selected roles; provider output never carries one of these values."""

    CONVERSATION_MANAGER = "CONVERSATION_MANAGER"
    EVIDENCE_SPECIALIST = "EVIDENCE_SPECIALIST"
    TOPOLOGY_SPECIALIST = "TOPOLOGY_SPECIALIST"


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


class ComponentContext(IncidentRunBinding):
    """Strict, read-only context for one canonical component in a projection."""

    schema_version: NonEmpty = "flowpulse.component-context.v1"
    projection_revision: PositiveInt
    component: IncidentGraphNode
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    fresh_read_performed: StrictBool = False


class ConversationContext(IncidentRunBinding):
    """Pinned, read-only provider context assembled by the Temporal activity."""

    schema_version: NonEmpty = "flowpulse.conversation-context.v1"
    projection_revision: PositiveInt
    component: IncidentGraphNode
    graph: IncidentGraph
    recorded_evidence_refs: List[NonEmpty] = Field(default_factory=list)
    knowledge_prior_refs: List[NonEmpty] = Field(default_factory=list)
    available_capabilities: List[NonEmpty] = Field(default_factory=list)
    max_tool_calls: NonNegativeInt = 0

    @root_validator(allow_reuse=True)
    def conversation_component_is_canonical_and_priors_are_labeled(cls, values):
        graph = values.get("graph")
        component = values.get("component")
        if graph is not None and component is not None:
            known = {node.component_id: node for node in graph.nodes}
            if known.get(component.component_id) != component:
                raise ValueError("conversation_component_not_canonical")
        if set(values.get("recorded_evidence_refs", [])).intersection(values.get("knowledge_prior_refs", [])):
            raise ValueError("conversation_reference_evidence_must_be_labeled_once")
        return values

    def canonical_hash(self) -> str:
        encoded = self.json(sort_keys=True, exclude_none=True, separators=(",", ":")).encode("utf-8")
        return sha256(encoded).hexdigest()


class ConversationProviderOutput(StrictModel):
    """The only model-controlled data accepted before a projection is written."""

    schema_version: NonEmpty = "flowpulse.conversation-provider-output.v1"
    summary: NonEmpty
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    abstained: StrictBool = False


class ConversationProviderRequest(StrictModel):
    """Temporal activity packet for one provider role; identity remains server-owned."""

    role: ConversationRole
    context: ConversationContext
    prompt_bundle_version: NonEmpty
    prompt_hash: Hash
    context_hash: Hash
    max_output_tokens: PositiveInt

    @root_validator(allow_reuse=True)
    def context_hash_is_bound_to_server_context(cls, values):
        context = values.get("context")
        if context is not None and values.get("context_hash") != context.canonical_hash():
            raise ValueError("conversation_context_hash_mismatch")
        return values


class VersionBundle(StrictModel):
    """Server-owned versions pinned to every completed provider conversation."""

    schema_version: NonEmpty = "flowpulse.version-bundle.v1"
    workflow_version: NonEmpty = "flowpulse.incident-workspace.v2"
    policy_version: NonEmpty = "capability-policy.v1"
    core_policy_version: NonEmpty = "conversation-core-policy.v1"
    role_prompt_version: NonEmpty = "conversation-role-prompts.v1"
    context_pack_version: NonEmpty = "conversation-context-pack.v1"
    capability_registry_version: NonEmpty = "capability-registry.v1"
    tool_schema_version: NonEmpty = "capability-tool-schema.v1"
    evidence_schema_version: NonEmpty = "flowpulse.evidence-envelope.v1"
    card_schema_version: NonEmpty = "flowpulse.next-best-action.v1"
    model_policy_version: NonEmpty = "provider-policy.v1"


class PromptLayer(StrictModel):
    layer: NonEmpty
    version: NonEmpty
    content_hash: Hash


class PromptBundle(StrictModel):
    schema_version: NonEmpty = "flowpulse.prompt-bundle.v1"
    role: ConversationRole
    layers: List[PromptLayer] = Field(min_items=2, max_items=3)
    prompt_hash: Hash

    @validator("layers", allow_reuse=True)
    def prompt_layers_are_unique(cls, value):
        names = [item.layer for item in value]
        if len(names) != len(set(names)):
            raise ValueError("prompt_layers_must_be_unique")
        return value


class ConversationTrace(StrictModel):
    """Safe durable metadata; raw prompts, credentials, and model payloads stay out."""

    schema_version: NonEmpty = "flowpulse.conversation-trace.v1"
    truth_label: ProviderTruthLabel
    provider_id: NonEmpty
    model_id: Optional[StrictStr] = None
    version_bundle: VersionBundle
    prompt_bundles: List[PromptBundle] = Field(min_items=1, max_items=3)
    context_hash: Hash
    provider_call_count: NonNegativeInt
    specialist_roles: List[ConversationRole] = Field(default_factory=list, max_items=2)
    available_capabilities: List[NonEmpty] = Field(default_factory=list)
    tool_calls: NonNegativeInt = 0
    recorded_context_accesses: NonNegativeInt = 0
    input_tokens: NonNegativeInt = 0
    output_tokens: NonNegativeInt = 0

    @root_validator(allow_reuse=True)
    def trace_truth_and_budget_are_consistent(cls, values):
        truth = values.get("truth_label")
        calls = values.get("provider_call_count")
        prompts = values.get("prompt_bundles", [])
        roles = values.get("specialist_roles", [])
        if calls > len(prompts):
            raise ValueError("conversation_provider_call_count_exceeds_prompt_bundles")
        if truth != ProviderTruthLabel.DEGRADED and calls != len(prompts):
            raise ValueError("conversation_provider_call_count_mismatch")
        if len(roles) != len(set(roles)):
            raise ValueError("conversation_specialist_roles_must_be_unique")
        return values


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

    def canonical_hash(self) -> str:
        """Exact browser command binding for a one-time server assertion."""
        encoded = self.json(sort_keys=True, separators=(",", ":")).encode("utf-8")
        return sha256(encoded).hexdigest()


class WorkspaceNodeExplanationInvocation(StrictModel):
    """Authenticated Temporal update packet; the browser never supplies an actor."""

    command: NodeExplanationStart
    authorization: AuthAssertion


class WorkspaceNodeExplanationAuthorizationPacket(IncidentRunBinding):
    """Typed worker-only validation packet before any provider activity may run."""

    command: NodeExplanationStart
    authorization: AuthAssertion
    projection_revision: PositiveInt


class WorkspaceNodeExplanationAuthorizationOutcome(StrictModel):
    """Identity resolved by the trusted authorization service, never by the update payload."""

    actor: AuthContext


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
    truth_label: ProviderTruthLabel = ProviderTruthLabel.DEGRADED
    conversation_trace: Optional[ConversationTrace] = None
    degraded_code: Optional[StrictStr] = None
    created_at: datetime

    @root_validator(allow_reuse=True)
    def pre_gate_explanation_is_read_only(cls, values):
        if values.get("fresh_read_performed"):
            raise ValueError("node_explanation_fresh_read_forbidden_before_gate1")
        if values.get("fresh_diagnosis_claimed"):
            raise ValueError("node_explanation_fresh_diagnosis_forbidden_before_gate1")
        trace = values.get("conversation_trace")
        if trace is not None and trace.truth_label != values.get("truth_label"):
            raise ValueError("node_explanation_truth_label_trace_mismatch")
        if values.get("truth_label") != ProviderTruthLabel.DEGRADED and trace is None:
            raise ValueError("node_explanation_non_degraded_requires_conversation_trace")
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
    actor: Optional[AuthContext] = None


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

"""Strict, versioned contracts at FlowPulse trust boundaries."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, StrictBool, StrictInt, StrictStr, conint, constr, root_validator, validator


class StrictModel(BaseModel):
    class Config:
        extra = "forbid"
        validate_assignment = True
        anystr_strip_whitespace = True
        use_enum_values = False


NonEmpty = constr(min_length=1)
Hash = constr(regex=r"^[a-f0-9]{64}$")


class CaseState(str, Enum):
    RECEIVED = "RECEIVED"
    NORMALIZING = "NORMALIZING"
    ROUTED = "ROUTED"
    INVESTIGATING = "INVESTIGATING"
    EVALUATING = "EVALUATING"
    VERIFYING_EVIDENCE = "VERIFYING_EVIDENCE"
    AWAITING_OWNER = "AWAITING_OWNER"
    APPROVED = "APPROVED"
    EXECUTING = "EXECUTING"
    VERIFYING_OUTCOME = "VERIFYING_OUTCOME"
    RESOLVED = "RESOLVED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    DUPLICATE = "DUPLICATE"
    BLOCKED = "BLOCKED"
    NEEDS_HUMAN = "NEEDS_HUMAN"
    ABSTAINED = "ABSTAINED"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"


class ProofScope(str, Enum):
    CURRENT_OBSERVATION = "CURRENT_OBSERVATION"
    REFERENCE_ONLY = "REFERENCE_ONLY"


class SourceKind(str, Enum):
    METRIC = "METRIC"
    LOG = "LOG"
    TRACE = "TRACE"
    CHANGE = "CHANGE"
    CONFIG = "CONFIG"
    TOPOLOGY = "TOPOLOGY"
    KNOWLEDGE = "KNOWLEDGE"
    SOURCE_READBACK = "SOURCE_READBACK"


class EvidenceAuthority(str, Enum):
    T0 = "T0_AUTHORITATIVE_CURRENT"
    T1 = "T1_DIRECT_CURRENT"
    T2 = "T2_DERIVED"
    T3 = "T3_HISTORICAL"
    T4 = "T4_UNTRUSTED"


class FreshnessStatus(str, Enum):
    CURRENT = "CURRENT"
    AGING = "AGING"
    STALE = "STALE"
    UNKNOWN = "UNKNOWN"


class ClaimStatus(str, Enum):
    PROPOSED = "PROPOSED"
    SUPPORTED = "SUPPORTED"
    VERIFIED = "VERIFIED"
    CONTRADICTED = "CONTRADICTED"
    AMBIGUOUS = "AMBIGUOUS"
    UNKNOWN = "UNKNOWN"


class CoverageStatus(str, Enum):
    MISSING = "MISSING"
    FILLED = "FILLED"
    UNCERTAIN = "UNCERTAIN"
    UNREACHABLE = "UNREACHABLE"


class ConflictStatus(str, Enum):
    OPEN = "OPEN"
    RESOLVED = "RESOLVED"
    ACTION_BLOCKING = "ACTION_BLOCKING"


class ApprovalDecision(str, Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class VerificationDecision(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    AMBIGUOUS = "AMBIGUOUS"


class KnowledgeStatus(str, Enum):
    ACTIVE = "ACTIVE"
    SUPERSEDED = "SUPERSEDED"
    REVOKED = "REVOKED"


class TraceContext(StrictModel):
    case_id: NonEmpty
    case_revision: conint(ge=1)
    workflow_run_id: NonEmpty
    stage: NonEmpty
    attempt: conint(ge=1) = 1
    record_id: Optional[StrictStr] = None


class IncidentIntake(StrictModel):
    tenant_id: NonEmpty
    external_incident_id: NonEmpty
    title: NonEmpty
    severity: NonEmpty
    environment: NonEmpty
    affected_entities: List[NonEmpty] = Field(min_items=1)
    observed_at: datetime
    summary: NonEmpty
    actor_id: NonEmpty


class IncidentCase(StrictModel):
    case_id: NonEmpty
    tenant_id: NonEmpty
    case_revision: conint(ge=1) = 1
    workflow_id: NonEmpty
    workflow_run_id: NonEmpty
    state: CaseState = CaseState.RECEIVED
    severity: NonEmpty
    environment: NonEmpty
    affected_entities: List[NonEmpty]
    created_at: datetime
    updated_at: datetime
    blocker_code: Optional[StrictStr] = None
    human_question: Optional[StrictStr] = None


class EvidenceEnvelope(StrictModel):
    evidence_id: NonEmpty
    case_id: NonEmpty
    case_revision: conint(ge=1)
    tenant_id: NonEmpty
    acl_subjects: List[NonEmpty] = Field(default_factory=list)
    source_kind: SourceKind
    source_uri: NonEmpty
    source_anchor: NonEmpty
    observed_at: datetime
    effective_at: datetime
    source_version: NonEmpty
    content_hash: Hash
    authority: EvidenceAuthority
    freshness: FreshnessStatus
    independence_key: NonEmpty
    schema_binding: NonEmpty
    proof_scope: ProofScope
    raw_artifact_key: Optional[StrictStr] = None
    parent_evidence_ids: List[NonEmpty] = Field(default_factory=list)
    adapter_version: NonEmpty = "p0"

    @root_validator
    def current_evidence_must_not_be_stale(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        if values.get("proof_scope") == ProofScope.CURRENT_OBSERVATION and values.get("freshness") == FreshnessStatus.STALE:
            raise ValueError("stale evidence cannot be current-incident proof")
        return values


class ClaimRecord(StrictModel):
    claim_id: NonEmpty
    case_id: NonEmpty
    case_revision: conint(ge=1)
    tenant_id: NonEmpty
    claim_type: NonEmpty
    statement: NonEmpty
    evidence_ids: List[NonEmpty] = Field(min_items=1)
    status: ClaimStatus = ClaimStatus.PROPOSED
    requires_current_proof: StrictBool = True
    contradiction_ids: List[NonEmpty] = Field(default_factory=list)
    created_by: NonEmpty


class HypothesisRecord(StrictModel):
    hypothesis_id: NonEmpty
    case_id: NonEmpty
    tenant_id: NonEmpty
    statement: NonEmpty
    supporting_claim_ids: List[NonEmpty] = Field(default_factory=list)
    contradicting_claim_ids: List[NonEmpty] = Field(default_factory=list)
    status: ClaimStatus = ClaimStatus.PROPOSED
    unknowns: List[NonEmpty] = Field(default_factory=list)


class CoverageEntry(StrictModel):
    case_id: NonEmpty
    tenant_id: NonEmpty
    field: NonEmpty
    status: CoverageStatus
    evidence_ids: List[NonEmpty] = Field(default_factory=list)
    conflict: StrictBool = False
    note: Optional[StrictStr] = None


class ConflictRecord(StrictModel):
    conflict_id: NonEmpty
    case_id: NonEmpty
    tenant_id: NonEmpty
    evidence_ids: List[NonEmpty] = Field(min_items=2)
    claim_ids: List[NonEmpty] = Field(default_factory=list)
    category: NonEmpty
    status: ConflictStatus
    discriminator_question: NonEmpty


class InvestigatorAssignment(StrictModel):
    assignment_id: NonEmpty
    case_id: NonEmpty
    case_revision: conint(ge=1)
    tenant_id: NonEmpty
    role: NonEmpty
    question: NonEmpty
    allowed_tools: List[NonEmpty]
    allowed_entities: List[NonEmpty]
    assignment_revision: conint(ge=1) = 1
    max_tool_calls: conint(ge=0) = 2
    dispatched_at: datetime


class RouteDecision(StrictModel):
    primary_profile: NonEmpty = "general"
    specialist_roles: List[NonEmpty] = Field(default_factory=list, max_items=4)
    knowledge_needs: List[NonEmpty] = Field(default_factory=list)
    reason_codes: List[NonEmpty] = Field(default_factory=list)
    fanout_suppressed_reason: Optional[StrictStr] = None


class RemediationProposal(StrictModel):
    proposal_id: NonEmpty
    case_id: NonEmpty
    case_revision: conint(ge=1)
    tenant_id: NonEmpty
    revision: conint(ge=1)
    action_type: NonEmpty
    exact_targets: List[NonEmpty] = Field(min_items=1)
    exact_change: Dict[str, Any]
    canary_scope: Dict[str, Any] = Field(default_factory=dict)
    preconditions: Dict[str, NonEmpty] = Field(default_factory=dict)
    supporting_claim_ids: List[NonEmpty] = Field(min_items=1)
    success_criteria: List[NonEmpty] = Field(min_items=1)
    rollback: Dict[str, Any]
    idempotency_key: NonEmpty
    expires_at: datetime


class OwnerApproval(StrictModel):
    approval_id: NonEmpty
    case_id: NonEmpty
    case_revision: conint(ge=1)
    tenant_id: NonEmpty
    proposal_id: NonEmpty
    proposal_revision: conint(ge=1)
    repair_contract_hash: Hash
    actor_id: NonEmpty
    execution_targets: List[NonEmpty] = Field(min_items=1)
    maximum_targets: conint(ge=1)
    precondition_witness: Dict[str, NonEmpty]
    decision: ApprovalDecision
    decided_at: datetime
    expires_at: datetime


class VerificationReport(StrictModel):
    verification_id: NonEmpty
    case_id: NonEmpty
    tenant_id: NonEmpty
    verifier_identity: NonEmpty
    run_context_id: NonEmpty
    verified_claim_ids: List[NonEmpty] = Field(default_factory=list)
    failed_claim_ids: List[NonEmpty] = Field(default_factory=list)
    fresh_evidence_ids: List[NonEmpty] = Field(default_factory=list)
    decision: VerificationDecision
    reason_codes: List[NonEmpty] = Field(default_factory=list)


class KnowledgeRevision(StrictModel):
    knowledge_revision_id: NonEmpty
    tenant_id: NonEmpty
    document_id: NonEmpty
    revision: conint(ge=1)
    kind: NonEmpty
    owner: NonEmpty
    allowed_subjects: List[NonEmpty]
    entities: List[NonEmpty]
    environment: NonEmpty
    effective_at: datetime
    expires_at: Optional[datetime] = None
    status: KnowledgeStatus = KnowledgeStatus.ACTIVE
    anchor: NonEmpty
    content: NonEmpty
    content_hash: Hash
    independence_key: NonEmpty
    supersedes_revision_id: Optional[StrictStr] = None


class KnowledgeCandidate(StrictModel):
    knowledge_revision_id: NonEmpty
    evidence: EvidenceEnvelope
    retrieval_score: float = Field(ge=0.0, le=1.0)
    reason: NonEmpty


class CriticDecision(StrictModel):
    identity: NonEmpty
    decision: VerificationDecision
    missing_coverage: List[NonEmpty] = Field(default_factory=list)
    reason_codes: List[NonEmpty] = Field(default_factory=list)


class DryRunReceipt(StrictModel):
    proposal_id: NonEmpty
    idempotency_key: NonEmpty
    status: NonEmpty = "DRY_RUN_ACCEPTED"
    external_write_performed: StrictBool = False
    reason: NonEmpty


class EvaluationMetrics(StrictModel):
    evaluation_trial_id: NonEmpty
    variant: NonEmpty
    time_to_first_useful_evidence_ms: Optional[StrictInt] = None
    time_to_verified_diagnosis_ms: Optional[StrictInt] = None
    tool_calls: conint(ge=0) = 0
    tokens: conint(ge=0) = 0
    specialist_fanout: conint(ge=0) = 0
    citation_precision: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    false_confident_rca: StrictBool = False
    stale_kb_failure: StrictBool = False
    abstained: StrictBool = False

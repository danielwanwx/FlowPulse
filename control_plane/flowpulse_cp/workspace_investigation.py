"""Strict Investigate synthesis, independent critic, and Temporal handoff records.

Fresh-read activities only append source evidence. These contracts let the
workflow schedule a separate bounded synthesis, an independent critic, and
then exactly one accepted or degraded projection transition.
"""

from enum import Enum
from hashlib import sha256
from typing import List, Optional, Protocol

from pydantic import Field, StrictBool, root_validator, validator

from .models import (
    ClaimRecord,
    ClaimStatus,
    EvidenceEnvelope,
    Hash,
    NonEmpty,
    PositiveInt,
    StrictModel,
    VerificationDecision,
)
from .policy import PolicyViolation
from .workspace_models import (
    IncidentProjection,
    IncidentRunBinding,
    ProviderTruthLabel,
)


class InvestigationSynthesisDisposition(str, Enum):
    CANDIDATE = "CANDIDATE"
    DEGRADED = "DEGRADED"
    ABSTAINED = "ABSTAINED"


class InvestigationHypothesisCandidate(StrictModel):
    statement: NonEmpty
    evidence_refs: List[NonEmpty] = Field(min_items=1, max_items=32)

    @validator("evidence_refs", allow_reuse=True)
    def evidence_refs_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("investigation_hypothesis_evidence_refs_must_be_unique")
        return value


class InvestigationSynthesisRequest(IncidentRunBinding):
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    component_id: NonEmpty
    synthesis_activity_id: NonEmpty
    observations: List[ClaimRecord] = Field(min_items=1, max_items=64)
    evidence: List[EvidenceEnvelope] = Field(min_items=1, max_items=64)


class InvestigationSynthesisOutput(StrictModel):
    summary: NonEmpty
    hypotheses: List[InvestigationHypothesisCandidate] = Field(default_factory=list, max_items=16)
    abstained: StrictBool = False

    @root_validator(allow_reuse=True)
    def nonabstained_output_has_hypothesis(cls, values):
        if not values.get("abstained") and not values.get("hypotheses"):
            raise ValueError("investigation_synthesis_hypothesis_required")
        if values.get("abstained") and values.get("hypotheses"):
            raise ValueError("investigation_abstention_cannot_emit_hypothesis")
        return values


class InvestigationSynthesisOutcome(IncidentRunBinding):
    synthesis_id: NonEmpty
    synthesis_activity_id: NonEmpty
    source_action_id: NonEmpty
    source_idempotency_key: NonEmpty
    component_id: NonEmpty
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    disposition: InvestigationSynthesisDisposition
    truth_label: ProviderTruthLabel
    provider_id: NonEmpty
    model_id: Optional[NonEmpty] = None
    summary: NonEmpty
    hypotheses: List[InvestigationHypothesisCandidate] = Field(default_factory=list, max_items=16)
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=64)
    degraded_code: Optional[NonEmpty] = None

    @root_validator(allow_reuse=True)
    def outcome_truth_is_explicit(cls, values):
        evidence_refs = values.get("evidence_refs", [])
        if len(evidence_refs) != len(set(evidence_refs)):
            raise ValueError("investigation_synthesis_evidence_refs_must_be_unique")
        if any(
            not set(candidate.evidence_refs).issubset(set(evidence_refs))
            for candidate in values.get("hypotheses", [])
        ):
            raise ValueError("investigation_synthesis_evidence_mismatch")
        disposition = values.get("disposition")
        if disposition == InvestigationSynthesisDisposition.CANDIDATE:
            if values.get("truth_label") == ProviderTruthLabel.DEGRADED:
                raise ValueError("investigation_candidate_truth_label_invalid")
            if not values.get("hypotheses") or values.get("degraded_code") is not None:
                raise ValueError("investigation_candidate_payload_invalid")
        elif values.get("truth_label") != ProviderTruthLabel.DEGRADED:
            raise ValueError("investigation_noncandidate_must_be_degraded")
        return values


class InvestigationCriticRequest(IncidentRunBinding):
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    component_id: NonEmpty
    critic_activity_id: NonEmpty
    synthesis: InvestigationSynthesisOutcome
    observations: List[ClaimRecord] = Field(min_items=1, max_items=64)
    evidence: List[EvidenceEnvelope] = Field(min_items=1, max_items=64)


class InvestigationCriticOutput(StrictModel):
    decision: VerificationDecision
    reason_codes: List[NonEmpty] = Field(default_factory=list, max_items=16)


class InvestigationCriticOutcome(IncidentRunBinding):
    critic_id: NonEmpty
    critic_activity_id: NonEmpty
    identity: NonEmpty
    source_action_id: NonEmpty
    source_idempotency_key: NonEmpty
    component_id: NonEmpty
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    decision: VerificationDecision
    reason_codes: List[NonEmpty] = Field(default_factory=list, max_items=16)
    reviewed_claim_fingerprints: List[Hash] = Field(default_factory=list, max_items=64)
    evidence_refs: List[NonEmpty] = Field(default_factory=list, max_items=64)

    @validator("reviewed_claim_fingerprints", "evidence_refs", allow_reuse=True)
    def critic_values_are_unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("investigation_critic_values_must_be_unique")
        return value


class WorkspaceInvestigationSynthesisPacket(IncidentRunBinding):
    projection: IncidentProjection
    component_id: NonEmpty
    actor_subject_id: NonEmpty
    source_action_id: NonEmpty
    source_idempotency_key: NonEmpty
    synthesis_activity_id: NonEmpty


class WorkspaceInvestigationCriticPacket(IncidentRunBinding):
    projection: IncidentProjection
    component_id: NonEmpty
    actor_subject_id: NonEmpty
    source_action_id: NonEmpty
    source_idempotency_key: NonEmpty
    critic_activity_id: NonEmpty
    synthesis: InvestigationSynthesisOutcome


class WorkspaceInvestigationFinalizePacket(IncidentRunBinding):
    projection: IncidentProjection
    component_id: NonEmpty
    actor_subject_id: NonEmpty
    source_action_id: NonEmpty
    source_idempotency_key: NonEmpty
    transition_key: NonEmpty
    event_sequence: PositiveInt
    synthesis: InvestigationSynthesisOutcome
    critic: Optional[InvestigationCriticOutcome] = None


class InvestigationStageRecordKind(str, Enum):
    SYNTHESIS = "SYNTHESIS"
    CRITIC = "CRITIC"


class WorkspaceInvestigationStageRecord(IncidentRunBinding):
    record_id: NonEmpty
    kind: InvestigationStageRecordKind
    synthesis: Optional[InvestigationSynthesisOutcome] = None
    critic: Optional[InvestigationCriticOutcome] = None

    @root_validator(allow_reuse=True)
    def record_carries_exact_stage_payload(cls, values):
        payload = None
        if values.get("kind") == InvestigationStageRecordKind.SYNTHESIS:
            if values.get("synthesis") is None or values.get("critic") is not None:
                raise ValueError("investigation_stage_record_payload_invalid")
            payload = values.get("synthesis")
        elif values.get("critic") is None or values.get("synthesis") is not None:
            raise ValueError("investigation_stage_record_payload_invalid")
        else:
            payload = values.get("critic")
        if payload is not None:
            for field in IncidentRunBinding.__fields__:
                if getattr(payload, field) != values.get(field):
                    raise ValueError("investigation_stage_record_binding_mismatch")
            expected_id = (
                payload.synthesis_activity_id
                if values.get("kind") == InvestigationStageRecordKind.SYNTHESIS
                else payload.critic_activity_id
            )
            if values.get("record_id") != expected_id:
                raise ValueError("investigation_stage_record_identity_mismatch")
        return values


class WorkspaceInvestigationCommit(StrictModel):
    transition_key: NonEmpty
    source_projection: IncidentProjection
    projection: IncidentProjection
    result_id: NonEmpty
    domain_claims: List[ClaimRecord] = Field(default_factory=list, max_items=64)
    event: "IncidentEvent"
    actions: List["NextBestAction"] = Field(default_factory=list)


class WorkspaceInvestigationOutcome(StrictModel):
    projection: IncidentProjection
    result: "InvestigationResult"
    actions: List["NextBestAction"] = Field(default_factory=list)


class InvestigationSynthesizer(Protocol):
    async def synthesize(self, request: InvestigationSynthesisRequest) -> InvestigationSynthesisOutput:
        """Return a schema-bound candidate; never a lifecycle decision."""


class InvestigationCriticPort(Protocol):
    identity: str

    async def critique(self, request: InvestigationCriticRequest) -> InvestigationCriticOutput:
        """Independently accept or reject a candidate against durable evidence."""


class UnavailableInvestigationSynthesizer:
    async def synthesize(self, request: InvestigationSynthesisRequest) -> Optional[InvestigationSynthesisOutput]:
        return None


class UnavailableInvestigationCritic:
    identity = "unconfigured-investigation-critic"

    async def critique(self, request: InvestigationCriticRequest) -> InvestigationCriticOutput:
        return InvestigationCriticOutput(
            decision=VerificationDecision.AMBIGUOUS,
            reason_codes=["critic_provider_unavailable"],
        )


class DeterministicInvestigationSynthesizer:
    """Explicit test-only synthesis provider; production construction never selects it."""

    truth_label = ProviderTruthLabel.TEST_DETERMINISTIC
    provider_id = "deterministic-investigation-test-provider"
    model_id = "deterministic-investigation-v1"

    def __init__(self) -> None:
        self.call_count = 0

    async def synthesize(self, request: InvestigationSynthesisRequest) -> InvestigationSynthesisOutput:
        self.call_count += 1
        evidence_id = request.evidence[0].evidence_id
        return InvestigationSynthesisOutput(
            summary="Current evidence supports a bounded checkout degradation hypothesis.",
            hypotheses=[InvestigationHypothesisCandidate(
                statement="The selected component is likely constrained by the observed current signal.",
                evidence_refs=[evidence_id],
            )],
        )


class DeterministicInvestigationCritic:
    """Independent test-only critic with its own identity and call counter."""

    identity = "deterministic-independent-critic"

    def __init__(self, decision: VerificationDecision = VerificationDecision.PASS) -> None:
        self.decision = decision
        self.call_count = 0

    async def critique(self, request: InvestigationCriticRequest) -> InvestigationCriticOutput:
        self.call_count += 1
        return InvestigationCriticOutput(
            decision=self.decision,
            reason_codes=(
                ["current_evidence_supports_candidate"]
                if self.decision == VerificationDecision.PASS
                else ["candidate_not_supported"]
            ),
        )


def claim_fingerprint(claim_type: str, statement: str, evidence_refs: List[str]) -> str:
    material = "{}|{}|{}".format(claim_type, statement, ",".join(sorted(evidence_refs)))
    return sha256(material.encode("utf-8")).hexdigest()


def temporal_investigation_finalize_activity(synthesis, critic) -> str:
    """Pure Temporal decision: only candidate + independent PASS may advance."""
    synthesis = InvestigationSynthesisOutcome.parse_obj(synthesis)
    critic = InvestigationCriticOutcome.parse_obj(critic) if critic is not None else None
    if (
        synthesis.disposition == InvestigationSynthesisDisposition.CANDIDATE
        and critic is not None
        and critic.decision == VerificationDecision.PASS
    ):
        return "workspace_accept_investigation_activity"
    return "workspace_record_investigation_degraded_activity"


def validate_investigation_source_transition(
    packet_binding: IncidentRunBinding,
    projection: IncidentProjection,
    source_transition,
    *,
    source_action_id: str,
    source_idempotency_key: str,
) -> None:
    """Bind synthesis to the exact durable Gate-1 read artifact set."""
    if source_transition is None:
        raise PolicyViolation("investigation_source_transition_missing")
    if (
        source_transition.receipt.status != "FRESH_READ_COMPLETED"
        or source_transition.receipt.action_id != source_action_id
        or source_transition.receipt.idempotency_key != source_idempotency_key
        or source_transition.projection != projection
        or source_transition.capability_result is None
        or source_transition.capability_audit is None
    ):
        raise PolicyViolation("investigation_source_transition_mismatch")
    for field in IncidentRunBinding.__fields__:
        if getattr(packet_binding, field) != getattr(projection, field):
            raise PolicyViolation("investigation_binding_mismatch")
    if projection.lifecycle_stage.value != "INVESTIGATE":
        raise PolicyViolation("investigation_projection_stage_mismatch")


def validate_workspace_investigation_commit(
    commit: WorkspaceInvestigationCommit,
    source_transition,
    synthesis: InvestigationSynthesisOutcome,
    critic: Optional[InvestigationCriticOutcome],
) -> None:
    """Repository-boundary validation for the only legal result successor."""
    if not isinstance(commit, WorkspaceInvestigationCommit):
        raise PolicyViolation("workspace_investigation_commit_invalid")
    source = commit.source_projection
    target = commit.projection
    validate_investigation_source_transition(
        IncidentRunBinding.parse_obj(source.dict(include=set(IncidentRunBinding.__fields__))),
        source,
        source_transition,
        source_action_id=source_transition.receipt.action_id,
        source_idempotency_key=source_transition.receipt.idempotency_key,
    )
    result = target.investigation_result
    if result is None:
        raise PolicyViolation("workspace_investigation_result_required")
    for stage in [synthesis] + ([critic] if critic is not None else []):
        for field in IncidentRunBinding.__fields__:
            if getattr(stage, field) != getattr(source, field):
                raise PolicyViolation("workspace_investigation_stage_binding_mismatch")
    if (
        synthesis.source_action_id != source_transition.receipt.action_id
        or synthesis.source_idempotency_key != source_transition.receipt.idempotency_key
        or synthesis.component_id != source_transition.capability_audit.component_id
        or synthesis.projection_revision != source.projection_revision
        or synthesis.evidence_revision != source.evidence_revision
        or synthesis.evidence_refs
        != [item.evidence_id for item in source_transition.capability_result.evidence]
    ):
        raise PolicyViolation("workspace_investigation_synthesis_source_mismatch")
    if synthesis.disposition == InvestigationSynthesisDisposition.CANDIDATE and critic is None:
        raise PolicyViolation("workspace_investigation_candidate_critic_required")
    if critic is not None and (
        critic.source_action_id != synthesis.source_action_id
        or critic.source_idempotency_key != synthesis.source_idempotency_key
        or critic.component_id != synthesis.component_id
        or critic.projection_revision != synthesis.projection_revision
        or critic.evidence_revision != synthesis.evidence_revision
        or critic.evidence_refs != synthesis.evidence_refs
        or critic.identity == synthesis.provider_id
    ):
        raise PolicyViolation("workspace_investigation_critic_source_mismatch")
    for field in IncidentRunBinding.__fields__:
        if (
            getattr(target, field) != getattr(source, field)
            or getattr(commit.event, field) != getattr(source, field)
        ):
            raise PolicyViolation("workspace_investigation_commit_binding_mismatch")
    if (
        target.projection_revision != source.projection_revision + 1
        or target.sequence != source.sequence + 1
        or target.evidence_revision != source.evidence_revision
        or target.gate_revision != source.gate_revision
        or target.action_revision != source.action_revision + 1
        or target.graph != source.graph
        or target.impacted_path != source.impacted_path
        or target.operator_title != source.operator_title
        or target.evidence_refs != source.evidence_refs
        or result.result_id != commit.result_id
    ):
        raise PolicyViolation("workspace_investigation_projection_successor_invalid")
    if (
        result.source_action_id != source_transition.receipt.action_id
        or result.source_idempotency_key != source_transition.receipt.idempotency_key
        or result.source_activity_identity != source_transition.activity_identity
        or result.component_id != synthesis.component_id
        or result.synthesis_id != synthesis.synthesis_id
        or result.synthesis_activity_id != synthesis.synthesis_activity_id
        or result.synthesis_provider_id != synthesis.provider_id
        or result.synthesis_model_id != synthesis.model_id
        or result.summary != synthesis.summary
        or result.truth_label
        != (
            synthesis.truth_label
            if result.disposition.value == "ACCEPTED"
            else ProviderTruthLabel.DEGRADED
        )
    ):
        raise PolicyViolation("workspace_investigation_result_source_mismatch")
    expected_evidence = [
        {
            "evidence_id": item.evidence_id,
            "source_kind": item.source_kind,
            "observed_at": item.observed_at,
            "freshness": item.freshness,
            "authority": item.authority,
            "proof_scope": item.proof_scope,
            "parent_evidence_refs": item.parent_evidence_ids,
        }
        for item in source_transition.capability_result.evidence
    ]
    if [item.dict() for item in result.evidence] != expected_evidence:
        raise PolicyViolation("workspace_investigation_result_evidence_mismatch")
    observation_claims = [item for item in result.claims if item.kind.value == "OBSERVATION"]
    expected_observations = [
        {
            "claim_id": item.claim_id,
            "kind": "OBSERVATION",
            "statement": item.statement,
            "evidence_refs": item.evidence_ids,
        }
        for item in source_transition.capability_result.claims
    ]
    if [item.dict() for item in observation_claims] != expected_observations:
        raise PolicyViolation("workspace_investigation_observation_claim_mismatch")
    hypothesis_claims = [item for item in result.claims if item.kind.value == "HYPOTHESIS"]
    expected_hypotheses = [
        {
            "claim_id": "investigation-claim-{}".format(
                claim_fingerprint("hypothesis", item.statement, item.evidence_refs)[:24],
            ),
            "kind": "HYPOTHESIS",
            "statement": item.statement,
            "evidence_refs": item.evidence_refs,
        }
        for item in synthesis.hypotheses
    ] if result.disposition.value == "ACCEPTED" else []
    if [item.dict() for item in hypothesis_claims] != expected_hypotheses:
        raise PolicyViolation("workspace_investigation_hypothesis_claim_mismatch")
    expected_fingerprints = [
        claim_fingerprint(item.claim_type, item.statement, item.evidence_ids)
        for item in source_transition.capability_result.claims
    ] + [
        claim_fingerprint("hypothesis", item.statement, item.evidence_refs)
        for item in synthesis.hypotheses
    ]
    if critic is not None and critic.reviewed_claim_fingerprints != expected_fingerprints:
        raise PolicyViolation("workspace_investigation_critic_claim_mismatch")
    if critic is None:
        if result.critic is not None:
            raise PolicyViolation("workspace_investigation_critic_result_mismatch")
    elif (
        result.critic is None
        or result.critic.critic_id != critic.critic_id
        or result.critic.identity != critic.identity
        or result.critic.decision != critic.decision
        or result.critic.reason_codes != critic.reason_codes
        or result.critic.reviewed_claim_ids != [item.claim_id for item in result.claims]
        or result.critic.evidence_refs != critic.evidence_refs
    ):
        raise PolicyViolation("workspace_investigation_critic_result_mismatch")
    if commit.event.projection_revision != target.projection_revision or commit.event.sequence != target.sequence:
        raise PolicyViolation("workspace_investigation_event_revision_invalid")
    accepted = result.disposition.value == "ACCEPTED"
    expected_accepted = (
        synthesis.disposition == InvestigationSynthesisDisposition.CANDIDATE
        and critic is not None
        and critic.decision == VerificationDecision.PASS
    )
    if accepted != expected_accepted:
        raise PolicyViolation("workspace_investigation_temporal_decision_mismatch")
    expected_event = "workspace.investigation.accepted" if accepted else "workspace.investigation.degraded"
    if (
        commit.event.event_type != expected_event
        or commit.event.evidence_refs != target.evidence_refs
        or commit.event.payload.get("result_id") != commit.result_id
        or commit.event.payload.get("lifecycle_stage") != target.lifecycle_stage.value
        or commit.event.payload.get("disposition") != result.disposition.value
    ):
        raise PolicyViolation("workspace_investigation_event_invalid")
    if commit.actions:
        raise PolicyViolation("workspace_investigation_unregistered_decide_action_forbidden")
    evidence_ids = {item.evidence_id for item in target.investigation_result.evidence}
    claim_ids = [item.claim_id for item in commit.domain_claims]
    if len(claim_ids) != len(set(claim_ids)):
        raise PolicyViolation("workspace_investigation_claim_ids_duplicate")
    for claim in commit.domain_claims:
        if (
            claim.tenant_id != target.tenant_id
            or claim.case_id != target.case_id
            or claim.case_revision != target.case_revision
            or not set(claim.evidence_ids).issubset(evidence_ids)
            or claim.status != ClaimStatus.SUPPORTED
        ):
            raise PolicyViolation("workspace_investigation_claim_lineage_invalid")
    expected_domain_claims = [
        {
            "claim_id": item.claim_id,
            "case_id": target.case_id,
            "case_revision": target.case_revision,
            "tenant_id": target.tenant_id,
            "claim_type": "hypothesis",
            "statement": item.statement,
            "evidence_ids": item.evidence_refs,
            "status": ClaimStatus.SUPPORTED,
            "requires_current_proof": True,
            "contradiction_ids": [],
            "created_by": "workspace-investigator:" + synthesis.synthesis_activity_id,
        }
        for item in hypothesis_claims
    ]
    if [item.dict() for item in commit.domain_claims] != expected_domain_claims:
        raise PolicyViolation("workspace_investigation_domain_claim_mismatch")


from .workspace_actions import NextBestAction  # noqa: E402
from .workspace_models import IncidentEvent, InvestigationResult  # noqa: E402

WorkspaceInvestigationCommit.update_forward_refs(
    IncidentEvent=IncidentEvent,
    NextBestAction=NextBestAction,
)
WorkspaceInvestigationOutcome.update_forward_refs(
    InvestigationResult=InvestigationResult,
    NextBestAction=NextBestAction,
)

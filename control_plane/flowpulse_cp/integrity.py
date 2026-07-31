"""Evidence admission, claim lineage, contradiction, critic, and verifier boundaries."""

from datetime import datetime, timezone
from hashlib import sha256
from typing import Dict, Iterable, List, Protocol, Sequence

from .models import (
    ClaimRecord,
    ClaimStatus,
    ConflictRecord,
    ConflictStatus,
    CoverageEntry,
    CoverageStatus,
    CriticDecision,
    EvidenceEnvelope,
    EvidenceAuthority,
    FreshnessStatus,
    SourceKind,
    ProofScope,
    VerificationDecision,
    VerificationReport,
)
from .policy import PolicyViolation, validate_claim_evidence, validate_evidence_admission
from .repository import InMemoryCaseRepository


REQUIRED_COVERAGE = {
    "affected_entity",
    "incident_window",
    "topology",
    "changes",
    "telemetry_symptom",
    "leading_cause",
    "alternative_hypothesis",
    "supporting_counter_evidence",
    "mitigation_preconditions",
    "success_and_rollback",
}


class EvidenceReadbackPort(Protocol):
    def readback(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        """Fresh, separately invoked source observation; never an investigator summary."""


class EvidenceGateway:
    def __init__(self, repository: InMemoryCaseRepository, subject_id: str = None) -> None:
        self.repository = repository
        self.subject_id = subject_id

    def admit(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        validate_evidence_admission(evidence, self.subject_id)
        if not evidence.source_uri or not evidence.source_anchor or not evidence.schema_binding:
            raise PolicyViolation("evidence_locator_or_schema_binding_missing")
        if evidence.proof_scope == ProofScope.REFERENCE_ONLY and evidence.source_kind != SourceKind.KNOWLEDGE:
            # P0 only uses reference-only for Knowledge Plane documents. Other
            # adapters must classify their own content explicitly.
            raise PolicyViolation("reference_only_scope_requires_knowledge_source")
        for parent_id in evidence.parent_evidence_ids:
            if parent_id == evidence.evidence_id:
                raise PolicyViolation("evidence_parent_self_reference")
            parent = self.repository.evidence.get(parent_id)
            if parent is None:
                raise PolicyViolation("unknown_parent_evidence")
            if (
                parent.tenant_id != evidence.tenant_id
                or parent.case_id != evidence.case_id
                or parent.case_revision != evidence.case_revision
            ):
                raise PolicyViolation("cross_tenant_or_cross_case_parent_evidence")
        self.repository.put_evidence(evidence)
        return evidence

    def admit_claim(self, claim: ClaimRecord) -> ClaimRecord:
        case = self.repository.cases.get(claim.case_id)
        if case is None or case.case_revision != claim.case_revision:
            raise PolicyViolation("claim_case_revision_mismatch")
        validate_claim_evidence(claim, self.repository.evidence_for_case(claim.case_id), self.subject_id)
        self.repository.put_claim(claim)
        return claim


def record_contradiction(repository: InMemoryCaseRepository, conflict: ConflictRecord) -> None:
    evidence = {item.evidence_id: item for item in repository.evidence_for_case(conflict.case_id)}
    if any(item_id not in evidence for item_id in conflict.evidence_ids):
        raise PolicyViolation("contradiction_unknown_evidence")
    if any(evidence[item_id].tenant_id != conflict.tenant_id for item_id in conflict.evidence_ids):
        raise PolicyViolation("contradiction_cross_tenant_evidence")
    repository.put_conflict(conflict)


class DeterministicCritic:
    identity = "critic:p0:separate-activity"

    def review(self, repository: InMemoryCaseRepository, case_id: str) -> CriticDecision:
        coverage = repository.coverage[case_id]
        filled = {item.field for item in coverage if item.status == CoverageStatus.FILLED and not item.conflict}
        missing = sorted(REQUIRED_COVERAGE - filled)
        open_conflicts = [
            item for item in repository.conflicts.values()
            if item.case_id == case_id and item.status in {ConflictStatus.OPEN, ConflictStatus.ACTION_BLOCKING}
        ]
        if open_conflicts:
            return CriticDecision(
                identity=self.identity,
                decision=VerificationDecision.AMBIGUOUS,
                missing_coverage=missing,
                reason_codes=["material_contradiction_unresolved"],
            )
        if missing:
            return CriticDecision(
                identity=self.identity,
                decision=VerificationDecision.AMBIGUOUS,
                missing_coverage=missing,
                reason_codes=["coverage_incomplete"],
            )
        return CriticDecision(identity=self.identity, decision=VerificationDecision.PASS)


class IndependentEvidenceVerifier:
    identity = "verifier:p0:fresh-source-readback"

    def __init__(self, readback: EvidenceReadbackPort) -> None:
        self.readback = readback

    def verify(
        self,
        repository: InMemoryCaseRepository,
        case_id: str,
        run_context_id: str,
        critic_identity: str = DeterministicCritic.identity,
        subject_id: str = None,
    ) -> VerificationReport:
        case = repository.cases[case_id]
        verified: List[str] = []
        failed: List[str] = []
        fresh_ids: List[str] = []
        for claim in [item for item in repository.claims.values() if item.case_id == case_id]:
            try:
                if (
                    claim.created_by == self.identity
                    or claim.created_by == critic_identity
                    or claim.created_by.startswith("verifier:")
                    or claim.created_by.startswith("critic:")
                    or self.identity == critic_identity
                ):
                    raise PolicyViolation("verifier_identity_not_independent")
                cited = [repository.evidence[item_id] for item_id in claim.evidence_ids]
                validate_claim_evidence(claim, cited)
                for evidence in cited:
                    reread = self.readback.readback(evidence)
                    if reread.tenant_id != case.tenant_id or reread.case_id != evidence.case_id:
                        raise PolicyViolation("readback_case_or_tenant_mismatch")
                    if reread.case_revision != evidence.case_revision:
                        raise PolicyViolation("readback_case_revision_mismatch")
                    if subject_id is not None and subject_id not in reread.acl_subjects:
                        raise PolicyViolation("readback_acl_subject_denied")
                    if reread.source_uri != evidence.source_uri or reread.source_anchor != evidence.source_anchor:
                        raise PolicyViolation("readback_locator_mismatch")
                    if reread.source_version != evidence.source_version:
                        raise PolicyViolation("readback_source_version_mismatch")
                    if reread.proof_scope != evidence.proof_scope:
                        raise PolicyViolation("readback_proof_scope_mismatch")
                    if reread.authority != evidence.authority or reread.freshness != evidence.freshness:
                        raise PolicyViolation("readback_authority_or_freshness_mismatch")
                    if reread.independence_key != evidence.independence_key:
                        raise PolicyViolation("readback_independence_key_mismatch")
                    if reread.content_hash != evidence.content_hash:
                        raise PolicyViolation("readback_content_hash_mismatch")
                    fresh_ids.append(reread.evidence_id)
                verified.append(claim.claim_id)
            except (KeyError, PolicyViolation):
                failed.append(claim.claim_id)
        if failed:
            decision = VerificationDecision.FAIL
            reasons = ["independent_source_readback_failed"]
        elif not verified:
            decision = VerificationDecision.AMBIGUOUS
            reasons = ["no_verifiable_claims"]
        else:
            decision = VerificationDecision.PASS
            reasons = []
        report = VerificationReport(
            verification_id="verify-{}-{}".format(case_id, run_context_id),
            case_id=case_id,
            case_revision=case.case_revision,
            tenant_id=case.tenant_id,
            verifier_identity=self.identity,
            run_context_id=run_context_id,
            verified_claim_ids=verified,
            failed_claim_ids=failed,
            fresh_evidence_ids=fresh_ids,
            decision=decision,
            reason_codes=reasons,
        )
        repository.put_verification(report)
        return report


class FrozenSourceReadback:
    """Deterministic source fixture used by tests and offline replay only."""

    def __init__(self, observed: Iterable[EvidenceEnvelope]) -> None:
        self.by_uri = {item.source_uri: item for item in observed}
        self.calls: List[str] = []

    def readback(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        self.calls.append(evidence.source_uri)
        item = self.by_uri.get(evidence.source_uri)
        if item is None:
            raise PolicyViolation("authoritative_source_unavailable")
        return item

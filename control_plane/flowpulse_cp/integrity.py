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
    ProofScope,
    VerificationDecision,
    VerificationReport,
)
from .policy import PolicyViolation, validate_claim_evidence
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
    def __init__(self, repository: InMemoryCaseRepository) -> None:
        self.repository = repository

    def admit(self, evidence: EvidenceEnvelope) -> EvidenceEnvelope:
        if not evidence.source_uri or not evidence.source_anchor or not evidence.schema_binding:
            raise PolicyViolation("evidence_locator_or_schema_binding_missing")
        if evidence.proof_scope == ProofScope.REFERENCE_ONLY and evidence.source_kind.value != "KNOWLEDGE":
            # P0 only uses reference-only for Knowledge Plane documents. Other
            # adapters must classify their own content explicitly.
            raise PolicyViolation("reference_only_scope_requires_knowledge_source")
        self.repository.put_evidence(evidence)
        return evidence

    def admit_claim(self, claim: ClaimRecord) -> ClaimRecord:
        validate_claim_evidence(claim, self.repository.evidence_for_case(claim.case_id))
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

    def verify(self, repository: InMemoryCaseRepository, case_id: str, run_context_id: str) -> VerificationReport:
        case = repository.cases[case_id]
        verified: List[str] = []
        failed: List[str] = []
        fresh_ids: List[str] = []
        for claim in [item for item in repository.claims.values() if item.case_id == case_id]:
            try:
                cited = [repository.evidence[item_id] for item_id in claim.evidence_ids]
                validate_claim_evidence(claim, cited)
                for evidence in cited:
                    reread = self.readback.readback(evidence)
                    if reread.tenant_id != case.tenant_id or reread.source_uri != evidence.source_uri:
                        raise PolicyViolation("readback_source_or_tenant_mismatch")
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
        return VerificationReport(
            verification_id="verify-{}-{}".format(case_id, run_context_id),
            case_id=case_id,
            tenant_id=case.tenant_id,
            verifier_identity=self.identity,
            run_context_id=run_context_id,
            verified_claim_ids=verified,
            failed_claim_ids=failed,
            fresh_evidence_ids=fresh_ids,
            decision=decision,
            reason_codes=reasons,
        )


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

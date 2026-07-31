"""Deterministic safety policies; no model output can override these checks."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Dict, Iterable, Sequence

from .models import (
    ApprovalDecision,
    ClaimRecord,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    OwnerApproval,
    ProofScope,
    RemediationProposal,
    SourceKind,
)


class PolicyViolation(ValueError):
    """A caller crossed a FlowPulse truth, tenant, or authority boundary."""


def require_authenticated_owner(subject_id: str, roles: Iterable[str]) -> None:
    """Authorize the trusted command principal, never a body-provided owner."""
    if not subject_id:
        raise PolicyViolation("authenticated_subject_required")
    if not set(roles).intersection({"owner", "local-test-owner"}):
        raise PolicyViolation("owner_role_required")


def canonical_json(value: Dict) -> str:
    """Stable JSON contract hash input (P0's RFC-8785-compatible subset)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def repair_contract_hash(proposal: RemediationProposal) -> str:
    contract = {
        "case_id": proposal.case_id,
        "case_revision": proposal.case_revision,
        "tenant_id": proposal.tenant_id,
        "proposal_id": proposal.proposal_id,
        "revision": proposal.revision,
        "action_type": proposal.action_type,
        "exact_targets": proposal.exact_targets,
        "exact_change": proposal.exact_change.dict(),
        "canary_scope": proposal.canary_scope.dict(),
        "preconditions": proposal.preconditions,
        "supporting_claim_ids": proposal.supporting_claim_ids,
        "success_criteria": proposal.success_criteria,
        "rollback": proposal.rollback.dict(),
        "idempotency_key": proposal.idempotency_key,
        "expires_at": proposal.expires_at.isoformat(),
    }
    return hashlib.sha256(canonical_json(contract).encode("utf-8")).hexdigest()


def validate_claim_evidence(
    claim: ClaimRecord, evidence: Sequence[EvidenceEnvelope], subject_id: str = None
) -> None:
    by_id = {item.evidence_id: item for item in evidence}
    missing = set(claim.evidence_ids) - set(by_id)
    if missing:
        raise PolicyViolation("unknown_evidence_id:" + ",".join(sorted(missing)))
    cited = [by_id[item_id] for item_id in claim.evidence_ids]
    if any(
        item.tenant_id != claim.tenant_id
        or item.case_id != claim.case_id
        or item.case_revision != claim.case_revision
        for item in cited
    ):
        raise PolicyViolation("cross_tenant_case_or_revision_evidence")
    if subject_id is not None and any(subject_id not in item.acl_subjects for item in cited):
        raise PolicyViolation("evidence_acl_subject_denied")
    if claim.requires_current_proof and not any(
        item.proof_scope == ProofScope.CURRENT_OBSERVATION
        and item.freshness == FreshnessStatus.CURRENT
        and item.authority in {EvidenceAuthority.T0, EvidenceAuthority.T1}
        for item in cited
    ):
        raise PolicyViolation("current_incident_proof_required")


def validate_evidence_admission(evidence: EvidenceEnvelope, subject_id: str = None) -> None:
    """Repeat current-proof checks at admission, including copy(update) bypasses."""
    if evidence.source_kind == SourceKind.KNOWLEDGE and evidence.proof_scope != ProofScope.REFERENCE_ONLY:
        raise PolicyViolation("knowledge_evidence_must_be_reference_only")
    if evidence.proof_scope == ProofScope.CURRENT_OBSERVATION:
        if evidence.freshness != FreshnessStatus.CURRENT:
            raise PolicyViolation("current_incident_proof_requires_current_freshness")
        if evidence.authority not in {EvidenceAuthority.T0, EvidenceAuthority.T1}:
            raise PolicyViolation("current_incident_proof_requires_trusted_authority")
        if not evidence.acl_subjects:
            raise PolicyViolation("current_incident_proof_requires_subject_acl")
    if subject_id is not None and subject_id not in evidence.acl_subjects:
        raise PolicyViolation("evidence_acl_subject_denied")


def validate_owner_gate(
    approval: OwnerApproval,
    proposal: RemediationProposal,
    current_case_revision: int,
    current_witness: Dict[str, str],
    now: datetime,
    authenticated_subject: str,
    authenticated_roles: Iterable[str],
    action_allowlist: Iterable[str] = (),
) -> None:
    """Fail closed before a dry-run or a future P1 executor can act."""
    now = now.astimezone(timezone.utc)
    if approval.actor_id != authenticated_subject:
        raise PolicyViolation("approval_actor_not_authenticated_subject")
    require_authenticated_owner(authenticated_subject, authenticated_roles)
    if approval.decision != ApprovalDecision.APPROVED:
        raise PolicyViolation("approval_not_approved")
    if approval.expires_at.astimezone(timezone.utc) <= now or proposal.expires_at.astimezone(timezone.utc) <= now:
        raise PolicyViolation("approval_or_proposal_expired")
    if approval.case_id != proposal.case_id or approval.tenant_id != proposal.tenant_id:
        raise PolicyViolation("approval_case_or_tenant_mismatch")
    if approval.case_revision != current_case_revision or proposal.case_revision != current_case_revision:
        raise PolicyViolation("case_revision_mismatch")
    if approval.proposal_id != proposal.proposal_id or approval.proposal_revision != proposal.revision:
        raise PolicyViolation("proposal_revision_mismatch")
    if approval.repair_contract_hash != repair_contract_hash(proposal):
        raise PolicyViolation("repair_contract_hash_mismatch")
    if approval.execution_targets != proposal.exact_targets:
        raise PolicyViolation("approval_target_sequence_mismatch")
    if len(proposal.exact_targets) > proposal.canary_scope.maximum_targets:
        raise PolicyViolation("proposal_canary_maximum_targets_exceeded")
    if len(proposal.exact_targets) > approval.maximum_targets:
        raise PolicyViolation("approval_maximum_targets_exceeded")
    if proposal.preconditions != current_witness:
        raise PolicyViolation("proposal_preconditions_changed")
    if approval.precondition_witness != current_witness:
        raise PolicyViolation("precondition_witness_changed")
    if action_allowlist and proposal.action_type not in set(action_allowlist):
        raise PolicyViolation("action_not_allowlisted")

"""Deterministic safety policies; no model output can override these checks."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Dict, Iterable, Sequence

from .models import (
    ApprovalDecision,
    ClaimRecord,
    EvidenceEnvelope,
    FreshnessStatus,
    OwnerApproval,
    ProofScope,
    RemediationProposal,
)


class PolicyViolation(ValueError):
    """A caller crossed a FlowPulse truth, tenant, or authority boundary."""


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
        "exact_change": proposal.exact_change,
        "canary_scope": proposal.canary_scope,
        "preconditions": proposal.preconditions,
        "supporting_claim_ids": proposal.supporting_claim_ids,
        "success_criteria": proposal.success_criteria,
        "rollback": proposal.rollback,
        "idempotency_key": proposal.idempotency_key,
        "expires_at": proposal.expires_at.isoformat(),
    }
    return hashlib.sha256(canonical_json(contract).encode("utf-8")).hexdigest()


def validate_claim_evidence(claim: ClaimRecord, evidence: Sequence[EvidenceEnvelope]) -> None:
    by_id = {item.evidence_id: item for item in evidence}
    missing = set(claim.evidence_ids) - set(by_id)
    if missing:
        raise PolicyViolation("unknown_evidence_id:" + ",".join(sorted(missing)))
    cited = [by_id[item_id] for item_id in claim.evidence_ids]
    if any(item.tenant_id != claim.tenant_id or item.case_id != claim.case_id for item in cited):
        raise PolicyViolation("cross_tenant_or_cross_case_evidence")
    if claim.requires_current_proof and not any(
        item.proof_scope == ProofScope.CURRENT_OBSERVATION and item.freshness != FreshnessStatus.STALE
        for item in cited
    ):
        raise PolicyViolation("current_incident_proof_required")


def validate_owner_gate(
    approval: OwnerApproval,
    proposal: RemediationProposal,
    current_case_revision: int,
    current_witness: Dict[str, str],
    now: datetime,
    action_allowlist: Iterable[str] = (),
) -> None:
    """Fail closed before a dry-run or a future P1 executor can act."""
    now = now.astimezone(timezone.utc)
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
    if set(approval.execution_targets) != set(proposal.exact_targets):
        raise PolicyViolation("approval_target_scope_mismatch")
    if len(proposal.exact_targets) > approval.maximum_targets:
        raise PolicyViolation("approval_maximum_targets_exceeded")
    if approval.precondition_witness != current_witness:
        raise PolicyViolation("precondition_witness_changed")
    if action_allowlist and proposal.action_type not in set(action_allowlist):
        raise PolicyViolation("action_not_allowlisted")

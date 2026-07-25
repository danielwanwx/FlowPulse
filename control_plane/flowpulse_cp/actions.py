"""Exact owner gate and P0 dry-run-only action boundary."""

from datetime import datetime
from typing import Dict, Set

from .models import DryRunReceipt, OwnerApproval
from .policy import PolicyViolation, validate_owner_gate
from .repository import InMemoryCaseRepository


class DryRunActionService:
    """P0 never dispatches a write. This receipt is intentionally non-executable."""

    def __init__(self, repository: InMemoryCaseRepository) -> None:
        self.repository = repository
        self._receipts: Dict[str, DryRunReceipt] = {}

    def dry_run(
        self,
        proposal_id: str,
        approval: OwnerApproval,
        current_witness: Dict[str, str],
        now: datetime,
    ) -> DryRunReceipt:
        proposal = self.repository.proposals.get(proposal_id)
        if proposal is None:
            raise PolicyViolation("unknown_proposal")
        case = self.repository.cases[proposal.case_id]
        validate_owner_gate(
            approval=approval,
            proposal=proposal,
            current_case_revision=case.case_revision,
            current_witness=current_witness,
            now=now,
            # An explicit deny-all: P0 can only return a simulated receipt.
            action_allowlist=(),
        )
        existing = self._receipts.get(proposal.idempotency_key)
        if existing:
            return existing
        receipt = DryRunReceipt(
            proposal_id=proposal.proposal_id,
            idempotency_key=proposal.idempotency_key,
            reason="p0_non_executing_dry_run_only",
        )
        self._receipts[proposal.idempotency_key] = receipt
        self.repository.put_approval(approval)
        return receipt

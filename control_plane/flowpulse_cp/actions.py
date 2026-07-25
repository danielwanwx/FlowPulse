"""Exact owner gate and P0 dry-run-only action boundary."""

from datetime import datetime
from typing import Dict, Tuple

from .models import DryRunReceipt, OwnerApproval
from .policy import PolicyViolation, repair_contract_hash, validate_owner_gate
from .repository import InMemoryCaseRepository


class DryRunActionService:
    """P0 never dispatches a write. This receipt is intentionally non-executable."""

    def __init__(self, repository: InMemoryCaseRepository) -> None:
        self.repository = repository
        self._receipts: Dict[Tuple[str, str, str, str, str], DryRunReceipt] = {}
        self._idempotency_bindings: Dict[str, Tuple[str, str, str, str]] = {}

    def dry_run(
        self,
        proposal_id: str,
        approval: OwnerApproval,
        current_witness: Dict[str, str],
        now: datetime,
    ) -> DryRunReceipt:
        # Keep the service itself tenant scoped too; callers must not be able
        # to turn a guessed proposal id into a cross-tenant dry-run.
        proposal = self.repository.get_proposal(approval.tenant_id, proposal_id)
        if proposal is None:
            raise PolicyViolation("unknown_proposal")
        case = self.repository.get_case(approval.tenant_id, proposal.case_id)
        if case is None:
            raise PolicyViolation("unknown_case")
        validate_owner_gate(
            approval=approval,
            proposal=proposal,
            current_case_revision=case.case_revision,
            current_witness=current_witness,
            now=now,
            # An explicit deny-all: P0 can only return a simulated receipt.
            action_allowlist=(),
        )
        contract_hash = repair_contract_hash(proposal)
        binding = (proposal.tenant_id, proposal.case_id, proposal.proposal_id, contract_hash)
        prior_binding = self._idempotency_bindings.get(proposal.idempotency_key)
        if prior_binding is not None and prior_binding != binding:
            raise PolicyViolation("idempotency_key_reuse_across_tenant_case_proposal_or_contract")
        receipt_key = binding + (proposal.idempotency_key,)
        existing = self._receipts.get(receipt_key)
        if existing:
            return existing
        receipt = DryRunReceipt(
            tenant_id=proposal.tenant_id,
            case_id=proposal.case_id,
            proposal_id=proposal.proposal_id,
            repair_contract_hash=contract_hash,
            idempotency_key=proposal.idempotency_key,
            reason="p0_non_executing_dry_run_only",
        )
        self._idempotency_bindings[proposal.idempotency_key] = binding
        self._receipts[receipt_key] = receipt
        self.repository.put_approval(approval)
        return receipt

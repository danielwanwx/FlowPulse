"""Append-only domain-record repository and P0 local artifact store.

The in-memory implementation is for local replay and unit tests. Production
deployments use the Postgres schema in migrations/ and retain Temporal as the
sole workflow authority; repositories never advance a case on their own.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import (
    ClaimRecord,
    ConflictRecord,
    CoverageEntry,
    EvidenceEnvelope,
    IncidentCase,
    InvestigatorAssignment,
    OwnerApproval,
    RemediationProposal,
)
from .policy import PolicyViolation


@dataclass(frozen=True)
class DomainEvent:
    event_id: str
    case_id: str
    tenant_id: str
    event_type: str
    occurred_at: datetime
    payload: Dict[str, Any]


class InMemoryCaseRepository:
    """A deterministic projection of append-only records, never an orchestrator."""

    def __init__(self) -> None:
        self.cases: Dict[str, IncidentCase] = {}
        self.events: List[DomainEvent] = []
        self.evidence: Dict[str, EvidenceEnvelope] = {}
        self.claims: Dict[str, ClaimRecord] = {}
        self.conflicts: Dict[str, ConflictRecord] = {}
        self.coverage: Dict[str, List[CoverageEntry]] = defaultdict(list)
        self.assignments: Dict[str, InvestigatorAssignment] = {}
        self.proposals: Dict[str, RemediationProposal] = {}
        self.approvals: Dict[str, OwnerApproval] = {}

    def append_event(self, event: DomainEvent) -> None:
        case = self.cases.get(event.case_id)
        if case is None or case.tenant_id != event.tenant_id:
            raise PolicyViolation("event_case_tenant_mismatch")
        self.events.append(event)

    def put_case(self, case: IncidentCase) -> None:
        existing = self.cases.get(case.case_id)
        if existing and existing.tenant_id != case.tenant_id:
            raise PolicyViolation("case_id_tenant_collision")
        self.cases[case.case_id] = case

    def replace_case_from_workflow(self, case: IncidentCase, event: DomainEvent) -> None:
        """Only the Temporal activity result path may update this read model."""
        if event.case_id != case.case_id or event.tenant_id != case.tenant_id:
            raise PolicyViolation("workflow_event_case_mismatch")
        self.put_case(case)
        self.events.append(event)

    def evidence_for_case(self, case_id: str) -> List[EvidenceEnvelope]:
        return [item for item in self.evidence.values() if item.case_id == case_id]

    def put_evidence(self, evidence: EvidenceEnvelope) -> None:
        case = self.cases.get(evidence.case_id)
        if case is None:
            raise PolicyViolation("unknown_case")
        if case.tenant_id != evidence.tenant_id or case.case_revision != evidence.case_revision:
            raise PolicyViolation("evidence_case_tenant_or_revision_mismatch")
        existing = self.evidence.get(evidence.evidence_id)
        if existing and existing != evidence:
            raise PolicyViolation("evidence_id_immutable")
        self.evidence[evidence.evidence_id] = evidence

    def put_claim(self, claim: ClaimRecord) -> None:
        case = self.cases.get(claim.case_id)
        if case is None or case.tenant_id != claim.tenant_id:
            raise PolicyViolation("claim_case_tenant_mismatch")
        self.claims[claim.claim_id] = claim

    def put_conflict(self, conflict: ConflictRecord) -> None:
        case = self.cases.get(conflict.case_id)
        if case is None or case.tenant_id != conflict.tenant_id:
            raise PolicyViolation("conflict_case_tenant_mismatch")
        self.conflicts[conflict.conflict_id] = conflict

    def put_coverage(self, entry: CoverageEntry) -> None:
        case = self.cases.get(entry.case_id)
        if case is None or case.tenant_id != entry.tenant_id:
            raise PolicyViolation("coverage_case_tenant_mismatch")
        self.coverage[entry.case_id].append(entry)

    def put_assignment(self, assignment: InvestigatorAssignment) -> None:
        case = self.cases.get(assignment.case_id)
        if case is None or case.tenant_id != assignment.tenant_id:
            raise PolicyViolation("assignment_case_tenant_mismatch")
        if assignment.role == "primary" and any(
            item.case_id == assignment.case_id and item.role == "primary" for item in self.assignments.values()
        ):
            raise PolicyViolation("primary_already_assigned")
        specialists = [
            item for item in self.assignments.values() if item.case_id == assignment.case_id and item.role != "primary"
        ]
        if assignment.role != "primary" and len(specialists) >= 4:
            raise PolicyViolation("specialist_cap_exceeded")
        self.assignments[assignment.assignment_id] = assignment

    def put_proposal(self, proposal: RemediationProposal) -> None:
        case = self.cases.get(proposal.case_id)
        if case is None or case.tenant_id != proposal.tenant_id:
            raise PolicyViolation("proposal_case_tenant_mismatch")
        self.proposals[proposal.proposal_id] = proposal

    def put_approval(self, approval: OwnerApproval) -> None:
        case = self.cases.get(approval.case_id)
        if case is None or case.tenant_id != approval.tenant_id:
            raise PolicyViolation("approval_case_tenant_mismatch")
        self.approvals[approval.approval_id] = approval


class LocalArtifactStore:
    """Versioned object-store port backed by files for P0 replay, not a shared FS claim."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def put(self, tenant_id: str, content: bytes) -> str:
        digest = sha256(content).hexdigest()
        key = "{}/sha256/{}".format(tenant_id, digest)
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != content:
            raise PolicyViolation("artifact_hash_collision")
        target.write_bytes(content)
        return key

    def read(self, tenant_id: str, key: str) -> bytes:
        if not key.startswith(tenant_id + "/"):
            raise PolicyViolation("cross_tenant_artifact_access")
        return (self.root / key).read_bytes()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)

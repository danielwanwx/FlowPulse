"""Typed activity-facing ports. OpenAI/Responses belongs behind these ports only."""

from datetime import datetime
from typing import Any, Dict, List, Protocol

from .models import ClaimRecord, CoverageEntry, EvidenceEnvelope, InvestigatorAssignment


class InvestigatorPort(Protocol):
    identity: str

    def investigate(
        self, assignment: InvestigatorAssignment, current_evidence: List[EvidenceEnvelope]
    ) -> List[ClaimRecord]:
        """Return structured candidates; caller applies evidence and policy validation."""


class OpenAIResponsesPort(Protocol):
    """Typed boundary for Agents SDK/Responses calls inside a Temporal activity."""

    def structured_investigation(self, role: str, packet: Dict[str, Any]) -> Dict[str, Any]:
        """Return only schema-bound candidate data; no workflow/state operations."""


class ControlActivityDispatcher(Protocol):
    """Adapter seam for Temporal activities and all external systems."""

    def dispatch(self, stage: str, packet: Dict[str, Any]) -> Dict[str, Any]:
        """Perform one typed activity and return a schema-validated record reference/result."""


class DeterministicPrimaryInvestigator:
    """A no-network P0 fake. It proves contracts, not an RCA capability claim."""

    identity = "primary:p0:deterministic-fake"

    def investigate(
        self, assignment: InvestigatorAssignment, current_evidence: List[EvidenceEnvelope]
    ) -> List[ClaimRecord]:
        current = [item for item in current_evidence if item.proof_scope.value == "CURRENT_OBSERVATION"]
        if not current:
            return []
        return [
            ClaimRecord(
                claim_id="claim-{}".format(assignment.case_id),
                case_id=assignment.case_id,
                case_revision=assignment.case_revision,
                tenant_id=assignment.tenant_id,
                claim_type="suspected_root_cause",
                statement="Current source indicates the bounded incident condition.",
                evidence_ids=[current[0].evidence_id],
                created_by=self.identity,
            )
        ]


def temporal_activity_surface() -> List[str]:
    """Names registered with a production Temporal worker (kept data-only for tests)."""
    return [
        "route_case_activity",
        "retrieve_knowledge_activity",
        "primary_investigator_activity",
        "specialist_activity",
        "critic_activity",
        "independent_verify_activity",
        "owner_gate_activity",
    ]


def build_temporal_activities(dispatcher: ControlActivityDispatcher) -> List[Any]:
    """Lazily construct production Temporal activity functions.

    The SDK is imported only in a Temporal worker process. The request packet
    contains scoped references, never raw credentials or a mutable case state.
    """
    from temporalio import activity

    def definition(name: str):
        @activity.defn(name=name)
        async def run(packet: Dict[str, Any]) -> Dict[str, Any]:
            return dispatcher.dispatch(name, packet)
        return run

    return [definition(name) for name in temporal_activity_surface()]

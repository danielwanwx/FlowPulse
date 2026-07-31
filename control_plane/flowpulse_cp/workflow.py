"""Deterministic diagnosis workflow kernel and test-only Temporal adapter.

This module deliberately has no database-driven scheduler. In production the
Temporal workflow in temporal_workflow.py invokes the same typed activity
surface; this kernel merely replays recorded activity values in tests.
"""

from dataclasses import replace
from datetime import datetime
from typing import Iterable, List, Sequence

from .activities import InvestigatorPort
from .integrity import DeterministicCritic, EvidenceGateway, IndependentEvidenceVerifier
from .knowledge import KnowledgePlane
from .models import (
    CaseState,
    CoverageEntry,
    CoverageStatus,
    EvidenceEnvelope,
    IncidentCase,
    IncidentIntake,
    InvestigatorAssignment,
    VerificationDecision,
)
from .repository import DomainEvent, InMemoryCaseRepository
from .router import route_case


def event(case: IncidentCase, event_type: str, at: datetime, **payload: str) -> DomainEvent:
    return DomainEvent(
        event_id="{}:{}:{}".format(case.case_id, event_type, len(payload)),
        case_id=case.case_id,
        tenant_id=case.tenant_id,
        event_type=event_type,
        occurred_at=at,
        payload=payload,
    )


class TestOnlyTemporalAdapter:
    """Fake Temporal test environment. It records history but is never deployment authority."""

    def __init__(
        self,
        repository: InMemoryCaseRepository,
        knowledge: KnowledgePlane,
        gateway: EvidenceGateway,
        primary: InvestigatorPort,
        critic: DeterministicCritic,
        verifier: IndependentEvidenceVerifier,
    ) -> None:
        self.repository = repository
        self.knowledge = knowledge
        self.gateway = gateway
        self.primary = primary
        self.critic = critic
        self.verifier = verifier
        self.history: List[str] = []

    def _transition(self, case: IncidentCase, state: CaseState, now: datetime, **context: str) -> IncidentCase:
        updated = case.copy(update={"state": state, "updated_at": now, **context})
        self.repository.replace_case_from_workflow(updated, event(updated, "state.{}".format(state.value), now, **context))
        self.history.append(state.value)
        return updated

    def run(
        self,
        case: IncidentCase,
        intake: IncidentIntake,
        current_evidence: Sequence[EvidenceEnvelope],
        coverage: Sequence[CoverageEntry],
        now: datetime,
        evidence_families: int = 1,
    ) -> IncidentCase:
        """Replay one bounded read-only chain from intake through owner wait/abstain."""
        self.repository.put_case(case)
        self.history.append(CaseState.RECEIVED.value)
        case = self._transition(case, CaseState.NORMALIZING, now)
        route = route_case(intake, evidence_families=evidence_families)
        case = self._transition(case, CaseState.ROUTED, now, route_reason="|".join(route.reason_codes))
        try:
            # Router/Planner prior: knowledge is admitted as reference evidence before investigation.
            for candidate in self.knowledge.retrieve(
                case.tenant_id,
                intake.actor_id,
                case.case_id,
                case.case_revision,
                case.environment,
                case.affected_entities,
                "runbook",
                now,
            ):
                self.gateway.admit(candidate.evidence)
            for evidence in current_evidence:
                self.gateway.admit(evidence)
            primary = InvestigatorAssignment(
                assignment_id="primary-{}".format(case.case_id),
                case_id=case.case_id,
                case_revision=case.case_revision,
                tenant_id=case.tenant_id,
                role="primary",
                question="What current evidence supports or contradicts the leading cause?",
                allowed_tools=["read_evidence"],
                allowed_entities=case.affected_entities,
                dispatched_at=now,
            )
            self.repository.put_assignment(primary)
            for index, role in enumerate(route.specialist_roles):
                self.repository.put_assignment(
                    InvestigatorAssignment(
                        assignment_id="specialist-{}-{}".format(case.case_id, index),
                        case_id=case.case_id,
                        case_revision=case.case_revision,
                        tenant_id=case.tenant_id,
                        role=role,
                        question="Answer one independent {} question with cited evidence.".format(role),
                        allowed_tools=["read_evidence"],
                        allowed_entities=case.affected_entities,
                        dispatched_at=now,
                    )
                )
            case = self._transition(case, CaseState.INVESTIGATING, now)
            claims = self.primary.investigate(primary, list(current_evidence))
            for claim in claims:
                self.gateway.admit_claim(claim)
            for entry in coverage:
                self.repository.put_coverage(entry)
            case = self._transition(case, CaseState.EVALUATING, now)
            critic = self.critic.review(self.repository, case.case_id)
            if critic.decision != VerificationDecision.PASS:
                return self._transition(
                    case,
                    CaseState.NEEDS_HUMAN,
                    now,
                    human_question="Resolve coverage gaps or contradiction before diagnosis can proceed.",
                )
            case = self._transition(case, CaseState.VERIFYING_EVIDENCE, now)
            report = self.verifier.verify(self.repository, case.case_id, "fresh-{}".format(case.workflow_run_id))
            if report.decision != VerificationDecision.PASS:
                return self._transition(
                    case,
                    CaseState.ABSTAINED,
                    now,
                    human_question="Independent source readback did not verify current evidence.",
                )
            return self._transition(case, CaseState.AWAITING_OWNER, now)
        except Exception as error:
            return self._transition(
                case,
                CaseState.BLOCKED,
                now,
                blocker_code="{}".format(str(error).split(":", 1)[0]),
            )

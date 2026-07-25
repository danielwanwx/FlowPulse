"""FastAPI boundary for P0's typed, non-executing control plane."""

from typing import Dict, Protocol

from fastapi import FastAPI, HTTPException

from .actions import DryRunActionService
from .models import IncidentCase, IncidentIntake, OwnerApproval, RemediationProposal
from .policy import PolicyViolation
from .repository import InMemoryCaseRepository


class TemporalStartPort(Protocol):
    """The API may request a Temporal start; it cannot persist a competing run."""

    def start_case(self, intake: IncidentIntake) -> IncidentCase:
        ...


class TemporalUnavailableStarter:
    def start_case(self, intake: IncidentIntake) -> IncidentCase:
        raise RuntimeError("temporal_start_unavailable")


def create_app(
    repository: InMemoryCaseRepository = None,
    dry_runs: DryRunActionService = None,
    temporal_starter: TemporalStartPort = None,
) -> FastAPI:
    repository = repository or InMemoryCaseRepository()
    dry_runs = dry_runs or DryRunActionService(repository)
    temporal_starter = temporal_starter or TemporalUnavailableStarter()
    app = FastAPI(title="FlowPulse Diagnosis Control Plane P0", version="0.1.0")

    @app.get("/healthz")
    def healthz() -> Dict[str, str]:
        return {"status": "ok", "workflow_authority": "temporal"}

    @app.post("/v1/cases", response_model=IncidentCase, status_code=202)
    def intake_case(intake: IncidentIntake) -> IncidentCase:
        try:
            # Production implementation is Temporal Client.start_workflow;
            # the API intentionally cannot create a durable case itself.
            return temporal_starter.start_case(intake)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v1/cases/{case_id}", response_model=IncidentCase)
    def get_case(case_id: str) -> IncidentCase:
        case = repository.cases.get(case_id)
        if case is None:
            raise HTTPException(status_code=404, detail="case_not_found")
        return case

    @app.post("/v1/proposals", response_model=RemediationProposal, status_code=202)
    def record_proposal(proposal: RemediationProposal) -> RemediationProposal:
        try:
            repository.put_proposal(proposal)
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))
        return proposal

    @app.post("/v1/proposals/{proposal_id}/dry-run")
    def dry_run(proposal_id: str, approval: OwnerApproval, current_witness: Dict[str, str]):
        try:
            return dry_runs.dry_run(proposal_id, approval, current_witness, datetime.now(timezone.utc))
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))

    return app


app = create_app()

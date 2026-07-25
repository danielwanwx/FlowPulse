"""Tenant-scoped FastAPI boundary; authentication comes from trusted ASGI state."""

from datetime import datetime, timezone
from typing import Optional, Protocol

from fastapi import Depends, FastAPI, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware

from .actions import DryRunActionService
from .models import AuthContext, DryRunRequest, IncidentCase, IncidentIntake, RemediationProposal
from .policy import PolicyViolation
from .repository import InMemoryCaseRepository


class TemporalStartPort(Protocol):
    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        ...


class TemporalUnavailableStarter:
    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        raise RuntimeError("temporal_start_unavailable")


class RepositoryUnavailable:
    """Fail closed until production composition supplies a Postgres adapter."""

    def get_case(self, tenant_id: str, case_id: str):
        return None

    def get_proposal(self, tenant_id: str, proposal_id: str):
        return None

    def put_proposal(self, proposal: RemediationProposal) -> None:
        raise PolicyViolation("postgres_repository_unavailable")


class LocalTestAuthMiddleware(BaseHTTPMiddleware):
    """Compose-only test adapter; production must inject ASGI auth state."""
    async def dispatch(self, request: Request, call_next):
        tenant = request.headers.get("x-flowpulse-test-tenant")
        subject = request.headers.get("x-flowpulse-test-subject")
        if tenant and subject:
            request.state.flowpulse_auth = AuthContext(
                tenant_id=tenant, subject_id=subject, roles=["local-test-owner"]
            )
        return await call_next(request)


def trusted_auth_context(request: Request) -> AuthContext:
    """Only an upstream authentication middleware may set this trusted value."""
    context = getattr(request.state, "flowpulse_auth", None)
    if not isinstance(context, AuthContext):
        raise HTTPException(status_code=401, detail="trusted_auth_context_required")
    return context


def tenant_match(value: str, actor: AuthContext) -> None:
    if value != actor.tenant_id:
        raise HTTPException(status_code=403, detail="body_tenant_does_not_match_authenticated_tenant")


def create_app(
    repository: Optional[InMemoryCaseRepository] = None,
    dry_runs: Optional[DryRunActionService] = None,
    temporal_starter: Optional[TemporalStartPort] = None,
    allow_local_test_auth: bool = False,
) -> FastAPI:
    # Production has no silent in-memory fallback. Tests explicitly inject the
    # deterministic adapter; production composition injects Postgres.
    repository = repository or RepositoryUnavailable()
    dry_runs = dry_runs or DryRunActionService(repository)
    temporal_starter = temporal_starter or TemporalUnavailableStarter()
    app = FastAPI(title="FlowPulse Diagnosis Control Plane P0", version="0.2.0")
    if allow_local_test_auth:
        app.add_middleware(LocalTestAuthMiddleware)

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok", "workflow_authority": "temporal"}

    @app.post("/v1/cases", response_model=IncidentCase, status_code=202)
    async def intake_case(
        intake: IncidentIntake,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentCase:
        tenant_match(intake.tenant_id, actor)
        # The body actor is untrusted. Preserve its shape only after forcing
        # the authenticated tenant and subject through the Temporal starter.
        trusted_intake = intake.copy(update={"tenant_id": actor.tenant_id, "actor_id": actor.subject_id})
        try:
            return await temporal_starter.start_case(trusted_intake, actor)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v1/cases/{case_id}", response_model=IncidentCase)
    async def get_case(case_id: str, actor: AuthContext = Depends(trusted_auth_context)) -> IncidentCase:
        case = repository.get_case(actor.tenant_id, case_id)
        if case is None:
            raise HTTPException(status_code=404, detail="case_not_found")
        return case

    @app.post("/v1/proposals", response_model=RemediationProposal, status_code=202)
    async def record_proposal(
        proposal: RemediationProposal,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> RemediationProposal:
        tenant_match(proposal.tenant_id, actor)
        if repository.get_case(actor.tenant_id, proposal.case_id) is None:
            raise HTTPException(status_code=404, detail="case_not_found")
        try:
            repository.put_proposal(proposal)
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))
        return proposal

    @app.post("/v1/proposals/{proposal_id}/dry-run")
    async def dry_run(
        proposal_id: str,
        request: DryRunRequest,
        actor: AuthContext = Depends(trusted_auth_context),
    ):
        proposal = repository.get_proposal(actor.tenant_id, proposal_id)
        if proposal is None:
            raise HTTPException(status_code=404, detail="proposal_not_found")
        tenant_match(request.approval.tenant_id, actor)
        trusted_approval = request.approval.copy(update={"tenant_id": actor.tenant_id, "actor_id": actor.subject_id})
        try:
            return dry_runs.dry_run(proposal_id, trusted_approval, request.current_witness, datetime.now(timezone.utc))
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))

    return app


app = create_app()

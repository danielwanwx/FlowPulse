"""Tenant-scoped FastAPI boundary with a real Postgres lifespan repository."""

import inspect
from contextlib import asynccontextmanager
from typing import Any, Optional, Protocol

from fastapi import Depends, FastAPI, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware

from .models import (
    AuthContext,
    DryRunRequest,
    IncidentCase,
    IncidentIntake,
    OwnerCommandReceipt,
    OwnerGateCommand,
    RemediationProposal,
)
from .policy import PolicyViolation, require_authenticated_owner
from .postgres import PostgresCaseRepository


class TemporalStartPort(Protocol):
    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        ...

    async def submit_owner_command(self, case: IncidentCase, command: OwnerGateCommand) -> OwnerCommandReceipt:
        ...


class TemporalUnavailableStarter:
    async def start_case(self, intake: IncidentIntake, actor: AuthContext) -> IncidentCase:
        raise RuntimeError("temporal_start_unavailable")

    async def submit_owner_command(self, case: IncidentCase, command: OwnerGateCommand) -> OwnerCommandReceipt:
        raise RuntimeError("temporal_update_unavailable")


class LocalTestAuthMiddleware(BaseHTTPMiddleware):
    """Compose-only test adapter; production must inject ASGI auth state."""
    async def dispatch(self, request: Request, call_next):
        tenant = request.headers.get("x-flowpulse-test-tenant")
        subject = request.headers.get("x-flowpulse-test-subject")
        if tenant and subject:
            supplied_roles = request.headers.get("x-flowpulse-test-roles", "local-test-owner")
            roles = [role.strip() for role in supplied_roles.split(",") if role.strip()]
            request.state.flowpulse_auth = AuthContext(
                tenant_id=tenant, subject_id=subject, roles=roles
            )
        return await call_next(request)


def trusted_auth_context(request: Request) -> AuthContext:
    context = getattr(request.state, "flowpulse_auth", None)
    if not isinstance(context, AuthContext):
        raise HTTPException(status_code=401, detail="trusted_auth_context_required")
    return context


def tenant_match(value: str, actor: AuthContext) -> None:
    if value != actor.tenant_id:
        raise HTTPException(status_code=403, detail="body_tenant_does_not_match_authenticated_tenant")


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _repository(request: Request) -> Any:
    repository = getattr(request.app.state, "repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="postgres_repository_unavailable")
    return repository


def create_app(
    repository: Optional[Any] = None,
    temporal_starter: Optional[TemporalStartPort] = None,
    allow_local_test_auth: bool = False,
    postgres_dsn: Optional[str] = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        created = PostgresCaseRepository(postgres_dsn) if postgres_dsn else None
        if created is not None:
            await created.connect()
        app.state.repository = created or repository
        try:
            yield
        finally:
            if created is not None:
                await created.close()

    app = FastAPI(title="FlowPulse Diagnosis Control Plane P0", version="0.3.0", lifespan=lifespan)
    # TestClient can be used without a context manager in existing callers;
    # retain an explicitly supplied deterministic repository immediately.
    app.state.repository = repository
    if allow_local_test_auth:
        app.add_middleware(LocalTestAuthMiddleware)
    temporal_starter = temporal_starter or TemporalUnavailableStarter()

    @app.get("/healthz")
    async def healthz(request: Request) -> dict:
        return {
            "status": "ok" if getattr(request.app.state, "repository", None) is not None else "degraded",
            "workflow_authority": "temporal",
        }

    @app.post("/v1/cases", response_model=IncidentCase, status_code=202)
    async def intake_case(
        intake: IncidentIntake, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentCase:
        tenant_match(intake.tenant_id, actor)
        _repository(request)
        trusted_intake = intake.copy(update={"tenant_id": actor.tenant_id, "actor_id": actor.subject_id})
        try:
            return await temporal_starter.start_case(trusted_intake, actor)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v1/cases/{case_id}", response_model=IncidentCase)
    async def get_case(case_id: str, request: Request, actor: AuthContext = Depends(trusted_auth_context)) -> IncidentCase:
        case = await _resolve(_repository(request).get_case(actor.tenant_id, case_id))
        if case is None:
            raise HTTPException(status_code=404, detail="case_not_found")
        return case

    @app.post("/v1/proposals", response_model=OwnerCommandReceipt, status_code=202)
    async def record_proposal(
        proposal: RemediationProposal, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> OwnerCommandReceipt:
        tenant_match(proposal.tenant_id, actor)
        repository = _repository(request)
        case = await _resolve(repository.get_case(actor.tenant_id, proposal.case_id))
        if case is None:
            raise HTTPException(status_code=404, detail="case_not_found")
        try:
            return await temporal_starter.submit_owner_command(case, OwnerGateCommand(
                case_id=case.case_id, tenant_id=case.tenant_id, actor=actor, proposal=proposal,
            ))
        except (PolicyViolation, RuntimeError) as error:
            raise HTTPException(status_code=409, detail=str(error))

    @app.post("/v1/proposals/{proposal_id}/dry-run", response_model=OwnerCommandReceipt, status_code=202)
    async def dry_run(
        proposal_id: str, body: DryRunRequest, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> OwnerCommandReceipt:
        repository = _repository(request)
        tenant_match(body.approval.tenant_id, actor)
        approval = body.approval.copy(update={"tenant_id": actor.tenant_id, "actor_id": actor.subject_id})
        try:
            require_authenticated_owner(actor.subject_id, actor.roles)
            if approval.proposal_id != proposal_id:
                raise PolicyViolation("path_proposal_id_mismatch")
            case = await _resolve(repository.get_case(actor.tenant_id, approval.case_id))
            if case is None:
                raise PolicyViolation("unknown_case")
            return await temporal_starter.submit_owner_command(case, OwnerGateCommand(
                case_id=case.case_id, tenant_id=case.tenant_id, actor=actor, proposal_id=proposal_id,
                approval=approval, current_witness=body.current_witness,
            ))
        except PolicyViolation as error:
            status = 403 if str(error) == "owner_role_required" else 409
            raise HTTPException(status_code=status, detail=str(error))
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error))

    return app


app = create_app()

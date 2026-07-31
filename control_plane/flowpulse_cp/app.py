"""Tenant-scoped FastAPI boundary with a real Postgres lifespan repository."""

import asyncio
import hmac
import inspect
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Mapping, Optional, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import StreamingResponse
from pydantic.schema import schema as pydantic_schema
from starlette.middleware.base import BaseHTTPMiddleware

from .authorization import AuthorizationPort, UnavailableAuthorizationPort
from .models import (
    AuthAssertion,
    AuthContext,
    DryRunRequest,
    EvidenceEnvelope,
    FreshnessStatus,
    IncidentCase,
    IncidentIntake,
    OwnerCommandReceipt,
    OwnerGateCommand,
    RemediationProposal,
)
from .policy import PolicyViolation, require_authenticated_owner
from .postgres import PostgresCaseRepository
from .workspace_models import (
    ComponentContext,
    IncidentDiscoveryState,
    IncidentEvent,
    IncidentNotification,
    IncidentProjection,
    IncidentSummary,
    NodeExplanationReceipt,
    NodeExplanationStart,
    WorkspaceIntake,
)
from .workspace_actions import (
    ActionInvocationCommand,
    NextBestAction,
    WorkspaceActionReceipt,
    validate_current_action_card,
)
from .realtime_models import (
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorReconcileRequest,
    IncidentClockState,
    IncidentProjectionV2,
    RealtimeIncidentEvent,
    RealtimeNotification,
    RealtimeSummary,
    RealtimeUpdateOutcome,
    MetricSeriesCollectionV3,
)
from .workspace_v3_models import (
    ActionApprovalCommandV3,
    AgentRunCommandV3,
    IncidentEventV3,
    IncidentProjectionV3,
    LiveEventV3,
    LiveIncidentSummaryV3,
    LiveSnapshotV3,
    WorkflowCommandReceiptV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowRerunCommandV3,
    WorkflowStageV3,
    WorkflowTemporalCommandV3,
    WorkflowTemporalOperationV3,
)


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


class WorkspaceStartPort(Protocol):
    async def start_workspace(self, intake: WorkspaceIntake, actor: AuthContext) -> IncidentProjection:
        ...

    async def start_or_reuse_node_explanation(
        self, projection: IncidentProjection, command: NodeExplanationStart, authorization: AuthAssertion,
    ) -> NodeExplanationReceipt:
        ...

    async def invoke_next_best_action(
        self, projection: IncidentProjection, command: ActionInvocationCommand, authorization: AuthAssertion,
    ) -> WorkspaceActionReceipt:
        ...

    async def reconcile_realtime_connector(
        self, projection: IncidentProjection, connector_id: str, idempotency_key: str,
        actor_subject_id: str, source_event_id: str, dispatch_id: str,
    ) -> RealtimeUpdateOutcome:
        ...


class WorkspaceUnavailableStarter:
    async def start_workspace(self, intake: WorkspaceIntake, actor: AuthContext) -> IncidentProjection:
        raise RuntimeError("workspace_temporal_start_unavailable")

    async def start_or_reuse_node_explanation(
        self, projection: IncidentProjection, command: NodeExplanationStart, authorization: AuthAssertion,
    ) -> NodeExplanationReceipt:
        raise RuntimeError("workspace_temporal_update_unavailable")

    async def invoke_next_best_action(
        self, projection: IncidentProjection, command: ActionInvocationCommand, authorization: AuthAssertion,
    ) -> WorkspaceActionReceipt:
        raise RuntimeError("workspace_temporal_update_unavailable")

    async def reconcile_realtime_connector(
        self, projection: IncidentProjection, connector_id: str, idempotency_key: str,
        actor_subject_id: str, source_event_id: str, dispatch_id: str,
    ) -> RealtimeUpdateOutcome:
        raise RuntimeError("workspace_temporal_update_unavailable")

    async def submit_workflow_command_v3(
        self, projection: IncidentProjection, invocation: WorkflowTemporalCommandV3,
    ) -> WorkflowCommandReceiptV3:
        raise RuntimeError("workspace_temporal_v3_update_unavailable")


class FixtureTokenAuthMiddleware(BaseHTTPMiddleware):
    """Explicit server-side fixture identity map; headers never choose identity."""

    def __init__(self, app, identities: Mapping[str, AuthContext]):
        super().__init__(app)
        self._identities = dict(identities)

    async def dispatch(self, request: Request, call_next):
        header = request.headers.get("authorization", "")
        bearer = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
        for configured_token, context in self._identities.items():
            if hmac.compare_digest(bearer, configured_token):
                request.state.flowpulse_auth = context
                break
        return await call_next(request)


trusted_bearer = HTTPBearer(
    scheme_name="FlowPulseTrustedBearer",
    bearerFormat="opaque",
    description="Trusted bearer authenticated by the configured FlowPulse identity boundary.",
    auto_error=False,
)


def trusted_auth_context(
    request: Request,
    _credentials: Optional[HTTPAuthorizationCredentials] = Security(trusted_bearer),
) -> AuthContext:
    """Use the OpenAPI security dependency only to declare the trusted boundary.

    The surrounding middleware/session implementation remains the sole source
    of subject and tenant identity; a bearer value is never parsed into roles
    at this route boundary.
    """
    context = getattr(request.state, "flowpulse_auth", None)
    if not isinstance(context, AuthContext):
        raise HTTPException(status_code=401, detail="trusted_auth_context_required")
    return context


def tenant_match(value: str, actor: AuthContext) -> None:
    if value != actor.tenant_id:
        raise HTTPException(status_code=403, detail="body_tenant_does_not_match_authenticated_tenant")


def workspace_permissions(actor: AuthContext):
    """Map only trusted identity roles to server-owned capability permissions."""
    if set(actor.roles).intersection({"viewer", "owner", "local-test-owner"}):
        return ["incident:read"]
    return []


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _repository(request: Request) -> Any:
    repository = getattr(request.app.state, "repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="postgres_repository_unavailable")
    return repository


def _workspace_repository(request: Request) -> Any:
    repository = getattr(request.app.state, "workspace_repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="workspace_projection_repository_unavailable")
    return repository


def _realtime_repository(request: Request) -> Any:
    repository = getattr(request.app.state, "realtime_repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="realtime_projection_repository_unavailable")
    return repository


async def _workspace_call(repository: Any, names, *args, **kwargs):
    for name in names:
        candidate = getattr(repository, name, None)
        if candidate is not None:
            return await _resolve(candidate(*args, **kwargs))
    raise HTTPException(status_code=503, detail="workspace_projection_repository_method_unavailable")


def _v3_stream_reset_reason(checkpoint: int, bounds) -> Optional[str]:
    """Return a reset reason when a resume cursor cannot be replayed exactly."""

    minimum, maximum = bounds
    if maximum is None:
        return "cursor_ahead" if checkpoint else None
    if checkpoint > maximum:
        return "cursor_ahead"
    if minimum is not None and checkpoint < minimum - 1:
        return "cursor_expired"
    return None


def _v3_stream_reset_frame(reason: str) -> str:
    payload = json.dumps({
        "schema_version": "flowpulse.stream-reset.v3",
        "reason": reason,
    }, sort_keys=True, separators=(",", ":"))
    return "event: stream-reset-v3\ndata: {}\n\n".format(payload)


def create_app(
    repository: Optional[Any] = None,
    temporal_starter: Optional[TemporalStartPort] = None,
    workspace_repository: Optional[Any] = None,
    workspace_starter: Optional[WorkspaceStartPort] = None,
    authorization: Optional[AuthorizationPort] = None,
    trusted_fixture_identities: Optional[Mapping[str, AuthContext]] = None,
    postgres_dsn: Optional[str] = None,
    realtime_repository: Optional[Any] = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        created = PostgresCaseRepository(postgres_dsn) if postgres_dsn else None
        if created is not None:
            await created.connect()
        app.state.repository = created or repository
        app.state.workspace_repository = created or workspace_repository
        app.state.realtime_repository = created or realtime_repository
        bind_execution_repository = getattr(
            workspace_starter, "bind_execution_repository", None,
        )
        if callable(bind_execution_repository):
            bind_execution_repository(app.state.workspace_repository)
        try:
            yield
        finally:
            if created is not None:
                await created.close()

    app = FastAPI(title="FlowPulse Diagnosis Control Plane P0", version="0.3.0", lifespan=lifespan)
    # TestClient can be used without a context manager in existing callers;
    # retain an explicitly supplied deterministic repository immediately.
    app.state.repository = repository
    app.state.workspace_repository = workspace_repository
    app.state.realtime_repository = realtime_repository
    app.state.workspace_sse_poll_seconds = 0.5
    app.state.workspace_sse_heartbeat_seconds = 15.0
    if trusted_fixture_identities:
        app.add_middleware(FixtureTokenAuthMiddleware, identities=trusted_fixture_identities)
    temporal_starter = temporal_starter or TemporalUnavailableStarter()
    workspace_starter = workspace_starter or WorkspaceUnavailableStarter()
    authorization = authorization or UnavailableAuthorizationPort()

    @app.get("/healthz")
    async def healthz(request: Request) -> dict:
        return {
            "status": "ok" if getattr(request.app.state, "repository", None) is not None else "degraded",
            "workflow_authority": "temporal",
        }

    async def _required_v3_projection(
        request: Request, actor: AuthContext, case_id: str,
    ) -> IncidentProjectionV3:
        projection = await _workspace_call(
            _workspace_repository(request), ("workspace_projection_v3",),
            actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workflow_v3_projection_not_found")
        return projection

    async def _submit_v3_command(
        request: Request,
        actor: AuthContext,
        case_id: str,
        invocation: WorkflowTemporalCommandV3,
    ) -> WorkflowCommandReceiptV3:
        projection = await _required_v3_projection(request, actor, case_id)
        if (
            invocation.tenant_id != actor.tenant_id
            or invocation.case_id != case_id
            or invocation.actor_subject_id != actor.subject_id
            or invocation.actor_roles != actor.roles
        ):
            raise HTTPException(status_code=403, detail="workflow_v3_trusted_actor_scope_mismatch")
        try:
            require_authenticated_owner(actor.subject_id, actor.roles)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))
        temporal_submit = getattr(workspace_starter, "submit_workflow_command_v3", None)
        try:
            if not callable(temporal_submit):
                raise RuntimeError("workspace_temporal_v3_update_unavailable")
            legacy_projection = await _workspace_call(
                _workspace_repository(request),
                ("workspace_projection", "get_projection"),
                actor.tenant_id, case_id,
            )
            if legacy_projection is None:
                raise HTTPException(status_code=409, detail="workflow_v3_temporal_binding_not_found")
            result = await _resolve(temporal_submit(legacy_projection, invocation))
            return WorkflowCommandReceiptV3.parse_obj(result)
        except PolicyViolation as error:
            reason = str(error)
            status = 403 if reason in {
                "owner_role_required", "workflow_v3_trusted_actor_scope_mismatch",
            } else 404 if reason in {
                "workflow_v3_projection_not_found", "workflow_v3_action_not_found",
            } else 409
            raise HTTPException(status_code=status, detail=reason)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v3/live/snapshot", response_model=LiveSnapshotV3)
    async def live_snapshot_v3(
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> LiveSnapshotV3:
        return await _workspace_call(
            _workspace_repository(request), ("workspace_live_snapshot_v3",),
            actor.tenant_id, 100,
        )

    @app.get(
        "/v3/live/events",
        response_class=StreamingResponse,
        responses={200: {"content": {"text/event-stream": {
            "schema": {"$ref": "#/components/schemas/LiveEventV3"},
        }}}},
    )
    async def live_events_v3(
        request: Request,
        after: int = Query(0, ge=0),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        checkpoint = after
        if last_event_id is not None:
            try:
                header_checkpoint = int(last_event_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="workflow_v3_live_checkpoint_invalid")
            # EventSource reconnects the original URL and advances the cursor
            # through Last-Event-ID.  The header is therefore authoritative
            # even when the URL still contains the initial ``after`` value.
            if header_checkpoint < 0:
                raise HTTPException(status_code=400, detail="workflow_v3_live_checkpoint_invalid")
            checkpoint = header_checkpoint
        repository = _workspace_repository(request)
        bounds = await _workspace_call(
            repository, ("workspace_live_event_bounds_v3",), actor.tenant_id,
        )
        initial_reset = _v3_stream_reset_reason(checkpoint, bounds)
        pending = [] if initial_reset else await _workspace_call(
            repository, ("workspace_live_events_v3_after",), actor.tenant_id,
            checkpoint,
        )

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            records = pending
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            if initial_reset:
                yield _v3_stream_reset_frame(initial_reset)
                return
            while True:
                if await request.is_disconnected():
                    return
                if records:
                    for item in records:
                        cursor = item.sequence
                        yield "id: {}\nevent: live-event-v3\ndata: {}\n\n".format(
                            item.sequence, item.json(),
                        )
                        last_emit = loop.time()
                    records = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                records = await _workspace_call(
                    repository, ("workspace_live_events_v3_after",),
                    actor.tenant_id, cursor,
                )
                if not records:
                    bounds = await _workspace_call(
                        repository, ("workspace_live_event_bounds_v3",),
                        actor.tenant_id,
                    )
                    reset = _v3_stream_reset_reason(cursor, bounds)
                    if reset:
                        yield _v3_stream_reset_frame(reset)
                        return
                if not records and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds:
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get(
        "/v3/incidents/{case_id}/projection",
        response_model=IncidentProjectionV3,
    )
    async def get_incident_projection_v3(
        case_id: str,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentProjectionV3:
        return await _required_v3_projection(request, actor, case_id)

    @app.get(
        "/v3/incidents/{case_id}/series",
        response_model=MetricSeriesCollectionV3,
    )
    async def get_incident_series_v3(
        case_id: str,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> MetricSeriesCollectionV3:
        await _required_v3_projection(request, actor, case_id)
        repository = getattr(request.app.state, "realtime_repository", None) or _workspace_repository(request)
        return await _workspace_call(
            repository, ("realtime_series",), actor.tenant_id, case_id,
        )

    @app.get(
        "/v3/incidents/{case_id}/events",
        response_class=StreamingResponse,
        responses={200: {"content": {"text/event-stream": {
            "schema": {"$ref": "#/components/schemas/IncidentEventV3"},
        }}}},
    )
    async def incident_events_v3(
        case_id: str,
        request: Request,
        after: int = Query(0, ge=0),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        await _required_v3_projection(request, actor, case_id)
        checkpoint = after
        if last_event_id is not None:
            try:
                header_checkpoint = int(last_event_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="workflow_v3_event_checkpoint_invalid")
            if header_checkpoint < 0:
                raise HTTPException(status_code=400, detail="workflow_v3_event_checkpoint_invalid")
            checkpoint = header_checkpoint
        repository = _workspace_repository(request)
        bounds = await _workspace_call(
            repository, ("workspace_event_bounds_v3",),
            actor.tenant_id, case_id,
        )
        initial_reset = _v3_stream_reset_reason(checkpoint, bounds)
        pending = [] if initial_reset else await _workspace_call(
            repository, ("workspace_events_v3_after",),
            actor.tenant_id, case_id, checkpoint,
        )

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            records = pending
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            if initial_reset:
                yield _v3_stream_reset_frame(initial_reset)
                return
            while True:
                if await request.is_disconnected():
                    return
                if records:
                    for item in records:
                        cursor = item.sequence
                        yield "id: {}\nevent: incident-event-v3\ndata: {}\n\n".format(
                            item.sequence, item.json(),
                        )
                        last_emit = loop.time()
                    records = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                records = await _workspace_call(
                    repository, ("workspace_events_v3_after",),
                    actor.tenant_id, case_id, cursor,
                )
                if not records:
                    bounds = await _workspace_call(
                        repository, ("workspace_event_bounds_v3",),
                        actor.tenant_id, case_id,
                    )
                    reset = _v3_stream_reset_reason(cursor, bounds)
                    if reset:
                        yield _v3_stream_reset_frame(reset)
                        return
                if not records and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds:
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post(
        "/v3/incidents/{case_id}/workflow/advance",
        response_model=WorkflowCommandReceiptV3,
        status_code=202,
    )
    async def advance_workflow_v3(
        case_id: str,
        command: WorkflowCommandV3,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkflowCommandReceiptV3:
        return await _submit_v3_command(request, actor, case_id, WorkflowTemporalCommandV3(
            operation=WorkflowTemporalOperationV3.ADVANCE,
            tenant_id=actor.tenant_id, case_id=case_id,
            actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            command=command.dict(),
        ))

    @app.post(
        "/v3/incidents/{case_id}/workflow/stages/{stage}/rerun",
        response_model=WorkflowCommandReceiptV3,
        status_code=202,
    )
    async def rerun_workflow_stage_v3(
        case_id: str,
        stage: WorkflowStageV3,
        command: WorkflowRerunCommandV3,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkflowCommandReceiptV3:
        return await _submit_v3_command(request, actor, case_id, WorkflowTemporalCommandV3(
            operation=WorkflowTemporalOperationV3.RERUN,
            tenant_id=actor.tenant_id, case_id=case_id,
            actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            command=command.dict(), target_stage=stage,
        ))

    @app.post(
        "/v3/incidents/{case_id}/workflow/escalations",
        response_model=WorkflowCommandReceiptV3,
        status_code=202,
    )
    async def escalate_workflow_v3(
        case_id: str,
        command: WorkflowEscalationCommandV3,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkflowCommandReceiptV3:
        return await _submit_v3_command(request, actor, case_id, WorkflowTemporalCommandV3(
            operation=WorkflowTemporalOperationV3.ESCALATE,
            tenant_id=actor.tenant_id, case_id=case_id,
            actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            command=command.dict(),
        ))

    @app.post(
        "/v3/incidents/{case_id}/agent-runs",
        response_model=WorkflowCommandReceiptV3,
        status_code=202,
    )
    async def start_agent_run_v3(
        case_id: str,
        command: AgentRunCommandV3,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkflowCommandReceiptV3:
        return await _submit_v3_command(request, actor, case_id, WorkflowTemporalCommandV3(
            operation=WorkflowTemporalOperationV3.AGENT_RUN,
            tenant_id=actor.tenant_id, case_id=case_id,
            actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            command=command.dict(),
        ))

    @app.post(
        "/v3/incidents/{case_id}/actions/{action_id}/approval",
        response_model=WorkflowCommandReceiptV3,
        status_code=202,
    )
    async def approve_action_v3(
        case_id: str,
        action_id: str,
        command: ActionApprovalCommandV3,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkflowCommandReceiptV3:
        return await _submit_v3_command(request, actor, case_id, WorkflowTemporalCommandV3(
            operation=WorkflowTemporalOperationV3.ACTION_APPROVAL,
            tenant_id=actor.tenant_id, case_id=case_id,
            actor_subject_id=actor.subject_id, actor_roles=actor.roles,
            command=command.dict(), action_id=action_id,
        ))

    @app.get("/v2/incidents", response_model=list[RealtimeSummary])
    async def list_realtime_incidents(
        request: Request,
        state: IncidentDiscoveryState = Query(IncidentDiscoveryState.ACTIVE),
        limit: int = Query(20, ge=1, le=50),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> list[RealtimeSummary]:
        if state != IncidentDiscoveryState.ACTIVE:
            raise HTTPException(status_code=422, detail="realtime_incident_state_not_supported")
        workspace_summaries = await _workspace_call(
            _workspace_repository(request),
            ("workspace_active_incidents", "active_incidents"),
            actor.tenant_id, limit,
        )
        projections = []
        for summary in workspace_summaries:
            workspace_projection = await _workspace_call(
                _workspace_repository(request),
                ("workspace_projection", "get_projection"),
                actor.tenant_id, summary.case_id,
            )
            if workspace_projection is not None:
                projections.append(await _workspace_call(
                    _realtime_repository(request),
                    ("materialize_realtime_baseline",),
                    workspace_projection,
                    now=datetime.now(timezone.utc),
                ))
        return [
            RealtimeSummary.from_projection(item)
            for item in sorted(
                projections, key=lambda value: value.sequence, reverse=True,
            )[:limit]
        ]

    @app.get("/v2/incidents/{case_id}/projection", response_model=IncidentProjectionV2)
    async def get_realtime_projection(
        case_id: str,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentProjectionV2:
        projection = await _workspace_call(
            _realtime_repository(request), ("realtime_projection",),
            actor.tenant_id, case_id,
        )
        if projection is None:
            workspace_projection = await _workspace_call(
                _workspace_repository(request),
                ("workspace_projection", "get_projection"),
                actor.tenant_id, case_id,
            )
            if workspace_projection is not None:
                projection = await _workspace_call(
                    _realtime_repository(request),
                    ("materialize_realtime_baseline",),
                    workspace_projection,
                    now=datetime.now(timezone.utc),
                )
        if projection is None:
            raise HTTPException(status_code=404, detail="realtime_projection_not_found")
        return _refresh_realtime_clock(projection, datetime.now(timezone.utc))

    @app.get("/v2/connectors", response_model=list[ConnectorHealth])
    async def list_realtime_connectors(
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> list[ConnectorHealth]:
        return await _workspace_call(
            _realtime_repository(request), ("realtime_connector_health", "connector_health"),
            actor.tenant_id,
        )

    @app.post(
        "/v2/connectors/{connector_id}/reconcile",
        response_model=RealtimeUpdateOutcome,
        status_code=202,
    )
    async def reconcile_realtime_connector(
        connector_id: str,
        body: ConnectorReconcileRequest,
        case_id: str,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> RealtimeUpdateOutcome:
        try:
            require_authenticated_owner(actor.subject_id, actor.roles)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))
        projection = await _workspace_call(
            _workspace_repository(request),
            ("workspace_projection", "get_projection"),
            actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        pending = [
            item for item in await _workspace_call(
                _realtime_repository(request), ("pending_dispatches",),
                actor.tenant_id, 100,
            )
            if item.case_id == case_id and item.connector_id == connector_id
        ]
        if len(pending) != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "realtime_dispatch_pending_not_found"
                    if not pending
                    else "realtime_dispatch_pending_ambiguous"
                ),
            )
        try:
            outcome = await workspace_starter.reconcile_realtime_connector(
                projection, connector_id, body.idempotency_key, actor.subject_id,
                pending[0].source_event_id, pending[0].dispatch_id,
            )
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))
        if not outcome.accepted:
            raise HTTPException(status_code=409, detail=outcome.reason or "realtime_reconcile_rejected")
        return outcome

    @app.get(
        "/v2/incidents/events",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Ordered tenant V2 incident notifications.",
                "content": {"text/event-stream": {
                    "schema": {"$ref": "#/components/schemas/RealtimeNotification"},
                }},
            },
        },
    )
    async def realtime_incident_notifications(
        request: Request,
        after: Optional[str] = Query(None),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        if last_event_id is not None and after is not None and last_event_id != after:
            raise HTTPException(status_code=400, detail="realtime_notification_checkpoint_invalid")
        checkpoint = last_event_id or after
        try:
            notifications = await _workspace_call(
                _realtime_repository(request), ("realtime_notifications_after",),
                actor.tenant_id, checkpoint,
            )
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error))

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            pending = notifications
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            while True:
                if await request.is_disconnected():
                    return
                if pending:
                    for item in pending:
                        if await request.is_disconnected():
                            return
                        cursor = item.notification_id
                        yield "id: {}\nevent: incident-realtime-notification\ndata: {}\n\n".format(
                            cursor, item.json(),
                        )
                        last_emit = loop.time()
                    pending = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                pending = await _workspace_call(
                    _realtime_repository(request), ("realtime_notifications_after",),
                    actor.tenant_id, cursor,
                )
                if not pending and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds:
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()
        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get(
        "/v2/incidents/{case_id}/events",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Ordered V2 case events.",
                "content": {"text/event-stream": {
                    "schema": {"$ref": "#/components/schemas/RealtimeIncidentEvent"},
                }},
            },
        },
    )
    async def realtime_case_events(
        case_id: str,
        request: Request,
        after: int = Query(0, ge=0),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        checkpoint = after
        if last_event_id is not None:
            try:
                header_checkpoint = int(last_event_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="realtime_event_checkpoint_invalid")
            if header_checkpoint < 0:
                raise HTTPException(status_code=400, detail="realtime_event_checkpoint_invalid")
            checkpoint = header_checkpoint
        events = await _workspace_call(
            _realtime_repository(request), ("realtime_events_after",),
            actor.tenant_id, case_id, checkpoint,
        )

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            pending = events
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            while True:
                if await request.is_disconnected():
                    return
                if pending:
                    for item in pending:
                        if await request.is_disconnected():
                            return
                        cursor = item.sequence
                        yield "id: {}\nevent: incident-realtime-event\ndata: {}\n\n".format(
                            cursor, item.json(),
                        )
                        last_emit = loop.time()
                    pending = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                pending = await _workspace_call(
                    _realtime_repository(request), ("realtime_events_after",),
                    actor.tenant_id, case_id, cursor,
                )
                if not pending and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds:
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()
        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get(
        "/v2/incidents/{case_id}/evidence/{evidence_id}",
        response_model=EvidenceEnvelope,
    )
    async def get_realtime_evidence(
        case_id: str,
        evidence_id: str,
        request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> EvidenceEnvelope:
        evidence = await _workspace_call(
            _realtime_repository(request), ("realtime_evidence",),
            actor.tenant_id, case_id, evidence_id, actor.subject_id,
        )
        if evidence is None:
            raise HTTPException(status_code=404, detail="realtime_evidence_not_found")
        return evidence

    @app.post("/v1/incidents", response_model=IncidentProjection, status_code=202)
    async def intake_workspace_incident(
        intake: WorkspaceIntake, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentProjection:
        _workspace_repository(request)
        try:
            return await workspace_starter.start_workspace(intake, actor)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v1/incidents", response_model=list[IncidentSummary])
    async def list_active_workspace_incidents(
        request: Request, state: IncidentDiscoveryState = Query(IncidentDiscoveryState.ACTIVE),
        limit: int = Query(20, ge=1, le=50), actor: AuthContext = Depends(trusted_auth_context),
    ) -> list[IncidentSummary]:
        """Tenant-scoped toast hydration; discovery never starts or advances a workflow."""
        if state != IncidentDiscoveryState.ACTIVE:
            raise HTTPException(status_code=422, detail="workspace_incident_state_not_supported")
        try:
            return await _workspace_call(
                _workspace_repository(request), ("workspace_active_incidents", "active_incidents"),
                actor.tenant_id, limit,
            )
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))

    @app.get(
        "/v1/incidents/events",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Ordered tenant incident notifications for toast hydration.",
                "content": {"text/event-stream": {"schema": {"$ref": "#/components/schemas/IncidentNotification"}}},
            },
        },
    )
    async def workspace_incident_notifications(
        request: Request, after: Optional[str] = Query(None),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        """Read the global notification projection without creating a case or conversation."""
        if last_event_id is not None and after is not None and after != last_event_id:
            raise HTTPException(status_code=400, detail="workspace_incident_notification_checkpoint_invalid")
        checkpoint = last_event_id if last_event_id is not None else after
        try:
            notifications = await _workspace_call(
                _workspace_repository(request), ("incident_notifications_after",), actor.tenant_id, checkpoint,
            )
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            pending = notifications
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            while True:
                if await request.is_disconnected():
                    return
                if pending:
                    for notification in pending:
                        if await request.is_disconnected():
                            return
                        cursor = notification.notification_id
                        yield "id: {}\nevent: incident-notification\ndata: {}\n\n".format(
                            notification.notification_id, notification.json(),
                        )
                        last_emit = loop.time()
                    pending = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                pending = await _workspace_call(
                    _workspace_repository(request), ("incident_notifications_after",),
                    actor.tenant_id, cursor,
                )
                if (
                    not pending
                    and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds
                ):
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()
        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/v1/incidents/{case_id}/projection", response_model=IncidentProjection)
    async def get_workspace_projection(
        case_id: str, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> IncidentProjection:
        projection = await _workspace_call(
            _workspace_repository(request),
            ("workspace_public_projection", "workspace_projection", "get_projection"),
            actor.tenant_id,
            case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        return projection

    @app.get(
        "/v1/incidents/{case_id}/components/{component_id}/context",
        response_model=ComponentContext,
    )
    async def workspace_component_context(
        case_id: str, component_id: str, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> ComponentContext:
        projection = await _workspace_call(
            _workspace_repository(request), ("workspace_projection", "get_projection"), actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        node = next((item for item in projection.graph.nodes if item.component_id == component_id), None)
        if node is None:
            raise HTTPException(status_code=404, detail="workspace_component_not_canonical")
        return ComponentContext(
            **{name: getattr(projection, name) for name in ComponentContext.__fields__ if name in {
                "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
                "workflow_id", "workflow_run_id", "created_at",
            }},
            projection_revision=projection.projection_revision,
            component=node,
            evidence_refs=projection.evidence_refs,
            fresh_read_performed=False,
        )

    @app.post("/v1/incidents/{case_id}/node-explanations", response_model=NodeExplanationReceipt, status_code=202)
    async def start_node_explanation(
        case_id: str, command: NodeExplanationStart, request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> NodeExplanationReceipt:
        projection = await _workspace_call(
            _workspace_repository(request), ("workspace_projection", "get_projection"), actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        if (
            command.incident_id != projection.incident_id or command.run_id != projection.run_id
            or command.topology_revision != projection.topology_revision
            or command.projection_revision != projection.projection_revision
        ):
            raise HTTPException(status_code=409, detail="workspace_node_explanation_identity_or_revision_mismatch")
        if command.component_id not in {node.component_id for node in projection.graph.nodes}:
            raise HTTPException(status_code=409, detail="workspace_node_explanation_component_not_canonical")
        try:
            intent = await _workspace_call(
                _workspace_repository(request), ("create_workspace_node_explanation_intent",),
                actor, projection, command,
            )
            assertion = await _resolve(authorization.issue_workspace_node_explanation_intent(intent))
            return await workspace_starter.start_or_reuse_node_explanation(projection, command, assertion)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get("/v1/incidents/{case_id}/node-explanations/{explanation_id}", response_model=NodeExplanationReceipt)
    async def get_node_explanation(
        case_id: str, explanation_id: str, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> NodeExplanationReceipt:
        explanation = await _workspace_call(
            _workspace_repository(request), ("workspace_explanation", "get_explanation"),
            actor.tenant_id, case_id, explanation_id,
        )
        if explanation is None:
            raise HTTPException(status_code=404, detail="workspace_node_explanation_not_found")
        return NodeExplanationReceipt(explanation=explanation, reused=True)

    @app.get("/v1/incidents/{case_id}/actions", response_model=list[NextBestAction])
    async def list_workspace_actions(
        case_id: str, request: Request, actor: AuthContext = Depends(trusted_auth_context),
    ) -> list[NextBestAction]:
        """Read only server-generated recommendation cards for one projection."""
        projection = await _workspace_call(
            _workspace_repository(request), ("workspace_projection", "get_projection"), actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        cards = await _workspace_call(
            _workspace_repository(request), ("workspace_next_best_actions", "get_next_best_actions"),
            actor.tenant_id, case_id,
        )
        # A generated card is only visible while it still binds the current
        # projection and authenticated capability permission.  Older cards
        # remain append-only audit records but never become active UI choices.
        now = datetime.now(timezone.utc)
        return [
            card for card in cards
            if _card_visible(card, projection, workspace_permissions(actor), now)
        ]

    @app.post(
        "/v1/incidents/{case_id}/actions/{action_id}", response_model=WorkspaceActionReceipt, status_code=202,
    )
    async def invoke_workspace_action(
        case_id: str, action_id: str, command: ActionInvocationCommand, request: Request,
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> WorkspaceActionReceipt:
        """Submit one revalidated server card command; never write approval/action state here."""
        if command.action_id != action_id:
            raise HTTPException(status_code=409, detail="workspace_action_path_identity_mismatch")
        projection = await _workspace_call(
            _workspace_repository(request), ("workspace_projection", "get_projection"), actor.tenant_id, case_id,
        )
        if projection is None:
            raise HTTPException(status_code=404, detail="workspace_projection_not_found")
        card = await _workspace_call(
            _workspace_repository(request), ("workspace_next_best_action", "get_next_best_action"),
            actor.tenant_id, case_id, action_id,
        )
        if card is None:
            raise HTTPException(status_code=404, detail="workspace_action_not_found")
        try:
            validate_current_action_card(card, projection, command, workspace_permissions(actor), datetime.now(timezone.utc))
            intent = await _workspace_call(
                _workspace_repository(request), ("create_workspace_action_intent",), actor, projection, command,
            )
            assertion = await _resolve(authorization.issue_workspace_action_intent(intent))
            return await workspace_starter.invoke_next_best_action(projection, command, assertion)
        except PolicyViolation as error:
            raise HTTPException(status_code=409, detail=str(error))
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error))

    @app.get(
        "/v1/incidents/{case_id}/events",
        response_class=StreamingResponse,
        responses={
            200: {
                "description": "Ordered IncidentEvent records in Server-Sent Events framing.",
                "content": {
                    "text/event-stream": {
                        "schema": {"$ref": "#/components/schemas/IncidentEvent"},
                    },
                },
            },
        },
    )
    async def workspace_events(
        case_id: str, request: Request, after: int = Query(0, ge=0),
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
        actor: AuthContext = Depends(trusted_auth_context),
    ) -> StreamingResponse:
        checkpoint = after
        if last_event_id is not None:
            try:
                header_checkpoint = int(last_event_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="workspace_event_checkpoint_invalid")
            if header_checkpoint < 0:
                raise HTTPException(status_code=400, detail="workspace_event_checkpoint_invalid")
            checkpoint = header_checkpoint
        events = await _workspace_call(
            _workspace_repository(request), ("workspace_events_after", "events_after"),
            actor.tenant_id, case_id, checkpoint,
        )

        async def stream() -> AsyncIterator[str]:
            cursor = checkpoint
            pending = events
            loop = asyncio.get_running_loop()
            last_emit = loop.time()
            while True:
                if await request.is_disconnected():
                    return
                if pending:
                    for event in pending:
                        if await request.is_disconnected():
                            return
                        cursor = event.sequence
                        yield "id: {}\nevent: incident-event\ndata: {}\n\n".format(
                            event.sequence, event.json(),
                        )
                        last_emit = loop.time()
                    pending = []
                    continue
                await asyncio.sleep(request.app.state.workspace_sse_poll_seconds)
                if await request.is_disconnected():
                    return
                pending = await _workspace_call(
                    _workspace_repository(request), ("workspace_events_after", "events_after"),
                    actor.tenant_id, case_id, cursor,
                )
                if (
                    not pending
                    and loop.time() - last_emit >= request.app.state.workspace_sse_heartbeat_seconds
                ):
                    yield ": heartbeat\n\n"
                    last_emit = loop.time()

        return StreamingResponse(stream(), media_type="text/event-stream")

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
            intent = await _resolve(repository.create_auth_command_intent(actor, case, proposal.proposal_id))
            return await temporal_starter.submit_owner_command(case, OwnerGateCommand(
                case_id=case.case_id, tenant_id=case.tenant_id,
                auth_assertion=await _resolve(authorization.issue_intent(intent)), proposal=proposal,
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
            intent = await _resolve(
                repository.create_auth_command_intent(actor, case, proposal_id, approval.approval_id)
            )
            return await temporal_starter.submit_owner_command(case, OwnerGateCommand(
                case_id=case.case_id, tenant_id=case.tenant_id,
                auth_assertion=await _resolve(authorization.issue_intent(intent)), proposal_id=proposal_id,
                approval=approval, current_witness=body.current_witness,
            ))
        except PolicyViolation as error:
            status = 403 if str(error) == "owner_role_required" else 409
            raise HTTPException(status_code=status, detail=str(error))
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error))

    # FastAPI cannot infer a Pydantic payload schema from a streaming response.
    # Register the exact strict model that each SSE ``data:`` line carries and
    # preserve the route's explicit text/event-stream media type.
    original_openapi = app.openapi

    def workspace_openapi():
        document = original_openapi()
        schemas = document.setdefault("components", {}).setdefault("schemas", {})
        stream_schemas = pydantic_schema(
            [
                IncidentEvent,
                IncidentNotification,
                RealtimeIncidentEvent,
                RealtimeNotification,
                IncidentEventV3,
                LiveEventV3,
            ],
            ref_prefix="#/components/schemas/",
        )["definitions"]
        schemas.update(stream_schemas)
        event_response = document["paths"]["/v1/incidents/{case_id}/events"]["get"]["responses"]["200"]
        event_response["content"] = {
            "text/event-stream": {"schema": {"$ref": "#/components/schemas/IncidentEvent"}},
        }
        notification_response = document["paths"]["/v1/incidents/events"]["get"]["responses"]["200"]
        notification_response["content"] = {
            "text/event-stream": {"schema": {"$ref": "#/components/schemas/IncidentNotification"}},
        }
        realtime_event_response = document["paths"]["/v2/incidents/{case_id}/events"]["get"]["responses"]["200"]
        realtime_event_response["content"] = {
            "text/event-stream": {"schema": {"$ref": "#/components/schemas/RealtimeIncidentEvent"}},
        }
        realtime_notification_response = document["paths"]["/v2/incidents/events"]["get"]["responses"]["200"]
        realtime_notification_response["content"] = {
            "text/event-stream": {"schema": {"$ref": "#/components/schemas/RealtimeNotification"}},
        }
        return document

    app.openapi = workspace_openapi
    return app


def _card_visible(card: NextBestAction, projection: IncidentProjection, permissions, now) -> bool:
    try:
        command = ActionInvocationCommand(
            incident_id=card.incident_id, run_id=card.run_id,
            topology_revision=card.topology_revision, projection_revision=card.projection_revision,
            action_id=card.action_id, idempotency_key="read-only-card-visibility",
        )
        validate_current_action_card(card, projection, command, permissions, now)
        return True
    except PolicyViolation:
        return False


def _refresh_realtime_clock(
    projection: IncidentProjectionV2, now: datetime,
) -> IncidentProjectionV2:
    """Refresh a display anchor without creating lifecycle or projection truth."""
    clock = projection.incident_clock
    if clock.state != IncidentClockState.RUNNING:
        return projection
    bounded_now = min(now, clock.fresh_until)
    delta = max(0, int((bounded_now - clock.as_of).total_seconds()))
    freshness = (
        FreshnessStatus.CURRENT
        if now <= clock.fresh_until else FreshnessStatus.STALE
    )
    return projection.copy(update={
        "incident_clock": clock.copy(update={
            "as_of": bounded_now,
            "elapsed_seconds": clock.elapsed_seconds + delta,
            "freshness": freshness,
        }),
        "connector_health": [
            item.copy(update={
                "state": ConnectorHealthState.STALE,
                "reason_code": "freshness_sla_exceeded",
            })
            if (
                item.state == ConnectorHealthState.CONNECTED
                and item.fresh_until is not None
                and now > item.fresh_until
            )
            else item
            for item in projection.connector_health
        ],
        "realtime_signals": [
            item.copy(update={"freshness": FreshnessStatus.STALE})
            if now > item.fresh_until else item
            for item in projection.realtime_signals
        ],
    })


app = create_app()

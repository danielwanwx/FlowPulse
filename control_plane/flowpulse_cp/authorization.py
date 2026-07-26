"""Signed assertions and the isolated authorization-service boundary."""

import hmac
import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Dict, Optional, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4

import asyncpg
from fastapi import FastAPI, HTTPException, Request

from .models import (
    AuthAssertion,
    AuthCommandIntent,
    AuthCommandKind,
    AuthContext,
    IncidentCase,
    NonEmpty,
    StrictModel,
)
from .policy import PolicyViolation, canonical_json
from .postgres import PostgresCaseRepository
from .workspace_models import IncidentRunBinding, NodeExplanationStart
from .workspace_actions import ActionInvocationCommand


DEFAULT_AUDIENCE = "flowpulse.temporal-owner-gate.v1"
WORKSPACE_NODE_EXPLANATION_AUDIENCE = "flowpulse.temporal-workspace-node-explanation.v1"
WORKSPACE_ACTION_AUDIENCE = "flowpulse.temporal-workspace-action.v1"


class AuthorizationPort(Protocol):
    def issue_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        """Mint an assertion from an already server-created command intent."""

    def resolve(
        self, assertion: AuthAssertion, case: IncidentCase, proposal_id: str = None,
        approval_id: str = None, now: datetime = None,
    ) -> AuthContext:
        """Verify and consume a one-time assertion before workflow mutation."""

    def issue_workspace_node_explanation_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        """Mint a short-lived command assertion from a server-created workspace intent."""

    def resolve_workspace_node_explanation(
        self, assertion: AuthAssertion, binding: IncidentRunBinding, command: NodeExplanationStart,
    ) -> AuthContext:
        """Verify/consume the exact public binding and command before provider work."""

    def issue_workspace_action_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        """Mint a one-time generic action command from a server-created intent."""

    def resolve_workspace_action(
        self, assertion: AuthAssertion, binding: IncidentRunBinding, command: ActionInvocationCommand,
    ) -> AuthContext:
        """Verify/consume an exact action identity without browser-selected scope."""


class HmacAuthorizationAuthority:
    """Key-id aware HMAC issuer/verifier used only by the auth service/tests."""

    def __init__(
        self, keyring, issuer: str = "flowpulse.authz.test", audience: str = DEFAULT_AUDIENCE,
        active_key_id: str = "test-k1", ttl_seconds: int = 300,
        workspace_node_explanation_audience: str = WORKSPACE_NODE_EXPLANATION_AUDIENCE,
        workspace_action_audience: str = WORKSPACE_ACTION_AUDIENCE,
    ) -> None:
        if isinstance(keyring, str):
            keyring = {active_key_id: keyring}
        if not keyring or not issuer or not audience or not workspace_node_explanation_audience or not workspace_action_audience or active_key_id not in keyring:
            raise ValueError("auth_assertion_keyring_issuer_audience_required")
        self._keys = {key_id: secret.encode("utf-8") for key_id, secret in keyring.items() if secret}
        if active_key_id not in self._keys:
            raise ValueError("auth_assertion_active_key_missing")
        self.issuer = issuer
        self.audience = audience
        self.workspace_node_explanation_audience = workspace_node_explanation_audience
        self.workspace_action_audience = workspace_action_audience
        self.active_key_id = active_key_id
        self._ttl_seconds = ttl_seconds
        self._consumed = set()

    @staticmethod
    def _material(assertion: AuthAssertion) -> str:
        material = {
            "assertion_id": assertion.assertion_id,
            "issuer": assertion.issuer,
            "audience": assertion.audience,
            "key_id": assertion.key_id,
            "jti": assertion.jti,
            "nonce": assertion.nonce,
            "tenant_id": assertion.tenant_id,
            "case_id": assertion.case_id,
            "case_revision": assertion.case_revision,
            "workflow_run_id": assertion.workflow_run_id,
            "proposal_id": assertion.proposal_id,
            "approval_id": assertion.approval_id,
            "subject_id": assertion.subject_id,
            "roles": assertion.roles,
            "issued_at": assertion.issued_at.astimezone(timezone.utc).isoformat(),
            "expires_at": assertion.expires_at.astimezone(timezone.utc).isoformat(),
        }
        # Keep the owner-gate assertion material exactly compatible with its
        # frozen v1 history/issuer. Workspace scope is cryptographically bound
        # only for the new, separate audience.
        if assertion.command_kind == AuthCommandKind.WORKSPACE_NODE_EXPLANATION:
            material["workspace_node_explanation"] = {
                "incident_id": assertion.workspace_incident_id,
                "run_id": assertion.workspace_run_id,
                "topology_revision": assertion.workspace_topology_revision,
                "projection_revision": assertion.workspace_projection_revision,
                "component_id": assertion.workspace_component_id,
                "command_hash": assertion.workspace_command_hash,
            }
        elif assertion.command_kind == AuthCommandKind.WORKSPACE_ACTION:
            material["workspace_action"] = {
                "incident_id": assertion.workspace_incident_id,
                "run_id": assertion.workspace_run_id,
                "topology_revision": assertion.workspace_topology_revision,
                "projection_revision": assertion.workspace_projection_revision,
                "action_id": assertion.workspace_action_id,
                "command_hash": assertion.workspace_action_command_hash,
            }
        return canonical_json(material)

    def _signature(self, assertion: AuthAssertion) -> str:
        key = self._keys.get(assertion.key_id)
        if key is None:
            raise PolicyViolation("auth_assertion_key_unknown")
        return hmac.new(key, self._material(assertion).encode("utf-8"), sha256).hexdigest()

    def issue(
        self, actor: AuthContext, case: IncidentCase, proposal_id: str = None,
        approval_id: str = None, now: datetime = None,
    ) -> AuthAssertion:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        jti = "authz-{}".format(uuid4().hex)
        unsigned = AuthAssertion(
            assertion_id=jti, issuer=self.issuer, audience=self.audience, key_id=self.active_key_id,
            jti=jti, nonce="nonce-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=case.case_id, case_revision=case.case_revision, workflow_run_id=case.workflow_run_id,
            proposal_id=proposal_id, approval_id=approval_id, subject_id=actor.subject_id, roles=actor.roles,
            issued_at=now, expires_at=now + timedelta(seconds=self._ttl_seconds), signature="0" * 64,
            command_kind=AuthCommandKind.OWNER_GATE,
        )
        return unsigned.copy(update={"signature": self._signature(unsigned)})

    def issue_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        if intent.command_kind != AuthCommandKind.OWNER_GATE:
            raise PolicyViolation("authorization_intent_command_kind_mismatch")
        return self.issue(intent.actor(), intent.case(), intent.proposal_id, intent.approval_id)

    def issue_workspace_node_explanation_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        if intent.command_kind != AuthCommandKind.WORKSPACE_NODE_EXPLANATION:
            raise PolicyViolation("authorization_intent_command_kind_mismatch")
        now = datetime.now(timezone.utc)
        if intent.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("authorization_intent_expired")
        jti = "workspace-authz-{}".format(uuid4().hex)
        unsigned = AuthAssertion(
            assertion_id=jti, issuer=self.issuer, audience=self.workspace_node_explanation_audience,
            key_id=self.active_key_id, jti=jti, nonce="nonce-{}".format(uuid4().hex),
            tenant_id=intent.tenant_id, case_id=intent.case_id, case_revision=intent.case_revision,
            workflow_run_id=intent.workflow_run_id, subject_id=intent.subject_id, roles=intent.roles,
            issued_at=now, expires_at=min(intent.expires_at, now + timedelta(seconds=self._ttl_seconds)),
            signature="0" * 64, command_kind=AuthCommandKind.WORKSPACE_NODE_EXPLANATION,
            workspace_incident_id=intent.workspace_incident_id, workspace_run_id=intent.workspace_run_id,
            workspace_topology_revision=intent.workspace_topology_revision,
            workspace_projection_revision=intent.workspace_projection_revision,
            workspace_component_id=intent.workspace_component_id,
            workspace_command_hash=intent.workspace_command_hash,
        )
        return unsigned.copy(update={"signature": self._signature(unsigned)})

    def issue_workspace_action_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        if intent.command_kind != AuthCommandKind.WORKSPACE_ACTION:
            raise PolicyViolation("authorization_intent_command_kind_mismatch")
        now = datetime.now(timezone.utc)
        if intent.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("authorization_intent_expired")
        jti = "workspace-action-authz-{}".format(uuid4().hex)
        unsigned = AuthAssertion(
            assertion_id=jti, issuer=self.issuer, audience=self.workspace_action_audience,
            key_id=self.active_key_id, jti=jti, nonce="nonce-{}".format(uuid4().hex),
            tenant_id=intent.tenant_id, case_id=intent.case_id, case_revision=intent.case_revision,
            workflow_run_id=intent.workflow_run_id, subject_id=intent.subject_id, roles=intent.roles,
            issued_at=now, expires_at=min(intent.expires_at, now + timedelta(seconds=self._ttl_seconds)),
            signature="0" * 64, command_kind=AuthCommandKind.WORKSPACE_ACTION,
            workspace_incident_id=intent.workspace_incident_id, workspace_run_id=intent.workspace_run_id,
            workspace_topology_revision=intent.workspace_topology_revision,
            workspace_projection_revision=intent.workspace_projection_revision,
            workspace_action_id=intent.workspace_action_id,
            workspace_action_command_hash=intent.workspace_action_command_hash,
        )
        return unsigned.copy(update={"signature": self._signature(unsigned)})

    def _verify_signature_and_time(self, assertion: AuthAssertion, audience: str, now: datetime) -> None:
        if assertion.issuer != self.issuer:
            raise PolicyViolation("auth_assertion_issuer_invalid")
        if assertion.audience != audience:
            raise PolicyViolation("auth_assertion_audience_invalid")
        if assertion.issued_at.astimezone(timezone.utc) > now or assertion.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("auth_assertion_expired_or_not_yet_valid")
        expected = self._signature(assertion.copy(update={"signature": "0" * 64}))
        if not hmac.compare_digest(expected, assertion.signature):
            raise PolicyViolation("auth_assertion_signature_invalid")

    def resolve(
        self, assertion: AuthAssertion, case: IncidentCase, proposal_id: str = None,
        approval_id: str = None, now: datetime = None, consume: bool = True,
    ) -> AuthContext:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if assertion.command_kind != AuthCommandKind.OWNER_GATE:
            raise PolicyViolation("auth_assertion_command_kind_mismatch")
        if (
            assertion.tenant_id != case.tenant_id or assertion.case_id != case.case_id
            or assertion.case_revision != case.case_revision or assertion.workflow_run_id != case.workflow_run_id
        ):
            raise PolicyViolation("auth_assertion_case_scope_mismatch")
        if assertion.proposal_id != proposal_id or assertion.approval_id != approval_id:
            raise PolicyViolation("auth_assertion_command_scope_mismatch")
        self._verify_signature_and_time(assertion, self.audience, now)
        if consume:
            if assertion.jti in self._consumed:
                raise PolicyViolation("auth_assertion_replayed")
            self._consumed.add(assertion.jti)
        return AuthContext(tenant_id=assertion.tenant_id, subject_id=assertion.subject_id, roles=assertion.roles)

    def resolve_workspace_node_explanation(
        self,
        assertion: AuthAssertion,
        binding: IncidentRunBinding,
        command: NodeExplanationStart,
        now: datetime = None,
        consume: bool = True,
    ) -> AuthContext:
        """Resolve only an exact, server-minted workspace command capability."""
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if assertion.command_kind != AuthCommandKind.WORKSPACE_NODE_EXPLANATION:
            raise PolicyViolation("workspace_auth_assertion_command_kind_mismatch")
        if (
            assertion.tenant_id != binding.tenant_id or assertion.case_id != binding.case_id
            or assertion.case_revision != binding.case_revision or assertion.workflow_run_id != binding.workflow_run_id
            or assertion.workspace_incident_id != binding.incident_id or assertion.workspace_run_id != binding.run_id
            or assertion.workspace_topology_revision != binding.topology_revision
            or assertion.workspace_projection_revision != command.projection_revision
            or assertion.workspace_component_id != command.component_id
            or assertion.workspace_command_hash != command.canonical_hash()
        ):
            raise PolicyViolation("workspace_auth_assertion_scope_mismatch")
        self._verify_signature_and_time(assertion, self.workspace_node_explanation_audience, now)
        if consume:
            if assertion.jti in self._consumed:
                raise PolicyViolation("auth_assertion_replayed")
            self._consumed.add(assertion.jti)
        return AuthContext(tenant_id=assertion.tenant_id, subject_id=assertion.subject_id, roles=assertion.roles)

    def resolve_workspace_action(
        self, assertion: AuthAssertion, binding: IncidentRunBinding, command: ActionInvocationCommand,
        now: datetime = None, consume: bool = True,
    ) -> AuthContext:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if assertion.command_kind != AuthCommandKind.WORKSPACE_ACTION:
            raise PolicyViolation("workspace_action_auth_assertion_command_kind_mismatch")
        if (
            assertion.tenant_id != binding.tenant_id or assertion.case_id != binding.case_id
            or assertion.case_revision != binding.case_revision or assertion.workflow_run_id != binding.workflow_run_id
            or assertion.workspace_incident_id != binding.incident_id or assertion.workspace_run_id != binding.run_id
            or assertion.workspace_topology_revision != binding.topology_revision
            or assertion.workspace_projection_revision != command.projection_revision
            or assertion.workspace_action_id != command.action_id
            or assertion.workspace_action_command_hash != command.canonical_hash()
        ):
            raise PolicyViolation("workspace_action_auth_assertion_scope_mismatch")
        self._verify_signature_and_time(assertion, self.workspace_action_audience, now)
        if consume:
            if assertion.jti in self._consumed:
                raise PolicyViolation("auth_assertion_replayed")
            self._consumed.add(assertion.jti)
        return AuthContext(tenant_id=assertion.tenant_id, subject_id=assertion.subject_id, roles=assertion.roles)


class UnavailableAuthorizationPort:
    def issue_intent(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")

    def resolve(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")

    def issue_workspace_node_explanation_intent(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")

    def resolve_workspace_node_explanation(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")

    def issue_workspace_action_intent(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")

    def resolve_workspace_action(self, *args, **kwargs):
        raise PolicyViolation("authorization_service_unavailable")


class HttpAuthorizationClient:
    """No-secret API/worker adapter to the dedicated authorization service."""

    def __init__(
        self, base_url: str, service_identity: str, service_token: str, timeout_seconds: float = 5.0,
    ) -> None:
        if not base_url or not service_identity or not service_token:
            raise ValueError("authorization_service_identity_required")
        self.base_url = base_url.rstrip("/")
        self.service_identity = service_identity
        self.service_token = service_token
        self.timeout_seconds = timeout_seconds

    def _post(self, path: str, payload: Dict) -> Dict:
        request = UrlRequest(
            self.base_url + path, data=json.dumps(payload, default=str, sort_keys=True).encode("utf-8"), method="POST",
            headers={
                "content-type": "application/json",
                "x-flowpulse-service-identity": self.service_identity,
                "authorization": "Bearer " + self.service_token,
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8")).get("detail", "authorization_service_rejected")
            except Exception:
                detail = "authorization_service_rejected"
            raise PolicyViolation(str(detail)) from error
        except (URLError, OSError) as error:
            raise PolicyViolation("authorization_service_unavailable") from error

    def issue_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        return AuthAssertion.parse_obj(self._post("/v1/assertions/mint", {
            "tenant_id": intent.tenant_id, "intent_id": intent.intent_id,
        }))

    def issue_workspace_node_explanation_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        return AuthAssertion.parse_obj(self._post("/v1/workspace-node-explanations/assertions/mint", {
            "tenant_id": intent.tenant_id, "intent_id": intent.intent_id,
        }))

    def resolve(
        self, assertion: AuthAssertion, case: IncidentCase, proposal_id: str = None,
        approval_id: str = None, now: datetime = None,
    ) -> AuthContext:
        if now is not None:
            raise PolicyViolation("authorization_resolve_clock_override_forbidden")
        return AuthContext.parse_obj(self._post("/v1/assertions/verify-consume", {
            "assertion": assertion.dict(), "proposal_id": proposal_id,
            "approval_id": approval_id,
        }))

    def resolve_workspace_node_explanation(
        self, assertion: AuthAssertion, binding: IncidentRunBinding, command: NodeExplanationStart,
    ) -> AuthContext:
        return AuthContext.parse_obj(self._post("/v1/workspace-node-explanations/assertions/verify-consume", {
            "assertion": assertion.dict(), "binding": binding.dict(), "command": command.dict(),
        }))

    def issue_workspace_action_intent(self, intent: AuthCommandIntent) -> AuthAssertion:
        return AuthAssertion.parse_obj(self._post("/v1/workspace-actions/assertions/mint", {
            "tenant_id": intent.tenant_id, "intent_id": intent.intent_id,
        }))

    def resolve_workspace_action(
        self, assertion: AuthAssertion, binding: IncidentRunBinding, command: ActionInvocationCommand,
    ) -> AuthContext:
        return AuthContext.parse_obj(self._post("/v1/workspace-actions/assertions/verify-consume", {
            "assertion": assertion.dict(), "binding": binding.dict(), "command": command.dict(),
        }))


class AuthMintRequest(StrictModel):
    tenant_id: NonEmpty
    intent_id: NonEmpty


class AuthVerifyRequest(StrictModel):
    assertion: AuthAssertion
    proposal_id: Optional[str] = None
    approval_id: Optional[str] = None


class WorkspaceAuthVerifyRequest(StrictModel):
    assertion: AuthAssertion
    binding: IncidentRunBinding
    command: NodeExplanationStart


class WorkspaceActionAuthVerifyRequest(StrictModel):
    assertion: AuthAssertion
    binding: IncidentRunBinding
    command: ActionInvocationCommand


class AssertionReplayRepository:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool = None

    async def connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=2)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def consume(self, assertion: AuthAssertion) -> None:
        if self.pool is None:
            raise RuntimeError("assertion_replay_repository_not_connected")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("SELECT set_config('app.tenant_id', $1, true)", assertion.tenant_id)
                inserted = await connection.fetchval(
                    """INSERT INTO auth_assertion_consumptions
                       (jti, tenant_id, issuer, audience, key_id, case_id, case_revision, workflow_run_id,
                        proposal_id, approval_id, subject_id, roles, expires_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
                       ON CONFLICT (jti) DO NOTHING RETURNING jti""",
                    assertion.jti, assertion.tenant_id, assertion.issuer, assertion.audience, assertion.key_id,
                    assertion.case_id, assertion.case_revision, assertion.workflow_run_id, assertion.proposal_id,
                    assertion.approval_id, assertion.subject_id, json.dumps(assertion.roles), assertion.expires_at,
                )
                if inserted is None:
                    raise PolicyViolation("auth_assertion_replayed")


def create_authz_app(
    authority: HmacAuthorizationAuthority, replay_dsn: str, api_service_token: str, worker_service_token: str,
) -> FastAPI:
    if not api_service_token or not worker_service_token:
        raise ValueError("authorization_service_tokens_required")
    replay = AssertionReplayRepository(replay_dsn)
    repository = PostgresCaseRepository(replay_dsn)
    app = FastAPI(title="FlowPulse P0 Authorization Service", version="0.1.0")

    @app.on_event("startup")
    async def startup() -> None:
        await replay.connect()
        await repository.connect()

    @app.on_event("shutdown")
    async def shutdown() -> None:
        await replay.close()
        await repository.close()

    def require_service(request: Request, required_identity: str) -> None:
        identity = request.headers.get("x-flowpulse-service-identity")
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        expected = {"api": api_service_token, "worker": worker_service_token}.get(identity)
        if identity != required_identity or expected is None or not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=403, detail="authorization_service_identity_rejected")

    @app.get("/healthz")
    async def healthz() -> Dict[str, str]:
        return {"status": "ok", "issuer": authority.issuer, "audience": authority.audience}

    @app.post("/v1/assertions/mint", response_model=AuthAssertion)
    async def mint(request: AuthMintRequest, http_request: Request) -> AuthAssertion:
        require_service(http_request, "api")
        try:
            intent = await repository.consume_auth_command_intent(request.tenant_id, request.intent_id)
            return authority.issue_intent(intent)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    @app.post("/v1/assertions/verify-consume", response_model=AuthContext)
    async def verify_consume(request: AuthVerifyRequest, http_request: Request) -> AuthContext:
        require_service(http_request, "worker")
        try:
            authoritative_case = await repository.get_case(request.assertion.tenant_id, request.assertion.case_id)
            if authoritative_case is None:
                raise PolicyViolation("authorization_assertion_case_not_authoritative")
            context = authority.resolve(
                request.assertion, authoritative_case, request.proposal_id, request.approval_id, consume=False,
            )
            await replay.consume(request.assertion)
            return context
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    @app.post("/v1/workspace-node-explanations/assertions/mint", response_model=AuthAssertion)
    async def mint_workspace_node_explanation(request: AuthMintRequest, http_request: Request) -> AuthAssertion:
        require_service(http_request, "api")
        try:
            intent = await repository.consume_workspace_node_explanation_intent(request.tenant_id, request.intent_id)
            return authority.issue_workspace_node_explanation_intent(intent)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    @app.post("/v1/workspace-node-explanations/assertions/verify-consume", response_model=AuthContext)
    async def verify_consume_workspace_node_explanation(
        request: WorkspaceAuthVerifyRequest, http_request: Request,
    ) -> AuthContext:
        require_service(http_request, "worker")
        try:
            assertion = request.assertion
            authoritative_binding = await repository.workspace_binding(assertion.tenant_id, assertion.case_id)
            if authoritative_binding is None or authoritative_binding != request.binding:
                raise PolicyViolation("workspace_auth_assertion_binding_not_authoritative")
            projection = await repository.workspace_projection(assertion.tenant_id, assertion.case_id)
            if projection is None or projection.projection_revision != request.command.projection_revision:
                raise PolicyViolation("workspace_auth_assertion_projection_not_authoritative")
            if not await repository.workspace_subject_authorized(
                assertion.tenant_id, assertion.case_id, assertion.subject_id,
            ):
                raise PolicyViolation("workspace_auth_assertion_subject_acl_denied")
            context = authority.resolve_workspace_node_explanation(
                assertion, authoritative_binding, request.command, consume=False,
            )
            await replay.consume(assertion)
            return context
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    @app.post("/v1/workspace-actions/assertions/mint", response_model=AuthAssertion)
    async def mint_workspace_action(request: AuthMintRequest, http_request: Request) -> AuthAssertion:
        require_service(http_request, "api")
        try:
            intent = await repository.consume_auth_command_intent(
                request.tenant_id, request.intent_id, AuthCommandKind.WORKSPACE_ACTION,
            )
            return authority.issue_workspace_action_intent(intent)
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    @app.post("/v1/workspace-actions/assertions/verify-consume", response_model=AuthContext)
    async def verify_consume_workspace_action(
        request: WorkspaceActionAuthVerifyRequest, http_request: Request,
    ) -> AuthContext:
        require_service(http_request, "worker")
        try:
            assertion = request.assertion
            authoritative_binding = await repository.workspace_binding(assertion.tenant_id, assertion.case_id)
            if authoritative_binding is None or authoritative_binding != request.binding:
                raise PolicyViolation("workspace_action_auth_assertion_binding_not_authoritative")
            projection = await repository.workspace_projection(assertion.tenant_id, assertion.case_id)
            if projection is None or projection.projection_revision != request.command.projection_revision:
                raise PolicyViolation("workspace_action_auth_assertion_projection_not_authoritative")
            if not await repository.workspace_subject_authorized(
                assertion.tenant_id, assertion.case_id, assertion.subject_id,
            ):
                raise PolicyViolation("workspace_action_auth_assertion_subject_acl_denied")
            context = authority.resolve_workspace_action(
                assertion, authoritative_binding, request.command, consume=False,
            )
            await replay.consume(assertion)
            return context
        except PolicyViolation as error:
            raise HTTPException(status_code=403, detail=str(error))

    return app

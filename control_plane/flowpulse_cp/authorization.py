"""Signed, short-lived authorization assertions for Temporal Owner Gate updates."""

import hmac
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Protocol
from uuid import uuid4

from .models import AuthAssertion, AuthContext, IncidentCase
from .policy import PolicyViolation, canonical_json


class AuthorizationPort(Protocol):
    def issue(
        self, actor: AuthContext, case: IncidentCase, proposal_id: str = None, now: datetime = None,
    ) -> AuthAssertion:
        """Mint an assertion at a trusted edge; never from a request body."""

    def resolve(
        self, assertion: AuthAssertion, case: IncidentCase, proposal_id: str = None, now: datetime = None,
    ) -> AuthContext:
        """Verify and resolve the assertion at the Owner Gate activity."""


class HmacAuthorizationAuthority:
    """P0 authz reference implementation with an edge-held signing secret.

    The Temporal update serializes only the signed claim.  Direct clients can
    construct its shape but cannot produce a valid signature; the worker
    resolves it again before approving an Owner Gate.
    """

    def __init__(self, signing_secret: str, ttl_seconds: int = 300) -> None:
        if not signing_secret:
            raise ValueError("auth_assertion_signing_secret_required")
        self._secret = signing_secret.encode("utf-8")
        self._ttl_seconds = ttl_seconds

    @staticmethod
    def _material(assertion: AuthAssertion) -> str:
        return canonical_json({
            "assertion_id": assertion.assertion_id,
            "tenant_id": assertion.tenant_id,
            "case_id": assertion.case_id,
            "case_revision": assertion.case_revision,
            "workflow_run_id": assertion.workflow_run_id,
            "proposal_id": assertion.proposal_id,
            "subject_id": assertion.subject_id,
            "roles": assertion.roles,
            "issued_at": assertion.issued_at.astimezone(timezone.utc).isoformat(),
            "expires_at": assertion.expires_at.astimezone(timezone.utc).isoformat(),
        })

    def _signature(self, assertion: AuthAssertion) -> str:
        return hmac.new(self._secret, self._material(assertion).encode("utf-8"), sha256).hexdigest()

    def issue(
        self, actor: AuthContext, case: IncidentCase, proposal_id: str = None, now: datetime = None,
    ) -> AuthAssertion:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        unsigned = AuthAssertion(
            assertion_id="authz-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=case.case_id, case_revision=case.case_revision, workflow_run_id=case.workflow_run_id,
            proposal_id=proposal_id, subject_id=actor.subject_id, roles=actor.roles,
            issued_at=now, expires_at=now + timedelta(seconds=self._ttl_seconds), signature="0" * 64,
        )
        return unsigned.copy(update={"signature": self._signature(unsigned)})

    def resolve(
        self, assertion: AuthAssertion, case: IncidentCase, proposal_id: str = None, now: datetime = None,
    ) -> AuthContext:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if (
            assertion.tenant_id != case.tenant_id
            or assertion.case_id != case.case_id
            or assertion.case_revision != case.case_revision
            or assertion.workflow_run_id != case.workflow_run_id
        ):
            raise PolicyViolation("auth_assertion_case_scope_mismatch")
        if assertion.proposal_id != proposal_id:
            raise PolicyViolation("auth_assertion_proposal_scope_mismatch")
        if assertion.issued_at.astimezone(timezone.utc) > now or assertion.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("auth_assertion_expired_or_not_yet_valid")
        expected = self._signature(assertion.copy(update={"signature": "0" * 64}))
        if not hmac.compare_digest(expected, assertion.signature):
            raise PolicyViolation("auth_assertion_signature_invalid")
        return AuthContext(
            tenant_id=assertion.tenant_id, subject_id=assertion.subject_id, roles=assertion.roles,
        )

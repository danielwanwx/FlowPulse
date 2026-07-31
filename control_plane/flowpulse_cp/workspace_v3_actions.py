"""V3 action card and authorization contracts.

V3 action authority binds stable public identity and decision revision.  It is
deliberately independent of physical Temporal generations and signal ticks.
"""

import hmac
import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import List
from uuid import uuid4

from pydantic import Field, root_validator

from .models import Hash, NonEmpty, PositiveInt, StrictBool, StrictModel
from .policy import PolicyViolation, canonical_json
from .workspace_v3_models import (
    ActionInvocationCommandV3,
    IncidentExecutionIdentityV3,
)


WORKSPACE_ACTION_V3_AUDIENCE = "flowpulse.temporal-workspace-action.v3"


class NextBestActionV3(IncidentExecutionIdentityV3):
    """Server-issued action card whose validity survives signal-only updates."""

    schema_version: NonEmpty = "flowpulse.next-best-action.v3"
    action_id: NonEmpty
    card_version: PositiveInt
    decision_revision: PositiveInt
    evidence_revision: PositiveInt
    title: NonEmpty
    summary: NonEmpty
    required_permission: NonEmpty
    precondition_version: NonEmpty
    precondition_hash: Hash
    idempotency_valid_until: datetime
    expires_at: datetime


class WorkspaceActionAuthorizationIntentV3(StrictModel):
    """Server-created scope for exactly one V3 action command."""

    intent_id: NonEmpty
    identity: IncidentExecutionIdentityV3
    decision_revision: PositiveInt
    action_id: NonEmpty
    command_hash: Hash
    subject_id: NonEmpty
    roles: List[NonEmpty] = Field(max_items=16)
    created_at: datetime
    expires_at: datetime


class WorkspaceActionAssertionV3(StrictModel):
    """Short-lived signed proof independent of one Temporal run generation."""

    schema_version: NonEmpty = "flowpulse.workspace-action-assertion.v3"
    assertion_id: NonEmpty
    issuer: NonEmpty
    audience: NonEmpty = WORKSPACE_ACTION_V3_AUDIENCE
    key_id: NonEmpty
    jti: NonEmpty
    nonce: NonEmpty
    identity: IncidentExecutionIdentityV3
    decision_revision: PositiveInt
    action_id: NonEmpty
    command_hash: Hash
    subject_id: NonEmpty
    roles: List[NonEmpty] = Field(max_items=16)
    issued_at: datetime
    expires_at: datetime
    signature: Hash

    @root_validator(allow_reuse=True)
    def time_window_is_valid(cls, values):
        issued_at = values.get("issued_at")
        expires_at = values.get("expires_at")
        if issued_at is not None and expires_at is not None and expires_at <= issued_at:
            raise ValueError("workspace_v3_action_assertion_expiry_must_follow_issue")
        return values


class HmacWorkspaceActionAuthorityV3:
    """Isolated signer/verifier for V3 action assertions."""

    def __init__(
        self, keyring, issuer: str = "flowpulse.authz.test",
        active_key_id: str = "test-k1", ttl_seconds: int = 300,
        audience: str = WORKSPACE_ACTION_V3_AUDIENCE,
    ) -> None:
        if isinstance(keyring, str):
            keyring = {active_key_id: keyring}
        if not keyring or active_key_id not in keyring or not issuer or not audience:
            raise ValueError("workspace_v3_action_authority_configuration_required")
        self._keys = {
            key_id: secret.encode("utf-8") for key_id, secret in keyring.items()
            if secret
        }
        if active_key_id not in self._keys:
            raise ValueError("workspace_v3_action_authority_active_key_missing")
        self.issuer = issuer
        self.active_key_id = active_key_id
        self.ttl_seconds = ttl_seconds
        self.audience = audience
        self._consumed = set()

    @staticmethod
    def _material(assertion: WorkspaceActionAssertionV3) -> str:
        return canonical_json({
            "assertion_id": assertion.assertion_id,
            "issuer": assertion.issuer,
            "audience": assertion.audience,
            "key_id": assertion.key_id,
            "jti": assertion.jti,
            "nonce": assertion.nonce,
            "identity": json.loads(assertion.identity.json()),
            "decision_revision": assertion.decision_revision,
            "action_id": assertion.action_id,
            "command_hash": assertion.command_hash,
            "subject_id": assertion.subject_id,
            "roles": assertion.roles,
            "issued_at": assertion.issued_at.astimezone(timezone.utc).isoformat(),
            "expires_at": assertion.expires_at.astimezone(timezone.utc).isoformat(),
        })

    def _signature(self, assertion: WorkspaceActionAssertionV3) -> str:
        key = self._keys.get(assertion.key_id)
        if key is None:
            raise PolicyViolation("workspace_v3_action_assertion_key_unknown")
        return hmac.new(key, self._material(assertion).encode("utf-8"), sha256).hexdigest()

    def issue(self, intent: WorkspaceActionAuthorizationIntentV3, now: datetime = None) -> WorkspaceActionAssertionV3:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if intent.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("workspace_v3_action_intent_expired")
        jti = "workspace-v3-action-authz-{}".format(uuid4().hex)
        unsigned = WorkspaceActionAssertionV3(
            assertion_id=jti, issuer=self.issuer, audience=self.audience,
            key_id=self.active_key_id, jti=jti, nonce="nonce-{}".format(uuid4().hex),
            identity=intent.identity, decision_revision=intent.decision_revision,
            action_id=intent.action_id, command_hash=intent.command_hash,
            subject_id=intent.subject_id, roles=intent.roles, issued_at=now,
            expires_at=min(
                intent.expires_at.astimezone(timezone.utc),
                now + timedelta(seconds=self.ttl_seconds),
            ), signature="0" * 64,
        )
        return unsigned.copy(update={"signature": self._signature(unsigned)})

    def resolve(
        self, assertion: WorkspaceActionAssertionV3,
        command: ActionInvocationCommandV3,
        now: datetime = None, consume: bool = True,
    ) -> None:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if assertion.issuer != self.issuer or assertion.audience != self.audience:
            raise PolicyViolation("workspace_v3_action_assertion_issuer_or_audience_invalid")
        if assertion.issued_at.astimezone(timezone.utc) > now or assertion.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("workspace_v3_action_assertion_expired_or_not_yet_valid")
        if not hmac.compare_digest(
            self._signature(assertion.copy(update={"signature": "0" * 64})),
            assertion.signature,
        ):
            raise PolicyViolation("workspace_v3_action_assertion_signature_invalid")
        if (
            assertion.identity.incident_id != command.incident_id
            or assertion.identity.incident_run_id != command.incident_run_id
            or assertion.identity.topology_revision != command.topology_revision
            or assertion.decision_revision != command.decision_revision
            or assertion.action_id != command.action_id
            or assertion.command_hash != command.canonical_hash()
        ):
            raise PolicyViolation("workspace_v3_action_assertion_scope_mismatch")
        if command.idempotency_valid_until.astimezone(timezone.utc) <= now:
            raise PolicyViolation("workspace_v3_action_idempotency_key_expired")
        if consume:
            if assertion.jti in self._consumed:
                raise PolicyViolation("workspace_v3_action_assertion_replayed")
            self._consumed.add(assertion.jti)


def validate_current_action_card_v3(
    card: NextBestActionV3, command: ActionInvocationCommandV3,
    subject_permissions: List[str], now: datetime,
) -> None:
    """Validate one V3 card without consulting a signal/projection tick."""
    now = now.astimezone(timezone.utc)
    if card.expires_at.astimezone(timezone.utc) <= now:
        raise PolicyViolation("workspace_v3_action_card_expired")
    if card.idempotency_valid_until.astimezone(timezone.utc) <= now:
        raise PolicyViolation("workspace_v3_action_idempotency_key_expired")
    if (
        card.incident_id != command.incident_id
        or card.incident_run_id != command.incident_run_id
        or card.topology_revision != command.topology_revision
        or card.decision_revision != command.decision_revision
        or card.action_id != command.action_id
    ):
        raise PolicyViolation("workspace_v3_action_card_scope_mismatch")
    if card.required_permission not in subject_permissions:
        raise PolicyViolation("workspace_v3_action_permission_denied")

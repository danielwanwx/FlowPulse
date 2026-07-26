"""Gate 1 lease contracts and server-owned Workspace action primitives.

The browser never receives a capability scope or a tool schema.  A Temporal
activity issues a short-lived lease after it has selected a server-generated
card; the shared capability registry validates that lease again immediately
before every fresh read.
"""

import inspect
import json
from hashlib import sha256
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol

from pydantic import Field, root_validator

from .capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityAuditRecord,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityResult,
)
from .models import AuthAssertion, Hash, NonEmpty, PositiveInt, StrictBool, StrictModel
from .policy import PolicyViolation
from .workspace_models import IncidentEvent, IncidentProjection, IncidentRunBinding


def canonical_evidence_set_hash(evidence_refs: List[str]) -> str:
    """Hash the exact, order-independent evidence set bound to a Gate 1 lease."""
    if len(evidence_refs) != len(set(evidence_refs)):
        raise PolicyViolation("gate1_evidence_set_duplicate")
    encoded = json.dumps(sorted(evidence_refs), separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return sha256(encoded).hexdigest()


class Gate1LeaseStatus(str, Enum):
    ACTIVE = "ACTIVE"
    CONSUMED = "CONSUMED"
    REVOKED = "REVOKED"
    EXPIRED = "EXPIRED"


class NextBestActionTaxonomy(str, Enum):
    FIND_CAUSE = "FIND_CAUSE"
    MAP_IMPACT = "MAP_IMPACT"
    REVIEW_EVIDENCE = "REVIEW_EVIDENCE"
    APPROVE_PLAN = "APPROVE_PLAN"
    APPLY_FIX = "APPLY_FIX"


class NextBestActionCta(str, Enum):
    REQUEST_GATE1 = "request_gate_1"
    RUN_READ_CAPABILITY = "run_read_capability"
    REVIEW_EVIDENCE = "review_evidence"
    REQUEST_GATE2 = "request_gate_2"
    SUBMIT_APPROVED_DRY_RUN = "submit_approved_dry_run"


ACTION_TAXONOMY = {
    NextBestActionTaxonomy.FIND_CAUSE: ("Find Cause", NextBestActionCta.REQUEST_GATE1),
    NextBestActionTaxonomy.MAP_IMPACT: ("Map Impact", NextBestActionCta.RUN_READ_CAPABILITY),
    NextBestActionTaxonomy.REVIEW_EVIDENCE: ("Review Evidence", NextBestActionCta.REVIEW_EVIDENCE),
    NextBestActionTaxonomy.APPROVE_PLAN: ("Approve Plan", NextBestActionCta.REQUEST_GATE2),
    NextBestActionTaxonomy.APPLY_FIX: ("Apply Fix", NextBestActionCta.SUBMIT_APPROVED_DRY_RUN),
}


class NextBestAction(IncidentRunBinding):
    """A fixed, server-generated recommendation—not an executable command."""

    schema_version: NonEmpty = "flowpulse.next-best-action.v1"
    action_id: NonEmpty
    card_version: PositiveInt
    taxonomy: NextBestActionTaxonomy
    title: NonEmpty
    cta: NextBestActionCta
    summary: NonEmpty
    display_order: PositiveInt
    recommended: StrictBool
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    gate_revision: PositiveInt
    action_revision: PositiveInt
    component_id: NonEmpty
    capability: NonEmpty
    data_class: NonEmpty
    required_permission: NonEmpty
    required_gate: NonEmpty
    tool_schema_version: NonEmpty
    capability_registry_revision: NonEmpty
    precondition_version: NonEmpty
    precondition_hash: Hash
    gate1_lease_id: Optional[NonEmpty] = None
    evidence_refs: List[NonEmpty] = Field(default_factory=list)
    expires_at: datetime

    @root_validator(allow_reuse=True)
    def fixed_taxonomy_controls_title_and_cta(cls, values):
        expected = ACTION_TAXONOMY.get(values.get("taxonomy"))
        if expected is None or (values.get("title"), values.get("cta")) != expected:
            raise ValueError("next_best_action_taxonomy_mapping_invalid")
        return values


class ActionInvocationCommand(StrictModel):
    """The complete browser command: opaque action plus canonical identity only."""

    incident_id: NonEmpty
    run_id: NonEmpty
    topology_revision: NonEmpty
    projection_revision: PositiveInt
    action_id: NonEmpty
    idempotency_key: NonEmpty

    def canonical_hash(self) -> str:
        return sha256(self.json(sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


class WorkspaceActionInvocation(StrictModel):
    command: ActionInvocationCommand
    authorization: AuthAssertion


class WorkspaceActionAuthorizationPacket(IncidentRunBinding):
    command: ActionInvocationCommand
    authorization: AuthAssertion
    projection_revision: PositiveInt


class WorkspaceActionAuthorizationOutcome(StrictModel):
    actor_tenant_id: NonEmpty
    actor_subject_id: NonEmpty
    actor_roles: List[NonEmpty]


class WorkspaceActionPacket(IncidentRunBinding):
    projection: IncidentProjection
    event_sequence: PositiveInt
    command: ActionInvocationCommand
    actor_tenant_id: NonEmpty
    actor_subject_id: NonEmpty
    actor_roles: List[NonEmpty]
    # Set by new workflow commands. Frozen v2 histories omit it and derive the
    # same immutable command identity in the activity dispatcher.
    activity_identity: Optional[NonEmpty] = None


class WorkspaceActionGenerationPacket(IncidentRunBinding):
    projection: IncidentProjection


class WorkspaceActionGenerationOutcome(StrictModel):
    actions: List[NextBestAction] = Field(default_factory=list, max_items=3)


class WorkspaceActionReceipt(IncidentRunBinding):
    action_id: NonEmpty
    idempotency_key: NonEmpty
    status: NonEmpty
    external_write_performed: StrictBool = False
    gate1_lease_id: Optional[NonEmpty] = None
    reason: NonEmpty
    created_at: datetime


class WorkspaceActionOutcome(StrictModel):
    receipt: WorkspaceActionReceipt
    projection: Optional[IncidentProjection] = None
    actions: List[NextBestAction] = Field(default_factory=list, max_items=3)


def validate_current_action_card(
    card: NextBestAction, projection: IncidentProjection, command: ActionInvocationCommand,
    subject_permissions: List[str], now: datetime,
) -> None:
    """Reloaded card validation shared by HTTP, Temporal activity, and tests."""
    if card.action_id != command.action_id:
        raise PolicyViolation("workspace_action_id_mismatch")
    if card.expires_at.astimezone(timezone.utc) <= now.astimezone(timezone.utc):
        raise PolicyViolation("workspace_action_card_expired")
    for field in (
        "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
        "workflow_id", "workflow_run_id", "projection_revision", "evidence_revision",
        "gate_revision", "action_revision",
    ):
        if getattr(card, field) != getattr(projection, field):
            raise PolicyViolation("workspace_action_card_stale_or_rebound")
    if (
        command.incident_id != card.incident_id or command.run_id != card.run_id
        or command.topology_revision != card.topology_revision
        or command.projection_revision != card.projection_revision
    ):
        raise PolicyViolation("workspace_action_command_scope_mismatch")
    if card.required_permission not in subject_permissions:
        raise PolicyViolation("workspace_action_permission_denied")
    if card.precondition_hash != NextBestActionGenerator._precondition_hash(projection):
        raise PolicyViolation("workspace_action_precondition_stale")


class NextBestActionGenerator:
    """Produces a maximum of three capability-bound cards from current state."""

    def __init__(self, registry: CapabilityRegistry, *, registry_revision: Optional[str] = None) -> None:
        self.registry = registry
        self.registry_revision = registry_revision or registry.policy_version

    @staticmethod
    def _precondition_hash(projection) -> str:
        payload = {
            "run_id": projection.run_id,
            "topology_revision": projection.topology_revision,
            "projection_revision": projection.projection_revision,
            "evidence_revision": projection.evidence_revision,
            "gate_revision": projection.gate_revision,
            "action_revision": projection.action_revision,
        }
        return sha256(str(sorted(payload.items())).encode("utf-8")).hexdigest()

    def _card(
        self, projection, descriptor: CapabilityDescriptor, taxonomy: NextBestActionTaxonomy,
        order: int, recommended: bool, now: datetime, gate1_lease_id: Optional[str] = None,
    ) -> NextBestAction:
        title, cta = ACTION_TAXONOMY[taxonomy]
        component_id = projection.graph.nodes[0].component_id
        data_class = descriptor.data_classes[0]
        precondition_hash = self._precondition_hash(projection)
        identity = {
            "tenant_id": projection.tenant_id, "run_id": projection.run_id,
            "topology_revision": projection.topology_revision, "projection_revision": projection.projection_revision,
            "action_revision": projection.action_revision, "taxonomy": taxonomy.value,
            "capability": descriptor.capability.value, "component_id": component_id,
        }
        action_id = "action-{}".format(sha256(str(sorted(identity.items())).encode("utf-8")).hexdigest()[:24])
        return NextBestAction(
            **projection.dict(include=set(IncidentRunBinding.__fields__)), action_id=action_id, card_version=1,
            taxonomy=taxonomy, title=title, cta=cta,
            summary=(
                "Request a bounded fresh read for the current incident."
                if taxonomy == NextBestActionTaxonomy.FIND_CAUSE
                else "Review only already admitted evidence."
            ),
            display_order=order, recommended=recommended,
            projection_revision=projection.projection_revision, evidence_revision=projection.evidence_revision,
            gate_revision=projection.gate_revision, action_revision=projection.action_revision,
            component_id=component_id, capability=descriptor.capability.value, data_class=data_class.value,
            required_permission="incident:read", required_gate=descriptor.required_gate.value,
            tool_schema_version=descriptor.input_schema, capability_registry_revision=self.registry_revision,
            precondition_version="workspace-precondition.v1", precondition_hash=precondition_hash,
            gate1_lease_id=gate1_lease_id,
            evidence_refs=list(projection.evidence_refs), expires_at=now.astimezone(timezone.utc) + timedelta(minutes=30),
        )

    def generate(self, projection, now: datetime) -> List[NextBestAction]:
        cards: List[NextBestAction] = []
        for descriptor in self.registry.available(CapabilityAudience.USER_QA):
            if descriptor.fresh_read and descriptor.required_gate == CapabilityGate.GATE1:
                cards.append(self._card(
                    projection, descriptor, NextBestActionTaxonomy.FIND_CAUSE,
                    len(cards) + 1, not cards, now,
                ))
            elif not descriptor.fresh_read and descriptor.capability == CapabilityName.RECORDED_CONTEXT:
                cards.append(self._card(
                    projection, descriptor, NextBestActionTaxonomy.REVIEW_EVIDENCE,
                    len(cards) + 1, not cards, now,
                ))
            if len(cards) == 3:
                break
        if sum(1 for card in cards if card.recommended) > 1:
            raise PolicyViolation("next_best_action_multiple_recommended")
        return cards

    def generate_after_gate1(self, projection, lease: "Gate1Lease", now: datetime) -> List[NextBestAction]:
        """Expose one bound read card only after an active exact Gate 1 lease."""
        descriptor = next((item for item in self.registry.available(CapabilityAudience.USER_QA)
                           if item.capability.value == lease.capability), None)
        if descriptor is None or not descriptor.fresh_read or descriptor.required_gate != CapabilityGate.GATE1:
            return []
        return [self._card(
            projection, descriptor, NextBestActionTaxonomy.MAP_IMPACT, 1, True, now, lease.lease_id,
        )]


class Gate1Lease(IncidentRunBinding):
    """One Temporal-owned authorization for one fresh read capability."""

    schema_version: NonEmpty = "flowpulse.gate1-lease.v1"
    lease_id: NonEmpty
    lease_revision: PositiveInt
    subject_id: NonEmpty
    required_permission: NonEmpty
    component_id: NonEmpty
    capability: NonEmpty
    data_class: NonEmpty
    tool_schema_version: NonEmpty
    projection_revision: PositiveInt
    evidence_revision: PositiveInt
    capability_registry_revision: NonEmpty
    precondition_version: NonEmpty
    precondition_hash: Hash
    issuance_command_fingerprint: Hash
    # These identify the server-generated Gate 1 card which issued this
    # lease.  Optional keeps previously archived/read-only records decodable;
    # a live consumption rejects a record that lacks them.
    issuance_action_id: Optional[NonEmpty] = None
    issuance_card_version: Optional[PositiveInt] = None
    issuance_idempotency_key: Optional[NonEmpty] = None
    evidence_set_hash: Hash
    issued_at: datetime
    expires_at: datetime
    status: Gate1LeaseStatus
    consumed_by_activity_id: Optional[NonEmpty] = None
    consumed_command_fingerprint: Optional[Hash] = None
    consumed_evidence_set_hash: Optional[Hash] = None
    consumed_evidence_revision: Optional[PositiveInt] = None


class WorkspaceActionCommit(StrictModel):
    """The one append-only action/outbox unit committed by a Temporal activity."""

    activity_identity: NonEmpty
    command_fingerprint: Hash
    projection: IncidentProjection
    receipt: WorkspaceActionReceipt
    event: IncidentEvent
    lease: Optional[Gate1Lease] = None
    actions: List[NextBestAction] = Field(default_factory=list, max_items=3)
    # The source Gate 1 card is retained with the grant transition so a later
    # read can validate the original opaque card identity rather than trusting
    # only a lease payload.
    issued_action: Optional[NextBestAction] = None
    # Fresh-read domain admission and capability audit are persisted with the
    # transition, never before it.
    capability_result: Optional[CapabilityResult] = None
    capability_audit: Optional[CapabilityAuditRecord] = None

    @root_validator(allow_reuse=True)
    def capability_records_are_complete(cls, values):
        result = values.get("capability_result")
        audit = values.get("capability_audit")
        if (result is None) != (audit is None):
            raise ValueError("workspace_action_capability_result_and_audit_must_match")
        return values


class Gate1LeaseStore(Protocol):
    async def workspace_gate1_lease(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[Gate1Lease]:
        """Return the latest append-only lease revision for the exact tenant/case."""

    async def append_gate1_lease(self, lease: Gate1Lease) -> Gate1Lease:
        """Append a new authoritative lease state under the immutable binding."""

    async def workspace_gate1_grant_transition(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[WorkspaceActionCommit]:
        """Return the immutable Gate 1 grant transition for this lease."""


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class Gate1LeaseAuthority:
    """Fail-closed validation port injected into the shared capability registry.

    It deliberately does not mutate a lease.  A read is only consumed inside
    the action transition transaction after source acquisition, admission, and
    audit construction all succeeded.
    """

    def __init__(self, store: Gate1LeaseStore, now=None) -> None:
        self._store = store
        self._now = now or (lambda: datetime.now(timezone.utc))

    async def assert_active(
        self, invocation_context, request: CapabilityRequest, descriptor: CapabilityDescriptor = None,
    ) -> Gate1Lease:
        lease_id = getattr(invocation_context, "gate1_lease_id", None)
        if not lease_id:
            raise PolicyViolation("gate1_lease_required")
        lease = await _maybe_await(self._store.workspace_gate1_lease(
            invocation_context.tenant_id, invocation_context.case_id, lease_id,
        ))
        if lease is None:
            raise PolicyViolation("gate1_lease_not_found")
        if lease.status != Gate1LeaseStatus.ACTIVE:
            raise PolicyViolation("gate1_lease_not_active")
        now = self._now().astimezone(timezone.utc)
        if lease.expires_at.astimezone(timezone.utc) <= now:
            raise PolicyViolation("gate1_lease_expired")
        for field in (
            "tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision",
            "workflow_id", "workflow_run_id", "projection_revision", "evidence_revision",
            "capability_registry_revision", "precondition_version", "precondition_hash", "subject_id",
        ):
            if getattr(lease, field) != getattr(invocation_context, field):
                raise PolicyViolation("gate1_lease_scope_mismatch")
        evidence_set_hash = canonical_evidence_set_hash(list(getattr(invocation_context, "recorded_evidence_ids", [])))
        if lease.evidence_set_hash != evidence_set_hash:
            raise PolicyViolation("gate1_lease_evidence_set_mismatch")
        command_fingerprint = getattr(invocation_context, "action_command_fingerprint", None)
        if not command_fingerprint:
            raise PolicyViolation("gate1_lease_command_fingerprint_required")
        await self._assert_issuance_binding(lease)
        if lease.required_permission not in getattr(invocation_context, "subject_permissions", []):
            raise PolicyViolation("gate1_lease_permission_denied")
        if lease.component_id not in getattr(invocation_context, "component_ids", []):
            raise PolicyViolation("gate1_lease_component_scope_mismatch")
        if lease.component_id != request.component_id:
            raise PolicyViolation("gate1_lease_component_mismatch")
        if lease.capability != request.capability.value:
            raise PolicyViolation("gate1_lease_capability_mismatch")
        if lease.data_class != request.data_class.value:
            raise PolicyViolation("gate1_lease_data_class_mismatch")
        if descriptor is not None and lease.tool_schema_version != descriptor.input_schema:
            raise PolicyViolation("gate1_lease_tool_schema_mismatch")
        return lease

    async def _assert_issuance_binding(self, lease: Gate1Lease) -> None:
        """Bind consumption to the immutable transition that granted Gate 1."""
        grant = await _maybe_await(self._store.workspace_gate1_grant_transition(
            lease.tenant_id, lease.case_id, lease.lease_id,
        ))
        validate_gate1_issuance_binding(lease, grant)


def validate_gate1_issuance_binding(
    lease: Gate1Lease, grant: Optional[WorkspaceActionCommit],
) -> None:
    """Validate the full immutable grant provenance for an active lease."""
    if (
        not lease.issuance_action_id
        or lease.issuance_card_version is None
        or not lease.issuance_idempotency_key
        or lease.lease_id != "gate1-" + lease.issuance_command_fingerprint
    ):
        raise PolicyViolation("gate1_lease_issuance_binding_missing_or_invalid")
    if grant is None:
        raise PolicyViolation("gate1_lease_grant_transition_not_found")
    issued_action = grant.issued_action
    granted_lease = grant.lease
    if (
        granted_lease is None
        or issued_action is None
        or granted_lease.status != Gate1LeaseStatus.ACTIVE
        or granted_lease.lease_revision != 1
        or granted_lease != lease
        or grant.command_fingerprint != lease.issuance_command_fingerprint
        or grant.receipt.status != "GATE1_GRANTED"
        or grant.receipt.gate1_lease_id != lease.lease_id
        or grant.receipt.action_id != lease.issuance_action_id
        or grant.receipt.idempotency_key != lease.issuance_idempotency_key
        or issued_action.action_id != lease.issuance_action_id
        or issued_action.card_version != lease.issuance_card_version
        or issued_action.cta != NextBestActionCta.REQUEST_GATE1
        or issued_action.gate1_lease_id is not None
    ):
        raise PolicyViolation("gate1_lease_issuance_binding_mismatch")
    if _workspace_binding_tuple(issued_action) != _workspace_binding_tuple(lease):
        raise PolicyViolation("gate1_lease_issuance_binding_mismatch")


def _workspace_binding_tuple(item: IncidentRunBinding) -> tuple:
    return tuple(getattr(item, name) for name in IncidentRunBinding.__fields__)

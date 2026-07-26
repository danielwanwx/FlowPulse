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
from uuid import UUID

from pydantic import Field, ValidationError, root_validator

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
    CapabilityScope,
    CurrentEvidenceCapabilityResult,
    canonical_capability_request_hash,
    canonical_capability_result_hash,
    deterministic_capability_audit_id,
)
from .models import (
    AuthAssertion,
    ClaimRecord,
    CoverageEntry,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    Hash,
    NonEmpty,
    PositiveInt,
    ProofScope,
    StrictBool,
    StrictModel,
)
from .policy import PolicyViolation, validate_claim_evidence, validate_evidence_admission
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


GATE1_LEASE_TTL = timedelta(minutes=30)
WORKSPACE_READ_ROLES = frozenset({"viewer", "owner", "local-test-owner"})


def workspace_permissions_for_roles(roles: List[str]) -> List[str]:
    """Derive the only P0 workspace read permission from durable roles."""
    return ["incident:read"] if set(roles).intersection(WORKSPACE_READ_ROLES) else []


class WorkspaceSubjectGrant(StrictModel):
    """Latest immutable scoped successor of a durable subject membership grant."""

    tenant_id: NonEmpty
    case_id: NonEmpty
    subject_id: NonEmpty
    scope_revision: PositiveInt = 1
    roles: List[NonEmpty] = Field(default_factory=list, max_items=16)
    permissions: List[NonEmpty] = Field(default_factory=list, max_items=16)
    created_at: datetime

    @root_validator(allow_reuse=True)
    def grant_roles_and_permissions_are_unique(cls, values):
        for field in ("roles", "permissions"):
            value = values.get(field, [])
            if len(value) != len(set(value)):
                raise ValueError("workspace_subject_grant_{}_must_be_unique".format(field))
        return values


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
    # Optional only to decode frozen P0 cards. Every newly generated Gate 1
    # card carries the adapter version and is required at consumption time.
    capability_version: Optional[NonEmpty] = None
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
            capability_version=descriptor.version,
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
    capability_version: Optional[NonEmpty] = None
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
    consumed_action_id: Optional[NonEmpty] = None
    consumed_card_version: Optional[PositiveInt] = None
    consumed_idempotency_key: Optional[NonEmpty] = None
    consumed_request_hash: Optional[Hash] = None
    consumed_result_hash: Optional[Hash] = None
    consumed_audit_id: Optional[UUID] = None
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
        error = _workspace_action_commit_kind_error(
            values.get("receipt"), values.get("lease"), values.get("actions", []),
            values.get("issued_action"), values.get("capability_result"), values.get("capability_audit"),
            values.get("command_fingerprint"), values.get("activity_identity"),
        )
        if error is not None:
            raise ValueError(error)
        return values


def _workspace_action_commit_kind_error(
    receipt: Optional[WorkspaceActionReceipt], lease: Optional[Gate1Lease], actions: List[NextBestAction],
    issued_action: Optional[NextBestAction], capability_result: Optional[CapabilityResult],
    capability_audit: Optional[CapabilityAuditRecord], command_fingerprint: Optional[str],
    activity_identity: Optional[str],
) -> Optional[str]:
    """Return the one permitted artifact shape for each authoritative action transition.

    This deliberately treats the transition kind as a persistence invariant,
    not an activity convention.  Repository entry points call the public
    wrapper below too, so ``BaseModel.construct`` cannot bypass it.
    """
    if not isinstance(receipt, WorkspaceActionReceipt):
        return "workspace_action_receipt_required"
    if lease is not None and not isinstance(lease, Gate1Lease):
        return "workspace_action_lease_invalid"
    if issued_action is not None and not isinstance(issued_action, NextBestAction):
        return "workspace_action_issued_card_invalid"
    if (capability_result is None) != (capability_audit is None):
        return "workspace_action_capability_result_and_audit_must_match"
    lease_status = getattr(getattr(lease, "status", None), "value", getattr(lease, "status", None))
    lease_revision = getattr(lease, "lease_revision", None)
    if lease is None or receipt.gate1_lease_id != getattr(lease, "lease_id", None):
        return "workspace_action_receipt_lease_binding_required"
    if receipt.status == "FRESH_READ_COMPLETED":
        if lease_status != Gate1LeaseStatus.CONSUMED.value:
            return "fresh_read_transition_consumed_lease_required"
        if capability_result is None or capability_audit is None:
            return "fresh_read_transition_artifacts_required"
        if issued_action is not None or actions:
            return "fresh_read_transition_incompatible_artifacts"
        return _fresh_read_artifact_binding_error(
            receipt, lease, capability_result, capability_audit, command_fingerprint,
            activity_identity,
        )
    if receipt.status == "GATE1_GRANTED":
        if lease_status != Gate1LeaseStatus.ACTIVE.value or lease_revision != 1:
            return "gate1_grant_active_revision_one_lease_required"
        if issued_action is None:
            return "gate1_grant_issued_card_required"
        if capability_result is not None or capability_audit is not None:
            return "gate1_grant_capability_artifacts_forbidden"
        if issued_action.action_id != receipt.action_id or issued_action.cta != NextBestActionCta.REQUEST_GATE1:
            return "gate1_grant_issued_card_binding_invalid"
        if issued_action.gate1_lease_id is not None:
            return "gate1_grant_issued_card_must_be_pre_lease"
        if (
            lease.issuance_action_id != issued_action.action_id
            or lease.issuance_card_version != issued_action.card_version
            or lease.issuance_idempotency_key != receipt.idempotency_key
            or lease.issuance_command_fingerprint != command_fingerprint
        ):
            return "gate1_grant_lease_issuance_binding_invalid"
        return None
    return "workspace_action_transition_kind_unsupported"


def _fresh_read_artifact_binding_error(
    receipt: WorkspaceActionReceipt, lease: Gate1Lease, capability_result: CapabilityResult,
    capability_audit: CapabilityAuditRecord, command_fingerprint: Optional[str],
    activity_identity: Optional[str],
) -> Optional[str]:
    """Validate the complete domain result and the immutable Gate 1 audit binding.

    ``CapabilityResult`` remains the common adapter return type.  A Gate 1
    fresh read, however, has the narrower current-evidence contract: an
    admitted envelope, a cited claim, and a coverage entry must all exist.
    The audit is deliberately checked against the consumed lease rather than
    merely against the final projection, so a copied audit cannot be paired
    with a different command or source result.
    """
    if not isinstance(capability_result, CapabilityResult):
        return "fresh_read_current_evidence_artifacts_required"
    try:
        CurrentEvidenceCapabilityResult.parse_obj(capability_result.dict())
    except (AttributeError, TypeError, ValidationError):
        return "fresh_read_current_evidence_artifacts_required"
    if not isinstance(capability_audit, CapabilityAuditRecord):
        return "fresh_read_audit_binding_invalid"
    result_error = _fresh_read_result_lineage_error(capability_result, capability_audit)
    if result_error is not None:
        return result_error
    if _workspace_binding_tuple(capability_audit) != _workspace_binding_tuple(lease):
        return "fresh_read_audit_binding_invalid"
    try:
        capability = CapabilityName(lease.capability)
        data_class = CapabilityDataClass(lease.data_class)
    except ValueError:
        return "fresh_read_audit_binding_invalid"
    if (
        capability_audit.subject_id != lease.subject_id
        or capability_audit.audience != CapabilityAudience.USER_QA
        or capability_audit.scope != CapabilityScope.USER_QA
        or capability_audit.capability != capability
        or capability_audit.component_id != lease.component_id
        or capability_audit.data_class != data_class
        or capability_audit.required_gate != CapabilityGate.GATE1
        or capability_audit.policy_version != lease.capability_registry_revision
        or capability_audit.projection_revision != lease.projection_revision
        or capability_audit.evidence_revision != lease.evidence_revision
        or capability_audit.status != "COMPLETED"
        or not lease.capability_version
        or capability_audit.capability_version != lease.capability_version
    ):
        return "fresh_read_audit_binding_invalid"
    try:
        expected_request_hash = canonical_capability_request_hash(CapabilityRequest(
            capability=capability, component_id=lease.component_id, data_class=data_class, parameters={},
        ))
        expected_result_hash = canonical_capability_result_hash(capability_result)
    except (PolicyViolation, ValidationError, TypeError):
        return "fresh_read_audit_binding_invalid"
    expected_audit_id = deterministic_capability_audit_id(
        tenant_id=capability_audit.tenant_id, run_id=capability_audit.run_id,
        activity_id=capability_audit.activity_id, scope=capability_audit.scope,
        audience=capability_audit.audience, capability=capability_audit.capability,
        request_hash=expected_request_hash,
    )
    if (
        capability_audit.request_hash != expected_request_hash
        or capability_audit.result_hash != expected_result_hash
        or capability_audit.audit_id != expected_audit_id
    ):
        return "fresh_read_audit_provenance_invalid"
    try:
        input_evidence_hash = canonical_evidence_set_hash(list(capability_audit.input_evidence_refs))
    except (PolicyViolation, TypeError):
        return "fresh_read_audit_binding_invalid"
    if (
        input_evidence_hash != lease.evidence_set_hash
        or lease.consumed_evidence_set_hash != input_evidence_hash
        or lease.consumed_evidence_revision != capability_audit.evidence_revision
        or lease.consumed_command_fingerprint != command_fingerprint
    ):
        return "fresh_read_audit_binding_invalid"
    expected_activity_id = "workspace-gate1:{}:{}:{}".format(
        lease.workflow_run_id, receipt.action_id, receipt.idempotency_key,
    )
    expected_transition_activity = "workspace-action:{}:{}".format(
        lease.workflow_run_id, command_fingerprint,
    )
    if (
        capability_audit.activity_id != expected_activity_id
        or lease.consumed_by_activity_id != expected_activity_id
        or activity_identity != expected_transition_activity
    ):
        return "fresh_read_audit_binding_invalid"
    expected_evidence_refs = list(capability_audit.input_evidence_refs)
    for evidence in capability_result.evidence:
        if evidence.evidence_id not in expected_evidence_refs:
            expected_evidence_refs.append(evidence.evidence_id)
    if capability_audit.evidence_refs != expected_evidence_refs:
        return "fresh_read_audit_result_evidence_mismatch"
    if (
        lease.consumed_action_id != receipt.action_id
        or lease.consumed_idempotency_key != receipt.idempotency_key
        or lease.consumed_request_hash != expected_request_hash
        or lease.consumed_result_hash != expected_result_hash
        or lease.consumed_audit_id != capability_audit.audit_id
        or lease.consumed_card_version is None
    ):
        return "fresh_read_audit_provenance_invalid"
    return None


def _fresh_read_result_lineage_error(
    capability_result: CapabilityResult, capability_audit: CapabilityAuditRecord,
) -> Optional[str]:
    """Require each fresh domain record to cite the exact authorized evidence set."""
    evidence_ids = [item.evidence_id for item in capability_result.evidence]
    claim_ids = [item.claim_id for item in capability_result.claims]
    if len(evidence_ids) != len(set(evidence_ids)) or len(claim_ids) != len(set(claim_ids)):
        return "fresh_read_result_duplicate_identity"
    authorized_ids = set(capability_audit.input_evidence_refs)
    coverage_keys = set()
    for evidence in capability_result.evidence:
        if evidence.evidence_id in evidence.parent_evidence_ids:
            return "fresh_read_result_lineage_invalid"
        if not set(evidence.parent_evidence_ids).issubset(authorized_ids):
            return "fresh_read_result_lineage_invalid"
        authorized_ids.add(evidence.evidence_id)
    for claim in capability_result.claims:
        if not set(claim.evidence_ids).issubset(authorized_ids):
            return "fresh_read_result_lineage_invalid"
    for coverage in capability_result.coverage:
        key = (coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value)
        if key in coverage_keys or not set(coverage.evidence_ids).issubset(authorized_ids):
            return "fresh_read_result_lineage_invalid"
        coverage_keys.add(key)
    return None


def validate_fresh_read_evidence_admission(
    capability_result: CapabilityResult,
    capability_audit: CapabilityAuditRecord,
    binding: IncidentRunBinding,
    immutable_input_evidence: Dict[str, EvidenceEnvelope],
) -> None:
    """Validate the full current-proof evidence DAG before either repository mutates.

    Gate 1 admits only current, subject-authorized evidence.  A parent can be
    an immutable input selected by the authoritative projection or an earlier
    record in this ordered result.  It may never be a forward reference, a
    cycle, or an arbitrary row that happens to be in storage.
    """
    if (
        capability_audit.data_class != CapabilityDataClass.CURRENT_INCIDENT
        or capability_audit.subject_id == ""
        or _workspace_binding_tuple(capability_audit) != _workspace_binding_tuple(binding)
    ):
        raise PolicyViolation("fresh_read_evidence_admission_binding_invalid")
    input_ids = list(capability_audit.input_evidence_refs)
    if len(input_ids) != len(set(input_ids)) or set(input_ids) != set(immutable_input_evidence):
        raise PolicyViolation("fresh_read_evidence_input_set_invalid")

    def validate_scope(evidence: EvidenceEnvelope) -> None:
        validate_evidence_admission(evidence, capability_audit.subject_id)
        if (
            evidence.tenant_id != binding.tenant_id
            or evidence.case_id != binding.case_id
            or evidence.case_revision != binding.case_revision
            or evidence.proof_scope != ProofScope.CURRENT_OBSERVATION
            or evidence.freshness != FreshnessStatus.CURRENT
            or evidence.authority not in {EvidenceAuthority.T0, EvidenceAuthority.T1}
        ):
            raise PolicyViolation("fresh_read_evidence_scope_or_current_proof_invalid")

    admitted: Dict[str, EvidenceEnvelope] = {}
    for evidence_id in input_ids:
        evidence = immutable_input_evidence[evidence_id]
        if evidence.evidence_id != evidence_id:
            raise PolicyViolation("fresh_read_evidence_input_identity_invalid")
        validate_scope(evidence)
        admitted[evidence_id] = evidence

    output_ids = set()
    for evidence in capability_result.evidence:
        if evidence.evidence_id in output_ids or evidence.evidence_id in admitted:
            raise PolicyViolation("fresh_read_evidence_duplicate_identity")
        validate_scope(evidence)
        if evidence.evidence_id in evidence.parent_evidence_ids:
            raise PolicyViolation("fresh_read_evidence_parent_self_reference")
        if not set(evidence.parent_evidence_ids).issubset(admitted):
            raise PolicyViolation("fresh_read_evidence_parent_not_earlier_or_authorized")
        output_ids.add(evidence.evidence_id)
        admitted[evidence.evidence_id] = evidence

    claim_ids = set()
    for claim in capability_result.claims:
        if claim.claim_id in claim_ids:
            raise PolicyViolation("fresh_read_claim_duplicate_identity")
        if (
            claim.tenant_id != binding.tenant_id
            or claim.case_id != binding.case_id
            or claim.case_revision != binding.case_revision
            or not set(claim.evidence_ids).issubset(admitted)
        ):
            raise PolicyViolation("fresh_read_claim_lineage_invalid")
        validate_claim_evidence(
            claim, [admitted[evidence_id] for evidence_id in claim.evidence_ids], capability_audit.subject_id,
        )
        claim_ids.add(claim.claim_id)

    coverage_keys = set()
    for coverage in capability_result.coverage:
        key = (coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value)
        if (
            key in coverage_keys
            or coverage.tenant_id != binding.tenant_id
            or coverage.case_id != binding.case_id
            or not set(coverage.evidence_ids).issubset(admitted)
        ):
            raise PolicyViolation("fresh_read_coverage_lineage_invalid")
        coverage_keys.add(key)


def validate_workspace_action_commit_kind(commit: WorkspaceActionCommit) -> None:
    """Fail closed at repository boundaries even for constructed model instances."""
    error = _workspace_action_commit_kind_error(
        getattr(commit, "receipt", None), getattr(commit, "lease", None),
        getattr(commit, "actions", []), getattr(commit, "issued_action", None),
        getattr(commit, "capability_result", None), getattr(commit, "capability_audit", None),
        getattr(commit, "command_fingerprint", None), getattr(commit, "activity_identity", None),
    )
    if error is not None:
        raise PolicyViolation(error)


def validate_consumed_gate1_lease_transition(
    active_lease: Gate1Lease, consumed_lease: Gate1Lease, *, command_fingerprint: str,
    capability_audit: CapabilityAuditRecord, receipt: Optional[WorkspaceActionReceipt] = None,
    activity_identity: Optional[str] = None, capability_result: Optional[CapabilityResult] = None,
    read_card: Optional[NextBestAction] = None, now: Optional[datetime] = None,
) -> None:
    """Prove a proposed consumption is the one legal successor of the active lease.

    This pure check is used by both storage implementations while their
    authoritative active lease row is locked.  Building the expected record
    from that row prevents ``copy``/``construct`` callers from rebinding any
    immutable issuance, scope, evidence-set, or revision field.
    """
    if (
        not isinstance(active_lease, Gate1Lease)
        or not isinstance(consumed_lease, Gate1Lease)
        or not isinstance(capability_audit, CapabilityAuditRecord)
        or active_lease.status != Gate1LeaseStatus.ACTIVE
        or active_lease.consumed_by_activity_id is not None
        or active_lease.consumed_command_fingerprint is not None
        or active_lease.consumed_evidence_set_hash is not None
        or active_lease.consumed_evidence_revision is not None
    ):
        raise PolicyViolation("gate1_consumed_lease_transition_invalid")
    if now is not None and active_lease.expires_at.astimezone(timezone.utc) <= now.astimezone(timezone.utc):
        raise PolicyViolation("gate1_consumed_lease_expired")
    try:
        evidence_set_hash = canonical_evidence_set_hash(list(capability_audit.input_evidence_refs))
    except (PolicyViolation, TypeError):
        raise PolicyViolation("gate1_consumed_lease_transition_invalid")
    if evidence_set_hash != active_lease.evidence_set_hash:
        raise PolicyViolation("gate1_consumed_lease_transition_invalid")
    expected_updates = {
        "lease_revision": active_lease.lease_revision + 1,
        "status": Gate1LeaseStatus.CONSUMED,
        "consumed_by_activity_id": capability_audit.activity_id,
        "consumed_command_fingerprint": command_fingerprint,
        "consumed_evidence_set_hash": evidence_set_hash,
        "consumed_evidence_revision": active_lease.evidence_revision,
    }
    if receipt is not None and capability_result is not None and read_card is not None:
        try:
            result_hash = canonical_capability_result_hash(capability_result)
        except PolicyViolation:
            raise PolicyViolation("gate1_consumed_lease_transition_invalid")
        expected_updates.update({
            "consumed_action_id": receipt.action_id,
            "consumed_card_version": read_card.card_version,
            "consumed_idempotency_key": receipt.idempotency_key,
            "consumed_request_hash": capability_audit.request_hash,
            "consumed_result_hash": result_hash,
            "consumed_audit_id": capability_audit.audit_id,
        })
        expected_activity = "workspace-action:{}:{}".format(active_lease.workflow_run_id, command_fingerprint)
        if activity_identity != expected_activity:
            raise PolicyViolation("gate1_consumed_lease_transition_invalid")
    expected = active_lease.copy(update=expected_updates)
    if consumed_lease != expected:
        raise PolicyViolation("gate1_consumed_lease_transition_invalid")


def validate_authoritative_gate1_read_card(
    active_lease: Gate1Lease, grant: Optional[WorkspaceActionCommit], commit: WorkspaceActionCommit,
    now: Optional[datetime] = None,
) -> NextBestAction:
    """Bind a consumption to the exact read card durably emitted by its grant."""
    validate_gate1_issuance_binding(active_lease, grant)
    if not active_lease.capability_version or grant is None:
        raise PolicyViolation("gate1_authoritative_read_card_missing")
    read_cards = [
        card for card in grant.actions
        if card.cta == NextBestActionCta.RUN_READ_CAPABILITY and card.gate1_lease_id == active_lease.lease_id
    ]
    if len(read_cards) != 1:
        raise PolicyViolation("gate1_authoritative_read_card_missing")
    card = read_cards[0]
    if now is not None and (
        active_lease.expires_at.astimezone(timezone.utc) <= now.astimezone(timezone.utc)
        or card.expires_at.astimezone(timezone.utc) <= now.astimezone(timezone.utc)
    ):
        raise PolicyViolation("gate1_authoritative_read_card_expired")
    if (
        _workspace_binding_tuple(card) != _workspace_binding_tuple(active_lease)
        or card.projection_revision != active_lease.projection_revision
        or card.evidence_revision != active_lease.evidence_revision
        or card.component_id != active_lease.component_id
        or card.capability != active_lease.capability
        or card.capability_version != active_lease.capability_version
        or card.data_class != active_lease.data_class
        or card.required_gate != CapabilityGate.GATE1.value
        or card.tool_schema_version != active_lease.tool_schema_version
        or card.capability_registry_revision != active_lease.capability_registry_revision
        or card.precondition_version != active_lease.precondition_version
        or card.precondition_hash != active_lease.precondition_hash
        or commit.receipt.action_id != card.action_id
        or commit.lease is None
        or commit.lease.consumed_action_id != card.action_id
        or commit.lease.consumed_card_version != card.card_version
        or commit.lease.consumed_idempotency_key != commit.receipt.idempotency_key
    ):
        raise PolicyViolation("gate1_authoritative_read_card_mismatch")
    command = ActionInvocationCommand(
        incident_id=card.incident_id, run_id=card.run_id, topology_revision=card.topology_revision,
        projection_revision=card.projection_revision, action_id=card.action_id,
        idempotency_key=commit.receipt.idempotency_key,
    )
    expected_fingerprint = command.canonical_hash()
    if (
        commit.command_fingerprint != expected_fingerprint
        or commit.lease.consumed_command_fingerprint != expected_fingerprint
        or commit.activity_identity != "workspace-action:{}:{}".format(card.workflow_run_id, expected_fingerprint)
        or commit.capability_audit is None
        or commit.capability_audit.activity_id != "workspace-gate1:{}:{}:{}".format(
            card.workflow_run_id, card.action_id, commit.receipt.idempotency_key,
        )
    ):
        raise PolicyViolation("gate1_authoritative_read_card_mismatch")
    return card


def validate_authoritative_fresh_read_transition(
    prior_projection: IncidentProjection, active_lease: Gate1Lease,
    grant: Optional[WorkspaceActionCommit], commit: WorkspaceActionCommit,
    now: Optional[datetime] = None,
) -> NextBestAction:
    """Derive the only fresh-read successor from locked Gate 1 authority.

    The activity may acquire source data, but it is not allowed to author a
    lifecycle result.  This check deliberately reconstructs every
    non-evidence artifact from the locked projection, immutable grant, and
    read card.  Both repositories invoke it before any mutation and again at
    the final commit boundary, so ``copy`` or ``construct`` callers cannot
    smuggle a plausible projection, receipt, event, or outbox payload through
    after the source phase has completed.
    """
    if (
        not isinstance(prior_projection, IncidentProjection)
        or not isinstance(commit.projection, IncidentProjection)
        or not isinstance(commit.receipt, WorkspaceActionReceipt)
        or not isinstance(commit.event, IncidentEvent)
        or commit.receipt.status != "FRESH_READ_COMPLETED"
        or commit.capability_result is None
        or commit.capability_audit is None
    ):
        raise PolicyViolation("fresh_read_projection_successor_invalid")
    # ``BaseModel.copy``/``construct`` can carry an undeclared field even
    # though ordinary request parsing has ``extra=forbid``.  A fresh-read
    # successor is exactly the declared projection model; it may not include
    # a caller-authored diagnosis/verifier/success field.
    if set(commit.projection.__dict__) != set(IncidentProjection.__fields__):
        raise PolicyViolation("fresh_read_projection_successor_invalid")
    if _workspace_binding_tuple(prior_projection) != _workspace_binding_tuple(active_lease):
        raise PolicyViolation("fresh_read_projection_successor_invalid")
    read_card = validate_authoritative_gate1_read_card(active_lease, grant, commit, now)
    validate_consumed_gate1_lease_transition(
        active_lease, commit.lease, command_fingerprint=commit.command_fingerprint,
        capability_audit=commit.capability_audit, receipt=commit.receipt,
        activity_identity=commit.activity_identity, capability_result=commit.capability_result,
        read_card=read_card, now=now,
    )
    evidence_refs = list(prior_projection.evidence_refs)
    for evidence in commit.capability_result.evidence:
        if evidence.evidence_id not in evidence_refs:
            evidence_refs.append(evidence.evidence_id)
    expected_projection = prior_projection.copy(update={
        "projection_revision": prior_projection.projection_revision + 1,
        "sequence": prior_projection.sequence + 1,
        "evidence_revision": prior_projection.evidence_revision + 1,
        "action_revision": prior_projection.action_revision + 1,
        # The transition timestamp is not lifecycle truth.  It is retained
        # only as the activity's append timestamp while every semantic field
        # is copied from the locked predecessor.
        "generated_at": commit.projection.generated_at,
        "evidence_refs": evidence_refs,
    })
    if commit.projection != expected_projection:
        raise PolicyViolation("fresh_read_projection_successor_invalid")
    expected_receipt = WorkspaceActionReceipt(
        **{name: getattr(prior_projection, name) for name in IncidentRunBinding.__fields__},
        action_id=read_card.action_id,
        idempotency_key=commit.receipt.idempotency_key,
        status="FRESH_READ_COMPLETED",
        gate1_lease_id=active_lease.lease_id,
        reason="temporal_gate1_bound_read_completed",
        external_write_performed=False,
    )
    if commit.receipt != expected_receipt:
        raise PolicyViolation("fresh_read_receipt_successor_invalid")
    expected_event = IncidentEvent(
        **{name: getattr(prior_projection, name) for name in IncidentRunBinding.__fields__},
        projection_revision=expected_projection.projection_revision,
        sequence=expected_projection.sequence,
        event_type="workspace.action.fresh_read_completed",
        occurred_at=commit.event.occurred_at,
        payload={
            "action_id": expected_receipt.action_id,
            "idempotency_key": expected_receipt.idempotency_key,
            "command_fingerprint": commit.command_fingerprint,
            "activity_identity": commit.activity_identity,
        },
        evidence_refs=evidence_refs,
    )
    if commit.event != expected_event:
        raise PolicyViolation("fresh_read_event_successor_invalid")
    return read_card


def validate_authoritative_gate1_grant_transition(
    prior_projection: IncidentProjection,
    stored_card: Optional[NextBestAction],
    subject_grant: Optional[WorkspaceSubjectGrant],
    capability_registry: Any,
    commit: WorkspaceActionCommit,
    now: datetime,
) -> None:
    """Derive one Gate 1 lease from the locked projection, card, grant, and registry.

    This intentionally does not trust the transition payload as an authority.
    Both repositories call it while holding their mapping lock, before an
    append-only projection, lease, card, receipt, event, or outbox row exists.
    """
    lease = commit.lease
    if (
        commit.receipt.status != "GATE1_GRANTED"
        or lease is None
        or lease.status != Gate1LeaseStatus.ACTIVE
        or lease.lease_revision != 1
        or stored_card is None
        or commit.issued_action != stored_card
        or capability_registry is None
    ):
        raise PolicyViolation("gate1_grant_authority_unavailable_or_invalid")
    if (
        subject_grant is None
        or (subject_grant.tenant_id, subject_grant.case_id, subject_grant.subject_id)
        != (prior_projection.tenant_id, prior_projection.case_id, lease.subject_id)
        or not set(subject_grant.roles).intersection(WORKSPACE_READ_ROLES)
        or subject_grant.permissions != workspace_permissions_for_roles(subject_grant.roles)
    ):
        raise PolicyViolation("gate1_grant_subject_permission_not_authoritative")
    command = ActionInvocationCommand(
        incident_id=stored_card.incident_id, run_id=stored_card.run_id,
        topology_revision=stored_card.topology_revision,
        projection_revision=stored_card.projection_revision,
        action_id=stored_card.action_id, idempotency_key=commit.receipt.idempotency_key,
    )
    command_fingerprint = command.canonical_hash()
    try:
        validate_current_action_card(
            stored_card, prior_projection, command, subject_grant.permissions, now,
        )
    except PolicyViolation as error:
        raise PolicyViolation("gate1_grant_stored_card_not_authoritative") from error
    descriptor = next(
        (
            item for item in capability_registry.available(CapabilityAudience.USER_QA)
            if item.capability.value == stored_card.capability
        ),
        None,
    )
    if (
        descriptor is None
        or not descriptor.fresh_read
        or descriptor.required_gate != CapabilityGate.GATE1
        or descriptor.version != stored_card.capability_version
        or descriptor.input_schema != stored_card.tool_schema_version
        or stored_card.data_class not in {item.value for item in descriptor.data_classes}
        or stored_card.required_gate != CapabilityGate.GATE1.value
        or stored_card.capability_registry_revision != capability_registry.policy_version
    ):
        raise PolicyViolation("gate1_grant_descriptor_not_authoritative")
    # The card is an authoritative server artifact, not merely a row with a
    # familiar shape.  Rebuild its fixed taxonomy/title/CTA/version/scope from
    # the locked projection and registered descriptor at the only timestamp
    # derivable from the card itself.  This prevents a direct repository
    # caller from first appending a plausible-but-unissued request card.
    expected_gate_cards = NextBestActionGenerator(
        capability_registry, registry_revision=capability_registry.policy_version,
    ).generate(prior_projection, stored_card.expires_at - GATE1_LEASE_TTL)
    if stored_card not in expected_gate_cards:
        raise PolicyViolation("gate1_grant_stored_card_not_authoritative")
    expected_projection = prior_projection.copy(update={
        "projection_revision": prior_projection.projection_revision + 1,
        "sequence": prior_projection.sequence + 1,
        "gate_revision": prior_projection.gate_revision + 1,
        "action_revision": prior_projection.action_revision + 1,
        "generated_at": commit.projection.generated_at,
    })
    if commit.projection != expected_projection:
        raise PolicyViolation("gate1_grant_projection_successor_invalid")
    if (
        commit.command_fingerprint != command_fingerprint
        or commit.activity_identity != "workspace-action:{}:{}".format(
            prior_projection.workflow_run_id, command_fingerprint,
        )
        or commit.receipt.action_id != stored_card.action_id
        or commit.receipt.idempotency_key != command.idempotency_key
        or commit.receipt.gate1_lease_id != "gate1-" + command_fingerprint
        or commit.receipt.external_write_performed
    ):
        raise PolicyViolation("gate1_grant_command_or_receipt_not_authoritative")
    if (
        lease.issued_at.astimezone(timezone.utc) > now.astimezone(timezone.utc)
        or lease.expires_at.astimezone(timezone.utc) <= now.astimezone(timezone.utc)
        or lease.expires_at.astimezone(timezone.utc) != lease.issued_at.astimezone(timezone.utc) + GATE1_LEASE_TTL
    ):
        raise PolicyViolation("gate1_grant_lease_ttl_invalid")
    expected_lease = Gate1Lease(
        **{name: getattr(commit.projection, name) for name in IncidentRunBinding.__fields__},
        lease_id="gate1-" + command_fingerprint, lease_revision=1,
        subject_id=subject_grant.subject_id, required_permission=stored_card.required_permission,
        component_id=stored_card.component_id, capability=descriptor.capability.value,
        capability_version=descriptor.version, data_class=stored_card.data_class,
        tool_schema_version=descriptor.input_schema,
        projection_revision=commit.projection.projection_revision,
        evidence_revision=commit.projection.evidence_revision,
        capability_registry_revision=capability_registry.policy_version,
        precondition_version=stored_card.precondition_version,
        precondition_hash=NextBestActionGenerator._precondition_hash(commit.projection),
        issuance_command_fingerprint=command_fingerprint,
        issuance_action_id=stored_card.action_id,
        issuance_card_version=stored_card.card_version,
        issuance_idempotency_key=command.idempotency_key,
        evidence_set_hash=canonical_evidence_set_hash(list(commit.projection.evidence_refs)),
        issued_at=lease.issued_at, expires_at=lease.expires_at,
        status=Gate1LeaseStatus.ACTIVE,
    )
    if lease != expected_lease:
        raise PolicyViolation("gate1_grant_lease_not_authoritative")
    expected_actions = NextBestActionGenerator(
        capability_registry, registry_revision=capability_registry.policy_version,
    ).generate_after_gate1(commit.projection, expected_lease, expected_lease.issued_at)
    if commit.actions != expected_actions:
        raise PolicyViolation("gate1_grant_read_card_not_authoritative")
    if (
        commit.event.projection_revision != commit.projection.projection_revision
        or commit.event.sequence != commit.projection.sequence
        or commit.event.event_type != "workspace.action.gate1_granted"
        or commit.event.payload.get("action_id") != commit.receipt.action_id
        or commit.event.payload.get("idempotency_key") != commit.receipt.idempotency_key
        or commit.event.payload.get("command_fingerprint") != command_fingerprint
        or commit.event.payload.get("activity_identity") != commit.activity_identity
    ):
        raise PolicyViolation("gate1_grant_event_not_authoritative")


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

"""Append-only workspace projections used by Temporal activities and API reads."""

import copy
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Tuple
from uuid import uuid4

from .capabilities import CapabilityAuditRecord
from .models import AuthCommandIntent, AuthCommandKind, AuthContext

from .policy import PolicyViolation
from .workspace_models import IncidentEvent, IncidentProjection, IncidentRunBinding, NodeExplanation, NodeExplanationStart
from .workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    NextBestAction,
    WorkspaceSubjectGrant,
    WorkspaceActionCommit,
    WorkspaceActionReceipt,
    validate_authoritative_gate1_read_card,
    validate_authoritative_gate1_grant_transition,
    validate_consumed_gate1_lease_transition,
    validate_fresh_read_evidence_admission,
    validate_workspace_action_commit_kind,
)


BindingKey = Tuple[str, str, str]


def _binding_key(item: IncidentRunBinding) -> BindingKey:
    return (item.tenant_id, item.run_id, item.topology_revision)


def _same_binding(left: IncidentRunBinding, right: IncidentRunBinding) -> bool:
    return (
        left.tenant_id, left.incident_id, left.run_id, left.topology_revision,
        left.case_id, left.case_revision, left.workflow_id, left.workflow_run_id,
    ) == (
        right.tenant_id, right.incident_id, right.run_id, right.topology_revision,
        right.case_id, right.case_revision, right.workflow_id, right.workflow_run_id,
    )


class InMemoryWorkspaceRepository:
    """Deterministic test/query projection; it never advances workflow state."""

    def __init__(
        self, failure_injector: Optional[Callable[[str], None]] = None, now: Optional[Callable[[], datetime]] = None,
    ) -> None:
        self.bindings: Dict[BindingKey, IncidentRunBinding] = {}
        self.projections: Dict[BindingKey, List[IncidentProjection]] = defaultdict(list)
        self.events: Dict[BindingKey, List[IncidentEvent]] = defaultdict(list)
        self.explanations: Dict[str, NodeExplanation] = {}
        self.explanation_by_selection: Dict[str, str] = {}
        self.capability_audits: Dict[object, CapabilityAuditRecord] = {}
        self.workspace_subject_grants: Dict[Tuple[str, str, str], WorkspaceSubjectGrant] = {}
        self.workspace_auth_intents: Dict[str, AuthCommandIntent] = {}
        self.gate1_leases: Dict[Tuple[str, str, str], List[Gate1Lease]] = defaultdict(list)
        self.next_best_actions: Dict[Tuple[str, str, str], NextBestAction] = {}
        self.workspace_action_receipts: Dict[Tuple[str, str, str], WorkspaceActionReceipt] = {}
        self.workspace_action_idempotency: Dict[Tuple[str, str, str], str] = {}
        self.workspace_action_commits: Dict[Tuple[str, str, str], WorkspaceActionCommit] = {}
        self.workspace_action_evidence = {}
        self.workspace_action_claims = {}
        self.workspace_action_coverage = {}
        # Test-only seam: a checkpoint raises inside the same in-memory
        # transaction simulation and restores every append-only collection.
        self.failure_injector = failure_injector
        self.workspace_capability_registry = None
        self._now = now or (lambda: datetime.now(timezone.utc))

    def configure_workspace_capability_registry(self, registry) -> None:
        """Install the worker's read-only registry for repository-side Gate checks."""
        if (
            self.workspace_capability_registry is not None
            and self.workspace_capability_registry is not registry
            and self.workspace_capability_registry.policy_version != registry.policy_version
        ):
            raise PolicyViolation("workspace_capability_registry_rebind_forbidden")
        self.workspace_capability_registry = registry

    async def put_binding(self, binding: IncidentRunBinding) -> IncidentRunBinding:
        key = _binding_key(binding)
        existing = self.bindings.get(key)
        if existing is not None and not _same_binding(existing, binding):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        for current_key, current in self.bindings.items():
            if current.tenant_id == binding.tenant_id and current.case_id == binding.case_id and (
                current.workflow_id != binding.workflow_id or current.workflow_run_id != binding.workflow_run_id
            ):
                raise PolicyViolation("workspace_case_rebound_to_different_temporal_run")
            if current.tenant_id == binding.tenant_id and current.run_id == binding.run_id and current_key != key:
                raise PolicyViolation("workspace_run_rebound_to_different_topology")
        self.bindings[key] = binding
        return binding

    put_workspace_binding = put_binding

    async def grant_workspace_subject(
        self, binding: IncidentRunBinding, subject_id: str, roles=None, permissions=None,
    ) -> None:
        stored = await self.get_binding(binding.tenant_id, binding.case_id)
        if stored != binding:
            raise PolicyViolation("workspace_subject_grant_binding_mismatch")
        grant = WorkspaceSubjectGrant(
            tenant_id=binding.tenant_id, case_id=binding.case_id, subject_id=subject_id,
            roles=list(roles or []), permissions=list(permissions or []), created_at=binding.created_at,
        )
        key = (binding.tenant_id, binding.case_id, subject_id)
        existing = self.workspace_subject_grants.get(key)
        if existing is not None and existing != grant:
            raise PolicyViolation("workspace_subject_grant_immutable")
        self.workspace_subject_grants[key] = grant

    async def workspace_subject_authorized(self, tenant_id: str, case_id: str, subject_id: str) -> bool:
        return (tenant_id, case_id, subject_id) in self.workspace_subject_grants

    async def workspace_subject_grant(
        self, tenant_id: str, case_id: str, subject_id: str,
    ) -> Optional[WorkspaceSubjectGrant]:
        return self.workspace_subject_grants.get((tenant_id, case_id, subject_id))

    async def get_binding(self, tenant_id: str, case_id: str) -> Optional[IncidentRunBinding]:
        for item in self.bindings.values():
            if item.tenant_id == tenant_id and item.case_id == case_id:
                return item
        return None

    async def get_binding_by_public_identity(
        self, tenant_id: str, incident_id: str, run_id: str, topology_revision: str,
    ) -> Optional[IncidentRunBinding]:
        item = self.bindings.get((tenant_id, run_id, topology_revision))
        return item if item is not None and item.incident_id == incident_id else None

    async def put_projection(self, projection: IncidentProjection) -> IncidentProjection:
        key = _binding_key(projection)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        records = self.projections[key]
        if records:
            latest = records[-1]
            if projection.projection_revision <= latest.projection_revision or projection.sequence <= latest.sequence:
                if projection == latest:
                    return latest
                raise PolicyViolation("workspace_projection_revision_or_sequence_not_monotonic")
        records.append(projection)
        return projection

    put_workspace_projection = put_projection

    async def get_projection(self, tenant_id: str, case_id: str) -> Optional[IncidentProjection]:
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None:
            return None
        records = self.projections.get(_binding_key(binding), [])
        return records[-1] if records else None

    workspace_projection = get_projection

    async def create_workspace_node_explanation_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: NodeExplanationStart,
    ) -> AuthCommandIntent:
        binding = await self.get_binding(actor.tenant_id, projection.case_id)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_authorization_binding_not_authoritative")
        current = await self.get_projection(actor.tenant_id, projection.case_id)
        if current != projection:
            raise PolicyViolation("workspace_authorization_projection_not_authoritative")
        if (
            command.incident_id != binding.incident_id or command.run_id != binding.run_id
            or command.topology_revision != binding.topology_revision
            or command.projection_revision != projection.projection_revision
            or command.component_id not in {node.component_id for node in projection.graph.nodes}
        ):
            raise PolicyViolation("workspace_authorization_command_scope_mismatch")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_authorization_subject_acl_denied")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_NODE_EXPLANATION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_component_id=command.component_id, workspace_command_hash=command.canonical_hash(),
        )
        self.workspace_auth_intents[intent.intent_id] = intent
        return intent

    async def append_event(self, event: IncidentEvent) -> IncidentEvent:
        key = _binding_key(event)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, event):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        records = self.events[key]
        if records and event.sequence <= records[-1].sequence:
            prior = next((item for item in records if item.sequence == event.sequence), None)
            if prior is not None and prior.copy(update={"occurred_at": event.occurred_at}) == event:
                return prior
            raise PolicyViolation("workspace_event_sequence_not_monotonic")
        records.append(event)
        return event

    append_workspace_event = append_event

    async def events_after(self, tenant_id: str, case_id: str, after: int) -> List[IncidentEvent]:
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None:
            return []
        return [event for event in self.events.get(_binding_key(binding), []) if event.sequence > after]

    workspace_events_after = events_after

    async def start_or_reuse_explanation(self, explanation: NodeExplanation) -> Tuple[NodeExplanation, bool]:
        key = _binding_key(explanation)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, explanation):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        existing_id = self.explanation_by_selection.get(explanation.selection_key)
        if existing_id is not None:
            return self.explanations[existing_id], True
        self.explanations[explanation.explanation_id] = explanation
        self.explanation_by_selection[explanation.selection_key] = explanation.explanation_id
        return explanation, False

    start_or_reuse_workspace_explanation = start_or_reuse_explanation

    async def get_explanation(self, tenant_id: str, case_id: str, explanation_id: str) -> Optional[NodeExplanation]:
        explanation = self.explanations.get(explanation_id)
        if explanation is None:
            return None
        binding = await self.get_binding(tenant_id, case_id)
        if binding is None or not _same_binding(binding, explanation):
            return None
        return explanation

    workspace_explanation = get_explanation

    async def append_gate1_lease(self, lease: Gate1Lease) -> Gate1Lease:
        """Append a Temporal-derived lease revision; never overwrite a grant."""
        binding = self.bindings.get(_binding_key(lease))
        if binding is None or not _same_binding(binding, lease):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        key = (lease.tenant_id, lease.case_id, lease.lease_id)
        records = self.gate1_leases[key]
        if records:
            latest = records[-1]
            if lease.lease_revision <= latest.lease_revision:
                if lease == latest:
                    return latest
                raise PolicyViolation("gate1_lease_revision_not_monotonic")
        records.append(lease)
        return lease

    async def workspace_gate1_lease(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[Gate1Lease]:
        records = self.gate1_leases.get((tenant_id, case_id, lease_id), [])
        return records[-1] if records else None

    async def workspace_gate1_grant_transition(
        self, tenant_id: str, case_id: str, lease_id: str,
    ) -> Optional[WorkspaceActionCommit]:
        grants = [
            commit for commit in self.workspace_action_commits.values()
            if (
                commit.receipt.tenant_id == tenant_id
                and commit.receipt.case_id == case_id
                and commit.receipt.status == "GATE1_GRANTED"
                and commit.lease is not None
                and commit.lease.lease_id == lease_id
            )
        ]
        if len(grants) > 1:
            raise PolicyViolation("gate1_lease_grant_transition_ambiguous")
        return grants[0] if grants else None

    async def append_next_best_action(self, action: NextBestAction) -> NextBestAction:
        binding = self.bindings.get(_binding_key(action))
        if binding is None or not _same_binding(binding, action):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        key = (action.tenant_id, action.case_id, action.action_id)
        existing = self.next_best_actions.get(key)
        if existing is not None and existing != action:
            raise PolicyViolation("next_best_action_immutable")
        self.next_best_actions[key] = action
        return action

    async def workspace_next_best_action(
        self, tenant_id: str, case_id: str, action_id: str,
    ) -> Optional[NextBestAction]:
        return self.next_best_actions.get((tenant_id, case_id, action_id))

    async def workspace_next_best_actions(self, tenant_id: str, case_id: str) -> List[NextBestAction]:
        return sorted(
            [item for (item_tenant, item_case, _), item in self.next_best_actions.items()
             if (item_tenant, item_case) == (tenant_id, case_id)],
            key=lambda item: item.display_order,
        )

    async def create_workspace_action_intent(
        self, actor: AuthContext, projection: IncidentProjection, command: ActionInvocationCommand,
    ) -> AuthCommandIntent:
        binding = await self.get_binding(actor.tenant_id, projection.case_id)
        action = await self.workspace_next_best_action(actor.tenant_id, projection.case_id, command.action_id)
        if binding is None or not _same_binding(binding, projection):
            raise PolicyViolation("workspace_action_binding_not_authoritative")
        current = await self.get_projection(actor.tenant_id, projection.case_id)
        if current != projection:
            raise PolicyViolation("workspace_action_projection_not_authoritative")
        if action is None:
            raise PolicyViolation("workspace_action_not_found")
        if not await self.workspace_subject_authorized(actor.tenant_id, projection.case_id, actor.subject_id):
            raise PolicyViolation("workspace_action_subject_acl_denied")
        if (
            command.incident_id != binding.incident_id or command.run_id != binding.run_id
            or command.topology_revision != binding.topology_revision
            or command.projection_revision != projection.projection_revision
        ):
            raise PolicyViolation("workspace_action_command_scope_mismatch")
        now = datetime.now(timezone.utc)
        intent = AuthCommandIntent(
            intent_id="workspace-action-intent-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            case_id=binding.case_id, case_revision=binding.case_revision, workflow_run_id=binding.workflow_run_id,
            subject_id=actor.subject_id, roles=actor.roles, created_at=now, expires_at=now + timedelta(minutes=1),
            command_kind=AuthCommandKind.WORKSPACE_ACTION,
            workspace_incident_id=binding.incident_id, workspace_run_id=binding.run_id,
            workspace_topology_revision=binding.topology_revision,
            workspace_projection_revision=projection.projection_revision,
            workspace_action_id=action.action_id, workspace_action_command_hash=command.canonical_hash(),
        )
        self.workspace_auth_intents[intent.intent_id] = intent
        return intent

    async def record_workspace_action_receipt(self, receipt: WorkspaceActionReceipt) -> WorkspaceActionReceipt:
        binding = self.bindings.get(_binding_key(receipt))
        if binding is None or not _same_binding(binding, receipt):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        identity_key = (receipt.tenant_id, receipt.case_id, receipt.idempotency_key)
        action_id = self.workspace_action_idempotency.get(identity_key)
        if action_id is not None and action_id != receipt.action_id:
            raise PolicyViolation("workspace_action_idempotency_conflict")
        key = (receipt.tenant_id, receipt.case_id, receipt.idempotency_key)
        existing = self.workspace_action_receipts.get(key)
        if existing is not None:
            if existing != receipt:
                raise PolicyViolation("workspace_action_receipt_immutable")
            return existing
        self.workspace_action_idempotency[identity_key] = receipt.action_id
        self.workspace_action_receipts[key] = receipt
        return receipt

    async def workspace_action_receipt(
        self, tenant_id: str, case_id: str, idempotency_key: str,
    ) -> Optional[WorkspaceActionReceipt]:
        return self.workspace_action_receipts.get((tenant_id, case_id, idempotency_key))

    def _action_checkpoint(self, checkpoint: str) -> None:
        if self.failure_injector is not None:
            self.failure_injector(checkpoint)

    async def workspace_action_commit(
        self, tenant_id: str, case_id: str, idempotency_key: str,
    ) -> Optional[WorkspaceActionCommit]:
        key = (tenant_id, case_id, idempotency_key)
        commit = self.workspace_action_commits.get(key)
        receipt = self.workspace_action_receipts.get(key)
        if commit is None:
            if receipt is not None:
                raise PolicyViolation("workspace_action_transition_partial")
            return None
        validate_workspace_action_commit_kind(commit)
        if receipt != commit.receipt:
            raise PolicyViolation("workspace_action_transition_partial")
        if self.projections.get(_binding_key(commit.projection), [])[-1] != commit.projection:
            raise PolicyViolation("workspace_action_transition_partial")
        events = self.events.get(_binding_key(commit.event), [])
        if commit.event not in events:
            raise PolicyViolation("workspace_action_transition_partial")
        if commit.lease is not None:
            latest = await self.workspace_gate1_lease(
                commit.lease.tenant_id, commit.lease.case_id, commit.lease.lease_id,
            )
            if latest != commit.lease:
                raise PolicyViolation("workspace_action_transition_partial")
        if commit.issued_action is not None:
            if await self.workspace_next_best_action(
                commit.issued_action.tenant_id, commit.issued_action.case_id, commit.issued_action.action_id,
            ) != commit.issued_action:
                raise PolicyViolation("workspace_action_transition_partial")
        if commit.capability_result is not None:
            audit = commit.capability_audit
            if audit is None or self.capability_audits.get(audit.audit_id) != audit:
                raise PolicyViolation("workspace_action_transition_partial")
            immutable_input_evidence = {
                evidence_id: self.workspace_action_evidence[evidence_id]
                for evidence_id in audit.input_evidence_refs
                if evidence_id in self.workspace_action_evidence
            }
            try:
                validate_fresh_read_evidence_admission(
                    commit.capability_result, audit, commit.projection, immutable_input_evidence,
                )
            except PolicyViolation as error:
                raise PolicyViolation("workspace_action_transition_partial") from error
            for evidence in commit.capability_result.evidence:
                if self.workspace_action_evidence.get(evidence.evidence_id) != evidence:
                    raise PolicyViolation("workspace_action_transition_partial")
            for claim in commit.capability_result.claims:
                if self.workspace_action_claims.get(claim.claim_id) != claim:
                    raise PolicyViolation("workspace_action_transition_partial")
            for coverage in commit.capability_result.coverage:
                key = (coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value)
                if self.workspace_action_coverage.get(key) != coverage:
                    raise PolicyViolation("workspace_action_transition_partial")
        for action in commit.actions:
            if await self.workspace_next_best_action(action.tenant_id, action.case_id, action.action_id) != action:
                raise PolicyViolation("workspace_action_transition_partial")
        return commit

    async def commit_workspace_action_transition(self, commit: WorkspaceActionCommit) -> WorkspaceActionCommit:
        """Atomically append projection, optional lease/cards, receipt, event, and outbox record."""
        validate_workspace_action_commit_kind(commit)
        key = (commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.idempotency_key)
        existing = await self.workspace_action_commit(*key)
        if existing is not None:
            if existing != commit:
                raise PolicyViolation("workspace_action_idempotency_conflict")
            return existing
        snapshots = {
            "projections": copy.deepcopy(self.projections),
            "gate1_leases": copy.deepcopy(self.gate1_leases),
            "next_best_actions": copy.deepcopy(self.next_best_actions),
            "workspace_action_receipts": copy.deepcopy(self.workspace_action_receipts),
            "workspace_action_idempotency": copy.deepcopy(self.workspace_action_idempotency),
            "events": copy.deepcopy(self.events),
            "workspace_action_commits": copy.deepcopy(self.workspace_action_commits),
            "workspace_action_evidence": copy.deepcopy(self.workspace_action_evidence),
            "workspace_action_claims": copy.deepcopy(self.workspace_action_claims),
            "workspace_action_coverage": copy.deepcopy(self.workspace_action_coverage),
            "capability_audits": copy.deepcopy(self.capability_audits),
        }
        try:
            if commit.issued_action is not None:
                if _binding_key(commit.issued_action) != _binding_key(commit.projection):
                    raise PolicyViolation("workspace_action_transition_binding_mismatch")
                stored_action = await self.workspace_next_best_action(
                    commit.issued_action.tenant_id, commit.issued_action.case_id, commit.issued_action.action_id,
                )
                if stored_action != commit.issued_action:
                    raise PolicyViolation("workspace_action_issued_card_not_authoritative")
            if commit.lease is not None and commit.receipt.status == "GATE1_GRANTED":
                prior_projection = await self.get_projection(
                    commit.projection.tenant_id, commit.projection.case_id,
                )
                stored_card = await self.workspace_next_best_action(
                    commit.receipt.tenant_id, commit.receipt.case_id, commit.receipt.action_id,
                )
                subject_grant = await self.workspace_subject_grant(
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.subject_id,
                )
                if prior_projection is None:
                    raise PolicyViolation("gate1_grant_projection_not_found")
                validate_authoritative_gate1_grant_transition(
                    prior_projection, stored_card, subject_grant, self.workspace_capability_registry,
                    commit, self._now(),
                )
            if commit.lease is not None and commit.lease.status.value == "CONSUMED":
                active = await self.workspace_gate1_lease(
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.lease_id,
                )
                grant = await self.workspace_gate1_grant_transition(
                    commit.lease.tenant_id, commit.lease.case_id, commit.lease.lease_id,
                )
                if active is None:
                    raise PolicyViolation("gate1_lease_not_found")
                read_card = validate_authoritative_gate1_read_card(active, grant, commit, self._now())
                validate_consumed_gate1_lease_transition(
                    active, commit.lease, command_fingerprint=commit.command_fingerprint,
                    capability_audit=commit.capability_audit, receipt=commit.receipt,
                    activity_identity=commit.activity_identity, capability_result=commit.capability_result,
                    read_card=read_card, now=self._now(),
                )
            if commit.capability_result is not None:
                audit = commit.capability_audit
                if audit is None or _binding_key(audit) != _binding_key(commit.projection):
                    raise PolicyViolation("workspace_action_capability_binding_mismatch")
                input_evidence = {
                    evidence_id: self.workspace_action_evidence[evidence_id]
                    for evidence_id in audit.input_evidence_refs
                    if evidence_id in self.workspace_action_evidence
                }
                validate_fresh_read_evidence_admission(
                    commit.capability_result, audit, commit.projection, input_evidence,
                )
                for evidence in commit.capability_result.evidence:
                    if (
                        evidence.tenant_id, evidence.case_id, evidence.case_revision
                    ) != (
                        commit.projection.tenant_id, commit.projection.case_id, commit.projection.case_revision
                    ):
                        raise PolicyViolation("capability_result_evidence_scope_mismatch")
                    existing = self.workspace_action_evidence.get(evidence.evidence_id)
                    if existing is not None and existing != evidence:
                        raise PolicyViolation("evidence_id_immutable")
                    self.workspace_action_evidence[evidence.evidence_id] = evidence
                for claim in commit.capability_result.claims:
                    if (
                        claim.tenant_id, claim.case_id, claim.case_revision
                    ) != (
                        commit.projection.tenant_id, commit.projection.case_id, commit.projection.case_revision
                    ):
                        raise PolicyViolation("capability_result_claim_scope_mismatch")
                    existing = self.workspace_action_claims.get(claim.claim_id)
                    if existing is not None and existing != claim:
                        raise PolicyViolation("claim_record_immutable")
                    self.workspace_action_claims[claim.claim_id] = claim
                for coverage in commit.capability_result.coverage:
                    if (coverage.tenant_id, coverage.case_id) != (commit.projection.tenant_id, commit.projection.case_id):
                        raise PolicyViolation("capability_result_coverage_scope_mismatch")
                    coverage_key = (
                        coverage.tenant_id, coverage.case_id, coverage.field, coverage.status.value,
                    )
                    existing_coverage = self.workspace_action_coverage.get(coverage_key)
                    if existing_coverage is not None and existing_coverage != coverage:
                        raise PolicyViolation("workspace_action_coverage_immutable")
                    self.workspace_action_coverage[coverage_key] = coverage
                self._action_checkpoint("after_evidence_admission")
                await self.append_capability_audit(audit)
                self._action_checkpoint("after_audit")
            await self.put_workspace_projection(commit.projection)
            self._action_checkpoint("after_projection")
            if commit.lease is not None:
                await self.append_gate1_lease(commit.lease)
            self._action_checkpoint("after_lease")
            for action in commit.actions:
                await self.append_next_best_action(action)
            self._action_checkpoint("after_cards")
            await self.record_workspace_action_receipt(commit.receipt)
            self._action_checkpoint("after_receipt")
            await self.append_workspace_event(commit.event)
            self._action_checkpoint("after_event")
            self.workspace_action_commits[key] = commit
            self._action_checkpoint("after_transition")
            return commit
        except Exception:
            self.projections = snapshots["projections"]
            self.gate1_leases = snapshots["gate1_leases"]
            self.next_best_actions = snapshots["next_best_actions"]
            self.workspace_action_receipts = snapshots["workspace_action_receipts"]
            self.workspace_action_idempotency = snapshots["workspace_action_idempotency"]
            self.events = snapshots["events"]
            self.workspace_action_commits = snapshots["workspace_action_commits"]
            self.workspace_action_evidence = snapshots["workspace_action_evidence"]
            self.workspace_action_claims = snapshots["workspace_action_claims"]
            self.workspace_action_coverage = snapshots["workspace_action_coverage"]
            self.capability_audits = snapshots["capability_audits"]
            raise

    async def append_capability_audit(self, audit: CapabilityAuditRecord) -> CapabilityAuditRecord:
        """Append the shared capability audit under the immutable workspace binding."""
        key = _binding_key(audit)
        binding = self.bindings.get(key)
        if binding is None or not _same_binding(binding, audit):
            raise PolicyViolation("workspace_public_internal_binding_mismatch")
        existing = self.capability_audits.get(audit.audit_id)
        if existing is not None:
            if existing != audit:
                raise PolicyViolation("workspace_capability_audit_immutable")
            return existing
        self.capability_audits[audit.audit_id] = audit
        return audit

    append_workspace_capability_audit = append_capability_audit

"""Gate 1 is an exact Temporal lease, never a browser capability flag."""

import asyncio
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.capabilities import (
    CapabilityAudience,
    CapabilityDataClass,
    CapabilityDescriptor,
    CapabilityGate,
    CapabilityName,
    CapabilityRegistry,
    CapabilityRequest,
    CapabilityResult,
    CapabilityScope,
    canonical_capability_result_hash,
    deterministic_capability_audit_id,
    EmptyCapabilityInput,
    ToolCallBudget,
)
from pydantic import ValidationError

from flowpulse_cp.models import (
    ClaimRecord,
    CoverageEntry,
    CoverageStatus,
    EvidenceAuthority,
    EvidenceEnvelope,
    FreshnessStatus,
    ProofScope,
    SourceKind,
)
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.workspace_actions import (
    ActionInvocationCommand,
    Gate1Lease,
    Gate1LeaseAuthority,
    Gate1LeaseStatus,
    NextBestActionGenerator,
    WorkspaceActionCommit,
    WorkspaceActionReceipt,
    WorkspaceActionPacket,
    canonical_evidence_set_hash,
    validate_consumed_gate1_lease_transition,
)
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphNode,
    IncidentProjection,
    IncidentRunBinding,
    ProjectionState,
    IncidentEvent,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher


NOW = datetime(2026, 7, 26, tzinfo=timezone.utc)
HASH = "a" * 64


def binding(tenant_id="tenant-a"):
    return IncidentRunBinding(
        tenant_id=tenant_id, incident_id="incident-a", run_id="run-public-a",
        topology_revision="topology-v1-a", case_id="case-a", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-a:run-public-a",
        workflow_run_id="temporal-run-a", created_at=NOW,
    )


def context(item, **changes):
    from flowpulse_cp.capabilities import CapabilityInvocationContext

    values = dict(
        **item.dict(), projection_revision=1, evidence_revision=1,
        component_ids=["checkout"], activity_id="activity-gate1", scope=CapabilityScope.USER_QA,
        subject_id="subject-a", subject_roles=["viewer"], authorized_subjects=["subject-a"],
        subject_permissions=["incident:read"], data_class=CapabilityDataClass.CURRENT_INCIDENT,
        max_tool_calls=1, capability_registry_revision="capability-registry.v3",
        precondition_version="workspace-precondition.v1", precondition_hash=HASH,
        gate1_lease_id="lease-a", action_command_fingerprint="c" * 64,
        recorded_evidence_ids=["evidence-a", "evidence-b"],
    )
    values.update(changes)
    return CapabilityInvocationContext(**values)


def lease(item, **changes):
    values = dict(
        **item.dict(), lease_id="lease-a", lease_revision=1, subject_id="subject-a",
        required_permission="incident:read", component_id="checkout", capability=CapabilityName.METRICS.value,
        data_class=CapabilityDataClass.CURRENT_INCIDENT.value, tool_schema_version="metrics-input.v1",
        projection_revision=1, evidence_revision=1, capability_registry_revision="capability-registry.v3",
        precondition_version="workspace-precondition.v1", precondition_hash=HASH,
        issuance_command_fingerprint="d" * 64,
        evidence_set_hash=canonical_evidence_set_hash(["evidence-a", "evidence-b"]),
        issued_at=NOW, expires_at=NOW + timedelta(minutes=30), status=Gate1LeaseStatus.ACTIVE,
    )
    values.update(changes)
    return Gate1Lease(**values)


class Gate1AuthorityStore:
    """Small authoritative grant fixture; it never mutates a lease."""

    def __init__(self, active, grant):
        self.active = active
        self.grant = grant

    async def workspace_gate1_lease(self, tenant_id, case_id, lease_id):
        if (tenant_id, case_id, lease_id) != (self.active.tenant_id, self.active.case_id, self.active.lease_id):
            return None
        return self.active

    async def workspace_gate1_grant_transition(self, tenant_id, case_id, lease_id):
        if (tenant_id, case_id, lease_id) != (self.active.tenant_id, self.active.case_id, self.active.lease_id):
            return None
        return self.grant


def granted_lease(item, **changes):
    registry = CapabilityRegistry(descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()})
    current = projection(item)
    card = NextBestActionGenerator(registry).generate(current, NOW)[0]
    base = lease(item, **{
        "lease_id": "gate1-" + ("d" * 64),
        "issuance_action_id": card.action_id,
        "issuance_card_version": card.card_version,
        "issuance_idempotency_key": "grant-idempotency",
    })
    receipt = WorkspaceActionReceipt(
        **item.dict(), action_id=card.action_id, idempotency_key="grant-idempotency",
        status="GATE1_GRANTED", gate1_lease_id=base.lease_id, reason="fixture-grant",
    )
    event = IncidentEvent(
        **item.dict(), projection_revision=1, sequence=2, event_type="workspace.action.gate1_granted",
        occurred_at=NOW, payload={}, evidence_refs=[],
    )
    grant = WorkspaceActionCommit(
        activity_identity="fixture-grant", command_fingerprint=base.issuance_command_fingerprint,
        projection=current, receipt=receipt, event=event, lease=base, issued_action=card,
    )
    active = base.copy(update=changes)
    return active, Gate1AuthorityStore(active, grant)


class MetricsAdapter:
    descriptor = CapabilityDescriptor(
        capability=CapabilityName.METRICS, version="metrics.v1", fresh_read=True, enabled=True,
        audiences=[CapabilityAudience.USER_QA], data_classes=[CapabilityDataClass.CURRENT_INCIDENT],
        required_gate=CapabilityGate.GATE1, input_schema="metrics-input.v1",
    )
    input_model = EmptyCapabilityInput
    result_model = CapabilityResult

    async def invoke(self, parsed_input, invocation_context):
        return CapabilityResult(summary="test")


class CurrentMetricsAdapter(MetricsAdapter):
    async def invoke(self, parsed_input, invocation_context):
        evidence = EvidenceEnvelope(
            evidence_id="metric-evidence-{}".format(invocation_context.tenant_id), tenant_id=invocation_context.tenant_id,
            case_id=invocation_context.case_id, case_revision=invocation_context.case_revision,
            acl_subjects=[invocation_context.subject_id], source_kind=SourceKind.METRIC,
            source_uri="metric://checkout/latency", source_anchor="window:1",
            observed_at=NOW, effective_at=NOW, source_version="metrics-v1", content_hash="b" * 64,
            authority=EvidenceAuthority.T1, freshness=FreshnessStatus.CURRENT,
            independence_key="metrics:checkout", schema_binding="metrics.v1",
            proof_scope=ProofScope.CURRENT_OBSERVATION,
        )
        return CapabilityResult(
            summary="current metric", evidence=[evidence],
            claims=[ClaimRecord(
                claim_id="metric-claim-{}".format(invocation_context.tenant_id),
                tenant_id=invocation_context.tenant_id, case_id=invocation_context.case_id,
                case_revision=invocation_context.case_revision, claim_type="symptom",
                statement="Current checkout latency is elevated.", evidence_ids=[evidence.evidence_id],
                created_by="test:current-metrics",
            )],
            coverage=[CoverageEntry(
                tenant_id=invocation_context.tenant_id, case_id=invocation_context.case_id,
                field="telemetry_symptom", status=CoverageStatus.FILLED,
                evidence_ids=[evidence.evidence_id],
            )],
        )


class ControlledMetricsAdapter(CurrentMetricsAdapter):
    def __init__(self):
        self.fail_source = False

    async def invoke(self, parsed_input, invocation_context):
        if self.fail_source:
            raise RuntimeError("source_failed")
        return await super().invoke(parsed_input, invocation_context)


class AcceptingScope:
    async def assert_scope(self, invocation_context):
        return None


class AcceptingAdmission:
    async def admit(self, result, invocation_context):
        return result


def projection(item):
    return IncidentProjection(
        **item.dict(), projection_revision=1, sequence=1, lifecycle_state=ProjectionState.DEGRADED,
        status="degraded", generated_at=NOW, graph=IncidentGraph(nodes=[IncidentGraphNode(
            component_id="checkout", canonical_identity="service:checkout", membership=GraphMembership.CLASSIFIED,
            classification_reason="Relationship unavailable",
            runtime_status="unknown", impact_status="unknown",
        )], edges=[]), evidence_revision=1, gate_revision=1, action_revision=1,
    )


async def complete_fresh_read(repository, item, *, idempotency_prefix):
    """Exercise the public action seam and return its immutable transitions."""
    now = datetime.now(timezone.utc)
    current = projection(item)
    await repository.put_binding(item)
    await repository.put_projection(current)
    await repository.grant_workspace_subject(
        item, "subject-a", ["viewer"], ["incident:read"],
    )
    registry = CapabilityRegistry(
        descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: CurrentMetricsAdapter()},
        scope_authority=AcceptingScope(), gate1_authority=Gate1LeaseAuthority(repository, now=lambda: now),
    )
    gate_card = NextBestActionGenerator(registry).generate(current, now)[0]
    await repository.append_next_best_action(gate_card)
    dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
    grant_command = ActionInvocationCommand(
        incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
        projection_revision=current.projection_revision, action_id=gate_card.action_id,
        idempotency_key="{}-grant".format(idempotency_prefix),
    )
    granted = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
        **item.dict(), projection=current, event_sequence=2, command=grant_command,
        actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
    ).dict())
    grant = await repository.workspace_action_commit(item.tenant_id, item.case_id, grant_command.idempotency_key)
    read_card = next(
        card for card in await repository.workspace_next_best_actions(item.tenant_id, item.case_id)
        if card.cta.value == "run_read_capability"
    )
    read_command = ActionInvocationCommand(
        incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
        projection_revision=read_card.projection_revision, action_id=read_card.action_id,
        idempotency_key="{}-read".format(idempotency_prefix),
    )
    completed = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
        **item.dict(), projection=IncidentProjection.parse_obj(granted["projection"]), event_sequence=3,
        command=read_command, actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
    ).dict())
    fresh = await repository.workspace_action_commit(item.tenant_id, item.case_id, read_command.idempotency_key)
    return grant, fresh, completed


async def staged_fresh_transition(item, *, idempotency_prefix):
    """Return a target repository with only the authoritative Gate 1 grant.

    The fresh transition is produced against an identical isolated source and
    then offered to the target before it has any read-side artifacts.  That
    gives every malformed ``copy``/``construct`` probe a real active lease to
    protect, rather than relying on an already-completed idempotency record.
    """
    source = InMemoryWorkspaceRepository()
    grant, fresh, _ = await complete_fresh_read(source, item, idempotency_prefix=idempotency_prefix)
    target = InMemoryWorkspaceRepository()
    target.configure_workspace_capability_registry(source.workspace_capability_registry)
    await target.put_binding(item)
    await target.put_projection(projection(item))
    await target.grant_workspace_subject(item, "subject-a", ["viewer"], ["incident:read"])
    await target.append_next_best_action(grant.issued_action)
    await target.commit_workspace_action_transition(grant)
    return target, grant, fresh


def rebound_fresh_result(fresh, result):
    """Re-sign a test result so repository admission—not stale hashes—rejects it."""
    evidence_refs = list(fresh.capability_audit.input_evidence_refs)
    for evidence in result.evidence:
        if evidence.evidence_id not in evidence_refs:
            evidence_refs.append(evidence.evidence_id)
    audit = fresh.capability_audit.copy(update={
        "result_hash": canonical_capability_result_hash(result),
        "evidence_refs": evidence_refs,
    })
    audit = audit.copy(update={
        "audit_id": deterministic_capability_audit_id(
            tenant_id=audit.tenant_id, run_id=audit.run_id, activity_id=audit.activity_id,
            scope=audit.scope, audience=audit.audience, capability=audit.capability,
            request_hash=audit.request_hash,
        ),
    })
    consumed = fresh.lease.copy(update={
        "consumed_result_hash": audit.result_hash,
        "consumed_audit_id": audit.audit_id,
    })
    return fresh.copy(update={
        "capability_result": result, "capability_audit": audit, "lease": consumed,
    })


class Gate1CapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_gate1_grant_rejects_every_forged_lease_axis_before_persistence(self):
        """A stored request card cannot be used to mint an arbitrary Gate 1 lease."""
        item = binding()

        async def target_for(label):
            source = InMemoryWorkspaceRepository()
            grant, _, _ = await complete_fresh_read(source, item, idempotency_prefix="grant-forge-" + label)
            target = InMemoryWorkspaceRepository()
            target.configure_workspace_capability_registry(source.workspace_capability_registry)
            await target.put_binding(item)
            await target.put_projection(projection(item))
            await target.grant_workspace_subject(item, "subject-a", ["viewer"], ["incident:read"])
            await target.append_next_best_action(grant.issued_action)
            return target, grant

        for field, value in {
            "subject_id": "intruder",
            "required_permission": "incident:admin",
            "component_id": "payments",
            "capability_version": "evil.v9",
            "precondition_hash": "f" * 64,
            "evidence_set_hash": "f" * 64,
        }.items():
            with self.subTest(forged_lease_field=field):
                target, grant = await target_for(field)
                forged = grant.copy(update={"lease": grant.lease.copy(update={field: value})})
                with self.assertRaisesRegex(PolicyViolation, "gate1_grant"):
                    await target.commit_workspace_action_transition(forged)

        # Even a row-shaped card is not authority: its fixed taxonomy/title,
        # descriptor version, identity and expiry must be derivable from the
        # locked projection and the registered capability policy.
        target, grant = await target_for("stored-card")
        forged_card = grant.issued_action.copy(update={"summary": "forged server card"})
        target.next_best_actions[(
            forged_card.tenant_id, forged_card.case_id, forged_card.action_id,
        )] = forged_card
        with self.assertRaisesRegex(PolicyViolation, "gate1_grant_stored_card_not_authoritative"):
            await target.commit_workspace_action_transition(grant.copy(update={"issued_action": forged_card}))

    async def test_action_commit_transition_kinds_require_complete_authoritative_artifacts(self):
        item = binding()
        current = projection(item)
        event = IncidentEvent(
            **item.dict(), projection_revision=1, sequence=2, event_type="workspace.action.fresh_read_completed",
            occurred_at=NOW, payload={}, evidence_refs=[],
        )
        receipt = WorkspaceActionReceipt(
            **item.dict(), action_id="read-card", idempotency_key="invalid-fresh",
            status="FRESH_READ_COMPLETED", gate1_lease_id="lease-a", reason="invalid-fixture",
        )
        consumed = lease(item).copy(update={
            "status": Gate1LeaseStatus.CONSUMED, "lease_revision": 2,
            "consumed_by_activity_id": "activity-invalid",
            "consumed_command_fingerprint": "c" * 64,
            "consumed_evidence_set_hash": canonical_evidence_set_hash(["evidence-a", "evidence-b"]),
            "consumed_evidence_revision": 1,
        })
        with self.assertRaisesRegex(ValidationError, "fresh_read_transition_artifacts_required"):
            WorkspaceActionCommit(
                activity_identity="activity-invalid", command_fingerprint="c" * 64,
                projection=current, receipt=receipt, event=event, lease=consumed,
            )

        repository = InMemoryWorkspaceRepository()
        grant, fresh, _ = await complete_fresh_read(repository, item, idempotency_prefix="kind")
        self.assertEqual("GATE1_GRANTED", grant.receipt.status)
        self.assertEqual("FRESH_READ_COMPLETED", fresh.receipt.status)
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_transition_artifacts_required"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_result": None, "capability_audit": None,
            }))
        with self.assertRaisesRegex(PolicyViolation, "gate1_grant_issued_card_required"):
            await repository.commit_workspace_action_transition(grant.copy(update={"issued_action": None}))
        with self.assertRaisesRegex(PolicyViolation, "gate1_grant_lease_issuance_binding_invalid"):
            await repository.commit_workspace_action_transition(grant.copy(update={
                "lease": grant.lease.copy(update={"issuance_action_id": "other-card"}),
            }))

    async def test_fresh_read_requires_complete_current_domain_artifacts_even_when_models_are_bypassed(self):
        """An empty result may never consume a lease or masquerade as a fresh read."""
        item = binding()
        repository, grant, fresh = await staged_fresh_transition(item, idempotency_prefix="complete-artifacts")
        self.assertEqual((1, 1, 1), (
            len(fresh.capability_result.evidence), len(fresh.capability_result.claims),
            len(fresh.capability_result.coverage),
        ))
        counts_before = (
            len(repository.workspace_action_commits), len(repository.capability_audits),
            len(repository.gate1_leases[(item.tenant_id, item.case_id, fresh.lease.lease_id)]),
        )
        for field in ("evidence", "claims", "coverage"):
            with self.subTest(field=field):
                incomplete_result = fresh.capability_result.copy(update={field: []})
                payload = fresh.dict()
                payload["capability_result"] = incomplete_result.dict()
                with self.assertRaisesRegex(ValidationError, "fresh_read_current_evidence_artifacts_required"):
                    WorkspaceActionCommit(**payload)

                copied = fresh.copy(update={"capability_result": incomplete_result})
                with self.assertRaisesRegex(PolicyViolation, "fresh_read_current_evidence_artifacts_required"):
                    await repository.commit_workspace_action_transition(copied)

                constructed = WorkspaceActionCommit.construct(
                    **{**fresh.__dict__, "capability_result": incomplete_result},
                )
                with self.assertRaisesRegex(PolicyViolation, "fresh_read_current_evidence_artifacts_required"):
                    await repository.commit_workspace_action_transition(constructed)
                self.assertEqual(counts_before, (
                    len(repository.workspace_action_commits), len(repository.capability_audits),
                    len(repository.gate1_leases[(item.tenant_id, item.case_id, fresh.lease.lease_id)]),
                ))
                active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, grant.lease.lease_id)
                self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))

        accepted = await repository.commit_workspace_action_transition(fresh)
        self.assertEqual(fresh, accepted)
        self.assertEqual(fresh, await repository.commit_workspace_action_transition(fresh))
        self.assertEqual((Gate1LeaseStatus.CONSUMED, 2), (
            (await repository.workspace_gate1_lease(item.tenant_id, item.case_id, fresh.lease.lease_id)).status,
            (await repository.workspace_gate1_lease(item.tenant_id, item.case_id, fresh.lease.lease_id)).lease_revision,
        ))

    async def test_fresh_read_audit_and_consumed_lease_must_match_the_exact_gate1_command(self):
        item = binding()
        repository, grant, fresh = await staged_fresh_transition(item, idempotency_prefix="audit-binding")
        self.assertEqual(Gate1LeaseStatus.ACTIVE, grant.lease.status)
        self.assertEqual(Gate1LeaseStatus.CONSUMED, fresh.lease.status)
        audit = fresh.capability_audit
        for field, value in {
            "subject_id": "intruder",
            "activity_id": "workspace-gate1:other-run:other-card:other-idempotency",
            "tenant_id": "tenant-b",
            "run_id": "run-public-b",
            "capability": CapabilityName.LOGS,
            "component_id": "payments",
            "data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE,
            "required_gate": CapabilityGate.NONE,
            "scope": CapabilityScope.AUTONOMOUS_DIAGNOSIS,
            "input_evidence_refs": ["other-evidence"],
            "evidence_refs": [],
        }.items():
            with self.subTest(audit_field=field):
                tampered = fresh.copy(update={"capability_audit": audit.copy(update={field: value})})
                with self.assertRaisesRegex(PolicyViolation, "fresh_read_audit_(binding_invalid|result_evidence_mismatch|provenance_invalid)"):
                    await repository.commit_workspace_action_transition(tampered)

        for field, value in {
            "precondition_hash": "e" * 64,
            "issuance_action_id": "other-action",
            "lease_revision": fresh.lease.lease_revision + 1,
        }.items():
            with self.subTest(consumed_lease_field=field):
                with self.assertRaisesRegex(PolicyViolation, "gate1_consumed_lease_transition_invalid"):
                    await repository.commit_workspace_action_transition(
                        fresh.copy(update={"lease": fresh.lease.copy(update={field: value})})
                    )
                constructed = WorkspaceActionCommit.construct(**{
                    **fresh.__dict__, "lease": fresh.lease.copy(update={field: value}),
                })
                with self.assertRaisesRegex(PolicyViolation, "gate1_consumed_lease_transition_invalid"):
                    await repository.commit_workspace_action_transition(constructed)

        for field, value in {
            "lease_id": "gate1-" + ("f" * 64),
            "consumed_by_activity_id": "other-activity",
            "consumed_command_fingerprint": "f" * 64,
            "consumed_evidence_set_hash": "f" * 64,
            "consumed_evidence_revision": fresh.lease.consumed_evidence_revision + 1,
        }.items():
            with self.subTest(pure_consumed_lease_field=field):
                with self.assertRaisesRegex(PolicyViolation, "gate1_consumed_lease_transition_invalid"):
                    validate_consumed_gate1_lease_transition(
                        grant.lease, fresh.lease.copy(update={field: value}),
                        command_fingerprint=fresh.command_fingerprint, capability_audit=audit,
                    )

        with self.assertRaisesRegex(PolicyViolation, "gate1_consumed_lease_transition_invalid"):
            validate_consumed_gate1_lease_transition(
                grant.lease.copy(update={"consumed_by_activity_id": "stale-activity"}), fresh.lease,
                command_fingerprint=fresh.command_fingerprint, capability_audit=audit,
            )

        active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, grant.lease.lease_id)
        self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))

    async def test_fresh_read_rejects_forged_card_audit_result_and_lineage_before_consumption(self):
        """Only the Gate 1 grant's exact read card may create a fresh-read ledger set."""
        item = binding()

        async def fresh_target(label):
            return await staged_fresh_transition(item, idempotency_prefix="forgery-" + label)

        repository, _, fresh = await fresh_target("request-hash")
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_audit"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_audit": fresh.capability_audit.copy(update={"request_hash": "f" * 64}),
            }))

        repository, _, fresh = await fresh_target("capability-version")
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_audit"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_audit": fresh.capability_audit.copy(update={"capability_version": "evil.v9"}),
            }))

        repository, _, fresh = await fresh_target("audit-id")
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_audit"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_audit": fresh.capability_audit.copy(update={"audit_id": uuid4()}),
            }))

        repository, _, fresh = await fresh_target("claim")
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_(audit|result)"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_result": fresh.capability_result.copy(update={
                    "claims": [fresh.capability_result.claims[0].copy(update={"statement": "forged claim"})],
                }),
            }))

        repository, _, fresh = await fresh_target("coverage")
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_(audit|result)"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_result": fresh.capability_result.copy(update={
                    "coverage": [fresh.capability_result.coverage[0].copy(update={"evidence_ids": ["unknown-evidence"]})],
                }),
            }))

        repository, _, fresh = await fresh_target("duplicate")
        duplicate_evidence = fresh.capability_result.evidence[0].copy(update={"source_anchor": "conflicting"})
        with self.assertRaisesRegex(PolicyViolation, "fresh_read_(audit|result)"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "capability_result": fresh.capability_result.copy(update={
                    "evidence": [fresh.capability_result.evidence[0], duplicate_evidence],
                }),
            }))

        repository, _, fresh = await fresh_target("card")
        forged_command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=fresh.lease.projection_revision, action_id="action-forged",
            idempotency_key="forged-idempotency",
        )
        forged_fingerprint = forged_command.canonical_hash()
        forged_audit_activity = "workspace-gate1:{}:{}:{}".format(
            item.workflow_run_id, forged_command.action_id, forged_command.idempotency_key,
        )
        forged_audit = fresh.capability_audit.copy(update={
            "activity_id": forged_audit_activity,
            "audit_id": deterministic_capability_audit_id(
                tenant_id=item.tenant_id, run_id=item.run_id, activity_id=forged_audit_activity,
                scope=CapabilityScope.USER_QA, audience=CapabilityAudience.USER_QA,
                capability=CapabilityName.METRICS, request_hash=fresh.capability_audit.request_hash,
            ),
        })
        forged_lease = fresh.lease.copy(update={
            "consumed_by_activity_id": forged_audit_activity,
            "consumed_command_fingerprint": forged_fingerprint,
            "consumed_action_id": forged_command.action_id,
            "consumed_idempotency_key": forged_command.idempotency_key,
            "consumed_audit_id": forged_audit.audit_id,
        })
        forged_receipt = fresh.receipt.copy(update={
            "action_id": forged_command.action_id, "idempotency_key": forged_command.idempotency_key,
        })
        with self.assertRaisesRegex(PolicyViolation, "gate1_authoritative_read_card"):
            await repository.commit_workspace_action_transition(fresh.copy(update={
                "activity_identity": "workspace-action:{}:{}".format(item.workflow_run_id, forged_fingerprint),
                "command_fingerprint": forged_fingerprint, "receipt": forged_receipt,
                "lease": forged_lease, "capability_audit": forged_audit,
            }))

    async def test_fresh_read_admission_rejects_unauthorized_and_cyclic_lineage_before_consumption(self):
        """The repository admission boundary accepts only an ordered authorized proof DAG."""
        item = binding()
        for label, make_result in {
            "unauthorized-acl": lambda fresh: fresh.capability_result.copy(update={
                "evidence": [fresh.capability_result.evidence[0].copy(update={"acl_subjects": ["intruder"]})],
            }),
            "cyclic-lineage": lambda fresh: fresh.capability_result.copy(update={
                "evidence": [
                    fresh.capability_result.evidence[0].copy(update={
                        "evidence_id": "cycle-a", "parent_evidence_ids": ["cycle-b"],
                    }),
                    fresh.capability_result.evidence[0].copy(update={
                        "evidence_id": "cycle-b", "parent_evidence_ids": ["cycle-a"],
                    }),
                ],
                "claims": [fresh.capability_result.claims[0].copy(update={"evidence_ids": ["cycle-a"]})],
                "coverage": [fresh.capability_result.coverage[0].copy(update={"evidence_ids": ["cycle-a"]})],
            }),
        }.items():
            with self.subTest(label=label):
                repository, grant, fresh = await staged_fresh_transition(item, idempotency_prefix="admission-" + label)
                forged = rebound_fresh_result(fresh, make_result(fresh))
                with self.assertRaisesRegex(PolicyViolation, "(fresh_read_(evidence|result)|evidence_acl_subject_denied)"):
                    await repository.commit_workspace_action_transition(forged)
                active = await repository.workspace_gate1_lease(
                    item.tenant_id, item.case_id, grant.lease.lease_id,
                )
                self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))
                self.assertEqual(1, len(repository.workspace_action_commits))
                self.assertEqual(0, len(repository.capability_audits))

    async def test_fresh_read_derives_the_only_lifecycle_projection_receipt_and_event_successor(self):
        """A row-shaped fresh result cannot invent lifecycle or success truth."""
        item = binding()

        async def assert_rejected(label, commit):
            repository, grant, fresh = await staged_fresh_transition(
                item, idempotency_prefix="lifecycle-" + label,
            )
            with self.assertRaisesRegex(PolicyViolation, "fresh_read_(projection|receipt|event)_successor_invalid"):
                await repository.commit_workspace_action_transition(commit(fresh))
            active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, grant.lease.lease_id)
            self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))
            self.assertEqual(1, len(repository.workspace_action_commits))
            self.assertEqual(0, len(repository.capability_audits))

        for field, value in {
            "lifecycle_state": ProjectionState.AWAITING_OWNER,
            "status": "forged-lifecycle-truth",
            "degraded_code": "forged-degraded-code",
            "impacted_path": ["checkout"],
            "projection_revision": 99,
            "sequence": 99,
            "gate_revision": 99,
            "action_revision": 99,
        }.items():
            with self.subTest(projection_field=field):
                await assert_rejected(
                    "projection-" + field,
                    lambda fresh, field=field, value=value: fresh.copy(update={
                        "projection": fresh.projection.copy(update={field: value}),
                    }),
                )

        await assert_rejected(
            "unknown-projection-field",
            lambda fresh: fresh.copy(update={
                "projection": fresh.projection.copy(update={"diagnosis_summary": "forged diagnosis"}),
            }),
        )
        await assert_rejected(
            "receipt",
            lambda fresh: fresh.copy(update={
                "receipt": fresh.receipt.copy(update={"reason": "forged success"}),
            }),
        )
        await assert_rejected(
            "event",
            lambda fresh: fresh.copy(update={
                "event": fresh.event.copy(update={"payload": {"forged": "success"}}),
            }),
        )
        await assert_rejected(
            "constructed",
            lambda fresh: WorkspaceActionCommit.construct(**{
                **fresh.__dict__,
                "projection": fresh.projection.copy(update={"status": "forged-lifecycle-truth"}),
            }),
        )

    async def test_expiry_after_source_result_and_before_atomic_commit_leaves_lease_active_then_retries_once(self):
        """The authoritative commit clock, not only pre-read validation, gates consumption."""
        item = binding()
        repository, grant, fresh = await staged_fresh_transition(item, idempotency_prefix="expiry-before-commit")
        clock = [fresh.lease.issued_at + timedelta(seconds=1)]
        repository._now = lambda: clock[0]

        def expire_after_admission(checkpoint):
            if checkpoint == "after_audit":
                clock[0] = fresh.lease.expires_at + timedelta(microseconds=1)

        repository.failure_injector = expire_after_admission
        with self.assertRaisesRegex(PolicyViolation, "gate1_(authoritative_read_card|consumed_lease)_expired"):
            await repository.commit_workspace_action_transition(fresh)
        active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, grant.lease.lease_id)
        self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))
        self.assertEqual(1, len(repository.workspace_action_commits))
        self.assertEqual(0, len(repository.capability_audits))

        repository.failure_injector = None
        clock[0] = fresh.lease.issued_at + timedelta(seconds=1)
        self.assertEqual(fresh, await repository.commit_workspace_action_transition(fresh))
        self.assertEqual(fresh, await repository.commit_workspace_action_transition(fresh))

    async def test_action_coverage_is_tenant_bound_verified_and_conflicts_retry_fail_closed(self):
        repository = InMemoryWorkspaceRepository()
        first_item = binding("tenant-a")
        second_item = binding("tenant-b")
        _, first_fresh, _ = await complete_fresh_read(repository, first_item, idempotency_prefix="coverage-a")
        _, second_fresh, _ = await complete_fresh_read(repository, second_item, idempotency_prefix="coverage-b")
        first_coverage = first_fresh.capability_result.coverage[0]
        second_coverage = second_fresh.capability_result.coverage[0]
        self.assertNotEqual(first_coverage.tenant_id, second_coverage.tenant_id)
        self.assertEqual(2, len(repository.workspace_action_coverage))
        self.assertEqual(
            first_coverage,
            repository.workspace_action_coverage[(
                first_coverage.tenant_id, first_coverage.case_id,
                first_coverage.field, first_coverage.status.value,
            )],
        )
        self.assertEqual(
            second_coverage,
            repository.workspace_action_coverage[(
                second_coverage.tenant_id, second_coverage.case_id,
                second_coverage.field, second_coverage.status.value,
            )],
        )

        coverage_key = (
            first_coverage.tenant_id, first_coverage.case_id,
            first_coverage.field, first_coverage.status.value,
        )
        del repository.workspace_action_coverage[coverage_key]
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_transition_partial"):
            await repository.workspace_action_commit(
                first_item.tenant_id, first_item.case_id, first_fresh.receipt.idempotency_key,
            )
        repository.workspace_action_coverage[coverage_key] = first_coverage.copy(update={"note": "conflict"})
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_transition_partial"):
            await repository.workspace_action_commit(
                first_item.tenant_id, first_item.case_id, first_fresh.receipt.idempotency_key,
            )
        repository.workspace_action_coverage[coverage_key] = first_coverage
        retried = await repository.workspace_action_commit(
            first_item.tenant_id, first_item.case_id, first_fresh.receipt.idempotency_key,
        )
        self.assertEqual(first_fresh, retried)

    async def test_conflicting_coverage_rolls_back_before_lease_consumption_then_retries_once(self):
        item = binding()
        now = datetime.now(timezone.utc)
        repository = InMemoryWorkspaceRepository()
        current = projection(item)
        await repository.put_binding(item)
        await repository.put_projection(current)
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: CurrentMetricsAdapter()},
            scope_authority=AcceptingScope(), gate1_authority=Gate1LeaseAuthority(repository, now=lambda: now),
        )
        gate_card = NextBestActionGenerator(registry).generate(current, now)[0]
        await repository.append_next_best_action(gate_card)
        dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
        grant_command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, action_id=gate_card.action_id, idempotency_key="coverage-conflict-grant",
        )
        granted = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
            **item.dict(), projection=current, event_sequence=2, command=grant_command,
            actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        ).dict())
        read_card = next(
            card for card in await repository.workspace_next_best_actions(item.tenant_id, item.case_id)
            if card.cta.value == "run_read_capability"
        )
        read_command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=read_card.projection_revision, action_id=read_card.action_id,
            idempotency_key="coverage-conflict-read",
        )
        read_packet = WorkspaceActionPacket(
            **item.dict(), projection=IncidentProjection.parse_obj(granted["projection"]), event_sequence=3,
            command=read_command, actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        )
        expected = CoverageEntry(
            tenant_id=item.tenant_id, case_id=item.case_id, field="telemetry_symptom",
            status=CoverageStatus.FILLED, evidence_ids=["metric-evidence-tenant-a"],
        )
        coverage_key = (expected.tenant_id, expected.case_id, expected.field, expected.status.value)
        repository.workspace_action_coverage[coverage_key] = expected.copy(update={"note": "conflicting"})
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_coverage_immutable"):
            await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
        active = await repository.workspace_gate1_lease(
            item.tenant_id, item.case_id, granted["receipt"]["gate1_lease_id"],
        )
        self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))
        self.assertEqual(0, len(repository.capability_audits))
        self.assertEqual(1, len(repository.workspace_action_commits))

        del repository.workspace_action_coverage[coverage_key]
        accepted = await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
        retried = await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
        self.assertEqual(accepted["receipt"], retried["receipt"])
        self.assertEqual(expected, repository.workspace_action_coverage[coverage_key])
        self.assertEqual(2, len(repository.workspace_action_commits))
    async def test_lease_validates_full_command_and_exact_evidence_set_without_consuming(self):
        item = binding()
        active, store = granted_lease(item)
        authority = Gate1LeaseAuthority(store, now=lambda: NOW)
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        validated = await authority.assert_active(
            context(item, gate1_lease_id=active.lease_id), request, MetricsAdapter.descriptor,
        )
        self.assertEqual(Gate1LeaseStatus.ACTIVE, validated.status)
        self.assertIsNone(validated.consumed_command_fingerprint)
        self.assertEqual(
            canonical_evidence_set_hash(["evidence-a", "evidence-b"]),
            active.evidence_set_hash,
        )
        self.assertIsNone(validated.consumed_evidence_revision)

        for label, changed_context in {
            "same-revision-evidence-substitution": context(item, gate1_lease_id=active.lease_id, recorded_evidence_ids=["evidence-a", "evidence-c"]),
            "cross-tenant": context(item, gate1_lease_id=active.lease_id, tenant_id="tenant-b"),
            "cross-run": context(item, gate1_lease_id=active.lease_id, run_id="run-public-b"),
        }.items():
            with self.subTest(label=label):
                with self.assertRaises(PolicyViolation):
                    await authority.assert_active(changed_context, request, MetricsAdapter.descriptor)

    async def test_lease_validation_is_non_authoritative_until_action_transition_commits(self):
        item = binding()
        active, store = granted_lease(item)
        authority = Gate1LeaseAuthority(store, now=lambda: NOW)
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        first = await authority.assert_active(context(item, gate1_lease_id=active.lease_id), request, MetricsAdapter.descriptor)
        self.assertEqual(Gate1LeaseStatus.ACTIVE, first.status)
        self.assertIsNone(first.consumed_by_activity_id)
        retry = await authority.assert_active(context(item, gate1_lease_id=active.lease_id), request, MetricsAdapter.descriptor)
        self.assertEqual(first, retry)
        self.assertEqual(Gate1LeaseStatus.ACTIVE, retry.status)

    async def test_lease_requires_the_exact_immutable_grant_transition_and_card(self):
        item = binding()
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        for label, mutate in {
            "tampered-lease-id": lambda active, store: setattr(
                store, "active", active.copy(update={"lease_id": "gate1-" + ("e" * 64)}),
            ),
            "tampered-issuance-fingerprint": lambda active, store: setattr(
                store, "active", active.copy(update={"issuance_command_fingerprint": "e" * 64}),
            ),
            "missing-grant": lambda active, store: setattr(store, "grant", None),
            "mismatched-grant-idempotency": lambda active, store: setattr(
                store, "grant", store.grant.copy(update={
                    "receipt": store.grant.receipt.copy(update={"idempotency_key": "other-idempotency"}),
                }),
            ),
            "mismatched-grant-card": lambda active, store: setattr(
                store, "grant", store.grant.copy(update={
                    "issued_action": store.grant.issued_action.copy(update={"card_version": 2}),
                }),
            ),
        }.items():
            with self.subTest(label=label):
                active, store = granted_lease(item)
                mutate(active, store)
                with self.assertRaisesRegex(PolicyViolation, "gate1_lease_(issuance|grant_transition)"):
                    await Gate1LeaseAuthority(store, now=lambda: NOW).assert_active(
                        context(item, gate1_lease_id=store.active.lease_id), request,
                    )

    async def test_shared_registry_validates_the_exact_gate1_lease_before_fresh_read_audit(self):
        item = binding()
        active, store = granted_lease(item)
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor],
            adapters={CapabilityName.METRICS: CurrentMetricsAdapter()},
            scope_authority=AcceptingScope(),
            gate1_authority=Gate1LeaseAuthority(store, now=lambda: NOW),
        )
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        first = await registry.invoke(
            CapabilityAudience.USER_QA, context(item, gate1_lease_id=active.lease_id), request, ToolCallBudget(max_calls=1),
            evidence_admission=AcceptingAdmission(),
        )
        self.assertEqual(["metric-evidence-tenant-a"], first.audit.evidence_refs)
        self.assertEqual(1, len(registry.audit_records))
        self.assertEqual(Gate1LeaseStatus.ACTIVE, active.status)

    async def test_exact_lease_permits_one_bound_fresh_read_and_every_stale_axis_fails_closed(self):
        repository = InMemoryWorkspaceRepository()
        item = binding()
        active, store = granted_lease(item)
        authority = Gate1LeaseAuthority(store, now=lambda: NOW)
        request = CapabilityRequest(
            capability=CapabilityName.METRICS, component_id="checkout",
            data_class=CapabilityDataClass.CURRENT_INCIDENT, parameters={},
        )
        await authority.assert_active(context(item, gate1_lease_id=active.lease_id), request)

        invalid = {
            "expiry": (lease(item, expires_at=NOW), context(item)),
            "revocation": (lease(item, status=Gate1LeaseStatus.REVOKED, lease_revision=2), context(item)),
            "tenant": (lease(item), context(item, tenant_id="tenant-b")),
            "run": (lease(item), context(item, run_id="run-public-b")),
            "topology": (lease(item), context(item, topology_revision="topology-v1-b")),
            "projection": (lease(item), context(item, projection_revision=2)),
            "evidence": (lease(item), context(item, evidence_revision=2)),
            "registry": (lease(item), context(item, capability_registry_revision="capability-registry.v4")),
            "component": (lease(item), context(item, component_ids=["payments"])),
            "permission": (lease(item), context(item, subject_permissions=[])),
            "precondition": (lease(item), context(item, precondition_hash="b" * 64)),
        }
        for label, (replacement, scoped) in invalid.items():
            with self.subTest(label=label):
                _, isolated = granted_lease(item, **replacement.dict(exclude={"created_at"}))
                with self.assertRaises(PolicyViolation):
                    await Gate1LeaseAuthority(isolated, now=lambda: NOW).assert_active(
                        scoped.copy(update={"gate1_lease_id": replacement.lease_id}), request,
                    )

        for label, wrong_request in {
            "capability": request.copy(update={"capability": CapabilityName.LOGS}),
            "data_class": request.copy(update={"data_class": CapabilityDataClass.KNOWLEDGE_REFERENCE}),
            "component": request.copy(update={"component_id": "payments"}),
        }.items():
            with self.subTest(label=label):
                with self.assertRaises(PolicyViolation):
                    await authority.assert_active(context(item, gate1_lease_id=active.lease_id), wrong_request)

    async def test_temporal_action_activity_issues_one_lease_and_invalidates_the_old_card(self):
        item = binding()
        repository = InMemoryWorkspaceRepository()
        await repository.put_binding(item)
        current = projection(item)
        await repository.put_projection(current)
        registry = CapabilityRegistry(
            descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
        )
        card = NextBestActionGenerator(registry).generate(current, datetime.now(timezone.utc))[0]
        await repository.append_next_best_action(card)
        dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
        command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, action_id=card.action_id, idempotency_key="gate1-click-a",
        )
        result = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
            **item.dict(), projection=current, event_sequence=2, command=command,
            actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        ).dict())
        self.assertEqual("GATE1_GRANTED", result["receipt"]["status"])
        self.assertEqual(2, result["projection"]["projection_revision"])
        lease_id = result["receipt"]["gate1_lease_id"]
        active = await repository.workspace_gate1_lease(item.tenant_id, item.case_id, lease_id)
        self.assertIsNotNone(active)
        self.assertEqual("gate1-" + command.canonical_hash(), lease_id)
        self.assertEqual(command.canonical_hash(), active.issuance_command_fingerprint)
        self.assertEqual(canonical_evidence_set_hash([]), active.evidence_set_hash)
        retry = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
            **item.dict(), projection=result["projection"], event_sequence=3, command=command,
            actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
        ).dict())
        self.assertEqual("GATE1_GRANTED", retry["receipt"]["status"])
        with self.assertRaisesRegex(PolicyViolation, "workspace_action_idempotency_conflict"):
            await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
                **item.dict(), projection=result["projection"], event_sequence=3,
                command=command.copy(update={"action_id": "other-card"}),
                actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
            ).dict())

    async def test_fresh_read_failure_never_consumes_a_lease_before_complete_transition(self):
        item = binding()
        all_checkpoints = (
            "source", "after_evidence_admission", "after_audit", "after_projection", "after_lease",
            "after_cards", "after_receipt", "after_event", "after_transition",
        )
        for target in all_checkpoints:
            with self.subTest(target=target):
                initial = projection(item).copy(update={"generated_at": datetime.now(timezone.utc)})
                repository = InMemoryWorkspaceRepository()
                await repository.put_binding(item)
                await repository.put_projection(initial)
                adapter = ControlledMetricsAdapter()
                registry = CapabilityRegistry(
                    descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: adapter},
                    scope_authority=AcceptingScope(), gate1_authority=Gate1LeaseAuthority(repository, now=lambda: NOW),
                )
                gate_card = NextBestActionGenerator(registry).generate(initial, datetime.now(timezone.utc))[0]
                await repository.append_next_best_action(gate_card)
                dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
                gate_command = ActionInvocationCommand(
                    incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
                    projection_revision=1, action_id=gate_card.action_id, idempotency_key="grant-{}".format(target),
                )
                granted = await dispatcher.dispatch("workspace_execute_action_activity", WorkspaceActionPacket(
                    **item.dict(), projection=initial, event_sequence=2, command=gate_command,
                    actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
                ).dict())
                read_card = (await repository.workspace_next_best_actions(item.tenant_id, item.case_id))[-1]
                read_command = ActionInvocationCommand(
                    incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
                    projection_revision=granted["projection"]["projection_revision"], action_id=read_card.action_id,
                    idempotency_key="read-{}".format(target),
                )
                read_packet = WorkspaceActionPacket(
                    **item.dict(), projection=IncidentProjection.parse_obj(granted["projection"]), event_sequence=3,
                    command=read_command, actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
                )
                if target == "source":
                    adapter.fail_source = True
                else:
                    repository.failure_injector = lambda checkpoint, expected=target: (
                        (_ for _ in ()).throw(RuntimeError("injected:" + checkpoint))
                        if checkpoint == expected else None
                    )
                with self.assertRaisesRegex(RuntimeError, "source_failed|injected:"):
                    await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
                active = await repository.workspace_gate1_lease(
                    item.tenant_id, item.case_id, granted["receipt"]["gate1_lease_id"],
                )
                self.assertEqual((Gate1LeaseStatus.ACTIVE, 1), (active.status, active.lease_revision))
                self.assertEqual(0, len(repository.capability_audits))
                self.assertEqual(1, len(repository.workspace_action_commits))
                adapter.fail_source = False
                repository.failure_injector = None
                accepted = await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
                retried = await dispatcher.dispatch("workspace_execute_action_activity", read_packet.dict())
                self.assertEqual(accepted["receipt"], retried["receipt"])
                consumed = await repository.workspace_gate1_lease(
                    item.tenant_id, item.case_id, granted["receipt"]["gate1_lease_id"],
                )
                self.assertEqual((Gate1LeaseStatus.CONSUMED, 2), (consumed.status, consumed.lease_revision))
                self.assertEqual(1, len(repository.capability_audits))
                self.assertEqual(2, len(repository.workspace_action_commits))

    async def test_action_commit_rolls_back_every_persistence_boundary_then_retry_is_complete_once(self):
        item = binding()
        current = projection(item)
        command = ActionInvocationCommand(
            incident_id=item.incident_id, run_id=item.run_id, topology_revision=item.topology_revision,
            projection_revision=1, action_id="placeholder", idempotency_key="gate1-atomic-a",
        )
        for boundary in ("after_projection", "after_lease", "after_cards", "after_receipt", "after_event", "after_transition"):
            with self.subTest(boundary=boundary):
                repository = InMemoryWorkspaceRepository(failure_injector=lambda checkpoint, target=boundary: (
                    (_ for _ in ()).throw(RuntimeError("injected:" + checkpoint))
                    if checkpoint == target else None
                ))
                await repository.put_binding(item)
                await repository.put_projection(current)
                registry = CapabilityRegistry(
                    descriptors=[MetricsAdapter.descriptor], adapters={CapabilityName.METRICS: MetricsAdapter()},
                )
                card = NextBestActionGenerator(registry).generate(current, datetime.now(timezone.utc))[0]
                await repository.append_next_best_action(card)
                command = command.copy(update={"action_id": card.action_id})
                dispatcher = WorkspaceActivityDispatcher(repository, capability_registry=registry)
                packet = WorkspaceActionPacket(
                    **item.dict(), projection=current, event_sequence=2, command=command,
                    actor_tenant_id=item.tenant_id, actor_subject_id="subject-a", actor_roles=["viewer"],
                )
                with self.assertRaisesRegex(RuntimeError, "injected:" + boundary):
                    await dispatcher.dispatch("workspace_execute_action_activity", packet.dict())
                self.assertEqual(current, await repository.workspace_projection(item.tenant_id, item.case_id))
                self.assertEqual([], repository.events[(item.tenant_id, item.run_id, item.topology_revision)])
                self.assertEqual([], repository.gate1_leases[(item.tenant_id, item.case_id, "gate1-" + command.canonical_hash())])
                self.assertIsNone(await repository.workspace_action_receipt(
                    item.tenant_id, item.case_id, command.idempotency_key,
                ))

                repository.failure_injector = None
                accepted = await dispatcher.dispatch("workspace_execute_action_activity", packet.dict())
                self.assertEqual("GATE1_GRANTED", accepted["receipt"]["status"])
                retried = await dispatcher.dispatch("workspace_execute_action_activity", packet.dict())
                self.assertEqual(accepted["receipt"], retried["receipt"])
                self.assertEqual(2, (await repository.workspace_projection(item.tenant_id, item.case_id)).projection_revision)
                self.assertEqual(1, len(repository.events[(item.tenant_id, item.run_id, item.topology_revision)]))
                self.assertEqual(1, len(repository.gate1_leases[(item.tenant_id, item.case_id, "gate1-" + command.canonical_hash())]))


if __name__ == "__main__":
    unittest.main()

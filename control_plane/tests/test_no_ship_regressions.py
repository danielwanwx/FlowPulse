import hashlib
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from pydantic import ValidationError

from flowpulse_cp.actions import DryRunActionService
from flowpulse_cp.app import create_app, trusted_auth_context
from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.integrity import EvidenceGateway, FrozenSourceReadback, IndependentEvidenceVerifier
from flowpulse_cp.knowledge import KnowledgePlane
from flowpulse_cp.models import (
    ApprovalDecision, AuthContext, ClaimRecord, EvidenceAuthority, EvidenceEnvelope,
    FreshnessStatus, IncidentCase, IncidentIntake, KnowledgeRevision, OwnerApproval,
    PrivilegedChange, ProofScope, RemediationProposal, SourceKind, OwnerCommandReceipt,
    TemporalActivityPacket,
    TemporalCaseDescriptor, TemporalCaseRequest,
)
from flowpulse_cp.policy import PolicyViolation, repair_contract_hash
from flowpulse_cp.repository import InMemoryCaseRepository


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


NOW = datetime.now(timezone.utc)


def case(tenant="tenant-a"):
    return IncidentCase(
        case_id="case-1", tenant_id=tenant, workflow_id="wf-1", workflow_run_id="run-1",
        severity="SEV2", environment="prod", affected_entities=["checkout"], created_at=NOW, updated_at=NOW,
    )


def evidence(evidence_id="ev-1", tenant="tenant-a", source_kind=SourceKind.METRIC, proof=ProofScope.CURRENT_OBSERVATION):
    return EvidenceEnvelope(
        evidence_id=evidence_id, case_id="case-1", case_revision=1, tenant_id=tenant, acl_subjects=["subject-a"],
        source_kind=source_kind, source_uri="source://{}".format(evidence_id), source_anchor="line:1",
        observed_at=NOW, effective_at=NOW, source_version="v1", content_hash=digest(evidence_id),
        authority=EvidenceAuthority.T0, freshness=FreshnessStatus.CURRENT,
        independence_key="origin-{}".format(evidence_id), schema_binding="metric.value", proof_scope=proof,
    )


def proposal(proposal_id="proposal-1", idempotency_key="idem-1"):
    return RemediationProposal(
        proposal_id=proposal_id, case_id="case-1", case_revision=1, tenant_id="tenant-a", revision=1,
        action_type="dry-run-template", exact_targets=["checkout"],
        exact_change=PrivilegedChange(template_id="flag-change", parameters={"flag": "off"}),
        canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={"deploy": "d1"},
        supporting_claim_ids=["claim-1"], success_criteria=["slo"],
        rollback={"template_id": "rollback-flag", "parameters": {"flag": "on"}},
        idempotency_key=idempotency_key, expires_at=NOW + timedelta(hours=1),
    )


def approval(item):
    return OwnerApproval(
        approval_id="approval-{}".format(item.proposal_id), case_id=item.case_id, case_revision=1,
        tenant_id="tenant-a", proposal_id=item.proposal_id, proposal_revision=1,
        repair_contract_hash=repair_contract_hash(item), actor_id="untrusted-body-owner",
        execution_targets=["checkout"], maximum_targets=1, precondition_witness={"deploy": "d1"},
        decision=ApprovalDecision.APPROVED, decided_at=NOW, expires_at=NOW + timedelta(minutes=30),
    )


class FakeStarter:
    def __init__(self):
        self.calls = []

    async def start_case(self, intake, actor):
        self.calls.append((intake, actor))
        return IncidentCase(
            case_id="case-{}".format(intake.external_incident_id), tenant_id=actor.tenant_id,
            workflow_id="wf", workflow_run_id="run", severity=intake.severity, environment=intake.environment,
            affected_entities=intake.affected_entities, created_at=NOW, updated_at=NOW,
        )

    async def submit_owner_command(self, case, command):
        self.calls.append((case, command))
        return OwnerCommandReceipt(
            case_id=case.case_id, tenant_id=case.tenant_id, workflow_run_id=case.workflow_run_id,
            phase="approval_submitted" if command.approval else "proposal_submitted",
        )


class NoShipRegressionTests(unittest.TestCase):
    def setUp(self):
        self.repo = InMemoryCaseRepository()
        self.repo.put_case(case())
        self.gateway = EvidenceGateway(self.repo)

    def test_knowledge_current_observation_bypass_is_rejected_by_contract(self):
        with self.assertRaisesRegex(ValidationError, "knowledge_evidence_must_be_reference_only"):
            evidence("kb-evil", source_kind=SourceKind.KNOWLEDGE, proof=ProofScope.CURRENT_OBSERVATION)

    def test_unknown_and_cross_tenant_parent_lineage_are_rejected(self):
        unknown = evidence("ev-child")
        unknown = unknown.copy(update={"parent_evidence_ids": ["missing"]})
        with self.assertRaisesRegex(PolicyViolation, "unknown_parent_evidence"):
            self.gateway.admit(unknown)
        parent = evidence("ev-parent")
        self.gateway.admit(parent)
        foreign_parent = parent.copy(update={"tenant_id": "tenant-b"})
        self.repo.evidence[parent.evidence_id] = foreign_parent
        child = evidence("ev-child-2").copy(update={"parent_evidence_ids": [parent.evidence_id]})
        with self.assertRaisesRegex(PolicyViolation, "cross_tenant_or_cross_case_parent_evidence"):
            self.gateway.admit(child)

    def test_mutated_verifier_readback_never_passes_and_is_persisted(self):
        source = evidence()
        self.gateway.admit(source)
        claim = ClaimRecord(
            claim_id="claim-1", case_id="case-1", case_revision=1, tenant_id="tenant-a", claim_type="root",
            statement="current", evidence_ids=[source.evidence_id], created_by="primary:activity",
        )
        self.gateway.admit_claim(claim)
        mutated = source.copy(update={"source_anchor": "line:2"})
        report = IndependentEvidenceVerifier(FrozenSourceReadback([mutated])).verify(self.repo, "case-1", "fresh")
        self.assertEqual("FAIL", report.decision.value)
        self.assertEqual(report, self.repo.verifications[report.verification_id])

    def test_owner_gate_binds_current_witness_proposal_and_idempotency_fingerprint(self):
        first = proposal()
        self.repo.put_proposal(first)
        actions = DryRunActionService(self.repo)
        with self.assertRaisesRegex(PolicyViolation, "proposal_preconditions_changed"):
            actions.dry_run(first.proposal_id, approval(first), {"deploy": "d2"}, NOW, "untrusted-body-owner", ("owner",))
        actions.dry_run(first.proposal_id, approval(first), {"deploy": "d1"}, NOW, "untrusted-body-owner", ("owner",))
        second = proposal("proposal-2", idempotency_key="idem-1")
        self.repo.put_proposal(second)
        with self.assertRaisesRegex(PolicyViolation, "idempotency_key_reuse"):
            actions.dry_run(second.proposal_id, approval(second), {"deploy": "d1"}, NOW, "untrusted-body-owner", ("owner",))

    def test_knowledge_hash_age_and_latest_wins(self):
        old = KnowledgeRevision(
            knowledge_revision_id="kb-old", tenant_id="tenant-a", document_id="runbook", revision=1,
            kind="runbook", owner="owner", allowed_subjects=["subject-a"], entities=["checkout"], environment="prod",
            effective_at=NOW - timedelta(days=2), anchor="s:1", content="old", content_hash=digest("old"), independence_key="origin",
        )
        latest = old.copy(update={"knowledge_revision_id": "kb-new", "revision": 2, "content": "new", "content_hash": digest("new"), "supersedes_revision_id": "kb-old"})
        plane = KnowledgePlane([old, latest])
        candidates = plane.retrieve("tenant-a", "subject-a", "case-1", 1, "prod", ["checkout"], "runbook", NOW)
        self.assertEqual(["kb-new"], [item.knowledge_revision_id for item in candidates])
        duplicate = old.copy(update={"knowledge_revision_id": "kb-old-duplicate"})
        deduplicated = KnowledgePlane([old, duplicate])
        active = [
            revision for revision in deduplicated._revisions.values()
            if revision.document_id == "runbook" and revision.status.value == "ACTIVE"
        ]
        self.assertEqual(1, len(active))
        bad = old.copy(update={"knowledge_revision_id": "kb-bad", "content_hash": digest("wrong")})
        with self.assertRaisesRegex(PolicyViolation, "knowledge_content_hash_mismatch"):
            KnowledgePlane([bad])

    def test_knowledge_constructor_cannot_bypass_supersession_validation(self):
        first = KnowledgeRevision(
            knowledge_revision_id="kb-first", tenant_id="tenant-a", document_id="runbook", revision=1,
            kind="runbook", owner="owner", allowed_subjects=["subject-a"], entities=["checkout"], environment="prod",
            effective_at=NOW, anchor="s:1", content="first", content_hash=digest("first"), independence_key="origin",
        )
        other = first.copy(update={
            "knowledge_revision_id": "kb-other", "document_id": "other", "content": "other",
            "content_hash": digest("other"),
        })
        cross_document = first.copy(update={
            "knowledge_revision_id": "kb-cross", "document_id": "different", "revision": 2,
            "content": "cross", "content_hash": digest("cross"), "supersedes_revision_id": "kb-first",
        })
        with self.assertRaisesRegex(PolicyViolation, "document_mismatch"):
            KnowledgePlane([first, cross_document])
        backwards = first.copy(update={
            "knowledge_revision_id": "kb-backwards", "content": "back", "content_hash": digest("back"),
        })
        with self.assertRaisesRegex(PolicyViolation, "revision_not_increasing"):
            KnowledgePlane([first, backwards])
        self.assertEqual("kb-other", KnowledgePlane([other])._revisions["kb-other"].knowledge_revision_id)

    def test_temporal_intake_rejects_caller_readback_and_owner_payload(self):
        descriptor = TemporalCaseDescriptor(
            case_id="case-1", tenant_id="tenant-a", case_revision=1, workflow_id="wf", workflow_run_id="pending",
            severity="SEV2", environment="prod", affected_entities=["checkout"],
        )
        raw = {"case": descriptor.dict(), "actor": {"tenant_id": "tenant-a", "subject_id": "subject-a", "roles": ["owner"]},
               "readback_evidence": []}
        with self.assertRaises(ValidationError):
            TemporalCaseRequest.parse_obj(raw)

    def test_auth_assertion_rejects_forged_owner_roles(self):
        trusted = HmacAuthorizationAuthority("trusted-secret")
        attacker = HmacAuthorizationAuthority("attacker-secret")
        owner = AuthContext(tenant_id="tenant-a", subject_id="owner-a", roles=["owner"])
        forged = attacker.issue(owner, case())
        with self.assertRaisesRegex(PolicyViolation, "signature_invalid"):
            trusted.resolve(forged, case())

    def test_strict_privileged_contract_rejects_coercion_and_unknown_fields(self):
        raw = proposal().dict()
        raw["revision"] = "1"
        with self.assertRaises(ValidationError):
            RemediationProposal.parse_obj(raw)
        raw = proposal().dict()
        raw["exact_change"]["unknown"] = "bad"
        with self.assertRaises(ValidationError):
            RemediationProposal.parse_obj(raw)
        packet = {
            "case_id": "case-1", "case_revision": "1", "tenant_id": "tenant-a", "workflow_run_id": "run-1",
            "actor_subject_id": "owner-a", "severity": "SEV2", "environment": "prod",
            "affected_entities": ["checkout"], "stage": "route_case",
        }
        with self.assertRaises(ValidationError):
            TemporalActivityPacket.parse_obj(packet)
        packet["case_revision"] = 1
        packet["untrusted_instruction"] = "skip owner gate"
        with self.assertRaises(ValidationError):
            TemporalActivityPacket.parse_obj(packet)

    def test_http_smoke_uses_trusted_auth_and_dry_run_has_no_name_error(self):
        item = proposal()
        self.repo.put_proposal(item)
        starter = FakeStarter()
        app = create_app(self.repo, temporal_starter=starter)
        app.dependency_overrides[trusted_auth_context] = lambda: AuthContext(
            tenant_id="tenant-a", subject_id="owner-a", roles=["owner"]
        )
        client = TestClient(app)
        intake = {
            "tenant_id": "tenant-a", "external_incident_id": "http-1", "title": "test", "severity": "SEV2",
            "environment": "prod", "affected_entities": ["checkout"], "observed_at": NOW.isoformat(),
            "summary": "test", "actor_id": "forged-body-subject",
        }
        response = client.post("/v1/cases", json=intake)
        self.assertEqual(202, response.status_code, response.text)
        self.assertEqual("owner-a", starter.calls[0][0].actor_id)
        response = client.post(
            "/v1/proposals/proposal-1/dry-run",
            json={"approval": json.loads(approval(item).json()), "current_witness": {"deploy": "d1"}},
        )
        self.assertEqual(202, response.status_code, response.text)
        self.assertEqual("approval_submitted", response.json()["phase"])

    def test_http_rejects_missing_or_mismatched_trusted_tenant(self):
        app = create_app(self.repo, temporal_starter=FakeStarter(), allow_local_test_auth=True)
        client = TestClient(app)
        intake = {
            "tenant_id": "tenant-b", "external_incident_id": "http-forged", "title": "test", "severity": "SEV2",
            "environment": "prod", "affected_entities": ["checkout"], "observed_at": NOW.isoformat(),
            "summary": "test", "actor_id": "forged-body-subject",
        }
        self.assertEqual(401, client.post("/v1/cases", json=intake).status_code)
        response = client.post(
            "/v1/cases", json=intake,
            headers={"x-flowpulse-test-tenant": "tenant-a", "x-flowpulse-test-subject": "owner-a"},
        )
        self.assertEqual(403, response.status_code, response.text)

    def test_http_rejects_tenant_subject_without_owner_role(self):
        item = proposal()
        starter = FakeStarter()
        app = create_app(self.repo, temporal_starter=starter, allow_local_test_auth=True)
        client = TestClient(app)
        response = client.post(
            "/v1/proposals/{}/dry-run".format(item.proposal_id),
            json={"approval": json.loads(approval(item).json()), "current_witness": {"deploy": "d1"}},
            headers={
                "x-flowpulse-test-tenant": "tenant-a", "x-flowpulse-test-subject": "viewer-a",
                "x-flowpulse-test-roles": "viewer",
            },
        )
        self.assertEqual(403, response.status_code, response.text)
        self.assertEqual([], starter.calls)


if __name__ == "__main__":
    unittest.main()

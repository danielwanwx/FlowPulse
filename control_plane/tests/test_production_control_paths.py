import hashlib
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import ValidationError

from flowpulse_cp.integrity import EvidenceGateway, REQUIRED_COVERAGE
from flowpulse_cp.knowledge import KnowledgePlane
from flowpulse_cp.models import (
    ApprovalDecision, ClaimRecord, CoverageEntry, CoverageStatus, EvidenceAuthority, EvidenceEnvelope,
    FreshnessStatus, IncidentCase, KnowledgeRevision, OwnerApproval, ProofScope, RemediationProposal,
    SourceKind, TemporalActivityPacket, VerificationDecision, EvaluationMetrics,
)
from flowpulse_cp.object_store import S3ObjectStore
from flowpulse_cp.policy import PolicyViolation, repair_contract_hash, validate_owner_gate
from flowpulse_cp.postgres import activity_event_identity
from flowpulse_cp.repository import InMemoryCaseRepository
from flowpulse_cp.temporal_runtime import DomainActivityEngine


NOW = datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def case():
    return IncidentCase(
        case_id="case-controls", tenant_id="tenant-a", workflow_id="wf", workflow_run_id="run",
        severity="SEV2", environment="prod", affected_entities=["checkout"], created_at=NOW, updated_at=NOW,
    )


def current(evidence_id="ev-current", anchor="line:1", acl=None):
    return EvidenceEnvelope(
        evidence_id=evidence_id, case_id="case-controls", case_revision=1, tenant_id="tenant-a",
        acl_subjects=acl or ["owner-a"], source_kind=SourceKind.METRIC, source_uri="metric://checkout",
        source_anchor=anchor, observed_at=NOW, effective_at=NOW, source_version="v1",
        content_hash=digest(evidence_id), authority=EvidenceAuthority.T0, freshness=FreshnessStatus.CURRENT,
        independence_key="origin-1", schema_binding="metric.v1", proof_scope=ProofScope.CURRENT_OBSERVATION,
    )


def proposal(targets=None, maximum_targets=1):
    return RemediationProposal(
        proposal_id="proposal-controls", case_id="case-controls", case_revision=1, tenant_id="tenant-a", revision=1,
        action_type="dry-run", exact_targets=targets or ["checkout"],
        exact_change={"template_id": "feature", "parameters": {"value": "off"}},
        canary_scope={"maximum_targets": maximum_targets, "environment": "prod"},
        preconditions={"deploy": "d1"}, supporting_claim_ids=["claim-controls"], success_criteria=["slo"],
        rollback={"template_id": "rollback", "parameters": {"value": "on"}}, idempotency_key="idem-controls",
        expires_at=NOW + timedelta(hours=1),
    )


def approval(item, targets=None, witness=None):
    return OwnerApproval(
        approval_id="approval-controls", case_id=item.case_id, case_revision=item.case_revision,
        tenant_id=item.tenant_id, proposal_id=item.proposal_id, proposal_revision=item.revision,
        repair_contract_hash=repair_contract_hash(item), actor_id="owner-a",
        execution_targets=targets or item.exact_targets, maximum_targets=len(item.exact_targets),
        precondition_witness=item.preconditions if witness is None else witness, decision=ApprovalDecision.APPROVED,
        decided_at=NOW, expires_at=NOW + timedelta(minutes=30),
    )


class FakeS3:
    def __init__(self):
        self.items = {}

    def put_object(self, Bucket, Key, Body, Metadata):
        self.items[(Bucket, Key)] = {"Body": Body, "Metadata": Metadata}

    def get_object(self, Bucket, Key):
        item = self.items[(Bucket, Key)]
        return {"Body": type("Body", (), {"read": lambda _self: item["Body"]})()}


class ProductionControlPathTests(unittest.TestCase):
    def packet(self, stage, *, readback=None, proposal_record=None, approval_record=None, witness=None, coverage=None):
        evidence = current()
        claim = ClaimRecord(
            claim_id="claim-controls", case_id="case-controls", case_revision=1, tenant_id="tenant-a",
            claim_type="root", statement="current observation", evidence_ids=[evidence.evidence_id], created_by="primary",
        )
        return TemporalActivityPacket(
            case_id="case-controls", case_revision=1, tenant_id="tenant-a", workflow_id="wf-real", workflow_run_id="run-real",
            actor_subject_id="owner-a", severity="SEV2", environment="prod", affected_entities=["checkout"],
            stage=stage, sequence=1, evidence=[evidence], readback_evidence=readback if readback is not None else [evidence],
            claims=[claim], coverage=coverage if coverage is not None else [
                CoverageEntry(case_id="case-controls", tenant_id="tenant-a", field=field, status=CoverageStatus.FILLED)
                for field in REQUIRED_COVERAGE
            ], proposal=proposal_record, approval=approval_record, current_witness=witness or {},
        )

    def test_current_proof_layers_reject_untrusted_unknown_acl_and_revision(self):
        untrusted = current().dict()
        untrusted["authority"] = EvidenceAuthority.T4
        with self.assertRaisesRegex(ValidationError, "trusted_authority"):
            EvidenceEnvelope.parse_obj(untrusted)
        unknown = current().dict()
        unknown["freshness"] = FreshnessStatus.UNKNOWN
        with self.assertRaisesRegex(ValidationError, "current_freshness"):
            EvidenceEnvelope.parse_obj(unknown)
        repository = InMemoryCaseRepository()
        repository.put_case(case())
        unsafe_copy = current().copy(update={"authority": EvidenceAuthority.T4, "freshness": FreshnessStatus.UNKNOWN})
        with self.assertRaisesRegex(PolicyViolation, "current_incident_proof_requires_current_freshness"):
            EvidenceGateway(repository, "owner-a").admit(unsafe_copy)
        with self.assertRaisesRegex(PolicyViolation, "acl_subject_denied"):
            EvidenceGateway(repository, "wrong-subject").admit(current())
        gateway = EvidenceGateway(repository, "owner-a")
        gateway.admit(current())
        claim = ClaimRecord(
            claim_id="claim-revision", case_id="case-controls", case_revision=999, tenant_id="tenant-a",
            claim_type="root", statement="wrong revision", evidence_ids=["ev-current"], created_by="primary",
        )
        with self.assertRaisesRegex(PolicyViolation, "claim_case_revision_mismatch"):
            gateway.admit_claim(claim)

    def test_owner_gate_requires_exact_order_and_canary_cap(self):
        two_targets = proposal(["checkout-a", "checkout-b"], maximum_targets=2)
        with self.assertRaisesRegex(PolicyViolation, "target_sequence"):
            validate_owner_gate(approval(two_targets, ["checkout-b", "checkout-a"]), two_targets, 1, {"deploy": "d1"}, NOW)
        bypass = proposal(["checkout-a", "checkout-b"], maximum_targets=1)
        with self.assertRaisesRegex(PolicyViolation, "canary_maximum"):
            validate_owner_gate(approval(bypass), bypass, 1, {"deploy": "d1"}, NOW)

    def test_domain_activity_controls_negative_paths(self):
        engine = DomainActivityEngine()
        critic = engine.execute(self.packet("critic", coverage=[]))
        self.assertNotEqual(VerificationDecision.PASS, critic.decision)
        verifier = engine.execute(self.packet("independent_verify", readback=[]))
        self.assertEqual(VerificationDecision.FAIL, verifier.decision)
        item = proposal()
        owner = engine.execute(self.packet("owner_gate", proposal_record=item, approval_record=approval(item, witness={"deploy": "changed"}), witness={"deploy": "d1"}))
        self.assertEqual(VerificationDecision.FAIL, owner.decision)
        self.assertEqual("BLOCKED", owner.state.value)

    def test_knowledge_supersession_requires_same_document_and_increasing_revision(self):
        first = KnowledgeRevision(
            knowledge_revision_id="kb-one", tenant_id="tenant-a", document_id="doc-a", revision=1, kind="runbook",
            owner="owner", allowed_subjects=["owner-a"], entities=["checkout"], environment="prod", effective_at=NOW,
            anchor="s:1", content="one", content_hash=digest("one"), independence_key="kb",
        )
        plane = KnowledgePlane([first])
        foreign_document = first.copy(update={
            "knowledge_revision_id": "kb-two", "document_id": "doc-b", "revision": 2, "content": "two",
            "content_hash": digest("two"), "supersedes_revision_id": "kb-one",
        })
        with self.assertRaisesRegex(PolicyViolation, "document_mismatch"):
            plane.promote(foreign_document, owner_reviewed=True)
        reverse = first.copy(update={
            "knowledge_revision_id": "kb-zero", "revision": 1, "content": "zero", "content_hash": digest("zero"),
            "supersedes_revision_id": "kb-one",
        })
        with self.assertRaisesRegex(PolicyViolation, "revision_not_increasing"):
            plane.promote(reverse, owner_reviewed=True)

    def test_s3_port_checks_tenant_and_content_hash(self):
        client = FakeS3()
        store = S3ObjectStore(client, "evidence")
        key = store.put("tenant-a", b"evidence")
        self.assertEqual(b"evidence", store.get("tenant-a", key))
        with self.assertRaisesRegex(PolicyViolation, "cross_tenant"):
            store.get("tenant-b", key)
        client.items[("evidence", key)]["Body"] = b"tampered"
        with self.assertRaisesRegex(PolicyViolation, "content_hash_mismatch"):
            store.get("tenant-a", key)

    def test_citation_precision_is_strict_float(self):
        with self.assertRaises(ValidationError):
            EvaluationMetrics(evaluation_trial_id="eval", variant="p0", citation_precision="0.5")

    def test_activity_retry_identity_is_stable(self):
        packet = self.packet("critic")
        self.assertEqual(
            activity_event_identity(packet, "activity-7"), activity_event_identity(packet, "activity-7")
        )


if __name__ == "__main__":
    unittest.main()

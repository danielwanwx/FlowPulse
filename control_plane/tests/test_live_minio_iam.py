"""Opt-in proof that worker source-read and artifact-write identities are disjoint."""

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3
from botocore.exceptions import ClientError

from flowpulse_cp.integrity import EvidenceGateway, IndependentEvidenceVerifier
from flowpulse_cp.models import ClaimRecord, IncidentCase
from flowpulse_cp.repository import InMemoryCaseRepository
from flowpulse_cp.source_readback import S3SourceReadback
from flowpulse_cp.policy import PolicyViolation


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_MINIO") == "1", "requires the local Compose MinIO IAM fixture")
class LiveMinioIamTests(unittest.TestCase):
    endpoint = os.environ.get("FLOWPULSE_MINIO_ENDPOINT", "http://127.0.0.1:9000")
    source_bucket = "flowpulse-sources"
    artifact_bucket = "flowpulse-evidence"

    def client(self, key, secret):
        return boto3.client(
            "s3", endpoint_url=self.endpoint, aws_access_key_id=key, aws_secret_access_key=secret,
            region_name="us-east-1",
        )

    def test_reader_is_read_only_scoped_and_verifier_uses_it(self):
        reader = self.client(
            "flowpulse-source-reader-tenant-minio", "flowpulse-source-reader-tenant-minio-local-only",
        )
        writer = self.client("flowpulse-artifact-writer-local", "flowpulse-artifact-writer-local-only")
        key = "controlled/tenant-minio/cases/case-minio/revisions/1/evidence/ev-minio/v1.json"
        raw = reader.get_object(Bucket=self.source_bucket, Key=key)["Body"].read()
        self.assertTrue(raw)
        with self.assertRaises(ClientError):
            reader.put_object(Bucket=self.source_bucket, Key=key, Body=b"forbidden")
        with self.assertRaises(ClientError):
            reader.get_object(Bucket=self.artifact_bucket, Key="tenant-minio/sha256/missing")
        with self.assertRaises(ClientError):
            writer.get_object(Bucket=self.source_bucket, Key=key)
        with self.assertRaises(ClientError):
            reader.get_object(
                Bucket=self.source_bucket,
                Key="controlled/tenant-other/cases/case-other/revisions/1/evidence/ev-other/v1.json",
            )
        with self.assertRaises(ClientError):
            reader.list_objects_v2(Bucket=self.source_bucket, Prefix="controlled/tenant-other/")

        import json
        from flowpulse_cp.models import EvidenceEnvelope
        evidence = EvidenceEnvelope.parse_obj(json.loads(raw.decode("utf-8")))
        source = S3SourceReadback(reader, self.source_bucket, "controlled", "tenant-minio")
        reread = source.readback(evidence)
        self.assertEqual(evidence, reread)
        with self.assertRaisesRegex(PolicyViolation, "adapter_binding_missing"):
            source.readback(evidence.copy(update={"source_uri": "s3://wrong-bucket/controlled/x"}))
        with self.assertRaisesRegex(PolicyViolation, "adapter_binding_missing"):
            source.readback(evidence.copy(update={"source_uri": "s3://flowpulse-sources/attacker/key"}))
        with self.assertRaisesRegex(PolicyViolation, "tenant_credential_mismatch"):
            source.readback(evidence.copy(update={"tenant_id": "tenant-other"}))

        now = datetime.now(timezone.utc)
        case = IncidentCase(
            case_id=evidence.case_id, tenant_id=evidence.tenant_id, case_revision=evidence.case_revision,
            workflow_id="minio-iam", workflow_run_id="minio-iam-run", severity="SEV2", environment="prod",
            affected_entities=["checkout"], created_at=now, updated_at=now,
        )
        repository = InMemoryCaseRepository()
        repository.put_case(case)
        gateway = EvidenceGateway(repository, "owner-minio")
        gateway.admit(evidence)
        claim = ClaimRecord(
            claim_id="claim-minio", case_id=case.case_id, case_revision=case.case_revision,
            tenant_id=case.tenant_id, claim_type="root", statement="fixture", evidence_ids=[evidence.evidence_id],
            created_by="primary:minio",
        )
        gateway.admit_claim(claim)
        report = IndependentEvidenceVerifier(source).verify(repository, case.case_id, case.workflow_run_id, subject_id="owner-minio")
        self.assertEqual("PASS", report.decision.value)


if __name__ == "__main__":
    unittest.main()

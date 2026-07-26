"""Real Compose proof that Gate 1 reaches the worker's controlled source adapter."""

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3

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
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_actions import canonical_evidence_set_hash


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_WORKSPACE_GATE1_PRODUCTION") == "1",
    "requires a rebuilt local Compose worker with the tenant-minio fixture identity",
)
class LiveWorkspaceGate1ProductionTests(unittest.TestCase):
    base_url = os.environ.get("FLOWPULSE_API_URL", "http://127.0.0.1:8090")
    owner_token = os.environ.get("FLOWPULSE_LIVE_API_OWNER_TOKEN")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
    minio_endpoint = os.environ.get("FLOWPULSE_MINIO_ENDPOINT", "http://127.0.0.1:9000")

    @classmethod
    def setUpClass(cls):
        if not cls.owner_token:
            raise unittest.SkipTest("requires FLOWPULSE_LIVE_API_OWNER_TOKEN")

    def request(self, method, path, payload=None):
        request = Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            method=method,
        )
        request.add_header("content-type", "application/json")
        request.add_header("authorization", "Bearer " + self.owner_token)
        try:
            with urlopen(request, timeout=20) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def _seed_controlled_manifest(self, projection):
        now = datetime.now(timezone.utc)
        evidence_id = "gate1-source-{}".format(uuid4().hex)
        source_key = "controlled/tenant-minio/cases/{}/revisions/1/evidence/{}/v1.json".format(
            projection["case_id"], evidence_id,
        )
        evidence = EvidenceEnvelope(
            evidence_id=evidence_id, tenant_id="tenant-minio", case_id=projection["case_id"], case_revision=1,
            acl_subjects=["owner-minio"], source_kind=SourceKind.METRIC,
            source_uri="s3://flowpulse-sources/{}".format(source_key), source_anchor="compose:gate1",
            observed_at=now, effective_at=now, source_version="compose-gate1-v1",
            content_hash=sha256((projection["case_id"] + evidence_id).encode("utf-8")).hexdigest(),
            authority=EvidenceAuthority.T0, freshness=FreshnessStatus.CURRENT,
            independence_key="compose-gate1:{}".format(projection["case_id"]), schema_binding="metric.v1",
            proof_scope=ProofScope.CURRENT_OBSERVATION,
        )
        claim = ClaimRecord(
            claim_id="gate1-claim-{}".format(uuid4().hex), tenant_id="tenant-minio",
            case_id=projection["case_id"], case_revision=1, claim_type="symptom",
            statement="Controlled source read confirms the current checkout symptom.",
            evidence_ids=[evidence.evidence_id], created_by="gate1:controlled-source",
        )
        coverage = CoverageEntry(
            tenant_id="tenant-minio", case_id=projection["case_id"],
            field="telemetry_symptom", status=CoverageStatus.FILLED,
        )
        client = boto3.client(
            "s3", endpoint_url=self.minio_endpoint,
            aws_access_key_id="flowpulse-local-root", aws_secret_access_key="flowpulse-local-root-only",
            region_name="us-east-1",
        )
        client.put_object(Bucket="flowpulse-sources", Key=source_key, Body=evidence.json().encode("utf-8"))
        manifest_key = "controlled/tenant-minio/cases/{}/revisions/1/current-evidence.json".format(
            projection["case_id"],
        )
        client.put_object(
            Bucket="flowpulse-sources", Key=manifest_key,
            Body=json.dumps({
                "evidence": [json.loads(evidence.json())],
                "claims": [json.loads(claim.json())],
                "coverage": [json.loads(coverage.json())],
            }).encode("utf-8"),
        )
        return evidence, manifest_key

    def test_http_temporal_gate1_reads_controlled_source_and_commits_complete_ledger(self):
        observed_at = datetime.now(timezone.utc).isoformat()
        status, projection = self.request("POST", "/v1/incidents", {
            "incident_id": "workspace-gate1-compose-{}".format(uuid4().hex),
            "title": "Gate 1 production source smoke", "severity": "SEV2", "environment": "local",
            "affected_entities": ["checkout"], "observed_at": observed_at,
            "summary": "Actual worker source-read acceptance proof.",
        })
        self.assertEqual(202, status, projection)
        self.assertEqual("tenant-minio", projection["tenant_id"])
        evidence, manifest_key = self._seed_controlled_manifest(projection)

        status, cards = self.request("GET", "/v1/incidents/{}/actions".format(projection["case_id"]))
        self.assertEqual(200, status, cards)
        gate = next(card for card in cards if card["cta"] == "request_gate_1")
        status, granted = self.request("POST", "/v1/incidents/{}/actions/{}".format(
            projection["case_id"], gate["action_id"],
        ), {
            "incident_id": projection["incident_id"], "run_id": projection["run_id"],
            "topology_revision": projection["topology_revision"],
            "projection_revision": projection["projection_revision"], "action_id": gate["action_id"],
            "idempotency_key": "gate1-compose-{}".format(uuid4().hex),
        })
        self.assertEqual(202, status, granted)
        self.assertEqual("GATE1_GRANTED", granted["status"])

        status, cards = self.request("GET", "/v1/incidents/{}/actions".format(projection["case_id"]))
        self.assertEqual(200, status, cards)
        read = next(card for card in cards if card["cta"] == "run_read_capability")
        status, completed = self.request("POST", "/v1/incidents/{}/actions/{}".format(
            projection["case_id"], read["action_id"],
        ), {
            "incident_id": projection["incident_id"], "run_id": projection["run_id"],
            "topology_revision": projection["topology_revision"],
            "projection_revision": read["projection_revision"], "action_id": read["action_id"],
            "idempotency_key": "read-compose-{}".format(uuid4().hex),
        })
        self.assertEqual(202, status, completed)
        self.assertEqual("FRESH_READ_COMPLETED", completed["status"])

        async def counts():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                async def operation(connection):
                    rows = await connection.fetchrow(
                        """SELECT
                             (SELECT count(*) FROM evidence_envelopes WHERE tenant_id='tenant-minio' AND case_id=$1) AS evidence,
                             (SELECT count(*) FROM tool_calls WHERE tenant_id='tenant-minio' AND case_id=$1 AND status='COMPLETED') AS audits,
                             (SELECT count(*) FROM workspace_action_transitions WHERE tenant_id='tenant-minio' AND case_id=$1) AS transitions,
                             (SELECT count(*) FROM incident_projection_events WHERE tenant_id='tenant-minio' AND case_id=$1) AS events""",
                        projection["case_id"],
                    )
                    lease = await connection.fetchrow(
                        """SELECT payload FROM workspace_gate1_leases
                           WHERE tenant_id='tenant-minio' AND case_id=$1 ORDER BY lease_revision DESC LIMIT 1""",
                        projection["case_id"],
                    )
                    return rows, lease["payload"]
                return await repository._tenant("tenant-minio", operation, subject_id="owner-minio")
            finally:
                await repository.close()

        rows, lease_payload = asyncio.run(counts())
        self.assertEqual((1, 1, 2, 3), tuple(rows))
        payload = lease_payload if isinstance(lease_payload, dict) else json.loads(lease_payload)
        self.assertEqual("CONSUMED", payload["status"])
        self.assertEqual(canonical_evidence_set_hash([]), payload["evidence_set_hash"])
        self.assertEqual(canonical_evidence_set_hash([]), payload["consumed_evidence_set_hash"])
        self.assertEqual(1, payload["consumed_evidence_revision"])
        self.assertEqual(64, len(payload["issuance_command_fingerprint"]))
        self.assertEqual(64, len(payload["consumed_command_fingerprint"]))
        evidence_dir = Path("/tmp/flowpulse-incident-workspace-evidence")
        evidence_dir.mkdir(parents=True, exist_ok=True)
        (evidence_dir / (projection["run_id"] + ".json")).write_text(json.dumps({
            "incident_id": projection["incident_id"], "run_id": projection["run_id"],
            "topology_revision": projection["topology_revision"], "case_id": projection["case_id"],
            "workflow_id": projection["workflow_id"], "workflow_run_id": projection["workflow_run_id"],
            "source_manifest_key": manifest_key, "evidence_id": evidence.evidence_id,
        }, sort_keys=True), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()

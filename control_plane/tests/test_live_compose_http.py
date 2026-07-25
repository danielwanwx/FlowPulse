"""Opt-in HTTP integration test for the local Compose API/Postgres/Temporal chain."""

import json
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.models import ApprovalDecision, OwnerApproval, RemediationProposal
from flowpulse_cp.policy import repair_contract_hash


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_COMPOSE") == "1", "requires the local Compose stack")
class LiveComposeHttpTests(unittest.TestCase):
    base_url = os.environ.get("FLOWPULSE_API_URL", "http://127.0.0.1:8090")
    headers = {"x-flowpulse-test-tenant": "tenant-http", "x-flowpulse-test-subject": "owner-http"}

    def request(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(self.base_url + path, data=body, method=method)
        request.add_header("content-type", "application/json")
        for key, value in (headers or self.headers).items():
            request.add_header(key, value)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_intake_get_proposal_approval_and_dry_run(self):
        now = datetime.now(timezone.utc)
        external = "http-{}".format(uuid4().hex)
        status, intake = self.request("POST", "/v1/cases", {
            "tenant_id": "tenant-http", "external_incident_id": external, "title": "Compose smoke",
            "severity": "SEV2", "environment": "prod", "affected_entities": ["checkout"],
            "observed_at": now.isoformat(), "summary": "deterministic local intake", "actor_id": "forged-body",
        })
        self.assertEqual(202, status, intake)
        self.assertNotEqual("pending", intake["workflow_run_id"])
        case_id = intake["case_id"]

        case = None
        for _ in range(30):
            status, case = self.request("GET", "/v1/cases/" + case_id)
            if status == 200:
                break
            time.sleep(0.1)
        self.assertEqual(200, status, case)
        self.assertEqual(intake["workflow_run_id"], case["workflow_run_id"])

        proposal = RemediationProposal(
            proposal_id="proposal-http-{}".format(uuid4().hex), case_id=case_id, case_revision=1,
            tenant_id="tenant-http", revision=1, action_type="dry-run", exact_targets=["checkout"],
            exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
            supporting_claim_ids=["claim-{}".format(case_id)], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="http-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )
        status, stored = self.request("POST", "/v1/proposals", json.loads(proposal.json()))
        self.assertEqual(202, status, stored)

        approval = OwnerApproval(
            approval_id="approval-http-{}".format(uuid4().hex), case_id=case_id, case_revision=1,
            tenant_id="tenant-http", proposal_id=proposal.proposal_id, proposal_revision=proposal.revision,
            repair_contract_hash=repair_contract_hash(proposal), actor_id="forged-body-owner",
            execution_targets=["checkout"], maximum_targets=1, precondition_witness={},
            decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        status, receipt = self.request(
            "POST", "/v1/proposals/{}/dry-run".format(proposal.proposal_id),
            {"approval": json.loads(approval.json()), "current_witness": {}},
        )
        self.assertEqual(200, status, receipt)
        self.assertFalse(receipt["external_write_performed"])

        status, hidden = self.request(
            "GET", "/v1/cases/" + case_id,
            headers={"x-flowpulse-test-tenant": "tenant-other", "x-flowpulse-test-subject": "owner-other"},
        )
        self.assertEqual(404, status, hidden)


if __name__ == "__main__":
    unittest.main()

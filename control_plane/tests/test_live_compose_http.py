"""Opt-in API/Temporal/Postgres proof for the owner-wait command path."""

import asyncio
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
from flowpulse_cp.postgres import PostgresCaseRepository


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_COMPOSE") == "1", "requires the local Compose stack")
class LiveComposeHttpTests(unittest.TestCase):
    base_url = os.environ.get("FLOWPULSE_API_URL", "http://127.0.0.1:8090")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
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

    def intake_and_wait(self):
        now = datetime.now(timezone.utc)
        external = "http-{}".format(uuid4().hex)
        status, intake = self.request("POST", "/v1/cases", {
            "tenant_id": "tenant-http", "external_incident_id": external, "title": "Compose smoke",
            "severity": "SEV2", "environment": "prod", "affected_entities": ["checkout"],
            "observed_at": now.isoformat(), "summary": "deterministic local intake", "actor_id": "forged-body",
        })
        self.assertEqual(202, status, intake)
        self.assertNotEqual("pending", intake["workflow_run_id"])
        for _ in range(50):
            status, case = self.request("GET", "/v1/cases/" + intake["case_id"])
            if status == 200 and case["state"] == "AWAITING_OWNER":
                self.assertEqual(intake["workflow_run_id"], case["workflow_run_id"])
                return now, case
            time.sleep(0.1)
        self.fail("Temporal projection did not reach AWAITING_OWNER: {}".format(case))

    def proposal(self, now, case, *, preconditions=None):
        return RemediationProposal(
            proposal_id="proposal-http-{}".format(uuid4().hex), case_id=case["case_id"], case_revision=1,
            tenant_id="tenant-http", revision=1, action_type="dry-run", exact_targets=["checkout"],
            exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions=preconditions or {},
            supporting_claim_ids=["claim-{}".format(case["case_id"])], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="http-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )

    def db_counts(self, case_id, approval_id, proposal_id):
        async def run():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                async def operation(connection):
                    candidate = await connection.fetchrow(
                        "SELECT status FROM owner_approval_candidates WHERE case_id=$1 AND approval_id=$2",
                        case_id, approval_id,
                    )
                    approvals = await connection.fetchval(
                        "SELECT count(*) FROM owner_approvals WHERE case_id=$1 AND approval_id=$2", case_id, approval_id,
                    )
                    actions = await connection.fetchval(
                        "SELECT count(*) FROM action_executions WHERE case_id=$1 AND proposal_id=$2", case_id, proposal_id,
                    )
                    return (candidate["status"] if candidate else None, approvals, actions)
                return await repository._tenant("tenant-http", operation)
            finally:
                await repository.close()
        return asyncio.run(run())

    def test_http_commands_resume_temporal_and_persist_authoritative_acceptance(self):
        now, case = self.intake_and_wait()
        proposal = self.proposal(now, case)
        status, command = self.request("POST", "/v1/proposals", json.loads(proposal.json()))
        self.assertEqual(202, status, command)
        self.assertEqual("proposal_submitted", command["phase"])
        approval = OwnerApproval(
            approval_id="approval-http-{}".format(uuid4().hex), case_id=case["case_id"], case_revision=1,
            tenant_id="tenant-http", proposal_id=proposal.proposal_id, proposal_revision=proposal.revision,
            repair_contract_hash=repair_contract_hash(proposal), actor_id="forged-body-owner",
            execution_targets=["checkout"], maximum_targets=1, precondition_witness={}, decision=ApprovalDecision.APPROVED,
            decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        status, command = self.request(
            "POST", "/v1/proposals/{}/dry-run".format(proposal.proposal_id),
            {"approval": json.loads(approval.json()), "current_witness": {}},
        )
        self.assertEqual(202, status, command)
        self.assertEqual("approval_submitted", command["phase"])
        for _ in range(30):
            candidate, approvals, actions = self.db_counts(case["case_id"], approval.approval_id, proposal.proposal_id)
            if candidate is not None:
                break
            time.sleep(0.1)
        self.assertEqual(("VERIFIED", 1, 1), (candidate, approvals, actions))

    def test_blocked_approval_is_candidate_only_and_projects_blocked(self):
        now, case = self.intake_and_wait()
        proposal = self.proposal(now, case, preconditions={"deploy": "d1"})
        self.assertEqual(202, self.request("POST", "/v1/proposals", json.loads(proposal.json()))[0])
        approval = OwnerApproval(
            approval_id="approval-http-{}".format(uuid4().hex), case_id=case["case_id"], case_revision=1,
            tenant_id="tenant-http", proposal_id=proposal.proposal_id, proposal_revision=proposal.revision,
            repair_contract_hash=repair_contract_hash(proposal), actor_id="forged-body-owner",
            execution_targets=["checkout"], maximum_targets=1, precondition_witness={"deploy": "changed"},
            decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        self.assertEqual(202, self.request(
            "POST", "/v1/proposals/{}/dry-run".format(proposal.proposal_id),
            {"approval": json.loads(approval.json()), "current_witness": {"deploy": "d1"}},
        )[0])
        for _ in range(30):
            _, projected = self.request("GET", "/v1/cases/" + case["case_id"])
            if projected["state"] == "BLOCKED":
                break
            time.sleep(0.1)
        self.assertEqual("BLOCKED", projected["state"])
        self.assertEqual(("REJECTED", 0, 0), self.db_counts(case["case_id"], approval.approval_id, proposal.proposal_id))

    def test_non_owner_is_rejected_before_temporal_command(self):
        now, case = self.intake_and_wait()
        proposal = self.proposal(now, case)
        self.assertEqual(202, self.request("POST", "/v1/proposals", json.loads(proposal.json()))[0])
        approval = OwnerApproval(
            approval_id="approval-http-{}".format(uuid4().hex), case_id=case["case_id"], case_revision=1,
            tenant_id="tenant-http", proposal_id=proposal.proposal_id, proposal_revision=proposal.revision,
            repair_contract_hash=repair_contract_hash(proposal), actor_id="forged", execution_targets=["checkout"],
            maximum_targets=1, precondition_witness={}, decision=ApprovalDecision.APPROVED,
            decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        status, body = self.request(
            "POST", "/v1/proposals/{}/dry-run".format(proposal.proposal_id),
            {"approval": json.loads(approval.json()), "current_witness": {}},
            headers={
                "x-flowpulse-test-tenant": "tenant-http", "x-flowpulse-test-subject": "viewer-http",
                "x-flowpulse-test-roles": "viewer",
            },
        )
        self.assertEqual(403, status, body)
        self.assertEqual((None, 0, 0), self.db_counts(case["case_id"], approval.approval_id, proposal.proposal_id))


if __name__ == "__main__":
    unittest.main()

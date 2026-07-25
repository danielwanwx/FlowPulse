"""Opt-in black-box checks against the local Compose Temporal worker.

Run with FLOWPULSE_LIVE_TEMPORAL=1 after ``docker compose up --build -d``.
They prove that terminal control decisions come from the actual registered
activities, rather than a workflow's unconditional happy-path return.
"""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client

from flowpulse_cp.models import (
    ApprovalDecision,
    AuthContext,
    IncidentCase,
    OwnerApproval,
    RemediationProposal,
    TemporalCaseDescriptor,
    TemporalCaseRequest,
)
from flowpulse_cp.policy import repair_contract_hash
from flowpulse_cp.temporal_runtime import TemporalStarter
from flowpulse_cp.temporal_workflow import DiagnosisTemporalWorkflow


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_TEMPORAL") == "1", "requires the local Compose stack")
class LiveTemporalNegativePathTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "127.0.0.1:7233")
    queue = os.environ.get("FLOWPULSE_TEMPORAL_TASK_QUEUE", "flowpulse-diagnosis-p0")

    def request(self, *, coverage=True, readback=True, proposal=None, approval=None, witness=None):
        now = datetime.now(timezone.utc)
        suffix = uuid4().hex
        actor = AuthContext(tenant_id="tenant-live", subject_id="owner-live", roles=["owner"])
        workflow_id = "flowpulse.live.{}".format(suffix)
        case = IncidentCase(
            case_id="case-live-{}".format(suffix), tenant_id=actor.tenant_id,
            workflow_id=workflow_id, workflow_run_id="starter-placeholder", severity="SEV2",
            environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
        )
        evidence, source_readback, claims, full_coverage = TemporalStarter(
            self.address, self.queue, local_deterministic_evidence=True
        )._local_records(case, actor)
        return TemporalCaseRequest(
            case=TemporalCaseDescriptor(
                case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
                severity=case.severity, environment=case.environment, affected_entities=case.affected_entities,
            ),
            actor=actor, evidence=evidence, readback_evidence=source_readback if readback else [], claims=claims,
            coverage=full_coverage if coverage else [], proposal=proposal, approval=approval,
            current_witness=witness or {},
        )

    def start(self, request):
        async def run():
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, request.dict(), id=request.case.workflow_id, task_queue=self.queue,
            )
            return await handle.result()
        return asyncio.run(run())

    def test_critic_failure_does_not_reach_verifier_or_owner_gate(self):
        self.assertEqual("NEEDS_HUMAN", self.start(self.request(coverage=False))["state"])

    def test_verifier_failure_does_not_reach_owner_gate(self):
        self.assertEqual("ABSTAINED", self.start(self.request(readback=False))["state"])

    def test_owner_precondition_mismatch_is_blocked(self):
        seed = self.request()
        now = datetime.now(timezone.utc)
        proposal = RemediationProposal(
            proposal_id="proposal-live-{}".format(uuid4().hex), case_id=seed.case.case_id,
            case_revision=seed.case.case_revision, tenant_id=seed.case.tenant_id, revision=1,
            action_type="dry-run", exact_targets=["checkout"],
            exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={"deploy": "d1"},
            supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="live-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )
        approval = OwnerApproval(
            approval_id="approval-live-{}".format(uuid4().hex), case_id=proposal.case_id,
            case_revision=proposal.case_revision, tenant_id=proposal.tenant_id, proposal_id=proposal.proposal_id,
            proposal_revision=proposal.revision, repair_contract_hash=repair_contract_hash(proposal),
            actor_id="owner-live", execution_targets=proposal.exact_targets, maximum_targets=1,
            precondition_witness={"deploy": "changed"}, decision=ApprovalDecision.APPROVED,
            decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        request = TemporalCaseRequest.parse_obj({
            **seed.dict(), "proposal": proposal, "approval": approval, "current_witness": {"deploy": "d1"},
        })
        result = self.start(request)
        self.assertEqual("BLOCKED", result["state"])


if __name__ == "__main__":
    unittest.main()

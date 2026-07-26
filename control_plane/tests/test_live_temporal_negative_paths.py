"""Opt-in black-box checks against the registered local Temporal worker."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client

from flowpulse_cp.authorization import DEFAULT_AUDIENCE, HmacAuthorizationAuthority, HttpAuthorizationClient
from flowpulse_cp.models import (
    ApprovalDecision, AuthContext, IncidentCase, OwnerApproval, OwnerGateCommand,
    RemediationProposal, TemporalCaseDescriptor, TemporalCaseRequest,
)
from flowpulse_cp.policy import repair_contract_hash
from flowpulse_cp.temporal_runtime import TemporalStarter
from flowpulse_cp.temporal_workflow import DiagnosisTemporalWorkflow


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_TEMPORAL") == "1", "requires the local Compose stack")
class LiveTemporalNegativePathTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "127.0.0.1:7233")
    queue = os.environ.get("FLOWPULSE_TEMPORAL_TASK_QUEUE", "flowpulse-diagnosis-p0")
    authority = HttpAuthorizationClient(os.environ.get("FLOWPULSE_AUTHORIZATION_SERVICE_URL", "http://127.0.0.1:8091"))

    def request(self, *, coverage=True, readable=True):
        now = datetime.now(timezone.utc)
        suffix = uuid4().hex
        actor = AuthContext(tenant_id="tenant-live", subject_id="owner-live", roles=["owner"])
        workflow_id = "flowpulse.live.{}".format(suffix)
        case = IncidentCase(
            case_id="case-live-{}".format(suffix), tenant_id=actor.tenant_id,
            workflow_id=workflow_id, workflow_run_id="starter-placeholder", severity="SEV2",
            environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
        )
        evidence, claims, full_coverage = TemporalStarter(
            self.address, self.queue, local_deterministic_evidence=True
        )._local_records(case, actor)
        if not readable:
            evidence = [evidence[0].copy(update={"source_uri": "unsupported://readback"})]
        return TemporalCaseRequest(
            case=TemporalCaseDescriptor(
                case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
                severity=case.severity, environment=case.environment, affected_entities=case.affected_entities,
            ),
            actor=actor, evidence=evidence, claims=claims, coverage=full_coverage if coverage else [],
        )

    def start_terminal(self, request):
        async def run():
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, request.dict(), id=request.case.workflow_id, task_queue=self.queue,
            )
            return await handle.result()
        return asyncio.run(run())

    def test_critic_failure_does_not_reach_verifier_or_owner_gate(self):
        self.assertEqual("NEEDS_HUMAN", self.start_terminal(self.request(coverage=False))["state"])

    def test_verifier_failure_uses_adapter_not_caller_readback(self):
        self.assertEqual("ABSTAINED", self.start_terminal(self.request(readable=False))["state"])

    def test_owner_precondition_mismatch_is_blocked_after_durable_update(self):
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

        async def run():
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, seed.dict(), id=seed.case.workflow_id, task_queue=self.queue,
            )
            actor = seed.actor
            current_case = IncidentCase(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id, case_revision=seed.case.case_revision,
                workflow_id=seed.case.workflow_id, workflow_run_id=handle.result_run_id,
                severity=seed.case.severity, environment=seed.case.environment,
                affected_entities=seed.case.affected_entities, created_at=now, updated_at=now,
            )
            # The workflow rejects commands before its durable owner wait, so
            # retry the command just as an HTTP caller would after projection.
            for _ in range(40):
                receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                    case_id=seed.case.case_id, tenant_id=seed.case.tenant_id,
                    auth_assertion=self.authority.issue(actor, current_case, proposal.proposal_id), proposal=proposal,
                ).dict())
                if receipt["accepted"]:
                    break
                if not any(marker in receipt["phase"] for marker in ("workflow_not_initialized", "owner_gate_not_ready")):
                    self.fail("unexpected rejected owner command: {}".format(receipt))
                await asyncio.sleep(0.1)
            else:
                self.fail("workflow never reached durable owner wait")
            await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id,
                auth_assertion=self.authority.issue(actor, current_case, proposal.proposal_id, approval.approval_id),
                proposal_id=proposal.proposal_id, approval=approval, current_witness={"deploy": "d1"},
            ).dict())
            return await handle.result()

        self.assertEqual("BLOCKED", asyncio.run(run())["state"])

    def test_direct_temporal_client_cannot_forge_owner_roles(self):
        seed = self.request()
        now = datetime.now(timezone.utc)
        proposal = RemediationProposal(
            proposal_id="proposal-forged-{}".format(uuid4().hex), case_id=seed.case.case_id,
            case_revision=1, tenant_id=seed.case.tenant_id, revision=1, action_type="dry-run",
            exact_targets=["checkout"], exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
            supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="forged-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )
        approval = OwnerApproval(
            approval_id="approval-forged-{}".format(uuid4().hex), case_id=proposal.case_id, case_revision=1,
            tenant_id=proposal.tenant_id, proposal_id=proposal.proposal_id, proposal_revision=1,
            repair_contract_hash=repair_contract_hash(proposal), actor_id="attacker", execution_targets=["checkout"],
            maximum_targets=1, precondition_witness={}, decision=ApprovalDecision.APPROVED,
            decided_at=now, expires_at=now + timedelta(minutes=5),
        )

        async def run():
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, seed.dict(), id=seed.case.workflow_id, task_queue=self.queue,
            )
            current_case = IncidentCase(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id, case_revision=1,
                workflow_id=seed.case.workflow_id, workflow_run_id=handle.result_run_id, severity="SEV2",
                environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
            )
            valid = self.authority.issue(seed.actor, current_case, proposal.proposal_id)
            for _ in range(80):
                receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                    case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=valid, proposal=proposal,
                ).dict())
                if receipt["accepted"]:
                    break
                await asyncio.sleep(0.05)
            else:
                self.fail("workflow never reached durable owner wait")
            forged_actor = AuthContext(tenant_id=current_case.tenant_id, subject_id="attacker", roles=["owner"])
            forged = HmacAuthorizationAuthority(
                {"local-k2": "attacker-secret"}, "flowpulse-local-authz", DEFAULT_AUDIENCE, "local-k2",
            ).issue(forged_actor, current_case, proposal.proposal_id, approval.approval_id)
            rejected = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=forged,
                proposal_id=proposal.proposal_id, approval=approval, current_witness={},
            ).dict())
            self.assertFalse(rejected["accepted"], rejected)
            self.assertIn("signature_invalid", rejected["phase"])
            accepted = approval.copy(update={"actor_id": seed.actor.subject_id})
            receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                auth_assertion=self.authority.issue(seed.actor, current_case, proposal.proposal_id, accepted.approval_id),
                proposal_id=proposal.proposal_id, approval=accepted, current_witness={},
            ).dict())
            self.assertTrue(receipt["accepted"], receipt)
            return await handle.result()

        self.assertEqual("APPROVED", asyncio.run(run())["state"])

    def test_update_before_first_workflow_task_is_race_safe_under_load(self):
        async def one(index):
            seed = self.request()
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, seed.dict(), id=seed.case.workflow_id, task_queue=self.queue,
            )
            now = datetime.now(timezone.utc)
            current_case = IncidentCase(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id, case_revision=1,
                workflow_id=seed.case.workflow_id, workflow_run_id=handle.result_run_id, severity="SEV2",
                environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
            )
            proposal = RemediationProposal(
                proposal_id="proposal-race-{}".format(index), case_id=current_case.case_id, case_revision=1,
                tenant_id=current_case.tenant_id, revision=1, action_type="dry-run", exact_targets=["checkout"],
                exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
                canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
                supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
                rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
                idempotency_key="race-{}".format(index), expires_at=now + timedelta(minutes=5),
            )
            command = OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                auth_assertion=self.authority.issue(seed.actor, current_case, proposal.proposal_id), proposal=proposal,
            )
            # Deliberately submit without waiting for the first workflow task.
            receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command.dict())
            for _ in range(320):
                if receipt["accepted"]:
                    return receipt
                self.assertTrue(any(marker in receipt["phase"] for marker in ("workflow_not_initialized", "owner_gate_not_ready")), receipt)
                await asyncio.sleep(0.025)
                receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command.dict())
            self.fail("race workflow never reached a safe owner wait")

        async def stress():
            return await asyncio.gather(*[one(index) for index in range(12)])

        receipts = asyncio.run(stress())
        self.assertEqual(12, len(receipts))
        self.assertTrue(all(item["accepted"] for item in receipts))


    def test_assertion_protocol_rejects_audience_issuer_key_and_replay_before_mutation(self):
        seed = self.request()
        now = datetime.now(timezone.utc)
        proposal = RemediationProposal(
            proposal_id="proposal-assertion-{}".format(uuid4().hex), case_id=seed.case.case_id,
            case_revision=1, tenant_id=seed.case.tenant_id, revision=1, action_type="dry-run",
            exact_targets=["checkout"], exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
            supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="assertion-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )
        approval = OwnerApproval(
            approval_id="approval-assertion-{}".format(uuid4().hex), case_id=proposal.case_id, case_revision=1,
            tenant_id=proposal.tenant_id, proposal_id=proposal.proposal_id, proposal_revision=1,
            repair_contract_hash=repair_contract_hash(proposal), actor_id=seed.actor.subject_id,
            execution_targets=["checkout"], maximum_targets=1, precondition_witness={}, decision=ApprovalDecision.APPROVED,
            decided_at=now, expires_at=now + timedelta(minutes=5),
        )

        async def run():
            client = await Client.connect(self.address)
            handle = await client.start_workflow(
                DiagnosisTemporalWorkflow.run, seed.dict(), id=seed.case.workflow_id, task_queue=self.queue,
            )
            current_case = IncidentCase(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id, case_revision=1,
                workflow_id=seed.case.workflow_id, workflow_run_id=handle.result_run_id, severity="SEV2",
                environment="prod", affected_entities=["checkout"], created_at=now, updated_at=now,
            )
            invalid_authorities = [
                ("audience_invalid", HmacAuthorizationAuthority(
                    {"local-k2": "flowpulse-active-local-only"}, "flowpulse-local-authz", "wrong-audience", "local-k2",
                )),
                ("issuer_invalid", HmacAuthorizationAuthority(
                    {"local-k2": "flowpulse-active-local-only"}, "wrong-issuer", DEFAULT_AUDIENCE, "local-k2",
                )),
                ("key_unknown", HmacAuthorizationAuthority(
                    {"wrong-k9": "attacker-secret"}, "flowpulse-local-authz", DEFAULT_AUDIENCE, "wrong-k9",
                )),
            ]
            for expected, authority in invalid_authorities:
                forged = authority.issue(seed.actor, current_case, proposal.proposal_id)
                for _ in range(80):
                    receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                        case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=forged,
                        proposal=proposal,
                    ).dict())
                    if "owner_gate_not_ready" not in receipt["phase"] and "workflow_not_initialized" not in receipt["phase"]:
                        break
                    await asyncio.sleep(0.05)
                self.assertFalse(receipt["accepted"], receipt)
                self.assertIn(expected, receipt["phase"])
            valid = self.authority.issue(seed.actor, current_case, proposal.proposal_id)
            accepted = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=valid, proposal=proposal,
            ).dict())
            self.assertTrue(accepted["accepted"], accepted)
            replay = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=valid, proposal=proposal,
            ).dict())
            self.assertFalse(replay["accepted"], replay)
            self.assertIn("auth_assertion_replayed", replay["phase"])
            accepted_approval = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                auth_assertion=self.authority.issue(seed.actor, current_case, proposal.proposal_id, approval.approval_id),
                proposal_id=proposal.proposal_id, approval=approval, current_witness={},
            ).dict())
            self.assertTrue(accepted_approval["accepted"], accepted_approval)
            return await handle.result()

        self.assertEqual("APPROVED", asyncio.run(run())["state"])


if __name__ == "__main__":
    unittest.main()

"""Replay actual parent-v1 Temporal histories against the current workflow."""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio import activity
from temporalio.client import Client, WorkflowFailureError
from temporalio.worker import Replayer, Worker

from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.legacy_temporal_workflow import LegacyDiagnosisTemporalWorkflow
from flowpulse_cp.models import (
    ActivityOutcome, ApprovalDecision, AuthContext, CaseState, IncidentCase,
    OwnerApproval, OwnerGateCommand, RemediationProposal, TemporalActivityPacket,
    TemporalCaseDescriptor, TemporalCaseRequest, VerificationDecision,
)
from flowpulse_cp.policy import repair_contract_hash
from flowpulse_cp.temporal_runtime import TemporalStarter
from flowpulse_cp.temporal_workflow import DiagnosisTemporalWorkflow


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_TEMPORAL") == "1", "requires the local Compose stack")
class LiveTemporalReplayCompatibilityTests(unittest.TestCase):
    """History capture is an integration proof, not a synthetic unit fixture."""

    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")

    def request(self, label):
        now = datetime.now(timezone.utc)
        actor = AuthContext(tenant_id="tenant-history", subject_id="owner-history", roles=["owner"])
        case = IncidentCase(
            case_id="case-parent-{}-{}".format(label, uuid4().hex), tenant_id=actor.tenant_id,
            workflow_id="flowpulse.parent-history.{}".format(uuid4().hex), workflow_run_id="parent-pending",
            severity="SEV2", environment="prod", affected_entities=["checkout"],
            created_at=now, updated_at=now,
        )
        evidence, claims, coverage = TemporalStarter(
            self.address, "unused", local_deterministic_evidence=True,
        )._local_records(case, actor)
        return TemporalCaseRequest(
            case=TemporalCaseDescriptor(
                case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
                workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
                severity=case.severity, environment=case.environment, affected_entities=case.affected_entities,
            ),
            actor=actor, evidence=evidence, claims=claims, coverage=coverage,
        )

    @staticmethod
    def case_with_run(request, run_id):
        now = datetime.now(timezone.utc)
        return IncidentCase(
            case_id=request.case.case_id, tenant_id=request.case.tenant_id,
            case_revision=request.case.case_revision, workflow_id=request.case.workflow_id,
            workflow_run_id=run_id, severity=request.case.severity, environment=request.case.environment,
            affected_entities=request.case.affected_entities, created_at=now, updated_at=now,
        )

    @staticmethod
    def proposal(request, label):
        now = datetime.now(timezone.utc)
        return RemediationProposal(
            proposal_id="proposal-parent-{}-{}".format(label, uuid4().hex), case_id=request.case.case_id,
            case_revision=request.case.case_revision, tenant_id=request.case.tenant_id, revision=1,
            action_type="dry-run", exact_targets=["checkout"],
            exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
            canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
            supporting_claim_ids=[request.claims[0].claim_id], success_criteria=["slo"],
            rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
            idempotency_key="parent-history-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
        )

    def test_parent_v1_histories_replay_with_compatibility_registration(self):
        """Replays pre-ready, owner-wait, and terminal histories from 1e4a6c7."""

        async def run():
            client = await Client.connect(self.address)
            queue = "flowpulse-parent-history-{}".format(uuid4().hex)
            pre_ready_route_started = asyncio.Event()
            pre_ready_route_release = asyncio.Event()
            owner_wait_started = asyncio.Event()
            pre_ready_case_id = None
            owner_wait_case_id = None
            terminal_case_id = None

            def fake_activity(name):
                @activity.defn(name=name)
                async def handler(packet_data):
                    packet = TemporalActivityPacket.parse_obj(packet_data)
                    if name == "route_case_activity" and packet.case_id == pre_ready_case_id:
                        pre_ready_route_started.set()
                        await pre_ready_route_release.wait()
                    if name == "owner_wait_activity" and packet.case_id == owner_wait_case_id:
                        owner_wait_started.set()
                    if name == "critic_activity" and packet.case_id == terminal_case_id:
                        return ActivityOutcome(
                            decision=VerificationDecision.FAIL, identity="parent-v1:critic-fail",
                            reason_codes=["parent_terminal_path"],
                        ).dict()
                    if name == "validate_owner_command_activity":
                        return ActivityOutcome(
                            decision=VerificationDecision.PASS, identity="parent-v1:auth",
                            authenticated=AuthContext(
                                tenant_id=packet.tenant_id, subject_id=packet.actor_subject_id, roles=["owner"],
                            ),
                        ).dict()
                    return ActivityOutcome(
                        decision=VerificationDecision.PASS,
                        state=CaseState.APPROVED if name == "owner_gate_activity" else None,
                        identity="parent-v1:{}".format(name),
                    ).dict()
                return handler

            activities = [fake_activity(name) for name in (
                "route_case_activity", "retrieve_knowledge_activity", "primary_investigator_activity",
                "specialist_activity", "critic_activity", "independent_verify_activity", "owner_wait_activity",
                "validate_owner_command_activity", "owner_gate_activity",
            )]
            async with Worker(
                client, task_queue=queue, workflows=[LegacyDiagnosisTemporalWorkflow], activities=activities,
            ):
                # 1e4a6c7 rejected a command during diagnosis without an auth
                # activity. Keep the workflow open only long enough to fetch a
                # real server history, then terminate it deliberately.
                pre_ready = self.request("pre-ready")
                pre_ready_case_id = pre_ready.case.case_id
                pre_handle = await client.start_workflow(
                    LegacyDiagnosisTemporalWorkflow.run, pre_ready.dict(),
                    id=pre_ready.case.workflow_id, task_queue=queue,
                )
                await asyncio.wait_for(pre_ready_route_started.wait(), timeout=5)
                pre_case = self.case_with_run(pre_ready, pre_handle.result_run_id)
                pre_proposal = self.proposal(pre_ready, "pre-ready")
                pre_assertion = HmacAuthorizationAuthority("parent-history-secret").issue(
                    pre_ready.actor, pre_case, pre_proposal.proposal_id,
                )
                pre_receipt = await pre_handle.execute_update(
                    LegacyDiagnosisTemporalWorkflow.submit_owner_command,
                    OwnerGateCommand(
                        case_id=pre_case.case_id, tenant_id=pre_case.tenant_id,
                        auth_assertion=pre_assertion, proposal=pre_proposal,
                    ).dict(),
                )
                self.assertFalse(pre_receipt["accepted"], pre_receipt)
                self.assertIn("owner_gate_not_ready", pre_receipt["phase"])
                pre_ready_route_release.set()
                await pre_handle.terminate(reason="parent-history-pre-ready-captured")
                with self.assertRaises(WorkflowFailureError):
                    await pre_handle.result()
                pre_ready_history = await pre_handle.fetch_history()

                # An owner-wait history includes the parent update/validation
                # sequence and then closes through the owner gate.
                owner_wait = self.request("owner-wait")
                owner_wait_case_id = owner_wait.case.case_id
                owner_handle = await client.start_workflow(
                    LegacyDiagnosisTemporalWorkflow.run, owner_wait.dict(),
                    id=owner_wait.case.workflow_id, task_queue=queue,
                )
                await asyncio.wait_for(owner_wait_started.wait(), timeout=5)
                owner_case = self.case_with_run(owner_wait, owner_handle.result_run_id)
                owner_proposal = self.proposal(owner_wait, "owner-wait")
                authority = HmacAuthorizationAuthority("parent-history-secret")
                proposal_receipt = await owner_handle.execute_update(
                    LegacyDiagnosisTemporalWorkflow.submit_owner_command,
                    OwnerGateCommand(
                        case_id=owner_case.case_id, tenant_id=owner_case.tenant_id,
                        auth_assertion=authority.issue(owner_wait.actor, owner_case, owner_proposal.proposal_id),
                        proposal=owner_proposal,
                    ).dict(),
                )
                self.assertTrue(proposal_receipt["accepted"], proposal_receipt)
                now = datetime.now(timezone.utc)
                approval = OwnerApproval(
                    approval_id="approval-parent-{}".format(uuid4().hex), case_id=owner_case.case_id,
                    case_revision=owner_case.case_revision, tenant_id=owner_case.tenant_id,
                    proposal_id=owner_proposal.proposal_id, proposal_revision=owner_proposal.revision,
                    repair_contract_hash=repair_contract_hash(owner_proposal), actor_id=owner_wait.actor.subject_id,
                    execution_targets=owner_proposal.exact_targets, maximum_targets=1, precondition_witness={},
                    decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
                )
                approval_receipt = await owner_handle.execute_update(
                    LegacyDiagnosisTemporalWorkflow.submit_owner_command,
                    OwnerGateCommand(
                        case_id=owner_case.case_id, tenant_id=owner_case.tenant_id,
                        auth_assertion=authority.issue(
                            owner_wait.actor, owner_case, owner_proposal.proposal_id, approval.approval_id,
                        ),
                        proposal_id=owner_proposal.proposal_id, approval=approval, current_witness={},
                    ).dict(),
                )
                self.assertTrue(approval_receipt["accepted"], approval_receipt)
                self.assertEqual("APPROVED", (await owner_handle.result())["state"])
                owner_wait_history = await owner_handle.fetch_history()

                # A parent terminal path has no owner update and must also
                # remain replay safe after the update-handler patch is added.
                terminal = self.request("terminal")
                terminal_case_id = terminal.case.case_id
                terminal_handle = await client.start_workflow(
                    LegacyDiagnosisTemporalWorkflow.run, terminal.dict(),
                    id=terminal.case.workflow_id, task_queue=queue,
                )
                self.assertEqual("NEEDS_HUMAN", (await terminal_handle.result())["state"])
                terminal_history = await terminal_handle.fetch_history()

            histories = [pre_ready_history, owner_wait_history, terminal_history]
            self.assertEqual(3, len(histories))
            self.assertTrue(all(history.events for history in histories))

            async def history_iterator():
                for history in histories:
                    yield history

            replay = await Replayer(
                workflows=[LegacyDiagnosisTemporalWorkflow, DiagnosisTemporalWorkflow],
            ).replay_workflows(history_iterator())
            self.assertEqual({}, replay.replay_failures)
            return [len(history.events) for history in histories]

        event_counts = asyncio.run(run())
        self.assertEqual(3, len(event_counts))
        self.assertTrue(all(count > 1 for count in event_counts), event_counts)


if __name__ == "__main__":
    unittest.main()

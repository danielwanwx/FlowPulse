"""Opt-in black-box checks against the registered local Temporal worker."""

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client

from flowpulse_cp.authorization import DEFAULT_AUDIENCE, HmacAuthorizationAuthority, HttpAuthorizationClient
from flowpulse_cp.models import (
    ApprovalDecision, AuthContext, IncidentCase, OwnerApproval, OwnerGateCommand,
    RemediationProposal, TemporalCaseDescriptor, TemporalCaseRequest,
)
from flowpulse_cp.policy import repair_contract_hash
from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.temporal_runtime import TemporalStarter
from flowpulse_cp.temporal_workflow import DiagnosisTemporalWorkflow


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_TEMPORAL") == "1", "requires the local Compose stack")
class LiveTemporalNegativePathTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")
    queue = os.environ.get("FLOWPULSE_TEMPORAL_TASK_QUEUE", "flowpulse-diagnosis-p0")
    authz_url = os.environ.get("FLOWPULSE_AUTHORIZATION_SERVICE_URL", "http://authz:8091")
    api_token = os.environ.get("FLOWPULSE_AUTHZ_API_SERVICE_TOKEN", "test-api-service-token")
    worker_token = os.environ.get("FLOWPULSE_AUTHZ_WORKER_SERVICE_TOKEN", "test-worker-service-token")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN", "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse",
    )
    authority = HttpAuthorizationClient(authz_url, "api", api_token)

    async def mint_assertion(self, actor, case, proposal_id=None, approval_id=None):
        repository = PostgresCaseRepository(self.dsn)
        await repository.connect()
        try:
            for _ in range(80):
                authoritative = await repository.get_case(actor.tenant_id, case.case_id)
                if authoritative is not None and authoritative.workflow_run_id == case.workflow_run_id:
                    break
                await asyncio.sleep(0.025)
            else:
                raise AssertionError("authoritative case projection was not available for mint")
            intent = await repository.create_auth_command_intent(actor, case, proposal_id, approval_id)
            return self.authority.issue_intent(intent)
        finally:
            await repository.close()

    async def wait_for_owner_wait(self, case):
        """Synchronize the conflict race at the observable command-ready edge."""
        repository = PostgresCaseRepository(self.dsn)
        await repository.connect()
        try:
            for _ in range(120):
                projected = await repository.get_case(case.tenant_id, case.case_id)
                if (
                    projected is not None
                    and projected.workflow_run_id == case.workflow_run_id
                    and projected.state.value == "AWAITING_OWNER"
                ):
                    return
                await asyncio.sleep(0.025)
        finally:
            await repository.close()
        self.fail("workflow never reached an observable durable owner wait")

    def raw_post(self, payload, identity=None, token=None):
        headers = {"content-type": "application/json"}
        if identity is not None:
            headers["x-flowpulse-service-identity"] = identity
        if token is not None:
            headers["authorization"] = "Bearer " + token
        request = Request(self.authz_url + "/v1/assertions/mint", data=json.dumps(payload).encode("utf-8"),
                          method="POST", headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

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
            receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id,
                auth_assertion=await self.mint_assertion(actor, current_case, proposal.proposal_id), proposal=proposal,
            ).dict())
            self.assertTrue(receipt["accepted"], receipt)
            await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=seed.case.case_id, tenant_id=seed.case.tenant_id,
                auth_assertion=await self.mint_assertion(
                    actor, current_case, proposal.proposal_id, approval.approval_id,
                ),
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
            valid = await self.mint_assertion(seed.actor, current_case, proposal.proposal_id)
            receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=valid, proposal=proposal,
            ).dict())
            self.assertTrue(receipt["accepted"], receipt)
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
                auth_assertion=await self.mint_assertion(
                    seed.actor, current_case, proposal.proposal_id, accepted.approval_id,
                ),
                proposal_id=proposal.proposal_id, approval=accepted, current_witness={},
            ).dict())
            self.assertTrue(receipt["accepted"], receipt)
            result = await handle.result()
            self.assertIn("flowpulse.diagnosis.v2", (await handle.fetch_history()).to_json())
            return result

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
                auth_assertion=await self.mint_assertion(seed.actor, current_case, proposal.proposal_id), proposal=proposal,
            )
            # Deliberately submit without waiting for owner-wait projection.
            receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command.dict())
            self.assertTrue(receipt["accepted"], receipt)
            return receipt

        async def stress():
            return await asyncio.gather(*[one(index) for index in range(12)])

        receipts = asyncio.run(stress())
        self.assertEqual(12, len(receipts))
        self.assertTrue(all(item["accepted"] for item in receipts))

    def test_early_update_waits_for_durable_owner_phase_then_valid_command_succeeds(self):
        seed = self.request()
        now = datetime.now(timezone.utc)

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
            proposal = RemediationProposal(
                proposal_id="proposal-early-{}".format(uuid4().hex), case_id=current_case.case_id,
                case_revision=1, tenant_id=current_case.tenant_id, revision=1, action_type="dry-run",
                exact_targets=["checkout"], exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
                canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
                supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
                rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
                idempotency_key="early-{}".format(uuid4().hex), expires_at=now + timedelta(minutes=5),
            )
            forged = HmacAuthorizationAuthority(
                {"local-k2": "attacker-secret"}, "flowpulse-local-authz", DEFAULT_AUDIENCE, "local-k2",
            ).issue(seed.actor, current_case, proposal.proposal_id)
            # Start the update immediately after Client.start_workflow. It must
            # wait for the durable phase, then fail on signature—not readiness.
            pending = asyncio.create_task(handle.execute_update(
                DiagnosisTemporalWorkflow.submit_owner_command,
                OwnerGateCommand(
                    case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                    auth_assertion=forged, proposal=proposal,
                ).dict(),
            ))
            await self.wait_for_owner_wait(current_case)
            rejected = await pending
            self.assertFalse(rejected["accepted"], rejected)
            self.assertIn("signature_invalid", rejected["phase"])
            self.assertNotIn("not_ready", rejected["phase"])

            accepted = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                auth_assertion=await self.mint_assertion(seed.actor, current_case, proposal.proposal_id), proposal=proposal,
            ).dict())
            self.assertTrue(accepted["accepted"], accepted)
            approval = OwnerApproval(
                approval_id="approval-early-{}".format(uuid4().hex), case_id=current_case.case_id,
                case_revision=1, tenant_id=current_case.tenant_id, proposal_id=proposal.proposal_id,
                proposal_revision=1, repair_contract_hash=repair_contract_hash(proposal), actor_id=seed.actor.subject_id,
                execution_targets=["checkout"], maximum_targets=1, precondition_witness={},
                decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
            )
            approved = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                auth_assertion=await self.mint_assertion(
                    seed.actor, current_case, proposal.proposal_id, approval.approval_id,
                ),
                proposal_id=proposal.proposal_id, approval=approval, current_witness={},
            ).dict())
            self.assertTrue(approved["accepted"], approved)
            return await handle.result()

        self.assertEqual("APPROVED", asyncio.run(run())["state"])

    def test_same_workflow_conflicting_commands_are_serialized_and_fail_closed(self):
        seed = self.request()
        now = datetime.now(timezone.utc)

        def proposal(label):
            return RemediationProposal(
                proposal_id="proposal-conflict-{}-{}".format(label, uuid4().hex), case_id=seed.case.case_id,
                case_revision=1, tenant_id=seed.case.tenant_id, revision=1, action_type="dry-run",
                exact_targets=["checkout"], exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
                canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
                supporting_claim_ids=[seed.claims[0].claim_id], success_criteria=["slo"],
                rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
                idempotency_key="conflict-{}-{}".format(label, uuid4().hex), expires_at=now + timedelta(minutes=5),
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
            await self.wait_for_owner_wait(current_case)
            first, second = proposal("first"), proposal("second")
            proposal_commands = [
                OwnerGateCommand(
                    case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                    auth_assertion=await self.mint_assertion(seed.actor, current_case, item.proposal_id), proposal=item,
                ).dict()
                for item in (first, second)
            ]
            proposal_receipts = await asyncio.gather(*[
                handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command)
                for command in proposal_commands
            ])
            accepted_proposals = [item for item in proposal_receipts if item["accepted"]]
            self.assertEqual(1, len(accepted_proposals), proposal_receipts)
            rejected_proposals = [item for item in proposal_receipts if not item["accepted"]]
            self.assertEqual(1, len(rejected_proposals), proposal_receipts)
            self.assertIn("proposal_immutable", rejected_proposals[0]["phase"])
            selected = first if proposal_receipts[0]["accepted"] else second

            # Both commands passed their initial authoritative check and
            # reached the asynchronously executed authorization activity.
            # Exactly one was then permitted to commit by the post-await
            # revalidation; the other is rejected with immutable state.
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                async def validation_count(connection):
                    return await connection.fetchval(
                        "SELECT count(*) FROM case_events WHERE case_id=$1 AND stage='validate_owner_command'",
                        current_case.case_id,
                    )
                self.assertEqual(2, await repository._tenant(current_case.tenant_id, validation_count))
            finally:
                await repository.close()

            def approval(label):
                return OwnerApproval(
                    approval_id="approval-conflict-{}-{}".format(label, uuid4().hex), case_id=selected.case_id,
                    case_revision=1, tenant_id=selected.tenant_id, proposal_id=selected.proposal_id,
                    proposal_revision=1, repair_contract_hash=repair_contract_hash(selected), actor_id=seed.actor.subject_id,
                    execution_targets=["checkout"], maximum_targets=1, precondition_witness={},
                    decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
                )

            first_approval, second_approval = approval("first"), approval("second")
            approval_commands = [
                OwnerGateCommand(
                    case_id=current_case.case_id, tenant_id=current_case.tenant_id,
                    auth_assertion=await self.mint_assertion(
                        seed.actor, current_case, selected.proposal_id, item.approval_id,
                    ),
                    proposal_id=selected.proposal_id, approval=item, current_witness={},
                ).dict()
                for item in (first_approval, second_approval)
            ]
            approval_receipts = await asyncio.gather(*[
                handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, command)
                for command in approval_commands
            ])
            accepted_approvals = [item for item in approval_receipts if item["accepted"]]
            self.assertEqual(1, len(accepted_approvals), approval_receipts)
            rejected_approvals = [item for item in approval_receipts if not item["accepted"]]
            self.assertEqual(1, len(rejected_approvals), approval_receipts)
            self.assertTrue(
                "approval_immutable" in rejected_approvals[0]["phase"]
                or "phase_not_accepting" in rejected_approvals[0]["phase"],
                rejected_approvals,
            )
            result = await handle.result()

            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                async def count(connection):
                    return await connection.fetchval(
                        "SELECT count(*) FROM owner_approvals WHERE case_id=$1", current_case.case_id,
                    )
                approval_count = await repository._tenant(current_case.tenant_id, count)
            finally:
                await repository.close()
            return result, approval_count

        result, approval_count = asyncio.run(run())
        self.assertEqual("APPROVED", result["state"])
        self.assertEqual(1, approval_count)


    def test_mint_requires_api_identity_and_server_created_scope(self):
        now = datetime.now(timezone.utc)
        actor = AuthContext(tenant_id="tenant-mint", subject_id="owner-mint", roles=["owner"])
        case = IncidentCase(
            case_id="case-mint-{}".format(uuid4().hex), tenant_id=actor.tenant_id,
            workflow_id="workflow-mint", workflow_run_id="run-mint", severity="SEV2", environment="prod",
            affected_entities=["checkout"], created_at=now, updated_at=now,
        )

        async def create_intent():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                await repository.put_case(case)
                return await repository.create_auth_command_intent(actor, case, "proposal-mint")
            finally:
                await repository.close()

        intent = asyncio.run(create_intent())
        self.assertEqual(403, self.raw_post({"tenant_id": actor.tenant_id, "intent_id": intent.intent_id})[0])
        self.assertEqual(403, self.raw_post(
            {"tenant_id": actor.tenant_id, "intent_id": intent.intent_id}, "worker", self.worker_token,
        )[0])
        self.assertEqual(422, self.raw_post(
            {"tenant_id": actor.tenant_id, "intent_id": intent.intent_id,
             "actor": {"tenant_id": actor.tenant_id, "subject_id": "attacker", "roles": ["owner"]}},
            "api", self.api_token,
        )[0])
        self.assertEqual(403, self.raw_post(
            {"tenant_id": "tenant-other", "intent_id": intent.intent_id}, "api", self.api_token,
        )[0])
        status, assertion = self.raw_post(
            {"tenant_id": actor.tenant_id, "intent_id": intent.intent_id}, "api", self.api_token,
        )
        self.assertEqual(200, status, assertion)
        self.assertEqual(actor.subject_id, assertion["subject_id"])
        self.assertEqual(actor.roles, assertion["roles"])


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
                receipt = await handle.execute_update(DiagnosisTemporalWorkflow.submit_owner_command, OwnerGateCommand(
                    case_id=current_case.case_id, tenant_id=current_case.tenant_id, auth_assertion=forged,
                    proposal=proposal,
                ).dict())
                self.assertFalse(receipt["accepted"], receipt)
                self.assertIn(expected, receipt["phase"])
            valid = await self.mint_assertion(seed.actor, current_case, proposal.proposal_id)
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
                auth_assertion=await self.mint_assertion(
                    seed.actor, current_case, proposal.proposal_id, approval.approval_id,
                ),
                proposal_id=proposal.proposal_id, approval=approval, current_witness={},
            ).dict())
            self.assertTrue(accepted_approval["accepted"], accepted_approval)
            return await handle.result()

        self.assertEqual("APPROVED", asyncio.run(run())["state"])


if __name__ == "__main__":
    unittest.main()

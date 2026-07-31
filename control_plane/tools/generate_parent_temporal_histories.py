"""Generate parent-1e4a6c7 Temporal histories with only its v1 class loaded.

The script is deliberately mounted into an image built from the exact parent
checkout. It writes de-identified, replayable JSON plus an integrity manifest
to OUTPUT_DIR; it never imports a workflow from the checkout that holds it.
"""

import asyncio
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from temporalio import activity
from temporalio.client import Client, WorkflowFailureError
from temporalio.worker import Worker

from flowpulse_cp.authorization import HmacAuthorizationAuthority
from flowpulse_cp.models import (
    ActivityOutcome,
    ApprovalDecision,
    AuthContext,
    CaseState,
    IncidentCase,
    OwnerApproval,
    OwnerGateCommand,
    RemediationProposal,
    TemporalActivityPacket,
    TemporalCaseDescriptor,
    TemporalCaseRequest,
    VerificationDecision,
)
from flowpulse_cp.policy import repair_contract_hash
from flowpulse_cp.temporal_runtime import TemporalStarter
from flowpulse_cp.temporal_workflow import DiagnosisTemporalWorkflow


PARENT_SHA = "1e4a6c7dec90198dc472c270edf108c112ef3bdf"
PARENT_WORKFLOW_SHA256 = "76a4cc08f0475e70f041cbfa8907533f1436bb2be2526d6fcd2d75b19346c3bb"
ADDRESS = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")
OUTPUT_DIR = Path(os.environ["FLOWPULSE_HISTORY_OUTPUT_DIR"])
QUEUE = "flowpulse-parent-1e4a6c7-history"
PRODUCER_IMAGE_ID = os.environ["FLOWPULSE_PRODUCER_IMAGE_ID"]
FIXTURE_SIGNING_KEY = os.environ["FLOWPULSE_PARENT_FIXTURE_SIGNING_KEY"]


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def request(label):
    now = datetime.now(timezone.utc)
    actor = AuthContext(tenant_id="tenant-parent-history", subject_id="owner-parent-history", roles=["owner"])
    case = IncidentCase(
        case_id="case-parent-{}".format(label), tenant_id=actor.tenant_id,
        workflow_id="flowpulse.parent-1e4a6c7.{}".format(label), workflow_run_id="parent-pending",
        severity="SEV2", environment="prod", affected_entities=["checkout"],
        created_at=now, updated_at=now,
    )
    evidence, claims, coverage = TemporalStarter(
        ADDRESS, "unused", local_deterministic_evidence=True,
    )._local_records(case, actor)
    return TemporalCaseRequest(
        case=TemporalCaseDescriptor(
            case_id=case.case_id, tenant_id=case.tenant_id, case_revision=case.case_revision,
            workflow_id=case.workflow_id, workflow_run_id=case.workflow_run_id,
            severity=case.severity, environment=case.environment, affected_entities=case.affected_entities,
        ),
        actor=actor, evidence=evidence, claims=claims, coverage=coverage,
    )


def case_with_run(input_request, run_id):
    now = datetime.now(timezone.utc)
    return IncidentCase(
        case_id=input_request.case.case_id, tenant_id=input_request.case.tenant_id,
        case_revision=input_request.case.case_revision, workflow_id=input_request.case.workflow_id,
        workflow_run_id=run_id, severity=input_request.case.severity, environment=input_request.case.environment,
        affected_entities=input_request.case.affected_entities, created_at=now, updated_at=now,
    )


def proposal(input_request, label):
    now = datetime.now(timezone.utc)
    return RemediationProposal(
        proposal_id="proposal-parent-{}".format(label), case_id=input_request.case.case_id,
        case_revision=input_request.case.case_revision, tenant_id=input_request.case.tenant_id, revision=1,
        action_type="dry-run", exact_targets=["checkout"],
        exact_change={"template_id": "toggle", "parameters": {"enabled": "false"}},
        canary_scope={"maximum_targets": 1, "environment": "prod"}, preconditions={},
        supporting_claim_ids=[input_request.claims[0].claim_id], success_criteria=["slo"],
        rollback={"template_id": "toggle", "parameters": {"enabled": "true"}},
        idempotency_key="parent-history-{}".format(label), expires_at=now + timedelta(minutes=5),
    )


async def generate():
    if os.environ.get("FLOWPULSE_PARENT_SHA") != PARENT_SHA:
        raise RuntimeError("parent_sha_environment_mismatch")
    if not PRODUCER_IMAGE_ID.startswith("sha256:"):
        raise RuntimeError("producer_image_id_missing_or_invalid")
    module_path = Path(__import__("flowpulse_cp.temporal_workflow", fromlist=["__file__"]).__file__)
    if sha256_bytes(module_path.read_bytes()) != PARENT_WORKFLOW_SHA256:
        raise RuntimeError("parent_workflow_module_hash_mismatch")
    client = await Client.connect(ADDRESS)
    pre_ready_route_started = asyncio.Event()
    pre_ready_route_release = asyncio.Event()
    owner_wait_started = asyncio.Event()
    case_ids = {"pre_ready": None, "owner_wait": None, "critic_terminal": None}

    def fake_activity(name):
        @activity.defn(name=name)
        async def handler(packet_data):
            packet = TemporalActivityPacket.parse_obj(packet_data)
            if name == "route_case_activity" and packet.case_id == case_ids["pre_ready"]:
                pre_ready_route_started.set()
                await pre_ready_route_release.wait()
            if name == "owner_wait_activity" and packet.case_id == case_ids["owner_wait"]:
                owner_wait_started.set()
            if name == "critic_activity" and packet.case_id == case_ids["critic_terminal"]:
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
    histories = {}
    metadata = {}
    async with Worker(client, task_queue=QUEUE, workflows=[DiagnosisTemporalWorkflow], activities=activities):
        pre_ready = request("pre-ready")
        case_ids["pre_ready"] = pre_ready.case.case_id
        pre_handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run, pre_ready.dict(), id=pre_ready.case.workflow_id, task_queue=QUEUE,
        )
        await asyncio.wait_for(pre_ready_route_started.wait(), timeout=10)
        pre_case = case_with_run(pre_ready, pre_handle.result_run_id)
        pre_proposal = proposal(pre_ready, "pre-ready")
        pre_authority = HmacAuthorizationAuthority(FIXTURE_SIGNING_KEY)
        pre_receipt = await pre_handle.execute_update(
            DiagnosisTemporalWorkflow.submit_owner_command,
            OwnerGateCommand(
                case_id=pre_case.case_id, tenant_id=pre_case.tenant_id,
                auth_assertion=pre_authority.issue(pre_ready.actor, pre_case, pre_proposal.proposal_id),
                proposal=pre_proposal,
            ).dict(),
        )
        if pre_receipt["accepted"] or "owner_gate_not_ready" not in pre_receipt["phase"]:
            raise RuntimeError("parent_pre_ready_behavior_not_observed")
        pre_ready_route_release.set()
        await pre_handle.terminate(reason="parent-history-pre-ready-captured")
        try:
            await pre_handle.result()
        except WorkflowFailureError:
            pass
        else:
            raise RuntimeError("parent_pre_ready_workflow_should_be_terminated")
        histories["pre_ready_rejected"] = await pre_handle.fetch_history()
        metadata["pre_ready_rejected"] = {
            "workflow_id": pre_ready.case.workflow_id,
            "run_id": pre_handle.result_run_id,
            "expected_outcome": "rejected:owner_gate_not_ready_then_terminated",
        }

        owner_wait = request("owner-wait")
        case_ids["owner_wait"] = owner_wait.case.case_id
        owner_handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run, owner_wait.dict(), id=owner_wait.case.workflow_id, task_queue=QUEUE,
        )
        await asyncio.wait_for(owner_wait_started.wait(), timeout=10)
        owner_case = case_with_run(owner_wait, owner_handle.result_run_id)
        owner_proposal = proposal(owner_wait, "owner-wait")
        authority = HmacAuthorizationAuthority(FIXTURE_SIGNING_KEY)
        proposal_receipt = await owner_handle.execute_update(
            DiagnosisTemporalWorkflow.submit_owner_command,
            OwnerGateCommand(
                case_id=owner_case.case_id, tenant_id=owner_case.tenant_id,
                auth_assertion=authority.issue(owner_wait.actor, owner_case, owner_proposal.proposal_id),
                proposal=owner_proposal,
            ).dict(),
        )
        if not proposal_receipt["accepted"]:
            raise RuntimeError("parent_owner_wait_proposal_rejected")
        now = datetime.now(timezone.utc)
        approval = OwnerApproval(
            approval_id="approval-parent-owner-wait", case_id=owner_case.case_id,
            case_revision=owner_case.case_revision, tenant_id=owner_case.tenant_id,
            proposal_id=owner_proposal.proposal_id, proposal_revision=owner_proposal.revision,
            repair_contract_hash=repair_contract_hash(owner_proposal), actor_id=owner_wait.actor.subject_id,
            execution_targets=owner_proposal.exact_targets, maximum_targets=1, precondition_witness={},
            decision=ApprovalDecision.APPROVED, decided_at=now, expires_at=now + timedelta(minutes=5),
        )
        approval_receipt = await owner_handle.execute_update(
            DiagnosisTemporalWorkflow.submit_owner_command,
            OwnerGateCommand(
                case_id=owner_case.case_id, tenant_id=owner_case.tenant_id,
                auth_assertion=authority.issue(
                    owner_wait.actor, owner_case, owner_proposal.proposal_id, approval.approval_id,
                ),
                proposal_id=owner_proposal.proposal_id, approval=approval, current_witness={},
            ).dict(),
        )
        if not approval_receipt["accepted"] or (await owner_handle.result())["state"] != "APPROVED":
            raise RuntimeError("parent_owner_wait_approval_not_approved")
        histories["owner_wait_approved"] = await owner_handle.fetch_history()
        metadata["owner_wait_approved"] = {
            "workflow_id": owner_wait.case.workflow_id,
            "run_id": owner_handle.result_run_id,
            "expected_outcome": "owner_wait_update_validation_terminal_approved",
        }

        terminal = request("critic-terminal")
        case_ids["critic_terminal"] = terminal.case.case_id
        terminal_handle = await client.start_workflow(
            DiagnosisTemporalWorkflow.run, terminal.dict(), id=terminal.case.workflow_id, task_queue=QUEUE,
        )
        if (await terminal_handle.result())["state"] != "NEEDS_HUMAN":
            raise RuntimeError("parent_critic_terminal_not_needs_human")
        histories["critic_terminal"] = await terminal_handle.fetch_history()
        metadata["critic_terminal"] = {
            "workflow_id": terminal.case.workflow_id,
            "run_id": terminal_handle.result_run_id,
            "expected_outcome": "critic_terminal_needs_human_no_owner_command",
        }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "producer": {
            "git_sha": PARENT_SHA,
            "image_id": PRODUCER_IMAGE_ID,
            "workflow_type": "flowpulse.diagnosis.v1",
            "workflow_module": str(module_path),
            "workflow_module_sha256": PARENT_WORKFLOW_SHA256,
            "worker_task_queue": QUEUE,
            "generator": "flowpulse-parent-history-generator.py",
        },
        "histories": [],
    }
    for name, history in histories.items():
        encoded = history.to_json().encode("utf-8")
        filename = name + ".json"
        (OUTPUT_DIR / filename).write_bytes(encoded)
        manifest["histories"].append({
            "name": name,
            "filename": filename,
            "sha256": sha256_bytes(encoded),
            "event_count": len(history.events),
            **metadata[name],
        })
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(generate())

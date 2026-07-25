"""The sole durable workflow definition for FlowPulse P0."""

from datetime import timedelta
from typing import Any, Dict, Optional

from temporalio import workflow
from pydantic import ValidationError

from .models import (
    ActivityOutcome,
    CaseState,
    OwnerCommandReceipt,
    OwnerGateCommand,
    TemporalActivityPacket,
    TemporalCaseRequest,
    VerificationDecision,
)
from .policy import PolicyViolation, require_authenticated_owner


def temporal_available() -> bool:
    return True


@workflow.defn(name="flowpulse.diagnosis.v1")
class DiagnosisTemporalWorkflow:
    """Temporal owns the wait/resume boundary for Owner Gate commands."""

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = TemporalCaseRequest.parse_obj(request_data)
        self._case_id = request.case.case_id
        self._tenant_id = request.case.tenant_id
        self._workflow_run_id = workflow.info().run_id
        self._proposal = None
        self._approval = None
        self._current_witness = {}
        self._owner_actor = None
        self._owner_wait_ready = False
        self._command_count = 0
        base = {
            "case_id": request.case.case_id,
            "case_revision": request.case.case_revision,
            "tenant_id": request.case.tenant_id,
            "workflow_id": request.case.workflow_id,
            "workflow_run_id": self._workflow_run_id,
            "actor_subject_id": request.actor.subject_id,
            "actor_roles": request.actor.roles,
            "severity": request.case.severity,
            "environment": request.case.environment,
            "affected_entities": request.case.affected_entities,
            "evidence": request.evidence,
            "claims": request.claims,
            "coverage": request.coverage,
        }
        sequence = 0

        async def activity(
            stage: str, specialist_role: str = None, proposal=None, approval=None,
            witness=None, owner_actor=None,
        ) -> ActivityOutcome:
            nonlocal sequence
            sequence += 1
            actor = owner_actor or request.actor
            packet = TemporalActivityPacket(
                stage=stage, specialist_role=specialist_role, sequence=sequence,
                proposal=proposal, approval=approval, current_witness=witness or {},
                actor_subject_id=actor.subject_id, actor_roles=actor.roles,
                **{key: value for key, value in base.items() if key not in {"actor_subject_id", "actor_roles"}},
            )
            result = await workflow.execute_activity(
                "{}_activity".format(stage), packet.dict(), start_to_close_timeout=timedelta(minutes=2),
            )
            return ActivityOutcome.parse_obj(result)

        await activity("route_case")
        await activity("retrieve_knowledge")
        await activity("primary_investigator")
        for role in request.specialist_roles[:4]:
            await activity("specialist", role)
        critic = await activity("critic")
        if critic.decision != VerificationDecision.PASS:
            return {"state": CaseState.NEEDS_HUMAN.value, "critic": critic.dict()}
        verification = await activity("independent_verify")
        if verification.decision != VerificationDecision.PASS:
            return {"state": CaseState.ABSTAINED.value, "verification": verification.dict()}

        await activity("owner_wait")
        self._owner_wait_ready = True
        await workflow.wait_condition(lambda: self._approval is not None)
        owner = await activity(
            "owner_gate", proposal=self._proposal, approval=self._approval,
            witness=self._current_witness, owner_actor=self._owner_actor,
        )
        return {
            "state": (owner.state or CaseState.BLOCKED).value,
            "verification": verification.dict(),
            "owner_gate": owner.dict(),
        }

    @workflow.update(name="submit_owner_command")
    def submit_owner_command(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        """A rejected update is a durable typed response, never a task failure.

        Raising from an update handler causes Temporal to replay the rejected
        workflow task.  Returning an explicit rejected receipt preserves the
        workflow's owner wait and lets the HTTP boundary report the command
        error without creating a second state authority.
        """
        try:
            command = OwnerGateCommand.parse_obj(command_data)
            if command.case_id != self._case_id or command.tenant_id != self._tenant_id:
                raise PolicyViolation("owner_command_case_or_tenant_mismatch")
            if not self._owner_wait_ready:
                raise PolicyViolation("owner_gate_not_ready")
            proposal = self._proposal
            if command.proposal is not None:
                if proposal is not None and proposal != command.proposal:
                    raise PolicyViolation("owner_command_proposal_immutable")
                proposal = command.proposal
            expected_proposal_id = proposal.proposal_id if proposal is not None else None
            if command.approval is not None:
                if command.approval.actor_id != command.actor.subject_id:
                    raise PolicyViolation("approval_actor_not_authenticated_subject")
                require_authenticated_owner(command.actor.subject_id, command.actor.roles)
                if expected_proposal_id is None or command.approval.proposal_id != expected_proposal_id:
                    raise PolicyViolation("owner_command_unknown_or_mismatched_proposal")
                if command.proposal_id not in {None, expected_proposal_id}:
                    raise PolicyViolation("owner_command_proposal_id_mismatch")
                if self._approval is not None and (
                    self._approval != command.approval or self._current_witness != command.current_witness
                ):
                    raise PolicyViolation("owner_command_approval_immutable")
            self._proposal = proposal
            if command.approval is not None:
                self._approval = command.approval
                self._current_witness = command.current_witness
                self._owner_actor = command.actor
            self._command_count += 1
            return OwnerCommandReceipt(
                case_id=self._case_id, tenant_id=self._tenant_id, workflow_run_id=self._workflow_run_id,
                phase="approval_submitted" if command.approval is not None else "proposal_submitted",
            ).dict()
        except (PolicyViolation, ValidationError) as error:
            return OwnerCommandReceipt(
                case_id=self._case_id, tenant_id=self._tenant_id, workflow_run_id=self._workflow_run_id,
                accepted=False, phase="rejected:" + str(error),
            ).dict()

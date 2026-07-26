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
from .policy import PolicyViolation


def temporal_available() -> bool:
    return True


@workflow.defn(name="flowpulse.diagnosis.v1")
class DiagnosisTemporalWorkflow:
    """Temporal owns both owner-command readiness and state mutation."""

    def __init__(self) -> None:
        # Updates can arrive before ``run`` has its first workflow task. Every
        # field is therefore total, and early commands return a typed receipt.
        self._initialized = False
        self._case_id = None
        self._case_revision = None
        self._tenant_id = None
        self._workflow_id = None
        self._workflow_run_id = None
        self._actor_subject_id = None
        self._actor_roles = []
        self._severity = None
        self._environment = None
        self._affected_entities = []
        self._evidence = []
        self._claims = []
        self._coverage = []
        self._sequence = 0
        self._proposal = None
        self._approval = None
        self._current_witness = {}
        self._owner_assertion = None
        self._owner_authenticated = None
        self._owner_wait_ready = False
        self._command_count = 0

    def _packet(
        self, stage: str, specialist_role: str = None, proposal=None, approval=None,
        witness=None, auth_assertion=None, authorized_actor=None, proposal_id=None,
    ) -> TemporalActivityPacket:
        self._sequence += 1
        return TemporalActivityPacket(
            case_id=self._case_id, case_revision=self._case_revision, tenant_id=self._tenant_id,
            workflow_id=self._workflow_id, workflow_run_id=self._workflow_run_id,
            actor_subject_id=self._actor_subject_id, actor_roles=self._actor_roles,
            severity=self._severity, environment=self._environment, affected_entities=self._affected_entities,
            stage=stage, specialist_role=specialist_role, sequence=self._sequence,
            evidence=self._evidence, claims=self._claims, coverage=self._coverage,
            proposal=proposal, proposal_id=proposal.proposal_id if proposal is not None else proposal_id,
            approval=approval, current_witness=witness or {}, auth_assertion=auth_assertion,
            authorized_actor=authorized_actor,
        )

    async def _activity(
        self, stage: str, specialist_role: str = None, proposal=None, approval=None,
        witness=None, auth_assertion=None, authorized_actor=None, proposal_id=None,
    ) -> ActivityOutcome:
        packet = self._packet(
            stage, specialist_role, proposal, approval, witness, auth_assertion, authorized_actor, proposal_id,
        )
        result = await workflow.execute_activity(
            "{}_activity".format(stage), packet.dict(), start_to_close_timeout=timedelta(minutes=2),
        )
        return ActivityOutcome.parse_obj(result)

    def _rejected(self, command_data: Any, error: Exception) -> Dict[str, Any]:
        raw = command_data if isinstance(command_data, dict) else {}
        return OwnerCommandReceipt(
            case_id=self._case_id or raw.get("case_id") or "uninitialized",
            tenant_id=self._tenant_id or raw.get("tenant_id") or "uninitialized",
            workflow_run_id=self._workflow_run_id or "uninitialized",
            accepted=False, phase="rejected:" + str(error),
        ).dict()

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = TemporalCaseRequest.parse_obj(request_data)
        self._case_id = request.case.case_id
        self._case_revision = request.case.case_revision
        self._tenant_id = request.case.tenant_id
        self._workflow_id = request.case.workflow_id
        self._workflow_run_id = workflow.info().run_id
        self._actor_subject_id = request.actor.subject_id
        self._actor_roles = request.actor.roles
        self._severity = request.case.severity
        self._environment = request.case.environment
        self._affected_entities = request.case.affected_entities
        self._evidence = request.evidence
        self._claims = request.claims
        self._coverage = request.coverage
        self._sequence = 0
        self._proposal = None
        self._approval = None
        self._current_witness = {}
        self._owner_assertion = None
        self._owner_authenticated = None
        self._owner_wait_ready = False
        self._command_count = 0
        self._initialized = True

        if not self._evidence:
            acquisition = await self._activity("acquire_current_evidence")
            if acquisition.decision != VerificationDecision.PASS or acquisition.acquisition is None:
                return {"state": CaseState.NEEDS_HUMAN.value, "acquisition": acquisition.dict()}
            self._evidence = acquisition.acquisition.evidence
            self._claims = acquisition.acquisition.claims
            self._coverage = acquisition.acquisition.coverage

        await self._activity("route_case")
        await self._activity("retrieve_knowledge")
        await self._activity("primary_investigator")
        for role in request.specialist_roles[:4]:
            await self._activity("specialist", role)
        critic = await self._activity("critic")
        if critic.decision != VerificationDecision.PASS:
            return {"state": CaseState.NEEDS_HUMAN.value, "critic": critic.dict()}
        verification = await self._activity("independent_verify")
        if verification.decision != VerificationDecision.PASS:
            return {"state": CaseState.ABSTAINED.value, "verification": verification.dict()}

        # This assignment and scheduling owner_wait happen in one workflow task.
        # Its projection cannot become externally visible before command readiness.
        self._owner_wait_ready = True
        await self._activity("owner_wait")
        await workflow.wait_condition(lambda: self._approval is not None)
        owner = await self._activity(
            "owner_gate", proposal=self._proposal, approval=self._approval,
            witness=self._current_witness, auth_assertion=self._owner_assertion,
            authorized_actor=self._owner_authenticated,
        )
        return {
            "state": (owner.state or CaseState.BLOCKED).value,
            "verification": verification.dict(),
            "owner_gate": owner.dict(),
        }

    @workflow.update(name="submit_owner_command")
    async def submit_owner_command(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        """Validate/consume auth before durable proposal or approval mutation."""
        try:
            command = OwnerGateCommand.parse_obj(command_data)
            if not self._initialized:
                raise PolicyViolation("workflow_not_initialized")
            if command.case_id != self._case_id or command.tenant_id != self._tenant_id:
                raise PolicyViolation("owner_command_case_or_tenant_mismatch")
            if not self._owner_wait_ready:
                raise PolicyViolation("owner_gate_not_ready")
            proposed = command.proposal or self._proposal
            expected_proposal_id = proposed.proposal_id if proposed is not None else None
            if command.proposal is not None and self._proposal is not None and self._proposal != command.proposal:
                raise PolicyViolation("owner_command_proposal_immutable")
            if command.approval is not None:
                if expected_proposal_id is None or command.approval.proposal_id != expected_proposal_id:
                    raise PolicyViolation("owner_command_unknown_or_mismatched_proposal")
                if command.proposal_id not in {None, expected_proposal_id}:
                    raise PolicyViolation("owner_command_proposal_id_mismatch")
                if self._approval is not None and (
                    self._approval != command.approval or self._current_witness != command.current_witness
                ):
                    raise PolicyViolation("owner_command_approval_immutable")
            validation = await self._activity(
                "validate_owner_command", proposal=command.proposal, approval=command.approval,
                witness=command.current_witness, auth_assertion=command.auth_assertion,
                proposal_id=expected_proposal_id,
            )
            if validation.decision != VerificationDecision.PASS or validation.authenticated is None:
                raise PolicyViolation((validation.reason_codes or ["owner_command_authorization_rejected"])[0])
            # No field below is changed until the isolated auth activity has
            # verified issuer/audience/key/scope and consumed the assertion jti.
            self._proposal = proposed
            if command.approval is not None:
                self._approval = command.approval
                self._current_witness = command.current_witness
                self._owner_assertion = command.auth_assertion
                self._owner_authenticated = validation.authenticated
            self._command_count += 1
            return OwnerCommandReceipt(
                case_id=self._case_id, tenant_id=self._tenant_id, workflow_run_id=self._workflow_run_id,
                phase="approval_submitted" if command.approval is not None else "proposal_submitted",
            ).dict()
        except (PolicyViolation, ValidationError) as error:
            return self._rejected(command_data, error)

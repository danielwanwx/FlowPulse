"""The sole durable workflow definition for FlowPulse P0."""

import asyncio
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


@workflow.defn(name="flowpulse.diagnosis.v2")
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
        self._public_incident_id = None
        self._public_run_id = None
        self._public_topology_revision = None
        self._capability_scope_created_at = None
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
        # A workflow-history phase, not a transient readiness bit. Updates
        # wait for this durable phase instead of racing an activity projection.
        self._owner_phase = "INITIALIZING"
        self._command_count = 0
        # Update handlers may await an auth activity. Serialize each
        # workflow-state check/commit section; the recheck after the await
        # closes the gap between them.
        # Construct only from an executing coroutine. Python 3.9's
        # ``asyncio.Lock`` otherwise requires a process-global current loop,
        # while this workflow is also instantiated by pure policy tests.
        self._owner_command_lock = None

    def _owner_lock(self):
        if self._owner_command_lock is None:
            self._owner_command_lock = asyncio.Lock()
        return self._owner_command_lock

    def _packet(
        self, stage: str, specialist_role: str = None, proposal=None, approval=None,
        witness=None, auth_assertion=None, authorized_actor=None, proposal_id=None,
    ) -> TemporalActivityPacket:
        self._sequence += 1
        return TemporalActivityPacket(
            case_id=self._case_id, case_revision=self._case_revision, tenant_id=self._tenant_id,
            workflow_id=self._workflow_id, workflow_run_id=self._workflow_run_id,
            public_incident_id=self._public_incident_id, public_run_id=self._public_run_id,
            public_topology_revision=self._public_topology_revision,
            capability_scope_created_at=self._capability_scope_created_at,
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
        # Existing v2 histories predate the public capability binding fields.
        # Omit only absent additions so their scheduled activity input remains
        # byte-equivalent when current code replays the frozen workflow type.
        payload = packet.dict()
        if all(
            getattr(packet, name) is None
            for name in (
                "public_incident_id", "public_run_id", "public_topology_revision", "capability_scope_created_at",
            )
        ):
            for name in (
                "public_incident_id", "public_run_id", "public_topology_revision", "capability_scope_created_at",
            ):
                payload.pop(name, None)
        result = await workflow.execute_activity(
            "{}_activity".format(stage), payload, start_to_close_timeout=timedelta(minutes=2),
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

    def _validate_authoritative_command_state(self, command: OwnerGateCommand):
        """Validate the current workflow state immediately before mutation."""
        if not self._initialized:
            raise PolicyViolation("workflow_not_initialized")
        if self._owner_phase != "OWNER_WAIT":
            raise PolicyViolation("owner_gate_phase_not_accepting_commands")
        if command.case_id != self._case_id or command.tenant_id != self._tenant_id:
            raise PolicyViolation("owner_command_case_or_tenant_mismatch")
        if (
            command.auth_assertion.case_revision != self._case_revision
            or command.auth_assertion.workflow_run_id != self._workflow_run_id
        ):
            raise PolicyViolation("owner_command_assertion_run_or_revision_mismatch")
        proposed = command.proposal or self._proposal
        expected_proposal_id = proposed.proposal_id if proposed is not None else None
        if command.proposal is not None and self._proposal is not None and self._proposal != command.proposal:
            raise PolicyViolation("owner_command_proposal_immutable")
        if command.proposal_id not in {None, expected_proposal_id}:
            raise PolicyViolation("owner_command_proposal_id_mismatch")
        if command.approval is not None:
            if expected_proposal_id is None or command.approval.proposal_id != expected_proposal_id:
                raise PolicyViolation("owner_command_unknown_or_mismatched_proposal")
            if self._approval is not None and (
                self._approval != command.approval or self._current_witness != command.current_witness
            ):
                raise PolicyViolation("owner_command_approval_immutable")
        return proposed, expected_proposal_id

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = TemporalCaseRequest.parse_obj(request_data)
        self._case_id = request.case.case_id
        self._case_revision = request.case.case_revision
        self._tenant_id = request.case.tenant_id
        self._workflow_id = request.case.workflow_id
        self._workflow_run_id = workflow.info().run_id
        self._public_incident_id = request.case.public_incident_id
        self._public_run_id = request.case.public_run_id
        self._public_topology_revision = request.case.public_topology_revision
        self._capability_scope_created_at = request.case.capability_scope_created_at
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
        self._owner_phase = "DIAGNOSING"
        self._command_count = 0
        self._initialized = True

        if not self._evidence:
            acquisition = await self._activity("acquire_current_evidence")
            if acquisition.decision != VerificationDecision.PASS or acquisition.acquisition is None:
                self._owner_phase = "TERMINAL"
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
            self._owner_phase = "TERMINAL"
            return {"state": CaseState.NEEDS_HUMAN.value, "critic": critic.dict()}
        verification = await self._activity("independent_verify")
        if verification.decision != VerificationDecision.PASS:
            self._owner_phase = "TERMINAL"
            return {"state": CaseState.ABSTAINED.value, "verification": verification.dict()}

        # Persist this workflow phase in the same task that schedules the
        # owner-wait activity. The activity projection therefore cannot be
        # externally visible before an update is permitted to proceed.
        self._owner_phase = "OWNER_WAIT"
        await self._activity("owner_wait")
        await workflow.wait_condition(lambda: self._approval is not None)
        self._owner_phase = "OWNER_GATE"
        owner = await self._activity(
            "owner_gate", proposal=self._proposal, approval=self._approval,
            witness=self._current_witness, auth_assertion=self._owner_assertion,
            authorized_actor=self._owner_authenticated,
        )
        self._owner_phase = "TERMINAL"
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
            # An early update is held in Temporal until either a durable owner
            # wait or a terminal outcome exists; it is never rejected merely
            # because a normal in-memory flag has not been set yet.
            await workflow.wait_condition(lambda: self._initialized)
            async with self._owner_lock():
                await workflow.wait_condition(
                    lambda: self._owner_phase in {"OWNER_WAIT", "OWNER_GATE", "TERMINAL"}
                )
                proposed, expected_proposal_id = self._validate_authoritative_command_state(command)
            # Authorization can suspend the update handler. Do not hold the
            # command lock across that external boundary: another command or
            # the run itself may advance the workflow while it is in flight.
            # The second lock acquisition and full revalidation below make
            # that race fail closed instead of committing stale intent.
            validation = await self._activity(
                "validate_owner_command", proposal=command.proposal, approval=command.approval,
                witness=command.current_witness, auth_assertion=command.auth_assertion,
                proposal_id=expected_proposal_id,
            )
            if validation.decision != VerificationDecision.PASS or validation.authenticated is None:
                raise PolicyViolation((validation.reason_codes or ["owner_command_authorization_rejected"])[0])
            async with self._owner_lock():
                # The activity awaited above is an external boundary. Re-read
                # all workflow-authoritative state before committing anything.
                revalidated, revalidated_proposal_id = self._validate_authoritative_command_state(command)
                if revalidated != proposed or revalidated_proposal_id != expected_proposal_id:
                    raise PolicyViolation("owner_command_authoritative_state_changed")
                # No field below is changed until auth verified issuer/audience/
                # key/scope and the same state passed a second authoritative check.
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

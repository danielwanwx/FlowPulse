"""V3 long-running Incident Workspace runtime owner.

The first implementation slice owns stable execution registration, bounded
carry state, and safe continue-as-new. Domain commands are added separately;
no V2 command is routed here until its V3 contract is implemented.
"""

import asyncio
from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError
    from .workspace_v3_models import (
        TemporalExecutionPointerV3,
        WorkspaceExecutionRegistrationV3,
        WorkspaceRevisionAdvanceV3,
        WorkspaceRolloverStateV3,
        WorkspaceWorkflowRequestV3,
    )
    from .workspace_versions import WORKSPACE_V3_WORKFLOW_TYPE


ROLLOVER_HISTORY_LENGTH_LIMIT = 1_500
ROLLOVER_HISTORY_SIZE_LIMIT = 24 * 1024 * 1024
ROLLOVER_TRANSITION_LIMIT = 500


@workflow.defn(name=WORKSPACE_V3_WORKFLOW_TYPE)
class IncidentWorkspaceTemporalWorkflowV3:
    """Bounded execution-generation shell for the V3 workspace."""

    def __init__(self) -> None:
        self._initialized = False
        self._rollover_requested = False
        self._active_updates = 0
        self._accepted_transitions = 0
        self._state = None
        self._lock = asyncio.Lock()

    def _rollover_due(self) -> bool:
        info = workflow.info()
        return (
            self._accepted_transitions >= ROLLOVER_TRANSITION_LIMIT
            or info.get_current_history_length() >= ROLLOVER_HISTORY_LENGTH_LIMIT
            or info.get_current_history_size() >= ROLLOVER_HISTORY_SIZE_LIMIT
            or info.is_continue_as_new_suggested()
        )

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> None:
        request = WorkspaceWorkflowRequestV3.parse_obj(request_data)
        info = workflow.info()
        prior = request.carry.current_execution if request.carry is not None else None
        generation = 1 if prior is None else prior.temporal_generation + 1
        current = TemporalExecutionPointerV3(
            tenant_id=request.identity.tenant_id,
            incident_run_id=request.identity.incident_run_id,
            temporal_workflow_id=info.workflow_id,
            temporal_run_id=info.run_id,
            temporal_generation=generation,
            updated_at=workflow.now(),
        )
        registered = await workflow.execute_activity(
            "workspace_register_execution_v3_activity",
            WorkspaceExecutionRegistrationV3(
                identity=request.identity,
                prior=prior,
                current=current,
            ).dict(),
            start_to_close_timeout=timedelta(minutes=1),
        )
        current = TemporalExecutionPointerV3.parse_obj(registered)
        source = request.carry or request
        self._state = WorkspaceRolloverStateV3(
            identity=request.identity,
            current_execution=current,
            projection_ref=source.projection_ref,
            projection_revision=source.projection_revision,
            signal_revision=source.signal_revision,
            decision_revision=source.decision_revision,
            workspace_revision=source.workspace_revision,
            case_event_sequence=source.case_event_sequence,
            recent_idempotency_fingerprints=(
                list(request.carry.recent_idempotency_fingerprints)
                if request.carry is not None else []
            ),
            connector_cursor_watermarks=(
                dict(request.carry.connector_cursor_watermarks)
                if request.carry is not None else {}
            ),
            active_timer_descriptors=(
                list(request.carry.active_timer_descriptors)
                if request.carry is not None else []
            ),
        )
        self._initialized = True
        await workflow.wait_condition(
            lambda: self._rollover_requested and self._active_updates == 0,
        )
        carry = self._state.copy(deep=True)
        workflow.continue_as_new(
            request.copy(update={"carry": carry}).dict(),
        )

    @workflow.update(name="advance_workspace_v3")
    async def advance_workspace_v3(
        self, command_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        self._active_updates += 1
        try:
            await workflow.wait_condition(lambda: self._initialized)
            command = WorkspaceRevisionAdvanceV3.parse_obj(command_data)
            async with self._lock:
                if (
                    command.expected_case_event_sequence
                    != self._state.case_event_sequence
                ):
                    raise ValueError("workspace_v3_transition_sequence_conflict")
                for field in (
                    "projection_revision",
                    "signal_revision",
                    "decision_revision",
                    "workspace_revision",
                ):
                    if getattr(command, field) < getattr(self._state, field):
                        raise ValueError(
                            "workspace_v3_revision_must_not_decrease",
                        )
                self._state = self._state.copy(update={
                    "projection_ref": command.projection_ref,
                    "projection_revision": command.projection_revision,
                    "signal_revision": command.signal_revision,
                    "decision_revision": command.decision_revision,
                    "workspace_revision": command.workspace_revision,
                    "case_event_sequence": command.case_event_sequence,
                })
                self._accepted_transitions += 1
                if self._rollover_due():
                    self._rollover_requested = True
                return self._state.dict()
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}
        finally:
            self._active_updates -= 1

    @workflow.signal(name="request_workspace_rollover_v3")
    def request_workspace_rollover_v3(self) -> None:
        self._rollover_requested = True

    @workflow.query(name="workspace_runtime_state_v3")
    def workspace_runtime_state_v3(self) -> Dict[str, Any]:
        if not self._initialized or self._state is None:
            return {"initialized": False}
        return {
            "initialized": True,
            "rollover_requested": self._rollover_requested,
            "active_updates": self._active_updates,
            "accepted_transitions": self._accepted_transitions,
            "state": self._state.dict(),
        }

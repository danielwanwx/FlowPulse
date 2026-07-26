"""Frozen v1 replay/drain workflow for pre-authenticated Workspace executions.

It replays historical v1 command history exactly, but version markers reject
any newly delivered v1 start or node-explanation update. New work is v2.
"""

import asyncio
from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError
    from .models import AuthContext, StrictModel
    from .workspace_models import (
        IncidentRunBinding,
        NodeExplanationReceipt,
        NodeExplanationStart,
        WorkspaceActivityOutcome,
        WorkspaceActivityPacket,
        WorkspaceWorkflowRequest,
        initial_projection,
    )
    from .workspace_versions import WORKSPACE_V1_WORKFLOW_TYPE


V1_DRAIN_START_PATCH = "workspace-v1-drain-reject-new-start"
V1_DRAIN_UPDATE_PATCH = "workspace-v1-drain-reject-new-update"


class LegacyWorkspaceNodeExplanationInvocation(StrictModel):
    """The retired v1 update wrapper; never accepted by the live workflow."""

    command: NodeExplanationStart
    actor: AuthContext


@workflow.defn(name=WORKSPACE_V1_WORKFLOW_TYPE)
class LegacyIncidentWorkspaceTemporalWorkflow:
    """Frozen pre-auth v1 definition, registered only to replay and drain."""

    def __init__(self) -> None:
        self._initialized = False
        self._binding = None
        self._projection = None
        self._event_sequence = 0
        self._explanations: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    def _packet(self, stage: str, *, command: NodeExplanationStart = None, actor=None) -> WorkspaceActivityPacket:
        return WorkspaceActivityPacket(
            **self._binding.dict(), stage=stage, projection=self._projection,
            event_sequence=self._event_sequence, node_explanation=command, actor=actor,
        )

    async def _activity(self, stage: str, *, command: NodeExplanationStart = None, actor=None) -> WorkspaceActivityOutcome:
        packet = self._packet(stage, command=command, actor=actor).dict()
        if packet.get("actor") is None:
            packet.pop("actor", None)
        result = await workflow.execute_activity(
            stage + "_activity", packet,
            start_to_close_timeout=timedelta(minutes=2),
        )
        return WorkspaceActivityOutcome.parse_obj(result)

    @workflow.run
    async def run(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        request = WorkspaceWorkflowRequest.parse_obj(request_data)
        # An old history has no marker and deterministically follows its
        # historical initialization. A direct new v1 start records this marker
        # and terminally drains instead of creating another unauthenticated run.
        if workflow.patched(V1_DRAIN_START_PATCH):
            return {"accepted": False, "state": "DRAINING", "reason": "workspace_v1_draining"}
        request_values = request.copy(update={"workflow_run_id": workflow.info().run_id}).dict()
        self._binding = IncidentRunBinding.parse_obj({
            field: request_values[field] for field in IncidentRunBinding.__fields__
        })
        self._event_sequence = 1
        self._projection = initial_projection(self._binding, request.affected_entities, request.created_at)
        initialized = await self._activity("workspace_initialize")
        self._projection = initialized.projection or self._projection
        self._initialized = True
        await workflow.wait_condition(lambda: False)
        return {"state": "unreachable"}

    @workflow.update(name="await_workspace_projection")
    async def await_workspace_projection(self) -> Dict[str, Any]:
        await workflow.wait_condition(lambda: self._initialized)
        return self._projection.dict()

    @workflow.update(name="start_or_reuse_node_explanation")
    async def start_or_reuse_node_explanation(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            await workflow.wait_condition(lambda: self._initialized)
            # Old update events replay with ``False`` (no historical marker),
            # preserving their scheduled activity commands. A newly delivered
            # update records the marker and returns a typed drain rejection;
            # it cannot exercise the retired actor-less decoder.
            if workflow.patched(V1_DRAIN_UPDATE_PATCH):
                return {"accepted": False, "reason": "workspace_v1_draining"}
            actor = None
            try:
                invocation = LegacyWorkspaceNodeExplanationInvocation.parse_obj(command_data)
                command = invocation.command
                actor = invocation.actor
            except (ValidationError, ValueError):
                command = NodeExplanationStart.parse_obj(command_data)
            async with self._lock:
                if (
                    command.incident_id != self._binding.incident_id or command.run_id != self._binding.run_id
                    or command.topology_revision != self._binding.topology_revision
                    or command.projection_revision != self._projection.projection_revision
                ):
                    raise ValueError("workspace_node_explanation_identity_or_revision_mismatch")
                if command.component_id not in {node.component_id for node in self._projection.graph.nodes}:
                    raise ValueError("workspace_node_explanation_component_not_canonical")
                selection_key = command.selection_key(self._binding.tenant_id)
                existing = self._explanations.get(selection_key)
                if existing is not None:
                    return NodeExplanationReceipt.parse_obj({"explanation": existing, "reused": True}).dict()
                self._event_sequence += 1
                outcome = await self._activity("workspace_node_explanation", command=command, actor=actor)
                if outcome.explanation is None:
                    raise ValueError("workspace_node_explanation_activity_missing_result")
                payload = outcome.explanation.dict()
                self._explanations[selection_key] = payload
                return NodeExplanationReceipt(explanation=outcome.explanation, reused=False).dict()
        except (ValidationError, ValueError) as error:
            return {"accepted": False, "reason": str(error)}

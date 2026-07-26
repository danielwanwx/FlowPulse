"""Temporal workflow for the additive, public-identity Incident Workspace."""

import asyncio
from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow
from temporalio.common import RetryPolicy

# Pydantic v1 model inheritance deep-copies datetime field descriptors during
# Temporal's sandbox import. The contracts are immutable parsing utilities, so
# pass this dependency through exactly as the worker/importer loaded it.
with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError
    from .workspace_models import (
        IncidentRunBinding,
        IncidentProjection,
        NodeExplanationReceipt,
        NodeExplanationStart,
        WorkspaceNodeExplanationInvocation,
        WorkspaceNodeExplanationAuthorizationOutcome,
        WorkspaceNodeExplanationAuthorizationPacket,
        WorkspaceActivityOutcome,
        WorkspaceActivityPacket,
        WorkspaceWorkflowRequest,
        initial_projection,
    )
    from .workspace_versions import WORKSPACE_V2_WORKFLOW_TYPE


@workflow.defn(name=WORKSPACE_V2_WORKFLOW_TYPE)
class IncidentWorkspaceTemporalWorkflow:
    """Authenticated v2 Temporal owner for new workspace executions."""

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
        # Keep parent workspace activity inputs byte-compatible when the old
        # direct update form carried no trusted actor packet.
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
        request_values = request.copy(update={"workflow_run_id": workflow.info().run_id}).dict()
        self._binding = IncidentRunBinding.parse_obj({
            field: request_values[field] for field in IncidentRunBinding.__fields__
        })
        self._event_sequence = 1
        self._projection = initial_projection(self._binding, request.affected_entities, request.created_at)
        # The initializer receives only the trusted intake identity and appends
        # its durable workspace-subject grant before the projection is readable.
        initialized = await self._activity("workspace_initialize", actor=request.actor)
        self._projection = initialized.projection or self._projection
        self._initialized = True
        await workflow.wait_condition(lambda: False)
        return {"state": "unreachable"}

    @workflow.update(name="await_workspace_projection")
    async def await_workspace_projection(self) -> Dict[str, Any]:
        """Read-after-start barrier: activity persistence precedes API success."""
        await workflow.wait_condition(lambda: self._initialized)
        return self._projection.dict()

    @workflow.update(name="start_or_reuse_node_explanation")
    async def start_or_reuse_node_explanation(self, command_data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            # v1's unauthenticated bare command decoder lives exclusively in
            # ``legacy_workspace_workflow`` for archived-history replay. A
            # current live update cannot reach an activity/provider without a
            # typed, server-minted command assertion.
            invocation = WorkspaceNodeExplanationInvocation.parse_obj(command_data)
            command = invocation.command
            await workflow.wait_condition(lambda: self._initialized)
            self._validate_node_command(command)
            authorization = await workflow.execute_activity(
                "workspace_authorize_node_explanation_activity",
                WorkspaceNodeExplanationAuthorizationPacket(
                    **self._binding.dict(), command=command, authorization=invocation.authorization,
                    projection_revision=self._projection.projection_revision,
                ).dict(),
                start_to_close_timeout=timedelta(minutes=1),
                # An invalid or replayed command is a policy decision, never
                # transient work to retry; a second attempt might consume a
                # one-time assertion or obscure the rejection boundary.
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            actor = WorkspaceNodeExplanationAuthorizationOutcome.parse_obj(authorization).actor
            if actor.tenant_id != self._binding.tenant_id:
                raise ValueError("workspace_authorization_actor_tenant_mismatch")
            async with self._lock:
                self._validate_node_command(command)
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

    def _validate_node_command(self, command: NodeExplanationStart) -> None:
        if (
            command.incident_id != self._binding.incident_id or command.run_id != self._binding.run_id
            or command.topology_revision != self._binding.topology_revision
            or command.projection_revision != self._projection.projection_revision
        ):
            raise ValueError("workspace_node_explanation_identity_or_revision_mismatch")
        if command.component_id not in {node.component_id for node in self._projection.graph.nodes}:
            raise ValueError("workspace_node_explanation_component_not_canonical")

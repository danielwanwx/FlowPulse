"""Live Temporal proof that a pre-correction v1 execution resumes only to drain."""

import asyncio
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from uuid import uuid4

from temporalio import workflow
from temporalio.client import Client
from temporalio.worker import Worker

# This module is itself imported by Temporal's workflow sandbox when it
# validates ``PreCorrectionV1WorkspaceWorkflow``.  The application models and
# activity dispatcher are deliberately shared with the host process, matching
# the production workflow modules' import boundary.
with workflow.unsafe.imports_passed_through():
    from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher, build_workspace_activities
    from flowpulse_cp.workspace_models import (
        IncidentRunBinding,
        NodeExplanationStart,
        WorkspaceActivityOutcome,
        WorkspaceActivityPacket,
        WorkspaceWorkflowRequest,
        initial_projection,
    )
    from flowpulse_cp.workspace_registration import WORKSPACE_V1_WORKFLOW_TYPE, workspace_workflow_definitions
    from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
    from flowpulse_cp.models import AuthContext
    from flowpulse_cp.legacy_workspace_workflow import LegacyIncidentWorkspaceTemporalWorkflow


@workflow.defn(name=WORKSPACE_V1_WORKFLOW_TYPE)
class PreCorrectionV1WorkspaceWorkflow:
    """A test-only producer of the pre-drain v1 command history."""

    def __init__(self) -> None:
        self._initialized = False
        self._binding = None
        self._projection = None
        self._event_sequence = 0

    async def _activity(self) -> WorkspaceActivityOutcome:
        packet = WorkspaceActivityPacket(
            **self._binding.dict(), stage="workspace_initialize", projection=self._projection,
            event_sequence=self._event_sequence,
        ).dict()
        result = await workflow.execute_activity(
            "workspace_initialize_activity", packet, start_to_close_timeout=timedelta(minutes=2),
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
        initialized = await self._activity()
        self._projection = initialized.projection or self._projection
        self._initialized = True
        await workflow.wait_condition(lambda: False)
        return {"state": "unreachable"}

    @workflow.update(name="await_workspace_projection")
    async def await_workspace_projection(self) -> Dict[str, Any]:
        await workflow.wait_condition(lambda: self._initialized)
        return self._projection.dict()


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_LIVE_WORKSPACE_V1_DRAIN") == "1",
    "requires the local Compose Temporal service",
)
class LiveWorkspaceV1DrainTests(unittest.TestCase):
    address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "temporal:7233")

    def test_pre_correction_v1_resumes_with_registered_drain_and_rejects_new_update(self):
        async def run():
            suffix = uuid4().hex
            queue = "flowpulse-workspace-v1-drain-{}".format(suffix)
            request = WorkspaceWorkflowRequest(
                tenant_id="tenant-v1-{}".format(suffix), incident_id="incident-{}".format(suffix),
                run_id="run-{}".format(suffix), topology_revision="topology-{}".format(suffix),
                case_id="case-{}".format(suffix), case_revision=1,
                workflow_id="flowpulse.workspace.v1-drain.{}".format(suffix), workflow_run_id="pending",
                created_at=datetime.now(timezone.utc),
                actor=AuthContext(tenant_id="tenant-v1-{}".format(suffix), subject_id="subject-v1", roles=["viewer"]),
                title="Legacy drain", severity="SEV2", environment="local", affected_entities=["checkout"],
                summary="Pre-correction v1 history for drain coverage.",
            )
            repository = InMemoryWorkspaceRepository()
            dispatcher = WorkspaceActivityDispatcher(repository)
            client = await Client.connect(self.address)
            async with Worker(
                client, task_queue=queue, workflows=[PreCorrectionV1WorkspaceWorkflow],
                activities=build_workspace_activities(dispatcher),
            ):
                handle = await client.start_workflow(
                    PreCorrectionV1WorkspaceWorkflow.run, request.dict(), id=request.workflow_id, task_queue=queue,
                )
                projection = await handle.execute_update(PreCorrectionV1WorkspaceWorkflow.await_workspace_projection)
                self.assertEqual(request.case_id, projection["case_id"])

            # This is the same registration list that production uses after the
            # deployment: old v1 resumes as drain; new v2 runs independently.
            async with Worker(
                client, task_queue=queue, workflows=workspace_workflow_definitions(),
                activities=build_workspace_activities(dispatcher),
            ):
                resumed = await handle.execute_update(LegacyIncidentWorkspaceTemporalWorkflow.await_workspace_projection)
                self.assertEqual(request.run_id, resumed["run_id"])
                receipt = await handle.execute_update(
                    LegacyIncidentWorkspaceTemporalWorkflow.start_or_reuse_node_explanation,
                    NodeExplanationStart(
                        incident_id=request.incident_id, run_id=request.run_id,
                        topology_revision=request.topology_revision, projection_revision=1,
                        component_id="checkout", idempotency_key="legacy-v1-drain",
                    ).dict(),
                )
                self.assertEqual({"accepted": False, "reason": "workspace_v1_draining"}, receipt)
                history = await handle.fetch_history()
                patch_ids = []
                for event in history.events:
                    if not event.HasField("marker_recorded_event_attributes"):
                        continue
                    marker = event.marker_recorded_event_attributes
                    if marker.marker_name != "core_patch":
                        continue
                    payloads = marker.details["patch-data"].payloads
                    patch_ids.extend(json.loads(payload.data.decode("utf-8"))["id"] for payload in payloads)
                self.assertIn("workspace-v1-drain-reject-new-update", patch_ids)
                self.assertNotIn("workspace_node_explanation_activity", history.to_json())
                self.assertEqual({}, repository.explanations)
                self.assertEqual({}, repository.capability_audits)

                # The actual production registration also drains a direct new
                # v1 start; only a pre-correction history may enter v1.
                direct_request = request.copy(update={
                    "workflow_id": "flowpulse.workspace.v1-new-start.{}".format(suffix),
                    "workflow_run_id": "pending",
                })
                direct = await client.start_workflow(
                    LegacyIncidentWorkspaceTemporalWorkflow.run,
                    direct_request.dict(), id=direct_request.workflow_id, task_queue=queue,
                )
                self.assertEqual(
                    {"accepted": False, "state": "DRAINING", "reason": "workspace_v1_draining"},
                    await direct.result(),
                )
                self.assertEqual({}, repository.explanations)
                self.assertEqual({}, repository.capability_audits)

                # A direct v1 start must drain before it attempts to decode
                # caller input.  Otherwise malformed input can turn the
                # retired type into a workflow-task failure rather than the
                # typed, side-effect-free terminal response.
                bindings_before = dict(repository.bindings)
                projections_before = {key: list(value) for key, value in repository.projections.items()}
                events_before = {key: list(value) for key, value in repository.events.items()}
                malformed = await client.start_workflow(
                    LegacyIncidentWorkspaceTemporalWorkflow.run,
                    {"unknown_caller_field": "must-not-be-parsed"},
                    id="flowpulse.workspace.v1-malformed-start.{}".format(suffix), task_queue=queue,
                )
                self.assertEqual(
                    {"accepted": False, "state": "DRAINING", "reason": "workspace_v1_draining"},
                    await malformed.result(),
                )
                malformed_history = await malformed.fetch_history()
                self.assertNotIn("workspace_initialize_activity", malformed_history.to_json())
                self.assertEqual(bindings_before, repository.bindings)
                self.assertEqual(projections_before, {key: list(value) for key, value in repository.projections.items()})
                self.assertEqual(events_before, {key: list(value) for key, value in repository.events.items()})
                self.assertEqual({}, repository.explanations)
                self.assertEqual({}, repository.capability_audits)
            await handle.terminate(reason="v1_drain_coverage_complete")

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

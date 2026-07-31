"""Opt-in Temporal proofs for the V3 user-gated stage orchestration."""

import asyncio
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from flowpulse_cp.models import AuthContext
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.realtime_activities import build_realtime_activities
from flowpulse_cp.realtime_models import (
    FreshnessDeadline,
    FreshnessDeadlineState,
    RealtimeFreshnessExpiryActivityOutcome,
    RealtimeFreshnessExpiryActivityPacket,
    RealtimeFreshnessTimerLoadPacket,
    TemporalFreshnessTimer,
)
from flowpulse_cp.workspace_activities import (
    WorkspaceActivityDispatcher,
    build_workspace_activities,
)
from flowpulse_cp.workspace_models import WorkspaceWorkflowRequest
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider
from flowpulse_cp.workspace_v3_models import (
    ActionApprovalCommandV3,
    ActionApprovalDecisionV3,
    GuidedStageActivityOutcomeV3,
    GuidedStageActivityPacketV3,
    GuidedStageActivityStatusV3,
    IncidentProjectionV3,
    WorkflowCommandNameV3,
    WorkflowCommandReceiptV3,
    WorkflowCommandV3,
    WorkflowRerunCommandV3,
    WorkflowStageV3,
    WorkflowTemporalCommandV3,
    WorkflowTemporalOperationV3,
)
from flowpulse_cp.workspace_workflow import IncidentWorkspaceTemporalWorkflow
from tests.test_realtime_workflow_api import accepted_transition, binding
from tests.test_workspace_v3_acceptance import initial_projection


NOW = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)


def workflow_request():
    return WorkspaceWorkflowRequest(
        **binding().dict(),
        actor=AuthContext(
            tenant_id="tenant-a", subject_id="owner-a", roles=["owner"],
        ),
        title="Checkout errors rising",
        severity="SEV2",
        environment="test",
        affected_entities=["checkout"],
        summary="Temporal guided workflow proof.",
    )


def temporal_command(projection, key, *, operation=WorkflowTemporalOperationV3.ADVANCE, target=None):
    base = {
        "attempt_id": projection.current_attempt.attempt_id,
        "expected_stage": projection.current_attempt.current_stage,
        "expected_workflow_revision": projection.workflow_revision,
        "idempotency_key": key,
    }
    command = (
        WorkflowRerunCommandV3(**base, reason="Explicit operator rerun.")
        if operation == WorkflowTemporalOperationV3.RERUN
        else WorkflowCommandV3(**base)
    )
    return WorkflowTemporalCommandV3(
        operation=operation,
        tenant_id=projection.tenant_id,
        case_id=projection.case_id,
        actor_subject_id="owner-a",
        actor_roles=["owner"],
        command=command.dict(),
        target_stage=target,
    )


class RecordingGuidedRuntime:
    """Typed deterministic activity double; the workflow remains real Temporal."""

    def __init__(self, *, force_verify=False, stage_failures=0, force_action=False, action_failures=0):
        self.projection = initial_projection("case-a", "incident-a", "run-a")
        self.receipts = {}
        self.dispatch_calls = 0
        self.stage_packets = []
        self.force_verify = force_verify
        self.stage_failures = stage_failures
        self.force_action = force_action
        self.action_failures = action_failures
        self.action_packets = []
        self.verify_started = asyncio.Event()
        self.release_verify = asyncio.Event()

    async def dispatch_command(self, data):
        invocation = WorkflowTemporalCommandV3.parse_obj(data)
        self.dispatch_calls += 1
        command = invocation.command
        key = command["idempotency_key"]
        prior = self.receipts.get(key)
        if prior is not None:
            return prior.copy(update={"reused": True}).dict()

        if invocation.operation == WorkflowTemporalOperationV3.RERUN:
            projected = rerun_detect_projection(self.projection)
            command_name = WorkflowCommandNameV3.RERUN_FROM_STAGE
        elif invocation.operation == WorkflowTemporalOperationV3.ACTION_APPROVAL:
            projected = approved_action_projection(self.projection)
            command_name = WorkflowCommandNameV3.APPROVE_ACTION
        elif self.force_verify:
            projected = running_stage_projection(self.projection, WorkflowStageV3.VERIFY)
            command_name = WorkflowCommandNameV3.NEXT
        else:
            projected = running_stage_projection(self.projection, WorkflowStageV3.TRIAGE)
            command_name = WorkflowCommandNameV3.NEXT
        self.projection = projected
        receipt = WorkflowCommandReceiptV3(
            command_id="temporal-test-command-{}".format(key),
            command_name=command_name,
            accepted=True,
            reused=False,
            actor_subject_id=invocation.actor_subject_id,
            attempt_id=projected.current_attempt.attempt_id,
            workflow_revision=projected.workflow_revision,
            projection=projected,
            recorded_at=NOW + timedelta(seconds=self.dispatch_calls),
        )
        self.receipts[key] = receipt
        return receipt.dict()

    async def run_stage(self, data):
        packet = GuidedStageActivityPacketV3.parse_obj(data)
        self.stage_packets.append(packet)
        if self.stage_failures:
            self.stage_failures -= 1
            raise RuntimeError("injected_stage_response_loss")
        if packet.stage == WorkflowStageV3.VERIFY and len(self.stage_packets) == 1:
            self.verify_started.set()
            await self.release_verify.wait()
            return GuidedStageActivityOutcomeV3(
                status=GuidedStageActivityStatusV3.WAITING,
                projection=self.projection,
                reason="post_action_observation_window_open",
            ).dict()
        self.projection = succeeded_stage_projection(self.projection)
        return GuidedStageActivityOutcomeV3(
            status=GuidedStageActivityStatusV3.SUCCEEDED,
            projection=self.projection,
        ).dict()

    async def run_existing_agent(self, data):
        raise AssertionError("agent activity was not expected")

    async def execute_action(self, data):
        self.action_packets.append(copy.deepcopy(data))
        if self.action_failures:
            self.action_failures -= 1
            raise RuntimeError("injected_action_response_loss")
        self.projection = succeeded_action_projection(self.projection)
        return GuidedStageActivityOutcomeV3(
            status=GuidedStageActivityStatusV3.SUCCEEDED,
            projection=self.projection,
        ).dict()


def running_stage_projection(projection, stage):
    raw = copy.deepcopy(projection.dict())
    revision = projection.workflow_revision + 1
    attempt = raw["current_attempt"]
    attempt["current_stage"] = stage.value
    attempt["workflow_revision"] = revision
    attempt["stage_runs"].append({
        "schema_version": "flowpulse.workflow-stage-run.v3",
        "stage_run_id": "temporal-test-{}-run".format(stage.value.lower()),
        "attempt_id": attempt["attempt_id"],
        "stage": stage.value,
        "status": "RUNNING",
        "run_number": 1,
        "input_workflow_revision": revision,
        "input_signal_revision": raw["signal_revision"],
        "input_decision_revision": raw["decision_revision"],
        "progress_percent": 0,
        "replan_count": 0,
        "summary": None,
        "output": None,
        "evidence_refs": [],
        "failure_code": None,
        "started_at": (NOW + timedelta(seconds=revision)).isoformat(),
        "verification_deadline_at": (
            (NOW + timedelta(seconds=revision + 30)).isoformat()
            if stage == WorkflowStageV3.VERIFY else None
        ),
        "completed_at": None,
        "created_at": (NOW + timedelta(seconds=revision)).isoformat(),
    })
    if stage == WorkflowStageV3.VERIFY:
        attempt["action_executed"] = True
        attempt["action_receipt_id"] = "temporal-test-action-receipt"
    raw.update({
        "workflow_revision": revision,
        "projection_revision": projection.projection_revision + 1,
        "sequence": projection.sequence + 2,
        "current_attempt": attempt,
        "available_commands": ["RETRY", "ESCALATE"],
        "available_rerun_stages": [],
        "generated_at": (NOW + timedelta(seconds=revision)).isoformat(),
    })
    return IncidentProjectionV3.parse_obj(raw)


def rerun_detect_projection(projection):
    raw = copy.deepcopy(projection.dict())
    revision = projection.workflow_revision + 1
    attempt = raw["current_attempt"]
    for run in attempt["stage_runs"]:
        if run["stage"] == "DETECT" and run["status"] != "SUPERSEDED":
            run["status"] = "SUPERSEDED"
    attempt["workflow_revision"] = revision
    attempt["stage_runs"].append({
        "schema_version": "flowpulse.workflow-stage-run.v3",
        "stage_run_id": "temporal-test-detect-rerun",
        "attempt_id": attempt["attempt_id"],
        "stage": "DETECT",
        "status": "RUNNING",
        "run_number": 2,
        "input_workflow_revision": revision,
        "input_signal_revision": raw["signal_revision"],
        "input_decision_revision": raw["decision_revision"],
        "progress_percent": 0,
        "replan_count": 0,
        "summary": None,
        "output": None,
        "evidence_refs": [],
        "failure_code": None,
        "started_at": (NOW + timedelta(seconds=revision)).isoformat(),
        "completed_at": None,
        "created_at": (NOW + timedelta(seconds=revision)).isoformat(),
    })
    raw.update({
        "workflow_revision": revision,
        "projection_revision": projection.projection_revision + 1,
        "sequence": projection.sequence + 2,
        "current_attempt": attempt,
        "available_commands": ["RETRY", "ESCALATE"],
        "available_rerun_stages": [],
        "generated_at": (NOW + timedelta(seconds=revision)).isoformat(),
    })
    return IncidentProjectionV3.parse_obj(raw)


def succeeded_stage_projection(projection):
    raw = copy.deepcopy(projection.dict())
    current = raw["current_attempt"]["stage_runs"][-1]
    current.update({
        "status": "SUCCEEDED",
        "progress_percent": 100,
        "summary": "Temporal test stage completed.",
        "output": {
            "summary": "Temporal test stage completed.",
            "facts": [{
                "fact_id": "temporal-test-fact",
                "label": "Canonical test fact",
                "value": "accepted",
                "evidence_refs": ["evidence-a"],
            }],
            "evidence_refs": ["evidence-a"],
        },
        "evidence_refs": ["evidence-a"],
        "completed_at": (NOW + timedelta(seconds=10)).isoformat(),
    })
    raw.update({
        "projection_revision": projection.projection_revision + 1,
        "sequence": projection.sequence + 1,
        "current_attempt": raw["current_attempt"],
        "available_commands": ["NEXT", "RERUN_FROM_STAGE"],
        "available_rerun_stages": list(dict.fromkeys(
            item["stage"]
            for item in raw["current_attempt"]["stage_runs"]
            if item["status"] == "SUCCEEDED"
        )),
        "generated_at": (NOW + timedelta(seconds=10)).isoformat(),
    })
    return IncidentProjectionV3.parse_obj(raw)


def approved_action_projection(projection):
    projected = running_stage_projection(projection, WorkflowStageV3.RESPOND)
    raw = copy.deepcopy(projected.dict())
    run = raw["current_attempt"]["stage_runs"][-1]
    raw["actions"] = [{
        "schema_version": "flowpulse.incident-action.v3",
        "action_id": "temporal-test-action",
        "attempt_id": raw["current_attempt"]["attempt_id"],
        "stage_run_id": run["stage_run_id"],
        "title": "Restore Payment reachability",
        "summary": "Disable the bounded local fault.",
        "component_id": "checkout",
        "command_id": "astronomy.restore-payment-and-recreate-checkout",
        "command_label": "Restore Payment reachability",
        "decision_revision": raw["decision_revision"],
        "required_permission": "incident:execute",
        "approval_state": "APPROVED",
        "execution_state": "NOT_STARTED",
        "status": "APPROVED",
        "blast_radius": "Local Checkout only",
        "risk": "Bounded local mutation",
        "rollback_plan": "Safe Checkout recreation while the fault remains off",
        "verification_conditions": ["Fresh healthy Checkout to Payment trace"],
        "receipt": None,
    }]
    return IncidentProjectionV3.parse_obj(raw)


def succeeded_action_projection(projection):
    projected = succeeded_stage_projection(projection)
    raw = copy.deepcopy(projected.dict())
    completed_at = (NOW + timedelta(seconds=10)).isoformat()
    receipt = {
        "schema_version": "flowpulse.action-execution-receipt.v3",
        "receipt_id": "temporal-test-execution-receipt",
        "executor_id": "temporal-test-node",
        "command_id": "astronomy.restore-payment-and-recreate-checkout",
        "status": "SUCCEEDED",
        "started_at": (NOW + timedelta(seconds=5)).isoformat(),
        "completed_at": completed_at,
        "output_summary": "Bounded action completed exactly once.",
        "rollback_status": "NOT_CONFIGURED",
    }
    raw["actions"][0].update({
        "execution_state": "SUCCEEDED",
        "status": "SUCCEEDED",
        "receipt": receipt,
    })
    raw["current_attempt"].update({
        "action_executed": True,
        "action_receipt_id": receipt["receipt_id"],
    })
    return IncidentProjectionV3.parse_obj(raw)


def approval_temporal_command(projection, key):
    action_projection = approved_action_projection(projection)
    action = action_projection.actions[0]
    command = ActionApprovalCommandV3(
        attempt_id=action_projection.current_attempt.attempt_id,
        expected_stage=WorkflowStageV3.RESPOND,
        expected_workflow_revision=action_projection.workflow_revision,
        idempotency_key=key,
        decision=ActionApprovalDecisionV3.APPROVE,
        expected_decision_revision=action_projection.decision_revision,
    )
    # The fake dispatch owns the transition to action_projection; the command
    # identity represents the browser's prior canonical Respond projection.
    return WorkflowTemporalCommandV3(
        operation=WorkflowTemporalOperationV3.ACTION_APPROVAL,
        tenant_id=projection.tenant_id,
        case_id=projection.case_id,
        actor_subject_id="owner-a",
        actor_roles=["owner"],
        command=command.dict(),
        action_id=action.action_id,
    )


class StaticRealtimeDispatcher:
    def __init__(self, poll_result, outcome, *, timer_seconds=300, expire=False):
        self.poll_result = poll_result
        self.outcome = outcome
        self.calls = []
        self.timer = None
        self.timer_seconds = timer_seconds
        self.expire = expire
        self.expiration_packets = []

    async def dispatch(self, name, data):
        self.calls.append(name)
        if name == "workspace_load_realtime_dispatch_activity":
            return self.poll_result.dict()
        if name == "workspace_commit_realtime_source_event_activity":
            return self.outcome.dict()
        if name == "workspace_load_realtime_freshness_timer_activity":
            packet = RealtimeFreshnessTimerLoadPacket.parse_obj(data)
            self.timer = TemporalFreshnessTimer(
                deadline=FreshnessDeadline(
                    tenant_id=packet.command.tenant_id,
                    case_id=packet.command.case_id,
                    connector_id=packet.command.connector_id,
                    deadline_revision=1,
                    state=FreshnessDeadlineState.ARMED,
                    deadline=(
                        datetime.now(timezone.utc)
                        + timedelta(seconds=self.timer_seconds)
                    ),
                    source_event_id=packet.committed_source_event_id,
                    recorded_at=datetime.now(timezone.utc),
                ),
                actor_subject_id=packet.command.actor_subject_id,
            )
            return self.timer.dict()
        if name == "workspace_expire_realtime_freshness_activity":
            packet = RealtimeFreshnessExpiryActivityPacket.parse_obj(data)
            self.expiration_packets.append(packet)
            if self.expire:
                workspace_projection = self.outcome.workspace_projection.copy(
                    update={
                        "projection_revision": (
                            self.outcome.workspace_projection.projection_revision + 1
                        ),
                        "sequence": self.outcome.workspace_projection.sequence + 1,
                        "generated_at": packet.fired_at,
                    },
                )
                realtime_projection = self.outcome.projection.copy(update={
                    "projection_revision": (
                        self.outcome.projection.projection_revision + 1
                    ),
                    "sequence": self.outcome.projection.sequence + 1,
                    "generated_at": packet.fired_at,
                    "incident_clock": self.outcome.projection.incident_clock.copy(
                        update={
                            "as_of": packet.fired_at,
                            "freshness": "STALE",
                            "fresh_until": packet.deadline.deadline,
                        },
                    ),
                    "realtime_signals": [
                        item.copy(update={
                            "freshness": "STALE",
                            "connector_state": "STALE",
                        })
                        for item in self.outcome.projection.realtime_signals
                    ],
                })
                return RealtimeFreshnessExpiryActivityOutcome(
                    expired=True,
                    deadline=packet.deadline.copy(update={
                        "deadline_revision": (
                            packet.deadline.deadline_revision + 1
                        ),
                        "state": FreshnessDeadlineState.EXPIRED,
                        "recorded_at": packet.fired_at,
                    }),
                    projection=realtime_projection,
                    workspace_projection=workspace_projection,
                ).dict()
            return RealtimeFreshnessExpiryActivityOutcome(
                expired=False,
                reason="test_timer_superseded",
            ).dict()
        raise AssertionError(name)


def workspace_activities(repository, runtime):
    return build_workspace_activities(WorkspaceActivityDispatcher(
        repository,
        topology_provider=CapturedAstronomyTopologyProvider(ProviderMode.TEST),
        guided_runtime=runtime,
    ))


@unittest.skipUnless(
    os.environ.get("FLOWPULSE_TEST_TEMPORAL") == "1",
    "requires an installed Temporal test server",
)
class GuidedV3TemporalTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_stage_response_retries_same_stage_run_once(self):
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime(stage_failures=1)
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-stage-retry"
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=workspace_activities(repository, runtime),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-stage-retry", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                receipt = await handle.execute_update(
                    "workflow_command_v3",
                    temporal_command(runtime.projection, "stage-retry-next").dict(),
                )
                self.assertEqual("SUCCEEDED", receipt["projection"]["current_attempt"]["stage_runs"][-1]["status"])
                self.assertEqual(2, len(runtime.stage_packets))
                self.assertEqual(
                    runtime.stage_packets[0].stage_run_id,
                    runtime.stage_packets[1].stage_run_id,
                )

    async def test_lost_action_response_retries_same_action_packet_and_succeeds(self):
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime(force_action=True, action_failures=1)
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-action-retry"
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=workspace_activities(repository, runtime),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-action-retry", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                receipt = await handle.execute_update(
                    "workflow_command_v3",
                    approval_temporal_command(runtime.projection, "approve-retry").dict(),
                )
                self.assertEqual("SUCCEEDED", receipt["projection"]["actions"][0]["execution_state"])
                self.assertEqual(2, len(runtime.action_packets))
                self.assertEqual(runtime.action_packets[0], runtime.action_packets[1])

    async def test_no_stage_before_next_and_duplicate_next_schedules_stage_once(self):
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime()
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-next"
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=workspace_activities(repository, runtime),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-next", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                self.assertEqual([], runtime.stage_packets)
                invocation = temporal_command(runtime.projection, "same-next")
                first, second = await asyncio.gather(
                    handle.execute_update("workflow_command_v3", invocation.dict()),
                    handle.execute_update("workflow_command_v3", invocation.dict()),
                )
                self.assertEqual(1, len(runtime.stage_packets))
                self.assertEqual(1, sum(not item["reused"] for item in (first, second)))

    async def test_detect_rerun_never_schedules_an_unsupported_stage_activity(self):
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime()
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-detect-rerun"
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=workspace_activities(repository, runtime),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-detect-rerun", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                invocation = temporal_command(
                    runtime.projection, "rerun-detect",
                    operation=WorkflowTemporalOperationV3.RERUN,
                    target=WorkflowStageV3.DETECT,
                )
                receipt = await handle.execute_update("workflow_command_v3", invocation.dict())
                self.assertEqual("DETECT", receipt["projection"]["current_attempt"]["current_stage"])
                self.assertEqual([], runtime.stage_packets)

    async def test_verify_temporal_timer_allows_realtime_update_to_interleave(self):
        prepared = __import__(
            "flowpulse_cp.realtime_repository", fromlist=["InMemoryRealtimeRepository"],
        ).InMemoryRealtimeRepository()
        _, outcome, packet = await accepted_transition(prepared)
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime(force_verify=True)
        realtime = StaticRealtimeDispatcher(packet.poll_result, outcome)
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-verify"
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=(
                    workspace_activities(repository, runtime)
                    + build_realtime_activities(realtime)
                ),
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-verify", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                verify = asyncio.create_task(handle.execute_update(
                    "workflow_command_v3",
                    temporal_command(runtime.projection, "start-verify").dict(),
                ))
                await asyncio.wait_for(runtime.verify_started.wait(), timeout=10)
                realtime_receipt = await handle.execute_update(
                    "reconcile_realtime_connector", packet.command.dict(),
                )
                self.assertTrue(realtime_receipt["accepted"])
                runtime.release_verify.set()
                receipt = await asyncio.wait_for(verify, timeout=20)
                self.assertEqual("SUCCEEDED", receipt["projection"]["current_attempt"]["stage_runs"][-1]["status"])
                self.assertEqual(2, len(runtime.stage_packets))
                history = (await handle.fetch_history()).to_json()
                self.assertIn("EVENT_TYPE_TIMER_STARTED", history)
                self.assertIn("EVENT_TYPE_TIMER_FIRED", history)

    async def test_freshness_timer_survives_replay_and_persists_stale_once(self):
        prepared = __import__(
            "flowpulse_cp.realtime_repository",
            fromlist=["InMemoryRealtimeRepository"],
        ).InMemoryRealtimeRepository()
        _, outcome, packet = await accepted_transition(prepared)
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime()
        realtime = StaticRealtimeDispatcher(
            packet.poll_result,
            outcome,
            timer_seconds=2,
            expire=True,
        )
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-freshness-restart"
            async with Worker(
                environment.client,
                task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow],
                activities=(
                    workspace_activities(repository, runtime)
                    + build_realtime_activities(realtime)
                ),
                # Rebuild from history on every workflow task, equivalent to a
                # replacement worker taking over after restart.
                max_cached_workflows=0,
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(),
                    id="guided-v3-temporal-freshness-restart",
                    task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                accepted = await handle.execute_update(
                    "reconcile_realtime_connector",
                    packet.command.dict(),
                )
                self.assertTrue(accepted["accepted"])
                armed = await handle.query("workspace_runtime_state")
                self.assertIn(packet.command.connector_id, armed["freshness_timers"])
                await environment.sleep(timedelta(seconds=3))
                for _ in range(50):
                    if realtime.expiration_packets:
                        break
                    await asyncio.sleep(0.02)
                self.assertEqual(1, len(realtime.expiration_packets))
                state = await handle.query("workspace_runtime_state")
                self.assertEqual({}, state["freshness_timers"])
                restored = await handle.execute_update("await_workspace_projection")
                self.assertEqual(
                    outcome.workspace_projection.projection_revision + 1,
                    restored["projection_revision"],
                )
                history = (await handle.fetch_history()).to_json()
                self.assertIn("EVENT_TYPE_TIMER_STARTED", history)
                self.assertIn("workspace_expire_realtime_freshness_activity", history)

    async def test_restart_equivalent_cache_eviction_replays_gate_without_rescheduling_stage(self):
        repository = InMemoryWorkspaceRepository()
        runtime = RecordingGuidedRuntime()
        async with await WorkflowEnvironment.start_time_skipping() as environment:
            queue = "guided-v3-temporal-restart"
            activities = workspace_activities(repository, runtime)
            async with Worker(
                environment.client, task_queue=queue,
                workflows=[IncidentWorkspaceTemporalWorkflow], activities=activities,
                # Every workflow task reconstructs state from server history,
                # which exercises the same deterministic replay boundary a
                # replacement worker uses after restart.
                max_cached_workflows=0,
            ):
                handle = await environment.client.start_workflow(
                    IncidentWorkspaceTemporalWorkflow.run,
                    workflow_request().dict(), id="guided-v3-temporal-restart", task_queue=queue,
                )
                await handle.execute_update("await_workspace_projection")
                invocation = temporal_command(runtime.projection, "restart-next")
                first = await handle.execute_update("workflow_command_v3", invocation.dict())
                self.assertFalse(first["reused"])
                self.assertEqual(1, len(runtime.stage_packets))
                replay = await handle.execute_update("workflow_command_v3", invocation.dict())
                self.assertTrue(replay["reused"])
                self.assertEqual(1, len(runtime.stage_packets))


if __name__ == "__main__":
    unittest.main()

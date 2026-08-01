"""Focused stage-domain tests for the guided V3 activity dispatcher."""

import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path

from flowpulse_cp.models import EvidenceAuthority, FreshnessStatus
from flowpulse_cp.realtime_activities import RealtimeActivityDispatcher
from flowpulse_cp.realtime_adapters import ConfiguredOtelSpoolConnector
from flowpulse_cp.realtime_models import (
    AgentWorkspace,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorRegistration,
    ConnectorTruthLabel,
    ConfiguredBindingTemplate,
    IncidentClock,
    IncidentClockState,
    IncidentProjectionV2,
    MetricPointV3,
    MetricSeriesV3,
    MetricSeriesCollectionV3,
    MetricThresholdV3,
    RealtimeCitation,
    RealtimeSignal,
    RealtimeSignalStatus,
    RealtimeTrend,
    RealtimeCommitActivityPacket,
    RealtimeUpdateCommand,
)
from flowpulse_cp.realtime_repository import InMemoryRealtimeRepository
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphEdge,
    IncidentGraphNode,
    IncidentLifecycleStage,
    IncidentRunBinding,
    ProjectionState,
    IncidentProjection,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_v3_guided import GuidedWorkflowCoordinatorV3
from flowpulse_cp.workspace_v3_models import (
    ActionApprovalCommandV3,
    ActionApprovalDecisionV3,
    ActionRollbackReceiptV3,
    AgentRunCommandV3,
    EvidenceQueryNameV3,
    EvidenceQueryResultV3,
    EvidenceQueryStateV3,
    GuidedActionBridgeResponseV3,
    GuidedActionPreflightResponseV3,
    GuidedAgentBridgeResponseV3,
    GuidedStageActivityOutcomeV3,
    GuidedStageActivityStatusV3,
    IncidentProjectionV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowRerunCommandV3,
    WorkflowStageStateV3,
    WorkflowStageV3,
)
from flowpulse_cp.workspace_v3_runtime import (
    GuidedRuntimeBridgeUnavailable,
    GuidedWorkflowActivityDispatcherV3,
)
from flowpulse_cp.policy import PolicyViolation


def stable_id(prefix, *parts):
    material = ":".join(str(part) for part in parts)
    return "{}-{}".format(
        prefix, sha256(material.encode("utf-8")).hexdigest()[:24],
    )


def source_projection(now):
    binding = IncidentRunBinding(
        tenant_id="tenant-a",
        incident_id="incident-a",
        run_id="run-a",
        topology_revision="topology-a",
        case_id="case-a",
        case_revision=1,
        workflow_id="workspace-a",
        workflow_run_id="temporal-a",
        created_at=now,
    )
    graph = IncidentGraph(
        nodes=[
            IncidentGraphNode(
                component_id="checkout",
                canonical_identity="service:checkout",
                display_name="Checkout",
                membership=GraphMembership.CONNECTED,
                runtime_status="critical",
                impact_status="impacted",
            ),
            IncidentGraphNode(
                component_id="payment",
                canonical_identity="service:payment",
                display_name="Payment",
                membership=GraphMembership.CONNECTED,
                runtime_status="degraded",
                impact_status="impacted",
            ),
        ],
        edges=[IncidentGraphEdge(
            edge_id="checkout-payment",
            source_component_id="checkout",
            target_component_id="payment",
            status="critical",
        )],
    )
    clock = IncidentClock(
        state=IncidentClockState.RUNNING,
        started_at=now - timedelta(minutes=4),
        last_signal_at=now,
        as_of=now,
        elapsed_seconds=240,
        freshness=FreshnessStatus.CURRENT,
        fresh_until=now + timedelta(minutes=5),
        max_interpolation_seconds=30,
    )
    health = ConnectorHealth(
        connector_id="connector-otel-primary",
        tenant_id="tenant-a",
        provider=ConnectorProvider.OTEL,
        state=ConnectorHealthState.CONNECTED,
        checked_at=now,
        last_success_at=now,
        last_event_observed_at=now,
        fresh_until=now + timedelta(minutes=5),
        cursor="3",
        consecutive_failures=0,
        lag_seconds=0,
        adapter_version="otel-spool.v1",
        health_revision=1,
        truth_label=ConnectorTruthLabel.LIVE,
    )
    signal = RealtimeSignal(
        signal_id="signal-edge-failure",
        source_event_id="source-edge-failure",
        provider=ConnectorProvider.OTEL,
        source_label="OTel",
        signal_kind="TRACE_STATUS",
        title="Checkout to Payment dependency failure",
        display_value="failed",
        status=RealtimeSignalStatus.CRITICAL,
        trend=RealtimeTrend.RISING,
        component_ids=["checkout", "payment"],
        edge_ids=["checkout-payment"],
        observed_at=now,
        fresh_until=now + timedelta(minutes=5),
        freshness=FreshnessStatus.CURRENT,
        authority=EvidenceAuthority.T0,
        evidence_refs=["evidence-a", "evidence-b"],
        citation_refs=["citation-a"],
        connector_state=ConnectorHealthState.CONNECTED,
        sequence=1,
    )
    prior_signal = signal.copy(update={
        "signal_id": "signal-edge-failure-prior",
        "source_event_id": "source-edge-failure-prior",
        "observed_at": now - timedelta(seconds=2),
        "evidence_refs": ["evidence-c", "evidence-d"],
        "sequence": 2,
    })
    metric_signals = [
        signal.copy(update={
            "signal_id": "signal-error-rate",
            "source_event_id": "source-error-rate",
            "signal_kind": "CHECKOUT_PAYMENT_ERROR_RATE",
            "title": "Checkout to Payment error rate",
            "display_value": "0.83 ratio",
            "component_ids": ["checkout"],
            "edge_ids": [],
            "evidence_refs": ["evidence-metric-error-rate"],
            "sequence": 3,
        }),
        signal.copy(update={
            "signal_id": "signal-mean-latency",
            "source_event_id": "source-mean-latency",
            "signal_kind": "CHECKOUT_PAYMENT_MEAN_LATENCY",
            "title": "Checkout to Payment mean latency",
            "display_value": "742 ms",
            "status": RealtimeSignalStatus.WARNING,
            "component_ids": ["checkout"],
            "edge_ids": [],
            "evidence_refs": ["evidence-metric-mean-latency"],
            "sequence": 4,
        }),
        signal.copy(update={
            "signal_id": "signal-request-count",
            "source_event_id": "source-request-count",
            "signal_kind": "CHECKOUT_PAYMENT_REQUEST_COUNT",
            "title": "Checkout to Payment request count",
            "display_value": "31 requests",
            "status": RealtimeSignalStatus.INFO,
            "trend": RealtimeTrend.STABLE,
            "component_ids": ["checkout"],
            "edge_ids": [],
            "evidence_refs": ["evidence-metric-request-count"],
            "sequence": 5,
        }),
    ]
    citation = RealtimeCitation(
        citation_id="citation-a",
        provider=ConnectorProvider.OTEL,
        evidence_id="evidence-a",
        source_event_id="source-edge-failure",
        label="Checkout to Payment dependency failure",
        observed_at=now,
        freshness=FreshnessStatus.CURRENT,
        safe_detail_path="/v2/incidents/case-a/evidence/evidence-a",
    )
    return IncidentProjectionV2(
        **binding.dict(),
        projection_revision=3,
        sequence=9,
        lifecycle_state=ProjectionState.ACTIVE,
        lifecycle_stage=IncidentLifecycleStage.INVESTIGATE,
        status="critical",
        operator_title="Checkout cannot reach Payment",
        operator_summary="Checkout requests fail at the Payment dependency.",
        generated_at=now,
        graph=graph,
        impacted_path=["checkout", "payment"],
        evidence_revision=3,
        gate_revision=1,
        action_revision=1,
        evidence_refs=[
            "evidence-a", "evidence-b", "evidence-c", "evidence-d",
            "evidence-metric-error-rate", "evidence-metric-mean-latency",
            "evidence-metric-request-count",
        ],
        source_revision=3,
        connector_revision=1,
        incident_clock=clock,
        connector_health=[health],
        realtime_signals=[prior_signal, signal, *metric_signals],
        active_graph_pulses=[],
        agent_workspace=AgentWorkspace(
            workspace_revision=1,
            activities=[],
            citations=[citation],
        ),
    )


class RuntimeRepository(InMemoryWorkspaceRepository):
    def __init__(self, source):
        super().__init__()
        self.source = source
        self.series_collection = MetricSeriesCollectionV3(
            case_id=source.case_id,
            signal_revision=source.source_revision,
            generated_at=source.generated_at,
            series=[],
        )
        self.race_on_terminal = False
        self.raced = False
        self.inject_investigation_refresh_evidence = False
        self.investigation_projection_reads = 0
        self.realtime_source_events = {}

    async def realtime_projection(self, tenant_id, case_id):
        if (tenant_id, case_id) != ("tenant-a", "case-a"):
            return None
        records = self.workflow_projections_v3.get((tenant_id, case_id), [])
        investigating = bool(
            records
            and records[-1].current_attempt.current_stage == WorkflowStageV3.INVESTIGATE
        )
        if self.inject_investigation_refresh_evidence and investigating:
            self.investigation_projection_reads += 1
            if self.investigation_projection_reads >= 2:
                observed_at = datetime.now(timezone.utc)
                new_signal = self.source.realtime_signals[1].copy(update={
                    "signal_id": "signal-refresh-evidence",
                    "source_event_id": "source-refresh-evidence",
                    "observed_at": observed_at,
                    "fresh_until": observed_at + timedelta(minutes=5),
                    "evidence_refs": ["evidence-refresh-new"],
                    "sequence": 3,
                })
                return IncidentProjectionV2.parse_obj({
                    **self.source.dict(),
                    "evidence_refs": [
                        *self.source.evidence_refs, "evidence-refresh-new",
                    ],
                    "realtime_signals": [
                        *self.source.realtime_signals, new_signal,
                    ],
                })
        return self.source

    async def realtime_series(self, tenant_id, case_id):
        return self.series_collection

    async def realtime_source_event(self, tenant_id, source_event_id):
        return self.realtime_source_events.get((tenant_id, source_event_id))

    async def recent_source_events_for_binding(
        self, tenant_id, binding_id, limit=2,
    ):
        values = [
            item for (item_tenant, _), item in self.realtime_source_events.items()
            if item_tenant == tenant_id and item.binding_id == binding_id
        ]
        return sorted(
            values, key=lambda item: item.observed_at, reverse=True,
        )[:limit]

    async def commit_workspace_transition_v3(self, commit):
        if (
            self.race_on_terminal
            and not self.raced
            and commit.idempotency_key.startswith("internal-stage-terminal:")
        ):
            self.raced = True
            records = self.workflow_projections_v3[(commit.tenant_id, commit.case_id)]
            current = records[-1]
            records.append(IncidentProjectionV3.parse_obj({
                **current.dict(),
                "projection_revision": current.projection_revision + 1,
                "sequence": current.sequence + 1,
                "generated_at": self.source.generated_at,
            }))
        return await super().commit_workspace_transition_v3(commit)


class RuntimeBridge:
    def __init__(self, now, *, tool_requests=None, execution_failures=0):
        self.now = now
        self.tool_requests = tool_requests or []
        self.agent_calls = []
        self.preflight_calls = []
        self.execution_calls = []
        self.execution_failures = execution_failures
        self.rollback_calls = []

    async def run_agent(self, request):
        self.agent_calls.append(request)
        return GuidedAgentBridgeResponseV3(
            request_id=request.request_id,
            provider="codex-cli",
            model="test-model",
            answer="Untrusted explanatory prose from {}.".format(request.role),
            evidence_refs=request.evidence_refs,
            tool_requests=self.tool_requests,
        )

    async def preflight_action(self, request):
        self.preflight_calls.append(request)
        return GuidedActionPreflightResponseV3(
            request_id=request.request_id,
            receipt_id="preflight-receipt-a",
            command_id=request.command_id,
            target_component_id=request.target_component_id,
            flag_name="paymentUnreachable",
            expected_variant="on",
            observed_variant="on",
            mutation_targets=["flag:paymentUnreachable", "container:checkout"],
            blast_radius="Local Astronomy Shop Checkout container only",
            manifest_hash="manifest-hash-a",
            rollback_supported=False,
            passed=True,
            summary="Exact flag state and allowlisted mutation manifest validated.",
            checked_at=self.now,
        )

    async def execute_action(self, request):
        self.execution_calls.append(request)
        if self.execution_failures:
            self.execution_failures -= 1
            raise RuntimeError("injected_executor_failure")
        return GuidedActionBridgeResponseV3(
            execution_key=request.execution_key,
            command_id=request.command_id,
            reused=False,
            started_at=self.now,
            completed_at=self.now + timedelta(seconds=1),
            output_summary="Fault disabled and Checkout recreated.",
            before="paymentUnreachable=on",
            after="paymentUnreachable=off",
        )

    async def rollback_action(self, request):
        self.rollback_calls.append(request)
        raise RuntimeError("safe_rollback_port_unavailable")


class BlockingAgentBridge(RuntimeBridge):
    def __init__(self, now):
        super().__init__(now)
        self.agent_started = asyncio.Event()
        self.release_agent = asyncio.Event()

    async def run_agent(self, request):
        self.agent_calls.append(request)
        self.agent_started.set()
        await self.release_agent.wait()
        return GuidedAgentBridgeResponseV3(
            request_id=request.request_id,
            provider="codex-cli",
            model="test-model",
            answer="Late response from the superseded stage run.",
            evidence_refs=request.evidence_refs,
            tool_requests=[],
        )


class LostAgentResponseBridge(RuntimeBridge):
    def __init__(self, now):
        super().__init__(now)
        self.lose_first_response = True

    async def run_agent(self, request):
        self.agent_calls.append(request)
        if self.lose_first_response:
            self.lose_first_response = False
            raise GuidedRuntimeBridgeUnavailable("injected_lost_agent_response")
        return GuidedAgentBridgeResponseV3(
            request_id=request.request_id,
            provider="codex-cli",
            model="test-model",
            answer="Recovered the exact frozen agent response.",
            evidence_refs=request.evidence_refs,
            tool_requests=[],
        )


class GuidedStageRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = datetime.now(timezone.utc)
        self.source = source_projection(self.now)
        self.repository = RuntimeRepository(self.source)
        self.coordinator = GuidedWorkflowCoordinatorV3(self.repository)
        self.detect = await self.coordinator.bootstrap(
            self.source, actor_subject_id="subject-a", now=self.now,
        )

    def command(self, projection, key):
        return WorkflowCommandV3(
            attempt_id=projection.current_attempt.attempt_id,
            expected_stage=projection.current_attempt.current_stage,
            expected_workflow_revision=projection.workflow_revision,
            idempotency_key=key,
        )

    async def advance(self, projection, key):
        return (await self.coordinator.advance(
            "tenant-a", "case-a", self.command(projection, key),
            "subject-a", self.now,
        )).projection

    async def run_current(self, dispatcher, projection, *, verification_deadline_reached=False):
        current = projection.current_attempt.stage_runs[-1]
        return GuidedStageActivityOutcomeV3.parse_obj(await dispatcher.run_stage({
            "tenant_id": projection.tenant_id,
            "case_id": projection.case_id,
            "attempt_id": projection.current_attempt.attempt_id,
            "stage_run_id": current.stage_run_id,
            "stage": current.stage,
            "expected_workflow_revision": projection.workflow_revision,
            "actor_subject_id": "subject-a",
            "verification_deadline_reached": verification_deadline_reached,
        }, now=self.now))

    async def reach_respond(self, dispatcher):
        projection = self.detect
        for stage in (
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        ):
            projection = await self.advance(
                projection, "reach-runtime-{}".format(stage.value.lower()),
            )
            outcome = await self.run_current(dispatcher, projection)
            self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
            projection = outcome.projection
        projection = await self.advance(projection, "reach-runtime-respond")
        outcome = await self.run_current(dispatcher, projection)
        self.assertEqual(GuidedStageActivityStatusV3.AWAITING_APPROVAL, outcome.status)
        return outcome.projection

    async def approve_current_action(self, projection, action_id, key):
        return (await self.coordinator.approve_action(
            "tenant-a", "case-a", action_id,
            ActionApprovalCommandV3(
                attempt_id=projection.current_attempt.attempt_id,
                expected_stage=projection.current_attempt.current_stage,
                expected_workflow_revision=projection.workflow_revision,
                idempotency_key=key,
                decision=ActionApprovalDecisionV3.APPROVE,
                expected_decision_revision=projection.decision_revision,
            ),
            "subject-a", ["owner"], self.now,
        )).projection

    async def execute_current_action(self, dispatcher, projection, action_id):
        current = projection.current_attempt.stage_runs[-1]
        return GuidedStageActivityOutcomeV3.parse_obj(await dispatcher.execute_action({
            "tenant_id": projection.tenant_id,
            "case_id": projection.case_id,
            "attempt_id": projection.current_attempt.attempt_id,
            "stage_run_id": current.stage_run_id,
            "action_id": action_id,
            "expected_workflow_revision": projection.workflow_revision,
            "actor_subject_id": "subject-a",
        }, now=self.now))

    async def test_stage_result_rebases_over_realtime_projection_race_without_reinvoking_agent(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-race")
        self.repository.race_on_terminal = True

        outcome = await self.run_current(dispatcher, triage)

        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
        self.assertTrue(self.repository.raced)
        self.assertEqual(1, len(bridge.agent_calls))
        self.assertEqual(4, len(bridge.agent_calls[0].evidence_facts))
        self.assertTrue(all(
            item.observed_at is not None
            and item.component_ids
            and item.evidence_refs
            for item in bridge.agent_calls[0].evidence_facts
        ))
        output = outcome.projection.current_attempt.stage_runs[-1].output
        self.assertTrue(output.questions)
        self.assertFalse(any("Untrusted explanatory prose" in fact.value for fact in output.facts))

    async def test_lost_agent_response_reuses_frozen_context_after_realtime_churn(self):
        bridge = LostAgentResponseBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-frozen-agent-context")

        with self.assertRaisesRegex(
            GuidedRuntimeBridgeUnavailable, "injected_lost_agent_response",
        ):
            await self.run_current(dispatcher, triage)
        frozen = bridge.agent_calls[0]
        self.assertIsNotNone(frozen)

        changed_signal = self.source.realtime_signals[-1].copy(update={
            "signal_id": "signal-arrived-after-agent-start",
            "source_event_id": "source-arrived-after-agent-start",
            "observed_at": self.now + timedelta(seconds=2),
            "evidence_refs": ["evidence-late-a", "evidence-late-b"],
            "sequence": 3,
        })
        self.repository.source = IncidentProjectionV2.parse_obj({
            **self.source.dict(),
            "projection_revision": self.source.projection_revision + 1,
            "sequence": self.source.sequence + 1,
            "source_revision": self.source.source_revision + 1,
            "evidence_refs": [
                *self.source.evidence_refs,
                *changed_signal.evidence_refs,
            ],
            "realtime_signals": [*self.source.realtime_signals, changed_signal],
        })

        outcome = await self.run_current(dispatcher, triage)
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
        self.assertEqual(2, len(bridge.agent_calls))
        self.assertEqual(frozen, bridge.agent_calls[1])
        persisted = next(
            item for item in outcome.projection.agent_activity
            if item.bridge_request == frozen
        )
        self.assertEqual(frozen, persisted.bridge_request)

    async def test_manual_graph_agent_keeps_clicked_component_and_distinct_request_identity(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-before-manual-agent")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(triage, "next-investigate-manual-agent")
        manual = await self.coordinator.start_agent_run(
            "tenant-a",
            "case-a",
            AgentRunCommandV3(
                attempt_id=investigate.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.INVESTIGATE,
                expected_workflow_revision=investigate.workflow_revision,
                idempotency_key="manual-agent-payment-node",
                component_id="payment",
                question="Investigate the clicked Payment node.",
            ),
            "subject-a",
            self.now,
        )
        manual_agent = manual.projection.agent_activity[-1]
        packet = {
            "tenant_id": "tenant-a",
            "case_id": "case-a",
            "attempt_id": manual.projection.current_attempt.attempt_id,
            "stage_run_id": manual.projection.current_attempt.stage_runs[-1].stage_run_id,
            "agent_run_id": manual_agent.agent_run_id,
            "expected_workflow_revision": manual.projection.workflow_revision,
            "actor_subject_id": "subject-a",
        }
        manual_outcome = GuidedStageActivityOutcomeV3.parse_obj(
            await dispatcher.run_existing_agent(packet, now=self.now),
        )
        manual_request = bridge.agent_calls[-1]
        self.assertEqual("payment", manual_request.selected_component)
        self.assertEqual(
            stable_id(
                "agent-bridge",
                "case-a",
                manual.projection.current_attempt.stage_runs[-1].stage_run_id,
                manual_agent.agent_run_id,
            ),
            manual_request.request_id,
        )

        repeated = GuidedStageActivityOutcomeV3.parse_obj(
            await dispatcher.run_existing_agent(packet, now=self.now),
        )
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, repeated.status)
        self.assertEqual(2, len(bridge.agent_calls))  # triage + one manual call

        investigated = await self.run_current(dispatcher, manual_outcome.projection)
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, investigated.status)
        automatic = next(
            item for item in bridge.agent_calls
            if item.role == "investigator" and item.request_id != manual_request.request_id
        )
        self.assertEqual("checkout", automatic.selected_component)
        self.assertNotEqual(manual_request.request_id, automatic.request_id)

    async def test_escalate_retry_makes_late_agent_response_a_noop_for_new_stage_run(self):
        bridge = BlockingAgentBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-late-agent")
        old_stage_run_id = triage.current_attempt.stage_runs[-1].stage_run_id
        old_activity = asyncio.create_task(self.run_current(dispatcher, triage))
        await asyncio.wait_for(bridge.agent_started.wait(), timeout=2)

        running = await self.repository.workspace_projection_v3("tenant-a", "case-a")
        escalation = await self.coordinator.escalate(
            "tenant-a", "case-a",
            WorkflowEscalationCommandV3(
                attempt_id=running.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.TRIAGE,
                expected_workflow_revision=running.workflow_revision,
                idempotency_key="escalate-pending-agent",
                reason="Operator needs to retry with additional evidence.",
            ),
            "subject-a", self.now + timedelta(seconds=1),
        )
        stopped_agent = next(
            item for item in escalation.projection.agent_activity
            if item.stage_run_id == old_stage_run_id
        )
        self.assertEqual("NEEDS_HUMAN", stopped_agent.state.value)

        retry = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.TRIAGE,
            WorkflowRerunCommandV3(
                attempt_id=escalation.projection.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.TRIAGE,
                expected_workflow_revision=escalation.projection.workflow_revision,
                idempotency_key="retry-after-pending-agent",
                reason="Retry after the operator supplied evidence.",
            ),
            "subject-a", self.now + timedelta(seconds=2),
        )
        new_stage_run_id = retry.projection.current_attempt.stage_runs[-1].stage_run_id
        self.assertNotEqual(old_stage_run_id, new_stage_run_id)

        bridge.release_agent.set()
        late_outcome = await asyncio.wait_for(old_activity, timeout=2)
        self.assertEqual(GuidedStageActivityStatusV3.WAITING, late_outcome.status)
        self.assertEqual("workflow_v3_stage_run_superseded", late_outcome.reason)
        canonical = await self.repository.workspace_projection_v3("tenant-a", "case-a")
        current = canonical.current_attempt.stage_runs[-1]
        self.assertEqual(new_stage_run_id, current.stage_run_id)
        self.assertEqual(WorkflowStageStateV3.RUNNING, current.status)
        self.assertIsNone(current.output)
        self.assertFalse(any(
            item.stage_run_id == new_stage_run_id
            for item in canonical.agent_activity
        ))
        superseded = next(
            item for item in canonical.current_attempt.stage_runs
            if item.stage_run_id == old_stage_run_id
        )
        self.assertEqual(WorkflowStageStateV3.SUPERSEDED, superseded.status)

    async def test_unexecuted_agent_tool_request_fails_closed_without_publishing_stage_output(self):
        bridge = RuntimeBridge(self.now, tool_requests=[{"name": "query-prometheus"}])
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-tool-request")

        outcome = await self.run_current(dispatcher, triage)

        self.assertEqual(GuidedStageActivityStatusV3.FAILED, outcome.status)
        run = outcome.projection.current_attempt.stage_runs[-1]
        self.assertEqual(WorkflowStageStateV3.FAILED, run.status)
        self.assertIsNone(run.output)
        self.assertEqual("FAILED", outcome.projection.agent_activity[-1].state.value)

    async def test_investigate_publishes_canonical_hypothesis_and_distinct_critic_then_decide_preflights(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(triage, "next-investigate")

        investigated = await self.run_current(dispatcher, investigate)

        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, investigated.status)
        roles = {
            item.role for item in investigated.projection.agent_activity
            if item.stage == WorkflowStageV3.INVESTIGATE
        }
        self.assertEqual({"EVIDENCE_WORKER", "INVESTIGATOR", "CRITIC"}, roles)
        query_results = [
            item for item in investigated.projection.evidence_queries
            if item.stage_run_id == investigate.current_attempt.stage_runs[-1].stage_run_id
        ]
        self.assertEqual(2, len(query_results))
        self.assertTrue(all(
            item.state == EvidenceQueryStateV3.SUCCEEDED
            for item in query_results
        ))
        self.assertEqual(
            0,
            investigated.projection.current_attempt.stage_runs[-1].replan_count,
        )
        event_types = [
            item.event_type.value
            for item in await self.repository.workspace_events_v3_after(
                "tenant-a", "case-a", 0,
            )
        ]
        self.assertEqual(2, event_types.count("evidence.query.started"))
        self.assertEqual(2, event_types.count("evidence.query.completed"))
        hypothesis = investigated.projection.hypotheses[-1]
        self.assertTrue(hypothesis.supporting_evidence_refs)
        self.assertTrue(hypothesis.falsification_condition)
        self.assertEqual("checkout-payment", self.source.realtime_signals[0].edge_ids[0])
        investigator_context = next(
            item for item in bridge.agent_calls if item.role == "investigator"
        )
        critic_context = next(
            item for item in bridge.agent_calls if item.role == "critic"
        )
        self.assertTrue(investigator_context.query_outcomes)
        self.assertTrue(critic_context.query_outcomes)
        self.assertTrue(critic_context.hypotheses)
        self.assertTrue(critic_context.hypotheses[0].supporting_evidence_refs)

        decide = await self.advance(investigated.projection, "next-decide")
        decided = await self.run_current(dispatcher, decide)
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, decided.status)
        self.assertEqual(1, len(bridge.preflight_calls))
        output = decided.projection.current_attempt.stage_runs[-1].output
        self.assertEqual("PASSED", output.action_candidate.dry_run_state.value)
        self.assertEqual(decided.projection.decision_revision, output.action_candidate.decision_revision)
        self.assertEqual(output.premise_fingerprint, decided.projection.current_premise_fingerprint)

    async def test_actual_failed_payment_client_spans_pass_investigate_edge_gate(self):
        """The real paymentUnreachable OTLP shape proves the canonical edge."""
        realtime = InMemoryRealtimeRepository()
        registration = ConnectorRegistration(
            connector_id="connector-otel-primary",
            tenant_id="tenant-a",
            provider=ConnectorProvider.OTEL,
            adapter_version="otel-jsonl-spool.v3",
            data_classes=["TRACE"],
            capabilities=["TRACES"],
            freshness_sla_seconds=30,
            enabled=True,
            truth_label=ConnectorTruthLabel.LIVE,
        )
        await realtime.register_connector(registration)
        prior = IncidentProjection.parse_obj({
            field: getattr(self.source, field)
            for field in IncidentProjection.__fields__
            if field != "schema_version"
        })
        template = ConfiguredBindingTemplate(
            binding_key="astronomy-checkout-payment-traces",
            external_resource_type="otel_trace_edge",
            external_resource_id="astronomy.checkout-payment",
            component_ids=["checkout", "payment"],
            edge_ids=["checkout-payment"],
        )
        await realtime.append_binding(template.materialize(
            registration, prior, valid_from=prior.created_at,
        ))

        class Store:
            def put(_, tenant_id, raw):
                return "{}/sha256/{}".format(tenant_id, sha256(raw).hexdigest())

        def otlp_failed_client(trace_id, observed_at):
            end_ns = int(observed_at.timestamp() * 1_000_000_000)
            return {
                "resourceSpans": [{
                    "resource": {"attributes": [{
                        "key": "service.name",
                        "value": {"stringValue": "checkout"},
                    }]},
                    "scopeSpans": [{
                        "scope": {"name": "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"},
                        "spans": [{
                            "traceId": trace_id,
                            "spanId": "client-" + trace_id,
                            "parentSpanId": "checkout-parent-" + trace_id,
                            "name": "oteldemo.PaymentService/Charge",
                            "startTimeUnixNano": str(end_ns - 850_000_000),
                            "endTimeUnixNano": str(end_ns),
                            "status": {
                                "code": 2,
                                "message": "name resolver error: produced zero addresses",
                            },
                        }],
                    }],
                }],
            }

        commit_dispatcher = RealtimeActivityDispatcher(realtime, {})
        prior_realtime = None
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "traces.jsonl"
            connector = ConfiguredOtelSpoolConnector(
                registration=registration,
                spool_path=path,
                external_resource_id="astronomy.checkout-payment",
                artifact_store=Store(),
                repository=realtime,
            )
            commits = []
            for index in range(2):
                observed_at = self.now + timedelta(seconds=index * 2)
                with path.open("a") as stream:
                    stream.write(json.dumps(otlp_failed_client(
                        "trace-real-failure-{}".format(index), observed_at,
                    )) + "\n")
                result = await connector.poll(
                    prior,
                    acl_subjects=["subject-a"],
                    now=observed_at + timedelta(seconds=1),
                )
                self.assertTrue(result.accepted)
                self.assertEqual(
                    ["checkout-payment"], result.source_event.edge_ids,
                )
                command = RealtimeUpdateCommand(
                    tenant_id=prior.tenant_id,
                    actor_subject_id="subject-a",
                    case_id=prior.case_id,
                    incident_id=prior.incident_id,
                    run_id=prior.run_id,
                    topology_revision=prior.topology_revision,
                    connector_id=registration.connector_id,
                    source_event_id=result.source_event.source_event_id,
                    dispatch_id=result.dispatch.dispatch_id,
                    idempotency_key="real-otel-{}".format(index),
                )
                commit = commit_dispatcher._build_commit(
                    RealtimeCommitActivityPacket(
                        command=command,
                        projection=prior,
                        prior_realtime_projection=prior_realtime,
                        first_event_sequence=prior.sequence + 1,
                        poll_result=result,
                    ),
                )
                self.assertIsNotNone(commit.pulse)
                self.assertEqual(["checkout-payment"], commit.signal.edge_ids)
                commits.append(commit)
                prior = commit.v1_projection
                prior_realtime = commit.projection

        self.repository.source = commits[-1].projection
        self.repository.realtime_source_events = dict(realtime.source_events)
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-real-otel")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(
            triage, "next-investigate-real-otel",
        )
        outcome = await self.run_current(dispatcher, investigate)

        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
        hypothesis = outcome.projection.hypotheses[-1]
        self.assertEqual(2, len(hypothesis.supporting_evidence_refs))
        self.assertIn("checkout -> payment", hypothesis.statement)

    async def test_evidence_query_result_is_immutable_and_only_one_new_evidence_replan_is_allowed(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-query-budget")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(triage, "next-investigate-query-budget")
        worker_receipt = await self.coordinator.start_agent_run(
            "tenant-a", "case-a",
            AgentRunCommandV3(
                attempt_id=investigate.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.INVESTIGATE,
                expected_workflow_revision=investigate.workflow_revision,
                idempotency_key="evidence-worker-budget-test",
                component_id="checkout",
                question="Execute the allowlisted evidence query.",
            ),
            "subject-a", self.now, role_override="EVIDENCE_WORKER",
        )
        projection = worker_receipt.projection
        worker = projection.agent_activity[-1]
        current = projection.current_attempt.stage_runs[-1]

        async def start_query(query_id, started_at):
            return await self.coordinator.record_evidence_query(
                "tenant-a", "case-a",
                EvidenceQueryResultV3(
                    query_id=query_id,
                    attempt_id=projection.current_attempt.attempt_id,
                    stage_run_id=current.stage_run_id,
                    stage=WorkflowStageV3.INVESTIGATE,
                    worker_activity_id=worker.activity_id,
                    query_name=EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS,
                    state=EvidenceQueryStateV3.RUNNING,
                    parameters_hash="parameters-hash-a",
                    result_summary="Allowlisted query started.",
                    started_at=started_at,
                ),
                now=started_at,
            )

        async def finish_query(
            query_id, started_at, evidence_refs, *, triggered_replan,
        ):
            return await self.coordinator.record_evidence_query(
                "tenant-a", "case-a",
                EvidenceQueryResultV3(
                    query_id=query_id,
                    attempt_id=projection.current_attempt.attempt_id,
                    stage_run_id=current.stage_run_id,
                    stage=WorkflowStageV3.INVESTIGATE,
                    worker_activity_id=worker.activity_id,
                    query_name=EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS,
                    state=EvidenceQueryStateV3.SUCCEEDED,
                    parameters_hash="parameters-hash-a",
                    result_summary="Allowlisted query completed.",
                    evidence_refs=evidence_refs,
                    observation_timestamps=[
                        started_at - timedelta(seconds=index)
                        for index in range(len(evidence_refs))
                    ],
                    triggered_replan=triggered_replan,
                    started_at=started_at,
                    completed_at=started_at + timedelta(milliseconds=1),
                ),
                now=started_at + timedelta(milliseconds=1),
            )

        first_started = self.now + timedelta(seconds=1)
        projection = await start_query("query-initial", first_started)
        projection = await finish_query(
            "query-initial", first_started, ["evidence-a"],
            triggered_replan=False,
        )
        refresh_started = self.now + timedelta(seconds=2)
        projection = await start_query("query-refresh", refresh_started)
        projection = await finish_query(
            "query-refresh", refresh_started,
            ["evidence-a", "evidence-new"], triggered_replan=True,
        )
        self.assertEqual(1, projection.current_attempt.stage_runs[-1].replan_count)
        terminal = projection.evidence_queries[-1]
        with self.assertRaisesRegex(
            PolicyViolation, "workflow_v3_evidence_query_result_immutable",
        ):
            await self.coordinator.record_evidence_query(
                "tenant-a", "case-a",
                EvidenceQueryResultV3.parse_obj({
                    **terminal.dict(),
                    "result_summary": "Attempted mutation.",
                }),
                now=self.now + timedelta(seconds=3),
            )

        exhausted_started = self.now + timedelta(seconds=4)
        projection = await start_query("query-refresh-two", exhausted_started)
        with self.assertRaisesRegex(
            PolicyViolation, "workflow_v3_evidence_replan_not_new_or_exhausted",
        ):
            await finish_query(
                "query-refresh-two", exhausted_started,
                ["evidence-a", "evidence-new", "evidence-newer"],
                triggered_replan=True,
            )

    async def test_investigate_runtime_replans_once_only_when_refresh_adds_evidence(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        triage = await self.advance(self.detect, "next-triage-runtime-replan")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(triage, "next-investigate-runtime-replan")
        self.repository.inject_investigation_refresh_evidence = True

        outcome = await self.run_current(dispatcher, investigate)

        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
        run = outcome.projection.current_attempt.stage_runs[-1]
        self.assertEqual(WorkflowStageV3.INVESTIGATE, run.stage)
        self.assertEqual(1, run.replan_count)
        refresh = next(
            item for item in outcome.projection.evidence_queries
            if item.triggered_replan
        )
        self.assertIn("evidence-refresh-new", refresh.evidence_refs)
        investigator_runs = [
            item for item in outcome.projection.agent_activity
            if item.stage_run_id == run.stage_run_id
            and item.role == "INVESTIGATOR"
        ]
        self.assertEqual(2, len(investigator_runs))
        self.assertTrue(all(
            item.state.value == "SUCCEEDED" for item in investigator_runs
        ))
        self.assertFalse(any(
            item.stage == WorkflowStageV3.DECIDE
            for item in outcome.projection.current_attempt.stage_runs
        ))

    async def test_investigate_accepts_newer_current_samples_after_agent_review(self):
        repository = self.repository

        class ChurningBridge(RuntimeBridge):
            async def run_agent(inner, request):
                response = await super().run_agent(request)
                if request.role == "critic":
                    observed_at = datetime.now(timezone.utc)
                    signals = [signal.copy(update={
                        "signal_id": "new-{}".format(signal.signal_id),
                        "source_event_id": "new-{}".format(signal.source_event_id),
                        "observed_at": observed_at,
                        "fresh_until": observed_at + timedelta(minutes=5),
                        "evidence_refs": ["new-{}".format(signal.evidence_refs[0])],
                    }) for signal in repository.source.realtime_signals]
                    repository.source = IncidentProjectionV2.parse_obj({
                        **repository.source.dict(),
                        "evidence_refs": [
                            ref for signal in signals for ref in signal.evidence_refs
                        ],
                        "realtime_signals": signals,
                    })
                return response

        dispatcher = GuidedWorkflowActivityDispatcherV3(
            repository, ChurningBridge(self.now),
        )
        triage = await self.advance(self.detect, "next-triage-live-churn")
        triage = (await self.run_current(dispatcher, triage)).projection
        investigate = await self.advance(triage, "next-investigate-live-churn")

        outcome = await self.run_current(dispatcher, investigate)

        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)

    async def test_respond_execution_failure_rerun_creates_fresh_action_and_approval(self):
        bridge = RuntimeBridge(self.now, execution_failures=1)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        respond = await self.reach_respond(dispatcher)
        first_action = next(
            item for item in respond.actions
            if item.stage_run_id == respond.current_attempt.stage_runs[-1].stage_run_id
        )
        approved = await self.approve_current_action(
            respond, first_action.action_id, "approve-first-action",
        )
        failed = await self.execute_current_action(
            dispatcher, approved, first_action.action_id,
        )
        self.assertEqual(GuidedStageActivityStatusV3.FAILED, failed.status)
        self.assertEqual(1, len(bridge.execution_calls))
        old_receipt = next(
            item.receipt for item in failed.projection.actions
            if item.action_id == first_action.action_id
        )
        self.assertEqual("FAILED", old_receipt.status.value)

        rerun_receipt = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.RESPOND,
            WorkflowRerunCommandV3(
                attempt_id=failed.projection.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.RESPOND,
                expected_workflow_revision=failed.projection.workflow_revision,
                idempotency_key="rerun-respond-after-failure",
                reason="Retry the still-valid decision with a fresh approval.",
            ), "subject-a", self.now,
        )
        proposed = await self.run_current(dispatcher, rerun_receipt.projection)
        self.assertEqual(GuidedStageActivityStatusV3.AWAITING_APPROVAL, proposed.status)
        current_run_id = proposed.projection.current_attempt.stage_runs[-1].stage_run_id
        second_action = next(
            item for item in proposed.projection.actions
            if item.stage_run_id == current_run_id
        )
        self.assertNotEqual(first_action.action_id, second_action.action_id)
        self.assertEqual("PENDING", second_action.approval_state.value)
        retained_old = next(
            item for item in proposed.projection.actions
            if item.action_id == first_action.action_id
        )
        self.assertEqual(old_receipt, retained_old.receipt)
        self.assertEqual(1, len(bridge.execution_calls))
        with self.assertRaisesRegex(
            PolicyViolation, "workflow_v3_action_approval_scope_mismatch",
        ):
            await self.coordinator.approve_action(
                "tenant-a", "case-a", first_action.action_id,
                ActionApprovalCommandV3(
                    attempt_id=proposed.projection.current_attempt.attempt_id,
                    expected_stage=WorkflowStageV3.RESPOND,
                    expected_workflow_revision=proposed.projection.workflow_revision,
                    idempotency_key="cannot-reapprove-old-action",
                    decision=ActionApprovalDecisionV3.APPROVE,
                    expected_decision_revision=proposed.projection.decision_revision,
                ), "subject-a", ["owner"], self.now,
            )

        approved_second = await self.approve_current_action(
            proposed.projection, second_action.action_id, "approve-second-action",
        )
        succeeded = await self.execute_current_action(
            dispatcher, approved_second, second_action.action_id,
        )
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, succeeded.status)
        self.assertEqual(2, len(bridge.execution_calls))

    async def test_verify_rollback_failure_is_terminal_and_cannot_retry_loop(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        respond = await self.reach_respond(dispatcher)
        action = next(
            item for item in respond.actions
            if item.stage_run_id == respond.current_attempt.stage_runs[-1].stage_run_id
        )
        approved = await self.approve_current_action(
            respond, action.action_id, "approve-for-verify-failure",
        )
        executed = await self.execute_current_action(
            dispatcher, approved, action.action_id,
        )
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, executed.status)
        verify = await self.advance(executed.projection, "next-verify-failure")
        current = verify.current_attempt.stage_runs[-1]
        outcome = GuidedStageActivityOutcomeV3.parse_obj(await dispatcher.run_stage({
            "tenant_id": verify.tenant_id,
            "case_id": verify.case_id,
            "attempt_id": verify.current_attempt.attempt_id,
            "stage_run_id": current.stage_run_id,
            "stage": WorkflowStageV3.VERIFY,
            "expected_workflow_revision": verify.workflow_revision,
            "actor_subject_id": "subject-a",
            "verification_deadline_reached": True,
        }, now=self.now))
        self.assertEqual(GuidedStageActivityStatusV3.NEEDS_HUMAN, outcome.status)
        self.assertEqual(1, len(bridge.rollback_calls))
        self.assertEqual(
            ["RERUN_FROM_STAGE"],
            [item.value for item in outcome.projection.available_commands],
        )
        self.assertEqual(
            ["INVESTIGATE", "DECIDE"],
            [item.value for item in outcome.projection.available_rerun_stages],
        )
        with self.assertRaisesRegex(
            PolicyViolation, "workflow_v3_current_stage_not_succeeded",
        ):
            await self.coordinator.advance(
                "tenant-a", "case-a",
                self.command(outcome.projection, "cannot-advance-verify-failure"),
                "subject-a", self.now,
            )
        with self.assertRaisesRegex(
            PolicyViolation,
            "workflow_v3_post_action_branch_requires_diagnostic_stage",
        ):
            await self.coordinator.rerun(
                "tenant-a", "case-a", WorkflowStageV3.VERIFY,
                WorkflowRerunCommandV3(
                    attempt_id=outcome.projection.current_attempt.attempt_id,
                    expected_stage=WorkflowStageV3.VERIFY,
                    expected_workflow_revision=outcome.projection.workflow_revision,
                    idempotency_key="cannot-rerun-verify",
                    reason="Do not loop a failed rollback.",
                ), "subject-a", self.now,
            )
        repeated = GuidedStageActivityOutcomeV3.parse_obj(await dispatcher.run_stage({
            "tenant_id": outcome.projection.tenant_id,
            "case_id": outcome.projection.case_id,
            "attempt_id": outcome.projection.current_attempt.attempt_id,
            "stage_run_id": outcome.projection.current_attempt.stage_runs[-1].stage_run_id,
            "stage": WorkflowStageV3.VERIFY,
            "expected_workflow_revision": outcome.projection.workflow_revision,
            "actor_subject_id": "subject-a",
            "verification_deadline_reached": True,
        }, now=self.now))
        self.assertEqual(GuidedStageActivityStatusV3.FAILED, repeated.status)
        self.assertEqual(1, len(bridge.rollback_calls))
        self.assertIn(
            "ROLLBACK_OUTCOME",
            [item.record_type.value for item in outcome.projection.audit_records],
        )

    async def test_verify_requires_three_healthy_error_latency_traffic_samples_and_builds_report(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        respond = await self.reach_respond(dispatcher)
        action = next(
            item for item in respond.actions
            if item.stage_run_id == respond.current_attempt.stage_runs[-1].stage_run_id
        )
        approved = await self.approve_current_action(
            respond, action.action_id, "approve-for-healthy-verify",
        )
        executed = await self.execute_current_action(
            dispatcher, approved, action.action_id,
        )
        receipt = next(
            item.receipt for item in executed.projection.actions
            if item.action_id == action.action_id
        )
        post_times = [
            receipt.completed_at + timedelta(seconds=offset)
            for offset in (2, 4, 6)
        ]
        healthy_signal = self.source.realtime_signals[0].copy(update={
            "signal_id": "signal-post-action-healthy",
            "source_event_id": "source-post-action-healthy",
            "display_value": "healthy",
            "status": RealtimeSignalStatus.INFO,
            "trend": RealtimeTrend.STABLE,
            "observed_at": post_times[-1],
            "fresh_until": post_times[-1] + timedelta(minutes=5),
            "evidence_refs": ["trace-post-action"],
            "sequence": 2,
        })
        self.repository.source = IncidentProjectionV2.parse_obj({
            **self.source.dict(),
            "projection_revision": 4,
            "sequence": 10,
            "source_revision": 4,
            "evidence_refs": ["evidence-a", "evidence-b", "trace-post-action"],
            "generated_at": post_times[-1],
            "incident_clock": self.source.incident_clock.copy(update={
                "last_signal_at": post_times[-1],
                "as_of": post_times[-1],
                "fresh_until": post_times[-1] + timedelta(minutes=5),
            }),
            "connector_health": [
                self.source.connector_health[0].copy(update={
                    "last_event_observed_at": post_times[-1],
                    "fresh_until": post_times[-1] + timedelta(minutes=5),
                }),
                self.source.connector_health[0].copy(update={
                    "connector_id": "connector-otel-metrics",
                    "last_event_observed_at": post_times[-1],
                    "fresh_until": post_times[-1] + timedelta(minutes=5),
                }),
            ],
            "realtime_signals": [healthy_signal],
        })

        def metric(
            series_id, metric_key, label, unit, pre_value, post_values,
            critical=None, connector_id="connector-otel-primary",
        ):
            points = [MetricPointV3(
                sequence=1,
                timestamp=receipt.completed_at - timedelta(seconds=2),
                interval_start_at=receipt.completed_at - timedelta(seconds=2),
                value=float(pre_value),
                evidence_refs=["evidence-pre-{}".format(series_id)],
                freshness=FreshnessStatus.CURRENT,
            )] + [MetricPointV3(
                sequence=index + 2,
                timestamp=timestamp,
                interval_start_at=(
                    receipt.completed_at
                    if index == 0 else post_times[index - 1]
                ),
                value=float(value),
                evidence_refs=["evidence-post-{}-{}".format(series_id, index)],
                freshness=FreshnessStatus.CURRENT,
            ) for index, (timestamp, value) in enumerate(zip(post_times, post_values))]
            return MetricSeriesV3(
                series_id=series_id,
                metric_key=metric_key,
                component_id="checkout",
                label=label,
                unit=unit,
                thresholds=MetricThresholdV3(
                    warning=(critical / 2.0 if critical is not None else None),
                    critical=critical,
                ),
                points=points,
                observed_window_start=points[0].timestamp,
                observed_window_end=points[-1].timestamp,
                freshness=FreshnessStatus.CURRENT,
                source_connector_id=connector_id,
            )

        self.repository.series_collection = MetricSeriesCollectionV3(
            case_id="case-a",
            signal_revision=4,
            generated_at=post_times[-1],
            series=[
                metric(
                    "error-checkout", "trace.error_indicator",
                    "Request error indicator", "ratio", 1.0,
                    [0.0, 0.0, 0.0], 0.05,
                ),
                metric(
                    "latency-checkout", "trace.edge.duration",
                    "Checkout to Payment latency", "s", 2.0,
                    [0.1, 0.09, 0.08], 1.0,
                ),
                metric(
                    "traffic-checkout", "trace.request_rate",
                    "Observed request rate", "requests/s", 0.1,
                    [0.5, 0.5, 0.5], None,
                ),
                metric(
                    "real-error-checkout", "checkout.payment.error_rate",
                    "Checkout payment error rate", "ratio", 0.95,
                    [0.01, 0.0, 0.0], 0.05,
                    "connector-otel-metrics",
                ),
                metric(
                    "real-latency-checkout", "checkout.payment.mean_latency",
                    "Checkout payment mean latency", "ms", 1700.0,
                    [100.0, 90.0, 80.0], 1500.0,
                    "connector-otel-metrics",
                ),
                metric(
                    "real-traffic-checkout", "checkout.payment.request_count",
                    "Checkout payment request count", "requests", 300.0,
                    [1.0, 2.0, 3.0], None,
                    "connector-otel-metrics",
                ),
            ],
        )
        verify = await self.advance(executed.projection, "next-healthy-verify")
        waiting = await self.run_current(dispatcher, verify)
        self.assertEqual(GuidedStageActivityStatusV3.WAITING, waiting.status)
        self.assertEqual(
            WorkflowStageStateV3.RUNNING,
            waiting.projection.current_attempt.stage_runs[-1].status,
        )
        outcome = await self.run_current(
            dispatcher, waiting.projection, verification_deadline_reached=True,
        )
        self.assertEqual(GuidedStageActivityStatusV3.SUCCEEDED, outcome.status)
        labels = [
            item.label for item in outcome.projection.current_attempt.stage_runs[-1].output.facts
        ]
        self.assertTrue(any("error" in item for item in labels))
        self.assertTrue(any("latency" in item for item in labels))
        self.assertTrue(any("traffic" in item for item in labels))
        fact_ids = {
            item.fact_id
            for item in outcome.projection.current_attempt.stage_runs[-1].output.facts
        }
        self.assertTrue({
            "verified-series:real-error-checkout",
            "verified-series:real-latency-checkout",
            "verified-series:real-traffic-checkout",
        }.issubset(fact_ids))
        self.assertFalse({
            "verified-series:error-checkout",
            "verified-series:latency-checkout",
            "verified-series:traffic-checkout",
        }.intersection(fact_ids))
        comparisons = [
            item.value for item in outcome.projection.current_attempt.stage_runs[-1].output.facts
            if "recovery" in item.label
        ]
        self.assertTrue(all("pre=" in item and "post=" in item for item in comparisons))

        completed = await self.coordinator.advance(
            "tenant-a", "case-a",
            self.command(outcome.projection, "complete-verified-incident"),
            "subject-a", post_times[-1],
        )
        report = completed.projection.final_report
        self.assertIsNotNone(report)
        self.assertEqual("RESOLVED", completed.projection.lifecycle_state.value)
        self.assertEqual(
            IncidentClockState.RESOLVED,
            completed.projection.incident_clock.state,
        )
        self.assertEqual(post_times[-1], completed.projection.incident_clock.resolved_at)
        self.assertEqual(
            self.repository.series_collection,
            completed.projection.resolved_series_snapshot,
        )
        self.assertEqual(
            completed.projection.signal_revision,
            completed.projection.resolved_series_snapshot.signal_revision,
        )
        self.assertIn("trace-post-action", report.verification_evidence_refs)
        self.assertTrue(report.action_receipt_audit_ids)
        self.assertTrue(report.stage_output_audit_ids)
        self.assertEqual(
            report.stage_output_audit_ids,
            [
                item.audit_id
                for item in completed.projection.audit_records
                if item.record_type.value in {
                    "STAGE_COMPLETED", "VERIFICATION_RECORDED",
                }
                and item.stage_output is not None
            ],
        )
        self.assertEqual(
            "INCIDENT_COMPLETED",
            completed.projection.audit_records[-1].record_type.value,
        )
        self.assertIsNone(completed.projection.audit_records[-1].stage_output)

        event_count = len(await self.repository.workspace_events_v3_after(
            "tenant-a", "case-a", 0,
        ))
        late_at = post_times[-1] + timedelta(seconds=2)
        late_source = source_projection(late_at).copy(update={
            "projection_revision": 99,
            "sequence": 99,
            "source_revision": 99,
        })
        unchanged = await self.coordinator.sync_realtime(
            late_source,
            actor_subject_id="flowpulse-realtime",
            now=late_at,
        )
        self.assertEqual(completed.projection, unchanged)
        self.assertEqual(
            event_count,
            len(await self.repository.workspace_events_v3_after(
                "tenant-a", "case-a", 0,
            )),
        )

    async def test_safe_rollback_success_requires_explicit_diagnostic_branch(self):
        bridge = RuntimeBridge(self.now)
        dispatcher = GuidedWorkflowActivityDispatcherV3(self.repository, bridge)
        respond = await self.reach_respond(dispatcher)
        action = next(
            item for item in respond.actions
            if item.stage_run_id == respond.current_attempt.stage_runs[-1].stage_run_id
        )
        approved = await self.approve_current_action(
            respond, action.action_id, "approve-for-safe-rollback",
        )
        executed = await self.execute_current_action(
            dispatcher, approved, action.action_id,
        )
        verify = await self.advance(executed.projection, "next-safe-rollback")
        failed = await self.coordinator.complete_current_stage(
            "tenant-a", "case-a",
            success=False,
            summary="Verification window expired.",
            evidence_refs=[],
            failure_code="verification_window_expired",
            now=self.now + timedelta(seconds=30),
        )
        self.assertEqual(WorkflowStageStateV3.FAILED, failed.current_attempt.stage_runs[-1].status)
        rollback_receipt = ActionRollbackReceiptV3(
            rollback_receipt_id="rollback-receipt-a",
            execution_key=stable_id(
                "action-rollback", "case-a", action.action_id,
                action.decision_revision,
            ),
            action_id=action.action_id,
            command_id=action.command_id,
            status="ROLLED_BACK",
            started_at=self.now + timedelta(seconds=30),
            completed_at=self.now + timedelta(seconds=31),
            output_summary=(
                "Known-good Checkout manifest restored while "
                "paymentUnreachable remained off."
            ),
        )
        rolled_back = await self.coordinator.record_action_rollback_outcome(
            "tenant-a", "case-a", action.action_id,
            succeeded=True,
            summary=(
                "Known-good Checkout manifest restored while "
                "paymentUnreachable remained off."
            ),
            rollback_receipt=rollback_receipt,
            now=self.now + timedelta(seconds=31),
        )
        current = rolled_back.current_attempt.stage_runs[-1]
        self.assertEqual(WorkflowStageStateV3.NEEDS_HUMAN, current.status)
        self.assertEqual("NEEDS_HUMAN", rolled_back.current_attempt.status.value)
        self.assertEqual(["RERUN_FROM_STAGE"], [
            item.value for item in rolled_back.available_commands
        ])
        rolled_action = next(
            item for item in rolled_back.actions if item.action_id == action.action_id
        )
        self.assertEqual("ROLLED_BACK", rolled_action.execution_state.value)
        self.assertEqual(rollback_receipt, rolled_action.rollback_receipt)
        self.assertEqual(
            rollback_receipt, rolled_back.audit_records[-1].rollback_receipt,
        )
        self.assertEqual("SUCCEEDED", rolled_action.receipt.status.value)
        self.assertEqual(
            "Known-good Checkout manifest restored while paymentUnreachable remained off.",
            rolled_back.audit_records[-1].summary,
        )
        branch = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.INVESTIGATE,
            WorkflowRerunCommandV3(
                attempt_id=rolled_back.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.VERIFY,
                expected_workflow_revision=rolled_back.workflow_revision,
                idempotency_key="branch-after-safe-rollback",
                reason="Investigate current post-rollback state.",
            ), "subject-a", self.now + timedelta(seconds=32),
        )
        self.assertEqual(
            rolled_back.current_attempt.attempt_id,
            branch.projection.current_attempt.parent_attempt_id,
        )


if __name__ == "__main__":
    unittest.main()

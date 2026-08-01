"""Public V3 workflow seam: one stage at a time, durable commands, no leaks."""

import asyncio
import unittest
from datetime import datetime, timedelta, timezone

from flowpulse_cp.models import EvidenceAuthority, FreshnessStatus
from flowpulse_cp.policy import PolicyViolation
from flowpulse_cp.realtime_models import (
    AgentWorkspace,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorTruthLabel,
    IncidentClock,
    IncidentClockState,
    IncidentProjectionV2,
    RealtimeSignal,
    RealtimeCitation,
    RealtimeSignalStatus,
    RealtimeTrend,
)
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentGraph,
    IncidentGraphEdge,
    IncidentGraphNode,
    IncidentLifecycleStage,
    IncidentRunBinding,
    ProjectionState,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_v3_guided import GuidedWorkflowCoordinatorV3
from flowpulse_cp.workspace_v3_models import (
    ActionApprovalCommandV3,
    ActionApprovalDecisionV3,
    IncidentActionV3,
    ActionApprovalStateV3,
    ActionExecutionStateV3,
    ActionExecutionReceiptV3,
    AgentRunCommandV3,
    AgentRunStateV3,
    DecisionActionCandidateV3,
    DecisionDryRunStateV3,
    EvidenceQueryNameV3,
    EvidenceQueryResultV3,
    EvidenceQueryStateV3,
    IncidentActionStatusV3,
    StageRunV3,
    StageFactV3,
    WorkflowHypothesisV3,
    WorkflowCommandV3,
    WorkflowEscalationCommandV3,
    WorkflowRerunCommandV3,
    WorkflowStageStateV3,
    WorkflowStageV3,
)


NOW = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)


def realtime_projection() -> IncidentProjectionV2:
    binding = IncidentRunBinding(
        tenant_id="tenant-a", incident_id="incident-a", run_id="run-a",
        topology_revision="topology-a", case_id="case-a", case_revision=1,
        workflow_id="workspace-a", workflow_run_id="temporal-a", created_at=NOW,
    )
    graph = IncidentGraph(
        nodes=[
            IncidentGraphNode(
                component_id="checkout", canonical_identity="service:checkout",
                display_name="Checkout", membership=GraphMembership.CONNECTED,
                runtime_status="critical", impact_status="impacted",
            ),
            IncidentGraphNode(
                component_id="payment", canonical_identity="service:payment",
                display_name="Payment", membership=GraphMembership.CONNECTED,
                runtime_status="degraded", impact_status="impacted",
            ),
        ],
        edges=[IncidentGraphEdge(
            edge_id="checkout-payment", source_component_id="checkout",
            target_component_id="payment", status="critical",
        )],
    )
    clock = IncidentClock(
        state=IncidentClockState.RUNNING, started_at=NOW - timedelta(minutes=4),
        last_signal_at=NOW, as_of=NOW, elapsed_seconds=240,
        freshness=FreshnessStatus.CURRENT, fresh_until=NOW + timedelta(seconds=30),
        max_interpolation_seconds=30,
    )
    health = ConnectorHealth(
        connector_id="connector-otel-primary", tenant_id="tenant-a",
        provider=ConnectorProvider.OTEL, state=ConnectorHealthState.CONNECTED,
        checked_at=NOW, last_success_at=NOW, last_event_observed_at=NOW,
        fresh_until=NOW + timedelta(seconds=30), cursor="3", consecutive_failures=0,
        lag_seconds=0, adapter_version="otel-jsonl-spool.v3", health_revision=1,
        truth_label=ConnectorTruthLabel.LIVE,
    )
    signal = RealtimeSignal(
        signal_id="signal-a", source_event_id="source-a",
        provider=ConnectorProvider.OTEL, source_label="OpenTelemetry",
        signal_kind="TRACE_STATUS", title="Checkout client error",
        display_value="12 ms · error",
        status=RealtimeSignalStatus.CRITICAL, trend=RealtimeTrend.RISING,
        component_ids=["checkout", "payment"], edge_ids=["checkout-payment"], observed_at=NOW,
        fresh_until=NOW + timedelta(seconds=30), freshness=FreshnessStatus.CURRENT,
        authority=EvidenceAuthority.T0,
        evidence_refs=["evidence-a"], citation_refs=["citation-a"],
        connector_state=ConnectorHealthState.CONNECTED, sequence=1,
    )
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
            "sequence": 2,
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
            "sequence": 3,
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
            "sequence": 4,
        }),
    ]
    citation = RealtimeCitation(
        citation_id="citation-a", provider=ConnectorProvider.OTEL,
        evidence_id="evidence-a", source_event_id="source-a",
        label="Checkout client error", observed_at=NOW,
        freshness=FreshnessStatus.CURRENT,
        safe_detail_path="/v2/incidents/case-a/evidence/evidence-a",
    )
    return IncidentProjectionV2(
        **binding.dict(), projection_revision=3, sequence=9,
        lifecycle_state=ProjectionState.ACTIVE,
        lifecycle_stage=IncidentLifecycleStage.INVESTIGATE,
        status="critical", operator_title="Checkout cannot reach Payment",
        operator_summary="Checkout requests fail at the Payment dependency.",
        generated_at=NOW, graph=graph, impacted_path=["checkout", "payment"],
        evidence_revision=3, gate_revision=1, action_revision=1,
        evidence_refs=[
            "evidence-a", "evidence-metric-error-rate",
            "evidence-metric-mean-latency", "evidence-metric-request-count",
        ], source_revision=3, connector_revision=1,
        incident_clock=clock, connector_health=[health],
        realtime_signals=[signal, *metric_signals],
        active_graph_pulses=[], agent_workspace=AgentWorkspace(
            workspace_revision=1, activities=[], citations=[citation],
        ),
    )


def command(projection, key="next-a") -> WorkflowCommandV3:
    return WorkflowCommandV3(
        attempt_id=projection.current_attempt.attempt_id,
        expected_stage=projection.current_attempt.current_stage,
        expected_workflow_revision=projection.workflow_revision,
        idempotency_key=key,
    )


class GuidedWorkflowV3Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.repository = InMemoryWorkspaceRepository()
        self.coordinator = GuidedWorkflowCoordinatorV3(self.repository)
        self.projection = await self.coordinator.bootstrap(
            realtime_projection(), actor_subject_id="subject-a", now=NOW,
        )

    async def test_verify_deadline_is_required_and_forbidden_on_other_stages(self):
        template = self.projection.current_attempt.stage_runs[0].dict()
        verify = {
            **template,
            "stage": WorkflowStageV3.VERIFY,
            "verification_deadline_at": NOW + timedelta(seconds=30),
        }
        self.assertEqual(
            NOW + timedelta(seconds=30),
            StageRunV3.parse_obj(verify).verification_deadline_at,
        )
        with self.assertRaisesRegex(ValueError, "workflow_v3_verify_deadline_required"):
            StageRunV3.parse_obj({**verify, "verification_deadline_at": None})
        with self.assertRaisesRegex(
            ValueError, "workflow_v3_verification_deadline_stage_mismatch",
        ):
            StageRunV3.parse_obj({
                **template,
                "verification_deadline_at": NOW + timedelta(seconds=30),
            })

    async def complete_typed_stage(self, projection):
        stage = projection.current_attempt.current_stage
        fact = StageFactV3(
            fact_id="fact-{}".format(stage.value.lower()),
            label="Canonical evidence",
            value="evidence-backed {} result".format(stage.value.lower()),
            evidence_refs=["evidence-a"],
        )
        arguments = {
            "success": True,
            "summary": "{} complete".format(stage.value),
            "evidence_refs": ["evidence-a"],
            "facts": [fact],
            "now": NOW,
        }
        if stage == WorkflowStageV3.TRIAGE:
            arguments["questions"] = ["Which dependency should be investigated next?"]
        elif stage == WorkflowStageV3.INVESTIGATE:
            current = await self.repository.workspace_projection_v3("tenant-a", "case-a")
            investigate_stage_run_id = current.current_attempt.stage_runs[-1].stage_run_id
            receipt = await self.coordinator.start_agent_run(
                "tenant-a", "case-a",
                AgentRunCommandV3(
                    attempt_id=current.current_attempt.attempt_id,
                    expected_stage=current.current_attempt.current_stage,
                    expected_workflow_revision=current.workflow_revision,
                    idempotency_key="test-agent-evidence-worker-{}".format(
                        investigate_stage_run_id,
                    ),
                    question="Execute the allowlisted evidence query.",
                ),
                "subject-a", NOW, role_override="EVIDENCE_WORKER",
            )
            worker = receipt.projection.agent_activity[-1]
            current = receipt.projection
            run = current.current_attempt.stage_runs[-1]
            running_query = EvidenceQueryResultV3(
                query_id="query-test-investigate-{}".format(
                    investigate_stage_run_id,
                ),
                attempt_id=current.current_attempt.attempt_id,
                stage_run_id=run.stage_run_id,
                stage=WorkflowStageV3.INVESTIGATE,
                worker_activity_id=worker.activity_id,
                query_name=EvidenceQueryNameV3.CURRENT_INCIDENT_SIGNALS,
                state=EvidenceQueryStateV3.RUNNING,
                parameters_hash="query-parameters-a",
                result_summary="Allowlisted query started.",
                started_at=NOW,
            )
            await self.coordinator.record_evidence_query(
                "tenant-a", "case-a", running_query, now=NOW,
            )
            await self.coordinator.record_evidence_query(
                "tenant-a", "case-a",
                EvidenceQueryResultV3.parse_obj({
                    **running_query.dict(),
                    "state": EvidenceQueryStateV3.SUCCEEDED,
                    "result_summary": "Allowlisted query completed.",
                    "evidence_refs": ["evidence-a"],
                    "observation_timestamps": [NOW - timedelta(seconds=2), NOW],
                    "completed_at": NOW,
                }),
                now=NOW,
            )
            await self.coordinator.update_agent_run(
                "tenant-a", "case-a", worker.agent_run_id,
                state=AgentRunStateV3.SUCCEEDED,
                progress_percent=100,
                summary="Canonical evidence query completed.",
                evidence_refs=["evidence-a"],
                now=NOW,
            )
            for role in ("INVESTIGATOR", "CRITIC"):
                current = await self.repository.workspace_projection_v3("tenant-a", "case-a")
                receipt = await self.coordinator.start_agent_run(
                    "tenant-a", "case-a",
                    AgentRunCommandV3(
                        attempt_id=current.current_attempt.attempt_id,
                        expected_stage=current.current_attempt.current_stage,
                        expected_workflow_revision=current.workflow_revision,
                        idempotency_key="test-agent-{}-{}".format(
                            role.lower(), investigate_stage_run_id,
                        ),
                        question="Bounded canonical review",
                    ),
                    "subject-a", NOW, role_override=role,
                )
                agent = receipt.projection.agent_activity[-1]
                await self.coordinator.update_agent_run(
                    "tenant-a", "case-a", agent.agent_run_id,
                    state=AgentRunStateV3.SUCCEEDED,
                    progress_percent=100,
                    summary="Explanatory text only.",
                    evidence_refs=["evidence-a"],
                    now=NOW,
                )
            current = await self.repository.workspace_projection_v3("tenant-a", "case-a")
            run = current.current_attempt.stage_runs[-1]
            arguments["hypotheses"] = [WorkflowHypothesisV3(
                hypothesis_id="hypothesis-checkout-payment",
                stage_run_id=run.stage_run_id,
                statement="The evidenced checkout to payment failure is causal.",
                confidence=0.8,
                supporting_evidence_refs=["evidence-a"],
                contradicting_evidence_refs=[],
                falsification_condition="A fresh healthy trace while failures continue.",
                status="SUPPORTED",
            )]
        elif stage == WorkflowStageV3.DECIDE:
            next_revision = projection.decision_revision + 1
            conditions = ["Fresh checkout to payment trace succeeds"]
            candidate = DecisionActionCandidateV3(
                candidate_id="candidate-a",
                command_id="astronomy.restore-payment-and-recreate-checkout",
                component_id="checkout",
                title="Restore Payment reachability",
                summary="Disable the local fault flag.",
                blast_radius="Local checkout only",
                risk="Low",
                rollback_plan="No automatic rollback to the known-bad fault.",
                verification_conditions=conditions,
                dry_run_state=DecisionDryRunStateV3.PASSED,
                dry_run_summary="Exact flag and container manifest validated.",
                preflight_receipt_id="preflight-a",
                preflight_manifest_hash="manifest-a",
                preflight_checked_at=NOW,
                expected_before="paymentUnreachable=on",
                observed_before="paymentUnreachable=on",
                mutation_targets=["flag:paymentUnreachable", "container:checkout"],
                decision_revision=next_revision,
            )
            arguments.update(
                root_cause="The evidenced checkout to payment failure is causal.",
                recommendation=candidate.summary,
                risk=candidate.risk,
                rollback=candidate.rollback_plan,
                verification_conditions=conditions,
                action_candidate=candidate,
                premise_fingerprint=projection.current_premise_fingerprint,
            )
        return await self.coordinator.complete_current_stage(
            "tenant-a", "case-a", **arguments,
        )

    async def reach_succeeded_decide(self):
        projection = self.projection
        for expected in (
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
        ):
            projection = (await self.coordinator.advance(
                "tenant-a", "case-a",
                command(projection, "reach-{}".format(expected.value.lower())),
                "subject-a", NOW,
            )).projection
            self.assertEqual(expected, projection.current_attempt.current_stage)
            projection = await self.complete_typed_stage(projection)
        return projection

    async def propose_current_action(self, respond, action_id="action-a"):
        candidate = next(
            item.output.action_candidate
            for item in respond.current_attempt.stage_runs
            if item.stage == WorkflowStageV3.DECIDE
            and item.output is not None
        )
        action = IncidentActionV3(
            action_id=action_id,
            attempt_id=respond.current_attempt.attempt_id,
            stage_run_id=respond.current_attempt.stage_runs[-1].stage_run_id,
            title=candidate.title,
            summary=candidate.summary,
            component_id=candidate.component_id,
            command_id=candidate.command_id,
            command_label=candidate.title,
            decision_revision=candidate.decision_revision,
            required_permission="incident:execute",
            approval_state=ActionApprovalStateV3.PENDING,
            execution_state=ActionExecutionStateV3.NOT_STARTED,
            status=IncidentActionStatusV3.AWAITING_APPROVAL,
            blast_radius=candidate.blast_radius,
            risk=candidate.risk,
            rollback_plan=candidate.rollback_plan,
            verification_conditions=candidate.verification_conditions,
        )
        return await self.coordinator.add_action("tenant-a", "case-a", action, NOW)

    async def test_bootstrap_exposes_only_succeeded_detect_and_locks_future_work(self):
        self.assertEqual(WorkflowStageV3.DETECT, self.projection.current_attempt.current_stage)
        self.assertEqual(
            [WorkflowStageV3.DETECT],
            [item.stage for item in self.projection.current_attempt.stage_runs],
        )
        self.assertEqual(
            WorkflowStageStateV3.SUCCEEDED,
            self.projection.current_attempt.stage_runs[0].status,
        )
        self.assertEqual(
            ["NEXT", "RERUN_FROM_STAGE"],
            [item.value for item in self.projection.available_commands],
        )
        detect = self.projection.current_attempt.stage_runs[0]
        self.assertEqual(4, len(detect.output.facts))
        self.assertNotIn("paymentUnreachable", detect.output.summary)

    async def test_bootstrap_links_every_evidence_impacted_graph_component(self):
        source = realtime_projection().copy(update={"impacted_path": ["checkout"]})
        repository = InMemoryWorkspaceRepository()
        projection = await GuidedWorkflowCoordinatorV3(repository).bootstrap(
            source, actor_subject_id="subject-a", now=NOW,
        )
        self.assertEqual(["checkout", "payment"], projection.impacted_path)

    async def test_detect_does_not_complete_from_metrics_and_arbitrary_log(self):
        source = realtime_projection()
        arbitrary_log = source.realtime_signals[0].copy(update={
            "signal_id": "signal-arbitrary-log",
            "source_event_id": "source-arbitrary-log",
            "signal_kind": "LOG_RECORD",
            "title": "Checkout error log",
            "component_ids": ["checkout"],
            "edge_ids": [],
            "sequence": 5,
        })
        source = IncidentProjectionV2.parse_obj({
            **source.dict(),
            "realtime_signals": [arbitrary_log, *source.realtime_signals[1:]],
        })
        repository = InMemoryWorkspaceRepository()
        coordinator = GuidedWorkflowCoordinatorV3(repository)

        projection = await coordinator.bootstrap(
            source, actor_subject_id="subject-a", now=NOW,
        )

        detect = projection.current_attempt.stage_runs[0]
        self.assertEqual(WorkflowStageStateV3.RUNNING, detect.status)
        self.assertIsNone(detect.output)
        self.assertEqual(
            ["ESCALATE"],
            [item.value for item in projection.available_commands],
        )

    async def test_detect_waits_for_all_three_metrics_then_completes(self):
        complete_source = realtime_projection()
        incomplete_source = IncidentProjectionV2.parse_obj({
            **complete_source.dict(),
            "realtime_signals": complete_source.realtime_signals[:-1],
        })
        repository = InMemoryWorkspaceRepository()
        coordinator = GuidedWorkflowCoordinatorV3(repository)
        projection = await coordinator.bootstrap(
            incomplete_source, actor_subject_id="subject-a", now=NOW,
        )
        self.assertEqual(
            WorkflowStageStateV3.RUNNING,
            projection.current_attempt.stage_runs[0].status,
        )

        observed_at = NOW + timedelta(seconds=2)
        complete_source = IncidentProjectionV2.parse_obj({
            **complete_source.dict(),
            "projection_revision": 4,
            "sequence": 10,
            "source_revision": 4,
            "generated_at": observed_at,
            "incident_clock": complete_source.incident_clock.copy(update={
                "last_signal_at": observed_at,
                "as_of": observed_at,
                "elapsed_seconds": 242,
                "fresh_until": observed_at + timedelta(seconds=30),
            }),
            "realtime_signals": [
                item.copy(update={
                    "observed_at": observed_at,
                    "fresh_until": observed_at + timedelta(seconds=30),
                })
                for item in complete_source.realtime_signals
            ],
        })
        completed = await coordinator.sync_realtime(
            complete_source,
            actor_subject_id="flowpulse-realtime",
            now=observed_at,
        )

        detect = completed.current_attempt.stage_runs[0]
        self.assertEqual(WorkflowStageStateV3.SUCCEEDED, detect.status)
        self.assertEqual(
            {
                "signal-a", "signal-error-rate", "signal-mean-latency",
                "signal-request-count",
            },
            {item.fact_id for item in detect.output.facts},
        )
        self.assertEqual(
            ["NEXT", "RERUN_FROM_STAGE"],
            [item.value for item in completed.available_commands],
        )

    async def test_next_starts_exactly_one_stage_and_replay_is_idempotent(self):
        first = await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection), "subject-a", NOW,
        )
        replay = await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection), "subject-a", NOW,
        )

        self.assertFalse(first.reused)
        self.assertTrue(replay.reused)
        self.assertEqual(first.command_id, replay.command_id)
        self.assertEqual(WorkflowStageV3.TRIAGE, replay.projection.current_attempt.current_stage)
        self.assertEqual(
            [WorkflowStageV3.DETECT, WorkflowStageV3.TRIAGE],
            [item.stage for item in replay.projection.current_attempt.stage_runs],
        )
        self.assertEqual(
            WorkflowStageStateV3.RUNNING,
            replay.projection.current_attempt.stage_runs[-1].status,
        )
        events = await self.repository.workspace_events_v3_after("tenant-a", "case-a", 0)
        self.assertEqual(
            ["workflow.stage.completed", "workflow.advanced", "workflow.stage.started"],
            [item.event_type.value for item in events],
        )

    async def test_failed_stage_cannot_advance(self):
        triage = (await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection), "subject-a", NOW,
        )).projection
        failed = await self.coordinator.complete_current_stage(
            "tenant-a", "case-a", success=False, summary="Agent unavailable.",
            evidence_refs=[], failure_code="agent_provider_unavailable", now=NOW,
        )
        with self.assertRaisesRegex(PolicyViolation, "workflow_v3_current_stage_not_succeeded"):
            await self.coordinator.advance(
                "tenant-a", "case-a", command(failed, "next-failed"), "subject-a", NOW,
            )

    async def test_realtime_samples_refresh_facts_without_advancing_gated_stage(self):
        triage = (await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection), "subject-a", NOW,
        )).projection
        workflow_revision = triage.workflow_revision
        decision_revision = triage.decision_revision
        stage_run_id = triage.current_attempt.stage_runs[-1].stage_run_id

        stored = triage
        for offset, value in enumerate(("710 ms", "684 ms", "655 ms"), 1):
            observed_at = NOW + timedelta(seconds=offset * 2)
            source = realtime_projection()
            signal = source.realtime_signals[0].copy(update={
                "display_value": value,
                "observed_at": observed_at,
                "fresh_until": observed_at + timedelta(seconds=30),
                "sequence": offset + 1,
                "source_event_id": "source-{}".format(offset + 1),
                "signal_id": "signal-{}".format(offset + 1),
            })
            clock = source.incident_clock.copy(update={
                "last_signal_at": observed_at,
                "as_of": observed_at,
                "elapsed_seconds": 240 + offset * 2,
                "fresh_until": observed_at + timedelta(seconds=30),
            })
            source = IncidentProjectionV2.parse_obj({
                **source.dict(),
                "projection_revision": 3 + offset,
                "sequence": 9 + offset,
                "source_revision": 3 + offset,
                "generated_at": observed_at,
                "incident_clock": clock,
                "realtime_signals": [signal],
            })
            stored = await self.coordinator.sync_realtime(
                source, actor_subject_id="flowpulse-realtime", now=observed_at,
            )

        self.assertEqual(workflow_revision, stored.workflow_revision)
        self.assertEqual(decision_revision, stored.decision_revision)
        self.assertEqual(WorkflowStageV3.TRIAGE, stored.current_attempt.current_stage)
        self.assertEqual(stage_run_id, stored.current_attempt.stage_runs[-1].stage_run_id)
        self.assertEqual(6, stored.signal_revision)
        self.assertEqual(source.generated_at, stored.generated_at)
        before_replay_events = len(await self.repository.workspace_events_v3_after(
            "tenant-a", "case-a", 0,
        ))
        replay = await self.coordinator.sync_realtime(
            source, actor_subject_id="flowpulse-realtime", now=source.generated_at,
        )
        self.assertEqual(stored, replay)
        self.assertEqual(before_replay_events, len(
            await self.repository.workspace_events_v3_after("tenant-a", "case-a", 0),
        ))

    async def test_durable_stale_signal_propagates_without_mutating_workflow(self):
        workflow_revision = self.projection.workflow_revision
        stage_run = self.projection.current_attempt.stage_runs[-1]
        stale_at = NOW + timedelta(seconds=31)
        source = realtime_projection()
        stale_health = source.connector_health[0].copy(update={
            "state": ConnectorHealthState.STALE,
            "checked_at": stale_at,
            "lag_seconds": 1,
            "reason_code": "freshness_deadline_expired",
            "health_revision": 2,
        })
        stale_signal = source.realtime_signals[0].copy(update={
            "freshness": FreshnessStatus.STALE,
            "connector_state": ConnectorHealthState.STALE,
            "sequence": 10,
        })
        stale_clock = source.incident_clock.copy(update={
            "as_of": stale_at,
            "elapsed_seconds": 271,
            "freshness": FreshnessStatus.STALE,
        })
        stale_source = IncidentProjectionV2.parse_obj({
            **source.dict(),
            "projection_revision": 4,
            "sequence": 10,
            "source_revision": 4,
            "connector_revision": 2,
            "generated_at": stale_at,
            "incident_clock": stale_clock,
            "connector_health": [stale_health],
            "realtime_signals": [stale_signal],
        })
        stored = await self.coordinator.sync_realtime(
            stale_source, actor_subject_id="flowpulse-realtime", now=stale_at,
        )
        self.assertEqual(FreshnessStatus.STALE, stored.freshness.state)
        self.assertEqual("STALE", stored.connectors[0].state)
        self.assertEqual("DEGRADED", stored.lifecycle_state.value)
        self.assertEqual(workflow_revision, stored.workflow_revision)
        self.assertEqual(stage_run, stored.current_attempt.stage_runs[-1])
        events = await self.repository.workspace_events_v3_after(
            "tenant-a", "case-a", 1,
        )
        self.assertEqual("signal.stale", events[-1].event_type.value)

    async def test_equivalent_sample_churn_does_not_invalidate_succeeded_decide(self):
        decided = await self.reach_succeeded_decide()
        source = realtime_projection()
        observed_at = NOW + timedelta(seconds=2)
        signal = source.realtime_signals[0].copy(update={
            "signal_id": "signal-equivalent",
            "source_event_id": "source-equivalent",
            "display_value": "735 ms",
            "observed_at": observed_at,
            "fresh_until": observed_at + timedelta(seconds=30),
            "sequence": 2,
        })
        source = IncidentProjectionV2.parse_obj({
            **source.dict(),
            "projection_revision": 4,
            "sequence": 10,
            "source_revision": 4,
            "generated_at": observed_at,
            "incident_clock": source.incident_clock.copy(update={
                "last_signal_at": observed_at,
                "as_of": observed_at,
                "fresh_until": observed_at + timedelta(seconds=30),
            }),
            "realtime_signals": [signal, *source.realtime_signals[1:]],
        })
        refreshed = await self.coordinator.sync_realtime(
            source, actor_subject_id="flowpulse-realtime", now=observed_at,
        )
        self.assertEqual(
            decided.current_premise_fingerprint,
            refreshed.current_premise_fingerprint,
        )
        receipt = await self.coordinator.advance(
            "tenant-a", "case-a", command(refreshed, "next-equivalent"),
            "subject-a", observed_at,
        )
        self.assertEqual(WorkflowStageV3.RESPOND, receipt.projection.current_attempt.current_stage)

    async def test_material_premise_change_requires_decide_revalidation(self):
        decided = await self.reach_succeeded_decide()
        source = realtime_projection()
        observed_at = NOW + timedelta(seconds=2)
        source = IncidentProjectionV2.parse_obj({
            **source.dict(),
            "projection_revision": 4,
            "sequence": 10,
            "source_revision": 4,
            "status": "warning",
            "generated_at": observed_at,
            "incident_clock": source.incident_clock.copy(update={
                "last_signal_at": observed_at,
                "as_of": observed_at,
                "fresh_until": observed_at + timedelta(seconds=30),
            }),
            "realtime_signals": [source.realtime_signals[0].copy(update={
                "observed_at": observed_at,
                "fresh_until": observed_at + timedelta(seconds=30),
                "sequence": 2,
            })],
        })
        refreshed = await self.coordinator.sync_realtime(
            source, actor_subject_id="flowpulse-realtime", now=observed_at,
        )
        self.assertNotEqual(
            decided.current_premise_fingerprint,
            refreshed.current_premise_fingerprint,
        )
        receipt = await self.coordinator.advance(
            "tenant-a", "case-a", command(refreshed, "next-material-change"),
            "subject-a", observed_at,
        )
        self.assertFalse(receipt.accepted)
        self.assertEqual("REVALIDATION_REQUIRED", receipt.reason)
        current = receipt.projection.current_attempt.stage_runs[-1]
        self.assertEqual(WorkflowStageStateV3.FAILED, current.status)
        self.assertEqual("REVALIDATION_REQUIRED", current.failure_code)
        self.assertEqual(
            {"RERUN_FROM_STAGE", "ESCALATE"},
            {item.value for item in receipt.projection.available_commands},
        )
        rerun = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.DECIDE,
            WorkflowRerunCommandV3(
                attempt_id=receipt.projection.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.DECIDE,
                expected_workflow_revision=receipt.projection.workflow_revision,
                idempotency_key="rerun-materially-changed-decision",
                reason="Re-evaluate the changed premises.",
            ), "subject-a", observed_at,
        )
        self.assertEqual(
            WorkflowStageStateV3.RUNNING,
            rerun.projection.current_attempt.stage_runs[-1].status,
        )

    async def test_agent_answer_remains_activity_and_never_becomes_stage_fact(self):
        triage = (await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection, "triage-for-agent"),
            "subject-a", NOW,
        )).projection
        triage = await self.complete_typed_stage(triage)
        investigate = (await self.coordinator.advance(
            "tenant-a", "case-a", command(triage, "investigate-for-agent"),
            "subject-a", NOW,
        )).projection
        succeeded = await self.complete_typed_stage(investigate)
        original_output = succeeded.current_attempt.stage_runs[-1].output
        receipt = await self.coordinator.start_agent_run(
            "tenant-a", "case-a",
            AgentRunCommandV3(
                attempt_id=succeeded.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.INVESTIGATE,
                expected_workflow_revision=succeeded.workflow_revision,
                idempotency_key="post-stage-explanation",
                question="Explain the canonical result.",
            ), "subject-a", NOW,
        )
        agent = receipt.projection.agent_activity[-1]
        updated = await self.coordinator.update_agent_run(
            "tenant-a", "case-a", agent.agent_run_id,
            state=AgentRunStateV3.SUCCEEDED,
            progress_percent=100,
            summary="Untrusted model explanation that must not become a fact.",
            evidence_refs=["evidence-a"],
            now=NOW,
        )
        self.assertEqual(original_output, updated.current_attempt.stage_runs[-1].output)
        self.assertIn(
            "Untrusted model explanation",
            updated.agent_activity[-1].summary,
        )

    async def test_rejected_action_terminalizes_respond_instead_of_dead_ending(self):
        decided = await self.reach_succeeded_decide()
        respond = (await self.coordinator.advance(
            "tenant-a", "case-a", command(decided, "respond-for-reject"),
            "subject-a", NOW,
        )).projection
        respond = await self.propose_current_action(respond, "action-reject")
        receipt = await self.coordinator.approve_action(
            "tenant-a", "case-a", "action-reject",
            ActionApprovalCommandV3(
                **command(respond, "reject-action").dict(),
                decision=ActionApprovalDecisionV3.REJECT,
                expected_decision_revision=respond.decision_revision,
                reason="Blast radius is not acceptable.",
            ), "subject-a", ["owner"], NOW,
        )
        current = receipt.projection.current_attempt.stage_runs[-1]
        self.assertEqual(WorkflowStageStateV3.FAILED, current.status)
        self.assertEqual("action_rejected", current.failure_code)
        self.assertEqual(
            {"RETRY", "ESCALATE", "RERUN_FROM_STAGE"},
            {item.value for item in receipt.projection.available_commands},
        )
        self.assertEqual(
            ["action.rejected", "workflow.stage.failed"],
            [item.event_type.value for item in (
                await self.repository.workspace_events_v3_after(
                    "tenant-a", "case-a", receipt.projection.sequence - 2,
                )
            )],
        )

    async def test_rerun_before_action_supersedes_old_run_without_mutating_history(self):
        triage = (await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection), "subject-a", NOW,
        )).projection
        succeeded = await self.complete_typed_stage(triage)
        original_run_id = succeeded.current_attempt.stage_runs[-1].stage_run_id
        receipt = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.TRIAGE,
            WorkflowRerunCommandV3(
                **command(succeeded, "rerun-a").dict(), reason="Review new evidence.",
            ), "subject-a", NOW,
        )

        runs = receipt.projection.current_attempt.stage_runs
        self.assertEqual(WorkflowStageStateV3.SUPERSEDED, runs[-2].status)
        self.assertEqual(original_run_id, runs[-2].stage_run_id)
        self.assertEqual(WorkflowStageStateV3.RUNNING, runs[-1].status)
        self.assertNotEqual(original_run_id, runs[-1].stage_run_id)
        historical = await self.repository.workspace_projection_v3_at_revision(
            "tenant-a", "case-a", succeeded.workflow_revision,
        )
        self.assertEqual(WorkflowStageStateV3.SUCCEEDED, historical.current_attempt.stage_runs[-1].status)

    async def test_rerun_from_earlier_stage_retains_all_downstream_objects_as_superseded_history(self):
        decided = await self.reach_succeeded_decide()
        respond = (await self.coordinator.advance(
            "tenant-a", "case-a", command(decided, "respond-history-retention"),
            "subject-a", NOW,
        )).projection
        respond = await self.propose_current_action(respond, "action-history")
        action = next(
            item for item in respond.actions if item.action_id == "action-history"
        )
        rejected = await self.coordinator.approve_action(
            "tenant-a", "case-a", action.action_id,
            ActionApprovalCommandV3(
                attempt_id=respond.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.RESPOND,
                expected_workflow_revision=respond.workflow_revision,
                idempotency_key="reject-history-action",
                decision=ActionApprovalDecisionV3.REJECT,
                expected_decision_revision=respond.decision_revision,
                reason="Gather more diagnostic evidence first.",
            ),
            "subject-a", ["owner"], NOW,
        )
        before = rejected.projection
        retained_run_ids = {
            item.stage_run_id for item in before.current_attempt.stage_runs
            if item.stage in {
                WorkflowStageV3.INVESTIGATE,
                WorkflowStageV3.DECIDE,
                WorkflowStageV3.RESPOND,
            }
        }
        retained_activity = list(before.agent_activity)
        retained_queries = list(before.evidence_queries)
        retained_hypotheses = list(before.hypotheses)
        retained_actions = list(before.actions)

        rerun = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.INVESTIGATE,
            WorkflowRerunCommandV3(
                attempt_id=before.current_attempt.attempt_id,
                expected_stage=WorkflowStageV3.RESPOND,
                expected_workflow_revision=before.workflow_revision,
                idempotency_key="rerun-investigate-retain-history",
                reason="Use additional evidence without rewriting prior results.",
            ),
            "subject-a", NOW,
        )
        after = rerun.projection
        retained_runs = [
            item for item in after.current_attempt.stage_runs
            if item.stage_run_id in retained_run_ids
        ]
        self.assertEqual(retained_run_ids, {
            item.stage_run_id for item in retained_runs
        })
        self.assertTrue(all(
            item.status == WorkflowStageStateV3.SUPERSEDED
            for item in retained_runs
        ))
        self.assertEqual(retained_activity, after.agent_activity)
        self.assertEqual(retained_queries, after.evidence_queries)
        self.assertEqual(retained_hypotheses, after.hypotheses)
        self.assertEqual(retained_actions, after.actions)
        self.assertEqual(
            WorkflowStageV3.INVESTIGATE,
            after.current_attempt.stage_runs[-1].stage,
        )
        self.assertEqual(
            WorkflowStageStateV3.RUNNING,
            after.current_attempt.stage_runs[-1].status,
        )

    async def test_rerun_after_action_creates_child_attempt(self):
        respond = self.projection
        for stage in (
            WorkflowStageV3.TRIAGE,
            WorkflowStageV3.INVESTIGATE,
            WorkflowStageV3.DECIDE,
            WorkflowStageV3.RESPOND,
        ):
            respond = (await self.coordinator.advance(
                "tenant-a", "case-a", command(respond, "next-{}".format(stage.value)),
                "subject-a", NOW,
            )).projection
            if stage != WorkflowStageV3.RESPOND:
                respond = await self.complete_typed_stage(respond)
        candidate = next(
            item.output.action_candidate
            for item in respond.current_attempt.stage_runs
            if item.stage == WorkflowStageV3.DECIDE
            and item.output is not None
        )
        action = IncidentActionV3(
            action_id="action-a", attempt_id=respond.current_attempt.attempt_id,
            stage_run_id=respond.current_attempt.stage_runs[-1].stage_run_id,
            title=candidate.title, summary=candidate.summary,
            component_id=candidate.component_id,
            command_id=candidate.command_id,
            command_label=candidate.title,
            decision_revision=candidate.decision_revision, required_permission="incident:execute",
            approval_state=ActionApprovalStateV3.PENDING,
            execution_state=ActionExecutionStateV3.NOT_STARTED,
            status=IncidentActionStatusV3.AWAITING_APPROVAL,
            blast_radius=candidate.blast_radius, risk=candidate.risk,
            rollback_plan=candidate.rollback_plan,
            verification_conditions=candidate.verification_conditions,
        )
        respond = await self.coordinator.add_action("tenant-a", "case-a", action, NOW)
        approved = await self.coordinator.approve_action(
            "tenant-a", "case-a", "action-a",
            ActionApprovalCommandV3(
                **command(respond, "approve-a").dict(), decision=ActionApprovalDecisionV3.APPROVE,
                expected_decision_revision=respond.decision_revision,
            ), "subject-a", ["owner"], NOW,
        )
        executed = await self.coordinator.record_action_execution(
            "tenant-a", "case-a", "action-a", ActionExecutionReceiptV3(
                receipt_id="receipt-a", executor_id="astronomy-local-executor",
                command_id="astronomy.restore-payment-and-recreate-checkout",
                status=ActionExecutionStateV3.SUCCEEDED,
                started_at=NOW, completed_at=NOW,
                output_summary="Fault disabled and checkout recreated.",
            ), now=NOW,
        )
        parent_id = executed.current_attempt.attempt_id
        for target in (WorkflowStageV3.RESPOND, WorkflowStageV3.VERIFY):
            with self.subTest(target=target):
                with self.assertRaisesRegex(
                    PolicyViolation,
                    "workflow_v3_post_action_branch_requires_diagnostic_stage",
                ):
                    await self.coordinator.rerun(
                        "tenant-a", "case-a", target,
                        WorkflowRerunCommandV3(
                            attempt_id=parent_id,
                            expected_stage=WorkflowStageV3.RESPOND,
                            expected_workflow_revision=executed.workflow_revision,
                            idempotency_key="invalid-branch-{}".format(target.value),
                            reason="Do not duplicate an executed repair.",
                        ), "subject-a", NOW,
                    )
        receipt = await self.coordinator.rerun(
            "tenant-a", "case-a", WorkflowStageV3.INVESTIGATE,
            WorkflowRerunCommandV3(
                attempt_id=parent_id, expected_stage=WorkflowStageV3.RESPOND,
                expected_workflow_revision=executed.workflow_revision,
                idempotency_key="branch-a", reason="Re-open based on current system state.",
            ), "subject-a", NOW,
        )
        child = receipt.projection.current_attempt
        self.assertNotEqual(parent_id, child.attempt_id)
        self.assertEqual(parent_id, child.parent_attempt_id)
        self.assertEqual(WorkflowStageV3.INVESTIGATE, child.current_stage)
        self.assertEqual([WorkflowStageV3.INVESTIGATE], [item.stage for item in child.stage_runs])
        self.assertEqual([parent_id], [item.attempt_id for item in receipt.projection.attempt_history])
        retained = next(item for item in receipt.projection.actions if item.action_id == "action-a")
        self.assertEqual("receipt-a", retained.receipt.receipt_id)
        self.assertIn(
            "ATTEMPT_BRANCHED",
            [item.record_type.value for item in receipt.projection.audit_records],
        )

    async def test_escalation_is_terminal_for_attempt_and_cannot_advance(self):
        triage = (await self.coordinator.advance(
            "tenant-a", "case-a", command(self.projection, "triage-for-escalate"),
            "subject-a", NOW,
        )).projection
        receipt = await self.coordinator.escalate(
            "tenant-a", "case-a",
            WorkflowEscalationCommandV3(
                **command(triage, "escalate-a").dict(),
                reason="Evidence access requires an operator.",
            ), "subject-a", NOW,
        )
        self.assertEqual("NEEDS_HUMAN", receipt.projection.current_attempt.status.value)
        with self.assertRaisesRegex(PolicyViolation, "workflow_v3_current_stage_not_succeeded"):
            await self.coordinator.advance(
                "tenant-a", "case-a", command(receipt.projection, "next-after-escalate"),
                "subject-a", NOW,
            )


if __name__ == "__main__":
    unittest.main()

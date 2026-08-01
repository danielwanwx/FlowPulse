import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCoherentIncidentV3, TrailingRefreshV3 } from "../public/incident-workbench-controller-v3.mjs";
import {
  applyIncidentEventV3,
  buildWorkflowCommandV3,
  metricSeriesPathsV3,
  metricTrendV3,
  parseIncidentWorkspaceUrlV3,
  renderIncidentWorkbenchV3,
  workbenchDurationV3,
  workbenchViewV3
} from "../public/incident-workspace-v3.mjs";

const stages = ["DETECT", "TRIAGE", "INVESTIGATE", "DECIDE", "RESPOND", "VERIFY"];

function projection(overrides = {}) {
  const current = overrides.current_stage || "TRIAGE";
  const stageRuns = stages.slice(0, stages.indexOf(current) + 1).map((stage, index) => ({
    stage,
    stage_run_id: `stage-run-${index + 1}`,
    status: "SUCCEEDED",
    progress_percent: 100,
    started_at: `2026-07-31T00:00:0${index}Z`,
    verification_deadline_at: stage === "VERIFY" ? "2026-07-31T00:01:30Z" : null,
    completed_at: `2026-07-31T00:00:1${index}Z`,
    summary: `${stage} visible result`,
    evidence_refs: [`evidence-${stage.toLowerCase()}`],
    output: { facts: [`${stage} fact`], unknowns: [], hypotheses: [], recommendations: [] }
  }));
  return {
    schema_version: "flowpulse.incident-projection.v3",
    tenant_id: "tenant-local",
    case_id: "case-checkout",
    incident_id: "incident-checkout",
    run_id: "run-checkout",
    topology_revision: "topology-v3",
    projection_revision: 12,
    sequence: 27,
    signal_revision: 9,
    decision_revision: 3,
    workspace_revision: 8,
    workflow_revision: 5,
    title: "Checkout cannot reach Payment",
    summary: "Checkout requests fail at the payment dependency.",
    severity: "SEV-1",
    owner_subject_id: "owner-local",
    lifecycle_state: "ACTIVE",
    incident_clock: {
      state: "RUNNING",
      started_at: "2026-07-31T00:00:00Z",
      as_of: "2026-07-31T00:01:00Z",
      elapsed_seconds: 60,
      freshness: "CURRENT",
      fresh_until: "2026-07-31T00:01:30Z",
      max_interpolation_seconds: 30
    },
    freshness: {
      state: "CURRENT",
      observed_at: "2026-07-31T00:01:00Z",
      fresh_until: "2026-07-31T00:01:30Z"
    },
    impacted_path: ["checkout", "payment"],
    graph: {
      nodes: [
        { component_id: "checkout", display_name: "Checkout", runtime_status: "degraded", impact_status: "impacted" },
        { component_id: "payment", display_name: "Payment", runtime_status: "unreachable", impact_status: "impacted" }
      ],
      edges: [{ edge_id: "checkout-payment", source_component_id: "checkout", target_component_id: "payment", status: "degraded" }],
      active_pulses: [{ pulse_id: "pulse-1", edge_ids: ["checkout-payment"], expires_at: "2026-07-31T00:02:00Z" }]
    },
    connectors: [{ connector_id: "otel-local", provider: "OTEL", state: "CONNECTED", observed_at: "2026-07-31T00:01:00Z" }],
    current_attempt: {
      attempt_id: "attempt-1",
      parent_attempt_id: null,
      current_stage: current,
      status: "ACTIVE",
      workflow_revision: 5,
      created_at: "2026-07-31T00:00:00Z",
      stage_runs: stageRuns
    },
    available_commands: ["NEXT", "RERUN_FROM_STAGE", "ESCALATE"],
    available_rerun_stages: stages.slice(0, stages.indexOf(current) + 1),
    agent_activity: [{ activity_id: "activity-1", agent_run_id: "agent-1", stage_run_id: stageRuns.at(-1).stage_run_id, stage: current, role: "OBSERVER", state: "SUCCEEDED", label: "Evidence correlation", summary: "Current trace and metrics agree.", occurred_at: "2026-07-31T00:00:20Z", evidence_refs: ["evidence-triage"] }],
    evidence_queries: [],
    hypotheses: [],
    actions: [],
    ...overrides,
    current_attempt: overrides.current_attempt || {
      attempt_id: "attempt-1",
      parent_attempt_id: null,
      current_stage: current,
      status: "ACTIVE",
      workflow_revision: 5,
      created_at: "2026-07-31T00:00:00Z",
      stage_runs: stageRuns
    }
  };
}

test("workbench renders one sparse stage, keeps future stages locked, and never leaks future output", () => {
  const value = projection();
  const view = workbenchViewV3(value, { reviewStage: null });
  const html = renderIncidentWorkbenchV3(value, { connection: "connected", now: Date.parse("2026-07-31T00:01:05Z") });

  assert.equal(view.visibleStage, "TRIAGE");
  assert.equal(view.reviewingHistory, false);
  assert.match(html, /data-active-stage="TRIAGE"/);
  assert.match(html, /Scope under review/);
  assert.doesNotMatch(html, /INVESTIGATE visible result|DECIDE visible result|RESPOND visible result|VERIFY visible result/);
  assert.match(html, /data-stage="INVESTIGATE"[^>]*disabled/);
  assert.match(html, /data-workflow-command="NEXT"/);
  assert.match(html, /data-open-panel="graph">Dataflow/);
  assert.match(html, /data-open-panel="metrics">Monitor/);
  assert.match(html, /data-open-panel="activity">Activity/);
  assert.doesNotMatch(html, /TRIAGE visible result|owner-local|<dt>Owner<\/dt>/);
  assert.match(html, /aria-labelledby="iw3-stage-title"/);
  assert.match(html, /<h3 id="iw3-stage-title">/);
});

test("Agent detail is hidden by default and Activity scopes it to the exact stage run", () => {
  const value = projection();
  const currentRun = value.current_attempt.stage_runs.at(-1);
  value.agent_activity = [
    { activity_id: "old", stage_run_id: "superseded-triage", stage: "TRIAGE", role: "OBSERVER", state: "SUCCEEDED", label: "Old run", summary: "OLD SUPERSEDED AGENT RESULT", occurred_at: "2026-07-31T00:00:20Z", evidence_refs: [] },
    { activity_id: "current", stage_run_id: currentRun.stage_run_id, stage: "TRIAGE", role: "OBSERVER", state: "SUCCEEDED", label: "Current run", summary: "CURRENT AGENT RESULT", occurred_at: "2026-07-31T00:00:21Z", evidence_refs: [] }
  ];

  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.doesNotMatch(html, /CURRENT AGENT RESULT/);
  assert.doesNotMatch(html, /OLD SUPERSEDED AGENT RESULT/);
  assert.match(html, /Observer · 0 evidence · Succeeded/);
  assert.match(html, /data-open-panel="activity">Activity/);

  const activity = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "activity" });
  assert.match(activity, /CURRENT AGENT RESULT/);
  assert.match(activity, /Current run/);
  assert.doesNotMatch(activity, /OLD SUPERSEDED AGENT RESULT/);
});

test("Investigate keeps query detail in Evidence while showing only compact current state", () => {
  const value = projection({ current_stage: "INVESTIGATE" });
  const run = value.current_attempt.stage_runs.at(-1);
  value.agent_activity = [{
    activity_id: "evidence-worker-1", agent_run_id: "agent-investigate-1", stage_run_id: run.stage_run_id,
    stage: "INVESTIGATE", role: "EVIDENCE_WORKER", state: "SUCCEEDED", label: "Evidence Worker",
    summary: "Allowlisted evidence query completed.", occurred_at: "2026-07-31T00:00:30Z", evidence_refs: ["otel-trace-1"]
  }];
  value.evidence_queries = [{
    schema_version: "flowpulse.evidence-query-result.v3", query_id: "query-1", attempt_id: "attempt-1",
    stage_run_id: run.stage_run_id, stage: "INVESTIGATE", worker_activity_id: "evidence-worker-1",
    query_name: "incident.current-signals.v1", state: "SUCCEEDED", parameters_hash: "sha256-query-1",
    result_summary: "Checkout cannot reach Payment in three fresh traces.", component_ids: ["checkout", "payment"],
    edge_ids: ["checkout-payment"], evidence_refs: ["otel-trace-1"],
    observation_timestamps: ["2026-07-31T00:00:28Z", "2026-07-31T00:00:30Z"], triggered_replan: true,
    started_at: "2026-07-31T00:00:25Z", completed_at: "2026-07-31T00:00:31Z", failure_code: null
  }];

  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.match(html, /1 query/);
  assert.match(html, /data-open-panel="evidence">Evidence/);
  assert.match(html, /data-open-panel="graph">Dataflow/);
  assert.doesNotMatch(html, /Evidence Worker queries|incident\.current-signals\.v1|Checkout cannot reach Payment in three fresh traces|Replan triggered/);
  assert.doesNotMatch(html, /data-inline-graph-node/);

  const drawer = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "evidence" });
  assert.match(drawer, /Worker activity/);
  assert.match(drawer, /otel-trace-1/);
  assert.match(drawer, /2026-07-31T00:00:30Z/);
});

test("Decide renders its preflight-bound candidate before any Respond action exists", () => {
  const value = projection({ current_stage: "DECIDE" });
  const run = value.current_attempt.stage_runs.at(-1);
  run.output = {
    summary: "Decision completed",
    facts: [{ label: "Flag", value: "paymentUnreachable=on" }],
    hypothesis_ids: [],
    action_ids: ["candidate-1"],
    action_candidate: {
      candidate_id: "candidate-1",
      command_id: "astronomy.restore-payment-and-recreate-checkout",
      component_id: "checkout",
      title: "Restore Payment reachability",
      summary: "Set the real local flag off and recreate Checkout.",
      blast_radius: "Checkout only",
      risk: "One bounded recreation",
      rollback_plan: "Use the independent safe recovery port",
      verification_conditions: ["Observe a fresh Checkout to Payment trace"],
      decision_revision: value.decision_revision
    }
  };
  value.actions = [];

  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.match(html, /Recommended action: Restore Payment reachability · Risk: bounded/);
  assert.match(html, /Risk: bounded/);
  assert.doesNotMatch(html, /astronomy\.restore-payment-and-recreate-checkout|Checkout only|Set the real local flag off/);
  assert.doesNotMatch(html, /No response candidate has been published/);
});

test("changed decision premises show an actionable rerun instead of a disabled Next loop", () => {
  const value = projection({ current_stage: "DECIDE" });
  const run = value.current_attempt.stage_runs.at(-1);
  Object.assign(run, { status: "FAILED", progress_percent: 100, failure_code: "REVALIDATION_REQUIRED", completed_at: "2026-07-31T00:01:10Z" });
  value.available_commands = ["RERUN_FROM_STAGE", "ESCALATE"];

  const html = renderIncidentWorkbenchV3(value, { connection: "degraded", error: "control_plane_revalidation_required" });
  assert.match(html, /Revalidation required/);
  assert.match(html, /data-workflow-command="RERUN_FROM_STAGE"/);
  assert.match(html, /Rerun from Decide/);
  assert.doesNotMatch(html, /data-workflow-command="NEXT"/);
});

test("failed post-action Verify offers a concrete diagnostic branch instead of a dead end", () => {
  const value = projection({ current_stage: "VERIFY" });
  const run = value.current_attempt.stage_runs.at(-1);
  Object.assign(run, {
    status: "NEEDS_HUMAN", progress_percent: 100, completed_at: "2026-07-31T00:02:00Z",
    failure_code: "verification_failed_action_safely_rolled_back"
  });
  value.available_commands = ["RERUN_FROM_STAGE", "ESCALATE"];
  value.available_rerun_stages = ["INVESTIGATE", "DECIDE"];

  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.match(html, /Rerun from Decide/);
  assert.match(html, /data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="DECIDE"/);
  assert.doesNotMatch(html, /data-workflow-command="COMPLETE_INCIDENT"/);
});

test("Verify hides execution records until the user opens Action details", () => {
  const value = projection({ current_stage: "VERIFY" });
  value.current_attempt.action_receipt_id = "receipt-1";
  value.actions = [{
    action_id: "action-1", attempt_id: "attempt-1", stage_run_id: "stage-run-5", status: "ROLLED_BACK",
    title: "Restore Payment and recreate Checkout", summary: "Bounded local recovery", component_id: "checkout",
    command_id: "astronomy.restore-payment-and-recreate-checkout", command_label: "Restore Payment and recreate Checkout",
    decision_revision: 3, required_permission: "incident.action.execute", approval_state: "APPROVED",
    execution_state: "ROLLED_BACK", blast_radius: "Local runtime", risk: "Checkout recreation",
    rollback_plan: "Restore prior local state", verification_conditions: ["Fresh trace"],
    receipt: {
      receipt_id: "receipt-1", status: "SUCCEEDED", output_summary: "Payment restored and Checkout recreated.",
      started_at: "2026-07-31T00:01:00Z", completed_at: "2026-07-31T00:01:05Z"
    },
    rollback_receipt: {
      rollback_receipt_id: "rollback-receipt-1", status: "ROLLED_BACK",
      output_summary: "Safe rollback restored the prior local fault state.",
      started_at: "2026-07-31T00:02:00Z", completed_at: "2026-07-31T00:02:03Z"
    }
  }];

  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.doesNotMatch(html, /Execution receipt|receipt-1|Safe rollback receipt|rollback-receipt-1/);

  const detail = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "action" });
  assert.match(detail, /Execution receipt/);
  assert.match(detail, /receipt-1/);
  assert.match(detail, /Safe rollback receipt/);
  assert.match(detail, /rollback-receipt-1/);
  assert.match(detail, /Safe rollback restored the prior local fault state/);
});

test("Verify publishes the backend-owned deadline and real signal cards show trend and observed window", () => {
  const value = projection({ current_stage: "VERIFY" });
  const run = value.current_attempt.stage_runs.at(-1);
  Object.assign(run, {
    status: "RUNNING",
    progress_percent: 40,
    completed_at: null,
    output: null,
    verification_deadline_at: "2026-07-31T00:02:00Z"
  });
  const series = {
    series: [{
      series_id: "checkout-errors", metric_key: "checkout.error_rate", component_id: "checkout",
      label: "Checkout error rate", unit: "percent", thresholds: { critical: 5 }, freshness: "CURRENT",
      observed_window_start: "2026-07-31T00:01:20Z", observed_window_end: "2026-07-31T00:01:40Z",
      points: [
        { timestamp: "2026-07-31T00:01:20Z", value: 8, evidence_refs: ["e1"] },
        { timestamp: "2026-07-31T00:01:40Z", value: 4, evidence_refs: ["e2"] }
      ]
    }, {
      series_id: "checkout-traffic", metric_key: "checkout.request_count", component_id: "checkout",
      label: "Checkout request count", unit: "requests", thresholds: { critical: null, warning: null }, freshness: "CURRENT",
      observed_window_start: "2026-07-31T00:01:20Z", observed_window_end: "2026-07-31T00:01:40Z",
      points: [{ timestamp: "2026-07-31T00:01:40Z", value: 1, evidence_refs: ["e3"] }]
    }]
  };

  const html = renderIncidentWorkbenchV3(value, {
    connection: "connected", series, now: Date.parse("2026-07-31T00:01:45Z")
  });
  assert.match(html, /data-verification-remaining data-deadline="2026-07-31T00:02:00Z">0m 15s/);
  assert.match(html, /Observing post-action telemetry · 0m 15s left/);
  assert.match(html, /data-series-id="checkout-errors" data-tone="healthy"/);
  assert.match(html, /data-series-id="checkout-traffic" data-tone="observed"/);
  assert.match(html, /iw3-signal-card-label">Errors<\/strong>|iw3-signal-card-label">Traffic<\/strong>/);
  assert.doesNotMatch(html, /data-trend="falling">Falling 50%|0m 20s window/);
  const monitor = renderIncidentWorkbenchV3(value, {
    connection: "connected", panel: "metrics", series, now: Date.parse("2026-07-31T00:01:45Z")
  });
  assert.match(monitor, /data-trend="falling">Falling 50%/);
  assert.match(monitor, /0m 20s window/);
  assert.match(monitor, /data-signal-visual="area"/);
  assert.match(monitor, /class="iw3-signal-viz is-area"/);
  assert.match(monitor, /class="iw3-signal-area"/);
  assert.match(monitor, /class="iw3-signal-dot"/);
  assert.deepEqual(metricTrendV3(series.series[0]), { direction: "falling", label: "Falling 50%" });
});

test("signal cards use evidence-backed visual grammars without fabricating a history", () => {
  const value = projection({ current_stage: "DETECT" });
  const series = {
    series: [{
      series_id: "checkout-errors", metric_key: "checkout.error_rate", component_id: "checkout",
      label: "Checkout error rate", unit: "ratio", thresholds: { critical: 0.05 }, freshness: "CURRENT",
      observed_window_start: "2026-07-31T00:01:20Z", observed_window_end: "2026-07-31T00:01:40Z",
      points: [
        { timestamp: "2026-07-31T00:01:20Z", value: 0.08, evidence_refs: ["e1"] },
        { timestamp: "2026-07-31T00:01:30Z", value: 0.06, evidence_refs: ["e2"] },
        { timestamp: "2026-07-31T00:01:40Z", value: 0.04, evidence_refs: ["e3"] }
      ]
    }, {
      series_id: "checkout-latency", metric_key: "checkout.mean_latency", component_id: "checkout",
      label: "Checkout mean latency", unit: "ms", thresholds: { warning: 500, critical: 1500 }, freshness: "CURRENT",
      observed_window_start: "2026-07-31T00:01:20Z", observed_window_end: "2026-07-31T00:01:40Z",
      points: [
        { timestamp: "2026-07-31T00:01:20Z", value: 900, evidence_refs: ["e4"] },
        { timestamp: "2026-07-31T00:01:30Z", value: 1100, evidence_refs: ["e5"] },
        { timestamp: "2026-07-31T00:01:40Z", value: 800, evidence_refs: ["e6"] }
      ]
    }, {
      series_id: "checkout-traffic", metric_key: "checkout.request_count", component_id: "checkout",
      label: "Checkout request count", unit: "requests", thresholds: {}, freshness: "CURRENT",
      observed_window_start: "2026-07-31T00:01:20Z", observed_window_end: "2026-07-31T00:01:40Z",
      points: [
        { timestamp: "2026-07-31T00:01:20Z", value: 12, evidence_refs: ["e7"] },
        { timestamp: "2026-07-31T00:01:30Z", value: null, missing_reason: "CONNECTOR_STALE", evidence_refs: [] },
        { timestamp: "2026-07-31T00:01:40Z", value: 28, evidence_refs: ["e8"] }
      ]
    }]
  };

  const html = renderIncidentWorkbenchV3(value, { connection: "connected", series });
  assert.match(html, /data-signal-visual="area"/);
  assert.match(html, /data-signal-visual="stems"/);
  assert.match(html, /data-signal-visual="tiles"/);
  assert.match(html, /data-signal-stem="0"/);
  assert.match(html, /data-signal-stem="2"/);
  assert.match(html, /data-signal-tile="0"/);
  assert.match(html, /data-signal-tile="2"/);
  assert.match(html, /iw3-signal-tile is-gap/);
  assert.doesNotMatch(html, /data-signal-tile="3"/);
  assert.match(html, /Live · 0m 20s/);
  assert.doesNotMatch(html, /Week|Month/);

  const portal = renderIncidentWorkbenchV3(value, {
    connection: "connected", series, portalOpen: true, componentId: "checkout", seriesId: "checkout-latency"
  });
  assert.match(portal, /Latest signal<\/span><strong>Latency 800 ms<\/strong>/);
  assert.match(portal, /Evidence<\/span><strong>1<\/strong><small>reference<\/small>/);
});

test("a completed incident keeps a compact visual summary and opens the immutable audit on demand", () => {
  const value = completedAuditProjection();
  const series = { series: [{
    series_id: "recovered-errors", metric_key: "checkout.error_rate", component_id: "checkout",
    label: "Recovered error rate", unit: "ratio", thresholds: { critical: 0.05 }, freshness: "STALE",
    observed_window_start: "2026-07-31T00:09:55Z", observed_window_end: "2026-07-31T00:10:02Z",
    points: [
      { timestamp: "2026-07-31T00:09:58Z", value: 0, freshness: "CURRENT", evidence_refs: ["e1"] },
      { timestamp: "2026-07-31T00:10:02Z", value: null, freshness: "STALE", missing_reason: "CONNECTOR_STALE", evidence_refs: [] }
    ]
  }] };
  const html = renderIncidentWorkbenchV3(value, { connection: "connected", series });

  assert.match(html, /data-audit-report="report-1"/);
  assert.match(html, /Resolved/);
  assert.match(html, /Recovered/);
  assert.match(html, />10m 00s</);
  assert.match(html, /data-open-panel="audit">Incident audit/);
  assert.doesNotMatch(html, /Agent room/);
  assert.match(html, /iw3-stage-rail/);
  assert.doesNotMatch(html, /Fresh Checkout to Payment trace observed|Payment dependency recovered/);
  assert.match(html, /iw3-signal-card-label">Errors<\/strong>/);
  assert.match(html, />0 ratio</);
  assert.doesNotMatch(html, /Connector Stale/);
  assert.doesNotMatch(html, /Attempt lineage|Immutable stage outputs|operator-local|receipt-1|evidence-verify-fresh/);
  assert.doesNotMatch(html, /data-workflow-command|Complete incident/);

  const history = renderIncidentWorkbenchV3(value, { connection: "connected", reviewStage: "DETECT", series });
  assert.match(history, /Checkout → Payment error elevated/);
  assert.doesNotMatch(history, /Rerun from this stage|Reviewing completed stage|DETECT visible result/);

  const audit = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "audit", series });
  assert.match(audit, /Immutable incident audit/);
  assert.match(audit, /Attempt lineage/);
  assert.match(audit, /Immutable stage outputs/);
  assert.match(audit, /operator-local/);
  assert.match(audit, /receipt-1/);
  assert.match(audit, /evidence-verify-fresh/);

  const graph = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "graph", componentId: "checkout", series });
  assert.match(graph, /Read-only/);
  assert.doesNotMatch(graph, /data-agent-investigate=/);
});

test("active stage rendering never exposes audit material from a later stage", () => {
  const value = projection({
    audit_records: [{
      audit_id: "untrusted-future-audit",
      record_type: "STAGE_COMPLETED",
      stage: "VERIFY",
      stage_output: { summary: "FUTURE SECRET ROOT CAUSE" }
    }]
  });
  const html = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.doesNotMatch(html, /FUTURE SECRET ROOT CAUSE|Immutable incident audit/);
});

test("completed stages are reviewable but locked and future stages cannot be selected", () => {
  const value = projection();
  assert.equal(workbenchViewV3(value, { reviewStage: "DETECT" }).visibleStage, "DETECT");
  assert.equal(workbenchViewV3(value, { reviewStage: "DETECT" }).reviewingHistory, true);
  assert.equal(workbenchViewV3(value, { reviewStage: "INVESTIGATE" }).visibleStage, "TRIAGE");

  const history = renderIncidentWorkbenchV3(value, { reviewStage: "DETECT", connection: "connected" });
  assert.match(history, /Checkout → Payment error elevated/);
  assert.match(history, /Rerun from this stage/);
  assert.doesNotMatch(history, /data-workflow-command="NEXT"/);
  assert.match(history, /data-stage="TRIAGE"[^>]*aria-current="step"/);
  assert.doesNotMatch(history.match(/data-stage="TRIAGE"[^>]*>/)?.[0] || "", /disabled/);
});

test("a newer telemetry series can render beside the current workflow projection", async () => {
  let projectionReads = 0;
  const client = {
    async projection() {
      projectionReads += 1;
      return projection({ signal_revision: 9 });
    },
    async series() {
      return { case_id: "case-checkout", signal_revision: 10, series: [] };
    }
  };
  const coherent = await loadCoherentIncidentV3(client, "case-checkout");
  assert.equal(projectionReads, 1);
  assert.equal(coherent.projection.signal_revision, 9);
  assert.equal(coherent.series.signal_revision, 10);
});

test("a lagging series is reread until it reaches the workflow projection", async () => {
  let seriesReads = 0;
  const client = {
    async projection() {
      return projection({ signal_revision: 10 });
    },
    async series() {
      seriesReads += 1;
      return { case_id: "case-checkout", signal_revision: seriesReads === 1 ? 9 : 10, series: [] };
    }
  };
  const coherent = await loadCoherentIncidentV3(client, "case-checkout");
  assert.equal(seriesReads, 2);
  assert.equal(coherent.series.signal_revision, 10);
});

test("a resolved incident accepts later series revisions because the UI freezes them at completion", async () => {
  let projectionReads = 0;
  const client = {
    async projection() {
      projectionReads += 1;
      return { ...completedAuditProjection(), signal_revision: 9 };
    },
    async series() {
      return { case_id: "case-checkout", signal_revision: 10, series: [] };
    }
  };
  const coherent = await loadCoherentIncidentV3(client, "case-checkout");
  assert.equal(projectionReads, 1);
  assert.equal(coherent.projection.lifecycle_state, "RESOLVED");
  assert.equal(coherent.series.signal_revision, 10);
});

test("Next, retry, rerun, and escalation commands bind canonical attempt and revision", () => {
  const value = projection();
  const base = {
    attempt_id: "attempt-1",
    expected_stage: "TRIAGE",
    expected_workflow_revision: 5
  };
  assert.deepEqual(buildWorkflowCommandV3(value, "NEXT", { idempotencyKey: "advance:attempt-1:5:triage" }), {
    ...base,
    idempotency_key: "advance:attempt-1:5:triage"
  });
  assert.deepEqual(buildWorkflowCommandV3(value, "RETRY", { idempotencyKey: "retry:attempt-1:5:triage" }), {
    ...base,
    idempotency_key: "retry:attempt-1:5:triage"
  });
  assert.deepEqual(buildWorkflowCommandV3(value, "RERUN_FROM_STAGE", { stage: "DETECT", reason: "New checkout trace", idempotencyKey: "rerun:attempt-1:5:detect" }), {
    ...base,
    reason: "New checkout trace",
    idempotency_key: "rerun:attempt-1:5:detect"
  });
  assert.deepEqual(buildWorkflowCommandV3(value, "ESCALATE", { reason: "Owner input required", idempotencyKey: "escalate:attempt-1:5:triage" }), {
    ...base,
    reason: "Owner input required",
    idempotency_key: "escalate:attempt-1:5:triage"
  });
});

test("workspace URL restores only canonical case, completed review, panel, and Portal state", () => {
  assert.deepEqual(parseIncidentWorkspaceUrlV3(new URL("https://flowpulse.test/?case_id=case-checkout&stage=DETECT&panel=graph&component=checkout&edge=checkout-payment&series=checkout-latency&portal=open&portal_tab=evidence")), {
    caseId: "case-checkout",
    reviewStage: "DETECT",
    panel: "graph",
    componentId: "checkout",
    edgeId: "checkout-payment",
    seriesId: "checkout-latency",
    portalOpen: true,
    portalTab: "evidence"
  });
  assert.deepEqual(parseIncidentWorkspaceUrlV3(new URL("https://flowpulse.test/?case_id=../../bad&stage=FUTURE&panel=debug&component=%2Fetc")), {
    caseId: null,
    reviewStage: null,
    panel: null,
    componentId: null,
    edgeId: null,
    seriesId: null,
    portalOpen: false,
    portalTab: "now"
  });
});

test("duration advances only within the backend freshness window and freezes stale", () => {
  const value = projection();
  assert.deepEqual(workbenchDurationV3(value, Date.parse("2026-07-31T00:01:05Z")), { elapsed_seconds: 65, freshness: "CURRENT" });
  assert.deepEqual(workbenchDurationV3(value, Date.parse("2026-07-31T00:02:00Z")), { elapsed_seconds: 90, freshness: "STALE" });
  assert.deepEqual(workbenchDurationV3({ ...value, incident_clock: { ...value.incident_clock, freshness: "STALE" } }, Date.parse("2026-07-31T00:01:05Z")), { elapsed_seconds: 60, freshness: "STALE" });
});

test("ordered SSE accepts the next sequence, ignores duplicates, and rehydrates on gaps", () => {
  const state = { lastSequence: 27, projectionRevision: 12 };
  assert.deepEqual(applyIncidentEventV3(state, { case_id: "case-checkout", sequence: 27, projection_revision: 12 }), { state, effect: null });
  assert.deepEqual(applyIncidentEventV3(state, { case_id: "case-checkout", sequence: 28, projection_revision: 13 }), {
    state: { lastSequence: 28, projectionRevision: 13 }, effect: "refresh"
  });
  assert.deepEqual(applyIncidentEventV3(state, { case_id: "case-checkout", sequence: 30, projection_revision: 14 }), {
    state, effect: "rehydrate"
  });
});

test("typed metric paths preserve gaps and never connect points across series", () => {
  const paths = metricSeriesPathsV3({
    series: [
      {
        series_id: "checkout-errors",
        unit: "percent",
        points: [
          { timestamp: "2026-07-31T00:00:00Z", value: 8.4, evidence_refs: ["e1"] },
          { timestamp: "2026-07-31T00:00:02Z", missing_reason: "scrape_timeout", evidence_refs: [] },
          { timestamp: "2026-07-31T00:00:04Z", value: 9.1, evidence_refs: ["e2"] }
        ]
      },
      {
        series_id: "payment-latency",
        unit: "ms",
        points: [
          { timestamp: "2026-07-31T00:00:00Z", value: 410, evidence_refs: ["e3"] },
          { timestamp: "2026-07-31T00:00:04Z", value: 520, evidence_refs: ["e4"] }
        ]
      }
    ]
  }, 200, 80);

  assert.deepEqual(paths.map((series) => series.seriesId), ["checkout-errors", "payment-latency"]);
  assert.equal(paths[0].segments.length, 2);
  assert.equal(paths[0].segments[0].length, 1);
  assert.equal(paths[0].segments[1].length, 1);
  assert.equal(paths[1].segments.length, 1);
  assert.equal(paths[1].segments[0].length, 2);
});

test("Investigate graph is an accessible modal without turning node review into an agent command", () => {
  const value = projection({ current_stage: "INVESTIGATE" });
  value.graph.nodes.push({ component_id: "catalog", display_name: "Catalog", runtime_status: "healthy", impact_status: "unaffected" });
  const html = renderIncidentWorkbenchV3(value, { connection: "connected", panel: "graph", componentId: "checkout", now: Date.parse("2026-07-31T00:01:05Z") });
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /data-graph-close/);
  assert.match(html, /data-graph-node="checkout"/);
  assert.match(html, /data-graph-node="payment"/);
  assert.match(html, /iw3-graph-dialog is-compact/);
  assert.match(html, /data-graph-layout="compact"/);
  assert.match(html, /data-graph-x="32" data-graph-y="50"/);
  assert.match(html, /data-graph-node="payment" data-graph-x="68" data-graph-y="50"/);
  assert.doesNotMatch(html, /data-graph-node="catalog"/);
  assert.doesNotMatch(html, /style="--x:/);
  assert.match(html, /class="iw3-graph-edge/);
  assert.match(html, /data-graph-edge="checkout-payment"/);
  assert.match(html, /marker-end="url\(#iw3-graph-arrow\)"/);
  assert.match(html, /class="iw3-graph-pulse/);
  assert.doesNotMatch(html, /No evidence-backed impact graph is available/);
  assert.match(html, /data-agent-investigate="checkout"/);
  assert.doesNotMatch(html.match(/data-graph-node="checkout"[^>]*>/)?.[0] || "", /data-agent-investigate/);
});

test("Dataflow never turns an adjacent but unimpacted component into the incident path", () => {
  const value = projection({ current_stage: "INVESTIGATE", impacted_path: ["checkout"] });
  const html = renderIncidentWorkbenchV3(value, {
    connection: "connected", panel: "graph", componentId: "checkout", now: Date.parse("2026-07-31T00:01:05Z")
  });
  assert.match(html, /data-graph-node="checkout"[^>]*data-graph-x="50" data-graph-y="50"/);
  assert.doesNotMatch(html, /No evidence-backed impact graph is available/);
  assert.doesNotMatch(html, /data-graph-node="payment"|data-graph-edge="checkout-payment"/);
});

test("Agent Portal stays hidden until a real component is selected and only exposes scoped evidence", () => {
  const value = projection();
  value.agent_activity = [{
    activity_id: "checkout-agent", agent_run_id: "agent-checkout", stage_run_id: "stage-run-2", stage: "TRIAGE",
    role: "OBSERVER", selected_component_id: "checkout", state: "SUCCEEDED", label: "Checkout review",
    summary: "Checkout error and dependency failure correlate.", occurred_at: "2026-07-31T00:00:30Z", evidence_refs: ["evidence-checkout"]
  }, {
    activity_id: "payment-agent", agent_run_id: "agent-payment", stage_run_id: "stage-run-2", stage: "TRIAGE",
    role: "OBSERVER", selected_component_id: "payment", state: "SUCCEEDED", label: "Payment review",
    summary: "PAYMENT ONLY", occurred_at: "2026-07-31T00:00:31Z", evidence_refs: ["evidence-payment"]
  }];
  value.evidence_queries = [{
    query_id: "query-checkout", stage_run_id: "stage-run-2", component_ids: ["checkout"], edge_ids: ["checkout-payment"],
    query_name: "incident.current-signals.v1", state: "SUCCEEDED", result_summary: "Checkout has fresh error evidence.", evidence_refs: ["evidence-checkout"]
  }];
  const series = { series: [{
    series_id: "checkout-errors", metric_key: "checkout.error_rate", component_id: "checkout",
    label: "Checkout error rate", unit: "ratio", thresholds: { warning: null, critical: 0.1 }, freshness: "CURRENT",
    points: [{ timestamp: "2026-07-31T00:00:30Z", value: 1, evidence_refs: ["metric-checkout"] }]
  }] };

  const closed = renderIncidentWorkbenchV3(value, { connection: "connected" });
  assert.doesNotMatch(closed, /class="iw3-agent-portal"|Checkout error and dependency failure correlate/);
  assert.match(closed, /data-component-select="checkout"/);
  assert.match(closed, /data-edge-select="checkout-payment"/);

  const portal = renderIncidentWorkbenchV3(value, {
    connection: "connected", series, portalOpen: true, componentId: "checkout", edgeId: "checkout-payment", portalTab: "evidence"
  });
  assert.match(portal, /Agent Portal/);
  assert.match(portal, /Checkout → Payment/);
  assert.match(portal, /Checkout has fresh error evidence/);
  assert.match(portal, /evidence-checkout/);
  assert.match(portal, /metric-checkout/);
  assert.doesNotMatch(portal, /PAYMENT ONLY|evidence-payment/);
  assert.match(portal, /data-agent-question/);
});

test("a historical Investigate graph remains inspectable but cannot start a current-stage Agent", () => {
  const value = projection({ current_stage: "RESPOND" });
  const html = renderIncidentWorkbenchV3(value, {
    connection: "connected", reviewStage: "INVESTIGATE", panel: "graph", componentId: "checkout"
  });
  assert.match(html, /Dataflow/);
  assert.match(html, /Historical graph · read-only/);
  assert.doesNotMatch(html, /data-agent-investigate=/);
});

test("Dataflow remains inspect-only outside the Investigate stage", () => {
  const html = renderIncidentWorkbenchV3(projection(), {
    connection: "connected", panel: "graph", componentId: "checkout", now: Date.parse("2026-07-31T00:01:05Z")
  });
  assert.doesNotMatch(html, /data-agent-investigate=/);
  assert.match(html, /Degraded · Impacted · Fresh/);
});

test("Dataflow turns stale immediately when the canonical clock expires", () => {
  const value = projection();
  const html = renderIncidentWorkbenchV3(value, {
    connection: "connected", panel: "graph", componentId: "checkout", now: Date.parse("2026-07-31T00:02:00Z")
  });
  assert.match(html, /iw3-graph-node is-stale/);
  assert.match(html, /iw3-graph-edge is-stale/);
  assert.doesNotMatch(html, /iw3-graph-pulse/);
});

test("projection refreshes coalesce while preserving one trailing refresh", async () => {
  const loop = new TrailingRefreshV3();
  let release;
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
  };
  const first = loop.request(operation);
  await Promise.resolve();
  const second = loop.request(operation);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("controller traps modal focus, closes on Escape, restores focus, and uses inert background", async () => {
  const source = await readFile(new URL("../public/incident-workbench-controller-v3.mjs", import.meta.url), "utf8");
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /setAttribute\("inert", ""\)/);
  assert.match(source, /querySelector\(this\.previousFocus\)\?\.focus\(\)/);
  assert.match(source, /workflow\.dataset\.rerunStage \|\| this\.ui\.reviewStage/);
  assert.match(source, /if \(this\.ui\.reviewStage \|\| this\.projection\.current_attempt\?\.current_stage !== "INVESTIGATE"/);
  assert.match(source, /node\.style\.left = `\$\{node\.dataset\.graphX\}%`/);
  assert.match(source, /node\.style\.top = `\$\{node\.dataset\.graphY\}%`/);
});

test("V3 stage shell owns viewport overflow and collapses safely at 451 by 859", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.iw3-controller-root, \.iw3-shell \{ width: 100%; height: 100%; min-width: 0; min-height: 0; \}/);
  assert.match(styles, /\.app-shell\[data-incident-workspace="v3"\] > main \{ display: grid; grid-template-rows: 64px minmax\(0, 1fr\); overflow: hidden; \}/);
  assert.match(styles, /\.iw3-stage-surface \{[^}]*min-width: 0;[^}]*overflow: auto;/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.iw3-stage-rail \{ display: flex; overflow-x: auto;/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.iw3-stage-grid, \.iw3-detect-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*#development-button \{ display: none !important; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.iw3-graph-edge\.is-active[^}]*animation: none;/);
});

test("URL-pinned Incident starts V3 directly while Live keeps a separate V3 incident adapter", async () => {
  const app = await readFile(new URL("../public/control-plane-app.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(app, /if \(state\.mode === "incident"\) void v3Workbench\.activate\(initialCaseId\)/);
  assert.match(app, /new LiveIncidentAdapterV3/);
  assert.match(app, /onOpen: openV3Incident/);
  assert.match(html, /id="v3-live-incidents"/);
  assert.match(html, /id="incident-workspace"/);
});

function completedAuditProjection() {
  const value = projection({ current_stage: "VERIFY" });
  value.lifecycle_state = "RESOLVED";
  value.incident_clock = { ...value.incident_clock, state: "RESOLVED" };
  value.current_attempt = {
    ...value.current_attempt,
    attempt_number: 1,
    status: "COMPLETED",
    created_reason: "INITIAL_INCIDENT_DETECTION",
    completed_at: "2026-07-31T00:10:00Z",
    action_executed: true,
    action_receipt_id: "receipt-1"
  };
  const verifyRun = value.current_attempt.stage_runs.find((run) => run.stage === "VERIFY");
  verifyRun.summary = "VERIFY immutable output";
  verifyRun.evidence_refs = ["evidence-verify-fresh"];
  verifyRun.output = { summary: "Payment dependency recovered", facts: ["Fresh Checkout to Payment trace observed"], evidence_refs: ["evidence-verify-fresh"] };
  value.available_commands = [];
  value.attempt_history = [];
  value.audit_records = [
    auditRecord("audit-stage-verify", "STAGE_COMPLETED", {
      stage: "VERIFY", stage_run_id: verifyRun.stage_run_id, summary: "VERIFY immutable output",
      evidence_refs: ["evidence-verify-fresh"], stage_output: structuredClone(verifyRun.output)
    }),
    auditRecord("audit-approval", "APPROVAL_RECORDED", {
      stage: "RESPOND", action_id: "action-1", actor_subject_id: "operator-local", approval_decision: "APPROVE",
      summary: "Operator approved the bounded local repair."
    }),
    auditRecord("audit-receipt", "ACTION_RECEIPT_RECORDED", {
      stage: "RESPOND", action_id: "action-1", summary: "Bounded local repair completed.",
      action_receipt: {
        schema_version: "flowpulse.action-execution-receipt.v3", receipt_id: "receipt-1", executor_id: "local-executor",
        command_id: "astronomy.restore-payment-and-recreate-checkout", status: "SUCCEEDED",
        started_at: "2026-07-31T00:08:00Z", completed_at: "2026-07-31T00:08:10Z",
        output_summary: "paymentUnreachable disabled and Checkout recreated", rollback_status: null
      }
    }),
    auditRecord("audit-verification", "VERIFICATION_RECORDED", {
      stage: "VERIFY", stage_run_id: verifyRun.stage_run_id, summary: "Payment dependency recovered",
      evidence_refs: ["evidence-verify-fresh"]
    }),
    auditRecord("audit-completed", "INCIDENT_COMPLETED", {
      stage: "VERIFY", stage_run_id: verifyRun.stage_run_id, summary: "Incident verification completed.",
      evidence_refs: ["evidence-verify-fresh"]
    })
  ];
  value.final_report = {
    schema_version: "flowpulse.incident-audit-report.v3",
    report_id: "report-1",
    attempt_id: value.current_attempt.attempt_id,
    attempt_lineage: [value.current_attempt.attempt_id],
    workflow_revision: value.workflow_revision,
    decision_revision: value.decision_revision,
    stage_output_audit_ids: ["audit-stage-verify"],
    action_receipt_audit_ids: ["audit-receipt"],
    verification_evidence_refs: ["evidence-verify-fresh"],
    generated_at: "2026-07-31T00:10:00Z",
    content_hash: "a".repeat(64)
  };
  return value;
}

function auditRecord(auditId, recordType, overrides = {}) {
  return {
    schema_version: "flowpulse.workflow-audit-record.v3",
    audit_id: auditId,
    record_type: recordType,
    attempt_id: "attempt-1",
    parent_attempt_id: null,
    stage: null,
    stage_run_id: null,
    action_id: null,
    actor_subject_id: null,
    workflow_revision: 5,
    decision_revision: 3,
    summary: "Recorded audit event.",
    evidence_refs: [],
    stage_output: null,
    approval_decision: null,
    action_receipt: null,
    rollback_receipt: null,
    recorded_at: "2026-07-31T00:10:00Z",
    ...overrides
  };
}

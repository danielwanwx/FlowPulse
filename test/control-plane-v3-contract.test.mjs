import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ControlPlaneV3ContractError,
  parseIncidentEventV3,
  parseIncidentProjectionV3,
  parseLiveSnapshotV3,
  parseMetricSeriesCollectionV3,
  parseWorkflowCommandReceiptV3
} from "../public/control-plane-v3-contract.mjs";

const examples = JSON.parse(readFileSync(new URL(
  "../control_plane/openapi/flowpulse-incident-workflow-v3.examples.json",
  import.meta.url
), "utf8"));

function validProjection() {
  return structuredClone(examples.projection);
}

test("checked-in V3 cross-language examples pass every browser parser", () => {
  assert.equal(examples.schema_version, "flowpulse.incident-workflow-v3.examples.v1");
  assert.deepEqual(parseIncidentProjectionV3(examples.projection), examples.projection);
  assert.deepEqual(parseLiveSnapshotV3(examples.live_snapshot), examples.live_snapshot);
  assert.deepEqual(parseMetricSeriesCollectionV3(examples.series, examples.projection.case_id), examples.series);
  assert.deepEqual(parseIncidentEventV3(examples.event, examples.projection.case_id), examples.event);
  assert.deepEqual(parseWorkflowCommandReceiptV3(examples.command_receipt, {
    caseId: examples.projection.case_id,
    attemptId: examples.projection.current_attempt.attempt_id
  }), examples.command_receipt);
});

test("Verify requires one backend-owned deadline and other stages forbid it", () => {
  const value = completedProjection();
  assert.deepEqual(parseIncidentProjectionV3(value), value);

  const missing = structuredClone(value);
  missing.current_attempt.stage_runs.at(-1).verification_deadline_at = null;
  assert.throws(() => parseIncidentProjectionV3(missing), /v3_verify_deadline_required/);

  const wrongStage = validProjection();
  wrongStage.current_attempt.stage_runs[0].verification_deadline_at = "2026-07-31T12:07:00Z";
  assert.throws(
    () => parseIncidentProjectionV3(wrongStage),
    /v3_stage_run_verification_deadline_stage_mismatch/,
  );
});

test("V3 projection accepts current and past runs while deriving future locked stages client-side", () => {
  const value = validProjection();
  const future = structuredClone(value.current_attempt.stage_runs.at(-1));
  Object.assign(future, {
    stage: "VERIFY", stage_run_id: "future", status: "LOCKED", progress_percent: 0,
    started_at: null, completed_at: null, summary: null, evidence_refs: [], output: null
  });
  value.current_attempt.stage_runs.push(future);
  assert.throws(() => parseIncidentProjectionV3(value), (error) => error instanceof ControlPlaneV3ContractError && error.code === "v3_future_stage_run_invalid");
});

test("V3 projection rejects identity drift, unknown command authority, and graph references outside canonical nodes", () => {
  const revision = validProjection();
  revision.current_attempt.workflow_revision += 1;
  assert.throws(() => parseIncidentProjectionV3(revision), /v3_attempt_revision_mismatch/);

  const command = validProjection();
  command.available_commands = ["SHELL_COMMAND"];
  assert.throws(() => parseIncidentProjectionV3(command), /v3_available_command_invalid/);

  const graph = validProjection();
  graph.graph.edges[0].target_component_id = "invented-service";
  assert.throws(() => parseIncidentProjectionV3(graph), /v3_graph_edge_node_invalid/);
});

test("V3 projection binds concrete rerun targets to backend command authority", () => {
  const missingTargets = validProjection();
  missingTargets.available_commands.push("RERUN_FROM_STAGE");
  assert.throws(() => parseIncidentProjectionV3(missingTargets), /v3_available_rerun_stages_command_mismatch/);

  const duplicateTargets = validProjection();
  duplicateTargets.available_commands.push("RERUN_FROM_STAGE");
  duplicateTargets.available_rerun_stages = ["TRIAGE", "TRIAGE"];
  assert.throws(() => parseIncidentProjectionV3(duplicateTargets), /v3_available_rerun_stages_invalid/);

  const concreteTargets = validProjection();
  concreteTargets.available_commands.push("RERUN_FROM_STAGE");
  concreteTargets.available_rerun_stages = ["DETECT", "TRIAGE"];
  assert.deepEqual(parseIncidentProjectionV3(concreteTargets), concreteTargets);
});

test("V3 graph accepts the canonical evidenced service arrow and scopes historical Agent activity to its stage run", () => {
  const value = validProjection();
  value.graph.edges[0].edge_id = "checkout->payment";
  value.graph.active_pulses = [{
    pulse_id: "pulse-checkout-payment",
    edge_ids: ["checkout->payment"],
    expires_at: "2026-07-31T12:00:30Z"
  }];

  const superseded = structuredClone(value.current_attempt.stage_runs[0]);
  Object.assign(superseded, {
    stage: "DECIDE",
    stage_run_id: "stage-run-superseded-decide",
    status: "SUPERSEDED",
    started_at: "2026-07-31T11:58:00Z",
    completed_at: "2026-07-31T11:59:00Z"
  });
  value.current_attempt.stage_runs.push(superseded);
  value.agent_activity = [{
    schema_version: "flowpulse.agent-activity.v3",
    activity_id: "activity-historical-decide",
    agent_run_id: "agent-historical-decide",
    stage_run_id: superseded.stage_run_id,
    stage: "DECIDE",
    role: "EVALUATOR",
    state: "SUCCEEDED",
    label: "Historical decision review",
    progress_percent: 100,
    summary: "Immutable superseded activity.",
    evidence_refs: ["evidence-a"],
    occurred_at: "2026-07-31T11:59:00Z",
    started_at: "2026-07-31T11:58:00Z",
    completed_at: "2026-07-31T11:59:00Z",
    failure_code: null
  }];

  assert.deepEqual(parseIncidentProjectionV3(value), value);
  const unbound = structuredClone(value);
  unbound.agent_activity[0].stage_run_id = "stage-run-unknown";
  assert.throws(() => parseIncidentProjectionV3(unbound), /v3_agent_activity_stage_run_invalid/);
});

test("Evidence Worker results are allowlisted, stage-run-affine, and topology-backed", () => {
  const value = validProjection();
  const run = value.current_attempt.stage_runs.at(-1);
  const edge = value.graph.edges[0];
  value.agent_activity.push({
    schema_version: "flowpulse.agent-activity.v3", activity_id: "evidence-worker-1", agent_run_id: "agent-run-1",
    stage_run_id: run.stage_run_id, stage: run.stage, role: "EVIDENCE_WORKER", state: "SUCCEEDED",
    label: "Evidence Worker", progress_percent: 100, summary: "Allowlisted query completed.",
    evidence_refs: ["evidence-query-1"], occurred_at: "2026-07-31T12:00:02Z",
    started_at: "2026-07-31T12:00:01Z", completed_at: "2026-07-31T12:00:02Z", failure_code: null
  });
  value.evidence_queries = [{
    schema_version: "flowpulse.evidence-query-result.v3", query_id: "query-1",
    attempt_id: value.current_attempt.attempt_id, stage_run_id: run.stage_run_id, stage: run.stage,
    worker_activity_id: "evidence-worker-1", query_name: "incident.current-signals.v1", state: "SUCCEEDED",
    parameters_hash: "sha256-query-1", result_summary: "Fresh Checkout and Payment evidence correlated.",
    component_ids: [value.graph.nodes[0].component_id], edge_ids: [edge.edge_id],
    evidence_refs: ["evidence-query-1"], observation_timestamps: ["2026-07-31T12:00:02Z"],
    triggered_replan: true, started_at: "2026-07-31T12:00:01Z", completed_at: "2026-07-31T12:00:02Z",
    failure_code: null
  }];
  assert.deepEqual(parseIncidentProjectionV3(value), value);

  const inventedTopology = structuredClone(value);
  inventedTopology.evidence_queries[0].component_ids = ["invented-service"];
  assert.throws(() => parseIncidentProjectionV3(inventedTopology), /v3_evidence_query_topology_invalid/);

  const unboundWorker = structuredClone(value);
  unboundWorker.evidence_queries[0].worker_activity_id = "missing-worker";
  assert.throws(() => parseIncidentProjectionV3(unboundWorker), /v3_evidence_query_scope_invalid/);
});

test("typed series require ordered numeric or explicit missing points and isolate case identity", () => {
  const value = structuredClone(examples.series);
  assert.deepEqual(parseMetricSeriesCollectionV3(value, value.case_id), value);

  const both = structuredClone(value);
  both.series[0].points[0].missing_reason = "scrape_timeout";
  assert.throws(() => parseMetricSeriesCollectionV3(both, value.case_id), /v3_metric_point_value_invalid/);
  const reordered = structuredClone(value);
  reordered.series[0].points.reverse();
  assert.throws(() => parseMetricSeriesCollectionV3(reordered, value.case_id), /v3_metric_point_sequence_invalid/);
  const outsideWindow = structuredClone(value);
  outsideWindow.series[0].observed_window_end = outsideWindow.series[0].points[1].timestamp;
  assert.throws(() => parseMetricSeriesCollectionV3(outsideWindow, value.case_id), /v3_metric_point_outside_window/);
  const missingSource = structuredClone(value);
  delete missingSource.series[0].source_connector_id;
  assert.throws(() => parseMetricSeriesCollectionV3(missingSource, value.case_id), /v3_metric_series_missing_field/);
  assert.throws(() => parseMetricSeriesCollectionV3(value, "case-other"), /v3_metric_case_mismatch/);
});

test("typed series accept Pydantic-style nullable value and missing_reason keys", () => {
  const value = structuredClone(examples.series);
  value.series[0].points = [
    { sequence: 1, timestamp: "2026-07-31T12:00:00Z", value: 8.4, missing_reason: null, evidence_refs: ["evidence-a"], freshness: "CURRENT" },
    { sequence: 2, timestamp: "2026-07-31T12:00:02Z", value: null, missing_reason: "connector_stale", evidence_refs: [], freshness: "STALE" }
  ];
  value.series[0].observed_window_start = value.series[0].points[0].timestamp;
  value.series[0].observed_window_end = value.series[0].points.at(-1).timestamp;
  value.series[0].freshness = value.series[0].points.at(-1).freshness;
  assert.deepEqual(parseMetricSeriesCollectionV3(value, value.case_id), value);

  const ambiguous = structuredClone(value);
  ambiguous.series[0].points[0].missing_reason = "also_missing";
  assert.throws(() => parseMetricSeriesCollectionV3(ambiguous, value.case_id), /v3_metric_point_value_invalid/);
});

test("completed projections validate immutable reports and every Python V3 audit enum", () => {
  const value = completedProjection();
  const parsed = parseIncidentProjectionV3(value);
  assert.deepEqual(parsed.final_report, value.final_report);
  assert.deepEqual(parsed.audit_records.slice(-2).map((record) => record.record_type), ["ESCALATION_RECORDED", "ROLLBACK_OUTCOME"]);

  const early = structuredClone(value);
  early.lifecycle_state = "ACTIVE";
  assert.throws(() => parseIncidentProjectionV3(early), /v3_final_report_scope_invalid/);

  const unknownAttemptState = validProjection();
  unknownAttemptState.current_attempt.status = "PAUSED";
  assert.throws(() => parseIncidentProjectionV3(unknownAttemptState), /v3_attempt_status_invalid/);

  const unknownActionState = completedProjection();
  unknownActionState.actions[0].execution_state = "CANCELLED";
  assert.throws(() => parseIncidentProjectionV3(unknownActionState), /v3_action_execution_state_invalid/);
});

test("safe rollback receipts are typed, action-bound, and immutable beside execution receipts", () => {
  const value = completedProjection();
  const action = value.actions[0];
  action.status = "ROLLED_BACK";
  action.execution_state = "ROLLED_BACK";
  action.rollback_receipt = {
    schema_version: "flowpulse.action-rollback-receipt.v3", rollback_receipt_id: "rollback-receipt-1",
    execution_key: "rollback-execution-1", action_id: action.action_id, command_id: action.command_id,
    status: "ROLLED_BACK", started_at: "2026-07-31T12:05:00Z", completed_at: "2026-07-31T12:05:03Z",
    output_summary: "The independent safe rollback port restored the prior local state."
  };
  assert.deepEqual(parseIncidentProjectionV3(value), value);

  const wrongAction = structuredClone(value);
  wrongAction.actions[0].rollback_receipt.action_id = "action-other";
  assert.throws(() => parseIncidentProjectionV3(wrongAction), /v3_action_rollback_receipt_scope_invalid/);
});

test("V3 incident events carry one ordered case sequence and bounded workflow progress", () => {
  const event = structuredClone(examples.event);
  assert.deepEqual(parseIncidentEventV3(event, event.case_id), event);
  assert.throws(() => parseIncidentEventV3({ ...event, progress: 101 }, event.case_id), /v3_event_progress_invalid/);
  assert.throws(() => parseIncidentEventV3({ ...event, case_id: "case-other" }, event.case_id), /v3_event_case_mismatch/);
  assert.equal(parseIncidentEventV3({ ...event, event_type: "evidence.query.completed" }, event.case_id).event_type, "evidence.query.completed");
});

function completedProjection() {
  const value = validProjection();
  const template = structuredClone(value.current_attempt.stage_runs[0]);
  const stages = ["DETECT", "TRIAGE", "INVESTIGATE", "DECIDE", "RESPOND", "VERIFY"];
  value.lifecycle_state = "RESOLVED";
  value.incident_clock.state = "RESOLVED";
  value.current_attempt = {
    ...value.current_attempt,
    current_stage: "VERIFY",
    status: "COMPLETED",
    completed_at: "2026-07-31T12:10:00Z",
    stage_runs: stages.map((stage, index) => ({
      ...structuredClone(template),
      stage,
      stage_run_id: `stage-run-${stage.toLowerCase()}`,
      status: "SUCCEEDED",
      progress_percent: 100,
      summary: `${stage} completed`,
      output: { summary: `${stage} completed`, facts: [], evidence_refs: [`evidence-${stage.toLowerCase()}`] },
      evidence_refs: [`evidence-${stage.toLowerCase()}`],
      started_at: `2026-07-31T12:0${index}:00Z`,
      verification_deadline_at: stage === "VERIFY" ? "2026-07-31T12:06:00Z" : null,
      completed_at: `2026-07-31T12:0${index}:30Z`
    }))
  };
  value.available_commands = [];
  const receipt = {
    schema_version: "flowpulse.action-execution-receipt.v3",
    receipt_id: "receipt-1",
    executor_id: "executor-local",
    command_id: "astronomy.restore-payment-and-recreate-checkout",
    status: "SUCCEEDED",
    started_at: "2026-07-31T12:04:00Z",
    completed_at: "2026-07-31T12:04:10Z",
    output_summary: "Bounded repair completed.",
    rollback_status: null
  };
  value.actions = [{
    schema_version: "flowpulse.incident-action.v3",
    action_id: "action-1",
    attempt_id: value.current_attempt.attempt_id,
    stage_run_id: "stage-run-respond",
    title: "Restore Payment and recreate Checkout",
    summary: "Run the bounded local repair.",
    component_id: "checkout",
    command_id: "astronomy.restore-payment-and-recreate-checkout",
    command_label: "Restore Payment and recreate Checkout",
    decision_revision: value.decision_revision,
    required_permission: "incident.action.execute",
    approval_state: "APPROVED",
    execution_state: "SUCCEEDED",
    status: "SUCCEEDED",
    blast_radius: "Local Astronomy Shop only",
    risk: "Checkout is recreated once",
    rollback_plan: "Restore the prior local fault state",
    verification_conditions: ["Observe a fresh Checkout to Payment trace"],
    receipt,
    rollback_receipt: null
  }];
  value.attempt_history = [];
  value.audit_records = [
    audit("audit-stage-verify", "STAGE_COMPLETED", {
      stage: "VERIFY", stage_run_id: "stage-run-verify", stage_output: structuredClone(value.current_attempt.stage_runs.at(-1).output), evidence_refs: ["evidence-verify"]
    }),
    audit("audit-receipt", "ACTION_RECEIPT_RECORDED", { stage: "RESPOND", action_id: "action-1", action_receipt: receipt }),
    audit("audit-escalation", "ESCALATION_RECORDED", { stage: "TRIAGE", summary: "Owner input was requested." }),
    audit("audit-rollback", "ROLLBACK_OUTCOME", { stage: "VERIFY", action_id: "action-1", summary: "Rollback was not required." })
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
    verification_evidence_refs: ["evidence-verify"],
    generated_at: "2026-07-31T12:10:00Z",
    content_hash: "a".repeat(64)
  };
  return value;
}

function audit(auditId, recordType, overrides = {}) {
  return {
    schema_version: "flowpulse.workflow-audit-record.v3",
    audit_id: auditId,
    record_type: recordType,
    attempt_id: validProjection().current_attempt.attempt_id,
    parent_attempt_id: null,
    stage: null,
    stage_run_id: null,
    action_id: null,
    actor_subject_id: null,
    workflow_revision: validProjection().workflow_revision,
    decision_revision: validProjection().decision_revision,
    summary: "Recorded audit event.",
    evidence_refs: [],
    stage_output: null,
    approval_decision: null,
    action_receipt: null,
    rollback_receipt: null,
    recorded_at: "2026-07-31T12:10:00Z",
    ...overrides
  };
}

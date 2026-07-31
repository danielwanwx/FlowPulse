import { INCIDENT_STAGES_V3, STAGE_STATES_V3, WORKFLOW_COMMANDS_V3 } from "./incident-v3-types.mjs";

const STAGES = new Set(INCIDENT_STAGES_V3);
const STAGE_STATES = new Set(STAGE_STATES_V3);
const COMMANDS = new Set(WORKFLOW_COMMANDS_V3);
const FRESHNESS = new Set(["CURRENT", "AGING", "STALE", "UNKNOWN"]);
const CLOCK_STATES = new Set(["RUNNING", "PAUSED", "RESOLVED"]);
const ACTIVITY_STATES = new Set(["READY", "RUNNING", "SUCCEEDED", "FAILED", "NEEDS_HUMAN"]);
const LIFECYCLE_STATES = new Set(["ACTIVE", "DEGRADED", "AWAITING_OWNER", "EXECUTING", "MONITORING", "RESOLVED", "NEEDS_HUMAN"]);
const ATTEMPT_STATES = new Set(["ACTIVE", "NEEDS_HUMAN", "COMPLETED", "SUPERSEDED"]);
const ACTION_APPROVAL_STATES = new Set(["PENDING", "APPROVED", "REJECTED", "REVALIDATION_REQUIRED"]);
const ACTION_EXECUTION_STATES = new Set(["NOT_STARTED", "RUNNING", "SUCCEEDED", "FAILED", "ROLLED_BACK", "NEEDS_HUMAN"]);
const ACTION_STATES = new Set(["AWAITING_APPROVAL", "APPROVED", "REJECTED", "EXECUTING", "SUCCEEDED", "FAILED", "REVALIDATION_REQUIRED", "ROLLED_BACK", "NEEDS_HUMAN"]);
const AUDIT_RECORD_TYPES = new Set([
  "ATTEMPT_CREATED", "STAGE_COMPLETED", "STAGE_FAILED", "STAGE_SUPERSEDED", "ATTEMPT_BRANCHED",
  "APPROVAL_RECORDED", "ACTION_RECEIPT_RECORDED", "VERIFICATION_RECORDED", "ESCALATION_RECORDED",
  "ROLLBACK_OUTCOME", "INCIDENT_COMPLETED"
]);
const TERMINAL_EXECUTION_STATES = new Set(["SUCCEEDED", "FAILED", "ROLLED_BACK", "NEEDS_HUMAN"]);
const EVIDENCE_QUERY_STATES = new Set(["RUNNING", "SUCCEEDED", "FAILED"]);
const EVIDENCE_QUERY_NAMES = new Set(["incident.current-signals.v1"]);
const EVENT_TYPES = new Set([
  "signal.observed", "signal.stale", "connector.health.changed", "graph.pulse.started", "graph.pulse.expired",
  "workflow.stage.started", "workflow.stage.progress", "workflow.stage.completed", "workflow.stage.failed",
  "workflow.advanced", "workflow.stage.superseded", "workflow.attempt.branched", "workflow.escalated",
  "agent.run.started", "agent.run.progress", "agent.run.completed", "agent.run.failed",
  "evidence.query.started", "evidence.query.completed", "evidence.query.failed",
  "action.proposed", "action.approved", "action.rejected", "action.started", "action.completed", "action.failed",
  "verification.started", "verification.completed", "verification.failed", "incident.completed"
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVIDENCED_EDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}->[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export class ControlPlaneV3ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ControlPlaneV3ContractError";
    this.code = code;
  }
}

export function parseIncidentProjectionV3(value) {
  object(value, "v3_projection_invalid");
  requiredKeys(value, [
    "schema_version", "tenant_id", "case_id", "incident_id", "run_id", "topology_revision",
    "projection_revision", "sequence", "signal_revision", "decision_revision", "workspace_revision", "workflow_revision",
    "title", "summary", "severity", "owner_subject_id", "lifecycle_state", "incident_clock", "freshness", "impacted_path", "graph",
    "connectors", "current_attempt", "available_commands", "available_rerun_stages", "agent_activity", "evidence_queries", "hypotheses", "actions", "generated_at"
  ], "v3_projection_missing_field");
  if (value.schema_version !== "flowpulse.incident-projection.v3") fail("v3_projection_schema_invalid");
  for (const key of ["tenant_id", "case_id", "incident_id", "run_id", "topology_revision", "owner_subject_id"]) id(value[key], `v3_${key}_invalid`);
  for (const key of ["projection_revision", "sequence", "signal_revision", "decision_revision", "workspace_revision", "workflow_revision"]) revision(value[key], `v3_${key}_invalid`);
  for (const key of ["title", "summary", "severity"]) text(value[key], `v3_${key}_invalid`, key === "summary" ? 4000 : 500);
  enumValue(value.lifecycle_state, LIFECYCLE_STATES, "v3_lifecycle_state_invalid");
  validateClock(value.incident_clock);
  validateFreshness(value.freshness);
  validateGraph(value.graph, value.impacted_path);
  validateConnectors(value.connectors);
  validateAttempt(value.current_attempt, value.workflow_revision);
  uniqueStrings(value.available_commands, 0, 16, "v3_available_commands_invalid");
  for (const command of value.available_commands) enumValue(command, COMMANDS, "v3_available_command_invalid");
  uniqueStrings(value.available_rerun_stages, 0, 6, "v3_available_rerun_stages_invalid");
  for (const stage of value.available_rerun_stages) enumValue(stage, STAGES, "v3_available_rerun_stage_invalid");
  if (Boolean(value.available_rerun_stages.length) !== value.available_commands.includes("RERUN_FROM_STAGE")) {
    fail("v3_available_rerun_stages_command_mismatch");
  }
  validateActivities(value.agent_activity, value.current_attempt, value.attempt_history ?? []);
  validateEvidenceQueries(
    value.evidence_queries, value.agent_activity, value.current_attempt,
    value.attempt_history ?? [], value.graph
  );
  array(value.hypotheses, 0, 64, "v3_hypotheses_invalid");
  for (const hypothesis of value.hypotheses) safeJson(hypothesis, "v3_hypothesis_invalid");
  validateActions(value.actions, value.decision_revision);
  validateAuditProjection(value);
  timestamp(value.generated_at, "v3_generated_at_invalid");
  return clone(value);
}

export function parseLiveSnapshotV3(value) {
  object(value, "v3_live_snapshot_invalid");
  requiredKeys(value, ["schema_version", "generated_at", "sequence", "incidents"], "v3_live_snapshot_missing_field");
  if (value.schema_version !== "flowpulse.live-snapshot.v3") fail("v3_live_snapshot_schema_invalid");
  timestamp(value.generated_at, "v3_live_snapshot_generated_at_invalid");
  nonnegative(value.sequence, "v3_live_snapshot_sequence_invalid");
  array(value.incidents, 0, 100, "v3_live_snapshot_incidents_invalid");
  const seen = new Set();
  for (const incident of value.incidents) {
    object(incident, "v3_live_incident_invalid");
    requiredKeys(incident, ["case_id", "incident_id", "run_id", "topology_revision", "projection_revision", "sequence", "title", "summary", "severity", "lifecycle_state", "freshness", "impacted_components", "current_stage"], "v3_live_incident_missing_field");
    for (const key of ["case_id", "incident_id", "run_id", "topology_revision"]) id(incident[key], `v3_live_${key}_invalid`);
    if (seen.has(incident.case_id)) fail("v3_live_incident_duplicate");
    seen.add(incident.case_id);
    for (const key of ["projection_revision", "sequence"]) revision(incident[key], `v3_live_${key}_invalid`);
    for (const key of ["title", "summary", "severity"]) text(incident[key], `v3_live_${key}_invalid`, 1000);
    enumValue(incident.lifecycle_state, LIFECYCLE_STATES, "v3_live_lifecycle_state_invalid");
    enumValue(incident.current_stage, STAGES, "v3_live_stage_invalid");
    validateFreshness(incident.freshness);
    uniqueStrings(incident.impacted_components, 1, 64, "v3_live_impacted_components_invalid");
  }
  return clone(value);
}

export function parseMetricSeriesCollectionV3(value, expectedCaseId = null) {
  object(value, "v3_metric_collection_invalid");
  requiredKeys(value, ["schema_version", "case_id", "signal_revision", "generated_at", "series"], "v3_metric_collection_missing_field");
  exactKeys(value, ["schema_version", "case_id", "signal_revision", "generated_at", "series"], "v3_metric_collection_extra_field");
  if (value.schema_version !== "flowpulse.metric-series-collection.v3") fail("v3_metric_collection_schema_invalid");
  id(value.case_id, "v3_metric_case_invalid");
  if (expectedCaseId && value.case_id !== expectedCaseId) fail("v3_metric_case_mismatch");
  revision(value.signal_revision, "v3_metric_signal_revision_invalid");
  timestamp(value.generated_at, "v3_metric_generated_at_invalid");
  array(value.series, 0, 16, "v3_metric_series_invalid");
  const ids = new Set();
  const semanticIds = new Set();
  for (const series of value.series) {
    object(series, "v3_metric_series_item_invalid");
    requiredKeys(series, [
      "schema_version", "series_id", "metric_key", "component_id", "label", "unit", "thresholds", "points",
      "observed_window_start", "observed_window_end", "freshness", "source_connector_id"
    ], "v3_metric_series_missing_field");
    exactKeys(series, [
      "schema_version", "series_id", "metric_key", "component_id", "label", "unit", "thresholds", "points",
      "observed_window_start", "observed_window_end", "freshness", "source_connector_id"
    ], "v3_metric_series_extra_field");
    if (series.schema_version !== "flowpulse.metric-series.v3") fail("v3_metric_series_schema_invalid");
    for (const key of ["series_id", "metric_key", "component_id", "source_connector_id"]) id(series[key], `v3_metric_${key}_invalid`);
    if (ids.has(series.series_id)) fail("v3_metric_series_duplicate");
    ids.add(series.series_id);
    const semanticId = `${series.metric_key}\u0000${series.component_id}\u0000${series.source_connector_id}`;
    if (semanticIds.has(semanticId)) fail("v3_metric_series_semantic_duplicate");
    semanticIds.add(semanticId);
    text(series.label, "v3_metric_label_invalid", 300);
    text(series.unit, "v3_metric_unit_invalid", 80);
    enumValue(series.freshness, FRESHNESS, "v3_metric_freshness_invalid");
    timestamp(series.observed_window_start, "v3_metric_window_start_invalid");
    timestamp(series.observed_window_end, "v3_metric_window_end_invalid");
    const windowStart = Date.parse(series.observed_window_start);
    const windowEnd = Date.parse(series.observed_window_end);
    if (windowEnd < windowStart) fail("v3_metric_window_invalid");
    object(series.thresholds, "v3_metric_thresholds_invalid");
    exactKeys(series.thresholds, ["warning", "critical"], "v3_metric_thresholds_extra_field");
    for (const key of ["warning", "critical"]) {
      if (series.thresholds[key] !== undefined && series.thresholds[key] !== null
        && (typeof series.thresholds[key] !== "number" || !Number.isFinite(series.thresholds[key]))) {
        fail("v3_metric_thresholds_invalid");
      }
    }
    if (typeof series.thresholds.warning === "number" && typeof series.thresholds.critical === "number"
      && series.thresholds.warning > series.thresholds.critical) fail("v3_metric_thresholds_invalid");
    array(series.points, 1, 360, "v3_metric_points_invalid");
    let previous = -Infinity;
    for (const [index, point] of series.points.entries()) {
      object(point, "v3_metric_point_invalid");
      requiredKeys(point, ["sequence", "timestamp", "evidence_refs", "freshness"], "v3_metric_point_missing_field");
      exactKeys(point, ["sequence", "timestamp", "interval_start_at", "value", "missing_reason", "evidence_refs", "freshness"], "v3_metric_point_extra_field");
      revision(point.sequence, "v3_metric_point_sequence_invalid");
      if (point.sequence !== index + 1) fail("v3_metric_point_sequence_invalid");
      timestamp(point.timestamp, "v3_metric_point_timestamp_invalid");
      const milliseconds = Date.parse(point.timestamp);
      if (point.interval_start_at !== undefined && point.interval_start_at !== null) {
        timestamp(point.interval_start_at, "v3_metric_point_interval_invalid");
        if (Date.parse(point.interval_start_at) > milliseconds) fail("v3_metric_point_interval_invalid");
      }
      if (milliseconds <= previous) fail("v3_metric_point_order_invalid");
      if (milliseconds < windowStart || milliseconds > windowEnd) fail("v3_metric_point_outside_window");
      previous = milliseconds;
      enumValue(point.freshness, FRESHNESS, "v3_metric_point_freshness_invalid");
      const hasValue = typeof point.value === "number" && Number.isFinite(point.value);
      const hasMissing = typeof point.missing_reason === "string" && Boolean(point.missing_reason.trim());
      if (hasValue === hasMissing) fail("v3_metric_point_value_invalid");
      if (hasMissing && point.missing_reason.length > 300) fail("v3_metric_point_missing_reason_invalid");
      if (hasMissing && point.freshness === "CURRENT") fail("v3_metric_point_freshness_invalid");
      if (point.value !== undefined && point.value !== null && !hasValue) fail("v3_metric_point_value_invalid");
      if (point.missing_reason !== undefined && point.missing_reason !== null && !hasMissing) fail("v3_metric_point_missing_reason_invalid");
      uniqueStrings(point.evidence_refs, hasValue ? 1 : 0, 32, "v3_metric_point_evidence_invalid");
    }
    if (windowStart !== Date.parse(series.points[0].timestamp)
      || windowEnd !== Date.parse(series.points.at(-1).timestamp)) fail("v3_metric_window_mismatch");
    if (series.freshness !== series.points.at(-1).freshness) fail("v3_metric_series_freshness_mismatch");
  }
  return clone(value);
}

export function parseIncidentEventV3(value, expectedCaseId = null) {
  object(value, "v3_event_invalid");
  requiredKeys(value, ["schema_version", "event_id", "tenant_id", "case_id", "sequence", "event_type", "occurred_at", "projection_revision", "workflow_revision"], "v3_event_missing_field");
  if (value.schema_version !== "flowpulse.incident-event.v3") fail("v3_event_schema_invalid");
  for (const key of ["event_id", "tenant_id", "case_id"]) id(value[key], `v3_event_${key}_invalid`);
  if (expectedCaseId && value.case_id !== expectedCaseId) fail("v3_event_case_mismatch");
  for (const key of ["sequence", "projection_revision", "workflow_revision"]) revision(value[key], `v3_event_${key}_invalid`);
  enumValue(value.event_type, EVENT_TYPES, "v3_event_type_invalid");
  timestamp(value.occurred_at, "v3_event_occurred_at_invalid");
  for (const key of ["attempt_id", "stage_run_id"]) if (value[key] !== undefined && value[key] !== null) id(value[key], `v3_event_${key}_invalid`);
  if (value.stage !== undefined && value.stage !== null) enumValue(value.stage, STAGES, "v3_event_stage_invalid");
  if (value.summary !== undefined && value.summary !== null) text(value.summary, "v3_event_summary_invalid", 4000);
  if (value.progress !== undefined && (!Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100)) fail("v3_event_progress_invalid");
  if (value.evidence_refs !== undefined) uniqueStrings(value.evidence_refs, 0, 64, "v3_event_evidence_invalid");
  return clone(value);
}

export function parseLiveEventV3(value) {
  object(value, "v3_live_event_invalid");
  requiredKeys(value, ["schema_version", "event_id", "sequence", "event_type", "occurred_at", "incident"], "v3_live_event_missing_field");
  if (value.schema_version !== "flowpulse.live-event.v3") fail("v3_live_event_schema_invalid");
  id(value.event_id, "v3_live_event_id_invalid");
  revision(value.sequence, "v3_live_event_sequence_invalid");
  text(value.event_type, "v3_live_event_type_invalid", 160);
  timestamp(value.occurred_at, "v3_live_event_occurred_at_invalid");
  const snapshot = parseLiveSnapshotV3({ schema_version: "flowpulse.live-snapshot.v3", generated_at: value.occurred_at, sequence: value.sequence, incidents: [value.incident] });
  return { ...clone(value), incident: snapshot.incidents[0] };
}

export function parseWorkflowCommandReceiptV3(value, expected = {}) {
  object(value, "v3_command_receipt_invalid");
  requiredKeys(value, ["schema_version", "command_id", "command_name", "accepted", "reused", "reason", "actor_subject_id", "attempt_id", "workflow_revision", "projection", "recorded_at"], "v3_command_receipt_missing_field");
  if (value.schema_version !== "flowpulse.workflow-command-receipt.v3") fail("v3_command_receipt_schema_invalid");
  for (const key of ["command_id", "command_name", "actor_subject_id", "attempt_id"]) id(value[key], `v3_command_receipt_${key}_invalid`);
  if (value.accepted !== true || typeof value.reused !== "boolean") fail("v3_command_receipt_status_invalid");
  if (value.reason !== null) text(value.reason, "v3_command_receipt_reason_invalid", 500);
  revision(value.workflow_revision, "v3_command_receipt_revision_invalid");
  timestamp(value.recorded_at, "v3_command_receipt_recorded_at_invalid");
  const projection = parseIncidentProjectionV3(value.projection);
  if (expected.caseId && projection.case_id !== expected.caseId) fail("v3_command_receipt_case_mismatch");
  if (expected.attemptId && value.attempt_id !== expected.attemptId) fail("v3_command_receipt_attempt_mismatch");
  if (value.workflow_revision !== projection.workflow_revision) fail("v3_command_receipt_projection_revision_mismatch");
  return { ...clone(value), projection };
}

function validateAttempt(attempt, workflowRevision) {
  object(attempt, "v3_attempt_invalid");
  requiredKeys(attempt, ["attempt_id", "parent_attempt_id", "current_stage", "status", "workflow_revision", "created_at", "stage_runs"], "v3_attempt_missing_field");
  id(attempt.attempt_id, "v3_attempt_id_invalid");
  if (attempt.parent_attempt_id !== null) id(attempt.parent_attempt_id, "v3_parent_attempt_id_invalid");
  enumValue(attempt.current_stage, STAGES, "v3_current_stage_invalid");
  enumValue(attempt.status, ATTEMPT_STATES, "v3_attempt_status_invalid");
  revision(attempt.workflow_revision, "v3_attempt_workflow_revision_invalid");
  if (attempt.workflow_revision !== workflowRevision) fail("v3_attempt_revision_mismatch");
  timestamp(attempt.created_at, "v3_attempt_created_at_invalid");
  array(attempt.stage_runs, 1, 100, "v3_stage_runs_invalid");
  const currentIndex = INCIDENT_STAGES_V3.indexOf(attempt.current_stage);
  let currentFound = false;
  for (const run of attempt.stage_runs) {
    object(run, "v3_stage_run_invalid");
    requiredKeys(run, ["stage", "stage_run_id", "status", "progress_percent", "started_at", "verification_deadline_at", "completed_at", "summary", "evidence_refs", "output"], "v3_stage_run_missing_field");
    enumValue(run.stage, STAGES, "v3_stage_run_stage_invalid");
    if (INCIDENT_STAGES_V3.indexOf(run.stage) > currentIndex && run.status !== "SUPERSEDED") fail("v3_future_stage_run_invalid");
    if (run.stage === attempt.current_stage) currentFound = true;
    id(run.stage_run_id, "v3_stage_run_id_invalid");
    enumValue(run.status, STAGE_STATES, "v3_stage_run_status_invalid");
    if (!Number.isInteger(run.progress_percent) || run.progress_percent < 0 || run.progress_percent > 100) fail("v3_stage_run_progress_invalid");
    for (const key of ["started_at", "completed_at"]) if (run[key] !== null) timestamp(run[key], `v3_stage_run_${key}_invalid`);
    if (run.stage === "VERIFY") {
      if (run.verification_deadline_at === null) fail("v3_verify_deadline_required");
      timestamp(run.verification_deadline_at, "v3_stage_run_verification_deadline_invalid");
      if (run.started_at === null
        || Date.parse(run.verification_deadline_at) <= Date.parse(run.started_at)) {
        fail("v3_stage_run_verification_deadline_invalid");
      }
    } else if (run.verification_deadline_at !== null) {
      fail("v3_stage_run_verification_deadline_stage_mismatch");
    }
    if (run.summary !== null) text(run.summary, "v3_stage_run_summary_invalid", 4000);
    uniqueStrings(run.evidence_refs, 0, 256, "v3_stage_run_evidence_invalid");
    safeJson(run.output, "v3_stage_run_output_invalid");
  }
  if (!currentFound) fail("v3_current_stage_run_missing");
}

function validateClock(clock) {
  object(clock, "v3_clock_invalid");
  requiredKeys(clock, ["state", "started_at", "as_of", "elapsed_seconds", "freshness", "fresh_until", "max_interpolation_seconds"], "v3_clock_missing_field");
  enumValue(clock.state, CLOCK_STATES, "v3_clock_state_invalid");
  enumValue(clock.freshness, FRESHNESS, "v3_clock_freshness_invalid");
  for (const key of ["started_at", "as_of", "fresh_until"]) timestamp(clock[key], `v3_clock_${key}_invalid`);
  nonnegative(clock.elapsed_seconds, "v3_clock_elapsed_invalid");
  if (!Number.isSafeInteger(clock.max_interpolation_seconds) || clock.max_interpolation_seconds < 0 || clock.max_interpolation_seconds > 60) fail("v3_clock_interpolation_invalid");
}

function validateFreshness(value) {
  object(value, "v3_freshness_invalid");
  requiredKeys(value, ["state", "observed_at", "fresh_until"], "v3_freshness_missing_field");
  enumValue(value.state, FRESHNESS, "v3_freshness_state_invalid");
  timestamp(value.observed_at, "v3_freshness_observed_at_invalid");
  timestamp(value.fresh_until, "v3_freshness_until_invalid");
}

function validateGraph(graph, impactedPath) {
  object(graph, "v3_graph_invalid");
  requiredKeys(graph, ["nodes", "edges", "active_pulses"], "v3_graph_missing_field");
  array(graph.nodes, 1, 200, "v3_graph_nodes_invalid");
  array(graph.edges, 0, 500, "v3_graph_edges_invalid");
  array(graph.active_pulses, 0, 128, "v3_graph_pulses_invalid");
  const nodes = new Set();
  for (const node of graph.nodes) {
    object(node, "v3_graph_node_invalid");
    requiredKeys(node, ["component_id", "display_name", "runtime_status", "impact_status"], "v3_graph_node_missing_field");
    id(node.component_id, "v3_graph_component_invalid");
    if (nodes.has(node.component_id)) fail("v3_graph_component_duplicate");
    nodes.add(node.component_id);
    for (const key of ["display_name", "runtime_status", "impact_status"]) text(node[key], `v3_graph_node_${key}_invalid`, 500);
  }
  const edges = new Set();
  for (const edge of graph.edges) {
    object(edge, "v3_graph_edge_invalid");
    requiredKeys(edge, ["edge_id", "source_component_id", "target_component_id", "status"], "v3_graph_edge_missing_field");
    graphId(edge.edge_id, "v3_graph_edge_edge_id_invalid");
    for (const key of ["source_component_id", "target_component_id"]) id(edge[key], `v3_graph_edge_${key}_invalid`);
    if (edges.has(edge.edge_id)) fail("v3_graph_edge_duplicate");
    edges.add(edge.edge_id);
    if (!nodes.has(edge.source_component_id) || !nodes.has(edge.target_component_id)) fail("v3_graph_edge_node_invalid");
    text(edge.status, "v3_graph_edge_status_invalid", 160);
  }
  uniqueStrings(impactedPath, 1, 64, "v3_impacted_path_invalid");
  if (impactedPath.some((component) => !nodes.has(component))) fail("v3_impacted_path_node_invalid");
  for (const pulse of graph.active_pulses) {
    object(pulse, "v3_graph_pulse_invalid");
    requiredKeys(pulse, ["pulse_id", "edge_ids", "expires_at"], "v3_graph_pulse_missing_field");
    id(pulse.pulse_id, "v3_graph_pulse_id_invalid");
    uniqueGraphIds(pulse.edge_ids, 1, 64, "v3_graph_pulse_edges_invalid");
    if (pulse.edge_ids.some((edge) => !edges.has(edge))) fail("v3_graph_pulse_edge_invalid");
    timestamp(pulse.expires_at, "v3_graph_pulse_expiry_invalid");
  }
}

function validateConnectors(connectors) {
  array(connectors, 0, 32, "v3_connectors_invalid");
  for (const connector of connectors) {
    object(connector, "v3_connector_invalid");
    requiredKeys(connector, ["connector_id", "provider", "state", "observed_at"], "v3_connector_missing_field");
    id(connector.connector_id, "v3_connector_id_invalid");
    for (const key of ["provider", "state"]) text(connector[key], `v3_connector_${key}_invalid`, 160);
    timestamp(connector.observed_at, "v3_connector_observed_at_invalid");
  }
}

function validateActivities(activities, currentAttempt, attemptHistory) {
  array(activities, 0, 500, "v3_agent_activity_invalid");
  const runs = new Map(
    [...attemptHistory, currentAttempt].flatMap((attempt) =>
      attempt.stage_runs.map((run) => [run.stage_run_id, run])
    )
  );
  for (const activity of activities) {
    object(activity, "v3_agent_activity_item_invalid");
    requiredKeys(activity, ["activity_id", "agent_run_id", "stage_run_id", "stage", "state", "label", "summary", "occurred_at", "evidence_refs"], "v3_agent_activity_missing_field");
    for (const key of ["activity_id", "agent_run_id", "stage_run_id"]) id(activity[key], `v3_agent_activity_${key}_invalid`);
    enumValue(activity.stage, STAGES, "v3_agent_activity_stage_invalid");
    const run = runs.get(activity.stage_run_id);
    if (!run || run.stage !== activity.stage) fail("v3_agent_activity_stage_run_invalid");
    enumValue(activity.state, ACTIVITY_STATES, "v3_agent_activity_state_invalid");
    for (const key of ["label", "summary"]) text(activity[key], `v3_agent_activity_${key}_invalid`, 4000);
    timestamp(activity.occurred_at, "v3_agent_activity_occurred_at_invalid");
    uniqueStrings(activity.evidence_refs, 0, 256, "v3_agent_activity_evidence_invalid");
  }
}

function validateActions(actions, decisionRevision) {
  array(actions, 0, 100, "v3_actions_invalid");
  for (const action of actions) {
    object(action, "v3_action_invalid");
    requiredKeys(action, [
      "action_id", "attempt_id", "stage_run_id", "status", "title", "summary", "component_id", "command_id", "command_label",
      "decision_revision", "required_permission", "approval_state", "execution_state", "blast_radius", "risk", "rollback_plan",
      "verification_conditions", "receipt", "rollback_receipt"
    ], "v3_action_missing_field");
    for (const key of ["action_id", "attempt_id", "stage_run_id", "component_id", "command_id", "required_permission"]) id(action[key], `v3_action_${key}_invalid`);
    for (const key of ["title", "summary", "command_label", "blast_radius", "risk", "rollback_plan"]) text(action[key], `v3_action_${key}_invalid`, 4000);
    enumValue(action.status, ACTION_STATES, "v3_action_status_invalid");
    enumValue(action.approval_state, ACTION_APPROVAL_STATES, "v3_action_approval_state_invalid");
    enumValue(action.execution_state, ACTION_EXECUTION_STATES, "v3_action_execution_state_invalid");
    uniqueTexts(action.verification_conditions, 1, 32, "v3_action_verification_conditions_invalid", 1000);
    revision(action.decision_revision, "v3_action_decision_revision_invalid");
    if (action.decision_revision > decisionRevision) fail("v3_action_decision_revision_mismatch");
    if (action.receipt !== null) validateActionReceipt(action.receipt);
    if (action.rollback_receipt !== null) {
      validateActionRollbackReceipt(action.rollback_receipt);
      if (action.rollback_receipt.action_id !== action.action_id
        || action.rollback_receipt.command_id !== action.command_id) fail("v3_action_rollback_receipt_scope_invalid");
    }
    if ((action.execution_state === "ROLLED_BACK") !== (action.rollback_receipt !== null)) fail("v3_action_rollback_receipt_state_invalid");
    safeJson(action, "v3_action_payload_invalid");
  }
}

function validateEvidenceQueries(queries, activities, currentAttempt, attemptHistory, graph) {
  array(queries, 0, 128, "v3_evidence_queries_invalid");
  const attempts = new Map([...attemptHistory, currentAttempt].map((attempt) => [attempt.attempt_id, attempt]));
  const runs = new Map([...attempts.values()].flatMap((attempt) =>
    attempt.stage_runs.map((run) => [run.stage_run_id, { ...run, attempt_id: attempt.attempt_id }])
  ));
  const workers = new Map(activities.map((activity) => [activity.activity_id, activity]));
  const nodeIds = new Set((graph?.nodes || []).map((node) => node.component_id));
  const edgeIds = new Set((graph?.edges || []).map((edge) => edge.edge_id));
  const queryIds = new Set();
  for (const query of queries) {
    object(query, "v3_evidence_query_invalid");
    requiredKeys(query, [
      "schema_version", "query_id", "attempt_id", "stage_run_id", "stage", "worker_activity_id",
      "query_name", "state", "parameters_hash", "result_summary", "component_ids", "edge_ids",
      "evidence_refs", "observation_timestamps", "triggered_replan", "started_at", "completed_at", "failure_code"
    ], "v3_evidence_query_missing_field");
    if (query.schema_version !== "flowpulse.evidence-query-result.v3") fail("v3_evidence_query_schema_invalid");
    for (const key of ["query_id", "attempt_id", "stage_run_id", "worker_activity_id", "parameters_hash"]) id(query[key], `v3_evidence_query_${key}_invalid`);
    if (queryIds.has(query.query_id)) fail("v3_evidence_query_duplicate");
    queryIds.add(query.query_id);
    enumValue(query.stage, STAGES, "v3_evidence_query_stage_invalid");
    enumValue(query.query_name, EVIDENCE_QUERY_NAMES, "v3_evidence_query_name_invalid");
    enumValue(query.state, EVIDENCE_QUERY_STATES, "v3_evidence_query_state_invalid");
    text(query.result_summary, "v3_evidence_query_summary_invalid", 4000);
    uniqueStrings(query.component_ids, 0, 64, "v3_evidence_query_components_invalid");
    uniqueGraphIds(query.edge_ids, 0, 128, "v3_evidence_query_edges_invalid");
    uniqueStrings(query.evidence_refs, 0, 128, "v3_evidence_query_evidence_invalid");
    array(query.observation_timestamps, 0, 128, "v3_evidence_query_observations_invalid");
    for (const observedAt of query.observation_timestamps) timestamp(observedAt, "v3_evidence_query_observation_invalid");
    if (new Set(query.observation_timestamps).size !== query.observation_timestamps.length) fail("v3_evidence_query_observation_duplicate");
    if (typeof query.triggered_replan !== "boolean") fail("v3_evidence_query_replan_invalid");
    timestamp(query.started_at, "v3_evidence_query_started_at_invalid");
    if (query.completed_at !== null) timestamp(query.completed_at, "v3_evidence_query_completed_at_invalid");
    if (query.failure_code !== null) text(query.failure_code, "v3_evidence_query_failure_invalid", 500);
    const run = runs.get(query.stage_run_id);
    const worker = workers.get(query.worker_activity_id);
    if (!attempts.has(query.attempt_id) || !run || run.attempt_id !== query.attempt_id || run.stage !== query.stage
      || !worker || worker.stage_run_id !== query.stage_run_id || worker.role !== "EVIDENCE_WORKER") fail("v3_evidence_query_scope_invalid");
    if (query.component_ids.some((component) => !nodeIds.has(component))
      || query.edge_ids.some((edge) => !edgeIds.has(edge))) fail("v3_evidence_query_topology_invalid");
    if (query.completed_at !== null && Date.parse(query.completed_at) < Date.parse(query.started_at)) fail("v3_evidence_query_interval_invalid");
    if (query.state === "RUNNING" && (query.completed_at !== null || query.failure_code !== null || query.triggered_replan)) fail("v3_evidence_query_running_state_invalid");
    if (query.state === "SUCCEEDED" && (query.completed_at === null || query.failure_code !== null || !query.evidence_refs.length || !query.observation_timestamps.length)) fail("v3_evidence_query_success_state_invalid");
    if (query.state === "FAILED" && (query.completed_at === null || query.failure_code === null || query.triggered_replan)) fail("v3_evidence_query_failed_state_invalid");
  }
}

function validateAuditProjection(projection) {
  const history = projection.attempt_history ?? [];
  array(history, 0, 31, "v3_attempt_history_invalid");
  const attempts = new Map([[projection.current_attempt.attempt_id, projection.current_attempt]]);
  for (const attempt of history) {
    validateAttempt(attempt, attempt.workflow_revision);
    if (attempts.has(attempt.attempt_id)) fail("v3_attempt_history_identity_invalid");
    attempts.set(attempt.attempt_id, attempt);
  }
  for (const attempt of attempts.values()) {
    if (attempt.parent_attempt_id !== null && !attempts.has(attempt.parent_attempt_id)) fail("v3_attempt_parent_unknown");
  }

  const records = projection.audit_records ?? [];
  array(records, 0, 256, "v3_audit_records_invalid");
  const auditIds = new Set();
  for (const record of records) {
    validateAuditRecord(record);
    if (auditIds.has(record.audit_id)) fail("v3_audit_record_identity_invalid");
    if (!attempts.has(record.attempt_id)) fail("v3_audit_attempt_unknown");
    auditIds.add(record.audit_id);
  }

  const report = projection.final_report ?? null;
  if (report === null) return;
  object(report, "v3_final_report_invalid");
  requiredKeys(report, [
    "schema_version", "report_id", "attempt_id", "attempt_lineage", "workflow_revision", "decision_revision",
    "stage_output_audit_ids", "action_receipt_audit_ids", "verification_evidence_refs", "generated_at", "content_hash"
  ], "v3_final_report_missing_field");
  if (report.schema_version !== "flowpulse.incident-audit-report.v3") fail("v3_final_report_schema_invalid");
  for (const key of ["report_id", "attempt_id", "content_hash"]) id(report[key], `v3_final_report_${key}_invalid`);
  for (const key of ["workflow_revision", "decision_revision"]) revision(report[key], `v3_final_report_${key}_invalid`);
  uniqueStrings(report.attempt_lineage, 1, 32, "v3_final_report_lineage_invalid");
  uniqueStrings(report.stage_output_audit_ids, 1, 64, "v3_final_report_stage_audits_invalid");
  uniqueStrings(report.action_receipt_audit_ids, 1, 32, "v3_final_report_receipt_audits_invalid");
  uniqueStrings(report.verification_evidence_refs, 1, 128, "v3_final_report_verification_evidence_invalid");
  timestamp(report.generated_at, "v3_final_report_generated_at_invalid");
  if (projection.lifecycle_state !== "RESOLVED" || projection.current_attempt.status !== "COMPLETED"
    || report.attempt_id !== projection.current_attempt.attempt_id
    || report.workflow_revision !== projection.workflow_revision
    || report.decision_revision !== projection.decision_revision
    || report.attempt_lineage.at(-1) !== report.attempt_id
    || report.attempt_lineage.some((attemptId) => !attempts.has(attemptId))
    || report.stage_output_audit_ids.some((auditId) => !auditIds.has(auditId))
    || report.action_receipt_audit_ids.some((auditId) => !auditIds.has(auditId))) fail("v3_final_report_scope_invalid");
  const byId = new Map(records.map((record) => [record.audit_id, record]));
  if (report.stage_output_audit_ids.some((auditId) => !byId.get(auditId)?.stage_output)
    || report.action_receipt_audit_ids.some((auditId) => !byId.get(auditId)?.action_receipt)) fail("v3_final_report_material_invalid");
}

function validateAuditRecord(record) {
  object(record, "v3_audit_record_invalid");
  requiredKeys(record, [
    "schema_version", "audit_id", "record_type", "attempt_id", "workflow_revision", "decision_revision",
    "summary", "evidence_refs", "recorded_at"
  ], "v3_audit_record_missing_field");
  if (record.schema_version !== "flowpulse.workflow-audit-record.v3") fail("v3_audit_record_schema_invalid");
  for (const key of ["audit_id", "attempt_id"]) id(record[key], `v3_audit_record_${key}_invalid`);
  enumValue(record.record_type, AUDIT_RECORD_TYPES, "v3_audit_record_type_invalid");
  for (const key of ["parent_attempt_id", "stage_run_id", "action_id", "actor_subject_id"]) {
    if (record[key] !== undefined && record[key] !== null) id(record[key], `v3_audit_record_${key}_invalid`);
  }
  if (record.stage !== undefined && record.stage !== null) enumValue(record.stage, STAGES, "v3_audit_record_stage_invalid");
  for (const key of ["workflow_revision", "decision_revision"]) revision(record[key], `v3_audit_record_${key}_invalid`);
  text(record.summary, "v3_audit_record_summary_invalid", 4000);
  uniqueStrings(record.evidence_refs, 0, 128, "v3_audit_record_evidence_invalid");
  timestamp(record.recorded_at, "v3_audit_record_recorded_at_invalid");
  if (record.approval_decision !== undefined && record.approval_decision !== null && !["APPROVE", "REJECT"].includes(record.approval_decision)) fail("v3_audit_record_approval_invalid");
  if (record.stage_output !== undefined && record.stage_output !== null) safeJson(record.stage_output, "v3_audit_record_stage_output_invalid");
  if (record.action_receipt !== undefined && record.action_receipt !== null) validateActionReceipt(record.action_receipt);
  if (record.rollback_receipt !== undefined && record.rollback_receipt !== null) {
    validateActionRollbackReceipt(record.rollback_receipt);
    if (record.action_id !== record.rollback_receipt.action_id) fail("v3_audit_rollback_receipt_scope_invalid");
  }
}

function validateActionReceipt(receipt) {
  object(receipt, "v3_action_receipt_invalid");
  requiredKeys(receipt, ["schema_version", "receipt_id", "executor_id", "command_id", "status", "started_at", "completed_at", "output_summary"], "v3_action_receipt_missing_field");
  if (receipt.schema_version !== "flowpulse.action-execution-receipt.v3") fail("v3_action_receipt_schema_invalid");
  for (const key of ["receipt_id", "executor_id", "command_id"]) id(receipt[key], `v3_action_receipt_${key}_invalid`);
  enumValue(receipt.status, TERMINAL_EXECUTION_STATES, "v3_action_receipt_status_invalid");
  for (const key of ["started_at", "completed_at"]) timestamp(receipt[key], `v3_action_receipt_${key}_invalid`);
  if (Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) fail("v3_action_receipt_interval_invalid");
  text(receipt.output_summary, "v3_action_receipt_output_invalid", 4000);
  if (receipt.rollback_status !== undefined && receipt.rollback_status !== null) text(receipt.rollback_status, "v3_action_receipt_rollback_invalid", 160);
}

function validateActionRollbackReceipt(receipt) {
  object(receipt, "v3_action_rollback_receipt_invalid");
  requiredKeys(receipt, [
    "schema_version", "rollback_receipt_id", "execution_key", "action_id", "command_id",
    "status", "started_at", "completed_at", "output_summary"
  ], "v3_action_rollback_receipt_missing_field");
  if (receipt.schema_version !== "flowpulse.action-rollback-receipt.v3") fail("v3_action_rollback_receipt_schema_invalid");
  for (const key of ["rollback_receipt_id", "execution_key", "action_id", "command_id"]) id(receipt[key], `v3_action_rollback_receipt_${key}_invalid`);
  if (receipt.status !== "ROLLED_BACK") fail("v3_action_rollback_receipt_status_invalid");
  for (const key of ["started_at", "completed_at"]) timestamp(receipt[key], `v3_action_rollback_receipt_${key}_invalid`);
  if (Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) fail("v3_action_rollback_receipt_interval_invalid");
  text(receipt.output_summary, "v3_action_rollback_receipt_output_invalid", 4000);
}

function safeJson(value, code, depth = 0) {
  if (depth > 8) fail(code);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 512) fail(code);
    for (const item of value) safeJson(item, code, depth + 1);
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 256) fail(code);
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(key)) fail(code);
      safeJson(item, code, depth + 1);
    }
    return;
  }
  fail(code);
}

function requiredKeys(value, keys, code) {
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(code);
}

function exactKeys(value, keys, code) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function array(value, minimum, maximum, code) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
}

function uniqueStrings(value, minimum, maximum, code) {
  array(value, minimum, maximum, code);
  for (const item of value) id(item, code);
  if (new Set(value).size !== value.length) fail(code);
}

function uniqueGraphIds(value, minimum, maximum, code) {
  array(value, minimum, maximum, code);
  for (const item of value) graphId(item, code);
  if (new Set(value).size !== value.length) fail(code);
}

function uniqueTexts(value, minimum, maximum, code, textLimit = 2000) {
  array(value, minimum, maximum, code);
  for (const item of value) text(item, code, textLimit);
  if (new Set(value).size !== value.length) fail(code);
}

function id(value, code) {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
}

function graphId(value, code) {
  if (typeof value !== "string" || (!ID.test(value) && !EVIDENCED_EDGE_ID.test(value))) fail(code);
}

function text(value, code, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(code);
}

function timestamp(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code);
}

function revision(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
}

function nonnegative(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}

function enumValue(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code) {
  throw new ControlPlaneV3ContractError(code);
}

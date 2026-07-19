import { createHash } from "node:crypto";

export const INCIDENT_PROJECTION_SCHEMA_VERSION = "flowpulse.incident-projection.v1";
export const INCIDENT_PROJECTION_LIMITS = Object.freeze({
  max_nodes: 128,
  max_edges: 256,
  max_frames: 100,
  max_evidence_summaries: 64,
  max_evidence_refs_per_event: 32,
  max_serialized_bytes: 256 * 1024
});

const SOURCE_HEALTH = new Set(["live", "stale", "disconnected", "unavailable"]);
const EVIDENCE_MODE = new Set(["live_stream", "frozen_real_snapshot", "captured_fixture"]);
const EXECUTION_MODE = new Set(["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"]);
const HASH = /^[a-f0-9]{64}$/;

/**
 * Produces the only browser-facing incident state. It is intentionally a pure,
 * read-only projection: no request field, source record, or UI value can create
 * authority, and no event payload is copied wholesale into the response.
 */
export function buildIncidentProjection(input) {
  try {
    const normalized = normalize(input);
    return build(normalized);
  } catch (error) {
    return nonActionable(error?.code || "projection_input_invalid");
  }
}

function normalize(value) {
  if (!plain(value) || !plain(value.run) || !plain(value.source) || !Array.isArray(value.events) || !Array.isArray(value.evidence)) fail("projection_input_invalid");
  const run = value.run;
  if (!text(run.run_id, 160) || !text(run.mode, 80) || !plain(run.incident) || !text(run.incident.id, 160)) fail("projection_run_invalid");
  const modes = truthAxes(run.mode, value.source, value.events);
  const events = [...value.events].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  let prior = 0;
  const ids = new Set();
  for (const event of events) {
    if (!plain(event) || !text(event.id, 200) || ids.has(event.id) || !Number.isInteger(event.sequence) || event.sequence <= prior || event.run_id !== run.run_id || event.incident_id !== run.incident.id || !text(event.type, 160) || !timestamp(event.recorded_at) || !Array.isArray(event.evidence_refs) || event.evidence_refs.length > INCIDENT_PROJECTION_LIMITS.max_evidence_refs_per_event || new Set(event.evidence_refs).size !== event.evidence_refs.length || !event.evidence_refs.every((id) => text(id, 200))) fail("projection_event_invalid");
    ids.add(event.id);
    prior = event.sequence;
  }
  const evidence = new Map();
  for (const record of value.evidence) {
    const recordHash = record?.hash || record?.provenance?.sha256;
    if (!plain(record) || !text(record.id, 200) || evidence.has(record.id) || !text(record.kind, 80) || !text(record.source, 160) || !timestamp(record.at) || (!isHash(recordHash) && modes.evidence_mode !== "captured_fixture")) fail("projection_evidence_invalid");
    evidence.set(record.id, record);
  }
  for (const event of events) for (const id of event.evidence_refs) if (!evidence.has(id)) fail("projection_evidence_missing");
  const topology = plain(run.topology) ? run.topology : {};
  return { run, source: value.source, events, evidence, topology, cursor: value.cursor ?? null, ...modes };
}

function truthAxes(runMode, source, events) {
  if (["truth_mode", "source_health", "evidence_mode", "execution_mode"].some((key) => Object.hasOwn(source, key))) fail("projection_legacy_or_injected_truth_axis");
  const sourceMode = source.mode;
  let evidence_mode;
  if (sourceMode === "deterministic_replay") evidence_mode = "captured_fixture";
  else if (["frozen_real_otlp_snapshot", "captured_real_evidence"].includes(sourceMode)) evidence_mode = "frozen_real_snapshot";
  else if (sourceMode === "live_otlp") evidence_mode = "live_stream";
  else fail("projection_evidence_mode_unknown");
  const sourceStatus = source.status;
  let source_health;
  if (["captured", "frozen", "live"].includes(sourceStatus)) source_health = "live";
  else if (sourceStatus === "stale") source_health = "stale";
  else if (sourceStatus === "disconnected") source_health = "disconnected";
  else if (["connecting", "unavailable"].includes(sourceStatus)) source_health = "unavailable";
  else fail("projection_source_health_unknown");
  let execution_mode;
  if (events.some((event) => event.type === "action.simulated")) execution_mode = "captured_simulation";
  else if (runMode === "replay") execution_mode = "deterministic_replay";
  else if (runMode === "live") execution_mode = "gpt_model_only";
  else if (runMode === "development") execution_mode = "real_local_development";
  else fail("projection_execution_mode_unknown");
  if (!SOURCE_HEALTH.has(source_health) || !EVIDENCE_MODE.has(evidence_mode) || !EXECUTION_MODE.has(execution_mode)) fail("projection_truth_axis_invalid");
  if (source_health !== "live") fail("projection_source_not_actionable");
  return { source_health, evidence_mode, execution_mode };
}

function build({ run, source, events, evidence, topology, cursor, source_health, evidence_mode, execution_mode }) {
  const revision = sha256({
    schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION,
    run_id: run.run_id,
    incident_id: run.incident.id,
    source_health,
    evidence_mode,
    execution_mode,
    events: events.map((event) => [event.sequence, event.id, event.type, event.recorded_at, event.evidence_refs]),
    evidence: [...evidence.values()].map((record) => [record.id, record.hash || record.provenance?.sha256 || derivedLegacyHash(record)]).sort(compareTuple)
  });
  const offset = decodeCursor(cursor, revision);
  const timelineAll = events.map(frameFor);
  const page = timelineAll.slice(offset, offset + INCIDENT_PROJECTION_LIMITS.max_frames);
  const nextOffset = offset + page.length < timelineAll.length ? offset + page.length : null;
  const refs = unique(events.flatMap((event) => event.evidence_refs));
  const evidenceSummaries = refs.slice(0, INCIDENT_PROJECTION_LIMITS.max_evidence_summaries).map((id) => safeEvidence(evidence.get(id)));
  const graph = graphFor(topology);
  const state = stateFor(events);
  const projection = {
    schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION,
    projection_revision: revision,
    run_id: run.run_id,
    incident: safeIncident(run.incident),
    stage: state.stage,
    stage_status: state.stage_status,
    source_health,
    evidence_mode,
    execution_mode,
    graph,
    timeline: { frames: page, total_frames: timelineAll.length, cursor: cursor || null },
    evidence: evidenceSummaries,
    investigation: investigationFor(events),
    decision: decisionFor(events),
    human_gate: humanGateFor(events),
    action: actionFor(events),
    verification: verificationFor(events),
    learning: learningFor(events),
    why_stopped: whyStoppedFor(events, state),
    truncated: Boolean(nextOffset !== null || refs.length > evidenceSummaries.length || graph.truncated),
    truncation: {
      graph_nodes: Math.max(0, graph.total_nodes - graph.nodes.length),
      graph_edges: Math.max(0, graph.total_edges - graph.edges.length),
      timeline_frames: Math.max(0, timelineAll.length - page.length - offset),
      evidence_summaries: Math.max(0, refs.length - evidenceSummaries.length),
      serialized_bytes: 0
    },
    next_cursor: nextOffset === null ? null : encodeCursor(revision, nextOffset)
  };
  return enforceSerializedCap(projection, timelineAll, revision);
}

function stateFor(events) {
  const has = (type) => events.some((event) => event.type === type);
  const last = (type) => [...events].reverse().find((event) => event.type === type);
  const failure = last("outcome.classified");
  if (failure && ["insufficient_evidence", "tool_data_failure", "causal_evidence_rejected"].includes(failure.payload?.classification)) return { stage: stage("agent_workbench"), stage_status: "blocked" };
  if (has("verification.completed")) return { stage: stage("decision_recovery"), stage_status: "verified" };
  if (has("repair.execution.attempted") || has("repair.executed")) return { stage: stage("decision_recovery"), stage_status: "executing" };
  if (has("approval.granted")) return { stage: stage("decision_recovery"), stage_status: "approved" };
  if (has("approval.requested")) return { stage: stage("decision_recovery"), stage_status: "waiting_for_owner" };
  if (has("plan.revised") || has("evaluation.rejected")) return { stage: stage("agent_workbench"), stage_status: "replanning" };
  if (has("evaluation.accepted") || has("hypothesis.proposed") || has("diagnosis.gate.passed")) return { stage: stage("agent_workbench"), stage_status: "evaluating" };
  return { stage: stage("monitor"), stage_status: "collecting" };
}

function stage(id) {
  return { id, label: ({ monitor: "Monitor", agent_workbench: "Agent Workbench", decision_recovery: "Decision & Recovery" })[id] };
}

function investigationFor(events) {
  const hypotheses = events.filter((event) => ["hypothesis.proposed", "diagnosis.proposed"].includes(event.type)).slice(-8).map((event) => ({ id: safeText(event.payload?.id || event.id, 160), status: event.type, evidence_refs: [...event.evidence_refs] }));
  const rejected = lastEvent(events, "evaluation.rejected");
  const accepted = lastEvent(events, "evaluation.accepted");
  const replan = lastEvent(events, "plan.revised");
  const gate = lastEvent(events, "diagnosis.gate.passed");
  return {
    hypotheses,
    counter_evidence: rejected ? { hypothesis_id: safeText(rejected.payload?.hypothesis_id, 160), evidence_refs: [...rejected.evidence_refs] } : null,
    evaluator: accepted ? { verdict: "accepted", evidence_refs: [...accepted.evidence_refs] } : rejected ? { verdict: "rejected", evidence_refs: [...rejected.evidence_refs] } : { verdict: "pending", evidence_refs: [] },
    diagnosis_gate: gate ? { status: "passed", event_id: gate.id, evidence_refs: [...gate.evidence_refs] } : { status: "pending", event_id: null, evidence_refs: [] },
    replan: replan ? { status: "recorded", event_id: replan.id } : { status: "not_recorded", event_id: null }
  };
}

function decisionFor(events) {
  const event = lastEvent(events, "autonomy.decision.recorded");
  if (!event) return { status: "not_recorded", decision_id: null, risk_tier: null, evidence_refs: [] };
  return { status: safeEnum(event.payload?.outcome, ["human_review_required", "auto_execute_pre_authorized", "non_actionable"], "non_actionable"), decision_id: event.id, risk_tier: safeEnum(event.payload?.risk_tier, ["low", "medium", "high"], "unknown"), evidence_refs: [...event.evidence_refs], contract_sha256: safeHash(event.payload?.contract_sha256) };
}

function humanGateFor(events) {
  const request = lastEvent(events, "approval.requested");
  const grant = lastEvent(events, "approval.granted");
  if (grant) return { status: "granted", request_id: request?.id || null, approval_id: grant.id };
  if (request) return { status: "requested", request_id: request.id, approval_id: null };
  return { status: "not_required", request_id: null, approval_id: null };
}

function actionFor(events) {
  const simulated = lastEvent(events, "action.simulated");
  const attempted = lastEvent(events, "repair.execution.attempted");
  const executed = lastEvent(events, "repair.executed");
  if (simulated) return { status: "simulated", event_id: simulated.id, truth: "captured_simulation" };
  if (executed) return { status: "executed", event_id: executed.id, truth: "ledger_recorded" };
  if (attempted) return { status: "attempted", event_id: attempted.id, truth: "ledger_recorded" };
  return { status: "not_started", event_id: null, truth: null };
}

function verificationFor(events) {
  const event = lastEvent(events, "verification.completed");
  if (!event) return { status: "not_recorded", event_id: null, passed: null, evidence_refs: [] };
  return { status: event.payload?.passed === true ? "passed" : "failed", event_id: event.id, passed: event.payload?.passed === true, evidence_refs: [...event.evidence_refs] };
}

function learningFor(events) {
  const regression = lastEvent(events, "regression.created");
  const backtest = lastEvent(events, "backtest.completed");
  const policy = lastEvent(events, "policy.evaluated");
  return { regression_id: regression?.id || null, backtest_id: backtest?.id || null, policy_id: policy?.id || null, backtest_source: safeEnum(backtest?.payload?.source, ["executed_offline_backtest", "captured_fixture"], null) };
}

function whyStoppedFor(events, state) {
  const failure = lastEvent(events, "outcome.classified");
  if (state.stage_status === "blocked") return { code: safeEnum(failure?.payload?.classification, ["insufficient_evidence", "tool_data_failure", "causal_evidence_rejected"], "authority_unavailable"), detail_status: "recorded" };
  if (events.length <= 2) return { code: "legacy_detail_unavailable", detail_status: "legacy_detail_unavailable" };
  if (state.stage_status === "waiting_for_owner") return { code: "owner_decision_required", detail_status: "recorded" };
  return { code: null, detail_status: "not_stopped" };
}

function graphFor(topology) {
  const candidates = Array.isArray(topology.services) ? topology.services : Array.isArray(topology.nodes) ? topology.nodes : [];
  const seen = new Set();
  const nodes = [];
  for (const node of candidates) {
    const id = typeof node === "string" ? node : node?.id;
    if (!text(id, 160) || seen.has(id)) continue;
    seen.add(id);
    if (nodes.length < INCIDENT_PROJECTION_LIMITS.max_nodes) nodes.push({ id, label: safeText(typeof node === "string" ? node : node.label || node.name || id, 160), kind: safeText(typeof node === "object" ? node.kind || "service" : "service", 80) });
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidatesEdges = Array.isArray(topology.dependencies) ? topology.dependencies : Array.isArray(topology.edges) ? topology.edges : [];
  const edgeSeen = new Set();
  const edges = [];
  for (const edge of candidatesEdges) {
    const from = edge?.from || edge?.source;
    const to = edge?.to || edge?.target;
    const key = `${from}|${to}`;
    if (!text(from, 160) || !text(to, 160) || !nodeIds.has(from) || !nodeIds.has(to) || edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    if (edges.length < INCIDENT_PROJECTION_LIMITS.max_edges) edges.push({ id: safeText(edge.id || key, 200), from, to, kind: safeText(edge.kind || "dependency", 80) });
  }
  return { nodes, edges, total_nodes: seen.size, total_edges: edgeSeen.size, truncated: seen.size > nodes.length || edgeSeen.size > edges.length };
}

function frameFor(event) {
  return { id: event.id, sequence: event.sequence, at: event.recorded_at, type: event.type, actor: safeText(event.actor || "unknown", 80), evidence_refs: [...event.evidence_refs] };
}

function safeEvidence(record) {
  return {
    id: record.id,
    kind: safeText(record.kind, 80),
    signal: safeText(record.signal || "unknown", 80),
    entity: safeText(record.entity || "unknown", 120),
    source: safeText(record.source, 160),
    observed_at: record.at,
    record_sha256: record.hash || record.provenance?.sha256 || derivedLegacyHash(record),
    provenance_status: isHash(record.hash || record.provenance?.sha256) ? "record_bound" : "legacy_detail_unavailable"
  };
}

function safeIncident(incident) {
  return { id: incident.id, title: safeText(incident.title || incident.id, 180), severity: safeEnum(incident.severity, ["SEV-1", "SEV-2", "SEV-3", "SEV-4", "unknown"], "unknown") };
}

function derivedLegacyHash(record) {
  return sha256({ id: record.id, kind: record.kind, signal: record.signal || null, entity: record.entity || null, source: record.source, at: record.at });
}

function enforceSerializedCap(projection, allFrames, revision) {
  let value = projection;
  for (;;) {
    const currentFrames = value.timeline.frames.length;
    const offset = value.timeline.cursor ? decodeCursor(value.timeline.cursor, revision) : 0;
    const nextOffset = offset + currentFrames < allFrames.length ? offset + currentFrames : null;
    value = { ...value, next_cursor: nextOffset === null ? null : encodeCursor(revision, nextOffset), truncation: { ...value.truncation, serialized_bytes: 0 } };
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    value = { ...value, truncation: { ...value.truncation, serialized_bytes: serializedBytes } };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= INCIDENT_PROJECTION_LIMITS.max_serialized_bytes) return value;
    if (value.timeline.frames.length > 0) {
      value = { ...value, timeline: { ...value.timeline, frames: value.timeline.frames.slice(0, -1) }, truncated: true };
      continue;
    }
    if (value.evidence.length > 0) {
      value = { ...value, evidence: value.evidence.slice(0, -1), truncated: true };
      continue;
    }
    return nonActionable("projection_serialized_limit_exceeded");
  }
}

function decodeCursor(cursor, revision) {
  if (cursor == null) return 0;
  if (!text(cursor, 300)) fail("projection_cursor_invalid");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!plain(parsed) || parsed.v !== 1 || parsed.r !== revision || !Number.isInteger(parsed.o) || parsed.o < 0) fail("projection_cursor_invalid");
    return parsed.o;
  } catch { fail("projection_cursor_invalid"); }
}

function encodeCursor(revision, offset) { return Buffer.from(JSON.stringify({ v: 1, r: revision, o: offset })).toString("base64url"); }
function lastEvent(events, type) { return [...events].reverse().find((event) => event.type === type) || null; }
function unique(values) { return [...new Set(values)]; }
function safeText(value, limit) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : "unknown"; }
function safeEnum(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function safeHash(value) { return isHash(value) ? value : null; }
function text(value, limit) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit; }
function timestamp(value) { return text(value, 40) && Number.isFinite(Date.parse(value)); }
function isHash(value) { return typeof value === "string" && HASH.test(value); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sha256(value) { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function compareTuple(left, right) { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }
function fail(code) { const error = new Error("Incident projection is non-actionable"); error.code = code; throw error; }

function nonActionable(code) {
  return {
    schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION,
    projection_revision: null,
    run_id: null,
    incident: { id: null, title: "Unavailable incident projection", severity: "unknown" },
    stage: stage("monitor"), stage_status: "non_actionable",
    source_health: "unavailable", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay",
    graph: { nodes: [], edges: [], total_nodes: 0, total_edges: 0, truncated: false },
    timeline: { frames: [], total_frames: 0, cursor: null }, evidence: [],
    investigation: { hypotheses: [], counter_evidence: null, evaluator: { verdict: "unavailable", evidence_refs: [] }, diagnosis_gate: { status: "unavailable", event_id: null, evidence_refs: [] }, replan: { status: "unavailable", event_id: null } },
    decision: { status: "non_actionable", decision_id: null, risk_tier: "unknown", evidence_refs: [] },
    human_gate: { status: "not_actionable", request_id: null, approval_id: null },
    action: { status: "not_actionable", event_id: null, truth: null },
    verification: { status: "not_actionable", event_id: null, passed: null, evidence_refs: [] },
    learning: { regression_id: null, backtest_id: null, policy_id: null, backtest_source: null },
    why_stopped: { code, detail_status: "recorded" },
    truncated: false, truncation: { graph_nodes: 0, graph_edges: 0, timeline_frames: 0, evidence_summaries: 0, serialized_bytes: 0 }, next_cursor: null
  };
}

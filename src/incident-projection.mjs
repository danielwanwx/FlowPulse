import { sha256Canonical } from "./autonomy-policy.mjs";
import { validateProjectionCanonicalChain, validateProjectionInvestigation } from "./projection-canonical-validator.mjs";

export const INCIDENT_PROJECTION_SCHEMA_VERSION = "flowpulse.incident-projection.v1";
export const INCIDENT_PROJECTION_LIMITS = Object.freeze({
  max_nodes: 128,
  max_edges: 256,
  max_frames: 100,
  max_evidence_summaries: 64,
  max_evidence_refs_per_event: 32,
  max_serialized_bytes: 256 * 1024,
  max_input_events: 512,
  max_input_evidence: 512,
  max_input_nodes: 512,
  max_input_edges: 1024,
  max_payload_bytes: 16 * 1024,
  max_evidence_bytes: 8 * 1024,
  max_value_depth: 8
});

const SOURCE_HEALTH = new Set(["live", "stale", "disconnected", "unavailable"]);
const EVIDENCE_MODE = new Set(["live_stream", "frozen_real_snapshot", "captured_fixture"]);
const EXECUTION_MODE = new Set(["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"]);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const AUTHORITY_EVENTS = new Set([
  "autonomy.decision.recorded", "repair.proposed", "approval.requested", "approval.granted",
  "repair.execution.attempted", "repair.executed", "verification.completed"
]);
const KNOWN_EVENTS = new Set([
  "run.started", "incident.opened", "incident.detected", "incident.close", "closed.incident",
  "evidence.queried", "evidence.requested", "evidence.snapshot.created", "evidence.manifest.proposed", "evidence.manifest.accepted", "evidence.plan.approved", "evidence.gap.proposed",
  "tool.called", "context.compiled", "hypothesis.proposed", "diagnosis.proposed", "diagnosis.gate.passed", "diagnosis.baseline.captured", "diagnosis.evidence_refs", "diagnosis.propagation", "diagnosis.proposed_repair",
  "evaluation.accepted", "evaluation.rejected", "plan.revised", "outcome.classified", "development.investigation.failed", "failure.episode.recorded",
  "change.applied", "code.semantics.captured", "repair.proposed", "approval.requested", "approval.granted", "repair.execution.attempted", "repair.executed", "verification.completed", "action.simulated", "autonomy.decision.recorded", "autonomy.locked",
  "regression.created", "regression.candidate.proposed", "backtest.completed", "policy.evaluated", "policy.candidate.proposed", "policy.promoted",
  "loop.symptoms_collected", "loop.initial_hypothesis", "loop.hypothesis_rejected", "loop.replanned", "loop.root_cause_confirmed", "loop.causal_evidence_collected", "loop.approval_requested", "loop.repair_executed", "loop.learning_complete",
  "manager.delegation.created", "manager.message.received", "manager.response.created", "task.delegation.proposed", "pr.review.proposed", "pr.review.recorded", "workitem.draft.proposed", "workitem.draft.approved", "orchestration.step.completed",
  "candidate.edited", "false_diagnosis.record", "post_action.evidence", "topology.snapshot", "triage.annotation.proposed", "verification.proposed"
]);

/**
 * Pure, bounded browser projection. authority_chain is only produced by the
 * server-local Slice-B verifier; an absent or invalid chain can never upgrade
 * a ledger row into an Owner Gate or execution state.
 */
export function buildIncidentProjection(input) {
  let axes = null;
  try {
    const normalized = normalize(input);
    axes = normalized.axes;
    return build(normalized);
  } catch (error) {
    return nonActionable(error?.code || "projection_input_invalid", axes);
  }
}

function normalize(value) {
  if (!plain(value) || !plain(value.run) || !plain(value.source) || !Array.isArray(value.events) || !Array.isArray(value.evidence)) fail("projection_input_invalid");
  const { run, source } = value;
  if (!id(run.run_id) || !text(run.mode, 80) || !plain(run.incident) || !id(run.incident.id)) fail("projection_run_invalid");
  if (value.events.length > INCIDENT_PROJECTION_LIMITS.max_input_events || value.evidence.length > INCIDENT_PROJECTION_LIMITS.max_input_evidence) fail("projection_input_limit_exceeded");
  const topology = plain(run.topology) ? run.topology : {};
  const nodes = Array.isArray(topology.services) ? topology.services : Array.isArray(topology.nodes) ? topology.nodes : [];
  const edges = Array.isArray(topology.dependencies) ? topology.dependencies : Array.isArray(topology.edges) ? topology.edges : [];
  if (nodes.length > INCIDENT_PROJECTION_LIMITS.max_input_nodes || edges.length > INCIDENT_PROJECTION_LIMITS.max_input_edges) fail("projection_input_limit_exceeded");
  // Count every untrusted collection before scanning it for truth axes,
  // canonical payloads, revisions, or topology. This protects the projection
  // path from an oversized append-only history becoming browser work.
  const axes = truthAxes(run.mode, source, value.events);

  const events = [...value.events];
  const ids = new Set();
  let priorSequence = 0;
  for (const event of events) {
    if (!plain(event) || !id(event.id) || ids.has(event.id) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.run_id !== run.run_id || event.incident_id !== run.incident.id || !KNOWN_EVENTS.has(event.type) || !timestamp(event.recorded_at) || !text(event.actor, 120) || !Number.isSafeInteger(event.offset_ms ?? 0) || !Array.isArray(event.evidence_refs) || event.evidence_refs.length > INCIDENT_PROJECTION_LIMITS.max_evidence_refs_per_event || new Set(event.evidence_refs).size !== event.evidence_refs.length || !event.evidence_refs.every(id) || !boundedValue(event.payload, INCIDENT_PROJECTION_LIMITS.max_payload_bytes)) fail("projection_event_invalid");
    if (event.payload_sha256 != null && (!isHash(event.payload_sha256) || event.payload_sha256 !== sha256Canonical(event.payload))) fail("projection_event_payload_invalid");
    if (event.parent_id != null && !id(event.parent_id)) fail("projection_event_relationship_invalid");
    if (event.correlation_id != null && !id(event.correlation_id)) fail("projection_event_relationship_invalid");
    if (event.sequence <= priorSequence) fail("projection_sequence_invalid");
    priorSequence = event.sequence;
    ids.add(event.id);
  }

  const evidence = new Map();
  for (const record of value.evidence) {
    const recordHash = record?.hash || record?.provenance?.sha256;
    if (!plain(record) || !id(record.id) || evidence.has(record.id) || !text(record.kind, 80) || !text(record.source, 160) || !timestamp(record.at) || !boundedValue(record, INCIDENT_PROJECTION_LIMITS.max_evidence_bytes) || (!isHash(recordHash) && axes.evidence_mode !== "captured_fixture")) fail("projection_evidence_invalid");
    evidence.set(record.id, record);
  }
  for (const event of events) for (const ref of event.evidence_refs) if (!evidence.has(ref)) fail("projection_evidence_missing");
  return { run, source, events, evidence, topology, cursor: value.cursor ?? null, authority_chain: value.authority_chain ?? null, axes };
}

function truthAxes(runMode, source, events) {
  if (["truth_mode", "source_health", "evidence_mode", "execution_mode"].some((key) => Object.hasOwn(source, key))) fail("projection_legacy_or_injected_truth_axis");
  const sourceMode = source.mode;
  const evidence_mode = sourceMode === "deterministic_replay" ? "captured_fixture"
    : ["frozen_real_otlp_snapshot", "captured_real_evidence"].includes(sourceMode) ? "frozen_real_snapshot"
      : sourceMode === "live_otlp" ? "live_stream" : fail("projection_evidence_mode_unknown");
  const sourceStatus = source.status;
  const source_health = ["captured", "frozen", "live"].includes(sourceStatus) ? "live"
    : sourceStatus === "stale" ? "stale"
      : sourceStatus === "disconnected" ? "disconnected"
        : ["connecting", "unavailable"].includes(sourceStatus) ? "unavailable" : fail("projection_source_health_unknown");
  const execution_mode = events.some((event) => event.type === "action.simulated") ? "captured_simulation"
    : runMode === "replay" ? "deterministic_replay"
      : runMode === "live" ? "gpt_model_only"
        : runMode === "development" ? "real_local_development" : fail("projection_execution_mode_unknown");
  if (!SOURCE_HEALTH.has(source_health) || !EVIDENCE_MODE.has(evidence_mode) || !EXECUTION_MODE.has(execution_mode)) fail("projection_truth_axis_invalid");
  return { source_health, evidence_mode, execution_mode };
}

function build({ run, events, evidence, topology, cursor, authority_chain, axes }) {
  if (axes.source_health !== "live") return nonActionable("projection_source_not_actionable", axes);
  const authority = canonicalChain(events, authority_chain, axes, evidence);
  const containsAuthority = events.some((event) => AUTHORITY_EVENTS.has(event.type));
  const legacyAuthority = containsAuthority && authority.status !== "canonical" && axes.evidence_mode === "captured_fixture";
  if (authority.status === "invalid" || (containsAuthority && !legacyAuthority && authority.status !== "canonical")) fail(authority.reason || "projection_authority_chain_invalid");

  const revision = sha256Canonical({
    schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION,
    run: { run_id: run.run_id, mode: run.mode, incident: safeIncident(run.incident), topology: revisionTopology(topology) },
    axes,
    events: events.map(eventIdentity),
    evidence: [...evidence.values()].map(evidenceIdentity).sort(compareCanonical),
    authority: authority.revision
  });
  const offset = decodeCursor(cursor, revision);
  const timelineAll = events.map(frameFor);
  const page = timelineAll.slice(offset, offset + INCIDENT_PROJECTION_LIMITS.max_frames);
  const nextOffset = offset + page.length < timelineAll.length ? offset + page.length : null;
  const refs = unique(events.flatMap((event) => event.evidence_refs));
  const evidenceSummaries = refs.slice(0, INCIDENT_PROJECTION_LIMITS.max_evidence_summaries).map((ref) => safeEvidence(evidence.get(ref)));
  const graph = graphFor(topology);
  const investigation = investigationFor(events);
  const state = stateFor(events, authority, legacyAuthority, investigation);
  const projection = {
    schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION,
    projection_revision: revision,
    run_id: run.run_id,
    incident: safeIncident(run.incident),
    stage: state.stage,
    stage_status: state.stage_status,
    ...axes,
    graph,
    timeline: { frames: page, total_frames: timelineAll.length, cursor: cursor || null },
    evidence: evidenceSummaries,
    investigation,
    decision: decisionFor(authority, legacyAuthority),
    human_gate: humanGateFor(authority, legacyAuthority),
    action: actionFor(authority, legacyAuthority),
    verification: verificationFor(authority, legacyAuthority),
    learning: learningFor(events),
    why_stopped: whyStoppedFor(events, state, authority, legacyAuthority),
    truncated: Boolean(nextOffset !== null || refs.length > evidenceSummaries.length || graph.truncated),
    truncation: { graph_nodes: Math.max(0, graph.total_nodes - graph.nodes.length), graph_edges: Math.max(0, graph.total_edges - graph.edges.length), timeline_frames: Math.max(0, timelineAll.length - page.length - offset), evidence_summaries: Math.max(0, refs.length - evidenceSummaries.length), serialized_bytes: 0 },
    next_cursor: nextOffset === null ? null : encodeCursor(revision, nextOffset)
  };
  return enforceSerializedCap(projection, timelineAll, revision);
}

/** Validates the server-provided read-only chain summary against this exact event stream. */
function canonicalChain(events, value, axes, evidence) { return validateProjectionCanonicalChain({ events, chain: value, axes, evidence }); }

function stateFor(events, authority, legacyAuthority, investigation) {
  const failure = lastEvent(events, "outcome.classified");
  if (failure && ["insufficient_evidence", "tool_data_failure", "causal_evidence_rejected"].includes(failure.payload?.classification)) return { stage: stage("agent_workbench"), stage_status: "blocked" };
  if (authority.status === "canonical") {
    if (authority.verification) return { stage: stage("decision_recovery"), stage_status: "verified" };
    if (authority.execution || authority.attempt) return { stage: stage("decision_recovery"), stage_status: "executing" };
    if (authority.approval) return { stage: stage("decision_recovery"), stage_status: "approved" };
    return { stage: stage("decision_recovery"), stage_status: "waiting_for_owner" };
  }
  if (legacyAuthority) return { stage: stage("decision_recovery"), stage_status: "legacy_detail_unavailable" };
  if (investigation.replan?.status === "recorded" || investigation.evaluator?.verdict === "rejected") return { stage: stage("agent_workbench"), stage_status: "replanning" };
  if (investigation.evaluator?.verdict === "accepted" || investigation.diagnosis_gate?.status === "passed" || has(events, "hypothesis.proposed")) return { stage: stage("agent_workbench"), stage_status: "evaluating" };
  return { stage: stage("monitor"), stage_status: "collecting" };
}

function stage(id) { return { id, label: ({ monitor: "Monitor", agent_workbench: "Agent Workbench", decision_recovery: "Decision & Recovery" })[id] }; }

function investigationFor(events) {
  const validated = validateProjectionInvestigation(events);
  const hypotheses = events.filter((event) => ["hypothesis.proposed", "diagnosis.proposed"].includes(event.type)).slice(-8).map((event) => ({ id: safeText(event.payload?.id || event.id, 160), status: event.type, evidence_refs: [...event.evidence_refs] }));
  const { rejected, accepted, replan, gate } = validated;
  return { hypotheses, counter_evidence: rejected ? { hypothesis_id: safeText(rejected.payload?.hypothesis_id, 160), evidence_refs: [...rejected.evidence_refs] } : null, evaluator: accepted ? { verdict: "accepted", evidence_refs: [...accepted.evidence_refs] } : rejected ? { verdict: "rejected", evidence_refs: [...rejected.evidence_refs] } : { verdict: "pending", evidence_refs: [] }, diagnosis_gate: gate ? { status: "passed", event_id: gate.id, evidence_refs: [...gate.evidence_refs] } : { status: "pending", event_id: null, evidence_refs: [] }, replan: replan ? { status: "recorded", event_id: replan.id } : { status: "not_recorded", event_id: null } };
}

function decisionFor(authority, legacy) {
  if (authority.status === "canonical") return { status: "human_review_required", decision_id: authority.decision.id, risk_tier: safeEnum(authority.decision.payload?.action?.risk, ["low", "medium", "high"], "medium"), evidence_refs: [...authority.decision.evidence_refs], contract_sha256: safeHash(authority.decision.payload?.contract_sha256) };
  return { status: legacy ? "legacy_detail_unavailable" : "not_recorded", decision_id: null, risk_tier: null, evidence_refs: [] };
}
function humanGateFor(authority, legacy) {
  if (authority.status === "canonical") return authority.approval ? { status: "granted", request_id: authority.request.id, approval_id: authority.approval.id } : { status: "requested", request_id: authority.request.id, approval_id: null };
  return { status: legacy ? "legacy_detail_unavailable" : "not_required", request_id: null, approval_id: null };
}
function actionFor(authority, legacy) {
  if (authority.status === "canonical") return authority.execution ? { status: "executed", event_id: authority.execution.id, truth: "ledger_recorded" } : authority.attempt ? { status: "attempted", event_id: authority.attempt.id, truth: "ledger_recorded" } : { status: "not_started", event_id: null, truth: null };
  return legacy ? { status: "legacy_display_only", event_id: null, truth: "captured_fixture" } : { status: "not_started", event_id: null, truth: null };
}
function verificationFor(authority, legacy) {
  if (authority.status === "canonical") return authority.verification ? { status: "passed", event_id: authority.verification.id, passed: true, evidence_refs: [...authority.verification.evidence_refs] } : { status: "not_recorded", event_id: null, passed: null, evidence_refs: [] };
  return legacy ? { status: "legacy_display_only", event_id: null, passed: null, evidence_refs: [] } : { status: "not_recorded", event_id: null, passed: null, evidence_refs: [] };
}
function learningFor(events) { const regression = lastEvent(events, "regression.created"); const backtest = lastEvent(events, "backtest.completed"); const policy = lastEvent(events, "policy.evaluated"); return { regression_id: regression?.id || null, backtest_id: backtest?.id || null, policy_id: policy?.id || null, backtest_source: safeEnum(backtest?.payload?.source, ["executed_offline_backtest", "captured_fixture"], null) }; }
function whyStoppedFor(events, state, authority, legacy) { const failure = lastEvent(events, "outcome.classified"); if (state.stage_status === "blocked") return { code: safeEnum(failure?.payload?.classification, ["insufficient_evidence", "tool_data_failure", "causal_evidence_rejected"], "authority_unavailable"), detail_status: "recorded" }; if (legacy || events.length <= 2) return { code: "legacy_detail_unavailable", detail_status: "legacy_detail_unavailable" }; if (authority.status === "canonical" && !authority.approval) return { code: "owner_decision_required", detail_status: "recorded" }; return { code: null, detail_status: "not_stopped" }; }

function graphFor(topology) {
  const candidates = Array.isArray(topology.services) ? topology.services : Array.isArray(topology.nodes) ? topology.nodes : [];
  const seen = new Set(); const nodes = [];
  for (const node of candidates) { const nodeId = typeof node === "string" ? node : node?.id; if (!id(nodeId) || seen.has(nodeId)) continue; seen.add(nodeId); if (nodes.length < INCIDENT_PROJECTION_LIMITS.max_nodes) nodes.push({ id: nodeId, label: safeText(typeof node === "string" ? node : node.label || node.name || nodeId, 160), kind: safeText(typeof node === "object" ? node.kind || "service" : "service", 80) }); }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidatesEdges = Array.isArray(topology.dependencies) ? topology.dependencies : Array.isArray(topology.edges) ? topology.edges : [];
  const edgeSeen = new Set(); const edges = [];
  for (const edge of candidatesEdges) { const from = edge?.from || edge?.source; const to = edge?.to || edge?.target; const key = `${from}|${to}`; if (!id(from) || !id(to) || !nodeIds.has(from) || !nodeIds.has(to) || edgeSeen.has(key)) continue; edgeSeen.add(key); if (edges.length < INCIDENT_PROJECTION_LIMITS.max_edges) edges.push({ id: safeText(edge.id || key, 200), from, to, kind: safeText(edge.kind || "dependency", 80) }); }
  return { nodes, edges, total_nodes: seen.size, total_edges: edgeSeen.size, truncated: seen.size > nodes.length || edgeSeen.size > edges.length };
}
function frameFor(event) { return { id: event.id, sequence: event.sequence, at: event.recorded_at, type: event.type, actor: safeText(event.actor, 80), evidence_refs: [...event.evidence_refs] }; }
function safeEvidence(record) { return { id: record.id, kind: safeText(record.kind, 80), signal: safeText(record.signal || "unknown", 80), entity: safeText(record.entity || "unknown", 120), source: safeText(record.source, 160), observed_at: record.at, record_sha256: record.hash || record.provenance?.sha256 || derivedLegacyHash(record), provenance_status: isHash(record.hash || record.provenance?.sha256) ? "record_bound" : "legacy_detail_unavailable" }; }
function safeIncident(incident) { return { id: incident.id, title: safeText(incident.title || incident.id, 180), severity: safeEnum(incident.severity, ["SEV-1", "SEV-2", "SEV-3", "SEV-4", "unknown"], "unknown") }; }
function derivedLegacyHash(record) { return sha256Canonical({ id: record.id, kind: record.kind, signal: record.signal || null, entity: record.entity || null, source: record.source, at: record.at }); }

function enforceSerializedCap(projection, allFrames, revision) { let value = projection; for (;;) { const currentFrames = value.timeline.frames.length; const offset = value.timeline.cursor ? decodeCursor(value.timeline.cursor, revision) : 0; const nextOffset = offset + currentFrames < allFrames.length ? offset + currentFrames : null; value = { ...value, next_cursor: nextOffset === null ? null : encodeCursor(revision, nextOffset), truncation: { ...value.truncation, serialized_bytes: 0 } }; const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8"); value = { ...value, truncation: { ...value.truncation, serialized_bytes: serializedBytes } }; if (Buffer.byteLength(JSON.stringify(value), "utf8") <= INCIDENT_PROJECTION_LIMITS.max_serialized_bytes) return value; if (value.timeline.frames.length) { value = { ...value, timeline: { ...value.timeline, frames: value.timeline.frames.slice(0, -1) }, truncated: true }; continue; } if (value.evidence.length) { value = { ...value, evidence: value.evidence.slice(0, -1), truncated: true }; continue; } return nonActionable("projection_serialized_limit_exceeded", { source_health: projection.source_health, evidence_mode: projection.evidence_mode, execution_mode: projection.execution_mode }); } }
function decodeCursor(cursor, revision) { if (cursor == null) return 0; if (!text(cursor, 300)) fail("projection_cursor_invalid"); try { const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (!plain(parsed) || Object.keys(parsed).sort().join(",") !== "o,r,v" || parsed.v !== 1 || parsed.r !== revision || !Number.isSafeInteger(parsed.o) || parsed.o < 0) fail("projection_cursor_invalid"); return parsed.o; } catch { fail("projection_cursor_invalid"); } }
function encodeCursor(revision, offset) { return Buffer.from(JSON.stringify({ v: 1, r: revision, o: offset })).toString("base64url"); }
function eventIdentity(event) { return { sequence: event.sequence, id: event.id, type: event.type, recorded_at: event.recorded_at, actor: event.actor, offset_ms: event.offset_ms ?? 0, parent_id: event.parent_id ?? null, correlation_id: event.correlation_id ?? null, payload_sha256: event.payload_sha256 || sha256Canonical(event.payload), evidence_refs: event.evidence_refs }; }
function evidenceIdentity(record) { return { id: record.id, sha256: record.hash || record.provenance?.sha256 || derivedLegacyHash(record), source: record.source, kind: record.kind, observed_at: record.at }; }
function revisionTopology(topology) { return graphFor(topology); }
function identityMatches(events, identity) { if (!plain(identity) || Object.keys(identity).sort().join(",") !== "event_id,payload_sha256,sequence" || !id(identity.event_id) || !Number.isSafeInteger(identity.sequence) || !isHash(identity.payload_sha256)) return false; const event = eventFor(events, identity.event_id); return Boolean(event && event.sequence === identity.sequence && (event.payload_sha256 || sha256Canonical(event.payload)) === identity.payload_sha256); }
function eventFor(events, eventId) { return events.find((event) => event.id === eventId) || null; }
function sameRefs(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]); }
function has(events, type) { return events.some((event) => event.type === type); }
function lastEvent(events, type) { return [...events].reverse().find((event) => event.type === type) || null; }
function unique(values) { return [...new Set(values)]; }
function safeText(value, limit) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>&"']/g, " ").slice(0, limit) : "unknown"; }
function safeEnum(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function safeHash(value) { return isHash(value) ? value : null; }
function id(value) { return typeof value === "string" && ID.test(value) && Buffer.byteLength(value, "utf8") <= 200; }
function text(value, limit) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit; }
function timestamp(value) { return text(value, 40) && Number.isFinite(Date.parse(value)); }
function isHash(value) { return typeof value === "string" && HASH.test(value); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function compareCanonical(left, right) { return sha256Canonical(left).localeCompare(sha256Canonical(right)); }
function boundedValue(value, maximum, depth = 0, budget = { bytes: 0, values: 0 }) { if (depth > INCIDENT_PROJECTION_LIMITS.max_value_depth || budget.values++ > 512) return false; if (value == null || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (typeof value === "string") { budget.bytes += Buffer.byteLength(value, "utf8"); return budget.bytes <= maximum; } if (Array.isArray(value)) { if (value.length > 64) return false; return value.every((item) => boundedValue(item, maximum, depth + 1, budget)); } if (!plain(value) || Object.keys(value).length > 64) return false; return Object.entries(value).every(([key, item]) => text(key, 160) && boundedValue(item, maximum, depth + 1, budget)); }
function fail(code) { const error = new Error("Incident projection is non-actionable"); error.code = code; throw error; }
function nonActionable(code, axes = null) { const truthful = axes && SOURCE_HEALTH.has(axes.source_health) && EVIDENCE_MODE.has(axes.evidence_mode) && EXECUTION_MODE.has(axes.execution_mode) ? axes : { source_health: "unavailable", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay" }; return { schema_version: INCIDENT_PROJECTION_SCHEMA_VERSION, projection_revision: null, run_id: null, incident: { id: null, title: "Unavailable incident projection", severity: "unknown" }, stage: stage("monitor"), stage_status: "non_actionable", ...truthful, graph: { nodes: [], edges: [], total_nodes: 0, total_edges: 0, truncated: false }, timeline: { frames: [], total_frames: 0, cursor: null }, evidence: [], investigation: { hypotheses: [], counter_evidence: null, evaluator: { verdict: "unavailable", evidence_refs: [] }, diagnosis_gate: { status: "unavailable", event_id: null, evidence_refs: [] }, replan: { status: "unavailable", event_id: null } }, decision: { status: "non_actionable", decision_id: null, risk_tier: "unknown", evidence_refs: [] }, human_gate: { status: "not_actionable", request_id: null, approval_id: null }, action: { status: "not_actionable", event_id: null, truth: null }, verification: { status: "not_actionable", event_id: null, passed: null, evidence_refs: [] }, learning: { regression_id: null, backtest_id: null, policy_id: null, backtest_source: null }, why_stopped: { code: safeText(code, 120), detail_status: "recorded" }, truncated: false, truncation: { graph_nodes: 0, graph_edges: 0, timeline_frames: 0, evidence_summaries: 0, serialized_bytes: 0 }, next_cursor: null }; }

const SCHEMA_VERSION = "flowpulse.incident-projection.v1";
const MAX_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>&"']+$/;
const STAGES = new Set(["monitor", "agent_workbench", "decision_recovery"]);
const SOURCE_HEALTH = new Set(["live", "stale", "disconnected", "unavailable"]);
const EVIDENCE_MODE = new Set(["live_stream", "frozen_real_snapshot", "captured_fixture"]);
const EXECUTION_MODE = new Set(["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"]);

/** Browser-only read boundary. This validates the bounded server projection;
 * it has no ledger, authority, receipt issuer, executor, or model imports. */
export class ProjectionUnavailableError extends Error {
  constructor(code = "projection_unavailable") {
    super("Incident projection is unavailable");
    this.name = "ProjectionUnavailableError";
    this.code = code;
  }
}

export class BackendIncidentProjectionClient {
  async load() {
    let response;
    try {
      response = await fetch("/api/state", { headers: { accept: "application/json" }, credentials: "same-origin" });
    } catch {
      throw new ProjectionUnavailableError("backend_unavailable");
    }
    if (!response.ok) throw new ProjectionUnavailableError("backend_unavailable");
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProjectionUnavailableError("backend_payload_invalid");
    }
    return validateIncidentProjection(payload?.incident_projection);
  }
}

const FIXED_DEMO_BUNDLE = Object.freeze({
  schema_version: SCHEMA_VERSION,
  projection_revision: "b".repeat(64),
  run_id: "run-captured-demo",
  incident: { id: "captured-demo", title: "Captured replay unavailable", severity: "unknown" },
  stage: { id: "monitor", label: "Monitor" },
  stage_status: "non_actionable",
  source_health: "unavailable",
  evidence_mode: "captured_fixture",
  execution_mode: "deterministic_replay",
  graph: { nodes: [], edges: [], total_nodes: 0, total_edges: 0, truncated: false },
  timeline: { frames: [], total_frames: 0, cursor: null },
  evidence: [],
  investigation: {
    hypotheses: [], counter_evidence: null,
    evaluator: { verdict: "unavailable", evidence_refs: [] },
    diagnosis_gate: { status: "unavailable", event_id: null, evidence_refs: [] },
    replan: { status: "unavailable", event_id: null }
  },
  decision: { status: "unavailable", decision_id: null, risk_tier: "unknown", evidence_refs: [] },
  human_gate: { status: "unavailable", request_id: null, approval_id: null },
  action: { status: "unavailable", event_id: null, truth: null },
  verification: { status: "unavailable", event_id: null, passed: null, evidence_refs: [] },
  learning: { regression_id: null, backtest_id: null, policy_id: null, backtest_source: null },
  why_stopped: { code: "captured_demo_unavailable", detail_status: "unavailable" },
  truncated: false,
  truncation: { graph_nodes: 0, graph_edges: 0, timeline_frames: 0, evidence_summaries: 0, serialized_bytes: 1600 },
  next_cursor: null
});

/** Fixed captured bundles may be selected only by the build-owned composition.
 * This class does not accept replay commands, cursors, or authority-shaped input. */
export class DemoBundleProjectionClient {
  #bundle = validateIncidentProjection(FIXED_DEMO_BUNDLE);

  async load() {
    return this.#bundle;
  }
}

// This is deliberately a build-owned constant. There is no query, storage,
// request, model, or automatic fallback path for client selection.
const BUILD_PROJECTION_CLIENT = "backend";
const configuredClient = new BackendIncidentProjectionClient();
export function configuredIncidentProjectionClient() {
  return BUILD_PROJECTION_CLIENT === "backend" ? configuredClient : (() => { throw new ProjectionUnavailableError("projection_client_configuration_invalid"); })();
}

export function validateIncidentProjection(value) {
  try {
    if (!plain(value) || bytes(value) > MAX_BYTES) fail("projection_schema_invalid");
    exactKeys(value, ["schema_version", "projection_revision", "run_id", "incident", "stage", "stage_status", "source_health", "evidence_mode", "execution_mode", "graph", "timeline", "evidence", "investigation", "decision", "human_gate", "action", "verification", "learning", "why_stopped", "truncated", "truncation", "next_cursor"]);
    if (value.schema_version !== SCHEMA_VERSION || !hash(value.projection_revision) || !id(value.run_id)) fail("projection_schema_invalid");
    incident(value.incident); stage(value.stage);
    enumValue(value.source_health, SOURCE_HEALTH); enumValue(value.evidence_mode, EVIDENCE_MODE); enumValue(value.execution_mode, EXECUTION_MODE);
    safeText(value.stage_status, 80);
    graph(value.graph); timeline(value.timeline); evidence(value.evidence); investigation(value.investigation); decision(value.decision); humanGate(value.human_gate); action(value.action); verification(value.verification); learning(value.learning); whyStopped(value.why_stopped); truncation(value.truncation);
    if (typeof value.truncated !== "boolean" || !(value.next_cursor === null || validCursor(value.next_cursor, value.projection_revision))) fail("projection_cursor_invalid");
    // A source that is not currently available must be rendered non-actionable,
    // even though its capture/evidence/execution provenance remains visible.
    if (value.source_health !== "live" && value.stage_status !== "non_actionable") fail("projection_source_not_actionable");
    return deepFreeze(structuredClone(value));
  } catch (error) {
    if (error instanceof ProjectionUnavailableError) throw error;
    throw new ProjectionUnavailableError("projection_schema_invalid");
  }
}

export function projectionPresentation(projection) {
  const value = validateIncidentProjection(projection);
  return Object.freeze({
    stage: value.stage.id,
    stage_status: value.stage_status,
    risk_tier: value.decision.risk_tier,
    evaluator: value.investigation.evaluator.verdict,
    diagnosis_gate: value.investigation.diagnosis_gate.status,
    receipt: value.decision.decision_id ? "ledger_derived" : "not_recorded",
    verification: value.verification.status,
    why_stopped: value.why_stopped.code,
    // Slice D has no authority or action capability, even for a canonical gate.
    actionable: false
  });
}

function incident(value) { exactKeys(value, ["id", "title", "severity"]); if (!id(value.id) || !safeText(value.title, 180) || !["SEV-1", "SEV-2", "SEV-3", "SEV-4", "unknown"].includes(value.severity)) fail(); }
function stage(value) { exactKeys(value, ["id", "label"]); if (!STAGES.has(value.id) || !safeText(value.label, 80)) fail(); }
function graph(value) {
  exactKeys(value, ["nodes", "edges", "total_nodes", "total_edges", "truncated"]);
  if (!Array.isArray(value.nodes) || value.nodes.length > 128 || !Array.isArray(value.edges) || value.edges.length > 256 || !count(value.total_nodes) || !count(value.total_edges) || typeof value.truncated !== "boolean") fail();
  const ids = new Set();
  for (const node of value.nodes) { exactKeys(node, ["id", "label", "kind"]); if (!id(node.id) || ids.has(node.id) || !safeText(node.label, 160) || !safeText(node.kind, 80)) fail(); ids.add(node.id); }
  const edgeIds = new Set();
  for (const edge of value.edges) { exactKeys(edge, ["id", "from", "to", "kind"]); if (!id(edge.id) || edgeIds.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to) || !safeText(edge.kind, 80)) fail(); edgeIds.add(edge.id); }
}
function timeline(value) {
  exactKeys(value, ["frames", "total_frames", "cursor"]);
  if (!Array.isArray(value.frames) || value.frames.length > 100 || !count(value.total_frames) || !(value.cursor === null || validCursor(value.cursor))) fail();
  let sequence = 0;
  for (const frame of value.frames) { exactKeys(frame, ["id", "sequence", "at", "type", "actor", "evidence_refs"]); if (!id(frame.id) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence || !timestamp(frame.at) || !safeText(frame.type, 100) || !safeText(frame.actor, 80) || !refs(frame.evidence_refs)) fail(); sequence = frame.sequence; }
}
function evidence(value) { if (!Array.isArray(value) || value.length > 64) fail(); const ids = new Set(); for (const record of value) { exactKeys(record, ["id", "kind", "signal", "entity", "source", "observed_at", "record_sha256", "provenance_status"]); if (!id(record.id) || ids.has(record.id) || !safeText(record.kind, 80) || !safeText(record.signal, 80) || !safeText(record.entity, 120) || !safeText(record.source, 160) || !timestamp(record.observed_at) || !hash(record.record_sha256) || !["record_bound", "legacy_detail_unavailable"].includes(record.provenance_status)) fail(); ids.add(record.id); } }
function investigation(value) {
  exactKeys(value, ["hypotheses", "counter_evidence", "evaluator", "diagnosis_gate", "replan"]);
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 8) fail();
  for (const hypothesis of value.hypotheses) { exactKeys(hypothesis, ["id", "status", "evidence_refs"]); if (!id(hypothesis.id) || !safeText(hypothesis.status, 80) || !refs(hypothesis.evidence_refs)) fail(); }
  if (value.counter_evidence !== null) { exactKeys(value.counter_evidence, ["hypothesis_id", "evidence_refs"]); if (!id(value.counter_evidence.hypothesis_id) || !refs(value.counter_evidence.evidence_refs)) fail(); }
  exactKeys(value.evaluator, ["verdict", "evidence_refs"]); exactKeys(value.diagnosis_gate, ["status", "event_id", "evidence_refs"]); exactKeys(value.replan, ["status", "event_id"]);
  if (!["accepted", "rejected", "pending", "unavailable"].includes(value.evaluator.verdict) || !refs(value.evaluator.evidence_refs) || !["passed", "pending", "unavailable"].includes(value.diagnosis_gate.status) || !(value.diagnosis_gate.event_id === null || id(value.diagnosis_gate.event_id)) || !refs(value.diagnosis_gate.evidence_refs) || !["recorded", "not_recorded", "unavailable"].includes(value.replan.status) || !(value.replan.event_id === null || id(value.replan.event_id))) fail();
}
function decision(value) { if (!plain(value) || ![["status", "decision_id", "risk_tier", "evidence_refs"], ["status", "decision_id", "risk_tier", "evidence_refs", "contract_sha256"]].some((keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)))) fail(); if (!safeText(value.status, 80) || !(value.decision_id === null || id(value.decision_id)) || !(value.risk_tier === null || ["low", "medium", "high", "unknown"].includes(value.risk_tier)) || !refs(value.evidence_refs) || !(value.contract_sha256 === undefined || value.contract_sha256 === null || hash(value.contract_sha256))) fail(); }
function humanGate(value) { exactKeys(value, ["status", "request_id", "approval_id"]); if (!safeText(value.status, 80) || !(value.request_id === null || id(value.request_id)) || !(value.approval_id === null || id(value.approval_id))) fail(); }
function action(value) { exactKeys(value, ["status", "event_id", "truth"]); if (!safeText(value.status, 80) || !(value.event_id === null || id(value.event_id)) || !(value.truth === null || safeText(value.truth, 80))) fail(); }
function verification(value) { exactKeys(value, ["status", "event_id", "passed", "evidence_refs"]); if (!safeText(value.status, 80) || !(value.event_id === null || id(value.event_id)) || !(value.passed === null || typeof value.passed === "boolean") || !refs(value.evidence_refs)) fail(); }
function learning(value) { exactKeys(value, ["regression_id", "backtest_id", "policy_id", "backtest_source"]); for (const key of ["regression_id", "backtest_id", "policy_id"]) if (!(value[key] === null || id(value[key]))) fail(); if (!(value.backtest_source === null || ["executed_offline_backtest", "captured_fixture"].includes(value.backtest_source))) fail(); }
function whyStopped(value) { exactKeys(value, ["code", "detail_status"]); if (!(value.code === null || safeText(value.code, 120)) || !safeText(value.detail_status, 80)) fail(); }
function truncation(value) { exactKeys(value, ["graph_nodes", "graph_edges", "timeline_frames", "evidence_summaries", "serialized_bytes"]); for (const key of Object.keys(value)) if (!count(value[key])) fail(); if (value.serialized_bytes > MAX_BYTES) fail(); }
function refs(value) { return Array.isArray(value) && value.length <= 32 && new Set(value).size === value.length && value.every(id); }
function validCursor(value, revision = null) { if (typeof value !== "string" || value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) return false; try { const parsed = JSON.parse(decodeBase64Url(value)); return plain(parsed) && Object.keys(parsed).sort().join(",") === "o,r,v" && parsed.v === 1 && (!revision || parsed.r === revision) && hash(parsed.r) && Number.isSafeInteger(parsed.o) && parsed.o >= 0; } catch { return false; } }
function decodeBase64Url(value) { const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4); return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))); }
function exactKeys(value, keys) { if (!plain(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(); }
function enumValue(value, allowed) { if (!allowed.has(value)) fail(); }
function safeText(value, max) { if (typeof value !== "string" || !value.length || value.length > max || !SAFE_TEXT.test(value)) fail(); return value; }
function timestamp(value) { if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return false; return true; }
function id(value) { return typeof value === "string" && ID.test(value); }
function hash(value) { return typeof value === "string" && HASH.test(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function bytes(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function fail(code = "projection_schema_invalid") { throw new ProjectionUnavailableError(code); }

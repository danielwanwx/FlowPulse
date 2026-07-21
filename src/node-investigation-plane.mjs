import { canonicalSha256 } from "./evidence-envelope.mjs";
import { composeComponentDetail, ComponentDetailProjectionError } from "./component-detail-projection.mjs";

export const NODE_INVESTIGATION_SCHEMA_VERSION = "flowpulse.node-investigation.v1";
export const NODE_INVESTIGATION_LIMITS = Object.freeze({
  windows: ["5m", "15m", "1h"],
  signals: ["all", "metric", "log", "trace", "change", "resource"],
  default_window: "15m",
  default_limit: 8,
  max_limit: 12,
  max_records: 12,
  max_response_bytes: 48 * 1024,
  max_tool_calls: 4,
  max_tool_rounds: 2,
  max_calls_per_tool: 2
});

export const NODE_INVESTIGATION_TOOLS = Object.freeze([
  "get_component_snapshot",
  "query_component_metrics",
  "query_component_logs",
  "query_component_traces",
  "query_component_dependencies",
  "query_recent_changes",
  "query_data_resources"
]);

export const ROLE_NODE_TOOL_ALLOWLIST = Object.freeze({
  observer: Object.freeze(["get_component_snapshot", "query_component_metrics", "query_component_logs"]),
  orchestrator: Object.freeze([]),
  investigator: Object.freeze([...NODE_INVESTIGATION_TOOLS]),
  evaluator: Object.freeze(["get_component_snapshot", "query_component_metrics", "query_component_traces", "query_component_dependencies", "query_recent_changes"])
});

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_STATUSES = new Set(["captured", "frozen", "live", "stale", "disconnected", "unavailable"]);
const RESOURCE_KINDS = new Set(["topic", "consumer_group", "database", "table", "job", "dag"]);

export class NodeInvestigationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NodeInvestigationError";
    this.code = code;
    this.status = status;
  }
}

export function validateNodeEvidenceQuery(value = {}, { allowSignal = true } = {}) {
  if (!plain(value)) throw new NodeInvestigationError("node_evidence_query_invalid");
  const allowed = new Set(["window", "signal", "cursor", "limit"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new NodeInvestigationError("node_evidence_query_unknown_field");
  const window = value.window == null ? NODE_INVESTIGATION_LIMITS.default_window : value.window;
  const signal = value.signal == null ? "all" : value.signal;
  const cursor = value.cursor == null || value.cursor === "" ? null : value.cursor;
  const limit = value.limit == null || value.limit === "" ? NODE_INVESTIGATION_LIMITS.default_limit : Number(value.limit);
  if (!NODE_INVESTIGATION_LIMITS.windows.includes(window)) throw new NodeInvestigationError("node_evidence_window_invalid");
  if (!allowSignal && signal !== "all") throw new NodeInvestigationError("node_evidence_signal_invalid");
  if (!NODE_INVESTIGATION_LIMITS.signals.includes(signal)) throw new NodeInvestigationError("node_evidence_signal_invalid");
  if (cursor !== null && (!CURSOR.test(cursor) || Buffer.byteLength(cursor, "utf8") > 120)) throw new NodeInvestigationError("node_evidence_cursor_invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NODE_INVESTIGATION_LIMITS.max_limit) throw new NodeInvestigationError("node_evidence_limit_invalid");
  return Object.freeze({ window, signal, cursor, limit });
}

export class NodeInvestigationPlane {
  constructor({ topologyViews, source, sourceState = null, incidentProjection = null, now = () => Date.now() } = {}) {
    if (!source || typeof source.list !== "function" || typeof source.metadata !== "function") throw new Error("NodeInvestigationPlane requires a bounded evidence source");
    this.topologyViews = topologyViews;
    this.source = source;
    this.sourceState = sourceState;
    this.incidentProjection = incidentProjection;
    this.now = now;
    this.cache = new Map();
  }

  snapshot(nodeId, rawQuery = {}) {
    if (!ID.test(nodeId || "")) throw new NodeInvestigationError("component_detail_unavailable", 404);
    const query = validateNodeEvidenceQuery(rawQuery);
    const records = this.recordsFor(nodeId, query);
    let detail;
    try {
      detail = composeComponentDetail({
        topologyViews: this.topologyViews,
        nodeId,
        source: this.sourceMetadata(),
        evidence: records.all.slice(0, 8).map(componentEvidence)
      });
    } catch (error) {
      if (error instanceof ComponentDetailProjectionError) throw new NodeInvestigationError(error.code === "component_detail_node_unavailable" ? "component_detail_unavailable" : error.code, 409);
      throw error;
    }
    const page = pageRecords(records.selected, query, nodeId);
    const projection = {
      schema_version: NODE_INVESTIGATION_SCHEMA_VERSION,
      topology_projection_revision: this.topologyViews?.projection_revision || null,
      component: detail.component,
      purpose: detail.purpose,
      health: {
        status: detail.component.status,
        severity: safeText(this.incidentProjection?.incident?.severity, 32) || null,
        incident_id: safeId(this.incidentProjection?.incident?.id)
      },
      runtime: detail.runtime,
      source_truth: this.sourceTruth(),
      relationships: detail.relationships,
      observability: detail.observability,
      configuration: detail.configuration,
      data_resources: detail.data_resources,
      evidence: page,
      window: { value: query.window, applied: this.windowApplied() },
      raw_payload_excluded: true
    };
    const detailRevision = canonicalSha256({ ...projection, detail_revision: null });
    const result = { ...projection, detail_revision: detailRevision };
    enforceBytes(result);
    return deepFreeze(result);
  }

  invoke({ role, tool, componentId, query = {} } = {}) {
    if (!ROLE_NODE_TOOL_ALLOWLIST[role]?.includes(tool)) throw new NodeInvestigationError("node_tool_role_forbidden", 403);
    if (!NODE_INVESTIGATION_TOOLS.includes(tool) || !ID.test(componentId || "")) throw new NodeInvestigationError("node_tool_request_invalid");
    const normalized = validateNodeEvidenceQuery(query);
    const allowedSignal = signalForTool(tool);
    if (allowedSignal && normalized.signal !== "all" && normalized.signal !== allowedSignal) throw new NodeInvestigationError("node_tool_signal_forbidden");
    const fingerprint = canonicalSha256({ tool, component_id: componentId, query: normalized, topology_revision: this.topologyViews?.projection_revision || null });
    const cached = this.cache.get(fingerprint);
    if (cached) return deepFreeze({ ...cached, cached: true });
    this.requireReadableSource();
    let result;
    if (tool === "get_component_snapshot") {
      const snapshot = this.snapshot(componentId, normalized);
      const evidence = snapshot.evidence.items;
      result = resultFor({ tool, componentId, normalized, fingerprint, records: evidence, detail: snapshot, omitted: snapshot.evidence.omitted_count });
    } else if (tool === "query_component_dependencies") {
      const snapshot = this.snapshot(componentId, { ...normalized, signal: "all" });
      const records = [...snapshot.relationships.upstream, ...snapshot.relationships.downstream].map((item) => ({
        id: `relation-${componentId}-${item.id}`,
        kind: "dependency",
        signal: "resource",
        title: `${componentId} ${item.relation} ${item.id}`,
        summary: `${item.relation} relation`,
        entity: componentId,
        observed_at: null,
        record_sha256: canonicalSha256(item),
        provenance: { status: "record_bound", sha256: canonicalSha256(item) },
        raw_payload_excluded: true
      }));
      result = resultFor({ tool, componentId, normalized, fingerprint, records, detail: null, omitted: 0 });
    } else {
      const forced = allowedSignal || "resource";
      const records = this.recordsFor(componentId, { ...normalized, signal: forced });
      const page = pageRecords(records.selected, { ...normalized, signal: forced }, componentId);
      result = resultFor({ tool, componentId, normalized, fingerprint, records: page.items, detail: null, omitted: page.omitted_count });
    }
    result = { ...result, source_truth: this.sourceTruth() };
    this.cache.set(fingerprint, result);
    return deepFreeze(result);
  }

  recordsFor(componentId, query) {
    const raw = this.source.list({ entity: componentId, limit: 50 })?.items || [];
    const all = raw.map(safeEvidence).filter(Boolean).filter((record) => this.withinWindow(record, query.window));
    const selected = all.filter((record) => matchesSignal(record, query.signal));
    if (query.cursor && !selected.some((item) => item.id === query.cursor)) throw new NodeInvestigationError("node_evidence_cursor_invalid");
    return { all, selected };
  }

  sourceMetadata() { return this.source.metadata() || {}; }
  sourceTruth() {
    const metadata = this.sourceMetadata();
    const status = SOURCE_STATUSES.has(metadata.status) ? metadata.status : "unavailable";
    const mode = safeText(metadata.mode, 80) || "unavailable";
    return {
      mode,
      status,
      freshness_ms: safeInt(this.sourceState?.freshness_ms ?? metadata.freshness_ms, 31_536_000_000),
      observed_at: safeTimestamp(this.sourceState?.last_observed_at ?? metadata.last_observed_at),
      truth_label: status === "captured" ? "captured_replay" : status === "frozen" ? "frozen_snapshot" : status === "live" ? "live" : status,
      evidence_count: safeInt(metadata.evidence_count, 100_000) || 0
    };
  }

  requireReadableSource() {
    const status = this.sourceTruth().status;
    if (["stale", "disconnected", "unavailable"].includes(status)) throw new NodeInvestigationError(`node_source_${status}`, 409);
  }

  windowApplied() { return this.sourceTruth().status === "live" || this.sourceTruth().status === "frozen"; }

  withinWindow(record, window) {
    if (!this.windowApplied()) return true;
    const at = Date.parse(record.observed_at || "");
    const age = this.now() - at;
    return Number.isFinite(at) && age >= 0 && age <= windowMs(window);
  }
}

function resultFor({ tool, componentId, normalized, fingerprint, records, detail, omitted }) {
  const safeRecords = records.slice(0, NODE_INVESTIGATION_LIMITS.max_records);
  const evidenceRefs = safeRecords.map((record) => record.id).filter(Boolean);
  const hashes = safeRecords.map((record) => record.record_sha256).filter(Boolean);
  const result = {
    schema_version: NODE_INVESTIGATION_SCHEMA_VERSION,
    tool,
    component_id: componentId,
    query: normalized,
    query_fingerprint: fingerprint,
    result_count: safeRecords.length,
    selected_count: safeRecords.length,
    omitted_count: Math.max(0, Number(omitted) || 0),
    evidence_refs: evidenceRefs,
    evidence_hashes: hashes,
    records: safeRecords,
    ...(detail ? { snapshot: detail } : {}),
    raw_payload_excluded: true,
    cached: false
  };
  enforceBytes(result);
  return result;
}

function pageRecords(records, query, componentId) {
  const start = query.cursor ? records.findIndex((item) => item.id === query.cursor) + 1 : 0;
  const selected = records.slice(start, start + query.limit);
  const total = records.length;
  const items = selected.slice(0, NODE_INVESTIGATION_LIMITS.max_records);
  return {
    items,
    next_cursor: start + items.length < total && items.length ? items.at(-1).id : null,
    cursor: query.cursor,
    total_matching: total,
    selected_count: items.length,
    omitted_count: Math.max(0, total - start - items.length),
    truncated: start + items.length < total,
    component_id: componentId,
    raw_payload_excluded: true
  };
}

function safeEvidence(value) {
  if (!plain(value) || !safeId(value.id)) return null;
  const safeValue = safeEvidenceValue(value.value, value.fact);
  const resource = safeValue.resource;
  const record_sha256 = safeHash(value.hash || value.record_sha256 || value.provenance?.sha256) || canonicalSha256({ id: value.id, kind: value.kind, signal: value.signal || null, title: value.title, entity: value.entity, source: value.source, observed_at: value.at || value.observed_at || null, value: safeValue });
  return {
    id: value.id,
    kind: safeText(value.kind, 80) || "unknown",
    signal: safeText(value.signal, 80) || "unknown",
    title: safeText(value.title, 180) || "Bounded evidence",
    summary: typeof value.fact === "string" ? redactText(value.fact).slice(0, 360) || null : null,
    entity: safeId(value.entity) || "unknown",
    source: safeText(value.source, 160) || "unknown",
    observed_at: safeTimestamp(value.at || value.observed_at),
    captured_at: safeTimestamp(value.captured_at),
    record_sha256,
    value: safeValue,
    resource,
    provenance: { status: safeHash(value.hash || value.record_sha256 || value.provenance?.sha256) ? "record_bound" : "legacy_summary_bound", sha256: record_sha256 },
    raw_payload_excluded: true
  };
}

function componentEvidence(record) {
  return {
    id: record.id,
    kind: record.kind,
    signal: record.signal,
    title: record.title,
    fact: record.summary,
    entity: record.entity,
    source: record.source,
    at: record.observed_at,
    captured_at: record.captured_at,
    hash: record.record_sha256,
    provenance: { sha256: record.record_sha256 },
    value: record.value
  };
}

function safeEvidenceValue(value, fact = null) {
  const source = plain(value) ? value : {};
  const metric = plain(source.metric) ? {
    name: safeText(source.metric.name, 120),
    value: safeNumber(source.metric.value), before: safeNumber(source.metric.before), after: safeNumber(source.metric.after),
    unit: safeText(source.metric.unit, 40), aggregation: safeText(source.metric.aggregation, 40), threshold: safeText(source.metric.threshold, 80)
  } : null;
  const trace = plain(source.trace) ? {
    operation: safeText(source.trace.operation, 160), peer_target: safeText(source.trace.peer_target, 160), status: safeText(source.trace.status, 40),
    error: safeText(source.trace.error, 160), trace_ref: safeRef(source.trace.trace_ref), span_ref: safeRef(source.trace.span_ref)
  } : null;
  const log = plain(source.log) ? {
    severity: safeText(source.log.severity, 32), message: redactText(safeText(source.log.message, 280) || ""), trace_ref: safeRef(source.log.trace_ref), span_ref: safeRef(source.log.span_ref)
  } : typeof fact === "string" ? { severity: null, message: redactText(fact).slice(0, 280), trace_ref: null, span_ref: null } : null;
  const change = plain(source.change) ? {
    target: safeId(source.change.target), flag: safeText(source.change.flag, 120), before: safeText(source.change.before, 120), after: safeText(source.change.after, 120), applied_at: safeTimestamp(source.change.applied_at)
  } : null;
  return { metric, trace, log, change, resource: safeResource(source.resource) };
}

function safeResource(value) {
  if (!plain(value) || !RESOURCE_KINDS.has(value.kind)) return null;
  const id = safeId(value.id);
  const name = safeText(value.name, 160);
  const consumer_group = safeText(value.consumer_group, 160);
  return id || name ? { kind: value.kind, id, name, consumer_group } : null;
}

function signalForTool(tool) {
  return ({ query_component_metrics: "metric", query_component_logs: "log", query_component_traces: "trace", query_recent_changes: "change", query_data_resources: "resource" })[tool] || null;
}

function matchesSignal(record, signal) {
  if (signal === "all") return true;
  if (signal === "metric") return record.kind === "metric" || record.signal === "metric";
  if (signal === "log") return record.kind === "log" || record.signal === "log";
  if (signal === "trace") return record.kind === "trace" || record.signal === "trace";
  if (signal === "change") return ["change", "deploy", "commit", "code"].includes(record.kind) || record.signal === "change";
  return record.kind === "resource" || record.signal === "resource" || record.resource !== null;
}

function windowMs(value) { return ({ "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000 })[value]; }
function enforceBytes(value) { if (Buffer.byteLength(JSON.stringify(value), "utf8") > NODE_INVESTIGATION_LIMITS.max_response_bytes) throw new NodeInvestigationError("node_evidence_response_limit_exceeded", 413); }
function redactText(value) { return String(value || "").replace(/[\u0000-\u001f\u007f<>&]/g, " ").replace(/\b(?:sk|rk)_[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, "[redacted]").replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, "configuration").replace(/\b(?:system|developer|user)\s+prompt\b/gi, "prompt [redacted]").replace(/\s+/g, " ").trim(); }
function safeText(value, limit) { return typeof value === "string" && Buffer.byteLength(value, "utf8") <= limit && value.length > 0 ? value.replace(/[\u0000-\u001f\u007f<>&]/g, " ").trim() : null; }
function safeId(value) { return typeof value === "string" && ID.test(value) ? value : null; }
function safeHash(value) { return typeof value === "string" && HASH.test(value) ? value : null; }
function safeRef(value) { return typeof value === "string" && /^[a-f0-9]{8,64}$/i.test(value) ? value : null; }
function safeTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
function safeInt(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null; }
function safeNumber(value) { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : null; }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }

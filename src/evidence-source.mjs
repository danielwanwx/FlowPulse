import { createHash } from "node:crypto";
import { evidenceById, queryEvidence } from "./bundle.mjs";
import { evaluateCheckoutPaymentDiagnosisGate, isExecutableCheckoutPaymentEvidence } from "./incident-mechanism.mjs";
import { sanitizeTelemetryText } from "./telemetry-sanitizer.mjs";

export const EVIDENCE_LIST_DEFAULT = 25;
export const EVIDENCE_LIST_MAX = 50;
export const EVIDENCE_LIST_MAX_BYTES = 48 * 1024;
export const SNAPSHOT_MAX_RECORDS = 120;
export const SNAPSHOT_MAX_BYTES = 512 * 1024;
export const INCIDENT_ENTITIES = ["checkout", "payment", "kafka", "accounting", "fraud", "fraud-detection"];

export class CapturedBundleEvidenceSource {
  constructor(bundle) {
    this.bundle = bundle;
    this.records = [...bundle.evidence].sort(compareEvidence);
    this.mode = "deterministic_replay";
    this.captureTopology = capturedTopology(bundle.topology);
  }

  metadata() {
    return { mode: this.mode, label: "deterministic replay", status: "captured", authoritative: true, evidence_count: this.records.length };
  }

  list(options = {}) { return page(this.records, options); }
  detail(id) { return detailFor(this.records, id); }
  summariesById(ids) { return evidenceById(this.bundle, ids).map(summarizeEvidence); }
  query({ kind, entity } = {}) { return queryEvidence(this.bundle, { kind, entity }).map(summarizeEvidence); }
  entities() { return this.bundle.topology.services.map((service) => service.id); }
  topology() { return this.captureTopology; }
  has(id) { return this.records.some((record) => record.id === id); }
}

export class LiveOtlpEvidenceSource {
  constructor(project) {
    this.project = project;
    this.records = [...(project.evidence || [])].sort(compareEvidence);
    this.mode = "captured_real_evidence";
  }

  metadata() {
    return {
      mode: this.project.status === "live" ? "live_otlp" : this.mode,
      label: this.project.status === "live" ? "live OTLP (not yet frozen)" : "captured real evidence",
      status: this.project.status,
      authoritative: Boolean(this.project.authoritative),
      evidence_count: this.records.length,
      last_observed_at: this.project.last_observed_at,
      freshness_ms: this.project.freshness_ms
    };
  }

  list(options = {}) { return page(this.records, options); }
  detail(id) { return detailFor(this.records, id); }
  summariesById(ids) { return selected(this.records, ids).map(summarizeEvidence); }
  query({ kind, entity } = {}) { return this.records.filter(matches({ kind, entity })).map(summarizeEvidence); }
  entities() { return [...new Set(this.records.map((record) => record.entity))].sort(); }
  topology() { return sourceTopology(this.project.topology); }
  has(id) { return this.records.some((record) => record.id === id); }

  freeze({ incidentId, runId, after, entities = INCIDENT_ENTITIES, supplementalRecords = [], executable = false, maxRecords = SNAPSHOT_MAX_RECORDS, maxBytes = SNAPSHOT_MAX_BYTES, harness = null } = {}) {
    if (this.project.status !== "live") throw new InsufficientEvidenceError(`OTLP source is ${this.project.status}; a live frozen snapshot cannot be created`);
    const afterMs = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
    const allowedEntities = new Set(entities);
    const relevant = [...this.records.filter((record) => allowedEntities.has(record.entity) && Date.parse(record.at) >= afterMs), ...supplementalRecords]
      .sort(compareEvidence);
    const reserved = executable ? requiredCausalRecords(relevant, supplementalRecords, after) : [];
    const reservedBytes = reserved.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(summarizeEvidence(record))), 0);
    if (executable && (reserved.length > maxRecords || reservedBytes > maxBytes)) {
      throw new InsufficientEvidenceError("Executable snapshot caps cannot retain the complete pre-approval Diagnosis Gate evidence");
    }
    const included = [];
    let bytes = 0;
    for (const record of [...reserved, ...relevant.filter((record) => !reserved.some((item) => item.id === record.id))]) {
      const size = Buffer.byteLength(JSON.stringify(summarizeEvidence(record)));
      if (included.length >= maxRecords || bytes + size > maxBytes) break;
      included.push(record);
      bytes += size;
    }
    if (executable && reserved.some((record) => !included.some((item) => item.id === record.id))) {
      throw new InsufficientEvidenceError("Executable snapshot caps cannot retain the complete pre-approval Diagnosis Gate evidence");
    }
    if (!included.length) throw new InsufficientEvidenceError("Fresh OTLP has no relevant bounded evidence for the checkout incident");
    const sourceHash = hash([...this.records, ...supplementalRecords].sort(compareEvidence).map((record) => `${record.id}:${record.provenance?.sha256 || record.hash || ""}`).join("\n"));
    const contentHash = hash(included.map((record) => `${record.id}:${record.provenance?.sha256 || ""}`).join("\n"));
    return new FrozenEvidenceSnapshot({
      id: `snapshot-${contentHash.slice(0, 16)}`,
      records: included,
      metadata: {
        mode: "frozen_real_otlp_snapshot",
        label: "frozen real OTLP snapshot",
        status: "frozen",
        incident_id: incidentId,
        run_id: runId,
        frozen_at: new Date().toISOString(),
        source_status: this.project.status,
        source_last_observed_at: this.project.last_observed_at,
        source_hash: sourceHash,
        content_hash: contentHash,
        record_count: included.length,
        source_record_count: this.records.length,
        bytes,
        caps: { max_records: maxRecords, max_bytes: maxBytes },
        truncated: included.length < relevant.length,
        reserved_causal_ids: reserved.map((record) => record.id),
        evidence_ids: included.map((record) => record.id),
        ...(harness ? { harness } : {})
      }
    });
  }
}

export class FrozenEvidenceSnapshot {
  constructor({ id, records, metadata }) {
    this.id = id;
    this.records = [...records].sort(compareEvidence);
    this.snapshot = Object.freeze({ ...metadata, evidence_ids: [...metadata.evidence_ids], caps: { ...metadata.caps } });
    this.mode = this.snapshot.mode;
  }

  metadata() { return { ...this.snapshot, evidence_ids: [...this.snapshot.evidence_ids] }; }
  list(options = {}) { return page(this.records, options); }
  detail(id) { return detailFor(this.records, id); }
  summariesById(ids) { return selected(this.records, ids).map(summarizeEvidence); }
  query({ kind, entity } = {}) { return this.records.filter(matches({ kind, entity })).map(summarizeEvidence); }
  entities() { return [...new Set(this.records.map((record) => record.entity))].sort(); }
  topology() { return EMPTY_TOPOLOGY; }
  has(id) { return this.records.some((record) => record.id === id); }
}

const EMPTY_TOPOLOGY = Object.freeze({ services: Object.freeze([]), dependencies: Object.freeze([]) });

function capturedTopology(value = {}) {
  const services = Array.isArray(value?.services) ? value.services : [];
  const nodes = services
    .filter((service) => service && typeof service.id === "string" && service.id.length > 0)
    .map((service) => Object.freeze({
      id: service.id,
      label: typeof service.label === "string" && service.label.length ? service.label : service.id,
      kind: typeof service.kind === "string" && service.kind.length ? service.kind : "service"
    }));
  const ids = new Set(nodes.map((service) => service.id));
  const dependencies = [];
  const seen = new Set();
  for (const edge of Array.isArray(value?.edges) ? value.edges : []) {
    const from = Array.isArray(edge) ? edge[0] : edge?.from;
    const to = Array.isArray(edge) ? edge[1] : edge?.to;
    if (!ids.has(from) || !ids.has(to)) continue;
    const id = typeof edge?.id === "string" && edge.id.length ? edge.id : `${from}-${to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    dependencies.push(Object.freeze({ id, from, to, kind: typeof edge?.kind === "string" && edge.kind.length ? edge.kind : "dependency" }));
  }
  return Object.freeze({ services: Object.freeze(nodes), dependencies: Object.freeze(dependencies) });
}

function sourceTopology(value = {}) {
  const services = Array.isArray(value?.services) ? value.services : Array.isArray(value?.nodes) ? value.nodes : [];
  const edges = Array.isArray(value?.dependencies) ? value.dependencies : Array.isArray(value?.edges) ? value.edges : [];
  return capturedTopology({ services, edges });
}

export class InsufficientEvidenceError extends Error {
  constructor(message, metadata = {}) { super(message); this.name = "InsufficientEvidenceError"; this.metadata = metadata && typeof metadata === "object" ? metadata : {}; }
}

export function summarizeEvidence(record) {
  return {
    id: record.id,
    kind: record.kind,
    signal: record.signal,
    title: record.title,
    fact: sanitizeTelemetryText(record.fact, { limit: 360 }),
    entity: sanitizeTelemetryText(record.entity, { limit: 120 }),
    source: sanitizeTelemetryText(record.source, { limit: 160 }),
    at: record.at,
    captured_at: record.captured_at,
    value: safeValue(record.value),
    hash: record.provenance?.sha256 || record.hash || null,
    provenance: safeProvenance(record.provenance)
  };
}

function page(records, { cursor, limit = EVIDENCE_LIST_DEFAULT, kind, entity } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || EVIDENCE_LIST_DEFAULT, 1), EVIDENCE_LIST_MAX);
  const filtered = records.filter(matches({ kind, entity }));
  const start = cursor ? Math.max(0, filtered.findIndex((record) => record.id === cursor) + 1) : 0;
  const items = [];
  let bytes = 0;
  for (const record of filtered.slice(start)) {
    const item = summarizeEvidence(record);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (items.length >= boundedLimit || bytes + size > EVIDENCE_LIST_MAX_BYTES) break;
    items.push(item);
    bytes += size;
  }
  const consumed = start + items.length;
  return {
    items,
    next_cursor: consumed < filtered.length && items.length ? items.at(-1).id : null,
    truncated: consumed < filtered.length,
    limits: { records: boundedLimit, bytes: EVIDENCE_LIST_MAX_BYTES },
    total_matching: filtered.length
  };
}

function detailFor(records, id) {
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`Unknown evidence id: ${id}`);
  return {
    ...summarizeEvidence(record),
    attributes: extractSafeAttributes(record.payload),
    payload_redacted: Boolean(record.payload),
    raw_payload_available: false
  };
}

function selected(records, ids) {
  const wanted = new Set(ids || []);
  return records.filter((record) => wanted.has(record.id));
}

function matches({ kind, entity }) {
  return (record) => (!kind || record.kind === kind) && (!entity || record.entity === entity);
}

function safeValue(value = {}) {
  return {
    services: Array.isArray(value.services) ? value.services.slice(0, 12).map((item) => sanitizeTelemetryText(item, { limit: 120 })) : [],
    trace: safeTrace(value.trace || legacyTrace(value)),
    log: safeObject(value.log, ["severity", "message", "trace_ref", "span_ref", "observed_at"]),
    metric: safeMetric(value.metric, value),
    change: safeChange(value.change, value),
    resource: safeResource(value.resource || value.data_resource),
    code: safeObject(value.code, ["id", "repository", "commit", "path", "line_start", "line_end", "content_sha256", "target", "flag", "bad_address", "charge_operation", "semantic_fact", "verified_from_git_object"])
  };
}

function legacyTrace(value) {
  return value && (value.operation || value.target || value.error || value.trace_id)
    ? { operation: value.operation, peer_target: value.target, status: value.status, error: value.error, trace_ref: value.trace_id, span_ref: value.span_id, observed_at: value.observed_at }
    : null;
}

function safeMetric(metric, legacy) {
  const result = safeObject(metric, ["name", "value", "before", "after", "unit", "aggregation", "threshold", "observed_at"])
    || safeObject(legacy, ["name", "value", "before", "after", "unit", "aggregation", "threshold", "observed_at"]);
  return result && Object.keys(result).length ? result : null;
}

function safeChange(change, legacy) {
  const result = safeObject(change, ["id", "target", "flag", "before", "after", "repair_id", "repair_command_id", "applied_at"])
    || safeObject(legacy, ["id", "target", "flag", "from", "to", "before", "after", "applied_at"]);
  if (!result) return null;
  if (result.from != null && result.before == null) result.before = result.from;
  if (result.to != null && result.after == null) result.after = result.to;
  delete result.from;
  delete result.to;
  return Object.keys(result).length ? result : null;
}

function safeResource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = ["topic", "consumer_group", "database", "table", "job", "dag"].includes(value.kind) ? value.kind : null;
  const id = typeof value.id === "string" ? sanitizeTelemetryText(value.id, { limit: 120 }) : null;
  const name = typeof value.name === "string" ? sanitizeTelemetryText(value.name, { limit: 160 }) : null;
  const consumer_group = typeof value.consumer_group === "string" ? sanitizeTelemetryText(value.consumer_group, { limit: 160 }) : null;
  return kind && (id || name) ? { kind, id, name, consumer_group } : null;
}

function safeTrace(trace) {
  if (!trace || typeof trace !== "object") return null;
  return {
    ...safeObject(trace, ["service", "operation", "peer_target", "status", "error", "observed_at", "trace_ref", "span_ref", "parent_ref"]),
    ...(trace.feature_flag ? {
      feature_flag: safeObject(trace.feature_flag, ["service", "key", "variant", "value", "provider", "reason", "evaluated_at", "trace_ref", "span_ref", "same_trace", "direct_parent"])
    } : {})
  };
}

export function versionedChangeEvidence({ manifest, applied, ledgerEvent }) {
  assertAppliedChange(manifest, applied, ledgerEvent);
  const value = {
    id: manifest.id,
    target: manifest.target,
    flag: manifest.flag,
    before: applied.before,
    after: applied.after,
    repair_id: manifest.repair_id,
    repair_command_id: manifest.repair_command_id,
    applied_at: applied.applied_at
  };
  const manifestHash = hash(JSON.stringify(manifest));
  const contentHash = hash(JSON.stringify({ manifest_hash: manifestHash, applied: value, ledger_event_id: ledgerEvent.id, recorded_at: ledgerEvent.recorded_at }));
  return {
    id: `change-${contentHash.slice(0, 16)}`,
    kind: "change",
    signal: "change",
    title: `Versioned ${manifest.target} change ${manifest.id}`,
    fact: `${manifest.target} flag ${manifest.flag} changed ${applied.before} → ${applied.after} at ${applied.applied_at}.`,
    entity: manifest.target,
    source: "repo-owned change manifest + append-only change.applied event",
    at: applied.applied_at,
    captured_at: ledgerEvent.recorded_at,
    value: { change: value, raw_sha256: contentHash },
    hash: contentHash,
    provenance: {
      file: "integrations/astronomy-shop/change.payment-unreachable.json",
      line: null,
      byte_start: null,
      byte_end: null,
      sha256: contentHash,
      manifest_sha256: manifestHash,
      ledger_event_id: ledgerEvent.id,
      immutable_capture: true
    }
  };
}

function assertAppliedChange(manifest = {}, applied = {}, ledgerEvent = {}) {
  for (const key of ["id", "target", "flag", "known_good", "after", "repair_id", "repair_command_id"]) {
    if (!manifest[key]) throw new InsufficientEvidenceError(`Applied change is missing ${key}`);
  }
  for (const key of ["before", "after", "applied_at"]) {
    if (applied[key] == null || applied[key] === "") throw new InsufficientEvidenceError(`Applied change event is missing ${key}`);
  }
  if (!ledgerEvent.id || !ledgerEvent.recorded_at || !Number.isFinite(Date.parse(applied.applied_at))) throw new InsufficientEvidenceError("Applied change ledger provenance is incomplete");
  if (manifest.after !== applied.after || manifest.known_good !== applied.before) throw new InsufficientEvidenceError("Applied change before/after values differ from the captured manifest");
}

function safeObject(value, fields) {
  if (!value || typeof value !== "object") return null;
  const entries = fields
    .filter((key) => value[key] != null)
    .map((key) => [key, safeField(key, value[key])])
    .filter(([, item]) => item != null);
  return entries.length ? Object.fromEntries(entries) : null;
}

function safeField(key, value) {
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (["trace_ref", "span_ref", "parent_ref"].includes(key) && /^[a-f0-9]{12}$/.test(value)) return value;
  if (key === "content_sha256" && /^[a-f0-9]{64}$/.test(value)) return value;
  if (key === "commit" && /^[a-f0-9]{40}$/.test(value)) return value;
  return sanitizeTelemetryText(value, { limit: fieldLimit(key) });
}

function fieldLimit(key) { return key === "semantic_fact" ? 360 : key === "error" || key === "message" ? 240 : ["peer_target", "repository"].includes(key) ? 160 : 120; }

function requiredCausalRecords(records, supplementalRecords, after) {
  const change = supplementalRecords.find((record) => record.kind === "change");
  if (!change) throw new InsufficientEvidenceError("Executable development snapshot is missing its applied change record");
  const appliedAt = Date.parse(change.value?.change?.applied_at || after);
  const gate = evaluateCheckoutPaymentDiagnosisGate(records, change.value?.change);
  if (!Number.isFinite(appliedAt) || !gate.passed) {
    throw new InsufficientEvidenceError(`Executable development snapshot is missing Diagnosis Gate evidence: ${gate.missing.join(", ")}`);
  }
  return [change, ...gate.required_records].sort(compareEvidence);
}

export function isFailureTrace(record, change) {
  return isExecutableCheckoutPaymentEvidence(record, change);
}

function safeProvenance(provenance = {}) {
  return {
    file: provenance.file || null,
    line: provenance.line ?? null,
    line_end: provenance.line_end ?? null,
    byte_start: provenance.byte_start ?? null,
    byte_end: provenance.byte_end ?? null,
    sha256: provenance.sha256 || null,
    manifest_sha256: provenance.manifest_sha256 || null,
    ledger_event_id: provenance.ledger_event_id || null,
    repository: provenance.repository || null,
    commit: provenance.commit || null,
    immutable_capture: Boolean(provenance.immutable_capture),
    verified_from_git_object: Boolean(provenance.verified_from_git_object)
  };
}

function extractSafeAttributes(payload) {
  if (!payload || typeof payload !== "object") return {};
  const services = [];
  for (const key of ["resourceSpans", "resourceMetrics", "resourceLogs"]) {
    for (const resource of payload[key] || []) {
      for (const attribute of resource.resource?.attributes || []) {
        if (attribute.key === "service.name" && attribute.value?.stringValue && !services.includes(attribute.value.stringValue)) services.push(attribute.value.stringValue);
      }
    }
  }
  return { service_names: services.slice(0, 12).map((service) => sanitizeTelemetryText(service, { limit: 120 })) };
}

function compareEvidence(a, b) {
  return String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id);
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

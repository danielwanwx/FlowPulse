import { createHash } from "node:crypto";

export const EVIDENCE_ENVELOPE_SCHEMA_VERSION = "flowpulse.evidence-envelope.v1";
export const CONNECTOR_PROJECTION_SCHEMA_VERSION = "flowpulse.connector-projection.v1";
export const EVIDENCE_ENVELOPE_LIMITS = Object.freeze({
  max_bytes: 48 * 1024,
  max_entities: 64,
  max_relations: 128,
  max_evidence: 64,
  max_string_bytes: 512,
  max_summary_bytes: 1024,
  max_json_depth: 16
});

export const SOURCE_KINDS = Object.freeze(["workflow_lineage", "stream_warehouse"]);
export const SOURCE_HEALTHS = Object.freeze(["live", "stale", "disconnected", "unavailable"]);
export const CAPTURE_MODES = Object.freeze(["captured_fixture", "frozen_real_snapshot"]);
export const ENTITY_KINDS = Object.freeze(["service", "deployment", "dag", "job", "task", "topic", "dataset", "table", "query", "incident"]);
export const RELATION_TYPES = Object.freeze(["calls", "publishes_to", "consumes_from", "produces", "reads", "writes", "scheduled_by", "deployed_by", "affects"]);
export const EVIDENCE_TYPES = Object.freeze(["failure", "lag", "lineage", "run", "metric", "quality"]);
export const FAULT_LOCALITIES = Object.freeze(["origin", "propagation", "symptom", "impact"]);

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DISPLAY_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .,:;_/@#-]*$/;
const CAPTURE_REFERENCE = /^capture:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}(?:#[A-Za-z0-9][A-Za-z0-9._:-]{0,159})?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /(?:\b(?:api[_ -]?key|access[_ -]?token|token|secret|password|passwd|pwd|authorization|bearer|private[ -]?key|client[ -]?secret|prompt|context|instruction|session(?:[_ -]?id)?|cookie|localstorage|raw[ -]?(?:log|payload|query|error)|stack|trace|payload|query|error)\b|\b(?:select|insert|update|delete|merge|drop|create|alter|show|describe|explain|with|grant|revoke|truncate|call|execute|use|set)\b|(?:[a-z][a-z0-9+.-]*):\/\/|<\/?(?:script|html|svg|img|iframe)\b|javascript:|file:\/\/|localhost|\/users\/|%[0-9a-f]{2}|&#(?:x?[0-9a-f]+|[a-z]+);|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/i;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class EvidenceEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = "EvidenceEnvelopeError";
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!plain(value)) return "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function evidenceEnvelopeContent(value) {
  if (!plain(value) || !plain(value.provenance)) return null;
  const { content_sha256: _contentSha256, ...provenance } = value.provenance;
  return { ...value, provenance };
}

export function evidenceEnvelopeContentSha256(value) {
  const content = evidenceEnvelopeContent(value);
  return content ? canonicalSha256(content) : null;
}

export function parseDuplicateFreeJson(raw, maximumBytes = EVIDENCE_ENVELOPE_LIMITS.max_bytes) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maximumBytes) fail("evidence_envelope_json_limit_exceeded");
  const parser = new DuplicateFreeJsonParser(raw, EVIDENCE_ENVELOPE_LIMITS.max_json_depth);
  return deepFreeze(parser.parse());
}

// Object input is intentionally structural-only. Browser/runtime-ready callers must
// prove duplicate-free raw parsing through connector-manifest's ingestion boundary.
export function normalizeEvidenceEnvelopeStructural(value) {
  if (!plain(value) || bytes(value) > EVIDENCE_ENVELOPE_LIMITS.max_bytes) fail("evidence_envelope_limit_exceeded");
  const required = ["schema_version", "envelope_id", "event_id", "source_id", "incident_id", "run_id", "correlation_id", "observed_at", "received_at", "frozen_at", "source_kind", "capture_mode", "source_health", "provenance", "entities", "relations", "evidence"];
  if (!exactKeys(value, required)) fail("evidence_envelope_fields_invalid");
  if (value.schema_version !== EVIDENCE_ENVELOPE_SCHEMA_VERSION || !ids(value, ["envelope_id", "event_id", "source_id", "incident_id", "run_id", "correlation_id"]) || !timestamp(value.observed_at) || !timestamp(value.received_at) || !timestamp(value.frozen_at) || time(value.observed_at) > time(value.received_at) || time(value.received_at) > time(value.frozen_at)) fail("evidence_envelope_scope_invalid");
  if (!SOURCE_KINDS.includes(value.source_kind) || !CAPTURE_MODES.includes(value.capture_mode) || !SOURCE_HEALTHS.includes(value.source_health)) fail("evidence_envelope_source_invalid");
  validateProvenance(value.provenance);
  if (value.provenance.content_sha256 !== evidenceEnvelopeContentSha256(value)) fail("evidence_envelope_hash_invalid");
  if (!Array.isArray(value.entities) || !Array.isArray(value.relations) || !Array.isArray(value.evidence) || value.entities.length > EVIDENCE_ENVELOPE_LIMITS.max_entities || value.relations.length > EVIDENCE_ENVELOPE_LIMITS.max_relations || value.evidence.length > EVIDENCE_ENVELOPE_LIMITS.max_evidence) fail("evidence_envelope_collection_limit");

  const entities = value.entities.map(normalizeEntity).sort(byId);
  const entityIds = new Set(entities.map((item) => item.id));
  if (entityIds.size !== entities.length) fail("evidence_envelope_entity_invalid");
  const evidence = value.evidence.map((item) => normalizeEvidence(item, entityIds, value)).sort(byId);
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) fail("evidence_envelope_evidence_invalid");
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const relations = value.relations.map((item) => normalizeRelation(item, entityIds, evidenceIds)).sort(byId);
  const relationKeys = new Set(relations.map((item) => canonicalJson([item.from, item.to, item.type, item.evidence_ids])));
  if (new Set(relations.map((item) => item.id)).size !== relations.length || relationKeys.size !== relations.length) fail("evidence_envelope_relation_invalid");

  return deepFreeze({
    schema_version: CONNECTOR_PROJECTION_SCHEMA_VERSION,
    envelope_id: value.envelope_id,
    event_id: value.event_id,
    source_id: value.source_id,
    incident_id: value.incident_id,
    run_id: value.run_id,
    correlation_id: value.correlation_id,
    observed_at: value.observed_at,
    received_at: value.received_at,
    frozen_at: value.frozen_at,
    source: { source_kind: value.source_kind, capture_mode: value.capture_mode, source_health: value.source_health },
    provenance: {
      connector_id: value.provenance.connector_id,
      connector_version: value.provenance.connector_version,
      source_reference: value.provenance.source_reference,
      content_type: value.provenance.content_type,
      encoding: value.provenance.encoding,
      redaction_state: value.provenance.redaction_state,
      content_sha256: value.provenance.content_sha256
    },
    graph: { entities, relations },
    evidence
  });
}

function validateProvenance(value) {
  const required = ["connector_id", "connector_version", "source_reference", "content_type", "encoding", "redaction_state", "content_sha256"];
  if (!plain(value) || !exactKeys(value, required) || !id(value.connector_id) || !version(value.connector_version) || !captureReference(value.source_reference, false) || value.content_type !== "application/json" || value.encoding !== "utf-8" || !["redacted", "synthetic"].includes(value.redaction_state) || !HASH.test(value.content_sha256)) fail("evidence_envelope_provenance_invalid");
}

function normalizeEntity(value) {
  const required = ["id", "kind", "label", "namespace", "provider_label", "provenance_ref", "sha256"];
  if (!plain(value) || !exactKeys(value, required) || !id(value.id) || !ENTITY_KINDS.includes(value.kind) || !isSafeDisplayText(value.label, EVIDENCE_ENVELOPE_LIMITS.max_string_bytes) || !isSafeDisplayText(value.namespace, 160) || !isSafeDisplayText(value.provider_label, 160) || !captureReference(value.provenance_ref, true) || !HASH.test(value.sha256)) fail("evidence_envelope_entity_invalid");
  return { id: value.id, kind: value.kind, label: value.label, namespace: value.namespace, provider_label: value.provider_label, provenance_ref: value.provenance_ref, sha256: value.sha256 };
}

function normalizeRelation(value, entityIds, evidenceIds) {
  if (!plain(value) || !exactKeys(value, ["id", "from", "to", "type", "evidence_ids"]) || !id(value.id) || !entityIds.has(value.from) || !entityIds.has(value.to) || value.from === value.to || !RELATION_TYPES.includes(value.type) || !Array.isArray(value.evidence_ids) || !value.evidence_ids.length || value.evidence_ids.length > 32 || new Set(value.evidence_ids).size !== value.evidence_ids.length || !value.evidence_ids.every((item) => id(item) && evidenceIds.has(item))) fail("evidence_envelope_relation_invalid");
  return { id: value.id, from: value.from, to: value.to, type: value.type, evidence_ids: [...value.evidence_ids].sort(byText) };
}

function normalizeEvidence(value, entityIds, envelope) {
  const required = ["id", "type", "entity_id", "summary", "fault_locality", "observed_at", "provenance"];
  if (!plain(value) || !exactKeys(value, required) || !id(value.id) || !EVIDENCE_TYPES.includes(value.type) || !entityIds.has(value.entity_id) || !isSafeDisplayText(value.summary, EVIDENCE_ENVELOPE_LIMITS.max_summary_bytes) || !FAULT_LOCALITIES.includes(value.fault_locality) || !timestamp(value.observed_at) || time(value.observed_at) < time(envelope.observed_at) || time(value.observed_at) > time(envelope.received_at)) fail("evidence_envelope_unsafe_content");
  if (!plain(value.provenance) || !exactKeys(value.provenance, ["source_reference", "redaction_state"]) || !captureReference(value.provenance.source_reference, true) || !value.provenance.source_reference.startsWith(`${envelope.provenance.source_reference}#`) || value.provenance.redaction_state !== envelope.provenance.redaction_state) fail("evidence_envelope_evidence_provenance_invalid");
  return { id: value.id, type: value.type, entity_id: value.entity_id, summary: value.summary, fault_locality: value.fault_locality, observed_at: value.observed_at, provenance: { source_reference: value.provenance.source_reference, redaction_state: value.provenance.redaction_state } };
}

export function isSafeDisplayText(value, limit) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit && DISPLAY_TEXT.test(value) && !unsafeText(value);
}

function unsafeText(value) {
  if (UNSAFE_TEXT.test(value)) return true;
  const tokens = value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? [];
  return tokens.some((token) => unsafeEncodedToken(token));
}

function unsafeEncodedToken(token) {
  if (/^[a-f0-9]{32,}$/i.test(token)) return true;
  if (token.length >= 24 && /^[A-Za-z0-9_-]+$/.test(token)) return true;
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) return false;
  try {
    const decoded = Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64").toString("utf8");
    return decoded.length > 0 && /^[\x20-\x7e]+$/.test(decoded) && UNSAFE_TEXT.test(decoded);
  } catch {
    return true;
  }
}

function captureReference(value, allowFragment) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= EVIDENCE_ENVELOPE_LIMITS.max_string_bytes && CAPTURE_REFERENCE.test(value) && (allowFragment || !value.includes("#"));
}

function ids(value, keys) { return keys.every((key) => id(value[key])); }
function id(value) { return typeof value === "string" && ID.test(value); }
function version(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value); }
function timestamp(value) { return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(time(value)) && new Date(time(value)).toISOString() === value; }
function time(value) { return Date.parse(value); }
function exactKeys(value, expected) { return plain(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function bytes(value) { try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; } }
function byId(left, right) { return byText(left.id, right.id); }
function byText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function fail(code) { throw new EvidenceEnvelopeError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

class DuplicateFreeJsonParser {
  constructor(raw, maximumDepth) {
    this.raw = raw;
    this.maximumDepth = maximumDepth;
    this.index = 0;
  }

  parse() {
    const value = this.value(0);
    this.space();
    if (this.index !== this.raw.length) fail("evidence_envelope_json_invalid");
    return value;
  }

  value(depth) {
    if (depth > this.maximumDepth) fail("evidence_envelope_json_depth_exceeded");
    this.space();
    const char = this.raw[this.index];
    if (char === "{") return this.object(depth + 1);
    if (char === "[") return this.array(depth + 1);
    if (char === '"') return this.string();
    if (char === "t" && this.literal("true")) return true;
    if (char === "f" && this.literal("false")) return false;
    if (char === "n" && this.literal("null")) return null;
    if (char === "-" || /[0-9]/.test(char ?? "")) return this.number();
    fail("evidence_envelope_json_invalid");
  }

  object(depth) {
    this.index += 1;
    const value = {};
    const keys = new Set();
    this.space();
    if (this.raw[this.index] === "}") { this.index += 1; return value; }
    while (true) {
      this.space();
      if (this.raw[this.index] !== '"') fail("evidence_envelope_json_invalid");
      const key = this.string();
      if (keys.has(key)) fail("evidence_envelope_json_duplicate_key");
      if (UNSAFE_JSON_KEYS.has(key)) fail("evidence_envelope_json_unsafe_key");
      keys.add(key);
      this.space();
      if (this.raw[this.index] !== ":") fail("evidence_envelope_json_invalid");
      this.index += 1;
      Object.defineProperty(value, key, { value: this.value(depth), enumerable: true, writable: true, configurable: true });
      this.space();
      if (this.raw[this.index] === "}") { this.index += 1; return value; }
      if (this.raw[this.index] !== ",") fail("evidence_envelope_json_invalid");
      this.index += 1;
    }
  }

  array(depth) {
    this.index += 1;
    const value = [];
    this.space();
    if (this.raw[this.index] === "]") { this.index += 1; return value; }
    while (true) {
      value.push(this.value(depth));
      this.space();
      if (this.raw[this.index] === "]") { this.index += 1; return value; }
      if (this.raw[this.index] !== ",") fail("evidence_envelope_json_invalid");
      this.index += 1;
    }
  }

  string() {
    this.index += 1;
    let value = "";
    while (this.index < this.raw.length) {
      const char = this.raw[this.index++];
      if (char === '"') return value;
      if (char === "\\") {
        const escape = this.raw[this.index++];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
        if (escape === "u") {
          const hex = this.raw.slice(this.index, this.index + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) fail("evidence_envelope_json_invalid");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          continue;
        }
        fail("evidence_envelope_json_invalid");
      }
      if (char < " ") fail("evidence_envelope_json_invalid");
      value += char;
    }
    fail("evidence_envelope_json_invalid");
  }

  number() {
    const match = this.raw.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail("evidence_envelope_json_invalid");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("evidence_envelope_json_invalid");
    return value;
  }

  literal(value) {
    if (!this.raw.startsWith(value, this.index)) return false;
    this.index += value.length;
    return true;
  }

  space() {
    while (/[\t\n\r ]/.test(this.raw[this.index] ?? "")) this.index += 1;
  }
}

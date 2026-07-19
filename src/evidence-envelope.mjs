import { createHash } from "node:crypto";

export const EVIDENCE_ENVELOPE_SCHEMA_VERSION = "flowpulse.evidence-envelope.v1";
export const CONNECTOR_PROJECTION_SCHEMA_VERSION = "flowpulse.connector-projection.v1";
export const EVIDENCE_ENVELOPE_LIMITS = Object.freeze({
  max_bytes: 48 * 1024,
  max_entities: 64,
  max_relations: 128,
  max_evidence: 64,
  max_string_bytes: 512,
  max_summary_bytes: 1024
});

export const SOURCE_KINDS = Object.freeze(["workflow_lineage", "stream_warehouse"]);
export const CAPTURE_MODES = Object.freeze(["captured_fixture", "frozen_real_snapshot"]);
export const ENTITY_KINDS = Object.freeze(["service", "deployment", "dag", "job", "task", "topic", "dataset", "table", "query", "incident"]);
export const RELATION_TYPES = Object.freeze(["calls", "publishes_to", "consumes_from", "produces", "reads", "writes", "scheduled_by", "deployed_by", "affects"]);
export const EVIDENCE_TYPES = Object.freeze(["failure", "lag", "lineage", "run", "metric", "quality"]);
export const FAULT_LOCALITIES = Object.freeze(["origin", "propagation", "symptom", "impact"]);

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .,:;_/@#-]*$/;
const FORBIDDEN_TEXT = /(?:\b(?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization|bearer|prompt|context|instruction|session(?:[_ -]?id)?|cookie|localstorage)\b|\b(?:select|insert|update|delete|merge|drop|create|alter)\b|<\/?(?:script|html|svg|img|iframe)\b|file:\/\/|localhost|\/users\/)/i;

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

export function normalizeEvidenceEnvelope(value) {
  if (!plain(value) || bytes(value) > EVIDENCE_ENVELOPE_LIMITS.max_bytes) fail("evidence_envelope_limit_exceeded");
  const required = ["schema_version", "envelope_id", "event_id", "source_id", "incident_id", "run_id", "correlation_id", "observed_at", "received_at", "frozen_at", "source_kind", "capture_mode", "source_health", "provenance", "entities", "relations", "evidence"];
  if (!exactKeys(value, required)) fail("evidence_envelope_fields_invalid");
  if (value.schema_version !== EVIDENCE_ENVELOPE_SCHEMA_VERSION || !ids(value, ["envelope_id", "event_id", "source_id", "incident_id", "run_id", "correlation_id"]) || !timestamp(value.observed_at) || !timestamp(value.received_at) || !timestamp(value.frozen_at) || Date.parse(value.observed_at) > Date.parse(value.received_at) || Date.parse(value.received_at) > Date.parse(value.frozen_at)) fail("evidence_envelope_scope_invalid");
  if (!SOURCE_KINDS.includes(value.source_kind) || !CAPTURE_MODES.includes(value.capture_mode) || value.source_health !== "live") fail("evidence_envelope_source_invalid");
  validateProvenance(value.provenance);
  if (value.provenance.content_sha256 !== evidenceEnvelopeContentSha256(value)) fail("evidence_envelope_hash_invalid");
  if (!Array.isArray(value.entities) || !Array.isArray(value.relations) || !Array.isArray(value.evidence)
    || value.entities.length > EVIDENCE_ENVELOPE_LIMITS.max_entities || value.relations.length > EVIDENCE_ENVELOPE_LIMITS.max_relations || value.evidence.length > EVIDENCE_ENVELOPE_LIMITS.max_evidence) fail("evidence_envelope_collection_limit");

  const entities = value.entities.map(normalizeEntity).sort(byId);
  const entityIds = new Set(entities.map((item) => item.id));
  if (entityIds.size !== entities.length) fail("evidence_envelope_entity_invalid");
  const evidence = value.evidence.map((item) => normalizeEvidence(item, entityIds, value)).sort(byId);
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) fail("evidence_envelope_evidence_invalid");
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const relations = value.relations.map((item) => normalizeRelation(item, entityIds, evidenceIds)).sort(byId);
  if (new Set(relations.map((item) => item.id)).size !== relations.length) fail("evidence_envelope_relation_invalid");

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
    source: {
      source_kind: value.source_kind,
      capture_mode: value.capture_mode,
      source_health: value.source_health
    },
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
  if (!plain(value) || !exactKeys(value, required) || !id(value.connector_id) || !version(value.connector_version) || !safeText(value.source_reference, EVIDENCE_ENVELOPE_LIMITS.max_string_bytes) || !["application/json"].includes(value.content_type) || value.encoding !== "utf-8" || !["redacted", "synthetic"].includes(value.redaction_state) || !HASH.test(value.content_sha256)) fail("evidence_envelope_provenance_invalid");
}

function normalizeEntity(value) {
  const required = ["id", "kind", "label", "namespace", "provider_label", "provenance_ref", "sha256"];
  if (!plain(value) || !exactKeys(value, required) || !id(value.id) || !ENTITY_KINDS.includes(value.kind) || !safeText(value.label, EVIDENCE_ENVELOPE_LIMITS.max_string_bytes) || !safeText(value.namespace, 160) || !safeText(value.provider_label, 160) || !safeText(value.provenance_ref, EVIDENCE_ENVELOPE_LIMITS.max_string_bytes) || !HASH.test(value.sha256)) fail("evidence_envelope_entity_invalid");
  return { id: value.id, kind: value.kind, label: value.label, namespace: value.namespace, provider_label: value.provider_label, provenance_ref: value.provenance_ref, sha256: value.sha256 };
}

function normalizeRelation(value, entityIds, evidenceIds) {
  if (!plain(value) || !exactKeys(value, ["id", "from", "to", "type", "evidence_ids"]) || !id(value.id) || !entityIds.has(value.from) || !entityIds.has(value.to) || value.from === value.to || !RELATION_TYPES.includes(value.type) || !Array.isArray(value.evidence_ids) || !value.evidence_ids.length || value.evidence_ids.length > 32 || new Set(value.evidence_ids).size !== value.evidence_ids.length || !value.evidence_ids.every((item) => evidenceIds.has(item))) fail("evidence_envelope_relation_invalid");
  return { id: value.id, from: value.from, to: value.to, type: value.type, evidence_ids: [...value.evidence_ids] };
}

function normalizeEvidence(value, entityIds, envelope) {
  const required = ["id", "type", "entity_id", "summary", "fault_locality", "observed_at", "provenance"];
  if (!plain(value) || !exactKeys(value, required) || !id(value.id) || !EVIDENCE_TYPES.includes(value.type) || !entityIds.has(value.entity_id) || !safeText(value.summary, EVIDENCE_ENVELOPE_LIMITS.max_summary_bytes) || !FAULT_LOCALITIES.includes(value.fault_locality) || !timestamp(value.observed_at) || Date.parse(value.observed_at) < Date.parse(envelope.observed_at) || Date.parse(value.observed_at) > Date.parse(envelope.received_at)) fail("evidence_envelope_evidence_invalid");
  if (!plain(value.provenance) || !exactKeys(value.provenance, ["source_reference", "redaction_state"]) || !safeText(value.provenance.source_reference, EVIDENCE_ENVELOPE_LIMITS.max_string_bytes) || !value.provenance.source_reference.startsWith(`${envelope.provenance.source_reference}#`) || value.provenance.redaction_state !== envelope.provenance.redaction_state) fail("evidence_envelope_evidence_provenance_invalid");
  return {
    id: value.id,
    type: value.type,
    entity_id: value.entity_id,
    summary: value.summary,
    fault_locality: value.fault_locality,
    observed_at: value.observed_at,
    provenance: { source_reference: value.provenance.source_reference, redaction_state: value.provenance.redaction_state }
  };
}

function ids(value, keys) { return keys.every((key) => id(value[key])); }
function id(value) { return typeof value === "string" && ID.test(value); }
function version(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value); }
function timestamp(value) { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function safeText(value, limit) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit && SAFE_TEXT.test(value) && !FORBIDDEN_TEXT.test(value); }
function exactKeys(value, expected) { return plain(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function bytes(value) { try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; } }
function byId(left, right) { return left.id.localeCompare(right.id); }
function fail(code) { throw new EvidenceEnvelopeError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

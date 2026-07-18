import { createHash } from "node:crypto";
import { evidenceById, queryEvidence } from "./bundle.mjs";

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
  }

  metadata() {
    return { mode: this.mode, label: "deterministic replay", status: "captured", authoritative: true, evidence_count: this.records.length };
  }

  list(options = {}) { return page(this.records, options); }
  detail(id) { return detailFor(this.records, id); }
  summariesById(ids) { return evidenceById(this.bundle, ids).map(summarizeEvidence); }
  query({ kind, entity } = {}) { return queryEvidence(this.bundle, { kind, entity }).map(summarizeEvidence); }
  entities() { return this.bundle.topology.services.map((service) => service.id); }
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
  has(id) { return this.records.some((record) => record.id === id); }

  freeze({ incidentId, runId, after, entities = INCIDENT_ENTITIES, maxRecords = SNAPSHOT_MAX_RECORDS, maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
    if (this.project.status !== "live") throw new InsufficientEvidenceError(`OTLP source is ${this.project.status}; a live frozen snapshot cannot be created`);
    const afterMs = after ? Date.parse(after) : Number.NEGATIVE_INFINITY;
    const allowedEntities = new Set(entities);
    const relevant = this.records.filter((record) => allowedEntities.has(record.entity) && Date.parse(record.at) >= afterMs);
    const included = [];
    let bytes = 0;
    for (const record of relevant) {
      const size = Buffer.byteLength(JSON.stringify(summarizeEvidence(record)));
      if (included.length >= maxRecords || bytes + size > maxBytes) break;
      included.push(record);
      bytes += size;
    }
    if (!included.length) throw new InsufficientEvidenceError("Fresh OTLP has no relevant bounded evidence for the checkout incident");
    const sourceHash = hash(this.records.map((record) => `${record.id}:${record.provenance?.sha256 || ""}`).join("\n"));
    const contentHash = hash(included.map((record) => `${record.id}:${record.provenance?.sha256 || ""}`).join("\n"));
    return new FrozenEvidenceSnapshot({
      id: `snapshot-${contentHash.slice(0, 16)}`,
      records: included,
      metadata: {
        mode: "live_gpt_5_6_frozen_otlp_snapshot",
        label: "live GPT-5.6 over frozen OTLP snapshot",
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
        evidence_ids: included.map((record) => record.id)
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

  metadata() { return { ...this.snapshot, evidence_ids: undefined }; }
  list(options = {}) { return page(this.records, options); }
  detail(id) { return detailFor(this.records, id); }
  summariesById(ids) { return selected(this.records, ids).map(summarizeEvidence); }
  query({ kind, entity } = {}) { return this.records.filter(matches({ kind, entity })).map(summarizeEvidence); }
  entities() { return [...new Set(this.records.map((record) => record.entity))].sort(); }
  has(id) { return this.records.some((record) => record.id === id); }
}

export class InsufficientEvidenceError extends Error {
  constructor(message) { super(message); this.name = "InsufficientEvidenceError"; }
}

export function summarizeEvidence(record) {
  return {
    id: record.id,
    kind: record.kind,
    signal: record.signal,
    title: record.title,
    fact: record.fact,
    entity: record.entity,
    source: record.source,
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
  return { services: Array.isArray(value.services) ? value.services.slice(0, 12) : [], raw_sha256: value.raw_sha256 || null };
}

function safeProvenance(provenance = {}) {
  return {
    file: provenance.file || null,
    line: provenance.line ?? null,
    byte_start: provenance.byte_start ?? null,
    byte_end: provenance.byte_end ?? null,
    sha256: provenance.sha256 || null,
    immutable_capture: Boolean(provenance.immutable_capture)
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
  return { service_names: services.slice(0, 12) };
}

function compareEvidence(a, b) {
  return String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id);
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalSha256, evidenceEnvelopeContentSha256 } from "../src/evidence-envelope.mjs";
import {
  connectorManifestContractSha256,
  connectorManifestTrustKey,
  connectorPolicyStructural,
  parseConnectorBundleJson,
  validateConnectorBundleStructural,
  validateParsedConnectorBundleForIngestion
} from "../src/connector-manifest.mjs";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "integration");
const fixtureNames = ["lineage-v1.json", "stream-warehouse-v1.json"];
const trustedNow = "2026-07-18T10:02:00.000Z";

function fixtureText(name) {
  return readFileSync(join(fixtureDirectory, name), "utf8");
}

function fixtureObject(name) {
  return JSON.parse(fixtureText(name));
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function context(overrides = {}) {
  return {
    trusted_now: trustedNow,
    consumed_receipt_ids: new Set(),
    consumed_receipt_fingerprints: new Set(),
    accepted_connector_contracts: new Set(fixtureNames.map((name) => connectorManifestTrustKey(fixtureObject(name).manifest))),
    ...overrides
  };
}

function resign(value) {
  value.envelope.provenance.content_sha256 = evidenceEnvelopeContentSha256(value.envelope);
  value.manifest.contract_sha256 = connectorManifestContractSha256(value.manifest);
  value.receipt.manifest_contract_sha256 = value.manifest.contract_sha256;
  value.receipt.content_sha256 = value.envelope.provenance.content_sha256;
  value.receipt.redaction_state = value.envelope.provenance.redaction_state;
  value.receipt.observed_at = value.envelope.observed_at;
  value.receipt.received_at = value.envelope.received_at;
  value.receipt.frozen_at = value.envelope.frozen_at;
}

function parsed(value) {
  return parseConnectorBundleJson(JSON.stringify(value));
}

function ingest(value, options = context()) {
  return validateParsedConnectorBundleForIngestion(parsed(value), options);
}

function rejects(name, mutate, code, options = context()) {
  const value = clone(fixtureObject("lineage-v1.json"));
  mutate(value);
  resign(value);
  assert.throws(() => ingest(value, options), (error) => error?.code === code, name);
}

test("fixtures parse duplicate-free and normalize deterministically through the ingestion-ready path", () => {
  for (const name of fixtureNames) {
    const first = validateParsedConnectorBundleForIngestion(parseConnectorBundleJson(fixtureText(name)), context());
    const second = validateParsedConnectorBundleForIngestion(parseConnectorBundleJson(fixtureText(name)), context());
    assert.deepEqual(first, second);
    assert.equal(canonicalSha256(first), canonicalSha256(second));
    assert.equal(first.schema_version, "flowpulse.connector-projection.v1");
    assert.equal(first.validation_mode, "ingestion_ready");
    assert.equal(first.readiness, "non_actionable");
    assert.equal(first.capabilities.can_mutate, false);
    assert.equal(first.capabilities.can_authorize, false);
    assert.equal(first.capabilities.can_execute, false);
    assert.equal(first.graph.entities.length > 1, true);
    assert.equal(first.graph.relations.length > 0, true);
    assert.equal(first.evidence.length > 0, true);
    assert.equal(Object.isFrozen(first), true);
  }

  const lineage = ingest(fixtureObject("lineage-v1.json"));
  assert.equal(lineage.source.source_kind, "workflow_lineage");
  assert.equal(lineage.source.capture_mode, "captured_fixture");
  assert.equal(lineage.source.source_health, "unavailable");
  assert.equal(lineage.graph.entities.some((item) => item.id === "dag-payments"), true);
  assert.equal(lineage.graph.relations.some((item) => item.type === "produces"), true);
  assert.equal(lineage.evidence.some((item) => item.type === "failure" && item.fault_locality === "origin"), true);

  const stream = ingest(fixtureObject("stream-warehouse-v1.json"));
  assert.equal(stream.source.source_kind, "stream_warehouse");
  assert.equal(stream.graph.entities.some((item) => item.id === "topic-payment-events"), true);
  assert.equal(stream.graph.relations.some((item) => item.type === "consumes_from"), true);
  assert.equal(stream.evidence.some((item) => item.type === "lag" && item.fault_locality === "propagation"), true);
});

test("structural validation is explicitly non-actionable and cannot become ingestion-ready without parser proof and trusted context", () => {
  const raw = fixtureObject("lineage-v1.json");
  const structural = validateConnectorBundleStructural(raw);
  assert.equal(structural.validation_mode, "structural_only");
  assert.equal(structural.readiness, "non_actionable");
  assert.throws(() => validateParsedConnectorBundleForIngestion(raw, context()), (error) => error?.code === "connector_bundle_parse_proof_required");
  assert.throws(() => validateParsedConnectorBundleForIngestion(parseConnectorBundleJson(fixtureText("lineage-v1.json"))), (error) => error?.code === "connector_ingestion_context_invalid");
});

test("unsafe text, raw telemetry-shaped content, and authority-shaped fields fail closed after all non-target bindings are recomputed", () => {
  const attacks = [
    ["postgres credentials", (value) => { value.envelope.evidence[0].summary = "postgresql://admin:hunter2@db.example/payments"; }, "evidence_envelope_unsafe_content"],
    ["uri userinfo", (value) => { value.envelope.provenance.source_reference = "capture://admin:secret@db.example"; }, "evidence_envelope_provenance_invalid"],
    ["aws key", (value) => { value.envelope.evidence[0].summary = "Credential AKIAIOSFODNN7EXAMPLE"; }, "evidence_envelope_unsafe_content"],
    ["temporary aws key", (value) => { value.envelope.evidence[0].summary = "ASIAIOSFODNN7EXAMPLE"; }, "evidence_envelope_unsafe_content"],
    ["aws secret access key", (value) => { value.envelope.evidence[0].summary = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; }, "evidence_envelope_unsafe_content"],
    ["userinfo without a scheme", (value) => { value.envelope.evidence[0].summary = "admin:hunter2@db.example"; }, "evidence_envelope_unsafe_content"],
    ["jwt", (value) => { value.envelope.evidence[0].summary = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature"; }, "evidence_envelope_unsafe_content"],
    ["private key", (value) => { value.envelope.evidence[0].summary = "-----BEGIN PRIVATE KEY-----"; }, "evidence_envelope_unsafe_content"],
    ["encoded secret", (value) => { value.envelope.evidence[0].summary = "c2VjcmV0"; }, "evidence_envelope_unsafe_content"],
    ["long base64url token", (value) => { value.envelope.evidence[0].summary = "QWxhZGRpbjpvcGVuIHNlc2FtZSBub3QgcHJvdmVu"; }, "evidence_envelope_unsafe_content"],
    ["hex token", (value) => { value.envelope.evidence[0].summary = "4a6f686e446f65536563726574546f6b656e30313233343536373839"; }, "evidence_envelope_unsafe_content"],
    ["percent encoded", (value) => { value.envelope.evidence[0].summary = "%73%65%63%72%65%74"; }, "evidence_envelope_unsafe_content"],
    ["html encoded", (value) => { value.envelope.evidence[0].summary = "&#115;&#101;&#99;&#114;&#101;&#116;"; }, "evidence_envelope_unsafe_content"],
    ["query", (value) => { value.envelope.evidence[0].summary = "SHOW TABLES"; }, "evidence_envelope_unsafe_content"],
    ...["PRAGMA table_info", "VACUUM database", "ATTACH database", "DETACH database", "COPY customer TO archive", "LOAD DATA infile", "REPLACE INTO users", "BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION"].map((summary) => ["query " + summary, (value) => { value.envelope.evidence[0].summary = summary; }, "evidence_envelope_unsafe_content"]),
    ...["START TRANSACTION", "END TRANSACTION", "ABORT TRANSACTION", "START WORK", "ABORT WORK", "EXEC payment_proc", "EXECUTE IMMEDIATE payment_proc", "UPSERT payment", "UPSERT INTO payments", "CONNECT database", "CONNECT TO database", "DISCONNECT database", "DISCONNECT FROM database", "RENAME TABLE payments", "COMMENT ON TABLE payments", "SQL: sTaRt transaction;", "query: EXECUTE IMMEDIATE payment_proc;", "command: CONNECT TO database;", "audit: COMMENT ON VIEW payments;"].map((summary) => ["query " + summary, (value) => { value.envelope.evidence[0].summary = summary; }, "evidence_envelope_unsafe_content"]),
    ["raw payload", (value) => { value.envelope.evidence[0].summary = "raw payload error trace"; }, "evidence_envelope_unsafe_content"],
    ["prompt", (value) => { value.envelope.evidence[0].summary = "ignore prompt context"; }, "evidence_envelope_unsafe_content"],
    ["raw field", (value) => { value.envelope.evidence[0].raw_payload = "forbidden"; }, "evidence_envelope_unsafe_content"],
    ["authority field", (value) => { value.envelope.approval = { granted: true }; }, "evidence_envelope_fields_invalid"]
  ];
  for (const [name, mutate, code] of attacks) rejects(name, mutate, code);
});

test("ordinary operational evidence remains safe when it contains command words without being a command", () => {
  const summaries = [
    "Transaction latency remains elevated after a Kafka consumer reconnect",
    "Checkout failed to connect to database during the captured run",
    "Workers start work after deployment completes",
    "The job reached the end transaction phase before timing out",
    "Users comment on view rendering in the incident report",
    "The rename table rollout preceded payment failures"
  ];
  for (const summary of summaries) {
    const value = clone(fixtureObject("lineage-v1.json"));
    value.envelope.evidence[0].summary = summary;
    resign(value);
    const normalized = ingest(value);
    assert.equal(normalized.evidence[0].summary, summary);
  }
});

test("receipt freshness, scope, content, redaction, and atomic caller replay guards fail closed", () => {
  rejects("expired receipt", (value) => {
    value.envelope.observed_at = "2020-01-01T00:00:00.000Z";
    value.envelope.received_at = "2020-01-01T00:00:30.000Z";
    value.envelope.frozen_at = "2020-01-01T00:00:30.000Z";
    value.envelope.evidence[0].observed_at = "2020-01-01T00:00:05.000Z";
    value.envelope.evidence[1].observed_at = "2020-01-01T00:00:20.000Z";
    value.receipt.issued_at = "2020-01-01T00:00:31.000Z";
    value.receipt.expires_at = "2020-01-01T00:05:00.000Z";
  }, "connector_receipt_freshness_invalid");
  rejects("new receipt cannot refresh an old frozen snapshot", (value) => {
    value.envelope.observed_at = "2020-01-01T00:00:00.000Z";
    value.envelope.received_at = "2020-01-01T00:00:30.000Z";
    value.envelope.frozen_at = "2020-01-01T00:00:30.000Z";
    value.envelope.evidence[0].observed_at = "2020-01-01T00:00:05.000Z";
    value.envelope.evidence[1].observed_at = "2020-01-01T00:00:20.000Z";
    value.receipt.issued_at = "2026-07-18T10:00:31.000Z";
    value.receipt.expires_at = "2026-07-18T10:05:00.000Z";
  }, "connector_receipt_freshness_invalid");
  rejects("receipt issuance cannot lag frozen capture beyond the declared age", (value) => {
    value.receipt.issued_at = "2026-07-18T10:05:31.000Z";
    value.receipt.expires_at = "2026-07-18T10:06:00.000Z";
  }, "connector_receipt_freshness_invalid", context({ trusted_now: "2026-07-18T10:05:32.000Z" }));
  rejects("trusted validation time cannot outlive the frozen snapshot age", (value) => {
    value.receipt.expires_at = "2026-07-18T10:05:31.000Z";
  }, "connector_receipt_freshness_invalid", context({ trusted_now: "2026-07-18T10:05:31.000Z" }));
  const historicalReplay = ingest(fixtureObject("lineage-v1.json"), context({ trusted_now: "2026-07-18T10:02:00.000Z" }));
  assert.equal(historicalReplay.source.capture_mode, "captured_fixture");
  assert.equal(historicalReplay.source.source_health, "unavailable");
  rejects("scope mismatch", (value) => { value.receipt.incident_id = "other-incident"; }, "connector_receipt_binding_invalid");
  const contentHashMismatch = clone(fixtureObject("lineage-v1.json"));
  resign(contentHashMismatch);
  contentHashMismatch.receipt.content_sha256 = "0".repeat(64);
  assert.throws(() => ingest(contentHashMismatch), (error) => error?.code === "connector_receipt_binding_invalid");
  const redactionMismatch = clone(fixtureObject("lineage-v1.json"));
  resign(redactionMismatch);
  redactionMismatch.receipt.redaction_state = "redacted";
  assert.throws(() => ingest(redactionMismatch), (error) => error?.code === "connector_receipt_binding_invalid");
  const unknownConnector = clone(fixtureObject("lineage-v1.json"));
  unknownConnector.manifest.connector_id = "unknown-connector";
  unknownConnector.envelope.provenance.connector_id = "unknown-connector";
  unknownConnector.receipt.connector_id = "unknown-connector";
  resign(unknownConnector);
  assert.throws(() => ingest(unknownConnector), (error) => error?.code === "connector_untrusted_manifest");

  const guard = context();
  const first = ingest(fixtureObject("lineage-v1.json"), guard);
  guard.consumed_receipt_ids.add(first.replay.receipt_id);
  guard.consumed_receipt_fingerprints.add(first.replay.fingerprint);
  assert.throws(() => ingest(fixtureObject("lineage-v1.json"), guard), (error) => error?.code === "connector_receipt_replayed");
});

test("duplicate-aware raw parser and structural validators reject duplicate keys, pollution, duplicate records, and semantic duplicate edges", () => {
  const source = fixtureText("lineage-v1.json");
  const duplicateRoot = source.replace('"source_health": "unavailable",', '"source_health": "stale",\n    "source_health": "unavailable",');
  assert.throws(() => parseConnectorBundleJson(duplicateRoot), (error) => error?.code === "evidence_envelope_json_duplicate_key");
  const duplicateNested = source.replace('"label": "Payments refresh",', '"label": "wrong",\n      "label": "Payments refresh",');
  assert.throws(() => parseConnectorBundleJson(duplicateNested), (error) => error?.code === "evidence_envelope_json_duplicate_key");
  const polluted = source.replace('"schema_version": "flowpulse.evidence-envelope.v1",', '"__proto__": {"polluted": true},\n    "schema_version": "flowpulse.evidence-envelope.v1",');
  assert.throws(() => parseConnectorBundleJson(polluted), (error) => error?.code === "evidence_envelope_json_unsafe_key");
  const tooDeep = `${'{"nested":'.repeat(17)}null${'}'.repeat(17)}`;
  assert.throws(() => parseConnectorBundleJson(tooDeep), (error) => error?.code === "evidence_envelope_json_depth_exceeded");

  rejects("duplicate entity", (value) => { value.envelope.entities.push(clone(value.envelope.entities[0])); }, "evidence_envelope_entity_invalid");
  rejects("duplicate evidence", (value) => { value.envelope.evidence.push(clone(value.envelope.evidence[0])); }, "evidence_envelope_evidence_invalid");
  rejects("orphan edge", (value) => { value.envelope.relations[0].to = "missing-entity"; }, "evidence_envelope_relation_invalid");
  rejects("semantic duplicate edge", (value) => {
    value.envelope.relations.push({ ...clone(value.envelope.relations[0]), id: "rel-semantic-duplicate" });
  }, "evidence_envelope_relation_invalid");
});

test("bounds, timestamps, unknown capabilities, and health semantics fail closed before safe output", () => {
  rejects("oversize string", (value) => { value.envelope.evidence[0].summary = "A".repeat(1025); }, "evidence_envelope_unsafe_content");
  rejects("unknown source", (value) => { value.envelope.source_kind = "unknown"; }, "evidence_envelope_source_invalid");
  rejects("stale source", (value) => { value.envelope.source_health = "stale"; value.receipt.source_health = "stale"; }, "connector_source_capability_invalid");
  rejects("enabled action", (value) => { value.manifest.permissions.action = true; }, "connector_manifest_permission_invalid");
  rejects("enabled verification", (value) => { value.manifest.capabilities.verification = true; }, "connector_manifest_capability_invalid");
  rejects("unknown capability", (value) => { value.manifest.capabilities.shell = true; }, "connector_manifest_capability_invalid");
  rejects("unsafe display", (value) => { value.manifest.display.name = "Bearer hidden token"; }, "connector_manifest_invalid");
  rejects("timestamp reversal", (value) => { value.envelope.received_at = "2026-07-18T09:59:00.000Z"; }, "evidence_envelope_scope_invalid");
});

test("display metadata has no policy effect and normalized output cannot carry authority or unsafe browser content", () => {
  const baseline = fixtureObject("stream-warehouse-v1.json");
  const changed = clone(baseline);
  changed.manifest.display = { name: "Different display label", glyph: "warehouse" };
  assert.deepEqual(connectorPolicyStructural(baseline.manifest), connectorPolicyStructural(changed.manifest));
  const normalized = ingest(changed);
  const serialized = JSON.stringify(normalized);
  for (const forbidden of ["approval.granted", "repair.executed", "verification.completed", "evaluation.accepted", "diagnosis.gate.passed", "topsecret", "<script", "Bearer ", "postgresql://"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

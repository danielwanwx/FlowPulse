import assert from "node:assert/strict";
import test from "node:test";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, SNAPSHOT_MAX_BYTES, versionedChangeEvidence } from "../src/evidence-source.mjs";
import { executeTool, validateDiagnosis, validateEvaluation } from "../src/openai.mjs";
import { loadBundle } from "../src/bundle.mjs";

test("freezes fresh OTLP in deterministic order under caps with immutable provenance", () => {
  const source = new LiveOtlpEvidenceSource(project("live", [
    record("b", "2026-07-18T10:00:02.000Z", "payment"),
    record("a", "2026-07-18T10:00:01.000Z", "checkout"),
    record("z", "2026-07-18T10:00:03.000Z", "unrelated")
  ]));
  const snapshot = source.freeze({ incidentId: "incident", runId: "run", maxRecords: 2, maxBytes: SNAPSHOT_MAX_BYTES });
  assert.deepEqual(snapshot.records.map((item) => item.id), ["a", "b"]);
  assert.equal(snapshot.metadata().mode, "live_gpt_5_6_frozen_otlp_snapshot");
  assert.equal(snapshot.metadata().truncated, false);
  assert.match(snapshot.detail("a").hash, /^a{64}$/);
  assert.equal(snapshot.detail("a").payload_redacted, true);
});

test("does not create a GPT snapshot from stale or irrelevant OTLP", () => {
  const stale = new LiveOtlpEvidenceSource(project("stale", [record("a", "2026-07-18T10:00:01.000Z", "checkout")]));
  assert.throws(() => stale.freeze({}), InsufficientEvidenceError);
  const unrelated = new LiveOtlpEvidenceSource(project("live", [record("z", "2026-07-18T10:00:01.000Z", "catalog")]));
  assert.throws(() => unrelated.freeze({}), /no relevant bounded evidence/);
});

test("GPT evidence tools query the selected frozen snapshot rather than the static bundle", () => {
  const snapshot = new LiveOtlpEvidenceSource(project("live", [record("live-only", "2026-07-18T10:00:01.000Z", "checkout", "trace")])).freeze({});
  const result = executeTool(snapshot, "query_traces", { entity: "checkout" });
  assert.deepEqual(result.map((item) => item.id), ["live-only"]);
  assert.equal(result.some((item) => item.id === "ev-trace-payment-refused"), false);
  assert.throws(() => validateDiagnosis({ evidence_refs: ["ev-trace-payment-refused"], proposed_repair: { action: "no_execution", target: "checkout" } }, snapshot), /missing or unknown evidence/);
  assert.equal(new CapturedBundleEvidenceSource(loadBundle()).has("ev-trace-payment-refused"), true);
});

test("frozen development snapshot includes a hashed applied change and bounded failure facts", () => {
  const change = versionedChangeEvidence({
    manifest: manifest(),
    applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" },
    ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" }
  });
  const failedTrace = record("failure", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  failedTrace.value.trace = { operation: "POST /checkout", peer_target: "payment:8080", status: "error", error: "connection refused", observed_at: failedTrace.at };
  const snapshot = new LiveOtlpEvidenceSource(project("live", [failedTrace])).freeze({ supplementalRecords: [change] });
  const trace = executeTool(snapshot, "query_traces", { entity: "checkout" })[0];
  const applied = executeTool(snapshot, "query_changes", { entity: "checkout" })[0];
  assert.deepEqual(trace.value.trace, failedTrace.value.trace);
  assert.equal(applied.value.change.applied_at, "2026-07-18T10:00:00.000Z");
  assert.equal(applied.value.change.repair_id, "repair-payment-reachable-v1");
  assert.match(applied.hash, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.metadata().evidence_ids.includes(applied.id), true);
  assert.equal(snapshot.metadata().content_hash.length, 64);
});

test("diagnosis repair must match the real development contract exactly", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const failure = record("live-only", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  failure.value.trace = paymentRefused(failure.at);
  const snapshot = new LiveOtlpEvidenceSource(project("live", [failure])).freeze({ supplementalRecords: [change] });
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  assert.doesNotThrow(() => validateDiagnosis({ evidence_refs: [change.id, "live-only"], proposed_repair: { ...contract, reason: "Failure follows the applied change." } }, snapshot, contract));
  assert.throws(() => validateDiagnosis({ evidence_refs: [change.id, "live-only"], proposed_repair: { ...contract, command_id: "other", reason: "bad" } }, snapshot, contract), /outside the approved boundary/);
});

test("sanitizes secrets and identifiers on list, detail, tool, and source-style projections", () => {
  const secret = "https://alice:password@payment.example/pay?sessionId=123456789012345678&api_key=topsecret#fragment Bearer eyJhbGciOiJIUzI1NiJ9.abc.def jane@example.com 018f63ed-9b24-7330-b0e1-82581d7d4c3a session_id=018f63ed-9b24-7330-b0e1-82581d7d4c3a user.id=alice-42 account-id:acct_123456 X-API-Key topsecret";
  const unsafe = record("unsafe", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  unsafe.fact = secret;
  unsafe.value.trace = { operation: "POST /pay", peer_target: secret, status: "error", error: secret, observed_at: unsafe.at };
  const source = new LiveOtlpEvidenceSource(project("live", [unsafe]));
  const serialized = JSON.stringify({ list: source.list(), detail: source.detail("unsafe"), tool: executeTool(source, "query_traces", { entity: "checkout" }), source: { evidence: source.list().items } });
  for (const leaked of ["alice", "password", "sessionId=123456789012345678", "topsecret", "eyJhbGciOiJIUzI1NiJ9.abc.def", "jane@example.com", "018f63ed-9b24-7330-b0e1-82581d7d4c3a", "alice-42", "acct_123456", "123456789012345678"]) assert.equal(serialized.includes(leaked), false);
  assert.match(serialized, /payment\.example\/pay/);
  assert.match(serialized, /\[REDACTED_TOKEN\]|\[REDACTED_SECRET\]|\[REDACTED_ID\]/);
});

test("executable snapshot reserves the exact change and post-change failure under cap pressure", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const lowValue = Array.from({ length: 140 }, (_, index) => record(`low-${index}`, `2026-07-18T10:00:${String(index % 59).padStart(2, "0")}.000Z`, "checkout", "trace"));
  const failure = record("post-change-error", "2026-07-18T11:00:00.000Z", "checkout", "trace");
  failure.value.trace = { operation: "POST /checkout", peer_target: "payment:8080", status: "error", error: "ECONNREFUSED", observed_at: failure.at };
  const snapshot = new LiveOtlpEvidenceSource(project("live", [...lowValue, failure])).freeze({ supplementalRecords: [change], executable: true, maxRecords: 120, maxBytes: 10_000_000 });
  assert.equal(snapshot.records.length, 120);
  assert.equal(snapshot.has(change.id), true);
  assert.equal(snapshot.has("post-change-error"), true);
  assert.deepEqual(snapshot.metadata().reserved_causal_ids.sort(), [change.id, "post-change-error"].sort());
});

test("executable snapshot rejects caps that cannot retain both causal records", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const failure = record("post-change-error", "2026-07-18T11:00:00.000Z", "checkout", "trace");
  failure.value.trace = paymentRefused(failure.at);
  const source = new LiveOtlpEvidenceSource(project("live", [failure]));
  assert.throws(() => source.freeze({ supplementalRecords: [change], executable: true, maxRecords: 2, maxBytes: 1 }), /cannot retain/);
});

test("executable diagnosis rejects irrelevant, missing, reversed, and unknown evaluator evidence", () => {
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const failure = record("failure", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  failure.value.trace = paymentRefused(failure.at);
  const databaseError = record("database-error", "2026-07-18T10:00:02.000Z", "checkout", "trace");
  databaseError.value.trace = { service: "checkout", operation: "SELECT orders", peer_target: "postgres:5432", status: "error", error: "timeout", observed_at: databaseError.at };
  const unrelated = record("unrelated", "2026-07-18T10:00:03.000Z", "payment", "trace");
  const source = new LiveOtlpEvidenceSource(project("live", [change, failure, databaseError, unrelated])).freeze({ supplementalRecords: [], executable: false });
  const diagnosis = (refs) => ({ evidence_refs: refs, proposed_repair: { ...contract, reason: "proof" } });
  assert.doesNotThrow(() => validateDiagnosis(diagnosis([change.id, failure.id]), source, contract));
  assert.throws(() => validateDiagnosis(diagnosis([unrelated.id]), source, contract), /required for executable repair/);
  assert.throws(() => validateDiagnosis(diagnosis([change.id, databaseError.id]), source, contract), /required for executable repair/);
  assert.throws(() => validateDiagnosis(diagnosis([change.id]), source, contract), /required for executable repair/);
  const reversed = record("reversed", "2026-07-18T09:59:59.000Z", "checkout", "trace");
  reversed.value.trace = paymentRefused(reversed.at);
  const reversedSource = new LiveOtlpEvidenceSource(project("live", [change, reversed])).freeze({ executable: false });
  assert.throws(() => validateDiagnosis(diagnosis([change.id, reversed.id]), reversedSource, contract), /required for executable repair/);
  assert.throws(() => validateEvaluation({ counter_evidence_refs: ["unknown"] }, source), /unknown counter-evidence/);
});

test("change evidence hashes the ledger-captured manifest instead of a later manifest variant", () => {
  const captured = manifest();
  const recordFromLedger = versionedChangeEvidence({ manifest: captured, applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const changedOnDisk = { ...captured, after: "different", repair_command_id: "different" };
  assert.equal(recordFromLedger.value.change.after, "on");
  assert.notEqual(recordFromLedger.hash, versionedChangeEvidence({ manifest: changedOnDisk, applied: { before: "off", after: "different", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } }).hash);
});

test("list and detail stay bounded and fail closed", () => {
  const source = new LiveOtlpEvidenceSource(project("live", Array.from({ length: 70 }, (_, index) => record(`id-${index}`, `2026-07-18T10:00:${String(index % 60).padStart(2, "0")}.000Z`, "checkout"))));
  const listed = source.list({ limit: 999 });
  assert.equal(listed.items.length, 50);
  assert.equal(listed.truncated, true);
  assert.equal(Object.hasOwn(listed.items[0], "payload"), false);
  assert.throws(() => source.detail("missing"), /Unknown evidence id/);
});

function project(status, evidence) {
  return { status, authoritative: status === "live", evidence, last_observed_at: "2026-07-18T10:00:04.000Z", freshness_ms: 5 };
}

function record(id, at, entity, kind = "trace") {
  return {
    id,
    kind,
    signal: kind === "trace" ? "traces" : `${kind}s`,
    title: "OTLP record",
    fact: "Observed local OTLP evidence.",
    entity,
    source: "OpenTelemetry Collector file exporter",
    at,
    captured_at: at,
    value: { services: [entity], raw_sha256: "a".repeat(64) },
    provenance: { file: "traces.jsonl", line: 1, byte_start: 0, byte_end: 10, sha256: "a".repeat(64), immutable_capture: true },
    payload: { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: entity } }] } }] }
  };
}

function manifest() {
  return {
    id: "change-payment-unreachable-v1",
    target: "checkout",
    flag: "paymentUnreachable",
    known_good: "off",
    after: "on",
    repair_id: "repair-payment-reachable-v1",
    repair_command_id: "astronomy.restore-payment-and-recreate-checkout"
  };
}

function paymentRefused(at) {
  return { service: "checkout", operation: "POST /checkout payment", peer_target: "payment:8080", status: "error", error: "ECONNREFUSED", observed_at: at };
}

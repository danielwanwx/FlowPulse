import assert from "node:assert/strict";
import test from "node:test";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, SNAPSHOT_MAX_BYTES, versionedChangeEvidence } from "../src/evidence-source.mjs";
import { executeTool, validateDiagnosis } from "../src/openai.mjs";
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
  const snapshot = new LiveOtlpEvidenceSource(project("live", [record("live-only", "2026-07-18T10:00:01.000Z", "checkout", "trace")])).freeze({});
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  assert.doesNotThrow(() => validateDiagnosis({ evidence_refs: ["live-only"], proposed_repair: { ...contract, reason: "Failure follows the applied change." } }, snapshot, contract));
  assert.throws(() => validateDiagnosis({ evidence_refs: ["live-only"], proposed_repair: { ...contract, command_id: "other", reason: "bad" } }, snapshot, contract), /outside the approved boundary/);
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
    repair_id: "repair-payment-reachable-v1",
    repair_command_id: "astronomy.restore-payment-and-recreate-checkout"
  };
}

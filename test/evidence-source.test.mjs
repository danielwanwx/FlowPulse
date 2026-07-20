import assert from "node:assert/strict";
import test from "node:test";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, SNAPSHOT_MAX_BYTES, versionedChangeEvidence } from "../src/evidence-source.mjs";
import { executeTool, validateDiagnosis, validateDiagnosisCandidate, validateEvaluation } from "../src/openai.mjs";
import { loadBundle } from "../src/bundle.mjs";
import { PINNED_CHECKOUT_CODE_SPEC } from "../src/code-evidence.mjs";
import { isExecutableCheckoutPaymentEvidence } from "../src/incident-mechanism.mjs";
import { harnessBinding, loadHarnessManifest } from "../src/harness-manifest.mjs";

test("freezes fresh OTLP in deterministic order under caps with immutable provenance", () => {
  const source = new LiveOtlpEvidenceSource(project("live", [
    record("b", "2026-07-18T10:00:02.000Z", "payment"),
    record("a", "2026-07-18T10:00:01.000Z", "checkout"),
    record("z", "2026-07-18T10:00:03.000Z", "unrelated")
  ]));
  const binding = harnessBinding(loadHarnessManifest());
  const snapshot = source.freeze({ incidentId: "incident", runId: "run", maxRecords: 2, maxBytes: SNAPSHOT_MAX_BYTES, harness: binding });
  assert.deepEqual(snapshot.records.map((item) => item.id), ["a", "b"]);
  assert.equal(snapshot.metadata().mode, "frozen_real_otlp_snapshot");
  assert.equal(snapshot.metadata().label, "frozen real OTLP snapshot");
  assert.equal(Object.hasOwn(snapshot.metadata(), "execution_mode"), false);
  assert.equal(snapshot.metadata().truncated, false);
  assert.equal(snapshot.metadata().harness.manifest_sha256, binding.manifest_sha256);
  assert.equal(snapshot.metadata().harness.skills.investigator.sha256, binding.skills.investigator.sha256);
  assert.match(snapshot.detail("a").hash, /^a{64}$/);
  assert.equal(snapshot.detail("a").payload_redacted, true);
});

test("does not create a frozen snapshot from stale or irrelevant OTLP", () => {
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
  assert.throws(() => validateDiagnosis({ evidence_refs: ["ev-trace-payment-refused"], proposed_repair: { action: "no_execution", target: "checkout" } }, snapshot), (error) => error?.name === "CausalEvidenceError" && error.metadata.reason_code === "unknown_evidence_ref");
  assert.equal(new CapturedBundleEvidenceSource(loadBundle()).has("ev-trace-payment-refused"), true);
});

test("captured replay publishes its complete, deterministic dependency topology without source authority", () => {
  const source = new CapturedBundleEvidenceSource(loadBundle());
  const first = source.topology();
  const second = source.topology();
  assert.deepEqual(first, second);
  assert.deepEqual(first.services.map(({ id }) => id), ["frontend", "checkout", "payment", "kafka", "accounting", "fraud"]);
  assert.deepEqual(first.dependencies.map(({ id, from, to }) => [id, from, to]), [
    ["frontend-checkout", "frontend", "checkout"],
    ["checkout-payment", "checkout", "payment"],
    ["checkout-kafka", "checkout", "kafka"],
    ["kafka-accounting", "kafka", "accounting"],
    ["kafka-fraud", "kafka", "fraud"]
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.services), true);
  assert.equal(Object.isFrozen(first.dependencies), true);
});

test("frozen development snapshot includes a hashed applied change and bounded failure facts", () => {
  const change = versionedChangeEvidence({
    manifest: manifest(),
    applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" },
    ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" }
  });
  const failedTrace = record("failure", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  failedTrace.value.trace = paymentRefused(failedTrace.at);
  const snapshot = new LiveOtlpEvidenceSource(project("live", [failedTrace])).freeze({ supplementalRecords: [change] });
  const trace = executeTool(snapshot, "query_traces", { entity: "checkout" })[0];
  const applied = executeTool(snapshot, "query_changes", { entity: "checkout" })[0];
  const { context_id: _contextId, raw_trace_id: _rawTraceId, ...safeFlag } = failedTrace.value.trace.feature_flag;
  assert.deepEqual(trace.value.trace, {
    ...failedTrace.value.trace,
    feature_flag: safeFlag
  });
  assert.equal(trace.value.trace.feature_flag.key, "paymentUnreachable");
  assert.equal(trace.value.trace.parent_ref, trace.value.trace.feature_flag.span_ref);
  assert.equal(JSON.stringify(trace).includes("raw-context-id"), false);
  assert.equal(JSON.stringify(trace).includes("raw-trace-id"), false);
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
  assert.doesNotThrow(() => validateDiagnosisCandidate({ evidence_refs: [change.id, "live-only"], proposed_repair: { ...contract, reason: "Failure follows the applied change." } }, snapshot, contract));
  assert.throws(() => validateDiagnosisCandidate({ evidence_refs: [change.id, "live-only"], proposed_repair: { ...contract, command_id: "other", reason: "bad" } }, snapshot, contract), (error) => error?.name === "CausalEvidenceError" && error.metadata.reason_code === "repair_contract_mismatch");
});

test("a known weak candidate may reach evaluation but cannot pass the executable causal gate", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const kafka = record("kafka-lag", "2026-07-18T10:00:01.000Z", "kafka", "metric");
  kafka.value.metric = { service: "kafka", name: "kafka.consumer.records_lag", value: 11842, aggregation: "gauge", observed_at: kafka.at };
  const snapshot = new LiveOtlpEvidenceSource(project("live", [change, kafka])).freeze({ executable: false });
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  const candidate = { evidence_refs: [kafka.id], proposed_repair: { ...contract, reason: "Kafka lag is the initial symptom-layer hypothesis." } };
  assert.doesNotThrow(() => validateDiagnosisCandidate(candidate, snapshot, contract));
  assert.throws(() => validateDiagnosis(candidate, snapshot, contract), (error) => error?.name === "CausalEvidenceError" && error.metadata.reason_code === "diagnosis_gate_evidence_missing");
});

test("checkout payment name-resolution failures are a bounded dependency mechanism", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const failure = record("resolver-failure", "2026-07-18T10:00:01.000Z", "checkout", "trace");
  failure.value.trace = paymentRefused(failure.at, { operation: "oteldemo.PaymentService/Charge", peer_target: null, error: "name resolver error: produced zero addresses" });
  assert.equal(isExecutableCheckoutPaymentEvidence(failure, change.value.change), true);
});

test("query_code returns only bounded pinned semantics and no source contents", () => {
  const code = codeEvidence();
  const source = new LiveOtlpEvidenceSource(project("live", [code])).freeze({ executable: false });
  const [result] = executeTool(source, "query_code", { entity: "checkout" });
  assert.equal(result.value.code.commit, PINNED_CHECKOUT_CODE_SPEC.commit);
  assert.equal(result.value.code.content_sha256, PINNED_CHECKOUT_CODE_SPEC.content_sha256);
  assert.equal(result.provenance.line, 565);
  assert.equal(result.provenance.line_end, 575);
  assert.equal(JSON.stringify(result).includes("paymentService :="), false);
  assert.equal(Object.hasOwn(result, "payload"), false);
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

test("executable snapshot reserves baseline, code, change, and three distinct failures under cap pressure", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const lowValue = Array.from({ length: 140 }, (_, index) => record(`low-${index}`, `2026-07-18T10:00:${String(index % 59).padStart(2, "0")}.000Z`, "checkout", "trace"));
  const failures = failureRecords();
  const baseline = baselineEvidence();
  const code = codeEvidence();
  const snapshot = new LiveOtlpEvidenceSource(project("live", [...lowValue, ...failures])).freeze({ supplementalRecords: [baseline, code, change], executable: true, maxRecords: 120, maxBytes: 10_000_000 });
  assert.equal(snapshot.records.length, 120);
  const required = [baseline.id, code.id, change.id, ...failures.map((item) => item.id)];
  for (const id of required) assert.equal(snapshot.has(id), true);
  assert.deepEqual(snapshot.metadata().reserved_causal_ids.sort(), required.sort());
});

test("executable snapshot rejects missing baseline, duplicate failures, and caps that cannot retain the complete gate", () => {
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const code = codeEvidence();
  const baseline = baselineEvidence();
  const failures = failureRecords();
  const source = new LiveOtlpEvidenceSource(project("live", failures));
  assert.throws(() => source.freeze({ supplementalRecords: [code, change], executable: true }), /controlled_off_on_contrast/);
  const duplicates = failureRecords().map((item) => ({ ...item, value: { ...item.value, trace: { ...item.value.trace, trace_ref: "a".repeat(12), feature_flag: { ...item.value.trace.feature_flag, trace_ref: "a".repeat(12) } } } }));
  assert.throws(() => new LiveOtlpEvidenceSource(project("live", duplicates)).freeze({ supplementalRecords: [baseline, code, change], executable: true }), /repeated_direct_failures/);
  assert.throws(() => source.freeze({ supplementalRecords: [baseline, code, change], executable: true, maxRecords: 5, maxBytes: 10_000_000 }), /cannot retain/);
});

test("executable diagnosis rejects irrelevant, missing, reversed, and unknown evaluator evidence", () => {
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const failures = failureRecords();
  const baseline = baselineEvidence();
  const code = codeEvidence();
  const databaseError = record("database-error", "2026-07-18T10:00:02.000Z", "checkout", "trace");
  databaseError.value.trace = { service: "checkout", operation: "SELECT orders", peer_target: "postgres:5432", status: "error", error: "timeout", observed_at: databaseError.at };
  const unrelated = record("unrelated", "2026-07-18T10:00:03.000Z", "payment", "trace");
  const source = new LiveOtlpEvidenceSource(project("live", [change, baseline, code, ...failures, databaseError, unrelated])).freeze({ supplementalRecords: [], executable: false });
  const diagnosis = (refs) => ({ evidence_refs: refs, proposed_repair: { ...contract, reason: "proof" } });
  const complete = [change.id, baseline.id, code.id, ...failures.map((item) => item.id)];
  assert.doesNotThrow(() => validateDiagnosis(diagnosis(complete), source, contract));
  assert.throws(() => validateDiagnosis(diagnosis([unrelated.id]), source, contract), diagnosisGateRejected);
  assert.throws(() => validateDiagnosis(diagnosis([change.id, databaseError.id]), source, contract), diagnosisGateRejected);
  assert.throws(() => validateDiagnosis(diagnosis([change.id]), source, contract), diagnosisGateRejected);
  const reversed = record("reversed", "2026-07-18T09:59:59.000Z", "checkout", "trace");
  reversed.value.trace = paymentRefused(reversed.at);
  const reversedSource = new LiveOtlpEvidenceSource(project("live", [change, baseline, code, reversed, ...failures.slice(1)])).freeze({ executable: false });
  assert.throws(() => validateDiagnosis(diagnosis([change.id, baseline.id, code.id, reversed.id, ...failures.slice(1).map((item) => item.id)]), reversedSource, contract), diagnosisGateRejected);
  assert.throws(() => validateEvaluation({ counter_evidence_refs: ["unknown"] }, source), (error) => error?.name === "CausalEvidenceError" && error.metadata.reason_code === "unknown_evidence_ref");
});

test("executable diagnosis rejects flagd-only, off, different-trace, and post-consumption changes", () => {
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  const change = versionedChangeEvidence({ manifest: manifest(), applied: { before: "off", after: "on", applied_at: "2026-07-18T10:00:00.000Z" }, ledgerEvent: { id: "evt-change", recorded_at: "2026-07-18T10:00:00.100Z" } });
  const baseline = baselineEvidence();
  const code = codeEvidence();
  const valid = failureRecords().slice(0, 2);
  const diagnosis = (failure) => ({ evidence_refs: [change.id, baseline.id, code.id, ...valid.map((item) => item.id), failure.id], proposed_repair: { ...contract, reason: "proof" } });
  const rejected = [
    traceRecord("flagd-only", "2026-07-18T10:00:01.000Z", { feature_flag: { service: "flagd" } }),
    traceRecord("off", "2026-07-18T10:00:01.000Z", { feature_flag: { variant: "off", value: false } }),
    traceRecord("different-trace", "2026-07-18T10:00:01.000Z", { feature_flag: { trace_ref: "f".repeat(12) } }),
    traceRecord("missing-parent-ref", "2026-07-18T10:00:01.000Z", { parent_ref: null }),
    traceRecord("change-after-evaluation", "2026-07-18T10:00:03.000Z", { feature_flag: { evaluated_at: "2026-07-18T09:59:59.000Z" } }),
    traceRecord("failure-before-evaluation", "2026-07-18T10:00:03.000Z", { feature_flag: { evaluated_at: "2026-07-18T10:00:04.000Z" } })
  ];
  const source = new LiveOtlpEvidenceSource(project("live", [change, baseline, code, ...valid, ...rejected])).freeze({ executable: false });
  for (const failure of rejected) assert.throws(() => validateDiagnosis(diagnosis(failure), source, contract), diagnosisGateRejected);
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

function diagnosisGateRejected(error) { return error?.name === "CausalEvidenceError" && error.metadata.reason_code === "diagnosis_gate_evidence_missing"; }

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

function traceRecord(id, at, overrides = {}) {
  const result = record(id, at, "checkout", "trace");
  const base = paymentRefused(at);
  result.value.trace = { ...base, ...overrides, feature_flag: { ...base.feature_flag, ...overrides.feature_flag } };
  return result;
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

function paymentRefused(at, overrides = {}) {
  const traceRef = "a".repeat(12);
  const parentRef = "b".repeat(12);
  return {
    service: "checkout",
    operation: "POST /checkout payment",
    peer_target: "payment:8080",
    status: "error",
    error: "ECONNREFUSED",
    observed_at: at,
    trace_ref: traceRef,
    span_ref: "c".repeat(12),
    parent_ref: parentRef,
    feature_flag: {
      service: "checkout",
      key: "paymentUnreachable",
      variant: "on",
      value: true,
      provider: "flagd",
      reason: "cached",
      evaluated_at: new Date(Date.parse(at) - 1).toISOString(),
      trace_ref: traceRef,
      span_ref: parentRef,
      same_trace: true,
      direct_parent: true,
      context_id: "raw-context-id",
      raw_trace_id: "raw-trace-id"
    },
    ...overrides
  };
}

function baselineEvidence() {
  const at = "2026-07-18T09:59:50.000Z";
  const result = record("baseline-off-success", at, "checkout", "trace");
  result.value.trace = {
    service: "checkout",
    operation: "oteldemo.PaymentService/Charge",
    peer_target: "payment:8080",
    status: "ok",
    error: null,
    observed_at: at,
    trace_ref: "1".repeat(12),
    span_ref: "2".repeat(12),
    parent_ref: "3".repeat(12),
    feature_flag: {
      service: "checkout",
      key: "paymentUnreachable",
      variant: "off",
      value: false,
      provider: "flagd",
      reason: "cached",
      evaluated_at: "2026-07-18T09:59:49.999Z",
      trace_ref: "1".repeat(12),
      span_ref: "3".repeat(12),
      same_trace: true,
      direct_parent: true
    }
  };
  return result;
}

function failureRecords() {
  return ["a", "d", "e"].map((character, index) => {
    const at = `2026-07-18T10:00:0${index + 1}.000Z`;
    const result = record(`failure-${index + 1}`, at, "checkout", "trace");
    result.value.trace = paymentRefused(at, {
      trace_ref: character.repeat(12),
      span_ref: `${index + 4}`.repeat(12),
      parent_ref: `${index + 7}`.repeat(12),
      feature_flag: {
        ...paymentRefused(at).feature_flag,
        evaluated_at: `2026-07-18T10:00:0${index}.999Z`,
        trace_ref: character.repeat(12),
        span_ref: `${index + 7}`.repeat(12)
      }
    });
    return result;
  });
}

function codeEvidence() {
  const code = { id: "astronomy-checkout-payment-unreachable-semantics-v1", ...PINNED_CHECKOUT_CODE_SPEC, verified_from_git_object: true };
  return {
    id: `code-${PINNED_CHECKOUT_CODE_SPEC.content_sha256.slice(0, 16)}`,
    kind: "code",
    signal: "code",
    title: "Pinned checkout semantics",
    fact: PINNED_CHECKOUT_CODE_SPEC.semantic_fact,
    entity: "checkout",
    source: "verified pinned official git object",
    at: "2026-07-17T14:32:39.000Z",
    captured_at: "2026-07-18T09:59:55.000Z",
    value: { code },
    hash: PINNED_CHECKOUT_CODE_SPEC.content_sha256,
    provenance: {
      file: PINNED_CHECKOUT_CODE_SPEC.path,
      line: PINNED_CHECKOUT_CODE_SPEC.line_start,
      line_end: PINNED_CHECKOUT_CODE_SPEC.line_end,
      sha256: PINNED_CHECKOUT_CODE_SPEC.content_sha256,
      repository: PINNED_CHECKOUT_CODE_SPEC.repository,
      commit: PINNED_CHECKOUT_CODE_SPEC.commit,
      immutable_capture: true,
      verified_from_git_object: true
    }
  };
}

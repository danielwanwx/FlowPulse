import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { PINNED_CHECKOUT_CODE_SPEC } from "../src/code-evidence.mjs";
import { DevelopmentRuntime } from "../src/development-runtime.mjs";
import { LiveOtlpEvidenceSource, versionedChangeEvidence } from "../src/evidence-source.mjs";
import { Ledger } from "../src/ledger.mjs";
import { runLiveInvestigation } from "../src/openai.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

test("investigators stop before authority", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-gpt-dev-")), "ledger.db")), bundle: loadBundle() });
  let repaired = false;
  let flag = "on";
  const source = { async project() { return { status: "live", evidence: repaired ? [healthy()] : failures() }; } };
  const adapter = {
    async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "synthetic local flag API" }; },
    async executeApprovedRollback({ commandId }) { repaired = true; flag = "off"; return { command_id: commandId, completed_at: "2026-07-17T12:01:00.000Z", stdout: "", stderr: "" }; },
    async readAllowlistedFlagVariant() { return { flag: "paymentUnreachable", variant: flag, observed_at: "2026-07-17T12:01:30.000Z", source: "synthetic local flag API" }; },
    async finalizeCapture({ runId, evidenceIds }) { return { id: `capture-${runId}`, sha256: "c".repeat(64), evidence_ids: evidenceIds }; }
  };
  const development = new DevelopmentRuntime({ runtime, source, adapter });
  const runId = await development.start();
  const applied = runtime.ledger.list(runId).find((event) => event.type === "change.applied");
  const snapshot = new LiveOtlpEvidenceSource({ status: "live", evidence: failures() }).freeze({
    runId,
    after: applied.payload.applied_at,
    supplementalRecords: [baseline(), code(), versionedChangeEvidence({ manifest: applied.payload.change, applied: applied.payload, ledgerEvent: applied })],
    executable: true
  });
  const contract = development.repairContract(runId);
  const ids = snapshot.metadata().reserved_causal_ids;
  const traceIds = ids.filter((id) => id.startsWith("trace-"));
  const changeId = ids.find((id) => id.startsWith("change-"));
  const codeId = ids.find((id) => id.startsWith("code-"));
  const attemptOne = diagnosis({ id: "hyp-kafka", refs: [traceIds[1]], contract, title: "Kafka caused payment failures", claim: "Kafka lag initiated the checkout incident." });
  const attemptTwo = diagnosis({ id: "hyp-checkout-flag", refs: [changeId, codeId, ...traceIds], contract, title: "Checkout flag caused the resolver failures", claim: "Checkout consumed paymentUnreachable=on and directly failed its payment resolver dependency." });
  const responses = [
    toolResponse("query_traces", "c1"), terminal(attemptOne), terminal(evaluation(false, [traceIds[1]])),
    toolResponse("query_changes", "c2"), toolResponse("query_code", "c3"), toolResponse("query_traces", "c4"), terminal(attemptTwo), terminal(evaluation(true, attemptTwo.evidence_refs))
  ];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-test-only";
  try {
    await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot, repairContract: contract, requestResponse: async () => next(responses), withTrace: trace });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  let events = runtime.ledger.list(runId);
  const authority = events.filter((event) => /^(hypothesis\.proposed|evaluation\.|repair\.proposed|approval\.requested)$/.test(event.type));
  assert.deepEqual(authority.filter((event) => event.type === "hypothesis.proposed").map((event) => event.evidence_refs), [[traceIds[1]], attemptTwo.evidence_refs]);
  assert.equal(events.filter((event) => event.type === "evaluation.rejected").length, 1);
  assert.equal(events.filter((event) => event.type === "evaluation.accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.executed").length, 0);
  assert.equal(events.some((event) => event.type === "diagnosis.gate.passed"), true);
  assert.equal(events.some((event) => event.type === "repair.proposed"), false);
  assert.equal(events.some((event) => event.type === "approval.requested"), false);
});

test("synthetic known but unqueried evidence stops before development authority", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-gpt-lineage-")), "ledger.db")), bundle: loadBundle() });
  const runId = runtime.startRun("development");
  const contract = repairContract();
  const source = frozenForLineage();
  const responses = [toolResponse("query_traces", "bad-call"), terminal(diagnosis({ id: "bad", refs: ["code-known"], contract, title: "Bad", claim: "Bad" }))];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-test-only";
  try {
    await assert.rejects(() => runLiveInvestigation({ runtime, runId, evidenceSource: source, repairContract: contract, requestResponse: async () => next(responses), withTrace: trace }), (error) => error?.name === "CausalEvidenceError" && error?.metadata?.reason_code === "known_but_unqueried_evidence");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.equal(runtime.ledger.list(runId).some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.proposed|approval\.requested)$/.test(event.type)), false);
});

function change() { return { id: "change-payment-unreachable-v1", target: "checkout", flag: "paymentUnreachable", after: "on", known_good: "off", repair_id: "repair-payment-reachable-v1", repair_command_id: "astronomy.restore-payment-and-recreate-checkout" }; }
function repairContract() { return { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" }; }
function baseline() { return traceRecord("trace-baseline", "2026-07-17T11:59:59.000Z", "111111111111", "off", false, "ok", null); }
function failures() { return [traceRecord("trace-failure-1", "2026-07-17T12:00:30.000Z", "aaaaaaaaaaaa", "on", true, "error", "ECONNREFUSED"), traceRecord("trace-failure-2", "2026-07-17T12:00:31.000Z", "bbbbbbbbbbbb", "on", true, "error", "ECONNREFUSED"), traceRecord("trace-failure-3", "2026-07-17T12:00:32.000Z", "cccccccccccc", "on", true, "error", "ECONNREFUSED")]; }
function healthy() { return syntheticRecord({ id: "trace-healthy", kind: "trace", entity: "checkout", signal: "traces", at: "2026-07-17T12:01:20.000Z", value: { trace: { service: "checkout", operation: "PaymentService.Charge", peer_target: "payment:8080", status: "ok", observed_at: "2026-07-17T12:01:20.000Z" } } }); }
function traceRecord(id, at, traceRef, variant, value, status, error) {
  return syntheticRecord({
    id, kind: "trace", entity: "checkout", signal: "traces", at,
    value: {
      services: ["checkout", "payment"],
      trace: {
        service: "checkout", operation: "PaymentService.Charge", peer_target: "payment:8080", status, error, observed_at: at,
        trace_ref: traceRef, span_ref: "cccccccccccc", parent_ref: "bbbbbbbbbbbb",
        feature_flag: {
          service: "checkout", key: "paymentUnreachable", variant, value, provider: "flagd", reason: "cached",
          evaluated_at: new Date(Date.parse(at) - 1).toISOString(), trace_ref: traceRef, span_ref: "bbbbbbbbbbbb", same_trace: true, direct_parent: true
        }
      }
    }
  });
}
function code() { const spec = PINNED_CHECKOUT_CODE_SPEC; return { id: `code-${spec.content_sha256.slice(0, 16)}`, kind: "code", entity: "checkout", signal: "code", at: "2026-07-17T11:00:00.000Z", fact: spec.semantic_fact, source: "verified pinned official git object", value: { code: { id: "checkout-payment-unreachable-v1", ...spec, verified_from_git_object: true } }, hash: spec.content_sha256, provenance: { file: spec.path, line: spec.line_start, line_end: spec.line_end, sha256: spec.content_sha256, repository: spec.repository, commit: spec.commit, immutable_capture: true, verified_from_git_object: true } }; }
function diagnosis({ id, refs, contract, title, claim }) { return { id, title, claim, confidence: 0.9, initiating_change: "checkout paymentUnreachable off to on", failure_mechanism: "checkout payment resolver unreachable", propagation: [], evidence_refs: refs, proposed_repair: { ...contract, reason: "Bounded local rollback." } }; }
function evaluation(accepted, refs) { return { accepted, score: accepted ? 0.95 : 0.1, classification: accepted ? "confirmed_system_bug" : "agent_false_positive", phase: "diagnosis_pre_approval", gate_checks: { initiating_change: accepted, temporal_order: accepted, implementation_semantics: accepted, controlled_off_on_contrast: accepted, repeated_direct_failures: accepted }, reason: accepted ? "Exact causal evidence passed." : "Kafka is not proven.", missing_evidence: accepted ? [] : ["initiating change"], counter_evidence_refs: refs }; }
function completed(output) { return { status: "completed", output }; }
function message(value) { return { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value) }] }; }
function toolResponse(name, callId) { return { data: completed([{ type: "reasoning", encrypted_content: "synthetic-encrypted" }, { type: "function_call", status: "completed", call_id: callId, name, arguments: JSON.stringify({ entity: "checkout" }) }]), metadata: metadata() }; }
function terminal(value) { return { data: completed([message(value)]), metadata: metadata() }; }
function metadata() { return { response_ref: "r".repeat(24), response_body_ref: "b".repeat(24), response_body_bytes: 12, response_status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; }
function next(values) { const value = values.shift(); if (!value) throw new Error("unexpected synthetic response"); return value; }
async function trace(_context, work) { return work({ traceRef: "safe", generation: () => observation(), evaluator: () => observation(), tool: () => observation() }); }
function observation() { return { update() { return this; }, end() {} }; }
function frozenForLineage() { const traceRecord = syntheticRecord({ id: "trace-returned", kind: "trace", entity: "checkout", value: {} }); const codeRecord = syntheticRecord({ id: "code-known", kind: "code", entity: "checkout", value: {} }); const changeRecord = syntheticRecord({ id: "change-contract", kind: "change", entity: "checkout", value: { change: { repair_id: "repair-payment-reachable-v1", target: "checkout", repair_command_id: "astronomy.restore-payment-and-recreate-checkout", flag: "paymentUnreachable" } } }); return { metadata: () => ({ mode: "frozen_real_otlp_snapshot" }), entities: () => ["checkout"], query: ({ kind }) => kind === "trace" ? [traceRecord] : kind === "change" ? [changeRecord] : [], summariesById: (ids) => [traceRecord, codeRecord, changeRecord].filter((record) => ids.includes(record.id)), has: (id) => [traceRecord, codeRecord, changeRecord].some((record) => record.id === id), list: () => ({ items: [traceRecord, codeRecord, changeRecord] }) }; }
function syntheticRecord(record) { const hash = record.hash || "a".repeat(64); return { source: "synthetic-test", fact: "Synthetic bounded evidence", ...record, hash, provenance: record.provenance || { sha256: hash } }; }

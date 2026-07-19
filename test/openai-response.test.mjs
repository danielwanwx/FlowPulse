import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelApiError,
  ModelBudgetExceededError,
  ModelIncompleteError,
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelTransportError,
  inspectOpenAIResponse,
  requestOpenAIResponse,
  safeFailure,
  safeFailureMetadata
} from "../src/openai-response.mjs";
import { CausalEvidenceError, createWorkflowBudget, runLiveInvestigation } from "../src/openai.mjs";
import { investigationFailureEnvelope, recordInvestigationFailure } from "../src/investigation-failure.mjs";

const entities = ["checkout", "payment"];
const secret = "seeded-secret-do-not-persist";

test("responses boundary accepts one completed structured terminal response and retains only safe metadata", async () => {
  const result = await request({
    status: "completed",
    id: "resp_should_never_escape",
    usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    output: [message(JSON.stringify({ accepted: false }))]
  });
  const inspected = inspectOpenAIResponse(result.data, result.metadata, { entities, stage: "evaluator" });
  assert.equal(inspected.kind, "terminal");
  assert.deepEqual(inspected.value, { accepted: false });
  assert.equal(JSON.stringify(inspected.metadata).includes("resp_should_never_escape"), false);
  assert.equal(JSON.stringify(inspected.metadata).includes(secret), false);
});

test("responses boundary rejects incomplete, refusal, malformed, missing, multiple, mixed, and oversized output before authority", () => {
  assert.throws(() => inspectOpenAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message("{")] }, metadata(), { entities, stage: "investigator" }), ModelIncompleteError);
  assert.throws(() => inspectOpenAIResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message("{")] }, { response_status: "incomplete", usage: {} }, { entities, stage: "investigator" }), ModelIncompleteError);
  assert.throws(() => inspectOpenAIResponse(completed([message("ignored", { type: "refusal", refusal: secret })]), metadata(), { entities, stage: "investigator" }), ModelRefusalError);
  assert.throws(() => inspectOpenAIResponse(completed([message(`{"claim":"${secret}"`)]), metadata(), { entities, stage: "investigator" }), (error) => error instanceof ModelOutputInvalidError && error.code === "json_parse_failed");
  assert.throws(() => inspectOpenAIResponse(completed([]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([message("{}"), message("{}")]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([tool("call-a"), message("{}")]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([message(JSON.stringify({ claim: secret.repeat(3000) }))]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
});

test("responses boundary validates bounded unique allowlisted entity-only tool calls and encrypted reasoning stays in-memory", () => {
  const response = completed([
    { type: "reasoning", encrypted_content: `encrypted-${secret}` },
    tool("call-a", "query_traces", { entity: "checkout" })
  ]);
  const inspected = inspectOpenAIResponse(response, metadata(), { entities, stage: "investigator" });
  assert.equal(inspected.kind, "tool_calls");
  assert.deepEqual(inspected.calls.map((call) => ({ name: call.name, args: call.args })), [{ name: "query_traces", args: { entity: "checkout" } }]);
  assert.equal(JSON.stringify(inspected.metadata).includes(secret), false);
  assert.equal(inspected.replayItems[0].encrypted_content.includes(secret), true);
  assert.throws(() => inspectOpenAIResponse(completed([tool("call-a"), tool("call-a")]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([tool("call-a", "execute_shell")]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([tool("call-a", "query_traces", { entity: "unknown" })]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([tool("call-a", "query_traces", { entity: "checkout", extra: secret })]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
});

test("responses boundary requires exact completed assistant/tool states and replayable encrypted reasoning", () => {
  assert.throws(() => inspectOpenAIResponse(completed([{ ...message("{}"), status: "in_progress" }]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([{ ...message("{}"), status: undefined }]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([{ ...message("{}"), role: "user" }]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([{ ...tool("call-a"), status: "in_progress" }]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([{ ...tool("call-a"), status: undefined }]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([{ type: "reasoning" }, tool("call-a")]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
  assert.throws(() => inspectOpenAIResponse(completed([tool("💥".repeat(128))]), metadata(), { entities, stage: "investigator" }), ModelOutputInvalidError);
});

test("safe failure metadata is an explicit allowlist", () => {
  const unsafe = safeFailureMetadata({
    response_ref: "a".repeat(24), response_body_ref: "b".repeat(24), response_body_bytes: 12, response_status: "completed",
    usage: { input_tokens: 1, output_tokens: 2, secret: secret }, stage: "investigator", call_id: "call-secret",
    response_id: "resp-secret", encrypted_content: secret, raw_text: secret, api_error: secret, arbitrary: { secret }
  });
  const serialized = JSON.stringify(unsafe);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("call-secret"), false);
  assert.equal(serialized.includes("resp-secret"), false);
  assert.deepEqual(Object.keys(unsafe).sort(), ["response_body_bytes", "response_body_ref", "response_ref", "response_status", "stage", "usage"]);
});

test("responses transport boundary rejects oversized, non-json, non-success, and transport results without raw API text", async () => {
  await assert.rejects(() => request({}, { status: 500, body: secret }), (error) => error instanceof ModelApiError && error.code === "api_non_success" && !JSON.stringify(safeFailure(error)).includes(secret));
  await assert.rejects(() => request("not-json"), (error) => error instanceof ModelApiError && error.code === "api_body_not_json");
  await assert.rejects(() => request({ output: secret.repeat(100) }, { limit: 32 }), (error) => error instanceof ModelApiError && error.code === "api_body_too_large");
  await assert.rejects(() => request({}, { fetchImpl: async () => { throw new TypeError(secret); } }), (error) => error instanceof ModelTransportError && !JSON.stringify(safeFailure(error)).includes(secret));
});

test("workflow budget stops before another paid response and keeps invalid token usage fail closed", () => {
  const budget = createWorkflowBudget();
  const initial = budget.requestLimit("investigator");
  assert.equal(initial >= 4096, true);
  budget.consumeResponse({ usage: { output_tokens: 49_152 } }, "investigator");
  assert.throws(() => budget.requestLimit("investigator"), ModelBudgetExceededError);
  const invalid = createWorkflowBudget();
  invalid.requestLimit("evaluator");
  assert.throws(() => invalid.consumeResponse({ usage: { output_tokens: null } }, "evaluator"), ModelOutputInvalidError);
});

test("one rejected evaluator replan completes within budget only after terminal validation", async () => {
  const runtime = modelRuntime();
  const source = modelOnlySource();
  const observations = [];
  const responses = [
    toolResponse("query_traces"), terminalResponse(diagnosis("first")), terminalResponse(evaluation(false)),
    toolResponse("query_traces"), terminalResponse(diagnosis("second")), terminalResponse(evaluation(true))
  ];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  try {
    await runLiveInvestigation({ runtime, runId: "run-replan", evidenceSource: source, requestResponse: async () => nextResponse(responses), withTrace: fakeTrace(observations) });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.equal(responses.length, 0);
  assert.equal(runtime.events.filter((event) => event.type === "tool.called").length, 2);
  const contexts = runtime.events.filter((event) => event.type === "context.compiled");
  assert.equal(contexts.length, 2);
  assert.equal(contexts.every((event) => event.payload.non_authoritative_summary === true && /^[a-f0-9]{64}$/.test(event.payload.context_sha256)), true);
  assert.equal(contexts.every((event) => event.payload.harness?.manifest_sha256 && event.evidence_refs.every((id) => event.payload.authority_refs.includes(id))), true);
  assert.equal(runtime.events.filter((event) => event.type === "hypothesis.proposed").length, 2);
  assert.equal(runtime.events.filter((event) => event.type === "evaluation.rejected").length, 1);
  assert.equal(runtime.events.filter((event) => event.type === "evaluation.accepted").length, 1);
  assert.equal(runtime.events.filter((event) => event.type === "plan.revised").length, 1);
  assert.equal(JSON.stringify(observations).includes("test-key-not-a-real-secret"), false);
  assert.equal(JSON.stringify(observations).includes("encrypted-replay-token"), false);
});

test("an attempt-one malformed evaluator leaves no model authority events", async () => {
  const runtime = modelRuntime();
  const source = modelOnlySource();
  const responses = [
    toolResponse("query_traces"), terminalResponse(diagnosis("first")),
    { data: completed([message("{")]), metadata: responseMetadata() }
  ];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  try {
    await assert.rejects(() => runLiveInvestigation({ runtime, runId: "run-first-evaluator-failure", evidenceSource: source, requestResponse: async () => nextResponse(responses) }), ModelOutputInvalidError);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.equal(responses.length, 0);
  assert.equal(runtime.events.filter((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)).length, 0);
  assert.equal(runtime.events.filter((event) => event.type === "tool.called").length, 1);
});

test("a second-attempt malformed evaluator leaves no model authority events", async () => {
  const runtime = modelRuntime();
  const source = modelOnlySource();
  const responses = [
    toolResponse("query_traces"), terminalResponse(diagnosis("first")), terminalResponse(evaluation(false)),
    toolResponse("query_traces"), terminalResponse(diagnosis("second")),
    { data: completed([message("{")]), metadata: responseMetadata() }
  ];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  try {
    await assert.rejects(() => runLiveInvestigation({ runtime, runId: "run-second-failure", evidenceSource: source, requestResponse: async () => nextResponse(responses) }), ModelOutputInvalidError);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.equal(responses.length, 0);
  assert.equal(runtime.events.filter((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)).length, 0);
  assert.equal(runtime.events.filter((event) => event.type === "tool.called").length, 2);
});

test("known but unqueried diagnosis or evaluator evidence stops before authority", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  try {
    const diagnosisRuntime = modelRuntime();
    const unqueriedDiagnosis = { ...diagnosis("unqueried"), evidence_refs: ["ev-unqueried"] };
    const diagnosisResponses = [toolResponse("query_traces", "call-unqueried"), terminalResponse(unqueriedDiagnosis)];
    await assert.rejects(
      () => runLiveInvestigation({
        runtime: diagnosisRuntime, runId: "run-unqueried-diagnosis", evidenceSource: lineageSource(),
        requestResponse: async () => nextResponse(diagnosisResponses)
      }),
      CausalEvidenceError
    );
    assert.equal(diagnosisRuntime.events.some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)), false);

    const evaluatorRuntime = modelRuntime();
    const evaluator = { ...evaluation(false), counter_evidence_refs: ["ev-unqueried"] };
    const evaluatorResponses = [toolResponse("query_traces", "call-evaluator"), terminalResponse(diagnosis("valid")), terminalResponse(evaluator)];
    await assert.rejects(
      () => runLiveInvestigation({
        runtime: evaluatorRuntime, runId: "run-unqueried-evaluator", evidenceSource: lineageSource(),
        requestResponse: async () => nextResponse(evaluatorResponses)
      }),
      CausalEvidenceError
    );
    assert.equal(evaluatorRuntime.events.some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)), false);

    const omittedRuntime = modelRuntime();
    const omittedDiagnosis = { ...diagnosis("omitted"), evidence_refs: ["ev-trace", "ev-log"] };
    const omittedEvaluator = { ...evaluation(false), counter_evidence_refs: ["ev-log"] };
    const omittedResponses = [toolResponse("query_traces", "call-omitted-trace"), toolResponse("query_logs", "call-omitted-log"), terminalResponse(omittedDiagnosis), terminalResponse(omittedEvaluator)];
    await assert.rejects(
      () => runLiveInvestigation({ runtime: omittedRuntime, runId: "run-omitted-evaluator", evidenceSource: lineageSource({ omitEvaluatorLog: true }), requestResponse: async () => nextResponse(omittedResponses) }),
      CausalEvidenceError
    );
    assert.equal(omittedRuntime.events.some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("valid multi-tool lineage accepts only evidence returned by the same attempt", async () => {
  const runtime = modelRuntime();
  const source = lineageSource();
  const first = { ...diagnosis("multi"), evidence_refs: ["ev-trace", "ev-log"] };
  const accepted = { ...evaluation(true), counter_evidence_refs: ["ev-trace", "ev-log"] };
  const responses = [toolResponse("query_traces", "call-trace"), toolResponse("query_logs", "call-log"), terminalResponse(first), terminalResponse(accepted)];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  try {
    await runLiveInvestigation({
      runtime, runId: "run-multi-tool-lineage", evidenceSource: source,
      requestResponse: async () => nextResponse(responses)
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  const proposed = runtime.events.find((event) => event.type === "hypothesis.proposed");
  assert.deepEqual(proposed.evidence_refs, ["ev-trace", "ev-log"]);
  assert.equal(runtime.events.filter((event) => event.type === "tool.called").length, 2);
  assert.equal(runtime.events.some((event) => event.type === "evaluation.accepted"), true);
});

test("typed investigation failures are exactly-once, safe, and authority-free", () => {
  const appended = [];
  const runtime = {
    ledger: { list: () => appended },
    append(_runId, type, _actor, payload) { appended.push({ type, payload }); }
  };
  const error = new ModelOutputInvalidError("json_parse_failed", { response_body_ref: "safe-hash", output_text_bytes: 77 });
  const first = recordInvestigationFailure({ runtime, runId: "run-safe", error, failedType: "development.investigation.failed" });
  const second = recordInvestigationFailure({ runtime, runId: "run-safe", error, failedType: "development.investigation.failed" });
  assert.equal(first.failureId, second.failureId);
  assert.equal(appended.length, 3);
  assert.equal(appended.every((event) => !JSON.stringify(event).includes(secret)), true);
  assert.equal(appended.some((event) => /hypothesis|evaluation|repair|approval/.test(event.type)), false);
  assert.equal(appended[0].payload.classification, "model_output_invalid");
  const envelope = investigationFailureEnvelope(first, { status: "investigating" });
  assert.equal(JSON.stringify(envelope).includes(secret), false);
  assert.deepEqual(Object.keys(envelope.error).sort(), ["classification", "code", "failure_id", "message"]);
});

for (const scenario of [
  { name: "investigator incomplete", stage: "investigator", code: "response_incomplete", response: () => ({ data: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message(secret)] }, metadata: unsafeResponseMetadata() }) },
  { name: "investigator refusal", stage: "investigator", code: "model_refusal", response: () => ({ data: completed([message("ignored", { type: "refusal", refusal: secret })]), metadata: unsafeResponseMetadata() }) },
  { name: "investigator malformed", stage: "investigator", code: "json_parse_failed", response: () => ({ data: completed([message(`{\"claim\":\"${secret}\"`)]), metadata: unsafeResponseMetadata() }) },
  { name: "investigator transport", stage: "investigator", code: "transport_failed", transport: true },
  { name: "evaluator incomplete", stage: "evaluator", code: "response_incomplete", response: () => ({ data: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message(secret)] }, metadata: unsafeResponseMetadata() }) },
  { name: "evaluator refusal", stage: "evaluator", code: "model_refusal", response: () => ({ data: completed([message("ignored", { type: "refusal", refusal: secret })]), metadata: unsafeResponseMetadata() }) },
  { name: "evaluator malformed", stage: "evaluator", code: "json_parse_failed", response: () => ({ data: completed([message(`{\"claim\":\"${secret}\"`)]), metadata: unsafeResponseMetadata() }) },
  { name: "evaluator transport", stage: "evaluator", code: "transport_failed", transport: true }
]) {
  test(`actual investigation path records safe typed metadata for ${scenario.name}`, async () => {
    const runtime = failureRuntime();
    const source = modelOnlySource();
    const responses = scenario.stage === "evaluator"
      ? [toolResponse("query_traces", "call-secret"), terminalResponse(diagnosis("failure-path"))]
      : [];
    const requestResponse = async () => {
      if (responses.length) return nextResponse(responses);
      if (scenario.transport) throw new ModelTransportError("transport_failed", { api_error: secret, response_id: "resp-secret" });
      return scenario.response();
    };
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-test-only";
    let error;
    try {
      await runLiveInvestigation({ runtime, runId: `run-${scenario.name.replaceAll(" ", "-")}`, evidenceSource: source, requestResponse });
    } catch (caught) {
      error = caught;
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
    assert.ok(error);
    const failure = recordInvestigationFailure({ runtime, runId: `run-${scenario.name.replaceAll(" ", "-")}`, error, failedType: "live.run.failed" });
    const episode = runtime.events.find((event) => event.type === "failure.episode.recorded")?.payload.episode;
    assert.equal(failure.classification.startsWith("model_"), true);
    assert.deepEqual({ stage: episode.stage, attempt: episode.attempt, round: episode.round, validator_id: episode.validator_id, reason_code: episode.reason_code }, {
      stage: scenario.stage,
      attempt: 1,
      round: scenario.stage === "investigator" ? 1 : 0,
      validator_id: "responses_boundary",
      reason_code: scenario.code
    });
    assert.equal(episode.harness.manifest_sha256.length, 64);
    if (!scenario.transport) {
      assert.equal(episode.response_ref, "a".repeat(24));
      assert.equal(episode.response_body_ref, "b".repeat(24));
      assert.deepEqual(episode.usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
    }
    if (scenario.stage === "evaluator") assert.match(episode.context_sha256, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(runtime.events);
    for (const forbidden of [secret, "call-secret", "encrypted-replay-token", "resp-secret"]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(runtime.events.some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)), false);
  });
}

async function request(payload, options = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return requestOpenAIResponse({
    url: "http://example.invalid/responses",
    body: { model: "gpt-5.6" },
    limits: { ...undefined, maxResponseBytes: options.limit || 1_048_576 },
    fetchImpl: options.fetchImpl || (async () => new Response(body, { status: options.status || 200, headers: { "content-type": "application/json" } }))
  });
}

function completed(output) { return { status: "completed", output }; }
function metadata() { return { response_ref: "safe", response_body_ref: "safe-body", response_body_bytes: 10, response_status: "completed", usage: { output_tokens: 1 } }; }
function message(text, content = null) { return { type: "message", role: "assistant", status: "completed", content: [content || { type: "output_text", text }] }; }
function tool(callId, name = "query_traces", args = { entity: "checkout" }) { return { type: "function_call", status: "completed", call_id: callId, name, arguments: JSON.stringify(args) }; }

function responseMetadata() { return { response_ref: "a".repeat(24), response_body_ref: "b".repeat(24), response_body_bytes: 12, response_status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; }
function unsafeResponseMetadata() { return { ...responseMetadata(), raw_text: secret, response_id: "resp-secret", call_id: "call-secret", encrypted_content: "encrypted-replay-token" }; }
function terminalResponse(value) { return { data: completed([message(JSON.stringify(value))]), metadata: responseMetadata() }; }
function toolResponse(name, callId = "call-tool") { return { data: completed([{ type: "reasoning", encrypted_content: "encrypted-replay-token" }, tool(callId, name)]), metadata: responseMetadata() }; }
function nextResponse(responses) { const response = responses.shift(); if (!response) throw new Error("unexpected response request"); return response; }
function diagnosis(id) {
  return {
    id: `hyp-${id}`, title: "Narrow checkout payment finding", claim: "Checkout has a bounded payment signal.", confidence: 0.5,
    initiating_change: "Not executable in model-only mode", failure_mechanism: "Bounded evidence query", propagation: [], evidence_refs: ["ev-trace"],
    proposed_repair: { action: "no_execution", target: "checkout", reason: "Model-only snapshot cannot request execution." }
  };
}
function evaluation(accepted) {
  return {
    accepted, score: accepted ? 0.9 : 0.2, classification: accepted ? "confirmed_system_bug" : "insufficient_evidence", phase: "diagnosis_pre_approval",
    gate_checks: {
      initiating_change: accepted, temporal_order: accepted, implementation_semantics: accepted,
      controlled_off_on_contrast: accepted, repeated_direct_failures: accepted
    },
    reason: accepted ? "Narrow model-only claim is internally consistent." : "Replan to direct trace evidence.",
    missing_evidence: accepted ? [] : ["direct trace evidence"], counter_evidence_refs: []
  };
}
function modelRuntime() {
  const events = [];
  return {
    events,
    bundle: { incident: { id: "incident-test", title: "Test incident", summary: "Bounded test incident" } },
    append(_runId, type, actor, payload, evidenceRefs = []) { events.push({ type, actor, payload, evidence_refs: evidenceRefs }); }
  };
}
function failureRuntime() {
  const events = [];
  return {
    events,
    bundle: { incident: { id: "incident-test", title: "Test incident", summary: "Bounded test incident" } },
    ledger: { list: () => events },
    append(_runId, type, actor, payload, evidence_refs = []) {
      const event = { type, actor, payload, evidence_refs };
      events.push(event);
      return event;
    }
  };
}
function modelOnlySource() {
  const record = { id: "ev-trace", kind: "trace", entity: "checkout", source: "synthetic-test", fact: "Bounded test trace", value: {}, hash: "c".repeat(64), provenance: { sha256: "c".repeat(64) } };
  return {
    metadata: () => ({ mode: "frozen_real_otlp_snapshot" }),
    entities: () => ["checkout", "payment"],
    query: ({ kind, entity }) => kind === "trace" && entity === "checkout" ? [record] : [],
    list: () => ({ items: [record] }),
    has: (id) => id === record.id,
    summariesById: (ids) => ids.filter((id) => id === record.id).map(() => record)
  };
}
function lineageSource({ omitEvaluatorLog = false } = {}) {
  const records = [
    { id: "ev-trace", kind: "trace", entity: "checkout", source: "synthetic-test", fact: "Bounded trace", value: {}, hash: "c".repeat(64), provenance: { sha256: "c".repeat(64) } },
    { id: "ev-log", kind: "log", entity: "checkout", source: "synthetic-test", fact: "Bounded log", value: {}, hash: "d".repeat(64), provenance: { sha256: "d".repeat(64) } },
    { id: "ev-unqueried", kind: "change", entity: "checkout", source: "synthetic-test", fact: "Known but not returned", value: {}, hash: "e".repeat(64), provenance: { sha256: "e".repeat(64) } }
  ];
  return {
    metadata: () => ({ mode: "frozen_real_otlp_snapshot" }),
    entities: () => ["checkout", "payment"],
    query: ({ kind, entity }) => records.filter((record) => record.kind === kind && record.entity === entity && record.id !== "ev-unqueried"),
    list: () => ({ items: records }),
    has: (id) => records.some((record) => record.id === id),
    summariesById: (ids) => records.filter((record) => ids.includes(record.id) && (!omitEvaluatorLog || record.id !== "ev-log"))
  };
}
function fakeTrace(observations) {
  return async (_context, work) => work({
    traceRef: "safe-trace-ref",
    generation: (name, details) => fakeObservation(observations, "generation", name, details),
    evaluator: (name, details) => fakeObservation(observations, "evaluator", name, details),
    tool: (name, details) => fakeObservation(observations, "tool", name, details)
  });
}
function fakeObservation(observations, type, name, details) {
  const event = { type, name, details, updates: [] };
  observations.push(event);
  return { update(update) { event.updates.push(update); return this; }, end() {} };
}

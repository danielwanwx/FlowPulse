import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentTeamChatError,
  AgentTeamChatService,
  createOpenAIChatAdapter
} from "../src/agent-team-chat.mjs";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

function setup({ modelAdapter, context = contextForRun } = {}) {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-agent-team-chat-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun();
  return {
    runtime,
    runId,
    service: new AgentTeamChatService({ runtime, modelAdapter, contextForRun: context })
  };
}

function contextForRun(runtime, runId) {
  return {
    topology_views: {
      schema_version: "flowpulse.topology-views.v2",
      projection_revision: "a".repeat(64),
      architecture: { runtime_data: { graph: { nodes: runtime.state(runId).topology.services.map(({ id }) => ({ id })) } } }
    },
    incident_projection: {
      schema_version: "flowpulse.incident-projection.v1",
      projection_revision: "b".repeat(64),
      source_health: "live",
      evidence_mode: "captured_fixture",
      execution_mode: "deterministic_replay",
      stage: { id: "monitor", label: "Monitor" },
      stage_status: "collecting",
      human_gate: { status: "not_required" },
      evidence: [{
        id: "ev-checkout-test",
        kind: "trace",
        entity: "checkout",
        source: "captured fixture",
        observed_at: "2026-07-20T00:00:00.000Z",
        record_sha256: "c".repeat(64)
      }]
    },
    source: { status: "captured", freshness_ms: 0, evidence_count: 1 },
    source_evidence: [{
      id: "ev-captured-checkout-metric",
      kind: "metric",
      signal: "metric",
      title: "Captured checkout error rate",
      fact: "Captured checkout error rate rose after the observed payment refusal.",
      entity: "checkout",
      source: "captured fixture",
      at: "2026-07-20T00:00:00.000Z",
      hash: "d".repeat(64)
    }],
    selected_component_detail: {
      component: { id: "checkout", label: "Checkout", kind: "service", status: "captured", source_health: "captured" },
      runtime: { status: "captured", freshness_ms: 0 },
      observability: { metrics: [{ evidence_id: "ev-captured-checkout-metric" }], traces: [], logs: [], changes: [] }
    }
  };
}

function request(runtime, runId, overrides = {}) {
  return {
    run_id: runId,
    incident_id: runtime.bundle.incident.id,
    conversation_id: "conv-checkout-001",
    idempotency_key: "chat-key-001",
    requested_agent: "orchestrator",
    page_mode: "architecture",
    selected_component: "checkout",
    message: "Explain the investigation workflow for checkout.",
    ...overrides
  };
}

test("strict request validation rejects unknown, authority, invalid persona, caps, and noncanonical nodes before provider work", async () => {
  let calls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: { async respond() { calls++; return { answer: "unexpected", provider: "test", model: "test" }; } } });

  for (const input of [
    request(runtime, runId, { authority: "caller" }),
    request(runtime, runId, { requested_agent: "ledger" }),
    request(runtime, runId, { selected_component: "not-a-runtime-node" }),
    request(runtime, runId, { message: "x".repeat(1_501) })
  ]) {
    await assert.rejects(() => service.submit(input), (error) => error instanceof AgentTeamChatError);
  }

  assert.equal(calls, 0);
  assert.equal(runtime.ledger.list(runId).filter((event) => event.type.startsWith("agent_team.")).length, 0);
});

test("conversation record capacity reserves the full bounded append budget before provider work", async () => {
  let calls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: { async respond() { calls++; return { answer: "unexpected" }; } } });
  for (let index = 0; index < 42; index++) {
    runtime.ledger.append({
      runId,
      incidentId: runtime.bundle.incident.id,
      type: "agent_team.error.recorded",
      actor: "runtime",
      payload: { conversation_id: "conv-checkout-001", message_id: `msg-existing-${index}`, code: "model_unavailable", attempts: 1 },
      correlationId: `agent-team:conv-checkout-001:msg-existing-${index}`
    });
  }
  await assert.rejects(() => service.submit(request(runtime, runId, { idempotency_key: "chat-key-capacity" })), /conversation_record_budget_exhausted/);
  assert.equal(calls, 0);
  assert.equal(runtime.ledger.list(runId).filter((event) => event.type.startsWith("agent_team.")).length, 42);
});

test("routing is explicit, persisted in order, and duplicate idempotency keys do not call the provider twice", async () => {
  let calls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: { async respond() { calls++; return { answer: "The evidence is bounded to the selected component.", provider: "recorded", model: "recorded-test" }; } } });
  const input = request(runtime, runId, {
    requested_agent: "observer",
    message: "Why is checkout failing? Investigate the causal evidence.",
    idempotency_key: "chat-key-handoff"
  });

  const first = await service.submit(input);
  const events = runtime.ledger.list(runId).filter((event) => event.type.startsWith("agent_team."));
  const repeat = await service.submit(input);

  assert.equal(first.requested_agent, "observer");
  assert.equal(first.responding_agent, "investigator");
  assert.deepEqual(first.handoff, { from: "observer", to: "investigator", reason: "Causal investigation belongs to Investigator." });
  assert.equal(first.state, "completed");
  const rendered = Object.fromEntries(first.conversation.messages.map((item) => [item.kind, item]));
  assert.equal(rendered.user.requested_agent, "observer");
  assert.equal(rendered.user.selected_component, "checkout");
  assert.deepEqual(rendered.handoff, { id: rendered.handoff.id, sequence: rendered.handoff.sequence, recorded_at: rendered.handoff.recorded_at, type: "agent_team.handoff.recorded", kind: "handoff", from: "observer", to: "investigator", reason: "Causal investigation belongs to Investigator." });
  assert.equal(rendered.working.responding_agent, "investigator");
  assert.equal(rendered.tool_summary.tools.every((tool) => tool.raw_payload_excluded), true);
  assert.equal(rendered.assistant.state, "completed");
  assert.equal(rendered.assistant.responding_agent, "investigator");
  assert.deepEqual(first.citations, ["ev-captured-checkout-metric", "ev-checkout-test"]);
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.message_id, first.message_id);
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "agent_team.message.received",
    "agent_team.handoff.recorded",
    "agent_team.context.prepared",
    "agent_team.tool_summary.recorded",
    "agent_team.response.working",
    "agent_team.response.created"
  ]);
  assert.equal(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence), true);
});

test("role tools stay isolated, Ledger language routes to a conversational role, and read projections never call a provider", async () => {
  let calls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: { async respond() { calls++; return { answer: "Source freshness is bounded and read-only.", provider: "recorded", model: "recorded-test" }; } } });

  assert.equal(service.project({ runId, conversationId: "conv-checkout-001" }).messages.length, 0);
  assert.equal(calls, 0);
  const result = await service.submit(request(runtime, runId, {
    message: "Show the Evidence Ledger freshness and current signals.",
    idempotency_key: "chat-key-ledger"
  }));

  assert.equal(result.responding_agent, "observer");
  assert.equal(result.handoff.to, "observer");
  assert.deepEqual(result.tool_summaries.map((item) => item.tool), ["read_source_freshness", "read_signal_summaries"]);
  assert.equal(JSON.stringify(result).includes("repair.executed"), false);
  assert.equal(calls, 1);
});

test("read-side provider capability remains non-probing until an explicit submit", async () => {
  let preflightCalls = 0;
  const adapter = {
    provider: "codex-local",
    model: "Codex CLI",
    capability() {
      return { provider_kind: "codex-local", availability: "preflight_required", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null };
    },
    async preflight() {
      preflightCalls++;
      return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null };
    },
    async respond() { return { answer: "Local answer." }; }
  };
  const { runId, service } = setup({ modelAdapter: adapter });

  assert.equal(service.project({ runId, conversationId: "conv-checkout-001" }).messages.length, 0);
  assert.equal((await service.preflightProvider({ probe: false })).availability, "preflight_required");
  assert.equal(preflightCalls, 0);
});

test("a validated provider handoff is recorded transparently without a second model invocation", async () => {
  let calls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: {
    async respond() {
      calls++;
      return {
        answer: "The current evidence needs adversarial review.",
        recommended_handoff: { to: "evaluator", reason: "The remaining question is evidence quality." }
      };
    }
  } });
  const result = await service.submit(request(runtime, runId, {
    requested_agent: "investigator",
    message: "Inspect the bounded evidence.",
    idempotency_key: "chat-key-model-handoff"
  }));

  assert.equal(calls, 1);
  assert.deepEqual(result.handoff, { from: "investigator", to: "evaluator", reason: "The remaining question is evidence quality." });
  assert.deepEqual(result.conversation.messages.map((item) => item.kind), ["user", "context", "tool_summary", "working", "handoff", "assistant"]);
  assert.equal(result.conversation.messages.at(-1).responding_agent, "investigator");
});

test("the default judge adapter is recorded and its label is persisted without a model call on read", async () => {
  const { runtime, runId, service } = setup();
  assert.equal((await service.preflightProvider()).truth_label, "RECORDED/DEMO");
  const result = await service.submit(request(runtime, runId, { idempotency_key: "chat-key-recorded-label" }));

  assert.deepEqual(result.provider, {
    provider_kind: "recorded",
    availability: "available",
    truth_label: "RECORDED/DEMO",
    model_label: "recorded-agent-team-v1",
    failure_reason: null
  });
  assert.equal(result.conversation.messages.find((item) => item.kind === "assistant").provider.truth_label, "RECORDED/DEMO");
});

test("authority requests stop at the human gate and redact secrets without provider or approval side effects", async () => {
  let calls = 0;
  let preflightCalls = 0;
  const { runtime, runId, service } = setup({ modelAdapter: {
    async preflight() { preflightCalls++; return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null }; },
    capability() { return { provider_kind: "codex-local", availability: "preflight_required", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null }; },
    async respond() { calls++; return { answer: "unexpected", provider: "test", model: "test" }; }
  } });
  const result = await service.submit(request(runtime, runId, {
    requested_agent: "investigator",
    message: "Approve and execute the repair. secret=do-not-store-this",
    idempotency_key: "chat-key-authority"
  }));
  const serialized = JSON.stringify({ result, events: runtime.ledger.list(runId) });

  assert.equal(result.state, "needs_human");
  assert.match(result.answer, /cannot approve or execute/i);
  assert.equal(calls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(runtime.ledger.list(runId).some((event) => /^(approval\.granted|repair\.executed)$/.test(event.type)), false);
  assert.equal(serialized.includes("do-not-store-this"), false);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "agent_team.human_gate.required"), true);
});

test("four role prompts preserve the requested role, avoid read-question gates, and cite captured bounded source evidence", async () => {
  const contexts = [];
  const { runtime, runId, service } = setup({ modelAdapter: {
    async respond({ role, context }) {
      contexts.push({ role, context });
      return { answer: `${role} bounded answer.` };
    }
  } });
  const prompts = [
    ["observer", "Report captured source freshness, current signals, and anomalies for checkout."],
    ["orchestrator", "Explain the architecture workflow and owner gate for checkout; do not claim approval."],
    ["investigator", "Investigate the checkout root cause using bounded evidence."],
    ["evaluator", "Evaluate the causal evidence and state whether human approval is granted."]
  ];

  for (const [requested_agent, message] of prompts) {
    const result = await service.submit(request(runtime, runId, {
      requested_agent,
      message,
      conversation_id: `conv-${requested_agent}-001`,
      idempotency_key: `chat-key-${requested_agent}`
    }));
    assert.equal(result.responding_agent, requested_agent);
    assert.equal(result.state, "completed");
    assert.notEqual(result.state, "needs_human");
    assert.equal(result.citations.includes("ev-captured-checkout-metric"), true);
    assert.equal(result.tool_summaries.some((item) => item.result_count > 0), true);
  }

  assert.equal(contexts.length, 4);
  assert.equal(contexts[0].context.source_truth.source_status, "captured");
  assert.equal(contexts[0].context.role_context.signal_summaries.length > 0, true);
  assert.equal(contexts[1].context.role_context.workflow.stage, "Monitor");
  assert.equal(contexts[2].context.role_context.selected_component.component.id, "checkout");
  assert.equal(contexts[3].context.role_context.cited_evidence.length > 0, true);
});

test("recorded and Responses adapters are bounded, provider failures are redacted, and telemetry failures are isolated", async () => {
  const requests = [];
  const adapter = createOpenAIChatAdapter({
    requestResponse: async (input) => {
      requests.push(input);
      return { data: { output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ answer: "A bounded provider answer.", recommended_handoff: null }) }] }], usage: { input_tokens: 12, output_tokens: 5 } } };
    }
  });
  const answer = await adapter.respond({ role: "orchestrator", context: { message: "safe", tool_allowlist: [] } });
  assert.equal(answer.answer, "A bounded provider answer.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model.length > 0, true);
  assert.equal(requests[0].body.text.format.type, "json_schema");

  const { runtime, runId, service } = setup({ modelAdapter: {
    provider: "openai-responses",
    model: "deployment-model",
    capability() { return { provider_kind: "openai-responses", availability: "available", truth_label: "OPENAI API", model_label: "deployment-model", failure_reason: null }; },
    async respond() { throw new Error("provider secret=never-expose"); }
  } });
  const result = await service.submit(request(runtime, runId, { idempotency_key: "chat-key-provider-failure" }), {
    trace: { agent() { throw new Error("telemetry down"); }, tool() { throw new Error("telemetry down"); }, generation() { throw new Error("telemetry down"); } }
  });

  assert.equal(result.state, "failed");
  assert.equal(result.answer.includes("never-expose"), false);
  assert.deepEqual(result.provider, {
    provider_kind: "openai-responses",
    availability: "unavailable",
    truth_label: "OPENAI API",
    model_label: "deployment-model",
    failure_reason: "provider_response_failed"
  });
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "agent_team.error.recorded"), true);
});

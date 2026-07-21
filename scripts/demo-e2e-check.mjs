#!/usr/bin/env node

// Runs against one already-started FlowPulse server. It intentionally uses the
// configured provider and refuses a recorded/demo provider so CI or a judge can
// distinguish a real local-Codex smoke from deterministic unit coverage.
const baseUrl = new URL(process.env.FLOWPULSE_E2E_BASE_URL || `http://127.0.0.1:${process.env.FLOWPULSE_E2E_PORT || "4310"}`);
const timeoutMs = integerEnv("FLOWPULSE_E2E_TIMEOUT_MS", 150_000, 10_000, 300_000);
const startedAt = Date.now();

try {
  const ui = await getText("/");
  assert(ui.response.ok && /<html/i.test(ui.text), "UI was not served by the same FlowPulse server");

  const health = await getJson("/api/health");
  assert(health.response.ok, "health endpoint is unavailable");
  const state = await getJson("/api/state");
  assert(state.response.ok && safeId(state.body.run_id) && safeId(state.body.incident_projection?.incident?.id), "canonical run/incident projection is unavailable");
  const runId = state.body.run_id;
  const incidentId = state.body.incident_projection.incident.id;

  const provider = await getJson("/api/agent-control/provider");
  assert(provider.response.ok, "provider endpoint is unavailable");
  assert(provider.body.provider_kind === "codex-local" && provider.body.availability === "available" && provider.body.truth_label === "LOCAL CODEX", "codex-local is not available; recorded fallback is not accepted");

  const component = await getJson(`/api/components/checkout?${query({ run_id: runId, window: "15m", signal: "all", limit: "8" })}`);
  assert(component.response.ok, "checkout node projection is unavailable");
  const node = component.body.node_investigation;
  assert(node?.source_truth?.truth_label === "captured_replay", "checkout source truth must remain captured replay");
  assert(node?.observability?.metrics?.length > 0, "checkout metrics are missing");
  assert(node?.observability?.logs?.length > 0, "checkout safe log summaries are missing");
  assert(node?.observability?.traces?.length > 0, "checkout traces are missing");
  assert(node?.configuration?.changes?.length > 0, "checkout changes are missing");
  assert((node?.relationships?.upstream?.length || 0) + (node?.relationships?.downstream?.length || 0) > 0, "checkout dependency evidence is missing");

  const nodeSse = await readSse(`/api/components/checkout/events?${query({ run_id: runId, window: "15m", limit: "8", after: "0" })}`);
  const nodeEvents = nodeSse.events;
  assert(nodeEvents.some((item) => item.event === "node-evidence-snapshot"), "node SSE snapshot is missing");
  assert(nodeEvents.some((item) => item.event === "node-evidence-metric"), "node SSE metric evidence is missing");
  assert(nodeEvents.some((item) => item.event === "node-evidence-log"), "node SSE log evidence is missing");
  assert(nodeEvents.some((item) => item.event === "node-evidence-trace"), "node SSE trace evidence is missing");
  assert(nodeEvents.some((item) => item.event === "node-evidence-change"), "node SSE change evidence is missing");
  assert(nodeEvents.some((item) => item.event === "node-evidence-state" && item.payload?.terminal === true), "captured node SSE terminal state is missing");

  const investigator = await postJson("/api/agent-control/chat", {
    run_id: runId,
    incident_id: incidentId,
    conversation_id: `integration-checkout-${Date.now()}`,
    idempotency_key: `integration-checkout-${Date.now()}-1`,
    requested_agent: "investigator",
    page_mode: "live",
    selected_component: "checkout",
    message: "Why is Checkout red? Use only bounded cited evidence. Identify the initiating checkout/payment configuration cause and explicitly distinguish Kafka as a downstream symptom rather than the initiating cause."
  });
  assert(investigator.response.ok, "Investigator request failed");
  assert(investigator.body.state === "completed" && investigator.body.responding_agent === "investigator", "Investigator did not complete as Investigator");
  assert(typeof investigator.body.answer === "string" && investigator.body.answer.length > 0, "Investigator safe answer is empty");
  assert(Array.isArray(investigator.body.citations) && investigator.body.citations.length > 0, "Investigator citations are empty");
  assert(Array.isArray(investigator.body.tool_summaries) && investigator.body.tool_summaries.some((tool) => Number.isInteger(tool.result_count) && tool.result_count > 0), "Investigator tool summaries are empty");
  assert(/kafka/i.test(investigator.body.answer) && /(downstream|symptom)/i.test(investigator.body.answer), "Investigator did not distinguish Kafka as downstream");

  const positive = await startLoop("checkout-payment-config", 1, `integration-checkout-loop-${Date.now()}`);
  const positiveEvents = positive.stream.events.filter((item) => item.event === "local-fault-loop").map((item) => item.payload?.event).filter(Boolean);
  const positiveTerminal = positive.stream.events.find((item) => item.event === "local-fault-loop-state")?.payload;
  assert(positive.elapsed_ms < 1_000, `loop POST was not asynchronous (${positive.elapsed_ms}ms)`);
  assert(positiveTerminal?.state === "recovered", "checkout loop did not recover");
  assertStrictSequence(positiveEvents);
  const roleEvents = positiveEvents.filter((event) => event.type === "local_fault_loop.role.response");
  assert(JSON.stringify(roleEvents.map((event) => event.payload?.role)) === JSON.stringify(["observer", "orchestrator", "investigator", "evaluator"]), "loop role order is not transparent");
  assert(roleEvents.every((event) => event.payload?.provider?.provider_kind === "codex-local" && event.payload?.provider?.truth_label === "LOCAL CODEX" && typeof event.payload?.safe_answer === "string" && event.payload.safe_answer.length > 0 && event.payload.citations?.length > 0 && event.payload.tools?.some((tool) => tool.result_count > 0)), "loop role evidence/provider projection is incomplete");
  assert(positiveEvents.some((event) => event.type === "local_fault_loop.repair.executed"), "checkout loop repair event is missing");
  assert(positiveEvents.some((event) => event.type === "local_fault_loop.verification.completed" && event.payload?.passed === true), "checkout loop verification event is missing");
  assert(JSON.stringify(positiveEvents.filter((event) => event.type === "local_fault_loop.handoff.recorded" && event.payload?.ownership === "runtime_deterministic").slice(0, 3).map((event) => [event.payload.from, event.payload.to])) === JSON.stringify([["observer", "orchestrator"], ["orchestrator", "investigator"], ["investigator", "evaluator"]]), "loop deterministic handoffs are missing");

  const negative = await startLoop("insufficient-evidence", 1, `integration-negative-loop-${Date.now()}`);
  const negativeEvents = negative.stream.events.filter((item) => item.event === "local-fault-loop").map((item) => item.payload?.event).filter(Boolean);
  const negativeTerminal = negative.stream.events.find((item) => item.event === "local-fault-loop-state")?.payload;
  assert(negativeTerminal?.state === "needs_human", "insufficient-evidence loop did not stop at the human gate");
  assert(!negativeEvents.some((event) => event.type === "local_fault_loop.repair.executed"), "insufficient-evidence loop executed a repair");

  console.log(JSON.stringify({
    status: "pass",
    base_url: baseUrl.origin,
    duration_ms: Date.now() - startedAt,
    source: node.source_truth,
    provider: provider.body,
    investigator: {
      conversation_id: investigator.body.conversation_id,
      responding_agent: investigator.body.responding_agent,
      citations: investigator.body.citations,
      tools: investigator.body.tool_summaries.map(({ tool, result_count }) => ({ tool, result_count })),
      safe_answer: investigator.body.answer
    },
    checkout_loop: summarizeLoop(positive.start, positiveTerminal, roleEvents, positiveEvents),
    insufficient_evidence_loop: summarizeLoop(negative.start, negativeTerminal, [], negativeEvents)
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "fail", base_url: baseUrl.origin, duration_ms: Date.now() - startedAt, reason: safeError(error) }, null, 2));
  process.exitCode = 1;
}

async function startLoop(caseId, round, idempotencyKey) {
  const at = Date.now();
  const started = await postJson("/api/demo/agent-loop/run", { case_id: caseId, round, idempotency_key: idempotencyKey });
  const elapsed_ms = Date.now() - at;
  assert(started.response.status === 202 && safeId(started.body?.run_id) && safeId(started.body?.incident_id) && typeof started.body?.events_url === "string", `could not start ${caseId} loop`);
  return { start: started.body, elapsed_ms, stream: await readSse(started.body.events_url) };
}

async function getJson(pathname) {
  const response = await request(pathname);
  return { response, body: await response.json().catch(() => null) };
}

async function getText(pathname) {
  const response = await request(pathname);
  return { response, text: await response.text() };
}

async function postJson(pathname, body) {
  const response = await request(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json().catch(() => null) };
}

async function readSse(pathname) {
  const response = await request(pathname, { headers: { accept: "text/event-stream" } });
  assert(response.ok, `SSE request failed: ${pathname}`);
  return parseSse(await response.text());
}

function request(pathname, options = {}) {
  return fetch(new URL(pathname, baseUrl), { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function parseSse(text) {
  const events = text.split("\n\n").map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!event || !data) return null;
    try { return { event, payload: JSON.parse(data) }; } catch { return null; }
  }).filter(Boolean);
  return { events };
}

function assertStrictSequence(events) {
  const sequences = events.map((event) => event.sequence);
  assert(sequences.length > 0 && sequences.every(Number.isSafeInteger) && new Set(sequences).size === sequences.length && sequences.every((value, index) => index === 0 || value > sequences[index - 1]), "loop event sequence is not strictly ordered");
}

function summarizeLoop(start, terminal, roleEvents, events) {
  return {
    run_id: start.run_id,
    incident_id: start.incident_id,
    state: terminal?.state || null,
    stage: terminal?.stage || null,
    event_count: events.length,
    role_order: roleEvents.map((event) => event.payload.role),
    repair: events.some((event) => event.type === "local_fault_loop.repair.executed"),
    verified: events.some((event) => event.type === "local_fault_loop.verification.completed" && event.payload?.passed === true)
  };
}

function query(value) { return new URLSearchParams(value).toString(); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
function safeError(error) { return String(error?.message || error).replace(/[\r\n\t]/g, " ").slice(0, 240); }
function integerEnv(name, fallback, min, max) { const value = Number(process.env[name] || fallback); return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback; }

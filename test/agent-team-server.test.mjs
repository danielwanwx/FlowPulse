import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import { LocalFaultLoop } from "../src/local-fault-loop.mjs";

test("Agent Team HTTP and SSE projections preserve a chat's transparent routing without read-side invocation", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "flowpulse-agent-team-server-"));
  const seededLoop = await new LocalFaultLoop({ ledger: new Ledger(join(root, "ledger.db")), modelAdapter: fakeLocalCodexAdapter() }).run({ caseId: "checkout-payment-config", round: 1 });
  const port = await freshPort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      FLOWPULSE_DB: join(root, "ledger.db"),
      FLOWPULSE_AGENT_PROVIDER: "recorded",
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stop(child));
  await waitForHealth(child, port);

  const initial = await getJson(port, "/api/state");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.agent_control.agent_team_provider.truth_label, "RECORDED/DEMO");
  assert.equal(initial.body.source.status, "captured");
  assert.equal(initial.body.topology_views.architecture.runtime_data.graph.total_nodes, 22);
  const component = await getJson(port, `/api/components/checkout?run_id=${initial.body.run_id}&window=15m&signal=all&limit=4`);
  assert.equal(component.status, 200);
  assert.equal(component.body.schema_version, "flowpulse.component-detail.v1");
  assert.equal(component.body.node_investigation.schema_version, "flowpulse.node-investigation.v1");
  assert.equal(component.body.node_investigation.source_truth.truth_label, "captured_replay");
  assert.equal(component.body.node_investigation.raw_payload_excluded, true);
  assert.equal(component.body.node_investigation.evidence.items.length > 0, true);
  const componentStream = await readSseEvent(port, `/api/components/checkout/events?run_id=${initial.body.run_id}&window=15m&limit=4&after=0`);
  assert.equal(componentStream.event, "node-evidence-snapshot");
  assert.equal(componentStream.payload.snapshot.detail_revision, component.body.detail_revision);
  const componentResume = await readSseEvent(port, `/api/components/checkout/events?run_id=${initial.body.run_id}&window=15m&limit=4&after=1`);
  assert.notEqual(componentResume.event, "node-evidence-snapshot");
  const invalidComponentQuery = await getJson(port, `/api/components/checkout?run_id=${initial.body.run_id}&limit=13`);
  assert.deepEqual(invalidComponentQuery, { status: 400, body: { error: "node_evidence_limit_invalid" } });
  const provider = await getJson(port, "/api/agent-control/provider");
  assert.deepEqual(provider.body, initial.body.agent_control.agent_team_provider);
  const loopUnavailable = await postJson(port, "/api/demo/agent-loop/run", { case_id: "checkout-payment-config", round: 1 });
  assert.equal(loopUnavailable.status, 202);
  assert.equal(loopUnavailable.body.state, "running");
  const loopProjection = await getJson(port, `/api/demo/agent-loop?run_id=${seededLoop.run_id}`);
  assert.equal(loopProjection.status, 200);
  assert.equal(loopProjection.body.state, "recovered");
  assert.equal(loopProjection.body.events.some((event) => event.type === "local_fault_loop.role.response" && Object.hasOwn(event.payload, "answer_sha256") && !Object.hasOwn(event.payload, "answer")), true);
  const loopStream = await readSseEvent(port, `/api/demo/agent-loop/events?run_id=${seededLoop.run_id}&after=0`);
  assert.equal(loopStream.event, "local-fault-loop");
  assert.equal(loopStream.payload.event.type, "local_fault_loop.reserved");
  const loopChat = await postJson(port, "/api/agent-control/chat", {
    run_id: seededLoop.run_id,
    incident_id: seededLoop.incident_id,
    projection_revision: seededLoop.topology.projection_revision,
    conversation_id: "conv-loop-sidebar-001",
    idempotency_key: "loop-sidebar-message-001",
    requested_agent: "investigator",
    page_mode: "live",
    selected_component: "checkout",
    message: "Why is checkout red? Cite the bounded component evidence."
  });
  assert.equal(loopChat.status, 200, JSON.stringify(loopChat.body));
  assert.equal(loopChat.body.state, "completed");
  assert.equal(loopChat.body.responding_agent, "investigator");
  assert.equal(loopChat.body.citations.length > 0, true);
  assert.equal(loopChat.body.tool_summaries.some((item) => item.result_count > 0), true);
  const loopConversation = await getJson(port, `/api/agent-control/conversation?run_id=${seededLoop.run_id}&conversation_id=conv-loop-sidebar-001`);
  assert.equal(loopConversation.status, 200);
  assert.equal(loopConversation.body.messages.at(-1).responding_agent, "investigator");

  const chat = await postJson(port, "/api/agent-control/chat", {
    run_id: initial.body.run_id,
    incident_id: initial.body.incident.id,
    projection_revision: initial.body.topology_views.projection_revision,
    conversation_id: "conv-sidebar-001",
    idempotency_key: "sidebar-message-001",
    requested_agent: "observer",
    page_mode: "live",
    selected_component: "checkout",
    message: "Why is checkout failing? Investigate the causal evidence."
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.equal(chat.body.state, "completed");
  assert.equal(chat.body.responding_agent, "investigator");
  assert.deepEqual(chat.body.handoff, {
    from: "observer",
    to: "investigator",
    reason: "Causal investigation belongs to Investigator."
  });
  assert.equal(chat.body.provider.truth_label, "RECORDED/DEMO");
  assert.equal(chat.body.citations.length > 0, true);
  assert.equal(chat.body.tool_summaries.some((item) => item.result_count > 0), true);
  assert.deepEqual(chat.body.conversation.messages.map((message) => message.kind), ["user", "handoff", "context", "tool_request", "tool_result", "tool_summary", "working", "assistant"]);
  assert.equal(chat.body.conversation.messages.find((message) => message.kind === "tool_result").result_count > 0, true);
  assert.equal(chat.body.conversation.messages[0].selected_component, "checkout");
  assert.deepEqual(chat.body.conversation.messages.find((message) => message.kind === "context").source_truth, {
    source_health: initial.body.topology_views.truth.source_health,
    evidence_mode: initial.body.topology_views.truth.evidence_mode,
    execution_mode: initial.body.topology_views.truth.execution_mode
  });

  // A conversation is always bound to the run that produced it.  Once the
  // local loop above becomes the ambient workspace, an unscoped read must not
  // silently project this recorded conversation onto that unrelated run.
  const unscopedConversation = await getJson(port, "/api/agent-control/conversation?conversation_id=conv-sidebar-001");
  assert.deepEqual(unscopedConversation, { status: 400, body: { error: "conversation_run_id_required" } });
  const unscopedStream = await getJson(port, "/api/agent-control/events?conversation_id=conv-sidebar-001");
  assert.deepEqual(unscopedStream, { status: 400, body: { error: "conversation_run_id_required" } });

  const conversation = await getJson(port, `/api/agent-control/conversation?run_id=${initial.body.run_id}&conversation_id=conv-sidebar-001`);
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.messages.at(-1).responding_agent, "investigator");
  const streamed = await readSse(port, `/api/agent-control/events?run_id=${initial.body.run_id}&conversation_id=conv-sidebar-001&after=0`);
  assert.equal(streamed.agent_control.agent_team_provider.truth_label, "RECORDED/DEMO");
  assert.equal(streamed.conversation.messages.at(-1).kind, "assistant");
  const rejected = await postJson(port, "/api/agent-control/chat", {
    run_id: initial.body.run_id,
    incident_id: initial.body.incident.id,
    projection_revision: initial.body.topology_views.projection_revision,
    conversation_id: "conv-sidebar-001",
    idempotency_key: "sidebar-message-invalid",
    requested_agent: "observer",
    page_mode: "live",
    selected_component: "checkout",
    message: "safe",
    approval: "forged"
  });
  assert.deepEqual(rejected, { status: 400, body: { error: "forbidden_request_field" } });

  const staleProjection = await postJson(port, "/api/agent-control/chat", {
    run_id: initial.body.run_id,
    incident_id: initial.body.incident.id,
    projection_revision: "0".repeat(64),
    conversation_id: "conv-sidebar-stale-revision-001",
    idempotency_key: "sidebar-stale-revision-001",
    requested_agent: "observer",
    page_mode: "live",
    selected_component: "checkout",
    message: "What is the current bounded source freshness?"
  });
  assert.deepEqual(staleProjection, { status: 409, body: { error: "projection_revision_mismatch" } });
});

async function freshPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function waitForHealth(child, port) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 2400; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* wait for listen */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function readSse(port, pathname) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(value);
  const match = text.match(/\ndata: (.+)\n\n/);
  assert.ok(match, text);
  return JSON.parse(match[1]);
}

async function readSseEvent(port, pathname) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(value);
  const match = text.match(/event: ([^\n]+)\ndata: (.+)\n\n/);
  assert.ok(match, text);
  return { event: match[1], payload: JSON.parse(match[2]) };
}

function fakeLocalCodexAdapter() {
  return {
    async preflight() { return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null }; },
    async respond({ role }) { return { answer: `${role} test response.`, recommended_handoff: null }; }
  };
}

function stop(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
}

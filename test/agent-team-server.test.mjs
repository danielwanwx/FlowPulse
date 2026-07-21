import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Agent Team HTTP and SSE projections preserve a chat's transparent routing without read-side invocation", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "flowpulse-agent-team-server-"));
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
  const provider = await getJson(port, "/api/agent-control/provider");
  assert.deepEqual(provider.body, initial.body.agent_control.agent_team_provider);

  const chat = await postJson(port, "/api/agent-control/chat", {
    run_id: initial.body.run_id,
    incident_id: initial.body.incident.id,
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
  assert.deepEqual(chat.body.conversation.messages.map((message) => message.kind), ["user", "handoff", "context", "tool_summary", "working", "assistant"]);
  assert.equal(chat.body.conversation.messages[0].selected_component, "checkout");

  const conversation = await getJson(port, "/api/agent-control/conversation?conversation_id=conv-sidebar-001");
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.messages.at(-1).responding_agent, "investigator");
  const streamed = await readSse(port, "/api/agent-control/events?conversation_id=conv-sidebar-001&after=0");
  assert.equal(streamed.agent_control.agent_team_provider.truth_label, "RECORDED/DEMO");
  assert.equal(streamed.conversation.messages.at(-1).kind, "assistant");
  const rejected = await postJson(port, "/api/agent-control/chat", {
    run_id: initial.body.run_id,
    incident_id: initial.body.incident.id,
    conversation_id: "conv-sidebar-001",
    idempotency_key: "sidebar-message-invalid",
    requested_agent: "observer",
    page_mode: "live",
    selected_component: "checkout",
    message: "safe",
    approval: "forged"
  });
  assert.deepEqual(rejected, { status: 400, body: { error: "forbidden_request_field" } });
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
  for (let attempt = 0; attempt < 400; attempt++) {
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

function stop(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("interactive loop starts asynchronously, streams safe events, resumes, and suppresses duplicate repair work", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "flowpulse-interactive-loop-"));
  const port = await freshPort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      FLOWPULSE_DB: join(root, "ledger.db"),
      FLOWPULSE_AGENT_PROVIDER: "codex-local",
      NODE_ENV: "test",
      FLOWPULSE_TEST_CODEX_RESPONSE: "{\"answer\":\"Bounded local role response cites ev-local-safe-1.\",\"recommended_handoff\":null}",
      FLOWPULSE_TEST_CODEX_DELAY_MS: "300",
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stop(child));
  await waitForHealth(child, port);

  const startedAt = Date.now();
  const [first, duplicate] = await Promise.all([
    postJson(port, "/api/demo/agent-loop/run", { case_id: "checkout-payment-config", round: 1, idempotency_key: "interactive-checkout-001" }),
    postJson(port, "/api/demo/agent-loop/run", { case_id: "checkout-payment-config", round: 1, idempotency_key: "interactive-checkout-001" })
  ]);
  const startElapsed = Date.now() - startedAt;
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
  assert.equal(first.body.run_id, duplicate.body.run_id);
  assert.equal(first.body.incident_id, duplicate.body.incident_id);
  assert.equal(first.body.state, "running");
  assert.equal(first.body.stage, "monitor");
  assert.equal(first.body.contextual_workspaces.actions.view_diagnosis.available, false);
  assert.equal(startElapsed < 500, true, `start took ${startElapsed}ms`);

  const inProgress = await getJson(port, `/api/demo/agent-loop?run_id=${encodeURIComponent(first.body.run_id)}`);
  assert.equal(inProgress.status, 200);
  assert.equal(inProgress.body.state, "running");

  const [firstStream, secondStream] = await Promise.all([
    readIncrementalSse(port, first.body.events_url),
    readAllSse(port, first.body.events_url)
  ]);
  assert.equal(firstStream.first_chunk_terminal, false);
  assert.equal(firstStream.raw.includes(": heartbeat"), true);
  const events = firstStream.events.filter((item) => item.event === "local-fault-loop");
  const sequences = events.map((item) => item.payload.event.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(events.some((item) => item.payload.event.type === "local_fault_loop.fault.injected"), true);
  assert.equal(events.find((item) => item.payload.event.type === "incident.opened").payload.contextual_workspaces.actions.view_diagnosis.available, true);
  assert.equal(events.find((item) => item.payload.event.type === "local_fault_loop.plan.proposed").payload.contextual_workspaces.actions.open_recovery_console.available, true);
  assert.equal(firstStream.states.length, 1);
  assert.equal(firstStream.states[0].payload.state, "recovered");
  assert.equal(firstStream.states[0].payload.contextual_workspaces.actions.compare_recovery.available, true);
  assert.equal(firstStream.states[0].payload.contextual_workspaces.context.run_id, first.body.run_id);
  assert.equal(firstStream.states[0].payload.contextual_workspaces.context.incident_id, first.body.incident_id);
  assert.equal(secondStream.states.length, 1);
  assert.deepEqual(secondStream.events.filter((item) => item.event === "local-fault-loop").map((item) => item.payload.event.sequence), sequences);

  const roles = events.filter((item) => item.payload.event.type === "local_fault_loop.role.response").map((item) => item.payload.event.payload);
  assert.equal(roles.length, 4);
  assert.deepEqual(roles.map((item) => item.role), ["observer", "orchestrator", "investigator", "evaluator"]);
  assert.equal(roles.every((item) => item.requested_agent === item.role && item.responding_agent === item.role && item.state === "completed" && typeof item.safe_answer === "string" && item.safe_answer.length > 0 && item.safe_answer.length <= 280 && item.citations.length > 0 && item.tools.every((tool) => Number.isInteger(tool.result_count)) && !Object.hasOwn(item, "answer")), true);
  assert.deepEqual(events.filter((item) => item.payload.event.type === "local_fault_loop.handoff.recorded" && item.payload.event.payload.ownership === "runtime_deterministic").slice(0, 3).map((item) => [item.payload.event.payload.from, item.payload.event.payload.to]), [
    ["observer", "orchestrator"], ["orchestrator", "investigator"], ["investigator", "evaluator"]
  ]);

  const resumeAfter = sequences[5];
  const resumed = await readAllSse(port, `/api/demo/agent-loop/events?run_id=${first.body.run_id}&after=${resumeAfter}`, { "Last-Event-ID": String(resumeAfter) });
  const resumedSequences = resumed.events.filter((item) => item.event === "local-fault-loop").map((item) => item.payload.event.sequence);
  assert.equal(resumedSequences.every((sequence) => sequence > resumeAfter), true);
  assert.equal(new Set(resumedSequences).size, resumedSequences.length);
  assert.deepEqual(resumedSequences, sequences.filter((sequence) => sequence > resumeAfter));
  assert.equal(resumed.states.length, 1);

  const negative = await postJson(port, "/api/demo/agent-loop/run", { case_id: "insufficient-evidence", round: 1, idempotency_key: "interactive-negative-001" });
  assert.equal(negative.status, 202, JSON.stringify(negative.body));
  const negativeStream = await readAllSse(port, negative.body.events_url);
  assert.equal(negativeStream.states.length, 1);
  assert.equal(negativeStream.states[0].payload.state, "needs_human");
  assert.equal(negativeStream.states[0].payload.contextual_workspaces.actions.open_recovery_console.available, false);
  assert.equal(negativeStream.states[0].payload.contextual_workspaces.actions.compare_recovery.available, false);
  assert.equal(negativeStream.events.some((item) => item.payload?.event?.type === "local_fault_loop.repair.executed"), false);

  assert.equal(roles.length + negativeStream.events.filter((item) => item.payload?.event?.type === "local_fault_loop.role.response").length, 8, "duplicate start must not create a second four-role execution");
});

test("a restarted server terminalizes an expired reservation without replaying model or repair side effects", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "flowpulse-interactive-restart-"));
  const db = join(root, "ledger.db");
  const firstPort = await freshPort();
  const sharedEnv = {
    ...process.env,
    FLOWPULSE_DB: db,
    FLOWPULSE_AGENT_PROVIDER: "codex-local",
    FLOWPULSE_AGENT_LOOP_LEASE_MS: "1000",
    NODE_ENV: "test",
    FLOWPULSE_TEST_CODEX_RESPONSE: "{\"answer\":\"Bounded local role response cites ev-local-safe-1.\",\"recommended_handoff\":null}",
    OPENAI_API_KEY: ""
  };
  const firstChild = spawn(process.execPath, ["src/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...sharedEnv, PORT: String(firstPort), FLOWPULSE_TEST_CODEX_DELAY_MS: "10000" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => stop(firstChild));
  await waitForHealth(firstChild, firstPort);
  const first = await postJson(firstPort, "/api/demo/agent-loop/run", { case_id: "checkout-payment-config", round: 1, idempotency_key: "interactive-restart-001" });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await stopAndWait(firstChild);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const secondPort = await freshPort();
  const secondChild = spawn(process.execPath, ["src/server.mjs"], { cwd: new URL("..", import.meta.url), env: { ...sharedEnv, PORT: String(secondPort) }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => stop(secondChild));
  await waitForHealth(secondChild, secondPort);
  const duplicate = await postJson(secondPort, "/api/demo/agent-loop/run", { case_id: "checkout-payment-config", round: 1, idempotency_key: "interactive-restart-001" });
  assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.run_id, first.body.run_id);
  assert.equal(duplicate.body.state, "failed");
  const stream = await readAllSse(secondPort, duplicate.body.events_url);
  assert.equal(stream.states.length, 1);
  assert.equal(stream.states[0].payload.state, "failed");
  const events = stream.events.filter((item) => item.event === "local-fault-loop").map((item) => item.payload.event);
  assert.equal(events.some((event) => event.type === "local_fault_loop.interrupted" && event.payload.model_calls_resumed === false && event.payload.repairs_resumed === false), true);
  assert.equal(events.some((event) => event.type === "local_fault_loop.repair.executed"), false);
  assert.equal(events.filter((event) => event.type === "local_fault_loop.role.response").length, 0);
  assert.equal(stream.states[0].payload.contextual_workspaces.actions.compare_recovery.available, false);
});

async function freshPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function waitForHealth(child, port) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function readIncrementalSse(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const reader = response.body.getReader();
  const first = await reader.read();
  const initial = new TextDecoder().decode(first.value || new Uint8Array());
  const rest = await readRemaining(reader);
  const parsed = parseSse(`${initial}${rest}`);
  return { ...parsed, raw: `${initial}${rest}`, first_chunk_terminal: initial.includes("event: local-fault-loop-state") };
}

async function readAllSse(port, pathname, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return parseSse(await response.text());
}

async function readRemaining(reader) {
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text;
    text += new TextDecoder().decode(next.value);
  }
}

function parseSse(text) {
  const blocks = text.split("\n\n").filter(Boolean);
  const items = blocks.map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] || null;
    const data = /^data: (.+)$/m.exec(block)?.[1] || null;
    return event && data ? { event, payload: JSON.parse(data) } : null;
  }).filter(Boolean);
  return { events: items, states: items.filter((item) => item.event === "local-fault-loop-state") };
}

function stop(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
}

async function stopAndWait(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("close", resolve);
    child.kill("SIGTERM");
  });
}

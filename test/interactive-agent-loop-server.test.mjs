import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { architectureViewTopology, liveViewTopology } from "../public/twin-state.mjs";

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
      FLOWPULSE_TEST_CODEX_RESPONSE: "{\"answer\":\"Bounded local role response cites ev-local-safe-1.\",\"recommended_handoff\":null,\"tool_requests\":[]}",
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

  const canonicalState = await getJson(port, "/api/state");
  assert.equal(canonicalState.status, 200);
  // Starting a local loop without a deep link must bind the whole browser
  // contract to that loop. A refresh cannot leave Live on one run while the
  // workspace/Agent Chat point at another globally-active run.
  assertCanonicalLoopBrowserState(canonicalState.body, first.body);
  const canonicalSource = await getJson(port, "/api/source");
  assert.equal(canonicalSource.status, 200);
  assert.equal(canonicalSource.body.mode, "deterministic_replay");
  assert.equal(canonicalSource.body.status, "captured");
  assert.equal((await getJson(port, "/api/source?run_id=missing-run")).status, 404, "an unknown source deep link must fail closed");
  const canonicalAgentControl = await getJson(port, "/api/agent-control");
  assert.equal(canonicalAgentControl.status, 200);
  assert.equal(canonicalAgentControl.body.run_id, first.body.run_id);
  assert.equal(canonicalAgentControl.body.incident_id, first.body.incident_id);
  assert.equal((await getJson(port, "/api/agent-control?run_id=missing-run")).status, 404, "an unknown Agent Chat deep link must fail closed");
  const agentSse = await readFirstAgentSse(port, `/api/agent-control/events?run_id=${encodeURIComponent(first.body.run_id)}`);
  assert.equal(agentSse.status, 200, agentSse.raw);
  assert.equal(agentSse.payload?.run_id, first.body.run_id, "Agent Chat SSE must retain the selected local loop run");
  assert.equal(agentSse.payload?.incident_id, first.body.incident_id, "Agent Chat SSE must retain the selected local loop incident");
  assert.equal(agentSse.payload?.last_sequence, canonicalAgentControl.body.last_sequence, "Agent Chat SSE must project the same selected-run event cursor as the page");
  const invalidAgentSse = await getJson(port, "/api/agent-control/events?run_id=not%20a%20run");
  assert.equal(invalidAgentSse.status, 400, "an invalid Agent Chat deep link must fail closed");
  const workspace = canonicalState.body.workspace_projection;
  assert.ok(workspace, `page state must expose the active canonical workspace without sessionStorage: ${JSON.stringify(Object.keys(canonicalState.body))}`);
  assert.equal(workspace.run_id, first.body.run_id);
  assert.equal(workspace.incident_id, first.body.incident_id);
  assert.equal(workspace.topology.current.state, "recovered");
  assert.notEqual(workspace.topology.current.metric_sample?.phase, "baseline", "Diagnose must not fall back to healthy/baseline after an incident");
  assert.equal(workspace.topology.verification.passed, true);
  assert.equal(workspace.events.some((event) => event.type === "local_fault_loop.plan.proposed"), true);
  assert.equal(workspace.events.some((event) => event.type === "local_fault_loop.repair.executed"), true);
  assert.equal(workspace.topology.compare.state, "verified");
  assert.ok(workspace.topology.snapshots.verified, "verified Compare requires a server-owned verified snapshot");
  for (const view of [workspace.topology.live, workspace.topology.diagnose, workspace.topology.recovery, workspace.topology.compare]) {
    assert.equal(view.run_id, workspace.topology.run_id);
    assert.equal(view.incident_id, workspace.topology.incident_id);
    assert.equal(view.projection_revision, workspace.topology.projection_revision);
  }
  const planEvent = events.find((item) => item.payload.event.type === "local_fault_loop.plan.proposed").payload.event;
  const authorityEvent = events.find((item) => item.payload.event.type === "local_fault_loop.authority.decided").payload.event;
  const repairEvent = events.find((item) => item.payload.event.type === "local_fault_loop.repair.executed").payload.event;
  const verificationEvent = events.find((item) => item.payload.event.type === "local_fault_loop.verification.completed").payload.event;
  assert.deepEqual([authorityEvent.actor, repairEvent.actor, verificationEvent.actor], ["runtime", "remediation", "verifier"]);
  assert.equal(planEvent.sequence < authorityEvent.sequence && authorityEvent.sequence < repairEvent.sequence && repairEvent.sequence < verificationEvent.sequence, true);
  assert.equal(authorityEvent.payload.execution_scope, "local_memory_only");
  assert.equal(repairEvent.payload.execution_scope, "local_memory_only");
  assert.deepEqual(verificationEvent.payload.checks.map(({ id, passed }) => [id, passed]), [
    ["root_condition_removed", true],
    ["direct_symptom_cleared", true],
    ["downstream_lag_converged", true]
  ]);
  const workflowChat = await postJson(port, "/api/agent-control/chat", {
    run_id: first.body.run_id,
    incident_id: first.body.incident_id,
    projection_revision: workspace.topology.projection_revision,
    conversation_id: "conv-workflow-separation-001",
    idempotency_key: "workflow-separation-message-001",
    requested_agent: "orchestrator",
    page_mode: "recovery",
    selected_component: "checkout",
    message: "What evidence proves this recovery was authorized and independently verified?"
  });
  assert.equal(workflowChat.status, 200, JSON.stringify(workflowChat.body));
  assert.equal(workflowChat.body.citations.includes(authorityEvent.id), true);
  assert.equal(workflowChat.body.citations.includes(verificationEvent.id), true);
  assert.equal(workflowChat.body.tool_summaries.some((item) => item.tool === "read_workflow_projection" && item.result_count === 1), true);
  const reset = await postJson(port, "/api/demo/reset", {});
  assert.equal(reset.status, 201);
  assert.equal(reset.body.workspace_projection, null, "a clean reset must clear the prior canonical workspace run");

  const roles = events.filter((item) => item.payload.event.type === "local_fault_loop.role.response").map((item) => item.payload.event.payload);
  assert.equal(roles.length, 4);
  assert.deepEqual(roles.map((item) => item.role), ["observer", "orchestrator", "investigator", "evaluator"]);
  assert.equal(roles.every((item) => item.requested_agent === item.role && item.responding_agent === item.role && item.state === "completed" && typeof item.safe_answer === "string" && item.safe_answer.length > 0 && item.safe_answer.length <= 280 && item.citations.length > 0 && item.tools.every((tool) => Number.isInteger(tool.result_count)) && !Object.hasOwn(item, "answer")), true);
  assert.deepEqual(events.filter((item) => item.payload.event.type === "local_fault_loop.handoff.recorded" && item.payload.event.payload.ownership === "runtime_deterministic").slice(0, 3).map((item) => [item.payload.event.payload.from, item.payload.event.payload.to]), [
    ["observer", "orchestrator"], ["orchestrator", "investigator"], ["investigator", "evaluator"]
  ]);

  const resumeAfter = sequences[5];
  const resumed = await readAllSse(port, `/api/demo/agent-loop/events?run_id=${first.body.run_id}&after=${resumeAfter}`, { "Last-Event-ID": String(resumeAfter) });
  const resumedSequences = resumed.events
    .filter((item) => item.event === "local-fault-loop" && item.payload.event.type.startsWith("local_fault_loop."))
    .map((item) => item.payload.event.sequence);
  assert.equal(resumedSequences.every((sequence) => sequence > resumeAfter), true);
  assert.equal(new Set(resumedSequences).size, resumedSequences.length);
  const expectedResumedSequences = events
    .filter((item) => item.payload.event.type.startsWith("local_fault_loop.") && item.payload.event.sequence > resumeAfter)
    .map((item) => item.payload.event.sequence);
  assert.deepEqual(resumedSequences, expectedResumedSequences);
  assert.equal(resumed.states.length, 1);

  const negative = await postJson(port, "/api/demo/agent-loop/run", { case_id: "insufficient-evidence", round: 1, idempotency_key: "interactive-negative-001" });
  assert.equal(negative.status, 202, JSON.stringify(negative.body));
  const negativeStream = await readAllSse(port, negative.body.events_url);
  assert.equal(negativeStream.states.length, 1);
  assert.equal(negativeStream.states[0].payload.state, "needs_human");
  assert.equal(negativeStream.states[0].payload.contextual_workspaces.actions.open_recovery_console.available, false);
  assert.equal(negativeStream.states[0].payload.contextual_workspaces.actions.compare_recovery.available, false);
  assert.equal(negativeStream.events.some((item) => item.payload?.event?.type === "local_fault_loop.repair.executed"), false);

  // A deep-linked completed checkout run must remain authoritative even after
  // another tab starts a later insufficient-evidence run. This is the browser
  // contract shared by Live, Diagnose, Recovery, Compare, and Agent Chat.
  const pinnedCheckout = await getJson(port, `/api/state?run_id=${encodeURIComponent(first.body.run_id)}`);
  assert.equal(pinnedCheckout.status, 200, JSON.stringify(pinnedCheckout.body));
  assertCanonicalLoopBrowserState(pinnedCheckout.body, first.body);
  assert.equal(pinnedCheckout.body.run_id, first.body.run_id);
  assert.equal(pinnedCheckout.body.incident?.id, first.body.incident_id);
  assert.equal(pinnedCheckout.body.workspace_projection?.run_id, first.body.run_id);
  assert.equal(pinnedCheckout.body.workspace_projection?.topology?.current?.state, "recovered");
  assert.equal(pinnedCheckout.body.workspace_projection?.topology?.compare?.state, "verified");
  const strictArchitecture = architectureViewTopology(pinnedCheckout.body.topology_views);
  assert.ok(strictArchitecture, "the deep-linked run must retain a strict Architecture view");
  assert.ok(liveViewTopology(pinnedCheckout.body.topology_views), "the deep-linked run must retain a strict Live view");
  for (const view of ["live", "diagnose", "recovery", "compare"]) {
    const projection = pinnedCheckout.body.workspace_projection?.topology?.[view];
    assert.equal(projection?.run_id, first.body.run_id, `${view} must retain the deep-linked run`);
    assert.equal(projection?.incident_id, first.body.incident_id, `${view} must retain the deep-linked incident`);
    assert.equal(projection?.projection_revision, workspace.topology.projection_revision, `${view} must retain the deep-linked revision`);
  }
  const unknownPinned = await getJson(port, "/api/state?run_id=missing-run");
  assert.equal(unknownPinned.status, 404, "an explicit unknown run must fail closed instead of falling back");
  const invalidPinned = await getJson(port, "/api/state?run_id=not%20a%20run");
  assert.equal(invalidPinned.status, 400, "an explicitly invalid run must fail closed instead of falling back");

  assert.equal(roles.length + negativeStream.events.filter((item) => item.payload?.event?.type === "local_fault_loop.role.response").length, 8, "duplicate start must not create a second four-role execution");
});

function assertCanonicalLoopBrowserState(state, started) {
  const runId = started.run_id;
  const incidentId = started.incident_id;
  assert.equal(state.run_id, runId, "top-level state must use the local loop run");
  assert.equal(state.incident?.id, incidentId, "top-level state must use the local loop incident");
  assert.equal(state.topology_views?.run_id, runId, "all topology views must use the local loop run");
  assert.equal(state.topology_views?.incident_id, incidentId, "all topology views must use the local loop incident");
  assert.equal(state.incident_projection?.run_id, runId, "incident projection must use the local loop run");
  assert.equal(state.incident_projection?.incident?.id, incidentId, "incident projection must use the local loop incident");
  assert.equal(state.workspace_projection?.run_id, runId, "workspace projection must use the local loop run");
  assert.equal(state.workspace_projection?.incident_id, incidentId, "workspace projection must use the local loop incident");
  assert.equal(state.agent_control?.run_id, runId, "agent control must use the local loop run");
  assert.equal(state.agent_control?.incident_id, incidentId, "agent control must use the local loop incident");
  assert.equal(state.events.every((event) => event.run_id === runId && event.incident_id === incidentId), true, "event ledger must not contain a second run");
  assert.equal(state.source?.mode, "deterministic_replay", "local loop source provenance must be the captured replay source");
  assert.equal(state.source?.status, "captured", "local loop source must not splice in live collector state");
}

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
    FLOWPULSE_TEST_CODEX_RESPONSE: "{\"answer\":\"Bounded local role response cites ev-local-safe-1.\",\"recommended_handoff\":null,\"tool_requests\":[]}",
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

async function readFirstAgentSse(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!response.body) return { status: response.status, payload: null, raw: "" };
  const reader = response.body.getReader();
  let raw = "";
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = await reader.read();
      if (next.done) break;
      raw += new TextDecoder().decode(next.value);
      const agentEvent = parseSse(raw).events.find((item) => item.event === "agent-control");
      if (agentEvent) return { status: response.status, payload: agentEvent.payload.agent_control || agentEvent.payload, raw };
    }
  } finally {
    await reader.cancel();
  }
  return { status: response.status, payload: null, raw };
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

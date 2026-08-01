import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import { sha256Canonical } from "../src/autonomy-policy.mjs";

const SECRET = "test-only-guided-v3-hmac-secret-that-is-long-enough";
const ROLLBACK_SECRET = "test-only-safe-rollback-hmac-secret-long-enough";

test("signed guided agent bridge is exact-schema, durable-idempotent, and rejects forged replay", async (context) => {
  const flag = await startFlagApi(context, "on");
  const fixture = await startFlowPulse(context, flag.baseUrl);
  const request = agentRequest();

  const first = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/agent-runs", request);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.answer, "Bounded canonical explanation.");
  assert.deepEqual(first.body.evidence_refs, request.evidence_refs);
  assert.deepEqual(first.body.tool_requests, []);

  const repeated = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/agent-runs", request);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, first.body);

  const forged = await fetch(`${fixture.baseUrl}/api/internal/control-plane/v3/agent-runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flowpulse-internal-signature": "0".repeat(64) },
    body: JSON.stringify(request)
  });
  assert.equal(forged.status, 401);

  const inventedFact = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/agent-runs", {
    ...request,
    request_id: "agent-request-invented-fact",
    evidence_facts: [{ ...request.evidence_facts[0], component_ids: ["invented-service"] }]
  });
  assert.equal(inventedFact.status, 422);

  const missingQuestion = { ...request, request_id: "agent-request-missing-question" };
  delete missingQuestion.question;
  const missingQuestionResult = await signedPost(
    fixture.baseUrl,
    "/api/internal/control-plane/v3/agent-runs",
    missingQuestion,
  );
  assert.equal(missingQuestionResult.status, 422);

  const conflict = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/agent-runs", {
    ...request,
    question: "A different operator question"
  });
  assert.equal(conflict.status, 409);
});

test("guided preflight reads the real allowlisted flag and survives a Node restart", async (context) => {
  const flag = await startFlagApi(context, "on");
  const root = mkdtempSync(join(tmpdir(), "flowpulse-guided-v3-restart-"));
  const dbPath = join(root, "ledger.db");
  const first = await startFlowPulse(context, flag.baseUrl, { dbPath });
  const request = preflightRequest();
  const initial = await signedPost(first.baseUrl, "/api/internal/control-plane/v3/actions/preflight", request);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.passed, true);
  assert.equal(initial.body.observed_variant, "on");
  assert.equal(initial.body.rollback_supported, true);
  assert.deepEqual(initial.body.mutation_targets, ["flag:paymentUnreachable", "container:checkout"]);
  first.child.kill("SIGTERM");
  await onceExit(first.child);

  const second = await startFlowPulse(context, flag.baseUrl, { dbPath });
  const replay = await signedPost(second.baseUrl, "/api/internal/control-plane/v3/actions/preflight", request);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, initial.body);
  second.child.kill("SIGTERM");
  await onceExit(second.child);
});

test("an action started before restart reconciles only with proof of a newer Checkout runtime", async (context) => {
  const flag = await startFlagApi(context, "off");
  const root = mkdtempSync(join(tmpdir(), "flowpulse-guided-v3-action-restart-"));
  const dbPath = join(root, "ledger.db");
  const request = actionRequest();
  const raw = JSON.stringify(request);
  const fingerprint = createHmac("sha256", SECRET).update(raw).digest("hex");
  const suffix = sha256Canonical({ key: request.execution_key }).slice(0, 32);
  const ledger = new Ledger(dbPath);
  const common = {
    runId: "flowpulse-internal-guided-v3",
    incidentId: "flowpulse-internal-control-plane",
    actor: "internal-control-plane",
    evidenceRefs: [],
    correlationId: `guided-v3-execution-${suffix}`
  };
  const claim = ledger.append({
    ...common,
    id: `guided-v3-execution-claimed-${suffix}`,
    type: "guided.v3.execution.claimed",
    payload: { fingerprint, action_id: request.action_id, command_id: request.command_id },
    recordedAt: "2026-07-31T12:00:00.000Z"
  });
  ledger.append({
    ...common,
    id: `guided-v3-execution-started-${suffix}`,
    type: "guided.v3.execution.started",
    payload: {
      fingerprint,
      action_id: request.action_id,
      command_id: request.command_id,
      pre_execution_checkout: checkoutIdentity("aaaaaaaaaaaa", "2026-07-31T11:00:00.000Z")
    },
    parentId: claim.id,
    recordedAt: "2026-07-31T12:00:01.000Z"
  });

  const first = await startFlowPulse(context, flag.baseUrl, {
    dbPath,
    checkoutRuntimeIdentity: checkoutIdentity("bbbbbbbbbbbb", "2026-07-31T12:00:02.000Z")
  });
  const reconciled = await signedPost(first.baseUrl, "/api/internal/control-plane/v3/actions/execute", request);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.reused, true);
  assert.equal(reconciled.body.before, "paymentUnreachable=on");
  assert.equal(reconciled.body.after, "paymentUnreachable=off");
  first.child.kill("SIGTERM");
  await onceExit(first.child);

  const second = await startFlowPulse(context, flag.baseUrl, {
    dbPath,
    checkoutRuntimeIdentity: checkoutIdentity("bbbbbbbbbbbb", "2026-07-31T12:00:02.000Z")
  });
  const durable = await signedPost(second.baseUrl, "/api/internal/control-plane/v3/actions/execute", request);
  assert.equal(durable.status, 200);
  assert.deepEqual(durable.body, reconciled.body);
  second.child.kill("SIGTERM");
  await onceExit(second.child);
});

test("flag-off without Checkout recreation proof fails closed and does not retry mutation", async (context) => {
  const flag = await startFlagApi(context, "off");
  const root = mkdtempSync(join(tmpdir(), "flowpulse-guided-v3-action-ambiguous-"));
  const dbPath = join(root, "ledger.db");
  const request = { ...actionRequest(), execution_key: "execution-key-ambiguous", action_id: "action-ambiguous" };
  const raw = JSON.stringify(request);
  const fingerprint = createHmac("sha256", SECRET).update(raw).digest("hex");
  const suffix = sha256Canonical({ key: request.execution_key }).slice(0, 32);
  const ledger = new Ledger(dbPath);
  const common = {
    runId: "flowpulse-internal-guided-v3",
    incidentId: "flowpulse-internal-control-plane",
    actor: "internal-control-plane",
    evidenceRefs: [],
    correlationId: `guided-v3-execution-${suffix}`
  };
  const claim = ledger.append({
    ...common,
    id: `guided-v3-execution-claimed-${suffix}`,
    type: "guided.v3.execution.claimed",
    payload: { fingerprint, action_id: request.action_id, command_id: request.command_id },
    recordedAt: "2026-07-31T12:00:00.000Z"
  });
  ledger.append({
    ...common,
    id: `guided-v3-execution-started-${suffix}`,
    type: "guided.v3.execution.started",
    payload: {
      fingerprint,
      action_id: request.action_id,
      command_id: request.command_id,
      pre_execution_checkout: checkoutIdentity("cccccccccccc", "2026-07-31T11:00:00.000Z")
    },
    parentId: claim.id,
    recordedAt: "2026-07-31T12:00:01.000Z"
  });

  const fixture = await startFlowPulse(context, flag.baseUrl, {
    dbPath,
    checkoutRuntimeIdentity: checkoutIdentity("cccccccccccc", "2026-07-31T11:00:00.000Z")
  });
  const first = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/actions/execute", request);
  assert.equal(first.status, 409, JSON.stringify(first.body));
  assert.equal(first.body.error, "guided_action_reconciliation_requires_human");
  const repeated = await signedPost(fixture.baseUrl, "/api/internal/control-plane/v3/actions/execute", request);
  assert.deepEqual(repeated, first);
  fixture.child.kill("SIGTERM");
  await onceExit(fixture.child);
});

test("safe rollback reconciles a lost response across restart without re-enabling the fault", async (context) => {
  const flag = await startFlagApi(context, "off");
  const root = mkdtempSync(join(tmpdir(), "flowpulse-guided-v3-safe-rollback-"));
  const dbPath = join(root, "ledger.db");
  const request = {
    ...actionRequest(),
    execution_key: "safe-rollback-key-1",
    action_id: "safe-rollback-action-1"
  };
  const raw = JSON.stringify(request);
  const fingerprint = createHmac("sha256", ROLLBACK_SECRET).update(raw).digest("hex");
  const suffix = sha256Canonical({ key: request.execution_key }).slice(0, 32);
  const ledger = new Ledger(dbPath);
  const common = {
    runId: "flowpulse-internal-guided-v3",
    incidentId: "flowpulse-internal-control-plane",
    actor: "internal-control-plane",
    evidenceRefs: [],
    correlationId: `guided-v3-rollback-${suffix}`
  };
  const claim = ledger.append({
    ...common,
    id: `guided-v3-rollback-claimed-${suffix}`,
    type: "guided.v3.rollback.claimed",
    payload: { fingerprint, action_id: request.action_id, command_id: request.command_id },
    recordedAt: "2026-07-31T12:00:00.000Z"
  });
  ledger.append({
    ...common,
    id: `guided-v3-rollback-started-${suffix}`,
    type: "guided.v3.rollback.started",
    payload: {
      fingerprint,
      action_id: request.action_id,
      command_id: request.command_id,
      pre_execution_checkout: checkoutIdentity("dddddddddddd", "2026-07-31T11:00:00.000Z")
    },
    parentId: claim.id,
    recordedAt: "2026-07-31T12:00:01.000Z"
  });

  const runtimeIdentity = checkoutIdentity("eeeeeeeeeeee", "2026-07-31T12:00:02.000Z");
  const first = await startFlowPulse(context, flag.baseUrl, {
    dbPath, checkoutRuntimeIdentity: runtimeIdentity
  });
  const recovered = await signedPost(
    first.baseUrl,
    "/api/internal/control-plane/v3/actions/safe-rollback",
    request,
    ROLLBACK_SECRET,
  );
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.status, "ROLLED_BACK");
  assert.equal(recovered.body.execution_key, request.execution_key);
  assert.match(recovered.body.output_summary, /remained off/);
  first.child.kill("SIGTERM");
  await onceExit(first.child);

  const second = await startFlowPulse(context, flag.baseUrl, {
    dbPath, checkoutRuntimeIdentity: runtimeIdentity
  });
  const durable = await signedPost(
    second.baseUrl,
    "/api/internal/control-plane/v3/actions/safe-rollback",
    request,
    ROLLBACK_SECRET,
  );
  assert.equal(durable.status, 200);
  assert.deepEqual(durable.body, recovered.body);
  second.child.kill("SIGTERM");
  await onceExit(second.child);
});

function agentRequest() {
  return {
    schema_version: "flowpulse.guided-agent-bridge-request.v3",
    request_id: "agent-request-1",
    case_id: "case-1",
    attempt_id: "attempt-1",
    stage_run_id: "stage-run-1",
    stage: "INVESTIGATE",
    role: "investigator",
    selected_component: "checkout",
    question: "Why is Checkout failing?",
    incident_title: "Checkout client error",
    incident_summary: "A current admitted trace reports a Checkout error.",
    freshness: {
      state: "CURRENT",
      observed_at: "2026-07-31T12:00:00.000Z",
      fresh_until: "2026-07-31T12:00:30.000Z"
    },
    component_ids: ["checkout", "payment"],
    edge_ids: ["checkout->payment"],
    evidence_refs: ["evidence-1"],
    evidence_facts: [{
      fact_id: "signal-1",
      label: "Checkout to Payment request failure",
      value: "failed",
      observed_at: "2026-07-31T12:00:00.000Z",
      component_ids: ["checkout", "payment"],
      edge_ids: ["checkout->payment"],
      evidence_refs: ["evidence-1"]
    }],
    query_outcomes: [{
      schema_version: "flowpulse.evidence-query-result.v3",
      query_id: "query-1",
      attempt_id: "attempt-1",
      stage_run_id: "stage-run-1",
      stage: "INVESTIGATE",
      worker_activity_id: "worker-1",
      query_name: "incident.current-signals.v1",
      state: "SUCCEEDED",
      parameters_hash: "query-hash-1",
      result_summary: "One current dependency failure is admitted.",
      component_ids: ["checkout", "payment"],
      edge_ids: ["checkout->payment"],
      evidence_refs: ["evidence-1"],
      observation_timestamps: ["2026-07-31T12:00:00.000Z"],
      triggered_replan: false,
      started_at: "2026-07-31T11:59:59.000Z",
      completed_at: "2026-07-31T12:00:01.000Z",
      failure_code: null
    }],
    hypotheses: [{
      hypothesis_id: "hypothesis-1",
      stage_run_id: "stage-run-1",
      statement: "The evidenced Checkout to Payment failure drives the incident.",
      confidence: 0.8,
      supporting_evidence_refs: ["evidence-1"],
      contradicting_evidence_refs: [],
      falsification_condition: "A fresh healthy dependency trace with continued failures.",
      status: "SUPPORTED"
    }]
  };
}

function preflightRequest() {
  return {
    schema_version: "flowpulse.guided-action-preflight-request.v3",
    request_id: "preflight-request-1",
    case_id: "case-1",
    attempt_id: "attempt-1",
    stage_run_id: "stage-run-decide-1",
    command_id: "astronomy.restore-payment-and-recreate-checkout",
    target_component_id: "checkout",
    decision_revision: 2,
    expected_before: "paymentUnreachable=on"
  };
}

function actionRequest() {
  return {
    schema_version: "flowpulse.guided-action-bridge-request.v3",
    execution_key: "execution-key-1",
    action_id: "action-1",
    attempt_id: "attempt-1",
    command_id: "astronomy.restore-payment-and-recreate-checkout",
    decision_revision: 2,
    expected_before: "paymentUnreachable=on",
    expected_after: "paymentUnreachable=off"
  };
}

async function signedPost(baseUrl, path, value, secret = SECRET) {
  const body = JSON.stringify(value);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flowpulse-internal-signature": signature },
    body
  });
  return { status: response.status, body: await response.json() };
}

async function startFlagApi(context, variant) {
  const port = await freePort();
  const server = createHttpServer((request, response) => {
    if (request.url !== "/api/read") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      flags: {
        paymentUnreachable: {
          defaultVariant: variant,
          variants: { on: true, off: false }
        }
      }
    }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${port}` };
}

function checkoutIdentity(containerId, startedAt) {
  return { container_id: containerId, started_at: startedAt, running: true };
}

async function startFlowPulse(context, flagUrl, { dbPath = null, checkoutRuntimeIdentity = null } = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "flowpulse-guided-v3-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      FLOWPULSE_DB: dbPath || join(root, "ledger.db"),
      FLOWPULSE_FLAGD_UI_URL: flagUrl,
      FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET: SECRET,
      FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET: ROLLBACK_SECRET,
      FLOWPULSE_V3_SAFE_ROLLBACK_URL: `http://127.0.0.1:${port}`,
      ...(checkoutRuntimeIdentity
        ? { FLOWPULSE_TEST_CHECKOUT_RUNTIME_IDENTITY: JSON.stringify(checkoutRuntimeIdentity) }
        : {}),
      NODE_ENV: "test",
      FLOWPULSE_TEST_CODEX_RESPONSE: JSON.stringify({
        answer: "Bounded canonical explanation.",
        recommended_handoff: null,
        tool_requests: []
      }),
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForHealth(port, child);
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`FlowPulse exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("FlowPulse did not become healthy");
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

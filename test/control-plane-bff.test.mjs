import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("same-origin control-plane BFF allowlists contract routes, injects bearer, and forwards SSE resume framing", async (context) => {
  const upstream = await startUpstream(context);
  const frontend = await startFrontend(context, upstream.baseUrl);

  const incidents = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents?state=active&limit=20`);
  assert.equal(incidents.status, 200);
  assert.deepEqual(await incidents.json(), []);
  assert.deepEqual(upstream.requests.at(-1), {
    method: "GET",
    pathname: "/v1/incidents",
    search: "?state=active&limit=20",
    authorization: "Bearer trusted-server-only-test-token",
    lastEventId: null,
    body: ""
  });

  const stream = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/events?after=cursor-1`, { headers: { "Last-Event-ID": "cursor-1" } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  assert.match(await stream.text(), /event: incident-notification/);
  assert.deepEqual(upstream.requests.at(-1), {
    method: "GET",
    pathname: "/v1/incidents/events",
    search: "?after=cursor-1",
    authorization: "Bearer trusted-server-only-test-token",
    lastEventId: "cursor-1",
    body: ""
  });

  const beforeRejected = upstream.requests.length;
  const forgedTenant = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents?tenant_id=tenant-attacker`);
  assert.equal(forgedTenant.status, 400);
  assert.deepEqual(await forgedTenant.json(), { error: "control_plane_request_invalid" });
  assert.equal(upstream.requests.length, beforeRejected);

  const action = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/actions/action-test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(action.status, 400);
  assert.equal(upstream.requests.length, beforeRejected);
});

test("BFF forwards only validated node-explanation commands and redacts unavailable or upstream auth failures", async (context) => {
  const upstream = await startUpstream(context);
  const frontend = await startFrontend(context, upstream.baseUrl);
  const command = {
    incident_id: "incident-test",
    run_id: "run-test",
    topology_revision: "topology-test-v1",
    projection_revision: 2,
    component_id: "checkout",
    idempotency_key: "node-explanation:run-test:2:checkout"
  };
  const started = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/node-explanations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
  });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).reused, true);
  assert.equal(upstream.requests.at(-1).pathname, "/v1/incidents/case-test/node-explanations");
  assert.equal(upstream.requests.at(-1).body, JSON.stringify(command));

  const badCommand = { ...command, tenant_id: "tenant-attacker" };
  const beforeRejected = upstream.requests.length;
  const rejected = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/node-explanations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(badCommand)
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "control_plane_request_invalid" });
  assert.equal(upstream.requests.length, beforeRejected);

  const auth = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-auth/projection`);
  assert.equal(auth.status, 401);
  assert.deepEqual(await auth.json(), { error: "control_plane_auth_failed" });
});

test("unconfigured BFF visibly fails closed without a local compatibility response", async (context) => {
  const frontend = await startFrontend(context, null);
  const response = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents?state=active&limit=20`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "control_plane_unavailable" });
});

test("V2 BFF is read-only, allowlisted, and keeps the trusted bearer server-side", async (context) => {
  const upstream = await startUpstream(context);
  const frontend = await startFrontend(context, upstream.baseUrl);
  for (const [browserPath, upstreamPath] of [
    ["/api/control-plane/v2/incidents?state=active&limit=20", "/v2/incidents"],
    ["/api/control-plane/v2/incidents/case-test/projection", "/v2/incidents/case-test/projection"],
    ["/api/control-plane/v2/incidents/case-test/evidence/evidence-test", "/v2/incidents/case-test/evidence/evidence-test"]
  ]) {
    const response = await fetch(frontend.baseUrl + browserPath);
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.at(-1).pathname, upstreamPath);
    assert.equal(upstream.requests.at(-1).authorization, "Bearer trusted-server-only-test-token");
    assert.doesNotMatch(await response.text(), /trusted-server-only-test-token/);
  }
  const count = upstream.requests.length;
  const blocked = await fetch(`${frontend.baseUrl}/api/control-plane/v2/connectors/connector-test/reconcile`, { method: "POST" });
  assert.equal(blocked.status, 404);
  assert.equal(upstream.requests.length, count);
});

test("BFF exposes only exact canonical Workspace Action routes and rejects forged action scope", async (context) => {
  const upstream = await startUpstream(context);
  const frontend = await startFrontend(context, upstream.baseUrl);
  const listed = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/actions`);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), []);
  assert.deepEqual(upstream.requests.at(-1), {
    method: "GET", pathname: "/v1/incidents/case-test/actions", search: "", authorization: "Bearer trusted-server-only-test-token", lastEventId: null, body: ""
  });

  const command = {
    incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test-v1", projection_revision: 2,
    action_id: "action-test", idempotency_key: "action-test"
  };
  const invoked = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/actions/action-test`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
  });
  assert.equal(invoked.status, 202);
  assert.equal((await invoked.json()).status, "GATE1_GRANTED");
  assert.equal(upstream.requests.at(-1).pathname, "/v1/incidents/case-test/actions/action-test");
  assert.equal(upstream.requests.at(-1).body, JSON.stringify(command));

  const count = upstream.requests.length;
  const forged = await fetch(`${frontend.baseUrl}/api/control-plane/v1/incidents/case-test/actions/action-other`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
  });
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), { error: "control_plane_request_invalid" });
  assert.equal(upstream.requests.length, count);
});

test("V3 BFF allowlists Live, typed series, ordered SSE, and workflow commands without browser-controlled authority", async (context) => {
  const upstream = await startUpstream(context);
  const frontend = await startFrontend(context, upstream.baseUrl);
  for (const [browserPath, upstreamPath] of [
    ["/api/control-plane/v3/live/snapshot", "/v3/live/snapshot"],
    ["/api/control-plane/v3/incidents/case-checkout/projection", "/v3/incidents/case-checkout/projection"],
    ["/api/control-plane/v3/incidents/case-checkout/series", "/v3/incidents/case-checkout/series"]
  ]) {
    const response = await fetch(frontend.baseUrl + browserPath);
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.at(-1).pathname, upstreamPath);
    assert.equal(upstream.requests.at(-1).authorization, "Bearer trusted-server-only-test-token");
  }

  const stream = await fetch(`${frontend.baseUrl}/api/control-plane/v3/incidents/case-checkout/events?after=12`, { headers: { "Last-Event-ID": "12" } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
  assert.match(await stream.text(), /event: incident-event-v3/);
  assert.equal(upstream.requests.at(-1).lastEventId, "12");

  const base = { attempt_id: "attempt-1", expected_stage: "TRIAGE", expected_workflow_revision: 2, idempotency_key: "next:attempt-1:2:triage" };
  const commands = [
    ["/api/control-plane/v3/incidents/case-checkout/workflow/advance", base],
    ["/api/control-plane/v3/incidents/case-checkout/workflow/stages/TRIAGE/rerun", { ...base, idempotency_key: "rerun:attempt-1:2:triage", reason: "Retry current evidence" }],
    ["/api/control-plane/v3/incidents/case-checkout/workflow/escalations", { ...base, idempotency_key: "escalate:attempt-1:2:triage", reason: "Owner input required" }],
    ["/api/control-plane/v3/incidents/case-checkout/agent-runs", { ...base, idempotency_key: "agent:attempt-1:2:checkout", component_id: "checkout", question: "Investigate this component" }],
    ["/api/control-plane/v3/incidents/case-checkout/actions/action-1/approval", { ...base, idempotency_key: "approve:attempt-1:2:action-1", decision: "APPROVE", expected_decision_revision: 1 }]
  ];
  for (const [path, body] of commands) {
    const response = await fetch(frontend.baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(upstream.requests.at(-1).body), body);
  }

  const before = upstream.requests.length;
  for (const body of [{ ...base, tenant_id: "tenant-attacker" }, { ...base, provider: "shell" }, { ...base, upstream: "http://attacker" }]) {
    const response = await fetch(`${frontend.baseUrl}/api/control-plane/v3/incidents/case-checkout/workflow/advance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(upstream.requests.length, before);

  for (const [caseId, status, error] of [
    ["case-conflict", 409, "control_plane_conflict"],
    ["case-revalidate", 409, "control_plane_revalidation_required"],
    ["case-invalid", 422, "control_plane_schema_invalid"]
  ]) {
    const response = await fetch(`${frontend.baseUrl}/api/control-plane/v3/incidents/${caseId}/workflow/advance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

async function startUpstream(context) {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, "http://upstream.test");
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      authorization: request.headers.authorization || null,
      lastEventId: request.headers["last-event-id"] || null,
      body
    });
    if (url.pathname === "/v1/incidents/events" || url.pathname === "/v3/incidents/case-checkout/events") {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      response.end(url.pathname.startsWith("/v3/")
        ? "id: 13\nevent: incident-event-v3\ndata: {\"event_id\":\"event-13\"}\n\n"
        : "id: cursor-2\nevent: incident-notification\ndata: {\"notification_id\":\"notification-2\"}\n\n");
      return;
    }
    if (url.pathname === "/v1/incidents/case-auth/projection") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "upstream secret detail" }));
      return;
    }
    if (url.pathname.includes("/v3/incidents/case-conflict/")) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "private revision mismatch detail" }));
      return;
    }
    if (url.pathname.includes("/v3/incidents/case-revalidate/")) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "REVALIDATION_REQUIRED" }));
      return;
    }
    if (url.pathname.includes("/v3/incidents/case-invalid/")) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "private validation detail" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/incidents/case-test/node-explanations") {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ reused: true, explanation: {} }));
      return;
    }
    if (url.pathname === "/v1/incidents/case-test/actions" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (url.pathname === "/v1/incidents/case-test/actions/action-test" && request.method === "POST") {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "GATE1_GRANTED" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function startFrontend(context, upstreamBaseUrl) {
  const port = await freshPort();
  const root = mkdtempSync(join(tmpdir(), "flowpulse-control-plane-bff-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      FLOWPULSE_DB: join(root, "ledger.db"),
      FLOWPULSE_OTLP_DIR: join(root, "otel"),
      OPENAI_API_KEY: "",
      ...(upstreamBaseUrl ? {
        FLOWPULSE_CONTROL_PLANE_URL: upstreamBaseUrl,
        FLOWPULSE_CONTROL_PLANE_BEARER: "trusted-server-only-test-token"
      } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stop(child));
  await waitForHealth(child, port);
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function freshPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(child, port) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* wait for boot */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}

function stop(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
}

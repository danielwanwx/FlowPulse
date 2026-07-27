import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneClient, ControlPlaneClientError } from "../public/control-plane-client.mjs";

const summary = {
  case_id: "case-test", incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test-v1",
  projection_revision: 1, sequence: 1, lifecycle_state: "DEGRADED", status: "provider_unavailable",
  title: "Checkout latency", summary: "Checkout requests are degraded."
};

const identity = {
  tenant_id: "tenant-test", incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test-v1",
  case_id: "case-test", case_revision: 1, workflow_id: "flowpulse.incident-workspace:tenant-test:run-test",
  workflow_run_id: "temporal-test-run", created_at: "2026-07-26T00:00:00Z"
};

const action = {
  ...identity,
  schema_version: "flowpulse.next-best-action.v1",
  lifecycle_stage: "INVESTIGATE",
  action_id: "action-gate-1", card_version: 1, taxonomy: "FIND_CAUSE", title: "Find Cause", cta: "request_gate_1",
  summary: "Request investigation access.", display_order: 1, recommended: true,
  projection_revision: 1, evidence_revision: 1, gate_revision: 1, action_revision: 1,
  component_id: "checkout", capability: "GATE1_CURRENT_EVIDENCE", capability_version: "workspace-gate1-current-evidence.v1",
  data_class: "CURRENT_INCIDENT", required_permission: "incident:read", required_gate: "GATE1", tool_schema_version: "metrics-input.v1",
  capability_registry_revision: "capability-policy.v1", precondition_version: "workspace-precondition.v1", precondition_hash: "a".repeat(64),
  evidence_refs: [], expires_at: "2026-08-26T00:00:00Z"
};

test("versioned browser client uses only same-origin BFF paths and validates JSON before return", async () => {
  const calls = [];
  const client = new ControlPlaneClient({
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      return new Response(JSON.stringify([summary]), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.deepEqual(await client.activeIncidents(), [summary]);
  assert.deepEqual(calls, [{ path: "/api/control-plane/v1/incidents?state=active&limit=20", options: { headers: { accept: "application/json" } } }]);
  assert.doesNotMatch(JSON.stringify(calls), /authorization|bearer/i);
});

test("browser-bound fetch receives the global receiver before the client sends its first request", async () => {
  const calls = [];
  const browserReceiverFetch = function (path, options = {}) {
    assert.equal(this, globalThis);
    calls.push({ path, options });
    return new Response(JSON.stringify([summary]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new ControlPlaneClient({ fetch: browserReceiverFetch });
  assert.deepEqual(await client.activeIncidents(), [summary]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/control-plane/v1/incidents?state=active&limit=20");
});

test("client fails closed for redacted BFF errors and malformed projection responses", async () => {
  const unavailable = new ControlPlaneClient({
    fetch: async () => new Response(JSON.stringify({ error: "control_plane_unavailable" }), { status: 503, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(() => unavailable.activeIncidents(), (error) => error instanceof ControlPlaneClientError && error.code === "control_plane_unavailable");

  const malformed = new ControlPlaneClient({
    fetch: async () => new Response(JSON.stringify({ not: "a projection" }), { status: 200, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(() => malformed.projection("case-test", summary), (error) => error instanceof ControlPlaneClientError && error.code === "control_plane_schema_invalid");
});

test("SSE subscriptions accept ordered contract frames, retain the resume cursor, and close on malformed frames", () => {
  const sources = [];
  class TestEventSource {
    constructor(path) {
      this.path = path;
      this.listeners = new Map();
      this.closed = false;
      sources.push(this);
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name, value, lastEventId = "") { this.listeners.get(name)?.({ data: JSON.stringify(value), lastEventId }); }
  }
  const connections = [];
  const received = [];
  const client = new ControlPlaneClient({ fetch: async () => { throw new Error("unused"); }, EventSource: TestEventSource });
  const subscription = client.subscribeGlobal({
    onNotification: (value, cursor) => received.push({ value, cursor }),
    onConnection: (state, cursor) => connections.push({ state, cursor })
  });
  const source = sources[0];
  assert.equal(source.path, "/api/control-plane/v1/incidents/events");
  source.emit("incident-notification", {
    notification_id: "notification-1",
    event_type: "incident.accepted",
    occurred_at: "2026-07-26T00:00:00Z",
    incident: summary
  }, "cursor-1");
  assert.deepEqual(received, [{ value: {
    notification_id: "notification-1", event_type: "incident.accepted", occurred_at: "2026-07-26T00:00:00Z", incident: summary
  }, cursor: "cursor-1" }]);
  assert.equal(subscription.lastEventId(), "cursor-1");
  source.emit("incident-notification", { notification_id: "bad" }, "cursor-2");
  assert.equal(source.closed, true);
  assert.deepEqual(connections.at(-1), { state: "degraded", cursor: "cursor-1" });
});

test("client reads server-issued cards and submits only an opaque canonical action command", async () => {
  const calls = [];
  const receipt = {
    ...identity, action_id: action.action_id, idempotency_key: action.action_id,
    status: "GATE1_GRANTED", gate1_lease_id: "gate1-accepted", reason: "temporal transition accepted"
  };
  const client = new ControlPlaneClient({
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      const body = path.endsWith("/actions") ? [action] : receipt;
      return new Response(JSON.stringify(body), { status: path.endsWith("/actions") ? 200 : 202, headers: { "content-type": "application/json" } });
    }
  });
  assert.deepEqual(await client.actions("case-test"), [action]);
  assert.equal((await client.invokeAction("case-test", action.action_id, {
    incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test-v1", projection_revision: 1,
    action_id: action.action_id, idempotency_key: action.action_id
  })).status, "GATE1_GRANTED");
  assert.equal(calls[0].path, "/api/control-plane/v1/incidents/case-test/actions");
  assert.equal(calls[1].path, "/api/control-plane/v1/incidents/case-test/actions/action-gate-1");
  assert.doesNotMatch(JSON.stringify(calls), /authorization|bearer/i);
});

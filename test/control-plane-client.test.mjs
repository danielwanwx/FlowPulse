import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneClient, ControlPlaneClientError } from "../public/control-plane-client.mjs";

const summary = {
  case_id: "case-test", incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test-v1",
  projection_revision: 1, sequence: 1, lifecycle_state: "DEGRADED", status: "provider_unavailable",
  title: "Checkout latency", summary: "Checkout requests are degraded."
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

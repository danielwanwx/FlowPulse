import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneV3Client, ControlPlaneV3ClientError } from "../public/control-plane-v3-client.mjs";
import { v3Commands, v3LiveSnapshot, v3Projection, v3Receipt, v3Series } from "./helpers/v3-fixtures.mjs";

const commands = v3Commands();
const baseCommand = commands.advance;
const caseId = v3Projection().case_id;

test("V3 client uses same-origin projection, series, and live routes without browser authority fields", async () => {
  const calls = [];
  const client = new ControlPlaneV3Client({
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      const body = path.endsWith("/series") ? v3Series() : path.endsWith("/live/snapshot") ? v3LiveSnapshot() : v3Projection();
      return json(body);
    }
  });

  assert.equal((await client.projection(caseId)).case_id, caseId);
  assert.equal((await client.series(caseId)).series[0].series_id, v3Series().series[0].series_id);
  assert.equal((await client.liveSnapshot()).incidents[0].case_id, caseId);
  assert.deepEqual(calls.map((call) => call.path), [
    `/api/control-plane/v3/incidents/${caseId}/projection`,
    `/api/control-plane/v3/incidents/${caseId}/series`,
    "/api/control-plane/v3/live/snapshot"
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /authorization|bearer|upstream|provider|target/i);
});

test("V3 client routes Next, retry/rerun, escalation, node investigation, and approval with strict bodies", async () => {
  const calls = [];
  const client = new ControlPlaneV3Client({
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      return json(v3Receipt(path.includes("agent-runs") ? "START_AGENT_RUN" : path.includes("approval") ? "APPROVE_ACTION" : "NEXT"), 202);
    }
  });
  await client.advance(caseId, commands.advance);
  await client.rerun(caseId, "TRIAGE", commands.rerun);
  await client.escalate(caseId, commands.escalation);
  await client.startAgentRun(caseId, commands.agent_run);
  await client.approveAction(caseId, "action-1", { ...commands.approval, expected_stage: "TRIAGE", expected_workflow_revision: 2 });

  assert.deepEqual(calls.map((call) => call.path), [
    `/api/control-plane/v3/incidents/${caseId}/workflow/advance`,
    `/api/control-plane/v3/incidents/${caseId}/workflow/stages/TRIAGE/rerun`,
    `/api/control-plane/v3/incidents/${caseId}/workflow/escalations`,
    `/api/control-plane/v3/incidents/${caseId}/agent-runs`,
    `/api/control-plane/v3/incidents/${caseId}/actions/action-1/approval`
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), commands.rerun);
  assert.doesNotMatch(JSON.stringify(calls), /authorization|bearer|tenant_id|actor_subject_id|upstream/i);

  assert.throws(() => client.advance(caseId, { ...baseCommand, upstream: "http://attacker" }), (error) => error instanceof ControlPlaneV3ClientError && error.code === "control_plane_schema_invalid");
});

test("V3 case SSE uses ordered event name, resume cursor, and closes on malformed frames", () => {
  const sources = [];
  class TestEventSource {
    constructor(path) { this.path = path; this.listeners = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name, value, lastEventId = "") { this.listeners.get(name)?.({ data: JSON.stringify(value), lastEventId }); }
  }
  const connections = [];
  const events = [];
  const client = new ControlPlaneV3Client({ fetch: async () => { throw new Error("unused"); }, EventSource: TestEventSource });
  const subscription = client.subscribeCase({ caseId, after: 9, onEvent: (event) => events.push(event), onConnection: (state) => connections.push(state) });
  const source = sources[0];
  assert.equal(source.path, `/api/control-plane/v3/incidents/${caseId}/events?after=9`);
  source.emit("incident-event-v3", {
    schema_version: "flowpulse.incident-event.v3", event_id: "event-10", tenant_id: "tenant-local", case_id: caseId, sequence: 10,
    event_type: "workflow.stage.progress", occurred_at: "2026-07-31T00:00:11Z", projection_revision: 5, workflow_revision: 2,
    attempt_id: "attempt-1", stage: "TRIAGE", stage_run_id: "triage-1", summary: "Trace query complete.", progress: 72, evidence_refs: ["evidence-2"]
  }, "10");
  assert.equal(events.length, 1);
  assert.equal(subscription.lastEventId(), "10");
  source.emit("incident-event-v3", { schema_version: "bad" }, "11");
  assert.equal(source.closed, true);
  assert.equal(connections.at(-1), "stale");
});

test("V3 SSE reset sentinel closes an expired cursor and requests canonical hydration", () => {
  const sources = [];
  class TestEventSource {
    constructor(path) { this.path = path; this.listeners = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value), lastEventId: "" }); }
  }
  const connections = [];
  const client = new ControlPlaneV3Client({
    fetch: async () => { throw new Error("unused"); },
    EventSource: TestEventSource
  });
  client.subscribeCase({
    caseId, after: 99, onEvent() {},
    onConnection: (state) => connections.push(state)
  });
  sources[0].emit("stream-reset-v3", {
    schema_version: "flowpulse.stream-reset.v3",
    reason: "cursor_expired"
  });
  assert.equal(sources[0].closed, true);
  assert.equal(connections.at(-1), "stale");
});

test("V3 client preserves conflict and validation semantics through generic BFF error bodies", async () => {
  const conflict = new ControlPlaneV3Client({ fetch: async () => json({ error: "control_plane_request_rejected" }, 409) });
  await assert.rejects(() => conflict.advance(caseId, baseCommand), (error) => error instanceof ControlPlaneV3ClientError && error.code === "control_plane_conflict");
  const invalid = new ControlPlaneV3Client({ fetch: async () => json({ error: "control_plane_request_rejected" }, 422) });
  await assert.rejects(() => invalid.advance(caseId, baseCommand), (error) => error instanceof ControlPlaneV3ClientError && error.code === "control_plane_schema_invalid");
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

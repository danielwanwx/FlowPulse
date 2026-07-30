import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneContractError,
  controlPlaneReducer,
  createControlPlaneState,
  parseRealtimeIncidentEvent,
  parseRealtimeNotification
} from "../public/control-plane-contract.mjs";

const identity = {
  tenant_id: "tenant-minio", incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test",
  case_id: "case-test", case_revision: 1, workflow_id: "workflow-test", workflow_run_id: "workflow-run-test",
  created_at: "2026-07-30T00:00:00Z"
};
const summary = {
  case_id: "case-test", incident_id: "incident-test", run_id: "run-test", topology_revision: "topology-test",
  projection_revision: 2, sequence: 10, lifecycle_state: "DEGRADED", lifecycle_stage: "INVESTIGATE",
  title: "Checkout degradation", summary: "Current backend summary.",
  incident_clock: { state: "RUNNING", started_at: "2026-07-30T00:00:00Z", last_signal_at: null, resolved_at: null, as_of: "2026-07-30T00:00:10Z", elapsed_seconds: 10, freshness: "CURRENT", fresh_until: "2026-07-30T00:00:40Z", max_interpolation_seconds: 30 },
  latest_signal_status: null, connector_freshness: "CURRENT"
};
const signal = {
  signal_id: "signal-1", source_event_id: "source-1", provider: "PROMETHEUS", source_label: "Prometheus",
  signal_kind: "ERROR_RATE", title: "Checkout error rate", display_value: "8.4%", status: "CRITICAL", trend: "STABLE",
  component_ids: ["checkout"], edge_ids: [], observed_at: "2026-07-30T00:00:10Z", fresh_until: "2026-07-30T00:01:10Z",
  freshness: "CURRENT", authority: "T0_AUTHORITATIVE_CURRENT", evidence_refs: ["evidence-1"], citation_refs: ["citation-1"],
  connector_state: "CONNECTED", sequence: 11
};
const citation = { citation_id: "citation-1", provider: "PROMETHEUS", evidence_id: "evidence-1", source_event_id: "source-1", label: "Checkout signal", observed_at: "2026-07-30T00:00:10Z", freshness: "CURRENT", safe_detail_path: "/v2/incidents/case-test/evidence/evidence-1" };
const health = { schema_version: "flowpulse.connector-health.v1", connector_id: "connector-1", tenant_id: "tenant-minio", provider: "PROMETHEUS", state: "CONNECTED", checked_at: "2026-07-30T00:00:10Z", last_success_at: "2026-07-30T00:00:10Z", last_event_observed_at: "2026-07-30T00:00:10Z", fresh_until: "2026-07-30T00:01:10Z", cursor: "cursor-1", consecutive_failures: 0, lag_seconds: 0, reason_code: null, adapter_version: "prometheus-read.v1", health_revision: 1, truth_label: "TEST_DETERMINISTIC" };
const pulse = { pulse_id: "pulse-1", source_event_id: "source-1", event_sequence: 12, edge_ids: ["edge-1"], component_ids: ["checkout"], pulse_kind: "PROPAGATION", severity: "CRITICAL", started_at: "2026-07-30T00:00:10Z", expires_at: "2026-07-30T00:00:20Z", evidence_refs: ["evidence-1"] };
const activity = { activity_id: "activity-1", activity_key: "activity-key-1", state_revision: 1, sequence: 13, role: "MONITOR", state: "STARTED", trigger: "CONNECTOR_EVENT", capability: "METRICS", capability_version: "prometheus-read.v1", tool_label: "Prometheus metrics", component_ids: ["checkout"], started_at: "2026-07-30T00:00:10Z", completed_at: null, summary: "Reading admitted evidence.", source_event_ids: ["source-1"], evidence_refs: ["evidence-1"], citation_refs: ["citation-1"], truth_label: "TEST_DETERMINISTIC", external_write_performed: false, degraded_code: null };
const clock = summary.incident_clock;

function event(event_type, payload = {}, sequence = 11) {
  return { ...identity, schema_version: "flowpulse.incident-realtime-event.v2", source_event_id: "source-1", projection_revision: 3, sequence, event_type, occurred_at: "2026-07-30T00:00:10Z", signal: null, pulse: null, activity: null, citation: null, health: null, incident_clock: null, ...payload };
}

test("V2 realtime parsers accept each exact event payload and reject mismatches", () => {
  const cases = [
    ["connector.health.changed", { health }],
    ["connector.source.accepted", {}],
    ["incident.signal.observed", { signal, citation }],
    ["incident.signal.stale", { signal }],
    ["graph.pulse.started", { pulse }],
    ["graph.pulse.expired", { pulse }],
    ["agent.activity.started", { activity, citation }],
    ["agent.activity.completed", { activity: { ...activity, state: "COMPLETED", completed_at: "2026-07-30T00:00:11Z" } }],
    ["agent.activity.degraded", { activity: { ...activity, state: "DEGRADED", degraded_code: "provider_unavailable" } }],
    ["incident.clock.changed", { incident_clock: clock }]
  ];
  for (const [type, payload] of cases) assert.equal(parseRealtimeIncidentEvent(event(type, payload)).event_type, type);
  assert.throws(() => parseRealtimeIncidentEvent(event("connector.source.accepted", { signal })), ControlPlaneContractError);
  assert.throws(() => parseRealtimeIncidentEvent(event("graph.pulse.started", { pulse: { ...pulse, edge_ids: [] } })), ControlPlaneContractError);
  assert.throws(() => parseRealtimeIncidentEvent({ ...event("incident.clock.changed", { incident_clock: clock }), extra: true }), ControlPlaneContractError);
});

test("V2 notification and reducer dedupe ordered events, fail closed across identity, and reload canonical projection only", () => {
  const notification = { notification_id: "notification-1", event_type: "incident.signal.observed", occurred_at: "2026-07-30T00:00:10Z", source_event_id: "source-1", incident: summary };
  assert.equal(parseRealtimeNotification(notification).incident.case_id, "case-test");
  const projection = { ...identity, schema_version: "flowpulse.incident-projection.v2", projection_revision: 2, sequence: 10 };
  let state = { ...createControlPlaneState(), projection, projections: new Map([["case-test", projection]]), last_case_sequence: 10, connection: "connected" };
  let reduced = controlPlaneReducer(state, { type: "case.event", event: event("incident.signal.observed", { signal, citation }, 11) });
  assert.deepEqual(reduced.effects, [{ type: "projection.load", case_id: "case-test", identity: null }]);
  assert.equal(reduced.state.last_case_sequence, 11);
  reduced = controlPlaneReducer(reduced.state, { type: "case.event", event: event("incident.signal.observed", { signal, citation }, 11) });
  assert.deepEqual(reduced.effects, []);
  const crossed = controlPlaneReducer(reduced.state, { type: "case.event", event: { ...event("incident.signal.observed", { signal, citation }, 12), tenant_id: "tenant-other" } });
  assert.equal(crossed.state.connection, "stale");
  assert.deepEqual(crossed.effects, []);
});

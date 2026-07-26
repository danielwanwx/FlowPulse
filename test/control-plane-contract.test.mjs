import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneContractError,
  controlPlaneReducer,
  createControlPlaneState,
  nodeExplanationCommand,
  parseIncidentEvent,
  parseIncidentNotification,
  parseIncidentProjection,
  parseIncidentSummaries,
  parseNodeExplanationReceipt
} from "../public/control-plane-contract.mjs";

// Test-only fixtures derived from frozen backend contract 65e62bc….
const IDENTITY = Object.freeze({
  tenant_id: "tenant-test",
  incident_id: "incident-test",
  run_id: "run-test",
  topology_revision: "topology-test-v1",
  case_id: "case-test",
  case_revision: 1,
  workflow_id: "flowpulse.incident-workspace:tenant-test:run-test",
  workflow_run_id: "temporal-test-run",
  created_at: "2026-07-26T00:00:00Z"
});

function projection({ revision = 1, sequence = revision, impacted = true } = {}) {
  return {
    ...IDENTITY,
    schema_version: "flowpulse.incident-projection.v1",
    projection_revision: revision,
    sequence,
    lifecycle_state: "DEGRADED",
    status: "provider_unavailable",
    operator_title: "Checkout latency",
    operator_summary: "Checkout requests are degraded.",
    generated_at: "2026-07-26T00:00:00Z",
    graph: {
      nodes: [
        { component_id: "checkout", canonical_identity: "service:checkout", display_name: "Checkout", membership: "CONNECTED", runtime_status: "degraded", impact_status: impacted ? "impacted" : "healthy", classification_reason: null },
        { component_id: "payment", canonical_identity: "service:payment", display_name: "Payment", membership: "CONNECTED", runtime_status: "degraded", impact_status: impacted ? "impacted" : "healthy", classification_reason: null },
        { component_id: "ledger", canonical_identity: "store:evidence-ledger", display_name: "Evidence Ledger", membership: "CLASSIFIED", classification_reason: "Data store", runtime_status: "available", impact_status: "unaffected" }
      ],
      edges: [{ edge_id: "checkout-payment", source_component_id: "checkout", target_component_id: "payment", status: "degraded" }]
    },
    impacted_path: impacted ? ["checkout", "payment"] : [],
    evidence_revision: 1,
    gate_revision: 1,
    action_revision: 1,
    evidence_refs: [],
    degraded_code: "provider_unavailable"
  };
}

function notification({ notification_id = "notification-1", sequence = 1 } = {}) {
  return {
    notification_id,
    event_type: "incident.accepted",
    occurred_at: "2026-07-26T00:00:00Z",
    incident: {
      case_id: IDENTITY.case_id,
      incident_id: IDENTITY.incident_id,
      run_id: IDENTITY.run_id,
      topology_revision: IDENTITY.topology_revision,
      projection_revision: 1,
      sequence,
      lifecycle_state: "DEGRADED",
      status: "provider_unavailable",
      title: "Checkout latency",
      summary: "Checkout requests are degraded."
    }
  };
}

test("contract validator accepts only server identity and connected-or-classified graph records", () => {
  const parsed = parseIncidentProjection(projection());
  assert.equal(parsed.graph.nodes[0].display_name, "Checkout");
  assert.equal(parsed.graph.nodes[2].classification_reason, "Data store");
  assert.deepEqual(parseIncidentSummaries([notification().incident]), [notification().incident]);

  const noDisplayName = projection();
  delete noDisplayName.graph.nodes[0].display_name;
  assert.throws(() => parseIncidentProjection(noDisplayName), ControlPlaneContractError);

  const orphan = projection();
  orphan.graph.nodes[0].membership = "CONNECTED";
  orphan.graph.edges = [];
  assert.throws(() => parseIncidentProjection(orphan), /connected_node_without_edge/);

  const unclassified = projection();
  unclassified.graph.nodes[2].classification_reason = null;
  assert.throws(() => parseIncidentProjection(unclassified), /classified_node_without_reason/);
});

test("notification passively prefetches projection while focus itself makes no request or explanation", () => {
  const notified = controlPlaneReducer(createControlPlaneState(), { type: "notification.received", notification: notification() });
  assert.deepEqual(notified.effects, [{ type: "projection.load", case_id: IDENTITY.case_id, identity: notification().incident }]);
  assert.equal(notified.state.toast.notification_id, "notification-1");

  const loadingFocus = controlPlaneReducer(notified.state, { type: "toast.focus" });
  assert.equal(loadingFocus.effects.length, 0);
  assert.equal(loadingFocus.state.mode, "incident");
  assert.equal(loadingFocus.state.focus_status, "loading");
  assert.deepEqual(loadingFocus.state.focused_path, []);

  const hydrated = controlPlaneReducer(loadingFocus.state, { type: "projection.hydrated", projection: projection() });
  assert.deepEqual(hydrated.state.focused_path, ["checkout", "payment"]);
  const focused = controlPlaneReducer(hydrated.state, { type: "toast.focus" });
  assert.equal(focused.effects.length, 0);
  assert.equal(focused.state.selected_component_id, null);

  const clicked = controlPlaneReducer(focused.state, { type: "node.clicked", component_id: "checkout" });
  assert.deepEqual(clicked.effects, [{ type: "node-explanation.start", command: nodeExplanationCommand(projection(), "checkout") }]);
  const duplicate = controlPlaneReducer(clicked.state, { type: "node.clicked", component_id: "checkout" });
  assert.equal(duplicate.effects.length, 0);
  const concurrentOtherNode = controlPlaneReducer(clicked.state, { type: "node.clicked", component_id: "payment" });
  assert.equal(concurrentOtherNode.effects.length, 0);

  const newerProjection = projection({ revision: 2, sequence: 2 });
  const newerHydration = controlPlaneReducer(loadingFocus.state, {
    type: "projection.hydrated", projection: newerProjection, identity: notification().incident
  });
  assert.equal(newerHydration.state.focus_status, "ready");
  assert.equal(newerHydration.state.projection.projection_revision, 2);
});

test("case SSE and durable receipts are canonical, ordered, and cannot cross-run replace the workspace", () => {
  const hydrated = controlPlaneReducer(createControlPlaneState(), { type: "projection.hydrated", projection: projection({ revision: 2, sequence: 4 }) }).state;
  const staleEvent = {
    ...IDENTITY,
    schema_version: "flowpulse.incident-event.v1",
    projection_revision: 1,
    sequence: 3,
    event_type: "node_explanation.completed",
    occurred_at: "2026-07-26T00:00:00Z",
    evidence_refs: [],
    payload: {},
    explanation_status: "COMPLETED"
  };
  assert.equal(parseIncidentEvent(staleEvent).sequence, 3);
  const stale = controlPlaneReducer(hydrated, { type: "case.event", event: staleEvent });
  assert.equal(stale.state.projection.projection_revision, 2);
  assert.equal(stale.effects.length, 0);

  const newerEvent = { ...staleEvent, projection_revision: 3, sequence: 5 };
  const newer = controlPlaneReducer(hydrated, { type: "case.event", event: newerEvent });
  assert.deepEqual(newer.effects, [{ type: "projection.load", case_id: IDENTITY.case_id, identity: null }]);
  const duplicate = controlPlaneReducer(newer.state, { type: "case.event", event: newerEvent });
  assert.equal(duplicate.effects.length, 0);

  const forgedRun = { ...staleEvent, run_id: "run-attacker", sequence: 5, projection_revision: 3 };
  const mismatched = controlPlaneReducer(hydrated, { type: "case.event", event: forgedRun });
  assert.equal(mismatched.state.connection, "stale");
  assert.equal(mismatched.state.projection.run_id, IDENTITY.run_id);

  const receipt = {
    reused: false,
    explanation: {
      ...IDENTITY,
      explanation_id: "explanation-test",
      selection_key: "node_explanation:tenant-test:run-test:2:checkout:flowpulse.node-explanation.v1",
      projection_revision: 2,
      component_id: "checkout",
      conversation_schema_version: "flowpulse.node-explanation.v1",
      state: "DEGRADED",
      summary: "Recorded context is available; no fresh read was performed.",
      evidence_refs: [],
      fresh_read_performed: false,
      fresh_diagnosis_claimed: false,
      degraded_code: "provider_unavailable",
      truth_label: "DEGRADED"
    }
  };
  assert.equal(parseNodeExplanationReceipt(receipt).explanation.explanation_id, "explanation-test");
  const selected = controlPlaneReducer(hydrated, { type: "node.clicked", component_id: "checkout" }).state;
  const completed = controlPlaneReducer(selected, { type: "explanation.receipt", receipt });
  assert.equal(completed.state.explanation.status, "degraded");

  receipt.explanation.fresh_read_performed = true;
  assert.throws(() => parseNodeExplanationReceipt(receipt), /fresh_read_not_allowed/);
});

test("global notification schema rejects malformed and duplicate stream frames", () => {
  assert.equal(parseIncidentNotification(notification()).notification_id, "notification-1");
  const malformed = notification();
  delete malformed.incident.title;
  assert.throws(() => parseIncidentNotification(malformed), ControlPlaneContractError);

  const unknownType = notification();
  unknownType.event_type = "incident.created_by_browser";
  assert.throws(() => parseIncidentNotification(unknownType), ControlPlaneContractError);

  const nonStringPayload = {
    ...IDENTITY,
    projection_revision: 1,
    sequence: 1,
    event_type: "workspace.initialized",
    occurred_at: "2026-07-26T00:00:00Z",
    payload: { explanation_id: 7 }
  };
  assert.throws(() => parseIncidentEvent(nonStringPayload), ControlPlaneContractError);

  const state = controlPlaneReducer(createControlPlaneState(), { type: "notification.received", notification: notification() }).state;
  const repeated = controlPlaneReducer(state, { type: "notification.received", notification: notification() });
  assert.equal(repeated.effects.length, 0);
  assert.equal(repeated.state.seen_notification_ids.size, 1);
});

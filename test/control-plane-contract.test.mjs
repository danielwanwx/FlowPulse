import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneContractError,
  actionInvocationCommand,
  controlPlaneReducer,
  createControlPlaneState,
  investigationPresentation,
  nodeExplanationCommand,
  parseIncidentEvent,
  parseIncidentNotification,
  parseIncidentProjection,
  parseIncidentSummaries,
  parseNextBestActions,
  parseNodeExplanationReceipt,
  parseWorkspaceActionReceipt
} from "../public/control-plane-contract.mjs";

// Test-only fixtures derived from frozen backend contract 99f84df….
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

function investigationResult({
  disposition = "ACCEPTED",
  lifecycle_stage = disposition === "ACCEPTED" ? "DECIDE" : "INVESTIGATE",
  critic_decision = disposition === "ACCEPTED" ? "PASS" : disposition === "CRITIC_REJECTED" ? "FAIL" : "AMBIGUOUS",
  projection_revision = 4,
  evidence_revision = 2,
  component_id = "checkout"
} = {}) {
  return {
    ...IDENTITY,
    schema_version: "flowpulse.investigation-result.v1",
    result_id: "investigation-result-example",
    component_id,
    source_action_id: "action-example-read",
    source_idempotency_key: "example-read-01",
    source_activity_identity: "workspace-action:temporal-test-run:command-hash-example",
    synthesis_id: "investigation-synthesis-example",
    synthesis_activity_id: "investigation-synthesis:activity-example",
    synthesis_model_id: "example-model",
    synthesis_provider_id: "configured-example-provider",
    projection_revision,
    evidence_revision,
    lifecycle_stage,
    disposition,
    summary: "Current evidence supports a bounded checkout degradation hypothesis.",
    claims: [
      { claim_id: "claim-checkout-latency", kind: "OBSERVATION", statement: "Current checkout latency is elevated.", evidence_refs: ["evidence-checkout-latency"] },
      { claim_id: "investigation-claim-example", kind: "HYPOTHESIS", statement: "The checkout service is constrained by the observed current signal.", evidence_refs: ["evidence-checkout-latency"] }
    ],
    evidence: [{
      evidence_id: "evidence-checkout-latency", source_kind: "METRIC", observed_at: "2026-07-26T00:00:00Z",
      freshness: "CURRENT", authority: "T1_DIRECT_CURRENT", proof_scope: "CURRENT_OBSERVATION", parent_evidence_refs: []
    }],
    critic: {
      critic_id: "investigation-critic-example", identity: "independent-example-critic", decision: critic_decision,
      evidence_refs: ["evidence-checkout-latency"], reason_codes: ["current_evidence_supports_candidate"],
      reviewed_claim_ids: ["claim-checkout-latency", "investigation-claim-example"]
    },
    truth_label: "LIVE",
    version_bundle: {
      capability_registry_version: "capability-registry.v1", card_schema_version: "flowpulse.next-best-action.v1",
      context_pack_version: "conversation-context-pack.v1", core_policy_version: "conversation-core-policy.v1",
      evidence_schema_version: "flowpulse.evidence-envelope.v1", model_policy_version: "provider-policy.v1",
      policy_version: "capability-policy.v1", role_prompt_version: "conversation-role-prompts.v1",
      schema_version: "flowpulse.version-bundle.v1", tool_schema_version: "capability-tool-schema.v1",
      workflow_version: "flowpulse.incident-workspace.v2"
    },
    recorded_at: "2026-07-26T00:00:00Z"
  };
}

function investigateProjection({ disposition = "ACCEPTED", lifecycle_stage, critic_decision, revision = 4, sequence = revision, impacted = true } = {}) {
  const result = investigationResult({ disposition, lifecycle_stage, critic_decision, projection_revision: revision, evidence_revision: 2 });
  const value = projection({ revision, sequence, impacted });
  return {
    ...value,
    lifecycle_state: "ACTIVE",
    status: disposition === "ACCEPTED" ? "investigation_accepted" : "investigation_degraded",
    evidence_revision: 2,
    gate1_state: "CONSUMED",
    lifecycle_stage: result.lifecycle_stage,
    evidence_refs: ["evidence-checkout-latency"],
    investigation_result: result
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

function nextBestAction({
  action_id = "action-gate-1",
  cta = "request_gate_1",
  taxonomy = cta === "run_read_capability" ? "MAP_IMPACT" : "FIND_CAUSE",
  title = cta === "run_read_capability" ? "Map Impact" : "Find Cause",
  projection_revision = 1,
  evidence_revision = 1,
  gate_revision = 1,
  action_revision = 1,
  gate1_lease_id = undefined,
  expires_at = "2026-08-26T00:00:00Z"
} = {}) {
  return {
    ...IDENTITY,
    schema_version: "flowpulse.next-best-action.v1",
    action_id,
    card_version: 1,
    taxonomy,
    title,
    cta,
    summary: cta === "run_read_capability" ? "Read current incident evidence." : "Request investigation access.",
    display_order: 1,
    recommended: true,
    projection_revision,
    evidence_revision,
    gate_revision,
    action_revision,
    component_id: "checkout",
    capability: "GATE1_CURRENT_EVIDENCE",
    capability_version: "workspace-gate1-current-evidence.v1",
    data_class: "CURRENT_INCIDENT",
    required_permission: "incident:read",
    required_gate: "GATE1",
    tool_schema_version: "metrics-input.v1",
    capability_registry_revision: "capability-policy.v1",
    precondition_version: "workspace-precondition.v1",
    precondition_hash: "a".repeat(64),
    ...(gate1_lease_id ? { gate1_lease_id } : {}),
    evidence_refs: [],
    expires_at
  };
}

function actionReceipt({
  action_id = "action-gate-1",
  idempotency_key = "workspace-action:run-test:1:action-gate-1:1",
  status = "GATE1_GRANTED",
  gate1_lease_id = "gate1-accepted"
} = {}) {
  return {
    ...IDENTITY,
    action_id,
    idempotency_key,
    status,
    ...(gate1_lease_id ? { gate1_lease_id } : {}),
    reason: "temporal transition accepted"
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
  assert.deepEqual(clicked.effects, [
    { type: "node-explanation.start", command: nodeExplanationCommand(projection(), "checkout") },
    { type: "actions.load", case_id: IDENTITY.case_id, identity: projection() }
  ]);
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

test("Investigate cards and Gate 1 transition stay server-owned and reject stale or forged cards", () => {
  const currentProjection = projection();
  const parsed = parseNextBestActions([nextBestAction()]);
  assert.equal(parsed[0].title, "Find Cause");
  assert.equal(parsed[0].cta, "request_gate_1");

  let reduced = controlPlaneReducer(createControlPlaneState(), { type: "projection.hydrated", projection: currentProjection });
  assert.deepEqual(reduced.effects, [{ type: "actions.load", case_id: IDENTITY.case_id, identity: currentProjection }]);
  reduced = controlPlaneReducer(reduced.state, { type: "actions.hydrated", identity: currentProjection, actions: parsed });
  assert.equal(reduced.state.actions.cards.length, 1);
  assert.equal(reduced.state.actions.cards[0].title, "Find Cause");

  const gateRequest = controlPlaneReducer(reduced.state, { type: "action.clicked", action_id: "action-gate-1" });
  assert.equal(gateRequest.effects.length, 1);
  assert.equal(gateRequest.effects[0].type, "action.invoke");
  assert.deepEqual(gateRequest.effects[0].command, actionInvocationCommand(currentProjection, parsed[0]));

  const gateReceipt = actionReceipt({ idempotency_key: gateRequest.effects[0].command.idempotency_key });
  assert.equal(parseWorkspaceActionReceipt(gateReceipt).status, "GATE1_GRANTED");
  let afterReceipt = controlPlaneReducer(gateRequest.state, { type: "action.receipt", receipt: gateReceipt });
  assert.equal(afterReceipt.state.actions.gate1.event, null);
  assert.equal(afterReceipt.state.actions.cards.length, 0);
  assert.deepEqual(afterReceipt.effects, [{ type: "projection.load", case_id: IDENTITY.case_id, identity: null }]);

  const earlyRead = nextBestAction({
    action_id: "action-read-1", cta: "run_read_capability", gate1_lease_id: "gate1-accepted",
    projection_revision: 2, gate_revision: 2, action_revision: 2
  });
  const refreshedProjection = projection({ revision: 2, sequence: 2 });
  refreshedProjection.gate_revision = 2;
  refreshedProjection.action_revision = 2;
  afterReceipt = controlPlaneReducer(afterReceipt.state, { type: "projection.hydrated", projection: refreshedProjection });
  const beforeEvent = controlPlaneReducer(afterReceipt.state, { type: "actions.hydrated", identity: refreshedProjection, actions: [earlyRead] });
  assert.equal(beforeEvent.state.actions.status, "awaiting_gate1_event");
  assert.equal(beforeEvent.state.actions.cards.length, 0);

  const gateEvent = {
    ...IDENTITY,
    schema_version: "flowpulse.incident-event.v1",
    projection_revision: 2,
    sequence: 3,
    event_type: "workspace.action.gate1_granted",
    occurred_at: "2026-07-26T00:01:00Z",
    evidence_refs: [],
    payload: { action_id: "action-gate-1", idempotency_key: gateReceipt.idempotency_key }
  };
  const acceptedEvent = controlPlaneReducer(afterReceipt.state, { type: "case.event", event: gateEvent });
  assert.equal(acceptedEvent.state.actions.gate1.event.event_type, "workspace.action.gate1_granted");
  const allowedRead = controlPlaneReducer(acceptedEvent.state, { type: "actions.hydrated", identity: refreshedProjection, actions: [earlyRead] });
  assert.equal(allowedRead.state.actions.cards[0].cta, "run_read_capability");

  const forged = nextBestAction({ action_id: "action-forged", projection_revision: 99 });
  const rejected = controlPlaneReducer(reduced.state, { type: "actions.hydrated", identity: currentProjection, actions: [forged] });
  assert.equal(rejected.state.connection, "degraded");
  assert.equal(rejected.state.actions.cards.length, 0);

  const expired = nextBestAction({ expires_at: "2025-01-01T00:00:00Z" });
  const expiredState = controlPlaneReducer(reduced.state, { type: "actions.hydrated", identity: currentProjection, actions: [expired] });
  const expiredClick = controlPlaneReducer(expiredState.state, { type: "action.clicked", action_id: "action-gate-1" });
  assert.equal(expiredClick.effects.length, 0);
  assert.equal(expiredClick.state.connection, "stale");
});

test("accepted frozen investigation projection alone advances the canonical presentation to Decide", () => {
  // The frozen backend example intentionally has a classified selected
  // component and an empty impacted path. Result identity binds to the graph
  // component, not a client-inferred red path.
  const accepted = investigateProjection({ impacted: false });
  accepted.graph = {
    nodes: [{
      component_id: "checkout", canonical_identity: "service:checkout", display_name: "Checkout",
      membership: "CLASSIFIED", classification_reason: "Relationship unavailable", runtime_status: "unknown", impact_status: "unknown"
    }],
    edges: []
  };
  const parsed = parseIncidentProjection(accepted);
  const presentation = investigationPresentation(parsed);
  assert.equal(presentation.stage, "DECIDE");
  assert.equal(presentation.outcome, "accepted");
  assert.equal(presentation.summary, accepted.investigation_result.summary);
  assert.deepEqual(presentation.claims.map((claim) => claim.kind), ["OBSERVATION", "HYPOTHESIS"]);
  assert.equal(presentation.critic.identity, "independent-example-critic");
  assert.deepEqual(presentation.evidence.map((evidence) => evidence.freshness), ["CURRENT"]);
  assert.equal("evidence_refs" in presentation.claims[0], false);
  assert.equal("evidence_id" in presentation.evidence[0], false);

  const hydrated = controlPlaneReducer(createControlPlaneState(), { type: "projection.hydrated", projection: accepted });
  assert.equal(hydrated.state.projection.lifecycle_stage, "DECIDE");
  assert.equal(investigationPresentation(hydrated.state.projection).stage, "DECIDE");
  assert.deepEqual(hydrated.effects, []);
});

test("degraded, abstained, and critic-rejected results remain server-owned Investigate outcomes", () => {
  for (const disposition of ["DEGRADED", "ABSTAINED", "CRITIC_REJECTED"]) {
    const result = investigateProjection({ disposition });
    const parsed = parseIncidentProjection(result);
    const presentation = investigationPresentation(parsed);
    assert.equal(presentation.stage, "INVESTIGATE", disposition);
    assert.equal(presentation.outcome, "degraded", disposition);
  }

  const untrustedSuccess = investigateProjection({ critic_decision: "FAIL" });
  assert.throws(() => parseIncidentProjection(untrustedSuccess), /investigation_result_critic_invalid/);

  const staleSuccessEvidence = investigateProjection();
  staleSuccessEvidence.investigation_result.evidence[0].freshness = "STALE";
  assert.throws(() => parseIncidentProjection(staleSuccessEvidence), /investigation_result_critic_invalid/);

  const staleResult = investigateProjection();
  staleResult.investigation_result.projection_revision = 3;
  assert.throws(() => parseIncidentProjection(staleResult), /investigation_result_revision_mismatch/);

  const crossRun = investigateProjection();
  crossRun.investigation_result.run_id = "run-attacker";
  assert.throws(() => parseIncidentProjection(crossRun), /investigation_result_identity_mismatch/);

  const unknownComponent = investigateProjection();
  unknownComponent.investigation_result.component_id = "component-attacker";
  assert.throws(() => parseIncidentProjection(unknownComponent), /investigation_result_component_mismatch/);

  const unknownNested = investigateProjection();
  unknownNested.investigation_result.evidence[0].browser_decision = "accept";
  assert.throws(() => parseIncidentProjection(unknownNested), /investigation_evidence_unknown_field/);

  const mismatchedEvidence = investigateProjection();
  mismatchedEvidence.investigation_result.claims[0].evidence_refs = ["evidence-attacker"];
  assert.throws(() => parseIncidentProjection(mismatchedEvidence), /investigation_claim_evidence_mismatch/);

  const invalidLineage = investigateProjection();
  invalidLineage.investigation_result.evidence[0].parent_evidence_refs = ["evidence-checkout-latency"];
  assert.throws(() => parseIncidentProjection(invalidLineage), /investigation_evidence_parent_mismatch/);
});

test("historical v1.1.1 projections remain Investigate and never infer Decide from an action receipt", () => {
  const historical = parseIncidentProjection(projection());
  assert.equal(historical.lifecycle_stage, undefined);
  assert.equal(historical.investigation_result, undefined);
  assert.equal(investigationPresentation(historical).stage, "INVESTIGATE");

  const state = createControlPlaneState();
  state.projection = historical;
  state.actions.receipt = { status: "FRESH_READ_COMPLETED", reason: "Investigation accepted: move to Decide." };
  assert.equal(investigationPresentation(state.projection).stage, "INVESTIGATE");
});

test("investigation SSE only rehydrates a newer canonical projection and never treats event prose as truth", () => {
  const current = investigateProjection({ disposition: "DEGRADED", revision: 3, sequence: 3 });
  const hydrated = controlPlaneReducer(createControlPlaneState(), { type: "projection.hydrated", projection: current }).state;
  const acceptedEvent = {
    ...IDENTITY,
    schema_version: "flowpulse.incident-event.v1",
    projection_revision: 4,
    sequence: 4,
    event_type: "workspace.investigation.accepted",
    occurred_at: "2026-07-26T00:01:00Z",
    evidence_refs: ["evidence-checkout-latency"],
    payload: { summary: "untrusted event prose", disposition: "ACCEPTED" }
  };
  const received = controlPlaneReducer(hydrated, { type: "case.event", event: acceptedEvent });
  assert.deepEqual(received.effects, [{ type: "projection.load", case_id: IDENTITY.case_id, identity: null }]);
  assert.equal(investigationPresentation(received.state.projection).outcome, "degraded");

  const degradedEvent = { ...acceptedEvent, event_type: "workspace.investigation.degraded", projection_revision: 5, sequence: 5 };
  const degraded = controlPlaneReducer(received.state, { type: "case.event", event: degradedEvent });
  assert.deepEqual(degraded.effects, [{ type: "projection.load", case_id: IDENTITY.case_id, identity: null }]);
  assert.equal(investigationPresentation(degraded.state.projection).outcome, "degraded");

  const duplicate = controlPlaneReducer(degraded.state, { type: "case.event", event: degradedEvent });
  assert.equal(duplicate.effects.length, 0);

  const outOfOrder = controlPlaneReducer(degraded.state, { type: "case.event", event: { ...acceptedEvent, event_type: "workspace.investigation.degraded", sequence: 3 } });
  assert.equal(outOfOrder.effects.length, 0);

  const crossRun = controlPlaneReducer(hydrated, { type: "case.event", event: { ...acceptedEvent, run_id: "run-attacker" } });
  assert.equal(crossRun.state.connection, "stale");
  assert.equal(crossRun.state.projection.run_id, IDENTITY.run_id);
});

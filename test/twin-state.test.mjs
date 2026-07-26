import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARCHITECTURE_LAYERS,
  AGENT_COLLABORATORS,
  AGENT_TEAM_ROLES,
  LIVE_LAYERS,
  PULSE_SLOTS,
  TWIN_EDGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_STAGES,
  activeIncidentState,
  architectureBoundaries,
  agentLoopStartProjection,
  agentTeamConversationProjection,
  agentTeamProviderProjection,
  canonicalIncidentWorkspaceStage,
  hasAuthoritativeIncidentExecution,
  incidentWorkflowEvidence,
  incidentVerificationProjection,
  incidentCompareControlAvailable,
  incidentVerificationGuidance,
  commitPinnedStateResponse,
  isRetryableRequestFailure,
  createTopologyRefreshTracker,
  settleTopologyRefresh,
  createCanonicalLoadingController,
  createPinnedRunStateRetryController,
  cancelPinnedRunRetries,
  sharedRunReconnectDelay,
  architectureViewTopology,
  componentDetailProjection,
  nodeInvestigationN1Projection,
  nodeLiveInspectorProjection,
  availableStage,
  architecturePositions,
  compareFrames,
  compareProvenance,
  canvasPointerTransition,
  containedCanvasView,
  canonicalTwinDisplay,
  diagnoseViewTopology,
  eventsAtStage,
  frameFor,
  liveEdgePath,
  liveEdgeRoute,
  liveIncidentNodeStates,
  liveSignalDuration,
  liveSignalProgress,
  livePulseSlots,
  liveViewTopology,
  livePositions,
  orderedSignalEdges,
  primaryLiveEdges,
  projectAgentCollaborators,
  isCanvasNavigationMode,
  topologyIntegrity
} from "../public/twin-state.mjs";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const twinStateSource = readFileSync(new URL("../public/twin-state.mjs", import.meta.url), "utf8");

test("canonical display never turns observed or missing backend facts into fixed healthy demo data", () => {
  const display = canonicalTwinDisplay({ sourceStates: { checkout: "observed" }, metric: null });
  assert.equal(display.nodeStates.checkout, "observed");
  assert.equal(display.nodeStates.frontend, "observed");
  assert.equal(Object.values(display.edgeStates).every((status) => status === "observed"), true);
  assert.deepEqual(display.metrics, {
    checkout: { value: "Unavailable", note: "Awaiting evidence" },
    payment: { value: "Unavailable", note: "Awaiting evidence" },
    kafka: { value: "Unavailable", note: "Awaiting evidence" }
  });
  assert.doesNotMatch(JSON.stringify(display), /0\.8|99\.98|620|healthy/i);
  assert.deepEqual(canonicalTwinDisplay({ metric: { checkout_error_rate_percent: 4.2, payment_reachability_percent: null, kafka_lag: 17 } }).metrics, display.metrics);
});
const architectureRefinementCss = stylesCss.slice(stylesCss.lastIndexOf("/* Architecture refinement: compact nested anatomy"));
const architectureMaterialCss = architectureRefinementCss.slice(0, architectureRefinementCss.indexOf("@media (max-width: 1320px)"));
const architectureStaticCss = stylesCss.slice(stylesCss.lastIndexOf("/* Architecture static overview: flat alpha-only material. */"));
const architectureDetailCss = stylesCss.slice(stylesCss.lastIndexOf("/* Architecture component detail: one flat four-level material scale. */"));
const architectureHoverCss = stylesCss.slice(stylesCss.lastIndexOf("/* Hover confirms an available component detail without a blue selection frame. */"));
const architectureComponentDetailSource = appJs.slice(appJs.indexOf("function architectureComponentDetailMarkup"), appJs.indexOf("function openArchitectureDetail"));
const topologyManifest = JSON.parse(readFileSync(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url), "utf8"));

function runtimeNodes(status) {
  const planeOrder = { runtime: 0, data: 1 };
  const layerOrder = { experience: 0, commerce: 1, processing: 2, platform: 3 };
  return [...topologyManifest.nodes]
    .sort((left, right) => planeOrder[left.plane] - planeOrder[right.plane] || layerOrder[left.layer] - layerOrder[right.layer] || left.id.localeCompare(right.id))
    .map((node) => ({ ...node, status }));
}

function backendArchitectureView() {
  const controls = [
    { id: "observer", kind: "service", display_class: "observer", plane: "control", layer: "observation", label: "Observer", status: "observed", source_health: "unavailable", signal_types: [], provenance_refs: ["code://flowpulse/observer"], detail: controlDetail("observer") },
    { id: "orchestrator", kind: "service", display_class: "orchestrator", plane: "control", layer: "orchestration", label: "Orchestrator", status: "idle", source_health: "unavailable", signal_types: [], provenance_refs: ["ledger://orchestration"], detail: controlDetail("orchestrator") },
    { id: "investigator", kind: "service", display_class: "agent", plane: "control", layer: "investigation", label: "Investigator", status: "idle", source_health: "unavailable", signal_types: [], provenance_refs: ["code://flowpulse/investigator"], detail: controlDetail("investigator") },
    { id: "evaluator", kind: "service", display_class: "evaluator", plane: "control", layer: "evaluation", label: "Evaluator", status: "idle", source_health: "unavailable", signal_types: [], provenance_refs: ["code://flowpulse/evaluator"], detail: controlDetail("evaluator") },
    { id: "ledger", kind: "dataset", display_class: "ledger", plane: "evidence", layer: "evidence", label: "Evidence Ledger", status: "recording", source_health: "unavailable", signal_types: [], provenance_refs: ["ledger://append-only"], detail: controlDetail("ledger") }
  ];
  const runtime = (status) => ({
    graph: {
      nodes: runtimeNodes(status),
      edges: topologyManifest.edges.map((edge) => ({ ...edge, status })),
      total_nodes: 22,
      total_edges: 26,
      truncated: false
    },
    node_count: 22,
    edge_count: 26,
    supporting_relations: topologyManifest.supporting_relations.map((relation) => ({ ...relation, status })),
    supporting_relation_count: 7
  });
  const controlSystem = { nodes: controls, relations: [], node_count: 5, relation_count: 0 };
  const externalChangeEvidence = {
    records: [{ id: "ev-deploy-checkout", kind: "deployment_change", status: "observed", affected_node_ids: ["checkout"], provenance_refs: ["evidence://ev-deploy-checkout"] }],
    relation_count: 1
  };
  return {
    schema_version: "flowpulse.topology-views.v2",
    projection_revision: "a".repeat(64),
    run_id: "run-topology",
    incident_id: "inc-astro-checkout-001",
    truth: { source_health: "unavailable", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay", label: "CAPTURED" },
    readiness: { architecture_available: true, live_available: true, incident_detected: false, diagnose_available: false, agent_available: false, compare_available: false },
    architecture: {
      runtime_data: runtime("observed"),
      control_system: controlSystem,
      external_change_evidence: externalChangeEvidence
    },
    live: {
      runtime_data: runtime("captured"),
      control_system: controlSystem,
      external_change_evidence: externalChangeEvidence,
      incident_overlay: { status: "inactive", node_ids: [], edges: [] }
    },
    diagnose: {
      runtime_data: runtime("observed"),
      overlay: { status: "unavailable", node_ids: [], edges: [] }
    },
    demo: {
      schema_version: "flowpulse.demo-lifecycle.v1",
      run_id: "run-topology",
      scenario_id: "astronomy-checkout-payment-captured-v1",
      phase: "HEALTHY",
      frames: [{ id: "healthy", order: 0, phase: "HEALTHY", node_ids: [], relation_ids: [], evidence_refs: [] }]
    }
  };
}

function activeDemoTopologyView() {
  const view = backendArchitectureView();
  const affectedNodes = ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"];
  const affectedEdges = ["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"];
  const incidentNodeIds = new Set(affectedNodes);
  const incidentEdgeIds = new Set(affectedEdges);
  for (const node of view.live.runtime_data.graph.nodes) node.status = incidentNodeIds.has(node.id) ? "incident" : "healthy";
  for (const edge of view.live.runtime_data.graph.edges) edge.status = incidentEdgeIds.has(edge.id) ? "incident" : "healthy";
  for (const edge of view.live.runtime_data.supporting_relations) edge.status = incidentEdgeIds.has(edge.id) ? "incident" : "healthy";
  view.live.incident_overlay = {
    status: "active",
    node_ids: affectedNodes,
    edges: [
      { id: "checkout->kafka", from: "checkout", to: "kafka", relation: "evidence_grounded_relation", status: "incident" },
      { id: "checkout->payment", from: "checkout", to: "payment", relation: "observed_dependency", status: "incident" },
      { id: "frontend->checkout", from: "frontend", to: "checkout", relation: "observed_dependency", status: "incident" },
      { id: "kafka->accounting", from: "kafka", to: "accounting", relation: "evidence_grounded_relation", status: "incident" },
      { id: "kafka->fraud-detection", from: "kafka", to: "fraud-detection", relation: "evidence_grounded_relation", status: "incident" }
    ]
  };
  view.diagnose.overlay = {
    status: "available",
    node_ids: affectedNodes,
    edges: view.live.incident_overlay.edges.map(({ status, ...edge }) => edge)
  };
  view.readiness = { architecture_available: true, live_available: true, incident_detected: true, diagnose_available: true, agent_available: false, compare_available: false };
  view.demo = {
    ...view.demo,
    phase: "INCIDENT_DETECTED",
    frames: [
      view.demo.frames[0],
      { id: "injecting", order: 1, phase: "INJECTING", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-deploy-checkout", "ev-trace-payment-refused"] },
      { id: "payment_checkout_impact", order: 2, phase: "PAYMENT_CHECKOUT_IMPACT", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-metric-checkout-errors"] },
      { id: "downstream_propagation", order: 3, phase: "DOWNSTREAM_PROPAGATION", node_ids: ["kafka", "accounting", "fraud-detection"], relation_ids: ["checkout->kafka", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-kafka-lag", "ev-log-consumer-delay"] },
      { id: "incident_detected", order: 4, phase: "INCIDENT_DETECTED", node_ids: affectedNodes, relation_ids: affectedEdges, evidence_refs: ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"] }
    ]
  };
  return view;
}

function controlDetail(id) {
  const provenance = {
    observer: ["code://flowpulse/connector-manifest", "code://flowpulse/evidence-source", "code://flowpulse/live-source"],
    orchestrator: ["code://flowpulse/agent-control-service", "code://flowpulse/agent-team-harness", "code://flowpulse/runtime"],
    investigator: ["code://flowpulse/development-runtime", "code://flowpulse/incident-projection", "code://flowpulse/runtime"],
    evaluator: ["code://flowpulse/agent-team-harness", "code://flowpulse/autonomy-policy", "code://flowpulse/runtime"],
    ledger: ["code://flowpulse/server", "ledger://append-only"]
  };
  return {
    summary: `${id} bounded capability`,
    inputs: ["Bounded input"],
    outputs: ["Bounded output"],
    authority: "Cannot approve execute or verify repairs",
    provenance_refs: provenance[id],
    activity: { summary: id === "observer" ? "Captured source intake" : null, stage: null, last_sequence: id === "ledger" ? 4 : null, last_recorded_at: id === "ledger" ? "2026-07-20T11:00:00.000Z" : null, evidence_refs: [], gate: "unavailable", source_health: "unavailable" }
  };
}

function agentTeamProviderPayload() {
  return {
    provider_kind: "codex-local",
    availability: "available",
    truth_label: "LOCAL CODEX",
    model_label: "Codex CLI",
    failure_reason: null
  };
}

function agentTeamConversationPayload() {
  const provider = agentTeamProviderPayload();
  return {
    schema_version: "flowpulse.agent-team-chat.v1",
    conversation_id: "conversation-run-topology",
    messages: [
      {
        id: "evt-agent-1",
        sequence: 1,
        recorded_at: "2026-07-21T12:00:00.000Z",
        type: "agent_team.message.received",
        kind: "user",
        agent: "human",
        requested_agent: "observer",
        page_mode: "live",
        selected_component: "checkout",
        text: "Why is checkout failing?"
      },
      {
        id: "evt-agent-2",
        sequence: 2,
        recorded_at: "2026-07-21T12:00:01.000Z",
        type: "agent_team.handoff.recorded",
        kind: "handoff",
        from: "observer",
        to: "investigator",
        reason: "Causal investigation belongs to Investigator."
      },
      {
        id: "evt-agent-3",
        sequence: 3,
        recorded_at: "2026-07-21T12:00:02.000Z",
        type: "agent_team.response.created",
        kind: "assistant",
        requested_agent: "observer",
        responding_agent: "investigator",
        agent: "investigator",
        state: "completed",
        text: "The bounded trace and change evidence identify the checkout payment endpoint.",
        handoff: { from: "observer", to: "investigator", reason: "Causal investigation belongs to Investigator." },
        citations: ["ev-trace-payment-refused"],
        tool_summaries: [{ tool: "read_evidence_summaries", result_count: 2, raw_payload_excluded: true }],
        human_gate: { status: "not_required" },
        provider
      }
    ],
    truncated: false,
    record_count: 3,
    latest: { sequence: 3, recorded_at: "2026-07-21T12:00:02.000Z" }
  };
}

function agentLoopStartPayload() {
  return {
    schema_version: "flowpulse.local-fault-loop.v2",
    run_id: "local-loop-checkout-payment-config-1-abc123",
    incident_id: "incident-local-checkout-payment-config-1-abc123",
    state: "running",
    stage: "monitor",
    events_url: "/api/demo/agent-loop/events?run_id=local-loop-checkout-payment-config-1-abc123&after=0",
    contextual_workspaces: {
      context: {
        run_id: "local-loop-checkout-payment-config-1-abc123",
        incident_id: "incident-local-checkout-payment-config-1-abc123",
        selected_component: "checkout",
        timeline: { position: 0, event_id: "evt-loop-1", stage: "monitor", terminal_state: null }
      },
      actions: {
        view_diagnosis: { available: false, prerequisites: [{ id: "bounded_incident_opened", satisfied: false }] },
        open_recovery_console: { available: false, prerequisites: [{ id: "evaluated_remediation_plan_or_repair_started", satisfied: false }] },
        compare_recovery: { available: false, prerequisites: [{ id: "independent_verification_completed", satisfied: false }, { id: "implemented_repair_recovered", satisfied: false }] }
      }
    }
  };
}

test("Agent Team browser projections accept only bounded roles, safe answers, transparent handoffs, and server workspace gates", () => {
  assert.deepEqual(AGENT_TEAM_ROLES, ["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
  assert.deepEqual(agentTeamProviderProjection(agentTeamProviderPayload()), agentTeamProviderPayload());
  assert.deepEqual(agentTeamProviderProjection({ ...agentTeamProviderPayload(), provider_kind: "recorded", truth_label: "RECORDED/DEMO", model_label: "recorded-agent-team-v1" }), { ...agentTeamProviderPayload(), provider_kind: "recorded", truth_label: "RECORDED/DEMO", model_label: "recorded-agent-team-v1" });
  assert.equal(agentTeamProviderProjection({ ...agentTeamProviderPayload(), secret: "forged" }), null);

  const conversation = agentTeamConversationPayload();
  const parsedConversation = agentTeamConversationProjection(conversation, { conversationId: conversation.conversation_id });
  assert.equal(parsedConversation?.messages.length, 3);
  assert.deepEqual(parsedConversation?.messages[1], conversation.messages[1]);
  const ledgerOrdered = structuredClone(conversation);
  ledgerOrdered.messages[2].citations = ["ev-trace-payment-refused", "ev-deploy-checkout"];
  assert.deepEqual(agentTeamConversationProjection(ledgerOrdered, { conversationId: conversation.conversation_id })?.messages[2].citations, ledgerOrdered.messages[2].citations);
  assert.equal(agentTeamConversationProjection({ ...conversation, messages: [{ ...conversation.messages[2], raw_prompt: "forged" }] }, { conversationId: conversation.conversation_id }), null);
  const toolConversation = structuredClone(conversation);
  toolConversation.messages = [
    toolConversation.messages[0],
    {
      id: "evt-agent-tool-request", sequence: 2, recorded_at: "2026-07-21T12:00:01.000Z", type: "agent_team.tool.requested", kind: "tool_request",
      agent: "investigator", state: "working", tool: "get_component_snapshot", component_id: "checkout", attempt: 0, round: 0, raw_payload_excluded: true
    },
    {
      id: "evt-agent-tool-result", sequence: 3, recorded_at: "2026-07-21T12:00:02.000Z", type: "agent_team.tool.result.recorded", kind: "tool_result",
      agent: "investigator", state: "working", tool: "get_component_snapshot", component_id: "checkout", result_count: 2, selected_count: 2, omitted_count: 0, cached: false,
      citations: ["ev-trace-payment-refused"], source_truth: { mode: "deterministic_replay", status: "captured", freshness_ms: null, observed_at: null, truth_label: "captured_replay" }, raw_payload_excluded: true
    },
    { ...toolConversation.messages[2], id: "evt-agent-tool-answer", sequence: 4, recorded_at: "2026-07-21T12:00:03.000Z" }
  ];
  toolConversation.record_count = 4;
  toolConversation.latest = { sequence: 4, recorded_at: "2026-07-21T12:00:03.000Z" };
  assert.equal(agentTeamConversationProjection(toolConversation, { conversationId: conversation.conversation_id })?.messages[2].kind, "tool_result");

  const loop = agentLoopStartPayload();
  const parsedLoop = agentLoopStartProjection(loop);
  assert.equal(parsedLoop?.contextual_workspaces.actions.compare_recovery.available, false);
  assert.equal(agentLoopStartProjection({ ...loop, state: "recovered" }), null);
  assert.equal(agentLoopStartProjection({ ...loop, contextual_workspaces: { ...loop.contextual_workspaces, repair: "forged" } }), null);
});

test("Incident accepts only the backend authority and verifier chain for its current stage", () => {
  const event = (id, type, actor, payload, evidence_refs = [], parent_id = null) => ({ id, type, actor, payload, evidence_refs, parent_id });
  const plan = event("evt-plan", "local_fault_loop.plan.proposed", "orchestrator", {
    stage: "plan", repair: "restore_checkout_payment_endpoint", target: "checkout", reversible: true, authority: "isolated_demo_task_authorization"
  });
  const authority = event("evt-authority", "local_fault_loop.authority.decided", "runtime", {
    stage: "approve-or-auto", outcome: "auto_execute_pre_authorized", execution_scope: "local_memory_only"
  }, [], plan.id);
  const repair = event("evt-repair", "local_fault_loop.repair.executed", "remediation", {
    stage: "repair", repair: "restore_checkout_payment_endpoint", target: "checkout", attempt: 1, bounded: true, execution_scope: "local_memory_only", rollback_available: true, result: "applied"
  }, ["ev-repair"], authority.id);
  const verification = (passed, actor = "verifier", parent_id = repair.id) => event(`evt-verify-${passed}-${actor}`, "local_fault_loop.verification.completed", actor, {
    stage: "verify", passed,
    checks: ["root_condition_removed", "direct_symptom_cleared", "downstream_lag_converged"].map((id) => ({ id, passed }))
  }, ["ev-verify"], parent_id);
  const recovered = {
    state: "recovered",
    topology: { verification: { passed: true } },
    workspace_actions: { compare_recovery: { available: true } },
    events: [plan, authority, repair, verification(true)]
  };
  const needsHuman = {
    state: "needs_human",
    topology: { verification: { passed: false } },
    events: [event("evt-human", "local_fault_loop.authority.decided", "runtime", { stage: "approve-or-auto", outcome: "needs_human", execution_scope: "none" })]
  };
  const needsHumanWithForgedScope = {
    state: "needs_human",
    topology: { verification: { passed: false } },
    events: [event("evt-forged-human", "local_fault_loop.authority.decided", "runtime", { stage: "approve-or-auto", outcome: "needs_human", execution_scope: "local_memory_only" })]
  };
  const approvedWithoutScope = {
    state: "running",
    topology: { verification: { passed: false } },
    events: [event("evt-no-scope", "local_fault_loop.authority.decided", "runtime", { stage: "approve-or-auto", outcome: "auto_execute_pre_authorized", execution_scope: "none" })]
  };
  const approved = {
    state: "running",
    topology: { verification: { passed: false } },
    events: [plan, authority]
  };
  const postExecutionNeedsHuman = {
    state: "needs_human",
    topology: { verification: { passed: false } },
    events: [
      plan, authority, repair, verification(false),
      event("evt-stopped", "local_fault_loop.stopped", "runtime", { state: "needs_human", halt_reason: "independent_verification_failed" }, [], "evt-verify-false-verifier")
    ]
  };
  const malformedRepair = [event("evt-malformed-repair", "local_fault_loop.repair.executed", "remediation", { stage: "repair", bounded: true, execution_scope: "local_memory_only", result: "applied" })];
  const repairWithoutAuthority = [event("evt-repair-no-auth", "local_fault_loop.repair.executed", "remediation", { stage: "repair", repair: "restore_checkout_payment_endpoint", target: "checkout", attempt: 1, bounded: true, execution_scope: "local_memory_only", rollback_available: true, result: "applied" })];
  const productionScope = { state: "running", topology: { verification: { passed: false } }, events: [plan, event("evt-production-authority", "local_fault_loop.authority.decided", "runtime", { stage: "approve-or-auto", outcome: "auto_execute_pre_authorized", execution_scope: "production_cluster" }, [], plan.id)] };
  const attackerVerifier = { state: "running", topology: { verification: { passed: false } }, events: [plan, authority, repair, verification(true, "attacker")] };
  const verifierBeforeRepair = { state: "running", topology: { verification: { passed: false } }, events: [plan, authority, verification(false)] };
  const forgedVerifierParent = { state: "running", topology: { verification: { passed: false } }, events: [plan, authority, repair, verification(true, "verifier", "evt-forged-repair")] };
  const forgedPassedAfterFailure = {
    state: "needs_human",
    topology: { verification: { passed: true }, snapshots: { verified: {} } },
    events: [...postExecutionNeedsHuman.events, verification(true, "attacker", repair.id)]
  };

  assert.equal(canonicalIncidentWorkspaceStage(recovered), "verify");
  assert.equal(hasAuthoritativeIncidentExecution(needsHuman.events), false);
  assert.equal(canonicalIncidentWorkspaceStage(needsHuman), "investigate");
  assert.equal(hasAuthoritativeIncidentExecution(needsHumanWithForgedScope.events), false);
  assert.equal(canonicalIncidentWorkspaceStage(needsHumanWithForgedScope), "investigate");
  assert.equal(hasAuthoritativeIncidentExecution(approvedWithoutScope.events), false);
  assert.equal(canonicalIncidentWorkspaceStage(approvedWithoutScope), "investigate");
  assert.equal(hasAuthoritativeIncidentExecution(approved.events), true);
  assert.equal(canonicalIncidentWorkspaceStage(approved), "execute");
  assert.equal(canonicalIncidentWorkspaceStage(postExecutionNeedsHuman), "verify");
  assert.equal(incidentWorkflowEvidence(postExecutionNeedsHuman.events).verificationFailed, true);
  assert.equal(hasAuthoritativeIncidentExecution(productionScope.events), false);
  assert.equal(canonicalIncidentWorkspaceStage(productionScope), "decide");
  assert.equal(canonicalIncidentWorkspaceStage(attackerVerifier), "execute");
  assert.equal(canonicalIncidentWorkspaceStage(verifierBeforeRepair), "execute");
  assert.equal(canonicalIncidentWorkspaceStage(forgedVerifierParent), "execute");
  assert.equal(hasAuthoritativeIncidentExecution(malformedRepair), false);
  assert.equal(hasAuthoritativeIncidentExecution(repairWithoutAuthority), false);
  const strictVerified = { ...recovered, topology: { verification: { passed: true }, snapshots: { verified: {} } } };
  assert.equal(incidentVerificationProjection(strictVerified).passed, true);
  assert.equal(incidentCompareControlAvailable(strictVerified), true);
  assert.equal(incidentVerificationProjection({ ...strictVerified, state: "running" }).passed, false);
  assert.equal(incidentVerificationProjection({ ...strictVerified, state: "needs_human" }).passed, false);
  assert.equal(incidentVerificationProjection({ ...strictVerified, workspace_actions: { compare_recovery: { available: false } } }).passed, false);
  assert.equal(incidentCompareControlAvailable({ ...strictVerified, state: "running" }), false);
  assert.deepEqual(incidentVerificationProjection(forgedPassedAfterFailure), { attempted: true, passed: false, failed: true });
  assert.deepEqual(incidentVerificationGuidance({ passed: false, failed: true }), {
    agentOutput: "Independent verification failed",
    nextAction: "Review the recorded evidence with an operator"
  });
  assert.deepEqual([1, 2, 3, 4].map(sharedRunReconnectDelay), [750, 1500, 3000, 3000]);
  assert.match(twinStateSource, /function incidentFocusSignal\(id, metric\) \{\n  if \(!metric \|\| !validCanonicalMetric\(metric, false\)\) return null;/);
});

test("Incident refresh controllers preserve the latest pinned state and retry only recoverable failures", async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((nextResolve) => { resolve = nextResolve; });
    return { promise, resolve };
  };
  let selectedRunId = "run-a";
  let currentGeneration = 0;
  let committedState = null;
  const applyResponse = async (requestedRunId, requestGeneration, response) => {
    const nextState = await response;
    return commitPinnedStateResponse({
      requestedRunId,
      selectedRunId,
      requestGeneration,
      currentGeneration,
      nextState,
      commit: (value) => { committedState = value; }
    });
  };
  const responseA = deferred();
  const responseB = deferred();
  const pendingA = applyResponse("run-a", ++currentGeneration, responseA.promise);
  selectedRunId = "run-b";
  const pendingB = applyResponse("run-b", ++currentGeneration, responseB.promise);
  const stateB = {
    run_id: "run-b",
    topology_views: {
      projection_revision: "revision-b",
      live: { runtime_data: { graph: { nodes: [{ id: "checkout-b" }], edges: [{ id: "checkout-b->payment-b" }] } } }
    }
  };
  responseB.resolve(stateB);
  assert.equal(await pendingB, "committed");
  responseA.resolve({
    run_id: "run-a",
    topology_views: { projection_revision: "revision-a", live: { runtime_data: { graph: { nodes: [{ id: "checkout-a" }], edges: [{ id: "checkout-a->payment-a" }] } } } }
  });
  assert.equal(await pendingA, "superseded", "a late response from the previous run never commits");
  assert.equal(committedState.run_id, "run-b");
  assert.equal(committedState.topology_views.projection_revision, "revision-b");
  assert.deepEqual(committedState.topology_views.live.runtime_data.graph.nodes, [{ id: "checkout-b" }]);
  assert.deepEqual(committedState.topology_views.live.runtime_data.graph.edges, [{ id: "checkout-b->payment-b" }]);

  selectedRunId = "run-stable";
  committedState = null;
  const olderResponse = deferred();
  const newerResponse = deferred();
  const olderGeneration = ++currentGeneration;
  const pendingOlder = applyResponse("run-stable", olderGeneration, olderResponse.promise);
  const newerGeneration = ++currentGeneration;
  const pendingNewer = applyResponse("run-stable", newerGeneration, newerResponse.promise);
  const newerState = {
    run_id: "run-stable",
    topology_views: {
      projection_revision: "revision-newer",
      live: { runtime_data: { graph: { nodes: [{ id: "checkout-newer" }], edges: [{ id: "checkout-newer->payment-newer" }] } } }
    }
  };
  newerResponse.resolve(newerState);
  assert.equal(await pendingNewer, "committed");
  olderResponse.resolve({
    run_id: "run-stable",
    topology_views: {
      projection_revision: "revision-older",
      live: { runtime_data: { graph: { nodes: [{ id: "checkout-older" }], edges: [{ id: "checkout-older->payment-older" }] } } }
    }
  });
  assert.equal(await pendingOlder, "superseded", "an older response for the same run cannot roll back a newer projection");
  assert.equal(committedState.topology_views.projection_revision, "revision-newer");
  assert.deepEqual(committedState.topology_views.live.runtime_data.graph.nodes, [{ id: "checkout-newer" }]);
  assert.deepEqual(committedState.topology_views.live.runtime_data.graph.edges, [{ id: "checkout-newer->payment-newer" }]);

  const loop = { run_id: "run-action", topology: null };
  const state = { run_id: "run-action", topology_views: { run_id: "run-action", projection_revision: "revision-one" } };
  const tracker = createTopologyRefreshTracker();
  const firstKey = tracker.request(loop, state);
  assert.ok(firstKey);
  assert.equal(tracker.request(loop, state), null, "an in-flight refresh is deduplicated");
  tracker.fail(firstKey);
  assert.equal(tracker.request(loop, state), firstKey, "a 503 clears the in-flight key so the same topology refresh retries");
  tracker.succeed(firstKey);
  assert.equal(tracker.request(loop, state), null, "a completed refresh is deduplicated until identity changes");

  const topologyRaceTracker = createTopologyRefreshTracker();
  const topologyRaceLoop = { run_id: "run-topology-race", topology: { projection_revision: "topology-revision-one" } };
  const topologyRaceState = { run_id: "run-topology-race", topology_views: { run_id: "run-topology-race", projection_revision: "state-revision-zero" } };
  const topologyRaceKey = topologyRaceTracker.request(topologyRaceLoop, topologyRaceState);
  let topologyRaceGeneration = 1;
  const delayedTopologyResponse = deferred();
  const pendingTopologyResponse = (async () => {
    const nextState = await delayedTopologyResponse.promise;
    const result = commitPinnedStateResponse({
      requestedRunId: "run-topology-race",
      selectedRunId: "run-topology-race",
      requestGeneration: 1,
      currentGeneration: topologyRaceGeneration,
      nextState,
      commit: () => { throw new Error("a superseded topology response must not commit"); }
    });
    settleTopologyRefresh(topologyRaceTracker, topologyRaceKey, result === "committed");
    return result;
  })();
  topologyRaceGeneration = 2; // A newer canonical request starts, but its /api/state read fails before it can settle gen1's key.
  delayedTopologyResponse.resolve({ ...topologyRaceState, topology_views: { ...topologyRaceState.topology_views, projection_revision: "state-revision-late" } });
  assert.equal(await pendingTopologyResponse, "superseded");
  assert.equal(topologyRaceTracker.request(topologyRaceLoop, topologyRaceState), topologyRaceKey, "a late superseded topology response releases its own in-flight key after the newer request fails");
  assert.equal(settleTopologyRefresh(topologyRaceTracker, topologyRaceKey), true);
  const newerTopologyLoop = { ...topologyRaceLoop, topology: { projection_revision: "topology-revision-two" } };
  const newerTopologyKey = topologyRaceTracker.request(newerTopologyLoop, topologyRaceState);
  assert.notEqual(newerTopologyKey, topologyRaceKey);
  assert.equal(settleTopologyRefresh(topologyRaceTracker, topologyRaceKey), false, "an older request cannot settle a newer topology key");
  assert.equal(topologyRaceTracker.request(newerTopologyLoop, topologyRaceState), null, "the newer topology key remains owned until its own request settles");
  assert.equal(settleTopologyRefresh(topologyRaceTracker, newerTopologyKey), true);

  const loadingTransitions = [];
  const loadingController = createCanonicalLoadingController({ setLoading: (value) => loadingTransitions.push(value) });
  let loadingGeneration = 1;
  let loadingState = {
    run_id: "run-loading",
    topology_views: { projection_revision: "revision-before", live: { runtime_data: { graph: { nodes: [{ id: "before" }], edges: [] } } } }
  };
  const delayedForegroundSuccess = deferred();
  const foregroundSuccessToken = loadingController.begin(loadingGeneration);
  const pendingForegroundSuccess = (async () => {
    const nextState = await delayedForegroundSuccess.promise;
    const result = commitPinnedStateResponse({
      requestedRunId: "run-loading",
      selectedRunId: "run-loading",
      requestGeneration: 1,
      currentGeneration: loadingGeneration,
      nextState,
      commit: (value) => { loadingState = value; }
    });
    loadingController.settle(foregroundSuccessToken);
    return result;
  })();
  loadingGeneration = 2; // A background agent refresh starts and succeeds without taking the foreground loading token.
  const backgroundSuccess = {
    run_id: "run-loading",
    topology_views: { projection_revision: "revision-background-success", live: { runtime_data: { graph: { nodes: [{ id: "background-success" }], edges: [{ id: "background->success" }] } } } }
  };
  assert.equal(commitPinnedStateResponse({
    requestedRunId: "run-loading",
    selectedRunId: "run-loading",
    requestGeneration: 2,
    currentGeneration: loadingGeneration,
    nextState: backgroundSuccess,
    commit: (value) => { loadingState = value; }
  }), "committed");
  assert.equal(loadingController.settleSupersededBy(loadingGeneration), true, "a background canonical success settles the older foreground loading token before that request resolves");
  assert.equal(loadingController.snapshot().active, false, "the loading overlay is gone while the superseded foreground response is still pending");
  delayedForegroundSuccess.resolve({
    run_id: "run-loading",
    topology_views: { projection_revision: "revision-foreground-old", live: { runtime_data: { graph: { nodes: [{ id: "foreground-old" }], edges: [] } } } }
  });
  assert.equal(await pendingForegroundSuccess, "superseded");
  assert.equal(loadingController.snapshot().active, false, "a background success cannot leave foreground loading active");
  assert.equal(loadingState.topology_views.projection_revision, "revision-background-success");
  assert.deepEqual(loadingState.topology_views.live.runtime_data.graph.nodes, [{ id: "background-success" }]);

  const delayedForegroundFailure = deferred();
  const foregroundFailureToken = loadingController.begin(++loadingGeneration);
  const foregroundFailureGeneration = loadingGeneration;
  const pendingForegroundFailure = (async () => {
    const nextState = await delayedForegroundFailure.promise;
    const result = commitPinnedStateResponse({
      requestedRunId: "run-loading",
      selectedRunId: "run-loading",
      requestGeneration: foregroundFailureGeneration,
      currentGeneration: loadingGeneration,
      nextState,
      commit: (value) => { loadingState = value; }
    });
    loadingController.settle(foregroundFailureToken);
    return result;
  })();
  loadingGeneration += 1; // The next background refresh fails after superseding the foreground request.
  assert.equal(loadingController.settleSupersededBy(loadingGeneration), true, "a background canonical failure also settles the older foreground loading token");
  assert.equal(loadingController.snapshot().active, false, "a failed background refresh cannot leave the obsolete foreground overlay active");
  delayedForegroundFailure.resolve({
    run_id: "run-loading",
    topology_views: { projection_revision: "revision-foreground-after-background-failure", live: { runtime_data: { graph: { nodes: [{ id: "foreground-after-failure" }], edges: [] } } } }
  });
  assert.equal(await pendingForegroundFailure, "superseded");
  assert.equal(loadingController.snapshot().active, false, "a background failure cannot leave foreground loading active");
  assert.equal(loadingState.topology_views.projection_revision, "revision-background-success", "a superseded foreground response cannot roll back the canonical projection after a background failure");
  const laterForegroundToken = loadingController.begin(++loadingGeneration);
  assert.equal(loadingController.settleSupersededBy(loadingGeneration - 1), false, "an older background generation cannot clear a later foreground overlay");
  assert.deepEqual(loadingController.snapshot(), { active: true, token: laterForegroundToken, generation: loadingGeneration });
  assert.equal(loadingController.settle(laterForegroundToken), true);
  assert.deepEqual(loadingTransitions, [true, false, true, false, true, false]);

  const scheduled = [];
  const retried = [];
  let retryController;
  retryController = createPinnedRunStateRetryController({
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
    onRetry: (runId) => {
      retried.push(runId);
      retryController.succeed(runId);
    }
  });
  assert.equal(retryController.schedule("run-deep-link"), true, "a first /api/state 503 with no model schedules a pinned retry");
  assert.deepEqual(scheduled.map(({ delay }) => delay), [750]);
  scheduled[0].callback();
  assert.deepEqual(retried, ["run-deep-link"], "the scheduled retry keeps the original pinned run id");
  assert.deepEqual(retryController.snapshot(), { runId: null, attempts: 0, pending: false }, "a successful retry restores the fresh deep link and resets backoff");

  const rejectedRetries = [];
  const rejectedController = createPinnedRunStateRetryController({
    schedule: (callback, delay) => {
      rejectedRetries.push({ callback, delay });
      return rejectedRetries.length;
    },
    cancel: () => {},
    onRetry: () => {}
  });
  const scheduleOnFailure = (error) => isRetryableRequestFailure(error) && rejectedController.schedule("run-missing");
  assert.equal(scheduleOnFailure({ kind: "http", status: 404 }), false, "a missing pinned run remains a stable error instead of polling forever");
  assert.equal(rejectedRetries.length, 0);
  assert.equal(scheduleOnFailure({ kind: "http", status: 503 }), true, "a one-shot 503 schedules recovery");
  rejectedRetries[0].callback();
  assert.equal(scheduleOnFailure({ kind: "network" }), true);
  rejectedRetries[1].callback();
  assert.equal(scheduleOnFailure({ kind: "http", status: 503 }), true);
  rejectedRetries[2].callback();
  assert.equal(scheduleOnFailure({ kind: "http", status: 503 }), false, "selected-run retries stop after the bounded 750→1500→3000ms window");
  assert.deepEqual(rejectedRetries.map(({ delay }) => delay), [750, 1500, 3000]);

  let requestCount = 1;
  let retryTimerId = 0;
  const retryTimers = new Map();
  const terminalController = createPinnedRunStateRetryController({
    schedule: (callback, delay) => {
      const timer = ++retryTimerId;
      retryTimers.set(timer, { callback, delay, cancelled: false });
      return timer;
    },
    cancel: (timer) => {
      retryTimers.get(timer).cancelled = true;
    },
    onRetry: () => { requestCount += 1; }
  });
  const settlePinnedRequest = (runId, error) => {
    if (isRetryableRequestFailure(error)) return terminalController.schedule(runId);
    terminalController.cancel(runId);
    return false;
  };
  assert.equal(settlePinnedRequest("run-retry-then-missing", { kind: "http", status: 503 }), true);
  assert.deepEqual(terminalController.snapshot(), { runId: "run-retry-then-missing", attempts: 1, pending: true });
  requestCount += 1; // The operator's manual Retry receives a terminal 404 before the queued 503 retry fires.
  assert.equal(settlePinnedRequest("run-retry-then-missing", { kind: "http", status: 404 }), false);
  assert.deepEqual(terminalController.snapshot(), { runId: null, attempts: 0, pending: false });
  for (const timer of retryTimers.values()) if (!timer.cancelled) timer.callback();
  assert.equal(requestCount, 2, "the queued 503 retry is cancelled after a terminal 404 and cannot make a third request");
  assert.equal(terminalController.schedule("run-new-selection"), true);
  assert.equal(terminalController.cancel("run-retry-then-missing"), false, "a terminal response for the old run cannot cancel the new run's retry");
  assert.deepEqual(terminalController.snapshot(), { runId: "run-new-selection", attempts: 1, pending: true });

  let restoredStateRequests = 1;
  let restoredAgentLoopRequests = 0;
  let restoredTimerId = 0;
  const restoredTimers = new Map();
  const restoredSharedReconnect = createPinnedRunStateRetryController({
    schedule: (callback, delay) => {
      const timer = ++restoredTimerId;
      restoredTimers.set(timer, { callback, delay, cancelled: false });
      return timer;
    },
    cancel: (timer) => { restoredTimers.get(timer).cancelled = true; },
    onRetry: () => { restoredAgentLoopRequests += 1; }
  });
  assert.equal(restoredSharedReconnect.schedule("run-restored"), true, "a restored shared run schedules its agent-loop reconnect after a 503");
  restoredStateRequests += 1; // The operator's manual retry receives the terminal 404.
  let selectedRetryCancellation = null;
  assert.equal(cancelPinnedRunRetries({
    requestedRunId: "run-restored",
    selectedRunId: "run-restored",
    selectedStateRetry: { cancel: (runId) => { selectedRetryCancellation = runId; } },
    cancelSharedReconnect: (runId) => restoredSharedReconnect.cancel(runId)
  }), true);
  assert.equal(selectedRetryCancellation, "run-restored");
  assert.deepEqual(restoredSharedReconnect.snapshot(), { runId: null, attempts: 0, pending: false });
  for (const timer of restoredTimers.values()) if (!timer.cancelled) timer.callback();
  assert.equal(restoredStateRequests, 2, "a restored shared run stays on the terminal 404 without a third /api/state request");
  assert.equal(restoredAgentLoopRequests, 0, "the terminal 404 cancels the queued agent-loop rehydrate");
  assert.equal(restoredSharedReconnect.schedule("run-new-restored"), true);
  assert.equal(cancelPinnedRunRetries({
    requestedRunId: "run-restored",
    selectedRunId: "run-new-restored",
    selectedStateRetry: { cancel: () => { throw new Error("an old terminal response must not cancel the selected retry"); } },
    cancelSharedReconnect: (runId) => restoredSharedReconnect.cancel(runId)
  }), false);
  assert.deepEqual(restoredSharedReconnect.snapshot(), { runId: "run-new-restored", attempts: 1, pending: true }, "an old terminal response cannot cancel a new restored run reconnect");
});

function componentDetailPayload() {
  const topology = backendArchitectureView();
  const component = topology.architecture.runtime_data.graph.nodes.find(({ id }) => id === "checkout");
  const hash = "b".repeat(64);
  return {
    schema_version: "flowpulse.component-detail.v1",
    topology_projection_revision: topology.projection_revision,
    detail_revision: "c".repeat(64),
    component,
    purpose: { business_role: "Order orchestration", description: "Coordinates order placement across payment and downstream services." },
    runtime: { mode: "deterministic_replay", status: "captured", label: "deterministic replay", freshness_ms: null, observed_at: null },
    relationships: {
      upstream: [{ id: "frontend", label: "Frontend", kind: "service", relation: "calls", provenance_refs: ["capture://otel-demo-system-v1#edge-frontend-checkout"] }],
      downstream: [{ id: "payment", label: "Payment", kind: "service", relation: "calls", provenance_refs: ["capture://otel-demo-system-v1#edge-checkout-payment"] }]
    },
    observability: {
      metrics: [{ evidence_id: "ev-metric-checkout-errors", title: "Checkout error rate", source: "otel.metric", observed_at: "2026-07-16T15:43:00.000Z", record_sha256: hash, name: null, value: null, before: 0.7, after: 38.4, unit: "percent", aggregation: null, threshold: null }],
      traces: [{ evidence_id: "ev-trace-payment-refused", title: "Payment span failure", source: "otel.trace", observed_at: "2026-07-16T15:43:06.000Z", record_sha256: hash, operation: null, peer_target: "payment:9090", status: null, error: "ECONNREFUSED", trace_ref: "4f91d2b7", span_ref: null }],
      logs: [{ evidence_id: "ev-log-endpoint-fallback", title: "Checkout endpoint selection", source: "otel.log", observed_at: "2026-07-16T15:42:11.000Z", record_sha256: hash }],
      changes: [{ evidence_id: "ev-deploy-checkout", title: "Checkout deployment", source: "deployment.change", observed_at: "2026-07-16T15:42:00.000Z", record_sha256: hash, target: null, flag: null, before: "checkout:2.17.3", after: "checkout:2.18.0", applied_at: null }]
    },
    configuration: { changes: [{ evidence_id: "ev-deploy-checkout", title: "Checkout deployment", source: "deployment.change", observed_at: "2026-07-16T15:42:00.000Z", record_sha256: hash, target: null, flag: null, before: "checkout:2.17.3", after: "checkout:2.18.0", applied_at: null }] },
    data_resources: [],
    raw_payload_excluded: true
  };
}

test("component detail accepts only the exact bounded, revision-bound browser read model", () => {
  const value = componentDetailPayload();
  const accepted = componentDetailProjection(value, { nodeId: "checkout", topologyRevision: "a".repeat(64) });
  assert.equal(accepted?.component.id, "checkout");
  assert.equal(accepted?.raw_payload_excluded, true);
  assert.equal(componentDetailProjection({ ...value, raw_log: "forged" }, { nodeId: "checkout", topologyRevision: "a".repeat(64) }), null);
  assert.equal(componentDetailProjection({ ...value, topology_projection_revision: "d".repeat(64) }, { nodeId: "checkout", topologyRevision: "a".repeat(64) }), null);
  const forged = structuredClone(value);
  forged.observability.logs[0].fact = "must never cross the browser boundary";
  assert.equal(componentDetailProjection(forged, { nodeId: "checkout", topologyRevision: "a".repeat(64) }), null);
  const enriched = structuredClone(value);
  enriched.observability.logs[0] = {
    ...enriched.observability.logs[0],
    severity: "ERROR",
    summary: "checkout selected fallback payment:9090 after configuration missing",
    trace_ref: "4f91d2b7",
    span_ref: null
  };
  enriched.data_resources = [{ kind: "topic", id: "checkout-events", name: "checkout events", consumer_group: null }];
  assert.equal(componentDetailProjection(enriched, { nodeId: "checkout", topologyRevision: "a".repeat(64) })?.observability.logs[0].summary, "checkout selected fallback payment:9090 after configuration missing");
  const credentialLeak = structuredClone(enriched);
  credentialLeak.observability.logs[0].summary = "authorization=Bearer should never cross";
  assert.equal(componentDetailProjection(credentialLeak, { nodeId: "checkout", topologyRevision: "a".repeat(64) }), null);
  assert.match(appJs, /componentDetailProjection/);
  assert.match(appJs, /\/api\/components\//);
});

test("Node Live Inspector derives a compact, ordered v1 narrative without inventing data or accepting N1 early", () => {
  const detail = componentDetailProjection(componentDetailPayload(), { nodeId: "checkout", topologyRevision: "a".repeat(64) });
  const inspector = nodeLiveInspectorProjection(detail);
  assert.ok(inspector);
  assert.equal(inspector.component.id, "checkout");
  assert.equal(inspector.live_pulse.length <= 4, true);
  assert.equal(inspector.event_stream.length, 3);
  assert.deepEqual(inspector.event_stream.map(({ evidence_id }) => evidence_id), ["ev-trace-payment-refused", "ev-log-endpoint-fallback", "ev-deploy-checkout"]);
  assert.equal(inspector.dependencies.upstream.visible.length, 1);
  assert.equal(inspector.dependencies.downstream.visible.length, 1);
  assert.equal(inspector.dependencies.upstream.remaining, 0);
  assert.equal(inspector.evidence.record_count, 4);
  assert.equal(inspector.data_resources.length, 0);
  const empty = componentDetailPayload();
  empty.observability = { metrics: [], traces: [], logs: [], changes: [] };
  empty.configuration = { changes: [] };
  const emptyDetail = componentDetailProjection(empty, { nodeId: "checkout", topologyRevision: "a".repeat(64) });
  assert.deepEqual(nodeLiveInspectorProjection(emptyDetail)?.event_stream, []);
  const unsafe = componentDetailPayload();
  unsafe.observability.logs[0].title = "raw <payload> must never render";
  assert.equal(nodeLiveInspectorProjection(componentDetailProjection(unsafe, { nodeId: "checkout", topologyRevision: "a".repeat(64) })), null);
  assert.equal(nodeInvestigationN1Projection({ schema_version: "flowpulse.component-detail.v1" }), null);
  assert.equal(nodeInvestigationN1Projection({ schema_version: "flowpulse.node-investigation.n1", events: [] }), null);
});

test("Architecture accepts only the strict v2 backend topology view and retains separate control evidence", () => {
  const view = architectureViewTopology(backendArchitectureView());
  assert.ok(view);
  assert.equal(view.graph.nodes.length, 27);
  assert.equal(view.runtime_data.node_count, 22);
  assert.equal(view.runtime_data.edge_count, 26);
  assert.equal(view.control_system.node_count, 5);
  assert.equal(view.control_system.relation_count, 0);
  assert.equal(view.control_system.nodes.every((node) => Object.keys(node.detail).sort().join(",") === "activity,authority,inputs,outputs,provenance_refs,summary"), true);
  assert.equal(view.control_system.nodes.every((node) => node.detail.provenance_refs.every((ref) => /^(code|ledger):\/\//.test(ref))), true);
  assert.equal(view.external_change_evidence.relation_count, 1);
  const live = liveViewTopology(backendArchitectureView());
  assert.ok(live);
  assert.equal(live.runtime_data.graph.nodes.length, 22);
  assert.deepEqual(live.control_system.nodes.map(({ id }) => id), ["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
  assert.deepEqual(live.control_system.nodes.map(({ id, detail }) => ({ id, detail })), view.control_system.nodes.map(({ id, detail }) => ({ id, detail })));
  assert.equal(live.external_change_evidence.relation_count, 1);
  assert.deepEqual(view.graph.nodes.filter((node) => ["control", "evidence"].includes(node.plane)).map((node) => node.id).sort(), ["evaluator", "investigator", "ledger", "observer", "orchestrator"]);
  assert.equal(view.graph.edges.filter((edge) => edge.plane === "runtime").length, 26);
  assert.equal(view.graph.edges.filter((edge) => ["control", "evidence"].includes(edge.plane)).length, 0);
  const ids = new Set(view.graph.nodes.map((node) => node.id));
  assert.equal(view.graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)), true);
  const boundaries = architectureBoundaries(view.graph);
  assert.equal(boundaries.observed.nodes.length, 22);
  assert.equal(boundaries.observed.relations.length, 26);
  assert.equal(boundaries.flowpulse.nodes.length, 5);
  assert.equal(boundaries.flowpulse.internal_relations.length, 0);
  assert.equal(boundaries.cross_boundary_relations.length, 0);
  assert.equal(boundaries.observed.nodes.some((node) => ["deployment", "investigator", "evaluator", "ledger", "observer", "orchestrator"].includes(node.id)), false);
  assert.equal(boundaries.flowpulse.nodes.every((node) => ["control", "evidence"].includes(node.plane)), true);
  const positioned = new Map(architecturePositions(boundaries.observed.nodes).map((node) => [node.id, node]));
  for (const node of boundaries.observed.nodes) {
    assert.equal(positioned.get(node.id).layer, node.layer);
  }

  assert.equal(architectureViewTopology({ schema_version: "flowpulse.topology-views.v1", architecture: { graph: { nodes: topologyManifest.nodes, edges: topologyManifest.edges } } }), null);
  const invalid = backendArchitectureView();
  invalid.architecture.runtime_data.graph.edges[0] = { ...invalid.architecture.runtime_data.graph.edges[0], to: "missing" };
  assert.equal(architectureViewTopology(invalid), null);
  const unsafe = backendArchitectureView();
  unsafe.architecture.runtime_data.graph.nodes[0] = { ...unsafe.architecture.runtime_data.graph.nodes[0], raw_trace: "not browser-safe" };
  assert.equal(architectureViewTopology(unsafe), null);
  const extraControl = backendArchitectureView();
  extraControl.architecture.control_system.nodes.push({ ...extraControl.architecture.control_system.nodes[0], id: "extra-control" });
  extraControl.architecture.control_system.node_count = 6;
  assert.equal(architectureViewTopology(extraControl), null);
  const unsafeControlDetail = backendArchitectureView();
  unsafeControlDetail.architecture.control_system.nodes[0].detail.summary = "<img src=x onerror=alert(1)>";
  assert.equal(architectureViewTopology(unsafeControlDetail), null);
  const mismatchedControlDetail = backendArchitectureView();
  mismatchedControlDetail.live.control_system = structuredClone(mismatchedControlDetail.live.control_system);
  mismatchedControlDetail.live.control_system.nodes[0].detail.activity.summary = "Forged activity";
  assert.equal(architectureViewTopology(mismatchedControlDetail), null);
  const mismatchedLive = backendArchitectureView();
  mismatchedLive.live.runtime_data.graph.nodes[0] = { ...mismatchedLive.live.runtime_data.graph.nodes[0], label: "Forged" };
  assert.equal(architectureViewTopology(mismatchedLive), null);
  const invalidEvidence = backendArchitectureView();
  invalidEvidence.architecture.external_change_evidence.records[0].affected_node_ids = ["missing"];
  assert.equal(architectureViewTopology(invalidEvidence), null);
  const invalidDemo = backendArchitectureView();
  invalidDemo.demo.frames[0].node_ids = ["missing"];
  assert.equal(architectureViewTopology(invalidDemo), null);
  const extraRoot = backendArchitectureView();
  extraRoot.compatibility = true;
  assert.equal(architectureViewTopology(extraRoot), null);

  const architectureFunction = appJs.match(/function architectureTopology\(\) \{[\s\S]+?\n\}/)?.[0] || "";
  assert.match(architectureFunction, /architectureViewTopology\(state\?\.topology_views\)/);
  assert.doesNotMatch(architectureFunction, /sourceState\(|TWIN_NODES|TWIN_EDGES/);
  assert.match(appJs, /function architectureView\(\) \{[\s\S]+architectureViewTopology\(state\?\.topology_views\)/);
  assert.match(appJs, /architecture-observed-system/);
  assert.match(appJs, /architecture-flowpulse-system/);
  assert.match(appJs, /architectureBoundaries\(topology\)/);
  assert.match(appJs, /architectureThumbnailMarkup/);
  assert.match(appJs, /controlSystemTileMarkup/);
  assert.doesNotMatch(appJs, /Cross-boundary evidence summary|architectureComponentContext/);
});

test("active demo topology preserves the bounded causal evidence order and renders the incident overlay", () => {
  const active = activeDemoTopologyView();
  const architecture = architectureViewTopology(active);
  const live = liveViewTopology(active);
  const diagnose = diagnoseViewTopology(active);
  assert.ok(architecture);
  assert.ok(live);
  assert.ok(diagnose);
  assert.equal(live.incident_overlay.status, "active");
  assert.deepEqual(live.incident_overlay.node_ids, ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"]);
  assert.equal(diagnose.overlay.status, "available");
  assert.equal(diagnose.projection_revision, active.projection_revision);
  assert.deepEqual(diagnose.overlay.node_ids, ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"]);
  assert.deepEqual(diagnose.overlay.edges.map(({ id }) => id), ["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"]);
  assert.deepEqual(active.demo.frames[3].evidence_refs, ["ev-metric-kafka-lag", "ev-log-consumer-delay"]);
  const unsafe = activeDemoTopologyView();
  unsafe.demo.frames[4].evidence_refs.push("ev-untrusted");
  assert.equal(architectureViewTopology(unsafe), null);
});

test("light and pure-black themes have a persisted accessible toggle", () => {
  assert.match(indexHtml, /id="theme-toggle"[^>]+aria-label="Switch to pure black theme"/);
  assert.match(appJs, /localStorage\.setItem\("flowpulse-theme", theme\)/);
  assert.match(appJs, /flowpulse-theme=\$\{theme\}/);
  assert.match(stylesCss, /:root\[data-theme="dark"\]/);
  assert.match(stylesCss, /\.theme-toggle:focus-visible/);
});

test("the product opens on architecture and keeps advanced actions in an accessible menu", () => {
  assert.match(indexHtml, /id="app-shell"[^>]+data-mode="architecture"/);
  assert.match(indexHtml, /data-mode="architecture">Architecture</);
  assert.match(indexHtml, /data-mode="incident">Incident</);
  assert.doesNotMatch(indexHtml, /Recovery Console|data-mode="replay">Diagnose|data-mode="compare">Compare/);
  assert.match(indexHtml, /id="workspace-menu"[^>]*class="workspace-menu"/);
  assert.match(indexHtml, /id="live-button"[^>]*>Run GPT-5\.6</);
  assert.match(indexHtml, /id="details-button"[^>]*>Inspect run</);
  assert.match(appJs, /let mode = "architecture"/);
  assert.match(stylesCss, /\.mission-bar \{[^}]+display: flex;[^}]+justify-content: center;/s);
  assert.match(stylesCss, /\.mission-summary \{[^}]+clip-path: inset\(50%\)/s);
  assert.match(stylesCss, /\.stage-readout \{ display: none;/);
});

test("the shared header omits nonessential capture, theme, and workspace-menu chrome", () => {
  assert.match(stylesCss, /\.topbar-status \{ display: none; \}/);
});

test("initial rendering does not wait for optional development diagnostics", () => {
  const refreshSource = appJs.slice(appJs.indexOf("async function refresh({ synchronizeIncidentStage = false, topologyRefreshKey = null } = {})"), appJs.indexOf("function render()"));
  assert.match(refreshSource, /const requestGeneration = beginCanonicalStateRequest\(\);[\s\S]*?const nextState = await request\(browserStatePath\(requestedRunId\)\);/);
  assert.match(refreshSource, /void refreshDevelopmentStatus\(\);/);
  assert.doesNotMatch(refreshSource, /Promise\.all\(/);
  assert.match(appJs, /async function refreshDevelopmentStatus\(\)/);
  assert.match(appJs, /function browserStatePath\(runId = selectedRunId\)[\s\S]*runId !== null/);
  assert.match(appJs, /function readRequestedRunId\(\)[\s\S]*get\("run_id"\)/);
  assert.match(appJs, /function bindCanonicalRunSelection\(loop\)[\s\S]*history\.replaceState/);
});

test("architecture is a static four-layer overview with backend-owned status dots", () => {
  const observed = new Set(["load-generator", "frontend-web", "frontend-proxy", "frontend", "checkout", "cart", "payment", "currency", "shipping", "product-catalog", "recommendation", "ad", "email", "kafka", "accounting", "fraud-detection", "quote", "image-provider", "flagd", "telemetry-docs", "otelcol-contrib", "astronomy-db"]);
  const nodes = ARCHITECTURE_LAYERS.flatMap((layer) => layer.ids.filter((id) => observed.has(id)).map((id, index) => ({ id, label: id, kind: index === 0 ? "client" : "service" })));
  const first = architecturePositions(nodes);
  const second = architecturePositions([...nodes].reverse());
  const coordinates = (items) => Object.fromEntries(items.map(({ id, layer, x, y }) => [id, { layer, x, y }]));
  assert.deepEqual(coordinates(first), coordinates(second));
  assert.deepEqual([...new Set(first.map(({ layer }) => layer))], ARCHITECTURE_LAYERS.map(({ id }) => id));
  assert.ok(ARCHITECTURE_LAYERS.every(({ description }) => typeof description === "string" && description.length > 0));
  assert.ok(first.every(({ x, y }) => x >= 6 && x <= 94 && y >= 18 && y <= 82));
  assert.deepEqual([...new Set(first.map(({ layerSize }) => layerSize))], [2, 4, 6, 10]);
  for (const y of new Set(first.map((node) => node.y))) {
    const xs = first.filter((node) => node.y === y).map((node) => node.x).sort((a, b) => a - b);
    for (let index = 1; index < xs.length; index++) assert.ok((xs[index] - xs[index - 1]) * 12.8 >= 116);
  }
  assert.equal(architecturePositions([...nodes, { id: "agent", label: "Investigator", kind: "service", plane: "control", layer: "investigation" }]).some((node) => node.id === "agent"), false);
  assert.deepEqual(Object.fromEntries(ARCHITECTURE_LAYERS.map((layer) => [layer.id, topologyManifest.nodes.filter((node) => node.layer === layer.id).length])), {
    experience: 6,
    commerce: 9,
    processing: 3,
    platform: 4
  });
  assert.equal(ARCHITECTURE_LAYERS.find((layer) => layer.id === "experience")?.label, "Client applications");
  assert.equal(ARCHITECTURE_LAYERS.find((layer) => layer.id === "experience")?.description, "browser and traffic-entry services");
  assert.match(appJs, /if \(layout === "architecture"\) \{[\s\S]+architecture-systems/);
  assert.match(appJs, /architecture-observed-system/);
  assert.match(appJs, /architecture-flowpulse-system/);
  assert.match(appJs, /architecture-layer-grid/);
  assert.match(appJs, /architecture-layer-anatomy/);
  assert.match(appJs, /data-architecture-member-count/);
  assert.match(appJs, /data-architecture-thumbnail-id/);
  assert.match(appJs, /layer\.members\.map\(\(node\)/);
  assert.doesNotMatch(appJs, /layer\.members\.slice\(0, 4\)/);
  assert.match(appJs, /data-architecture-layer="\$\{escapeHtml\(layer\.id\)\}"/);
  assert.match(appJs, /function architectureLayerStatus\(/);
  assert.doesNotMatch(appJs, /ARCHITECTURE_LAYER_SUMMARIES|architectureLayerStatusSummary|architecture-layer-role|data-architecture-layer-status-summary/);
  assert.match(appJs, /function controlSystemTileMarkup\(/);
  assert.match(appJs, /data-control-node-id/);
  assert.match(appJs, /node-status-dot is-\$\{escapeHtml\(node\.status \|\| "idle"\)\}/);
  assert.match(appJs, /function openControlDetail\(id, \{ focus = false \} = \{\}\)/);
  assert.match(appJs, /openControlDetail\(event\.target\.dataset\.controlNodeId, \{ focus: true \}\)/);
  assert.match(appJs, /data-control-detail-id/);
  assert.match(appJs, /class="architecture-control-slot" aria-hidden="true"/);
  assert.match(appJs, /architectureDetail\?\.scope === mode && event\.key === "Escape"/);
  assert.match(appJs, /function controlComponentDetailMarkup\(/);
  assert.doesNotMatch(appJs, /live-control-system|data-live-control|data-control-scope/);
  assert.match(appJs, /architecture-status-dot/);
  assert.match(appJs, /data-architecture-control-id/);
  assert.match(appJs, /let architectureDetail = null;/);
  assert.match(appJs, /function architectureDetailContext\(id\)/);
  assert.match(appJs, /function architectureComponentDetailMarkup\(context\)/);
  assert.match(appJs, /const COMPONENT_EXPLANATIONS = Object\.freeze/);
  assert.match(appJs, /data-architecture-detail-id/);
  assert.doesNotMatch(appJs, /data-architecture-back|Back to components/);
  assert.match(appJs, /if \(architectureDetailSurface\) \{/);
  assert.match(appJs, /closeArchitectureDetail\(\{ restoreFocus: false \}\)/);
  assert.match(appJs, /closeArchitectureDetail\(\{ restoreFocus: true \}\)/);
  assert.match(appJs, /architectureDetail\?\.scope === mode && event\.key === "Escape"/);
  assert.match(appJs, /data-architecture-detail-id="\$\{escapeHtml\(node\.id\)\}" tabindex="-1"/);
  assert.match(appJs, /async function openArchitectureDetail\(id\)/);
  assert.match(appJs, /function closeArchitectureDetail\(\{ restoreFocus = false \} = \{\}\)/);
  assert.match(appJs, /event\.target\.matches\("\[data-architecture-thumbnail-id\]"\)/);
  assert.match(appJs, /mode === "architecture" \|\| mode === "live" \|\| isUnifiedRailWorkspace\(\)/);
  assert.match(appJs, /item\?\.id === id && \["runtime", "data"\]\.includes\(item\.plane\)/);
  assert.match(appJs, /nodeById\.has\(edge\.from\) && nodeById\.has\(edge\.to\)/);
  assert.match(appJs, /edge\.from === id \|\| edge\.to === id/);
  assert.match(appJs, /slice\(0, 8\)/);
  assert.match(architectureComponentDetailSource, /componentRelationsMarkup\("Depends on", projection\.relationships\.downstream\)/);
  assert.match(architectureComponentDetailSource, /componentRelationsMarkup\("Depended on by", projection\.relationships\.upstream\)/);
  assert.match(architectureComponentDetailSource, /componentObservabilityMarkup\(projection\.observability\)/);
  assert.doesNotMatch(architectureComponentDetailSource, /relationList\("Uses", incoming/);
  assert.doesNotMatch(architectureComponentDetailSource, /No signal summary|No provenance reference/);
  assert.match(appJs, /node\.layer === layer\.id/);
  assert.match(appJs, /dataset\.runtimeEdges/);
  assert.match(appJs, /dataset\.controlRelations/);
  assert.doesNotMatch(appJs, /architecture-edge-map|queueArchitectureRelationRender|architectureRelationPath|data-architecture-edge/);
  assert.doesNotMatch(stylesCss, /\.architecture-edge-map|\.architecture-edge-line|\.architecture-edge-group/);
  assert.match(stylesCss, /\.architecture-layer-grid \{[^}]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(architectureRefinementCss, /--architecture-vector: #58758e;/);
  assert.match(architectureRefinementCss, /\.architecture-observed-system \{[^}]+background: transparent;[^}]+box-shadow: none;[^}]+backdrop-filter: none;/s);
  assert.match(architectureRefinementCss, /\.architecture-thumbnail-node \{[^}]+min-height: 54px;[^}]+grid-template-columns: 32px minmax\(0, 1fr\);[^}]+border-radius: var\(--architecture-node-radius\);/s);
  assert.match(stylesCss, /\.control-system-tile \{[\s\S]+?height: 54px;[\s\S]+?grid-template-columns: 32px minmax\(0, 1fr\) auto;/);
  assert.match(stylesCss, /\.is-architecture-source \{[\s\S]+?--control-system-surface:/);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.is-architecture-source \{/);
  assert.doesNotMatch(stylesCss, /live-control-system/);
  assert.match(stylesCss, /\.control-component-detail:focus-visible \{ outline: 2px solid var\(--blue\);/);
  assert.match(stylesCss, /\.control-system-tile \.node-status-dot\.is-recording,[\s\S]+?--control-status: var\(--green\);/);
  assert.match(appJs, /function agentTeamHomeMarkup\(controls\)/);
  assert.match(stylesCss, /\.architecture-flowpulse-system\.is-detail \{[\s\S]+?background: rgba\(255, 255, 255, \.88\);/);
  assert.match(stylesCss, /\.architecture-flowpulse-nodes\.is-detail \{[\s\S]+?flex: 1;/);
  assert.match(stylesCss, /\.control-component-detail \{[\s\S]+?height: 100%;[\s\S]+?background: transparent;/);
  assert.match(architectureRefinementCss, /@media \(max-width: 1320px\) \{[\s\S]+?\.architecture-layer-anatomy \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: 7px; \}/);
  assert.match(stylesCss, /\.control-system-tile \.node-icon,[\s\S]+?color: var\(--architecture-vector\);/s);
  assert.match(architectureDetailCss, /--architecture-vector: #111827;/);
  assert.match(architectureDetailCss, /\.architecture-thumbnail-node,[\s\S]+?\.source-node\.is-architecture-compact \{[\s\S]+?background: rgba\(255, 255, 255, \.9\);/);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.workspace-menu-panel,[\s\S]+?\.state-key \{[^}]+border: 0;[^}]+background: rgba\(255, 255, 255, \.3\);/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.context-drawer \{[^}]+background: rgba\(249, 251, 252, \.36\);/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.canvas-toolbar \{[^}]+display: none;/s);
  assert.match(architectureStaticCss, /\.architecture-layer-module,[\s\S]+?\.context-drawer \{[\s\S]+?box-shadow: none;/);
  assert.match(architectureStaticCss, /\.architecture-thumbnail-node,[\s\S]+?\.source-node\.is-architecture-compact \{[\s\S]+?background: var\(--architecture-node-surface\);/);
  assert.match(architectureStaticCss, /\.architecture-thumbnail-icon,[\s\S]+?\.node-icon \{[\s\S]+?color: var\(--architecture-vector\);/);
  assert.match(architectureStaticCss, /\.architecture-status-dot,[\s\S]+?\.node-status-dot \{[\s\S]+?background: var\(--architecture-status\);/);
  assert.match(architectureStaticCss, /--architecture-status: var\(--green\);/);
  assert.match(architectureStaticCss, /is-healthy[\s\S]+?--architecture-status: var\(--green\);/);
  assert.match(architectureStaticCss, /is-impact[\s\S]+?--architecture-status: var\(--red\);/);
  assert.match(architectureStaticCss, /is-fault[\s\S]+?--architecture-status: var\(--red\);/);
  assert.match(architectureStaticCss, /is-pending[\s\S]+?--architecture-status: var\(--amber\);/);
  assert.match(architectureStaticCss, /is-sleeping[\s\S]+?--architecture-status: var\(--faint\);/);
  assert.match(architectureStaticCss, /Architecture interaction: flat selection feedback and bounded layer summaries/);
  assert.match(architectureStaticCss, /\.architecture-layer-role \{ max-width: 78%; \}/);
  assert.match(architectureStaticCss, /\.architecture-thumbnail-node:hover,[\s\S]+?\.source-node\.is-architecture-compact\.is-selected \{[\s\S]+?transform: translateY\(-2px\);[\s\S]+?background: var\(--architecture-node-surface\);[\s\S]+?box-shadow: none;/);
  assert.match(architectureStaticCss, /\.architecture-thumbnail-node:focus-visible,[\s\S]+?outline: 2px solid var\(--blue\);/);
  assert.match(architectureStaticCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]+?\.architecture-thumbnail-node:hover,[\s\S]+?transform: none;/);
  assert.match(architectureHoverCss, /\.architecture-thumbnail-node:hover,[\s\S]+?\.source-node\.is-architecture-compact:hover \{[\s\S]+?outline: none;[\s\S]+?background: rgba\(255, 255, 255, \.9\);[\s\S]+?box-shadow: none;/);
  assert.match(architectureHoverCss, /\.architecture-thumbnail-node:focus-visible,[\s\S]+?outline: 2px solid var\(--blue\);/);
  assert.match(architectureHoverCss, /Detail stays inside its own macro layer; long projected facts scroll locally/);
  assert.match(architectureHoverCss, /\.architecture-layer-module\.is-detail \{[\s\S]+?overflow: hidden;/);
  assert.match(architectureHoverCss, /\.architecture-component-detail \{[\s\S]+?height: 100%;[\s\S]+?overflow-y: auto;[\s\S]+?overscroll-behavior: contain;/);
  assert.match(appJs, /"fault", "pending", "warning"/);
  assert.match(architectureDetailCss, /\.app-shell\[data-mode="architecture"\] \{[\s\S]+?background: #e9eef1;/);
  assert.match(architectureDetailCss, /\.twin-workspace,[\s\S]+?\.twin-scroll \{ background: #e9eef1; \}/);
  assert.match(architectureDetailCss, /\.architecture-layer-module,[\s\S]+?\.architecture-flowpulse-system \{[\s\S]+?background: rgba\(211, 220, 226, \.66\);/);
  assert.match(architectureDetailCss, /\.architecture-layer-module\.is-detail \{ background: rgba\(255, 255, 255, \.78\); \}/);
  assert.match(architectureDetailCss, /\.architecture-component-detail \{[\s\S]+?display: grid;/);
  assert.match(architectureDetailCss, /\.architecture-detail-purpose \{ display: grid; gap: 4px; \}/);
  assert.match(architectureDetailCss, /\.architecture-detail-facts \{[\s\S]+?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(architectureDetailCss, /Architecture 2D transparency correction[\s\S]+?\.mode-switch,[\s\S]+?box-shadow: none;/);
  assert.match(architectureStaticCss, /\.is-architecture-compact \{[\s\S]+?display: grid;/);
  assert.match(stylesCss, /\.is-architecture-source \.source-node\.is-architecture-compact \{[^}]+border: 0;[^}]+border-radius: var\(--architecture-node-radius\);/s);
  assert.match(stylesCss, /--architecture-page-radius: 22px;[\s\S]+--architecture-system-radius: 22px;[\s\S]+--architecture-node-radius: 14px;[\s\S]+--architecture-control-radius: 14px;/);
  assert.match(stylesCss, /--architecture-font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif;/);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-system \{[^}]+border: 0;[^}]+background: var\(--architecture-surface\);/s);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-flowpulse-system \{[^}]+background: var\(--architecture-surface-muted\);/s);
  assert.match(stylesCss, /@media \(prefers-reduced-transparency: reduce\)[\s\S]+backdrop-filter: none;/s);
  assert.match(stylesCss, /@supports not \(\(backdrop-filter: blur\(1px\)\)/);
  assert.match(appJs, /service\.name=\$\{node\.id\}/);
  assert.match(appJs, /telemetry\.sdk\.language/);
  assert.doesNotMatch(appJs, /const origin = architecture \?/);
  assert.match(appJs, /class="visually-hidden">Observed System Data Source Architecture/);
  assert.doesNotMatch(appJs, /<header class="architecture-system-heading" data-system="observed">/);
  assert.doesNotMatch(appJs, /<strong>Data Source Architecture<\/strong>/);
  assert.doesNotMatch(appJs, /runtime and data source projection/);
  assert.doesNotMatch(appJs, /Technology stack overview/);
  assert.doesNotMatch(appJs, /metric-checkout-label"\]\.textContent = "Observed system"/);
  assert.doesNotMatch(appJs, /metric-payment-label"\]\.textContent = "Runtime dependencies"/);
});

test("Stage C Live layout keeps the backend layer ordering with room for later paths", () => {
  const nodes = LIVE_LAYERS.flatMap((layer) => layer.ids.map((id, index) => ({ id, label: id, kind: index === 0 ? "client" : "service" })));
  const first = livePositions(nodes);
  const second = livePositions([...nodes].reverse());
  const coordinates = (items) => Object.fromEntries(items.map(({ id, layer, x, y }) => [id, { layer, x, y }]));
  assert.deepEqual(coordinates(first), coordinates(second));
  assert.deepEqual([...new Set(first.map(({ layer }) => layer))], LIVE_LAYERS.map(({ id }) => id));
  assert.deepEqual(LIVE_LAYERS.map(({ ids }) => ids.length), [6, 9, 3, 4]);
  assert.deepEqual([...new Set(first.map(({ x }) => x))], [10, 30, 50, 70]);
  assert.ok(first.every(({ y }) => y >= 6.25 && y <= 93.75));
  assert.doesNotMatch(stylesCss, /\.architecture-guides/);
  assert.match(stylesCss, /\.live-guides span[^}]+top: 10px/s);
  assert.match(appJs, /livePositions\(topology\.nodes\)/);
  assert.match(indexHtml, /id="zoom-out"[^>]+aria-label="Zoom out"/);
  assert.match(indexHtml, /id="zoom-in"[^>]+aria-label="Zoom in"/);
  assert.match(indexHtml, /id="zoom-controls"[^>]+aria-label="Canvas zoom"/);
  assert.match(appJs, /minScale: \.6, maxScale: 1\.6/);
  assert.match(appJs, /function containedLiveView/);
  assert.match(appJs, /containedCanvasView\(\{[\s\S]+?worldWidth: LIVE_WORLD\.width,[\s\S]+?worldHeight: LIVE_WORLD\.height,/);
  assert.match(appJs, /live-column-\$\{node\.layerIndex\} live-count-\$\{node\.layerSize\} live-index-\$\{node\.layerPosition\}/);
  const sourceCanvasSource = appJs.slice(appJs.indexOf("function renderSourceCanvas"), appJs.indexOf("function architectureLayerStatus"));
  assert.doesNotMatch(sourceCanvasSource, /style="left:\$\{Number\(node\.x\)\.toFixed\(3\)/);
  assert.match(stylesCss, /\.is-live-source \.live-column-0 \{ left: 10%; \}/);
  assert.match(stylesCss, /\.is-live-source \.live-count-9\.live-index-8 \{ top: 93\.75%; \}/);
});

test("Recovery compact canvas keeps canonical cards and endpoints inside its reserved workspace", () => {
  const recoverySource = appJs.slice(appJs.indexOf("function canonicalRecoveryTopologyMarkup"), appJs.indexOf("function renderTwinLayer"));
  assert.match(recoverySource, /incidentFocusLayerMarkup\(topology, topology\?\.current, \{ layerName: "current", workspace: "recovery", pulse: true \}\)/);
  assert.match(recoverySource, /data-canonical-node-count="\$\{focus\.visual\.node_ids\.length\}"/);
  assert.match(stylesCss, /\.recovery-topology-map \.incident-focus-workspace \.incident-focus-node/);
});

test("canonical Incident, Diagnose, and Compare keep a bounded pan and zoom canvas at constrained viewports", () => {
  assert.equal(isCanvasNavigationMode("live"), true);
  assert.equal(isCanvasNavigationMode("incident"), true);
  assert.equal(isCanvasNavigationMode("replay"), true);
  assert.equal(isCanvasNavigationMode("compare"), true);
  assert.equal(isCanvasNavigationMode("agents"), false);

  const constrained = containedCanvasView({
    viewportWidth: 840,
    viewportHeight: 430,
    worldWidth: 1480,
    worldHeight: 680,
    minScale: .6,
    maxScale: 1,
    inset: 24
  });
  assert.equal(constrained.scale, .6);
  assert.equal(constrained.pan_required, true);
  assert.ok(constrained.x < 0);

  const fitted = containedCanvasView({
    viewportWidth: 1280,
    viewportHeight: 720,
    worldWidth: 1480,
    worldHeight: 680,
    minScale: .6,
    maxScale: 1,
    inset: 24
  });
  assert.ok(fitted.scale > .6 && fitted.scale < 1);
  assert.equal(fitted.pan_required, false);
  assert.match(appJs, /els\["zoom-controls"\]\.hidden = !isCanvasNavigationMode\(mode\);/);
  assert.match(appJs, /if \(!isCanvasNavigationMode\(mode\)\) return;/);
  assert.match(appJs, /if \(!liveView\.initialized \|\| renderedMode !== mode\) resetLiveView\(\);/);
  assert.match(stylesCss, /\.app-shell\[data-mode="replay"\] \.zoom-controls:not\(\[hidden\]\),[\s\S]+?\.app-shell\[data-mode="incident"\] \.zoom-controls:not\(\[hidden\]\),[\s\S]+?\.app-shell\[data-mode="compare"\] \.zoom-controls:not\(\[hidden\]\)/);
});

test("pending canonical canvases clear every ready identity and test selector", () => {
  const clearSource = appJs.match(/function clearCanonicalCanvasIdentity\(\) \{[\s\S]+?\n\}/)?.[0] || "";
  assert.match(clearSource, /delete els\["twin-canvas"\]\.dataset\[key\]/);
  assert.match(clearSource, /setAttribute\("data-testid", "canonical-topology-pending"\)/);
  assert.doesNotMatch(clearSource, /diagnose-canvas|compare-canvas|recovery-canvas/);
});

test("workspace navigation binds only mode buttons so app-shell state cannot reset a clicked tab", () => {
  assert.equal([...appJs.matchAll(/document\.querySelectorAll\("button\.mode-button\[data-mode\]"\)/g)].length, 2);
  assert.doesNotMatch(appJs, /for \(const button of document\.querySelectorAll\("\[data-mode\]"\)\) button\.addEventListener\("click", \(\) => setMode/);
  assert.match(appJs, /const label = isIncidentWorkspace\(\) \? "Incident workspace"/);
  assert.match(appJs, /function setIncidentStage\(nextStage\)/);
  assert.match(appJs, /data-incident-stage/);
  const modeSource = appJs.slice(appJs.indexOf("function setMode"), appJs.indexOf("function configureCanvasWorld"));
  assert.match(modeSource, /const serverFocusReady = nextMode === "replay"[\s\S]+?incidentFocusWorkspace\(/);
  assert.match(modeSource, /shared\.workspace_actions\?\.\[requiredAction\]\?\.available !== true && !serverFocusReady/);
  assert.match(modeSource, /Recovery and Compare remain governed solely by their[\s\S]+?server action gates/);
});

test("live topology normalizes endpoints and explains true telemetry islands", () => {
  const projected = topologyIntegrity({
    nodes: [{ id: "Frontend Web" }, { id: "checkout" }, { id: "telemetry_docs" }],
    edges: [
      { id: "web-checkout", from: "frontend_web", to: "checkout" },
      { id: "bad", from: "checkout", to: "missing-service" }
    ]
  });
  assert.deepEqual(projected.edges.map(({ from, to }) => [from, to]), [["frontend-web", "checkout"]]);
  assert.deepEqual(projected.invalid_edges.map(({ id }) => id), ["bad"]);
  assert.deepEqual(projected.unlinked_node_ids, ["telemetry-docs"]);
  assert.equal(projected.nodes.find(({ id }) => id === "telemetry-docs").connectivity, "unlinked");
  assert.match(appJs, /Insufficient dependency evidence/);
});

test("Live consumes only the strict v2 runtime view and never uses the six-node compatibility topology", () => {
  const projected = topologyIntegrity({
    services: [
      { id: "frontend", kind: "client" }, { id: "checkout", kind: "service" }, { id: "payment", kind: "api" },
      { id: "kafka", kind: "stream" }, { id: "accounting", kind: "worker" }, { id: "fraud", kind: "worker" }
    ],
    dependencies: [
      { id: "frontend-checkout", from: "frontend", to: "checkout" },
      { id: "checkout-payment", from: "checkout", to: "payment" },
      { id: "checkout-kafka", from: "checkout", to: "kafka" },
      { id: "kafka-accounting", from: "kafka", to: "accounting" },
      { id: "kafka-fraud", from: "kafka", to: "fraud" }
    ]
  });
  assert.equal(projected.nodes.length, 6);
  assert.equal(projected.edges.length, 5);
  assert.deepEqual(primaryLiveEdges(projected).map(({ id }) => id), [
    "checkout-kafka", "checkout-payment", "frontend-checkout", "kafka-accounting", "kafka-fraud"
  ]);
  assert.match(appJs, /function liveTopologyView\(\) \{[\s\S]+liveViewTopology\(state\?\.topology_views\)/);
  assert.match(appJs, /const live = layout === "live" \? liveTopologyView\(\) : null;/);
  assert.match(appJs, /live\?\.runtime_data\.graph\s*\? topologyIntegrity\(/);
  assert.match(appJs, /edges: \[\.\.\.live\.runtime_data\.graph\.edges, \.\.\.\(live\.runtime_data\.supporting_relations \|\| \[\]\)\]/);
  assert.doesNotMatch(appJs.match(/function renderSourceCanvas\(layout\) \{[\s\S]+?\n\}/)?.[0] || "", /source\.topology/);
  const metricsSource = appJs.slice(appJs.indexOf("function renderMetrics"), appJs.indexOf("function setMetric"));
  assert.match(metricsSource, /const source = mode === "live" \? liveSource\(live\) : sourceState\(\);/);
  assert.match(metricsSource, /topologyIntegrity\(live\?\.runtime_data\.graph \|\| \{ nodes: \[\], edges: \[\] \}\)/);
  assert.match(appJs, /Live projection unavailable/);
  assert.match(stylesCss, /\.twin-canvas\.is-live-source \{[\s\S]+?border-radius: var\(--architecture-page-radius\);/);
  assert.match(stylesCss, /\.is-live-source \.source-node \{[\s\S]+?border: 0;[\s\S]+?border-radius: var\(--architecture-node-radius\);[\s\S]+?box-shadow: none;/);
  assert.match(appJs, /event\.target\.matches\("\[data-node-id\], \[data-edge-id\], \[data-agent-edge-id\]"\)/);
  assert.match(appJs, /event\.target\.dataset\.nodeId\) openDrawer\(\{ type: "node"/);
});

test("control details use a supported Observer glyph and render only bounded projected activity facts", () => {
  const controlDetailSource = appJs.slice(appJs.indexOf("function controlComponentDetailMarkup"), appJs.indexOf("function openArchitectureDetail"));
  assert.match(appJs, /observer: "binoculars"/);
  assert.match(controlDetailSource, /controlActivityMarkup\(detail\.activity\)/);
  assert.match(controlDetailSource, /Current activity/);
  assert.match(controlDetailSource, /Last recorded event/);
  assert.match(controlDetailSource, /Evidence references/);
  assert.match(controlDetailSource, /Gate result/);
  assert.match(controlDetailSource, /Source status/);
  assert.doesNotMatch(controlDetailSource, /payload|prompt|token|secret|raw_log/i);
});

test("Live keeps shared node identities while rendering every canonical runtime path and repeated pulses", () => {
  const renderSourceCanvasSource = appJs.slice(appJs.indexOf("function renderSourceCanvas"), appJs.indexOf("function architectureLayerStatus"));
  const runtime = topologyIntegrity({ nodes: topologyManifest.nodes, edges: topologyManifest.edges });
  assert.match(appJs, /data-transition-key="\$\{escapeHtml\(transitionKey\(node\.id\)\)\}"/);
  assert.match(appJs, /querySelectorAll\("\[data-transition-key\]"\)/);
  assert.match(appJs, /node\.classList\.contains\("twin-node"\)/);
  assert.equal(runtime.nodes.length, 22);
  assert.equal(runtime.edges.length, 26);
  assert.equal(runtime.edges.every((edge) => runtime.nodes.some((node) => node.id === edge.from) && runtime.nodes.some((node) => node.id === edge.to)), true);
  assert.match(renderSourceCanvasSource, /const runtimeEdges = topology\.edges/);
  assert.match(renderSourceCanvasSource, /fixed-live-edge-map/);
  assert.match(renderSourceCanvasSource, /liveEdgePath\(positions\.get\(edge\.from\), positions\.get\(edge\.to\)/);
  assert.doesNotMatch(renderSourceCanvasSource, /LIVE_ROUTE_WORLD/);
  assert.doesNotMatch(renderSourceCanvasSource, /class="pulse-flow is-\$\{edgeState\}"/);
  assert.doesNotMatch(renderSourceCanvasSource, /plannedLiveRoutes/);
  assert.doesNotMatch(renderSourceCanvasSource, /renderLiveChange\(/);
  assert.doesNotMatch(appJs, /function renderMeasuredLiveRoutes\(/);
  const fixedRouteRendererSource = appJs.slice(appJs.indexOf("function fixedLiveEdgeMarkup"), appJs.indexOf("function positionLiveProjectile"));
  assert.doesNotMatch(fixedRouteRendererSource, /getBoundingClientRect\(\)/);
  assert.match(appJs, /data-live-route="canonical-authored"/);
  assert.match(appJs, /class="signal-projectile signal-projectile-core" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000" d="\$\{path\}"/);
  assert.match(appJs, /function positionLiveProjectile\(path, projectile, progress, pathLength\)/);
  assert.match(appJs, /const packetLength = Math\.min\(68, Math\.max\(32, pathLength \* \.065\)\);/);
  assert.match(appJs, /projectile\.setAttribute\("stroke-dasharray",/);
  assert.match(appJs, /signal-projectile-halo" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000"/);
  assert.match(appJs, /signal-projectile-core" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000"/);
  assert.match(appJs, /positionLiveProjectile\(path, halo, 0, pathLength\);[\s\S]*?positionLiveProjectile\(path, core, 0, pathLength\);[\s\S]*?group\.classList\.add\("is-signal-active"\);/);
  assert.doesNotMatch(appJs, /function pathTrail\(/);
  assert.doesNotMatch(appJs, /<circle class="signal-projectile/);
  assert.match(stylesCss, /\.is-live-source \.edge-group \.edge-line \{[\s\S]*?stroke-width: 1\.45;[\s\S]*?stroke-dasharray: 1000;/);
  assert.match(stylesCss, /\.is-live-source \.signal-projectile-halo \{ stroke: var\(--edge-signal\); stroke-width: 5;/);
  assert.doesNotMatch(stylesCss, /relation-telemetry_export \.edge-line \{[^}]*stroke-dasharray/);
  assert.match(renderSourceCanvasSource, /\$\{runtimeEdges\.length\} projected dependency paths are rendered/);
  assert.match(indexHtml, /id="operations-team-rail"/);
});

test("Live keeps the shared header fixed, hides metric noise, and uses a bounded 2D detail surface", () => {
  assert.match(stylesCss, /\.mode-button\.is-active\s*\{\s*color: #ffffff;\s*background: var\(--blue\);\s*\}/);
  assert.match(stylesCss, /\.app-shell\[data-mode="architecture"\] \.mission-bar,\s*\.app-shell\[data-mode="live"\] \.mission-bar/s);
  assert.match(stylesCss, /Architecture\/Live shared shell[\s\S]+?\.app-shell\[data-mode="architecture"\],\s*\.app-shell\[data-mode="live"\]/);
  assert.match(stylesCss, /Architecture\/Live shared shell[\s\S]+?\.mission-bar\s*\{[\s\S]+?height: 64px;/);
  assert.match(stylesCss, /Architecture\/Live shared shell[\s\S]+?\.mode-switch\s*\{[\s\S]+?width: 710px;[\s\S]+?min-width: 710px;/);
  assert.match(stylesCss, /\.app-shell\[data-mode="live"\] \.metric-cluster\s*\{\s*display: none;/);
  assert.match(stylesCss, /\.app-shell\[data-mode="live"\] \.canvas-toolbar\s*\{\s*grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(stylesCss, /\.app-shell\[data-mode="live"\]\s*\{[\s\S]*?--architecture-system-radius: 20px;[\s\S]*?--architecture-node-radius: 16px;[\s\S]*?--architecture-control-radius: 12px;/);
  const liveNodeInteractionCss = stylesCss.slice(stylesCss.indexOf(".app-shell[data-mode=\"live\"] .is-live-source .source-node:hover"), stylesCss.indexOf(".is-live-source .source-node:focus-visible"));
  assert.match(liveNodeInteractionCss, /\.app-shell\[data-mode="live"\] \.is-live-source \.source-node:hover,[\s\S]+?transform: translate\(-50%, -50%\);/);
  assert.doesNotMatch(liveNodeInteractionCss, /translateY\(/);
  assert.match(stylesCss, /@keyframes live-node-activity[\s\S]+?opacity:/);
  const liveContinuityCss = stylesCss.slice(stylesCss.lastIndexOf("/* Live runtime continuity"));
  assert.doesNotMatch(liveContinuityCss, /drop-shadow\(/);
  assert.match(stylesCss, /\.app-shell\[data-mode="live"\] \.context-drawer\s*\{[\s\S]+?border-radius: var\(--architecture-system-radius\);[\s\S]+?box-shadow: none;/);
  const liveDrawerSource = appJs.slice(appJs.indexOf("function renderSourceDrawerContent"), appJs.indexOf("function renderAgentOperationDetail"));
  assert.match(liveDrawerSource, /liveAgentAssessment\(context\)/);
  const assessmentSource = appJs.slice(appJs.indexOf("function liveAgentAssessment"), appJs.indexOf("function renderAgentOperationDetail"));
  assert.match(assessmentSource, /agentControl\(\)\.report/);
  assert.match(assessmentSource, /Run-level agent assessment/);
  assert.doesNotMatch(assessmentSource, /payload|prompt|token|secret|raw_log/i);
});

test("Live reuses the canonical navigation and exposes only safe projected Team details", () => {
  assert.match(indexHtml, /id="operations-team-rail"[^>]+aria-label="FlowPulse Team"/);
  assert.match(appJs, /function renderOperationsTeamRail\(\)/);
  assert.match(appJs, /const controls = controlSystemNodes\(\)/);
  assert.match(appJs, /const inspectorOpen = \(mode === "live" \|\| isUnifiedRailWorkspace\(\)\) && selected\?\.type === "node" && isRailRuntimeNode\(selected\.id\) && agentTeam\.panel === "home"/);
  assert.match(appJs, /rail\.hidden = !controls\.length;/);
  assert.match(appJs, /controlSystemTileMarkup\(node, \{ rail: true \}\)/);
  assert.match(stylesCss, /\.operations-team-rail > \.architecture-flowpulse-system \{ height: 100%; \}/);
  assert.match(stylesCss, /\.twin-workspace \{[\s\S]*?--flowpulse-control-rail-width: 272px;[\s\S]*?--flowpulse-control-rail-inset-y: 16px;[\s\S]*?--flowpulse-control-rail-inset-x: 20px;/);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-systems \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) var\(--flowpulse-control-rail-width\);[\s\S]*?padding: var\(--flowpulse-control-rail-inset-y\) var\(--flowpulse-control-rail-inset-x\);/);
  assert.match(stylesCss, /\.operations-team-rail \{[\s\S]*?top: var\(--flowpulse-control-rail-inset-y\);[\s\S]*?right: var\(--flowpulse-control-rail-inset-x\);[\s\S]*?bottom: var\(--flowpulse-control-rail-inset-y\);[\s\S]*?width: var\(--flowpulse-control-rail-width\);/);
  assert.match(stylesCss, /\.operations-team-rail \.architecture-flowpulse-system \{[\s\S]*?gap: 10px;[\s\S]*?padding: 14px 12px 12px;/);
  assert.match(stylesCss, /@media \(max-width: 1320px\) \{[\s\S]*?\.twin-workspace \{[\s\S]*?--flowpulse-control-rail-width: 236px;/);
  assert.match(appJs, /function controlDrawerContent\(context\)/);
  assert.match(appJs, /Agent conversation and consequential actions remain unavailable here\./);
  assert.doesNotMatch(appJs.slice(appJs.indexOf("function controlDrawerContent"), appJs.indexOf("function architectureComponentDetailMarkup")), /payload|prompt|token|secret|raw_log/i);
  assert.match(stylesCss, /\.app-shell\[data-mode\] \.mode-switch\s*\{[\s\S]+?border-radius: 12px;/);
  assert.match(stylesCss, /\.app-shell\[data-mode="live"\] \.canvas-toolbar \{ display: none; \}/);
});

test("Agent Team rail is session-driven, retains Live selection, and never uses the legacy manager message route", () => {
  const railSource = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function drawerTabsForSelection"));
  const sessionSource = appJs.slice(appJs.indexOf("function restoreAgentTeamState"), appJs.indexOf("function drawerTabsForSelection"));
  const liveDetailSource = appJs.slice(appJs.indexOf("function renderLiveComponentDetail"), appJs.indexOf("function liveComponentRelationSections"));
  assert.match(appJs, /AGENT_TEAM_ROLES,/);
  assert.match(railSource, /data-agent-team-role/);
  assert.match(railSource, /data-agent-team-send/);
  assert.match(railSource, /querySelector\("\[data-agent-team-send\]"\)[\s\S]*?submitAgentTeamComposer\(form\)/);
  assert.match(railSource, /textarea name="message" data-agent-team-input/);
  assert.match(railSource, /data-testid="agent-chatbox"/);
  assert.match(railSource, /data-testid="agent-chat-input"/);
  assert.match(railSource, /data-testid="agent-chat-send"/);
  assert.match(railSource, /data-testid="simulate-incident"/);
  assert.match(railSource, /data-projection-revision/);
  assert.match(appJs, /function handleAgentTeamComposerKeydown/);
  assert.match(appJs, /event\.key !== "Enter" \|\| event\.shiftKey/);
  assert.match(appJs, /function handleAgentTeamDraft/);
  assert.match(appJs, /function setAgentTeamDraft/);
  assert.match(appJs, /function submitAgentTeamComposer/);
  assert.match(railSource, /escapeHtml\(agentTeam\.draft \|\| ""\)/);
  assert.match(appJs, /draft: message/);
  assert.match(appJs, /Agent chat records have their own append-only ledger sequence/);
  assert.doesNotMatch(appJs.slice(appJs.indexOf("function agentTeamTimelineMarkup"), appJs.indexOf("function agentTeamMessageMarkup")), /message\.sequence <= throughSequence/);
  assert.match(appJs, /projection_revision: projectionRevision/);
  assert.match(appJs, /data-testid="recovery-topology"/);
  assert.match(appJs, /bindCanonicalCanvasIdentity\(recoveryTopology\.visual, "recovery-canvas"\)/);
  assert.match(appJs, /function canonicalRecoveryTopologyMarkup/);
  assert.match(appJs, /data-node-ids=/);
  assert.match(appJs, /data-edge-ids=/);
  assert.match(appJs, /data-testid="\$\{verificationProjection\.passed \? "verification-passed"/);
  assert.match(readFileSync(new URL("../public/vendor/phosphor/flowpulse-icons.css", import.meta.url), "utf8"), /\.ph-arrow-left::before/);
  assert.match(railSource, /role !== "ledger"/);
  assert.match(railSource, /data-agent-team-composer/);
  assert.match(railSource, /Evidence Ledger is read-only/);
  assert.match(railSource, /from\)} → \$\{escapeHtml\(message\.to\)/);
  assert.match(railSource, /data-agent-team-workspace="\$\{id\}"/);
  assert.match(railSource, /view_diagnosis: "investigate"/);
  assert.match(railSource, /open_recovery_console: "decide"/);
  assert.match(railSource, /compare_recovery: "verify"/);
  assert.match(sessionSource, /\/api\/agent-control\/provider/);
  assert.match(sessionSource, /\/api\/agent-control\/conversation\?run_id=/);
  assert.match(sessionSource, /\/api\/agent-control\/events\?run_id=/);
  assert.match(sessionSource, /\/api\/agent-control\/chat/);
  assert.match(sessionSource, /\/api\/demo\/agent-loop\/run/);
  assert.match(sessionSource, /agentTeamConversationProjection/);
  assert.match(sessionSource, /agentLoopStartProjection/);
  assert.match(sessionSource, /connectSharedRunStream/);
  assert.doesNotMatch(sessionSource, /\/api\/agent-control\/message/);
  const roleSelectionSource = appJs.slice(appJs.indexOf("async function openAgentTeamSession"), appJs.indexOf("function closeAgentTeamSession"));
  assert.match(roleSelectionSource, /hydrateAgentTeamSession\(\)/);
  assert.doesNotMatch(roleSelectionSource, /method:\s*"POST"/);
  assert.match(liveDetailSource, /data-ask-observer/);
  assert.match(appJs, /openAgentTeamSession\("observer", \{ restoreInspector: true, inspectorSnapshot: captureLiveInspectorSnapshot\(\) \}\)/);
  assert.match(appJs, /agentTeam\.panel === "session"/);
  assert.match(appJs, /renderDrawer\(\);\n  renderOperationsTeamRail\(\);/);
  assert.match(stylesCss, /\.agent-team-timeline \{[\s\S]+?overflow: auto;/);
  assert.match(stylesCss, /\.agent-team-composer \{[\s\S]+?grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(stylesCss, /\.agent-team-composer textarea \{/);
});

test("Live Inspector owns the rail, preserves canvas continuity, and keeps its progressive disclosures closed by default", () => {
  const railSource = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function handleOperationsTeamRail"));
  const inspectorSource = appJs.slice(appJs.indexOf("function liveNodeInspectorRailMarkup"), appJs.indexOf("function agentTeamHomeMarkup"));
  const sessionSource = appJs.slice(appJs.indexOf("function agentTeamSessionMarkup"), appJs.indexOf("function boundedListMarkup"));
  assert.match(railSource, /\(mode === "live" \|\| isUnifiedRailWorkspace\(\)\) && selected\?\.type === "node" && isRailRuntimeNode\(selected\.id\) && agentTeam\.panel === "home"/);
  assert.match(railSource, /liveNodeInspectorRailMarkup\(/);
  assert.match(inspectorSource, /data-live-inspector-close/);
  assert.match(inspectorSource, /data-live-inspector-disclosure/);
  assert.match(inspectorSource, /data-ask-observer/);
  assert.match(inspectorSource, /data-focus-entity/);
  assert.match(inspectorSource, /aria-expanded="\$\{String\(liveInspector\.disclosures/);
  assert.match(sessionSource, /Agent capability/);
  assert.match(sessionSource, /Run details/);
  assert.doesNotMatch(sessionSource, /<code>\$\{escapeHtml\(agentTeam\.loop\?\.run_id\)/);
  assert.match(appJs, /captureLiveInspectorSnapshot\(\)/);
  assert.match(appJs, /restoreLiveInspectorSnapshot\(\)/);
  assert.match(stylesCss, /\.operations-team-rail \.live-node-inspector \{[\s\S]+?overflow: hidden;/);
  assert.match(stylesCss, /\.live-node-inspector-body \{[\s\S]+?overflow: auto;/);
  assert.doesNotMatch(railSource, /\/api\/agent-control\/message/);
});

test("Unified Context Rail keeps one surface through workspace summaries, inspector, and Agent back navigation", () => {
  const railSource = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function handleOperationsTeamRail"));
  const railHandler = appJs.slice(appJs.indexOf("function handleOperationsTeamRail"), appJs.indexOf("function handleAgentTeamSubmit"));
  const modeSource = appJs.slice(appJs.indexOf("function setMode"), appJs.indexOf("function configureCanvasWorld"));
  assert.match(railSource, /isUnifiedRailWorkspace\(\)\) && selected\?\.type === "node" && isRailRuntimeNode\(selected\.id\)/);
  assert.match(railSource, /workspaceEvidenceRailMarkup\(\)/);
  assert.match(railSource, /workspaceSummaryRailMarkup\(\)/);
  assert.match(railHandler, /closeAgentTeamSession\(\{ restoreInspector: true \}\)/);
  assert.match(railSource, /querySelectorAll\("\[data-agent-team-role\]"\)[\s\S]*?openAgentTeamSession\(button\.dataset\.agentTeamRole/);
  assert.match(modeSource, /isSelectionValidForMode\(selected, nextMode\)/);
  assert.match(appJs, /data-workspace-evidence-close/);
  assert.match(appJs, /data-workspace-view-evidence/);
  assert.match(appJs, /data-agent-team-workspace/);
  assert.match(stylesCss, /\.unified-context-summary/);
  assert.match(stylesCss, /\.unified-context-evidence/);
});

test("Unified Context Rail replaces legacy commander and duplicated control surfaces", () => {
  assert.match(indexHtml, /id="operations-team-rail"/);
  assert.doesNotMatch(indexHtml, /id="manager-panel"/);
  assert.doesNotMatch(indexHtml, /id="compare-review-rail"/);
  assert.match(appJs, /function workspaceSummaryRailMarkup\(\)/);
  assert.match(appJs, /function workspaceEvidenceRailMarkup\(\)/);
  assert.match(appJs, /function isRailRuntimeNode\(id\)/);
  assert.match(appJs, /function isUnifiedRailWorkspace\(candidate = mode\)/);
  assert.match(appJs, /Diagnosis Summary/);
  assert.match(appJs, /Recovery Status/);
  assert.match(appJs, /Verification Summary/);
  assert.doesNotMatch(appJs, /\/api\/agent-control\/message/);
  assert.doesNotMatch(appJs, /data-recovery-action/);
  assert.doesNotMatch(appJs, /data-collaborator-id/);
  assert.match(stylesCss, /\.app-shell\[data-mode="incident"\] \.plane-guides \{ display: none; \}/);
  assert.equal(AGENT_COLLABORATORS.length, 6);
});

test("Incident is the sole persistent incident workspace and reserves the shared rail once", () => {
  const primaryModes = [...indexHtml.matchAll(/<button class="mode-button[^>]*data-mode="([^"]+)"[^>]*>([^<]+)<\/button>/g)]
    .map(([, id, label]) => ({ id, label: label.trim() }));
  assert.deepEqual(primaryModes, [
    { id: "architecture", label: "Architecture" },
    { id: "live", label: "Live" },
    { id: "incident", label: "Incident" }
  ]);

  const modeSource = appJs.slice(appJs.indexOf("function setMode"), appJs.indexOf("function configureCanvasWorld"));
  assert.match(modeSource, /mode = nextMode;[\s\S]+?render\(\);/);
  assert.match(appJs, /const INCIDENT_STAGES = Object\.freeze\(\[/);
  assert.match(indexHtml, /id="incident-stage-rail"/);
  assert.match(indexHtml, /id="incident-stage-panel"/);
  assert.match(appJs, /function renderIncidentStageRail\(focusedStage = null\)/);
  assert.match(appJs, /function renderIncidentStagePanel\(shared\)/);
  assert.doesNotMatch(stylesCss, /\.app-shell\[data-mode="compare"\] \.twin-scroll \{ padding-right: 348px; \}/);
  assert.match(stylesCss, /\.app-shell\[data-mode="incident"\] \.canvas-shell \{[\s\S]+?padding-right: calc\(var\(--flowpulse-control-rail-width\) \+ var\(--flowpulse-control-rail-inset-x\) \* 2\);/);
  assert.match(stylesCss, /\.app-shell\[data-mode="incident"\] \.twin-canvas \{ min-width: 0; width: 100%; \}/);
});

test("F3A.1 keeps one rounded frosted rail silhouette for every workspace and rail state", () => {
  const railSource = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function handleOperationsTeamRail"));
  assert.match(indexHtml, /<aside id="operations-team-rail" class="operations-team-rail is-architecture-source"/);
  assert.match(railSource, /agentTeamHomeMarkup\(controls\)/);
  assert.match(railSource, /liveNodeInspectorRailMarkup\(\)/);
  assert.match(railSource, /workspaceSummaryRailMarkup\(\)/);
  assert.match(railSource, /workspaceEvidenceRailMarkup\(\)/);
  assert.match(railSource, /agentTeamSessionMarkup\(controls\)/);
  assert.match(stylesCss, /--flowpulse-control-rail-radius: 22px;/);
  assert.match(stylesCss, /\.operations-team-rail \{[\s\S]+?border-radius: var\(--flowpulse-control-rail-radius\);[\s\S]+?background: var\(--flowpulse-control-rail-surface\);[\s\S]+?box-shadow: var\(--flowpulse-control-rail-shadow\);[\s\S]+?backdrop-filter: blur\(18px\) saturate\(118%\);[\s\S]+?overflow: hidden;/);
  assert.match(stylesCss, /\.operations-team-rail > \.architecture-flowpulse-system \{[\s\S]+?height: 100%;[\s\S]+?border-radius: inherit;[\s\S]+?background: transparent;[\s\S]+?box-shadow: none;/);
  assert.doesNotMatch(stylesCss, /\.app-shell\[data-mode="(?:architecture|live|replay|agents|compare)"\] \.operations-team-rail \{[^}]*border-radius:\s*0/);
});

test("collaborator projection deterministically aggregates isolated backend roles", () => {
  const control = {
    current_agent_id: "owner",
    report: { human_gate: "owner_approval_required" },
    graph: { nodes: [
      { id: "manager", status: "running" }, { id: "monitor", status: "complete" }, { id: "evidence", status: "complete" },
      { id: "diagnosis", status: "complete" }, { id: "evaluator", status: "complete" }, { id: "planner", status: "complete" },
      { id: "executor", status: "standby" }, { id: "verification", status: "standby" }, { id: "evolve", status: "standby" }, { id: "test", status: "standby" }
    ] },
    activity: [{ id: "ev-1", agent_id: "evidence", summary: "Cited deployment evidence", evidence_refs: ["ev-deploy-checkout"] }]
  };
  const team = projectAgentCollaborators(control);
  assert.equal(team.nodes.length, 6);
  assert.equal(team.currentId, "recovery-engineer");
  assert.equal(team.nodes.find(({ id }) => id === "observer").latestActivity.id, "ev-1");
  assert.equal(team.nodes.find(({ id }) => id === "recovery-engineer").status, "waiting");
  assert.equal(team.edges.find(({ id }) => id === "critic-recovery").status, "waiting");
  assert.equal(team.nodes.some(({ id }) => ["owner", "ledger", "langfuse"].includes(id)), false);
});

test("every component has a vector icon and causal pulses remain sequential", () => {
  assert.deepEqual(Object.keys(TWIN_ICONS).sort(), TWIN_NODES.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(PULSE_SLOTS).sort(), TWIN_EDGES.map(({ id }) => id).sort());
  assert.ok(PULSE_SLOTS["deployment-checkout"] < PULSE_SLOTS["frontend-checkout"]);
  assert.ok(PULSE_SLOTS["frontend-checkout"] < PULSE_SLOTS["checkout-payment"]);
  assert.ok(PULSE_SLOTS["checkout-payment"] < PULSE_SLOTS["checkout-kafka"]);
  assert.ok(PULSE_SLOTS["checkout-kafka"] < PULSE_SLOTS["kafka-accounting"]);
  assert.ok(PULSE_SLOTS["kafka-accounting"] < PULSE_SLOTS["kafka-fraud"]);
});

test("runtime, control-plane, and derived-outcome semantics stay explicit", () => {
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "runtime").map(({ id }) => id),
    ["frontend", "checkout", "payment", "kafka", "accounting", "fraud"]
  );
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "control").map(({ id }) => id),
    ["deployment", "agent", "evaluator", "ledger"]
  );
  assert.deepEqual(
    frameFor(7).annotations.filter(({ role }) => role === "outcome").map(({ id }) => id),
    ["recovery", "learning"]
  );
});

test("digital twin keeps stable component identities and coordinates across every stage", () => {
  const identities = TWIN_NODES.map(({ id, x, y }) => ({ id, x, y }));
  const edges = TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path }));
  for (let index = 0; index < TWIN_STAGES.length; index++) {
    const frame = frameFor(index);
    assert.deepEqual(TWIN_NODES.map(({ id, x, y }) => ({ id, x, y })), identities);
    assert.deepEqual(TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path })), edges);
    assert.deepEqual(Object.keys(frame.nodeStates).sort(), identities.map(({ id }) => id).sort());
  }
});

test("ledger milestones deterministically unlock the replay stages", () => {
  const events = [
    { type: "incident.opened" },
    { type: "loop.symptoms_collected" },
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "verification.completed" },
    { type: "policy.evaluated" }
  ];
  assert.equal(availableStage(events.slice(0, 1)), 0);
  assert.equal(availableStage(events.slice(0, 2)), 2);
  assert.equal(availableStage(events.slice(0, 3)), 3);
  assert.equal(availableStage(events.slice(0, 4)), 4);
  assert.equal(availableStage(events.slice(0, 5)), 5);
  assert.equal(availableStage(events.slice(0, 6)), 6);
  assert.equal(availableStage(events), 7);
});

test("seeking the same stage reconstructs identical canvas state", () => {
  const first = frameFor(4);
  const second = frameFor(4);
  assert.deepEqual(first, second);
  assert.equal(first.nodeStates.checkout, "root");
  assert.equal(first.nodeStates.payment, "root");
  assert.equal(first.edgeStates["checkout-payment"], "root");
  assert.ok(first.annotations.some((note) => note.id === "replan"));
});

test("compare uses incident and verified frames without changing layout", () => {
  const { incident, recovered } = compareFrames();
  assert.equal(incident.nodeStates.checkout, "impact");
  assert.equal(recovered.nodeStates.checkout, "verified");
  assert.equal(incident.metrics.checkout.value, "38.4%");
  assert.equal(recovered.metrics.checkout.value, "0.8%");
  assert.equal(TWIN_NODES.length, 10);
  assert.match(indexHtml, /id="compare-range"[^>]+step="1"/);
  assert.match(indexHtml, /id="compare-canvas-range"[^>]+type="range"[^>]+step="1"/);
  assert.match(appJs, /--compare-percent/);
  assert.match(appJs, /addEventListener\("pointerdown", startCompareDrag\)/);
  assert.match(appJs, /function updateCompareFromPointer\(clientX\)/);
  assert.doesNotMatch(appJs, /Math\.round\(comparePercent \/ 10\)/);
  assert.doesNotMatch(stylesCss, /\.compare-value-\d+/);
});

test("Compare pointer sequence gives a blank canvas to pan and its divider to comparison only", () => {
  const down = (input) => canvasPointerTransition({ phase: "down", mode: "compare", pointerId: 41, ...input });
  const pan = down();
  assert.deepEqual(pan, { action: "pan", pointerId: 41 });
  assert.deepEqual(canvasPointerTransition({ current: pan, phase: "move", pointerId: 41 }), pan);
  assert.equal(canvasPointerTransition({ current: pan, phase: "up", pointerId: 41 }), null);

  const divider = down({ isCompareHandle: true });
  assert.deepEqual(divider, { action: "compare-divider", pointerId: 41 });
  assert.deepEqual(canvasPointerTransition({ current: divider, phase: "move", pointerId: 41 }), divider);
  assert.equal(canvasPointerTransition({ current: divider, phase: "up", pointerId: 41 }), null);

  assert.equal(down({ isInteractive: true }), null);
  assert.match(appJs, /claimCanvasPointer\(event, "pan"\)/);
  assert.match(appJs, /claimCanvasPointer\(event, "compare-divider"\)/);
  assert.match(appJs, /mode: isIncidentCompareStage\(\) \? "compare" : mode/);
});

test("Compare keeps its split canvas while Unified Context Rail owns the verification summary", () => {
  assert.doesNotMatch(indexHtml, /id="compare-review-rail"/);
  assert.doesNotMatch(appJs, /function renderCompareReviewRail/);
  assert.doesNotMatch(appJs, /function handleCompareReview/);
  assert.match(appJs, /function compareDecisionModel\(\)/);
  assert.match(appJs, /evaluation\.rejected/);
  assert.match(appJs, /repair\.proposed/);
  assert.match(appJs, /verification\.completed/);
  assert.match(appJs, /regression\.created/);
  assert.match(appJs, /workspaceSummaryRailMarkup\(\)/);
});

test("compare labels legacy previews separately while canonical workspaces require verified evidence", () => {
  assert.deepEqual(compareProvenance([]), {
    label: "Captured recovery preview",
    tone: "preview",
    status: "Deterministic captured preview",
    caption: "Verified recovery is projected from the deterministic captured incident bundle",
    aria: "captured deterministic recovery preview"
  });
  assert.equal(compareProvenance([{ type: "verification.completed", payload: { passed: false } }]).label, "Captured recovery preview");
  assert.deepEqual(compareProvenance([{ type: "verification.completed", payload: { passed: true } }]), {
    label: "Current verified run",
    tone: "verified",
    status: "Authoritative current-run comparison",
    caption: "Passed recovery verification recorded in the current immutable ledger",
    aria: "current run with passed recovery verification"
  });
  const setModeSource = appJs.match(/function setMode\(nextMode\) \{[\s\S]+?\n\}/)?.[0] || "";
  assert.doesNotMatch(setModeSource, /nextMode === "compare"/);
  assert.match(appJs, /function canonicalTopologyLayerMarkup/);
  assert.match(appJs, /Compare remains locked until this run records passed independent verification/);
  assert.match(appJs, /const canonicalWorkspacePending = \(isIncidentWorkspace\(\) \|\| \["replay", "agents", "compare"\]\.includes\(mode\)\) && !shared/);
  assert.match(appJs, /Workspace loading/);
  assert.match(stylesCss, /\.capture-label\.source-preview::before \{ background: var\(--amber\); \}/);
});

test("live connector paths terminate at card boundaries for target viewport widths", () => {
  const from = { x: 6, y: 25 };
  const to = { x: 31, y: 25 };
  for (const canvasWidth of [1100, 1280, 1440]) {
    const route = liveEdgeRoute(from, to, { canvasWidth, canvasHeight: 520, nodeWidth: 144, nodeHeight: 58 });
    const { x: startX, y: startY } = route[0];
    const { x: endX, y: endY } = route.at(-1);
    assert.ok(Math.abs(startX - (from.x / 100 * canvasWidth + 72)) < 0.01);
    assert.ok(Math.abs(endX - (to.x / 100 * canvasWidth - 72)) < 0.01);
    assert.equal(startY, from.y / 100 * 520);
    assert.equal(endY, to.y / 100 * 520);
  }

  const crossLayer = liveEdgeRoute({ x: 31, y: 17 }, { x: 68, y: 61 }, {
    canvasWidth: 1440,
    canvasHeight: 620,
    nodeWidth: 144,
    nodeHeight: 58,
    lane: 1
  });
  assert.ok(Math.abs(crossLayer[0].x - (31 / 100 * 1440 + 72)) < 0.01);
  assert.ok(Math.abs(crossLayer.at(-1).x - (68 / 100 * 1440 - 72)) < 0.01);
  assert.ok(crossLayer.some(({ y }) => [4, 8, 612, 616].includes(y)));
  const path = liveEdgePath(from, to, { lane: 1 });
  assert.match(path, /^M .+ Q /);
  assert.doesNotMatch(path, /\bC\b/);
});

test("reserved live routes avoid every non-endpoint card", () => {
  const topology = topologyIntegrity({
    nodes: [
      { id: "frontend", kind: "client" }, { id: "checkout", kind: "service" }, { id: "cart", kind: "service" },
      { id: "payment", kind: "api" }, { id: "kafka", kind: "stream" }, { id: "flagd", kind: "service" }
    ],
    edges: [
      { id: "front-checkout", from: "frontend", to: "checkout" },
      { id: "checkout-cart", from: "checkout", to: "cart" },
      { id: "checkout-payment", from: "checkout", to: "payment" },
      { id: "cart-flagd", from: "cart", to: "flagd" }
    ]
  });
  const positions = livePositions(topology.nodes);
  const byId = new Map(positions.map((node) => [node.id, node]));
  const halfWidth = 144 / 2;
  const halfHeight = 58 / 2;
  for (const [index, edge] of topology.edges.entries()) {
    const lane = index % 2 ? Math.ceil(index / 2) : -Math.ceil((index + 1) / 2);
    const route = liveEdgeRoute(byId.get(edge.from), byId.get(edge.to), { canvasWidth: 1480, canvasHeight: 680, lane });
    for (const node of positions.filter(({ id }) => ![edge.from, edge.to].includes(id))) {
      const rect = { left: node.x / 100 * 1480 - halfWidth, right: node.x / 100 * 1480 + halfWidth, top: node.y / 100 * 680 - halfHeight, bottom: node.y / 100 * 680 + halfHeight };
      for (let point = 1; point < route.length; point++) assert.equal(segmentHitsRect(route[point - 1], route[point], rect), false, `${edge.id} crosses ${node.id}`);
    }
  }
});

test("complete captured Live topology routes meet exactly at node boundaries without crossing cards", () => {
  const topology = topologyIntegrity({ nodes: topologyManifest.nodes, edges: topologyManifest.edges });
  const positions = livePositions(topology.nodes);
  const byId = new Map(positions.map((node) => [node.id, node]));
  const halfWidth = 180 / 2;
  const halfHeight = 60 / 2;
  const slots = livePulseSlots(topology);
  const ordered = orderedSignalEdges(topology.edges, slots);
  const rectFor = (node) => ({
    left: node.x / 100 * 1480 - halfWidth,
    right: node.x / 100 * 1480 + halfWidth,
    top: node.y / 100 * 680 - halfHeight,
    bottom: node.y / 100 * 680 + halfHeight
  });
  const isOnBoundary = (point, rect) => (
    point.x >= rect.left && point.x <= rect.right
    && point.y >= rect.top && point.y <= rect.bottom
    && ([point.x - rect.left, point.x - rect.right, point.y - rect.top, point.y - rect.bottom]
      .some((distance) => Math.abs(distance) < 1e-9))
  );

  assert.equal(positions.length, 22);
  assert.equal(ordered.length, 26);
  for (const [order, edge] of ordered.entries()) {
    const lane = order % 2 ? Math.ceil(order / 2) : -Math.ceil((order + 1) / 2);
    const route = liveEdgeRoute(byId.get(edge.from), byId.get(edge.to), {
      canvasWidth: 1480,
      canvasHeight: 680,
      nodeWidth: 180,
      nodeHeight: 60,
      lane
    });
    assert.equal(isOnBoundary(route[0], rectFor(byId.get(edge.from))), true, `${edge.id} starts outside ${edge.from}`);
    assert.equal(isOnBoundary(route.at(-1), rectFor(byId.get(edge.to))), true, `${edge.id} ends outside ${edge.to}`);
    for (const node of positions.filter(({ id }) => ![edge.from, edge.to].includes(id))) {
      const rect = rectFor(node);
      for (let point = 1; point < route.length; point++) {
        assert.equal(segmentHitsRect(route[point - 1], route[point], rect), false, `${edge.id} crosses ${node.id}`);
      }
    }
  }
});

function segmentHitsRect(a, b, rect) {
  if (a.x === b.x) return a.x > rect.left && a.x < rect.right && Math.max(Math.min(a.y, b.y), rect.top) < Math.min(Math.max(a.y, b.y), rect.bottom);
  if (a.y === b.y) return a.y > rect.top && a.y < rect.bottom && Math.max(Math.min(a.x, b.x), rect.left) < Math.min(Math.max(a.x, b.x), rect.right);
  return false;
}

test("Live pulse ordering remains deterministic across the complete backend runtime graph", () => {
  const topology = {
    nodes: ["frontend", "checkout", "payment", "kafka", "accounting"].map((id) => ({ id })),
    edges: [
      { id: "frontend->checkout", from: "frontend", to: "checkout" },
      { id: "checkout->payment", from: "checkout", to: "payment" },
      { id: "checkout->kafka", from: "checkout", to: "kafka" },
      { id: "kafka->accounting", from: "kafka", to: "accounting" }
    ]
  };
  assert.deepEqual(livePulseSlots(topology), {
    "frontend->checkout": 0,
    "checkout->kafka": 1,
    "checkout->payment": 2,
    "kafka->accounting": 3
  });
  assert.deepEqual(orderedSignalEdges(topology.edges, livePulseSlots(topology)).map(({ id }) => id), [
    "frontend->checkout",
    "checkout->kafka",
    "kafka->accounting",
    "checkout->payment"
  ]);
  const renderSourceCanvasSource = appJs.slice(appJs.indexOf("function renderSourceCanvas"), appJs.indexOf("function architectureLayerStatus"));
  assert.match(renderSourceCanvasSource, /edges: \[\.\.\.live\.runtime_data\.graph\.edges, \.\.\.\(live\.runtime_data\.supporting_relations \|\| \[\]\)\]/);
  assert.match(renderSourceCanvasSource, /const pulseSlots = livePulseSlots\(\{ \.\.\.topology, edges: pulseEdges \}\);/);
  assert.match(renderSourceCanvasSource, /const routeBuildOrder = new Map\(orderedLiveRouteBuildEdges\(runtimeEdges, positioned\)/);
  assert.match(renderSourceCanvasSource, /orderedSignalEdges\(pulseEdges, pulseSlots\)/);
  assert.match(renderSourceCanvasSource, /fixed-live-edge-map/);
  assert.match(renderSourceCanvasSource, /liveEdgePath\(positions\.get\(edge\.from\), positions\.get\(edge\.to\)/);
  assert.doesNotMatch(renderSourceCanvasSource, /class="pulse-flow/);
  assert.match(appJs, /classList\.toggle\("is-live-source", mode === "live" \|\| isIncidentWorkspace\(\) \|\| mode === "replay" \|\| mode === "compare"\)/);
  assert.match(appJs, /function startLiveSignalLoop\(/);
  assert.match(appJs, /const concurrentPulseCount = Math\.min\(3, groups\.length\);/);
  assert.match(appJs, /groups\.slice\(0, concurrentPulseCount\)\.forEach\(/);
  assert.match(appJs, /let liveSignalFrames = new Set\(\);/);
  assert.match(appJs, /function liveSignalTiming\(pathLength\)/);
  assert.match(appJs, /liveSignalDuration\(pathLength, 760, launch, terminal\)/);
  assert.match(appJs, /liveSignalProgress\(elapsed, pathLength, timing\.speed, timing\.launch, timing\.terminal\)/);
  assert.match(appJs, /function positionLiveProjectile\(path, projectile, progress, pathLength\)/);
  assert.match(stylesCss, /\.is-live-source \.edge-group \.edge-line \{[\s\S]*?animation-delay: 0ms;[\s\S]*?animation-fill-mode: both;/);
  assert.match(appJs, /function applyLiveRouteDelays\(\)/);
  assert.match(appJs, /const delay = Number\(group\.dataset\.routeOrder\) \* 32;/);
  assert.match(appJs, /line\.style\.animationDelay = `\$\{delay\}ms`/);
  assert.match(appJs, /data-route-order="\$\{edge\.routeOrder\}"/);
  assert.doesNotMatch(appJs, /data-recovery-command-send/);
  assert.doesNotMatch(appJs, /sendRecoveryCommand\(/);
  assert.match(appJs, /Recovery Status/);
});

test("future primary dependency selection remains deterministic while Live renders the complete canonical canvas", () => {
  const topology = topologyIntegrity({
    nodes: ["load-generator", "frontend-web", "frontend-proxy", "frontend", "checkout", "cart", "payment", "flagd"].map((id) => ({ id, kind: "service" })),
    edges: [
      { id: "load-generator->frontend-proxy", from: "load-generator", to: "frontend-proxy" },
      { id: "frontend-web->frontend-proxy", from: "frontend-web", to: "frontend-proxy" },
      { id: "frontend-proxy->frontend", from: "frontend-proxy", to: "frontend" },
      { id: "frontend->checkout", from: "frontend", to: "checkout" },
      { id: "frontend->cart", from: "frontend", to: "cart" },
      { id: "checkout->cart", from: "checkout", to: "cart" },
      { id: "checkout->payment", from: "checkout", to: "payment" },
      { id: "load-generator->flagd", from: "load-generator", to: "flagd" },
      { id: "cart->flagd", from: "cart", to: "flagd" }
    ]
  });
  const selected = primaryLiveEdges(topology);
  const selectedReversed = primaryLiveEdges({ nodes: [...topology.nodes].reverse(), edges: [...topology.edges].reverse() });
  const authoritative = new Set(topology.edges.map(({ id }) => id));
  const covered = new Set(selected.flatMap((edge) => [edge.from, edge.to]));
  const connected = new Set(topology.edges.flatMap((edge) => [edge.from, edge.to]));

  assert.ok(selected.length < topology.edges.length);
  assert.ok(selected.every(({ id }) => authoritative.has(id)));
  assert.deepEqual([...covered].sort(), [...connected].sort());
  assert.deepEqual(selectedReversed.map(({ id }) => id), selected.map(({ id }) => id));
  const inboundCounts = selected.reduce((counts, { to }) => counts.set(to, (counts.get(to) || 0) + 1), new Map());
  assert.equal(Math.max(...inboundCounts.values()), 2);
  assert.match(appJs, /Live renders the complete canonical runtime graph/);
  assert.match(appJs, /dataset\.observedEdges/);
  assert.match(appJs, /dataset\.displayedEdges/);
  assert.match(appJs, /dataset\.displayedEdges = String\(runtimeEdges\.length\)/);
});

test("live signal projectile accelerates, cruises, then eases into the destination", () => {
  const short = liveSignalDuration(100);
  const long = liveSignalDuration(300);
  assert.ok(Math.abs(long / short - 3) < 1e-9);
  const launchEndMs = (2 * 520 * .1 / 520) * 1000;
  const terminalStartMs = launchEndMs + ((1 - .1 - .16) * 520 / 520) * 1000;
  const launchFirstStep = liveSignalProgress(100, 520) - liveSignalProgress(50, 520);
  const launchSecondStep = liveSignalProgress(150, 520) - liveSignalProgress(100, 520);
  assert.equal(liveSignalProgress(100, 520), .025);
  assert.ok(launchSecondStep > launchFirstStep, "launch speed increases");
  assert.equal(liveSignalProgress(launchEndMs, 520), .1);
  assert.equal(liveSignalProgress(terminalStartMs, 520), .84);
  const terminalFirstStep = liveSignalProgress(terminalStartMs + 80, 520) - liveSignalProgress(terminalStartMs, 520);
  const terminalSecondStep = liveSignalProgress(terminalStartMs + 160, 520) - liveSignalProgress(terminalStartMs + 80, 520);
  assert.ok(terminalFirstStep > terminalSecondStep, "arrival speed decreases");
  assert.equal(liveSignalProgress(liveSignalDuration(520), 520), 1);
});

test("active incident chrome appears only for unresolved real-development runs", () => {
  const unresolved = [{ type: "incident.opened" }];
  const resolved = [...unresolved, { type: "verification.completed", payload: { passed: true } }];
  assert.equal(activeIncidentState(unresolved), true);
  assert.equal(activeIncidentState(resolved), false);
  assert.match(appJs, /state\.mode === "development" && activeIncidentState\(state\.events\)/);
  assert.match(appJs, /mode !== "live" \|\| !activeIncident/);
});

test("source component drawers expose only data-bearing topology, signals, and immutable provenance", () => {
  assert.match(appJs, /function sourceComponentContext\(id\)/);
  assert.match(appJs, /function sourceDrawerTabs\(context\)/);
  assert.match(appJs, /Overview/);
  assert.match(appJs, /function renderSourceSignalSummary\(context\)/);
  assert.match(appJs, /Upstream/);
  assert.match(appJs, /Downstream/);
  assert.match(appJs, /function renderTelemetryPreview\(item\)/);
  assert.match(appJs, /item\.provenance\.byte_start/);
  assert.match(appJs, /item\.provenance\.sha256/);
  assert.match(stylesCss, /\.component-context/);
  assert.match(stylesCss, /\.signal-summary/);
  assert.match(stylesCss, /\.telemetry-preview/);
});

test("Live node detail is revision-bound, comprehensive, and never remounts the active runtime canvas", () => {
  const detailLoader = appJs.slice(appJs.indexOf("function liveComponentDetailKey"), appJs.indexOf("function architectureDetailContext"));
  const liveDetail = appJs.slice(appJs.indexOf("function renderLiveComponentDetail"), appJs.indexOf("function liveAgentAssessment"));
  const drawerOpen = appJs.slice(appJs.indexOf("function openDrawer"), appJs.indexOf("function closeDrawer"));
  const rootRender = appJs.slice(appJs.indexOf("function render()"), appJs.indexOf("function renderHeader"));
  assert.match(detailLoader, /componentDetailProjection/);
  assert.match(detailLoader, /\/api\/components\//);
  assert.match(detailLoader, /renderDrawer\(\)/);
  assert.doesNotMatch(detailLoader, /renderCanvas\(|\brender\(\)/);
  assert.match(liveDetail, /purpose\.business_role/);
  assert.match(liveDetail, /relationships\.upstream/);
  assert.match(liveDetail, /relationships\.downstream/);
  assert.match(liveDetail, /observability\.metrics/);
  assert.match(liveDetail, /observability\.traces/);
  assert.match(liveDetail, /observability\.logs/);
  assert.match(liveDetail, /observability\.changes/);
  assert.match(liveDetail, /record_sha256/);
  assert.doesNotMatch(liveDetail, /payload|prompt|token|secret|raw_log/i);
  assert.doesNotMatch(drawerOpen, /\brender\(\)|\brenderCanvas\(/);
  assert.match(rootRender, /canvasProjectionKey\(\)/);
  assert.match(rootRender, /canvasKey !== renderedCanvasKey/);
});

test("Live Inspector owns the existing rail and preserves the running canvas while an agent session is opened and restored", () => {
  const railRender = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function resolveOperationsTeamControls"));
  const drawerOpen = appJs.slice(appJs.indexOf("function openDrawer"), appJs.indexOf("function closeDrawer"));
  const detailLoader = appJs.slice(appJs.indexOf("function requestLiveComponentDetail"), appJs.indexOf("function architectureDetailContext"));
  assert.match(railRender, /\(mode === "live" \|\| isUnifiedRailWorkspace\(\)\) && selected\?\.type === "node"/);
  assert.match(railRender, /liveNodeInspectorRailMarkup/);
  assert.match(appJs, /captureLiveInspectorSnapshot/);
  assert.match(appJs, /restoreLiveInspectorSnapshot/);
  assert.match(appJs, /data-live-inspector-close/);
  assert.match(appJs, /data-live-inspector-disclosure/);
  assert.match(appJs, /data-focus-entity/);
  assert.match(appJs, /Agent capability/);
  assert.match(appJs, /Run details/);
  assert.match(appJs, /agent-team-citations/);
  assert.match(appJs, /const canCompose = role !== "ledger"/);
  assert.doesNotMatch(railRender, /legacy|\/api\/agent-control\/message/);
  assert.doesNotMatch(drawerOpen, /\brender\(\)|\brenderCanvas\(|startLiveSignals|stopLiveSignals/);
  assert.doesNotMatch(detailLoader, /\brender\(\)|\brenderCanvas\(|startLiveSignals|stopLiveSignals/);
  assert.match(stylesCss, /\.live-node-inspector-body \{[\s\S]+?overflow: auto;[\s\S]+?overscroll-behavior: contain;/);
});

test("timeline renders only recorded milestones and labels the next evidence requirement", () => {
  const sharedTimelineSource = appJs.slice(appJs.indexOf("function sharedEventLabel"), appJs.indexOf("function seekSharedEvent"));
  assert.match(appJs, /const visible = stages\.slice\(0, available \+ 1\)/);
  assert.match(appJs, /function nextTimelineRequirement\(index\)/);
  assert.match(appJs, /awaiting recovery verification/);
  assert.match(sharedTimelineSource, /agent_team\.response\.working[\s\S]*?Agent investigation is in progress/);
  assert.match(stylesCss, /\.timeline-next/);
  assert.match(stylesCss, /--stage-count/);
});

test("terminal Diagnosis Summary copy follows the current canonical recovery state", () => {
  const summarySource = appJs.slice(appJs.indexOf("function workspaceSummaryModel"), appJs.indexOf("function recoveryGateLabel"));
  assert.match(summarySource, /const verification = incidentVerificationProjection\(shared\);[\s\S]*?const recoveryVerified = verification\.passed/);
  assert.match(summarySource, /recoveryVerified[\s\S]*?Causal diagnosis accepted; recovery is verified/);
  assert.match(summarySource, /humanStageLabel\(shared\.stage\)/);
});

test("P0.6 makes Diagnose, Recovery, and Compare canvas-first without technical node chrome", () => {
  const p06Css = stylesCss.slice(stylesCss.lastIndexOf("/* P0.6 canvas-first convergence */"));
  const timelineSource = appJs.slice(appJs.indexOf("function renderTimeline"), appJs.indexOf("function sharedTimelineMarkers"));
  const twinLayerSource = appJs.slice(appJs.indexOf("function renderTwinLayer"), appJs.indexOf("function renderAnnotation"));
  assert.match(p06Css, /grid-template-rows: 64px minmax\(0, 1fr\) 72px;/);
  assert.match(p06Css, /#timeline-dock\s*\{[\s\S]*?height: 72px;/);
  assert.match(p06Css, /\[data-mode="replay"\] \.canvas-toolbar > div:first-child,[\s\S]*?display: none;/);
  assert.match(p06Css, /\[data-mode="agents"\] \.canvas-toolbar > div:first-child,[\s\S]*?display: none;/);
  assert.match(p06Css, /\[data-mode="compare"\] \.canvas-toolbar > div:first-child,[\s\S]*?display: none;/);
  assert.match(timelineSource, /const compactStages = visible\.filter/);
  assert.match(timelineSource, /View history/);
  assert.doesNotMatch(twinLayerSource, /node-origin|node-detail/);
});

test("P0.6 keeps internal provenance out of primary chrome and makes recovery authority explicit", () => {
  const headerSource = appJs.slice(appJs.indexOf("function renderHeader"), appJs.indexOf("function toggleTheme"));
  const captionSource = appJs.slice(appJs.indexOf("function modeCaption"), appJs.indexOf("function tabForStage"));
  const summarySource = appJs.slice(appJs.indexOf("function workspaceSummaryModel"), appJs.indexOf("function recoveryGateLabel"));
  const railSource = appJs.slice(appJs.indexOf("function renderOperationsTeamRail"), appJs.indexOf("function bindOperationsTeamRailControls"));
  const agentSessionSource = appJs.slice(appJs.indexOf("function agentTeamSessionMarkup"), appJs.indexOf("function agentTeamDisclosureMarkup"));
  const recoverySource = appJs.slice(appJs.indexOf("function renderSharedRecoveryCanvas"), appJs.indexOf("function recoveryRoleDetail"));
  const liveEventSource = appJs.slice(appJs.indexOf("function liveInspectorEventStreamMarkup"), appJs.indexOf("function liveInspectorDependenciesMarkup"));
  assert.doesNotMatch(headerSource, /Canonical run \$\{shared\.run_id\}/);
  assert.doesNotMatch(headerSource, /\$\{shared\.stage\} · \$\{shared\.run_id\}/);
  assert.doesNotMatch(captionSource, /shared\.run_id/);
  assert.doesNotMatch(captionSource, /isolated fixture evidence/);
  assert.doesNotMatch(appJs, /Live canonical topology for run/);
  assert.doesNotMatch(appJs, /Incident diagnosis for canonical run/);
  assert.doesNotMatch(appJs, /Compare incident and verified snapshots for canonical run/);
  assert.doesNotMatch(summarySource, /\["Run", shared\.run_id\]/);
  assert.doesNotMatch(agentSessionSource, /\[workspace, component, sourceTruthLabel\(\)\]/);
  assert.ok(agentSessionSource.indexOf("const runId") < agentSessionSource.indexOf("const runDetail"), "session identity must exist before collapsed Run details are composed");
  assert.match(agentSessionSource, /const runDetail = \[/);
  assert.match(agentSessionSource, /agentTeamDisclosureMarkup\("run", "Run details", runDetail\)/);
  assert.doesNotMatch(agentSessionSource, /runId \? `<code>/);
  assert.doesNotMatch(agentSessionSource, /incidentId \? `<code>/);
  assert.doesNotMatch(liveEventSource, /event\.marker \?/);
  assert.match(railSource, /isUnifiedRailWorkspace\(\)/);
  assert.match(recoverySource, /Owner gate/);
});

test("Incident hydration pins the restored run, reports a stale stream, and retains stage focus across rerenders", () => {
  const bootstrap = appJs.slice(appJs.indexOf("let sharedRun = restoreSharedRun()"), appJs.indexOf("window.addEventListener(\"popstate\""));
  const refreshSource = appJs.slice(appJs.indexOf("async function refresh({ synchronizeIncidentStage = false, topologyRefreshKey = null } = {})"), appJs.indexOf("function bindCanonicalWorkspace"));
  const hydrateSource = appJs.slice(appJs.indexOf("async function hydrateSharedRun"), appJs.indexOf("function appendLoopTimelineItem"));
  const railSource = appJs.slice(appJs.indexOf("function renderIncidentStageRail"), appJs.indexOf("function renderCanonicalTopologyPending"));
  const headerSource = appJs.slice(appJs.indexOf("function renderHeader"), appJs.indexOf("function toggleTheme"));
  const approvalSource = appJs.slice(appJs.indexOf("function renderApproval"), appJs.indexOf("function renderDrawer"));
  const connectionSource = appJs.slice(appJs.indexOf("function renderSharedRunConnectionStatus"), appJs.indexOf("function toggleTheme"));
  const sharedRecoverySource = appJs.slice(appJs.indexOf("function renderSharedRecoveryCanvas"), appJs.indexOf("function canonicalRecoveryTopologyMarkup"));
  const sharedSummarySource = appJs.slice(appJs.indexOf("function workspaceSummaryModel"), appJs.indexOf("function recoveryGateLabel"));
  const streamSource = appJs.slice(appJs.indexOf("function connectSharedRunStream"), appJs.indexOf("function appendLoopTimelineItem"));
  const agentStreamSource = appJs.slice(appJs.indexOf("function connectAgentStream"), appJs.indexOf("function escapeHtml"));
  const reconnectSource = appJs.slice(appJs.indexOf("function scheduleSharedRunReconnect"), appJs.indexOf("function connectSharedRunStream"));
  const timelineSource = appJs.slice(appJs.indexOf("function renderTimeline"), appJs.indexOf("function sharedTimelineMarkers"));
  const streamOpenSource = streamSource.slice(streamSource.indexOf("stream.onopen"), streamSource.indexOf("stream.addEventListener(\"local-fault-loop\""));
  assert.match(bootstrap, /let selectedRunId = readRequestedRunId\(\);[\s\S]*?if \(selectedRunId === null && sharedRun\?\.run_id\) bindCanonicalRunSelection\(sharedRun\);/);
  assert.match(appJs, /if \(selectedRunId === null\) bindCanonicalRunSelection\(loop\);/);
  assert.match(refreshSource, /const requestGeneration = beginCanonicalStateRequest\(\);[\s\S]*?const nextState = await request\(browserStatePath\(requestedRunId\)\);[\s\S]*?commitCanonicalStateResponse\([\s\S]*?requestGeneration/);
  assert.doesNotMatch(refreshSource, /state = await request\(browserStatePath/);
  assert.match(agentStreamSource, /requestGeneration = beginCanonicalStateRequest\(\);[\s\S]*?const nextState = await request\(browserStatePath\(requestedRunId\)\);[\s\S]*?commitCanonicalStateResponse\([\s\S]*?requestGeneration/);
  assert.doesNotMatch(agentStreamSource, /state = await request\(browserStatePath/);
  assert.doesNotMatch(appJs, /state = await request\(browserStatePath/);
  assert.match(appJs, /function commitCanonicalStateResponse\(\{ requestedRunId, requestGeneration, nextState \}\)[\s\S]*?currentGeneration: canonicalStateRequestGeneration/);
  assert.match(refreshSource, /if \(requestGeneration !== canonicalStateRequestGeneration \|\| selectedRunId !== requestedRunId\) return;/);
  assert.match(hydrateSource, /if \(!runId \|\| selectedRunId !== runId\) return;/);
  assert.match(hydrateSource, /agent-loop\?run_id=\$\{encodeURIComponent\(runId\)\}/);
  assert.match(hydrateSource, /new EventSource\(`\/api\/demo\/agent-loop\/events\?run_id=\$\{encodeURIComponent\(runId\)\}/);
  assert.match(hydrateSource, /scheduleSharedRunReconnect\(\{ error: error\.message/);
  assert.match(streamSource, /scheduleSharedRunReconnect\(\{ error: "Shared run stream is incompatible\." \}\)/);
  assert.match(reconnectSource, /sharedRunReconnectDelay\(sharedRunReconnectAttempts\)/);
  assert.match(reconnectSource, /void hydrateSharedRun\(\);/);
  assert.doesNotMatch(reconnectSource, /sharedRunTerminal\(\)/);
  assert.match(refreshSource, /Canonical incident refresh is unavailable\./);
  assert.match(hydrateSource, /if \(!sharedRunReconnectRequiresSchemaFrame\) sharedRunReconnectAttempts = 0;/);
  assert.match(hydrateSource, /const topologyRefreshKey = sharedRunTopologyRefresh\.request\(loop, state\);/);
  assert.match(hydrateSource, /stream_state: sharedRunTransportState\(loop\)/);
  assert.match(hydrateSource, /if \(topologyRefreshKey\) void refresh\(\{ synchronizeIncidentStage: true, topologyRefreshKey \}\);/);
  assert.match(refreshSource, /const loadingToken = canonicalStateLoading\.begin\(requestGeneration\);/);
  assert.match(refreshSource, /const settleTopologyRefreshOwnership = \(succeeded = false\) => \{[\s\S]*?settleTopologyRefresh\(sharedRunTopologyRefresh, topologyRefreshKey, succeeded\)/);
  assert.match(refreshSource, /if \(stateCommit === "superseded"\) \{\s*settleTopologyRefreshOwnership\(\);/);
  assert.match(refreshSource, /if \(stateCommit === "mismatched"\) \{\s*settleTopologyRefreshOwnership\(\);/);
  assert.match(refreshSource, /settleTopologyRefreshOwnership\(true\);/);
  assert.match(refreshSource, /\} catch \(error\) \{\s*settleTopologyRefreshOwnership\(\);[\s\S]*?requestGeneration !== canonicalStateRequestGeneration/);
  assert.match(refreshSource, /canonicalStateLoading\.settle\(loadingToken\);/);
  assert.match(agentStreamSource, /finally \{\s*if \(requestGeneration !== null\) settleSupersededCanonicalLoading\(requestGeneration\);\s*\}/);
  const runLiveSource = appJs.slice(appJs.indexOf("async function runLive"), appJs.indexOf("async function mutate"));
  assert.match(runLiveSource, /finally \{\s*if \(requestGeneration !== null\) settleSupersededCanonicalLoading\(requestGeneration\);\s*\}/);
  assert.match(refreshSource, /const retryable = isRetryableRequestFailure\(error\);/);
  assert.match(refreshSource, /if \(!retryable && requestedRunId !== null\) \{[\s\S]*?cancelPinnedRunRetries\(\{[\s\S]*?cancelSharedReconnect: cancelSharedRunReconnect/);
  assert.match(refreshSource, /terminalRetryCancelled && sharedRun\?\.run_id === requestedRunId[\s\S]*?stream_state: "stale"/);
  assert.match(refreshSource, /retryable && topologyRefreshKey && requestedRunId !== null/);
  assert.match(refreshSource, /retryable && requestedRunId !== null/);
  assert.match(appJs, /class RequestError extends Error/);
  assert.match(appJs, /new RequestError\(data\?\.error \|\| `Request failed \(\$\{response\.status\}\)`/);
  assert.doesNotMatch(streamOpenSource, /sharedRunReconnectAttempts = 0/);
  assert.match(streamSource, /topology: projection\.topology \|\| sharedRun\.loop\.topology/);
  assert.match(streamSource, /needsAuthoritativeBrowserProjection[\s\S]*?void refresh\(\{ synchronizeIncidentStage: true \}\)/);
  assert.match(streamSource, /sharedRunReconnectAttempts = 0;[\s\S]*?stream_state: "connected"/);
  assert.match(streamSource, /sharedRunReconnectRequiresSchemaFrame = false;/);
  assert.match(streamSource, /sharedRunReconnectRequiresSchemaFrame = true;[\s\S]*?scheduleSharedRunReconnect\(\{ error: "Shared run stream is incompatible\." \}\)/);
  assert.match(appJs, /const verification = incidentVerificationProjection\(shared\);/);
  assert.match(appJs, /const verified = verification\.passed;/);
  assert.match(appJs, /Verification failed after a recorded repair\./);
  assert.match(headerSource, /shared-run-connection/);
  assert.match(headerSource, /Repair executed; verification failed/);
  assert.match(connectionSource, /Live incident updates are stale; retrying/);
  assert.match(connectionSource, /const retryPending = sharedRunReconnectTimer !== null;/);
  assert.match(connectionSource, /Live incident updates are unavailable\. Retry manually\./);
  assert.match(connectionSource, /els\["incident-strip"\]\.hidden = false/);
  assert.match(connectionSource, /els\["incident-strip"\]\.classList\.add\("is-connection-status"\)/);
  assert.doesNotMatch(reconnectSource, /if \(!state && !sharedRunModel\(\)\) return;/);
  assert.match(reconnectSource, /sharedRunReconnectTimer = setTimeout\([\s\S]*?if \(state \|\| sharedRunModel\(\)\) render\(\);/);
  assert.match(indexHtml, /id="shared-run-connection"[^>]+role="status"/);
  assert.match(approvalSource, /connectionVisible = \["reconnecting", "stale"\]\.includes\(sharedRun\?\.stream_state\)/);
  assert.match(approvalSource, /incident-strip"\]\.hidden = !connectionVisible/);
  assert.match(approvalSource, /Repair was executed, but independent verification failed/);
  assert.match(appJs, /verification\.passed \? "Passed" : verification\.failed \? "Failed" : "Awaiting independent check"/);
  assert.match(appJs, /function resetIncidentStageForRun\(runId\)[\s\S]*?incidentStageFollowsAuthority = true/);
  assert.match(appJs, /function cancelSharedRunReconnect\(runId = null\) \{\s*if \(runId !== null && sharedRun\?\.run_id !== runId\) return false;[\s\S]*?clearTimeout\(sharedRunReconnectTimer\)/);
  assert.match(appJs, /if \(selectedRunId !== runId\) \{[\s\S]*?cancelSharedRunReconnect\(\);[\s\S]*?selectedRunStateRetry\.cancel\(\);/);
  assert.match(appJs, /bindCanonicalRunSelection\(loop\)[\s\S]*?resetIncidentStageForRun\(runId\)/);
  assert.match(appJs, /data-start-guided-replay/);
  assert.match(headerSource, /Recovery verification incident/);
  const stagePanelSource = appJs.slice(appJs.indexOf("function renderIncidentStagePanel"), appJs.indexOf("function renderIncidentStageRail"));
  assert.match(stagePanelSource, /const verification = incidentVerificationProjection\(shared\);/);
  assert.doesNotMatch(stagePanelSource, /verification\?\.payload\?\.passed/);
  assert.match(sharedRecoverySource, /const verificationProjection = incidentVerificationProjection\(shared\);/);
  assert.doesNotMatch(sharedRecoverySource, /verification\.payload\.passed/);
  assert.match(sharedSummarySource, /const verification = incidentVerificationProjection\(shared\);/);
  assert.doesNotMatch(sharedSummarySource, /verification\?\.payload\?\.passed/);
  assert.match(timelineSource, /incidentCompareControlAvailable\(shared\)/);
  const recoveryNextActionSource = appJs.slice(appJs.indexOf("function recoveryNextAction"), appJs.indexOf("function compactAgentSwitcherMarkup"));
  assert.match(recoveryNextActionSource, /if \(verification\.failed\) return "Review failed verification with an operator";/);
  assert.match(railSource, /focusedStage = null/);
  assert.match(railSource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(stylesCss, /\.causal-note\.note-deploy \{ left: clamp\(140px, 14%, calc\(100% - 140px\)\);/);
});

test("incident workspaces render only the strict server focus projection while Architecture and Live stay complete", () => {
  const diagnosisSource = appJs.slice(appJs.indexOf("function incidentFocusLayerMarkup"), appJs.indexOf("function bindCanonicalCanvasIdentity"));
  assert.match(appJs, /incidentFocusWorkspace/);
  assert.match(appJs, /diagnoseViewTopology\(state\?\.topology_views\)/);
  assert.match(diagnosisSource, /data-focus-node-count/);
  assert.match(diagnosisSource, /data-focus-edge-count/);
  assert.match(diagnosisSource, /layout: "incident-focus"/);
  assert.match(appJs, /renderSourceCanvas\("architecture"\)/);
  assert.match(appJs, /renderSourceCanvas\("live", shared\?\.topology/);
  assert.match(stylesCss, /\.incident-focus-workspace \.incident-focus-node/);
  assert.match(stylesCss, /@keyframes incident-focus-path-enter/);
  assert.doesNotMatch(diagnosisSource, /failure observed/i);
});

test("incident stage panels turn recorded repair facts into readable operator evidence", () => {
  const stagePanelSource = appJs.slice(appJs.indexOf("function incidentActionLabel"), appJs.indexOf("function renderIncidentStageRail"));
  assert.match(stagePanelSource, /value\.replaceAll\("_", " "\)/);
  assert.match(stagePanelSource, /plan\?\.payload\?\.repair/);
  assert.match(stagePanelSource, /repair\.payload\?\.repair/);
  assert.match(stagePanelSource, /repair \? "Repair completed"/);
  assert.doesNotMatch(stagePanelSource, /restore_checkout_payment_endpoint/);
});

test("incident focus settles every server-projected node before the review gate and isolates recovery detail", () => {
  const focusSource = appJs.slice(appJs.indexOf("function incidentFocusLayerMarkup"), appJs.indexOf("function startIncidentFocusSignals"));
  const nodeSource = appJs.slice(appJs.indexOf("function sourceNodeMarkup"), appJs.indexOf("function incidentFocusStatusLabel"));
  assert.match(focusSource, /focus\.nodes\.map\(\(node, transitionIndex\)/);
  assert.match(focusSource, /transitionIndex/);
  assert.match(appJs, /startLiveSignalLoop\(\{ nodeFeedback: false \}\)/);
  assert.match(nodeSource, /incident-focus-enter-\$\{transitionIndex\}/);
  assert.match(stylesCss, /animation: incident-focus-node-enter \.42s/);
  assert.match(stylesCss, /incident-focus-enter-5 \{ animation-delay: \.18s; \}/);
  assert.doesNotMatch(stylesCss, /incident-focus-node:nth-of-type/);
  assert.match(stylesCss, /\.recovery-collaboration-panel \{[\s\S]*?overflow: hidden;[\s\S]*?isolation: isolate;/);
  assert.match(stylesCss, /\.recovery-collaboration-panel \.recovery-execution-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(stylesCss, /\.recovery-collaboration-panel \.recovery-workflow-nodes \{[\s\S]*?display: none;/);
  assert.match(stylesCss, /\.recovery-execution-grid \{[\s\S]*?isolation: isolate;[\s\S]*?overflow: hidden;/);
  assert.match(stylesCss, /\.recovery-handoff \{ display: none; \}/);
  assert.match(stylesCss, /\.recovery-step-detail \{[\s\S]*?z-index: 2;[\s\S]*?overflow: auto;/);
});

test("recovery console keeps workflow facts in the canvas while the Unified Context Rail owns interaction", () => {
  assert.match(stylesCss, /\[data-mode="agents"\] \.metric-cluster, \.app-shell\[data-mode="agents"\] \.legend-menu \{ display: none;/);
  assert.match(appJs, /Projected recovery workflow/);
  assert.match(appJs, /See Unified Context Rail/);
  assert.match(appJs, /workspaceSummaryRailMarkup\(\)/);
  assert.match(appJs, /bindOperationsTeamRailControls\(rail\)/);
  assert.match(appJs, /querySelectorAll\("\[data-agent-team-role\]"\)[\s\S]*?openAgentTeamSession\(button\.dataset\.agentTeamRole/);
  assert.match(appJs, /querySelector\("\[data-agent-team-send\]"\)[\s\S]*?submitAgentTeamComposer\(form\)/);
  assert.doesNotMatch(appJs, /recovery-command-form/);
  const recoveryTopologySource = appJs.slice(appJs.indexOf("function canonicalRecoveryTopologyMarkup"), appJs.indexOf("function renderTwinLayer"));
  assert.match(recoveryTopologySource, /Recovery impact/);
  assert.doesNotMatch(recoveryTopologySource, /Canonical topology/);
  assert.doesNotMatch(recoveryTopologySource, /projection_revision\.slice/);
});

test("pure-black mode keeps structural component and connector edges high contrast", () => {
  assert.match(stylesCss, /:root\[data-theme="dark"\][\s\S]+--line-strong: #f0f0f0;/s);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.edge-line \{ stroke: #e7e7e7;/);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.twin-node \{[^}]+border-color: rgba\(255, 255, 255, \.78\)/s);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-tier \.source-node \{ border-color: #f5f5f5; \}/);
});

test("live incident state requires referenced explicit development failure evidence", () => {
  const source = {
    status: "live",
    authoritative: true,
    topology: { nodes: [{ id: "checkout" }, { id: "payment" }, { id: "kafka" }], edges: [] },
    evidence: [{
      id: "live-failure",
      signal: "traces",
      value: { services: ["checkout", "payment"] },
      payload: {
        resourceSpans: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
          scopeSpans: [{ spans: [{ name: "payment", status: { code: 2, message: "unavailable" } }] }]
        }]
      }
    }]
  };
  const active = liveIncidentNodeStates({
    mode: "development",
    source,
    events: [{ type: "evidence.queried", evidence_refs: ["live-failure"] }]
  });
  assert.deepEqual(active, { checkout: "impact", payment: "impact", kafka: "observed" });
  assert.deepEqual(liveIncidentNodeStates({ mode: "captured", source, events: [{ evidence_refs: ["live-failure"] }] }), {
    checkout: "observed", payment: "observed", kafka: "observed"
  });
  assert.deepEqual(liveIncidentNodeStates({
    mode: "development",
    source,
    events: [
      { type: "evidence.queried", evidence_refs: ["live-failure"] },
      { type: "verification.completed", payload: { passed: true }, evidence_refs: [] }
    ]
  }), { checkout: "verified", payment: "verified", kafka: "observed" });
  assert.deepEqual(liveIncidentNodeStates({ source: { status: "stale", topology: source.topology } }), {
    checkout: "warning", payment: "warning", kafka: "warning"
  });
  assert.deepEqual(liveIncidentNodeStates({ source: { status: "disconnected", topology: source.topology } }), {
    checkout: "dormant", payment: "dormant", kafka: "dormant"
  });
});

test("every canvas mode exposes the shared status-dot contract with compact toolbar copy", () => {
  assert.match(appJs, /data-status="\$\{escapeHtml\(nodeState\)\}"/);
  assert.match(appJs, /control-system-tile[\s\S]+?data-status="\$\{escapeHtml\(agentNodeTone\(node\.status\)\)\}"/);
  assert.match(appJs, /data-status="\$\{escapeHtml\(status\)\}" data-transition-key/);
  assert.match(appJs, /node\.connectivity === "unlinked" \? "unlinked"/);
  assert.match(stylesCss, /\.twin-node\.is-observed[^}]+var\(--blue\)/);
  assert.match(stylesCss, /\.twin-node\.is-healthy[^}]+var\(--green\)/);
  assert.match(stylesCss, /\.twin-node\.is-warning[^}]+var\(--amber\)/);
  assert.match(stylesCss, /\.twin-node\.is-impact[^}]+var\(--red\)/);
  assert.match(stylesCss, /\.twin-node\.is-quiet[^}]+var\(--faint\)/);
  assert.match(indexHtml, />Status<\/strong>/);
  assert.match(indexHtml, /Live \/ active/);
  assert.match(indexHtml, /Failure \/ rejected/);
  assert.match(stylesCss, /\.metric small:empty \{ display: none; \}/);
  assert.match(appJs, /node\.connectivity === "unlinked" \? "unlinked" : sharedStatus \|\| node\.status \|\| "dormant"/);
  assert.match(appJs, /sourceStatusLabel\(status, source\.status\)/);
  assert.match(stylesCss, /\.component-context\.is-warning, \.component-context\.is-unlinked/);
  assert.doesNotMatch(appJs, /observed components arranged by system role/);
  assert.doesNotMatch(appJs, /This canvas does not synthesize services or telemetry/);
});

test("a reserved shared run stays on the backend binding path until canonical topology arrives", () => {
  assert.match(appJs, /if \(shared \|\| sharedRun\?\.loop\) \{/);
  assert.match(appJs, /if \(sharedRun\?\.loop && mode !== "architecture"\) \{/);
  assert.match(appJs, /renderCanonicalTopologyPending\(/);
  assert.doesNotMatch(appJs, /sharedRunFrame\(/);
  assert.doesNotMatch(appJs, /sharedCompareFrames\(/);
});

test("final competition shell gives every workspace one bounded canvas and one shared frosted rail", () => {
  const finalShell = stylesCss.slice(stylesCss.lastIndexOf("/* Final competition demo shell"));
  assert.match(finalShell, /--demo-page-field: #e9eef1;/);
  assert.match(finalShell, /--demo-workspace-radius: 22px;/);
  assert.match(finalShell, /\.app-shell\[data-mode\] \.twin-workspace \{[\s\S]*?padding: 16px 20px;/);
  assert.match(finalShell, /\.app-shell\[data-mode\] \.canvas-shell \{[\s\S]*?border-radius: var\(--demo-workspace-radius\);[\s\S]*?overflow: hidden;/);
  assert.match(finalShell, /\.app-shell\[data-mode\] \.operations-team-rail \{[\s\S]*?border-radius: var\(--demo-workspace-radius\);[\s\S]*?overflow: hidden;/);
  assert.match(finalShell, /\.app-shell\[data-mode\] #timeline-dock \{[\s\S]*?border-radius: var\(--demo-control-radius\);/);
  assert.match(finalShell, /\.app-shell\[data-mode="replay"\] \.canvas-shell,[\s\S]*?\.app-shell\[data-mode="agents"\] \.canvas-shell,[\s\S]*?\.app-shell\[data-mode="compare"\] \.canvas-shell \{[\s\S]*?min-width: 0;/);
  assert.match(finalShell, /@media \(max-width: 900px\) \{[\s\S]*?\.app-shell\[data-mode\] \.twin-workspace \{[\s\S]*?padding: 10px 12px;/);
});

test("component vectors stay transparent, semantically colored, and status-independent", () => {
  assert.match(stylesCss, /\.node-icon \{[^}]+border: 0;[^}]+color: var\(--icon\);[^}]+background: transparent;/);
  assert.match(stylesCss, /\.node-icon \{[^}]+border: 0;[^}]+color: var\(--icon\);[^}]+background: transparent;/);
  assert.match(stylesCss, /\.source-node\.kind-stream \{ --icon: #d97706;/);
  assert.match(stylesCss, /\.source-node\.kind-database \{ --icon: #059669;/);
  assert.match(appJs, /controlSystemTileMarkup\(node, \{ rail: true \}\)/);
  assert.match(appJs, /<span class="node-icon" aria-hidden="true"><i class="ph ph-\$\{iconForLive\(node\)\}"><\/i><\/span>/);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.node-icon \{ color: var\(--icon\); background: transparent; \}/);
  assert.match(stylesCss, /\.twin-node\.is-impact[^}]+--signal: var\(--red\)/);
  assert.match(stylesCss, /\.operations-team-rail \.control-system-tile \.node-status-dot\.is-accepted \{ --control-status: var\(--green\); \}/);
});

test("the contextual drawer and workspace menu use restrained semantic color", () => {
  assert.match(appJs, /context-drawer"\]\.dataset\.tone = drawerTone\(selected\)/);
  assert.match(appJs, /function drawerTone\(focus\)/);
  assert.match(appJs, /\["impact", "root", "rejected"\]\.includes\(source\.status\)/);
  assert.match(appJs, /source\.status === "verified"/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="stream"\] \{ --drawer-accent: #d97706;/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="impact"\] \{ --drawer-accent: var\(--red\); \}/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="verified"\] \{ --drawer-accent: var\(--green\); \}/);
  assert.match(stylesCss, /\.drawer-header[^}]+box-shadow: inset 3px 0 0 var\(--drawer-accent\)/s);
  assert.match(stylesCss, /\.drawer-tab\[aria-selected="true"\][^}]+box-shadow: inset 0 -2px 0 var\(--drawer-accent\)/s);
  assert.match(stylesCss, /\.nav-button\[data-nav-tab="incidents"\] \{ --menu-accent: var\(--red\); \}/);
  assert.match(stylesCss, /\.nav-button::before[^}]+background: var\(--menu-accent, var\(--faint\)\)/s);
});

test("stage projection preserves evaluator, owner, recovery, and evolve ordering", () => {
  const events = [
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "approval.granted" },
    { type: "repair.executed" },
    { type: "verification.completed" },
    { type: "regression.created" },
    { type: "policy.evaluated" }
  ];
  assert.deepEqual(eventsAtStage(events, 3).map(({ type }) => type), ["evaluation.rejected"]);
  assert.deepEqual(eventsAtStage(events, 5).map(({ type }) => type), ["evaluation.rejected", "evaluation.accepted", "approval.requested"]);
  assert.deepEqual(eventsAtStage(events, 7).map(({ type }) => type), events.map(({ type }) => type));
});

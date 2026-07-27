// Browser-side, fail-closed boundary for frozen Incident Workspace contract v1.2
// (backend commit 99f84dfb84fabc6d0b45148f0bc415d419ba1ff4). This module owns no
// incident truth: it only accepts complete server projections and records local
// presentation state keyed to their canonical identity.

const CLASSIFICATIONS = new Set([
  "External dependency",
  "Data store",
  "Control plane",
  "Observed boundary",
  "Relationship unavailable"
]);
const LIFECYCLE_STATES = new Set(["INITIALIZING", "ACTIVE", "DEGRADED", "AWAITING_OWNER", "BLOCKED", "NEEDS_HUMAN", "ABSTAINED"]);
const LIFECYCLE_STAGES = new Set(["INVESTIGATE", "DECIDE", "EXECUTE", "VERIFY", "CLOSED", "NEEDS_HUMAN"]);
const GATE1_STATES = new Set(["NONE", "ACTIVE", "CONSUMED", "INVALIDATED"]);
const EXPLANATION_STATES = new Set(["DEGRADED", "COMPLETED", "BLOCKED"]);
const EXPLANATION_EVENT_STATES = new Set(["STARTED", "COMPLETED", "DEGRADED"]);
const TRUTH_LABELS = new Set(["DEGRADED", "TEST_DETERMINISTIC", "DEMO", "LIVE"]);
const INVESTIGATION_DISPOSITIONS = new Set(["ACCEPTED", "DEGRADED", "ABSTAINED", "CRITIC_REJECTED"]);
const INVESTIGATION_CLAIM_KINDS = new Set(["OBSERVATION", "HYPOTHESIS"]);
const CRITIC_DECISIONS = new Set(["PASS", "FAIL", "AMBIGUOUS"]);
const EVIDENCE_AUTHORITIES = new Set(["T0_AUTHORITATIVE_CURRENT", "T1_DIRECT_CURRENT", "T2_DERIVED", "T3_HISTORICAL", "T4_UNTRUSTED"]);
const EVIDENCE_FRESHNESS = new Set(["CURRENT", "AGING", "STALE", "UNKNOWN"]);
const EVIDENCE_PROOF_SCOPES = new Set(["CURRENT_OBSERVATION", "REFERENCE_ONLY"]);
const EVIDENCE_SOURCE_KINDS = new Set(["METRIC", "LOG", "TRACE", "CHANGE", "CONFIG", "TOPOLOGY", "KNOWLEDGE", "SOURCE_READBACK"]);
const NOTIFICATION_TYPES = new Set(["incident.accepted", "incident.updated"]);
const IDENTITY_KEYS = ["tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision", "workflow_id", "workflow_run_id", "created_at"];
const VERSION_BUNDLE_KEYS = [
  "capability_registry_version", "card_schema_version", "context_pack_version", "core_policy_version", "evidence_schema_version",
  "model_policy_version", "policy_version", "role_prompt_version", "schema_version", "tool_schema_version", "workflow_version"
];
const ACTION_TAXONOMY = new Map([
  ["FIND_CAUSE", { title: "Find Cause", cta: "request_gate_1" }],
  ["MAP_IMPACT", { title: "Map Impact", cta: "run_read_capability" }],
  ["REVIEW_EVIDENCE", { title: "Review Evidence", cta: "review_evidence" }],
  ["APPROVE_PLAN", { title: "Approve Plan", cta: "request_gate_2" }],
  ["APPLY_FIX", { title: "Apply Fix", cta: "submit_approved_dry_run" }]
]);
const ACTION_CTAS = new Set([...ACTION_TAXONOMY.values()].map((item) => item.cta));
const ACTION_RECEIPT_STATUSES = new Set(["GATE1_GRANTED", "FRESH_READ_COMPLETED"]);

export class ControlPlaneContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ControlPlaneContractError";
    this.code = code;
  }
}

export function parseIncidentSummaries(value) {
  if (!Array.isArray(value) || value.length > 50) fail("incident_summaries_invalid");
  return value.map((summary) => parseIncidentSummary(summary));
}

export function parseIncidentSummary(value) {
  exactObject(value, [
    "case_id", "incident_id", "run_id", "topology_revision", "projection_revision", "sequence",
    "lifecycle_state", "lifecycle_stage", "status", "title", "summary"
  ], "incident_summary_unknown_field", [
    "case_id", "incident_id", "run_id", "topology_revision", "projection_revision", "sequence",
    "lifecycle_state", "status", "title", "summary"
  ]);
  assertText(value.case_id, "case_id_invalid");
  assertText(value.incident_id, "incident_id_invalid");
  assertText(value.run_id, "run_id_invalid");
  assertText(value.topology_revision, "topology_revision_invalid");
  assertInteger(value.projection_revision, "projection_revision_invalid");
  assertInteger(value.sequence, "sequence_invalid");
  assertEnum(value.lifecycle_state, LIFECYCLE_STATES, "lifecycle_state_invalid");
  if (value.lifecycle_stage !== undefined) assertEnum(value.lifecycle_stage, LIFECYCLE_STAGES, "lifecycle_stage_invalid");
  assertText(value.status, "incident_status_invalid");
  assertText(value.title, "incident_title_invalid");
  assertText(value.summary, "incident_summary_invalid");
  return clone(value);
}

export function parseIncidentNotification(value) {
  exactObject(value, ["notification_id", "event_type", "occurred_at", "incident"], "incident_notification_unknown_field");
  assertText(value.notification_id, "notification_id_invalid");
  assertEnum(value.event_type, NOTIFICATION_TYPES, "notification_event_type_invalid");
  assertTimestamp(value.occurred_at, "notification_occurred_at_invalid");
  return { notification_id: value.notification_id, event_type: value.event_type, occurred_at: value.occurred_at, incident: parseIncidentSummary(value.incident) };
}

export function parseIncidentProjection(value) {
  exactObject(value, [
    ...IDENTITY_KEYS,
    "schema_version", "projection_revision", "sequence", "lifecycle_state", "status", "operator_title", "operator_summary",
    "generated_at", "graph", "impacted_path", "evidence_revision", "gate_revision", "action_revision",
    "evidence_refs", "degraded_code", "lifecycle_stage", "gate1_state", "investigation_result"
  ], "incident_projection_unknown_field", [
    ...IDENTITY_KEYS, "projection_revision", "sequence", "lifecycle_state", "status", "generated_at", "graph",
    "evidence_revision", "gate_revision", "action_revision"
  ]);
  parseIdentity(value);
  if (value.schema_version !== undefined && value.schema_version !== "flowpulse.incident-projection.v1") fail("incident_projection_schema_invalid");
  assertInteger(value.projection_revision, "projection_revision_invalid");
  assertInteger(value.sequence, "sequence_invalid");
  assertEnum(value.lifecycle_state, LIFECYCLE_STATES, "lifecycle_state_invalid");
  assertText(value.status, "incident_status_invalid");
  if (value.operator_title !== undefined) assertText(value.operator_title, "operator_title_invalid");
  if (value.operator_summary !== undefined) assertText(value.operator_summary, "operator_summary_invalid");
  assertTimestamp(value.generated_at, "generated_at_invalid");
  const graph = parseGraph(value.graph);
  const componentIds = new Set(graph.nodes.map((node) => node.component_id));
  const impacted_path = stringList(value.impacted_path === undefined ? [] : value.impacted_path, "impacted_path_invalid");
  if (impacted_path.some((componentId) => !componentIds.has(componentId))) fail("impacted_path_component_unknown");
  assertInteger(value.evidence_revision, "evidence_revision_invalid");
  assertInteger(value.gate_revision, "gate_revision_invalid");
  assertInteger(value.action_revision, "action_revision_invalid");
  const evidence_refs = stringList(value.evidence_refs === undefined ? [] : value.evidence_refs, "evidence_refs_invalid");
  if (value.degraded_code !== undefined && value.degraded_code !== null) assertText(value.degraded_code, "degraded_code_invalid");
  const lifecycle_stage = value.lifecycle_stage === undefined ? "INVESTIGATE" : value.lifecycle_stage;
  const gate1_state = value.gate1_state === undefined ? "NONE" : value.gate1_state;
  assertEnum(lifecycle_stage, LIFECYCLE_STAGES, "lifecycle_stage_invalid");
  assertEnum(gate1_state, GATE1_STATES, "gate1_state_invalid");
  const projection = { ...clone(value), graph, impacted_path, evidence_refs };
  if (value.investigation_result !== undefined && value.investigation_result !== null) {
    projection.investigation_result = parseInvestigationResult(value.investigation_result, projection);
  }
  assertTrustedProjectionStage(projection, lifecycle_stage, gate1_state);
  return projection;
}

// This is a presentation-safe read model. It has no authority to advance a
// lifecycle: the stage is accepted only when the canonical projection carries
// a valid backend result. Raw receipt/event/provider/internal IDs stay out of
// this shape and therefore out of the primary operator card.
export function investigationPresentation(value) {
  const projection = parseIncidentProjection(value);
  const lifecycle_stage = projection.lifecycle_stage === undefined ? "INVESTIGATE" : projection.lifecycle_stage;
  const result = projection.investigation_result || null;
  if (!result) return { stage: "INVESTIGATE", outcome: projection.lifecycle_state === "DEGRADED" ? "degraded" : "pending", summary: null, claims: [], evidence: [], critic: null, truth_label: null };
  const accepted = result.disposition === "ACCEPTED";
  const stage = accepted && ["DECIDE", "EXECUTE", "VERIFY", "CLOSED"].includes(lifecycle_stage)
    ? lifecycle_stage
    : "INVESTIGATE";
  return {
    stage,
    outcome: accepted ? "accepted" : "degraded",
    summary: result.summary,
    claims: result.claims.map(({ kind, statement }) => ({ kind, statement })),
    evidence: result.evidence.map(({ source_kind, observed_at, freshness, authority, proof_scope, parent_evidence_refs }) => ({ source_kind, observed_at, freshness, authority, proof_scope, lineage_count: parent_evidence_refs.length })),
    critic: result.critic ? { identity: result.critic.identity, decision: result.critic.decision } : null,
    truth_label: result.truth_label
  };
}

export function parseIncidentEvent(value) {
  exactObject(value, [
    ...IDENTITY_KEYS, "schema_version", "projection_revision", "sequence", "event_type", "occurred_at",
    "evidence_refs", "explanation_status", "payload"
  ], "incident_event_unknown_field", [
    ...IDENTITY_KEYS, "projection_revision", "sequence", "event_type", "occurred_at"
  ]);
  parseIdentity(value);
  if (value.schema_version !== undefined && value.schema_version !== "flowpulse.incident-event.v1") fail("incident_event_schema_invalid");
  assertInteger(value.projection_revision, "projection_revision_invalid");
  assertInteger(value.sequence, "sequence_invalid");
  assertText(value.event_type, "event_type_invalid");
  assertTimestamp(value.occurred_at, "event_occurred_at_invalid");
  const evidence_refs = stringList(value.evidence_refs === undefined ? [] : value.evidence_refs, "event_evidence_refs_invalid");
  if (value.explanation_status !== undefined && value.explanation_status !== null) assertEnum(value.explanation_status, EXPLANATION_EVENT_STATES, "explanation_event_status_invalid");
  const payload = stringRecord(value.payload === undefined ? {} : value.payload, "event_payload_invalid");
  return { ...clone(value), evidence_refs, payload };
}

export function parseNodeExplanationReceipt(value) {
  exactObject(value, ["explanation", "reused"], "node_explanation_receipt_unknown_field");
  if (typeof value.reused !== "boolean") fail("node_explanation_reused_invalid");
  const explanation = parseNodeExplanation(value.explanation);
  return { reused: value.reused, explanation };
}

export function nodeExplanationCommand(projection, componentId) {
  const parsed = parseIncidentProjection(projection);
  assertText(componentId, "component_id_invalid");
  const node = parsed.graph.nodes.find((candidate) => candidate.component_id === componentId);
  if (!node || !parsed.impacted_path.includes(componentId)) fail("component_not_impacted");
  return {
    incident_id: parsed.incident_id,
    run_id: parsed.run_id,
    topology_revision: parsed.topology_revision,
    projection_revision: parsed.projection_revision,
    component_id: componentId,
    idempotency_key: `node-explanation:${parsed.run_id}:${parsed.projection_revision}:${componentId}`
  };
}

export function parseNextBestActions(value) {
  if (!Array.isArray(value) || value.length > 3) fail("next_best_actions_invalid");
  const actions = value.map(parseNextBestAction);
  if (new Set(actions.map((action) => action.action_id)).size !== actions.length) fail("next_best_action_duplicate");
  if (new Set(actions.map((action) => action.display_order)).size !== actions.length) fail("next_best_action_order_duplicate");
  if (actions.filter((action) => action.recommended).length > 1) fail("next_best_action_recommended_invalid");
  return actions.sort((left, right) => left.display_order - right.display_order);
}

export function parseWorkspaceActionReceipt(value) {
  exactObject(value, [
    ...IDENTITY_KEYS, "action_id", "idempotency_key", "status", "external_write_performed", "gate1_lease_id", "reason"
  ], "workspace_action_receipt_unknown_field", [
    ...IDENTITY_KEYS, "action_id", "idempotency_key", "status", "reason"
  ]);
  parseIdentity(value);
  assertText(value.action_id, "workspace_action_id_invalid");
  assertText(value.idempotency_key, "workspace_action_idempotency_invalid");
  assertEnum(value.status, ACTION_RECEIPT_STATUSES, "workspace_action_status_invalid");
  assertText(value.reason, "workspace_action_reason_invalid");
  if (value.external_write_performed !== undefined && value.external_write_performed !== false) fail("workspace_action_write_not_allowed");
  if (value.gate1_lease_id !== undefined && value.gate1_lease_id !== null) assertText(value.gate1_lease_id, "workspace_action_gate1_lease_invalid");
  if (!value.gate1_lease_id) fail("workspace_action_gate1_lease_required");
  return clone(value);
}

export function parseActionInvocationCommand(value) {
  exactObject(value, ["incident_id", "run_id", "topology_revision", "projection_revision", "action_id", "idempotency_key"], "workspace_action_command_unknown_field");
  for (const field of ["incident_id", "run_id", "topology_revision", "action_id", "idempotency_key"]) assertText(value[field], `${field}_invalid`);
  assertInteger(value.projection_revision, "projection_revision_invalid");
  return clone(value);
}

export function actionInvocationCommand(projection, action) {
  const parsedProjection = parseIncidentProjection(projection);
  const parsedAction = parseNextBestActions([action])[0];
  if (!matchesActionProjection(parsedAction, parsedProjection) || Date.parse(parsedAction.expires_at) <= Date.now()) fail("workspace_action_card_stale");
  return parseActionInvocationCommand({
    incident_id: parsedAction.incident_id,
    run_id: parsedAction.run_id,
    topology_revision: parsedAction.topology_revision,
    projection_revision: parsedAction.projection_revision,
    action_id: parsedAction.action_id,
    // The opaque server action identifier is stable for this canonical card
    // and deliberately doubles as the idempotency key. The browser does not
    // invent action authority or a second identity namespace.
    idempotency_key: parsedAction.action_id
  });
}

export function createControlPlaneState() {
  return {
    mode: "live",
    connection: "connecting",
    projection: null,
    projections: new Map(),
    toast: null,
    focused_path: [],
    focus_status: "idle",
    selected_component_id: null,
    explanation: { status: "idle", receipt: null, key: null },
    actions: emptyActions(),
    seen_notification_ids: new Set(),
    last_notification_id: null,
    last_case_sequence: 0
  };
}

export function controlPlaneReducer(current, action) {
  const state = copyState(current);
  const effects = [];
  try {
    if (action?.type === "summaries.hydrated") {
      for (const summary of parseIncidentSummaries(action.summaries)) {
        effects.push({ type: "projection.load", case_id: summary.case_id, identity: summary });
      }
      state.connection = "connected";
      return { state, effects };
    }
    if (action?.type === "notification.received") {
      const notification = parseIncidentNotification(action.notification);
      if (state.seen_notification_ids.has(notification.notification_id)) return { state, effects };
      state.seen_notification_ids.add(notification.notification_id);
      state.last_notification_id = notification.notification_id;
      state.toast = notification;
      // This is an asynchronous canonical-projection hydration triggered by a
      // server notification. It is not a user click, fresh capability, tool,
      // lifecycle command, or conversation turn.
      effects.push({ type: "projection.load", case_id: notification.incident.case_id, identity: notification.incident });
      return { state, effects };
    }
    if (action?.type === "projection.hydrated") {
      const projection = parseIncidentProjection(action.projection);
      if (action.identity && !matchesSummarySnapshot(action.identity, projection)) {
        state.connection = "stale";
        return { state, effects };
      }
      const cached = state.projections.get(projection.case_id);
      if (cached && sameIdentity(cached, projection) && projection.projection_revision < cached.projection_revision) return { state, effects };
      state.projections.set(projection.case_id, projection);
      const toastMatches = state.toast && matchesSummarySnapshot(state.toast.incident, projection);
      const currentMatches = state.projection && sameIdentity(state.projection, projection);
      if (!state.projection || currentMatches || (state.mode === "incident" && toastMatches)) {
        state.projection = projection;
        state.last_case_sequence = Math.max(state.last_case_sequence, projection.sequence);
        state.actions = emptyActions(state.actions);
        if (allowsInvestigateActions(projection)) effects.push({ type: "actions.load", case_id: projection.case_id, identity: projection });
      }
      state.connection = "connected";
      if (state.mode === "incident" && toastMatches) {
        state.focused_path = [...projection.impacted_path];
        state.focus_status = "ready";
      }
      return { state, effects };
    }
    if (action?.type === "toast.focus") {
      state.mode = "incident";
      state.selected_component_id = null;
      // Focus is presentation-only. It may select a cached different case,
      // so discard cards from any prior case rather than letting cross-run
      // recommendations appear under the new canonical graph.
      state.actions = emptyActions();
      const cached = state.toast ? state.projections.get(state.toast.incident.case_id) : null;
      if (state.toast && cached && matchesSummarySnapshot(state.toast.incident, cached)) {
        state.projection = cached;
        state.last_case_sequence = cached.sequence;
        state.focused_path = [...cached.impacted_path];
        state.focus_status = "ready";
      } else {
        state.focused_path = [];
        state.focus_status = "loading";
      }
      return { state, effects };
    }
    if (action?.type === "case.select") {
      const projection = state.projections.get(action.case_id);
      if (!projection) {
        state.connection = "stale";
        return { state, effects };
      }
      state.projection = projection;
      state.last_case_sequence = projection.sequence;
      state.selected_component_id = null;
      state.explanation = { status: "idle", receipt: null, key: null };
      state.actions = emptyActions();
      state.focused_path = [];
      state.focus_status = "idle";
      return { state, effects };
    }
    if (action?.type === "actions.hydrated") {
      if (!state.projection || !action.identity || !matchesActionProjection(action.identity, state.projection)) {
        state.connection = "stale";
        return { state, effects };
      }
      if (!allowsInvestigateActions(state.projection)) {
        state.actions = emptyActions(state.actions);
        return { state, effects };
      }
      const cards = parseNextBestActions(action.actions);
      if (cards.some((card) => !matchesActionProjection(card, state.projection))) {
        state.connection = "degraded";
        state.actions = emptyActions(state.actions);
        return { state, effects };
      }
      const phase = investigateCardPhase(state.actions);
      if (!cardsMatchInvestigatePhase(cards, phase, state.actions)) {
        state.actions = { ...state.actions, status: phase === "awaiting_gate1_event" ? phase : "degraded", cards: [], in_flight: null };
        if (phase !== "awaiting_gate1_event") state.connection = "degraded";
        return { state, effects };
      }
      state.actions = { ...state.actions, status: "ready", cards, in_flight: null };
      return { state, effects };
    }
    if (action?.type === "action.clicked") {
      if (!state.projection || !allowsInvestigateActions(state.projection) || state.connection !== "connected" || state.actions.in_flight) return { state, effects };
      const card = state.actions.cards.find((candidate) => candidate.action_id === action.action_id);
      if (!card || Date.parse(card.expires_at) <= Date.now()) {
        state.connection = "stale";
        state.actions = { ...state.actions, cards: [], status: "stale", in_flight: null };
        return { state, effects };
      }
      const phase = investigateCardPhase(state.actions);
      if (!cardsMatchInvestigatePhase([card], phase, state.actions)) {
        state.connection = "degraded";
        state.actions = { ...state.actions, cards: [], status: "degraded", in_flight: null };
        return { state, effects };
      }
      const command = actionInvocationCommand(state.projection, card);
      state.actions = { ...state.actions, status: "invoking", in_flight: { action_id: card.action_id, command, cta: card.cta } };
      effects.push({ type: "action.invoke", case_id: state.projection.case_id, action_id: card.action_id, command });
      return { state, effects };
    }
    if (action?.type === "action.receipt") {
      const receipt = parseWorkspaceActionReceipt(action.receipt);
      const inFlight = state.actions.in_flight;
      if (!state.projection || !inFlight || !sameIdentity(state.projection, receipt)
        || receipt.action_id !== inFlight.action_id || receipt.idempotency_key !== inFlight.command.idempotency_key
        || (receipt.status === "GATE1_GRANTED" && inFlight.cta !== "request_gate_1")
        || (receipt.status === "FRESH_READ_COMPLETED" && inFlight.cta !== "run_read_capability")) {
        state.connection = "stale";
        state.actions = emptyActions(state.actions);
        return { state, effects };
      }
      const gate1 = receipt.status === "GATE1_GRANTED"
        ? { receipt, event: matchingActionEvent(state.actions.events, receipt, "workspace.action.gate1_granted") }
        : state.actions.gate1;
      state.actions = {
        ...state.actions,
        status: receipt.status === "GATE1_GRANTED" ? "awaiting_gate1_event" : "completed",
        cards: [],
        in_flight: null,
        receipt,
        gate1
      };
      effects.push({ type: "projection.load", case_id: state.projection.case_id, identity: null });
      return { state, effects };
    }
    if (action?.type === "node.clicked") {
      if (!state.projection || state.connection !== "connected") return { state, effects };
      const command = nodeExplanationCommand(state.projection, action.component_id);
      const key = command.idempotency_key;
      if (state.explanation.status === "starting") return { state, effects };
      if (state.explanation.key === key && ["starting", "completed", "degraded", "blocked"].includes(state.explanation.status)) return { state, effects };
      state.mode = "incident";
      state.selected_component_id = action.component_id;
      state.explanation = { status: "starting", receipt: null, key };
      effects.push({ type: "node-explanation.start", command });
      // Recommendation cards are a server read, not a fresh capability. This
      // happens only after the operator selects an impacted node; toast focus
      // itself remains zero-network and zero-command.
      if (allowsInvestigateActions(state.projection)) {
        effects.push({ type: "actions.load", case_id: state.projection.case_id, identity: state.projection });
      }
      return { state, effects };
    }
    if (action?.type === "explanation.receipt") {
      const receipt = parseNodeExplanationReceipt(action.receipt);
      if (!state.projection || !sameIdentity(state.projection, receipt.explanation)
        || receipt.explanation.projection_revision !== state.projection.projection_revision
        || receipt.explanation.component_id !== state.selected_component_id) {
        state.connection = "stale";
        return { state, effects };
      }
      const status = receipt.explanation.state.toLowerCase();
      state.explanation = { status, receipt, key: nodeExplanationCommand(state.projection, receipt.explanation.component_id).idempotency_key };
      return { state, effects };
    }
    if (action?.type === "case.event") {
      const event = parseIncidentEvent(action.event);
      if (!state.projection || !sameIdentity(state.projection, event)) {
        state.connection = "stale";
        return { state, effects };
      }
      if (event.sequence <= state.last_case_sequence || event.projection_revision < state.projection.projection_revision) return { state, effects };
      state.last_case_sequence = event.sequence;
      if (event.event_type.startsWith("workspace.action.")) {
        state.actions.events = [...state.actions.events, event].slice(-16);
        if (state.actions.gate1.receipt && event.event_type === "workspace.action.gate1_granted") {
          state.actions.gate1 = { ...state.actions.gate1, event: matchingActionEvent(state.actions.events, state.actions.gate1.receipt, "workspace.action.gate1_granted") };
        }
      }
      if (event.projection_revision > state.projection.projection_revision) {
        effects.push({ type: "projection.load", case_id: event.case_id, identity: null });
      }
      if (event.explanation_status && state.explanation.status === "starting") {
        state.explanation = { ...state.explanation, status: event.explanation_status.toLowerCase() };
      }
      return { state, effects };
    }
    if (action?.type === "connection.stale") {
      state.connection = "stale";
      return { state, effects };
    }
    if (action?.type === "connection.connected") {
      state.connection = "connected";
      return { state, effects };
    }
    if (action?.type === "connection.reconnecting") {
      state.connection = "reconnecting";
      return { state, effects };
    }
    if (action?.type === "connection.degraded") {
      state.connection = "degraded";
      return { state, effects };
    }
    return { state, effects };
  } catch (error) {
    if (!(error instanceof ControlPlaneContractError)) throw error;
    state.connection = "degraded";
    return { state, effects };
  }
}

function parseInvestigationResult(value, projection) {
  exactObject(value, [
    ...IDENTITY_KEYS, "schema_version", "result_id", "component_id", "source_action_id", "source_idempotency_key",
    "source_activity_identity", "synthesis_id", "synthesis_activity_id", "synthesis_model_id", "synthesis_provider_id",
    "projection_revision", "evidence_revision", "lifecycle_stage", "disposition", "summary", "claims", "evidence",
    "critic", "degraded_code", "truth_label", "version_bundle", "recorded_at"
  ], "investigation_result_unknown_field", [
    ...IDENTITY_KEYS, "result_id", "component_id", "source_action_id", "source_idempotency_key", "source_activity_identity",
    "synthesis_id", "synthesis_activity_id", "synthesis_provider_id", "projection_revision", "evidence_revision",
    "lifecycle_stage", "disposition", "summary", "truth_label", "version_bundle", "recorded_at"
  ]);
  parseIdentity(value);
  if (value.schema_version !== undefined && value.schema_version !== "flowpulse.investigation-result.v1") fail("investigation_result_schema_invalid");
  for (const field of [
    "result_id", "component_id", "source_action_id", "source_idempotency_key", "source_activity_identity",
    "synthesis_id", "synthesis_activity_id", "synthesis_provider_id", "summary"
  ]) assertText(value[field], `investigation_result_${field}_invalid`);
  if (value.synthesis_model_id !== undefined && value.synthesis_model_id !== null) assertText(value.synthesis_model_id, "investigation_result_synthesis_model_id_invalid");
  assertInteger(value.projection_revision, "investigation_result_projection_revision_invalid");
  assertInteger(value.evidence_revision, "investigation_result_evidence_revision_invalid");
  assertEnum(value.lifecycle_stage, LIFECYCLE_STAGES, "investigation_result_lifecycle_stage_invalid");
  assertEnum(value.disposition, INVESTIGATION_DISPOSITIONS, "investigation_result_disposition_invalid");
  assertEnum(value.truth_label, TRUTH_LABELS, "investigation_result_truth_label_invalid");
  assertTimestamp(value.recorded_at, "investigation_result_recorded_at_invalid");
  if (value.degraded_code !== undefined && value.degraded_code !== null) assertText(value.degraded_code, "investigation_result_degraded_code_invalid");
  if (!IDENTITY_KEYS.every((field) => projection[field] === value[field])) fail("investigation_result_identity_mismatch");
  if (projection.projection_revision !== value.projection_revision || projection.evidence_revision !== value.evidence_revision) fail("investigation_result_revision_mismatch");
  const component = projection.graph.nodes.find((node) => node.component_id === value.component_id);
  if (!component) fail("investigation_result_component_mismatch");
  const evidence = parseInvestigationEvidence(value.evidence === undefined ? [] : value.evidence);
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  if ([...evidenceIds].some((evidenceId) => !projection.evidence_refs.includes(evidenceId))) fail("investigation_result_evidence_mismatch");
  if (evidence.some((item) => item.parent_evidence_refs.some((evidenceId) => evidenceId === item.evidence_id || !evidenceIds.has(evidenceId)))) fail("investigation_evidence_parent_mismatch");
  const claims = parseInvestigationClaims(value.claims === undefined ? [] : value.claims, evidenceIds);
  const critic = value.critic === undefined || value.critic === null ? null : parseInvestigationCritic(value.critic, claims, evidenceIds);
  const version_bundle = parseVersionBundle(value.version_bundle);
  const result = { ...clone(value), claims, evidence, critic, version_bundle };
  assertTrustedInvestigationResult(result);
  return result;
}

function parseInvestigationClaims(value, evidenceIds) {
  if (!Array.isArray(value) || value.length > 64) fail("investigation_claims_invalid");
  const claims = value.map((claim) => {
    exactObject(claim, ["claim_id", "kind", "statement", "evidence_refs"], "investigation_claim_unknown_field");
    assertText(claim.claim_id, "investigation_claim_id_invalid");
    assertEnum(claim.kind, INVESTIGATION_CLAIM_KINDS, "investigation_claim_kind_invalid");
    assertText(claim.statement, "investigation_claim_statement_invalid");
    const evidence_refs = stringList(claim.evidence_refs, "investigation_claim_evidence_invalid");
    if (evidence_refs.some((evidenceId) => !evidenceIds.has(evidenceId))) fail("investigation_claim_evidence_mismatch");
    return { ...clone(claim), evidence_refs };
  });
  if (new Set(claims.map((claim) => claim.claim_id)).size !== claims.length) fail("investigation_claim_duplicate");
  return claims;
}

function parseInvestigationEvidence(value) {
  if (!Array.isArray(value) || value.length > 64) fail("investigation_evidence_invalid");
  const evidence = value.map((item) => {
    exactObject(item, ["evidence_id", "source_kind", "observed_at", "freshness", "authority", "proof_scope", "parent_evidence_refs"], "investigation_evidence_unknown_field", ["evidence_id", "source_kind", "observed_at", "freshness", "authority", "proof_scope"]);
    assertText(item.evidence_id, "investigation_evidence_id_invalid");
    assertEnum(item.source_kind, EVIDENCE_SOURCE_KINDS, "investigation_evidence_source_kind_invalid");
    assertTimestamp(item.observed_at, "investigation_evidence_observed_at_invalid");
    assertEnum(item.freshness, EVIDENCE_FRESHNESS, "investigation_evidence_freshness_invalid");
    assertEnum(item.authority, EVIDENCE_AUTHORITIES, "investigation_evidence_authority_invalid");
    assertEnum(item.proof_scope, EVIDENCE_PROOF_SCOPES, "investigation_evidence_proof_scope_invalid");
    return { ...clone(item), parent_evidence_refs: stringList(item.parent_evidence_refs === undefined ? [] : item.parent_evidence_refs, "investigation_evidence_parent_invalid") };
  });
  if (new Set(evidence.map((item) => item.evidence_id)).size !== evidence.length) fail("investigation_evidence_duplicate");
  return evidence;
}

function parseInvestigationCritic(value, claims, evidenceIds) {
  exactObject(value, ["critic_id", "identity", "decision", "evidence_refs", "reason_codes", "reviewed_claim_ids"], "investigation_critic_unknown_field", ["critic_id", "identity", "decision"]);
  assertText(value.critic_id, "investigation_critic_id_invalid");
  assertText(value.identity, "investigation_critic_identity_invalid");
  assertEnum(value.decision, CRITIC_DECISIONS, "investigation_critic_decision_invalid");
  const evidence_refs = stringList(value.evidence_refs === undefined ? [] : value.evidence_refs, "investigation_critic_evidence_invalid");
  if (evidence_refs.some((evidenceId) => !evidenceIds.has(evidenceId))) fail("investigation_critic_evidence_mismatch");
  const reason_codes = stringList(value.reason_codes === undefined ? [] : value.reason_codes, "investigation_critic_reason_invalid");
  const reviewed_claim_ids = stringList(value.reviewed_claim_ids === undefined ? [] : value.reviewed_claim_ids, "investigation_critic_claim_invalid");
  const claimIds = new Set(claims.map((claim) => claim.claim_id));
  if (reviewed_claim_ids.some((claimId) => !claimIds.has(claimId))) fail("investigation_critic_claim_mismatch");
  return { ...clone(value), evidence_refs, reason_codes, reviewed_claim_ids };
}

function parseVersionBundle(value) {
  exactObject(value, VERSION_BUNDLE_KEYS, "investigation_version_bundle_unknown_field", []);
  for (const field of VERSION_BUNDLE_KEYS) {
    if (value[field] !== undefined) assertText(value[field], "investigation_version_bundle_invalid");
  }
  return clone(value);
}

function assertTrustedInvestigationResult(result) {
  if (result.disposition === "ACCEPTED") {
    const claimKinds = new Set(result.claims.map((claim) => claim.kind));
    const evidenceIds = new Set(result.evidence.map((item) => item.evidence_id));
    const acceptedEvidenceIsCurrent = result.evidence.every((item) => item.proof_scope === "CURRENT_OBSERVATION"
      && item.freshness === "CURRENT"
      && (item.authority === "T0_AUTHORITATIVE_CURRENT" || item.authority === "T1_DIRECT_CURRENT")
      && item.source_kind !== "KNOWLEDGE");
    const criticCoversEvidence = result.critic?.evidence_refs?.every((evidenceId) => evidenceIds.has(evidenceId))
      && [...evidenceIds].every((evidenceId) => result.critic?.evidence_refs?.includes(evidenceId));
    const claimIds = new Set(result.claims.map((claim) => claim.claim_id));
    const criticCoversClaims = result.critic?.reviewed_claim_ids?.every((claimId) => claimIds.has(claimId))
      && [...claimIds].every((claimId) => result.critic?.reviewed_claim_ids?.includes(claimId));
    if (result.lifecycle_stage !== "DECIDE" || result.truth_label === "DEGRADED" || result.degraded_code !== null && result.degraded_code !== undefined
      || result.critic?.decision !== "PASS" || !claimKinds.has("OBSERVATION") || !claimKinds.has("HYPOTHESIS")
      || !acceptedEvidenceIsCurrent || !criticCoversEvidence || !criticCoversClaims || VERSION_BUNDLE_KEYS.some((field) => !result.version_bundle[field])) {
      fail("investigation_result_critic_invalid");
    }
    return;
  }
  if (result.disposition === "CRITIC_REJECTED" && result.critic?.decision !== "FAIL") fail("investigation_result_critic_invalid");
  if (result.lifecycle_stage !== "INVESTIGATE") fail("investigation_result_lifecycle_stage_invalid");
}

function assertTrustedProjectionStage(projection, lifecycle_stage, gate1_state) {
  const result = projection.investigation_result;
  if (lifecycle_stage === "DECIDE" && (!result || result.disposition !== "ACCEPTED" || result.critic?.decision !== "PASS")) fail("investigation_result_stage_untrusted");
  if (result && result.lifecycle_stage !== lifecycle_stage) fail("investigation_result_stage_untrusted");
  if (result?.disposition === "ACCEPTED" && gate1_state !== "CONSUMED") fail("investigation_result_stage_untrusted");
}

function parseGraph(value) {
  exactObject(value, ["nodes", "edges"], "incident_graph_unknown_field");
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 250 || value.edges.length > 500) fail("incident_graph_invalid");
  const nodes = value.nodes.map(parseGraphNode);
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.component_id)) fail("component_id_duplicate");
    ids.add(node.component_id);
  }
  const edges = value.edges.map((edge) => parseGraphEdge(edge, ids));
  const referenced = new Set(edges.flatMap((edge) => [edge.source_component_id, edge.target_component_id]));
  for (const node of nodes) {
    if (node.membership === "CONNECTED" && !referenced.has(node.component_id)) fail("connected_node_without_edge");
    if (node.membership === "CLASSIFIED" && !CLASSIFICATIONS.has(node.classification_reason)) fail("classified_node_without_reason");
    if (node.membership === "CONNECTED" && node.classification_reason !== null) fail("connected_node_with_classification");
  }
  return { nodes, edges };
}

function parseGraphNode(value) {
  exactObject(value, ["component_id", "canonical_identity", "display_name", "membership", "runtime_status", "impact_status", "classification_reason"], "incident_graph_node_unknown_field", ["component_id", "canonical_identity", "display_name", "membership", "runtime_status", "impact_status"]);
  assertText(value.component_id, "component_id_invalid");
  assertText(value.canonical_identity, "canonical_identity_invalid");
  assertText(value.display_name, "display_name_invalid");
  if (!["CONNECTED", "CLASSIFIED"].includes(value.membership)) fail("graph_membership_invalid");
  assertText(value.runtime_status, "runtime_status_invalid");
  assertText(value.impact_status, "impact_status_invalid");
  if (value.classification_reason !== null && value.classification_reason !== undefined) assertEnum(value.classification_reason, CLASSIFICATIONS, "classification_reason_invalid");
  return { ...clone(value), classification_reason: value.classification_reason ?? null };
}

function parseGraphEdge(value, componentIds) {
  exactObject(value, ["edge_id", "source_component_id", "target_component_id", "status"], "incident_graph_edge_unknown_field");
  assertText(value.edge_id, "edge_id_invalid");
  assertText(value.source_component_id, "edge_source_invalid");
  assertText(value.target_component_id, "edge_target_invalid");
  assertText(value.status, "edge_status_invalid");
  if (value.source_component_id === value.target_component_id || !componentIds.has(value.source_component_id) || !componentIds.has(value.target_component_id)) fail("edge_endpoint_invalid");
  return clone(value);
}

function parseNodeExplanation(value) {
  exactObject(value, [
    ...IDENTITY_KEYS, "explanation_id", "selection_key", "projection_revision", "component_id", "conversation_schema_version",
    "state", "summary", "evidence_refs", "fresh_read_performed", "fresh_diagnosis_claimed", "degraded_code", "truth_label", "conversation_trace"
  ], "node_explanation_unknown_field", [
    ...IDENTITY_KEYS, "explanation_id", "selection_key", "projection_revision", "component_id", "conversation_schema_version",
    "state", "summary"
  ]);
  parseIdentity(value);
  assertText(value.explanation_id, "explanation_id_invalid");
  assertText(value.selection_key, "selection_key_invalid");
  assertInteger(value.projection_revision, "projection_revision_invalid");
  assertText(value.component_id, "component_id_invalid");
  if (value.conversation_schema_version !== "flowpulse.node-explanation.v1") fail("conversation_schema_version_invalid");
  assertEnum(value.state, EXPLANATION_STATES, "node_explanation_state_invalid");
  assertText(value.summary, "node_explanation_summary_invalid");
  const evidence_refs = stringList(value.evidence_refs === undefined ? [] : value.evidence_refs, "node_explanation_evidence_refs_invalid");
  if (value.fresh_read_performed !== undefined && value.fresh_read_performed !== false) fail("fresh_read_not_allowed");
  if (value.fresh_diagnosis_claimed !== undefined && value.fresh_diagnosis_claimed !== false) fail("fresh_diagnosis_not_allowed");
  if (value.degraded_code !== undefined && value.degraded_code !== null) assertText(value.degraded_code, "degraded_code_invalid");
  if (value.truth_label !== undefined && value.truth_label !== null) assertEnum(value.truth_label, TRUTH_LABELS, "truth_label_invalid");
  if (value.conversation_trace !== undefined && value.conversation_trace !== null && !plainObject(value.conversation_trace)) fail("conversation_trace_invalid");
  return { ...clone(value), evidence_refs };
}

function parseNextBestAction(value) {
  exactObject(value, [
    ...IDENTITY_KEYS, "schema_version", "lifecycle_stage", "action_id", "card_version", "taxonomy", "title", "cta", "summary",
    "display_order", "recommended", "projection_revision", "evidence_revision", "gate_revision", "action_revision",
    "component_id", "capability", "capability_version", "data_class", "required_permission", "required_gate",
    "tool_schema_version", "capability_registry_revision", "precondition_version", "precondition_hash", "gate1_lease_id",
    "evidence_refs", "expires_at"
  ], "next_best_action_unknown_field", [
    ...IDENTITY_KEYS, "lifecycle_stage", "action_id", "card_version", "taxonomy", "title", "cta", "summary", "display_order",
    "recommended", "projection_revision", "evidence_revision", "gate_revision", "action_revision", "component_id",
    "capability", "data_class", "required_permission", "required_gate", "tool_schema_version",
    "capability_registry_revision", "precondition_version", "precondition_hash", "expires_at"
  ]);
  parseIdentity(value);
  if (value.schema_version !== undefined && value.schema_version !== "flowpulse.next-best-action.v1") fail("next_best_action_schema_invalid");
  assertEnum(value.lifecycle_stage, LIFECYCLE_STAGES, "next_best_action_lifecycle_stage_invalid");
  for (const field of [
    "action_id", "title", "summary", "component_id", "capability", "data_class", "required_permission", "required_gate",
    "tool_schema_version", "capability_registry_revision", "precondition_version"
  ]) assertText(value[field], `${field}_invalid`);
  if (value.capability_version !== undefined && value.capability_version !== null) assertText(value.capability_version, "capability_version_invalid");
  for (const field of ["card_version", "display_order", "projection_revision", "evidence_revision", "gate_revision", "action_revision"]) assertInteger(value[field], `${field}_invalid`);
  if (typeof value.recommended !== "boolean") fail("next_best_action_recommended_invalid");
  const taxonomy = ACTION_TAXONOMY.get(value.taxonomy);
  if (!taxonomy || !ACTION_CTAS.has(value.cta) || taxonomy.title !== value.title || taxonomy.cta !== value.cta) fail("next_best_action_taxonomy_invalid");
  if (typeof value.precondition_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.precondition_hash)) fail("next_best_action_precondition_invalid");
  if (value.gate1_lease_id !== undefined && value.gate1_lease_id !== null) assertText(value.gate1_lease_id, "next_best_action_gate1_lease_invalid");
  const evidence_refs = stringList(value.evidence_refs === undefined ? [] : value.evidence_refs, "next_best_action_evidence_refs_invalid");
  assertTimestamp(value.expires_at, "next_best_action_expiry_invalid");
  return { ...clone(value), evidence_refs };
}

function parseIdentity(value) {
  for (const field of ["tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "workflow_id", "workflow_run_id"]) assertText(value[field], `${field}_invalid`);
  assertInteger(value.case_revision, "case_revision_invalid");
  assertTimestamp(value.created_at, "created_at_invalid");
}

function sameIdentity(left, right) {
  return Boolean(left && right) && ["tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "workflow_id", "workflow_run_id"].every((field) => left[field] === right[field]);
}

function matchesActionProjection(action, projection) {
  return Boolean(action && projection)
    && ["tenant_id", "incident_id", "run_id", "topology_revision", "case_id", "case_revision", "workflow_id", "workflow_run_id"].every((field) => action[field] === projection[field])
    && ["projection_revision", "evidence_revision", "gate_revision", "action_revision"].every((field) => action[field] === projection[field])
    && (action.lifecycle_stage === undefined || action.lifecycle_stage === (projection.lifecycle_stage === undefined ? "INVESTIGATE" : projection.lifecycle_stage));
}

function allowsInvestigateActions(projection) {
  return investigationPresentation(projection).stage === "INVESTIGATE";
}

function emptyActions(previous = null) {
  return {
    status: "idle",
    cards: [],
    in_flight: null,
    receipt: previous?.receipt || null,
    gate1: previous?.gate1 || { receipt: null, event: null },
    events: [...(previous?.events || [])]
  };
}

function investigateCardPhase(actions) {
  const receipt = actions?.gate1?.receipt;
  if (!receipt) return "before_gate1";
  if (!actions?.gate1?.event) return "awaiting_gate1_event";
  return "after_gate1";
}

function cardsMatchInvestigatePhase(cards, phase, actions) {
  if (!Array.isArray(cards)) return false;
  if (cards.length === 0) return true;
  if (phase === "before_gate1") return cards.every((card) => card.cta === "request_gate_1" && !card.gate1_lease_id);
  if (phase === "after_gate1") {
    const leaseId = actions?.gate1?.receipt?.gate1_lease_id;
    return Boolean(leaseId) && cards.every((card) => card.cta === "run_read_capability" && card.gate1_lease_id === leaseId);
  }
  return false;
}

function matchingActionEvent(events, receipt, expectedType) {
  if (!receipt) return null;
  return [...(events || [])].reverse().find((event) => event.event_type === expectedType
    && event.payload?.action_id === receipt.action_id
    && event.payload?.idempotency_key === receipt.idempotency_key) || null;
}

function matchesSummarySnapshot(summary, projection) {
  return Boolean(summary && projection) && ["incident_id", "run_id", "topology_revision", "case_id"].every((field) => summary[field] === projection[field])
    && projection.projection_revision >= summary.projection_revision
    && projection.sequence >= summary.sequence;
}

function copyState(state) {
  return {
    ...state,
    focused_path: [...(state.focused_path || [])],
    explanation: { ...state.explanation },
    actions: {
      ...(state.actions || emptyActions()),
      cards: [...(state.actions?.cards || [])],
      in_flight: state.actions?.in_flight ? { ...state.actions.in_flight, command: { ...state.actions.in_flight.command } } : null,
      gate1: { ...(state.actions?.gate1 || { receipt: null, event: null }) },
      events: [...(state.actions?.events || [])]
    },
    projections: new Map(state.projections || []),
    seen_notification_ids: new Set(state.seen_notification_ids || [])
  };
}

function stringList(value, code) {
  if (!Array.isArray(value) || value.length > 100) fail(code);
  const copied = value.map((entry) => {
    assertText(entry, code);
    return entry;
  });
  if (new Set(copied).size !== copied.length) fail(code);
  return copied;
}

function stringRecord(value, code) {
  if (!plainObject(value) || Object.keys(value).length > 50) fail(code);
  for (const entry of Object.values(value)) assertText(entry, code);
  return clone(value);
}

function exactObject(value, allowedKeys, code, requiredKeys = allowedKeys) {
  if (!plainObject(value)) fail(code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(code);
  for (const key of requiredKeys) {
    if (!(key in value)) fail(code);
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertText(value, code) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) fail(code);
}

function assertInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
}

function assertTimestamp(value, code) {
  assertText(value, code);
  if (Number.isNaN(Date.parse(value))) fail(code);
}

function assertEnum(value, accepted, code) {
  if (!accepted.has(value)) fail(code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code) {
  throw new ControlPlaneContractError(code);
}

export const TWIN_STAGES = [
  { id: "healthy", label: "Healthy", time: "15:41" },
  { id: "deploy", label: "Deploy", time: "15:42" },
  { id: "propagate", label: "Propagate", time: "15:43" },
  { id: "rejected", label: "Wrong hypothesis rejected", time: "15:46" },
  { id: "root-cause", label: "Root cause", time: "15:48" },
  { id: "owner-gate", label: "Owner gate", time: "15:50" },
  { id: "recover", label: "Recover", time: "16:02" },
  { id: "learn", label: "Learn", time: "16:07" }
];

export const TWIN_NODES = [
  { id: "frontend", label: "Frontend", detail: "storefront", kind: "client", plane: "runtime", x: 10, y: 46 },
  { id: "checkout", label: "Checkout", detail: "commerce service", kind: "service", plane: "runtime", x: 27, y: 46 },
  { id: "payment", label: "Payment API", detail: "money movement", kind: "api", plane: "runtime", x: 48, y: 24 },
  { id: "kafka", label: "orders.v1", detail: "Kafka stream", kind: "stream", plane: "runtime", x: 48, y: 59 },
  { id: "accounting", label: "Accounting", detail: "consumer worker", kind: "worker", plane: "runtime", x: 69, y: 46 },
  { id: "fraud", label: "Fraud", detail: "risk worker", kind: "worker", plane: "runtime", x: 69, y: 74 },
  { id: "deployment", label: "checkout:2.18.0", detail: "deploy-checkout-442", kind: "change", plane: "control", x: 27, y: 14 },
  { id: "agent", label: "Investigator", detail: "evidence agent", kind: "agent", plane: "control", x: 87, y: 27 },
  { id: "evaluator", label: "Evaluator", detail: "adversarial check", kind: "evaluator", plane: "control", x: 87, y: 51 },
  { id: "ledger", label: "Evidence ledger", detail: "append-only SQLite", kind: "database", plane: "control", x: 87, y: 76 }
];

export const TWIN_ICONS = {
  frontend: "browser",
  checkout: "shopping-cart-simple",
  payment: "credit-card",
  kafka: "queue",
  accounting: "calculator",
  fraud: "shield-check",
  deployment: "git-commit",
  agent: "robot",
  evaluator: "scales",
  ledger: "database"
};

export const PULSE_SLOTS = {
  "frontend-checkout": 1,
  "deployment-checkout": 0,
  "checkout-payment": 2,
  "checkout-kafka": 3,
  "kafka-accounting": 4,
  "kafka-fraud": 5,
  "agent-evaluator": 0,
  "evaluator-ledger": 1,
  "checkout-ledger": 2,
  "kafka-ledger": 3
};

export const ARCHITECTURE_LAYERS = [
  {
    id: "experience",
    label: "Client applications",
    description: "browser and traffic-entry services",
    ids: ["load-generator", "frontend-web"]
  },
  {
    id: "commerce",
    label: "Commerce edge & APIs",
    description: "checkout-facing APIs and commerce services",
    ids: ["frontend-proxy", "frontend", "checkout", "cart"]
  },
  {
    id: "processing",
    label: "Core services",
    description: "domain and stream-processing services",
    ids: ["payment", "currency", "shipping", "product-catalog", "recommendation", "ad"]
  },
  {
    id: "platform",
    label: "Async data & platform",
    description: "eventing, data, configuration, and telemetry",
    ids: ["email", "kafka", "accounting", "fraud-detection", "fraud", "quote", "image-provider", "flagd-ui", "flagd", "telemetry-docs", "otelcol-contrib", "astronomy-db"]
  }
];

export const LIVE_LAYERS = [
  {
    id: "experience",
    label: "Client & entry",
    ids: ["ad", "frontend", "frontend-proxy", "frontend-web", "image-provider", "load-generator"]
  },
  {
    id: "commerce",
    label: "Commerce & APIs",
    ids: ["cart", "checkout", "currency", "email", "payment", "product-catalog", "quote", "recommendation", "shipping"]
  },
  {
    id: "processing",
    label: "Async & data",
    ids: ["accounting", "fraud-detection", "kafka"]
  },
  {
    id: "platform",
    label: "Platform & telemetry",
    ids: ["flagd", "flagd-ui", "otelcol-contrib", "telemetry-docs"]
  }
];

export const LIVE_UNLINKED_LAYER = Object.freeze({ id: "unlinked", label: "Unlinked telemetry" });

export const AGENT_COLLABORATORS = Object.freeze([
  {
    id: "commander",
    label: "Commander",
    icon: "chats-circle",
    responsibility: "Coordinates the incident, routes bounded work, and identifies the next human decision.",
    roleIds: ["manager"],
    activityIds: ["manager"],
    x: 10,
    y: 49,
    prompts: ["Summarize the incident", "Recommend the next safe step", "Explain the pending owner decision"]
  },
  {
    id: "observer",
    label: "Observer",
    icon: "binoculars",
    responsibility: "Collects runtime telemetry and assembles cited traces, logs, metrics, and change evidence.",
    roleIds: ["monitor", "evidence"],
    activityIds: ["monitor", "evidence"],
    x: 28,
    y: 27,
    prompts: ["Show the first failing trace", "Compare the checkout deployment", "Show related log clusters"]
  },
  {
    id: "investigator",
    label: "Investigator",
    icon: "brain",
    responsibility: "Builds and revises causal hypotheses from the immutable evidence ledger.",
    roleIds: ["diagnosis"],
    activityIds: ["diagnosis"],
    x: 47,
    y: 27,
    prompts: ["Explain the root cause", "Show counter-evidence", "Request missing evidence"]
  },
  {
    id: "critic",
    label: "Critic",
    icon: "scales",
    responsibility: "Challenges unsupported diagnoses and records adversarial evaluation results.",
    roleIds: ["evaluator"],
    activityIds: ["evaluator"],
    x: 66,
    y: 27,
    prompts: ["Explain the rejected Kafka hypothesis", "Challenge the current diagnosis", "Explain the evaluator score"]
  },
  {
    id: "recovery-engineer",
    label: "Recovery Engineer",
    icon: "wrench",
    responsibility: "Drafts a bounded repair and reports execution only after owner approval.",
    roleIds: ["planner", "executor"],
    activityIds: ["planner", "executor", "owner"],
    x: 66,
    y: 72,
    prompts: ["Draft a bounded repair plan", "Prepare a PR review draft", "Prepare the owner approval request"]
  },
  {
    id: "verifier",
    label: "Verifier",
    icon: "shield-check",
    responsibility: "Checks recovery and exposes regression, backtest, and learning outcomes.",
    roleIds: ["verification", "evolve", "test"],
    activityIds: ["verification", "evolve", "test"],
    x: 86,
    y: 72,
    prompts: ["Show recovery checks", "Inspect the regression record", "Summarize the offline backtest"]
  }
]);

export const AGENT_COLLABORATOR_EDGES = Object.freeze([
  { id: "commander-observer", from: "commander", to: "observer", label: "observe" },
  { id: "observer-investigator", from: "observer", to: "investigator", label: "ground" },
  { id: "investigator-critic", from: "investigator", to: "critic", label: "challenge" },
  { id: "critic-recovery", from: "critic", to: "recovery-engineer", label: "plan" },
  { id: "recovery-verifier", from: "recovery-engineer", to: "verifier", label: "verify" }
]);

export function projectAgentCollaborators(control = {}) {
  const backendNodes = new Map((control.graph?.nodes || []).map((node) => [node.id, node]));
  const currentId = collaboratorForRole(control.current_agent_id);
  const report = control.report || {};
  const nodes = AGENT_COLLABORATORS.map((definition) => {
    const members = definition.roleIds.map((id) => backendNodes.get(id)).filter(Boolean);
    const status = definition.id === "recovery-engineer" && report.human_gate
      ? "waiting"
      : aggregateAgentStatus(members.map((node) => node.status));
    const currentRole = definition.roleIds.find((id) => id === control.current_agent_id)
      || (control.current_agent_id === "owner" && definition.id === "recovery-engineer" ? "owner" : null)
      || members.find((node) => node.status === status)?.id
      || definition.roleIds[0];
    const latestActivity = [...(control.activity || [])].reverse().find((item) => definition.activityIds.includes(item.agent_id)) || null;
    return { ...definition, status, currentRole, latestActivity, selectedByRuntime: definition.id === currentId };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = AGENT_COLLABORATOR_EDGES.map((edge) => ({
    ...edge,
    status: collaboratorEdgeStatus(byId.get(edge.from)?.status, byId.get(edge.to)?.status)
  }));
  return { nodes, edges, currentId };
}

function collaboratorForRole(roleId) {
  return AGENT_COLLABORATORS.find((item) => item.roleIds.includes(roleId))?.id
    || (roleId === "owner" ? "recovery-engineer" : "commander");
}

function aggregateAgentStatus(statuses) {
  if (!statuses.length) return "standby";
  if (statuses.every((status) => status === "complete")) return "complete";
  return ["waiting", "rejected", "running", "observing", "recording"].find((status) => statuses.includes(status)) || "standby";
}

function collaboratorEdgeStatus(fromStatus, toStatus) {
  if (toStatus === "rejected") return "rejected";
  if (toStatus === "waiting") return "waiting";
  if (toStatus === "running") return "active";
  if (toStatus === "complete") return "complete";
  return fromStatus === "running" ? "active" : "quiet";
}

export function architecturePositions(nodes = []) {
  const knownLayer = new Map(ARCHITECTURE_LAYERS.flatMap((layer, index) => layer.ids.map((id, order) => [id, { index, order }])));
  const buckets = ARCHITECTURE_LAYERS.map(() => []);
  const fallbackLayer = { client: 0, api: 1, service: 1, stream: 2, worker: 2, database: 3 };

  for (const node of nodes) {
    if (node.plane && !["runtime", "data"].includes(node.plane)) continue;
    const known = knownLayer.get(node.id);
    const backendRuntimeLayer = ["experience", "commerce", "processing", "platform"].indexOf(node.layer);
    const layerIndex = backendRuntimeLayer >= 0 ? backendRuntimeLayer : known?.index ?? fallbackLayer[node.kind] ?? 3;
    buckets[layerIndex].push({ node, order: known?.order ?? 1_000 });
  }

  return buckets.flatMap((bucket, layerIndex) => {
    const sorted = bucket.sort((a, b) => a.order - b.order || a.node.id.localeCompare(b.node.id));
    return sorted.map(({ node }, index) => ({
      ...node,
      layer: ARCHITECTURE_LAYERS[layerIndex].id,
      layerLabel: ARCHITECTURE_LAYERS[layerIndex].label,
      layerIndex,
      layerPosition: index,
      layerSize: sorted.length,
      x: spreadCoordinate(index, sorted.length),
      y: [18, 39, 61, 82][layerIndex]
    }));
  });
}

export function livePositions(nodes = []) {
  const knownLayer = new Map(LIVE_LAYERS.flatMap((layer, index) => layer.ids.map((id, order) => [id, { index, order }])));
  const buckets = [...LIVE_LAYERS.map(() => []), []];
  const fallbackLayer = { client: 0, api: 1, service: 1, stream: 2, worker: 2, database: 3 };
  for (const node of nodes) {
    const known = knownLayer.get(node.id);
    const projectedLayerIndex = LIVE_LAYERS.findIndex((layer) => layer.id === node.layer);
    const layerIndex = projectedLayerIndex >= 0 ? projectedLayerIndex : node.connectivity === "unlinked" ? LIVE_LAYERS.length : known?.index ?? fallbackLayer[node.kind] ?? 3;
    buckets[layerIndex].push({ node, order: known?.order ?? 1_000 });
  }
  return buckets.flatMap((bucket, layerIndex) => {
    const sorted = bucket.sort((a, b) => a.order - b.order || a.node.id.localeCompare(b.node.id));
    return sorted.map(({ node }, index) => ({
      ...node,
      layer: LIVE_LAYERS[layerIndex]?.id ?? LIVE_UNLINKED_LAYER.id,
      layerLabel: LIVE_LAYERS[layerIndex]?.label ?? LIVE_UNLINKED_LAYER.label,
      layerIndex,
      layerPosition: index,
      layerSize: sorted.length,
      x: [10, 30, 50, 70, 90][layerIndex],
      y: spreadVertical(index, sorted.length)
    }));
  });
}

export function orderedLiveRouteBuildEdges(edges = [], positionedNodes = []) {
  const positions = positionedNodes instanceof Map
    ? positionedNodes
    : new Map((positionedNodes || []).map((node) => [node.id, node]));
  const positionFor = (id) => positions.get(id) || { layerIndex: Number.MAX_SAFE_INTEGER, layerPosition: Number.MAX_SAFE_INTEGER };
  // Construction follows the source columns from left to right, then top to
  // bottom. It is distinct from the causal pulse order so the canvas can read
  // as a connected system before traffic begins to travel through it.
  return [...edges].sort((left, right) => {
    const fromLeft = positionFor(left.from);
    const fromRight = positionFor(right.from);
    const toLeft = positionFor(left.to);
    const toRight = positionFor(right.to);
    return fromLeft.layerIndex - fromRight.layerIndex
      || fromLeft.layerPosition - fromRight.layerPosition
      || toLeft.layerIndex - toRight.layerIndex
      || toLeft.layerPosition - toRight.layerPosition
      || left.id.localeCompare(right.id);
  });
}

export function primaryLiveEdges(topology = {}) {
  const nodes = topology.nodes || [];
  const edges = topology.edges || [];
  if (!nodes.length || !edges.length) return [];

  const positioned = new Map(livePositions(nodes).map((node) => [node.id, node]));
  const valid = edges.filter((edge) => positioned.has(edge.from) && positioned.has(edge.to));
  const compare = (a, b) => {
    const fromA = positioned.get(a.from);
    const toA = positioned.get(a.to);
    const fromB = positioned.get(b.from);
    const toB = positioned.get(b.to);
    const deltaA = toA.layerIndex - fromA.layerIndex;
    const deltaB = toB.layerIndex - fromB.layerIndex;
    const directionA = deltaA > 0 ? 0 : deltaA === 0 ? 1 : 2;
    const directionB = deltaB > 0 ? 0 : deltaB === 0 ? 1 : 2;
    return directionA - directionB || Math.abs(deltaA) - Math.abs(deltaB) || a.id.localeCompare(b.id);
  };

  const incoming = new Map();
  for (const edge of valid) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to).push(edge);
  }

  const selected = new Map();
  for (const target of [...incoming.keys()].sort()) {
    const edge = incoming.get(target).sort(compare)[0];
    selected.set(edge.id, edge);
  }

  const connected = new Set(valid.flatMap((edge) => [edge.from, edge.to]));
  const covered = () => new Set([...selected.values()].flatMap((edge) => [edge.from, edge.to]));
  for (const nodeId of [...connected].sort()) {
    if (covered().has(nodeId)) continue;
    const edge = valid.filter((candidate) => candidate.from === nodeId || candidate.to === nodeId).sort(compare)[0];
    if (edge) selected.set(edge.id, edge);
  }

  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function orderedSignalEdges(edges = [], pulseSlots = {}) {
  const compare = (a, b) => (pulseSlots[a.id] ?? 0) - (pulseSlots[b.id] ?? 0) || a.id.localeCompare(b.id);
  const outgoing = new Map();
  const incoming = new Set();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
    incoming.add(edge.to);
  }
  for (const group of outgoing.values()) group.sort(compare);

  const remaining = new Set(edges.map((edge) => edge.id));
  const ordered = [];
  const visit = (nodeId) => {
    for (const edge of outgoing.get(nodeId) || []) {
      if (!remaining.delete(edge.id)) continue;
      ordered.push(edge);
      visit(edge.to);
    }
  };

  const roots = [...outgoing.keys()].filter((id) => !incoming.has(id)).sort((a, b) => {
    const firstA = outgoing.get(a)?.[0];
    const firstB = outgoing.get(b)?.[0];
    return compare(firstA, firstB);
  });
  for (const root of roots) visit(root);
  for (const edge of [...edges].sort(compare)) {
    if (!remaining.delete(edge.id)) continue;
    ordered.push(edge);
    visit(edge.to);
  }
  return ordered;
}

export function topologyIntegrity(topology = {}) {
  const nodes = [];
  const byId = new Map();
  const sourceNodes = Array.isArray(topology.nodes) ? topology.nodes : Array.isArray(topology.services) ? topology.services : [];
  const sourceEdges = Array.isArray(topology.edges) ? topology.edges : Array.isArray(topology.dependencies) ? topology.dependencies : [];
  for (const input of sourceNodes) {
    const normalized = normalizeServiceId(input.id);
    if (!normalized || byId.has(normalized)) continue;
    const node = { ...input, id: normalized };
    nodes.push(node);
    byId.set(normalized, node);
  }

  const invalidEdges = [];
  const edgeIds = new Set();
  const edges = [];
  for (const input of sourceEdges) {
    const from = normalizeServiceId(input.from);
    const to = normalizeServiceId(input.to);
    if (!byId.has(from) || !byId.has(to)) {
      invalidEdges.push({ ...input, from, to });
      continue;
    }
    const baseId = String(input.id || `${from}->${to}`);
    const id = edgeIds.has(baseId) ? `${baseId}:${edges.length}` : baseId;
    edgeIds.add(id);
    edges.push({ ...input, id, from, to });
  }

  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return {
    ...topology,
    nodes: nodes.map((node) => ({ ...node, connectivity: connected.has(node.id) ? "connected" : "unlinked" })),
    edges,
    invalid_edges: invalidEdges,
    unlinked_node_ids: nodes.filter((node) => !connected.has(node.id)).map((node) => node.id)
  };
}

export function architectureViewTopology(topologyViews = {}) {
  const views = topologyViewsV2(topologyViews);
  if (!views) return null;
  const runtime = views.architecture.runtime_data.graph;
  const controls = views.architecture.control_system;
  const graph = topologyIntegrity({ nodes: [...runtime.nodes, ...controls.nodes], edges: [...runtime.edges, ...controls.relations] });
  if (graph.invalid_edges.length || graph.nodes.length !== runtime.nodes.length + controls.nodes.length || graph.edges.length !== runtime.edges.length + controls.relations.length) return null;
  return {
    graph: { ...graph, total_nodes: graph.nodes.length, total_edges: graph.edges.length, truncated: false },
    runtime_data: { ...views.architecture.runtime_data },
    control_system: { ...controls },
    external_change_evidence: { ...views.architecture.external_change_evidence },
    truth: { ...views.truth },
    projection_revision: views.projection_revision
  };
}

export function liveViewTopology(topologyViews = {}) {
  const views = topologyViewsV2(topologyViews);
  if (!views) return null;
  return {
    runtime_data: { ...views.live.runtime_data },
    control_system: { ...views.live.control_system },
    external_change_evidence: { ...views.live.external_change_evidence },
    incident_overlay: { ...views.live.incident_overlay },
    truth: { ...views.truth },
    readiness: { ...views.readiness },
    projection_revision: views.projection_revision
  };
}

// Agent Team is a separate, server-owned read model. These parsers deliberately
// accept only the bounded public envelopes below: chat answers, prompt material,
// provider payloads, and arbitrary ledger records never become browser state.
export const AGENT_TEAM_ROLES = Object.freeze(["observer", "orchestrator", "investigator", "evaluator", "ledger"]);

const AGENT_TEAM_CONVERSATIONAL_ROLES = new Set(AGENT_TEAM_ROLES.filter((role) => role !== "ledger"));
const AGENT_TEAM_PROVIDER_KINDS = new Set(["codex-local", "openai-responses", "recorded"]);
const AGENT_TEAM_PROVIDER_AVAILABILITY = new Set(["available", "unavailable", "preflight_required"]);
const AGENT_TEAM_PAGE_MODES = new Set(["architecture", "live", "diagnose", "recovery", "compare", "manager"]);
const AGENT_TEAM_MESSAGE_STATES = new Set(["completed", "failed", "needs_human", "working", "routing"]);
const AGENT_TEAM_LOOP_STATES = new Set(["running", "recovered", "needs_human", "failed"]);

export function agentTeamProviderProjection(value) {
  return validAgentTeamProvider(value) ? value : null;
}

export function agentTeamConversationProjection(value, { conversationId = null } = {}) {
  const keys = ["schema_version", "conversation_id", "messages", "truncated", "record_count", "latest"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.agent-team-chat.v1"
    || !safeAgentTeamId(value.conversation_id) || conversationId && value.conversation_id !== conversationId
    || !Array.isArray(value.messages) || value.messages.length > 48 || !value.messages.every(validAgentTeamMessage)
    || !Number.isSafeInteger(value.record_count) || value.record_count < value.messages.length || value.record_count > 48
    || typeof value.truncated !== "boolean" || !strictAscending(value.messages, "sequence")
    || new Set(value.messages.map(({ id }) => id)).size !== value.messages.length
    || !validAgentTeamLatest(value.latest, value.messages)) return null;
  return value;
}

export function agentLoopStartProjection(value) {
  const keys = ["schema_version", "run_id", "incident_id", "state", "stage", "events_url", "contextual_workspaces"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.local-fault-loop.v2"
    || !safeAgentTeamId(value.run_id) || !safeAgentTeamId(value.incident_id) || value.state !== "running"
    || !safeAgentTeamText(value.stage, 80) || !validAgentLoopEventsUrl(value.events_url, value.run_id)
    || !validAgentTeamWorkspaces(value.contextual_workspaces, { runId: value.run_id, incidentId: value.incident_id })) return null;
  return value;
}

export function agentLoopProjection(value, { runId = null } = {}) {
  const keys = ["schema_version", "run_id", "incident_id", "case_id", "round", "state", "stage", "provider", "citations", "role_responses", "topology", "contextual_workspaces", "events", "final"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.local-fault-loop.v2"
    || !safeAgentTeamId(value.run_id) || runId && value.run_id !== runId || !safeAgentTeamId(value.incident_id)
    || !["checkout-payment-config", "insufficient-evidence"].includes(value.case_id) || !Number.isSafeInteger(value.round) || value.round < 1 || value.round > 3
    || !AGENT_TEAM_LOOP_STATES.has(value.state) || !safeAgentTeamText(value.stage, 80)
    || value.provider !== null && !validAgentTeamLoopProvider(value.provider)
    || !validAgentTeamRefs(value.citations, 64) || !Array.isArray(value.role_responses) || value.role_responses.length > 12 || !value.role_responses.every(validAgentTeamLoopRoleResponse)
    || !(value.topology === null && value.state === "running" || validCanonicalRunTopology(value.topology, { runId: value.run_id, incidentId: value.incident_id }))
    || !validAgentTeamWorkspaces(value.contextual_workspaces, { runId: value.run_id, incidentId: value.incident_id })
    || !Array.isArray(value.events) || value.events.length > 160 || !value.events.every(validAgentTeamLoopEvent)
    || !strictAscending(value.events, "sequence") || !validAgentTeamLoopFinal(value.final, value.state)) return null;
  return value;
}

export function agentLoopEventProjection(value, { runId = null } = {}) {
  const keys = ["schema_version", "run_id", "incident_id", "case_id", "round", "event", "topology", "contextual_workspaces"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.local-fault-loop.v2"
    || !safeAgentTeamId(value.run_id) || runId && value.run_id !== runId || !safeAgentTeamId(value.incident_id)
    || !["checkout-payment-config", "insufficient-evidence"].includes(value.case_id) || !Number.isSafeInteger(value.round) || value.round < 1 || value.round > 3
    || !validAgentTeamLoopEvent(value.event) || !(value.topology === null || validCanonicalRunTopology(value.topology, { runId: value.run_id, incidentId: value.incident_id })) || !validAgentTeamWorkspaces(value.contextual_workspaces, { runId: value.run_id, incidentId: value.incident_id })) return null;
  return value;
}

// The shared-run controller stores only this bounded interpretation of the
// server's immutable loop events. It never creates telemetry, changes state,
// or infers a recovery that the loop has not recorded.
export function sharedRunReadModel(loop, { throughSequence = null } = {}) {
  if (!agentLoopProjection(loop, { runId: loop?.run_id || null })) return null;
  const events = Number.isSafeInteger(throughSequence) && throughSequence >= 0
    ? loop.events.filter((event) => event.sequence <= throughSequence)
    : loop.events;
  const topology = [...events].reverse().find((event) => event.topology)?.topology || loop.topology;
  if (!topology) return null;
  const state = topology.current.state;
  const stage = topology.current.stage;
  const current = events.at(-1) || null;
  return {
    run_id: loop.run_id,
    incident_id: loop.incident_id,
    projection_revision: topology.projection_revision,
    state,
    stage,
    selected_component: loop.contextual_workspaces.context.selected_component,
    workspace_actions: (current?.contextual_workspaces || loop.contextual_workspaces).actions,
    timeline: {
      position: current?.sequence || 0,
      event_id: current?.id || loop.contextual_workspaces.context.timeline.event_id,
      stage,
      terminal_state: ["recovered", "needs_human", "failed"].includes(state) ? state : null
    },
    events,
    topology,
    metric_samples: { ...topology.metric_samples, current: topology.current.metric_sample },
    node_statuses: topology.current.node_statuses,
    edge_statuses: topology.current.edge_statuses,
    role_responses: loop.role_responses,
    citations: loop.citations
  };
}

function validCanonicalRunTopology(value, { runId, incidentId }) {
  const keys = ["schema_version", "run_id", "incident_id", "projection_revision", "graph", "node_ids", "edge_ids", "affected_node_ids", "affected_edge_ids", "source_truth", "current", "metric_samples", "snapshots", "verification", "live", "diagnose", "recovery", "compare", "raw_payload_excluded"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.canonical-run-topology.v1"
    || value.run_id !== runId || value.incident_id !== incidentId || !validHash(value.projection_revision)
    || !plainRecord(value.graph) || !sameKeys(value.graph, ["nodes", "edges", "total_nodes", "total_edges", "truncated"])
    || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges) || value.graph.nodes.length < 1 || value.graph.nodes.length > 128 || value.graph.edges.length > 256
    || value.graph.total_nodes !== value.graph.nodes.length || value.graph.total_edges !== value.graph.edges.length || value.graph.truncated !== false
    || !value.graph.nodes.every(validRuntimeNode) || !value.graph.edges.every(validRuntimeEdge)) return false;
  const nodeIds = value.graph.nodes.map((node) => node.id);
  const edgeIds = value.graph.edges.map((edge) => edge.id);
  if (new Set(nodeIds).size !== nodeIds.length || new Set(edgeIds).size !== edgeIds.length || nodeIds.includes("fraud") || !nodeIds.includes("fraud-detection")
    || !sameOrdered(value.node_ids, nodeIds) || !sameOrdered(value.edge_ids, edgeIds)
    || !validTopologyIdSubset(value.affected_node_ids, nodeIds) || !validTopologyIdSubset(value.affected_edge_ids, edgeIds)
    || !validCanonicalSourceTruth(value.source_truth) || !validCanonicalSnapshot(value.current, nodeIds, edgeIds)
    || !plainRecord(value.metric_samples) || !sameKeys(value.metric_samples, ["baseline", "incident", "verified"])
    || !validCanonicalMetric(value.metric_samples.baseline, false) || !validCanonicalMetric(value.metric_samples.incident, false) || !validCanonicalMetric(value.metric_samples.verified, false)
    || !plainRecord(value.snapshots) || !sameKeys(value.snapshots, ["baseline", "incident", "verified"])
    || !validCanonicalSnapshot(value.snapshots.baseline, nodeIds, edgeIds) || !validCanonicalSnapshot(value.snapshots.incident, nodeIds, edgeIds) || !(value.snapshots.verified === null || validCanonicalSnapshot(value.snapshots.verified, nodeIds, edgeIds))
    || !validCanonicalVerification(value.verification, nodeIds, edgeIds)
    || !["live", "diagnose", "recovery", "compare"].every((name) => validCanonicalWorkspace(value[name], value, name))
    || value.raw_payload_excluded !== true) return false;
  return value.current.metric_sample === null || validCanonicalMetric(value.current.metric_sample, true);
}

function validCanonicalWorkspace(value, topology, name) {
  return plainRecord(value) && sameKeys(value, ["run_id", "incident_id", "projection_revision", "node_ids", "edge_ids", "affected_node_ids", "affected_edge_ids", "state"])
    && value.run_id === topology.run_id && value.incident_id === topology.incident_id && value.projection_revision === topology.projection_revision
    && sameOrdered(value.node_ids, topology.node_ids) && sameOrdered(value.edge_ids, topology.edge_ids)
    && sameOrdered(value.affected_node_ids, topology.affected_node_ids) && sameOrdered(value.affected_edge_ids, topology.affected_edge_ids)
    && (name === "compare" ? ["verified", "verification_pending"].includes(value.state) : value.state === "current");
}

function validTopologyIdSubset(value, ids) {
  return Array.isArray(value) && value.length <= ids.length && new Set(value).size === value.length && value.every((id) => ids.includes(id)) && sameOrdered(value, [...value].sort());
}

function validCanonicalSourceTruth(value) {
  return plainRecord(value) && sameKeys(value, ["source_health", "evidence_mode", "execution_mode", "label"])
    && ["live", "stale", "disconnected", "unavailable"].includes(value.source_health)
    && ["captured_fixture", "live", "unavailable"].includes(value.evidence_mode)
    && ["deterministic_replay", "live", "unavailable"].includes(value.execution_mode)
    && ["CAPTURED", "LIVE", "UNAVAILABLE"].includes(value.label);
}

function validCanonicalSnapshot(value, nodeIds, edgeIds) {
  return plainRecord(value) && sameKeys(value, ["name", "sequence", "stage", "state", "node_statuses", "edge_statuses", "metric_sample"])
    && ["baseline", "incident", "verified", "current"].includes(value.name) && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && safeAgentTeamText(value.stage, 80) && AGENT_TEAM_LOOP_STATES.has(value.state)
    && validCanonicalStatuses(value.node_statuses, nodeIds) && validCanonicalStatuses(value.edge_statuses, edgeIds)
    && (value.metric_sample === null || validCanonicalMetric(value.metric_sample, true));
}

function validCanonicalStatuses(value, ids) {
  return plainRecord(value) && sameOrdered(Object.keys(value), ids) && Object.values(value).every((status) => ["observed", "impact", "root", "active", "verified"].includes(status));
}

function validCanonicalMetric(value, required) {
  if (value === null) return !required;
  return plainRecord(value) && sameKeys(value, ["checkout_error_rate_percent", "payment_reachability_percent", "kafka_lag", "phase", "source", "recorded_at"])
    && Number.isFinite(value.checkout_error_rate_percent) && value.checkout_error_rate_percent >= 0 && value.checkout_error_rate_percent <= 100
    && Number.isFinite(value.payment_reachability_percent) && value.payment_reachability_percent >= 0 && value.payment_reachability_percent <= 100
    && Number.isSafeInteger(value.kafka_lag) && value.kafka_lag >= 0 && value.kafka_lag <= 10_000_000
    && ["baseline", "fault", "verified"].includes(value.phase) && value.source === "isolated_fixture" && validTopologyTimestamp(value.recorded_at);
}

function validCanonicalVerification(value, nodeIds, edgeIds) {
  return plainRecord(value) && sameKeys(value, ["state", "passed", "event_sequence", "snapshot"])
    && ["passed", "pending", "failed"].includes(value.state) && typeof value.passed === "boolean"
    && (value.event_sequence === null || Number.isSafeInteger(value.event_sequence) && value.event_sequence > 0)
    && (value.snapshot === null || validCanonicalSnapshot(value.snapshot, nodeIds, edgeIds))
    && (value.passed ? value.state === "passed" && value.snapshot?.name === "verified" : value.state !== "passed" && value.snapshot === null);
}

function validAgentTeamProvider(value) {
  return plainRecord(value) && sameKeys(value, ["provider_kind", "availability", "truth_label", "model_label", "failure_reason"])
    && AGENT_TEAM_PROVIDER_KINDS.has(value.provider_kind) && AGENT_TEAM_PROVIDER_AVAILABILITY.has(value.availability)
    && safeAgentTeamText(value.truth_label, 80) && nullableAgentTeamText(value.model_label, 120) && nullableAgentTeamText(value.failure_reason, 120);
}

function validAgentTeamLoopProvider(value) {
  return plainRecord(value) && sameKeys(value, ["provider_kind", "truth_label", "model_label"])
    && ["codex-local", "unavailable"].includes(value.provider_kind) && safeAgentTeamText(value.truth_label, 80) && safeAgentTeamText(value.model_label, 120);
}

function validAgentTeamMessage(value) {
  if (!plainRecord(value) || !safeAgentTeamEventBase(value) || !safeAgentTeamText(value.kind, 32)) return false;
  if (value.kind === "user") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "agent", "requested_agent", "page_mode", "selected_component", "text"])
    && value.type === "agent_team.message.received" && value.agent === "human" && validAgentTeamRole(value.requested_agent)
    && AGENT_TEAM_PAGE_MODES.has(value.page_mode) && nullableAgentTeamId(value.selected_component) && safeAgentTeamText(value.text, 1_500);
  if (value.kind === "handoff") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "from", "to", "reason"])
    && value.type === "agent_team.handoff.recorded" && validAgentTeamHandoff({ from: value.from, to: value.to, reason: value.reason });
  if (value.kind === "context") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "agent", "state", "topology", "source_truth", "citations"])
    && value.type === "agent_team.context.prepared" && validAgentTeamRole(value.agent) && value.state === "routing"
    && validAgentTeamContextTopology(value.topology) && validAgentTeamSourceTruth(value.source_truth) && validAgentTeamRefs(value.citations, 12);
  if (value.kind === "tool_summary") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "agent", "state", "citations", "tools"])
    && value.type === "agent_team.tool_summary.recorded" && validAgentTeamRole(value.agent) && value.state === "working"
    && validAgentTeamRefs(value.citations, 12) && validAgentTeamTools(value.tools);
  if (value.kind === "tool_request") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "agent", "state", "tool", "component_id", "attempt", "round", "raw_payload_excluded"])
    && value.type === "agent_team.tool.requested" && validAgentTeamRole(value.agent) && value.state === "working"
    && safeAgentTeamText(value.tool, 120) && safeAgentTeamId(value.component_id)
    && Number.isSafeInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 2
    && Number.isSafeInteger(value.round) && value.round >= 0 && value.round <= 2 && value.raw_payload_excluded === true;
  if (value.kind === "tool_result") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "agent", "state", "tool", "component_id", "result_count", "selected_count", "omitted_count", "cached", "citations", "source_truth", "raw_payload_excluded"])
    && value.type === "agent_team.tool.result.recorded" && validAgentTeamRole(value.agent) && value.state === "working"
    && safeAgentTeamText(value.tool, 120) && safeAgentTeamId(value.component_id)
    && validAgentTeamResultCount(value.result_count) && validAgentTeamResultCount(value.selected_count) && validAgentTeamResultCount(value.omitted_count)
    && typeof value.cached === "boolean" && validAgentTeamRefs(value.citations, 12) && validAgentTeamNodeSourceTruth(value.source_truth)
    && value.raw_payload_excluded === true;
  if (value.kind === "working") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "requested_agent", "responding_agent", "state", "citations", "provider"])
    && value.type === "agent_team.response.working" && validAgentTeamRole(value.requested_agent) && validAgentTeamRole(value.responding_agent)
    && value.state === "working" && validAgentTeamRefs(value.citations, 12) && validAgentTeamProvider(value.provider);
  if (value.kind === "assistant") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "requested_agent", "responding_agent", "agent", "state", "text", "handoff", "citations", "tool_summaries", "human_gate", "provider"])
    && value.type === "agent_team.response.created" && validAgentTeamRole(value.requested_agent) && validAgentTeamRole(value.responding_agent)
    && value.agent === value.responding_agent && ["completed", "failed", "needs_human"].includes(value.state)
    && safeAgentTeamAnswer(value.text) && (value.handoff === null || validAgentTeamHandoff(value.handoff))
    && validAgentTeamRefs(value.citations, 12) && validAgentTeamTools(value.tool_summaries) && validAgentTeamHumanGate(value.human_gate) && validAgentTeamProvider(value.provider);
  if (value.kind === "human_gate") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "requested_agent", "responding_agent", "state", "reason", "human_gate", "citations"])
    && value.type === "agent_team.human_gate.required" && validAgentTeamRole(value.requested_agent) && validAgentTeamRole(value.responding_agent)
    && value.state === "needs_human" && safeAgentTeamText(value.reason, 160) && validAgentTeamHumanGate(value.human_gate) && validAgentTeamRefs(value.citations, 12);
  if (value.kind === "error") return sameKeys(value, ["id", "sequence", "recorded_at", "type", "kind", "code"])
    && value.type === "agent_team.error.recorded" && safeAgentTeamCode(value.code);
  return false;
}

function safeAgentTeamEventBase(value) {
  return safeAgentTeamId(value.id) && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && validTopologyTimestamp(value.recorded_at)
    && typeof value.type === "string" && /^agent_team(?:\.[a-z_]{2,80}){1,3}$/.test(value.type);
}

function validAgentTeamLatest(value, messages) {
  if (!messages.length) return value === null;
  const latest = messages.at(-1);
  return plainRecord(value) && sameKeys(value, ["sequence", "recorded_at"])
    && value.sequence === latest.sequence && value.recorded_at === latest.recorded_at;
}

function validAgentTeamHandoff(value) {
  return plainRecord(value) && sameKeys(value, ["from", "to", "reason"])
    && validAgentTeamRole(value.from) && validAgentTeamRole(value.to) && value.from !== value.to && safeAgentTeamText(value.reason, 200);
}

function validAgentTeamContextTopology(value) {
  return plainRecord(value) && sameKeys(value, ["schema_version", "projection_revision"])
    && (value.schema_version === null || value.schema_version === "flowpulse.topology-views.v2") && (value.projection_revision === null || validHash(value.projection_revision));
}

function validAgentTeamSourceTruth(value) {
  return plainRecord(value) && sameKeys(value, ["source_health", "evidence_mode", "execution_mode"])
    && ["live", "stale", "disconnected", "unavailable"].includes(value.source_health)
    && ["captured_fixture", "frozen_real_snapshot", "live_stream"].includes(value.evidence_mode)
    && ["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"].includes(value.execution_mode);
}

function validAgentTeamTools(value) {
  return Array.isArray(value) && value.length <= 4 && value.every((item) => {
    const compact = plainRecord(item) && sameKeys(item, ["tool", "result_count", "raw_payload_excluded"])
      && safeAgentTeamText(item.tool, 120) && validAgentTeamResultCount(item.result_count) && item.raw_payload_excluded === true;
    const detailed = plainRecord(item) && sameKeys(item, ["tool", "result_count", "selected_count", "omitted_count", "cached", "raw_payload_excluded"])
      && safeAgentTeamText(item.tool, 120) && validAgentTeamResultCount(item.result_count)
      && validAgentTeamResultCount(item.selected_count) && validAgentTeamResultCount(item.omitted_count)
      && typeof item.cached === "boolean" && item.raw_payload_excluded === true;
    return compact || detailed;
  });
}

function validAgentTeamResultCount(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 10_000; }

function validAgentTeamNodeSourceTruth(value) {
  return plainRecord(value) && sameKeys(value, ["mode", "status", "freshness_ms", "observed_at", "truth_label"])
    && safeAgentTeamText(value.mode, 80) && ["captured", "frozen", "live", "stale", "disconnected", "unavailable"].includes(value.status)
    && (value.freshness_ms === null || Number.isSafeInteger(value.freshness_ms) && value.freshness_ms >= 0 && value.freshness_ms <= 31_536_000_000)
    && (value.observed_at === null || validTopologyTimestamp(value.observed_at))
    && safeAgentTeamText(value.truth_label, 80);
}

function validAgentTeamHumanGate(value) {
  return plainRecord(value) && sameKeys(value, ["status"]) && ["requested", "granted", "not_required", "not_actionable"].includes(value.status);
}

function validAgentTeamWorkspaces(value, { runId, incidentId }) {
  if (!plainRecord(value) || !sameKeys(value, ["context", "actions"]) || !plainRecord(value.context) || !plainRecord(value.actions)
    || !sameKeys(value.context, ["run_id", "incident_id", "selected_component", "timeline"])
    || value.context.run_id !== runId || value.context.incident_id !== incidentId || !safeAgentTeamId(value.context.selected_component)
    || !plainRecord(value.context.timeline) || !sameKeys(value.context.timeline, ["position", "event_id", "stage", "terminal_state"])
    || !Number.isSafeInteger(value.context.timeline.position) || value.context.timeline.position < 0 || !safeAgentTeamId(value.context.timeline.event_id)
    || !safeAgentTeamText(value.context.timeline.stage, 80) || !(value.context.timeline.terminal_state === null || AGENT_TEAM_LOOP_STATES.has(value.context.timeline.terminal_state))
    || !sameKeys(value.actions, ["view_diagnosis", "open_recovery_console", "compare_recovery"])) return false;
  return [value.actions.view_diagnosis, value.actions.open_recovery_console, value.actions.compare_recovery].every(validAgentTeamWorkspaceAction);
}

function validAgentTeamWorkspaceAction(value) {
  return plainRecord(value) && sameKeys(value, ["available", "prerequisites"]) && typeof value.available === "boolean"
    && Array.isArray(value.prerequisites) && value.prerequisites.length >= 1 && value.prerequisites.length <= 3
    && value.prerequisites.every((item) => plainRecord(item) && sameKeys(item, ["id", "satisfied"]) && safeAgentTeamCode(item.id) && typeof item.satisfied === "boolean");
}

function validAgentLoopEventsUrl(value, runId) {
  return typeof value === "string" && value === `/api/demo/agent-loop/events?run_id=${encodeURIComponent(runId)}&after=0`;
}

function validAgentTeamLoopRoleResponse(value) {
  return plainRecord(value) && sameKeys(value, ["role", "requested_agent", "responding_agent", "state", "provider", "safe_answer", "answer_sha256", "answer_bytes", "duration_ms", "handoff", "recommended_handoff", "citations", "tools"])
    && validAgentTeamRole(value.role) && value.requested_agent === value.role && value.responding_agent === value.role && value.state === "completed"
    && validAgentTeamLoopProvider(value.provider) && safeAgentTeamAnswer(value.safe_answer) && validHash(value.answer_sha256)
    && Number.isSafeInteger(value.answer_bytes) && value.answer_bytes >= 1 && value.answer_bytes <= 1_200
    && Number.isSafeInteger(value.duration_ms) && value.duration_ms >= 0 && value.duration_ms <= 120_000
    && (value.handoff === null || validAgentTeamLoopHandoff(value.handoff, value.role)) && (value.recommended_handoff === null || validAgentTeamLoopHandoff(value.recommended_handoff, value.role))
    && validAgentTeamRefs(value.citations, 12) && validAgentTeamLoopTools(value.tools);
}

function validAgentTeamLoopEvent(value) {
  return plainRecord(value) && sameKeys(value, ["id", "sequence", "recorded_at", "type", "actor", "evidence_refs", "payload", "topology", "contextual_workspaces"])
    && safeAgentTeamId(value.id) && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && validTopologyTimestamp(value.recorded_at)
    && safeAgentTeamText(value.type, 120) && safeAgentTeamText(value.actor, 80) && validAgentTeamRefs(value.evidence_refs, 64)
    && plainRecord(value.payload) && validAgentTeamWorkspacesForEvent(value.contextual_workspaces);
}

function validAgentTeamWorkspacesForEvent(value) {
  return value === undefined || plainRecord(value) && sameKeys(value, ["context", "actions"]);
}

function validAgentTeamLoopFinal(value, state) {
  if (state === "running") return value === null;
  return plainRecord(value) && sameKeys(value, ["sequence", "recorded_at", "type", "payload"])
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && validTopologyTimestamp(value.recorded_at)
    && safeAgentTeamText(value.type, 120) && plainRecord(value.payload);
}

function validAgentTeamLoopHandoff(value, from) {
  return plainRecord(value) && sameKeys(value, ["to", "reason"])
    && AGENT_TEAM_CONVERSATIONAL_ROLES.has(value.to) && value.to !== from && safeAgentTeamText(value.reason, 200);
}

function validAgentTeamLoopTools(value) {
  return Array.isArray(value) && value.length <= 4 && value.every((item) => plainRecord(item) && sameKeys(item, ["tool", "result_count"])
    && safeAgentTeamText(item.tool, 120) && Number.isSafeInteger(item.result_count) && item.result_count >= 0 && item.result_count <= 10_000);
}

function validAgentTeamRefs(value, limit) {
  // Citation order is ledger/event order. It is meaningful to the server and
  // intentionally not re-sorted in the browser projection.
  return Array.isArray(value) && value.length <= limit && new Set(value).size === value.length && value.every(safeAgentTeamId);
}

function strictAscending(items, field) {
  return items.every((item, index) => index === 0 || items[index - 1][field] < item[field]);
}

function validAgentTeamRole(value) { return AGENT_TEAM_CONVERSATIONAL_ROLES.has(value); }
function safeAgentTeamId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value); }
function nullableAgentTeamId(value) { return value === null || safeAgentTeamId(value); }
function safeAgentTeamCode(value) { return typeof value === "string" && /^[a-z][a-z0-9_]{1,119}$/.test(value); }
function safeAgentTeamText(value, limit) { return typeof value === "string" && value.length > 0 && value.length <= limit && /^[^\u0000-\u001f\u007f<>&]+$/.test(value); }
function nullableAgentTeamText(value, limit) { return value === null || safeAgentTeamText(value, limit); }
function safeAgentTeamAnswer(value) { return safeAgentTeamText(value, 1_200) && !/(?:chain[- ]of[- ]thought|raw\s+(?:prompt|payload|log)|\b(?:api[_ -]?key|token|secret|password)\b)/i.test(value); }

// This read model is intentionally separate from topology_views. The browser
// accepts it only when it is tied to the currently rendered canonical revision
// and contains no raw evidence body, provider payload, or authority state.
export function componentDetailProjection(value, { nodeId = null, topologyRevision = null } = {}) {
  const keys = ["schema_version", "topology_projection_revision", "detail_revision", "component", "purpose", "runtime", "relationships", "observability", "configuration", "data_resources", "raw_payload_excluded"];
  if (!plainRecord(value) || !sameKeys(value, keys) || value.schema_version !== "flowpulse.component-detail.v1"
    || !validHash(value.topology_projection_revision) || !validHash(value.detail_revision)
    || topologyRevision && value.topology_projection_revision !== topologyRevision
    || !validRuntimeNode(value.component) || nodeId && value.component.id !== nodeId
    || !validComponentPurpose(value.purpose) || !validComponentRuntime(value.runtime)
    || !validComponentRelationships(value.relationships) || !validComponentObservability(value.observability)
    || !plainRecord(value.configuration) || !sameKeys(value.configuration, ["changes"])
    || JSON.stringify(value.configuration.changes) !== JSON.stringify(value.observability.changes)
    || !validComponentDataResources(value.data_resources) || value.raw_payload_excluded !== true) return null;
  return value;
}

// The Inspector owns presentation ranking, not telemetry truth. It receives an
// already validated v1 detail record and only groups/sorts its safe fields for
// the compact Live rail. No browser-created metric, event, resource, or health
// fact crosses this boundary.
export function nodeLiveInspectorProjection(detail) {
  const accepted = componentDetailProjection(detail, {
    nodeId: detail?.component?.id || null,
    topologyRevision: detail?.topology_projection_revision || null
  });
  if (!accepted) return null;
  const observability = accepted.observability;
  const events = [
    ...observability.logs.map((item) => ({ ...item, event_kind: "log", marker: null })),
    ...observability.traces.map((item) => ({ ...item, event_kind: "trace", marker: item.trace_ref })),
    ...observability.changes.map((item) => ({ ...item, event_kind: "change", marker: item.flag || item.target }))
  ].sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.evidence_id.localeCompare(left.evidence_id));
  const pulseMetrics = [...observability.metrics]
    .filter((item) => item.value !== null || item.before !== null || item.after !== null)
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.evidence_id.localeCompare(left.evidence_id))
    .slice(0, 3)
    .map((item) => ({ kind: "metric", evidence_id: item.evidence_id, title: item.title, value: item.value, before: item.before, after: item.after, unit: item.unit, observed_at: item.observed_at }));
  const lastEvent = events[0]
    ? { kind: "event", evidence_id: events[0].evidence_id, title: events[0].title, event_kind: events[0].event_kind, observed_at: events[0].observed_at }
    : null;
  const evidenceIds = new Set([
    ...observability.metrics,
    ...observability.traces,
    ...observability.logs,
    ...observability.changes
  ].map((item) => item.evidence_id));
  const group = (items) => ({ visible: items.slice(0, 3), remaining: Math.max(0, items.length - 3) });
  return {
    component: accepted.component,
    purpose: accepted.purpose,
    runtime: accepted.runtime,
    live_pulse: [...pulseMetrics, ...(lastEvent ? [lastEvent] : [])].slice(0, 4),
    event_stream: events,
    dependencies: {
      upstream: group(accepted.relationships.upstream),
      downstream: group(accepted.relationships.downstream)
    },
    evidence: {
      record_count: evidenceIds.size,
      source_health: accepted.component.source_health,
      source_mode: accepted.runtime.mode,
      freshness_ms: accepted.runtime.freshness_ms,
      observed_at: accepted.runtime.observed_at,
      provenance_refs: accepted.component.provenance_refs,
      topology_projection_revision: accepted.topology_projection_revision,
      detail_revision: accepted.detail_revision,
      truncated: false
    },
    data_resources: accepted.data_resources
  };
}

// N1 is intentionally a separate future adapter. No published N1 envelope is
// available in this frontend checkpoint, so every candidate fails closed rather
// than letting v1 or a guessed shape masquerade as an event stream.
export function nodeInvestigationN1Projection(_value) { return null; }

function validComponentPurpose(value) {
  return plainRecord(value) && sameKeys(value, ["business_role", "description"])
    && validComponentText(value.business_role, 120) && validComponentText(value.description, 240);
}

function validComponentRuntime(value) {
  return plainRecord(value) && sameKeys(value, ["mode", "status", "label", "freshness_ms", "observed_at"])
    && validComponentText(value.mode, 80) && ["captured", "frozen", "live", "stale", "disconnected", "unavailable"].includes(value.status)
    && validComponentText(value.label, 160)
    && (value.freshness_ms === null || Number.isSafeInteger(value.freshness_ms) && value.freshness_ms >= 0 && value.freshness_ms <= 31_536_000_000)
    && (value.observed_at === null || validTopologyTimestamp(value.observed_at));
}

function validComponentRelationships(value) {
  return plainRecord(value) && sameKeys(value, ["upstream", "downstream"])
    && [value.upstream, value.downstream].every((items) => Array.isArray(items) && items.length <= 8
      && new Set(items.map(({ id }) => id)).size === items.length && items.every(validComponentRelation)
      && sameOrdered(items, [...items].sort((left, right) => left.id.localeCompare(right.id))));
}

function validComponentRelation(value) {
  return plainRecord(value) && sameKeys(value, ["id", "label", "kind", "relation", "provenance_refs"])
    && safeTopologyId(value.id) && validComponentText(value.label, 160) && ["service", "job", "topic"].includes(value.kind)
    && ["calls", "declared_async_dependency", "configuration_route", "telemetry_export"].includes(value.relation)
    && validProvenanceList(value.provenance_refs, 4);
}

function validComponentObservability(value) {
  return plainRecord(value) && sameKeys(value, ["metrics", "traces", "logs", "changes"])
    && validComponentEvidenceList(value.metrics, validMetricDetail)
    && validComponentEvidenceList(value.traces, validTraceDetail)
    && validComponentEvidenceList(value.logs, validLogDetail)
    && validComponentEvidenceList(value.changes, validChangeDetail);
}

function validComponentEvidenceList(value, validator) {
  return Array.isArray(value) && value.length <= 4 && new Set(value.map(({ evidence_id }) => evidence_id)).size === value.length
    && value.every(validator) && sameOrdered(value, [...value].sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.evidence_id.localeCompare(right.evidence_id)));
}

function validEvidenceBase(value, keys) {
  return plainRecord(value) && sameKeys(value, keys)
    && safeTopologyId(value.evidence_id) && validComponentText(value.title, 180) && validComponentText(value.source, 160)
    && validTopologyTimestamp(value.observed_at) && validHash(value.record_sha256);
}

function validMetricDetail(value) {
  const keys = ["evidence_id", "title", "source", "observed_at", "record_sha256", "name", "value", "before", "after", "unit", "aggregation", "threshold"];
  return validEvidenceBase(value, keys) && nullableComponentText(value.name, 120) && nullableDetailNumber(value.value)
    && nullableDetailNumber(value.before) && nullableDetailNumber(value.after) && nullableComponentText(value.unit, 40)
    && nullableComponentText(value.aggregation, 40) && nullableComponentText(value.threshold, 80);
}

function validTraceDetail(value) {
  const keys = ["evidence_id", "title", "source", "observed_at", "record_sha256", "operation", "peer_target", "status", "error", "trace_ref", "span_ref"];
  return validEvidenceBase(value, keys) && nullableComponentText(value.operation, 160) && nullableComponentText(value.peer_target, 160)
    && nullableComponentText(value.status, 40) && nullableComponentText(value.error, 160)
    && nullableDetailRef(value.trace_ref) && nullableDetailRef(value.span_ref);
}

function validLogDetail(value) {
  const base = ["evidence_id", "title", "source", "observed_at", "record_sha256"];
  const enriched = [...base, "severity", "summary", "trace_ref", "span_ref"];
  if (sameKeys(value, base)) return validEvidenceBase(value, base);
  return validEvidenceBase(value, enriched)
    && nullableComponentText(value.severity, 32)
    && validSafeLogSummary(value.summary)
    && nullableDetailRef(value.trace_ref)
    && nullableDetailRef(value.span_ref);
}

function validChangeDetail(value) {
  const keys = ["evidence_id", "title", "source", "observed_at", "record_sha256", "target", "flag", "before", "after", "applied_at"];
  return validEvidenceBase(value, keys) && (value.target === null || safeTopologyId(value.target))
    && nullableComponentText(value.flag, 120) && nullableComponentText(value.before, 120)
    && nullableComponentText(value.after, 120) && (value.applied_at === null || validTopologyTimestamp(value.applied_at));
}

function validComponentDataResources(value) {
  return Array.isArray(value) && value.length <= 8
    && value.every((resource) => plainRecord(resource) && sameKeys(resource, ["kind", "id", "name", "consumer_group"])
      && ["topic", "consumer_group", "database", "table", "job", "dag"].includes(resource.kind)
      && (resource.id === null || safeTopologyId(resource.id))
      && nullableComponentText(resource.name, 160)
      && nullableComponentText(resource.consumer_group, 160)
      && (resource.id !== null || resource.name !== null))
    && new Set(value.map((resource) => `${resource.kind}:${resource.id || ""}:${resource.name || ""}:${resource.consumer_group || ""}`)).size === value.length;
}

function validProvenanceList(value, limit) {
  return Array.isArray(value) && value.length > 0 && value.length <= limit && value.every(validProvenanceRef)
    && sameOrdered(value, [...value].sort());
}

function nullableComponentText(value, maximum) { return value === null || validComponentText(value, maximum); }
function nullableDetailNumber(value) { return value === null || typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000; }
function nullableDetailRef(value) { return value === null || typeof value === "string" && /^[a-f0-9]{8,64}$/i.test(value); }
function validComponentText(value, maximum) { return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9 .()/_:+,=-]*$/.test(value); }
function validSafeLogSummary(value) {
  return validComponentText(value, 280)
    && !/(?:\b(?:api[_ -]?key|authorization|password|secret|token)\b\s*[:=]|\b(?:sk|rk)_[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.)/i.test(value)
    && !/\b(?:system|developer|user)\s+prompt\b/i.test(value);
}

function topologyViewsV2(value) {
  const rootKeys = ["schema_version", "projection_revision", "run_id", "incident_id", "truth", "readiness", "architecture", "live", "diagnose", "demo"];
  if (!plainRecord(value) || !sameKeys(value, rootKeys) || value.schema_version !== "flowpulse.topology-views.v2" || !validHash(value.projection_revision) || !nullableTopologyId(value.run_id) || !nullableTopologyId(value.incident_id) || !validTopologyTruth(value.truth) || !validTopologyReadiness(value.readiness)) return null;
  const architecture = parseScopedTopology(value.architecture, false);
  const live = parseScopedTopology(value.live, true);
  const diagnose = parseDiagnoseTopology(value.diagnose);
  const demo = parseDemoTopology(value.demo, value.run_id, architecture?.runtime_data);
  if (!architecture || !live || !diagnose || demo === undefined || !sameRuntimeIdentity(architecture.runtime_data, live.runtime_data) || !sameRuntimeIdentity(architecture.runtime_data, diagnose.runtime_data) || !sameControlIdentity(architecture.control_system, live.control_system) || !sameExternalEvidence(architecture.external_change_evidence, live.external_change_evidence)) return null;
  return {
    projection_revision: value.projection_revision,
    run_id: value.run_id,
    incident_id: value.incident_id,
    truth: value.truth,
    readiness: value.readiness,
    architecture,
    live,
    diagnose,
    demo
  };
}

function parseScopedTopology(scope, hasOverlay) {
  const keys = hasOverlay ? ["runtime_data", "control_system", "external_change_evidence", "incident_overlay"] : ["runtime_data", "control_system", "external_change_evidence"];
  if (!plainRecord(scope) || !sameKeys(scope, keys)) return null;
  const runtimeData = parseRuntimeData(scope.runtime_data);
  const controlSystem = parseControlSystem(scope.control_system);
  const externalEvidence = parseExternalEvidence(scope.external_change_evidence, new Set(runtimeData?.graph.nodes.map(({ id }) => id)));
  const overlay = hasOverlay ? parseLiveOverlay(scope.incident_overlay, new Set(runtimeData?.graph.nodes.map(({ id }) => id)), new Set(runtimeData?.graph.edges.map(({ id }) => id)), new Set(runtimeData?.supporting_relations.map(({ id }) => id))) : null;
  if (!runtimeData || !controlSystem || !externalEvidence || hasOverlay && !overlay) return null;
  return hasOverlay
    ? { runtime_data: runtimeData, control_system: controlSystem, external_change_evidence: externalEvidence, incident_overlay: overlay }
    : { runtime_data: runtimeData, control_system: controlSystem, external_change_evidence: externalEvidence };
}

function parseRuntimeData(value) {
  if (!plainRecord(value) || !sameKeys(value, ["graph", "node_count", "edge_count", "supporting_relations", "supporting_relation_count"]) || !plainRecord(value.graph) || !sameKeys(value.graph, ["nodes", "edges", "total_nodes", "total_edges", "truncated"]) || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges) || !Array.isArray(value.supporting_relations) || value.node_count !== 22 || value.edge_count !== 26 || value.supporting_relation_count !== 7 || value.graph.nodes.length !== 22 || value.graph.edges.length !== 26 || value.supporting_relations.length !== 7 || value.graph.total_nodes !== 22 || value.graph.total_edges !== 26 || value.graph.truncated !== false || !value.graph.nodes.every(validRuntimeNode) || !value.graph.edges.every(validRuntimeEdge) || !value.supporting_relations.every(validSupportingRelation)) return null;
  const ids = new Set(value.graph.nodes.map(({ id }) => id));
  const edgeIds = new Set(value.graph.edges.map(({ id }) => id));
  const supportingIds = new Set(value.supporting_relations.map(({ id }) => id));
  const semanticEdges = new Set(value.graph.edges.map(({ from, to, kind }) => `${from}\0${to}\0${kind}`));
  if (ids.size !== 22 || edgeIds.size !== 26 || supportingIds.size !== 7 || semanticEdges.size !== 26 || [...supportingIds].some((id) => edgeIds.has(id)) || value.graph.edges.some(({ from, to }) => !ids.has(from) || !ids.has(to) || from === to) || value.supporting_relations.some(({ from, to }) => !ids.has(from) || !ids.has(to) || from === to) || !sameOrdered(value.graph.nodes, sortProjectionNodes(value.graph.nodes)) || !sameOrdered(value.graph.edges, sortProjectionEdges(value.graph.edges)) || !sameOrdered(value.supporting_relations, [...value.supporting_relations].sort((left, right) => left.id.localeCompare(right.id)))) return null;
  return { graph: { nodes: value.graph.nodes, edges: value.graph.edges, total_nodes: 22, total_edges: 26, truncated: false }, node_count: 22, edge_count: 26, supporting_relations: value.supporting_relations, supporting_relation_count: 7 };
}

function parseControlSystem(value) {
  if (!plainRecord(value) || !sameKeys(value, ["nodes", "relations", "node_count", "relation_count"]) || !Array.isArray(value.nodes) || !Array.isArray(value.relations) || value.node_count !== 5 || value.nodes.length !== 5 || !Number.isInteger(value.relation_count) || value.relation_count < 0 || value.relation_count > 4 || value.relations.length !== value.relation_count || !value.nodes.every(validControlNode) || !value.relations.every(validControlRelation)) return null;
  const ids = new Set(value.nodes.map(({ id }) => id));
  const expected = ["observer", "orchestrator", "investigator", "evaluator", "ledger"];
  const relationIds = new Set(value.relations.map(({ id }) => id));
  if (ids.size !== 5 || expected.some((id) => !ids.has(id)) || relationIds.size !== value.relations.length || value.relations.some(({ from, to }) => !ids.has(from) || !ids.has(to)) || !sameOrdered(value.nodes, sortProjectionNodes(value.nodes)) || !sameOrdered(value.relations, sortProjectionEdges(value.relations))) return null;
  return { nodes: value.nodes, relations: value.relations, node_count: 5, relation_count: value.relation_count };
}

function parseExternalEvidence(value, runtimeIds) {
  if (!plainRecord(value) || !sameKeys(value, ["records", "relation_count"]) || !Array.isArray(value.records) || value.records.length > 4 || !Number.isInteger(value.relation_count) || value.relation_count < 0 || value.relation_count > 16 || !value.records.every(validExternalEvidenceRecord) || new Set(value.records.map(({ id }) => id)).size !== value.records.length || value.records.some((record) => record.affected_node_ids.some((id) => !runtimeIds.has(id))) || value.relation_count !== value.records.reduce((count, record) => count + record.affected_node_ids.length, 0) || !sameOrdered(value.records, [...value.records].sort((left, right) => left.id.localeCompare(right.id)))) return null;
  return { records: value.records, relation_count: value.relation_count };
}

function parseDiagnoseTopology(value) {
  if (!plainRecord(value) || !sameKeys(value, ["runtime_data", "overlay"])) return null;
  const runtimeData = parseRuntimeData(value.runtime_data);
  const nodeIds = new Set(runtimeData?.graph.nodes.map(({ id }) => id));
  const edgeIds = new Set(runtimeData?.graph.edges.map(({ id }) => id));
  const overlay = parseDiagnoseOverlay(value.overlay, nodeIds, edgeIds, new Set(runtimeData?.supporting_relations.map(({ id }) => id)));
  return runtimeData && overlay ? { runtime_data: runtimeData, overlay } : null;
}

function parseLiveOverlay(value, nodeIds, edgeIds, supportingIds) {
  if (!plainRecord(value) || !sameKeys(value, ["status", "node_ids", "edges"]) || !["inactive", "active"].includes(value.status) || !Array.isArray(value.node_ids) || !Array.isArray(value.edges) || value.node_ids.length > 6 || value.edges.length > 5 || new Set(value.node_ids).size !== value.node_ids.length || new Set(value.edges.map((edge) => edge?.id)).size !== value.edges.length || !value.node_ids.every((id) => nodeIds.has(id)) || !value.edges.every((edge) => validOverlayEdge(edge, value.node_ids, edgeIds, supportingIds, true)) || !sameOrdered(value.node_ids, [...value.node_ids].sort()) || !sameOrdered(value.edges, [...value.edges].sort((left, right) => left.id.localeCompare(right.id)))) return null;
  if (value.status === "inactive" && (value.node_ids.length || value.edges.length)) return null;
  if (value.status === "active" && (value.node_ids.length !== 6 || value.edges.length !== 5)) return null;
  return { status: value.status, node_ids: value.node_ids, edges: value.edges };
}

function parseDiagnoseOverlay(value, nodeIds, edgeIds, supportingIds) {
  if (!plainRecord(value) || !sameKeys(value, ["status", "node_ids", "edges"]) || !["unavailable", "available"].includes(value.status) || !Array.isArray(value.node_ids) || !Array.isArray(value.edges) || value.node_ids.length > 6 || value.edges.length > 5 || new Set(value.node_ids).size !== value.node_ids.length || new Set(value.edges.map((edge) => edge?.id)).size !== value.edges.length || !value.node_ids.every((id) => nodeIds.has(id)) || !value.edges.every((edge) => validOverlayEdge(edge, value.node_ids, edgeIds, supportingIds, false)) || !sameOrdered(value.node_ids, [...value.node_ids].sort()) || !sameOrdered(value.edges, [...value.edges].sort((left, right) => left.id.localeCompare(right.id)))) return null;
  if (value.status === "unavailable" && (value.node_ids.length || value.edges.length)) return null;
  if (value.status === "available" && (value.node_ids.length !== 6 || value.edges.length !== 5)) return null;
  return { status: value.status, node_ids: value.node_ids, edges: value.edges };
}

function validOverlayEdge(edge, nodeIds, edgeIds, supportingIds, live) {
  const keys = live ? ["id", "from", "to", "relation", "status"] : ["id", "from", "to", "relation"];
  return plainRecord(edge) && sameKeys(edge, keys) && edge.id === `${edge.from}->${edge.to}` && nodeIds.includes(edge.from) && nodeIds.includes(edge.to)
    && ["observed_dependency", "evidence_grounded_relation"].includes(edge.relation)
    && (edge.relation !== "observed_dependency" || edgeIds.has(edge.id))
    && (edge.relation !== "evidence_grounded_relation" || supportingIds.has(edge.id))
    && (!live || edge.status === "incident");
}

function parseDemoTopology(value, runId, runtimeData) {
  if (value === null) return null;
  const phases = ["HEALTHY", "INJECTING", "PAYMENT_CHECKOUT_IMPACT", "DOWNSTREAM_PROPAGATION", "INCIDENT_DETECTED"];
  const evidenceRefs = new Set(["ev-deploy-checkout", "ev-trace-payment-refused", "ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"]);
  const expectedPhases = value?.phase === "HEALTHY" ? phases.slice(0, 1) : value?.phase === "INCIDENT_DETECTED" ? phases : null;
  const nodeIds = new Set(runtimeData?.graph.nodes.map(({ id }) => id));
  const edgeIds = new Set([...(runtimeData?.graph.edges || []), ...(runtimeData?.supporting_relations || [])].map(({ id }) => id));
  if (!safeTopologyId(runId) || !expectedPhases || !plainRecord(value) || !sameKeys(value, ["schema_version", "run_id", "scenario_id", "phase", "frames"])
    || value.schema_version !== "flowpulse.demo-lifecycle.v1" || value.run_id !== runId || value.scenario_id !== "astronomy-checkout-payment-captured-v1"
    || !Array.isArray(value.frames) || value.frames.length !== expectedPhases.length) return undefined;
  const valid = value.frames.every((frame, index) => plainRecord(frame) && sameKeys(frame, ["id", "order", "phase", "node_ids", "relation_ids", "evidence_refs"])
    && frame.id === expectedPhases[index].toLowerCase() && frame.order === index && frame.phase === expectedPhases[index]
    // Node, relation, and evidence references retain the server's causal-frame
    // order. It is deterministic but meaningful, so a browser must not reject the
    // active incident merely because that order is not lexical.
    && Array.isArray(frame.node_ids) && frame.node_ids.length <= 6 && new Set(frame.node_ids).size === frame.node_ids.length && frame.node_ids.every((id) => nodeIds.has(id))
    && Array.isArray(frame.relation_ids) && frame.relation_ids.length <= 5 && new Set(frame.relation_ids).size === frame.relation_ids.length && frame.relation_ids.every((id) => edgeIds.has(id))
    && Array.isArray(frame.evidence_refs) && frame.evidence_refs.length <= 6 && new Set(frame.evidence_refs).size === frame.evidence_refs.length && frame.evidence_refs.every((id) => evidenceRefs.has(id)));
  return valid ? { schema_version: value.schema_version, run_id: value.run_id, scenario_id: value.scenario_id, phase: value.phase, frames: value.frames.map((frame) => ({ ...frame, node_ids: [...frame.node_ids], relation_ids: [...frame.relation_ids], evidence_refs: [...frame.evidence_refs] })) } : undefined;
}

function sameRuntimeIdentity(left, right) {
  return JSON.stringify(runtimeIdentity(left)) === JSON.stringify(runtimeIdentity(right));
}

function sameControlIdentity(left, right) {
  return JSON.stringify(left.nodes.map(nodeIdentity)) === JSON.stringify(right.nodes.map(nodeIdentity)) && JSON.stringify(left.relations.map(edgeIdentity)) === JSON.stringify(right.relations.map(edgeIdentity));
}

function sameExternalEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runtimeIdentity(runtimeData) {
  return {
    nodes: runtimeData.graph.nodes.map(nodeIdentity),
    edges: runtimeData.graph.edges.map(edgeIdentity),
    supporting_relations: runtimeData.supporting_relations.map(edgeIdentity)
  };
}

function nodeIdentity({ status, ...node }) { return node; }
function edgeIdentity({ status, ...edge }) { return edge; }

function sortProjectionNodes(nodes) {
  const plane = { runtime: 0, data: 1, control: 2, evidence: 3 };
  const layer = { experience: 0, commerce: 1, processing: 2, platform: 3, observation: 4, orchestration: 5, investigation: 6, evaluation: 7, evidence: 8 };
  return [...nodes].sort((left, right) => plane[left.plane] - plane[right.plane] || layer[left.layer] - layer[right.layer] || left.id.localeCompare(right.id));
}

function sortProjectionEdges(edges) {
  const plane = { runtime: 0, data: 1, control: 2, evidence: 3 };
  return [...edges].sort((left, right) => plane[left.plane] - plane[right.plane] || left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function sameOrdered(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function architectureBoundaries(topology = {}) {
  const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
  const edges = Array.isArray(topology.edges) ? topology.edges : [];
  const observedNodes = nodes.filter((node) => ["runtime", "data"].includes(node.plane));
  const flowpulseNodes = nodes.filter((node) => ["control", "evidence"].includes(node.plane));
  const observedIds = new Set(observedNodes.map((node) => node.id));
  const flowpulseIds = new Set(flowpulseNodes.map((node) => node.id));
  const observedRelations = [];
  const internalRelations = [];
  const crossBoundaryRelations = [];

  for (const edge of edges) {
    const observedFrom = observedIds.has(edge.from);
    const observedTo = observedIds.has(edge.to);
    const flowpulseFrom = flowpulseIds.has(edge.from);
    const flowpulseTo = flowpulseIds.has(edge.to);
    if (observedFrom && observedTo) observedRelations.push(edge);
    else if (flowpulseFrom && flowpulseTo) internalRelations.push(edge);
    else if ((observedFrom && flowpulseTo) || (flowpulseFrom && observedTo)) crossBoundaryRelations.push(edge);
  }

  return {
    observed: { nodes: observedNodes, relations: observedRelations },
    flowpulse: { nodes: flowpulseNodes, internal_relations: internalRelations },
    cross_boundary_relations: crossBoundaryRelations
  };
}

function validArchitectureNode(node) {
  return plainRecord(node) && sameKeys(node, ["id", "kind", "display_class", "plane", "layer", "label", "status", "source_health", "signal_types", "provenance_refs"])
    && typeof node.id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(node.id)
    && typeof node.label === "string" && node.label.length > 0 && node.label.length <= 160
    && ["service", "job", "topic", "dataset"].includes(node.kind)
    && ["client", "service", "api", "stream", "worker", "observer", "orchestrator", "agent", "evaluator", "ledger"].includes(node.display_class)
    && ["runtime", "data", "control", "evidence"].includes(node.plane)
    && typeof node.layer === "string" && node.layer.length > 0 && node.layer.length <= 80
    && ["observed", "captured", "healthy", "incident", "idle", "recording", "active", "rejected", "accepted"].includes(node.status)
    && ["live", "stale", "disconnected", "unavailable"].includes(node.source_health)
    && Array.isArray(node.signal_types) && node.signal_types.length <= 3 && new Set(node.signal_types).size === node.signal_types.length && node.signal_types.every((value, index) => ["trace", "metric", "log"].includes(value) && (index === 0 || ["trace", "metric", "log"].indexOf(node.signal_types[index - 1]) < ["trace", "metric", "log"].indexOf(value)))
    && Array.isArray(node.provenance_refs) && node.provenance_refs.length > 0 && node.provenance_refs.length <= 4 && node.provenance_refs.every(validProvenanceRef);
}

function validArchitectureEdge(edge) {
  return plainRecord(edge) && sameKeys(edge, ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"])
    && typeof edge.id === "string" && edge.id.length > 0 && edge.id.length <= 160
    && typeof edge.from === "string" && typeof edge.to === "string" && edge.from !== edge.to
    && ["runtime", "data", "control", "evidence"].includes(edge.plane)
    && typeof edge.kind === "string" && edge.kind.length > 0 && edge.kind.length <= 80
    && (edge.label === null || typeof edge.label === "string" && edge.label.length <= 160)
    && ["observed", "captured", "healthy", "incident", "idle", "recording", "active", "rejected", "accepted"].includes(edge.status)
    && Array.isArray(edge.provenance_refs) && edge.provenance_refs.length > 0 && edge.provenance_refs.length <= 4 && edge.provenance_refs.every(validProvenanceRef);
}

function validRuntimeNode(node) {
  return validArchitectureNode(node)
    && ["runtime", "data"].includes(node.plane)
    && ["experience", "commerce", "processing", "platform"].includes(node.layer)
    && ["service", "job", "topic"].includes(node.kind)
    && ["client", "service", "api", "stream", "worker"].includes(node.display_class)
    && ["observed", "captured", "healthy", "incident"].includes(node.status);
}

function validRuntimeEdge(edge) {
  return validArchitectureEdge(edge)
    && edge.id === `${edge.from}->${edge.to}`
    && edge.kind === "calls"
    && edge.plane === "runtime"
    && edge.label === "Observed dependency"
    && ["observed", "captured", "healthy", "incident"].includes(edge.status);
}

function validSupportingRelation(edge) {
  return validArchitectureEdge(edge)
    && edge.id === `${edge.from}->${edge.to}`
    && ["declared_async_dependency", "configuration_route", "telemetry_export"].includes(edge.kind)
    && ["runtime", "data"].includes(edge.plane)
    && ["Declared async dependency", "Configured route", "Telemetry export"].includes(edge.label)
    && ["observed", "captured", "healthy", "incident"].includes(edge.status);
}

function validControlNode(node) {
  const expected = {
    observer: ["service", "observer", "control", "observation", "Observer"],
    orchestrator: ["service", "orchestrator", "control", "orchestration", "Orchestrator"],
    investigator: ["service", "agent", "control", "investigation", "Investigator"],
    evaluator: ["service", "evaluator", "control", "evaluation", "Evaluator"],
    ledger: ["dataset", "ledger", "evidence", "evidence", "Evidence Ledger"]
  };
  const shape = expected[node?.id];
  const { detail, ...identity } = node || {};
  return validArchitectureNode(identity) && Boolean(shape) && validControlDetail(detail)
    && node.kind === shape[0] && node.display_class === shape[1] && node.plane === shape[2] && node.layer === shape[3] && node.label === shape[4]
    && ["observed", "idle", "recording", "active", "rejected", "accepted"].includes(node.status)
    && (node.id === "observer" || node.source_health === "unavailable")
    && node.signal_types.length === 0;
}

function validControlDetail(value) {
  const fields = ["summary", "inputs", "outputs", "authority", "provenance_refs", "activity"];
  const activityFields = ["summary", "stage", "last_sequence", "last_recorded_at", "evidence_refs", "gate", "source_health"];
  return plainRecord(value) && sameKeys(value, fields)
    && validTopologyText(value.summary, 160) && validTopologyText(value.authority, 160)
    && validTopologyTextList(value.inputs, 4, 120) && validTopologyTextList(value.outputs, 4, 120)
    && Array.isArray(value.provenance_refs) && value.provenance_refs.length > 0 && value.provenance_refs.length <= 4 && new Set(value.provenance_refs).size === value.provenance_refs.length && value.provenance_refs.every(validProvenanceRef) && sameOrdered(value.provenance_refs, [...value.provenance_refs].sort())
    && plainRecord(value.activity) && sameKeys(value.activity, activityFields)
    && (value.activity.summary === null || validTopologyText(value.activity.summary, 120))
    && (value.activity.stage === null || ["collecting", "evaluating", "replanning", "blocked", "waiting_for_owner", "approved", "executing", "verified", "legacy_detail_unavailable", "non_actionable"].includes(value.activity.stage))
    && (value.activity.last_sequence === null || Number.isInteger(value.activity.last_sequence) && value.activity.last_sequence > 0 && value.activity.last_sequence <= 1_000_000_000)
    && (value.activity.last_recorded_at === null || validTopologyTimestamp(value.activity.last_recorded_at))
    && Array.isArray(value.activity.evidence_refs) && value.activity.evidence_refs.length <= 4 && new Set(value.activity.evidence_refs).size === value.activity.evidence_refs.length && value.activity.evidence_refs.every(safeTopologyId) && sameOrdered(value.activity.evidence_refs, [...value.activity.evidence_refs].sort())
    && ["unavailable", "pending", "rejected", "accepted"].includes(value.activity.gate)
    && ["live", "stale", "disconnected", "unavailable"].includes(value.activity.source_health);
}

function validControlRelation(edge) {
  const expected = {
    "investigator-evaluator": ["investigator", "evaluator", "evaluates", "control", "Investigation handoff", "ledger://investigation"],
    "investigator-ledger": ["investigator", "ledger", "records", "evidence", "Investigation record", "ledger://investigation"],
    "evaluator-ledger": ["evaluator", "ledger", "records", "evidence", "Evaluator record", "ledger://evaluation"]
  };
  const shape = expected[edge?.id];
  return validArchitectureEdge(edge) && Boolean(shape)
    && edge.from === shape[0] && edge.to === shape[1] && edge.kind === shape[2] && edge.plane === shape[3] && edge.label === shape[4]
    && edge.provenance_refs.length === 1 && edge.provenance_refs[0] === shape[5]
    && ["active", "rejected", "accepted"].includes(edge.status);
}

function validExternalEvidenceRecord(record) {
  return plainRecord(record) && sameKeys(record, ["id", "kind", "status", "affected_node_ids", "provenance_refs"])
    && typeof record.id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(record.id)
    && record.kind === "deployment_change" && record.status === "observed"
    && Array.isArray(record.affected_node_ids) && record.affected_node_ids.length >= 1 && record.affected_node_ids.length <= 4 && new Set(record.affected_node_ids).size === record.affected_node_ids.length
    && record.affected_node_ids.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id))
    && sameOrdered(record.affected_node_ids, [...record.affected_node_ids].sort())
    && Array.isArray(record.provenance_refs) && record.provenance_refs.length > 0 && record.provenance_refs.length <= 4 && record.provenance_refs.every(validProvenanceRef);
}

function validTopologyTruth(truth) {
  return plainRecord(truth) && sameKeys(truth, ["source_health", "evidence_mode", "execution_mode", "label"])
    && ["live", "stale", "disconnected", "unavailable"].includes(truth.source_health)
    && ["live_stream", "frozen_real_snapshot", "captured_fixture"].includes(truth.evidence_mode)
    && ["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"].includes(truth.execution_mode)
    && ["LIVE", "CAPTURED", "UNAVAILABLE"].includes(truth.label);
}

function validTopologyReadiness(readiness) {
  const keys = ["architecture_available", "live_available", "incident_detected", "diagnose_available", "agent_available", "compare_available"];
  return plainRecord(readiness) && sameKeys(readiness, keys) && keys.every((key) => typeof readiness[key] === "boolean");
}

function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nullableTopologyId(value) { return value === null || typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value); }
function safeTopologyId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value); }

function validProvenanceRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^(capture|code|ledger|evidence):\/\/[A-Za-z0-9._:/#-]+$/.test(value);
}

function validTopologyText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9 .()/_+-]*$/.test(value);
}

function validTopologyTextList(value, maximumCount, maximumLength) {
  return Array.isArray(value) && value.length > 0 && value.length <= maximumCount && new Set(value).size === value.length && value.every((item) => validTopologyText(item, maximumLength)) && sameOrdered(value, [...value].sort());
}

function validTopologyTimestamp(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function sameKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function normalizeServiceId(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_.]+/g, "-").replace(/-+/g, "-");
  return ({ fraud: "fraud-detection" })[normalized] || normalized;
}

export const TWIN_EDGES = [
  { id: "frontend-checkout", from: "frontend", to: "checkout", label: "cart request", path: "M 155 239 C 185 239 205 239 225 239" },
  { id: "checkout-payment", from: "checkout", to: "payment", label: "payment call", path: "M 332 226 C 382 226 378 125 430 125" },
  { id: "checkout-kafka", from: "checkout", to: "kafka", label: "order publish", path: "M 332 252 C 382 252 385 307 430 307" },
  { id: "kafka-accounting", from: "kafka", to: "accounting", label: "accounting consume", path: "M 525 306 C 575 306 592 239 635 239" },
  { id: "kafka-fraud", from: "kafka", to: "fraud", label: "fraud consume", path: "M 525 322 C 575 322 590 385 635 385" },
  { id: "deployment-checkout", from: "deployment", to: "checkout", label: "deployment change", path: "M 270 104 C 270 136 270 168 270 199", control: true },
  { id: "agent-evaluator", from: "agent", to: "evaluator", label: "candidate diagnosis", path: "M 870 174 C 870 202 870 228 870 248", control: true },
  { id: "evaluator-ledger", from: "evaluator", to: "ledger", label: "score and record", path: "M 870 302 C 870 332 870 360 870 382", control: true },
  { id: "checkout-ledger", from: "checkout", to: "ledger", label: "cited checkout evidence", path: "M 300 270 C 320 485 730 486 820 420", evidence: true },
  { id: "kafka-ledger", from: "kafka", to: "ledger", label: "cited Kafka evidence", path: "M 490 335 C 520 465 730 468 820 420", evidence: true }
];

export function availableStage(events = []) {
  const has = (type) => events.some((event) => event.type === type);
  if (has("policy.evaluated")) return 7;
  if (has("verification.completed")) return 6;
  if (has("approval.requested")) return 5;
  if (has("evaluation.accepted")) return 4;
  if (has("evaluation.rejected")) return 3;
  if (has("loop.symptoms_collected")) return 2;
  return 0;
}

export function frameFor(stageIndex) {
  const index = clampStage(stageIndex);
  const nodeStates = Object.fromEntries(TWIN_NODES.map((node) => [node.id, node.kind === "change" ? "dormant" : node.kind === "database" ? "recording" : "healthy"]));
  const edgeStates = Object.fromEntries(TWIN_EDGES.map((edge) => [edge.id, edge.control || edge.evidence ? "quiet" : "healthy"]));
  const annotations = [];

  if (index >= 1) {
    nodeStates.deployment = "change";
    nodeStates.checkout = "warning";
    edgeStates["deployment-checkout"] = "change";
    annotations.push({ id: "deploy", tone: "change", title: "Deployment entered", copy: "checkout:2.18.0 from commit c7e1b9a", x: 35, y: 8 });
  }
  if (index >= 2 && index < 6) {
    for (const id of ["checkout", "payment", "kafka", "accounting", "fraud"]) nodeStates[id] = "impact";
    for (const id of ["checkout-payment", "checkout-kafka", "kafka-accounting", "kafka-fraud"]) edgeStates[id] = "impact";
    annotations.push({ id: "propagation", tone: "impact", title: "Failure propagated", copy: "ECONNREFUSED precedes Kafka lag by 171s", x: 52, y: 7 });
  }
  if (index >= 3) {
    nodeStates.agent = index >= 6 ? "verified" : "active";
    nodeStates.evaluator = index >= 6 ? "verified" : "rejected";
    edgeStates["agent-evaluator"] = index >= 6 ? "verified" : "rejected";
    annotations.push({ id: "rejected", tone: "rejected", title: "Kafka hypothesis rejected", copy: "22% score. Broker health is normal.", x: 69, y: 13 });
  }
  if (index >= 3 && index < 6) {
    annotations.push({ id: "replan", tone: "change", title: "Investigator replanned", copy: "Search upstream change and first failing span", x: 72, y: 30 });
  }
  if (index >= 4 && index < 6) {
    nodeStates.checkout = "root";
    nodeStates.payment = "root";
    edgeStates["checkout-payment"] = "root";
    annotations.push({ id: "root", tone: "root", title: "Root cause confirmed", copy: "Unset PAYMENT_ADDR selected payment:9090", x: 42, y: 34 });
  }
  if (index >= 5 && index < 6) {
    nodeStates.deployment = "approval";
    annotations.push({ id: "gate", tone: "gate", title: "Owner approval required", copy: "Rollback is locked to checkout only", x: 25, y: 65 });
  }
  if (index >= 6) {
    for (const id of ["checkout", "payment", "kafka", "accounting", "fraud", "deployment"]) nodeStates[id] = "verified";
    for (const id of ["checkout-payment", "checkout-kafka", "kafka-accounting", "kafka-fraud", "deployment-checkout"]) edgeStates[id] = "verified";
    annotations.push({ id: "recovery", role: "outcome", tone: "verified", title: "Recovery verified", copy: "Payment 99.98%. Errors 0.8%. Lag 620.", x: 43, y: 8 });
  }
  if (index >= 7) {
    nodeStates.agent = "learned";
    nodeStates.evaluator = "learned";
    nodeStates.ledger = "learned";
    for (const id of ["agent-evaluator", "evaluator-ledger", "checkout-ledger", "kafka-ledger"]) edgeStates[id] = "learned";
    annotations.push({ id: "learning", role: "outcome", tone: "learned", title: "Regression recorded", copy: "evidence-policy-v2 passed six offline gates", x: 70, y: 7 });
  }

  return {
    index,
    stage: TWIN_STAGES[index],
    nodeStates,
    edgeStates,
    annotations,
    metrics: metricSnapshot(index)
  };
}

export function compareFrames() {
  return { incident: frameFor(2), recovered: frameFor(6) };
}

export function compareProvenance(events = []) {
  const currentRunVerified = events.some((event) => event.type === "verification.completed" && event.payload?.passed === true);
  return currentRunVerified
    ? {
        label: "Current verified run",
        tone: "verified",
        status: "Authoritative current-run comparison",
        caption: "Passed recovery verification recorded in the current immutable ledger",
        aria: "current run with passed recovery verification"
      }
    : {
        label: "Captured recovery preview",
        tone: "preview",
        status: "Deterministic captured preview",
        caption: "Verified recovery is projected from the deterministic captured incident bundle",
        aria: "captured deterministic recovery preview"
      };
}

export function metricSnapshot(index) {
  if (index >= 6) return {
    checkout: { value: "0.8%", note: "verified" },
    payment: { value: "99.98%", note: "reachable" },
    kafka: { value: "620", note: "draining" }
  };
  if (index >= 2) return {
    checkout: { value: "38.4%", note: "errors" },
    payment: { value: "61.6%", note: "reachable" },
    kafka: { value: "11,842", note: "lag" }
  };
  return {
    checkout: { value: "0.7%", note: "captured baseline" },
    payment: { value: "Nominal", note: "pre-incident" },
    kafka: { value: "182", note: "lag baseline" }
  };
}

export function eventsAtStage(events = [], stageIndex) {
  const index = clampStage(stageIndex);
  const allowed = new Set(stageEventTypes(index));
  return events.filter((event) => allowed.has(event.type));
}

export function liveIncidentNodeStates({ mode, events = [], source = {} } = {}) {
  const nodes = source.topology?.nodes || [];
  const base = source.status === "live" ? "observed" : ["stale", "connecting"].includes(source.status) ? "warning" : "dormant";
  const states = Object.fromEntries(nodes.map(({ id }) => [id, base]));
  if (mode !== "development" || source.status !== "live" || source.authoritative !== true) return states;

  const referenced = new Set(events.flatMap((event) => event.evidence_refs || []));
  const knownNodes = new Set(nodes.map(({ id }) => id));
  const affected = new Set();
  for (const item of source.evidence || []) {
    if (!referenced.has(item.id) || item.signal !== "traces" || !hasExplicitFailure(item.payload)) continue;
    const scoped = failedResourceServices(item.payload);
    const declared = Array.isArray(item.value?.services) ? item.value.services : [];
    const services = new Set(scoped);
    if (declared.length <= 2) for (const service of declared) services.add(service);
    for (const service of services) if (knownNodes.has(service)) affected.add(service);
  }
  const verified = events.some((event) => event.type === "verification.completed" && event.payload?.passed === true);
  for (const service of affected) states[service] = verified ? "verified" : "impact";
  return states;
}

export function activeIncidentState(events = []) {
  const opened = events.some((event) => event.type === "incident.opened");
  const verified = events.some((event) => event.type === "verification.completed" && event.payload?.passed === true);
  return opened && !verified;
}

export function liveSignalDuration(pathLength, speed = 520, launchFraction = .1, terminalFraction = .16) {
  const length = Math.max(0, Number(pathLength) || 0);
  const velocity = Math.max(1, Number(speed) || 1);
  const launch = Math.max(0, Math.min(.2, Number(launchFraction) || 0));
  const terminal = Math.max(0, Math.min(.4, Number(terminalFraction) || 0));
  const cruise = Math.max(0, 1 - launch - terminal);
  return (length / velocity) * (cruise + 2 * launch + 2 * terminal) * 1000;
}

export function liveSignalProgress(elapsedMs, pathLength, speed = 520, launchFraction = .1, terminalFraction = .16) {
  const length = Math.max(0, Number(pathLength) || 0);
  if (!length) return 1;
  const velocity = Math.max(1, Number(speed) || 1);
  const launch = Math.max(0, Math.min(.2, Number(launchFraction) || 0));
  const terminal = Math.max(0, Math.min(.4, Number(terminalFraction) || 0));
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const launchMs = (2 * length * launch / velocity) * 1000;
  if (elapsed <= launchMs && launch) {
    const phase = Math.min(1, elapsed / launchMs);
    return launch * phase ** 2;
  }
  const cruiseDistance = length * Math.max(0, 1 - launch - terminal);
  const cruiseMs = (cruiseDistance / velocity) * 1000;
  if (elapsed <= launchMs + cruiseMs || !terminal) return Math.min(1, launch + (elapsed - launchMs) * velocity / 1000 / length);
  const terminalMs = (2 * length * terminal / velocity) * 1000;
  const phase = Math.min(1, (elapsed - launchMs - cruiseMs) / terminalMs);
  return (1 - terminal) + terminal * (1 - (1 - phase) ** 2);
}

export function livePulseSlots(topology = {}) {
  const nodes = topology.nodes || [];
  const edges = topology.edges || [];
  const incoming = new Map(nodes.map(({ id }) => [id, 0]));
  const outgoing = new Map(nodes.map(({ id }) => [id, []]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }

  const depth = new Map();
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const edge of [...(outgoing.get(id) || [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const next = (depth.get(id) || 0) + 1;
      if (!depth.has(edge.to) || next < depth.get(edge.to)) depth.set(edge.to, next);
      const remaining = (incoming.get(edge.to) || 0) - 1;
      incoming.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  return Object.fromEntries([...edges]
    .sort((a, b) => (depth.get(a.from) || 0) - (depth.get(b.from) || 0) || a.id.localeCompare(b.id))
    .map((edge, slot) => [edge.id, slot]));
}

export function liveEdgePath(from, to, {
  canvasWidth = 1100,
  canvasHeight = 520,
  nodeWidth = 144,
  nodeHeight = 58,
  lane = 0
} = {}) {
  const points = liveEdgeRoute(from, to, { canvasWidth, canvasHeight, nodeWidth, nodeHeight, lane });
  if (points.length < 3) return points.map((point, index) => `${index ? "L" : "M"} ${round(point.x)} ${round(point.y)}`).join(" ");
  const commands = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(8, incoming / 2, outgoing / 2);
    const before = pointToward(current, previous, radius, incoming);
    const after = pointToward(current, next, radius, outgoing);
    commands.push(`L ${round(before.x)} ${round(before.y)}`, `Q ${round(current.x)} ${round(current.y)} ${round(after.x)} ${round(after.y)}`);
  }
  const end = points.at(-1);
  commands.push(`L ${round(end.x)} ${round(end.y)}`);
  return commands.join(" ");
}

function pointToward(from, to, distance, length) {
  if (!length) return from;
  return {
    x: from.x + ((to.x - from.x) * distance) / length,
    y: from.y + ((to.y - from.y) * distance) / length
  };
}

export function liveEdgeRoute(from, to, {
  canvasWidth = 1100,
  canvasHeight = 520,
  nodeWidth = 144,
  nodeHeight = 58,
  lane = 0
} = {}) {
  const startCenter = { x: Number(from.x) / 100 * canvasWidth, y: Number(from.y) / 100 * canvasHeight };
  const endCenter = { x: Number(to.x) / 100 * canvasWidth, y: Number(to.y) / 100 * canvasHeight };
  const halfWidth = nodeWidth / 2;
  const halfHeight = nodeHeight / 2;
  const fromColumn = liveRouteColumn(from, startCenter.x, canvasWidth);
  const toColumn = liveRouteColumn(to, endCenter.x, canvasWidth);
  const laneIndex = Math.abs(Math.trunc(Number(lane) || 0));
  const portOffsets = [0, -6, 6, -12, 12];
  const portOffset = Math.max(-halfHeight + 8, Math.min(halfHeight - 8, portOffsets[laneIndex % portOffsets.length]));
  const sameColumn = fromColumn === toColumn;
  const direction = sameColumn ? (fromColumn === 0 ? -1 : 1) : Math.sign(endCenter.x - startCenter.x) || 1;
  const start = { x: startCenter.x + direction * halfWidth, y: startCenter.y + portOffset };
  const end = { x: endCenter.x + (sameColumn ? direction : -direction) * halfWidth, y: endCenter.y - portOffset };

  // Every runtime dependency follows this one fixed-coordinate circuit-board
  // grammar. A route leaves a calculated card port, stays in a gutter or an
  // outer corridor, and enters the exact destination port. It deliberately
  // does not infer a route from the DOM or arbitrary path geometry: the same
  // backend relationship and node coordinates always yield the same path.
  if (sameColumn) {
    const laneX = sameColumnLaneX(start, fromColumn, laneIndex, canvasWidth);
    return compactRoute([start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end]);
  }

  const columnDistance = Math.abs(toColumn - fromColumn);
  if (columnDistance === 1) {
    const gutterMidpoint = (start.x + end.x) / 2;
    const laneX = gutterMidpoint + (((laneIndex % 7) - 3) * 12);
    return compactRoute([start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end]);
  }

  // A long relationship never crosses intermediate component columns. It
  // joins one of four deterministic outer lanes, then returns through the
  // target gutter. These lanes sit outside every fixed card rectangle.
  const sourceLane = start.x + direction * (12 + (laneIndex % 5) * 8);
  const targetLane = end.x - direction * (12 + (laneIndex % 5) * 8);
  const outerTop = [4, 8];
  const outerBottom = [canvasHeight - 8, canvasHeight - 4];
  const corridorY = laneIndex % 2 === 0
    ? outerTop[Math.floor(laneIndex / 2) % outerTop.length]
    : outerBottom[Math.floor(laneIndex / 2) % outerBottom.length];
  return compactRoute([
    start,
    { x: sourceLane, y: start.y },
    { x: sourceLane, y: corridorY },
    { x: targetLane, y: corridorY },
    { x: targetLane, y: end.y },
    end
  ]);
}

function liveRouteColumn(node, centerX, canvasWidth) {
  if (Number.isInteger(node?.layerIndex)) return node.layerIndex;
  return Math.max(0, Math.min(4, Math.round((centerX / canvasWidth * 100 - 10) / 20)));
}

function sameColumnLaneX(start, column, laneIndex, canvasWidth) {
  if (column === 0) return Math.max(8, start.x - (8 + (laneIndex % 7) * 7));
  if (column >= 3) return Math.min(canvasWidth - 8, start.x + 14 + (laneIndex % 7) * 10);
  return start.x + 14 + (laneIndex % 7) * 10;
}

function compactRoute(points) {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

function stageEventTypes(index) {
  const groups = [
    ["run.started", "incident.opened"],
    [],
    ["evidence.queried", "loop.symptoms_collected", "hypothesis.proposed", "loop.initial_hypothesis"],
    ["evaluation.rejected", "loop.hypothesis_rejected", "plan.revised", "loop.replanned"],
    ["tool.called", "loop.causal_evidence_collected", "evaluation.accepted", "loop.root_cause_confirmed"],
    ["repair.proposed", "approval.requested", "loop.approval_requested"],
    ["approval.granted", "repair.executed", "loop.repair_executed", "verification.completed"],
    ["outcome.classified", "regression.created", "policy.evaluated", "loop.learning_complete"]
  ];
  return groups.slice(0, index + 1).flat();
}

function clampStage(value) {
  return Math.max(0, Math.min(TWIN_STAGES.length - 1, Number(value) || 0));
}

function failedResourceServices(payload = {}) {
  const services = new Set();
  for (const resource of payload.resourceSpans || []) {
    if (!hasExplicitFailure(resource)) continue;
    const service = resource.service || attributeValue(resource.resource?.attributes, "service.name");
    if (service) services.add(service);
  }
  return services;
}

function hasExplicitFailure(value) {
  if (!value) return false;
  const text = JSON.stringify(value).toLowerCase();
  return /(?:error|exception|unavailable|refused|"code"\s*:\s*2|status_code_error)/.test(text);
}

function attributeValue(attributes = [], key) {
  const attribute = attributes.find((item) => item.key === key);
  return attribute?.value?.stringValue || attribute?.value?.string_value || null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function spreadCoordinate(index, count) {
  if (count <= 1) return 50;
  const span = Math.min(88, Math.max(36, (count - 1) * 12.4));
  return 50 - span / 2 + (span * index) / (count - 1);
}

function spreadVertical(index, count) {
  if (count <= 1) return 50;
  const span = Math.min(87.5, Math.max(40, (count - 1) * 12.5));
  return 50 - span / 2 + (span * index) / (count - 1);
}

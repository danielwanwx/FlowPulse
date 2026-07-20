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
    label: "Experience",
    description: "customer and synthetic entry",
    ids: ["load-generator", "frontend-web"]
  },
  {
    id: "commerce",
    label: "Edge & commerce",
    description: "requests, cart, and checkout",
    ids: ["frontend-proxy", "frontend", "checkout", "cart"]
  },
  {
    id: "processing",
    label: "Core services",
    description: "transactional and supporting services",
    ids: ["payment", "currency", "shipping", "product-catalog", "recommendation", "ad"]
  },
  {
    id: "platform",
    label: "Async, data & platform",
    description: "eventing, workers, configuration, and telemetry",
    ids: ["email", "kafka", "accounting", "fraud-detection", "fraud", "quote", "image-provider", "flagd-ui", "flagd", "telemetry-docs", "otelcol-contrib", "astronomy-db"]
  },
  {
    id: "control",
    label: "FlowPulse control plane",
    description: "bounded change and investigation components",
    ids: ["deployment", "agent", "evaluator"]
  },
  {
    id: "evidence",
    label: "Evidence plane",
    description: "append-only evidence and decision record",
    ids: ["ledger"]
  }
];

export const LIVE_LAYERS = [
  {
    id: "entry",
    label: "Entry & delivery",
    ids: ["load-generator", "frontend-web", "frontend-proxy", "frontend"]
  },
  {
    id: "commerce",
    label: "Commerce request path",
    ids: ["cart", "currency", "shipping", "checkout", "product-catalog", "recommendation", "ad"]
  },
  {
    id: "processing",
    label: "Payment & asynchronous processing",
    ids: ["payment", "kafka", "accounting", "fraud-detection", "fraud", "email", "quote", "image-provider"]
  },
  {
    id: "platform",
    label: "Platform, telemetry & data",
    ids: ["flagd-ui", "flagd", "telemetry-docs", "otelcol-contrib", "astronomy-db"]
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
    const known = knownLayer.get(node.id);
    const backendRuntimeLayer = ["experience", "commerce", "processing", "platform"].indexOf(node.layer);
    const layerIndex = node.plane === "evidence" ? 5 : node.plane === "control" ? 4 : backendRuntimeLayer >= 0 ? backendRuntimeLayer : known?.index ?? fallbackLayer[node.kind] ?? 3;
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
      y: [18, 34, 50, 66, 80, 92][layerIndex]
    }));
  });
}

export function livePositions(nodes = []) {
  const knownLayer = new Map(LIVE_LAYERS.flatMap((layer, index) => layer.ids.map((id, order) => [id, { index, order }])));
  const buckets = [...LIVE_LAYERS.map(() => []), []];
  const fallbackLayer = { client: 0, api: 1, service: 1, stream: 2, worker: 2, database: 3 };
  for (const node of nodes) {
    const known = knownLayer.get(node.id);
    const layerIndex = node.connectivity === "unlinked" ? LIVE_LAYERS.length : known?.index ?? fallbackLayer[node.kind] ?? 3;
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
  if (!plainRecord(topologyViews) || topologyViews.schema_version !== "flowpulse.topology-views.v1" || !validTopologyTruth(topologyViews.truth)) return null;
  const architecture = topologyViews.architecture;
  if (!plainRecord(architecture) || !sameKeys(architecture, ["graph", "runtime_data", "control_evidence"]) || !plainRecord(architecture.graph) || !plainRecord(architecture.runtime_data) || !plainRecord(architecture.control_evidence)) return null;
  const { graph, runtime_data: runtimeData, control_evidence: controlEvidence } = architecture;
  if (!sameKeys(graph, ["nodes", "edges", "total_nodes", "total_edges", "truncated"]) || !sameKeys(runtimeData, ["node_count", "edge_count"]) || !sameKeys(controlEvidence, ["node_count", "relation_count"])
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.total_nodes !== graph.nodes.length || graph.total_edges !== graph.edges.length || graph.truncated !== false
    || runtimeData.node_count !== 22 || runtimeData.edge_count !== 22
    || controlEvidence.node_count !== 4 || !Number.isInteger(controlEvidence.relation_count) || controlEvidence.relation_count < 0 || controlEvidence.relation_count > 32
    || graph.nodes.length !== runtimeData.node_count + controlEvidence.node_count
    || graph.edges.length !== runtimeData.edge_count + controlEvidence.relation_count) return null;
  if (!graph.nodes.every(validArchitectureNode) || !graph.edges.every(validArchitectureEdge)) return null;

  const topology = topologyIntegrity({ nodes: graph.nodes, edges: graph.edges });
  if (topology.invalid_edges.length || topology.nodes.length !== graph.nodes.length || topology.edges.length !== graph.edges.length) return null;
  if (!graph.nodes.every((node, index) => node.id === topology.nodes[index]?.id)
    || !graph.edges.every((edge, index) => edge.id === topology.edges[index]?.id && edge.from === topology.edges[index]?.from && edge.to === topology.edges[index]?.to)) return null;

  const controlIds = ["deployment", "agent", "evaluator", "ledger"];
  const controls = topology.nodes.filter((node) => ["control", "evidence"].includes(node.plane));
  const runtimeEdges = topology.edges.filter((edge) => ["runtime", "data"].includes(edge.plane));
  const controlEdges = topology.edges.filter((edge) => ["control", "evidence"].includes(edge.plane));
  if (controls.length !== controlEvidence.node_count || runtimeEdges.length !== runtimeData.edge_count || controlEdges.length !== controlEvidence.relation_count
    || controls.map((node) => node.id).sort().join(",") !== [...controlIds].sort().join(",")
    || topology.nodes.some((node) => controlIds.includes(node.id) !== ["control", "evidence"].includes(node.plane))) return null;

  return {
    graph: { ...topology, total_nodes: graph.total_nodes, total_edges: graph.total_edges, truncated: false },
    runtime_data: { ...runtimeData },
    control_evidence: { ...controlEvidence },
    truth: { ...topologyViews.truth }
  };
}

function validArchitectureNode(node) {
  return plainRecord(node) && sameKeys(node, ["id", "kind", "display_class", "plane", "layer", "label", "status", "source_health", "signal_types", "provenance_refs"])
    && typeof node.id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(node.id)
    && typeof node.label === "string" && node.label.length > 0 && node.label.length <= 160
    && ["service", "job", "topic", "deployment", "dataset"].includes(node.kind)
    && ["client", "service", "api", "stream", "worker", "change", "agent", "evaluator", "ledger"].includes(node.display_class)
    && ["runtime", "data", "control", "evidence"].includes(node.plane)
    && typeof node.layer === "string" && node.layer.length > 0 && node.layer.length <= 80
    && ["observed", "idle", "recording", "active", "rejected", "accepted"].includes(node.status)
    && ["live", "stale", "disconnected", "unavailable"].includes(node.source_health)
    && Array.isArray(node.signal_types) && node.signal_types.length <= 3 && node.signal_types.every((value) => ["trace", "metric", "log"].includes(value))
    && Array.isArray(node.provenance_refs) && node.provenance_refs.length > 0 && node.provenance_refs.length <= 4 && node.provenance_refs.every(validProvenanceRef);
}

function validArchitectureEdge(edge) {
  return plainRecord(edge) && sameKeys(edge, ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"])
    && typeof edge.id === "string" && edge.id.length > 0 && edge.id.length <= 160
    && typeof edge.from === "string" && typeof edge.to === "string" && edge.from !== edge.to
    && ["runtime", "data", "control", "evidence"].includes(edge.plane)
    && typeof edge.kind === "string" && edge.kind.length > 0 && edge.kind.length <= 80
    && (edge.label === null || typeof edge.label === "string" && edge.label.length <= 160)
    && ["observed", "idle", "recording", "active", "rejected", "accepted"].includes(edge.status)
    && Array.isArray(edge.provenance_refs) && edge.provenance_refs.length > 0 && edge.provenance_refs.length <= 4 && edge.provenance_refs.every(validProvenanceRef);
}

function validTopologyTruth(truth) {
  return plainRecord(truth) && sameKeys(truth, ["source_health", "evidence_mode", "execution_mode", "label"])
    && ["live", "stale", "disconnected", "unavailable"].includes(truth.source_health)
    && ["live_stream", "frozen_real_snapshot", "captured_fixture"].includes(truth.evidence_mode)
    && ["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"].includes(truth.execution_mode)
    && ["LIVE", "CAPTURED", "UNAVAILABLE"].includes(truth.label);
}

function validProvenanceRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^(capture|code|ledger|evidence):\/\/[A-Za-z0-9._:/#-]+$/.test(value);
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

export function liveSignalDuration(pathLength, speed = 520, terminalFraction = .16) {
  const length = Math.max(0, Number(pathLength) || 0);
  const velocity = Math.max(1, Number(speed) || 1);
  const terminal = Math.max(0, Math.min(.4, Number(terminalFraction) || 0));
  return (length / velocity) * (1 + terminal) * 1000;
}

export function liveSignalProgress(elapsedMs, pathLength, speed = 520, terminalFraction = .16) {
  const length = Math.max(0, Number(pathLength) || 0);
  if (!length) return 1;
  const velocity = Math.max(1, Number(speed) || 1);
  const terminal = Math.max(0, Math.min(.4, Number(terminalFraction) || 0));
  const cruiseDistance = length * (1 - terminal);
  const cruiseMs = (cruiseDistance / velocity) * 1000;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  if (elapsed <= cruiseMs || !terminal) return Math.min(1, elapsed * velocity / 1000 / length);
  const terminalMs = (2 * length * terminal / velocity) * 1000;
  const phase = Math.min(1, (elapsed - cruiseMs) / terminalMs);
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
  const startCenter = { x: from.x * 10, y: from.y * 5.2 };
  const endCenter = { x: to.x * 10, y: to.y * 5.2 };
  const halfWidth = nodeWidth * (1000 / canvasWidth) / 2;
  const halfHeight = nodeHeight * (520 / canvasHeight) / 2;
  const portOffset = Math.max(-halfHeight + 4, Math.min(halfHeight - 4, lane * 2.6));
  const sameColumn = Math.abs(endCenter.x - startCenter.x) < halfWidth * 2;
  const direction = sameColumn ? (lane >= 0 ? 1 : -1) : Math.sign(endCenter.x - startCenter.x) || 1;
  const start = { x: startCenter.x + direction * halfWidth, y: startCenter.y + portOffset };
  const end = { x: endCenter.x + (sameColumn ? direction : -direction) * halfWidth, y: endCenter.y - portOffset };
  const gutterOffset = 12 + Math.min(12, Math.abs(lane) * 1.8);
  const sourceGutter = start.x + direction * gutterOffset;
  const targetGutter = end.x + (sameColumn ? direction : -direction) * gutterOffset;

  if (sameColumn) {
    return [start, { x: sourceGutter, y: start.y }, { x: sourceGutter, y: end.y }, end];
  }

  const laneIndex = Math.abs(Math.trunc(lane)) % 5;
  const corridorY = lane < 0 ? 22 + laneIndex * 4 : 498 - laneIndex * 4;
  return [
    start,
    { x: sourceGutter, y: start.y },
    { x: sourceGutter, y: corridorY },
    { x: targetGutter, y: corridorY },
    { x: targetGutter, y: end.y },
    end
  ];
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

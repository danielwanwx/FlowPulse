import { canonicalSha256 } from "./evidence-envelope.mjs";
import { topologyManifestContentSha256 } from "./topology-manifest.mjs";

export const TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION = "flowpulse.topology-views.v1";

const RUNTIME_NODE_COUNT = 22;
const RUNTIME_EDGE_COUNT = 22;
const OVERLAY_NODE_COUNT = 6;
const OVERLAY_EDGE_COUNT = 5;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL_IDS = new Set(["deployment", "agent", "evaluator", "ledger"]);
const VIEW_READY_STAGES = new Set(["evaluating", "replanning", "blocked", "waiting_for_owner", "approved", "executing", "verified"]);
const AGENT_READY_STAGES = new Set(["evaluating", "replanning", "blocked"]);

export function composeTopologyViews({ manifest, incidentProjection, overlay, controls = {} } = {}) {
  const base = runtimeGraph(manifest);
  const incident = incidentState(incidentProjection);
  const control = controlGraph(controls, incident);
  const readiness = readinessFor(incident, base.available);
  const truth = truthFor(manifest);
  const architectureNodes = sortNodes([...base.nodes, ...control.nodes]);
  const architectureIds = new Set(architectureNodes.map(({ id }) => id));
  const architectureEdges = sortEdges([...base.edges, ...control.edges].filter(({ from, to }) => architectureIds.has(from) && architectureIds.has(to)));
  const incidentOverlay = diagnoseOverlay(overlay, incident, base);
  const revision = canonicalSha256({
    schema_version: TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION,
    manifest_sha256: manifest.content_sha256,
    incident_projection_revision: incident.revision,
    truth,
    readiness,
    architecture: graphIdentity(architectureNodes, architectureEdges),
    live: graphIdentity(base.nodes, base.edges),
    overlay: incidentOverlay,
    control: control.identity
  });
  const result = {
    schema_version: TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION,
    projection_revision: revision,
    run_id: incident.run_id,
    incident_id: incident.incident_id,
    truth,
    readiness,
    architecture: {
      graph: graph(architectureNodes, architectureEdges),
      runtime_data: { node_count: base.nodes.length, edge_count: base.edges.length },
      control_evidence: { node_count: control.nodes.length, relation_count: control.edges.length }
    },
    live: {
      graph: graph(base.nodes.map((node) => ({ ...node, status: "captured" })), base.edges.map((edge) => ({ ...edge, status: "captured" }))),
      runtime_data: { node_count: base.nodes.length, edge_count: base.edges.length }
    },
    diagnose: {
      graph: graph(base.nodes, base.edges),
      overlay: incidentOverlay
    }
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SERIALIZED_BYTES) throw new TopologyProjectionError("topology_view_projection_limit_exceeded");
  return deepFreeze(result);
}

export class TopologyProjectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "TopologyProjectionError";
    this.code = code;
  }
}

function runtimeGraph(manifest) {
  if (!plain(manifest) || manifest.schema_version !== "flowpulse.topology-manifest.v1" || manifest.fixture_id !== "otel-demo-system-v1" || manifest.source_system !== "opentelemetry-demo" || manifest.source_health !== "unavailable" || manifest.evidence_mode !== "captured_fixture" || manifest.execution_mode !== "deterministic_replay" || !HASH.test(manifest.content_sha256) || topologyManifestContentSha256(manifest) !== manifest.content_sha256) fail("topology_view_manifest_invalid");
  if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges) || manifest.nodes.length !== RUNTIME_NODE_COUNT || manifest.edges.length !== RUNTIME_EDGE_COUNT) fail("topology_view_manifest_count_invalid");
  const nodes = manifest.nodes.map((node) => runtimeNode(node));
  const ids = new Set(nodes.map(({ id }) => id));
  if (ids.size !== nodes.length || [...ids].some((id) => CONTROL_IDS.has(id))) fail("topology_view_manifest_node_invalid");
  const edges = manifest.edges.map((edge) => runtimeEdge(edge, ids));
  const semantic = new Set(edges.map(({ from, to, kind }) => `${from}\0${to}\0${kind}`));
  if (new Set(edges.map(({ id }) => id)).size !== edges.length || semantic.size !== edges.length) fail("topology_view_manifest_edge_invalid");
  return { available: true, nodes: sortNodes(nodes), edges: sortEdges(edges) };
}

function runtimeNode(node) {
  const fields = ["id", "kind", "display_class", "plane", "layer", "label", "status", "source_health", "signal_types", "provenance_refs"];
  if (!plain(node) || !sameKeys(node, fields) || !safeId(node.id) || !["service", "job", "topic"].includes(node.kind) || !["client", "service", "api", "stream", "worker"].includes(node.display_class) || !["runtime", "data"].includes(node.plane) || !["experience", "commerce", "processing", "platform"].includes(node.layer) || node.status !== "observed" || node.source_health !== "unavailable" || !safeText(node.label, 160) || !signalTypes(node.signal_types) || !provenance(node.provenance_refs)) fail("topology_view_manifest_node_invalid");
  return { id: node.id, kind: node.kind, display_class: node.display_class, plane: node.plane, layer: node.layer, label: node.label, status: node.status, source_health: node.source_health, signal_types: [...node.signal_types], provenance_refs: [...node.provenance_refs] };
}

function runtimeEdge(edge, ids) {
  const fields = ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"];
  if (!plain(edge) || !sameKeys(edge, fields) || edge.id !== `${edge.from}->${edge.to}` || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || edge.kind !== "calls" || edge.plane !== "runtime" || edge.label !== "Observed dependency" || edge.status !== "observed" || !provenance(edge.provenance_refs)) fail("topology_view_manifest_edge_invalid");
  return { id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, plane: edge.plane, label: edge.label, status: edge.status, provenance_refs: [...edge.provenance_refs] };
}

function incidentState(projection) {
  const valid = plain(projection) && projection.schema_version === "flowpulse.incident-projection.v1" && (projection.projection_revision === null || HASH.test(projection.projection_revision));
  if (!valid) return { available: false, run_id: null, incident_id: null, revision: null, stage_status: "non_actionable", evaluator: "unavailable", action: "not_actionable", verification: "not_actionable" };
  const runId = safeId(projection.run_id) ? projection.run_id : null;
  const incidentId = safeId(projection.incident?.id) ? projection.incident.id : null;
  const stageStatus = ["collecting", "evaluating", "replanning", "blocked", "waiting_for_owner", "approved", "executing", "verified", "legacy_detail_unavailable", "non_actionable"].includes(projection.stage_status) ? projection.stage_status : "non_actionable";
  return {
    available: Boolean(runId && incidentId && stageStatus !== "non_actionable"),
    run_id: runId,
    incident_id: incidentId,
    revision: projection.projection_revision,
    stage_status: stageStatus,
    evaluator: ["pending", "rejected", "accepted"].includes(projection.investigation?.evaluator?.verdict) ? projection.investigation.evaluator.verdict : "unavailable",
    action: ["not_started", "attempted", "executed"].includes(projection.action?.status) ? projection.action.status : "not_actionable",
    verification: projection.verification?.status === "passed" && projection.verification?.passed === true ? "passed" : "not_recorded"
  };
}

function controlGraph(controls, incident) {
  const deploymentObserved = controls?.deployment_evidence_id === "ev-deploy-checkout";
  const agentStatus = ["rejected", "accepted"].includes(incident.evaluator) || AGENT_READY_STAGES.has(incident.stage_status) ? "active" : "idle";
  const evaluatorStatus = incident.evaluator === "rejected" ? "rejected" : incident.evaluator === "accepted" ? "accepted" : "idle";
  const ledgerStatus = Number.isSafeInteger(controls?.ledger_event_count) && controls.ledger_event_count > 0 ? "recording" : "idle";
  const nodes = [
    controlNode("deployment", "deployment", "change", "control", "change", "Deployment", deploymentObserved ? "observed" : "idle", deploymentObserved ? ["evidence://ev-deploy-checkout"] : ["code://flowpulse/deployment"]),
    controlNode("agent", "service", "agent", "control", "investigation", "Investigator", agentStatus, ["code://flowpulse/investigator"]),
    controlNode("evaluator", "service", "evaluator", "control", "evaluation", "Evaluator", evaluatorStatus, ["code://flowpulse/evaluator"]),
    controlNode("ledger", "dataset", "ledger", "evidence", "evidence", "Evidence Ledger", ledgerStatus, ["ledger://append-only"])
  ];
  const edges = [];
  if (deploymentObserved) edges.push(controlEdge("deployment-checkout", "deployment", "checkout", "affects", "control", "Deployment evidence", "observed", ["evidence://ev-deploy-checkout"]));
  if (evaluatorStatus !== "idle") {
    edges.push(controlEdge("agent-evaluator", "agent", "evaluator", "evaluates", "control", "Investigation handoff", evaluatorStatus, ["ledger://investigation"]));
    edges.push(controlEdge("evaluator-ledger", "evaluator", "ledger", "records", "evidence", "Evaluator record", evaluatorStatus, ["ledger://evaluation"]));
  }
  if (agentStatus === "active") edges.push(controlEdge("agent-ledger", "agent", "ledger", "records", "evidence", "Investigation record", "active", ["ledger://investigation"]));
  return { nodes: sortNodes(nodes), edges: sortEdges(edges), identity: { deployment_observed: deploymentObserved, agent_status: agentStatus, evaluator_status: evaluatorStatus, ledger_status: ledgerStatus } };
}

function controlNode(id, kind, display_class, plane, layer, label, status, provenance_refs) {
  return { id, kind, display_class, plane, layer, label, status, source_health: "unavailable", signal_types: [], provenance_refs };
}

function controlEdge(id, from, to, kind, plane, label, status, provenance_refs) {
  return { id, from, to, kind, plane, label, status, provenance_refs };
}

function diagnoseOverlay(overlay, incident, base) {
  if (!incident.available) return { status: "unavailable", node_ids: [], edges: [] };
  if (!plain(overlay) || !sameKeys(overlay, ["schema_version", "base_fixture_id", "incident_id", "node_ids", "edges"]) || overlay.schema_version !== "flowpulse.incident-topology-map.v1" || overlay.base_fixture_id !== "otel-demo-system-v1" || overlay.incident_id !== incident.incident_id || !Array.isArray(overlay.node_ids) || !Array.isArray(overlay.edges) || overlay.node_ids.length !== OVERLAY_NODE_COUNT || overlay.edges.length !== OVERLAY_EDGE_COUNT || new Set(overlay.node_ids).size !== OVERLAY_NODE_COUNT || !overlay.node_ids.every(safeId)) fail("topology_view_overlay_invalid");
  const nodeIds = new Set(overlay.node_ids);
  const baseNodeIds = new Set(base.nodes.map(({ id }) => id));
  const baseEdgeIds = new Set(base.edges.map(({ id }) => id));
  if (![...nodeIds].every((id) => baseNodeIds.has(id))) fail("topology_view_overlay_invalid");
  const edges = overlay.edges.map((edge) => {
    if (!plain(edge) || !sameKeys(edge, ["id", "from", "to", "relation"]) || edge.id !== `${edge.from}->${edge.to}` || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !["observed_dependency", "incident_evidence"].includes(edge.relation)) fail("topology_view_overlay_invalid");
    if (edge.relation === "observed_dependency" && !baseEdgeIds.has(edge.id)) fail("topology_view_overlay_invalid");
    if (edge.relation === "incident_evidence" && baseEdgeIds.has(edge.id)) fail("topology_view_overlay_invalid");
    return { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation };
  });
  if (new Set(edges.map(({ id }) => id)).size !== edges.length || edges.filter(({ relation }) => relation === "observed_dependency").length !== 2 || edges.filter(({ relation }) => relation === "incident_evidence").length !== 3) fail("topology_view_overlay_invalid");
  return { status: "available", node_ids: [...overlay.node_ids].sort(), edges: [...edges].sort((left, right) => left.id.localeCompare(right.id)) };
}

function readinessFor(incident, graphAvailable) {
  const incidentDetected = incident.available;
  const diagnoseAvailable = incidentDetected && VIEW_READY_STAGES.has(incident.stage_status);
  return {
    architecture_available: graphAvailable,
    live_available: graphAvailable,
    incident_detected: incidentDetected,
    diagnose_available: diagnoseAvailable,
    agent_available: incidentDetected && AGENT_READY_STAGES.has(incident.stage_status),
    compare_available: diagnoseAvailable && incident.action === "executed" && incident.verification === "passed"
  };
}

function truthFor(manifest) {
  return {
    source_health: manifest.source_health,
    evidence_mode: manifest.evidence_mode,
    execution_mode: manifest.execution_mode,
    label: manifest.evidence_mode === "captured_fixture" && manifest.execution_mode === "deterministic_replay" ? "CAPTURED" : "UNAVAILABLE"
  };
}

function graph(nodes, edges) {
  return { nodes, edges, total_nodes: nodes.length, total_edges: edges.length, truncated: false };
}

function graphIdentity(nodes, edges) {
  return { nodes: nodes.map((node) => ({ ...node, signal_types: [...node.signal_types], provenance_refs: [...node.provenance_refs] })), edges: edges.map((edge) => ({ ...edge, provenance_refs: [...edge.provenance_refs] })) };
}

function sortNodes(nodes) {
  const planeOrder = { runtime: 0, data: 1, control: 2, evidence: 3 };
  const layerOrder = { experience: 0, commerce: 1, processing: 2, platform: 3, change: 4, investigation: 5, evaluation: 6, evidence: 7 };
  return [...nodes].sort((left, right) => planeOrder[left.plane] - planeOrder[right.plane] || layerOrder[left.layer] - layerOrder[right.layer] || left.id.localeCompare(right.id));
}

function sortEdges(edges) {
  const planeOrder = { runtime: 0, data: 1, control: 2, evidence: 3 };
  return [...edges].sort((left, right) => planeOrder[left.plane] - planeOrder[right.plane] || left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function signalTypes(value) {
  const order = ["trace", "metric", "log"];
  return Array.isArray(value) && value.length > 0 && value.length <= order.length && value.every((item) => order.includes(item)) && new Set(value).size === value.length && value.every((item, index) => index === 0 || order.indexOf(value[index - 1]) < order.indexOf(item));
}

function provenance(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((item) => typeof item === "string" && item.length <= 200 && /^(capture|code|ledger|evidence):\/\/[A-Za-z0-9._:/#-]+$/.test(item));
}

function safeId(value) { return typeof value === "string" && ID.test(value); }
function safeText(value, maximum) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && /^[A-Za-z0-9][A-Za-z0-9 .()/_+-]*$/.test(value); }
function sameKeys(value, expected) { return Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail(code) { throw new TopologyProjectionError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

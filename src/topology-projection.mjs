import { canonicalSha256 } from "./evidence-envelope.mjs";
import { topologyManifestContentSha256 } from "./topology-manifest.mjs";

export const TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION = "flowpulse.topology-views.v2";

const RUNTIME_NODE_COUNT = 22;
const RUNTIME_EDGE_COUNT = 22;
const OVERLAY_NODE_COUNT = 6;
const OVERLAY_EDGE_COUNT = 5;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL_IDS = new Set(["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
const VIEW_READY_STAGES = new Set(["evaluating", "replanning", "blocked", "waiting_for_owner", "approved", "executing", "verified"]);
const AGENT_READY_STAGES = new Set(["evaluating", "replanning", "blocked"]);
const DEMO_SCENARIO_ID = "astronomy-checkout-payment-captured-v1";
const DEMO_PHASES = ["HEALTHY", "INJECTING", "PAYMENT_CHECKOUT_IMPACT", "DOWNSTREAM_PROPAGATION", "INCIDENT_DETECTED"];
const DEMO_FRAME_CONTENT = [
  { node_ids: [], relation_ids: [], evidence_refs: [] },
  { node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-deploy-checkout", "ev-trace-payment-refused"] },
  { node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-metric-checkout-errors"] },
  { node_ids: ["kafka", "accounting", "fraud-detection"], relation_ids: ["checkout->kafka", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-kafka-lag", "ev-log-consumer-delay"] },
  { node_ids: ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"], relation_ids: ["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"] }
];

export function composeTopologyViews({ manifest, incidentProjection, overlay, controls = {}, demoLifecycle = null } = {}) {
  const base = runtimeGraph(manifest);
  const incident = incidentState(incidentProjection);
  const demo = normalizeDemoLifecycle(demoLifecycle, incident, base);
  const control = controlSystem(controls, incident);
  const externalEvidence = externalChangeEvidence(controls, base);
  const readiness = readinessFor(incident, base.available, demo);
  const truth = truthFor(manifest);
  const incidentOverlay = diagnoseOverlay(overlay, incident, base, demo);
  const live = liveGraph(base, incidentOverlay, demo);
  const architecture = scopedTopology(base, control, externalEvidence);
  const liveScope = scopedTopology(live, control, externalEvidence, { incident_overlay: live.incident_overlay });
  const diagnose = {
    runtime_data: runtimeData(base),
    overlay: incidentOverlay
  };
  const revision = canonicalSha256({
    schema_version: TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION,
    manifest_sha256: manifest.content_sha256,
    incident_projection_revision: incident.revision,
    truth,
    readiness,
    architecture: scopeIdentity(architecture),
    live: scopeIdentity(liveScope),
    diagnose,
    demo
  });
  const result = {
    schema_version: TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION,
    projection_revision: revision,
    run_id: incident.run_id,
    incident_id: incident.incident_id,
    truth,
    readiness,
    architecture,
    live: liveScope,
    diagnose,
    demo
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

function controlSystem(controls, incident) {
  const observerStatus = controlStatus(controls?.observer_status, "idle");
  const observerHealth = sourceHealth(controls?.observer_source_health);
  const orchestratorStatus = AGENT_READY_STAGES.has(incident.stage_status) ? "active" : "idle";
  const investigatorStatus = ["rejected", "accepted"].includes(incident.evaluator) || AGENT_READY_STAGES.has(incident.stage_status) ? "active" : "idle";
  const evaluatorStatus = incident.evaluator === "rejected" ? "rejected" : incident.evaluator === "accepted" ? "accepted" : "idle";
  const ledgerStatus = Number.isSafeInteger(controls?.ledger_event_count) && controls.ledger_event_count > 0 ? "recording" : "idle";
  const nodes = [
    controlNode("observer", "service", "observer", "control", "observation", "Observer", observerStatus, observerHealth, ["code://flowpulse/observer"]),
    controlNode("orchestrator", "service", "orchestrator", "control", "orchestration", "Orchestrator", orchestratorStatus, "unavailable", ["ledger://orchestration"]),
    controlNode("investigator", "service", "agent", "control", "investigation", "Investigator", investigatorStatus, "unavailable", ["code://flowpulse/investigator"]),
    controlNode("evaluator", "service", "evaluator", "control", "evaluation", "Evaluator", evaluatorStatus, "unavailable", ["code://flowpulse/evaluator"]),
    controlNode("ledger", "dataset", "ledger", "evidence", "evidence", "Evidence Ledger", ledgerStatus, "unavailable", ["ledger://append-only"])
  ];
  const edges = [];
  if (evaluatorStatus !== "idle") {
    edges.push(controlEdge("investigator-evaluator", "investigator", "evaluator", "evaluates", "control", "Investigation handoff", evaluatorStatus, ["ledger://investigation"]));
    edges.push(controlEdge("evaluator-ledger", "evaluator", "ledger", "records", "evidence", "Evaluator record", evaluatorStatus, ["ledger://evaluation"]));
  }
  if (investigatorStatus === "active") edges.push(controlEdge("investigator-ledger", "investigator", "ledger", "records", "evidence", "Investigation record", "active", ["ledger://investigation"]));
  const sortedNodes = sortNodes(nodes);
  const sortedEdges = sortEdges(edges);
  return {
    nodes: sortedNodes,
    relations: sortedEdges,
    node_count: sortedNodes.length,
    relation_count: sortedEdges.length,
    identity: { observer_status: observerStatus, observer_source_health: observerHealth, orchestrator_status: orchestratorStatus, investigator_status: investigatorStatus, evaluator_status: evaluatorStatus, ledger_status: ledgerStatus }
  };
}

function controlNode(id, kind, display_class, plane, layer, label, status, source_health, provenance_refs) {
  return { id, kind, display_class, plane, layer, label, status, source_health, signal_types: [], provenance_refs };
}

function controlEdge(id, from, to, kind, plane, label, status, provenance_refs) {
  return { id, from, to, kind, plane, label, status, provenance_refs };
}

function externalChangeEvidence(controls, base) {
  const records = controls?.external_change_evidence == null ? [] : controls.external_change_evidence;
  if (!Array.isArray(records) || records.length > 4 || new Set(records.map((record) => record?.id)).size !== records.length) fail("topology_view_external_change_invalid");
  const runtimeIds = new Set(base.nodes.map(({ id }) => id));
  const normalized = records.map((record) => {
    const fields = ["id", "kind", "status", "affected_node_ids", "provenance_refs"];
    if (!plain(record) || !sameKeys(record, fields) || !safeId(record.id) || record.kind !== "deployment_change" || record.status !== "observed" || !Array.isArray(record.affected_node_ids) || record.affected_node_ids.length < 1 || record.affected_node_ids.length > 4 || new Set(record.affected_node_ids).size !== record.affected_node_ids.length || !record.affected_node_ids.every((id) => runtimeIds.has(id)) || !sameOrdered(record.affected_node_ids, [...record.affected_node_ids].sort()) || !provenance(record.provenance_refs)) fail("topology_view_external_change_invalid");
    return { id: record.id, kind: record.kind, status: record.status, affected_node_ids: [...record.affected_node_ids], provenance_refs: [...record.provenance_refs] };
  });
  const sorted = [...normalized].sort((left, right) => left.id.localeCompare(right.id));
  if (!sameOrdered(normalized.map(({ id }) => id), sorted.map(({ id }) => id))) fail("topology_view_external_change_invalid");
  return { records: sorted, relation_count: sorted.reduce((count, record) => count + record.affected_node_ids.length, 0) };
}

function runtimeData(value) {
  return { graph: graph(value.nodes, value.edges), node_count: value.nodes.length, edge_count: value.edges.length };
}

function scopedTopology(runtime, control, external, extra = {}) {
  return {
    runtime_data: runtimeData(runtime),
    control_system: {
      nodes: control.nodes,
      relations: control.relations,
      node_count: control.node_count,
      relation_count: control.relation_count
    },
    external_change_evidence: external,
    ...extra
  };
}

function scopeIdentity(scope) {
  return {
    runtime_data: graphIdentity(scope.runtime_data.graph.nodes, scope.runtime_data.graph.edges),
    control_system: {
      nodes: scope.control_system.nodes.map((node) => ({ ...node, signal_types: [...node.signal_types], provenance_refs: [...node.provenance_refs] })),
      relations: scope.control_system.relations.map((edge) => ({ ...edge, provenance_refs: [...edge.provenance_refs] }))
    },
    external_change_evidence: scope.external_change_evidence.records.map((record) => ({ ...record, affected_node_ids: [...record.affected_node_ids], provenance_refs: [...record.provenance_refs] })),
    incident_overlay: scope.incident_overlay || null
  };
}

function controlStatus(value, fallback) {
  return ["observed", "idle", "recording", "active", "rejected", "accepted"].includes(value) ? value : fallback;
}

function sourceHealth(value) {
  return ["live", "stale", "disconnected", "unavailable"].includes(value) ? value : "unavailable";
}

function diagnoseOverlay(overlay, incident, base, demo) {
  if (!incident.available || demo?.phase === "HEALTHY") return { status: "unavailable", node_ids: [], edges: [] };
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

function readinessFor(incident, graphAvailable, demo) {
  if (demo) return {
    architecture_available: graphAvailable,
    live_available: graphAvailable,
    incident_detected: demo.phase === "INCIDENT_DETECTED",
    diagnose_available: demo.phase === "INCIDENT_DETECTED",
    agent_available: false,
    compare_available: false
  };
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

function normalizeDemoLifecycle(value, incident, base) {
  if (value == null) return null;
  if (!incident.available || !plain(value) || !sameKeys(value, ["schema_version", "run_id", "scenario_id", "phase", "frames"]) || value.schema_version !== "flowpulse.demo-lifecycle.v1" || value.run_id !== incident.run_id || value.scenario_id !== DEMO_SCENARIO_ID || !["HEALTHY", "INCIDENT_DETECTED"].includes(value.phase) || !Array.isArray(value.frames)) fail("topology_view_demo_lifecycle_invalid");
  const expectedFrames = value.phase === "HEALTHY" ? DEMO_PHASES.slice(0, 1) : DEMO_PHASES;
  if (value.frames.length !== expectedFrames.length) fail("topology_view_demo_lifecycle_invalid");
  const nodeIds = new Set(base.nodes.map(({ id }) => id));
  const relationIds = new Set(["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"]);
  const frames = value.frames.map((frame, index) => {
    const expected = DEMO_FRAME_CONTENT[index];
    if (!plain(frame) || !sameKeys(frame, ["id", "order", "phase", "node_ids", "relation_ids", "evidence_refs"]) || frame.id !== expectedFrames[index].toLowerCase() || frame.order !== index || frame.phase !== expectedFrames[index] || !Array.isArray(frame.node_ids) || !Array.isArray(frame.relation_ids) || !Array.isArray(frame.evidence_refs) || frame.node_ids.length > OVERLAY_NODE_COUNT || frame.relation_ids.length > OVERLAY_EDGE_COUNT || frame.evidence_refs.length > 6 || new Set(frame.node_ids).size !== frame.node_ids.length || new Set(frame.relation_ids).size !== frame.relation_ids.length || new Set(frame.evidence_refs).size !== frame.evidence_refs.length || !frame.node_ids.every((id) => nodeIds.has(id)) || !frame.relation_ids.every((id) => relationIds.has(id)) || !frame.evidence_refs.every(safeId) || !sameOrdered(frame.node_ids, expected.node_ids) || !sameOrdered(frame.relation_ids, expected.relation_ids) || !sameOrdered(frame.evidence_refs, expected.evidence_refs)) fail("topology_view_demo_lifecycle_invalid");
    return { id: frame.id, order: frame.order, phase: frame.phase, node_ids: [...frame.node_ids], relation_ids: [...frame.relation_ids], evidence_refs: [...frame.evidence_refs] };
  });
  return { schema_version: value.schema_version, run_id: value.run_id, scenario_id: value.scenario_id, phase: value.phase, frames };
}

function liveGraph(base, overlay, demo) {
  if (!demo) return {
    nodes: base.nodes.map((node) => ({ ...node, status: "captured" })),
    edges: base.edges.map((edge) => ({ ...edge, status: "captured" })),
    incident_overlay: { status: "inactive", node_ids: [], edges: [] }
  };
  const finalFrame = demo.frames.at(-1);
  const incident = demo.phase === "INCIDENT_DETECTED" ? new Set(finalFrame.node_ids) : new Set();
  const observedRelations = new Set(overlay.edges.filter(({ relation }) => relation === "observed_dependency").map(({ id }) => id));
  return {
    nodes: base.nodes.map((node) => ({ ...node, status: incident.has(node.id) ? "incident" : "healthy" })),
    edges: base.edges.map((edge) => ({ ...edge, status: observedRelations.has(edge.id) && demo.phase === "INCIDENT_DETECTED" ? "incident" : "healthy" })),
    incident_overlay: demo.phase === "INCIDENT_DETECTED"
      ? { status: "active", node_ids: [...overlay.node_ids], edges: overlay.edges.map((edge) => ({ ...edge, status: "incident" })) }
      : { status: "inactive", node_ids: [], edges: [] }
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
  const layerOrder = { experience: 0, commerce: 1, processing: 2, platform: 3, observation: 4, orchestration: 5, investigation: 6, evaluation: 7, evidence: 8 };
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
function sameOrdered(actual, expected) { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
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

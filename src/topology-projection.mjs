import { canonicalSha256 } from "./evidence-envelope.mjs";
import { topologyManifestContentSha256 } from "./topology-manifest.mjs";

export const TOPOLOGY_VIEW_PROJECTION_SCHEMA_VERSION = "flowpulse.topology-views.v2";

const RUNTIME_NODE_COUNT = 22;
const RUNTIME_EDGE_COUNT = 26;
const SUPPORTING_RELATION_COUNT = 7;
const OVERLAY_NODE_COUNT = 6;
const OVERLAY_EDGE_COUNT = 5;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL_IDS = new Set(["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
const CONTROL_ACTIVITY_STAGES = new Set(["collecting", "evaluating", "replanning", "blocked", "waiting_for_owner", "approved", "executing", "verified", "legacy_detail_unavailable", "non_actionable"]);
const CONTROL_ACTIVITY_GATES = new Set(["unavailable", "pending", "rejected", "accepted"]);
const CONTROL_SOURCE_MODES = new Set(["captured", "frozen", "live", "stale", "disconnected", "unavailable"]);
const CONTROL_DETAIL_CATALOG = Object.freeze({
  observer: Object.freeze({
    summary: "Collects bounded source evidence and freshness",
    inputs: Object.freeze(["Connector receipts", "Source health", "Telemetry summaries"]),
    outputs: Object.freeze(["Bounded evidence references", "Source truth axes"]),
    authority: "Cannot approve execute or verify repairs",
    provenance_refs: Object.freeze(["code://flowpulse/connector-manifest", "code://flowpulse/evidence-source", "code://flowpulse/live-source"])
  }),
  orchestrator: Object.freeze({
    summary: "Projects ledger-derived workflow state and dispatch context",
    inputs: Object.freeze(["Append-only ledger state", "Canonical incident projection"]),
    outputs: Object.freeze(["Agent control projection", "Readiness projection"]),
    authority: "Cannot approve execute or verify repairs",
    provenance_refs: Object.freeze(["code://flowpulse/agent-control-service", "code://flowpulse/agent-team-harness", "code://flowpulse/runtime"])
  }),
  investigator: Object.freeze({
    summary: "Collects cited evidence and tests bounded hypotheses",
    inputs: Object.freeze(["Bounded evidence references", "Canonical incident context"]),
    outputs: Object.freeze(["Cited hypotheses", "Diagnosis gate inputs"]),
    authority: "Cannot approve or execute remediation",
    provenance_refs: Object.freeze(["code://flowpulse/development-runtime", "code://flowpulse/incident-projection", "code://flowpulse/runtime"])
  }),
  evaluator: Object.freeze({
    summary: "Checks causal evidence and remediation quality gates",
    inputs: Object.freeze(["Cited hypotheses", "Evidence references"]),
    outputs: Object.freeze(["Causal gate result", "Quality verdict"]),
    authority: "Cannot grant owner approval or execute remediation",
    provenance_refs: Object.freeze(["code://flowpulse/agent-team-harness", "code://flowpulse/autonomy-policy", "code://flowpulse/runtime"])
  }),
  ledger: Object.freeze({
    summary: "Records immutable evidence and bounded replay history",
    inputs: Object.freeze(["Bound evidence references", "Typed ledger events"]),
    outputs: Object.freeze(["Ordered provenance records", "Replay-safe event history"]),
    authority: "Records truth but does not execute remediation",
    provenance_refs: Object.freeze(["code://flowpulse/server", "ledger://append-only"])
  })
});
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
  if (!plain(manifest) || manifest.schema_version !== "flowpulse.topology-manifest.v2" || manifest.fixture_id !== "otel-demo-system-v1" || manifest.source_system !== "opentelemetry-demo" || manifest.source_health !== "unavailable" || manifest.evidence_mode !== "captured_fixture" || manifest.execution_mode !== "deterministic_replay" || !HASH.test(manifest.content_sha256) || topologyManifestContentSha256(manifest) !== manifest.content_sha256) fail("topology_view_manifest_invalid");
  if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges) || !Array.isArray(manifest.supporting_relations) || manifest.nodes.length !== RUNTIME_NODE_COUNT || manifest.edges.length !== RUNTIME_EDGE_COUNT || manifest.supporting_relations.length !== SUPPORTING_RELATION_COUNT) fail("topology_view_manifest_count_invalid");
  const nodes = manifest.nodes.map((node) => runtimeNode(node));
  const ids = new Set(nodes.map(({ id }) => id));
  if (ids.size !== nodes.length || [...ids].some((id) => CONTROL_IDS.has(id))) fail("topology_view_manifest_node_invalid");
  const edges = manifest.edges.map((edge) => runtimeEdge(edge, ids));
  const supporting_relations = manifest.supporting_relations.map((relation) => runtimeSupportingRelation(relation, ids));
  const semantic = new Set(edges.map(({ from, to, kind }) => `${from}\0${to}\0${kind}`));
  if (new Set(edges.map(({ id }) => id)).size !== edges.length || semantic.size !== edges.length || new Set(supporting_relations.map(({ id }) => id)).size !== supporting_relations.length || supporting_relations.some(({ id }) => edges.some((edge) => edge.id === id))) fail("topology_view_manifest_edge_invalid");
  return { available: true, nodes: sortNodes(nodes), edges: sortEdges(edges), supporting_relations: [...supporting_relations].sort((left, right) => left.id.localeCompare(right.id)) };
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

function runtimeSupportingRelation(relation, ids) {
  const fields = ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"];
  if (!plain(relation) || !sameKeys(relation, fields) || relation.id !== `${relation.from}->${relation.to}` || !ids.has(relation.from) || !ids.has(relation.to) || relation.from === relation.to || !["declared_async_dependency", "configuration_route", "telemetry_export"].includes(relation.kind) || !["runtime", "data"].includes(relation.plane) || !["Declared async dependency", "Configured route", "Telemetry export"].includes(relation.label) || relation.status !== "observed" || !provenance(relation.provenance_refs)) fail("topology_view_manifest_relation_invalid");
  return { id: relation.id, from: relation.from, to: relation.to, kind: relation.kind, plane: relation.plane, label: relation.label, status: relation.status, provenance_refs: [...relation.provenance_refs] };
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
  const facts = controlFacts(controls);
  const observerStatus = controlStatus(controls?.observer_status, "idle");
  const observerHealth = sourceHealth(controls?.observer_source_health);
  const orchestratorStatus = AGENT_READY_STAGES.has(incident.stage_status) ? "active" : "idle";
  const investigatorStatus = ["rejected", "accepted"].includes(incident.evaluator) || AGENT_READY_STAGES.has(incident.stage_status) ? "active" : "idle";
  const evaluatorStatus = incident.evaluator === "rejected" ? "rejected" : incident.evaluator === "accepted" ? "accepted" : "idle";
  const ledgerStatus = Number.isSafeInteger(controls?.ledger_event_count) && controls.ledger_event_count > 0 ? "recording" : "idle";
  const nodes = [
    controlNode("observer", "service", "observer", "control", "observation", "Observer", observerStatus, observerHealth, ["code://flowpulse/observer"], controlDetail("observer", facts, incident, observerHealth)),
    controlNode("orchestrator", "service", "orchestrator", "control", "orchestration", "Orchestrator", orchestratorStatus, "unavailable", ["ledger://orchestration"], controlDetail("orchestrator", facts, incident)),
    controlNode("investigator", "service", "agent", "control", "investigation", "Investigator", investigatorStatus, "unavailable", ["code://flowpulse/investigator"], controlDetail("investigator", facts, incident)),
    controlNode("evaluator", "service", "evaluator", "control", "evaluation", "Evaluator", evaluatorStatus, "unavailable", ["code://flowpulse/evaluator"], controlDetail("evaluator", facts, incident)),
    controlNode("ledger", "dataset", "ledger", "evidence", "evidence", "Evidence Ledger", ledgerStatus, "unavailable", ["ledger://append-only"], controlDetail("ledger", facts, incident))
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

function controlNode(id, kind, display_class, plane, layer, label, status, source_health, provenance_refs, detail) {
  return { id, kind, display_class, plane, layer, label, status, source_health, signal_types: [], provenance_refs, detail };
}

function controlFacts(controls) {
  const observerMode = controls?.observer_mode == null ? "unavailable" : controls.observer_mode;
  const latest = controls?.ledger_latest_event == null ? null : controls.ledger_latest_event;
  if (!CONTROL_SOURCE_MODES.has(observerMode)) fail("topology_view_control_detail_invalid");
  if (latest === null) return { observer_mode: observerMode, ledger_latest_event: null };
  const fields = ["sequence", "recorded_at", "evidence_refs"];
  if (!plain(latest) || !sameKeys(latest, fields) || !Number.isSafeInteger(latest.sequence) || latest.sequence < 1 || latest.sequence > 1_000_000_000 || !safeTimestamp(latest.recorded_at) || !Array.isArray(latest.evidence_refs) || latest.evidence_refs.length > 4 || new Set(latest.evidence_refs).size !== latest.evidence_refs.length || !latest.evidence_refs.every(safeId) || !sameOrdered(latest.evidence_refs, [...latest.evidence_refs].sort())) fail("topology_view_control_detail_invalid");
  return { observer_mode: observerMode, ledger_latest_event: { sequence: latest.sequence, recorded_at: latest.recorded_at, evidence_refs: [...latest.evidence_refs] } };
}

function controlDetail(id, facts, incident, observerHealth = "unavailable") {
  const catalog = CONTROL_DETAIL_CATALOG[id];
  if (!catalog) fail("topology_view_control_detail_invalid");
  const latest = facts.ledger_latest_event;
  const stage = incident.available && CONTROL_ACTIVITY_STAGES.has(incident.stage_status) && incident.stage_status !== "non_actionable" ? incident.stage_status : null;
  const gate = CONTROL_ACTIVITY_GATES.has(incident.evaluator) ? incident.evaluator : "unavailable";
  const activity = { summary: null, stage: null, last_sequence: null, last_recorded_at: null, evidence_refs: [], gate: "unavailable", source_health: "unavailable" };
  if (id === "observer") {
    activity.summary = ({ captured: "Captured source intake", frozen: "Frozen source intake", live: "Live source intake", stale: "Source freshness stale", disconnected: "Source disconnected" })[facts.observer_mode] || null;
    activity.source_health = observerHealth;
  }
  if (id === "orchestrator" && stage) {
    activity.summary = `Workflow ${stage}`;
    activity.stage = stage;
    activity.last_sequence = latest?.sequence ?? null;
    activity.last_recorded_at = latest?.recorded_at ?? null;
  }
  if (id === "investigator") {
    activity.evidence_refs = latest?.evidence_refs || [];
    activity.summary = activity.evidence_refs.length ? `${activity.evidence_refs.length} cited evidence` : null;
    activity.stage = stage;
  }
  if (id === "evaluator") {
    activity.gate = gate;
    activity.evidence_refs = latest?.evidence_refs || [];
    activity.summary = gate === "unavailable" ? null : `Gate ${gate}`;
  }
  if (id === "ledger" && latest) {
    activity.summary = `Recorded event ${latest.sequence}`;
    activity.last_sequence = latest.sequence;
    activity.last_recorded_at = latest.recorded_at;
    activity.evidence_refs = [...latest.evidence_refs];
  }
  if (!safeControlDetail({ ...catalog, activity })) fail("topology_view_control_detail_invalid");
  return {
    summary: catalog.summary,
    inputs: [...catalog.inputs],
    outputs: [...catalog.outputs],
    authority: catalog.authority,
    provenance_refs: [...catalog.provenance_refs],
    activity
  };
}

function safeControlDetail(value) {
  const fields = ["summary", "inputs", "outputs", "authority", "provenance_refs", "activity"];
  const activityFields = ["summary", "stage", "last_sequence", "last_recorded_at", "evidence_refs", "gate", "source_health"];
  return plain(value) && sameKeys(value, fields) && safeText(value.summary, 160) && safeText(value.authority, 160)
    && safeTextList(value.inputs, 4, 120) && safeTextList(value.outputs, 4, 120) && provenance(value.provenance_refs)
    && plain(value.activity) && sameKeys(value.activity, activityFields)
    && (value.activity.summary === null || safeText(value.activity.summary, 120))
    && (value.activity.stage === null || CONTROL_ACTIVITY_STAGES.has(value.activity.stage))
    && (value.activity.last_sequence === null || Number.isSafeInteger(value.activity.last_sequence) && value.activity.last_sequence > 0 && value.activity.last_sequence <= 1_000_000_000)
    && (value.activity.last_recorded_at === null || safeTimestamp(value.activity.last_recorded_at))
    && Array.isArray(value.activity.evidence_refs) && value.activity.evidence_refs.length <= 4 && new Set(value.activity.evidence_refs).size === value.activity.evidence_refs.length && value.activity.evidence_refs.every(safeId) && sameOrdered(value.activity.evidence_refs, [...value.activity.evidence_refs].sort())
    && CONTROL_ACTIVITY_GATES.has(value.activity.gate) && sourceHealth(value.activity.source_health) === value.activity.source_health;
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
  return {
    graph: graph(value.nodes, value.edges),
    node_count: value.nodes.length,
    edge_count: value.edges.length,
    supporting_relations: value.supporting_relations.map((relation) => ({ ...relation, provenance_refs: [...relation.provenance_refs] })),
    supporting_relation_count: value.supporting_relations.length
  };
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
    runtime_data: {
      ...graphIdentity(scope.runtime_data.graph.nodes, scope.runtime_data.graph.edges),
      supporting_relations: scope.runtime_data.supporting_relations.map((relation) => ({ ...relation, provenance_refs: [...relation.provenance_refs] }))
    },
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
  const supportingRelationIds = new Set(base.supporting_relations.map(({ id }) => id));
  if (![...nodeIds].every((id) => baseNodeIds.has(id))) fail("topology_view_overlay_invalid");
  const edges = overlay.edges.map((edge) => {
    if (!plain(edge) || !sameKeys(edge, ["id", "from", "to", "relation"]) || edge.id !== `${edge.from}->${edge.to}` || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !["observed_dependency", "evidence_grounded_relation", "incident_evidence"].includes(edge.relation)) fail("topology_view_overlay_invalid");
    if (edge.relation === "observed_dependency" && !baseEdgeIds.has(edge.id)) fail("topology_view_overlay_invalid");
    if (edge.relation === "evidence_grounded_relation" && !supportingRelationIds.has(edge.id)) fail("topology_view_overlay_invalid");
    if (edge.relation === "incident_evidence" && (baseEdgeIds.has(edge.id) || supportingRelationIds.has(edge.id))) fail("topology_view_overlay_invalid");
    return { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation };
  });
  if (new Set(edges.map(({ id }) => id)).size !== edges.length || edges.filter(({ relation }) => relation === "observed_dependency").length !== 2 || edges.filter(({ relation }) => relation === "evidence_grounded_relation").length !== 3 || edges.some(({ relation }) => relation === "incident_evidence")) fail("topology_view_overlay_invalid");
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
  const active = demo ? demo.phase === "INCIDENT_DETECTED" : overlay.status === "available";
  const incident = active ? new Set((demo ? demo.frames.at(-1).node_ids : overlay.node_ids)) : new Set();
  const directRelations = new Set(overlay.edges.filter(({ relation }) => relation === "observed_dependency").map(({ id }) => id));
  const supportingRelations = new Set(overlay.edges.filter(({ relation }) => relation === "evidence_grounded_relation").map(({ id }) => id));
  return {
    nodes: base.nodes.map((node) => ({ ...node, status: incident.has(node.id) ? "incident" : demo ? "healthy" : "captured" })),
    edges: base.edges.map((edge) => ({ ...edge, status: directRelations.has(edge.id) && active ? "incident" : demo ? "healthy" : "captured" })),
    supporting_relations: base.supporting_relations.map((relation) => ({ ...relation, status: supportingRelations.has(relation.id) && active ? "incident" : demo ? "healthy" : "captured" })),
    incident_overlay: active
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
function safeTextList(value, maximumCount, maximumBytes) { return Array.isArray(value) && value.length > 0 && value.length <= maximumCount && new Set(value).size === value.length && value.every((item) => safeText(item, maximumBytes)) && sameOrdered(value, [...value].sort()); }
function safeTimestamp(value) { return typeof value === "string" && value.length >= 20 && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
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

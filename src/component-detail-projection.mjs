import { canonicalSha256 } from "./evidence-envelope.mjs";

export const COMPONENT_DETAIL_SCHEMA_VERSION = "flowpulse.component-detail.v1";

const MAX_SERIALIZED_BYTES = 24 * 1024;
const MAX_EVIDENCE = 8;
const MAX_RELATIONS = 8;
const MAX_GRAPH_NODES = 256;
const MAX_GRAPH_EDGES = 512;
const MAX_DATA_RESOURCES = 8;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SIGNAL_TYPES = ["trace", "metric", "log"];
const SOURCE_STATUSES = new Set(["captured", "frozen", "live", "stale", "disconnected", "unavailable"]);
const NODE_KINDS = new Set(["service", "job", "topic", "database", "table", "dataset", "query", "dag", "worker"]);
const RESOURCE_KINDS = new Set(["topic", "consumer_group", "database", "table", "job", "dag"]);
const COMPONENT_CATALOG = Object.freeze({
  accounting: ["Financial posting", "Posts financial records for completed order flows."],
  ad: ["Promotion selection", "Selects promotional content for storefront requests."],
  cart: ["Shopping basket", "Maintains the active shopping basket for a customer session."],
  checkout: ["Order orchestration", "Coordinates order placement across payment and downstream services."],
  currency: ["Price conversion", "Converts or formats prices for storefront and checkout requests."],
  email: ["Customer confirmation", "Sends customer communications after order events."],
  flagd: ["Runtime configuration", "Serves runtime feature configuration to observed services."],
  "flagd-ui": ["Feature flag interface", "Exposes the observed feature-flag administration surface."],
  "fraud-detection": ["Risk screening", "Screens order and payment activity for risk signals."],
  frontend: ["Storefront application", "Composes the storefront interface for customer requests."],
  "frontend-proxy": ["Edge request routing", "Routes browser requests toward the storefront application."],
  "frontend-web": ["Customer web experience", "Serves the browser entry point and static web assets."],
  "image-provider": ["Product media", "Supplies product media to the storefront."],
  kafka: ["Order event backbone", "Carries order and payment events between downstream services."],
  "load-generator": ["Traffic simulation", "Generates deterministic demo traffic for the captured system."],
  "otelcol-contrib": ["Observability pipeline", "Collects and forwards observed telemetry signals."],
  payment: ["Payment authorization", "Authorizes payment requests during checkout."],
  "product-catalog": ["Catalog discovery", "Provides product and catalogue information to storefront flows."],
  quote: ["Shipping quotes", "Calculates shipping quotes for an order."],
  recommendation: ["Personalization", "Ranks product recommendations for the storefront."],
  shipping: ["Fulfillment quoting", "Coordinates shipping options and fulfillment routing."],
  "telemetry-docs": ["Telemetry diagnostics", "Provides captured telemetry diagnostic documentation."]
});

export class ComponentDetailProjectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ComponentDetailProjectionError";
    this.code = code;
  }
}

export function composeComponentDetail({ topologyViews, nodeId, source, evidence = [] } = {}) {
  const runtime = canonicalRuntime(topologyViews);
  if (!ID.test(nodeId || "")) fail("component_detail_node_unavailable");
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) fail("component_detail_evidence_limit_exceeded");
  const node = runtime.nodes.find((item) => item.id === nodeId);
  if (!node) fail("component_detail_node_unavailable");
  const sourceTruth = sourceSummary(source);
  const relationships = relationshipsFor(node, runtime);
  const observability = observabilityFor(evidence, node.id);
  const catalog = COMPONENT_CATALOG[node.id] || catalogFallback(node);
  const detail = {
    schema_version: COMPONENT_DETAIL_SCHEMA_VERSION,
    topology_projection_revision: topologyViews.projection_revision,
    detail_revision: null,
    component: cloneRuntimeNode(node),
    purpose: { business_role: catalog[0], description: catalog[1] },
    runtime: sourceTruth,
    relationships,
    observability,
    configuration: { changes: observability.changes },
    data_resources: dataResourcesFor(evidence, node.id),
    raw_payload_excluded: true
  };
  detail.detail_revision = canonicalSha256({ ...detail, detail_revision: null });
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_SERIALIZED_BYTES) fail("component_detail_response_limit_exceeded");
  return deepFreeze(detail);
}

function canonicalRuntime(views) {
  const graph = views?.schema_version === "flowpulse.topology-views.v2" && HASH.test(views?.projection_revision || "")
    ? views.architecture?.runtime_data?.graph
    : null;
  if (!graph || !Number.isSafeInteger(graph.total_nodes) || !Number.isSafeInteger(graph.total_edges)
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.total_nodes < 1 || graph.total_nodes > MAX_GRAPH_NODES || graph.total_edges < 0 || graph.total_edges > MAX_GRAPH_EDGES
    || graph.nodes.length !== graph.total_nodes || graph.edges.length !== graph.total_edges || !graph.nodes.every(validRuntimeNode)) fail("component_detail_topology_invalid");
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || !graph.edges.every((edge) => validRuntimeEdge(edge, ids))) fail("component_detail_topology_invalid");
  return { nodes: graph.nodes, edges: graph.edges };
}

function validRuntimeNode(node) {
  return plain(node)
    && sameKeys(node, ["id", "kind", "display_class", "plane", "layer", "label", "status", "source_health", "signal_types", "provenance_refs"])
    && ID.test(node.id) && NODE_KINDS.has(node.kind)
    && safeToken(node.display_class, 40)
    && ["runtime", "data"].includes(node.plane) && safeToken(node.layer, 80)
    && ["observed", "captured", "healthy", "incident"].includes(node.status)
    && SOURCE_STATUSES.has(node.source_health) && safeText(node.label, 160)
    && orderedSignals(node.signal_types) && provenance(node.provenance_refs);
}

function validRuntimeEdge(edge, ids) {
  return plain(edge)
    && sameKeys(edge, ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"])
    && edge.id === `${edge.from}->${edge.to}` && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to
    && safeToken(edge.kind, 80) && ["runtime", "data"].includes(edge.plane) && safeText(edge.label, 160)
    && ["observed", "captured", "healthy", "incident"].includes(edge.status) && provenance(edge.provenance_refs);
}

function sourceSummary(source) {
  const mode = safeText(source?.mode, 80) ? source.mode : "unavailable";
  const status = SOURCE_STATUSES.has(source?.status) ? source.status : "unavailable";
  const label = safeText(source?.label, 160) ? source.label : "UNAVAILABLE";
  const freshness_ms = Number.isSafeInteger(source?.freshness_ms) && source.freshness_ms >= 0 && source.freshness_ms <= 31_536_000_000 ? source.freshness_ms : null;
  const observed_at = safeTimestamp(source?.last_observed_at) ? source.last_observed_at : null;
  return { mode, status, label, freshness_ms, observed_at };
}

function relationshipsFor(node, runtime) {
  const byId = new Map(runtime.nodes.map((item) => [item.id, item]));
  const map = (direction) => runtime.edges
    .filter((edge) => direction === "upstream" ? edge.to === node.id : edge.from === node.id)
    .map((edge) => ({ edge, node: byId.get(direction === "upstream" ? edge.from : edge.to) }))
    .filter(({ node: related }) => Boolean(related))
    .sort((left, right) => left.node.id.localeCompare(right.node.id))
    .slice(0, MAX_RELATIONS)
    .map(({ edge, node: related }) => ({ id: related.id, label: related.label, kind: related.kind, relation: edge.kind, provenance_refs: [...edge.provenance_refs] }));
  return { upstream: map("upstream"), downstream: map("downstream") };
}

function observabilityFor(records, entity) {
  const metrics = [];
  const traces = [];
  const logs = [];
  const changes = [];
  for (const record of records) {
    if (!plain(record) || record.entity !== entity || !ID.test(record.id || "")) continue;
    const base = evidenceBase(record);
    if (!base) continue;
    if (record.kind === "metric") {
      const metric = safeMetric(record.value?.metric);
      if (metric) metrics.push({ ...base, ...metric });
    }
    if (record.kind === "trace") {
      const trace = safeTrace(record.value?.trace);
      if (trace) traces.push({ ...base, ...trace });
    }
    if (record.kind === "log") {
      const summary = safeLogSummary(record.value?.log || { message: record.fact });
      if (summary) logs.push({ ...base, ...summary });
    }
    if (["deploy", "change"].includes(record.kind)) {
      const change = safeChange(record.value?.change);
      if (change) changes.push({ ...base, ...change });
    }
  }
  const ordered = (items) => items.sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.evidence_id.localeCompare(right.evidence_id)).slice(0, 4);
  return { metrics: ordered(metrics), traces: ordered(traces), logs: ordered(logs), changes: ordered(changes) };
}

function dataResourcesFor(records, entity) {
  const seen = new Set();
  const resources = [];
  for (const record of records) {
    if (!plain(record) || record.entity !== entity || !ID.test(record.id || "")) continue;
    const base = evidenceBase(record);
    const value = plain(record.value?.resource) ? record.value.resource : plain(record.value?.data_resource) ? record.value.data_resource : null;
    const resource = safeDataResource(value);
    if (!base || !resource) continue;
    const key = `${resource.kind}:${resource.id || resource.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push({ ...base, ...resource });
    if (resources.length >= MAX_DATA_RESOURCES) break;
  }
  return resources.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function evidenceBase(record) {
  const observed_at = safeTimestamp(record.at) ? record.at : null;
  if (!observed_at || !safeText(record.title, 180) || !safeText(record.source, 160)) return null;
  // Captured replay records predate the envelope hash. Bind their browser-safe
  // summary here instead of exposing an unhashed record or its raw fact/body.
  const record_sha256 = HASH.test(record.hash || "") ? record.hash
    : HASH.test(record.provenance?.sha256 || "") ? record.provenance.sha256
      : canonicalSha256({
        id: record.id,
        kind: record.kind,
        signal: record.signal || null,
        title: record.title,
        entity: record.entity,
        source: record.source,
        at: record.at,
        captured_at: record.captured_at || null,
        value: record.value || null
      });
  return { evidence_id: record.id, title: record.title, source: record.source, observed_at, record_sha256 };
}

function safeMetric(value) {
  if (!plain(value)) return null;
  const metric = {
    name: safeText(value.name, 120) ? value.name : null,
    value: safeNumber(value.value),
    before: safeNumber(value.before),
    after: safeNumber(value.after),
    unit: safeText(value.unit, 40) ? value.unit : null,
    aggregation: safeText(value.aggregation, 40) ? value.aggregation : null,
    threshold: safeText(value.threshold, 80) ? value.threshold : null
  };
  if (!metric.name && metric.value === null && metric.before === null && metric.after === null) return null;
  return metric;
}

function safeTrace(value) {
  if (!plain(value)) return null;
  const trace = {
    operation: safeText(value.operation, 160) ? value.operation : null,
    peer_target: safeText(value.peer_target, 160) ? value.peer_target : null,
    status: safeText(value.status, 40) ? value.status : null,
    error: safeText(value.error, 160) ? value.error : null,
    trace_ref: safeRef(value.trace_ref),
    span_ref: safeRef(value.span_ref)
  };
  return Object.values(trace).some((item) => item !== null) ? trace : null;
}

function safeChange(value) {
  if (!plain(value)) return null;
  const change = {
    target: ID.test(value.target || "") ? value.target : null,
    flag: safeText(value.flag, 120) ? value.flag : null,
    before: safeText(value.before, 120) ? value.before : null,
    after: safeText(value.after, 120) ? value.after : null,
    applied_at: safeTimestamp(value.applied_at) ? value.applied_at : null
  };
  return Object.values(change).some((item) => item !== null) ? change : null;
}

function safeLogSummary(value) {
  if (!plain(value)) return null;
  const summary = redactSummary(value.summary ?? value.message ?? value.body, 280);
  const severity = safeToken(String(value.severity || "").toLowerCase(), 32) ? String(value.severity).toUpperCase() : null;
  const trace_ref = safeRef(value.trace_ref);
  const span_ref = safeRef(value.span_ref);
  return summary ? { severity, summary, trace_ref, span_ref } : null;
}

function safeDataResource(value) {
  if (!plain(value) || !RESOURCE_KINDS.has(value.kind)) return null;
  const id = ID.test(value.id || "") ? value.id : null;
  const name = safeText(value.name, 160) ? value.name : null;
  const consumer_group = safeText(value.consumer_group, 160) ? value.consumer_group : null;
  if (!id && !name) return null;
  return { kind: value.kind, id, name, consumer_group };
}

function catalogFallback(node) {
  const kind = safeToken(node.kind, 40) ? node.kind : "component";
  const label = safeText(node.label, 160) ? node.label : node.id;
  return [`Observed ${kind}`, `${label} is a canonical observed ${kind}.`];
}

function cloneRuntimeNode(node) {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    display_class: node.display_class,
    plane: node.plane,
    layer: node.layer,
    status: node.status,
    source_health: node.source_health,
    signal_types: [...node.signal_types],
    provenance_refs: [...node.provenance_refs]
  };
}

function orderedSignals(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= SIGNAL_TYPES.length && new Set(value).size === value.length
    && value.every((item, index) => SIGNAL_TYPES.includes(item) && (index === 0 || SIGNAL_TYPES.indexOf(value[index - 1]) < SIGNAL_TYPES.indexOf(item)));
}

function provenance(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((item) => typeof item === "string" && item.length <= 200 && /^(capture|code|ledger|evidence):\/\/[A-Za-z0-9._:/#-]+$/.test(item));
}

function safeText(value, maximum) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && /^[A-Za-z0-9][A-Za-z0-9 .()/_:+,=-]*$/.test(value);
}

function safeToken(value, maximum) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && /^[a-z][a-z0-9_-]*$/.test(value);
}

function redactSummary(value, maximum) {
  if (typeof value !== "string" || !value.trim()) return null;
  const redacted = value
    .replace(/[\u0000-\u001f\u007f<>&]/g, " ")
    .replace(/\b(?:sk|rk)_[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, "redacted")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential redacted")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, "configuration")
    .replace(/\b(?:system|developer|user)\s+prompt\b/gi, "prompt redacted")
    .replace(/[^A-Za-z0-9 .()/_:+,=-]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
  return safeText(redacted, maximum) ? redacted : null;
}

function safeTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function safeNumber(value) { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : null; }
function safeRef(value) { return typeof value === "string" && /^[a-f0-9]{8,64}$/i.test(value) ? value : null; }
function sameKeys(value, expected) { return Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail(code) { throw new ComponentDetailProjectionError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

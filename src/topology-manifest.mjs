import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalSha256, parseDuplicateFreeJson } from "./evidence-envelope.mjs";

export const TOPOLOGY_MANIFEST_SCHEMA_VERSION = "flowpulse.topology-manifest.v2";
export const TOPOLOGY_MANIFEST_LIMITS = Object.freeze({
  max_bytes: 48 * 1024,
  nodes: 22,
  edges: 26,
  supporting_relations: 7,
  max_label_bytes: 160,
  max_provenance_refs: 4
});

const defaultManifestPath = fileURLToPath(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .()/_+-]{0,159}$/;
const UNSAFE_LABEL = /(?:<|>|javascript:|bearer\b|api[ _-]?key|password|secret|token|credential|prompt|session|customer|trace[ _-]?id|span[ _-]?id|raw[ _-]?(?:log|metric|trace|payload)|sql\b)/i;
const NODE_KINDS = new Set(["service", "job", "topic"]);
const DISPLAY_CLASSES = new Set(["client", "service", "api", "stream", "worker"]);
const PLANES = new Set(["runtime", "data"]);
const LAYERS = new Set(["experience", "commerce", "processing", "platform"]);
const SIGNAL_TYPES = ["trace", "metric", "log"];
const EXPECTED_EXCLUSIONS = Object.freeze([
  "credentials",
  "customer_identifiers",
  "environment_values",
  "filesystem_paths",
  "log_bodies",
  "metric_payloads",
  "prompts",
  "provider_payloads",
  "raw_telemetry",
  "session_identifiers",
  "source_bodies",
  "span_identifiers",
  "trace_identifiers"
]);
const EXPECTED_NODE_IDS = Object.freeze([
  "accounting", "ad", "cart", "checkout", "currency", "email", "flagd", "flagd-ui",
  "fraud-detection", "frontend", "frontend-proxy", "frontend-web", "image-provider", "kafka",
  "load-generator", "otelcol-contrib", "payment", "product-catalog", "quote", "recommendation",
  "shipping", "telemetry-docs"
]);
const EXPECTED_EDGE_IDS = Object.freeze([
  "ad->flagd",
  "cart->flagd",
  "checkout->cart", "checkout->currency", "checkout->email", "checkout->payment",
  "checkout->product-catalog", "checkout->shipping",
  "fraud-detection->flagd",
  "frontend->ad", "frontend->cart", "frontend->checkout", "frontend->currency",
  "frontend->product-catalog", "frontend->recommendation", "frontend->shipping",
  "frontend-proxy->flagd", "frontend-proxy->frontend", "frontend-proxy->image-provider",
  "frontend-web->frontend-proxy", "load-generator->flagd", "load-generator->frontend-proxy",
  "payment->flagd", "recommendation->flagd", "recommendation->product-catalog", "shipping->quote"
]);
const EXPECTED_SUPPORTING_RELATIONS = Object.freeze([
  { id: "checkout->kafka", from: "checkout", to: "kafka", kind: "declared_async_dependency", plane: "data", label: "Declared async dependency", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-checkout-to-kafka", "code://otel-demo/checkout-kafka"] },
  { id: "flagd-ui->otelcol-contrib", from: "flagd-ui", to: "otelcol-contrib", kind: "telemetry_export", plane: "runtime", label: "Telemetry export", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-flagd-ui-to-otelcol-contrib", "code://otel-demo/flagd-ui-telemetry-export"] },
  { id: "frontend-proxy->flagd-ui", from: "frontend-proxy", to: "flagd-ui", kind: "configuration_route", plane: "runtime", label: "Configured route", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-frontend-proxy-to-flagd-ui", "code://otel-demo/frontend-proxy-flagd-ui"] },
  { id: "frontend-proxy->telemetry-docs", from: "frontend-proxy", to: "telemetry-docs", kind: "configuration_route", plane: "runtime", label: "Configured route", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-frontend-proxy-to-telemetry-docs", "code://otel-demo/frontend-proxy-telemetry-docs"] },
  { id: "kafka->accounting", from: "kafka", to: "accounting", kind: "declared_async_dependency", plane: "data", label: "Declared async dependency", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-kafka-to-accounting", "code://otel-demo/kafka-accounting"] },
  { id: "kafka->fraud-detection", from: "kafka", to: "fraud-detection", kind: "declared_async_dependency", plane: "data", label: "Declared async dependency", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-kafka-to-fraud-detection", "code://otel-demo/kafka-fraud-detection"] },
  { id: "telemetry-docs->otelcol-contrib", from: "telemetry-docs", to: "otelcol-contrib", kind: "telemetry_export", plane: "runtime", label: "Telemetry export", status: "observed", provenance_refs: ["capture://otel-demo-system-v1#relation-telemetry-docs-to-otelcol-contrib", "code://otel-demo/telemetry-docs-telemetry-export"] }
]);
const INCIDENT_NODE_IDS = Object.freeze(["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"]);
const INCIDENT_EDGE_IDS = Object.freeze([
  "checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"
]);

export class TopologyManifestError extends Error {
  constructor(code) {
    super(code);
    this.name = "TopologyManifestError";
    this.code = code;
  }
}

export function topologyManifestContent(value) {
  if (!plain(value)) return null;
  const { content_sha256: _contentSha256, ...content } = value;
  return content;
}

export function topologyManifestContentSha256(value) {
  const content = topologyManifestContent(value);
  return content ? canonicalSha256(content) : null;
}

export function parseTopologyManifest(raw) {
  if (typeof raw !== "string") fail("topology_manifest_json_invalid");
  let value;
  try {
    value = parseDuplicateFreeJson(raw, TOPOLOGY_MANIFEST_LIMITS.max_bytes);
  } catch (error) {
    const code = ({
      evidence_envelope_json_limit_exceeded: "topology_manifest_json_limit_exceeded",
      evidence_envelope_json_duplicate_key: "topology_manifest_json_duplicate_key",
      evidence_envelope_json_unsafe_key: "topology_manifest_json_unsafe_key",
      evidence_envelope_json_depth_exceeded: "topology_manifest_json_depth_exceeded"
    })[error?.code] || "topology_manifest_json_invalid";
    fail(code);
  }
  return validateTopologyManifest(value);
}

export function loadTopologyManifest(path = defaultManifestPath) {
  return parseTopologyManifest(readFileSync(path, "utf8"));
}

export function validateAstronomyIncidentSubgraph(manifest, bundle) {
  const base = validateTopologyManifest(manifest);
  const services = bundle?.topology?.services;
  const edges = bundle?.topology?.edges;
  if (bundle?.incident?.id !== "inc-astro-checkout-001" || !Array.isArray(services) || !Array.isArray(edges)) fail("topology_incident_mapping_invalid");

  const nodeIds = services.map(({ id }) => id === "fraud" ? "fraud-detection" : id).sort(byText);
  const edgeIds = edges.map((edge) => Array.isArray(edge) && edge.length === 2
    ? `${edge[0] === "fraud" ? "fraud-detection" : edge[0]}->${edge[1] === "fraud" ? "fraud-detection" : edge[1]}`
    : null).sort(byText);
  if (!sameArray(nodeIds, INCIDENT_NODE_IDS) || !sameArray(edgeIds, INCIDENT_EDGE_IDS)) fail("topology_incident_mapping_invalid");

  const baseNodeIds = new Set(base.nodes.map(({ id }) => id));
  const baseEdgeIds = new Set(base.edges.map(({ id }) => id));
  const supportingRelationIds = new Set(base.supporting_relations.map(({ id }) => id));
  if (!nodeIds.every((id) => baseNodeIds.has(id))) fail("topology_incident_mapping_invalid");

  return deepFreeze({
    schema_version: "flowpulse.incident-topology-map.v1",
    base_fixture_id: base.fixture_id,
    incident_id: bundle.incident.id,
    node_ids: nodeIds,
    edges: edgeIds.map((id) => {
      const [from, to] = id.split("->");
      return {
        id,
        from,
        to,
        relation: baseEdgeIds.has(id)
          ? "observed_dependency"
          : supportingRelationIds.has(id)
            ? "evidence_grounded_relation"
            : "incident_evidence"
      };
    })
  });
}

function validateTopologyManifest(value) {
  const rootFields = ["schema_version", "fixture_id", "source_system", "source_version", "evidence_mode", "execution_mode", "source_health", "captured_at", "derivation", "nodes", "edges", "supporting_relations", "content_sha256"];
  if (!plain(value) || !exactKeys(value, rootFields)) fail("topology_manifest_fields_invalid");
  if (!HASH.test(value.content_sha256) || topologyManifestContentSha256(value) !== value.content_sha256) fail("topology_manifest_hash_invalid");
  if (value.schema_version !== TOPOLOGY_MANIFEST_SCHEMA_VERSION || value.fixture_id !== "otel-demo-system-v1" || value.source_system !== "opentelemetry-demo" || !/^[a-f0-9]{40}$/.test(value.source_version) || value.evidence_mode !== "captured_fixture" || value.execution_mode !== "deterministic_replay" || value.source_health !== "unavailable" || !timestamp(value.captured_at)) fail("topology_manifest_truth_invalid");
  validateDerivation(value.derivation, value.captured_at);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.supporting_relations) || value.nodes.length !== TOPOLOGY_MANIFEST_LIMITS.nodes || value.edges.length !== TOPOLOGY_MANIFEST_LIMITS.edges || value.supporting_relations.length !== TOPOLOGY_MANIFEST_LIMITS.supporting_relations) fail("topology_manifest_count_invalid");

  const nodes = value.nodes.map(normalizeNode);
  const nodeIds = nodes.map(({ id }) => id);
  if (new Set(nodeIds).size !== nodes.length || !sameArray([...nodeIds].sort(byText), EXPECTED_NODE_IDS)) fail("topology_manifest_node_invalid");
  if (!sameArray(nodeIds, [...nodeIds].sort(byText))) fail("topology_manifest_order_invalid");
  const edges = value.edges.map((edge) => normalizeEdge(edge, new Set(nodeIds)));
  const edgeIds = edges.map(({ id }) => id);
  const semanticEdges = new Set(edges.map(({ from, to, kind }) => `${from}\0${to}\0${kind}`));
  if (new Set(edgeIds).size !== edges.length || semanticEdges.size !== edges.length || !sameArray([...edgeIds].sort(byText), EXPECTED_EDGE_IDS)) fail("topology_manifest_edge_invalid");
  if (!sameArray(edgeIds, [...edgeIds].sort(byText))) fail("topology_manifest_order_invalid");
  const rawSupportingIds = value.supporting_relations.map((relation) => relation?.id);
  if (!sameArray(rawSupportingIds, [...rawSupportingIds].sort(byText))) fail("topology_manifest_order_invalid");
  const supportingRelations = value.supporting_relations.map((relation, index) => normalizeSupportingRelation(relation, new Set(nodeIds), EXPECTED_SUPPORTING_RELATIONS[index]));
  const supportingIds = supportingRelations.map(({ id }) => id);
  if (new Set(supportingIds).size !== supportingRelations.length || !sameArray(supportingIds, EXPECTED_SUPPORTING_RELATIONS.map(({ id }) => id))) fail("topology_manifest_relation_invalid");

  return deepFreeze({
    schema_version: value.schema_version,
    fixture_id: value.fixture_id,
    source_system: value.source_system,
    source_version: value.source_version,
    evidence_mode: value.evidence_mode,
    execution_mode: value.execution_mode,
    source_health: value.source_health,
    captured_at: value.captured_at,
    derivation: {
      normalization_version: value.derivation.normalization_version,
      capture_window: { ...value.derivation.capture_window },
      inputs: value.derivation.inputs.map((input) => ({ ...input })),
      exclusions: [...value.derivation.exclusions]
    },
    nodes,
    edges,
    supporting_relations: supportingRelations,
    content_sha256: value.content_sha256
  });
}

function validateDerivation(value, capturedAt) {
  if (!plain(value) || !exactKeys(value, ["normalization_version", "capture_window", "inputs", "exclusions"]) || !VERSION.test(value.normalization_version)) fail("topology_manifest_derivation_invalid");
  const window = value.capture_window;
  if (!plain(window) || !exactKeys(window, ["start", "end"]) || !timestamp(window.start) || !timestamp(window.end) || time(window.start) > time(window.end) || window.end !== capturedAt) fail("topology_manifest_derivation_invalid");
  if (!Array.isArray(value.inputs) || value.inputs.length !== 3 || !sameArray(value.inputs.map(({ signal }) => signal), ["logs", "metrics", "traces"])) fail("topology_manifest_derivation_invalid");
  for (const input of value.inputs) if (!plain(input) || !exactKeys(input, ["signal", "sha256"]) || !["logs", "metrics", "traces"].includes(input.signal) || !HASH.test(input.sha256)) fail("topology_manifest_derivation_invalid");
  if (!sameArray(value.exclusions, EXPECTED_EXCLUSIONS)) fail("topology_manifest_derivation_invalid");
}

function normalizeNode(value) {
  const fields = ["id", "kind", "display_class", "plane", "layer", "label", "status", "source_health", "signal_types", "provenance_refs"];
  if (!plain(value) || !exactKeys(value, fields) || !ID.test(value.id) || !NODE_KINDS.has(value.kind) || !DISPLAY_CLASSES.has(value.display_class) || !PLANES.has(value.plane) || !LAYERS.has(value.layer) || !safeLabel(value.label) || value.status !== "observed" || value.source_health !== "unavailable" || !signalTypes(value.signal_types) || !provenanceRefs(value.provenance_refs, `node-${value.id}`)) fail("topology_manifest_node_invalid");
  if ((value.kind === "job" || value.kind === "topic") !== (value.plane === "data")) fail("topology_manifest_node_invalid");
  return { ...value, signal_types: [...value.signal_types], provenance_refs: [...value.provenance_refs] };
}

function normalizeEdge(value, nodeIds) {
  const fields = ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"];
  const fragment = `edge-${String(value?.id || "").replace("->", "-to-")}`;
  if (!plain(value) || !exactKeys(value, fields) || value.id !== `${value.from}->${value.to}` || !nodeIds.has(value.from) || !nodeIds.has(value.to) || value.from === value.to || value.kind !== "calls" || value.plane !== "runtime" || value.label !== "Observed dependency" || value.status !== "observed" || !provenanceRefs(value.provenance_refs, fragment)) fail("topology_manifest_edge_invalid");
  return { ...value, provenance_refs: [...value.provenance_refs] };
}

function normalizeSupportingRelation(value, nodeIds, expected) {
  const fields = ["id", "from", "to", "kind", "plane", "label", "status", "provenance_refs"];
  if (!expected || !plain(value) || !exactKeys(value, fields) || !nodeIds.has(value.from) || !nodeIds.has(value.to) || value.from === value.to || !sameRecord(value, expected)) fail("topology_manifest_relation_invalid");
  return { ...expected, provenance_refs: [...expected.provenance_refs] };
}

function provenanceRefs(value, fragment) {
  return Array.isArray(value) && value.length === 1 && value.length <= TOPOLOGY_MANIFEST_LIMITS.max_provenance_refs && value[0] === `capture://otel-demo-system-v1#${fragment}`;
}

function signalTypes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SIGNAL_TYPES.length) return false;
  if (!value.every((type) => SIGNAL_TYPES.includes(type)) || new Set(value).size !== value.length) return false;
  return sameArray(value, [...value].sort((left, right) => SIGNAL_TYPES.indexOf(left) - SIGNAL_TYPES.indexOf(right)));
}

function safeLabel(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= TOPOLOGY_MANIFEST_LIMITS.max_label_bytes && SAFE_LABEL.test(value) && !UNSAFE_LABEL.test(value);
}

function timestamp(value) { return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(time(value)) && new Date(time(value)).toISOString() === value; }
function time(value) { return Date.parse(value); }
function exactKeys(value, expected) { return Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function sameRecord(value, expected) { return Object.keys(expected).every((key) => Array.isArray(expected[key]) ? sameArray(value[key], expected[key]) : value[key] === expected[key]); }
function sameArray(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function byText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function fail(code) { throw new TopologyManifestError(code); }
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

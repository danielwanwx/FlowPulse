import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import {
  TOPOLOGY_MANIFEST_LIMITS,
  loadTopologyManifest,
  parseTopologyManifest,
  topologyManifestContentSha256,
  validateAstronomyIncidentSubgraph
} from "../src/topology-manifest.mjs";

const manifestPath = new URL("../data/topology/otel-demo-system-v1.json", import.meta.url);
const manifestRaw = readFileSync(manifestPath, "utf8");

test("sanitized OpenTelemetry Demo manifest contains 22 stable nodes, 26 captured calls, and seven typed supporting relations", () => {
  const manifest = loadTopologyManifest(manifestPath);
  const nodeIds = new Set(manifest.nodes.map(({ id }) => id));

  assert.equal(manifest.nodes.length, 22);
  assert.equal(manifest.edges.length, 26);
  assert.equal(manifest.supporting_relations.length, 7);
  assert.equal(nodeIds.size, 22);
  assert.equal(manifest.edges.every(({ from, to }) => nodeIds.has(from) && nodeIds.has(to)), true);
  assert.equal(manifest.supporting_relations.every(({ from, to }) => nodeIds.has(from) && nodeIds.has(to)), true);
  assert.deepEqual(manifest.nodes.map(({ id }) => id), [...nodeIds].sort());
  assert.deepEqual(manifest.edges.map(({ id }) => id), manifest.edges.map(({ id }) => id).toSorted());
  assert.deepEqual(manifest.supporting_relations.map(({ id }) => id), manifest.supporting_relations.map(({ id }) => id).toSorted());
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.nodes[0]), true);
});

test("manifest canonicalization is byte-identical across key order and repeated loads", () => {
  const first = loadTopologyManifest(manifestPath);
  const second = loadTopologyManifest(manifestPath);
  const reordered = parseTopologyManifest(JSON.stringify(reverseKeys(JSON.parse(manifestRaw))));

  assert.deepEqual(second, first);
  assert.deepEqual(reordered, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(topologyManifestContentSha256(first), first.content_sha256);
});

test("node signal-type summaries are evidence-derived, bounded, and canonically ordered", () => {
  const manifest = loadTopologyManifest(manifestPath);
  const signalTypes = Object.fromEntries(manifest.nodes.map(({ id, signal_types }) => [id, signal_types]));

  assert.deepEqual(signalTypes, {
    "accounting": ["log"],
    "ad": ["log"],
    "cart": ["log"],
    "checkout": ["log"],
    "currency": ["log"],
    "email": ["log"],
    "flagd": ["trace"],
    "flagd-ui": ["trace"],
    "fraud-detection": ["log"],
    "frontend": ["metric"],
    "frontend-proxy": ["log"],
    "frontend-web": ["trace"],
    "image-provider": ["trace"],
    "kafka": ["log"],
    "load-generator": ["log"],
    "otelcol-contrib": ["log"],
    "payment": ["log"],
    "product-catalog": ["log"],
    "quote": ["log"],
    "recommendation": ["log"],
    "shipping": ["log"],
    "telemetry-docs": ["trace"]
  });

  for (const [code, mutate] of [
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].signal_types = ["event"]; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].signal_types = ["log", "log"]; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].signal_types = ["metric", "trace"]; }]
  ]) assertCode(() => parseTopologyManifest(resigned(mutate)), code);
});

test("manifest content hash binds every topology truth provenance and derivation field", () => {
  const mutations = [
    (value) => { value.source_version = value.source_version.replace(/^./, "0"); },
    (value) => { value.evidence_mode = "live_stream"; },
    (value) => { value.execution_mode = "real_local_development"; },
    (value) => { value.source_health = "live"; },
    (value) => { value.captured_at = "2026-07-18T20:13:05.000Z"; },
    (value) => { value.derivation.normalization_version = "flowpulse.live-source.topology.v3"; },
    (value) => { value.derivation.capture_window.start = "2026-07-18T20:11:10.000Z"; },
    (value) => { value.derivation.inputs[0].sha256 = "a".repeat(64); },
    (value) => { value.derivation.exclusions[0] = "arbitrary"; },
    (value) => { value.nodes[0].label = "Changed label"; },
    (value) => { value.nodes[0].signal_types = ["trace"]; },
    (value) => { value.nodes[0].provenance_refs[0] = "capture://otel-demo-system-v1#node-altered"; },
    (value) => { value.edges[0].label = "Changed dependency"; },
    (value) => { value.edges[0].provenance_refs[0] = "capture://otel-demo-system-v1#edge-altered"; },
    (value) => { value.supporting_relations[0].label = "Changed supporting relation"; }
  ];

  for (const mutate of mutations) {
    const value = JSON.parse(manifestRaw);
    mutate(value);
    assertCode(() => parseTopologyManifest(JSON.stringify(value)), "topology_manifest_hash_invalid");
  }
});

test("unknown duplicate unsafe orphan oversized or nondeterministically ordered manifest data fails closed", () => {
  const cases = [
    ["topology_manifest_fields_invalid", (value) => { value.raw_payload = "omitted"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes.at(-1).id = value.nodes[0].id; }],
    ["topology_manifest_edge_invalid", (value) => { value.edges[value.edges.length - 1] = { ...value.edges[0], id: "duplicate-semantic-edge" }; }],
    ["topology_manifest_edge_invalid", (value) => { value.edges[0].to = "missing-node"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].kind = "database"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].plane = "provider"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].layer = "unknown"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].label = "<script>alert(1)</script>"; }],
    ["topology_manifest_node_invalid", (value) => { value.nodes[0].label = "X".repeat(161); }],
    ["topology_manifest_order_invalid", (value) => { value.nodes.reverse(); }],
    ["topology_manifest_order_invalid", (value) => { value.edges.reverse(); }],
    ["topology_manifest_order_invalid", (value) => { value.supporting_relations.reverse(); }],
    ["topology_manifest_relation_invalid", (value) => { value.supporting_relations[0].kind = "calls"; }],
    ["topology_manifest_count_invalid", (value) => { value.edges.push({ ...value.edges[0], id: "extra-edge", from: "ad", to: "cart", provenance_refs: ["capture://otel-demo-system-v1#edge-extra-edge"] }); }]
  ];

  for (const [code, mutate] of cases) assertCode(() => parseTopologyManifest(resigned(mutate)), code);

  const duplicateRoot = manifestRaw.replace('"source_health": "unavailable",', '"source_health": "unavailable",\n  "source_health": "unavailable",');
  assertCode(() => parseTopologyManifest(duplicateRoot), "topology_manifest_json_duplicate_key");
  assertCode(() => parseTopologyManifest(`${manifestRaw}${" ".repeat(TOPOLOGY_MANIFEST_LIMITS.max_bytes)}`), "topology_manifest_json_limit_exceeded");
  assertCode(() => parseTopologyManifest(JSON.parse(manifestRaw)), "topology_manifest_json_invalid");
});

test("captured judge manifest is unavailable current health authority-free and free of raw telemetry or secrets", () => {
  const manifest = loadTopologyManifest(manifestPath);
  const prohibitedKeys = /(?:payload|body|message|span[_-]?id|trace[_-]?id|session|customer|user|path|env|prompt|secret|token|credential|password|sql)/i;
  const prohibitedValues = /(?:outputs\/|\/Users\/|\.env|BEGIN [A-Z ]+PRIVATE KEY|Bearer\s+|<script|javascript:)/i;

  assert.equal(manifest.evidence_mode, "captured_fixture");
  assert.equal(manifest.execution_mode, "deterministic_replay");
  assert.equal(manifest.source_health, "unavailable");
  assert.equal(manifest.nodes.every(({ status, source_health }) => status === "observed" && source_health === "unavailable"), true);
  assert.equal(manifest.nodes.some(({ kind }) => ["dataset", "table", "query", "dag"].includes(kind)), false);
  walk(manifest, (key, value) => {
    assert.doesNotMatch(key, prohibitedKeys);
    if (typeof value === "string") assert.doesNotMatch(value, prohibitedValues);
  });
});

test("existing six-node five-edge incident graph maps onto the full system with typed backing relations", () => {
  const manifest = loadTopologyManifest(manifestPath);
  const bundle = loadBundle();
  const before = JSON.stringify(bundle);
  const mapping = validateAstronomyIncidentSubgraph(manifest, bundle);

  assert.deepEqual(mapping.node_ids, ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"]);
  assert.equal(mapping.edges.length, 5);
  assert.equal(mapping.edges.filter(({ relation }) => relation === "observed_dependency").length, 2);
  assert.equal(mapping.edges.filter(({ relation }) => relation === "evidence_grounded_relation").length, 3);
  assert.deepEqual(mapping.edges.map(({ id }) => id), [
    "checkout->kafka",
    "checkout->payment",
    "frontend->checkout",
    "kafka->accounting",
    "kafka->fraud-detection"
  ]);
  assert.equal(JSON.stringify(bundle), before);
  assert.equal(Object.isFrozen(mapping), true);
});

function resigned(mutate) {
  const value = JSON.parse(manifestRaw);
  mutate(value);
  value.content_sha256 = topologyManifestContentSha256(value);
  return JSON.stringify(value);
}

function assertCode(action, code) {
  assert.throws(action, (error) => error?.code === code, code);
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

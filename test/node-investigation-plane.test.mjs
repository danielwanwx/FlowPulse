import assert from "node:assert/strict";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { CapturedBundleEvidenceSource } from "../src/evidence-source.mjs";
import {
  NodeInvestigationError,
  NodeInvestigationPlane,
  NODE_INVESTIGATION_SCHEMA_VERSION,
  validateNodeEvidenceQuery
} from "../src/node-investigation-plane.mjs";
import { loadTopologyManifest, validateAstronomyIncidentSubgraph } from "../src/topology-manifest.mjs";
import { composeTopologyViews } from "../src/topology-projection.mjs";

const bundle = loadBundle();
const source = new CapturedBundleEvidenceSource(bundle);
const manifest = loadTopologyManifest();
const overlay = validateAstronomyIncidentSubgraph(manifest, bundle);

test("node investigation shares canonical detail and bounded captured evidence", () => {
  const plane = new NodeInvestigationPlane({ topologyViews: topologyViews(), source, incidentProjection: incidentProjection() });
  const snapshot = plane.snapshot("checkout", { window: "15m", signal: "all", limit: 8 });

  assert.equal(snapshot.schema_version, NODE_INVESTIGATION_SCHEMA_VERSION);
  assert.equal(snapshot.component.id, "checkout");
  assert.equal(snapshot.source_truth.truth_label, "captured_replay");
  assert.equal(snapshot.window.applied, false);
  assert.equal(snapshot.observability.metrics.some((item) => item.evidence_id === "ev-metric-checkout-errors"), true);
  assert.equal(snapshot.observability.traces.some((item) => item.evidence_id === "ev-trace-payment-refused"), true);
  assert.equal(snapshot.observability.logs.some((item) => item.evidence_id === "ev-log-endpoint-fallback"), true);
  assert.equal(snapshot.configuration.changes.some((item) => item.evidence_id === "ev-deploy-checkout"), true);
  assert.equal(snapshot.raw_payload_excluded, true);
  assert.equal(JSON.stringify(snapshot).includes("PAYMENT_ADDR"), false);
});

test("node query validation and tool registry enforce bounded role-scoped reads with cache lineage", () => {
  const plane = new NodeInvestigationPlane({ topologyViews: topologyViews(), source, incidentProjection: incidentProjection() });
  assert.throws(() => validateNodeEvidenceQuery({ window: "2h" }), (error) => error instanceof NodeInvestigationError && error.code === "node_evidence_window_invalid");
  assert.throws(() => validateNodeEvidenceQuery({ limit: 13 }), (error) => error instanceof NodeInvestigationError && error.code === "node_evidence_limit_invalid");
  assert.throws(() => validateNodeEvidenceQuery({ repair: "checkout" }), (error) => error instanceof NodeInvestigationError && error.code === "node_evidence_query_unknown_field");

  const first = plane.invoke({ role: "investigator", tool: "query_component_traces", componentId: "checkout", query: { window: "15m", limit: 4 } });
  const cached = plane.invoke({ role: "investigator", tool: "query_component_traces", componentId: "checkout", query: { window: "15m", limit: 4 } });
  assert.equal(first.cached, false);
  assert.equal(cached.cached, true);
  assert.equal(first.records.some((item) => item.id === "ev-trace-payment-refused"), true);
  assert.equal(first.evidence_refs.every((id) => first.records.some((item) => item.id === id)), true);
  assert.equal(first.raw_payload_excluded, true);
  assert.throws(
    () => plane.invoke({ role: "observer", tool: "query_component_traces", componentId: "checkout", query: {} }),
    (error) => error instanceof NodeInvestigationError && error.code === "node_tool_role_forbidden"
  );
  assert.throws(
    () => plane.invoke({ role: "investigator", tool: "query_component_logs", componentId: "checkout", query: { signal: "metric" } }),
    (error) => error instanceof NodeInvestigationError && error.code === "node_tool_signal_forbidden"
  );
});

test("component projection accepts a bounded future canonical graph and projects only explicit resources", () => {
  const views = reducedTopologyViews();
  const resource = {
    id: "ev-resource-checkout-topic",
    kind: "resource",
    signal: "resource",
    title: "Captured checkout topic",
    fact: "Checkout emits orders through a captured topic.",
    entity: "checkout",
    source: "captured connector",
    at: "2026-07-21T00:00:00.000Z",
    value: { resource: { kind: "topic", id: "orders-v1", name: "orders.v1", consumer_group: "accounting-consumer" } },
    hash: "a".repeat(64)
  };
  const resourceSource = {
    metadata: () => ({ mode: "captured_fixture", status: "captured", label: "captured fixture", evidence_count: 1 }),
    list: () => ({ items: [resource] })
  };
  const plane = new NodeInvestigationPlane({ topologyViews: views, source: resourceSource, incidentProjection: incidentProjection() });
  const snapshot = plane.snapshot("checkout", {});
  assert.equal(snapshot.data_resources.length, 1);
  assert.deepEqual(snapshot.data_resources[0].kind, "topic");
  assert.equal(snapshot.data_resources[0].id, "orders-v1");

  const future = structuredClone(views);
  future.architecture.runtime_data.graph.nodes.find((item) => item.id === "checkout").id = "inventory";
  future.architecture.runtime_data.graph.nodes.find((item) => item.id === "inventory").label = "Inventory";
  future.architecture.runtime_data.graph.edges.find((item) => item.from === "checkout").from = "inventory";
  const incoming = future.architecture.runtime_data.graph.edges.find((item) => item.to === "checkout");
  if (incoming) incoming.to = "inventory";
  for (const edge of future.architecture.runtime_data.graph.edges) edge.id = `${edge.from}->${edge.to}`;
  const futureResource = { ...resource, id: "ev-resource-inventory-topic", entity: "inventory" };
  const futurePlane = new NodeInvestigationPlane({ topologyViews: future, source: { ...resourceSource, list: () => ({ items: [futureResource] }) }, incidentProjection: incidentProjection() });
  assert.equal(futurePlane.snapshot("inventory", {}).purpose.business_role, "Observed service");

  const oversize = structuredClone(views);
  oversize.architecture.runtime_data.graph.total_nodes = 257;
  assert.throws(() => new NodeInvestigationPlane({ topologyViews: oversize, source: resourceSource }).snapshot("checkout", {}), /component_detail_topology_invalid/);
});

test("stale and disconnected sources surface a gap instead of returning investigation tool facts", () => {
  const staleSource = {
    metadata: () => ({ mode: "live_otlp", status: "stale", label: "stale", evidence_count: 1 }),
    list: () => ({ items: [] })
  };
  const plane = new NodeInvestigationPlane({ topologyViews: topologyViews(), source: staleSource, incidentProjection: incidentProjection() });
  assert.equal(plane.snapshot("checkout", {}).source_truth.status, "stale");
  assert.throws(
    () => plane.invoke({ role: "observer", tool: "get_component_snapshot", componentId: "checkout", query: {} }),
    (error) => error instanceof NodeInvestigationError && error.code === "node_source_stale"
  );
});

test("Kafka reads retain their own captured evidence and honestly expose absent resource detail", () => {
  const plane = new NodeInvestigationPlane({ topologyViews: topologyViews(), source, incidentProjection: incidentProjection() });
  const kafka = plane.snapshot("kafka", { signal: "metric", limit: 8 });
  assert.equal(kafka.observability.metrics.some((item) => item.evidence_id === "ev-metric-kafka-lag"), true);
  assert.equal(kafka.observability.metrics.some((item) => item.evidence_id === "ev-metric-checkout-errors"), false);
  assert.deepEqual(kafka.data_resources, []);
  const resources = plane.invoke({ role: "investigator", tool: "query_data_resources", componentId: "kafka", query: {} });
  assert.equal(resources.result_count, 0);
  assert.equal(resources.raw_payload_excluded, true);
});

function topologyViews() {
  return composeTopologyViews({
    manifest,
    incidentProjection: incidentProjection(),
    overlay,
    controls: {
      observer_status: "observed", observer_source_health: "unavailable", observer_mode: "captured",
      external_change_evidence: [], ledger_event_count: 0, ledger_latest_event: null
    }
  });
}

function reducedTopologyViews() {
  const views = structuredClone(topologyViews());
  const graph = views.architecture.runtime_data.graph;
  graph.nodes = graph.nodes.filter((item) => ["checkout", "payment"].includes(item.id));
  graph.edges = graph.edges.filter((item) => item.from === "checkout" && item.to === "payment");
  graph.total_nodes = graph.nodes.length;
  graph.total_edges = graph.edges.length;
  return views;
}

function incidentProjection() {
  return {
    schema_version: "flowpulse.incident-projection.v1",
    projection_revision: "a".repeat(64),
    run_id: "run-node-plane", incident: { id: "inc-astro-checkout-001", title: "Checkout payment failures", severity: "SEV-2" },
    stage: { id: "monitor" }, stage_status: "collecting",
    investigation: { evaluator: { verdict: "pending", evidence_refs: [] }, hypotheses: [], diagnosis_gate: { status: "pending", event_id: null, evidence_refs: [] }, replan: { status: "not_recorded", event_id: null } },
    action: { status: "not_started" }, verification: { status: "not_recorded", passed: null }
  };
}

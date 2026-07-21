import assert from "node:assert/strict";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { CapturedBundleEvidenceSource } from "../src/evidence-source.mjs";
import { composeComponentDetail, ComponentDetailProjectionError } from "../src/component-detail-projection.mjs";
import { loadTopologyManifest, validateAstronomyIncidentSubgraph } from "../src/topology-manifest.mjs";
import { composeTopologyViews } from "../src/topology-projection.mjs";

const bundle = loadBundle();
const manifest = loadTopologyManifest();
const overlay = validateAstronomyIncidentSubgraph(manifest, bundle);

test("component detail projects bounded, evidence-backed DevOps facts without raw evidence content", () => {
  const source = new CapturedBundleEvidenceSource(bundle);
  const detail = composeComponentDetail({
    topologyViews: topologyViews(),
    nodeId: "checkout",
    source: source.metadata(),
    evidence: source.list({ entity: "checkout", limit: 12 }).items
  });

  assert.equal(detail.schema_version, "flowpulse.component-detail.v1");
  assert.equal(detail.component.id, "checkout");
  assert.equal(detail.purpose.business_role, "Order orchestration");
  assert.deepEqual(detail.relationships.downstream.map(({ id }) => id), ["cart", "currency", "email", "payment", "product-catalog", "shipping"]);
  assert.deepEqual(detail.relationships.upstream.map(({ id }) => id), ["frontend"]);
  assert.equal(detail.observability.metrics.some(({ evidence_id }) => evidence_id === "ev-metric-checkout-errors"), true);
  assert.equal(detail.observability.traces.some(({ evidence_id }) => evidence_id === "ev-trace-payment-refused"), true);
  assert.equal(detail.observability.logs.some(({ evidence_id }) => evidence_id === "ev-log-endpoint-fallback"), true);
  assert.equal(detail.configuration.changes.some(({ evidence_id }) => evidence_id === "ev-deploy-checkout"), true);
  assert.equal(detail.raw_payload_excluded, true);
  assert.equal(Object.isFrozen(detail), true);

  const serialized = JSON.stringify(detail);
  for (const forbidden of ["Error rate rose", "PAYMENT_ADDR", "provider-response", "\"payload_redacted\"", "\"fact\""]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("component detail rejects a non-canonical node and omits unsupported database/table claims", () => {
  const source = new CapturedBundleEvidenceSource(bundle);
  assert.throws(
    () => composeComponentDetail({ topologyViews: topologyViews(), nodeId: "not-a-runtime-node", source: source.metadata(), evidence: [] }),
    (error) => error instanceof ComponentDetailProjectionError && error.code === "component_detail_node_unavailable"
  );

  const detail = composeComponentDetail({ topologyViews: topologyViews(), nodeId: "frontend", source: source.metadata(), evidence: [] });
  assert.deepEqual(detail.data_resources, []);
  assert.deepEqual(detail.observability.metrics, []);
  assert.deepEqual(detail.observability.logs, []);
  assert.deepEqual(detail.observability.traces, []);
});

test("component detail fails closed on malformed topology-view identity or oversized evidence input", () => {
  const source = new CapturedBundleEvidenceSource(bundle);
  const malformed = structuredClone(topologyViews());
  malformed.projection_revision = "not-a-hash";
  assert.throws(
    () => composeComponentDetail({ topologyViews: malformed, nodeId: "checkout", source: source.metadata(), evidence: [] }),
    (error) => error instanceof ComponentDetailProjectionError && error.code === "component_detail_topology_invalid"
  );
  assert.throws(
    () => composeComponentDetail({
      topologyViews: topologyViews(),
      nodeId: "checkout",
      source: source.metadata(),
      evidence: Array.from({ length: 9 }, (_, index) => ({ id: `evidence-${index}` }))
    }),
    (error) => error instanceof ComponentDetailProjectionError && error.code === "component_detail_evidence_limit_exceeded"
  );
});

function topologyViews() {
  return composeTopologyViews({
    manifest,
    incidentProjection: {
      schema_version: "flowpulse.incident-projection.v1",
      projection_revision: "a".repeat(64),
      run_id: "run-component-detail",
      incident: { id: "inc-astro-checkout-001", title: "Checkout payment failures", severity: "SEV-2" },
      stage: { id: "monitor" },
      stage_status: "collecting",
      investigation: { evaluator: { verdict: "pending", evidence_refs: [] }, hypotheses: [], diagnosis_gate: { status: "pending", event_id: null, evidence_refs: [] }, replan: { status: "not_recorded", event_id: null } },
      action: { status: "not_started" },
      verification: { status: "not_recorded", passed: null }
    },
    overlay,
    controls: {
      observer_status: "observed",
      observer_source_health: "unavailable",
      observer_mode: "captured",
      external_change_evidence: [{ id: "ev-deploy-checkout", kind: "deployment_change", status: "observed", affected_node_ids: ["checkout"], provenance_refs: ["evidence://ev-deploy-checkout"] }],
      ledger_event_count: 0,
      ledger_latest_event: null
    }
  });
}

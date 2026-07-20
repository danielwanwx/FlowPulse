import assert from "node:assert/strict";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { loadTopologyManifest, validateAstronomyIncidentSubgraph } from "../src/topology-manifest.mjs";
import { composeTopologyViews, TopologyProjectionError } from "../src/topology-projection.mjs";

const manifest = loadTopologyManifest();
const overlay = validateAstronomyIncidentSubgraph(manifest, loadBundle());

test("topology views compose deterministic captured Architecture, Live, and Diagnose read models", () => {
  const incidentProjection = projection();
  const first = composeTopologyViews({ manifest, incidentProjection, overlay, controls: controls() });
  const second = composeTopologyViews({ manifest, incidentProjection, overlay, controls: controls() });
  const runtimeIds = new Set(first.architecture.runtime_data.graph.nodes.map(({ id }) => id));

  assert.deepEqual(second, first);
  assert.equal(first.schema_version, "flowpulse.topology-views.v2");
  assert.equal(first.truth.label, "CAPTURED");
  assert.deepEqual([first.truth.source_health, first.truth.evidence_mode, first.truth.execution_mode], ["unavailable", "captured_fixture", "deterministic_replay"]);
  assert.equal(first.architecture.runtime_data.graph.nodes.length, 22);
  assert.equal(runtimeIds.size, 22);
  assert.equal(first.architecture.runtime_data.edge_count, 22);
  assert.equal(first.architecture.runtime_data.graph.edges.every(({ from, to }) => runtimeIds.has(from) && runtimeIds.has(to)), true);
  assert.deepEqual(first.architecture.control_system.nodes.map(({ id }) => id), ["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
  assert.equal(first.architecture.control_system.relation_count, 0);
  assert.equal(first.architecture.external_change_evidence.relation_count, 1);
  assert.deepEqual(first.architecture.external_change_evidence.records[0].affected_node_ids, ["checkout"]);
  assert.equal(first.live.runtime_data.graph.nodes.length, 22);
  assert.equal(first.live.runtime_data.graph.edges.length, 22);
  assert.equal(first.live.runtime_data.graph.nodes.every(({ status, source_health }) => status === "captured" && source_health === "unavailable"), true);
  assert.deepEqual(first.live.control_system.nodes.map(({ id }) => id), first.architecture.control_system.nodes.map(({ id }) => id));
  assert.deepEqual(first.live.external_change_evidence, first.architecture.external_change_evidence);
  assert.equal(first.diagnose.runtime_data.graph.nodes.length, 22);
  assert.equal(first.diagnose.runtime_data.graph.edges.length, 22);
  assert.equal(first.diagnose.overlay.node_ids.length, 6);
  assert.equal(first.diagnose.overlay.edges.length, 5);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.live.runtime_data.graph.nodes[0]), true);
});

test("topology readiness is server-derived and compatibility input cannot unlock views", () => {
  const initial = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls() });
  const compatibilityAttempt = composeTopologyViews({
    manifest,
    incidentProjection: projection(),
    overlay,
    controls: controls(),
    compatibility: { architecture_available: false, live_available: false, incident_detected: false, diagnose_available: true, agent_available: true, compare_available: true }
  });
  const active = composeTopologyViews({
    manifest,
    incidentProjection: projection({ stage: { id: "agent_workbench" }, stage_status: "replanning", investigation: investigation("rejected") }),
    overlay,
    controls: controls()
  });
  const verified = composeTopologyViews({
    manifest,
    incidentProjection: projection({ stage: { id: "decision_recovery" }, stage_status: "verified", action: { status: "executed" }, verification: { status: "passed", passed: true } }),
    overlay,
    controls: controls()
  });
  const malformed = composeTopologyViews({ manifest, incidentProjection: projection({ run_id: null }), overlay, controls: controls() });

  assert.deepEqual(initial.readiness, {
    architecture_available: true,
    live_available: true,
    incident_detected: true,
    diagnose_available: false,
    agent_available: false,
    compare_available: false
  });
  assert.deepEqual(compatibilityAttempt.readiness, initial.readiness);
  assert.deepEqual(active.readiness, { ...initial.readiness, diagnose_available: true, agent_available: true });
  assert.deepEqual(verified.readiness, { ...initial.readiness, diagnose_available: true, agent_available: false, compare_available: true });
  assert.equal(malformed.readiness.incident_detected, false);
  assert.equal(malformed.readiness.diagnose_available, false);
});

test("five control identities remain while deployment change evidence is bounded and optional", () => {
  const before = JSON.stringify(overlay);
  const view = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls({ external_change_evidence: [] }) });

  assert.deepEqual(view.architecture.control_system.nodes.map(({ id }) => id), ["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
  assert.equal(view.architecture.control_system.nodes.some(({ id }) => id === "deployment"), false);
  assert.equal(view.architecture.external_change_evidence.relation_count, 0);
  assert.deepEqual(view.architecture.external_change_evidence.records, []);
  assert.equal(view.diagnose.overlay.edges.filter(({ relation }) => relation === "observed_dependency").length, 2);
  assert.equal(view.diagnose.overlay.edges.filter(({ relation }) => relation === "incident_evidence").length, 3);
  assert.equal(JSON.stringify(overlay), before);
});

test("view revisions bind projection semantics and invalid incident overlays fail closed", () => {
  const baseline = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls() });
  const semanticDrift = composeTopologyViews({ manifest, incidentProjection: projection({ projection_revision: "b".repeat(64) }), overlay, controls: controls() });
  const evidenceDrift = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls({ external_change_evidence: [changeEvidence("payment")] }) });
  const invalidOverlay = structuredClone(overlay);
  invalidOverlay.edges[0].from = "not-a-runtime-node";

  assert.notEqual(semanticDrift.projection_revision, baseline.projection_revision);
  assert.notEqual(evidenceDrift.projection_revision, baseline.projection_revision);
  assert.throws(
    () => composeTopologyViews({ manifest, incidentProjection: projection(), overlay: invalidOverlay, controls: controls() }),
    (error) => error instanceof TopologyProjectionError && error.code === "topology_view_overlay_invalid"
  );
  assert.throws(
    () => composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls({ external_change_evidence: [changeEvidence("missing")] }) }),
    (error) => error instanceof TopologyProjectionError && error.code === "topology_view_external_change_invalid"
  );
});

test("server-owned demo lifecycle keeps the full graph healthy, then exposes only the bounded incident overlay", () => {
  const healthy = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls(), demoLifecycle: demoLifecycle("HEALTHY") });
  const detected = composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls(), demoLifecycle: demoLifecycle("INCIDENT_DETECTED") });

  assert.deepEqual(healthy.readiness, {
    architecture_available: true,
    live_available: true,
    incident_detected: false,
    diagnose_available: false,
    agent_available: false,
    compare_available: false
  });
  assert.equal(healthy.live.runtime_data.graph.nodes.every((node) => node.status === "healthy"), true);
  assert.equal(healthy.live.runtime_data.graph.edges.every((edge) => edge.status === "healthy"), true);
  assert.equal(healthy.diagnose.overlay.status, "unavailable");
  assert.equal(detected.readiness.incident_detected, true);
  assert.equal(detected.readiness.diagnose_available, true);
  assert.equal(detected.readiness.agent_available, false);
  assert.equal(detected.readiness.compare_available, false);
  assert.equal(detected.live.runtime_data.graph.nodes.filter((node) => node.status === "incident").length, 6);
  assert.equal(detected.live.incident_overlay.edges.length, 5);
  assert.deepEqual(detected.demo.frames.map((frame) => frame.phase), ["HEALTHY", "INJECTING", "PAYMENT_CHECKOUT_IMPACT", "DOWNSTREAM_PROPAGATION", "INCIDENT_DETECTED"]);

  const forged = demoLifecycle("INCIDENT_DETECTED");
  forged.frames[3].relation_ids = ["kafka->fraud-detection", "checkout->kafka", "kafka->accounting"];
  assert.throws(
    () => composeTopologyViews({ manifest, incidentProjection: projection(), overlay, controls: controls(), demoLifecycle: forged }),
    (error) => error instanceof TopologyProjectionError && error.code === "topology_view_demo_lifecycle_invalid"
  );
});

function controls(overrides = {}) {
  return {
    observer_status: "observed",
    observer_source_health: "unavailable",
    external_change_evidence: [changeEvidence("checkout")],
    ledger_event_count: 2,
    ...overrides
  };
}

function changeEvidence(affectedNodeId) {
  return {
    id: "ev-deploy-checkout",
    kind: "deployment_change",
    status: "observed",
    affected_node_ids: [affectedNodeId],
    provenance_refs: ["evidence://ev-deploy-checkout"]
  };
}

function projection(overrides = {}) {
  return {
    schema_version: "flowpulse.incident-projection.v1",
    projection_revision: "a".repeat(64),
    run_id: "run-topology",
    incident: { id: "inc-astro-checkout-001", title: "Checkout payment failures", severity: "SEV-2" },
    stage: { id: "monitor" },
    stage_status: "collecting",
    investigation: investigation("pending"),
    action: { status: "not_started" },
    verification: { status: "not_recorded", passed: null },
    ...overrides
  };
}

function investigation(verdict) {
  return {
    hypotheses: [],
    evaluator: { verdict, evidence_refs: [] },
    diagnosis_gate: { status: verdict === "accepted" ? "passed" : "pending", event_id: null, evidence_refs: [] },
    replan: { status: verdict === "rejected" ? "recorded" : "not_recorded", event_id: null }
  };
}

function demoLifecycle(phase) {
  return {
    schema_version: "flowpulse.demo-lifecycle.v1",
    run_id: "run-topology",
    scenario_id: "astronomy-checkout-payment-captured-v1",
    phase,
    frames: [
      { id: "healthy", order: 0, phase: "HEALTHY", node_ids: [], relation_ids: [], evidence_refs: [] },
      { id: "injecting", order: 1, phase: "INJECTING", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-deploy-checkout", "ev-trace-payment-refused"] },
      { id: "payment_checkout_impact", order: 2, phase: "PAYMENT_CHECKOUT_IMPACT", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-metric-checkout-errors"] },
      { id: "downstream_propagation", order: 3, phase: "DOWNSTREAM_PROPAGATION", node_ids: ["kafka", "accounting", "fraud-detection"], relation_ids: ["checkout->kafka", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-kafka-lag", "ev-log-consumer-delay"] },
      { id: "incident_detected", order: 4, phase: "INCIDENT_DETECTED", node_ids: ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"], relation_ids: ["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"] }
    ].slice(0, phase === "HEALTHY" ? 1 : 5)
  };
}

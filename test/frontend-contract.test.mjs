import test from "node:test";
import assert from "node:assert/strict";
import {
  BackendIncidentProjectionClient,
  DemoBundleProjectionClient,
  ProjectionUnavailableError,
  projectionPresentation,
  validateIncidentProjection
} from "../public/incident-projection-client.mjs";

const HASH = "a".repeat(64);

function projection(overrides = {}) {
  return {
    schema_version: "flowpulse.incident-projection.v1",
    projection_revision: HASH,
    run_id: "run-frontend-contract",
    incident: { id: "checkout-payment", title: "Checkout payment failures", severity: "SEV-2" },
    stage: { id: "agent_workbench", label: "Agent Workbench" },
    stage_status: "replanning",
    source_health: "live",
    evidence_mode: "captured_fixture",
    execution_mode: "deterministic_replay",
    graph: {
      nodes: [
        { id: "checkout", label: "Checkout", kind: "service" },
        { id: "kafka", label: "orders.v1", kind: "topic" }
      ],
      edges: [{ id: "checkout-kafka", from: "checkout", to: "kafka", kind: "dependency" }],
      total_nodes: 2,
      total_edges: 1,
      truncated: false
    },
    timeline: {
      frames: [
        { id: "event-1", sequence: 1, at: "2026-07-18T10:00:00.000Z", type: "incident.opened", actor: "runtime", evidence_refs: [] },
        { id: "event-2", sequence: 2, at: "2026-07-18T10:00:01.000Z", type: "evaluation.rejected", actor: "evaluator", evidence_refs: ["ev-checkout"] }
      ],
      total_frames: 2,
      cursor: null
    },
    evidence: [{ id: "ev-checkout", kind: "trace", signal: "traces", entity: "checkout", source: "captured", observed_at: "2026-07-18T10:00:01.000Z", record_sha256: HASH, provenance_status: "record_bound" }],
    investigation: {
      hypotheses: [{ id: "hyp-kafka", status: "hypothesis.proposed", evidence_refs: ["ev-checkout"] }],
      counter_evidence: { hypothesis_id: "hyp-kafka", evidence_refs: ["ev-checkout"] },
      evaluator: { verdict: "rejected", evidence_refs: ["ev-checkout"] },
      diagnosis_gate: { status: "pending", event_id: null, evidence_refs: [] },
      replan: { status: "recorded", event_id: "event-2" }
    },
    decision: { status: "not_recorded", decision_id: null, risk_tier: null, evidence_refs: [] },
    human_gate: { status: "not_required", request_id: null, approval_id: null },
    action: { status: "not_started", event_id: null, truth: null },
    verification: { status: "not_recorded", event_id: null, passed: null, evidence_refs: [] },
    learning: { regression_id: null, backtest_id: null, policy_id: null, backtest_source: null },
    why_stopped: { code: null, detail_status: "not_stopped" },
    truncated: false,
    truncation: { graph_nodes: 0, graph_edges: 0, timeline_frames: 0, evidence_summaries: 0, serialized_bytes: 1800 },
    next_cursor: null,
    ...overrides
  };
}

test("both strict projection clients render the same golden incident contract", async () => {
  const priorFetch = globalThis.fetch;
  const demo = await new DemoBundleProjectionClient().load();
  globalThis.fetch = async () => new Response(JSON.stringify({ incident_projection: demo }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const backend = await new BackendIncidentProjectionClient().load();
    assert.deepEqual(projectionPresentation(backend), projectionPresentation(demo));
    assert.equal(Object.isFrozen(backend), true);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("backend failure and schema mismatch are unavailable, never a demo fallback", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ incident_projection: projection({ schema_version: "attacker.schema.v1" }) }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(new BackendIncidentProjectionClient().load(), ProjectionUnavailableError);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("only a valid projection may provide stage, risk, gate, receipt, verification, and why-stopped presentation", () => {
  const valid = validateIncidentProjection(projection());
  assert.deepEqual(projectionPresentation(valid), {
    stage: "agent_workbench",
    stage_status: "replanning",
    risk_tier: null,
    evaluator: "rejected",
    diagnosis_gate: "pending",
    receipt: "not_recorded",
    verification: "not_recorded",
    why_stopped: null,
    actionable: false
  });
  assert.throws(() => validateIncidentProjection(projection({ source_health: "stale" })), ProjectionUnavailableError);
  assert.throws(() => validateIncidentProjection(projection({ graph: { ...projection().graph, nodes: [{ id: "checkout", label: "<script>alert(1)</script>", kind: "service" }] } })), ProjectionUnavailableError);
});

test("projection cursor is presentation-only and cannot append, authorize, verify, or select a client", () => {
  const client = new BackendIncidentProjectionClient();
  assert.equal(typeof client.append, "undefined");
  assert.equal(typeof client.authorize, "undefined");
  assert.equal(typeof client.verify, "undefined");
  assert.throws(() => validateIncidentProjection(projection({ next_cursor: "not-an-opaque-projection-cursor" })), ProjectionUnavailableError);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  INCIDENT_PROJECTION_LIMITS,
  INCIDENT_PROJECTION_SCHEMA_VERSION,
  buildIncidentProjection
} from "../src/incident-projection.mjs";
import { sha256Canonical } from "../src/autonomy-policy.mjs";

const RUN_ID = "run-projection";
const INCIDENT_ID = "checkout-payment";

function event(sequence, type, payload = {}, evidence_refs = [], relationship = {}) {
  return {
    id: `event-${sequence}-${type.replaceAll(".", "-")}`,
    sequence,
    run_id: RUN_ID,
    incident_id: INCIDENT_ID,
    recorded_at: `2026-07-18T10:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}.000Z`,
    actor: "runtime",
    type,
    payload,
    payload_sha256: sha256Canonical(payload),
    evidence_refs,
    parent_id: relationship.parent_id ?? null,
    correlation_id: relationship.correlation_id ?? `corr-${RUN_ID}`
  };
}

function authorityIdentity(value) {
  return { event_id: value.id, sequence: value.sequence, payload_sha256: value.payload_sha256 };
}

function canonicalAuthorityEvents() {
  const refs = ["ev-checkout"];
  const decision = { ...event(7, "autonomy.decision.recorded", {
    outcome: "human_review_required", source_health: "live", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay", contract_sha256: "b".repeat(64)
  }, refs, { correlation_id: "corr-decision" }), id: "decision-7" };
  const proposal = { ...event(8, "repair.proposed", { decision_id: decision.id }, refs, { correlation_id: decision.id }), id: "proposal-8" };
  const request = { ...event(9, "approval.requested", { decision_id: decision.id }, refs, { parent_id: proposal.id, correlation_id: decision.id }), id: "request-9" };
  const approval = { ...event(10, "approval.granted", {}, refs, { correlation_id: decision.id }), id: "approval-10" };
  const attempt = { ...event(11, "repair.execution.attempted", {}, refs, { parent_id: approval.id, correlation_id: decision.id }), id: "attempt-11" };
  const execution = { ...event(12, "repair.executed", { completed_at: "2026-07-18T10:01:00.000Z" }, refs, { parent_id: attempt.id, correlation_id: decision.id }), id: "execution-12" };
  const verification = { ...event(13, "verification.completed", { passed: true, repair_completed_at: "2026-07-18T10:01:00.000Z", checks: [{ passed: true }] }, refs, { correlation_id: decision.id, }), id: "verification-13", actor: "verifier" };
  const events = [decision, proposal, request, approval, attempt, execution, verification];
  return {
    events,
    chain: {
      schema_version: "flowpulse.projection-authority.v1", status: "canonical",
      decision: authorityIdentity(decision), proposal: authorityIdentity(proposal), request: authorityIdentity(request), approval: authorityIdentity(approval), attempt: authorityIdentity(attempt), execution: authorityIdentity(execution), verification: authorityIdentity(verification)
    }
  };
}

function input(overrides = {}) {
  return {
    run: {
      run_id: RUN_ID,
      mode: "replay",
      incident: { id: INCIDENT_ID, title: "Checkout payment failures", severity: "SEV-2", summary: "Payment calls fail." },
      topology: {
        services: [{ id: "checkout", label: "Checkout" }, { id: "payment", label: "Payment" }],
        dependencies: [{ from: "checkout", to: "payment" }]
      }
    },
    source: {
      mode: "deterministic_replay",
      status: "captured",
      live_status: "disconnected",
      label: "deterministic replay",
      last_observed_at: "2026-07-18T10:00:00.000Z"
    },
    evidence: [{
      id: "ev-checkout", kind: "trace", signal: "traces", title: "Payment refused", fact: "checkout span failed", entity: "checkout", source: "captured", at: "2026-07-18T10:00:01.000Z", hash: "a".repeat(64), provenance: { sha256: "a".repeat(64) }
    }],
    events: [
      event(1, "run.started", { mode: "replay" }),
      event(2, "incident.opened", { title: "Checkout payment failures", severity: "SEV-2" }),
      event(3, "evidence.queried", { tool: "query_traces", result_count: 1 }, ["ev-checkout"]),
      event(4, "hypothesis.proposed", { id: "hyp-kafka", title: "Kafka is the cause", confidence: 0.7, claim: "Kafka delay" }, ["ev-checkout"]),
      event(5, "evaluation.rejected", { hypothesis_id: "hyp-kafka", score: 0.2, reason: "failure precedes lag" }, ["ev-checkout"]),
      event(6, "plan.revised", { reason: "Inspect checkout first" }, ["ev-checkout"])
    ],
    ...overrides
  };
}

test("IncidentProjection v1 is bounded, deterministic, redacted, and exposes the rejected-hypothesis replan", () => {
  const first = buildIncidentProjection(input());
  const second = buildIncidentProjection(input({ events: [...input().events].reverse() }));

  assert.equal(first.schema_version, INCIDENT_PROJECTION_SCHEMA_VERSION);
  assert.equal(first.stage.id, "agent_workbench");
  assert.equal(first.stage_status, "replanning");
  assert.equal(first.source_health, "live");
  assert.equal(first.evidence_mode, "captured_fixture");
  assert.equal(first.execution_mode, "deterministic_replay");
  assert.equal(first.investigation.evaluator.verdict, "rejected");
  assert.equal(first.investigation.replan.status, "recorded");
  assert.deepEqual(first.timeline.frames.map((frame) => frame.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(first.projection_revision, second.projection_revision);
  assert.equal(JSON.stringify(first).includes("Payment calls fail."), false);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= INCIDENT_PROJECTION_LIMITS.max_serialized_bytes);
});

test("projection treats captured legacy Owner-Gate rows as display-only while preserving failure state", () => {
  const cases = [
    [
      [event(7, "autonomy.decision.recorded", { outcome: "human_review_required", risk_tier: "medium" }, ["ev-checkout"]), event(8, "repair.proposed", { id: "repair-1", target: "checkout", action: "rollback" }, ["ev-checkout"]), event(9, "approval.requested", { decision_id: "event-7-autonomy-decision-recorded" }, [])],
      "decision_recovery", "legacy_detail_unavailable", "legacy_detail_unavailable"
    ],
    [
      [event(7, "approval.granted", { owner: "owner" }, ["ev-checkout"]), event(8, "repair.execution.attempted", { decision_id: "event-7" }, ["ev-checkout"]), event(9, "verification.completed", { passed: true, checks: [{ passed: true }] }, ["ev-checkout"])],
      "decision_recovery", "legacy_detail_unavailable", "legacy_detail_unavailable"
    ],
    [
      [event(7, "outcome.classified", { classification: "insufficient_evidence" }, ["ev-checkout"])],
      "agent_workbench", "blocked", "not_required"
    ]
  ];
  for (const [suffix, stage, status, gate] of cases) {
    const projection = buildIncidentProjection(input({ events: [...input().events, ...suffix] }));
    assert.equal(projection.stage.id, stage);
    assert.equal(projection.stage_status, status);
    assert.equal(projection.human_gate.status, gate);
  }
  const legacy = buildIncidentProjection(input({ events: [event(1, "run.started", { mode: "replay" }), event(2, "incident.opened", { title: "legacy", severity: "SEV-2" })] }));
  assert.equal(legacy.why_stopped.detail_status, "legacy_detail_unavailable");
});

test("projection fails closed for cross-incident, malformed, unknown-mode, unknown-cursor, stale source, and oversized evidence references", () => {
  const badInputs = [
    input({ events: [...input().events, { ...event(7, "tool.called"), incident_id: "other-incident" }] }),
    input({ run: { ...input().run, mode: "unknown" } }),
    input({ source: { ...input().source, status: "stale" } }),
    input({ source: { ...input().source, truth_mode: "live" } }),
    input({ cursor: "not-a-flowpulse-projection-cursor" }),
    input({ events: [...input().events, event(7, "tool.called", {}, Array.from({ length: 33 }, (_, index) => `ev-${index}`))] })
  ];
  for (const value of badInputs) {
    const projection = buildIncidentProjection(value);
    assert.equal(projection.stage_status, "non_actionable");
    assert.equal(projection.action.status, "not_actionable");
    assert.ok(projection.why_stopped.code);
  }
});

test("projection caps graph, timeline, evidence and serialized bytes with explicit deterministic truncation", () => {
  const nodes = Array.from({ length: 129 }, (_, index) => ({ id: `service-${index}`, label: `Service ${index}` }));
  const dependencies = Array.from({ length: 257 }, (_, index) => ({ from: `service-${index % 128}`, to: `service-${(index + Math.floor(index / 128) + 1) % 128}` }));
  const evidence = Array.from({ length: 65 }, (_, index) => ({
    id: `ev-${index}`, kind: "log", signal: "logs", title: "x".repeat(120), fact: `secret-${index}`, entity: "checkout", source: "captured", at: "2026-07-18T10:00:01.000Z", hash: `${index}`.padStart(64, "a"), provenance: { sha256: `${index}`.padStart(64, "a") }
  }));
  const events = Array.from({ length: 101 }, (_, index) => event(index + 1, "evidence.queried", { tool: "query", raw_provider_text: "must-not-project" }, [`ev-${index % 65}`]));
  const projection = buildIncidentProjection(input({
    run: { ...input().run, topology: { services: nodes, dependencies } },
    evidence,
    events
  }));
  assert.equal(projection.graph.nodes.length, 128);
  assert.equal(projection.graph.edges.length, 256);
  assert.equal(projection.timeline.frames.length, 100);
  assert.equal(projection.evidence.length, 64);
  assert.equal(projection.truncated, true);
  assert.ok(projection.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= INCIDENT_PROJECTION_LIMITS.max_serialized_bytes);
  assert.equal(JSON.stringify(projection).includes("secret-"), false);
  assert.equal(JSON.stringify(projection).includes("raw_provider_text"), false);
  const nextPage = buildIncidentProjection(input({
    run: { ...input().run, topology: { services: nodes, dependencies } },
    evidence,
    events,
    cursor: projection.next_cursor
  }));
  assert.equal(nextPage.stage_status, "collecting");
  assert.deepEqual(nextPage.timeline.frames.map((frame) => frame.sequence), [101]);
});

test("truth axes remain orthogonal for frozen real, GPT model-only, local development and captured simulation", () => {
  const cases = [
    [{ mode: "development" }, { mode: "frozen_real_otlp_snapshot", status: "frozen", live_status: "live" }, "live", "frozen_real_snapshot", "real_local_development"],
    [{ mode: "live" }, { mode: "live_otlp", status: "live", live_status: "live" }, "live", "live_stream", "gpt_model_only"],
    [{ mode: "replay" }, { mode: "deterministic_replay", status: "captured", live_status: "disconnected" }, "live", "captured_fixture", "deterministic_replay"],
    [{ mode: "replay" }, { mode: "deterministic_replay", status: "captured", live_status: "disconnected" }, "live", "captured_fixture", "captured_simulation", [event(7, "action.simulated", { execution_mode: "captured_simulation" }, ["ev-checkout"])] ]
  ];
  for (const [runPatch, sourcePatch, health, evidenceMode, executionMode, extra = []] of cases) {
    const projection = buildIncidentProjection(input({ run: { ...input().run, ...runPatch }, source: { ...input().source, ...sourcePatch }, events: [...input().events, ...extra] }));
    assert.deepEqual([projection.source_health, projection.evidence_mode, projection.execution_mode], [health, evidenceMode, executionMode]);
  }
});

test("projection never strengthens isolated, reordered, or forged Owner-Gate events", () => {
  const isolated = [
    event(7, "approval.granted", { owner: "forged" }, ["ev-checkout"]),
    event(8, "repair.execution.attempted", { decision_id: "forged" }, ["ev-checkout"]),
    event(9, "repair.executed", { decision_id: "forged" }, ["ev-checkout"]),
    event(10, "verification.completed", { passed: true }, ["ev-checkout"])
  ];
  const projection = buildIncidentProjection(input({
    run: { ...input().run, mode: "development" },
    source: { mode: "frozen_real_otlp_snapshot", status: "frozen" },
    events: [...input().events, ...isolated]
  }));
  assert.equal(projection.stage_status, "non_actionable");
  assert.equal(projection.human_gate.status, "not_actionable");
  assert.equal(projection.action.status, "not_actionable");
  assert.equal(projection.verification.status, "not_actionable");
});

test("projection renders a fully linked canonical chain only, and rejects relationship or payload drift", () => {
  const canonical = canonicalAuthorityEvents();
  const valid = buildIncidentProjection(input({ events: [...input().events, ...canonical.events], authority_chain: canonical.chain }));
  assert.equal(valid.stage_status, "verified");
  assert.equal(valid.human_gate.status, "granted");
  assert.equal(valid.action.status, "executed");

  const reordered = structuredClone(canonical);
  reordered.events[2].parent_id = null;
  const relationshipDrift = buildIncidentProjection(input({ events: [...input().events, ...reordered.events], authority_chain: reordered.chain }));
  assert.equal(relationshipDrift.stage_status, "non_actionable");

  const payloadDrift = structuredClone(canonical);
  payloadDrift.events[0].payload.outcome = "non_actionable";
  const changedPayload = buildIncidentProjection(input({ events: [...input().events, ...payloadDrift.events], authority_chain: payloadDrift.chain }));
  assert.equal(changedPayload.stage_status, "non_actionable");
});

test("projection revision binds payload and relationship changes, while stale truth remains truthful", () => {
  const left = buildIncidentProjection(input({ events: [...input().events, event(7, "autonomy.decision.recorded", { outcome: "non_actionable" }, ["ev-checkout"])] }));
  const right = buildIncidentProjection(input({ events: [...input().events, event(7, "autonomy.decision.recorded", { outcome: "human_review_required" }, ["ev-checkout"])] }));
  assert.notEqual(left.projection_revision, right.projection_revision);

  const stale = buildIncidentProjection(input({
    run: { ...input().run, mode: "development" },
    source: { mode: "frozen_real_otlp_snapshot", status: "stale" }
  }));
  assert.equal(stale.stage_status, "non_actionable");
  assert.deepEqual([stale.source_health, stale.evidence_mode, stale.execution_mode], ["stale", "frozen_real_snapshot", "real_local_development"]);
});

test("projection rejects unknown events and oversize input before deriving state", () => {
  const unknown = buildIncidentProjection(input({ events: [...input().events, event(7, "attacker.unknown.authority", {}, [])] }));
  assert.equal(unknown.stage_status, "non_actionable");

  const oversized = buildIncidentProjection(input({ events: Array.from({ length: 1_025 }, (_, index) => event(index + 1, "evidence.queried", {}, [])) }));
  assert.equal(oversized.stage_status, "non_actionable");

  const oversizedUtf8 = buildIncidentProjection(input({ events: [...input().events, event(7, "tool.called", { label: "界".repeat(8_193) })] }));
  assert.equal(oversizedUtf8.stage_status, "non_actionable");

  let nested = { leaf: "value" };
  for (let index = 0; index < 10; index += 1) nested = { nested };
  const deepPayload = buildIncidentProjection(input({ events: [...input().events, event(7, "tool.called", nested)] }));
  assert.equal(deepPayload.stage_status, "non_actionable");
});

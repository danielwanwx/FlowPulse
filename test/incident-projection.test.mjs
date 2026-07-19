import test from "node:test";
import assert from "node:assert/strict";
import {
  INCIDENT_PROJECTION_LIMITS,
  INCIDENT_PROJECTION_SCHEMA_VERSION,
  buildIncidentProjection
} from "../src/incident-projection.mjs";
import { sha256Canonical } from "../src/autonomy-policy.mjs";
import { sha256 as hashBoundEvidence } from "../src/regression-backtest.mjs";

const RUN_ID = "run-projection";
const INCIDENT_ID = "checkout-payment";

function event(sequence, type, payload = {}, evidence_refs = [], relationship = {}) {
  return {
    id: `event-${sequence}-${type.replaceAll(".", "-")}`,
    sequence,
    run_id: RUN_ID,
    incident_id: INCIDENT_ID,
    recorded_at: `2026-07-18T10:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}.000Z`,
    actor: relationship.actor ?? "runtime",
    type,
    offset_ms: 0,
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
  const contract = {
    repair_id: "repair-payment-reachable-v1",
    action: "restore known-good paymentUnreachable flag and recreate checkout",
    command_id: "astronomy.restore-payment-and-recreate-checkout",
    target: "checkout",
    expected_before: "paymentUnreachable=on",
    expected_after: "paymentUnreachable=off"
  };
  const contract_sha256 = sha256Canonical(contract);
  const evaluation = {
    accepted: true,
    score: 0.9,
    classification: "confirmed_system_bug",
    phase: "diagnosis_pre_approval",
    gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
    reason: "Bounded evidence supports the checkout configuration cause.",
    missing_evidence: [],
    counter_evidence_refs: refs
  };
  const boundRecord = {
    id: "ev-checkout", kind: "trace", signal: "traces", title: "Frozen checkout failure", entity: "checkout", source: "frozen", at: "2026-07-18T10:00:01.000Z",
    hash: "a".repeat(64), provenance: { sha256: "a".repeat(64) }
  };
  const evidenceBinding = { id: "ev-checkout", sha256: hashBoundEvidence(boundRecord), record: boundRecord };
  const diagnosis = {
    id: "hyp-checkout-flag",
    title: "Checkout configuration causes the payment failure",
    confidence: 0.91,
    claim: "The frozen checkout evidence proves the bounded configuration mechanism.",
    initiating_change: "paymentUnreachable changed off to on for checkout",
    failure_mechanism: "Checkout resolver reads the flag and fails its payment child call.",
    propagation: [],
    evidence_refs: refs,
    proposed_repair: { repair_id: contract.repair_id, action: contract.action, command_id: contract.command_id, target: contract.target, reason: "Owner approval is required." }
  };
  const decisionPayload = {
    schema_version: "flowpulse.autonomy.v1", run_id: RUN_ID, incident_id: INCIDENT_ID, intent_id: "checkout-payment", environment: "local_development",
    source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: "real_local_development",
    contract, contract_sha256, snapshot: { id: "snapshot-projection", content_sha256: "d".repeat(64), mode: "frozen_real_otlp_snapshot", records: [], manifest_sha256: "e".repeat(64) },
    receipt_sha256: "f".repeat(64), authority_context_sha256: "a".repeat(64),
    artifact: { schema_version: "flowpulse.autonomy-artifacts.v1", version: "2026-07-18", registry_sha256: "b".repeat(64), intent_sha256: "c".repeat(64), envelope_sha256: "d".repeat(64), artifact_sha256: "e".repeat(64) },
    authority_evidence: { evaluator: { id: "evaluation-6", sequence: 6, payload_sha256: "0".repeat(64) }, diagnosis_gate: { id: "gate-7", sequence: 7, payload_sha256: "0".repeat(64) }, refs: [{ id: "ev-checkout", sha256: evidenceBinding.sha256, record_sha256: "a".repeat(64), source: "frozen", mode: "frozen_real_otlp_snapshot" }] },
    outcome: "human_review_required", reason_code: "owner_gate_required", capture_observed_at: "2026-07-18T10:00:00.000Z", decision_sha256: "0".repeat(64), decision_id: "pending"
  };
  decisionPayload.decision_sha256 = sha256Canonical({ contract_sha256, marker: "projection-canonical" });
  const decisionId = `autonomy-decision-${decisionPayload.decision_sha256.slice(0, 32)}`;
  decisionPayload.decision_id = decisionId;
  const accepted = { ...event(6, "evaluation.accepted", { ...evaluation, hypothesis_id: diagnosis.id }, refs, { actor: "evaluator", correlation_id: `${RUN_ID}:evaluation.accepted` }), id: "evaluation-6" };
  const gate = { ...event(7, "diagnosis.gate.passed", {
    version: "flowpulse.checkout-payment-backtest.v2",
    harness: {
      version: "flowpulse.harness.v1", manifest_sha256: "9".repeat(64),
      model: { id: "gpt-5.6", reasoning_effort: "medium", store: false },
      skills: {
        investigator: { id: "flowpulse-investigator", version: "v1", sha256: "1".repeat(64) },
        evaluator: { id: "flowpulse-adversarial-evaluator", version: "v1", sha256: "2".repeat(64) }
      },
      protocols: { sha256: "3".repeat(64), tool_protocol_sha256: "4".repeat(64), investigator_evaluator_handoff_sha256: "5".repeat(64), owner_repair_sha256: "6".repeat(64), safe_failure_sha256: "7".repeat(64) }
    },
    snapshot: { id: "snapshot-projection", mode: "frozen_real_otlp_snapshot", content_sha256: "d".repeat(64), source_sha256: "8".repeat(64) },
    accepted: { diagnosis, evaluation, evidence_ids: refs, evidence_bindings: [evidenceBinding] },
    rejected: null,
    repair_contract: { repair_id: contract.repair_id, action: contract.action, command_id: contract.command_id, target: contract.target },
    candidate_sha256: "7".repeat(64)
  }, refs, { correlation_id: `${RUN_ID}:diagnosis.gate.passed` }), id: "gate-7" };
  decisionPayload.authority_evidence.evaluator.payload_sha256 = accepted.payload_sha256;
  decisionPayload.authority_evidence.diagnosis_gate.payload_sha256 = gate.payload_sha256;
  const decision = { ...event(8, "autonomy.decision.recorded", decisionPayload, refs, { actor: "authority-composition", correlation_id: decisionId }), id: decisionId };
  const proposalPayload = { ...contract, bounded: true, decision_id: decision.id, contract_sha256 };
  const proposal = { ...event(9, "repair.proposed", proposalPayload, refs, { actor: "authority-composition", correlation_id: decision.id }), id: `repair-proposed-${decisionPayload.decision_sha256.slice(0, 32)}` };
  const requestPayload = { ...contract, owner_team: "local-development", decision_id: decision.id, contract_sha256, reason: "Consequential checkout remediation requires an explicit owner decision." };
  const request = { ...event(10, "approval.requested", requestPayload, refs, { actor: "authority-composition", parent_id: proposal.id, correlation_id: decision.id }), id: `approval-request-${decisionPayload.decision_sha256.slice(0, 32)}` };
  const approvalPayload = { owner: "Owner", ...contract, scope: "local checkout container only", decision_id: decision.id, contract_sha256 };
  const approval = { ...event(11, "approval.granted", approvalPayload, refs, { actor: "owner", correlation_id: decision.id }), id: `approval-granted-${decisionPayload.decision_sha256.slice(0, 32)}` };
  const attemptPayload = { approval_id: approval.id, decision_id: decision.id, contract_sha256, contract, execution_mode: "real_local_development" };
  const attempt = { ...event(12, "repair.execution.attempted", attemptPayload, refs, { actor: "authority-composition", parent_id: approval.id, correlation_id: decision.id }), id: `repair-execution-attempt-${decisionPayload.decision_sha256.slice(0, 32)}` };
  const executionPayload = { repair_id: contract.repair_id, action: contract.action, target: contract.target, from: "on", to: "off", mode: "local-development", command_id: contract.command_id, completed_at: "2026-07-18T10:01:00.000Z", decision_id: decision.id, approval_id: approval.id, contract_sha256 };
  const execution = { ...event(13, "repair.executed", executionPayload, refs, { actor: "remediation", parent_id: attempt.id, correlation_id: decision.id }), id: `repair-executed-${decisionPayload.decision_sha256.slice(0, 32)}` };
  const verificationPayload = { schema_version: "flowpulse.canonical-verification.v1", decision_id: decision.id, execution_id: execution.id, contract_sha256, passed: true, repair_completed_at: executionPayload.completed_at, source_status: "live", flag_observed_at: "2026-07-18T10:01:30.000Z", checks: [
    { id: "flag_variant_restored", metric: "paymentUnreachable_variant", observed: "off", expected: "off", threshold: "== off", passed: true },
    { id: "fresh_checkout_payment_success", metric: "fresh_healthy_checkout_payment_traces", observed: 1, threshold: ">= 1", passed: true },
    { id: "no_fresh_resolver_failures", metric: "fresh_checkout_payment_unreachable_traces", observed: 0, threshold: "== 0", passed: true }
  ] };
  const verification = { ...event(14, "verification.completed", verificationPayload, ["ev-checkout", "ev-recovery"], { actor: "verifier", parent_id: execution.id, correlation_id: decision.id }), id: "verification-14" };
  const events = [accepted, gate, decision, proposal, request, approval, attempt, execution, verification];
  return {
    events,
    evidence: [boundRecord, { id: "ev-recovery", kind: "trace", signal: "traces", title: "Post-repair checkout success", entity: "checkout", source: "frozen", at: "2026-07-18T10:02:00.000Z", hash: "f".repeat(64), provenance: { sha256: "f".repeat(64) } }],
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
      event(5, "evaluation.rejected", { hypothesis_id: "hyp-kafka", score: 0.2, reason: "failure precedes lag" }, ["ev-checkout"], { actor: "evaluator" }),
      event(6, "plan.revised", { reason: "Inspect checkout first" }, ["ev-checkout"])
    ],
    ...overrides
  };
}

function investigationPairInput(mutate = ({ accepted, gate }) => [accepted, gate]) {
  const canonical = canonicalAuthorityEvents();
  const accepted = structuredClone(canonical.events.find((item) => item.type === "evaluation.accepted"));
  const gate = structuredClone(canonical.events.find((item) => item.type === "diagnosis.gate.passed"));
  return input({
    run: { ...input().run, mode: "development" },
    source: { mode: "frozen_real_otlp_snapshot", status: "frozen" },
    evidence: canonical.evidence,
    events: [...input().events.slice(0, 2), ...mutate({ accepted, gate })]
  });
}

function assertInvestigationPairIsNonActionable(value) {
  const projection = buildIncidentProjection(value);
  assert.equal(projection.stage_status, "non_actionable");
  assert.equal(projection.investigation.evaluator.verdict, "unavailable");
  assert.equal(projection.investigation.diagnosis_gate.status, "unavailable");
  assert.equal(projection.human_gate.status, "not_actionable");
  assert.equal(projection.action.status, "not_actionable");
  assert.equal(projection.verification.status, "not_actionable");
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
  assert.equal(second.stage_status, "non_actionable");
  assert.equal(second.why_stopped.code, "projection_sequence_invalid");
  assert.equal(JSON.stringify(first).includes("Payment calls fail."), false);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= INCIDENT_PROJECTION_LIMITS.max_serialized_bytes);
});

test("projection never upgrades malformed evaluator or diagnosis-gate payloads", () => {
  const malformed = buildIncidentProjection(input({
    events: [
      ...input().events,
      event(7, "evaluation.accepted", {}, ["ev-checkout"]),
      event(8, "diagnosis.gate.passed", {}, ["ev-checkout"])
    ]
  }));
  assert.notEqual(malformed.investigation.evaluator.verdict, "accepted");
  assert.notEqual(malformed.investigation.diagnosis_gate.status, "passed");
  assert.notEqual(malformed.stage_status, "verified");
});

test("projection treats accepted evaluation and diagnosis gate as one strict causal pair", () => {
  const reversed = investigationPairInput(({ accepted, gate }) => {
    gate.sequence = 6;
    gate.recorded_at = "2026-07-18T10:00:06.000Z";
    accepted.sequence = 7;
    accepted.recorded_at = "2026-07-18T10:00:07.000Z";
    return [gate, accepted];
  });
  const timestampReversed = investigationPairInput(({ accepted, gate }) => {
    accepted.recorded_at = "2026-07-18T10:00:08.000Z";
    gate.recorded_at = "2026-07-18T10:00:07.000Z";
    return [accepted, gate];
  });
  const duplicateAccepted = investigationPairInput(({ accepted, gate }) => {
    const duplicate = { ...structuredClone(accepted), id: "evaluation-duplicate", sequence: 7, recorded_at: "2026-07-18T10:00:07.000Z" };
    gate.sequence = 8;
    gate.recorded_at = "2026-07-18T10:00:08.000Z";
    return [accepted, duplicate, gate];
  });
  const conflictingAccepted = investigationPairInput(({ accepted, gate }) => {
    const conflict = structuredClone(accepted);
    conflict.id = "evaluation-conflict";
    conflict.sequence = 7;
    conflict.recorded_at = "2026-07-18T10:00:07.000Z";
    conflict.payload.reason = "Conflicting accepted conclusion.";
    conflict.payload_sha256 = sha256Canonical(conflict.payload);
    gate.sequence = 8;
    gate.recorded_at = "2026-07-18T10:00:08.000Z";
    return [accepted, conflict, gate];
  });
  const duplicateGate = investigationPairInput(({ accepted, gate }) => {
    const duplicate = { ...structuredClone(gate), id: "gate-duplicate", sequence: 8, recorded_at: "2026-07-18T10:00:08.000Z" };
    return [accepted, gate, duplicate];
  });
  const conflictingGate = investigationPairInput(({ accepted, gate }) => {
    const conflict = structuredClone(gate);
    conflict.id = "gate-conflict";
    conflict.sequence = 8;
    conflict.recorded_at = "2026-07-18T10:00:08.000Z";
    conflict.payload.candidate_sha256 = "f".repeat(64);
    conflict.payload_sha256 = sha256Canonical(conflict.payload);
    return [accepted, gate, conflict];
  });

  for (const attack of [reversed, timestampReversed, duplicateAccepted, conflictingAccepted, duplicateGate, conflictingGate]) {
    assertInvestigationPairIsNonActionable(attack);
  }

  const valid = buildIncidentProjection(investigationPairInput());
  assert.equal(valid.stage_status, "evaluating");
  assert.equal(valid.investigation.evaluator.verdict, "accepted");
  assert.equal(valid.investigation.diagnosis_gate.status, "passed");
  assert.equal(valid.human_gate.status, "not_required");
  assert.equal(valid.action.status, "not_started");
  assert.equal(valid.verification.status, "not_recorded");
});

test("forged execution and verification semantics cannot upgrade a canonical chain", () => {
  const canonical = canonicalAuthorityEvents();
  const forged = structuredClone(canonical);
  forged.events.find((event) => event.type === "repair.executed").payload.from = "attacker-from";
  forged.events.find((event) => event.type === "repair.executed").payload.to = "attacker-to";
  const verification = forged.events.find((event) => event.type === "verification.completed");
  verification.parent_id = "wrong-parent";
  verification.correlation_id = "wrong-correlation";
  verification.payload.source_status = "captured";
  verification.payload.checks = [{ id: "attacker-check", passed: true }];
  for (const item of forged.events) item.payload_sha256 = sha256Canonical(item.payload);
  for (const identity of Object.values(forged.chain)) {
    if (identity?.event_id) {
      const item = forged.events.find((candidate) => candidate.id === identity.event_id);
      identity.payload_sha256 = item.payload_sha256;
    }
  }
  const projection = buildIncidentProjection(input({
    run: { ...input().run, mode: "development" },
    source: { mode: "frozen_real_otlp_snapshot", status: "frozen" },
    evidence: forged.evidence,
    events: [...input().events.slice(0, 2), ...forged.events],
    authority_chain: forged.chain
  }));
  assert.equal(projection.stage_status, "non_actionable");
  assert.equal(projection.action.status, "not_actionable");
  assert.equal(projection.verification.status, "not_actionable");
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
  const canonicalInput = () => input({
    run: { ...input().run, mode: "development" },
    source: { mode: "frozen_real_otlp_snapshot", status: "frozen" },
    evidence: canonical.evidence,
    events: [...input().events.slice(0, 2), ...canonical.events],
    authority_chain: canonical.chain
  });
  const valid = buildIncidentProjection(canonicalInput());
  assert.equal(valid.stage_status, "verified", valid.why_stopped.code);
  assert.equal(valid.human_gate.status, "granted");
  assert.equal(valid.action.status, "executed");

  const reordered = structuredClone(canonical);
  reordered.events.find((event) => event.type === "approval.requested").parent_id = null;
  const relationshipDrift = buildIncidentProjection(input({ ...canonicalInput(), events: [...input().events.slice(0, 2), ...reordered.events], authority_chain: reordered.chain }));
  assert.equal(relationshipDrift.stage_status, "non_actionable");

  const payloadDrift = structuredClone(canonical);
  payloadDrift.events.find((event) => event.type === "autonomy.decision.recorded").payload.outcome = "non_actionable";
  const changedPayload = buildIncidentProjection(input({ ...canonicalInput(), events: [...input().events.slice(0, 2), ...payloadDrift.events], authority_chain: payloadDrift.chain }));
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

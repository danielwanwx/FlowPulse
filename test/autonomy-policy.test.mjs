import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import {
  AUTONOMY_SCHEMA_VERSION,
  AutonomyPolicyError,
  buildAutonomyDecisionEvent,
  buildAuthorityGateBinding,
  buildFailureLockEvent,
  buildPreauthorizationConsumptionEvent,
  canonicalDecisionHash,
  evaluateAutonomyDecision,
  failureLockKey,
  revalidateExecutionAuthority,
  resolvePreauthorization,
  sha256Canonical
} from "../src/autonomy-policy.mjs";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T14:05:00.000Z";
const HASH = (character) => character.repeat(64);

function contract(overrides = {}) {
  return {
    repair_id: "repair-low-cache-flush-v1",
    command_id: "flowpulse.simulate-cache-flush",
    target: "edge-cache",
    expected_before: "stale",
    expected_after: "fresh",
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    schema_version: "flowpulse-preauthorization.v1",
    id: "preauth-edge-cache-v1",
    policy_version: "2026-07-18",
    policy_sha256: `sha256:${HASH("c")}`,
    status: "active",
    issued_by: "authorized-owner",
    issued_at: "2026-07-18T11:00:00.000Z",
    expires_at: "2026-07-18T13:00:00.000Z",
    environment: "captured_demo",
    action_contract: contract(),
    limits: {
      max_components: 1,
      max_attempts: 1,
      require_idempotency: true,
      require_rollback: true,
      require_fresh_verification: true,
      require_notification_receipt: true
    },
    required_verification_check_ids: ["fresh-cache-read"],
    notification_targets: ["owner-demo"],
    ...overrides
  };
}

function registry(overrides = {}) {
  return { schema_version: "flowpulse-preauthorization-registry.v1", envelopes: [envelope()], ...overrides };
}

function gate(eventId, eventType, evidenceRefs, overrides = {}) {
  return buildAuthorityGateBinding({
    event_id: eventId,
    event_type: eventType,
    snapshot_sha256: HASH("a"),
    evidence_refs: evidenceRefs,
    ...overrides
  });
}

function authorityEvidence(overrides = {}) {
  const refs = ["ev-change", "ev-trace"];
  return {
    snapshot_sha256: HASH("a"),
    evidence_refs: refs,
    conflict_status: "none",
    deterministic_gate: gate("diagnosis-gate-1", "diagnosis.gate.passed", refs),
    evaluator_gate: gate("evaluator-gate-1", "evaluation.accepted", refs),
    ...overrides
  };
}

function input(overrides = {}) {
  const selectedContract = overrides.contract ?? contract();
  return {
    registry: overrides.registry ?? registry(),
    contract: selectedContract,
    environment: "captured_demo",
    incident_id: "inc-cache-1",
    run_id: "run-cache-1",
    snapshot_sha256: HASH("a"),
    target: selectedContract.target,
    now: NOW,
    impact: { level: "low" },
    source: { status: "captured_fixture", fresh: true },
    authority_evidence: authorityEvidence(),
    advisory: { kb_refs: ["kb-cache-runbook"], model_confidence: 1 },
    action: {
      risk: "low",
      reversible: true,
      idempotent: true,
      blast_radius_components: 1,
      rollback_ready: true,
      verification_ready: true,
      attempt_count: 1
    },
    notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
    truth_mode: "captured_simulation",
    failure_lock_events: [],
    ...overrides
  };
}

function expectPolicyError(fn, code) {
  assert.throws(fn, (error) => error instanceof AutonomyPolicyError && error.code === code);
}

test("high impact cannot auto-authorize an otherwise valid candidate", () => {
  const decision = evaluateAutonomyDecision(input({ impact: { level: "sev1" } }));
  assert.notEqual(decision.outcome, "auto_execute_pre_authorized");
  assert.equal(decision.factor_results.find((entry) => entry.id === "impact_low").passed, false);
});

test("authority evidence is hash-bound, current, deduplicated, and separate from advisory refs", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.deepEqual(decision.evidence_refs, ["ev-change", "ev-trace"]);
  assert.equal(decision.authority_evidence.deterministic_gate.event_id, "diagnosis-gate-1");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ evidence_refs: ["ev-change", "ev-change"] }) })), "authority_evidence_invalid");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ snapshot_sha256: HASH("b") }) })), "authority_snapshot_mismatch");
  expectPolicyError(() => evaluateAutonomyDecision(input({ advisory: { kb_refs: ["ev-change"], model_confidence: 1 } })), "advisory_authority_overlap");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ evidence_refs: [] }) })), "authority_evidence_invalid");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ deterministic_gate: gate("diagnosis-gate-1", "diagnosis.gate.passed", ["ev-change"]) }) })), "authority_evidence_mismatch");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ evaluator_gate: { ...authorityEvidence().evaluator_gate, event_type: "evaluation.rejected" } }) })), "authority_gate_type_mismatch");
});

test("exact registry schema rejects renamed authority fields and client selection", () => {
  assert.equal(resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract() }).id, "preauth-edge-cache-v1");
  expectPolicyError(() => resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract(), selected_ref: "forged" }), "client_preauthorization_selection_forbidden");
  const renamed = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [envelope({ notification_target_refs: ["owner-demo"] })] }) }));
  assert.ok(renamed.reason_codes.includes("preauthorization_schema_invalid"));
  const missingIssuer = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [envelope({ issued_by: undefined })] }) }));
  assert.ok(missingIssuer.reason_codes.includes("preauthorization_schema_invalid"));
});

test("every hard gate is conjunctive and a single mutation blocks captured automation", () => {
  const cases = [
    ["impact", { level: "medium" }, "impact_not_low"],
    ["source", { status: "captured_fixture", fresh: false }, "source_stale"],
    ["authority_evidence", authorityEvidence({ conflict_status: "conflicting" }), "evidence_conflicting"],
    ["action", { ...input().action, risk: "medium" }, "action_not_low_risk"],
    ["action", { ...input().action, blast_radius_components: 2 }, "blast_radius_exceeded"],
    ["action", { ...input().action, reversible: false }, "action_not_reversible_idempotent"],
    ["action", { ...input().action, rollback_ready: false }, "rollback_or_verification_not_ready"],
    ["action", { ...input().action, attempt_count: 2 }, "preauthorization_attempt_limit_exceeded"],
    ["notification", { status: "failed", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] }, "local_notification_required"],
    ["registry", registry({ envelopes: [envelope({ status: "revoked" })] }), "preauthorization_revoked"]
  ];
  for (const [field, value, reason] of cases) {
    const decision = evaluateAutonomyDecision(input({ [field]: value }));
    assert.notEqual(decision.outcome, "auto_execute_pre_authorized", `${field}:${reason}`);
    assert.ok(decision.reason_codes.includes(reason), `${field}:${decision.reason_codes.join(",")}`);
  }
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ deterministic_gate: { ...authorityEvidence().deterministic_gate, event_type: "diagnosis.gate.failed" } }) })), "authority_gate_type_mismatch");
  expectPolicyError(() => evaluateAutonomyDecision(input({ authority_evidence: authorityEvidence({ evaluator_gate: { ...authorityEvidence().evaluator_gate, event_sha256: HASH("f") } }) })), "authority_gate_hash_mismatch");
});

test("canonical decision and event builders reject any authority-field mutation", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.equal(canonicalDecisionHash(decision), decision.decision_sha256);
  const event = buildAutonomyDecisionEvent(decision);
  assert.equal(event.type, "autonomy.decision.recorded");
  const changed = structuredClone(decision);
  changed.contract.expected_after = "wrong";
  expectPolicyError(() => buildAutonomyDecisionEvent(changed), "decision_contract_hash_mismatch");
  const changedHash = structuredClone(decision);
  changedHash.decision_sha256 = HASH("f");
  expectPolicyError(() => buildAutonomyDecisionEvent(changedHash), "decision_hash_mismatch");
  for (const [path, mutate] of [
    ["incident", (value) => { value.incident_id = "inc-other"; value.binding.incident_id = "inc-other"; }],
    ["run", (value) => { value.run_id = "run-other"; value.binding.run_id = "run-other"; }],
    ["environment", (value) => { value.environment = "other"; value.binding.environment = "other"; }],
    ["snapshot", (value) => { value.snapshot_sha256 = HASH("b"); value.binding.snapshot_sha256 = HASH("b"); }],
    ["target", (value) => { value.target = "other"; value.binding.target = "other"; }],
    ["policy", (value) => { value.policy_sha256 = `sha256:${HASH("b")}`; }],
    ["envelope", (value) => { value.envelope_sha256 = HASH("b"); }],
    ["authority", (value) => { value.authority_evidence.evaluator_gate.event_sha256 = HASH("b"); }]
  ]) {
    const mutated = structuredClone(decision);
    mutate(mutated);
    assert.notEqual(canonicalDecisionHash(mutated), decision.decision_sha256, path);
    assert.throws(() => buildAutonomyDecisionEvent(mutated), AutonomyPolicyError, path);
  }
  assert.deepEqual(event.payload.authority_evidence.evidence_refs, ["ev-change", "ev-trace"]);
  assert.equal(Object.hasOwn(event.payload, "advisory"), false);
});

test("malformed or contradictory incident locks fail closed", () => {
  const valid = evaluateAutonomyDecision(input());
  const malformed = {
    type: "autonomy.locked",
    incident_id: valid.incident_id,
    payload: { incident_id: valid.incident_id, contract_sha256: valid.contract_sha256, target: valid.target, lock_key: "not-a-valid-lock" }
  };
  const decision = evaluateAutonomyDecision(input({ failure_lock_events: [malformed] }));
  assert.equal(decision.outcome, "blocked");
  assert.ok(decision.reason_codes.includes("failure_lock_state_unavailable"));
  const lock = buildFailureLockEvent({ decision: valid, failed_event_ref: "repair-failed-1", reason_code: "verification_failed" });
  const locked = evaluateAutonomyDecision(input({ failure_lock_events: [lock] }));
  assert.ok(locked.reason_codes.includes("autonomy_failure_locked"));
  assert.equal(failureLockKey({ incident_id: valid.incident_id, contract_sha256: valid.contract_sha256, target: valid.target }), lock.id);
});

test("consumption identity is internal, cross-run single-use, and cannot be overridden", () => {
  const first = evaluateAutonomyDecision(input());
  const second = evaluateAutonomyDecision(input({ run_id: "run-cache-2" }));
  const firstEvent = buildPreauthorizationConsumptionEvent({ decision: first });
  const secondEvent = buildPreauthorizationConsumptionEvent({ decision: second });
  assert.equal(firstEvent.id, secondEvent.id);
  assert.equal(firstEvent.runId, "run-cache-1");
  expectPolicyError(() => buildPreauthorizationConsumptionEvent({ decision: first, claim_id: "forged" }), "consumption_input_invalid");
  expectPolicyError(() => buildPreauthorizationConsumptionEvent({ decision: first, run_id: "forged-run" }), "consumption_input_invalid");
});

test("independent concurrent writers preserve one immutable consumption winner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-"));
  const path = join(directory, "ledger.sqlite");
  new Ledger(path);
  const one = buildPreauthorizationConsumptionEvent({ decision: evaluateAutonomyDecision(input()) });
  const two = buildPreauthorizationConsumptionEvent({ decision: evaluateAutonomyDecision(input({ run_id: "run-cache-2" })) });
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = [one, two].map((event) => startClaimWorker({ path, event, gate }));
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.inserted).length, 1);
  const ledger = new Ledger(path);
  const stored = ledger.get(one.id);
  assert.equal(stored.payload.decision_sha256, results.find((result) => result.inserted).event.payload.decision_sha256);
  assert.equal(ledger.list("run-cache-1").filter((entry) => entry.type === "preauthorization.consumed").length + ledger.list("run-cache-2").filter((entry) => entry.type === "preauthorization.consumed").length, 1);
});

test("pure policy neither freezes nor mutates caller-owned nested objects", () => {
  const source = input();
  const before = structuredClone(source);
  evaluateAutonomyDecision(source);
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(source.notification), false);
  source.notification.status = "failed";
  assert.equal(source.notification.status, "failed");
});

test("captured simulation stays distinct from execution and future live revalidation", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.equal(decision.schema_version, AUTONOMY_SCHEMA_VERSION);
  assert.equal(decision.action_event_type, "action.simulated");
  assert.equal(decision.execution.satisfies_live_production_gate, false);
  assert.equal(decision.execution.satisfies_executed_offline_backtest, false);
  const revalidated = revalidateExecutionAuthority({ decision, registry: registry(), now: LATER, source: { status: "live", fresh: true }, failure_lock_events: [], executor_enabled: true });
  assert.equal(revalidated.passed, false);
  assert.ok(revalidated.reason_codes.includes("preauthorization_expired"));
  const revoked = revalidateExecutionAuthority({ decision, registry: registry({ envelopes: [envelope({ status: "revoked" })] }), now: NOW, source: { status: "live", fresh: true }, failure_lock_events: [], executor_enabled: true });
  assert.ok(revoked.reason_codes.includes("preauthorization_revoked"));
});

function startClaimWorker({ path, event, gate }) {
  const worker = new Worker(new URL("./helpers/autonomy-claim-worker.mjs", import.meta.url), { workerData: { path, event, gate } });
  let readyResolve;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`claim worker exited ${code}`)); });
  });
  worker.on("message", (message) => {
    if (message.ready) readyResolve();
    if (message.result) resultResolve(message.result);
    if (message.error) resultReject(new Error(message.error));
  });
  return { ready, result };
}

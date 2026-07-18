import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import {
  AUTONOMY_SCHEMA_VERSION,
  AutonomyPolicyError,
  buildAutonomyDecisionEvent,
  buildFailureLockEvent,
  buildPreauthorizationConsumptionEvent,
  evaluateAutonomyDecision,
  hasFailureLock,
  preauthorizationClaimId,
  revalidateExecutionAuthority,
  resolvePreauthorization,
  sha256Canonical
} from "../src/autonomy-policy.mjs";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T14:05:00.000Z";

function contract(overrides = {}) {
  return {
    repair_id: "repair-low-cache-flush-v1",
    action: "flush bounded stale edge cache",
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
    policy_sha256: "c".repeat(64),
    status: "active",
    issued_at: "2026-07-18T11:00:00.000Z",
    expires_at: "2026-07-18T13:00:00.000Z",
    environment: "captured_demo",
    action_contract: contract(),
    limits: {
      max_components: 1,
      max_attempts: 1,
      reversible: true,
      idempotent: true,
      rollback_ready: true,
      verification_ready: true,
      notification_required: true
    },
    required_verification_check_ids: ["fresh-cache-read"],
    notification_target_refs: ["owner-demo"],
    ...overrides
  };
}

function registry(overrides = {}) {
  return {
    schema_version: "flowpulse-preauthorization-registry.v1",
    envelopes: [envelope()],
    ...overrides
  };
}

function input(overrides = {}) {
  const selectedContract = overrides.contract ?? contract();
  const selectedRegistry = overrides.registry ?? registry();
  return {
    registry: selectedRegistry,
    contract: selectedContract,
    environment: "captured_demo",
    incident_id: "inc-cache-1",
    run_id: "run-cache-1",
    snapshot_sha256: "a".repeat(64),
    target: selectedContract.target,
    now: NOW,
    source: { status: "captured_fixture", fresh: true },
    evidence: {
      complete: true,
      fresh: true,
      conflicting: false,
      diagnosis_gate_passed: true,
      evaluator_accepted: true
    },
    action: {
      risk: "low",
      reversible: true,
      idempotent: true,
      blast_radius_components: 1,
      rollback_ready: true,
      verification_ready: true
    },
    notification: { status: "recorded_local", delivery_mode: "captured_simulation" },
    truth_mode: "captured_simulation",
    failure_lock_events: [],
    ...overrides
  };
}

function expectPolicyError(fn, code) {
  assert.throws(fn, (error) => error instanceof AutonomyPolicyError && error.code === code);
}

test("Slice 0 red foundation: autonomy policy module is required", () => {
  assert.equal(AUTONOMY_SCHEMA_VERSION, "flowpulse.autonomy.v1");
});

test("code-owned registry resolves the exact envelope and rejects forged selection", () => {
  const found = resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract() });
  assert.equal(found.id, "preauth-edge-cache-v1");
  expectPolicyError(
    () => resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract(), selected_ref: "forged" }),
    "client_preauthorization_selection_forbidden"
  );
  expectPolicyError(
    () => resolvePreauthorization({ registry: registry({ envelopes: [envelope(), envelope({ id: "duplicate" })] }), environment: "captured_demo", contract: contract() }),
    "preauthorization_ambiguous"
  );
  expectPolicyError(
    () => resolvePreauthorization({ registry: registry({ schema_version: "unknown" }), environment: "captured_demo", contract: contract() }),
    "preauthorization_registry_version_invalid"
  );
  const outOfScope = envelope({ limits: { ...envelope().limits, max_components: 2 } });
  const blocked = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [outOfScope] }) }));
  assert.ok(blocked.reason_codes.includes("preauthorization_scope_invalid"));
});

test("severity, model confidence, and advisory knowledge never grant autonomy", () => {
  const blocked = evaluateAutonomyDecision(input({
    severity: "sev1",
    model_confidence: 1,
    advisory_kb_refs: ["kb-strong-prior"],
    evidence: { complete: false, fresh: false, conflicting: true, diagnosis_gate_passed: false, evaluator_accepted: false }
  }));
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.factor_results.find((factor) => factor.id === "evidence_complete").passed, false);
  assert.equal(blocked.factor_results.some((factor) => factor.id === "model_confidence"), false);
  assert.equal(blocked.factor_results.some((factor) => factor.id === "advisory_kb"), false);
});

test("missing, stale, or conflicting evidence blocks the captured low-risk simulation", () => {
  for (const evidence of [
    { complete: false, fresh: true, conflicting: false, diagnosis_gate_passed: true, evaluator_accepted: true },
    { complete: true, fresh: false, conflicting: false, diagnosis_gate_passed: true, evaluator_accepted: true },
    { complete: true, fresh: true, conflicting: true, diagnosis_gate_passed: true, evaluator_accepted: true }
  ]) {
    const decision = evaluateAutonomyDecision(input({ evidence }));
    assert.equal(decision.outcome, "blocked");
    assert.equal(decision.action_event_type, null);
  }
  const unknownLockState = input();
  delete unknownLockState.failure_lock_events;
  const lockBlocked = evaluateAutonomyDecision(unknownLockState);
  assert.ok(lockBlocked.reason_codes.includes("failure_lock_state_unavailable"));
});

test("envelope bindings mutate deterministically and post-decision expiry or revocation blocks revalidation", () => {
  const base = input();
  const decision = evaluateAutonomyDecision(base);
  assert.equal(decision.outcome, "auto_execute_pre_authorized");
  for (const field of ["incident_id", "run_id", "snapshot_sha256"]) {
    const changed = { ...base, [field]: field === "snapshot_sha256" ? "b".repeat(64) : `${base[field]}-other` };
    const next = evaluateAutonomyDecision(changed);
    assert.notEqual(next.binding_sha256, decision.binding_sha256);
  }
  const environmentEnvelope = envelope({ environment: "captured_demo_other" });
  const environmentDecision = evaluateAutonomyDecision(input({ environment: "captured_demo_other", registry: registry({ envelopes: [environmentEnvelope] }) }));
  assert.notEqual(environmentDecision.binding_sha256, decision.binding_sha256);
  const changedContract = contract({ target: "other-cache" });
  const changedTarget = evaluateAutonomyDecision(input({ contract: changedContract, target: changedContract.target, registry: registry({ envelopes: [envelope({ action_contract: changedContract })] }) }));
  assert.notEqual(changedTarget.binding_sha256, decision.binding_sha256);
  assert.notEqual(changedTarget.contract_sha256, decision.contract_sha256);
  const changedEnvelope = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [envelope({ policy_sha256: "d".repeat(64) })] }) }));
  assert.notEqual(changedEnvelope.envelope_sha256, decision.envelope_sha256);
  const expired = revalidateExecutionAuthority({ ...base, now: LATER, executor_enabled: true });
  assert.equal(expired.passed, false);
  assert.ok(expired.reason_codes.includes("preauthorization_expired"));
  const revoked = revalidateExecutionAuthority({ ...base, registry: registry({ envelopes: [envelope({ status: "revoked" })] }), executor_enabled: true });
  assert.equal(revoked.passed, false);
  assert.ok(revoked.reason_codes.includes("preauthorization_revoked"));
});

test("deterministic consumption keys yield one appendIfAbsent winner across concurrent and cross-run claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-"));
  const firstLedger = new Ledger(join(directory, "ledger.sqlite"));
  const secondLedger = new Ledger(join(directory, "ledger.sqlite"));
  const decision = evaluateAutonomyDecision(input());
  const claim = preauthorizationClaimId({
    incident_id: decision.incident_id,
    contract_sha256: decision.contract_sha256,
    envelope_sha256: decision.envelope_sha256
  });
  const event = buildPreauthorizationConsumptionEvent({ claim_id: claim, decision, run_id: "run-cache-1" });
  const [first, replay] = await Promise.all([
    Promise.resolve().then(() => firstLedger.appendIfAbsent(event)),
    Promise.resolve().then(() => secondLedger.appendIfAbsent({ ...event, runId: "run-cache-2", correlationId: "other-correlation" }))
  ]);
  assert.equal([first, replay].filter((result) => result.inserted).length, 1);
  assert.equal(first.event.id, replay.event.id);
  assert.equal(firstLedger.list("run-cache-1").filter((entry) => entry.type === "preauthorization.consumed").length, 1);
  assert.equal(secondLedger.list("run-cache-2").length, 0);
});

test("a failure lock is keyed across runs by incident, exact contract, and target", () => {
  const decision = evaluateAutonomyDecision(input());
  const lock = buildFailureLockEvent({ decision, failed_event_ref: "repair-failed-1", reason_code: "verification_failed" });
  assert.equal(hasFailureLock({ events: [lock], incident_id: decision.incident_id, contract_sha256: decision.contract_sha256, target: decision.target }), true);
  assert.equal(hasFailureLock({ events: [lock], incident_id: decision.incident_id, contract_sha256: decision.contract_sha256, target: "other-cache" }), false);
  const blocked = revalidateExecutionAuthority({ ...input(), failure_lock_events: [lock], executor_enabled: true });
  assert.equal(blocked.passed, false);
  assert.ok(blocked.reason_codes.includes("autonomy_failure_locked"));
});

test("execution-time revalidation is stricter than a recorded decision", () => {
  const stale = revalidateExecutionAuthority({ ...input(), source: { status: "stale", fresh: false }, executor_enabled: true });
  assert.equal(stale.passed, false);
  assert.ok(stale.reason_codes.includes("source_stale"));
  assert.ok(stale.reason_codes.includes("live_source_required"));
  const consumed = revalidateExecutionAuthority({ ...input(), already_consumed: true, executor_enabled: true });
  assert.equal(consumed.passed, false);
  assert.ok(consumed.reason_codes.includes("preauthorization_already_consumed"));
});

test("captured simulation and recorded-local notification cannot become execution or delivery authority", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.equal(decision.action_event_type, "action.simulated");
  assert.equal(decision.execution.truth_mode, "captured_simulation");
  assert.equal(decision.execution.receipt_type, null);
  assert.equal(decision.notification.status, "recorded_local");
  assert.equal(decision.notification.delivery_mode, "captured_simulation");
  assert.equal(decision.execution.satisfies_live_production_gate, false);
  assert.equal(decision.execution.satisfies_executed_offline_backtest, false);
  const event = buildAutonomyDecisionEvent(decision);
  assert.equal(event.type, "autonomy.decision.recorded");
  assert.notEqual(event.payload.action_event_type, "repair.executed");
  assert.notEqual(event.payload.notification.status, "delivered_external");
});

test("pure policy preserves caller input and serializes a bounded v1 decision", () => {
  const source = input();
  const before = structuredClone(source);
  const decision = evaluateAutonomyDecision(source);
  assert.deepEqual(source, before);
  assert.equal(decision.schema_version, AUTONOMY_SCHEMA_VERSION);
  assert.equal(sha256Canonical(decision.binding), decision.binding_sha256);
  assert.ok(Buffer.byteLength(JSON.stringify(buildAutonomyDecisionEvent(decision).payload), "utf8") < 12 * 1024);
});

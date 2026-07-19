import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { DevelopmentRuntime, evaluateDevelopmentPolicy } from "../src/development-runtime.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";
import { LiveOtlpEvidenceSource, versionedChangeEvidence } from "../src/evidence-source.mjs";
import { PINNED_CHECKOUT_CODE_SPEC } from "../src/code-evidence.mjs";
import { buildDiagnosisBacktestSeed, createDevelopmentRegressionArtifact, runDevelopmentBacktest, sha256 } from "../src/regression-backtest.mjs";

test("real-development loop rejects weak blame, gates rollback, then verifies fresh evidence", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-")), "ledger.db")),
    bundle: loadBundle()
  });
  let repaired = false;
  let flagVariant = "on";
  const source = {
    async project() {
      return {
        status: "live",
        evidence: repaired ? [healthyEvidence()] : failureEvidenceSet()
      };
    }
  };
  const adapter = {
    async applyDevelopmentCase() {
      return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test flag API" };
    },
    async executeApprovedRollback({ commandId }) {
      repaired = true;
      flagVariant = "off";
      return { command_id: commandId, completed_at: "2026-07-17T12:01:00.000Z", stdout: "checkout recreated", stderr: "" };
    },
    async readAllowlistedFlagVariant() { return { flag: "paymentUnreachable", variant: flagVariant, observed_at: "2026-07-17T12:01:31.000Z", source: "test flag API" }; }
  };
  const development = new DevelopmentRuntime({ runtime, source, adapter });
  const runId = await development.start();
  await development.investigate(runId, diagnosisSnapshot(runtime, runId));

  let state = development.state(runId);
  assert.equal(state.waiting_for_approval, true);
  assert.equal(state.events.some((event) => event.type === "evaluation.rejected" && event.payload.hypothesis_id === "hyp-payment-service"), true);
  assert.equal(state.events.some((event) => event.type === "repair.executed"), false);

  await development.approve(runId, "Test development owner");
  await development.verify(runId);
  state = development.state(runId);
  assert.equal(state.complete, true);
  assert.equal(state.events.find((event) => event.type === "repair.executed").payload.mode, "local-development");
  const verification = state.events.find((event) => event.type === "verification.completed");
  assert.equal(verification.payload.passed, true);
  assert.deepEqual(verification.payload.checks, [
    { id: "flag_variant_restored", metric: "paymentUnreachable_variant", observed: "off", expected: "off", threshold: "== off", passed: true },
    { id: "fresh_checkout_payment_success", metric: "fresh_healthy_checkout_payment_traces", observed: 1, threshold: ">= 1", passed: true },
    { id: "no_fresh_resolver_failures", metric: "fresh_checkout_payment_unreachable_traces", observed: 0, threshold: "== 0", passed: true }
  ]);
  const policy = state.events.find((event) => event.type === "policy.evaluated");
  const backtest = state.events.find((event) => event.type === "backtest.completed");
  assert.equal(backtest.payload.passed, true, JSON.stringify(state.events.find((event) => event.type === "regression.created").payload.artifact));
  const { harness, ...policyWithoutHarness } = policy.payload;
  assert.equal(harness?.version, "flowpulse.harness.v1");
  assert.match(harness?.manifest_sha256 || "", /^[a-f0-9]{64}$/);
  assert.deepEqual(policyWithoutHarness, {
    candidate: "live-evidence-policy-v1",
    passed: true,
    promotion: "eligible_for_owner_review",
    gates: [
      { id: "approval_before_repair", label: "Owner approval precedes repair execution", passed: true },
      { id: "allowlisted_repair_contract", label: "Every repair control event matches the checked-in contract", passed: true },
      { id: "flag_variant_restored", label: "paymentUnreachable_variant", passed: true },
      { id: "fresh_checkout_payment_success", label: "fresh_healthy_checkout_payment_traces", passed: true },
      { id: "no_fresh_resolver_failures", label: "fresh_checkout_payment_unreachable_traces", passed: true },
      { id: "regression_artifact", label: "A versioned immutable regression artifact exists", passed: true },
      { id: "executed_offline_backtest", label: "A matching deterministic offline backtest recomputed and passed", passed: true }
    ]
  });
});

test("verification rejects a healthy trace while the allowlisted flag remains on", async () => {
  const { development, runId } = await approvedDevelopment({
    flagVariant: "on",
    recoveredEvidence: [healthyEvidence()]
  });
  await assert.rejects(() => development.verify(runId), /verification failed/);
  assertFailedVerification(development.state(runId), "flag_variant_restored", "repair_failure");
});

test("verification rejects when a fresh checkout-to-payment resolver failure remains", async () => {
  const { development, runId } = await approvedDevelopment({
    flagVariant: "off",
    recoveredEvidence: [healthyEvidence(), failureEvidence("2026-07-17T12:01:31.000Z")]
  });
  await assert.rejects(() => development.verify(runId), /verification failed/);
  assertFailedVerification(development.state(runId), "no_fresh_resolver_failures", "repair_failure");
});

test("verification rejects stale pre-repair evidence", async () => {
  const { development, runId } = await approvedDevelopment({
    flagVariant: "off",
    recoveredEvidence: [healthyEvidence("2026-07-17T12:00:59.999Z")]
  });
  await assert.rejects(() => development.verify(runId), /verification failed/);
  assertFailedVerification(development.state(runId), "fresh_checkout_payment_success", "repair_failure");
});

test("verification rejects a stale flag observation", async () => {
  const { development, runId } = await approvedDevelopment({
    recoveredEvidence: [healthyEvidence()],
    readFlag: async () => ({ flag: "paymentUnreachable", variant: "off", observed_at: "2026-07-17T12:00:59.999Z", source: "test flag API" })
  });
  await assert.rejects(() => development.verify(runId), /flag state/);
  assertFailedVerification(development.state(runId), "flag_variant_restored", "tool_data_failure");
});

test("verification classifies an unavailable allowlisted flag read as tool data failure", async () => {
  const { development, runId } = await approvedDevelopment({
    recoveredEvidence: [healthyEvidence()],
    readFlag: async () => { throw new Error("flag API unavailable"); }
  });
  await assert.rejects(() => development.verify(runId), /flag state/);
  const events = development.state(runId).events;
  assert.equal(events.find((event) => event.type === "verification.completed").payload.passed, false);
  assert.equal(events.find((event) => event.type === "outcome.classified").payload.classification, "tool_data_failure");
  assert.equal(events.some((event) => event.type === "regression.created" || event.type === "policy.evaluated"), false);
});

test("verification classifies a fulfilled disconnected source as tool data failure", async () => {
  const { development, runId } = await approvedDevelopment({
    recoveredEvidence: [],
    sourceStatus: "disconnected"
  });
  await assert.rejects(() => development.verify(runId), /telemetry source is unavailable/);
  const events = development.state(runId).events;
  assert.equal(events.find((event) => event.type === "verification.completed").payload.passed, false);
  assert.equal(events.find((event) => event.type === "outcome.classified").payload.classification, "tool_data_failure");
  assert.equal(events.some((event) => event.type === "regression.created" || event.type === "policy.evaluated"), false);
});

test("development policy blocks missing, mismatched, or reversed repair control events", () => {
  const contract = expectedRepairContract();
  const verification = successfulVerificationEvent(50);
  const valid = [
    contractEvent("repair.proposed", 10, contract),
    contractEvent("approval.requested", 20, contract),
    contractEvent("approval.granted", 30, contract),
    contractEvent("repair.executed", 40, contract),
    verification
  ];

  const missing = evaluateDevelopmentPolicy(valid.filter((event) => event.type !== "approval.granted"), contract);
  assertPolicyBlocked(missing, "approval_before_repair");
  assertPolicyBlocked(missing, "allowlisted_repair_contract");

  const mismatched = evaluateDevelopmentPolicy(valid.map((event) => event.type === "repair.executed"
    ? contractEvent(event.type, event.sequence, { ...contract, command_id: "unrelated.command" })
    : event), contract);
  assertPolicyBlocked(mismatched, "allowlisted_repair_contract");

  const reversed = evaluateDevelopmentPolicy(valid.map((event) => event.type === "approval.granted"
    ? contractEvent(event.type, 41, contract)
    : event), contract);
  assertPolicyBlocked(reversed, "approval_before_repair");
});

test("executed offline backtest recomputes immutable evidence, repair, ordering, and recovery gates", async () => {
  const { development, runId } = await approvedDevelopment({ recoveredEvidence: [healthyEvidence()] });
  await development.verify(runId);
  const events = development.state(runId).events;
  const regression = events.find((event) => event.type === "regression.created");
  const contract = expectedRepairContract();
  assert.equal(events.find((event) => event.type === "backtest.completed").payload.source, "executed_offline_backtest");
  assert.equal(runDevelopmentBacktest({ artifact: regression.payload.artifact, events, repairContract: contract }).passed, true);

  const missingEvidence = structuredClone(regression.payload.artifact);
  missingEvidence.diagnosis.accepted.evidence_bindings.pop();
  assert.equal(runDevelopmentBacktest({ artifact: missingEvidence, events, repairContract: contract }).passed, false);

  const corruptContract = structuredClone(regression.payload.artifact);
  corruptContract.repair_contract.command_id = "unrelated.command";
  assert.equal(runDevelopmentBacktest({ artifact: corruptContract, events, repairContract: contract }).passed, false);

  const reversed = events.map((event) => event.type === "approval.granted" ? { ...event, sequence: 9_999 } : event);
  assert.equal(runDevelopmentBacktest({ artifact: regression.payload.artifact, events: reversed, repairContract: contract }).passed, false);

  const recoveryFailed = events.map((event) => event.type === "verification.completed"
    ? { ...event, payload: { ...event.payload, passed: false, checks: event.payload.checks.map((check) => check.id === "no_fresh_resolver_failures" ? { ...check, passed: false } : check) } }
    : event);
  assert.equal(runDevelopmentBacktest({ artifact: regression.payload.artifact, events: recoveryFailed, repairContract: contract }).passed, false);

  const missingVerificationRef = events.map((event) => event.type === "verification.completed"
    ? { ...event, evidence_refs: event.evidence_refs.slice(1) }
    : event);
  assert.equal(runDevelopmentBacktest({ artifact: regression.payload.artifact, events: missingVerificationRef, repairContract: contract }).passed, false);

  const reversedRegressionBacktest = events.map((event) => event.type === "regression.created" ? { ...event, sequence: 9_999 } : event);
  assertPolicyBlocked(evaluateDevelopmentPolicy(reversedRegressionBacktest, contract), "executed_offline_backtest");
});

test("rehashable recovery receipt mutations cannot pass the deterministic backtest or policy", async () => {
  const { development, runId } = await approvedDevelopment({ recoveredEvidence: [healthyEvidence()] });
  await development.verify(runId);
  const originalEvents = development.state(runId).events;
  const originalArtifact = originalEvents.find((event) => event.type === "regression.created").payload.artifact;
  const contract = expectedRepairContract();
  const cases = [
    ["flag remains on", (payload) => ({
      ...payload,
      passed: true,
      checks: payload.checks.map((check) => check.id === "flag_variant_restored" ? { ...check, observed: "on", passed: true } : check)
    })],
    ["no healthy checkout payment trace", (payload) => ({
      ...payload,
      passed: true,
      checks: payload.checks.map((check) => check.id === "fresh_checkout_payment_success" ? { ...check, observed: 0, passed: true } : check)
    })],
    ["a resolver failure remains", (payload) => ({
      ...payload,
      passed: true,
      checks: payload.checks.map((check) => check.id === "no_fresh_resolver_failures" ? { ...check, observed: 1, passed: true } : check)
    })],
    ["flag observation is stale", (payload) => ({ ...payload, passed: true, flag_observed_at: payload.repair_completed_at })],
    ["receipt source is not live", (payload) => ({ ...payload, passed: true, source_status: "captured" })],
    ["recorded booleans deny an otherwise healthy receipt", (payload) => ({
      ...payload,
      passed: false,
      checks: payload.checks.map((check) => check.id === "flag_variant_restored" ? { ...check, passed: false } : check)
    })]
  ];

  for (const [name, mutate] of cases) {
    const events = replaceVerification(originalEvents, mutate);
    const verification = events.find((event) => event.type === "verification.completed");
    const artifact = rehashedArtifact(originalArtifact, verification);
    const backtest = runDevelopmentBacktest({ artifact, events, repairContract: contract });
    assert.equal(backtest.passed, false, name);
    const policyEvents = replaceRegressionAndBacktest(events, artifact, backtest);
    assertPolicyBlocked(evaluateDevelopmentPolicy(policyEvents, contract), "executed_offline_backtest");
  }
});

test("policy rejects a forged passed backtest when one internal gate is false", async () => {
  const { development, runId } = await approvedDevelopment({ recoveredEvidence: [healthyEvidence()] });
  await development.verify(runId);
  const contract = expectedRepairContract();
  const forged = development.state(runId).events.map((event) => event.type === "backtest.completed"
    ? {
      ...event,
      payload: {
        ...event.payload,
        passed: true,
        gates: event.payload.gates.map((gate) => gate.id === "fresh_recovery_checks" ? { ...gate, passed: false } : gate)
      }
    }
    : event);
  assertPolicyBlocked(evaluateDevelopmentPolicy(forged, contract), "executed_offline_backtest");
});

test("policy requires executed source, matching version/hash, and one passed instance of every backtest gate", async () => {
  const { development, runId } = await approvedDevelopment({ recoveredEvidence: [healthyEvidence()] });
  await development.verify(runId);
  const events = development.state(runId).events;
  const contract = expectedRepairContract();
  const current = events.find((event) => event.type === "backtest.completed").payload;
  const variants = [
    { ...current, source: "captured_fixture" },
    { ...current, version: "flowpulse.checkout-payment-backtest.v0" },
    { ...current, artifact_sha256: "0".repeat(64) },
    { ...current, gates: [...current.gates, current.gates[0]] }
  ];
  for (const payload of variants) {
    const mutated = events.map((event) => event.type === "backtest.completed" ? { ...event, payload } : event);
    assertPolicyBlocked(evaluateDevelopmentPolicy(mutated, contract), "executed_offline_backtest");
  }
});

test("a rehashed regression with a different harness contract fails backtest and blocks policy", async () => {
  const { development, runId } = await approvedDevelopment({ recoveredEvidence: [healthyEvidence()] });
  await development.verify(runId);
  const events = development.state(runId).events;
  const original = events.find((event) => event.type === "regression.created").payload.artifact;
  const artifact = structuredClone(original);
  artifact.harness.manifest_sha256 = "f".repeat(64);
  const { artifact_sha256: _artifactHash, case_sha256: _caseHash, ...unsigned } = artifact;
  artifact.artifact_sha256 = sha256(unsigned);
  artifact.case_sha256 = sha256({
    version: artifact.version,
    artifact_sha256: artifact.artifact_sha256,
    candidate_sha256: artifact.diagnosis.candidate_sha256,
    capture_sha256: artifact.capture.sha256,
    harness_sha256: artifact.harness.manifest_sha256
  });
  const backtest = runDevelopmentBacktest({ artifact, events, repairContract: expectedRepairContract() });
  assert.equal(backtest.gates.find((gate) => gate.id === "harness_contract_binding").passed, false);
  assert.equal(backtest.passed, false);
  assertPolicyBlocked(evaluateDevelopmentPolicy(replaceRegressionAndBacktest(events, artifact, backtest), expectedRepairContract()), "executed_offline_backtest");
});

test("policy is blocked until a matching executed offline backtest exists", () => {
  const contract = expectedRepairContract();
  const events = [
    contractEvent("repair.proposed", 10, contract),
    contractEvent("approval.requested", 20, contract),
    contractEvent("approval.granted", 30, contract),
    contractEvent("repair.executed", 40, contract),
    successfulVerificationEvent(50)
  ];
  const policy = evaluateDevelopmentPolicy(events, contract);
  assertPolicyBlocked(policy, "regression_artifact");
  assertPolicyBlocked(policy, "executed_offline_backtest");
});

test("executable GPT backtest seed requires the independently rejected initial hypothesis", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-backtest-seed-")), "ledger.db")), bundle: loadBundle() });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } };
  const development = new DevelopmentRuntime({ runtime, source: { async project() { return { status: "live", evidence: failureEvidenceSet() }; } }, adapter });
  const runId = await development.start();
  const snapshot = diagnosisSnapshot(runtime, runId);
  const contract = expectedRepairContract();
  const accepted = {
    id: "hyp-live-payment-flag", title: "Exact", claim: "Exact", confidence: 0.9, initiating_change: "change", failure_mechanism: "resolver", propagation: [],
    evidence_refs: snapshot.metadata().reserved_causal_ids,
    proposed_repair: { ...contract, reason: "bounded" }
  };
  const evaluation = { accepted: true, score: 0.9, classification: "confirmed_system_bug", phase: "diagnosis_pre_approval", gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true }, reason: "exact", missing_evidence: [], counter_evidence_refs: accepted.evidence_refs };
  assert.throws(() => buildDiagnosisBacktestSeed({ evidenceSource: snapshot, diagnosis: accepted, evaluation, repairContract: contract }), /rejected initial hypothesis/);
});

test("development start records the real flag-off baseline and pinned implementation semantics before applying the change", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-preflight-")), "ledger.db")), bundle: loadBundle() });
  let applied = false;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: "live", evidence: [baselineEvidence()] }; } },
    adapter: {
      async developmentChangeManifest() { return change(); },
      async readAllowlistedFlagVariant() { return { flag: "paymentUnreachable", variant: "off", observed_at: "2026-07-17T12:00:00.000Z", source: "test flag API" }; },
      async readPinnedCheckoutCodeEvidence() { return codeEvidence(); },
      async applyDevelopmentCase() { applied = true; return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; }
    }
  });
  const runId = await development.start();
  assert.equal(applied, true);
  const events = runtime.ledger.list(runId);
  const baselineCapture = events.find((event) => event.type === "diagnosis.baseline.captured");
  const codeCapture = events.find((event) => event.type === "code.semantics.captured");
  assert.deepEqual(baselineCapture.evidence_refs, ["live-tra-baseline"]);
  assert.equal(baselineCapture.payload.evidence.value.trace.feature_flag.variant, "off");
  assert.equal(Object.hasOwn(baselineCapture.payload.evidence, "payload"), false);
  assert.equal(JSON.stringify(baselineCapture.payload.evidence).includes("raw"), false);
  assert.deepEqual(codeCapture.evidence_refs, [`code-${PINNED_CHECKOUT_CODE_SPEC.content_sha256.slice(0, 16)}`]);
  assert.equal(codeCapture.payload.evidence.value.code.commit, PINNED_CHECKOUT_CODE_SPEC.commit);
  assert.equal(Object.hasOwn(codeCapture.payload.evidence, "payload"), false);
});

test("development start fails closed before applying a change when the real flag-off baseline is absent", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-no-baseline-")), "ledger.db")), bundle: loadBundle() });
  let applied = false;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: "live", evidence: [] }; } },
    adapter: {
      async developmentChangeManifest() { return change(); },
      async readAllowlistedFlagVariant() { return { flag: "paymentUnreachable", variant: "off", observed_at: "2026-07-17T12:00:00.000Z", source: "test flag API" }; },
      async readPinnedCheckoutCodeEvidence() { return codeEvidence(); },
      async applyDevelopmentCase() { applied = true; return { change: change() }; }
    }
  });
  await assert.rejects(() => development.start(), /known-good checkout-to-payment baseline/);
  assert.equal(applied, false);
});

test("bounded diagnosis collection preserves three distinct failures across rolling OTLP tail projections", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-rolling-")), "ledger.db")), bundle: loadBundle() });
  const failures = failureEvidenceSet();
  let projection = 0;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: "live", evidence: [failures[Math.min(projection++, failures.length - 1)]] }; } },
    adapter: { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } }
  });
  const runId = await development.start();
  const applied = runtime.ledger.list(runId).find((event) => event.type === "change.applied");
  const changeEvidence = versionedChangeEvidence({ manifest: applied.payload.change, applied: applied.payload, ledgerEvent: applied });
  const collected = await development.collectDiagnosisEvidence(runId, {
    baseline: baselineEvidence(),
    code: codeEvidence(),
    changeEvidence,
    timeoutMs: 100,
    intervalMs: 0
  });
  assert.equal(collected.gate.passed, true);
  assert.equal(collected.gate.failures.length, 3);
  assert.equal(new Set(collected.gate.failures.map((item) => item.value.trace.trace_ref)).size, 3);
  assert.equal(collected.records.some((item) => Object.hasOwn(item, "payload")), false);
});

test("development investigation stops when fresh telemetry cannot prove the mechanism", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-empty-")), "ledger.db")),
    bundle: loadBundle()
  });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", source: "test" }; } };
  const development = new DevelopmentRuntime({ runtime, source: { async project() { return { status: "live", evidence: [] }; } }, adapter });
  const runId = await development.start();
  await assert.rejects(() => development.investigate(runId), /not available/);
  assert.equal(development.state(runId).events.find((event) => event.type === "outcome.classified").payload.classification, "insufficient_evidence");
});

test("development investigation rejects a known checkout database timeout as unrelated to payment reachability", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-irrelevant-")), "ledger.db")),
    bundle: loadBundle()
  });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } };
  const development = new DevelopmentRuntime({ runtime, source: { async project() { return { status: "live", evidence: [databaseTimeoutEvidence()] }; } }, adapter });
  const runId = await development.start();
  await assert.rejects(() => development.investigate(runId), /not available/);
  const events = development.state(runId).events;
  assert.equal(events.some((event) => event.type === "outcome.classified" && event.payload.classification === "insufficient_evidence"), true);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested"), false);
});

test("development investigation without checkout flag-consumption evidence creates no executable approval", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-no-flag-")), "ledger.db")),
    bundle: loadBundle()
  });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } };
  const development = new DevelopmentRuntime({ runtime, source: { async project() { return { status: "live", evidence: [failureWithoutFlagEvidence()] }; } }, adapter });
  const runId = await development.start();
  await assert.rejects(() => development.investigate(runId), /not available/);
  const events = development.state(runId).events;
  assert.equal(events.some((event) => event.type === "outcome.classified" && event.payload.classification === "insufficient_evidence"), true);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested"), false);
});

test("mismatched approval request cannot execute the checked-in development repair", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-mismatch-")), "ledger.db")),
    bundle: loadBundle()
  });
  let executions = 0;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: "live", evidence: [failureEvidence()] }; } },
    adapter: {
      async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; },
      async executeApprovedRollback() { executions += 1; return { command_id: "should-not-run" }; }
    }
  });
  const runId = await development.start();
  runtime.append(runId, "approval.requested", "test", { repair_id: "unrelated", action: "other", target: "payment", command_id: "other" });
  await assert.rejects(() => development.approve(runId), /does not match/);
  assert.equal(executions, 0);
});

test("frozen development investigation cites the exact change and complete pre-approval Diagnosis Gate", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-frozen-")), "ledger.db")), bundle: loadBundle() });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } };
  const failures = failureEvidenceSet();
  const source = { async project() { return { status: "live", evidence: failures }; } };
  const development = new DevelopmentRuntime({ runtime, source, adapter });
  const runId = await development.start();
  const frozen = diagnosisSnapshot(runtime, runId, failures);
  await development.investigate(runId, frozen);
  const query = runtime.ledger.list(runId).find((event) => event.type === "evidence.queried");
  assert.equal(query.payload.evidence_mode, "frozen_real_otlp_snapshot");
  assert.equal(query.payload.execution_mode, "deterministic");
  assert.equal(JSON.stringify(query.payload).toLowerCase().includes("gpt"), false);
  const expected = new Set(frozen.metadata().reserved_causal_ids);
  assert.equal(expected.size, 6);
  for (const type of ["hypothesis.proposed", "evaluation.accepted", "repair.proposed", "approval.requested"]) {
    const event = runtime.ledger.list(runId).filter((item) => item.type === type).at(-1);
    assert.deepEqual(new Set(event.evidence_refs), expected);
  }
});

function change() {
  return {
    id: "change-payment-unreachable-v1",
    target: "checkout",
    flag: "paymentUnreachable",
    after: "on",
    known_good: "off",
    repair_id: "repair-payment-reachable-v1",
    repair_command_id: "astronomy.restore-payment-and-recreate-checkout",
    timeout_seconds: 120,
    abort_if: "checkout unhealthy"
  };
}

function failureEvidence(at = "2026-07-17T12:00:30.000Z", { id = "live-tra-failure", traceRef = "a".repeat(12) } = {}) {
  return {
    id,
    kind: "trace",
    entity: "checkout",
    signal: "traces",
    at,
    value: {
      services: ["checkout"],
      trace: {
        service: "checkout",
        operation: "POST /checkout payment",
        peer_target: "payment:8080",
        status: "error",
        error: "ECONNREFUSED",
        observed_at: at,
        trace_ref: traceRef,
        span_ref: "c".repeat(12),
        parent_ref: "b".repeat(12),
        feature_flag: {
          service: "checkout",
          key: "paymentUnreachable",
          variant: "on",
          value: true,
          provider: "flagd",
          reason: "cached",
          evaluated_at: "2026-07-17T12:00:29.999Z",
          trace_ref: traceRef,
          span_ref: "b".repeat(12),
          same_trace: true,
          direct_parent: true
        }
      }
    },
    payload: { resourceSpans: [{ resource: { service: "checkout" }, scopeSpans: [{ spans: [{ name: "payment", status: { code: 2, message: "unavailable" } }] }] }] }
  };
}

function failureEvidenceSet() {
  return [
    failureEvidence("2026-07-17T12:00:30.000Z", { id: "live-tra-failure-1", traceRef: "a".repeat(12) }),
    failureEvidence("2026-07-17T12:00:31.000Z", { id: "live-tra-failure-2", traceRef: "d".repeat(12) }),
    failureEvidence("2026-07-17T12:00:32.000Z", { id: "live-tra-failure-3", traceRef: "e".repeat(12) })
  ];
}

function failureWithoutFlagEvidence() {
  const evidence = failureEvidence();
  evidence.id = "live-tra-failure-without-flag";
  delete evidence.value.trace.feature_flag;
  return evidence;
}

function healthyEvidence(at = "2026-07-17T12:01:30.000Z") {
  return {
    id: "live-tra-healthy",
    kind: "trace",
    entity: "checkout",
    signal: "traces",
    at,
    value: {
      services: ["checkout", "payment"],
      trace: { service: "checkout", operation: "oteldemo.PaymentService/Charge", peer_target: "payment:8080", status: "ok", error: null, observed_at: at }
    },
    payload: {}
  };
}

async function approvedDevelopment({ flagVariant = "off", recoveredEvidence, readFlag, sourceStatus = "live" } = {}) {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-verify-")), "ledger.db")), bundle: loadBundle() });
  let repaired = false;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: repaired ? sourceStatus : "live", evidence: repaired ? recoveredEvidence : [failureEvidence()] }; } },
    adapter: {
      async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; },
      async executeApprovedRollback({ commandId }) { repaired = true; return { command_id: commandId, completed_at: "2026-07-17T12:01:00.000Z", stdout: "", stderr: "" }; },
      readAllowlistedFlagVariant: readFlag || (async () => ({ flag: "paymentUnreachable", variant: flagVariant, observed_at: "2026-07-17T12:01:31.000Z", source: "test flag API" }))
    }
  });
  const runId = await development.start();
  await development.investigate(runId, diagnosisSnapshot(runtime, runId));
  await development.approve(runId, "Test owner");
  return { development, runId };
}

function diagnosisSnapshot(runtime, runId, failures = failureEvidenceSet()) {
  const applied = runtime.ledger.list(runId).find((event) => event.type === "change.applied");
  const changeEvidence = versionedChangeEvidence({ manifest: applied.payload.change, applied: applied.payload, ledgerEvent: applied });
  return new LiveOtlpEvidenceSource({ status: "live", evidence: failures }).freeze({
    supplementalRecords: [baselineEvidence(), codeEvidence(), changeEvidence],
    executable: true,
    after: applied.payload.applied_at
  });
}

function baselineEvidence() {
  const at = "2026-07-17T11:59:59.000Z";
  return {
    id: "live-tra-baseline",
    kind: "trace",
    entity: "checkout",
    signal: "traces",
    at,
    value: {
      services: ["checkout", "payment"],
      trace: {
        service: "checkout",
        operation: "oteldemo.PaymentService/Charge",
        peer_target: "payment:8080",
        status: "ok",
        error: null,
        observed_at: at,
        trace_ref: "1".repeat(12),
        span_ref: "3".repeat(12),
        parent_ref: "2".repeat(12),
        feature_flag: {
          service: "checkout",
          key: "paymentUnreachable",
          variant: "off",
          value: false,
          provider: "flagd",
          reason: "cached",
          evaluated_at: "2026-07-17T11:59:58.999Z",
          trace_ref: "1".repeat(12),
          span_ref: "2".repeat(12),
          same_trace: true,
          direct_parent: true
        }
      }
    },
    hash: "4".repeat(64),
    provenance: { sha256: "4".repeat(64), immutable_capture: true }
  };
}

function codeEvidence() {
  const spec = PINNED_CHECKOUT_CODE_SPEC;
  return {
    id: `code-${spec.content_sha256.slice(0, 16)}`,
    kind: "code",
    entity: "checkout",
    signal: "code",
    at: "2026-07-17T11:00:00.000Z",
    fact: spec.semantic_fact,
    source: "verified pinned official git object",
    value: { code: { id: "checkout-payment-unreachable-v1", ...spec, verified_from_git_object: true } },
    hash: spec.content_sha256,
    provenance: {
      file: spec.path,
      line: spec.line_start,
      line_end: spec.line_end,
      sha256: spec.content_sha256,
      repository: spec.repository,
      commit: spec.commit,
      immutable_capture: true,
      verified_from_git_object: true
    }
  };
}

function expectedRepairContract() {
  return {
    repair_id: "repair-payment-reachable-v1",
    action: "restore known-good paymentUnreachable flag and recreate checkout",
    target: "checkout",
    command_id: "astronomy.restore-payment-and-recreate-checkout"
  };
}

function contractEvent(type, sequence, payload) { return { type, sequence, payload }; }

function successfulVerificationEvent(sequence) {
  return {
    type: "verification.completed",
    sequence,
    payload: {
      passed: true,
      checks: [
        { id: "flag_variant_restored", metric: "paymentUnreachable_variant", passed: true },
        { id: "fresh_checkout_payment_success", metric: "fresh_healthy_checkout_payment_traces", passed: true },
        { id: "no_fresh_resolver_failures", metric: "fresh_checkout_payment_unreachable_traces", passed: true }
      ]
    }
  };
}

function replaceVerification(events, mutate) {
  return events.map((event) => event.type === "verification.completed"
    ? { ...event, payload: mutate(structuredClone(event.payload)) }
    : event);
}

function rehashedArtifact(artifact, verification) {
  return createDevelopmentRegressionArtifact({
    runId: artifact.run_id,
    seed: artifact.diagnosis,
    verification: {
      ...verification.payload,
      evidence_ids: verification.evidence_refs,
      evidence_bindings: artifact.verification.evidence_bindings
    },
    capture: artifact.capture,
    repairContract: artifact.repair_contract
  });
}

function replaceRegressionAndBacktest(events, artifact, backtest) {
  const regression = events.find((event) => event.type === "regression.created");
  return events.map((event) => {
    if (event.type === "regression.created") return { ...event, payload: { ...event.payload, artifact } };
    if (event.type === "backtest.completed") return { ...event, payload: { ...backtest, regression_id: regression.payload.id } };
    return event;
  });
}

function assertPolicyBlocked(policy, gateId) {
  assert.equal(policy.passed, false);
  assert.equal(policy.promotion, "blocked");
  assert.equal(policy.gates.find((gate) => gate.id === gateId).passed, false);
}

function assertFailedVerification(state, failedCheckId, classification) {
  const verification = state.events.find((event) => event.type === "verification.completed");
  assert.equal(verification.payload.passed, false);
  assert.equal(verification.payload.checks.find((check) => check.id === failedCheckId).passed, false);
  assert.equal(state.events.find((event) => event.type === "outcome.classified").payload.classification, classification);
  assert.equal(state.events.some((event) => event.type === "regression.created"), false);
  assert.equal(state.events.some((event) => event.type === "policy.evaluated"), false);
}

function databaseTimeoutEvidence() {
  return {
    id: "live-tra-database-timeout",
    kind: "trace",
    entity: "checkout",
    signal: "traces",
    at: "2026-07-17T12:00:30.000Z",
    value: {
      services: ["checkout"],
      trace: {
        service: "checkout",
        operation: "SELECT orders",
        peer_target: "postgres:5432",
        status: "error",
        error: "timeout",
        observed_at: "2026-07-17T12:00:30.000Z"
      }
    },
    payload: {}
  };
}

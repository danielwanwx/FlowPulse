import { evaluateCheckoutPaymentDiagnosisGate, isCheckoutPaymentUnreachableTrace, isExecutableCheckoutPaymentEvidence, isHealthyCheckoutPaymentTrace, isKnownGoodCheckoutPaymentEvidence } from "./incident-mechanism.mjs";
import { isPinnedCheckoutCodeEvidence } from "./code-evidence.mjs";
import { InsufficientEvidenceError, summarizeEvidence } from "./evidence-source.mjs";
import { buildDiagnosisBacktestSeed, buildRecoveryReceipt, controlGates, createDevelopmentRegressionArtifact, DEVELOPMENT_BACKTEST_GATE_IDS, DEVELOPMENT_BACKTEST_VERSION, runDevelopmentBacktest } from "./regression-backtest.mjs";
import { harnessBinding, loadHarnessManifest } from "./harness-manifest.mjs";

export class DevelopmentRuntime {
  constructor({ runtime, source, adapter }) {
    this.runtime = runtime;
    this.source = source;
    this.adapter = adapter;
  }

  async start() {
    const preflight = await this.prepareDiagnosisPreflight();
    const applied = await this.adapter.applyDevelopmentCase();
    const runId = this.runtime.startRun("development", {
      title: "Checkout cannot reach payment",
      severity: "SEV-2",
      environment: "dev / astronomy-shop",
      summary: "A versioned checkout configuration change is producing real failures in the local development runtime."
    });
    this.runtime.append(runId, "change.applied", "development-adapter", applied);
    this.runtime.append(runId, "deployment.completed", "development-adapter", {
      target: "checkout",
      change_id: applied.change.id,
      revision: applied.after,
      source: applied.source
    });
    if (preflight) {
      this.runtime.append(runId, "diagnosis.baseline.captured", "development-adapter", {
        evidence_id: preflight.baseline.id,
        evidence_hash: evidenceHash(preflight.baseline),
        observed_at: preflight.baseline.value.trace.observed_at,
        flag: preflight.flag.flag,
        variant: preflight.flag.variant,
        source: "fresh bounded OTLP projection",
        evidence: summarizeEvidence(preflight.baseline)
      }, [preflight.baseline.id]);
      this.runtime.append(runId, "code.semantics.captured", "development-adapter", {
        evidence_id: preflight.code.id,
        evidence_hash: evidenceHash(preflight.code),
        commit: preflight.code.value.code.commit,
        path: preflight.code.value.code.path,
        line_start: preflight.code.value.code.line_start,
        line_end: preflight.code.value.code.line_end,
        source: preflight.code.source,
        evidence: summarizeEvidence(preflight.code)
      }, [preflight.code.id]);
    }
    return runId;
  }

  async prepareDiagnosisPreflight() {
    if (![this.adapter.developmentChangeManifest, this.adapter.readAllowlistedFlagVariant, this.adapter.readPinnedCheckoutCodeEvidence].every((method) => typeof method === "function")) return null;
    const change = await this.adapter.developmentChangeManifest();
    const [flag, source, code] = await Promise.all([
      this.adapter.readAllowlistedFlagVariant(),
      this.source.project(),
      this.adapter.readPinnedCheckoutCodeEvidence()
    ]);
    const baseline = (source.evidence || [])
      .filter((item) => isKnownGoodCheckoutPaymentEvidence(item, change, flag.observed_at))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (source.status !== "live" || flag.flag !== change.flag || flag.variant !== change.known_good || !baseline) {
      throw new Error("Fresh known-good checkout-to-payment baseline is not available while the allowlisted flag is off");
    }
    if (!isPinnedCheckoutCodeEvidence(code, change)) throw new Error("Pinned checkout implementation semantics evidence is unavailable or mismatched");
    return { baseline, code, flag };
  }

  async collectDiagnosisEvidence(runId, { baseline, code, changeEvidence, timeoutMs = 90_000, intervalMs = 1_000 } = {}) {
    this.assertMode(runId);
    const change = changeEvidence?.value?.change;
    if (!baseline || !code || !change) throw new InsufficientEvidenceError("Diagnosis evidence collection is missing its immutable preflight records");
    const failures = new Map();
    const deadline = Date.now() + timeoutMs;
    let project = null;
    do {
      project = await this.source.project();
      if (project.status !== "live") throw new InsufficientEvidenceError(`Diagnosis telemetry source is ${project.status}`);
      for (const record of project.evidence || []) {
        if (!isExecutableCheckoutPaymentEvidence(record, change)) continue;
        const traceRef = record.value.trace.trace_ref;
        if (!failures.has(traceRef)) failures.set(traceRef, summarizeEvidence(record));
      }
      const records = [baseline, code, ...failures.values()];
      const gate = evaluateCheckoutPaymentDiagnosisGate(records, change);
      if (gate.passed) return { project, records, gate };
      if (Date.now() >= deadline) throw new InsufficientEvidenceError(`Diagnosis evidence collection timed out: ${gate.missing.join(", ")}`);
      if (intervalMs > 0) await wait(intervalMs);
    } while (true);
  }

  async investigate(runId = this.runtime.ensureRun(), evidenceSource = null) {
    this.assertMode(runId);
    const harness = harnessBinding(loadHarnessManifest());
    const source = await this.source.project();
    const appliedAt = this.runtime.ledger.list(runId).find((event) => event.type === "change.applied")?.payload.applied_at;
    const selected = evidenceSource?.records || source.evidence;
    const change = this.changeFor(runId);
    const contract = repairContract(change);
    const changeEvidence = evidenceSource ? selected.find((item) => item.kind === "change" && matchesChange(item, contract, appliedAt)) : null;
    const causalChange = changeEvidence?.value?.change || { ...change, before: change.known_good, applied_at: appliedAt };
    const gate = evaluateCheckoutPaymentDiagnosisGate(selected, causalChange);
    if (source.status !== "live" || !evidenceSource || !gate.passed) {
      this.runtime.append(runId, "outcome.classified", "evaluator", {
        classification: "insufficient_evidence",
        explanation: `The pre-approval Diagnosis Gate is incomplete: ${gate.missing.join(", ") || "frozen snapshot required"}.`
      }, gate.required_records.map((item) => item.id));
      throw new InsufficientEvidenceError("Fresh checkout/payment Diagnosis Gate evidence is not available yet", {
        stage: "evidence_snapshot",
        validator_id: "checkout_payment_diagnosis_gate",
        reason_code: "diagnosis_gate_incomplete",
        missing_evidence_classes: gate.missing
      });
    }
    if (evidenceSource && !changeEvidence) {
      this.runtime.append(runId, "outcome.classified", "evaluator", {
        classification: "insufficient_evidence",
        explanation: "The frozen development snapshot is missing the exact applied versioned change record."
      }, gate.required_records.map((item) => item.id));
      throw new InsufficientEvidenceError("Frozen development change evidence is missing or mismatched", {
        stage: "evidence_snapshot",
        validator_id: "checkout_payment_diagnosis_gate",
        reason_code: "versioned_change_missing"
      });
    }
    const refs = [...new Set([changeEvidence.id, ...gate.required_records.map((item) => item.id)])];
    this.runtime.append(runId, "evidence.queried", "investigator", {
      tool: "query_live_otlp",
      result_count: refs.length,
      evidence_mode: evidenceSource?.metadata?.().mode || "unit-only-fallback",
      execution_mode: "real_local_development"
    }, refs);
    this.runtime.append(runId, "loop.symptoms_collected", "runtime", { step: "inspect fresh local telemetry" }, refs);
    const rejectedDiagnosis = {
      id: "hyp-payment-service",
      title: "Payment service initiated the failure",
      claim: "Checkout payment spans are failing, so payment itself may be unhealthy.",
      confidence: 0.63,
      initiating_change: "Not established",
      failure_mechanism: "Dependency failure only",
      propagation: [],
      evidence_refs: refs,
      proposed_repair: { ...contract, reason: "No repair is permitted until initiating cause is proven." }
    };
    const rejectedEvaluation = {
      accepted: false,
      score: 0.28,
      classification: "agent_false_positive",
      phase: "diagnosis_pre_approval",
      gate_checks: { initiating_change: false, temporal_order: false, implementation_semantics: false, controlled_off_on_contrast: false, repeated_direct_failures: false },
      reason: "The failure spans prove an unsuccessful dependency call but do not prove that the payment process initiated the incident.",
      missing_evidence: ["initiating change", "payment service health"],
      counter_evidence_refs: refs
    };
    this.runtime.append(runId, "hypothesis.proposed", "investigator", {
      id: "hyp-payment-service",
      title: "Payment service initiated the failure",
      confidence: 0.63,
      claim: "Checkout payment spans are failing, so payment itself may be unhealthy."
    }, refs);
    this.runtime.append(runId, "evaluation.rejected", "evaluator", {
      hypothesis_id: "hyp-payment-service",
      score: 0.28,
      reason: "The failure spans prove an unsuccessful dependency call but do not prove that the payment process initiated the incident.",
      missing: ["initiating change", "payment service health"]
    }, refs);
    this.runtime.append(runId, "loop.hypothesis_rejected", "runtime", { step: "challenge unsupported service blame" }, refs);
    this.runtime.append(runId, "plan.revised", "investigator", {
      reason: "Join the allowlisted change with pinned implementation semantics, a flag-off healthy contrast, and repeated direct-parent flag-on failures."
    }, refs);
    this.runtime.append(runId, "loop.replanned", "runtime", { step: "replan from counter-evidence" }, refs);
    this.runtime.append(runId, "tool.called", "investigator", { tool: "query_versioned_changes", result_count: 1 }, refs);
    this.runtime.append(runId, "loop.causal_evidence_collected", "runtime", { step: "join change and trace evidence" }, refs);
    const acceptedDiagnosis = {
      id: "hyp-live-payment-flag",
      title: "Checkout payment-unreachable change caused the dependency failures",
      confidence: 0.91,
      claim: "The pinned checkout code, controlled flag-off/on contrast, and three distinct direct-parent failures prove the bounded checkout-to-payment mechanism.",
      initiating_change: "paymentUnreachable changed off to on for checkout",
      failure_mechanism: "Checkout directly consumed paymentUnreachable=on and its child payment resolver call failed.",
      propagation: [],
      evidence_refs: refs,
      proposed_repair: { ...contract, reason: "Restore the known-good checkout flag only after owner approval." }
    };
    const acceptedEvaluation = {
      accepted: true,
      score: 0.9,
      classification: "confirmed_system_bug",
      phase: "diagnosis_pre_approval",
      gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
      reason: "Every pre-approval Diagnosis Gate check passed for the bounded checkout-to-payment claim; wider propagation remains unproven.",
      missing_evidence: [],
      counter_evidence_refs: refs
    };
    this.runtime.append(runId, "hypothesis.proposed", "investigator", {
      id: "hyp-live-payment-flag",
      title: "Checkout payment-unreachable change caused the dependency failures",
      confidence: 0.91,
      claim: "The pinned checkout code, controlled flag-off/on contrast, and three distinct direct-parent failures prove the bounded checkout-to-payment mechanism."
    }, refs);
    this.runtime.append(runId, "evaluation.accepted", "evaluator", {
      ...acceptedEvaluation,
      hypothesis_id: "hyp-live-payment-flag"
    }, refs);
    const seed = buildDiagnosisBacktestSeed({
      evidenceSource,
      diagnosis: acceptedDiagnosis,
      evaluation: acceptedEvaluation,
      repairContract: contract,
      rejected: { diagnosis: rejectedDiagnosis, evaluation: rejectedEvaluation },
      harness
    });
    this.runtime.append(runId, "diagnosis.gate.passed", "runtime", seed, seed.accepted.evidence_ids);
    this.runtime.append(runId, "loop.root_cause_confirmed", "runtime", { step: "confirm local root cause" }, refs);
    // Investigation is deliberately non-consequential. The server-owned
    // autonomy closure re-reads this gate before it may create an Owner Gate.
    return source;
  }

  async verify(runId = this.runtime.ensureRun()) {
    this.assertMode(runId);
    const harness = harnessBinding(loadHarnessManifest());
    const events = this.runtime.ledger.list(runId);
    const repaired = events.find((event) => event.type === "repair.executed");
    if (!repaired) throw new Error("Approved repair must execute before verification");
    const change = this.changeFor(runId);
    const [flagRead, sourceRead] = await Promise.allSettled([
      this.adapter.readAllowlistedFlagVariant(),
      this.source.project()
    ]);
    const flagState = flagRead.status === "fulfilled" ? flagRead.value : null;
    const source = sourceRead.status === "fulfilled" ? sourceRead.value : { status: "disconnected", evidence: [] };
    const repairedAt = Date.parse(repaired.payload.completed_at || "");
    const flagObservedAt = Date.parse(flagState?.observed_at || "");
    const flagReadable = flagState?.flag === change.flag
      && [change.after, change.known_good].includes(flagState?.variant)
      && Number.isFinite(repairedAt) && Number.isFinite(flagObservedAt) && flagObservedAt > repairedAt;
    const fresh = (source.evidence || []).filter((item) => strictlyAfterRepair(item, repaired.payload.completed_at));
    const healthy = fresh.filter(isHealthyCheckoutPaymentTrace);
    const failures = fresh.filter(isCheckoutPaymentUnreachableTrace);
    const checks = [
      verificationCheck("flag_variant_restored", `${change.flag}_variant`, flagReadable ? flagState.variant : null, `== ${change.known_good}`, flagReadable && flagState.variant === change.known_good, change.known_good),
      verificationCheck("fresh_checkout_payment_success", "fresh_healthy_checkout_payment_traces", healthy.length, ">= 1", source.status === "live" && healthy.length >= 1),
      verificationCheck("no_fresh_resolver_failures", "fresh_checkout_payment_unreachable_traces", failures.length, "== 0", source.status === "live" && failures.length === 0)
    ];
    const refs = [...new Set([...healthy, ...failures].map((item) => item.id))];
    const passed = checks.every((check) => check.passed);
    this.runtime.append(runId, "verification.completed", "verifier", {
      passed,
      repair_completed_at: repaired.payload.completed_at,
      source_status: source.status,
      flag_observed_at: flagState?.observed_at || null,
      checks
    }, refs);
    if (!passed) {
      const toolDataFailure = !flagReadable || flagRead.status === "rejected" || sourceRead.status === "rejected" || source.status !== "live";
      this.runtime.append(runId, "outcome.classified", "evaluator", {
        classification: toolDataFailure ? "tool_data_failure" : "repair_failure",
        explanation: toolDataFailure
          ? "Recovery verification could not read the bounded flag state or telemetry source."
          : "The approved repair did not satisfy every recorded recovery check."
      }, refs);
      throw new Error(toolDataFailure ? "Recovery flag state or telemetry source is unavailable" : "Recovery verification failed");
    }
    const seedEvent = events.filter((event) => event.type === "diagnosis.gate.passed").at(-1);
    if (!seedEvent?.payload) throw new Error("A passed frozen Diagnosis Gate seed is required before regression creation");
    const diagnosisRefs = seedEvent.payload.accepted?.evidence_ids || [];
    const captureRefs = [...new Set([...diagnosisRefs, ...refs])];
    const capture = this.adapter.finalizeCapture
      ? await this.adapter.finalizeCapture({ runId, evidenceIds: captureRefs })
      : { id: `capture-${runId}`, sha256: "test-capture", evidence_ids: captureRefs };
    this.runtime.append(runId, "outcome.classified", "evaluator", {
      classification: "confirmed_system_bug",
      secondary_learning: "agent_false_positive",
      explanation: "A real local checkout change caused the incident; unsupported payment-service blame was rejected."
    }, refs);
    const verificationReceipt = buildRecoveryReceipt({
      passed,
      repair_completed_at: repaired.payload.completed_at,
      source_status: source.status,
      flag_observed_at: flagState?.observed_at || null,
      checks,
      evidence_ids: refs,
      evidence: [...healthy, ...failures]
    });
    const artifact = createDevelopmentRegressionArtifact({
      runId,
      seed: seedEvent.payload,
      verification: verificationReceipt,
      capture,
      repairContract: repairContract(change)
    });
    const regression = this.runtime.append(runId, "regression.created", "evolve", {
      id: `regression-${runId}`,
      name: "Live checkout payment-unreachable regression",
      source: "executed_real_otlp_regression_artifact",
      capture_id: capture.id,
      capture_sha256: capture.sha256,
      evidence_ids: captureRefs,
      artifact,
      harness
    }, captureRefs);
    const backtest = runDevelopmentBacktest({ artifact, events: this.runtime.ledger.list(runId), repairContract: repairContract(change) });
    this.runtime.append(runId, "backtest.completed", "test", { ...backtest, regression_id: regression.payload.id, harness }, captureRefs);
    this.runtime.append(runId, "policy.evaluated", "evolve", { ...evaluateDevelopmentPolicy(this.runtime.ledger.list(runId), repairContract(change)), harness });
    this.runtime.append(runId, "loop.learning_complete", "runtime", { step: "verify and learn from live capture" }, refs);
    return source;
  }

  state(runId = this.runtime.ensureRun()) { return this.runtime.state(runId); }

  assertMode(runId) {
    const mode = this.runtime.ledger.list(runId).find((event) => event.type === "run.started")?.payload.mode;
    if (mode !== "development") throw new Error("The active run is not a local development incident");
  }

  changeFor(runId) {
    const change = this.runtime.ledger.list(runId).find((event) => event.type === "change.applied")?.payload.change;
    if (!change) throw new Error("Versioned development change is missing");
    return change;
  }

  repairContract(runId = this.runtime.ensureRun()) { return repairContract(this.changeFor(runId)); }
}

export function repairContract(change) {
  for (const key of ["repair_id", "flag", "target", "repair_command_id"]) {
    if (!change?.[key]) throw new Error(`Captured development change is missing ${key}`);
  }
  return {
    repair_id: change.repair_id,
    action: `restore known-good ${change.flag} flag and recreate checkout`,
    target: change.target,
    command_id: change.repair_command_id
  };
}

function matchesChange(item, contract, appliedAt) {
  const change = item.value?.change;
  return change?.repair_id === contract.repair_id
    && change?.target === contract.target
    && change?.repair_command_id === contract.command_id
    && changeAction(change.flag) === contract.action
    && change?.applied_at === appliedAt;
}

function changeAction(flag) { return flag ? `restore known-good ${flag} flag and recreate checkout` : null; }
function evidenceHash(record) { return record.provenance?.sha256 || record.hash || null; }

function strictlyAfterRepair(item, completedAt) {
  const observedAt = Date.parse(item.value?.trace?.observed_at || "");
  const recordedAt = Date.parse(item.at || "");
  const repairedAt = Date.parse(completedAt || "");
  return Number.isFinite(observedAt) && Number.isFinite(recordedAt) && Number.isFinite(repairedAt)
    && observedAt > repairedAt && recordedAt > repairedAt;
}

function verificationCheck(id, metric, observed, threshold, passed, expected) {
  return { id, metric, observed, ...(expected === undefined ? {} : { expected }), threshold, passed: Boolean(passed) };
}

const RECOVERY_CHECK_IDS = ["flag_variant_restored", "fresh_checkout_payment_success", "no_fresh_resolver_failures"];

export function evaluateDevelopmentPolicy(events, contract) {
  const control = controlGates(events, contract);
  const verificationEvents = events.filter((event) => event.type === "verification.completed");
  const verification = verificationEvents.length === 1 ? verificationEvents[0] : null;
  const recordedChecks = Array.isArray(verification?.payload?.checks) ? verification.payload.checks : [];
  const verificationPassed = verification?.payload?.passed === true;
  const recoveryGates = RECOVERY_CHECK_IDS.map((id) => {
    const matches = recordedChecks.filter((check) => check.id === id);
    const check = matches.length === 1 ? matches[0] : null;
    return policyGate(id, verificationPassed && check?.passed === true, check?.metric || id);
  });
  const regressions = events.filter((event) => event.type === "regression.created");
  const backtests = events.filter((event) => event.type === "backtest.completed");
  const regression = regressions.length === 1 ? regressions[0] : null;
  const backtest = backtests.length === 1 ? backtests[0] : null;
  const backtestGates = Array.isArray(backtest?.payload?.gates) ? backtest.payload.gates : [];
  const exactBacktestGates = backtestGates.length === DEVELOPMENT_BACKTEST_GATE_IDS.length
    && DEVELOPMENT_BACKTEST_GATE_IDS.every((id) => backtestGates.filter((gate) => gate?.id === id).length === 1);
  const allBacktestGatesPassed = exactBacktestGates && backtestGates.every((gate) => gate.passed === true);
  const backtestPassConsistent = typeof backtest?.payload?.passed === "boolean"
    && backtest.payload.passed === allBacktestGatesPassed;
  const matchingBacktest = Boolean(regression && backtest
    && backtest.payload?.source === "executed_offline_backtest"
    && backtest.payload?.version === DEVELOPMENT_BACKTEST_VERSION
    && regression.payload?.artifact?.version === DEVELOPMENT_BACKTEST_VERSION
    && allBacktestGatesPassed
    && backtestPassConsistent
    && Number.isFinite(regression.sequence) && Number.isFinite(backtest.sequence) && regression.sequence < backtest.sequence
    && backtest.payload?.regression_id === regression.payload?.id
    && backtest.payload?.case_sha256 === regression.payload?.artifact?.case_sha256
    && backtest.payload?.artifact_sha256 === regression.payload?.artifact?.artifact_sha256
    && backtest.payload?.candidate_sha256 === regression.payload?.artifact?.diagnosis?.candidate_sha256
    && sameHarnessBinding(regression.payload?.harness, regression.payload?.artifact?.harness)
    && sameHarnessBinding(backtest.payload?.harness, regression.payload?.artifact?.harness));
  const gates = [
    policyGate("approval_before_repair", control.approvalBeforeRepair, "Owner approval precedes repair execution"),
    policyGate("allowlisted_repair_contract", control.allowlistedRepairContract, "Every repair control event matches the checked-in contract"),
    ...recoveryGates,
    policyGate("regression_artifact", Boolean(regression?.payload?.artifact?.case_sha256 && regression?.payload?.artifact?.artifact_sha256), "A versioned immutable regression artifact exists"),
    policyGate("executed_offline_backtest", matchingBacktest, "A matching deterministic offline backtest recomputed and passed")
  ];
  const passed = gates.every((gate) => gate.passed);
  return {
    candidate: "live-evidence-policy-v1",
    passed,
    promotion: passed ? "eligible_for_owner_review" : "blocked",
    gates
  };
}

function sameHarnessBinding(left, right) {
  return typeof left?.manifest_sha256 === "string" && left.manifest_sha256 === right?.manifest_sha256
    && typeof left.version === "string" && left.version === right?.version;
}

function policyGate(id, passed, label) { return { id, label, passed: Boolean(passed) }; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

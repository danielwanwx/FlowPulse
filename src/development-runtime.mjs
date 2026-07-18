import { isCheckoutPaymentUnreachableTrace } from "./incident-mechanism.mjs";

export class DevelopmentRuntime {
  constructor({ runtime, source, adapter }) {
    this.runtime = runtime;
    this.source = source;
    this.adapter = adapter;
  }

  async start() {
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
    return runId;
  }

  async investigate(runId = this.runtime.ensureRun(), evidenceSource = null) {
    this.assertMode(runId);
    const source = await this.source.project();
    const appliedAt = this.runtime.ledger.list(runId).find((event) => event.type === "change.applied")?.payload.applied_at;
    const selected = evidenceSource?.records || source.evidence;
    const change = this.changeFor(runId);
    const contract = repairContract(change);
    const changeEvidence = evidenceSource ? selected.find((item) => item.kind === "change" && matchesChange(item, contract, appliedAt)) : null;
    const candidates = selected.filter((item) => relevantFailure(item) && Date.parse(item.at) >= Date.parse(appliedAt));
    if (source.status !== "live" || candidates.length === 0) {
      this.runtime.append(runId, "outcome.classified", "evaluator", {
        classification: "insufficient_evidence",
        explanation: "Fresh OTLP evidence does not yet prove the checkout-to-payment failure mechanism."
      }, candidates.map((item) => item.id));
      throw new Error("Fresh checkout/payment failure evidence is not available yet");
    }
    if (evidenceSource && !changeEvidence) {
      this.runtime.append(runId, "outcome.classified", "evaluator", {
        classification: "insufficient_evidence",
        explanation: "The frozen development snapshot is missing the exact applied versioned change record."
      }, candidates.map((item) => item.id));
      throw new Error("Frozen development change evidence is missing or mismatched");
    }
    const refs = [...new Set([...(changeEvidence ? [changeEvidence.id] : []), ...candidates.map((item) => item.id)])];
    this.runtime.append(runId, "evidence.queried", "investigator", {
      tool: "query_live_otlp",
      result_count: refs.length,
      evidence_mode: evidenceSource?.metadata?.().mode || "unit-only-fallback"
    }, refs);
    this.runtime.append(runId, "loop.symptoms_collected", "runtime", { step: "inspect fresh local telemetry" }, refs);
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
      reason: "Correlate the first failed checkout/payment span with the allowlisted versioned change."
    }, refs);
    this.runtime.append(runId, "loop.replanned", "runtime", { step: "replan from counter-evidence" }, refs);
    this.runtime.append(runId, "tool.called", "investigator", { tool: "query_versioned_changes", result_count: 1 }, refs);
    this.runtime.append(runId, "loop.causal_evidence_collected", "runtime", { step: "join change and trace evidence" }, refs);
    this.runtime.append(runId, "hypothesis.proposed", "investigator", {
      id: "hyp-live-payment-flag",
      title: "Checkout payment-unreachable change caused the dependency failures",
      confidence: 0.91,
      claim: "The versioned paymentUnreachable change preceded fresh checkout-to-payment failure telemetry in the local runtime."
    }, refs);
    this.runtime.append(runId, "evaluation.accepted", "evaluator", {
      hypothesis_id: "hyp-live-payment-flag",
      score: 0.9,
      reason: "The allowlisted change, target, timing, and fresh failure telemetry support a bounded checkout rollback."
    }, refs);
    this.runtime.append(runId, "loop.root_cause_confirmed", "runtime", { step: "confirm local root cause" }, refs);
    this.runtime.append(runId, "repair.proposed", "investigator", {
      ...repairContract(change),
      from: change.after,
      to: change.known_good,
      bounded: true,
      timeout_seconds: change.timeout_seconds,
      abort_if: change.abort_if,
      expected_effect: "Restore checkout payment calls and confirm recovery from fresh post-repair OTLP evidence."
    }, refs);
    this.runtime.append(runId, "approval.requested", "runtime", {
      ...repairContract(change),
      owner_team: "local-development",
      reason: "Recreating a running checkout container is consequential and requires owner approval."
    }, refs);
    this.runtime.append(runId, "loop.approval_requested", "runtime", { step: "request owner approval" }, refs);
    return source;
  }

  async approve(runId = this.runtime.ensureRun(), owner = "Development owner") {
    this.assertMode(runId);
    const events = this.runtime.ledger.list(runId);
    const change = this.changeFor(runId);
    const contract = repairContract(change);
    const request = events.find((event) => event.type === "approval.requested");
    const proposal = events.find((event) => event.type === "repair.proposed");
    if (!request) throw new Error("No local repair is awaiting approval");
    if (events.some((event) => event.type === "approval.granted")) throw new Error("Local repair is already approved");
    if (!sameRepairContract(request.payload, contract) || !proposal || !sameRepairContract(proposal.payload, contract)) {
      throw new Error("Requested repair does not match the checked-in development repair contract");
    }
    this.runtime.append(runId, "approval.granted", "owner", { owner, ...contract, scope: "local checkout container only" }, proposal.evidence_refs);
    const result = await this.adapter.executeApprovedRollback({ commandId: contract.command_id });
    this.runtime.append(runId, "repair.executed", "remediation", {
      repair_id: change.repair_id,
      action: contract.action,
      target: contract.target,
      from: change.after,
      to: change.known_good,
      mode: "local-development",
      command_id: result.command_id,
      completed_at: result.completed_at,
      stdout: result.stdout,
      stderr: result.stderr
    });
    this.runtime.append(runId, "loop.repair_executed", "runtime", { step: "execute approved local rollback" });
    return result;
  }

  async verify(runId = this.runtime.ensureRun()) {
    this.assertMode(runId);
    const events = this.runtime.ledger.list(runId);
    const repaired = events.find((event) => event.type === "repair.executed");
    if (!repaired) throw new Error("Approved repair must execute before verification");
    const source = await this.source.project();
    const after = source.evidence.filter((item) => Date.parse(item.at) > Date.parse(repaired.payload.completed_at));
    const healthy = after.filter(relevantHealthy);
    if (source.status !== "live" || healthy.length === 0) throw new Error("Fresh post-repair checkout/payment telemetry is not available yet");
    const refs = healthy.map((item) => item.id);
    const capture = this.adapter.finalizeCapture
      ? await this.adapter.finalizeCapture({ runId, evidenceIds: refs })
      : { id: `capture-${runId}`, sha256: "test-capture", evidence_ids: refs };
    this.runtime.append(runId, "verification.completed", "verifier", {
      passed: true,
      checks: [{ metric: "fresh_post_repair_otlp", before: 0, after: refs.length, threshold: ">=1", passed: true }]
    }, refs);
    this.runtime.append(runId, "outcome.classified", "evaluator", {
      classification: "confirmed_system_bug",
      secondary_learning: "agent_false_positive",
      explanation: "A real local checkout change caused the incident; unsupported payment-service blame was rejected."
    }, refs);
    this.runtime.append(runId, "regression.created", "evolve", {
      id: `regression-${runId}`,
      name: "Live checkout payment-unreachable regression",
      source: "hashed local OTLP capture",
      capture_id: capture.id,
      capture_sha256: capture.sha256,
      evidence_ids: refs
    }, refs);
    this.runtime.append(runId, "policy.evaluated", "evolve", {
      candidate: "live-evidence-policy-v1",
      passed: true,
      promotion: "eligible_for_owner_review",
      gates: [
        { id: "fresh_source", label: "Fresh OTLP source", passed: true },
        { id: "approval_before_repair", label: "Owner approval preceded repair", passed: true },
        { id: "post_repair_evidence", label: "Post-repair evidence captured", passed: true }
      ]
    });
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

function sameRepairContract(candidate = {}, expected) {
  return candidate.repair_id === expected.repair_id
    && candidate.action === expected.action
    && candidate.target === expected.target
    && candidate.command_id === expected.command_id;
}

function relevantFailure(item) {
  return isCheckoutPaymentUnreachableTrace(item);
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

function relevantHealthy(item) {
  const text = JSON.stringify(item.payload || {}).toLowerCase();
  const services = item.value?.services || [];
  return item.signal === "traces" && services.some((name) => name.includes("checkout") || name.includes("payment")) && !/(error|exception|unavailable|refused|"code"\s*:\s*2)/.test(text);
}

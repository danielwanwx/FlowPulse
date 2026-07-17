import { randomUUID } from "node:crypto";
import { evidenceById } from "./bundle.mjs";
import { evaluateCandidate } from "./policy.mjs";

const STEP_OFFSETS = [30_000, 55_000, 70_000, 86_000, 105_000, 122_000, 140_000, 155_000, 170_000];

export class IncidentRuntime {
  constructor({ ledger, bundle, mode = "replay" }) {
    this.ledger = ledger;
    this.bundle = bundle;
    this.mode = mode;
  }

  ensureRun() {
    return this.ledger.latestRun(this.bundle.incident.id) ?? this.startRun();
  }

  startRun(mode = this.mode, incident = this.bundle.incident) {
    const runId = `run-${randomUUID()}`;
    this.append(runId, "run.started", "runtime", { mode, schema_version: 1 });
    this.append(runId, "incident.opened", "runtime", {
      title: incident.title,
      severity: incident.severity,
      summary: incident.summary,
      environment: incident.environment || this.bundle.incident.environment
    });
    return runId;
  }

  next(runId = this.ensureRun()) {
    const events = this.ledger.list(runId);
    if (events.some((event) => event.type === "approval.requested") && !events.some((event) => event.type === "approval.granted")) {
      return { waiting_for_approval: true, event: null };
    }
    const completed = events.filter((event) => event.type.startsWith("loop.")).length;
    const action = replayActions[completed];
    if (!action) return { complete: events.some((event) => event.type === "policy.evaluated"), event: null };
    const emitted = action(this, runId, STEP_OFFSETS[completed] ?? 180_000);
    return { event: emitted, waiting_for_approval: emitted?.type === "approval.requested" };
  }

  approve(runId = this.ensureRun(), owner = "Incident owner") {
    const events = this.ledger.list(runId);
    if (!events.some((event) => event.type === "approval.requested")) throw new Error("No repair is awaiting approval");
    if (events.some((event) => event.type === "approval.granted")) throw new Error("Repair is already approved");
    const event = this.append(runId, "approval.granted", "owner", {
      owner,
      repair_id: this.bundle.repair.id,
      scope: "checkout deployment only"
    }, [], 176_000);
    const mode = events.find((item) => item.type === "run.started")?.payload.mode;
    if (mode === "live") {
      replayActions[7](this, runId, 180_000);
      replayActions[8](this, runId, 190_000);
    }
    return event;
  }

  state(runId = this.ensureRun()) {
    const events = this.ledger.list(runId);
    const evidenceIds = [...new Set(events.flatMap((event) => event.evidence_refs))];
    const waiting = events.some((event) => event.type === "approval.requested") && !events.some((event) => event.type === "approval.granted");
    const complete = events.some((event) => event.type === "policy.evaluated");
    return {
      run_id: runId,
      mode: events.find((event) => event.type === "run.started")?.payload.mode ?? this.mode,
      status: complete ? "resolved" : waiting ? "approval_required" : "investigating",
      stage: stageFor(events),
      waiting_for_approval: waiting,
      complete,
      events,
      evidence: evidenceById(this.bundle, evidenceIds),
      incident: incidentFor(events, this.bundle.incident),
      topology: this.bundle.topology,
      thresholds: this.bundle.thresholds,
      repair: this.bundle.repair,
      live_available: Boolean(process.env.OPENAI_API_KEY),
      langfuse_enabled: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
      langfuse_url: process.env.LANGFUSE_TRACE_URL || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"
    };
  }

  append(runId, type, actor, payload, evidenceRefs = [], offsetMs = 0, parentId = null) {
    return this.ledger.append({
      runId,
      incidentId: this.bundle.incident.id,
      type,
      actor,
      payload,
      evidenceRefs,
      offsetMs,
      parentId,
      correlationId: `${runId}:${type}`
    });
  }
}

const replayActions = [
  (runtime, runId, offset) => {
    const refs = ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"];
    runtime.append(runId, "evidence.queried", "investigator", { tool: "query_symptoms", result_count: refs.length }, refs, offset);
    return runtime.append(runId, "loop.symptoms_collected", "runtime", { step: "inspect symptoms" }, refs, offset + 1);
  },
  (runtime, runId, offset) => {
    const refs = ["ev-metric-kafka-lag", "ev-log-consumer-delay"];
    runtime.append(runId, "hypothesis.proposed", "investigator", {
      id: "hyp-kafka",
      title: "Kafka broker degradation initiated the incident",
      confidence: 0.72,
      claim: "Growing consumer lag delayed accounting and fraud processing."
    }, refs, offset);
    return runtime.append(runId, "loop.initial_hypothesis", "runtime", { step: "form hypothesis" }, refs, offset + 1);
  },
  (runtime, runId, offset) => {
    const refs = ["ev-metric-kafka-healthy", "ev-timing-error-before-lag"];
    runtime.append(runId, "evaluation.rejected", "evaluator", {
      hypothesis_id: "hyp-kafka",
      score: 0.22,
      reason: "Kafka lag is a downstream symptom. Broker health is normal, and payment failures lead the lag alert by 171 seconds.",
      missing: ["initiating change", "upstream failure mechanism"]
    }, refs, offset);
    return runtime.append(runId, "loop.hypothesis_rejected", "runtime", { step: "challenge diagnosis" }, refs, offset + 1);
  },
  (runtime, runId, offset) => {
    runtime.append(runId, "plan.revised", "investigator", {
      reason: "The causal claim failed. Search upstream changes and the first failing span before inspecting Kafka further.",
      next_tools: ["query_deploys", "query_traces", "query_logs", "query_commits"]
    }, [], offset);
    return runtime.append(runId, "loop.replanned", "runtime", { step: "replan from counter-evidence" }, [], offset + 1);
  },
  (runtime, runId, offset) => {
    const refs = ["ev-deploy-checkout", "ev-trace-payment-refused", "ev-log-endpoint-fallback", "ev-commit-checkout"];
    for (const [tool, id] of [["query_deploys", refs[0]], ["query_traces", refs[1]], ["query_logs", refs[2]], ["query_commits", refs[3]]]) {
      runtime.append(runId, "tool.called", "investigator", { tool, result_count: 1 }, [id], offset);
    }
    return runtime.append(runId, "loop.causal_evidence_collected", "runtime", { step: "collect causal evidence" }, refs, offset + 1);
  },
  (runtime, runId, offset) => {
    const refs = ["ev-deploy-checkout", "ev-trace-payment-refused", "ev-log-endpoint-fallback", "ev-commit-checkout"];
    runtime.append(runId, "hypothesis.proposed", "investigator", {
      id: "hyp-checkout-config",
      title: "Checkout deployment selected an unreachable payment endpoint",
      confidence: 0.96,
      claim: "Commit c7e1b9a renamed the payment environment key without updating deployment configuration. checkout:2.18.0 fell back to payment:9090, causing connection refusals and retries before Kafka lag rose.",
      propagation: ["checkout", "payment", "kafka", "accounting", "fraud"]
    }, refs, offset);
    runtime.append(runId, "evaluation.accepted", "evaluator", {
      hypothesis_id: "hyp-checkout-config",
      score: 0.94,
      reason: "The evidence establishes change, mechanism, timing, and downstream propagation."
    }, refs, offset + 1);
    return runtime.append(runId, "loop.root_cause_confirmed", "runtime", { step: "confirm root cause" }, refs, offset + 2);
  },
  (runtime, runId, offset) => {
    runtime.append(runId, "repair.proposed", "investigator", {
      ...runtime.bundle.repair,
      bounded: true,
      expected_effect: "Restore checkout payment calls to payment:8080 and allow retry pressure and Kafka lag to drain."
    }, ["ev-deploy-checkout", "ev-commit-checkout"], offset);
    runtime.append(runId, "approval.requested", "runtime", {
      repair_id: runtime.bundle.repair.id,
      owner_team: "commerce",
      reason: "Deployment rollback is consequential and requires owner approval."
    }, [], offset + 1);
    return runtime.append(runId, "loop.approval_requested", "runtime", { step: "request owner approval" }, [], offset + 2);
  },
  (runtime, runId, offset) => {
    const events = runtime.ledger.list(runId);
    if (!events.some((event) => event.type === "approval.granted")) throw new Error("Owner approval is required");
    runtime.append(runId, "repair.executed", "remediation", {
      repair_id: runtime.bundle.repair.id,
      action: runtime.bundle.repair.action,
      target: runtime.bundle.repair.target,
      from: runtime.bundle.repair.from,
      to: runtime.bundle.repair.to,
      mode: "captured-replay"
    }, ["ev-deploy-checkout"], offset);
    return runtime.append(runId, "loop.repair_executed", "runtime", { step: "execute bounded rollback" }, [], offset + 1);
  },
  (runtime, runId, offset) => {
    const refs = runtime.bundle.repair.verification_evidence;
    const rejectedDiagnosis = runtime.ledger.list(runId).some((event) => event.type === "evaluation.rejected");
    runtime.append(runId, "verification.completed", "verifier", {
      passed: true,
      checks: [
        { metric: "payment_reachability_percent", before: 61.6, after: 99.98, threshold: ">=99.9", passed: true },
        { metric: "checkout_error_percent", before: 38.4, after: 0.8, threshold: "<=1.0", passed: true },
        { metric: "kafka_lag", before: 11842, after: 620, threshold: "<=1000", passed: true }
      ]
    }, refs, offset);
    runtime.append(runId, "outcome.classified", "evaluator", {
      classification: "confirmed_system_bug",
      secondary_learning: rejectedDiagnosis ? "agent_false_positive" : "none",
      explanation: rejectedDiagnosis
        ? "A checkout configuration regression caused the incident; the initial diagnosis was unsupported."
        : "A checkout configuration regression caused the incident and the accepted diagnosis was evidence-grounded."
    }, refs, offset + 1);
    runtime.append(runId, "regression.created", "evolve", runtime.bundle.regression, ["ev-metric-kafka-healthy", "ev-trace-payment-refused", "ev-commit-checkout"], offset + 2);
    const evaluation = evaluateCandidate({ events: runtime.ledger.list(runId), bundle: runtime.bundle });
    runtime.append(runId, "policy.evaluated", "evolve", evaluation, [], offset + 3);
    return runtime.append(runId, "loop.learning_complete", "runtime", { step: "verify and learn" }, refs, offset + 4);
  }
];

function stageFor(events) {
  if (events.some((event) => event.type === "policy.evaluated")) return "Learning recorded";
  if (events.some((event) => event.type === "repair.executed")) return "Verifying recovery";
  if (events.some((event) => event.type === "approval.requested") && !events.some((event) => event.type === "approval.granted")) return "Owner approval";
  if (events.some((event) => event.type === "evaluation.accepted")) return "Repair planning";
  if (events.some((event) => event.type === "evaluation.rejected")) return "Replanning";
  if (events.some((event) => event.type === "hypothesis.proposed")) return "Adversarial evaluation";
  return "Evidence collection";
}

function incidentFor(events, fallback) {
  const opened = events.find((event) => event.type === "incident.opened")?.payload;
  return opened ? { ...fallback, ...opened } : fallback;
}

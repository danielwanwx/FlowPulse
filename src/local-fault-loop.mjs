import { createHash, randomUUID } from "node:crypto";

export const LOCAL_FAULT_LOOP_SCHEMA_VERSION = "flowpulse.local-fault-loop.v2";
export const LOCAL_FAULT_LOOP_CASES = Object.freeze([
  Object.freeze({
    id: "checkout-payment-config",
    title: "Checkout payment endpoint regression",
    root_component: "checkout",
    affected_components: ["checkout", "payment", "kafka", "accounting", "fraud-detection"],
    fault: "payment_endpoint_unreachable",
    root_cause: "checkout payment endpoint configuration selected payment:9090",
    false_hypothesis: "Kafka initiated the incident",
    repair: "restore_checkout_payment_endpoint",
    risk: "low"
  }),
  Object.freeze({
    id: "kafka-consumer-pause",
    title: "Kafka consumer pause",
    root_component: "kafka",
    affected_components: ["kafka", "accounting", "fraud-detection"],
    fault: "consumer_group_paused",
    root_cause: "the isolated accounting consumer group was paused before lag accumulated",
    false_hypothesis: "Checkout payment failures initiated the lag",
    repair: "resume_isolated_consumer_group",
    risk: "low"
  }),
  Object.freeze({
    id: "database-pool-exhaustion",
    title: "Database connection pool exhaustion",
    root_component: "accounting",
    affected_components: ["accounting", "kafka"],
    fault: "database_pool_exhausted",
    root_cause: "the isolated accounting database pool reached its configured connection ceiling",
    false_hypothesis: "Kafka broker health initiated accounting timeouts",
    repair: "reset_isolated_connection_pool",
    risk: "low"
  })
]);

const POSITIVE_ROUNDS = 3;
const MAX_REMEDIATION_ATTEMPTS = 2;
const NEGATIVE_CASE = Object.freeze({ id: "insufficient-evidence", title: "Insufficient evidence anomaly", root_component: "checkout", affected_components: ["checkout"], fault: "ambiguous_anomaly", root_cause: null, false_hypothesis: "A repair target is known", repair: null, risk: "unknown" });
const ROLE_TOOLS = Object.freeze({
  observer: ["read_source_freshness", "read_signal_summaries"],
  orchestrator: ["read_workflow_projection"],
  investigator: ["read_evidence_summaries", "read_selected_component"],
  evaluator: ["read_cited_hypotheses", "read_evidence_summaries"]
});
const CASES = new Map(LOCAL_FAULT_LOOP_CASES.map((item) => [item.id, item]));

export class LocalFaultLoopError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalFaultLoopError";
    this.code = code;
  }
}

export class LocalFaultLoop {
  constructor({ ledger, modelAdapter, now = () => Date.now(), fixtureOptions = {}, topologyProvider = null } = {}) {
    if (!ledger?.append || !ledger?.list) throw new Error("LocalFaultLoop requires an append-only ledger");
    if (!modelAdapter?.respond || !modelAdapter?.preflight) throw new Error("LocalFaultLoop requires a provider adapter");
    this.ledger = ledger;
    this.modelAdapter = modelAdapter;
    this.now = now;
    this.fixtureOptions = fixtureOptions;
    this.topologyProvider = typeof topologyProvider === "function" ? topologyProvider : null;
    this.executions = new Map();
  }

  async start(input = {}) {
    const existing = this.#findReservation(input);
    if (existing) return this.#startProjection(existing);
    const reservation = this.#reserve(input);
    if (reservation.inserted) this.#launch(reservation);
    return this.#startProjection(reservation);
  }

  async run(input = {}) {
    const reservation = this.#reserve(input);
    if (!reservation.inserted) return this.project(reservation.session.runId);
    return this.#execute(reservation);
  }

  async runNegative({ round = 1, idempotencyKey = null } = {}) {
    return this.run({ caseId: NEGATIVE_CASE.id, round, idempotencyKey });
  }

  async #execute(reservation) {
    try {
      return reservation.negative ? await this.#runNegative(reservation) : await this.#runPositive(reservation);
    } catch (error) {
      if (!this.#terminal(reservation.session.runId)) this.#append(reservation.session, "local_fault_loop.failed", "runtime", { state: "failed", stage: "failed", reason: safeLoopFailureReason(error) });
      throw error;
    }
  }

  async #runPositive({ definition, session }) {
    const simulator = new FixtureSimulator(definition, session.runId, {
      verificationFailures: boundedFailureCount(this.fixtureOptions?.verificationFailuresByCase?.[definition.id])
    });
    try {
      session.topology = await this.#topologyFor(session, definition);
    } catch {
      this.#append(session, "local_fault_loop.failed", "runtime", { state: "failed", reason: "local_fault_loop_topology_unavailable" });
      throw new LocalFaultLoopError("local_fault_loop_topology_unavailable");
    }
    const baseline = simulator.captureBaseline();
    const baselineEvent = this.#append(session, "local_fault_loop.baseline.captured", "observer", baseline.payload, baseline.refs);
    const fault = simulator.inject();
    const injection = this.#append(session, "local_fault_loop.fault.injected", "fixture-injector", fault.payload, fault.refs, baselineEvent.id);
    for (const record of fault.evidence) this.#append(session, "local_fault_loop.evidence.recorded", "evidence-ledger", record, [record.id], injection.id);
    const topology = this.#append(session, "local_fault_loop.topology.bound", "observer", {
      schema_version: session.topology.schema_version,
      projection_revision: session.topology.projection_revision,
      selected_component: definition.root_component,
      affected_components: definition.affected_components,
      source_truth: session.topology.source_truth,
      runtime_node_count: session.topology.runtime_node_count
    }, fault.refs, injection.id);

    const evidence = [...baseline.evidence, ...fault.evidence];
    const observer = await this.#callRole(session, "observer", definition, evidence, "Detect bounded anomalies without assuming an initiating cause.", topology.id);
    const incident = this.#append(session, "incident.opened", "observer", {
      title: definition.title,
      severity: "SEV-2",
      environment: "isolated local fixture",
      summary: "A controlled reversible fault was detected in the local simulator."
    }, fault.symptom_ids, observer.id);
    const detected = this.#append(session, "local_fault_loop.observer.detected", "observer", {
      stage: "detect",
      anomaly_ids: fault.symptom_ids,
      affected_components: definition.affected_components,
      bounded_incident: true
    }, fault.symptom_ids, incident.id);
    const orchestrator = await this.#callRole(session, "orchestrator", definition, evidence, "Select the read-only fault-to-recovery workflow and preserve authority boundaries.", detected.id);
    const routed = this.#append(session, "local_fault_loop.orchestrator.routed", "orchestrator", {
      stage: "diagnose",
      workflow: ["detect", "diagnose", "evaluate", "plan", "authorize", "repair", "verify", "recovered"],
      requested_agent: "orchestrator",
      responding_agent: "orchestrator"
    }, fault.refs, orchestrator.id);
    const investigator = await this.#callRole(session, "investigator", definition, evidence, "Investigate the first causal condition using only the bounded evidence.", routed.id);
    const falseHypothesis = this.#append(session, "local_fault_loop.hypothesis.proposed", "investigator", {
      id: `hyp-${session.runId}-false`,
      claim: definition.false_hypothesis,
      confidence: 0.42,
      ground_truth: false
    }, fault.false_causal_refs, investigator.id);
    const evaluator = await this.#callRole(session, "evaluator", definition, evidence, "Adversarially reject correlation without causal evidence, then assess the supported root cause.", falseHypothesis.id);
    const rejected = this.#append(session, "local_fault_loop.evaluation.rejected", "evaluator", {
      stage: "evaluate",
      hypothesis_id: falseHypothesis.payload.id,
      reason: "The candidate is downstream or lacks the earliest causal mechanism.",
      score: 0.18,
      false_causal_rejected: true
    }, fault.false_causal_refs, evaluator.id);
    const accepted = this.#append(session, "local_fault_loop.hypothesis.accepted", "investigator", {
      id: `hyp-${session.runId}-root`,
      claim: definition.root_cause,
      confidence: 0.94,
      ground_truth: true,
      root_component: definition.root_component
    }, fault.root_cause_refs, rejected.id);
    const verdict = this.#append(session, "local_fault_loop.evaluation.accepted", "evaluator", {
      stage: "evaluate",
      hypothesis_id: accepted.payload.id,
      reason: "The bounded change, direct mechanism, and temporal order identify the initiating condition.",
      score: 0.94,
      root_cause_accuracy: true
    }, fault.root_cause_refs, accepted.id);
    const plan = this.#append(session, "local_fault_loop.plan.proposed", "orchestrator", {
      stage: "plan",
      repair: definition.repair,
      target: definition.root_component,
      risk: definition.risk,
      reversible: true,
      verification_plan: ["root_condition_removed", "direct_symptom_cleared", "downstream_lag_converged"],
      authority: "isolated_demo_task_authorization"
    }, fault.root_cause_refs, verdict.id);
    const authority = this.#append(session, "local_fault_loop.authority.decided", "runtime", {
      stage: "approve-or-auto",
      outcome: "auto_execute_pre_authorized",
      reason: "Low-risk reversible repair is confined to the in-memory fixture simulator.",
      execution_scope: "local_memory_only"
    }, [], plan.id);
    let repairParent = authority.id;
    let verification;
    let verified;
    for (let attempt = 1; attempt <= MAX_REMEDIATION_ATTEMPTS; attempt += 1) {
      const repair = simulator.repair();
      for (const record of repair.evidence) this.#append(session, "local_fault_loop.evidence.recorded", "evidence-ledger", record, [record.id], repairParent);
      const repaired = this.#append(session, "local_fault_loop.repair.executed", "remediation", {
        stage: "repair",
        repair: definition.repair,
        target: definition.root_component,
        attempt,
        bounded: true,
        execution_scope: "local_memory_only",
        rollback_available: true,
        result: repair.result
      }, repair.refs, repairParent);
      verification = simulator.verify();
      for (const record of verification.evidence) this.#append(session, "local_fault_loop.evidence.recorded", "evidence-ledger", record, [record.id], repaired.id);
      verified = this.#append(session, "local_fault_loop.verification.completed", "verifier", verification, verification.refs, repaired.id);
      if (verification.passed) break;
      const rollback = simulator.rollback();
      for (const record of rollback.evidence) this.#append(session, "local_fault_loop.evidence.recorded", "evidence-ledger", record, [record.id], verified.id);
      const rolledBack = this.#append(session, "local_fault_loop.repair.rolled_back", "remediation", {
        stage: "repair",
        attempt,
        execution_scope: "local_memory_only",
        reason: "independent_verification_failed",
        result: rollback.result
      }, rollback.refs, verified.id);
      if (attempt === MAX_REMEDIATION_ATTEMPTS) {
        this.#append(session, "local_fault_loop.stopped", "runtime", { state: "needs_human", reason: "fixture_recovery_verification_failed", attempts: attempt }, verification.refs, rolledBack.id);
        return this.project(session.runId);
      }
      const reinvestigator = await this.#callRole(session, "investigator", definition, evidence, "Re-investigate after independent verification failed; preserve the original causal ordering.", rolledBack.id);
      const reevaluator = await this.#callRole(session, "evaluator", definition, evidence, "Adversarially re-check the evidence before a second bounded repair attempt.", reinvestigator.id);
      repairParent = this.#append(session, "local_fault_loop.plan.replanned", "orchestrator", {
        stage: "plan",
        repair: definition.repair,
        attempt: attempt + 1,
        reason: "independent_verification_failed",
        authority: "isolated_demo_task_authorization"
      }, fault.root_cause_refs, reevaluator.id).id;
    }
    if (!verification?.passed || !verified) throw new LocalFaultLoopError("local_fault_loop_verification_unreachable");
    this.#append(session, "local_fault_loop.recovered", "runtime", {
      stage: "recovered",
      state: "recovered",
      recovery_slo_met: true,
      root_cause_accuracy: true,
      false_causal_rejected: true
    }, verification.refs, verified.id);
    return this.project(session.runId);
  }

  async #runNegative({ definition, session }) {
    try {
      session.topology = await this.#topologyFor(session, definition);
    } catch {
      this.#append(session, "local_fault_loop.failed", "runtime", { state: "failed", reason: "local_fault_loop_topology_unavailable" });
      throw new LocalFaultLoopError("local_fault_loop_topology_unavailable");
    }
    const anomaly = evidenceRecord(session, "metric", "checkout", "unexpected checkout error increase", "impact", 1);
    const anomalyEvent = this.#append(session, "local_fault_loop.evidence.recorded", "evidence-ledger", anomaly, [anomaly.id]);
    const topology = this.#append(session, "local_fault_loop.topology.bound", "observer", {
      schema_version: session.topology.schema_version,
      projection_revision: session.topology.projection_revision,
      selected_component: definition.root_component,
      affected_components: definition.affected_components,
      source_truth: session.topology.source_truth,
      runtime_node_count: session.topology.runtime_node_count
    }, [anomaly.id], anomalyEvent.id);
    const evidence = [anomaly];
    const observer = await this.#callRole(session, "observer", definition, evidence, "Detect the anomaly but do not infer a root cause.", topology.id);
    const incident = this.#append(session, "incident.opened", "observer", { title: definition.title, severity: "SEV-3", environment: "isolated local fixture", summary: "A bounded anomaly was detected but has no causal source evidence." }, [anomaly.id], observer.id);
    const detected = this.#append(session, "local_fault_loop.observer.detected", "observer", { stage: "detect", anomaly_ids: [anomaly.id], affected_components: ["checkout"], bounded_incident: true }, [anomaly.id], incident.id);
    const orchestrator = await this.#callRole(session, "orchestrator", definition, evidence, "Route the anomaly to evidence collection and request a human gate if the evidence remains insufficient.", detected.id);
    const investigator = await this.#callRole(session, "investigator", definition, evidence, "Assess the evidence gap without proposing a repair.", orchestrator.id);
    const candidate = this.#append(session, "local_fault_loop.hypothesis.proposed", "investigator", { id: `hyp-${session.runId}-unsupported`, claim: "A repair target is known", confidence: 0.12, ground_truth: false }, [anomaly.id], investigator.id);
    const evaluator = await this.#callRole(session, "evaluator", definition, evidence, "Reject the unsupported causal claim and state that approval is not granted.", candidate.id);
    const rejected = this.#append(session, "local_fault_loop.evaluation.rejected", "evaluator", { stage: "evaluate", hypothesis_id: candidate.payload.id, reason: "No change, direct mechanism, timing, or counter-evidence is available.", score: 0, false_causal_rejected: true }, [anomaly.id], evaluator.id);
    const gate = this.#append(session, "local_fault_loop.authority.decided", "runtime", { stage: "approve-or-auto", outcome: "needs_human", reason: "insufficient_evidence", execution_scope: "none" }, [anomaly.id], rejected.id);
    this.#append(session, "local_fault_loop.stopped", "runtime", { stage: "stopped", state: "needs_human", reason: "insufficient_evidence", repair_executed: false }, [anomaly.id], gate.id);
    return this.project(session.runId);
  }

  async runAll({ rounds = POSITIVE_ROUNDS, includeNegative = true } = {}) {
    if (!Number.isInteger(rounds) || rounds !== POSITIVE_ROUNDS) throw new LocalFaultLoopError("local_fault_loop_round_count_invalid");
    const runs = [];
    for (const definition of LOCAL_FAULT_LOOP_CASES) {
      for (let round = 1; round <= rounds; round++) runs.push(await this.run({ caseId: definition.id, round }));
    }
    if (includeNegative) runs.push(await this.runNegative({ round: 1 }));
    return suiteProjection(runs);
  }

  project(runId) {
    const events = this.ledger.list(runId);
    const started = events.find((event) => event.type === "local_fault_loop.run.started");
    if (!started) throw new LocalFaultLoopError("local_fault_loop_run_unavailable");
    const final = [...events].reverse().find((event) => ["local_fault_loop.recovered", "local_fault_loop.stopped", "local_fault_loop.failed"].includes(event.type));
    const roleResponses = events.filter((event) => event.type === "local_fault_loop.role.response").map((event) => event.payload);
    const citations = [...new Set(events.flatMap((event) => event.evidence_refs))].slice(0, 64);
    const state = final?.payload?.state || "running";
    const contextualWorkspaces = workspaceProjection(events, started, final, state);
    return {
      schema_version: LOCAL_FAULT_LOOP_SCHEMA_VERSION,
      run_id: runId,
      incident_id: started.incident_id,
      case_id: started.payload.case_id,
      round: started.payload.round,
      state,
      stage: loopStage(events, final, state),
      provider: roleResponses.at(-1)?.provider || null,
      citations,
      role_responses: roleResponses,
      contextual_workspaces: contextualWorkspaces,
      events: events.map((event, index) => ({
        ...projectEvent(event),
        contextual_workspaces: workspaceProjection(events.slice(0, index + 1), started)
      })),
      final: final ? { sequence: final.sequence, recorded_at: final.recorded_at, type: final.type, payload: final.payload } : null
    };
  }

  #findReservation(input) {
    const request = normalizeRequest(input);
    if (!request.idempotencyKey) return null;
    const event = this.ledger.get(reservationId(request.idempotencyKey));
    if (!event) return null;
    const payload = event.payload;
    if (event.type !== "local_fault_loop.reserved" || payload?.case_id !== request.definition.id || payload?.round !== request.round || payload?.idempotency_key !== request.idempotencyKey) throw new LocalFaultLoopError("local_fault_loop_idempotency_conflict");
    return reservationFromEvent(event, request.definition, request.negative);
  }

  #reserve(input) {
    const request = normalizeRequest(input);
    const session = this.#session({ definition: request.definition, round: request.round, negative: request.negative });
    const key = request.idempotencyKey || `generated-${session.runId}`;
    const reserved = this.ledger.appendIfAbsent({
      id: reservationId(key),
      runId: session.runId,
      incidentId: session.incidentId,
      type: "local_fault_loop.reserved",
      actor: "runtime",
      payload: {
        schema_version: LOCAL_FAULT_LOOP_SCHEMA_VERSION,
        run_id: session.runId,
        incident_id: session.incidentId,
        case_id: request.definition.id,
        round: request.round,
        idempotency_key: request.idempotencyKey,
        state: "running",
        stage: "monitor"
      },
      correlationId: `local-fault-loop:${session.runId}`,
      recordedAt: new Date(session.startedAt).toISOString()
    });
    if (!reserved.inserted) return reservationFromEvent(reserved.event, request.definition, request.negative);
    this.#append(session, "local_fault_loop.run.started", "runtime", {
      schema_version: LOCAL_FAULT_LOOP_SCHEMA_VERSION,
      case_id: request.definition.id,
      round: request.round,
      mode: "isolated_fixture",
      execution_scope: "local_memory_only",
      max_remediation_attempts: MAX_REMEDIATION_ATTEMPTS,
      state: "running",
      stage: "monitor"
    }, [], reserved.event.id);
    return { inserted: true, definition: request.definition, negative: request.negative, session };
  }

  #launch(reservation) {
    const completion = new Promise((resolve) => setTimeout(resolve, 200)).then(() => this.#execute(reservation));
    this.executions.set(reservation.session.runId, completion);
    void completion.catch(() => {}).finally(() => this.executions.delete(reservation.session.runId));
  }

  #startProjection(reservation) {
    const projection = this.project(reservation.session.runId);
    return {
      schema_version: LOCAL_FAULT_LOOP_SCHEMA_VERSION,
      run_id: projection.run_id,
      incident_id: projection.incident_id,
      state: projection.state,
      stage: projection.stage,
      events_url: `/api/demo/agent-loop/events?run_id=${encodeURIComponent(projection.run_id)}&after=0`,
      contextual_workspaces: projection.contextual_workspaces
    };
  }

  #terminal(runId) {
    return this.ledger.list(runId).some((event) => ["local_fault_loop.recovered", "local_fault_loop.stopped", "local_fault_loop.failed"].includes(event.type));
  }

  #session({ definition, round, negative }) {
    const runId = `local-loop-${definition.id}-${round}-${randomUUID()}`;
    const incidentId = `incident-local-${definition.id}-${round}-${randomUUID()}`;
    return { definition, runId, incidentId, negative, startedAt: this.now(), index: 0 };
  }

  #append(session, type, actor, payload, evidenceRefs = [], parentId = null) {
    const recordedAt = new Date(session.startedAt + session.index * 1_000).toISOString();
    session.index += 1;
    return this.ledger.append({
      id: `evt-${session.runId}-${session.index}`,
      runId: session.runId,
      incidentId: session.incidentId,
      type,
      actor,
      payload,
      evidenceRefs: [...new Set(evidenceRefs)],
      parentId,
      correlationId: `local-fault-loop:${session.runId}`,
      recordedAt
    });
  }

  async #topologyFor(session, definition) {
    if (!this.topologyProvider) return fixtureTopologyContext();
    const candidate = await this.topologyProvider({ runId: session.runId, incidentId: session.incidentId, selectedComponent: definition.root_component });
    const context = topologyContext(candidate);
    if (!context) throw new LocalFaultLoopError("local_fault_loop_topology_unavailable");
    return context;
  }

  async #callRole(session, role, definition, evidence, message, parentId) {
    const capability = await this.modelAdapter.preflight();
    if (capability?.provider_kind !== "codex-local" || capability?.availability !== "available") {
      this.#append(session, "local_fault_loop.failed", "runtime", { state: "failed", reason: "local_codex_provider_unavailable" }, [], parentId);
      throw new LocalFaultLoopError("local_codex_provider_unavailable");
    }
    const context = providerContext({ session, role, definition, evidence, message, negative: session.negative });
    const toolEvent = this.#append(session, "local_fault_loop.tool.completed", role, {
      role,
      tools: ROLE_TOOLS[role].map((tool) => ({ tool, result_count: toolResultCount(tool, evidence), raw_payload_excluded: true }))
    }, evidence.map((item) => item.id), parentId);
    let response;
    try {
      response = await this.modelAdapter.respond({ role, context });
    } catch (error) {
      this.#append(session, "local_fault_loop.failed", "runtime", {
        state: "failed",
        reason: "local_codex_provider_response_failed",
        provider_failure_reason: safeProviderFailureReason(error)
      }, evidence.map((item) => item.id), toolEvent.id);
      throw new LocalFaultLoopError("local_codex_provider_response_failed");
    }
    const safeAnswer = safeDisplayAnswer(response?.answer);
    if (!safeAnswer) {
      this.#append(session, "local_fault_loop.failed", "runtime", { state: "failed", stage: "failed", reason: "local_codex_provider_response_failed", provider_failure_reason: "provider_output_schema_invalid" }, evidence.map((item) => item.id), toolEvent.id);
      throw new LocalFaultLoopError("local_codex_provider_response_failed");
    }
    const safeHandoff = safeHandoffFor(response?.recommended_handoff);
    const responseEvent = this.#append(session, "local_fault_loop.role.response", role, {
      role,
      requested_agent: role,
      responding_agent: role,
      state: "completed",
      provider: safeProvider(capability),
      safe_answer: safeAnswer,
      answer_sha256: hash(String(response?.answer || "")),
      answer_bytes: Buffer.byteLength(String(response?.answer || ""), "utf8"),
      handoff: safeHandoff,
      recommended_handoff: safeHandoff,
      citations: evidence.map((item) => item.id),
      tools: toolEvent.payload.tools.map(({ tool, result_count }) => ({ tool, result_count }))
    }, evidence.map((item) => item.id), toolEvent.id);
    if (safeHandoff && safeHandoff.to !== role) this.#append(session, "local_fault_loop.handoff.recorded", role, { from: role, to: safeHandoff.to, reason: safeHandoff.reason }, evidence.map((item) => item.id), responseEvent.id);
    return responseEvent;
  }
}

class FixtureSimulator {
  constructor(definition, runId, { verificationFailures = 0 } = {}) {
    this.definition = definition;
    this.runId = runId;
    this.faulted = false;
    this.repairAttempt = 0;
    this.verificationFailures = verificationFailures;
  }

  captureBaseline() {
    const record = evidenceRecord({ runId: this.runId }, "trace", this.definition.root_component, "healthy local fixture baseline", "baseline", 0);
    return {
      payload: { stage: "monitor", healthy: true, ground_truth: "baseline", source: "local fixture simulator" },
      refs: [record.id],
      evidence: [record]
    };
  }

  inject() {
    this.faulted = true;
    const origin = evidenceRecord({ runId: this.runId }, "change", this.definition.root_component, this.definition.root_cause, "origin", 1);
    const direct = evidenceRecord({ runId: this.runId }, "trace", this.definition.root_component, `direct ${this.definition.fault} mechanism`, "mechanism", 2);
    const downstream = evidenceRecord({ runId: this.runId }, "metric", this.definition.affected_components.at(-1), "downstream impact increased after the initiating condition", "propagation", 3);
    const counter = evidenceRecord({ runId: this.runId }, "metric", this.definition.root_component === "kafka" ? "checkout" : "kafka", "counter-evidence separates downstream symptom from initiating condition", "counter_evidence", 4);
    const log = evidenceRecord({ runId: this.runId }, "log", this.definition.root_component, `bounded local log confirms ${this.definition.fault}`, "mechanism", 5);
    const evidence = [origin, direct, downstream, counter, log];
    return {
      payload: { stage: "fault", fault: this.definition.fault, root_component: this.definition.root_component, affected_components: this.definition.affected_components, reversible: true, execution_scope: "local_memory_only" },
      refs: evidence.map((item) => item.id),
      evidence,
      symptom_ids: [direct.id, downstream.id],
      false_causal_refs: [downstream.id, counter.id],
      root_cause_refs: [origin.id, direct.id, counter.id, log.id]
    };
  }

  repair() {
    if (!this.faulted) throw new LocalFaultLoopError("fixture_repair_without_fault");
    this.faulted = false;
    this.repairAttempt += 1;
    const record = evidenceRecord({ runId: this.runId }, "change", this.definition.root_component, `reversible local repair ${this.definition.repair} applied`, "repair", 6 + (this.repairAttempt - 1) * 4);
    return { result: "applied", refs: [record.id], evidence: [record] };
  }

  verify() {
    const passed = this.faulted === false && this.verificationFailures === 0;
    if (this.verificationFailures > 0) this.verificationFailures -= 1;
    const offset = (this.repairAttempt - 1) * 4;
    const healthy = evidenceRecord({ runId: this.runId }, "trace", this.definition.root_component, passed ? "direct symptom cleared after local repair" : "direct symptom remains after local repair", "verification", 7 + offset);
    const lag = evidenceRecord({ runId: this.runId }, "metric", this.definition.affected_components.at(-1), passed ? "downstream backlog converged after root condition removal" : "downstream backlog remains after repair", "verification", 8 + offset);
    return {
      stage: "verify",
      passed,
      checks: [
        { id: "root_condition_removed", passed },
        { id: "direct_symptom_cleared", passed },
        { id: "downstream_lag_converged", passed }
      ],
      recovery_slo: { target: "all three checks pass", observed: passed ? "met" : "failed" },
      refs: [healthy.id, lag.id],
      evidence: [healthy, lag]
    };
  }

  rollback() {
    this.faulted = true;
    const record = evidenceRecord({ runId: this.runId }, "change", this.definition.root_component, "local repair rolled back after failed independent verification", "rollback", 9 + (this.repairAttempt - 1) * 4);
    return { result: "rolled_back", refs: [record.id], evidence: [record] };
  }
}

function providerContext({ session, role, definition, evidence, message, negative }) {
  return {
    role,
    message,
    page_mode: "live",
    selected_component: definition.root_component,
    topology: session.topology,
    source_truth: { ...session.topology.source_truth, source_status: "isolated_local", freshness_ms: 0 },
    incident: { run_id: session.runId, incident_id: session.incidentId, stage: negative ? "Evidence gap" : "Fault-to-recovery", stage_status: "recorded" },
    human_gate: { status: negative ? "requested" : "not_required" },
    evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, entity: item.entity, source: "local fixture simulator", observed_at: item.observed_at, record_sha256: item.record_sha256, title: item.summary })),
    citations: evidence.map((item) => item.id),
    tool_allowlist: ROLE_TOOLS[role],
    role_context: { local_fixture: true, case_id: definition.id, ground_truth_available: !negative }
  };
}

function evidenceRecord(session, kind, entity, summary, faultLocality, order) {
  const id = `ev-local-${String(session.runId).replace(/[^A-Za-z0-9]/g, "").slice(-20)}-${order}-${kind}`;
  return {
    id,
    kind,
    entity,
    summary,
    fault_locality: faultLocality,
    observed_at: new Date(Date.UTC(2026, 6, 20, 12, 0, order)).toISOString(),
    record_sha256: hash({ id, kind, entity, summary, faultLocality, order })
  };
}

function suiteProjection(runs) {
  const positive = runs.filter((run) => run.case_id !== "insufficient-evidence");
  const negative = runs.find((run) => run.case_id === "insufficient-evidence") || null;
  return {
    schema_version: LOCAL_FAULT_LOOP_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    run_count: runs.length,
    positive_run_count: positive.length,
    recovered_count: positive.filter((run) => run.state === "recovered").length,
    negative_case: negative ? { run_id: negative.run_id, state: negative.state } : null,
    runs
  };
}

function projectEvent(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    recorded_at: event.recorded_at,
    type: event.type,
    actor: event.actor,
    evidence_refs: event.evidence_refs,
    payload: event.payload
  };
}

function loopStage(events, final, state) {
  if (state === "recovered") return "recovered";
  if (state === "needs_human") return "needs-human";
  if (state === "failed") return "failed";
  for (const event of [...events].reverse()) {
    if (typeof event.payload?.stage === "string") return event.payload.stage;
  }
  return "monitor";
}

function workspaceProjection(events, started, final = null, state = null) {
  const terminal = final || [...events].reverse().find((event) => ["local_fault_loop.recovered", "local_fault_loop.stopped", "local_fault_loop.failed"].includes(event.type)) || null;
  const currentState = state || terminal?.payload?.state || "running";
  const topology = [...events].reverse().find((event) => event.type === "local_fault_loop.topology.bound");
  const definition = started?.payload?.case_id === NEGATIVE_CASE.id ? NEGATIVE_CASE : CASES.get(started?.payload?.case_id);
  const selectedComponent = topology?.payload?.selected_component || definition?.root_component || null;
  const incidentOpen = events.some((event) => event.type === "incident.opened" && event.actor === "observer");
  const remediationReady = events.some((event) => event.type === "local_fault_loop.plan.proposed" || event.type === "local_fault_loop.repair.executed");
  const verified = events.some((event) => event.type === "local_fault_loop.verification.completed");
  const compareReady = verified && Boolean(terminal);
  const current = events.at(-1) || started || null;
  const stage = loopStage(events, terminal, currentState);
  return {
    context: {
      run_id: started?.run_id || null,
      incident_id: started?.incident_id || null,
      selected_component: selectedComponent,
      timeline: {
        position: Number.isInteger(current?.sequence) ? current.sequence : 0,
        event_id: current?.id || null,
        stage,
        terminal_state: terminal?.payload?.state || null
      }
    },
    actions: {
      view_diagnosis: actionAvailability(incidentOpen, "bounded_incident_opened"),
      open_recovery_console: actionAvailability(remediationReady, "evaluated_remediation_plan_or_repair_started"),
      compare_recovery: {
        available: compareReady,
        prerequisites: [
          { id: "independent_verification_completed", satisfied: verified },
          { id: "terminal_state_recorded", satisfied: Boolean(terminal) }
        ]
      }
    }
  };
}

function actionAvailability(available, prerequisite) {
  return { available, prerequisites: [{ id: prerequisite, satisfied: available }] };
}

function toolResultCount(tool, evidence) {
  if (tool === "read_workflow_projection") return 1;
  if (tool === "read_selected_component") return 1;
  if (tool === "read_cited_hypotheses") return 1;
  return evidence.length;
}

function safeProvider(value) {
  return {
    provider_kind: value.provider_kind === "codex-local" ? "codex-local" : "unavailable",
    truth_label: typeof value.truth_label === "string" ? value.truth_label : "LOCAL CODEX",
    model_label: typeof value.model_label === "string" ? value.model_label : "Codex CLI"
  };
}

function safeProviderFailureReason(error) {
  const code = typeof error?.code === "string" ? error.code : "provider_response_failed";
  return /^(codex|provider|openai)_[a-z_]{1,80}$/.test(code) ? code : "provider_response_failed";
}

function safeLoopFailureReason(error) {
  const code = typeof error?.code === "string" ? error.code : "local_fault_loop_execution_failed";
  return /^[a-z][a-z0-9_]{2,100}$/.test(code) ? code : "local_fault_loop_execution_failed";
}

function safeDisplayAnswer(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 1_200 || [...value].length > 280) return null;
  const answer = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b(?:authorization|bearer|api[_ -]?key)\s*[:=]\s*[^\s]+/gi, "[redacted]");
  return answer && Buffer.byteLength(answer, "utf8") <= 1_200 && [...answer].length <= 280 ? answer : null;
}

function validHandoff(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ["observer", "orchestrator", "investigator", "evaluator"].includes(value.to)
    && typeof value.reason === "string" && value.reason.length > 0 && Buffer.byteLength(value.reason, "utf8") <= 200);
}

function safeHandoffFor(value) {
  if (!validHandoff(value)) return null;
  const reason = safeDisplayAnswer(value.reason);
  return reason && Buffer.byteLength(reason, "utf8") <= 200 ? { to: value.to, reason } : null;
}

function topologyContext(value) {
  if (!value || value.schema_version !== "flowpulse.topology-views.v2" || !/^[a-f0-9]{64}$/.test(value.projection_revision || "")) return null;
  const truth = value.truth && typeof value.truth === "object" ? value.truth : {};
  const source_health = ["live", "stale", "disconnected", "unavailable"].includes(truth.source_health) ? truth.source_health : "unavailable";
  const evidence_mode = ["captured_fixture", "live", "unavailable"].includes(truth.evidence_mode) ? truth.evidence_mode : "unavailable";
  const execution_mode = ["deterministic_replay", "live", "unavailable"].includes(truth.execution_mode) ? truth.execution_mode : "unavailable";
  const label = ["CAPTURED", "LIVE", "UNAVAILABLE"].includes(truth.label) ? truth.label : "UNAVAILABLE";
  const runtime_node_count = Number.isInteger(value.architecture?.runtime_data?.graph?.total_nodes) ? value.architecture.runtime_data.graph.total_nodes : null;
  return { schema_version: value.schema_version, projection_revision: value.projection_revision, runtime_node_count, source_truth: { source_health, evidence_mode, execution_mode, label } };
}

function fixtureTopologyContext() {
  return {
    schema_version: "flowpulse.topology-views.v2",
    projection_revision: hash("flowpulse.local-fault-loop.fixture-topology.v1"),
    runtime_node_count: null,
    source_truth: { source_health: "unavailable", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay", label: "CAPTURED" }
  };
}

function boundedFailureCount(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_REMEDIATION_ATTEMPTS) : 0;
}

function normalizeRequest(value) {
  const caseId = value?.caseId;
  const definition = caseId === NEGATIVE_CASE.id ? NEGATIVE_CASE : caseFor(caseId);
  const round = value?.round;
  if (!Number.isInteger(round) || round < 1 || round > POSITIVE_ROUNDS) throw new LocalFaultLoopError("local_fault_loop_round_invalid");
  const idempotencyKey = value?.idempotencyKey ?? null;
  if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(idempotencyKey))) throw new LocalFaultLoopError("local_fault_loop_idempotency_key_invalid");
  return { definition, round, idempotencyKey, negative: definition.id === NEGATIVE_CASE.id };
}

function reservationId(key) {
  return `local-fault-loop-reservation-${hash(key).slice(0, 48)}`;
}

function reservationFromEvent(event, definition, negative) {
  const payload = event.payload;
  return {
    inserted: false,
    definition,
    negative,
    session: {
      definition,
      runId: payload.run_id,
      incidentId: payload.incident_id,
      negative,
      startedAt: Date.parse(event.recorded_at),
      index: 0
    }
  };
}

function caseFor(id) {
  const definition = CASES.get(id);
  if (!definition) throw new LocalFaultLoopError("local_fault_loop_case_invalid");
  return definition;
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

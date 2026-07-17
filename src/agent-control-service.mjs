import { ROLE_MANIFESTS } from "./agent-team-harness.mjs";

export const AGENT_ACTIONS = Object.freeze({
  summarize: { label: "Summarize incident", consequential: false },
  advance: { label: "Continue investigation", consequential: false },
  review_recovery: { label: "Review recovery plan", consequential: false },
  verify_recovery: { label: "Monitor verification", consequential: false },
  review_learning: { label: "Review regression", consequential: false }
});

export const AGENT_GRAPH_NODES = Object.freeze([
  node("manager", "Manager", "Human interface", "agent", 9, 46),
  node("monitor", "Monitor", "Runtime triage", "monitor", 25, 18),
  node("evidence", "Evidence", "Telemetry collection", "evidence", 25, 46),
  node("diagnosis", "Diagnosis", "Causal maker", "diagnosis", 42, 30),
  node("evaluator", "Evaluator", "Adversarial checker", "adversarial_evaluator", 58, 30),
  node("planner", "Planner", "Bounded remediation", "remediation_planner", 73, 18),
  node("owner", "Owner gate", "Human approval", "owner", 73, 46),
  node("executor", "Repair executor", "Allowlisted action", "executor", 73, 74),
  node("verification", "Verification", "Post-action checker", "verification", 58, 74),
  node("evolve", "Evolve", "Offline candidate maker", "evolve", 42, 74),
  node("test", "Test", "Independent backtest", "test", 25, 74),
  node("ledger", "Evidence ledger", "Runtime authority", "ledger", 91, 46),
  node("langfuse", "Langfuse", "Async observation", "langfuse", 91, 74)
]);

export const AGENT_GRAPH_EDGES = Object.freeze([
  edge("manager-monitor", "manager", "monitor", "triage request"),
  edge("manager-evidence", "manager", "evidence", "evidence task"),
  edge("evidence-diagnosis", "evidence", "diagnosis", "evidence manifest"),
  edge("diagnosis-evaluator", "diagnosis", "evaluator", "candidate diagnosis"),
  edge("evaluator-evidence", "evaluator", "evidence", "bounded replan"),
  edge("evaluator-planner", "evaluator", "planner", "accepted cause"),
  edge("planner-owner", "planner", "owner", "repair proposal"),
  edge("owner-executor", "owner", "executor", "approved scope"),
  edge("executor-verification", "executor", "verification", "execution receipt"),
  edge("verification-evolve", "verification", "evolve", "classified outcome"),
  edge("evolve-test", "evolve", "test", "frozen candidate"),
  edge("manager-ledger", "manager", "ledger", "attributed decisions"),
  edge("test-ledger", "test", "ledger", "backtest record"),
  edge("ledger-langfuse", "ledger", "langfuse", "async trace projection")
]);

export class AgentControlService {
  constructor({ runtime, langfuseEnabled = false }) {
    if (!runtime?.ledger?.list || !runtime?.state || !runtime?.append) throw new Error("AgentControlService requires an IncidentRuntime");
    this.runtime = runtime;
    this.langfuseEnabled = Boolean(langfuseEnabled);
  }

  project(runId = this.runtime.ensureRun()) {
    const state = this.runtime.state(runId);
    const events = state.events;
    const statuses = projectStatuses(events, state, this.langfuseEnabled);
    const nodes = AGENT_GRAPH_NODES.map((item) => ({
      ...item,
      status: statuses[item.id],
      manifest: manifestFor(item.role)
    }));
    const edges = AGENT_GRAPH_EDGES.map((item) => ({ ...item, status: edgeStatus(item, statuses) }));
    return {
      schema_version: "flowpulse.agent_control.v1",
      run_id: runId,
      incident_id: state.incident.id,
      authority: "append-only-ledger",
      streaming: "ledger-derived-sse",
      langfuse: this.langfuseEnabled ? "observing" : "not_configured",
      current_agent_id: currentAgent(statuses),
      last_event_id: events.at(-1)?.id ?? null,
      last_sequence: events.at(-1)?.sequence ?? 0,
      report: managerReport(state),
      actions: allowedActions(state),
      graph: { nodes, edges },
      activity: agentActivity(events)
    };
  }

  message(runId, rawMessage) {
    const message = String(rawMessage || "").trim();
    if (!message) throw new Error("Manager message is required");
    if (message.length > 2_000) throw new Error("Manager message is too long");
    const before = this.runtime.state(runId);
    const received = this.runtime.append(runId, "manager.message.received", "human", { message });
    const intent = intentFor(message, before);
    const report = managerReport(before);
    const response = responseFor(intent, report, before);
    this.runtime.append(runId, "manager.response.created", "manager", {
      intent,
      message: response,
      citations: report.citations,
      safe_actions: allowedActions(before).map((item) => item.id),
      deterministic: true
    }, report.citations, 0, received.id);
    return { intent, message: response, projection: this.project(runId) };
  }

  act(runId, actionId) {
    const state = this.runtime.state(runId);
    const allowed = new Set(allowedActions(state).map((item) => item.id));
    if (!allowed.has(actionId)) throw new Error(`Agent action is not available: ${actionId}`);
    if (actionId !== "advance") return this.project(runId);
    this.runtime.append(runId, "manager.delegation.created", "manager", {
      action: "advance",
      target: nextRole(state.events),
      consequential: false
    });
    this.runtime.next(runId);
    return this.project(runId);
  }
}

function managerReport(state) {
  const events = state.events;
  const accepted = last(events, "evaluation.accepted");
  const rejected = last(events, "evaluation.rejected");
  const hypothesis = accepted && [...events].reverse().find((item) => item.type === "hypothesis.proposed" && item.payload.id === accepted.payload.hypothesis_id);
  const repair = last(events, "repair.proposed");
  const verification = last(events, "verification.completed");
  const regression = last(events, "regression.created");
  const citations = unique([
    ...(hypothesis?.evidence_refs || []),
    ...(accepted?.evidence_refs || []),
    ...(rejected?.evidence_refs || []),
    ...(repair?.evidence_refs || []),
    ...(verification?.evidence_refs || [])
  ]);
  return {
    title: reportTitle(state),
    summary: reportSummary(state, hypothesis, repair, verification),
    stage: state.stage,
    confidence: accepted?.payload.score ?? hypothesis?.payload.confidence ?? null,
    root_cause: hypothesis?.payload.claim ?? null,
    rejected_diagnosis: rejected ? {
      hypothesis_id: rejected.payload.hypothesis_id,
      reason: rejected.payload.reason,
      score: rejected.payload.score
    } : null,
    repair: repair ? {
      id: repair.payload.id,
      action: repair.payload.action,
      target: repair.payload.target,
      from: repair.payload.from,
      to: repair.payload.to,
      expected_effect: repair.payload.expected_effect,
      bounded: repair.payload.bounded === true
    } : null,
    verification: verification?.payload ?? null,
    regression: regression?.payload ?? null,
    citations,
    human_gate: state.waiting_for_approval ? "owner_approval_required" : null,
    data_mode: state.mode === "development" ? "real_local_runtime" : "captured_deterministic_replay"
  };
}

function projectStatuses(events, state, langfuseEnabled) {
  const has = (type) => events.some((item) => item.type === type);
  const accepted = has("evaluation.accepted");
  const rejected = has("evaluation.rejected");
  const proposed = has("hypothesis.proposed");
  const repair = has("repair.proposed");
  const approved = has("approval.granted");
  const executed = has("repair.executed");
  const verified = has("verification.completed");
  const evolved = has("regression.created");
  const tested = has("policy.evaluated");
  return {
    manager: tested ? "complete" : state.waiting_for_approval ? "waiting" : "running",
    monitor: has("incident.opened") ? "complete" : "standby",
    evidence: accepted ? "complete" : has("evidence.queried") ? "running" : "standby",
    diagnosis: accepted ? "complete" : rejected ? "rejected" : proposed ? "running" : "standby",
    evaluator: accepted ? "complete" : rejected ? "rejected" : proposed ? "running" : "standby",
    planner: repair ? "complete" : accepted ? "running" : "standby",
    owner: approved ? "complete" : state.waiting_for_approval ? "waiting" : "standby",
    executor: executed ? "complete" : approved ? "running" : "standby",
    verification: verified ? "complete" : executed ? "running" : "standby",
    evolve: evolved ? "complete" : verified ? "running" : "standby",
    test: tested ? "complete" : evolved ? "running" : "standby",
    ledger: "recording",
    langfuse: langfuseEnabled ? "observing" : "unconfigured"
  };
}

function allowedActions(state) {
  if (state.complete) return [action("review_learning")];
  if (state.waiting_for_approval) return [action("review_recovery", true)];
  if (state.events.some((item) => item.type === "repair.executed")) return [action("verify_recovery")];
  return [action("advance")];
}

function action(id, requiresOwner = false) {
  return { id, ...AGENT_ACTIONS[id], requires_owner: requiresOwner };
}

function reportTitle(state) {
  if (state.complete) return "Recovery verified and regression recorded";
  if (state.waiting_for_approval) return "Bounded recovery is ready for owner review";
  if (state.events.some((item) => item.type === "evaluation.accepted")) return "Root cause confirmed";
  if (state.events.some((item) => item.type === "evaluation.rejected")) return "Unsupported diagnosis rejected";
  return "Incident evidence is being collected";
}

function reportSummary(state, hypothesis, repair, verification) {
  if (verification) return "Fresh verification evidence passed the recovery checks. The learning path remains isolated from production policy promotion.";
  if (state.waiting_for_approval && repair) return `${hypothesis?.payload.title || "The accepted diagnosis"}. The proposed action is bounded to ${repair.payload.target || "the affected component"} and cannot run without owner approval.`;
  if (hypothesis) return hypothesis.payload.claim;
  return state.incident.summary;
}

function intentFor(message, state) {
  const text = message.toLowerCase();
  if (/(approve|accept|批准|接受|执行修复)/.test(text)) return "approval_explanation";
  if (/(recover|repair|rollback|修复|恢复)/.test(text)) return "recovery";
  if (/(agent|team|谁|进度)/.test(text)) return "team_status";
  if (/(evidence|why|root|证据|原因|根因)/.test(text)) return "evidence";
  return state.waiting_for_approval ? "recovery" : "summary";
}

function responseFor(intent, report, state) {
  if (intent === "approval_explanation") return state.waiting_for_approval
    ? "I cannot approve the repair for you. Review the cited scope and use the separate Owner approval control if you accept the bounded action."
    : "No owner-gated repair is currently waiting. I will not create or imply an approval from chat.";
  if (intent === "recovery") return report.repair
    ? `${report.summary} The current proposal is ${report.repair.action}. It targets only ${report.repair.target}.`
    : "The team has not produced an accepted bounded repair yet. Continue the evidence and evaluator loop first.";
  if (intent === "team_status") return `The active control stage is ${report.stage}. ${report.human_gate ? "The team is paused at the owner gate." : "Specialists are operating inside their role permissions."}`;
  if (intent === "evidence") return report.root_cause
    ? `${report.root_cause} The report cites ${report.citations.length} immutable evidence record${report.citations.length === 1 ? "" : "s"}.`
    : "The current evidence does not yet support a final causal claim.";
  return report.summary;
}

function agentActivity(events) {
  return events.filter((event) => nodeForEvent(event.type)).slice(-18).map((event) => ({
    id: event.id,
    sequence: event.sequence,
    at: event.recorded_at,
    type: event.type,
    agent_id: nodeForEvent(event.type),
    actor: event.actor,
    evidence_refs: event.evidence_refs,
    summary: activitySummary(event)
  }));
}

function nodeForEvent(type) {
  if (type.startsWith("manager.")) return "manager";
  if (["incident.opened", "change.applied", "deployment.completed"].includes(type)) return "monitor";
  if (["evidence.queried", "tool.called", "plan.revised", "loop.symptoms_collected", "loop.causal_evidence_collected"].includes(type)) return "evidence";
  if (type === "hypothesis.proposed") return "diagnosis";
  if (type.startsWith("evaluation.") || type === "outcome.classified") return "evaluator";
  if (type === "repair.proposed") return "planner";
  if (type.startsWith("approval.")) return "owner";
  if (type === "repair.executed") return "executor";
  if (type === "verification.completed") return "verification";
  if (type === "regression.created") return "evolve";
  if (type === "policy.evaluated") return "test";
  return null;
}

function activitySummary(event) {
  return event.payload.title || event.payload.reason || event.payload.step || event.payload.action || event.type.replaceAll(".", " ");
}

function nextRole(events) {
  if (!events.some((item) => item.type === "loop.symptoms_collected")) return "evidence";
  if (!events.some((item) => item.type === "evaluation.rejected")) return "diagnosis";
  if (!events.some((item) => item.type === "evaluation.accepted")) return "evidence";
  if (!events.some((item) => item.type === "repair.proposed")) return "remediation_planner";
  return "manager";
}

function currentAgent(statuses) {
  return ["owner", "executor", "verification", "test", "evolve", "planner", "evaluator", "diagnosis", "evidence", "monitor"]
    .find((id) => ["running", "waiting", "rejected"].includes(statuses[id])) || "manager";
}

function edgeStatus(item, statuses) {
  if (item.id === "ledger-langfuse") return statuses.langfuse === "observing" ? "observing" : "quiet";
  const target = statuses[item.to];
  if (target === "rejected") return "rejected";
  if (target === "waiting") return "waiting";
  if (target === "running") return "active";
  if (target === "complete") return "complete";
  return "quiet";
}

function manifestFor(role) {
  const manifest = ROLE_MANIFESTS[role];
  return manifest ? structuredClone(manifest) : null;
}

function last(events, type) {
  return [...events].reverse().find((event) => event.type === type) || null;
}

function unique(values) {
  return [...new Set(values)];
}

function node(id, label, detail, role, x, y) {
  return { id, label, detail, role, x, y };
}

function edge(id, from, to, label) {
  return { id, from, to, label };
}

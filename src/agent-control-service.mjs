import { AGENT_SCHEMA_VERSION, AgentTeamHarness, ROLE_MANIFESTS, sealAgentProposal } from "./agent-team-harness.mjs";

export const AGENT_ACTIONS = Object.freeze({
  summarize: { label: "Summarize incident", consequential: false },
  advance: { label: "Continue investigation", consequential: false },
  review_recovery: { label: "Review recovery plan", consequential: false },
  verify_recovery: { label: "Monitor verification", consequential: false },
  review_learning: { label: "Review regression", consequential: false },
  delegate_task: { label: "Assign diagnosis task", consequential: false, kind: "task" },
  review_pr: { label: "Review PR draft", consequential: false, kind: "pull_request" },
  approve_pr_review: { label: "Approve PR review", consequential: false, kind: "pull_request" },
  draft_jira: { label: "Draft Jira ticket", consequential: false, kind: "work_item" },
  approve_jira_draft: { label: "Approve Jira draft", consequential: false, kind: "work_item" }
});

const SAFE_WORK_ACTIONS = new Set(["delegate_task", "review_pr", "approve_pr_review", "draft_jira", "approve_jira_draft"]);
const COLLABORATOR_IDS = new Set(["commander", "observer", "investigator", "critic", "recovery-engineer", "verifier"]);

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
    this.harness = new AgentTeamHarness({ runtime });
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
      work_items: recoveryWorkItems(events),
      graph: { nodes, edges },
      activity: agentActivity(events),
      orchestration: orchestrationProjection(events)
    };
  }

  message(runId, rawMessage, rawCollaboratorId = "commander") {
    const message = String(rawMessage || "").trim();
    if (!message) throw new Error("Manager message is required");
    if (message.length > 2_000) throw new Error("Manager message is too long");
    const collaboratorId = COLLABORATOR_IDS.has(rawCollaboratorId) ? rawCollaboratorId : "commander";
    const before = this.runtime.state(runId);
    const received = this.runtime.append(runId, "manager.message.received", "human", { message, collaborator_id: collaboratorId });
    const intent = intentFor(message, before);
    const report = managerReport(before);
    const citations = collaboratorEvidenceRefs(collaboratorId, before, report.citations);
    const response = collaboratorResponseFor(collaboratorId, intent, report, before, citations);
    if (intent === "task_delegation") {
      this.recordSafeAction(runId, "delegate_task", {
        input: { instruction: message },
        parentId: received.id,
        idempotencyKey: `${runId}:chat:${received.id}:delegate_task`
      });
    }
    this.runtime.append(runId, "manager.response.created", "manager", {
      intent,
      message: response,
      collaborator_id: collaboratorId,
      citations,
      safe_actions: allowedActions(before).map((item) => item.id),
      deterministic: true
    }, citations, 0, received.id);
    return { intent, message: response, collaborator_id: collaboratorId, projection: this.project(runId) };
  }

  act(runId, actionId, input = {}) {
    const state = this.runtime.state(runId);
    const allowed = new Set(allowedActions(state).map((item) => item.id));
    if (!allowed.has(actionId)) throw new Error(`Agent action is not available: ${actionId}`);
    if (SAFE_WORK_ACTIONS.has(actionId)) {
      this.recordSafeAction(runId, actionId, { input });
      return this.project(runId);
    }
    if (!["advance", "verify_recovery"].includes(actionId)) return this.project(runId);
    this.advance(runId, actionId);
    return this.project(runId);
  }

  recordSafeAction(runId, actionId, { input = {}, parentId = null, idempotencyKey = `${runId}:${actionId}` } = {}) {
    if (!SAFE_WORK_ACTIONS.has(actionId)) throw new Error(`Safe work action is not supported: ${actionId}`);
    const state = this.runtime.state(runId);
    const existing = state.events.find((event) => event.payload?.idempotency_key === idempotencyKey);
    if (existing) return existing;
    const report = managerReport(state);
    const previous = previousWorkItemEvent(state.events, actionId);
    const definition = safeWorkEvent(actionId, report, input, previous);
    return this.runtime.append(runId, definition.type, definition.actor, {
      ...definition.payload,
      action_id: actionId,
      idempotency_key: idempotencyKey,
      integration_state: definition.payload.integration_state || "internal_only",
      external_mutation: false
    }, report.citations, 0, parentId || previous?.id || state.events.at(-1)?.id || null);
  }

  advance(runId = this.runtime.ensureRun(), action = "advance") {
    const state = this.runtime.state(runId);
    if (state.waiting_for_approval) return { waiting_for_approval: true, event: null };
    if (state.complete) return { complete: true, event: null };
    const stepIndex = state.events.filter((event) => event.type.startsWith("loop.")).length;
    const step = recordedStep(stepIndex, this.runtime.bundle);
    if (!step) return this.runtime.next(runId);

    const parentId = state.events.at(-1)?.id ?? null;
    const delegation = this.runtime.append(runId, "manager.delegation.created", "manager", {
      action,
      orchestration_step: stepIndex,
      target: step.role,
      expected_runtime_event: step.expected,
      consequential: step.role === "executor"
    }, step.evidenceRefs, 0, parentId);

    const proposalIds = [];
    let proposalParent = delegation.id;
    for (const [index, proposal] of step.before.entries()) {
      const accepted = this.harness.propose(recordedEnvelope({
        state,
        stepIndex,
        index,
        parentId: proposalParent,
        proposal
      }));
      proposalIds.push(accepted.id);
      proposalParent = accepted.id;
    }

    const result = this.runtime.next(runId);
    const afterState = this.runtime.state(runId);
    for (const [index, proposal] of step.after.entries()) {
      const accepted = this.harness.propose(recordedEnvelope({
        state: afterState,
        stepIndex,
        index: step.before.length + index,
        parentId: result.event?.id ?? proposalParent,
        proposal
      }));
      proposalIds.push(accepted.id);
      proposalParent = accepted.id;
    }

    const completion = this.runtime.append(runId, "orchestration.step.completed", "coordinator", {
      orchestration_step: stepIndex,
      target: step.role,
      validation: step.before.length || step.after.length ? "agent_team_harness" : "owner_gate_and_allowlist",
      proposal_event_ids: proposalIds,
      result_event_id: result.event?.id ?? null,
      expected_runtime_event: step.expected
    }, step.evidenceRefs, 0, result.event?.id ?? proposalParent);
    return { ...result, orchestration_event: completion };
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
  const backtest = last(events, "backtest.completed");
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
    backtest: backtest?.payload ?? null,
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
  const events = state.events;
  const actions = [];
  if (state.complete) actions.push(action("review_learning"));
  else if (state.waiting_for_approval) actions.push(action("review_recovery", true));
  else if (events.some((item) => item.type === "repair.executed")) actions.push(action("verify_recovery"));
  else actions.push(action("advance"));

  if (!events.some((item) => item.type === "task.delegation.proposed")) actions.push(action("delegate_task"));
  const prProposed = last(events, "pr.review.proposed");
  const prRecorded = last(events, "pr.review.recorded");
  if (events.some((item) => item.type === "repair.proposed") && !prProposed) actions.push(action("review_pr"));
  else if (prProposed && !prRecorded) actions.push(action("approve_pr_review"));
  const jiraDraft = last(events, "workitem.draft.proposed");
  const jiraApproved = last(events, "workitem.draft.approved");
  if (!jiraDraft) actions.push(action("draft_jira"));
  else if (!jiraApproved) actions.push(action("approve_jira_draft"));
  return actions;
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
  if (/(assign|delegate|task|派发|安排|分配任务)/.test(text)) return "task_delegation";
  if (/(recover|repair|rollback|修复|恢复)/.test(text)) return "recovery";
  if (/(agent|team|谁|进度)/.test(text)) return "team_status";
  if (/(evidence|why|root|证据|原因|根因)/.test(text)) return "evidence";
  return state.waiting_for_approval ? "recovery" : "summary";
}

function collaboratorResponseFor(collaboratorId, intent, report, state, citations) {
  if (intent === "approval_explanation") return responseFor(intent, report, state);
  if (collaboratorId === "observer") return report.root_cause
    ? `Observer: ${citations.length} cited records connect the checkout change to the payment failure. ${report.root_cause}`
    : `Observer: ${citations.length} immutable evidence record${citations.length === 1 ? " is" : "s are"} currently cited. ${report.summary}`;
  if (collaboratorId === "investigator") return report.root_cause
    ? `Investigator: ${report.root_cause}`
    : report.rejected_diagnosis
      ? `Investigator: the ${report.rejected_diagnosis.hypothesis_id} claim was rejected. I need upstream change and first-failing-span evidence before asserting root cause.`
      : "Investigator: the current evidence does not yet support a final causal claim.";
  if (collaboratorId === "critic") return report.rejected_diagnosis
    ? `Critic: ${report.rejected_diagnosis.hypothesis_id} scored ${Math.round(report.rejected_diagnosis.score * 100)}% and was rejected because ${report.rejected_diagnosis.reason}`
    : report.confidence == null ? "Critic: no diagnosis is ready for adversarial evaluation." : `Critic: the accepted diagnosis scored ${Math.round(report.confidence * 100)}% against the cited evidence.`;
  if (collaboratorId === "recovery-engineer") return report.repair
    ? `Recovery Engineer: ${report.repair.action}. The allowlisted scope is ${report.repair.target} only.${report.human_gate ? " Execution remains paused at the separate owner gate." : ""}`
    : "Recovery Engineer: I will not draft a repair until the evaluator accepts a causal diagnosis.";
  if (collaboratorId === "verifier") return report.verification
    ? `Verifier: recovery checks ${report.verification.passed ? "passed" : "failed"}.${report.regression ? " The regression record is available for offline replay." : ""}`
    : "Verifier: verification waits for an approved execution receipt and fresh post-action evidence.";
  return responseFor(intent, report, state);
}

function collaboratorEvidenceRefs(collaboratorId, state, reportCitations) {
  const roleIds = ({
    commander: ["manager"],
    observer: ["monitor", "evidence"],
    investigator: ["diagnosis"],
    critic: ["evaluator"],
    "recovery-engineer": ["planner", "executor"],
    verifier: ["verification", "evolve", "test"]
  })[collaboratorId] || ["manager"];
  return unique([
    ...reportCitations,
    ...state.events
      .filter((event) => roleIds.includes(nodeForEvent(event.type)))
      .flatMap((event) => event.evidence_refs || [])
  ]);
}

function responseFor(intent, report, state) {
  if (intent === "approval_explanation") return state.waiting_for_approval
    ? "I cannot approve the repair for you. Review the cited scope and use the separate Owner approval control if you accept the bounded action."
    : "No owner-gated repair is currently waiting. I will not create or imply an approval from chat.";
  if (intent === "recovery") return report.repair
    ? `${report.summary} The current proposal is ${report.repair.action}. It targets only ${report.repair.target}.`
    : "The team has not produced an accepted bounded repair yet. Continue the evidence and evaluator loop first.";
  if (intent === "task_delegation") return `I recorded an internal diagnosis task with ${report.citations.length} immutable evidence citation${report.citations.length === 1 ? "" : "s"}. It does not authorize remediation or mutate an external system.`;
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
    collaborator_id: event.payload.collaborator_id || null,
    actor: event.actor,
    evidence_refs: event.evidence_refs,
    summary: activitySummary(event)
  }));
}

function nodeForEvent(type) {
  if (type.startsWith("manager.") || type.startsWith("task.delegation") || type.startsWith("workitem.")) return "manager";
  if (type === "orchestration.step.completed") return "manager";
  if (["incident.opened", "change.applied", "deployment.completed"].includes(type)) return "monitor";
  if (["evidence.requested", "evidence.manifest.proposed", "evidence.gap.proposed", "evidence.queried", "tool.called", "plan.revised", "loop.symptoms_collected", "loop.causal_evidence_collected"].includes(type)) return "evidence";
  if (["diagnosis.proposed", "hypothesis.proposed"].includes(type)) return "diagnosis";
  if (type.startsWith("evaluation.") || type === "outcome.classified") return "evaluator";
  if (type === "repair.proposed" || type.startsWith("pr.review")) return "planner";
  if (type.startsWith("approval.")) return "owner";
  if (type === "repair.executed") return "executor";
  if (["verification.proposed", "verification.completed"].includes(type)) return "verification";
  if (["regression.candidate.proposed", "policy.candidate.proposed", "regression.created"].includes(type)) return "evolve";
  if (["backtest.completed", "policy.evaluated"].includes(type)) return "test";
  return null;
}

function activitySummary(event) {
  return event.payload.message || event.payload.title || event.payload.reason || event.payload.step || event.payload.action || event.type.replaceAll(".", " ");
}

function nextRole(events) {
  if (!events.some((item) => item.type === "loop.symptoms_collected")) return "evidence";
  if (!events.some((item) => item.type === "evaluation.rejected")) return "diagnosis";
  if (!events.some((item) => item.type === "evaluation.accepted")) return "evidence";
  if (!events.some((item) => item.type === "repair.proposed")) return "remediation_planner";
  return "manager";
}

function orchestrationProjection(events) {
  const proposals = events.filter((event) => event.payload?._agent_proposal).map((event) => ({
    event_id: event.id,
    sequence: event.sequence,
    type: event.type,
    agent_id: event.payload._agent_proposal.agent_id,
    agent_version: event.payload._agent_proposal.agent_version,
    model: event.payload._agent_proposal.model,
    prompt_hash: event.payload._agent_proposal.prompt_hash,
    content_sha256: event.payload._agent_proposal.content_sha256,
    budget: event.payload._agent_proposal.budget,
    parent_event_ids: event.payload._agent_proposal.parent_event_ids,
    evidence_refs: event.evidence_refs
  }));
  const completed = events.filter((event) => event.type === "orchestration.step.completed");
  return {
    mode: "ledger-governed-agent-team-harness",
    proposal_count: proposals.length,
    proposals: proposals.slice(-12),
    last_step: completed.at(-1)?.payload ?? null
  };
}

function recoveryWorkItems(events) {
  const relevant = events.filter((event) => [
    "task.delegation.proposed",
    "pr.review.proposed",
    "pr.review.recorded",
    "workitem.draft.proposed",
    "workitem.draft.approved"
  ].includes(event.type));
  return relevant.map((event) => ({
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    action_id: event.payload.action_id,
    title: event.payload.title,
    summary: event.payload.summary,
    status: event.payload.status,
    integration_state: event.payload.integration_state,
    external_mutation: event.payload.external_mutation === true,
    evidence_refs: event.evidence_refs
  }));
}

function previousWorkItemEvent(events, actionId) {
  const expected = {
    approve_pr_review: "pr.review.proposed",
    approve_jira_draft: "workitem.draft.proposed"
  }[actionId];
  return expected ? last(events, expected) : null;
}

function safeWorkEvent(actionId, report, input, previous) {
  if (actionId === "delegate_task") return {
    type: "task.delegation.proposed",
    actor: "manager",
    payload: {
      title: "Validate the checkout recovery evidence",
      summary: input.instruction || report.root_cause || report.summary,
      target_agent: "diagnosis",
      status: "recorded",
      integration_state: "internal_only"
    }
  };
  if (actionId === "review_pr") return {
    type: "pr.review.proposed",
    actor: "agent:remediation_planner",
    payload: {
      title: "Review checkout rollback PR draft",
      summary: report.repair ? `${report.repair.action}; ${report.repair.target} only.` : report.summary,
      status: "awaiting_human_review",
      integration_state: "not_configured"
    }
  };
  if (actionId === "approve_pr_review") {
    if (!previous) throw new Error("A PR review draft is required before approval");
    return {
      type: "pr.review.recorded",
      actor: "human",
      payload: {
        title: previous.payload.title,
        summary: "The internal PR review is approved and ready for a configured GitHub integration.",
        status: "ready_for_integration",
        review_decision: "approved",
        integration_state: "not_configured"
      }
    };
  }
  if (actionId === "draft_jira") return {
    type: "workitem.draft.proposed",
    actor: "manager",
    payload: {
      title: `${report.stage}: checkout/payment incident follow-up`,
      summary: report.root_cause || report.summary,
      status: "awaiting_human_review",
      integration_state: "not_configured"
    }
  };
  if (!previous) throw new Error("A Jira work-item draft is required before approval");
  return {
    type: "workitem.draft.approved",
    actor: "human",
    payload: {
      title: previous.payload.title,
      summary: "The work-item draft is approved and ready for a configured Jira integration.",
      status: "ready_for_integration",
      integration_state: "not_configured"
    }
  };
}

function recordedEnvelope({ state, stepIndex, index, parentId, proposal }) {
  const createdAt = state.events.find((event) => event.type === "run.started")?.recorded_at ?? state.events[0]?.recorded_at ?? new Date(0).toISOString();
  const deadlineAt = new Date(Date.parse(createdAt) + 3_600_000).toISOString();
  return sealAgentProposal({
    schema_version: AGENT_SCHEMA_VERSION,
    message_id: `${state.run_id}:step-${stepIndex}:proposal-${index}`,
    idempotency_key: `${state.run_id}:step-${stepIndex}:${proposal.agentId}:${proposal.eventType}:${index}`,
    incident_id: state.incident.id,
    run_id: state.run_id,
    agent_id: proposal.agentId,
    agent_version: "recorded-adapter-v1",
    prompt_hash: "sha256:flowpulse-recorded-adapter-v1",
    model: "recorded-fixture",
    created_at: createdAt,
    parent_event_ids: parentId ? [parentId] : [],
    evidence_refs: proposal.evidenceRefs,
    budget: {
      tool_calls_remaining: Math.max(1, ROLE_MANIFESTS[proposal.agentId]?.tools.length || 1),
      turns_remaining: 1,
      tokens_remaining: 1_800,
      deadline_at: deadlineAt
    },
    event_type: proposal.eventType,
    payload_type: proposal.payloadType,
    payload: proposal.payload
  });
}

function recordedStep(index, bundle) {
  const symptoms = ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"];
  const counter = ["ev-metric-kafka-healthy", "ev-timing-error-before-lag"];
  const causal = ["ev-deploy-checkout", "ev-trace-payment-refused", "ev-log-endpoint-fallback", "ev-commit-checkout"];
  const verification = bundle.repair.verification_evidence;
  const steps = [
    {
      role: "evidence", expected: "loop.symptoms_collected", evidenceRefs: symptoms,
      before: [
        proposal("evidence", "evidence.requested", "EvidencePlan", { queries: ["query_symptoms"] }),
        proposal("evidence", "evidence.manifest.proposed", "EvidenceManifest", { evidence_ids: symptoms }, symptoms)
      ], after: []
    },
    {
      role: "diagnosis", expected: "loop.initial_hypothesis", evidenceRefs: symptoms.slice(1),
      before: [proposal("diagnosis", "diagnosis.proposed", "DiagnosisCandidate", {
        id: "hyp-kafka", title: "Kafka broker degradation initiated the incident", claim: "Growing consumer lag delayed accounting and fraud processing.", confidence: 0.72
      }, symptoms.slice(1))], after: []
    },
    {
      role: "adversarial_evaluator", expected: "loop.hypothesis_rejected", evidenceRefs: counter,
      before: [proposal("adversarial_evaluator", "evaluation.rejected", "EvaluationVerdict", {
        hypothesis_id: "hyp-kafka", accepted: false, score: 0.22, reason: "Kafka lag is downstream; payment failures lead it by 171 seconds."
      }, counter)], after: []
    },
    {
      role: "evidence", expected: "loop.replanned", evidenceRefs: [],
      before: [proposal("evidence", "evidence.requested", "EvidencePlan", { queries: ["query_causal_gaps"] })], after: []
    },
    {
      role: "evidence", expected: "loop.causal_evidence_collected", evidenceRefs: causal,
      before: [
        proposal("evidence", "evidence.requested", "EvidencePlan", { queries: ["query_deploys", "query_traces", "query_logs", "query_commits"] }),
        proposal("evidence", "evidence.manifest.proposed", "EvidenceManifest", { evidence_ids: causal }, causal)
      ], after: []
    },
    {
      role: "adversarial_evaluator", expected: "loop.root_cause_confirmed", evidenceRefs: causal,
      before: [
        proposal("diagnosis", "diagnosis.proposed", "DiagnosisCandidate", {
          id: "hyp-checkout-config", title: "Checkout deployment selected an unreachable payment endpoint", claim: "checkout:2.18.0 fell back to payment:9090 after commit c7e1b9a renamed the payment environment key.", confidence: 0.96
        }, causal),
        proposal("adversarial_evaluator", "evaluation.accepted", "EvaluationVerdict", {
          hypothesis_id: "hyp-checkout-config", accepted: true, score: 0.94, reason: "Change, mechanism, timing, and propagation are cited."
        }, causal)
      ], after: []
    },
    {
      role: "remediation_planner", expected: "loop.approval_requested", evidenceRefs: ["ev-deploy-checkout", "ev-commit-checkout"],
      before: [proposal("remediation_planner", "repair.proposed", "RemediationProposal", { ...bundle.repair, bounded: true }, ["ev-deploy-checkout", "ev-commit-checkout"])], after: []
    },
    { role: "executor", expected: "loop.repair_executed", evidenceRefs: ["ev-deploy-checkout"], before: [], after: [] },
    {
      role: "verification", expected: "loop.learning_complete", evidenceRefs: verification,
      before: [proposal("verification", "verification.proposed", "VerificationReport", {
        passed: true,
        checks: [
          { metric: "payment_reachability_percent", threshold: ">=99.9", passed: true },
          { metric: "checkout_error_percent", threshold: "<=1.0", passed: true },
          { metric: "kafka_lag", threshold: "<=1000", passed: true }
        ]
      }, verification)],
      after: [
        proposal("evolve", "regression.candidate.proposed", "RegressionCandidate", { id: bundle.regression.id, name: bundle.regression.name }, causal),
        proposal("evolve", "policy.candidate.proposed", "PolicyCandidate", { id: "policy-grounded-causality-v2" }),
        proposal("test", "backtest.completed", "BacktestReport", { source: "captured_fixture", candidate_id: "policy-grounded-causality-v2", passed: true, gates: ["deterministic_replay", "owner_gate", "false_positive_rejection"] })
      ]
    }
  ];
  return steps[index] ?? null;
}

function proposal(agentId, eventType, payloadType, payload, evidenceRefs = []) {
  return { agentId, eventType, payloadType, payload, evidenceRefs };
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

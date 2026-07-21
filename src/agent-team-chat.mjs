import { createHash } from "node:crypto";
import { createAgentTeamProvider, createOpenAIResponsesAdapter, createRecordedChatAdapter as createRecordedProvider } from "./agent-team-provider.mjs";
import { NodeInvestigationError, ROLE_NODE_TOOL_ALLOWLIST } from "./node-investigation-plane.mjs";

export const createRecordedChatAdapter = createRecordedProvider;
export const createOpenAIChatAdapter = createOpenAIResponsesAdapter;

export const AGENT_TEAM_CHAT_SCHEMA_VERSION = "flowpulse.agent-team-chat.v1";
export const AGENT_TEAM_CHAT_LIMITS = Object.freeze({
  max_message_bytes: 1_500,
  max_answer_bytes: 1_200,
  max_conversation_records: 48,
  max_projection_bytes: 64 * 1024,
  max_context_bytes: 24 * 1024,
  max_evidence_refs: 12,
  max_model_attempts: 3,
  max_tool_rounds: 2,
  max_tool_calls: 4,
  max_calls_per_tool: 2
});

const ROLES = new Set(["observer", "orchestrator", "investigator", "evaluator"]);
const PAGE_MODES = new Set(["architecture", "live", "diagnose", "recovery", "compare", "manager"]);
const ENVELOPE_KEYS = ["run_id", "incident_id", "conversation_id", "idempotency_key", "requested_agent", "page_mode", "selected_component", "message"];
const FORBIDDEN_FIELD = /(?:approval|approve|authority|truth|repair|remediat|evidence|verification|execute|owner|prompt|trace|log|secret|provider)/i;
const MAX_RECORDS_PER_SUBMIT = 18;
const ROLE_TOOLS = Object.freeze({
  observer: ["read_source_freshness", "read_signal_summaries"],
  orchestrator: ["read_workflow_projection"],
  investigator: ["read_evidence_summaries", "read_selected_component"],
  evaluator: ["read_cited_hypotheses", "read_evidence_summaries"]
});

export class AgentTeamChatError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "AgentTeamChatError";
    this.code = code;
    this.status = status;
  }
}

export class AgentTeamChatService {
  constructor({ runtime, modelAdapter = null, contextForRun = null, providerKind = undefined } = {}) {
    if (!runtime?.ledger?.list || !runtime?.ledger?.appendIfAbsent || !runtime?.bundle?.incident?.id) {
      throw new Error("AgentTeamChatService requires an IncidentRuntime with an append-only ledger");
    }
    this.runtime = runtime;
    this.contextForRun = typeof contextForRun === "function" ? contextForRun : null;
    this.modelAdapter = modelAdapter || createAgentTeamProvider({ providerKind });
  }

  async submit(rawRequest, { trace = null, signal = null } = {}) {
    const request = validateAgentTeamChatRequest(rawRequest);
    const state = this.runtime.state(request.run_id);
    if (state.run_id !== request.run_id || request.incident_id !== state.incident.id) {
      throw new AgentTeamChatError("canonical_identity_mismatch", 409);
    }
    const inputHash = requestHash(request);
    const messageId = `msg-${sha256({ run_id: request.run_id, conversation_id: request.conversation_id, idempotency_key: request.idempotency_key }).slice(0, 32)}`;
    const records = conversationEvents(state.events, request.conversation_id);
    const duplicate = records.find((event) => event.type === "agent_team.message.received" && event.payload?.idempotency_key === request.idempotency_key);
    if (duplicate) {
      if (duplicate.payload?.input_sha256 !== inputHash) throw new AgentTeamChatError("idempotency_key_conflict", 409);
      return this.resultFor(request.run_id, request.conversation_id, messageId, { idempotent: true });
    }
    if (records.length + MAX_RECORDS_PER_SUBMIT > AGENT_TEAM_CHAT_LIMITS.max_conversation_records) {
      throw new AgentTeamChatError("conversation_record_budget_exhausted", 429);
    }

    const external = await this.readContext(request.run_id, request);
    validateSelectedComponent(request.selected_component, state, external);
    const received = this.append(request.run_id, "agent_team.message.received", "human", {
      conversation_id: request.conversation_id,
      message_id: messageId,
      idempotency_key: request.idempotency_key,
      input_sha256: inputHash,
      requested_agent: request.requested_agent,
      page_mode: request.page_mode,
      selected_component: request.selected_component,
      message: redactText(request.message)
    });

    const route = routeFor(request.requested_agent, request.message);
    let parentId = received.id;
    if (route.to !== route.from) {
      parentId = this.append(request.run_id, "agent_team.handoff.recorded", "orchestrator", {
        conversation_id: request.conversation_id,
        message_id: messageId,
        from: route.from,
        to: route.to,
        reason: route.reason
      }, [], parentId).id;
    }

    const context = buildContext({ request, state, external, role: route.to });
    const humanGate = context.human_gate;
    if (isAuthorityRequest(request.message)) {
      const provider = this.providerCapability();
      const gate = this.append(request.run_id, "agent_team.human_gate.required", "orchestrator", {
        conversation_id: request.conversation_id,
        message_id: messageId,
        requested_agent: request.requested_agent,
        responding_agent: route.to,
        reason: "approval_or_repair_authority_is_human_owned",
        human_gate: humanGate.status
      }, context.citations, parentId);
      this.append(request.run_id, "agent_team.response.created", route.to, responsePayload({
        request,
        messageId,
        route,
        state: "needs_human",
        answer: humanGateAnswer(humanGate),
        citations: context.citations,
        handoff: route.to === route.from ? null : route,
        toolSummaries: [],
        provider,
        humanGate
      }), context.citations, gate.id);
      return this.resultFor(request.run_id, request.conversation_id, messageId);
    }
    const provider = await this.preflightProvider();

    const contextEvent = this.append(request.run_id, "agent_team.context.prepared", route.to, {
      conversation_id: request.conversation_id,
      message_id: messageId,
      topology: context.topology,
      source_truth: context.source_truth,
      incident: context.incident,
      evidence_count: context.evidence.length,
      evidence_refs: context.citations,
      tool_allowlist: context.tool_allowlist,
      context_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
      budgets: { records: AGENT_TEAM_CHAT_LIMITS.max_conversation_records, bytes: AGENT_TEAM_CHAT_LIMITS.max_context_bytes, attempts: AGENT_TEAM_CHAT_LIMITS.max_model_attempts, tool_rounds: AGENT_TEAM_CHAT_LIMITS.max_tool_rounds, tool_calls: AGENT_TEAM_CHAT_LIMITS.max_tool_calls }
    }, context.citations, parentId);
    const toolResults = [];
    let toolParent = contextEvent.id;
    let toolSummaries = toolSummariesFor(context);
    let attemptCitations = [];
    try {
      if (external?.node_plane && request.selected_component && context.tool_allowlist.includes("get_component_snapshot")) {
        const seeded = this.recordNodeTool({ request, messageId, route, plane: external.node_plane, tool: "get_component_snapshot", query: {}, round: 0, attempt: 0, parentId: toolParent });
        toolResults.push(seeded.result);
        toolSummaries = summarizeNodeTools(toolResults);
        attemptCitations = safeIds(toolResults.flatMap((item) => item.evidence_refs));
        toolParent = seeded.parentId;
      }
    } catch (error) {
      return this.toolBlockedResult({ error, request, messageId, route, context, provider, humanGate, parentId: toolParent, toolSummaries });
    }
    const toolObservation = safeObservation(trace, "tool", "flowpulse.agent-team-context", {
      input: { role: route.to, tool_count: toolSummaries.length, evidence_count: context.evidence.length },
      metadata: { authority: "flowpulse-ledger" }
    });
    safeUpdate(toolObservation, { output: { tool_count: toolSummaries.length, evidence_count: context.evidence.length } });
    safeEnd(toolObservation);
    const toolEvent = this.append(request.run_id, "agent_team.tool_summary.recorded", route.to, {
      conversation_id: request.conversation_id,
      message_id: messageId,
      tools: toolSummaries
    }, attemptCitations.length ? attemptCitations : context.citations, toolParent);
    const working = this.append(request.run_id, "agent_team.response.working", route.to, {
      conversation_id: request.conversation_id,
      message_id: messageId,
      requested_agent: request.requested_agent,
      responding_agent: route.to,
      state: "working",
      provider
    }, context.citations, toolEvent.id);

    const generation = safeObservation(trace, "generation", "flowpulse.agent-team-response", {
      input: { role: route.to, evidence_count: context.evidence.length, selected_component: context.selected_component },
      model: provider.model_label || "configured-agent-team-adapter",
      metadata: { authority: "flowpulse-ledger", conversation_id: request.conversation_id }
    });
    const startedAt = Date.now();
    try {
      if (provider.availability !== "available") throw new Error("provider_unavailable");
      let model = null;
      let modelAttempts = 0;
      let round = 0;
      const perTool = new Map();
      let finalParent = working.id;
      while (true) {
        modelAttempts++;
        model = await this.modelAdapter.respond({ role: route.to, context: { ...context, tool_results: boundedModelToolResults(toolResults) }, signal });
        const requests = validatedModelToolRequests(model?.tool_requests, context.tool_allowlist);
        if (!requests.length) break;
        if (!external?.node_plane || !request.selected_component || round >= AGENT_TEAM_CHAT_LIMITS.max_tool_rounds || modelAttempts >= AGENT_TEAM_CHAT_LIMITS.max_model_attempts) {
          throw new AgentTeamChatError("node_tool_budget_exhausted", 422);
        }
        round++;
        for (const item of requests) {
          const count = (perTool.get(item.tool) || 0) + 1;
          perTool.set(item.tool, count);
          if (count > AGENT_TEAM_CHAT_LIMITS.max_calls_per_tool || toolResults.length >= AGENT_TEAM_CHAT_LIMITS.max_tool_calls) throw new AgentTeamChatError("node_tool_budget_exhausted", 422);
          const recorded = this.recordNodeTool({ request, messageId, route, plane: external.node_plane, tool: item.tool, query: toolQueryFor(item), round, attempt: modelAttempts, parentId: finalParent });
          toolResults.push(recorded.result);
          finalParent = recorded.parentId;
        }
        toolSummaries = summarizeNodeTools(toolResults);
        attemptCitations = safeIds(toolResults.flatMap((item) => item.evidence_refs));
      }
      const answer = safeAnswer(model?.answer, route.to, context);
      const metadata = modelMetadata(model, Date.now() - startedAt, provider);
      safeUpdate(generation, { output: metadata });
      safeEnd(generation);
      const modelHandoff = modelHandoffFor(route.to, model?.recommended_handoff);
      finalParent = modelHandoff
        ? this.append(request.run_id, "agent_team.handoff.recorded", route.to, {
          conversation_id: request.conversation_id,
          message_id: messageId,
          from: modelHandoff.from,
          to: modelHandoff.to,
          reason: modelHandoff.reason
        }, attemptCitations.length ? attemptCitations : context.citations, finalParent).id
        : finalParent;
      const citations = attemptCitations.length ? attemptCitations : context.citations;
      const answerEvent = this.append(request.run_id, "agent_team.response.created", route.to, responsePayload({
        request,
        messageId,
        route,
        state: "completed",
        answer,
        citations,
        handoff: modelHandoff || (route.to === route.from ? null : route),
        toolSummaries,
        model: metadata,
        provider,
        humanGate
      }), citations, finalParent);
      return this.resultFor(request.run_id, request.conversation_id, messageId, { answerEvent });
    } catch (error) {
      if (error instanceof NodeInvestigationError || error instanceof AgentTeamChatError) {
        safeUpdate(generation, { output: { status: "blocked", code: error.code } });
        safeEnd(generation);
        return this.toolBlockedResult({ error, request, messageId, route, context, provider, humanGate, parentId: working.id, toolSummaries });
      }
      const failedProvider = safeProvider({
        ...this.providerCapability(),
        provider_kind: provider.provider_kind,
        truth_label: provider.truth_label,
        model_label: provider.model_label,
        availability: "unavailable",
        failure_reason: this.providerCapability().failure_reason || "provider_response_failed"
      });
      safeUpdate(generation, { output: { status: "failed", code: "model_unavailable" } });
      safeEnd(generation);
      const failure = this.append(request.run_id, "agent_team.error.recorded", "runtime", {
        conversation_id: request.conversation_id,
        message_id: messageId,
        code: "model_unavailable",
        attempts: 1
      }, context.citations, working.id);
      this.append(request.run_id, "agent_team.response.created", route.to, responsePayload({
        request,
        messageId,
        route,
        state: "failed",
        answer: "The selected role could not produce a response. No approval, repair, or truth state changed.",
        citations: context.citations,
        handoff: route.to === route.from ? null : route,
        toolSummaries,
        provider: failedProvider,
        humanGate
      }), context.citations, failure.id);
      return this.resultFor(request.run_id, request.conversation_id, messageId);
    }
  }

  project({ runId, conversationId }) {
    if (!safeId(runId) || !safeId(conversationId)) throw new AgentTeamChatError("conversation_identity_invalid");
    const events = conversationEvents(this.runtime.ledger.list(runId), conversationId);
    const messages = events.slice(0, AGENT_TEAM_CHAT_LIMITS.max_conversation_records).map(projectEvent);
    let projection = {
      schema_version: AGENT_TEAM_CHAT_SCHEMA_VERSION,
      conversation_id: conversationId,
      messages,
      truncated: events.length > messages.length,
      record_count: events.length,
      latest: messages.at(-1) ? { sequence: messages.at(-1).sequence, recorded_at: messages.at(-1).recorded_at } : null
    };
    while (Buffer.byteLength(JSON.stringify(projection), "utf8") > AGENT_TEAM_CHAT_LIMITS.max_projection_bytes && projection.messages.length) {
      projection = { ...projection, messages: projection.messages.slice(1), truncated: true };
    }
    return projection;
  }

  resultFor(runId, conversationId, messageId, { idempotent = false, answerEvent = null } = {}) {
    const events = conversationEvents(this.runtime.ledger.list(runId), conversationId);
    const response = answerEvent || [...events].reverse().find((event) => event.type === "agent_team.response.created" && event.payload?.message_id === messageId);
    if (!response) {
      return { schema_version: AGENT_TEAM_CHAT_SCHEMA_VERSION, conversation_id: conversationId, message_id: messageId, idempotent, state: "working", conversation: this.project({ runId, conversationId }) };
    }
    const payload = response.payload;
    return {
      schema_version: AGENT_TEAM_CHAT_SCHEMA_VERSION,
      conversation_id: conversationId,
      message_id: messageId,
      idempotent,
      requested_agent: payload.requested_agent,
      responding_agent: payload.responding_agent,
      state: payload.state,
      answer: payload.answer,
      handoff: payload.handoff,
      citations: payload.citations,
      tool_summaries: payload.tool_summaries,
      human_gate: payload.human_gate,
      provider: safeProvider(payload.provider),
      ledger: { sequence: response.sequence, recorded_at: response.recorded_at },
      conversation: this.project({ runId, conversationId })
    };
  }

  async readContext(runId, request) {
    return this.contextForRun ? await this.contextForRun(this.runtime, runId, request) : {};
  }

  providerCapability() {
    return providerCapability(this.modelAdapter);
  }

  async preflightProvider({ probe = true } = {}) {
    if (!probe) return this.providerCapability();
    try {
      if (typeof this.modelAdapter.preflight === "function") return safeProvider(await this.modelAdapter.preflight(), this.modelAdapter);
      return this.providerCapability();
    } catch {
      const current = this.providerCapability();
      return { ...current, availability: "unavailable", failure_reason: "provider_preflight_failed" };
    }
  }

  recordNodeTool({ request, messageId, route, plane, tool, query, round, attempt, parentId }) {
    const requested = this.append(request.run_id, "agent_team.tool.requested", route.to, {
      conversation_id: request.conversation_id,
      message_id: messageId,
      attempt,
      round,
      tool,
      component_id: request.selected_component,
      query: boundedToolQuery(query)
    }, [], parentId);
    const result = plane.invoke({ role: route.to, tool, componentId: request.selected_component, query });
    const evidenceRefs = safeIds(result.evidence_refs);
    const recorded = this.append(request.run_id, "agent_team.tool.result.recorded", route.to, {
      conversation_id: request.conversation_id,
      message_id: messageId,
      attempt,
      round,
      tool: result.tool,
      component_id: request.selected_component,
      query_fingerprint: safeHash(result.query_fingerprint),
      cached: result.cached === true,
      result_count: safeInt(result.result_count, 10_000) || 0,
      selected_count: safeInt(result.selected_count, 10_000) || 0,
      omitted_count: safeInt(result.omitted_count, 10_000) || 0,
      evidence_hashes: safeHashes(result.evidence_hashes),
      source_truth: safeSourceTruth(result.source_truth),
      raw_payload_excluded: true
    }, evidenceRefs, requested.id);
    return { result, parentId: recorded.id };
  }

  toolBlockedResult({ error, request, messageId, route, context, provider, humanGate, parentId, toolSummaries }) {
    const reason = error instanceof NodeInvestigationError || error instanceof AgentTeamChatError ? error.code : "node_tool_failure";
    const citations = context.citations;
    const gate = this.append(request.run_id, "agent_team.human_gate.required", "orchestrator", {
      conversation_id: request.conversation_id,
      message_id: messageId,
      requested_agent: request.requested_agent,
      responding_agent: route.to,
      reason,
      human_gate: humanGate.status
    }, citations, parentId);
    this.append(request.run_id, "agent_team.response.created", route.to, responsePayload({
      request,
      messageId,
      route,
      state: "needs_human",
      answer: "Bounded node evidence is unavailable or incomplete for this request. No approval, repair, verification, or truth state changed.",
      citations,
      handoff: route.to === route.from ? null : route,
      toolSummaries,
      provider,
      humanGate
    }), citations, gate.id);
    return this.resultFor(request.run_id, request.conversation_id, messageId);
  }

  append(runId, type, actor, payload, evidenceRefs = [], parentId = null) {
    return this.runtime.ledger.append({
      runId,
      incidentId: this.runtime.bundle.incident.id,
      type,
      actor,
      payload,
      evidenceRefs,
      parentId,
      correlationId: `agent-team:${payload.conversation_id}:${payload.message_id}`
    });
  }
}

export function validateAgentTeamChatRequest(value) {
  if (!plain(value)) throw new AgentTeamChatError("request_envelope_invalid");
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.includes(key)) throw new AgentTeamChatError(FORBIDDEN_FIELD.test(key) ? "forbidden_request_field" : "unknown_request_field");
  }
  if (Object.keys(value).length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every((key) => Object.hasOwn(value, key))) throw new AgentTeamChatError("request_envelope_invalid");
  for (const key of ["run_id", "incident_id", "conversation_id", "idempotency_key"]) if (!safeId(value[key])) throw new AgentTeamChatError(`invalid_${key}`);
  if (!ROLES.has(value.requested_agent)) throw new AgentTeamChatError("requested_agent_invalid");
  if (!PAGE_MODES.has(value.page_mode)) throw new AgentTeamChatError("page_mode_invalid");
  if (value.selected_component !== null && !safeId(value.selected_component)) throw new AgentTeamChatError("selected_component_invalid");
  if (typeof value.message !== "string" || !value.message.trim() || Buffer.byteLength(value.message, "utf8") > AGENT_TEAM_CHAT_LIMITS.max_message_bytes) throw new AgentTeamChatError("message_invalid");
  return { ...value, message: value.message.trim() };
}

function validateSelectedComponent(selected, state, external) {
  if (selected === null) return;
  const ids = new Set([
    ...(external?.topology_views?.architecture?.runtime_data?.graph?.nodes || []).map((node) => node?.id),
    ...(external?.incident_projection?.graph?.nodes || []).map((node) => node?.id),
    ...(state.topology?.services || state.topology?.nodes || []).map((node) => typeof node === "string" ? node : node?.id)
  ]);
  if (!ids.has(selected)) throw new AgentTeamChatError("selected_component_not_canonical", 422);
}

function buildContext({ request, state, external, role }) {
  const projection = external?.incident_projection || {};
  const topologyViews = external?.topology_views || {};
  const evidence = boundedEvidence(state, projection, external?.source_evidence, request.selected_component);
  const source = {
    status: safeEnum(external?.source?.status, ["captured", "frozen", "live", "stale", "disconnected", "unavailable"], "unavailable"),
    freshness_ms: safeInt(external?.source?.freshness_ms, 86_400_000),
    evidence_count: safeInt(external?.source?.evidence_count, 10_000) ?? evidence.length
  };
  const incident = {
    run_id: state.run_id,
    incident_id: state.incident.id,
    stage: safeText(projection.stage?.label || state.stage, 120) || "Unavailable",
    stage_status: safeText(projection.stage_status || state.status, 80) || "unavailable"
  };
  const humanGate = { status: safeEnum(projection.human_gate?.status, ["requested", "granted", "not_required", "not_actionable"], state.waiting_for_approval ? "requested" : "not_required") };
  const roleTools = external?.node_plane ? (role === "orchestrator" ? ROLE_TOOLS.orchestrator : (ROLE_NODE_TOOL_ALLOWLIST[role] || [])) : ROLE_TOOLS[role];
  const context = {
    role,
    message: redactText(request.message),
    page_mode: request.page_mode,
    selected_component: request.selected_component,
    topology: {
      schema_version: safeText(topologyViews.schema_version, 80) || null,
      projection_revision: safeHash(topologyViews.projection_revision)
    },
    source_truth: {
      source_health: safeEnum(projection.source_health, ["live", "stale", "disconnected", "unavailable"], "unavailable"),
      evidence_mode: safeEnum(projection.evidence_mode, ["captured_fixture", "frozen_real_snapshot", "live_stream"], "captured_fixture"),
      execution_mode: safeEnum(projection.execution_mode, ["deterministic_replay", "gpt_model_only", "real_local_development", "captured_simulation"], "deterministic_replay"),
      source_status: source.status,
      freshness_ms: source.freshness_ms
    },
    incident,
    human_gate: humanGate,
    evidence,
    citations: evidence.map((item) => item.id),
    tool_allowlist: [...roleTools],
    role_context: roleContextFor({ role, source, incident, humanGate, evidence, projection, componentDetail: external?.selected_component_detail })
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > AGENT_TEAM_CHAT_LIMITS.max_context_bytes) throw new AgentTeamChatError("context_byte_budget_exhausted", 429);
  return context;
}

function boundedEvidence(state, projection, sourceEvidence, selectedComponent) {
  const source = Array.isArray(sourceEvidence) ? sourceEvidence : [];
  const projectionEvidence = Array.isArray(projection?.evidence) ? projection.evidence : [];
  const fallback = Array.isArray(state.evidence) ? state.evidence : [];
  const selected = (items) => selectedComponent ? items.filter((item) => item?.entity === selectedComponent) : items;
  const groups = [selected(source), selected(projectionEvidence), selected(fallback), source, projectionEvidence, fallback];
  const entries = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group) {
      const id = safeIdValue(item?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push(item);
      if (entries.length >= AGENT_TEAM_CHAT_LIMITS.max_evidence_refs) break;
    }
    if (entries.length >= AGENT_TEAM_CHAT_LIMITS.max_evidence_refs) break;
  }
  return entries.map((item) => ({
    id: safeIdValue(item?.id),
    kind: safeText(item?.kind, 80) || "unknown",
    signal: safeText(item?.signal, 80) || "unknown",
    title: redactText(safeText(item?.title, 180) || "Bounded evidence"),
    summary: redactText(safeText(item?.fact || item?.summary, 360) || "" ) || null,
    entity: safeText(item?.entity, 120) || "unknown",
    source: safeText(item?.source, 160) || "unknown",
    observed_at: safeText(item?.observed_at || item?.at, 40) || null,
    record_sha256: safeHash(item?.record_sha256 || item?.hash || item?.provenance?.sha256)
  })).filter((item) => item.id);
}

function roleContextFor({ role, source, incident, humanGate, evidence, projection, componentDetail }) {
  const workflow = {
    stage: incident.stage,
    stage_status: incident.stage_status,
    human_gate: humanGate.status
  };
  const hypotheses = boundedHypotheses(projection?.investigation);
  if (role === "observer") return {
    source: { status: source.status, freshness_ms: source.freshness_ms, evidence_count: source.evidence_count },
    signal_summaries: evidence.map(({ id, kind, signal, title, entity, observed_at }) => ({ id, kind, signal, title, entity, observed_at }))
  };
  if (role === "orchestrator") return { workflow };
  if (role === "investigator") return {
    selected_component: boundedComponentDetail(componentDetail),
    evidence_summaries: evidence.map(({ id, kind, signal, title, summary, entity, observed_at }) => ({ id, kind, signal, title, summary, entity, observed_at }))
  };
  return {
    hypotheses,
    evaluator: {
      verdict: safeEnum(projection?.investigation?.evaluator?.verdict, ["accepted", "rejected", "pending", "unavailable"], "pending"),
      evidence_refs: safeIds(projection?.investigation?.evaluator?.evidence_refs)
    },
    cited_evidence: evidence.map(({ id, kind, title, entity, observed_at }) => ({ id, kind, title, entity, observed_at }))
  };
}

function boundedHypotheses(value) {
  const candidates = Array.isArray(value?.hypotheses) ? value.hypotheses : [];
  return candidates.slice(0, 8).map((item) => ({
    id: safeIdValue(item?.id),
    status: safeText(item?.status, 80) || "recorded",
    evidence_refs: safeIds(item?.evidence_refs)
  })).filter((item) => item.id);
}

function boundedComponentDetail(value) {
  if (!plain(value) || !plain(value.component)) return null;
  const component = {
    id: safeIdValue(value.component.id),
    label: safeText(value.component.label, 160) || null,
    kind: safeText(value.component.kind, 80) || null,
    status: safeText(value.component.status, 80) || null,
    source_health: safeText(value.component.source_health, 80) || null
  };
  if (!component.id) return null;
  const observability = plain(value.observability) ? value.observability : {};
  const evidenceIds = [
    ...(Array.isArray(observability.metrics) ? observability.metrics : []),
    ...(Array.isArray(observability.traces) ? observability.traces : []),
    ...(Array.isArray(observability.logs) ? observability.logs : []),
    ...(Array.isArray(observability.changes) ? observability.changes : [])
  ].map((item) => safeIdValue(item?.evidence_id)).filter(Boolean).slice(0, AGENT_TEAM_CHAT_LIMITS.max_evidence_refs);
  return {
    component,
    runtime: {
      status: safeText(value.runtime?.status, 80) || "unavailable",
      freshness_ms: safeInt(value.runtime?.freshness_ms, 86_400_000)
    },
    evidence_ids: evidenceIds
  };
}

function routeFor(requested, message) {
  const text = message.toLowerCase();
  const match = {
    evaluator: /\b(?:evaluate|evaluates|evaluated|evaluating|evaluation|evaluator|adversarial|challenge|verdict|quality)\b/.test(text),
    investigator: /\b(?:investigate|investigates|investigated|investigating|investigation|investigator|hypothesis|root cause|causal|replan)\b/.test(text),
    observer: /\b(?:freshness|fresh|connect(?:ion|ivity)?|source|signals?|anomal(?:y|ies|ous)|metrics?|traces?|logs?)\b/.test(text),
    orchestrator: /\b(?:architecture|workflow|routing|route|stage|next steps?|human gate)\b/.test(text)
  };
  const category = ["evaluator", "investigator", "observer", "orchestrator"].find((role) => match[role]) || "generic";
  let to = requested;
  let reason = null;
  if (/\bledger\b/.test(text)) {
    to = match.evaluator ? "evaluator" : match.investigator ? "investigator" : "observer";
    reason = "Evidence Ledger is a source; the selected conversational role can summarize its bounded records.";
  } else if (category !== "generic" && category !== requested) {
    to = category;
    reason = {
      observer: "Source freshness and signals belong to Observer.",
      orchestrator: "Workflow explanation and routing belong to Orchestrator.",
      investigator: "Causal investigation belongs to Investigator.",
      evaluator: "Adversarial assessment belongs to Evaluator."
    }[to];
  }
  return { from: requested, to, reason };
}

function isAuthorityRequest(message) {
  const text = message.toLowerCase();
  return /\b(?:approve|grant)\s+(?:the\s+|this\s+|a\s+)?(?:repair|remediation|change|action|owner approval)\b/.test(text)
    || /\b(?:can|could|will|would)\s+you\s+(?:approve|grant)\s+(?:the\s+|this\s+|a\s+)?(?:repair|remediation|change|action|owner approval)\b/.test(text)
    || /\b(?:apply|execute|run)\s+(?:the\s+|this\s+|a\s+)?(?:repair|remediation|fix|change)\b/.test(text)
    || /\bbypass\s+(?:the\s+)?(?:owner\s+)?gate\b/.test(text)
    || /\b(?:mark|set)\s+(?:the\s+)?(?:truth|verification|status)\s+(?:as\s+)?(?:true|verified|approved)\b/.test(text)
    || /\b(?:change|mutate)\s+(?:the\s+)?truth\b/.test(text);
}

function toolSummariesFor(context) {
  const counts = {
    read_source_freshness: context.role_context?.source ? 1 : 0,
    read_signal_summaries: context.evidence.length,
    read_workflow_projection: context.role_context?.workflow ? 1 : 0,
    read_evidence_summaries: context.evidence.length,
    read_selected_component: context.role_context?.selected_component ? 1 : 0,
    read_cited_hypotheses: context.role_context?.hypotheses?.length || 0
  };
  return context.tool_allowlist.map((tool) => ({ tool, result_count: counts[tool] || 0, raw_payload_excluded: true }));
}

function validatedModelToolRequests(value, allowlist) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 2) throw new AgentTeamChatError("node_tool_request_invalid", 422);
  return value.map((item) => {
    if (!plain(item) || Object.keys(item).sort().join(",") !== "cursor,limit,signal,tool" || !allowlist.includes(item.tool)
      || (item.cursor !== null && !safeId(item.cursor))
      || (item.limit !== null && (!Number.isSafeInteger(item.limit) || item.limit < 1 || item.limit > 12))
      || (item.signal !== null && !["all", "metric", "log", "trace", "change", "resource"].includes(item.signal))) throw new AgentTeamChatError("node_tool_request_invalid", 422);
    return { tool: item.tool, cursor: item.cursor, limit: item.limit, signal: item.signal };
  });
}

function toolQueryFor(item) {
  return {
    ...(item.cursor !== null ? { cursor: item.cursor } : {}),
    ...(item.limit !== null ? { limit: item.limit } : {}),
    ...(item.signal !== null ? { signal: item.signal } : {})
  };
}

function boundedToolQuery(value) {
  return {
    window: "15m",
    cursor: safeIdValue(value?.cursor),
    limit: Number.isSafeInteger(value?.limit) ? value.limit : null,
    signal: ["all", "metric", "log", "trace", "change", "resource"].includes(value?.signal) ? value.signal : null
  };
}

function summarizeNodeTools(results) {
  return results.slice(0, AGENT_TEAM_CHAT_LIMITS.max_tool_calls).map((item) => ({
    tool: safeText(item?.tool, 120) || "read_only",
    result_count: safeInt(item?.result_count, 10_000) || 0,
    selected_count: safeInt(item?.selected_count, 10_000) || 0,
    omitted_count: safeInt(item?.omitted_count, 10_000) || 0,
    cached: item?.cached === true,
    raw_payload_excluded: true
  }));
}

function boundedModelToolResults(results) {
  return results.slice(0, AGENT_TEAM_CHAT_LIMITS.max_tool_calls).map((item) => ({
    tool: safeText(item?.tool, 120) || "read_only",
    component_id: safeIdValue(item?.component_id),
    query_fingerprint: safeHash(item?.query_fingerprint),
    result_count: safeInt(item?.result_count, 10_000) || 0,
    selected_count: safeInt(item?.selected_count, 10_000) || 0,
    omitted_count: safeInt(item?.omitted_count, 10_000) || 0,
    evidence_refs: safeIds(item?.evidence_refs),
    records: Array.isArray(item?.records) ? item.records.slice(0, 8).map((record) => ({
      id: safeIdValue(record?.id), kind: safeText(record?.kind, 80) || "unknown", title: redactText(safeText(record?.title, 180) || "Bounded evidence"), summary: redactText(safeText(record?.summary, 360) || "") || null, entity: safeText(record?.entity, 120) || "unknown", observed_at: safeText(record?.observed_at, 40) || null, record_sha256: safeHash(record?.record_sha256)
    })).filter((record) => record.id) : [],
    source_truth: safeSourceTruth(item?.source_truth),
    raw_payload_excluded: true
  }));
}

function safeHashes(value) { return Array.isArray(value) ? [...new Set(value.filter(safeHash))].slice(0, AGENT_TEAM_CHAT_LIMITS.max_evidence_refs) : []; }
function safeSourceTruth(value) { return { mode: safeText(value?.mode, 80) || "unavailable", status: safeEnum(value?.status, ["captured", "frozen", "live", "stale", "disconnected", "unavailable"], "unavailable"), freshness_ms: safeInt(value?.freshness_ms, 31_536_000_000), observed_at: safeText(value?.observed_at, 40) || null, truth_label: safeText(value?.truth_label, 80) || "unavailable" }; }

function responsePayload({ request, messageId, route, state, answer, citations, handoff, toolSummaries, model = null, provider = null, humanGate = null }) {
  return {
    conversation_id: request.conversation_id,
    message_id: messageId,
    requested_agent: request.requested_agent,
    responding_agent: route.to,
    state,
    answer: safeAnswer(answer, route.to, {}),
    handoff: handoff ? { from: handoff.from, to: handoff.to, reason: handoff.reason } : null,
    citations: [...new Set(citations.filter(safeId))].slice(0, AGENT_TEAM_CHAT_LIMITS.max_evidence_refs),
    tool_summaries: toolSummaries.slice(0, 4),
    human_gate: { status: state === "needs_human" ? "requested" : safeEnum(humanGate?.status, ["requested", "granted", "not_required", "not_actionable"], "not_required") },
    provider: safeProvider(provider),
    ...(model ? { model } : {})
  };
}

function humanGateAnswer(humanGate) {
  const gate = humanGate.status === "granted" ? "An owner approval is already recorded; this chat still cannot execute a repair." : "A bounded owner action is required where the Owner Gate applies.";
  return `Agent Team chat cannot approve or execute repairs. ${gate}`;
}

function projectEvent(event) {
  const payload = event.payload || {};
  const base = { id: event.id, sequence: event.sequence, recorded_at: event.recorded_at, type: event.type };
  if (event.type === "agent_team.message.received") return {
    ...base,
    kind: "user",
    agent: "human",
    requested_agent: safeRole(payload.requested_agent),
    page_mode: safeEnum(payload.page_mode, [...PAGE_MODES], null),
    selected_component: safeIdValue(payload.selected_component),
    text: safeText(payload.message, AGENT_TEAM_CHAT_LIMITS.max_message_bytes) || "[redacted]"
  };
  if (event.type === "agent_team.handoff.recorded") return { ...base, kind: "handoff", from: payload.from, to: payload.to, reason: safeText(payload.reason, 200) || "routed" };
  if (event.type === "agent_team.context.prepared") return {
    ...base,
    kind: "context",
    agent: safeRole(event.actor),
    state: "routing",
    topology: { schema_version: safeText(payload.topology?.schema_version, 80) || null, projection_revision: safeHash(payload.topology?.projection_revision) },
    source_truth: { source_health: safeText(payload.source_truth?.source_health, 80) || "unavailable", evidence_mode: safeText(payload.source_truth?.evidence_mode, 80) || "captured_fixture", execution_mode: safeText(payload.source_truth?.execution_mode, 80) || "deterministic_replay" },
    citations: safeIds(payload.evidence_refs)
  };
  if (event.type === "agent_team.tool_summary.recorded") return { ...base, kind: "tool_summary", agent: safeRole(event.actor), state: "working", citations: safeIds(event.evidence_refs), tools: safeToolSummaries(payload.tools) };
  if (event.type === "agent_team.tool.requested") return {
    ...base,
    kind: "tool_request",
    agent: safeRole(event.actor),
    state: "working",
    tool: safeText(payload.tool, 120) || "read_only",
    component_id: safeIdValue(payload.component_id),
    attempt: safeInt(payload.attempt, AGENT_TEAM_CHAT_LIMITS.max_model_attempts),
    round: safeInt(payload.round, AGENT_TEAM_CHAT_LIMITS.max_tool_rounds),
    raw_payload_excluded: true
  };
  if (event.type === "agent_team.tool.result.recorded") return {
    ...base,
    kind: "tool_result",
    agent: safeRole(event.actor),
    state: "working",
    tool: safeText(payload.tool, 120) || "read_only",
    component_id: safeIdValue(payload.component_id),
    result_count: safeInt(payload.result_count, 10_000) || 0,
    selected_count: safeInt(payload.selected_count, 10_000) || 0,
    omitted_count: safeInt(payload.omitted_count, 10_000) || 0,
    cached: payload.cached === true,
    citations: safeIds(event.evidence_refs),
    source_truth: safeSourceTruth(payload.source_truth),
    raw_payload_excluded: true
  };
  if (event.type === "agent_team.response.working") return { ...base, kind: "working", requested_agent: safeRole(payload.requested_agent), responding_agent: safeRole(payload.responding_agent), state: "working", citations: safeIds(event.evidence_refs), provider: safeProvider(payload.provider) };
  if (event.type === "agent_team.response.created") return {
    ...base,
    kind: "assistant",
    requested_agent: safeRole(payload.requested_agent),
    responding_agent: safeRole(payload.responding_agent),
    agent: safeRole(payload.responding_agent),
    state: safeEnum(payload.state, ["completed", "failed", "needs_human"], "failed"),
    text: safeText(payload.answer, AGENT_TEAM_CHAT_LIMITS.max_answer_bytes) || "Unavailable",
    handoff: safeHandoff(payload.handoff),
    citations: safeIds(payload.citations),
    tool_summaries: safeToolSummaries(payload.tool_summaries),
    human_gate: { status: safeText(payload.human_gate?.status, 80) || "not_approved" },
    provider: safeProvider(payload.provider)
  };
  if (event.type === "agent_team.human_gate.required") return { ...base, kind: "human_gate", requested_agent: safeRole(payload.requested_agent), responding_agent: safeRole(payload.responding_agent), state: "needs_human", reason: safeText(payload.reason, 160) || "human_gate_required", human_gate: { status: safeText(payload.human_gate, 80) || "requested" }, citations: safeIds(event.evidence_refs) };
  if (event.type === "agent_team.error.recorded") return { ...base, kind: "error", code: safeText(payload.code, 80) || "unavailable" };
  return { ...base, kind: "context" };
}

function conversationEvents(events, conversationId) {
  return events.filter((event) => event.type.startsWith("agent_team.") && event.payload?.conversation_id === conversationId);
}

function modelMetadata(value, latencyMs, provider) {
  return {
    provider: provider.provider_kind,
    model: provider.model_label,
    latency_ms: safeInt(latencyMs, 120_000),
    usage: boundedUsage(value?.usage)
  };
}

function boundedUsage(value) {
  return {
    input_tokens: safeInt(value?.input_tokens, 100_000),
    output_tokens: safeInt(value?.output_tokens, 100_000)
  };
}

function safeAnswer(value, role, context) {
  const fallback = `${role[0].toUpperCase()}${role.slice(1)}: no bounded answer is available for the current context.`;
  return redactText(safeText(value, AGENT_TEAM_CHAT_LIMITS.max_answer_bytes) || fallback).slice(0, AGENT_TEAM_CHAT_LIMITS.max_answer_bytes);
}

function redactText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f<>&]/g, " ")
    .replace(/\b(?:sk|rk)_[A-Za-z0-9_-]{12,}\b|\bsk-[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\b(?:system|developer|user)\s+prompt\b/gi, "prompt [redacted]")
    .replace(/\b(?:provider\s+payload|raw\s+(?:log|trace|payload))\b/gi, "redacted provider detail")
    .replace(/\s+/g, " ")
    .trim();
}

function safeObservation(trace, type, name, details) {
  try {
    const observation = trace?.[type]?.(name, details);
    return observation && typeof observation === "object" ? observation : null;
  } catch {
    return null;
  }
}
function safeUpdate(observation, value) { try { observation?.update?.(value); } catch {} }
function safeEnd(observation) { try { observation?.end?.(); } catch {} }
function sha256(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requestHash(request) { return sha256(Object.fromEntries(ENVELOPE_KEYS.map((key) => [key, request[key]]))); }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value); }
function safeIdValue(value) { return safeId(value) ? value : null; }
function safeIds(value) { return Array.isArray(value) ? [...new Set(value.filter(safeId))].slice(0, AGENT_TEAM_CHAT_LIMITS.max_evidence_refs) : []; }
function safeRole(value) { return ROLES.has(value) ? value : null; }
function safeHandoff(value) { return plain(value) && ROLES.has(value.from) && ROLES.has(value.to) ? { from: value.from, to: value.to, reason: safeText(value.reason, 200) || "routed" } : null; }
function modelHandoffFor(from, value) {
  if (!plain(value) || !ROLES.has(from) || !ROLES.has(value.to) || value.to === from) return null;
  const reason = safeText(value.reason, 200);
  return reason ? { from, to: value.to, reason } : null;
}
function safeToolSummaries(value) { return Array.isArray(value) ? value.slice(0, 4).map((item) => ({ tool: safeText(item?.tool, 120) || "read_only", result_count: safeInt(item?.result_count, 10_000) || 0, selected_count: safeInt(item?.selected_count, 10_000) || 0, omitted_count: safeInt(item?.omitted_count, 10_000) || 0, cached: item?.cached === true, raw_payload_excluded: true })) : []; }
function providerCapability(adapter) { return safeProvider(typeof adapter?.capability === "function" ? adapter.capability() : null, adapter); }
function safeProvider(value, adapter = null) {
  const kinds = ["codex-local", "openai-responses", "recorded"];
  const availability = ["available", "unavailable", "preflight_required"];
  return {
    provider_kind: kinds.includes(value?.provider_kind) ? value.provider_kind : kinds.includes(adapter?.provider) ? adapter.provider : "recorded",
    availability: availability.includes(value?.availability) ? value.availability : "available",
    truth_label: safeText(value?.truth_label, 80) || (adapter?.provider === "recorded" ? "RECORDED/DEMO" : "UNAVAILABLE"),
    model_label: safeText(value?.model_label, 120) || safeText(adapter?.model, 120) || null,
    failure_reason: safeText(value?.failure_reason, 120) || null
  };
}
function safeHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function safeText(value, limit) { return typeof value === "string" && Buffer.byteLength(value, "utf8") <= limit ? value.replace(/[\u0000-\u001f\u007f<>&]/g, " ").trim() : null; }
function safeInt(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null; }
function safeEnum(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }

import "./load-env.mjs";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.mjs";
import { loadBundle } from "./bundle.mjs";
import { IncidentRuntime } from "./runtime.mjs";
import { runLiveInvestigation } from "./openai.mjs";
import { initializeObservability, shutdownObservability, withAgentControlTrace } from "./observability.mjs";
import { LiveSource } from "./live-source.mjs";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, summarizeEvidence, versionedChangeEvidence } from "./evidence-source.mjs";
import { investigationFailureEnvelope, localFailureState, projectFailureEpisode, recordInvestigationFailure } from "./investigation-failure.mjs";
import { DevelopmentRuntime } from "./development-runtime.mjs";
import * as developmentAdapter from "./development-adapter.mjs";
import { AgentControlService } from "./agent-control-service.mjs";
import { AgentTeamChatError, AgentTeamChatService } from "./agent-team-chat.mjs";
import { LocalFaultLoop, LocalFaultLoopError } from "./local-fault-loop.mjs";
import { harnessBinding, loadHarnessManifest } from "./harness-manifest.mjs";
import { AUTONOMY_POLICY_ARTIFACT, validateAutonomyPolicyArtifact } from "./autonomy-policy-artifacts.mjs";
import { failureLockKey, sha256Canonical } from "./autonomy-policy.mjs";
import { FRESHNESS_MAX_AGE_MS, FRESHNESS_RECEIPT_SCHEMA_VERSION, verifySnapshotFreshnessReceipt } from "./autonomy-freshness.mjs";
import { sha256 as hashBoundEvidence } from "./regression-backtest.mjs";
import { buildIncidentProjection, INCIDENT_PROJECTION_LIMITS } from "./incident-projection.mjs";
import { validateProjectionCanonicalChain } from "./projection-canonical-validator.mjs";
import { loadTopologyManifest, validateAstronomyIncidentSubgraph } from "./topology-manifest.mjs";
import { composeTopologyViews } from "./topology-projection.mjs";
import { composeComponentDetail, ComponentDetailProjectionError } from "./component-detail-projection.mjs";
import { NodeInvestigationError, NodeInvestigationPlane, validateNodeEvidenceQuery } from "./node-investigation-plane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const dbPath = process.env.FLOWPULSE_DB || join(root, ".flowpulse", "ledger.db");
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "127.0.0.1";
const ledger = new Ledger(dbPath);
const bundle = loadBundle();
const topologyManifest = loadTopologyManifest();
const incidentTopologyOverlay = validateAstronomyIncidentSubgraph(topologyManifest, bundle);
const runtime = new IncidentRuntime({ ledger, bundle });
const liveSource = new LiveSource({ directory: process.env.FLOWPULSE_OTLP_DIR || join(root, "outputs", "live", "otel") });
const development = new DevelopmentRuntime({ runtime, source: liveSource, adapter: developmentAdapter });
const capturedEvidence = new CapturedBundleEvidenceSource(bundle);
const snapshots = new Map();
const developmentInvestigations = new Map();
// This key and map intentionally remain module-private. They bind an issued
// receipt to this server's capture and cannot be reconstructed by a request.
const authorityReceiptSecret = randomBytes(32);
const authorityReceiptBindings = new Map();
const CAPTURE_CLOCK_SKEW_MS = 1_000;
const BROWSER_RESPONSE_MAX_BYTES = 512 * 1024;
const DEVELOPMENT_STATUS_CACHE_TTL_MS = 10_000;
// This is a server-side work bound, deliberately much smaller than an
// unbounded ledger scan and independent of the 256 KiB browser response cap.
const PROJECTION_LEDGER_MAX_BYTES = 2 * 1024 * 1024;
const DEMO_SCENARIO_ID = "astronomy-checkout-payment-captured-v1";
const DEMO_LIFECYCLE_SCHEMA_VERSION = "flowpulse.demo-lifecycle.v1";
const DEMO_INJECTION_EVIDENCE_REFS = [
  "ev-deploy-checkout",
  "ev-trace-payment-refused",
  "ev-metric-checkout-errors",
  "ev-metric-kafka-lag",
  "ev-log-consumer-delay"
];
const DEMO_REPLAY_FRAMES = [
  { id: "healthy", order: 0, phase: "HEALTHY", node_ids: [], relation_ids: [], evidence_refs: [] },
  { id: "injecting", order: 1, phase: "INJECTING", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-deploy-checkout", "ev-trace-payment-refused"] },
  { id: "payment_checkout_impact", order: 2, phase: "PAYMENT_CHECKOUT_IMPACT", node_ids: ["checkout", "payment"], relation_ids: ["checkout->payment"], evidence_refs: ["ev-metric-checkout-errors"] },
  { id: "downstream_propagation", order: 3, phase: "DOWNSTREAM_PROPAGATION", node_ids: ["kafka", "accounting", "fraud-detection"], relation_ids: ["checkout->kafka", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-kafka-lag", "ev-log-consumer-delay"] },
  { id: "incident_detected", order: 4, phase: "INCIDENT_DETECTED", node_ids: ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"], relation_ids: ["checkout->kafka", "checkout->payment", "frontend->checkout", "kafka->accounting", "kafka->fraud-detection"], evidence_refs: ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"] }
];
let developmentStatusCache = { value: null, expiresAt: 0, pending: null };
let activeDemoRunId = initializeDemoRun();
let activeWorkspaceRunId = null;
validateAutonomyPolicyArtifact(AUTONOMY_POLICY_ARTIFACT);
const langfuseEnabled = await initializeObservability().catch(() => {
  console.warn("Langfuse disabled");
  return false;
});
const agentControl = new AgentControlService({ runtime, langfuseEnabled });
let localFaultLoop;
const agentTeamChat = new AgentTeamChatService({
  runtime,
  stateForRun: (runId) => agentTeamStateForRun(runId),
  incidentIdForRun: (runId) => localFaultLoopProjection(runId)?.incident_id || runtime.bundle.incident.id,
  contextForRun: async (_runtime, runId, request = {}) => {
    const state = await nodeStateForRun(runId);
    // Agent Control consumes the browser state projection directly.  Do not
    // reconstruct or patch its source truth here: a chat answer must describe
    // the exact same evidence authority as the visible workspace.
    const incidentProjection = state.incident_projection;
    const selectedComponent = typeof request.selected_component === "string" ? request.selected_component : null;
    const plane = await nodeInvestigationPlaneForRun(runId, state);
    const source = plane.source;
    const sourceEvidence = selectedComponent
      ? plane.snapshot(selectedComponent, {}).evidence.items
      : source.list({ limit: 12 }).items;
    let selectedComponentDetail = null;
    if (selectedComponent) {
      try {
        selectedComponentDetail = componentDetailResponse(plane.snapshot(selectedComponent, {}));
      } catch (error) {
        if (!(error instanceof ComponentDetailProjectionError) && !(error instanceof NodeInvestigationError)) throw error;
      }
    }
    const sourceMetadata = source.metadata();
    const sourceState = await sourceProjection(runId, source);
    return {
      topology_views: state.topology_views,
      incident_projection: incidentProjection,
      source: {
        status: sourceMetadata.status,
        freshness_ms: sourceState.freshness_ms,
        evidence_count: sourceMetadata.evidence_count
      },
      source_evidence: sourceEvidence,
      selected_component_detail: selectedComponentDetail,
      node_plane: plane
    };
  }
});
localFaultLoop = new LocalFaultLoop({
  ledger,
  modelAdapter: agentTeamChat.modelAdapter,
  topologyProvider: async () => (await stateWithSource(browserRunId())).topology_views,
  leaseMs: localFaultLoopLeaseMs()
});

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "OPTIONS") return send(response, 204, "");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (activeDemoWriteBlocked(request.method, url.pathname)) {
      return json(response, 409, { error: "demo_mode_active" });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      if (requestedRunId !== null && !safeBrowserId(requestedRunId)) return json(response, 400, { error: "browser_state_run_id_invalid" });
      try {
        return json(response, 200, await browserStateForRun(requestedRunId || browserRunId(), { cursor: url.searchParams.get("projection_cursor") }));
      } catch (error) {
        if (error?.code === "browser_state_run_unavailable") return json(response, 404, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/source" && request.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      if (requestedRunId !== null && !safeBrowserId(requestedRunId)) return json(response, 400, { error: "browser_state_run_id_invalid" });
      try {
        return json(response, 200, (await browserStateForRun(requestedRunId || browserRunId())).source);
      } catch (error) {
        if (error?.code === "browser_state_run_unavailable") return json(response, 404, { error: error.code });
        throw error;
      }
    }
    if (url.pathname.startsWith("/api/components/") && url.pathname.endsWith("/events") && request.method === "GET") {
      return await streamNodeEvidenceEvents(request, response, url);
    }
    if (url.pathname.startsWith("/api/components/") && request.method === "GET") {
      let nodeId;
      try {
        nodeId = decodeURIComponent(url.pathname.slice("/api/components/".length));
      } catch {
        return json(response, 404, { error: "component_detail_unavailable" });
      }
      if (!safeBrowserId(nodeId)) return json(response, 404, { error: "component_detail_unavailable" });
      const runId = url.searchParams.get("run_id") || browserRunId();
      if (!knownNodeRun(runId)) return json(response, 409, { error: "node_evidence_run_unavailable" });
      const state = await nodeStateForRun(runId);
      if (!state.topology_views) return json(response, 409, { error: "component_detail_unavailable" });
      try {
        const plane = await nodeInvestigationPlaneForRun(runId, state);
        return json(response, 200, componentDetailResponse(plane.snapshot(nodeId, nodeQueryFromUrl(url))));
      } catch (error) {
        if (error instanceof NodeInvestigationError) return json(response, error.status, { error: error.code });
        if (error instanceof ComponentDetailProjectionError) return json(response, 409, { error: "component_detail_unavailable" });
        throw error;
      }
    }
    if (url.pathname === "/api/evidence" && request.method === "GET") {
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || browserRunId());
      return json(response, 200, { source: redactedSource(source.metadata()), ...redactedEvidencePage(source.list({
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        entity: url.searchParams.get("entity") || undefined
      })) });
    }
    if (url.pathname.startsWith("/api/evidence/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/evidence/".length));
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || browserRunId());
      return json(response, 200, { source: redactedSource(source.metadata()), evidence: redactedEvidenceDetail(source.detail(id)) });
    }
    if (url.pathname === "/api/agent-control" && request.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      if (requestedRunId !== null && !safeBrowserId(requestedRunId)) return json(response, 400, { error: "browser_state_run_id_invalid" });
      try {
        return json(response, 200, (await browserStateForRun(requestedRunId || browserRunId())).agent_control);
      } catch (error) {
        if (error?.code === "browser_state_run_unavailable") return json(response, 404, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/agent-control/events" && request.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      const conversationId = url.searchParams.get("conversation_id");
      if (conversationId !== null && requestedRunId === null) return json(response, 400, { error: "conversation_run_id_required" });
      if (requestedRunId !== null && !safeBrowserId(requestedRunId)) return json(response, 400, { error: "browser_state_run_id_invalid" });
      if (!knownAgentRun(requestedRunId || browserRunId())) return json(response, 409, { error: "agent_control_run_unavailable" });
      return streamAgentEvents(request, response, url);
    }
    if (url.pathname === "/api/agent-control/conversation" && request.method === "GET") {
      const conversationId = url.searchParams.get("conversation_id");
      const requestedRunId = url.searchParams.get("run_id");
      if (conversationId !== null && requestedRunId === null) return json(response, 400, { error: "conversation_run_id_required" });
      if (requestedRunId !== null && !safeBrowserId(requestedRunId)) return json(response, 400, { error: "browser_state_run_id_invalid" });
      const runId = requestedRunId || browserRunId();
      if (!knownAgentRun(runId)) return json(response, 409, { error: "conversation_run_unavailable" });
      try {
        return json(response, 200, agentTeamChat.project({ runId, conversationId }));
      } catch (error) {
        if (error instanceof AgentTeamChatError) return json(response, error.status, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/agent-control/provider" && request.method === "GET") {
      return json(response, 200, await agentTeamChat.preflightProvider());
    }
    if (url.pathname === "/api/demo/agent-loop/events" && request.method === "GET") {
      return streamLocalFaultLoopEvents(request, response, url);
    }
    if (url.pathname === "/api/demo/agent-loop" && request.method === "GET") {
      const runId = url.searchParams.get("run_id");
      try {
        return json(response, 200, localFaultLoop.project(runId));
      } catch (error) {
        if (error instanceof LocalFaultLoopError) return json(response, 404, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/demo/agent-loop/run" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      if (!plainLocalFaultLoopRequest(body)) return json(response, 400, { error: "local_fault_loop_request_invalid" });
      try {
        const projection = await localFaultLoop.start({ caseId: body.case_id, round: body.round, idempotencyKey: body.idempotency_key || null });
        activeWorkspaceRunId = projection.run_id;
        return json(response, 202, projection);
      } catch (error) {
        if (error instanceof LocalFaultLoopError) return json(response, error.code === "local_fault_loop_idempotency_conflict" ? 409 : 422, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/agent-control/chat" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const abort = new AbortController();
      request.once("aborted", () => abort.abort());
      try {
        const result = await withAgentControlTrace({
          runId: typeof body?.run_id === "string" ? body.run_id : "invalid",
          incidentId: runtime.bundle.incident.id,
          action: "agent-team-chat",
          input: {
            conversation_id: typeof body?.conversation_id === "string" ? body.conversation_id : null,
            requested_agent: typeof body?.requested_agent === "string" ? body.requested_agent : null,
            page_mode: typeof body?.page_mode === "string" ? body.page_mode : null,
            message_bytes: typeof body?.message === "string" ? Buffer.byteLength(body.message, "utf8") : null
          }
        }, async (trace) => agentTeamChat.submit(body, { trace, signal: abort.signal }));
        return json(response, 200, result);
      } catch (error) {
        if (error instanceof AgentTeamChatError) return json(response, error.status, { error: error.code });
        throw error;
      }
    }
    if (url.pathname === "/api/agent-control/message" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = browserRunId();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: "manager-message",
        input: { message: body.message, collaborator_id: body.collaborator_id }
      }, async (trace) => {
        const generation = trace.generation("flowpulse.manager-response", {
          input: { message: body.message, collaborator_id: body.collaborator_id },
          model: process.env.OPENAI_MODEL || "deterministic-ledger-projection",
          metadata: { run_id: runId, authority: "flowpulse-ledger" }
        });
        const result = agentControl.message(runId, body.message, body.collaborator_id);
        const browser = await stateWithSource(runId);
        const safeResult = { intent: safeBrowserText(result.intent, 80), collaborator_id: safeBrowserText(result.collaborator_id, 80), message: safeBrowserText(result.message, 512), projection: browser.agent_control };
        generation.update({ output: { intent: safeResult.intent, collaborator_id: safeResult.collaborator_id, message: safeResult.message, citations: safeResult.projection.report.citations } });
        generation.end();
        return safeResult;
      }));
    }
    if (url.pathname === "/api/agent-control/action" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = browserRunId();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: String(body.action || ""),
        input: { action: body.action, parameters: body.input || {} }
      }, async (trace) => {
        const tool = trace.tool("flowpulse.agent-action", { input: { action: body.action, parameters: body.input || {} }, metadata: { run_id: runId } });
        agentControl.act(runId, body.action, body.input || {});
        const projection = (await stateWithSource(runId)).agent_control;
        tool.update({ output: { current_agent_id: projection.current_agent_id, last_event_id: projection.last_event_id } });
        tool.end();
        return projection;
      }));
    }
    if (url.pathname === "/api/development/status" && request.method === "GET") {
      const status = await cachedDevelopmentStatus();
      response.setHeader("x-flowpulse-development-status-cache", status.cache);
      return json(response, 200, status.value);
    }
    if (url.pathname === "/api/development/setup" && request.method === "POST") {
      requireJson(request);
      const result = await developmentAdapter.setupDevelopment();
      invalidateDevelopmentStatusCache();
      return json(response, 200, result);
    }
    if (url.pathname === "/api/development/start" && request.method === "POST") {
      requireJson(request);
      const result = await developmentAdapter.startDevelopment();
      invalidateDevelopmentStatusCache();
      return json(response, 200, result);
    }
    if (url.pathname === "/api/development/case" && request.method === "POST") {
      requireJson(request);
      const runId = await development.start();
      // A successful local development case supersedes the read-only replay
      // demo as the browser's canonical run. This is intentionally done only
      // after the server-owned case start has completed.
      activeDemoRunId = null;
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/investigate" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      if (!isEmptyObject(body)) return json(response, 409, { error: "Development investigation accepts no caller authority input" });
      const runId = runtime.ensureRun();
      try {
        await singleFlightDevelopmentInvestigation(runId);
        return json(response, 200, await stateWithSource(runId));
      } catch (error) {
        const failure = recordInvestigationFailure({
          runtime,
          runId,
          error,
          failedType: "development.investigation.failed",
          actor: "development-evaluator"
        });
        return json(response, failure.httpStatus, investigationFailureEnvelope(failure, localFailureState(runtime, runId)));
      }
    }
    if (url.pathname === "/api/development/approve" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      const owner = approvalOwner(body);
      if (!owner) return json(response, 409, { error: "An explicit bounded owner is required" });
      await approveDevelopmentAfterAuthority({ run_id: runId, incident_id: runtime.bundle.incident.id, intent_id: "checkout-payment", owner });
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/verify" && request.method === "POST") {
      requireJson(request);
      const runId = runtime.ensureRun();
      await development.verify(runId);
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/reset" && request.method === "POST") {
      // Compatibility replay reset. Active deterministic demos must use the
      // bounded /api/demo/reset route, enforced at the routing boundary.
      activeDemoRunId = null;
      const runId = runtime.startRun();
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/next" && request.method === "POST") {
      const runId = runtime.ensureRun();
      agentControl.advance(runId, "timeline-advance");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      if (runMode(runId) === "development") return json(response, 409, { error: "Development approval requires the canonical development Owner Gate" });
      runtime.approve(runId, body.owner || "Incident owner");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/demo/inject" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = browserRunId();
      const current = await stateWithSource(runId);
      const result = injectDemoIncident({ runId, body, current });
      if (!result.ok) return json(response, 409, { error: result.code });
      return json(response, result.inserted ? 201 : 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/demo/reset" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      if (!isEmptyObject(body)) return json(response, 409, { error: "Demo reset accepts no caller state" });
      activeWorkspaceRunId = null;
      activeDemoRunId = createHealthyDemoRun();
      return json(response, 201, await stateWithSource(activeDemoRunId));
    }
    if (url.pathname === "/api/live" && request.method === "POST") {
      const runId = runtime.startRun("live");
      try {
        const snapshot = await freezeLiveEvidence(runId);
        const result = await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot });
        return json(response, 200, { result, state: await stateWithSource(runId) });
      } catch (error) {
        const failure = recordInvestigationFailure({ runtime, runId, error, failedType: "live.run.failed", actor: "live-evaluator" });
        return json(response, failure.httpStatus, investigationFailureEnvelope(failure, localFailureState(runtime, runId)));
      }
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      const source = await liveSource.project();
      return json(response, 200, { ok: true, ledger: "sqlite-append-only", agent_control: "ledger-governed-agent-team-harness", langfuse: langfuseEnabled, source: source.status });
    }
    if (request.method !== "GET") return json(response, 404, { error: "Not found" });
    return serveStatic(url.pathname, response);
  } catch (error) {
    const message = error?.message?.startsWith("application/json is required")
      ? "application/json is required"
      : error?.message?.includes("Unknown evidence id")
        ? "Not found"
        : "Request could not be completed";
    const status = message === "Not found" ? 404 : message === "application/json is required" ? 409 : 500;
    return json(response, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`FlowPulse ready at http://${host}:${port}`);
  console.log(`Mode: deterministic replay${process.env.OPENAI_API_KEY ? " + live GPT-5.6" : ""}${langfuseEnabled ? " + Langfuse" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await shutdownObservability().catch(() => {});
    process.exit(0);
  });
}

// The following boundary is intentionally local to this server module. It is
// invoked only after an investigator has persisted diagnosis.gate.passed; no
// route, model tool, fixture, or client can import a decision provider.
async function singleFlightDevelopmentInvestigation(runId) {
  const existing = developmentInvestigations.get(runId);
  if (existing) return existing;
  const work = (async () => {
    const existingGate = ledger.list(runId).some((event) => event.type === "diagnosis.gate.passed");
    const snapshot = snapshots.get(runId) || await freezeLiveEvidence(runId);
    if (!existingGate) {
      if (process.env.OPENAI_API_KEY) await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot, repairContract: development.repairContract(runId) });
      else await development.investigate(runId, snapshot);
    }
    await advanceAutonomyAfterDiagnosis({ run_id: runId, incident_id: runtime.bundle.incident.id, intent_id: "checkout-payment" });
  })();
  developmentInvestigations.set(runId, work);
  try {
    return await work;
  } finally {
    if (developmentInvestigations.get(runId) === work) developmentInvestigations.delete(runId);
  }
}

async function approveDevelopmentAfterAuthority({ run_id, incident_id, intent_id, owner }) {
  const decision = await advanceAutonomyAfterDiagnosis({ run_id, incident_id, intent_id });
  if (decision?.payload?.outcome !== "human_review_required") throw autonomyFailure("owner_gate_not_actionable", "autonomy.decision.recorded");
  const events = ledger.list(run_id);
  const request = events.find((event) => event.type === "approval.requested" && event.payload?.decision_id === decision.id);
  const proposal = events.find((event) => event.type === "repair.proposed" && event.payload?.decision_id === decision.id);
  if (!request || !proposal || !exactFullContract(request.payload, decision.payload.contract) || !exactFullContract(proposal.payload, decision.payload.contract)) {
    throw autonomyFailure("owner_gate_contract_invalid", "approval.requested");
  }
  const claim = claimCanonicalDevelopmentApproval({ run_id, incident_id, intent_id, owner, decision, proposal, request });
  return executeCanonicalDevelopmentApproval({ run_id, decision, proposal, request, approval: claim });
}

async function advanceAutonomyAfterDiagnosis({ run_id, incident_id, intent_id }) {
  assertAutonomySelector({ run_id, incident_id, intent_id });
  validateAutonomyPolicyArtifact(AUTONOMY_POLICY_ARTIFACT);
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intent_id);
  if (!intent) throw autonomyFailure("unknown_intent", "intent_id");
  const manifest = captureAuthoritySnapshot({ run_id, incident_id, intent_id });
  const events = ledger.list(run_id);
  const now = trustedNow();
  const validated = validateAuthorityPrerequisites({ events, manifest, intent, now, incident_id, run_id });
  const issued = issueAuthorityFreshnessReceipt({ run_id, incident_id, intent_id, manifest, validated });
  verifyAuthorityReceipt({ receipt: issued.receipt, binding: issued.binding, manifest, validated, now });
  const locks = readAuthorityLocks({ incident_id, run_id, contract_sha256: validated.contract_sha256, target: intent.contract.target });
  const decision = buildAuthorityDecision({ run_id, incident_id, intent, manifest, validated, receipt: issued.receipt, locks });
  return appendDecisionAndPendingOwnerContract({ decision, validated, intent });
}

function captureAuthoritySnapshot({ run_id, incident_id, intent_id }) {
  const snapshot = snapshots.get(run_id);
  if (!snapshot || typeof snapshot.metadata !== "function" || !Array.isArray(snapshot.records)) throw autonomyFailure("snapshot_unavailable", "snapshot");
  const metadata = snapshot.metadata();
  if (metadata.mode !== "frozen_real_otlp_snapshot" || metadata.run_id !== run_id || metadata.incident_id !== incident_id || metadata.source_status !== "live") {
    throw autonomyFailure("snapshot_scope_or_source_invalid", "snapshot.metadata");
  }
  const snapshotRecords = new Map();
  const records = snapshot.records.map((record) => {
    const summary = summarizeEvidence(record);
    snapshotRecords.set(record.id, record);
    return {
      id: record.id,
      sha256: record.provenance?.sha256 || record.hash,
      source: record.source,
      mode: metadata.mode,
      summary_sha256: hashBoundEvidence(summary)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!records.length || records.some((record) => !validHash(record.sha256) || !validHash(record.summary_sha256) || !boundedText(record.id, 160) || !boundedText(record.source, 240))) throw autonomyFailure("snapshot_manifest_invalid", "snapshot.records");
  const expectedIds = [...metadata.evidence_ids].sort();
  if (expectedIds.length !== records.length || expectedIds.some((id, index) => id !== records[index].id)) throw autonomyFailure("snapshot_manifest_drift", "snapshot.evidence_ids");
  const core = { id: snapshot.id, content_sha256: metadata.content_hash, mode: metadata.mode, records };
  const frozenAt = timestamp(metadata.frozen_at);
  const sourceObservedAt = timestamp(metadata.source_last_observed_at);
  if (!boundedText(intent_id, 120) || !frozenAt || !sourceObservedAt || sourceObservedAt - frozenAt > CAPTURE_CLOCK_SKEW_MS || !validHash(core.content_sha256)) throw autonomyFailure("snapshot_manifest_invalid", "snapshot.metadata");
  const captureFrozenAt = new Date(Math.max(frozenAt, sourceObservedAt)).toISOString();
  return { ...core, manifest_sha256: sha256Canonical(core), frozen_at: captureFrozenAt, source_observed_at: metadata.source_last_observed_at, snapshot_records: snapshotRecords };
}

function issueAuthorityFreshnessReceipt({ run_id, incident_id, intent_id, manifest, validated }) {
  // A receipt describes the server-owned capture, never a decision-time refresh.
  const observed_at = manifest.frozen_at;
  const expires_at = new Date(timestamp(observed_at) + FRESHNESS_MAX_AGE_MS).toISOString();
  const unsigned = {
    schema_version: FRESHNESS_RECEIPT_SCHEMA_VERSION,
    issuer: "flowpulse.authority-composition.v1",
    snapshot_id: manifest.id,
    snapshot_content_sha256: manifest.content_sha256,
    snapshot_manifest_sha256: manifest.manifest_sha256,
    snapshot_mode: manifest.mode,
    source_mode: "live",
    truth_mode: "live",
    observed_at,
    expires_at
  };
  const receipt = { ...unsigned, receipt_sha256: sha256Canonical(unsigned) };
  const binding = authorityBinding({ run_id, incident_id, intent_id, manifest: stripManifest(manifest), validated, artifact: artifactBinding(intent_id), receipt_sha256: receipt.receipt_sha256 });
  authorityReceiptBindings.set(receipt.receipt_sha256, binding);
  return { receipt, binding };
}

function verifyAuthorityReceipt({ receipt, binding, manifest, validated, now }) {
  try {
    verifySnapshotFreshnessReceipt({ receipt, manifest: stripManifest(manifest), now });
  } catch (error) {
    throw autonomyFailure(error?.code || "freshness_receipt_invalid", error?.field_path || "receipt");
  }
  const stored = authorityReceiptBindings.get(receipt.receipt_sha256);
  const expected = authorityBinding({ run_id: validated.run_id, incident_id: validated.incident_id, intent_id: validated.intent_id, manifest: stripManifest(manifest), validated, artifact: artifactBinding(validated.intent_id), receipt_sha256: receipt.receipt_sha256 });
  if (!stored || !binding || !safeEqual(stored, binding) || !safeEqual(stored, expected)) throw autonomyFailure("freshness_receipt_binding_mismatch", "receipt");
}

function validateAuthorityPrerequisites({ events, manifest, intent, now, incident_id, run_id }) {
  if (!Array.isArray(events) || !events.length || events.some((event, index) => !validLedgerEvent(event, incident_id, run_id) || (index && event.sequence <= events[index - 1].sequence))) {
    throw autonomyFailure("ledger_scope_or_sequence_invalid", "events");
  }
  const accepted = events.filter((event) => event.type === "evaluation.accepted");
  const gates = events.filter((event) => event.type === "diagnosis.gate.passed");
  if (accepted.length !== 1 || gates.length !== 1) throw autonomyFailure("authority_gate_count_invalid", "events");
  const evaluation = accepted[0];
  const gate = gates[0];
  const decisionAt = timestamp(now);
  const sourceObservedAt = timestamp(manifest.source_observed_at);
  const frozenAt = timestamp(manifest.frozen_at);
  const evaluationAt = timestamp(evaluation.recorded_at);
  const gateAt = timestamp(gate.recorded_at);
  if (!decisionAt || !sourceObservedAt || !frozenAt || !evaluationAt || !gateAt
    || sourceObservedAt > frozenAt || frozenAt > evaluationAt || evaluationAt > gateAt || gateAt > decisionAt
    || decisionAt - frozenAt >= FRESHNESS_MAX_AGE_MS || evaluation.sequence >= gate.sequence) {
    throw autonomyFailure("authority_gate_order_invalid", "events");
  }
  const payload = evaluation.payload;
  const expectedChecks = ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"];
  if (payload?.accepted !== true || payload.classification !== "confirmed_system_bug" || payload.phase !== "diagnosis_pre_approval" || !expectedChecks.every((key) => payload.gate_checks?.[key] === true) || !Array.isArray(payload.missing_evidence) || payload.missing_evidence.length) {
    throw autonomyFailure("evaluator_not_authoritative", "evaluation.accepted");
  }
  const diagnosis = gate.payload?.accepted?.diagnosis;
  const gateEvaluation = gate.payload?.accepted?.evaluation;
  const refs = gate.payload?.accepted?.evidence_ids;
  const contract = intent.contract;
  const contract_sha256 = sha256Canonical(contract);
  if (!diagnosis || !gateEvaluation || !boundedText(diagnosis.id, 160) || payload.hypothesis_id !== diagnosis.id || !sameCanonicalEvaluation(payload, gateEvaluation) || !Array.isArray(refs) || !sameSet(refs, evaluation.evidence_refs) || !sameSet(refs, payload.counter_evidence_refs) || !sameSet(refs, diagnosis.evidence_refs) || !sameSet(refs, gate.evidence_refs) || !sameSet(payload.counter_evidence_refs, gateEvaluation.counter_evidence_refs)) {
    throw autonomyFailure("authority_evidence_refs_invalid", "diagnosis.gate.passed");
  }
  const change = events.find((event) => event.type === "change.applied")?.payload?.change;
  if (!coreContractMatches(diagnosis.proposed_repair, contract) || !coreContractMatches(gate.payload?.repair_contract, contract) || !contractMatchesCapturedChange(contract, change) || gate.payload?.snapshot?.id !== manifest.id || gate.payload?.snapshot?.content_sha256 !== manifest.content_sha256 || gate.payload?.snapshot?.mode !== manifest.mode) {
    throw autonomyFailure("authority_contract_or_snapshot_mismatch", "diagnosis.gate.passed");
  }
  const manifestById = new Map(manifest.records.map((record) => [record.id, record]));
  if (new Set(refs).size !== refs.length || refs.length === 0 || refs.some((id) => !manifestById.has(id))) throw autonomyFailure("authority_evidence_membership_invalid", "evidence_refs");
  const bindings = gate.payload?.accepted?.evidence_bindings;
  if (!Array.isArray(bindings) || bindings.length !== refs.length || new Set(bindings.map((item) => item?.id)).size !== bindings.length || bindings.some((item) => {
    const record = manifestById.get(item?.id);
    const safeRecord = item?.record;
    const sourceRecord = manifest.snapshot_records.get(item?.id);
    const currentSummary = sourceRecord ? summarizeEvidence(sourceRecord) : null;
    const evidenceHash = currentSummary?.provenance?.sha256 || currentSummary?.hash;
    return !record || !sourceRecord || !validHash(item.sha256) || item.sha256 !== record.summary_sha256 || item.sha256 !== hashBoundEvidence(safeRecord) || record.summary_sha256 !== hashBoundEvidence(currentSummary) || hashBoundEvidence(safeRecord) !== hashBoundEvidence(currentSummary) || evidenceHash !== record.sha256 || currentSummary?.source !== record.source;
  })) throw autonomyFailure("authority_evidence_binding_invalid", "evidence_bindings");
  return {
    run_id, incident_id, intent_id: intent.id, evaluation_event_id: evaluation.id, evaluation_sequence: evaluation.sequence,
    evaluation_payload_sha256: evaluation.payload_sha256, diagnosis_event_id: gate.id, diagnosis_sequence: gate.sequence,
    diagnosis_payload_sha256: gate.payload_sha256, evidence_refs: [...refs].sort(), evidence_bindings: bindings.map((item) => ({ id: item.id, sha256: item.sha256, record_sha256: item.record.provenance?.sha256 || item.record.hash, source: item.record.source, mode: manifest.mode })).sort((a, b) => a.id.localeCompare(b.id)), contract_sha256,
    gate_identity_sha256: sha256Canonical({ evaluator: { id: evaluation.id, sequence: evaluation.sequence, payload_sha256: evaluation.payload_sha256 }, diagnosis_gate: { id: gate.id, sequence: gate.sequence, payload_sha256: gate.payload_sha256 }, evidence_bindings: bindings.map((item) => ({ id: item.id, sha256: item.sha256 })).sort((a, b) => a.id.localeCompare(b.id)), contract_sha256 })
  };
}

function readAuthorityLocks({ incident_id, run_id, contract_sha256, target }) {
  let locks;
  try { locks = ledger.listAutonomyLocks(); } catch { throw autonomyFailure("failure_lock_state_unavailable", "autonomy.locked"); }
  for (const event of locks) {
    const payload = event?.payload;
    const touches = event?.incident_id === incident_id || payload?.incident_id === incident_id;
    if (!touches) continue;
    if (!validLedgerEvent(event, event.incident_id, event.run_id) || !payload || payload.incident_id !== event.incident_id || !boundedText(payload.target, 160) || !validHash(payload.contract_sha256) || payload.lock_key !== failureLockKey({ incident_id: payload.incident_id, contract_sha256: payload.contract_sha256, target: payload.target })) {
      throw autonomyFailure("failure_lock_state_unavailable", "autonomy.locked");
    }
    if (payload.incident_id === incident_id && payload.contract_sha256 === contract_sha256 && payload.target === target) return { blocked: true, event_id: event.id, observed_sequence: locks.at(-1)?.sequence || 0 };
  }
  return { blocked: false, observed_sequence: locks.at(-1)?.sequence || 0 };
}

function buildAuthorityDecision({ run_id, incident_id, intent, manifest, validated, receipt, locks }) {
  const impact = intent.impact?.level;
  const blocked = locks.blocked === true;
  const human = !blocked && (impact !== "low" || intent.id === "checkout-payment");
  const artifact = artifactBinding(intent.id);
  const immutableIdentity = {
    run_id, incident_id, intent_id: intent.id, environment: intent.environment,
    artifact, manifest: stripManifest(manifest), gate_identity_sha256: validated.gate_identity_sha256,
    contract_sha256: validated.contract_sha256, evidence_bindings: validated.evidence_bindings,
    source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: intent.execution_mode,
    lock_event_id: locks.event_id || null, receipt_sha256: receipt.receipt_sha256
  };
  const decision_sha256 = sha256Canonical(immutableIdentity);
  const payload = {
    schema_version: "flowpulse.autonomy.v1", run_id, incident_id, intent_id: intent.id, environment: intent.environment,
    source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: intent.execution_mode,
    contract: intent.contract, contract_sha256: validated.contract_sha256, snapshot: stripManifest(manifest),
    receipt_sha256: receipt.receipt_sha256, authority_context_sha256: authorityBinding(immutableIdentity),
    artifact, authority_evidence: {
      evaluator: { id: validated.evaluation_event_id, sequence: validated.evaluation_sequence, payload_sha256: validated.evaluation_payload_sha256 },
      diagnosis_gate: { id: validated.diagnosis_event_id, sequence: validated.diagnosis_sequence, payload_sha256: validated.diagnosis_payload_sha256 },
      refs: validated.evidence_bindings
    },
    outcome: blocked ? "non_actionable" : human ? "human_review_required" : "auto_execute_pre_authorized",
    reason_code: blocked ? "failure_lock_present" : human ? "owner_gate_required" : "preauthorized_low_risk",
    capture_observed_at: manifest.source_observed_at,
    decision_sha256
  };
  return { ...payload, decision_sha256, decision_id: `autonomy-decision-${decision_sha256.slice(0, 32)}` };
}

function appendDecisionAndPendingOwnerContract({ decision, validated, intent }) {
  const inserted = ledger.appendIfAbsent({ id: decision.decision_id, runId: decision.run_id, incidentId: decision.incident_id, type: "autonomy.decision.recorded", actor: "authority-composition", payload: decision, evidenceRefs: validated.evidence_refs, correlationId: decision.decision_id });
  if (!inserted.inserted && !sameCanonicalDecisionEvent(inserted.event, decision, validated.evidence_refs)) throw autonomyFailure("authority_claim_conflict", "decision_id");
  if (decision.outcome === "human_review_required") {
    const ownerGate = canonicalOwnerGate({ decision, intent, evidenceRefs: validated.evidence_refs });
    const proposal = ledger.appendIfAbsent(ownerGate.proposal);
    if (!proposal.inserted && !sameCanonicalOwnerGateEvent(proposal.event, ownerGate.proposal, inserted.event)) throw autonomyFailure("owner_gate_proposal_conflict", "repair.proposed");
    const request = ledger.appendIfAbsent(ownerGate.request);
    if (!request.inserted && !sameCanonicalOwnerGateEvent(request.event, ownerGate.request, proposal.event)) throw autonomyFailure("owner_gate_request_conflict", "approval.requested");
    if (!(inserted.event.sequence < proposal.event.sequence && proposal.event.sequence < request.event.sequence)) throw autonomyFailure("owner_gate_order_invalid", "approval.requested");
  }
  return inserted.event;
}

function canonicalOwnerGate({ decision, intent, evidenceRefs }) {
  const proposalId = `repair-proposed-${decision.decision_sha256.slice(0, 32)}`;
  const requestId = `approval-request-${decision.decision_sha256.slice(0, 32)}`;
  return {
    proposal: {
      id: proposalId,
      runId: decision.run_id,
      incidentId: decision.incident_id,
      type: "repair.proposed",
      actor: "authority-composition",
      payload: { ...intent.contract, bounded: true, decision_id: decision.decision_id, contract_sha256: decision.contract_sha256 },
      evidenceRefs,
      correlationId: decision.decision_id
    },
    request: {
      id: requestId,
      runId: decision.run_id,
      incidentId: decision.incident_id,
      type: "approval.requested",
      actor: "authority-composition",
      payload: { ...intent.contract, owner_team: "local-development", decision_id: decision.decision_id, contract_sha256: decision.contract_sha256, reason: "Consequential checkout remediation requires an explicit owner decision." },
      evidenceRefs,
      correlationId: decision.decision_id,
      parentId: proposalId
    }
  };
}

function claimCanonicalDevelopmentApproval({ run_id, incident_id, intent_id, owner, decision, proposal, request }) {
  assertAutonomySelector({ run_id, incident_id, intent_id });
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intent_id);
  if (!intent || !sameCanonicalDecisionEvent(decision, decision.payload, decision.evidence_refs)) throw autonomyFailure("canonical_decision_invalid", "autonomy.decision.recorded");
  const ownerGate = canonicalOwnerGate({ decision: decision.payload, intent, evidenceRefs: decision.evidence_refs });
  if (!sameCanonicalOwnerGateEvent(proposal, ownerGate.proposal, decision) || !sameCanonicalOwnerGateEvent(request, ownerGate.request, proposal) || !(decision.sequence < proposal.sequence && proposal.sequence < request.sequence)) {
    throw autonomyFailure("owner_gate_contract_or_order_invalid", "approval.requested");
  }
  const locks = readAuthorityLocks({ incident_id, run_id, contract_sha256: decision.payload.contract_sha256, target: intent.contract.target });
  if (locks.blocked) throw autonomyFailure("failure_lock_present", "autonomy.locked");
  const approvalId = `approval-granted-${decision.payload.decision_sha256.slice(0, 32)}`;
  const approvalPayload = { owner, ...decision.payload.contract, scope: "local checkout container only", decision_id: decision.id, contract_sha256: decision.payload.contract_sha256 };
  const inserted = atomicApprovalClaim({
    approvalId,
    approvalPayload,
    decision,
    proposal,
    request,
    observedLockSequence: locks.observed_sequence,
    contract_sha256: decision.payload.contract_sha256,
    target: intent.contract.target,
    lock_key: failureLockKey({ incident_id, contract_sha256: decision.payload.contract_sha256, target: intent.contract.target })
  });
  if (!inserted) throw autonomyFailure("atomic_approval_claim_rejected", "approval.granted");
  const approval = ledger.get(approvalId);
  if (!sameCanonicalApprovalEvent(approval, { approvalId, approvalPayload, decision, request })) throw autonomyFailure("atomic_approval_claim_invalid", "approval.granted");
  return approval;
}

// This is deliberately server-local: only the request that atomically inserted
// the canonical approval may create the one-shot execution-attempt claim.
// A previously seeded approval event is inert because it never reaches here.
async function executeCanonicalDevelopmentApproval({ run_id, decision, proposal, request, approval }) {
  const events = ledger.list(run_id);
  const currentDecision = events.find((event) => event.id === decision.id);
  const currentProposal = events.find((event) => event.id === proposal.id);
  const currentRequest = events.find((event) => event.id === request.id);
  const currentApproval = events.find((event) => event.id === approval.id);
  if (!sameCanonicalDecisionEvent(currentDecision, decision.payload, decision.evidence_refs)
    || !sameCanonicalOwnerGateEvent(currentProposal, canonicalOwnerGate({ decision: decision.payload, intent: intentForDecision(decision), evidenceRefs: decision.evidence_refs }).proposal, currentDecision)
    || !sameCanonicalOwnerGateEvent(currentRequest, canonicalOwnerGate({ decision: decision.payload, intent: intentForDecision(decision), evidenceRefs: decision.evidence_refs }).request, currentProposal)
    || !sameCanonicalApprovalEvent(currentApproval, { approvalId: approval.id, approvalPayload: approval.payload, decision: currentDecision, request: currentRequest })) {
    throw autonomyFailure("canonical_execution_chain_invalid", "approval.granted");
  }
  const attemptPayload = {
    approval_id: approval.id,
    decision_id: decision.id,
    contract_sha256: decision.payload.contract_sha256,
    contract: decision.payload.contract,
    execution_mode: decision.payload.execution_mode
  };
  const attemptId = `repair-execution-attempt-${decision.payload.decision_sha256.slice(0, 32)}`;
  const attempt = ledger.appendIfAbsent({
    id: attemptId,
    runId: run_id,
    incidentId: decision.incident_id,
    type: "repair.execution.attempted",
    actor: "authority-composition",
    payload: attemptPayload,
    evidenceRefs: decision.evidence_refs,
    parentId: approval.id,
    correlationId: decision.id
  });
  if (!attempt.inserted || !sameCanonicalExecutionAttempt(attempt.event, { attemptId, attemptPayload, decision, approval })) {
    throw autonomyFailure("execution_attempt_already_claimed", "repair.execution.attempted");
  }
  const result = await developmentAdapter.executeApprovedRollback({ commandId: decision.payload.contract.command_id });
  const change = development.changeFor(run_id);
  const executedPayload = {
    repair_id: change.repair_id,
    action: decision.payload.contract.action,
    target: decision.payload.contract.target,
    from: change.after,
    to: change.known_good,
    mode: "local-development",
    command_id: result.command_id,
    completed_at: result.completed_at,
    decision_id: decision.id,
    approval_id: approval.id,
    contract_sha256: decision.payload.contract_sha256
  };
  const executed = ledger.appendIfAbsent({
    id: `repair-executed-${decision.payload.decision_sha256.slice(0, 32)}`,
    runId: run_id,
    incidentId: decision.incident_id,
    type: "repair.executed",
    actor: "remediation",
    payload: executedPayload,
    evidenceRefs: decision.evidence_refs,
    parentId: attempt.id,
    correlationId: decision.id
  });
  if (!executed.inserted) throw autonomyFailure("repair_execution_record_conflict", "repair.executed");
  return result;
}

function intentForDecision(decision) {
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((candidate) => candidate.id === decision.payload?.intent_id);
  if (!intent) throw autonomyFailure("canonical_decision_intent_invalid", "autonomy.decision.recorded");
  return intent;
}

function atomicApprovalClaim({ approvalId, approvalPayload, decision, proposal, request, observedLockSequence, contract_sha256, target, lock_key }) {
  const parameters = sqliteParameters({
    approval_id: approvalId,
    approval_payload: JSON.stringify(approvalPayload),
    approval_correlation_id: decision.id,
    decision_id: decision.id,
    decision_payload: JSON.stringify(decision.payload),
    proposal_id: proposal.id,
    proposal_payload: JSON.stringify(proposal.payload),
    request_id: request.id,
    request_payload: JSON.stringify(request.payload),
    run_id: decision.run_id,
    incident_id: decision.incident_id,
    evidence_refs: JSON.stringify(decision.evidence_refs),
    observed_lock_sequence: String(observedLockSequence),
    contract_sha256,
    target,
    lock_key
  });
  const text = (name) => `CAST(@${name} AS TEXT)`;
  // Existing locks are fully decoded and integrity-checked before this
  // transaction. A row that arrives after that observation cannot safely be
  // validated with SQLite alone, so any defensive signal that it touches this
  // authority tuple blocks the claim. This preserves valid pre-existing
  // unrelated locks while making the TOCTOU window fail closed.
  const newlyObservedAuthorityLock = `l.type='autonomy.locked'
      AND l.sequence > CAST(@observed_lock_sequence AS INTEGER)
      AND (
        l.incident_id=${text("incident_id")}
        OR json_extract(l.payload_json,'$.incident_id')=${text("incident_id")}
        OR (json_extract(l.payload_json,'$.contract_sha256')=${text("contract_sha256")}
          AND json_extract(l.payload_json,'$.target')=${text("target")})
        OR json_extract(l.payload_json,'$.lock_key')=${text("lock_key")}
      )`;
  const script = `${parameters}
BEGIN IMMEDIATE;
INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
SELECT ${text("approval_id")}, ${text("run_id")}, ${text("incident_id")}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 'approval.granted', 'owner', ${text("approval_payload")}, ${text("evidence_refs")}, NULL, ${text("approval_correlation_id")}
WHERE EXISTS (SELECT 1 FROM events d WHERE d.id=${text("decision_id")} AND d.run_id=${text("run_id")} AND d.incident_id=${text("incident_id")} AND d.type='autonomy.decision.recorded' AND d.actor='authority-composition' AND d.parent_id IS NULL AND d.correlation_id=${text("decision_id")} AND d.offset_ms=0 AND d.payload_json=${text("decision_payload")} AND d.evidence_refs_json=${text("evidence_refs")})
  AND EXISTS (SELECT 1 FROM events p WHERE p.id=${text("proposal_id")} AND p.run_id=${text("run_id")} AND p.incident_id=${text("incident_id")} AND p.type='repair.proposed' AND p.actor='authority-composition' AND p.parent_id IS NULL AND p.correlation_id=${text("decision_id")} AND p.offset_ms=0 AND p.payload_json=${text("proposal_payload")} AND p.evidence_refs_json=${text("evidence_refs")})
  AND EXISTS (SELECT 1 FROM events r WHERE r.id=${text("request_id")} AND r.run_id=${text("run_id")} AND r.incident_id=${text("incident_id")} AND r.type='approval.requested' AND r.actor='authority-composition' AND r.parent_id=${text("proposal_id")} AND r.correlation_id=${text("decision_id")} AND r.offset_ms=0 AND r.payload_json=${text("request_payload")} AND r.evidence_refs_json=${text("evidence_refs")})
  AND (SELECT sequence FROM events WHERE id=${text("decision_id")}) < (SELECT sequence FROM events WHERE id=${text("proposal_id")})
  AND (SELECT sequence FROM events WHERE id=${text("proposal_id")}) < (SELECT sequence FROM events WHERE id=${text("request_id")})
  AND NOT EXISTS (SELECT 1 FROM events WHERE run_id=${text("run_id")} AND type='approval.granted')
  AND NOT EXISTS (SELECT 1 FROM events l WHERE ${newlyObservedAuthorityLock});
SELECT changes() AS approval_inserted;
INSERT OR ROLLBACK INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
SELECT ${text("decision_id")}, ${text("run_id")}, ${text("incident_id")}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 'approval.guard', 'authority-composition', '{}', '[]', NULL, ${text("decision_id")}
WHERE changes() = 1
  AND EXISTS (SELECT 1 FROM events l WHERE ${newlyObservedAuthorityLock});
COMMIT;
`;
  try {
    const output = ledger.exec(script).trim().split(/\s+/).filter(Boolean);
    return output[0] === "1";
  } catch {
    return false;
  }
}

function sqliteParameters(values) {
  return [".parameter init", ...Object.entries(values).map(([name, value]) => `.parameter set @${name} X'${Buffer.from(String(value), "utf8").toString("hex")}'`)].join("\n");
}

function assertAutonomySelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "incident_id,intent_id,run_id" || !boundedText(value.run_id, 160) || !boundedText(value.incident_id, 160) || !boundedText(value.intent_id, 120)) throw autonomyFailure("authority_selector_invalid", "selector");
}
function artifactBinding(intentId) {
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intentId);
  if (!intent) throw autonomyFailure("unknown_intent", "intent_id");
  return {
    schema_version: AUTONOMY_POLICY_ARTIFACT.schema_version,
    version: AUTONOMY_POLICY_ARTIFACT.version,
    registry_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT.registry),
    intent_sha256: sha256Canonical(intent),
    envelope_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT.registry.envelopes.filter((envelope) => envelope.action_contract.repair_id === intent.contract.repair_id)),
    artifact_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT)
  };
}
function stripManifest(manifest) { return { id: manifest.id, content_sha256: manifest.content_sha256, mode: manifest.mode, records: manifest.records, manifest_sha256: manifest.manifest_sha256 }; }
function authorityBinding(value) { return createHmac("sha256", authorityReceiptSecret).update(sha256Canonical(value), "utf8").digest("hex"); }
function safeEqual(left, right) { return typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function trustedNow() { return new Date().toISOString(); }
function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : null; }
function boundedText(value, bytes) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= bytes; }
function validLedgerEvent(event, incident_id, run_id) { return event && event.incident_id === incident_id && event.run_id === run_id && Number.isInteger(event.sequence) && event.sequence > 0 && boundedText(event.id, 200) && boundedText(event.recorded_at, 40) && validHash(event.payload_sha256) && Array.isArray(event.evidence_refs); }
function sameSet(left, right) { return Array.isArray(left) && Array.isArray(right) && new Set(left).size === left.length && new Set(right).size === right.length && left.length === right.length && [...left].every((item) => right.includes(item)); }
function sameOrderedRefs(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]); }
function sameCanonicalDecisionEvent(event, decision, evidenceRefs) {
  return Boolean(event && event.id === decision.decision_id && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "autonomy.decision.recorded" && event.actor === "authority-composition" && event.parent_id == null && event.correlation_id === decision.decision_id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, evidenceRefs) && sha256Canonical(event.payload) === sha256Canonical(decision));
}
function sameCanonicalOwnerGateEvent(event, candidate, parent) {
  return Boolean(event && event.id === candidate.id && event.run_id === candidate.runId && event.incident_id === candidate.incidentId && event.type === candidate.type && event.actor === candidate.actor && event.parent_id === (candidate.parentId || null) && event.correlation_id === candidate.correlationId && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, candidate.evidenceRefs) && sha256Canonical(event.payload) === sha256Canonical(candidate.payload) && Number.isInteger(parent?.sequence) && parent.sequence < event.sequence);
}
function sameCanonicalApprovalEvent(event, { approvalId, approvalPayload, decision, request }) {
  return Boolean(event && event.id === approvalId && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "approval.granted" && event.actor === "owner" && event.parent_id == null && event.correlation_id === decision.id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, decision.evidence_refs) && sha256Canonical(event.payload) === sha256Canonical(approvalPayload) && request.sequence < event.sequence);
}
function sameCanonicalExecutionAttempt(event, { attemptId, attemptPayload, decision, approval }) {
  return Boolean(event && event.id === attemptId && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "repair.execution.attempted" && event.actor === "authority-composition" && event.parent_id === approval.id && event.correlation_id === decision.id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, decision.evidence_refs) && sha256Canonical(event.payload) === sha256Canonical(attemptPayload));
}
function coreContractMatches(value, contract) {
  return Boolean(value && Object.keys(value).every((key) => ["repair_id", "action", "target", "command_id", "reason"].includes(key)) && ["repair_id", "action", "target", "command_id"].every((key) => value[key] === contract[key]) && (!Object.hasOwn(value, "reason") || boundedText(value.reason, 2_048)));
}
function exactFullContract(value, contract) {
  return Boolean(value && contract && ["repair_id", "action", "target", "command_id", "expected_before", "expected_after"].every((key) => value[key] === contract[key]));
}
function contractMatchesCapturedChange(contract, change) {
  return Boolean(change && contract.repair_id === change.repair_id && contract.target === change.target && contract.command_id === change.repair_command_id && contract.action === `restore known-good ${change.flag} flag and recreate checkout` && contract.expected_before === `${change.flag}=${change.after}` && contract.expected_after === `${change.flag}=${change.known_good}`);
}
function sameCanonicalEvaluation(eventPayload, gatePayload) {
  const keys = ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs"];
  if (!eventPayload || !gatePayload || Object.keys(gatePayload).sort().join(",") !== keys.sort().join(",")) return false;
  return sha256Canonical(Object.fromEntries(keys.map((key) => [key, eventPayload[key]]))) === sha256Canonical(gatePayload);
}
function isEmptyObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0); }
function approvalOwner(value) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && boundedText(value.owner, 160) ? value.owner : null; }
function runMode(runId) { return ledger.list(runId).find((event) => event.type === "run.started")?.payload?.mode || null; }
// The current browser selection is a run, not an ambient demo fixture. Once a
// local loop starts, an unpinned refresh must resolve to that exact run until
// reset; explicit query parameters are handled separately and never fall back.
function browserRunId() { return activeWorkspaceRunId || activeDemoRunId || runtime.ensureRun(); }
function initializeDemoRun() {
  const latest = ledger.latestRun(bundle.incident.id);
  if (!latest) return createHealthyDemoRun();
  return demoLifecycleFor(latest).ok ? latest : null;
}
function demoCorrelationId(runId) { return `demo:${runId}`; }
function demoLifecycleFor(runId) {
  if (!safeBrowserId(runId)) return { ok: false, code: "demo_run_invalid" };
  const events = ledger.list(runId);
  const start = events.find((event) => event.type === "run.started");
  const lifecycle = events.find((event) => event.type === "demo.lifecycle.started");
  if (!start || !lifecycle) return { ok: false, code: "demo_lifecycle_missing" };
  const correlationId = demoCorrelationId(runId);
  const validStart = start.actor === "demo-lifecycle" && start.parent_id === null && start.correlation_id === correlationId && start.payload?.mode === "replay" && start.payload?.schema_version === 1 && start.payload?.demo_lifecycle === "healthy" && start.payload?.scenario_id === DEMO_SCENARIO_ID;
  const validLifecycle = lifecycle.actor === "demo-lifecycle" && lifecycle.parent_id === start.id && lifecycle.correlation_id === correlationId && lifecycle.payload?.schema_version === DEMO_LIFECYCLE_SCHEMA_VERSION && lifecycle.payload?.scenario_id === DEMO_SCENARIO_ID && lifecycle.payload?.phase === "HEALTHY" && lifecycle.evidence_refs.length === 0 && start.sequence < lifecycle.sequence;
  if (!validStart || !validLifecycle) return { ok: false, code: "demo_lifecycle_invalid" };
  const injections = events.filter((event) => event.type === "demo.incident.injected");
  const extraDemoEvents = events.filter((event) => event.type.startsWith("demo.") && event.type !== "demo.lifecycle.started" && event.type !== "demo.incident.injected");
  if (extraDemoEvents.length || injections.length > 1) return { ok: false, code: "demo_lifecycle_invalid" };
  if (!injections.length) return { ok: true, value: demoLifecycleValue(runId, "HEALTHY"), injection: null };
  const injection = injections[0];
  const payload = injection.payload;
  const validInjection = injection.id === `demo-injection-${runId}` && injection.actor === "demo-lifecycle" && injection.parent_id === lifecycle.id && injection.correlation_id === correlationId && injection.sequence > lifecycle.sequence && sameOrderedRefs(injection.evidence_refs, DEMO_INJECTION_EVIDENCE_REFS) && plainDemoInjectionPayload(payload);
  if (!validInjection) return { ok: false, code: "demo_lifecycle_invalid" };
  return { ok: true, value: demoLifecycleValue(runId, "INCIDENT_DETECTED"), injection };
}
function demoLifecycleValue(runId, phase) {
  return {
    schema_version: DEMO_LIFECYCLE_SCHEMA_VERSION,
    run_id: runId,
    scenario_id: DEMO_SCENARIO_ID,
    phase,
    frames: DEMO_REPLAY_FRAMES.slice(0, phase === "HEALTHY" ? 1 : DEMO_REPLAY_FRAMES.length).map((frame) => ({ ...frame, node_ids: [...frame.node_ids], relation_ids: [...frame.relation_ids], evidence_refs: [...frame.evidence_refs] }))
  };
}
function plainDemoInjectionPayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === "idempotency_key,phase,projection_revision,scenario_id" && value.scenario_id === DEMO_SCENARIO_ID && value.phase === "INCIDENT_DETECTED" && validHash(value.projection_revision) && validDemoIdempotencyKey(value.idempotency_key));
}
function validDemoIdempotencyKey(value) { return typeof value === "string" && /^[a-z][a-z0-9-]{2,80}$/.test(value); }
function createHealthyDemoRun() {
  const runId = `run-${randomUUID()}`;
  const correlationId = demoCorrelationId(runId);
  const started = ledger.append({
    id: `demo-run-started-${runId}`,
    runId,
    incidentId: bundle.incident.id,
    type: "run.started",
    actor: "demo-lifecycle",
    payload: { mode: "replay", schema_version: 1, demo_lifecycle: "healthy", scenario_id: DEMO_SCENARIO_ID },
    evidenceRefs: [],
    correlationId
  });
  runtime.append(runId, "incident.opened", "runtime", {
    title: bundle.incident.title,
    severity: bundle.incident.severity,
    summary: bundle.incident.summary,
    environment: bundle.incident.environment
  });
  ledger.append({
    id: `demo-lifecycle-started-${runId}`,
    runId,
    incidentId: bundle.incident.id,
    type: "demo.lifecycle.started",
    actor: "demo-lifecycle",
    payload: { schema_version: DEMO_LIFECYCLE_SCHEMA_VERSION, scenario_id: DEMO_SCENARIO_ID, phase: "HEALTHY" },
    evidenceRefs: [],
    parentId: started.id,
    correlationId
  });
  return runId;
}
function injectDemoIncident({ runId, body, current }) {
  const lifecycle = demoLifecycleFor(runId);
  if (!lifecycle.ok || activeDemoRunId !== runId) return { ok: false, code: "demo_run_not_active" };
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "idempotency_key,projection_revision,run_id,scenario_id" || body.scenario_id !== DEMO_SCENARIO_ID || body.run_id !== runId || !validHash(body.projection_revision) || !validDemoIdempotencyKey(body.idempotency_key)) return { ok: false, code: "demo_injection_request_invalid" };
  if (lifecycle.value.phase === "INCIDENT_DETECTED") {
    const payload = lifecycle.injection?.payload;
    return payload?.idempotency_key === body.idempotency_key && payload?.projection_revision === body.projection_revision
      ? { ok: true, inserted: false }
      : { ok: false, code: "demo_incident_already_injected" };
  }
  if (current?.topology_views?.projection_revision !== body.projection_revision || current?.topology_views?.demo?.phase !== "HEALTHY") return { ok: false, code: "demo_injection_request_invalid" };
  const start = ledger.list(runId).find((event) => event.type === "demo.lifecycle.started");
  const appended = ledger.appendIfAbsent({
    id: `demo-injection-${runId}`,
    runId,
    incidentId: bundle.incident.id,
    type: "demo.incident.injected",
    actor: "demo-lifecycle",
    payload: { scenario_id: DEMO_SCENARIO_ID, phase: "INCIDENT_DETECTED", projection_revision: body.projection_revision, idempotency_key: body.idempotency_key },
    evidenceRefs: DEMO_INJECTION_EVIDENCE_REFS,
    parentId: start?.id || null,
    correlationId: demoCorrelationId(runId)
  });
  if (appended.inserted) return { ok: true, inserted: true };
  const fresh = demoLifecycleFor(runId);
  return fresh.ok && fresh.injection?.payload?.idempotency_key === body.idempotency_key && fresh.injection?.payload?.projection_revision === body.projection_revision
    ? { ok: true, inserted: false }
    : { ok: false, code: "demo_injection_conflict" };
}
function activeDemoWriteBlocked(method, pathname) {
  if (!activeDemoRunId || !["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
  return !(method === "POST" && (pathname === "/api/demo/inject" || pathname === "/api/demo/reset" || pathname === "/api/demo/agent-loop/run" || pathname === "/api/agent-control/chat"));
}
function plainLocalFaultLoopRequest(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && ["case_id,round", "case_id,idempotency_key,round"].includes(Object.keys(value).sort().join(","))
    && typeof value.case_id === "string" && /^[a-z][a-z0-9-]{2,79}$/.test(value.case_id)
    && Number.isInteger(value.round) && value.round >= 1 && value.round <= 3
    && (value.idempotency_key === undefined || (typeof value.idempotency_key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value.idempotency_key))));
}
function autonomyFailure(code, field_path) { const error = new InsufficientEvidenceError("Autonomy authority boundary rejected the run"); error.code = code; error.metadata = { stage: "authority_decision", validator_id: "server_authority_closure", reason_code: code, field_path, next_precondition: "produce_a_matching_frozen_diagnosis_gate" }; return error; }

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, "");
  const path = join(publicDir, safe);
  if (!path.startsWith(publicDir)) return json(response, 404, { error: "Not found" });
  try {
    const body = await readFile(path);
    response.writeHead(200, { "content-type": mime(extname(path)), "cache-control": "no-store" });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function requireJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("application/json is required for local development actions");
  }
}

function localFaultLoopLeaseMs() {
  const value = Number(process.env.FLOWPULSE_AGENT_LOOP_LEASE_MS || 180_000);
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 180_000;
}

function setHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:");
}

function json(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function cachedDevelopmentStatus() {
  const now = Date.now();
  if (developmentStatusCache.value && developmentStatusCache.expiresAt > now) return { value: developmentStatusCache.value, cache: "hit" };
  if (developmentStatusCache.pending) return { value: await developmentStatusCache.pending, cache: "coalesced" };
  const pending = developmentAdapter.developmentStatus();
  developmentStatusCache.pending = pending;
  try {
    const value = await pending;
    developmentStatusCache = { value, expiresAt: Date.now() + DEVELOPMENT_STATUS_CACHE_TTL_MS, pending: null };
    return { value, cache: "miss" };
  } finally {
    if (developmentStatusCache.pending === pending) developmentStatusCache.pending = null;
  }
}

function invalidateDevelopmentStatusCache() {
  developmentStatusCache = { value: null, expiresAt: 0, pending: null };
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function mime(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[extension] || "application/octet-stream";
}

async function stateWithSource(runId = runtime.ensureRun(), { cursor = null } = {}) {
  const preflight = projectionLedgerPreflight(runId);
  if (!preflight.ok) return nonActionableBrowserState(runId, preflight.code);
  const projected = runtime.state(runId);
  const demoLifecycle = demoLifecycleFor(runId);
  if (activeDemoRunId === runId && !demoLifecycle.ok) return nonActionableBrowserState(runId, demoLifecycle.code);
  const referenced = new Set(projected.events.flatMap((event) => event.evidence_refs));
  const source = await selectedEvidenceSource(runId, projected.mode);
  const evidence = source.summariesById(referenced);
  const sourceState = await sourceProjection(runId, source);
  const authority_chain = projectionAuthorityChain({ runId, projected, evidenceById: new Map(evidence.map((record) => [record.id, record])) });
  const incident_projection = buildIncidentProjection({
    // Topology is source evidence, not runtime authority. Bind the selected,
    // read-only source topology into the bounded projection before browser
    // redaction so replay never falls back to unrelated collector state.
    run: { ...projected, topology: sourceState.topology },
    events: projected.events,
    evidence,
    source: sourceState,
    cursor,
    authority_chain
  });
  const topology_views = composeTopologyViews({
    manifest: topologyManifest,
    incidentProjection: incident_projection,
    overlay: incidentTopologyOverlay,
    controls: topologyControlInputs(projected, sourceState),
    demoLifecycle: demoLifecycle.ok ? demoLifecycle.value : null
  });
  // An explicit request is authoritative.  The ambient browser workspace is
  // only safe to expose when it is the very same selected run; otherwise a
  // previous tab's local loop would splice its repair/verification state into
  // an unrelated captured or live run.
  const selectedWorkspace = activeWorkspaceRunId === runId ? localFaultLoopProjection(runId) : null;
  const state = {
    schema_version: "flowpulse.browser-state.v1",
    run_id: incident_projection.run_id || safeBrowserId(projected.run_id),
    mode: safeBrowserEnum(projected.mode, ["replay", "live", "development"], "unavailable"),
    status: safeBrowserText(projected.status || incident_projection.stage_status, 80),
    complete: projected.complete === true,
    waiting_for_approval: incident_projection.human_gate?.status === "requested" || projected.waiting_for_approval === true,
    incident: incident_projection.incident,
    events: projected.events.slice(-INCIDENT_PROJECTION_LIMITS.max_frames).map(redactedLedgerEvent),
    evidence: incident_projection.evidence,
    source: redactedSource(sourceState, incident_projection, topology_views),
    topology_views,
    incident_projection,
    workspace_projection: selectedWorkspace ? compactBrowserWorkspaceProjection(selectedWorkspace) : null,
    agent_control: {
      ...agentControl.project(runId, { incidentProjection: incident_projection, state: projected }),
      agent_team_provider: agentTeamChat.providerCapability()
    },
    harness: redactedHarness(harnessProjection(projected.events))
  };
  return enforceBrowserResponseCap(state);
}

// A browser deep link is an explicit, immutable run selection. It must never
// silently fall back to the newest workspace run, otherwise one tab can show a
// recovered checkout loop while another shows an unrelated human-gated loop.
async function browserStateForRun(runId, { cursor = null } = {}) {
  if (!safeBrowserId(runId)) {
    const error = new Error("browser_state_run_unavailable");
    error.code = "browser_state_run_unavailable";
    throw error;
  }
  // Local-loop detection reads the complete run from the ledger. Refuse an
  // oversized run before that lookup so a browser read cannot materialize an
  // unbounded payload merely to decide whether it is a local loop.
  const preflight = projectionLedgerPreflight(runId);
  if (!preflight.ok) return nonActionableBrowserState(runId, preflight.code);
  const loop = localFaultLoopProjection(runId);
  if (loop) return localLoopBrowserState(loop, { cursor });
  if (runId !== browserRunId() && !knownNodeRun(runId)) {
    const error = new Error("browser_state_run_unavailable");
    error.code = "browser_state_run_unavailable";
    throw error;
  }
  return stateWithSource(runId, { cursor });
}

function projectionLedgerPreflight(runId) {
  if (!safeBrowserId(runId)) return { ok: false, code: "projection_ledger_preflight_invalid" };
  try {
    const quoted = `'${runId.replaceAll("'", "''")}'`;
    const row = ledger.query(`SELECT count(*) AS event_count, COALESCE(sum(length(CAST(id AS BLOB)) + length(CAST(run_id AS BLOB)) + length(CAST(incident_id AS BLOB)) + length(CAST(recorded_at AS BLOB)) + length(CAST(type AS BLOB)) + length(CAST(actor AS BLOB)) + length(CAST(payload_json AS BLOB)) + length(CAST(evidence_refs_json AS BLOB)) + length(CAST(COALESCE(parent_id,'') AS BLOB)) + length(CAST(correlation_id AS BLOB))), 0) AS serialized_bytes FROM events WHERE run_id=${quoted};`)[0] || {};
    const count = Number(row.event_count);
    const bytes = Number(row.serialized_bytes);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(bytes) || count < 0 || bytes < 0) return { ok: false, code: "projection_ledger_preflight_invalid" };
    if (count > INCIDENT_PROJECTION_LIMITS.max_input_events || bytes > PROJECTION_LEDGER_MAX_BYTES) return { ok: false, code: "projection_ledger_preflight_exceeded" };
    return { ok: true };
  } catch {
    return { ok: false, code: "projection_ledger_preflight_unavailable" };
  }
}

function nonActionableBrowserState(runId, code) {
  const incident_projection = buildIncidentProjection({});
  incident_projection.why_stopped = { code: safeBrowserText(code, 120), detail_status: "recorded" };
  const agent_control = {
    schema_version: "flowpulse.agent_control.v1", run_id: safeBrowserId(runId), incident_id: null,
    authority: "append-only-ledger", streaming: "ledger-derived-sse", langfuse: langfuseEnabled ? "observing" : "not_configured",
    current_agent_id: null, last_event_id: null, last_sequence: 0,
    report: { title: "Unavailable incident projection", summary: safeBrowserText(code, 120), stage: "Monitor", confidence: null, root_cause: null, rejected_diagnosis: null, repair: null, verification: null, regression: null, backtest: null, citations: [], human_gate: null, data_mode: null },
    actions: [], work_items: [], graph: { nodes: [], edges: [] }, activity: [], orchestration: { mode: "ledger-governed-agent-team-harness", proposal_count: 0, proposals: [], last_step: null }, incident_projection
  };
  return {
    schema_version: "flowpulse.browser-state.v1", run_id: safeBrowserId(runId), mode: "unavailable", status: "non_actionable", complete: false, waiting_for_approval: false,
    incident: incident_projection.incident, events: [], evidence: [], source: redactedSource({}, incident_projection), topology_views: null, incident_projection, agent_control,
    harness: { manifest: { legacy_detail_status: "legacy_detail_unavailable" }, current_stage: "unavailable", attempt: null, last_context_sha256: null, failure: { legacy_detail_status: "legacy_detail_unavailable", boundary: "unavailable", validator_id: "unavailable", reason_code: safeBrowserText(code, 120), tool_coverage: [], missing_evidence_classes: [], next_precondition: "unavailable" } }
  };
}

// This read-only verifier deliberately stays in the server composition root so
// the module-private freshness binding remains unavailable to HTTP, fixtures,
// model output, and browser code. A restart that cannot re-establish the
// binding projects non-actionable rather than trusting historical shapes.
function projectionAuthorityChain({ runId, projected, evidenceById }) {
  const events = projected.events;
  const decisions = events.filter((event) => event.type === "autonomy.decision.recorded");
  if (!decisions.length) return { schema_version: "flowpulse.projection-authority.v1", status: "legacy", reason: "legacy_detail_unavailable" };
  if (decisions.length !== 1 || projected.mode !== "development") return projectionAuthorityInvalid("decision_count_or_mode_invalid");
  try {
    const decision = decisions[0];
    const intent = intentForDecision(decision);
    const manifest = captureAuthoritySnapshot({ run_id: runId, incident_id: decision.incident_id, intent_id: intent.id });
    const now = trustedNow();
    const validated = validateAuthorityPrerequisites({ events, manifest, intent, now, incident_id: decision.incident_id, run_id: runId });
    const receipt_sha256 = decision.payload?.receipt_sha256;
    const binding = authorityReceiptBindings.get(receipt_sha256);
    const expectedBinding = authorityBinding({ run_id: decision.run_id, incident_id: decision.incident_id, intent_id: intent.id, manifest: stripManifest(manifest), validated, artifact: artifactBinding(intent.id), receipt_sha256 });
    if (!validHash(receipt_sha256) || !safeEqual(binding, expectedBinding)) throw autonomyFailure("projection_receipt_binding_invalid", "receipt_sha256");
    const locks = readAuthorityLocks({ incident_id: decision.incident_id, run_id: runId, contract_sha256: validated.contract_sha256, target: intent.contract.target });
    const expectedDecision = buildAuthorityDecision({ run_id: runId, incident_id: decision.incident_id, intent, manifest, validated, receipt: { receipt_sha256 }, locks });
    if (expectedDecision.outcome !== "human_review_required" || !sameCanonicalDecisionEvent(decision, expectedDecision, validated.evidence_refs)) throw autonomyFailure("projection_decision_invalid", "autonomy.decision.recorded");
    const ownerGate = canonicalOwnerGate({ decision: expectedDecision, intent, evidenceRefs: validated.evidence_refs });
    const proposal = exactlyOne(events, "repair.proposed");
    const request = exactlyOne(events, "approval.requested");
    if (!proposal || !request || !sameCanonicalOwnerGateEvent(proposal, ownerGate.proposal, decision) || !sameCanonicalOwnerGateEvent(request, ownerGate.request, proposal) || !(decision.sequence < proposal.sequence && proposal.sequence < request.sequence)) throw autonomyFailure("projection_owner_gate_invalid", "approval.requested");
    const approval = optionalOne(events, "approval.granted");
    const attempt = optionalOne(events, "repair.execution.attempted");
    const execution = optionalOne(events, "repair.executed");
    const verification = optionalOne(events, "verification.completed");
    const chain = {
      schema_version: "flowpulse.projection-authority.v1", status: "canonical",
      decision: projectionEventIdentity(decision), proposal: projectionEventIdentity(proposal), request: projectionEventIdentity(request),
      approval: approval ? projectionEventIdentity(approval) : null, attempt: attempt ? projectionEventIdentity(attempt) : null,
      execution: execution ? projectionEventIdentity(execution) : null, verification: verification ? projectionEventIdentity(verification) : null
    };
    const strict = validateProjectionCanonicalChain({
      events,
      chain,
      axes: { source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: "real_local_development" },
      evidence: evidenceById
    });
    if (strict.status !== "canonical") throw autonomyFailure(strict.reason || "projection_canonical_schema_invalid", "projection_authority_chain");
    return chain;
  } catch (error) {
    return projectionAuthorityInvalid(error?.code || "authority_chain_invalid");
  }
}

function projectionAuthorityInvalid(reason) { return { schema_version: "flowpulse.projection-authority.v1", status: "invalid", reason: safeBrowserText(reason, 120) }; }
function exactlyOne(events, type) { const matches = events.filter((event) => event.type === type); return matches.length === 1 ? matches[0] : null; }
function optionalOne(events, type) { const matches = events.filter((event) => event.type === type); if (matches.length > 1) throw autonomyFailure("projection_event_count_invalid", type); return matches[0] || null; }
function projectionEventIdentity(event) { return { event_id: event.id, sequence: event.sequence, payload_sha256: event.payload_sha256 }; }

function redactedLedgerEvent(event) {
  return {
    id: safeBrowserId(event.id), sequence: Number.isSafeInteger(event.sequence) ? event.sequence : 0,
    run_id: safeBrowserId(event.run_id), incident_id: safeBrowserId(event.incident_id), at: safeBrowserText(event.recorded_at, 40),
    type: safeBrowserText(event.type, 120), actor: safeBrowserText(event.actor, 80), evidence_refs: Array.isArray(event.evidence_refs) ? event.evidence_refs.filter(safeBrowserId).slice(0, 32) : [],
    payload: redactedEventPayload(event)
  };
}

function redactedEventPayload(event) {
  const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
  const copy = (keys) => Object.fromEntries(keys.filter((key) => typeof payload[key] === "string").map((key) => [key, safeBrowserText(payload[key], 240)]));
  switch (event?.type) {
    case "run.started": return copy(["mode"]);
    case "incident.opened": return copy(["title", "severity", "environment"]);
    case "evidence.queried":
    case "tool.called": return { ...copy(["tool"]), ...(Number.isSafeInteger(payload.result_count) && payload.result_count >= 0 ? { result_count: Math.min(payload.result_count, 10_000) } : {}) };
    case "hypothesis.proposed":
    case "diagnosis.proposed": return { ...copy(["id", "title"]), ...(Number.isFinite(payload.confidence) ? { confidence: Math.max(0, Math.min(1, payload.confidence)) } : {}) };
    case "evaluation.accepted": return { ...copy(["hypothesis_id", "classification", "phase"]), ...(Number.isFinite(payload.score) ? { score: Math.max(0, Math.min(1, payload.score)) } : {}) };
    case "evaluation.rejected": return { ...copy(["hypothesis_id"]), ...(Number.isFinite(payload.score) ? { score: Math.max(0, Math.min(1, payload.score)) } : {}) };
    case "autonomy.decision.recorded": return copy(["intent_id", "outcome", "reason_code", "contract_sha256"]);
    case "repair.proposed":
    case "approval.requested": return copy(["repair_id", "action", "target", "decision_id", "contract_sha256"]);
    case "approval.granted": return copy(["decision_id", "contract_sha256"]);
    case "repair.execution.attempted": return copy(["decision_id", "approval_id", "contract_sha256", "execution_mode"]);
    case "repair.executed": return copy(["repair_id", "target", "from", "to", "mode", "command_id", "decision_id", "approval_id", "contract_sha256", "completed_at"]);
    case "verification.completed": return {
      ...copy(["source_status", "decision_id", "execution_id", "contract_sha256"]),
      ...(payload.passed === true || payload.passed === false ? { passed: payload.passed } : {}),
      checks: Array.isArray(payload.checks) ? payload.checks.slice(0, 3).map((check) => ({ id: safeBrowserText(check?.id || "check", 120), metric: safeBrowserText(check?.metric || "metric", 120), passed: check?.passed === true })) : []
    };
    case "outcome.classified": return copy(["classification"]);
    default: return {};
  }
}

function redactedSource(source, projection = null, topologyViews = null) {
  const graph = projection?.graph || { nodes: [], edges: [] };
  return {
    mode: safeBrowserText(source?.mode || "unavailable", 80), status: safeBrowserEnum(source?.status, ["captured", "frozen", "live", "stale", "disconnected", "connecting", "unavailable"], "unavailable"),
    label: safeBrowserText(source?.label || "FlowPulse evidence source", 160), raw_records_excluded: true,
    topology_scope: projection ? "incident_overlay_compatibility" : "unavailable",
    topology: { services: graph.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind })), dependencies: graph.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind })) },
    topology_views: topologyViews,
    evidence: projection?.evidence || [],
    counts: safeCounts(source?.counts)
  };
}
function redactedEvidencePage(page) {
  const items = Array.isArray(page?.items) ? page.items.slice(0, INCIDENT_PROJECTION_LIMITS.max_evidence_summaries).map(redactedEvidenceDetail) : [];
  return {
    items,
    next_cursor: safeBrowserId(page?.next_cursor),
    truncated: page?.truncated === true,
    limits: { records: items.length, bytes: Math.min(Number(page?.limits?.bytes) || 0, 48 * 1024) },
    total_matching: Math.min(Math.max(Number(page?.total_matching) || 0, 0), INCIDENT_PROJECTION_LIMITS.max_input_evidence)
  };
}
function redactedEvidenceDetail(record) {
  const recordHash = record?.hash || record?.provenance?.sha256 || null;
  return {
    id: safeBrowserId(record?.id),
    kind: safeBrowserText(record?.kind || "unknown", 80),
    signal: safeBrowserText(record?.signal || "unknown", 80),
    title: safeBrowserText(record?.title || "Evidence", 180),
    entity: safeBrowserText(record?.entity || "unknown", 120),
    source: safeBrowserText(record?.source || "unknown", 160),
    observed_at: safeBrowserText(record?.at || record?.observed_at || "unknown", 40),
    captured_at: safeBrowserText(record?.captured_at || "unknown", 40),
    record_sha256: safeBrowserHash(recordHash),
    provenance: { status: safeBrowserHash(recordHash) ? "record_bound" : "legacy_detail_unavailable", sha256: safeBrowserHash(recordHash) },
    raw_payload_excluded: true
  };
}
function safeCounts(value) { const result = {}; if (!value || typeof value !== "object" || Array.isArray(value)) return result; for (const [key, count] of Object.entries(value).slice(0, 16)) if (/^[a-z_]+$/i.test(key) && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000) result[key] = count; return result; }
function redactedHarness(value) { return { manifest: value?.manifest?.sha256 ? { version: safeBrowserText(value.manifest.version, 80), sha256: safeBrowserHash(value.manifest.sha256) } : { legacy_detail_status: "legacy_detail_unavailable" }, current_stage: safeBrowserText(value?.current_stage || "unavailable", 120), attempt: Number.isSafeInteger(value?.attempt) ? value.attempt : null, last_context_sha256: safeBrowserHash(value?.last_context_sha256), failure: { legacy_detail_status: safeBrowserText(value?.failure?.legacy_detail_status || "legacy_detail_unavailable", 80), boundary: safeBrowserText(value?.failure?.boundary || "unavailable", 120), validator_id: safeBrowserText(value?.failure?.validator_id || "unavailable", 160), reason_code: safeBrowserText(value?.failure?.reason_code || "unavailable", 160), tool_coverage: Array.isArray(value?.failure?.tool_coverage) ? value.failure.tool_coverage.slice(0, 24).map((item) => safeBrowserText(String(item), 160)) : [], missing_evidence_classes: Array.isArray(value?.failure?.missing_evidence_classes) ? value.failure.missing_evidence_classes.slice(0, 8).map((item) => safeBrowserText(String(item), 120)) : [], next_precondition: safeBrowserText(value?.failure?.next_precondition || "unavailable", 160) } }; }
function enforceBrowserResponseCap(value) { if (Buffer.byteLength(JSON.stringify(value), "utf8") <= BROWSER_RESPONSE_MAX_BYTES) return value; const reduced = { ...value, events: [], evidence: [], source: { ...value.source, topology: { services: [], dependencies: [] }, evidence: [] }, agent_control: { ...value.agent_control, activity: [], graph: { nodes: [], edges: [] } } }; if (Buffer.byteLength(JSON.stringify(reduced), "utf8") <= BROWSER_RESPONSE_MAX_BYTES) return reduced; return { schema_version: "flowpulse.browser-state.v1", run_id: null, mode: "unavailable", status: "non_actionable", complete: false, waiting_for_approval: false, incident: reduced.incident_projection.incident, events: [], evidence: [], source: redactedSource({}, reduced.incident_projection), topology_views: null, incident_projection: reduced.incident_projection, agent_control: { schema_version: "flowpulse.agent_control.v1", authority: "append-only-ledger", actions: [], activity: [], graph: { nodes: [], edges: [] }, incident_projection: reduced.incident_projection }, harness: { manifest: { legacy_detail_status: "legacy_detail_unavailable" } } }; }
function safeBrowserText(value, limit = 160) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>&"']/g, " ").slice(0, limit) : "unknown"; }
function safeBrowserId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : null; }
function safeBrowserHash(value) { return validHash(value) ? value : null; }
function safeBrowserEnum(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }

async function selectedEvidenceSource(runId = runtime.ensureRun(), knownMode = null) {
  if (localFaultLoopProjection(runId)) return capturedEvidence;
  if (snapshots.has(runId)) return snapshots.get(runId);
  const mode = knownMode || runMode(runId);
  if (mode === "replay") return capturedEvidence;
  return new LiveOtlpEvidenceSource(await liveSource.project());
}

async function sourceProjection(runId = runtime.ensureRun(), source = null) {
  const selected = source || await selectedEvidenceSource(runId);
  const metadata = selected.metadata();
  // A captured/local-loop selection is immutable evidence. Reading the live
  // collector here would silently splice a different runtime into the selected
  // run. Only a live evidence source is allowed to query the collector.
  const project = metadata?.status === "live" ? await liveSource.project() : null;
  // Replay must project the selected captured bundle, not an unrelated current
  // collector window. The projection remains read-only and deliberately carries
  // no policy, approval, or execution material.
  const topology = typeof selected.topology === "function" ? selected.topology() : project?.topology;
  return {
    ...metadata,
    kind: "otlp-jsonl",
    live_status: project?.status || "unavailable",
    last_observed_at: project?.last_observed_at || null,
    freshness_ms: project?.freshness_ms ?? null,
    counts: project?.counts || metadata?.counts || {},
    topology,
    errors: project?.errors || [],
    evidence: selected.list({ limit: 50 }).items,
    raw_records_excluded: true
  };
}

async function nodeInvestigationPlaneForRun(runId, state = null) {
  const loop = localFaultLoopProjection(runId);
  const current = state || await nodeStateForRun(runId);
  if (!current?.topology_views) throw new NodeInvestigationError("component_detail_unavailable", 409);
  const source = loop ? capturedEvidence : await selectedEvidenceSource(runId, current.mode);
  return new NodeInvestigationPlane({
    topologyViews: current.topology_views,
    source,
    sourceState: await sourceProjection(runId, source),
    incidentProjection: current.incident_projection
  });
}

function knownNodeRun(runId) {
  return safeBrowserId(runId) !== null && (Boolean(localFaultLoopProjection(runId)) || ledger.list(runId).some((event) => event.type === "run.started" && event.incident_id === runtime.bundle.incident.id));
}

function knownAgentRun(runId) {
  return knownNodeRun(runId);
}

async function nodeStateForRun(runId) {
  const loop = localFaultLoopProjection(runId);
  return loop ? localLoopBrowserState(loop) : stateWithSource(runId);
}

async function localLoopBrowserState(loop, { cursor = null } = {}) {
  const projected = localLoopRuntimeState(loop);
  const evidence = localLoopEvidence(loop);
  const source = await selectedEvidenceSource(loop.run_id, projected.mode);
  const sourceState = await sourceProjection(loop.run_id, source);
  const incidentProjection = localLoopIncidentProjection(loop, { cursor, evidence, sourceTruth: topologySourceTruth() });
  // The static overlay schema is keyed to its captured fixture incident. It
  // is a presentation scaffold only; stateWithLocalLoopTopology immediately
  // binds the emitted view identity and runtime graph to this local loop.
  const viewIncidentProjection = {
    ...incidentProjection,
    incident: { ...incidentProjection.incident, id: incidentTopologyOverlay.incident_id }
  };
  const topologyViews = composeTopologyViews({
    manifest: topologyManifest,
    incidentProjection: viewIncidentProjection,
    overlay: incidentTopologyOverlay,
    controls: topologyControlInputs(projected, sourceState),
    demoLifecycle: null
  });
  const state = {
    schema_version: "flowpulse.browser-state.v1",
    run_id: loop.run_id,
    mode: projected.mode,
    status: projected.status,
    complete: projected.complete,
    waiting_for_approval: projected.waiting_for_approval,
    incident: incidentProjection.incident,
    events: projected.events.slice(-INCIDENT_PROJECTION_LIMITS.max_frames).map(redactedLedgerEvent),
    evidence: incidentProjection.evidence,
    source: redactedSource(sourceState, incidentProjection, topologyViews),
    topology_views: topologyViews,
    incident_projection: incidentProjection,
    workspace_projection: compactBrowserWorkspaceProjection(loop),
    agent_control: {
      ...agentControl.project(loop.run_id, { incidentProjection, state: projected }),
      agent_team_provider: agentTeamChat.providerCapability()
    },
    harness: redactedHarness(harnessProjection(projected.events))
  };
  return enforceBrowserResponseCap(stateWithLocalLoopTopology(state, loop));
}

function localLoopRuntimeState(loop) {
  const terminal = ["recovered", "needs_human", "failed"].includes(loop.state);
  return {
    run_id: loop.run_id,
    mode: "replay",
    status: loop.state,
    complete: terminal,
    waiting_for_approval: loop.state === "needs_human",
    incident: { id: loop.incident_id, title: loop.case_id === "insufficient-evidence" ? "Evidence gap" : "Checkout / payment incident", severity: loop.case_id === "insufficient-evidence" ? "unknown" : "SEV-2", environment: "isolated local fixture" },
    events: (loop.events || []).map((event) => ({ ...event, run_id: loop.run_id, incident_id: loop.incident_id }))
  };
}

function localLoopEvidence(loop) {
  const records = new Map();
  for (const event of loop.events || []) {
    if (event.type !== "local_fault_loop.evidence.recorded") continue;
    const record = event.payload;
    if (!safeBrowserId(record?.id) || records.has(record.id)) continue;
    records.set(record.id, {
      id: record.id,
      kind: safeBrowserText(record.kind || "evidence", 80),
      source: "local fixture simulator",
      entity: safeBrowserText(record.entity || "unknown", 120),
      title: safeBrowserText(record.summary || "Local evidence", 180),
      at: safeBrowserText(record.observed_at || event.recorded_at, 40),
      hash: safeBrowserHash(record.record_sha256)
    });
  }
  return [...records.values()];
}

function stateWithLocalLoopTopology(state, loop) {
  const topology = loop?.topology;
  if (!topology?.graph?.nodes?.length || !topology?.graph?.edges?.length || typeof topology.projection_revision !== "string") return state;
  const views = structuredClone(state.topology_views);
  const graph = topologyViewGraph(topology.graph);
  // A stored captured demo lifecycle is scoped to the source run that produced
  // it.  A local loop owns a different canonical run, so retaining that stale
  // lifecycle makes the strict v2 view parser reject every workspace.  `null`
  // explicitly means no captured lifecycle is projected for this run.
  views.demo = null;
  for (const scope of [views.architecture, views.live, views.diagnose]) {
    if (!scope?.runtime_data) continue;
    scope.runtime_data.graph = structuredClone(graph);
    scope.runtime_data.node_count = graph.total_nodes;
    scope.runtime_data.edge_count = graph.total_edges;
  }
  views.run_id = loop.run_id;
  views.incident_id = loop.incident_id;
  views.projection_revision = topology.projection_revision;
  return {
    ...state,
    run_id: loop.run_id,
    incident: { ...state.incident, id: loop.incident_id },
    topology_views: views,
    // Keep this exact local-fault-loop source available to every UI workspace,
    // even when a newer loop is globally active in another tab.
    workspace_projection: compactBrowserWorkspaceProjection(loop)
  };
}

function topologyViewGraph(graph) {
  const planeOrder = { runtime: 0, data: 1, control: 2, evidence: 3 };
  const layerOrder = { experience: 0, commerce: 1, processing: 2, platform: 3, observation: 4, orchestration: 5, investigation: 6, evaluation: 7, evidence: 8 };
  return {
    ...structuredClone(graph),
    nodes: [...graph.nodes].map((node) => ({ ...node })).sort((left, right) =>
      planeOrder[left.plane] - planeOrder[right.plane]
      || layerOrder[left.layer] - layerOrder[right.layer]
      || left.id.localeCompare(right.id)),
    edges: [...graph.edges].map((edge) => ({ ...edge })).sort((left, right) =>
      planeOrder[left.plane] - planeOrder[right.plane]
      || left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to)
      || left.kind.localeCompare(right.kind)
      || left.id.localeCompare(right.id))
  };
}

function localFaultLoopProjection(runId) {
  if (!localFaultLoop || !safeBrowserId(runId)) return null;
  try {
    return localFaultLoop.project(runId);
  } catch (error) {
    if (error instanceof LocalFaultLoopError) return null;
    throw error;
  }
}

function compactBrowserWorkspaceProjection(loop) {
  if (!loop?.topology || !Array.isArray(loop.events)) return null;
  return {
    ...loop,
    events: loop.events.map((event) => ({
      ...event,
      topology: null,
      contextual_workspaces: loop.contextual_workspaces
    }))
  };
}

function agentTeamStateForRun(runId) {
  const loop = localFaultLoopProjection(runId);
  if (!loop) return runtime.state(runId);
  return {
    run_id: loop.run_id,
    incident: { id: loop.incident_id },
    stage: loop.stage,
    status: loop.state,
    waiting_for_approval: loop.state === "needs_human",
    complete: ["recovered", "needs_human", "failed"].includes(loop.state),
    events: loop.events,
    topology: loop.topology?.graph || { nodes: [], edges: [] }
  };
}

function topologySourceTruth() {
  return {
    source_health: topologyManifest.source_health,
    evidence_mode: topologyManifest.evidence_mode,
    execution_mode: topologyManifest.execution_mode
  };
}

function localLoopIncidentProjection(loop, { cursor = null, evidence = localLoopEvidence(loop), sourceTruth = topologySourceTruth() } = {}) {
  const definition = loop.case_id === "insufficient-evidence" ? "Evidence gap" : "Checkout / payment incident";
  const latest = (type) => [...(loop.events || [])].reverse().find((event) => event.type === type) || null;
  const plan = latest("local_fault_loop.plan.proposed");
  const authority = latest("local_fault_loop.authority.decided");
  const repair = latest("local_fault_loop.repair.executed");
  const verification = latest("local_fault_loop.verification.completed");
  const accepted = latest("local_fault_loop.evaluation.accepted");
  const rejected = latest("local_fault_loop.evaluation.rejected");
  const stage = localLoopProjectionStage(loop);
  const graph = topologyViewGraph(loop.topology?.graph || { nodes: [], edges: [] });
  const cited = [...new Set((loop.events || []).flatMap((event) => event.evidence_refs || []))].filter(safeBrowserId);
  return {
    schema_version: "flowpulse.incident-projection.v1",
    projection_revision: safeBrowserHash(loop.topology?.projection_revision),
    run_id: loop.run_id,
    incident: {
      id: loop.incident_id,
      title: definition,
      severity: loop.case_id === "insufficient-evidence" ? "unknown" : "SEV-2",
      environment: "isolated local fixture"
    },
    stage: stage.value,
    stage_status: stage.status,
    source_health: sourceTruth.source_health,
    evidence_mode: sourceTruth.evidence_mode,
    execution_mode: sourceTruth.execution_mode,
    graph,
    timeline: { frames: (loop.events || []).slice(-INCIDENT_PROJECTION_LIMITS.max_frames).map((event) => ({ event_id: event.id, sequence: event.sequence, type: event.type, recorded_at: event.recorded_at, evidence_refs: [...(event.evidence_refs || [])] })), total_frames: (loop.events || []).length, cursor },
    evidence: evidence.map((record) => ({ id: record.id, kind: record.kind, title: record.title, entity: record.entity, source: record.source, observed_at: record.at, provenance: { status: record.hash ? "record_bound" : "legacy_detail_unavailable", sha256: record.hash } })),
    investigation: { hypotheses: [], counter_evidence: rejected ? { hypothesis_id: rejected.payload?.hypothesis_id || rejected.id, evidence_refs: [...rejected.evidence_refs] } : null, evaluator: { verdict: accepted ? "accepted" : rejected ? "rejected" : "pending", evidence_refs: [...(accepted?.evidence_refs || rejected?.evidence_refs || [])] }, diagnosis_gate: { status: accepted ? "passed" : "pending", event_id: accepted?.id || null, evidence_refs: [...(accepted?.evidence_refs || [])] }, replan: { status: "not_recorded", event_id: null } },
    decision: { status: authority ? "auto_execute_pre_authorized" : "not_recorded", decision_id: authority?.id || null, risk_tier: plan?.payload?.risk || null, evidence_refs: [...(plan?.evidence_refs || [])] },
    human_gate: { status: loop.state === "needs_human" ? "requested" : "not_required", request_id: null, approval_id: null },
    action: { status: repair ? "executed" : "not_started", event_id: repair?.id || null, truth: repair ? "ledger_recorded" : null },
    verification: { status: verification?.payload?.passed === true ? "passed" : "not_recorded", event_id: verification?.id || null, passed: verification?.payload?.passed === true ? true : null, evidence_refs: [...(verification?.evidence_refs || [])] },
    learning: { regression_id: null, backtest_id: null, policy_id: null, backtest_source: "captured_fixture" },
    why_stopped: { code: loop.state === "needs_human" ? "insufficient_evidence" : null, detail_status: loop.state === "needs_human" ? "recorded" : "not_stopped" },
    truncated: false,
    truncation: { graph_nodes: 0, graph_edges: 0, timeline_frames: 0, evidence_summaries: Math.max(0, cited.length - evidence.length), serialized_bytes: 0 },
    next_cursor: null,
    workflow: {
      plan: plan ? { event_id: plan.id, actor: plan.actor, sequence: plan.sequence, repair: plan.payload?.repair, target: plan.payload?.target, risk: plan.payload?.risk, verification_plan: plan.payload?.verification_plan, evidence_refs: plan.evidence_refs } : null,
      authority: authority ? { event_id: authority.id, actor: authority.actor, sequence: authority.sequence, outcome: authority.payload?.outcome, reason: authority.payload?.reason, execution_scope: authority.payload?.execution_scope, evidence_refs: authority.evidence_refs } : null,
      repair: repair ? { event_id: repair.id, actor: repair.actor, sequence: repair.sequence, result: repair.payload?.result, execution_scope: repair.payload?.execution_scope, rollback_available: repair.payload?.rollback_available, evidence_refs: repair.evidence_refs } : null,
      verification: verification ? { event_id: verification.id, actor: verification.actor, sequence: verification.sequence, passed: verification.payload?.passed, checks: verification.payload?.checks, recovery_slo: verification.payload?.recovery_slo, evidence_refs: verification.evidence_refs } : null,
      verification_boundary: { kind: "demo_role_separation", limitation: "The remediation and verifier actors are separate paths inside this demo workflow; this does not establish organizational or cryptographic independence." }
    }
  };
}

function localLoopProjectionStage(loop) {
  if (loop.state === "recovered") return { value: { id: "decision_recovery", label: "Decision & Recovery" }, status: "verified" };
  if (loop.state === "needs_human") return { value: { id: "agent_workbench", label: "Agent Workbench" }, status: "blocked" };
  if (["repair", "verify"].includes(loop.stage)) return { value: { id: "decision_recovery", label: "Decision & Recovery" }, status: "executing" };
  if (["plan", "approve-or-auto"].includes(loop.stage)) return { value: { id: "decision_recovery", label: "Decision & Recovery" }, status: "approved" };
  if (["diagnose", "evaluate"].includes(loop.stage)) return { value: { id: "agent_workbench", label: "Agent Workbench" }, status: "evaluating" };
  return { value: { id: "monitor", label: "Monitor" }, status: "collecting" };
}

function componentDetailResponse(snapshot) {
  return {
    schema_version: "flowpulse.component-detail.v1",
    topology_projection_revision: snapshot.topology_projection_revision,
    detail_revision: snapshot.detail_revision,
    component: snapshot.component,
    purpose: snapshot.purpose,
    runtime: snapshot.runtime,
    relationships: snapshot.relationships,
    observability: snapshot.observability,
    configuration: snapshot.configuration,
    data_resources: snapshot.data_resources,
    raw_payload_excluded: true,
    node_investigation: snapshot
  };
}

function nodeQueryFromUrl(url, { includeAfter = false } = {}) {
  const allowed = new Set(["run_id", "window", "signal", "cursor", "limit", ...(includeAfter ? ["after"] : [])]);
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new NodeInvestigationError("node_evidence_query_invalid");
  }
  return validateNodeEvidenceQuery({
    ...(url.searchParams.has("window") ? { window: url.searchParams.get("window") } : {}),
    ...(url.searchParams.has("signal") ? { signal: url.searchParams.get("signal") } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
    ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {})
  });
}

function topologyControlInputs(projected, sourceState) {
  const deploymentEvidence = Array.isArray(sourceState?.evidence) && sourceState.evidence.some((record) => record?.id === "ev-deploy-checkout"
    && record.kind === "deploy" && record.source === "deployment.change" && record.entity === "checkout");
  const observerStatus = sourceState?.status === "captured" || sourceState?.status === "frozen"
    ? "observed"
    : sourceState?.live_status === "live"
      ? "active"
      : "idle";
  const observerSourceHealth = ["live", "stale", "disconnected"].includes(sourceState?.live_status)
    ? sourceState.live_status
    : "unavailable";
  const latestEvent = Array.isArray(projected?.events)
    ? [...projected.events].filter((event) => Number.isSafeInteger(event?.sequence) && event.sequence > 0 && typeof event?.recorded_at === "string" && Array.isArray(event?.evidence_refs)).at(-1)
    : null;
  const latestEvidenceRefs = latestEvent
    ? [...new Set(latestEvent.evidence_refs.filter(safeBrowserId))].sort().slice(0, 4)
    : [];
  return {
    observer_status: observerStatus,
    observer_source_health: observerSourceHealth,
    observer_mode: ["captured", "frozen", "live", "stale", "disconnected"].includes(sourceState?.status) ? sourceState.status : "unavailable",
    external_change_evidence: deploymentEvidence
      ? [{
          id: "ev-deploy-checkout",
          kind: "deployment_change",
          status: "observed",
          affected_node_ids: ["checkout"],
          provenance_refs: ["evidence://ev-deploy-checkout"]
        }]
      : [],
    ledger_event_count: Array.isArray(projected?.events) ? Math.min(projected.events.length, INCIDENT_PROJECTION_LIMITS.max_input_events) : 0,
    replay_complete: projected?.mode === "replay" && projected?.complete === true,
    ledger_latest_event: latestEvent
      ? { sequence: latestEvent.sequence, recorded_at: latestEvent.recorded_at, evidence_refs: latestEvidenceRefs }
      : null
  };
}

async function freezeLiveEvidence(runId) {
  const harness = harnessBinding(loadHarnessManifest());
  let live = new LiveOtlpEvidenceSource(await liveSource.project());
  const runEvents = runtime.ledger.list(runId);
  const applied = runEvents.find((event) => event.type === "change.applied");
  const after = applied?.payload.applied_at;
  const supplementalRecords = [];
  if (applied) {
    const baselineCapture = runEvents.find((event) => event.type === "diagnosis.baseline.captured");
    const codeCapture = runEvents.find((event) => event.type === "code.semantics.captured");
    const baseline = baselineCapture?.payload?.evidence;
    const code = codeCapture?.payload?.evidence;
    const verifiedCode = await developmentAdapter.readPinnedCheckoutCodeEvidence();
    const baselineMatchesCapture = Boolean(baseline
      && baselineCapture?.payload?.evidence_id
      && baselineCapture?.payload?.evidence_hash
      && baseline.id === baselineCapture.payload.evidence_id
      && (baseline.provenance?.sha256 || baseline.hash) === baselineCapture.payload.evidence_hash);
    const codeMatchesCapture = Boolean(code
      && codeCapture?.payload?.evidence_id
      && codeCapture?.payload?.evidence_hash
      && code.id === codeCapture.payload.evidence_id
      && (code.provenance?.sha256 || code.hash) === codeCapture.payload.evidence_hash
      && verifiedCode.id === code.id
      && (verifiedCode.provenance?.sha256 || verifiedCode.hash) === (code.provenance?.sha256 || code.hash));
    if (!baselineMatchesCapture || !codeMatchesCapture) {
      throw new InsufficientEvidenceError("Development snapshot cannot recover the exact pre-change baseline and pinned code evidence", {
        stage: "diagnosis_gate",
        attempt: 0,
        round: 0,
        validator_id: "snapshot_integrity_binding",
        field_path: "diagnosis.baseline.captured",
        reason_code: "captured_baseline_or_code_integrity_mismatch",
        missing_evidence_classes: ["immutable_baseline_or_code_semantics"],
        next_precondition: "capture_matching_baseline_and_pinned_code_evidence"
      });
    }
    const changeEvidence = versionedChangeEvidence({
      manifest: applied.payload.change,
      applied: applied.payload,
      ledgerEvent: applied
    });
    const collected = await development.collectDiagnosisEvidence(runId, { baseline, code, changeEvidence });
    live = new LiveOtlpEvidenceSource(collected.project);
    supplementalRecords.push(...collected.records, changeEvidence);
  }
  const snapshot = live.freeze({ incidentId: bundle.incident.id, runId, after, supplementalRecords, executable: Boolean(applied), harness });
  snapshots.set(runId, snapshot);
  const metadata = snapshot.metadata();
  runtime.append(runId, "evidence.snapshot.created", "runtime", {
    snapshot_id: snapshot.id,
    mode: metadata.mode,
    source_hash: metadata.source_hash,
    content_hash: metadata.content_hash,
    record_count: metadata.record_count,
    source_record_count: metadata.source_record_count,
    bytes: metadata.bytes,
    caps: metadata.caps,
    truncated: metadata.truncated,
    reserved_causal_ids: metadata.reserved_causal_ids,
    frozen_at: metadata.frozen_at,
    harness
  }, snapshot.snapshot.evidence_ids);
  return snapshot;
}

function harnessProjection(events = []) {
  const contextual = [...events].reverse().find((event) => event.type === "context.compiled");
  const bound = [...events].reverse().find((event) => event.payload?.harness)?.payload?.harness || null;
  const failure = projectFailureEpisode(events);
  return {
    manifest: bound ? {
      version: bound.version || null,
      sha256: bound.manifest_sha256 || null
    } : { legacy_detail_status: "legacy_detail_unavailable" },
    current_stage: contextual?.payload?.stage || failure.stage || null,
    attempt: contextual?.payload?.attempt ?? failure.attempt ?? null,
    last_context_sha256: contextual?.payload?.context_sha256 || failure.context_sha256 || null,
    failure: {
      legacy_detail_status: failure.legacy_detail_status,
      boundary: failure.stage || null,
      validator_id: failure.validator_id || null,
      reason_code: failure.reason_code || null,
      tool_coverage: failure.tool_coverage || [],
      missing_evidence_classes: failure.missing_evidence_classes || [],
      next_precondition: failure.next_precondition || null
    }
  };
}

async function streamNodeEvidenceEvents(request, response, url) {
  const prefix = "/api/components/";
  const encodedId = url.pathname.slice(prefix.length, -"/events".length);
  let nodeId;
  try { nodeId = decodeURIComponent(encodedId); } catch { return json(response, 404, { error: "component_detail_unavailable" }); }
  if (!safeBrowserId(nodeId)) return json(response, 404, { error: "component_detail_unavailable" });
  let query;
  try { query = nodeQueryFromUrl(url, { includeAfter: true }); } catch (error) {
    if (error instanceof NodeInvestigationError) return json(response, error.status, { error: error.code });
    throw error;
  }
  const runId = url.searchParams.get("run_id") || browserRunId();
  if (!knownNodeRun(runId)) return json(response, 409, { error: "node_evidence_run_unavailable" });
  let after = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
  if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: "node_evidence_after_invalid" });
  let snapshot;
  try {
    snapshot = (await nodeInvestigationPlaneForRun(runId, await nodeStateForRun(runId))).snapshot(nodeId, query);
  } catch (error) {
    if (error instanceof NodeInvestigationError) return json(response, error.status, { error: error.code });
    throw error;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const staticEvents = nodeEvidenceEvents({ runId, nodeId, snapshot });
  const writeEvent = (event) => {
    if (event.sequence <= after || response.destroyed || response.writableEnded) return;
    after = event.sequence;
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  };
  for (const event of staticEvents) writeEvent(event);
  response.write(": heartbeat\n\n");
  const terminal = ["captured", "frozen", "stale", "disconnected", "unavailable"].includes(snapshot.source_truth.status);
  if (terminal) {
    const final = { sequence: staticEvents.length + 1, type: "node-evidence-state", payload: { run_id: runId, component_id: nodeId, state: snapshot.source_truth.status === "captured" ? "captured_replay" : snapshot.source_truth.status, source_truth: snapshot.source_truth, terminal: true, raw_payload_excluded: true } };
    writeEvent(final);
    response.end();
    return;
  }
  const known = new Set(snapshot.evidence.items.map((item) => item.id));
  let nextSequence = staticEvents.length + 1;
  const interval = setInterval(() => {
    if (response.destroyed || response.writableEnded) return;
    void (async () => {
      try {
        const next = (await nodeInvestigationPlaneForRun(runId)).snapshot(nodeId, query);
        for (const record of next.evidence.items) {
          if (known.has(record.id)) continue;
          known.add(record.id);
          writeEvent({ sequence: nextSequence++, type: nodeEvidenceType(record), payload: nodeEvidencePayload(runId, nodeId, record, next) });
        }
      } catch {
        writeEvent({ sequence: nextSequence++, type: "node-evidence-state", payload: { run_id: runId, component_id: nodeId, state: "disconnected", terminal: true, raw_payload_excluded: true } });
        clearInterval(interval);
        response.end();
      }
      if (!response.writableEnded) response.write(": heartbeat\n\n");
    })();
  }, 1_000);
  request.on("close", () => clearInterval(interval));
  response.on("close", () => clearInterval(interval));
}

function nodeEvidenceEvents({ runId, nodeId, snapshot }) {
  const reference = {
    schema_version: snapshot.schema_version,
    run_id: runId,
    component_id: nodeId,
    detail_revision: snapshot.detail_revision,
    source_truth: snapshot.source_truth,
    snapshot: { ...snapshot, evidence: { ...snapshot.evidence, items: [] } },
    raw_payload_excluded: true
  };
  const events = [{ sequence: 1, type: "node-evidence-snapshot", payload: reference }];
  for (const record of snapshot.evidence.items) {
    events.push({ sequence: events.length + 1, type: nodeEvidenceType(record), payload: nodeEvidencePayload(runId, nodeId, record, snapshot) });
  }
  return events;
}

function nodeEvidenceType(record) {
  if (["metric", "log", "trace"].includes(record.kind)) return `node-evidence-${record.kind}`;
  if (["deploy", "change", "commit", "code"].includes(record.kind)) return "node-evidence-change";
  if (record.resource) return "node-evidence-resource";
  return "node-evidence-record";
}

function nodeEvidencePayload(runId, nodeId, record, snapshot) {
  return {
    schema_version: snapshot.schema_version,
    run_id: runId,
    component_id: nodeId,
    source_truth: snapshot.source_truth,
    evidence: record,
    raw_payload_excluded: true
  };
}

function streamAgentEvents(request, response, url) {
  const runId = url.searchParams.get("run_id") || browserRunId();
  const conversationId = url.searchParams.get("conversation_id");
  let lastSequence = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const sendProjection = async () => {
    // The stream must use the same selected-run read model as the initial
    // page. Calling stateWithSource directly would rebuild a local-loop SSE
    // update from the unrelated runtime state after the page was correct.
    const projection = (await browserStateForRun(runId)).agent_control;
    if (projection.last_sequence <= lastSequence) return;
    lastSequence = projection.last_sequence;
    let payload = projection;
    if (conversationId) {
      try { payload = { agent_control: projection, conversation: agentTeamChat.project({ runId, conversationId }) }; } catch { payload = projection; }
    }
    response.write(`id: ${lastSequence}\nevent: agent-control\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  void sendProjection();
  const interval = setInterval(() => {
    if (response.destroyed) return;
    void sendProjection();
    response.write(": heartbeat\n\n");
  }, 1_000);
  request.on("close", () => clearInterval(interval));
}

function streamLocalFaultLoopEvents(request, response, url) {
  const runId = url.searchParams.get("run_id");
  if (!safeBrowserId(runId)) return json(response, 400, { error: "local_fault_loop_run_id_invalid" });
  let projection;
  try { projection = localFaultLoop.project(runId); } catch (error) {
    if (error instanceof LocalFaultLoopError) return json(response, 404, { error: error.code });
    throw error;
  }
  let lastSequence = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) lastSequence = 0;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  let terminalSent = false;
  const send = () => {
    if (terminalSent || response.writableEnded || response.destroyed) return;
    projection = localFaultLoop.project(runId);
    for (const event of projection.events.filter((item) => item.sequence > lastSequence)) {
      lastSequence = event.sequence;
      response.write(`id: ${event.sequence}\nevent: local-fault-loop\ndata: ${JSON.stringify({ schema_version: projection.schema_version, run_id: projection.run_id, incident_id: projection.incident_id, case_id: projection.case_id, round: projection.round, event, topology: event.topology, contextual_workspaces: event.contextual_workspaces })}\n\n`);
    }
    if (["recovered", "needs_human", "failed"].includes(projection.state)) {
      response.write(`event: local-fault-loop-state\ndata: ${JSON.stringify({ run_id: projection.run_id, incident_id: projection.incident_id, state: projection.state, stage: projection.stage, provider: projection.provider, final: projection.final, contextual_workspaces: projection.contextual_workspaces })}\n\n`);
      terminalSent = true;
      response.end();
    }
  };
  send();
  if (response.writableEnded) return;
  const interval = setInterval(() => {
    if (response.destroyed || response.writableEnded) return;
    send();
    if (!response.writableEnded) response.write(": heartbeat\n\n");
  }, 1_000);
  request.on("close", () => clearInterval(interval));
  response.on("close", () => clearInterval(interval));
}

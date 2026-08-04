import {
  ARCHITECTURE_LAYERS,
  AGENT_TEAM_ROLES,
  LIVE_LAYERS,
  LIVE_UNLINKED_LAYER,
  PULSE_SLOTS,
  TWIN_STAGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_EDGES,
  activeIncidentState,
  architectureBoundaries,
  availableStage,
  architectureViewTopology,
  agentLoopEventProjection,
  agentLoopProjection,
  agentLoopStartProjection,
  sharedRunReadModel,
  canonicalIncidentWorkspaceStage,
  incidentWorkflowEvidence,
  incidentVerificationProjection,
  incidentCompareControlAvailable,
  incidentVerificationGuidance,
  commitPinnedStateResponse,
  isRetryableRequestFailure,
  createTopologyRefreshTracker,
  settleTopologyRefresh,
  createCanonicalLoadingController,
  createPinnedRunStateRetryController,
  cancelPinnedRunRetries,
  sharedRunReconnectDelay,
  agentTeamConversationProjection,
  agentTeamProviderProjection,
  canonicalWorkspaceVisual,
  canvasPointerTransition,
  containedCanvasView,
  componentDetailProjection,
  diagnoseViewTopology,
  nodeLiveInspectorProjection,
  compareProvenance,
  eventsAtStage,
  frameFor,
  liveIncidentNodeStates,
  liveEdgePath,
  incidentFocusWorkspace,
  liveSignalDuration,
  liveSignalProgress,
  livePulseSlots,
  livePositions,
  liveViewTopology,
  isCanvasNavigationMode,
  normalizeServiceId,
  orderedLiveRouteBuildEdges,
  orderedSignalEdges,
  primaryLiveEdges,
  projectAgentCollaborators,
  recoveryWorkflowProjection,
  topologyIntegrity
} from "./twin-state.mjs";
import { connectedLiveTopology } from "./live-topology-renderer.mjs";
import { incidentFocusGraphMarkup } from "./incident-focus-graph.mjs";

try {
  const cookieTheme = document.cookie.split("; ").find((value) => value.startsWith("flowpulse-theme="))?.split("=")[1];
  const savedTheme = localStorage.getItem("flowpulse-theme") || cookieTheme;
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
} catch { /* the light document default remains available */ }

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const IMPACT_SEQUENCE = { checkout: 0, payment: 1, kafka: 2, accounting: 3, fraud: 4 };
const NODE_BY_ID = new Map(TWIN_NODES.map((node) => [node.id, node]));
const EDGE_BY_ID = new Map(TWIN_EDGES.map((edge) => [edge.id, edge]));
const LIVE_WORLD = Object.freeze({ width: 1480, height: 680, minScale: .6, maxScale: 1.6, step: .1 });
const INCIDENT_STAGES = Object.freeze([
  { id: "investigate", label: "Investigate", pageMode: "diagnose" },
  { id: "decide", label: "Decide", pageMode: "recovery" },
  { id: "execute", label: "Execute", pageMode: "recovery" },
  { id: "verify", label: "Verify", pageMode: "compare" }
]);
// Recovery renders the same canonical positions as Live in a compact canvas.
// Keep SVG endpoint geometry aligned with the actual recovery cards so a
// reduced workspace never clips ports or leaves paths visibly short.
const RECOVERY_LIVE_NODE = Object.freeze({ width: 126, height: 44 });
const COMPONENT_CAPABILITIES = Object.freeze({
  "load-generator": "Traffic simulation",
  "frontend-web": "Customer web experience",
  "frontend-proxy": "Edge request routing",
  frontend: "Storefront application",
  cart: "Shopping basket",
  currency: "Price conversion",
  shipping: "Fulfillment quoting",
  checkout: "Order orchestration",
  "product-catalog": "Catalog discovery",
  recommendation: "Personalization",
  ad: "Promotion selection",
  payment: "Payment authorization",
  kafka: "Order event backbone",
  accounting: "Financial posting",
  "fraud-detection": "Risk screening",
  email: "Customer confirmation",
  quote: "Shipping quotes",
  "image-provider": "Product media",
  flagd: "Runtime configuration",
  "telemetry-docs": "Telemetry diagnostics",
  "otelcol-contrib": "Observability pipeline",
  "astronomy-db": "Operational data"
});
const COMPONENT_EXPLANATIONS = Object.freeze({
  "load-generator": "Generates deterministic demo traffic for the captured system.",
  "frontend-web": "Serves the browser entry point and static web assets.",
  "frontend-proxy": "Routes browser requests toward the storefront application.",
  frontend: "Composes the storefront interface for customer requests.",
  cart: "Maintains the active shopping basket for a customer session.",
  currency: "Converts or formats prices for storefront and checkout requests.",
  shipping: "Coordinates shipping options and fulfillment routing.",
  checkout: "Coordinates order placement across payment and downstream services.",
  "product-catalog": "Provides product and catalogue information to storefront flows.",
  recommendation: "Ranks product recommendations for the storefront.",
  ad: "Selects promotional content for storefront requests.",
  payment: "Authorizes payment requests during checkout.",
  kafka: "Carries order and payment events between downstream services.",
  accounting: "Posts financial records from completed order flows.",
  "fraud-detection": "Screens order and payment activity for risk signals.",
  email: "Sends customer communications after order events.",
  quote: "Calculates shipping quotes for an order.",
  "image-provider": "Supplies product media to the storefront.",
  flagd: "Serves runtime feature configuration to observed services.",
  "telemetry-docs": "Provides captured telemetry diagnostic documentation.",
  "otelcol-contrib": "Collects and forwards observed telemetry signals.",
  "astronomy-db": "Stores operational application data for the captured system."
});

let state;
let developmentStatus;
let mode = "architecture";
let incidentStage = "investigate";
let authoritativeIncidentStage = "investigate";
let incidentStageFollowsAuthority = true;
let incidentStageRunId = null;
let renderedMode = null;
let renderedCanvasKey = null;
let cursor = 0;
let playing = false;
let busy = false;
let comparePercent = 50;
let compareFocus = "impact";
let selected = null;
let recoverySelectedRole = null;
let architectureDetail = null;
let activeTab = "evidence";
let toastTimer;
let eventSource;
let streamedRunId;
let streamRefreshTimer;
let liveView = { scale: 1, x: 0, y: 0, initialized: false };
let livePan = null;
let compareDrag = null;
let canvasPointer = null;
let liveSignalTimers = [];
let liveSignalIndex = 0;
let liveSignalFrames = new Set();
let liveSignalGeneration = 0;
let componentCatalogSource = null;
let componentCatalogCache = new Map();
const liveComponentDetails = new Map();
const pendingLiveComponentDetails = new Set();
const unavailableLiveComponentDetails = new Set();
let agentTeamEventSource;
let agentLoopEventSource;
let agentTeamRestoreAttempted = false;
let agentTeam = restoreAgentTeamState();
let liveInspector = emptyLiveInspector();
// This is a connection/cache controller, not a second incident store. Every
// displayed run fact is a parsed record from /api/demo/agent-loop or its SSE.
let sharedRun = restoreSharedRun();
// `run_id` is a deliberate browser contract, not a hint. Restore and pin the
// prior canonical run before the first state request or hydration so another
// tab cannot replace it with whichever loop started most recently.
let selectedRunId = readRequestedRunId();
if (selectedRunId === null && sharedRun?.run_id) bindCanonicalRunSelection(sharedRun);
let sharedRunReconnectTimer = null;
let sharedRunReconnectAttempts = 0;
let sharedRunReconnectRequiresSchemaFrame = false;
let canonicalStateRequestGeneration = 0;
const sharedRunTopologyRefresh = createTopologyRefreshTracker();
const canonicalStateLoading = createCanonicalLoadingController({ setLoading });
const selectedRunStateRetry = createPinnedRunStateRetryController({
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: (timer) => clearTimeout(timer),
  onRetry: (runId) => {
    if (selectedRunId === runId) void refresh({ synchronizeIncidentStage: true });
  }
});
let sharedRunFollowing = true;

class RequestError extends Error {
  constructor(message, { kind = "http", status = null } = {}) {
    super(message);
    this.name = "RequestError";
    this.kind = kind;
    this.status = status;
  }
}

function beginCanonicalStateRequest() {
  canonicalStateRequestGeneration += 1;
  return canonicalStateRequestGeneration;
}

// Background state reads do not create an overlay, but once one completes the
// foreground request it superseded can no longer become canonical. Retire only
// a strictly older foreground token; a newer user refresh remains visible.
function settleSupersededCanonicalLoading(requestGeneration) {
  return canonicalStateLoading.settleSupersededBy(requestGeneration);
}

function commitCanonicalStateResponse({ requestedRunId, requestGeneration, nextState }) {
  return commitPinnedStateResponse({
    requestedRunId,
    selectedRunId,
    requestGeneration,
    currentGeneration: canonicalStateRequestGeneration,
    nextState,
    commit: (value) => { state = value; }
  });
}

window.addEventListener("popstate", () => {
  const requestedRunId = readRequestedRunId();
  if (requestedRunId !== selectedRunId) {
    cancelSharedRunReconnect();
    selectedRunStateRetry.cancel();
  }
  selectedRunId = requestedRunId;
  void refresh({ synchronizeIncidentStage: true });
});

// The app shell itself records the active mode for styling. Bind navigation only
// to actual controls so a tab click cannot bubble back into the shell and reset
// the selected workspace to its initial `architecture` data attribute.
for (const button of document.querySelectorAll("button.mode-button[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
for (const button of document.querySelectorAll("[data-nav-tab]")) button.addEventListener("click", () => handleNavigation(button.dataset.navTab));
for (const button of document.querySelectorAll("[data-focus-entity]")) button.addEventListener("click", () => openDrawer({ type: "node", id: button.dataset.focusEntity }, "overview"));
els["incident-stage-rail"].addEventListener("click", (event) => {
  const stage = event.target.closest("[data-incident-stage]");
  if (stage && !stage.disabled) setIncidentStage(stage.dataset.incidentStage);
});
els["incident-stage-panel"].addEventListener("click", (event) => {
  const role = event.target.closest("[data-agent-team-role]")?.dataset.agentTeamRole;
  if (!role) return;
  const restoreInspector = Boolean(selected?.type === "node" && isRailRuntimeNode(selected.id));
  void openAgentTeamSession(role, { restoreInspector, inspectorSnapshot: restoreInspector ? captureLiveInspectorSnapshot() : null });
});
els["retry-button"].addEventListener("click", refresh);
els["live-button"].addEventListener("click", () => { closeWorkspaceMenu(); runLive(); });
els["details-button"].addEventListener("click", () => { closeWorkspaceMenu(); openDrawer({ type: "run", id: state?.run_id }, "evidence"); });
els["open-incident-button"].addEventListener("click", () => openDrawer({ type: "run", id: state?.run_id }, "agent"));
// Recovery status is navigation only. Repair authority stays in the
// server-owned owner gate and cannot be granted by a canvas control.
els["recovery-status-button"].addEventListener("click", () => setIncidentStage("decide"));
els["development-button"].addEventListener("click", handleDevelopmentAction);
els["drawer-close"].addEventListener("click", closeDrawer);
els["restart-button"].addEventListener("click", restartReplay);
els["back-button"].addEventListener("click", () => seek(cursor - 1));
els["forward-button"].addEventListener("click", stepForward);
els["play-button"].addEventListener("click", togglePlayback);
els["speed-select"].addEventListener("change", updateControls);
els["timeline-range"].addEventListener("input", () => seek(Number(els["timeline-range"].value)));
els["compare-range"].addEventListener("input", () => {
  comparePercent = Number(els["compare-range"].value);
  renderComparePosition();
});
els["compare-canvas-range"].addEventListener("input", () => {
  comparePercent = Number(els["compare-canvas-range"].value);
  renderComparePosition();
});
els["compare-incident"].addEventListener("click", () => setComparePercent(70));
els["compare-even"].addEventListener("click", () => setComparePercent(50));
els["compare-verified"].addEventListener("click", () => setComparePercent(30));
els["compare-control"].addEventListener("click", handleCompareFocus);
els["operations-team-rail"].addEventListener("click", handleOperationsTeamRail);
els["operations-team-rail"].addEventListener("scroll", (event) => {
  if (event.target.matches("[data-live-inspector-scroll]")) liveInspector = { ...liveInspector, scroll_top: event.target.scrollTop };
}, true);
els["theme-toggle"].addEventListener("click", toggleTheme);
els["zoom-out"].addEventListener("click", () => setLiveZoom(liveView.scale - LIVE_WORLD.step));
els["zoom-in"].addEventListener("click", () => setLiveZoom(liveView.scale + LIVE_WORLD.step));
els["zoom-reset"].addEventListener("click", resetLiveView);
els["twin-canvas"].addEventListener("pointerdown", startLivePan);
els["twin-canvas"].addEventListener("pointermove", moveLivePan);
els["twin-canvas"].addEventListener("pointerup", endLivePan);
els["twin-canvas"].addEventListener("pointercancel", endLivePan);
els["twin-canvas"].addEventListener("pointerdown", startCompareDrag);
els["twin-canvas"].addEventListener("pointermove", moveCompareDrag);
els["twin-canvas"].addEventListener("pointerup", endCompareDrag);
els["twin-canvas"].addEventListener("pointercancel", endCompareDrag);
els["timeline-current"].addEventListener("click", () => {
  const shared = sharedRunModelAtCursor();
  openDrawer({ type: "stage", id: shared?.events.at(-1)?.id || TWIN_STAGES[cursor]?.id || "stage" }, tabForStage(cursor));
});
els["canvas-layers"].addEventListener("click", handleCanvasSelection);
els["canvas-layers"].addEventListener("keydown", handleCanvasKeydown);
els["annotation-layer"].addEventListener("click", handleAnnotationSelection);
els["drawer-tabs"].addEventListener("click", handleDrawerTab);
els["drawer-content"].addEventListener("click", handleDrawerEntityFocus);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && agentTeam.panel !== "home") {
    event.preventDefault();
    closeAgentTeamSession({ restoreInspector: true });
  }
});

await refresh({ synchronizeIncidentStage: true });

async function refresh({ synchronizeIncidentStage = false, topologyRefreshKey = null } = {}) {
  const requestedRunId = selectedRunId;
  const requestGeneration = beginCanonicalStateRequest();
  const loadingToken = canonicalStateLoading.begin(requestGeneration);
  let topologyRefreshSettled = false;
  const settleTopologyRefreshOwnership = (succeeded = false) => {
    if (topologyRefreshSettled) return false;
    topologyRefreshSettled = true;
    return settleTopologyRefresh(sharedRunTopologyRefresh, topologyRefreshKey, succeeded);
  };
  try {
    const nextState = await request(browserStatePath(requestedRunId));
    const stateCommit = commitCanonicalStateResponse({
      requestedRunId,
      requestGeneration,
      nextState
    });
    if (stateCommit === "superseded") {
      settleTopologyRefreshOwnership();
      return;
    }
    if (stateCommit === "mismatched") {
      settleTopologyRefreshOwnership();
      throw new RequestError("The requested incident is unavailable.", { status: 404 });
    }
    settleTopologyRefreshOwnership(true);
    bindCanonicalWorkspace(state.workspace_projection);
    const canonical = sharedRunModel();
    synchronizeCanonicalIncidentStage(canonical, { force: synchronizeIncidentStage });
    cursor = canonical?.events.length ? canonical.events.length - 1 : availableStage(state.events);
    connectAgentStream();
    hideError();
    render();
    ensureSelectedLiveComponentDetail();
    if (requestedRunId !== null) selectedRunStateRetry.succeed(requestedRunId);
    void hydrateSharedRun();
    void restoreAgentTeamSession();
    // Local-development diagnostics can spend seconds probing Docker and the
    // optional flag API. They must never delay the canonical browser state.
    void refreshDevelopmentStatus();
  } catch (error) {
    settleTopologyRefreshOwnership();
    if (requestGeneration !== canonicalStateRequestGeneration || selectedRunId !== requestedRunId) return;
    showError(error.message);
    // A restored terminal run cannot rely on a live EventSource to surface a
    // failed reload. Keep its canonical identity pinned and enter the same
    // rehydrate loop used for incompatible stream frames.
    // A rejected topology refresh is a pinned /api/state failure, not an
    // EventSource failure. Retry that exact state read so the refresh tracker
    // can accept the same revision after a transient 503.
    const retryable = isRetryableRequestFailure(error);
    if (!retryable && requestedRunId !== null) {
      const terminalRetryCancelled = cancelPinnedRunRetries({
        requestedRunId,
        selectedRunId,
        selectedStateRetry: selectedRunStateRetry,
        cancelSharedReconnect: cancelSharedRunReconnect
      });
      if (terminalRetryCancelled && sharedRun?.run_id === requestedRunId) {
        sharedRun = { ...sharedRun, stream_state: "stale", error: "Live incident updates are unavailable. Retry manually." };
        persistSharedRun();
        renderSharedRunConnectionStatus();
      }
    } else if (retryable && topologyRefreshKey && requestedRunId !== null) {
      selectedRunStateRetry.schedule(requestedRunId);
    } else if (retryable && sharedRun?.run_id && selectedRunId === sharedRun.run_id) {
      scheduleSharedRunReconnect({ error: "Canonical incident refresh is unavailable." });
      renderSharedRunConnectionStatus();
    } else if (retryable && requestedRunId !== null) {
      selectedRunStateRetry.schedule(requestedRunId);
    }
  } finally {
    canonicalStateLoading.settle(loadingToken);
  }
}

function bindCanonicalWorkspace(value) {
  if (value == null) {
    if (selectedRunId !== null) {
      sharedRun = { run_id: null, incident_id: null, loop: null, last_sequence: 0, stream_state: "stale", error: "The requested run is unavailable." };
      persistSharedRun();
    }
    return;
  }
  const loop = agentLoopProjection(value, { runId: value?.run_id || null });
  if (!loop || (selectedRunId !== null && loop.run_id !== selectedRunId)) {
    sharedRun = { run_id: null, incident_id: null, loop: null, last_sequence: 0, stream_state: "stale", error: "Canonical workspace projection is incompatible." };
    persistSharedRun();
    return;
  }
  if (selectedRunId === null) bindCanonicalRunSelection(loop);
  if (sharedRun?.run_id && sharedRun.run_id !== loop.run_id) cancelSharedRunReconnect();
  resetIncidentStageForRun(loop.run_id);
  sharedRun = {
    run_id: loop.run_id,
    incident_id: loop.incident_id,
    loop,
    last_sequence: loop.events.at(-1)?.sequence || 0,
    stream_state: sharedRunTransportState(loop),
    error: null
  };
  persistSharedRun();
}

function restoreSharedRun() {
  try {
    const value = JSON.parse(sessionStorage.getItem("flowpulse-shared-run") || "null");
    if (!value || typeof value !== "object" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.run_id || "") || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.incident_id || "")) return null;
    return { run_id: value.run_id, incident_id: value.incident_id, loop: null, last_sequence: Number.isSafeInteger(value.last_sequence) && value.last_sequence >= 0 ? value.last_sequence : 0, stream_state: "connecting", error: null };
  } catch {
    return null;
  }
}

function readRequestedRunId() {
  try {
    // Do not validate away a caller's explicit query. The server owns the
    // validation and must be allowed to fail closed rather than returning the
    // currently active run for an invalid deep link.
    return new URLSearchParams(window.location.search).get("run_id");
  } catch {
    return null;
  }
}

function browserStatePath(runId = selectedRunId) {
  return runId !== null ? `/api/state?run_id=${encodeURIComponent(runId)}` : "/api/state";
}

function bindCanonicalRunSelection(loop) {
  const runId = loop?.run_id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(runId || "")) throw new Error("Demo loop did not return a valid canonical run.");
  const next = new URL(window.location.href);
  next.searchParams.set("run_id", runId);
  // Update the mutable selector and the visible URL synchronously before the
  // next hydration/SSE refresh. This prevents a refresh from selecting a
  // different loop that happened to start in another tab.
  if (selectedRunId !== runId) {
    cancelSharedRunReconnect();
    selectedRunStateRetry.cancel();
  }
  selectedRunId = runId;
  resetIncidentStageForRun(runId);
  history.replaceState({ ...(history.state || {}), flowpulse_run_id: runId }, "", `${next.pathname}${next.search}${next.hash}`);
}

function persistSharedRun() {
  try {
    if (!sharedRun?.run_id) sessionStorage.removeItem("flowpulse-shared-run");
    else sessionStorage.setItem("flowpulse-shared-run", JSON.stringify({ run_id: sharedRun.run_id, incident_id: sharedRun.incident_id, last_sequence: sharedRun.last_sequence || 0 }));
  } catch { /* session restore is optional */ }
}

function sharedRunModel() {
  return sharedRun?.loop ? sharedRunReadModel(sharedRun.loop) : null;
}

function sharedRunModelAtCursor() {
  const model = sharedRunModel();
  if (!model?.events.length) return model;
  const event = model.events[Math.max(0, Math.min(cursor, model.events.length - 1))];
  return sharedRunReadModel(sharedRun.loop, { throughSequence: event.sequence });
}

function canonicalRunId() {
  return sharedRunModel()?.run_id || state?.run_id || null;
}

function canonicalIncidentId() {
  return sharedRunModel()?.incident_id || state?.incident?.id || null;
}

function canonicalProjectionRevision() {
  return sharedRunModel()?.projection_revision
    || (mode === "architecture" ? architectureView()?.projection_revision : liveTopologyView()?.projection_revision)
    || state?.topology_views?.projection_revision
    || null;
}

function canonicalSelectedComponent() {
  const candidate = normalizeServiceId(selected?.type === "node" ? selected.id : sharedRunModel()?.selected_component || "");
  const topology = sharedRunModel()?.topology;
  return topology && !topology.node_ids.includes(candidate) ? topology.current.node_statuses["checkout"] ? "checkout" : null : candidate || null;
}

function canonicalEvents() {
  return sharedRunModel()?.events || state?.events || [];
}

function sharedRunTerminal() {
  return ["recovered", "needs_human", "failed"].includes(sharedRunModel()?.state);
}

function sharedRunTransportState(loop) {
  if (["recovered", "needs_human", "failed"].includes(loop?.state)) return "idle";
  return sharedRunReconnectAttempts >= 2 ? "stale" : "reconnecting";
}

async function hydrateSharedRun() {
  const runId = sharedRun?.run_id;
  if (!runId || selectedRunId !== runId) return;
  try {
    const payload = await request(`/api/demo/agent-loop?run_id=${encodeURIComponent(runId)}`);
    if (sharedRun?.run_id !== runId || selectedRunId !== runId) return;
    const loop = agentLoopProjection(payload, { runId });
    if (!loop || loop.incident_id !== sharedRun.incident_id) throw new Error("Shared run projection is incompatible.");
    // A successful full projection normally proves hydration has recovered.
    // When the retry was caused by a malformed SSE envelope, keep the
    // backoff until a valid frame proves the transport schema is usable.
    if (!sharedRunReconnectRequiresSchemaFrame) sharedRunReconnectAttempts = 0;
    const topologyRefreshKey = sharedRunTopologyRefresh.request(loop, state);
    sharedRun = { ...sharedRun, loop, last_sequence: Math.max(sharedRun.last_sequence || 0, loop.events.at(-1)?.sequence || 0), stream_state: sharedRunTransportState(loop), error: null };
    agentTeam = {
      ...agentTeam,
      loop,
      loop_after: Math.max(agentTeam.loop_after || 0, loop.events.at(-1)?.sequence || 0),
      loop_items: loop.events.reduce((items, event) => appendLoopTimelineItem(items, event), [])
    };
    if (!selected && loop.contextual_workspaces.context.selected_component) selected = { type: "node", id: loop.contextual_workspaces.context.selected_component };
    if (sharedRunFollowing) cursor = Math.max(0, loop.events.length - 1);
    synchronizeCanonicalIncidentStage(sharedRunModel());
    persistSharedRun();
    connectSharedRunStream();
    render();
    ensureSelectedLiveComponentDetail();
    // A guided replay may finish before EventSource connects. Its full loop
    // projection is useful, but the Incident canvas also needs the matching
    // pinned /api/state topology view before it can render the graph.
    if (topologyRefreshKey) void refresh({ synchronizeIncidentStage: true, topologyRefreshKey });
  } catch (error) {
    if (sharedRun?.run_id !== runId || selectedRunId !== runId) return;
    scheduleSharedRunReconnect({ error: error.message || "Shared run is unavailable." });
  }
}

function cancelSharedRunReconnect(runId = null) {
  if (runId !== null && sharedRun?.run_id !== runId) return false;
  if (sharedRunReconnectTimer) clearTimeout(sharedRunReconnectTimer);
  sharedRunReconnectTimer = null;
  sharedRunReconnectAttempts = 0;
  sharedRunReconnectRequiresSchemaFrame = false;
  sharedRunTopologyRefresh.reset();
  agentLoopEventSource?.close();
  agentLoopEventSource = null;
  return true;
}

function scheduleSharedRunReconnect({ error = null } = {}) {
  const runId = sharedRun?.run_id;
  if (!runId || selectedRunId !== runId || sharedRunReconnectTimer) return;
  agentLoopEventSource?.close();
  agentLoopEventSource = null;
  sharedRunReconnectAttempts += 1;
  const delay = sharedRunReconnectDelay(sharedRunReconnectAttempts);
  sharedRun = {
    ...sharedRun,
    stream_state: sharedRunReconnectAttempts >= 2 ? "stale" : "reconnecting",
    error
  };
  sharedRunReconnectTimer = setTimeout(() => {
    sharedRunReconnectTimer = null;
    if (sharedRun?.run_id !== runId || selectedRunId !== runId) return;
    // Refresh the immutable projection before reopening SSE. Both a rejected
    // hydration and an incompatible stream frame travel through this same
    // bounded retry path, so the operator never sees a fake retrying state.
    void hydrateSharedRun();
  }, delay);
  renderSharedRunConnectionStatus();
  if (state || sharedRunModel()) render();
}

function connectSharedRunStream() {
  if (!sharedRun?.run_id || !sharedRun?.loop || ["recovered", "needs_human", "failed"].includes(sharedRun.loop.state) || typeof EventSource !== "function") return;
  agentLoopEventSource?.close();
  const runId = sharedRun.run_id;
  const incidentId = sharedRun.incident_id;
  const after = sharedRun.last_sequence || 0;
  const stream = new EventSource(`/api/demo/agent-loop/events?run_id=${encodeURIComponent(runId)}&after=${after}`);
  agentLoopEventSource = stream;
  stream.onopen = () => {
    if (agentLoopEventSource !== stream || sharedRun?.run_id !== runId) return;
    // Transport open is not proof of a usable stream. Attempts reset only
    // after a validated schema frame or a successful authoritative hydrate.
  };
  stream.addEventListener("local-fault-loop", (event) => {
    try {
      if (agentLoopEventSource !== stream || sharedRun?.run_id !== runId) return;
      const projection = agentLoopEventProjection(JSON.parse(event.data), { runId });
      if (!projection || projection.incident_id !== incidentId) throw new Error("Shared run event is incompatible.");
      const needsAuthoritativeBrowserProjection = projection.topology !== null
        && (state?.run_id !== runId || state?.topology_views?.projection_revision !== projection.topology.projection_revision);
      const incoming = projection.event;
      const events = [...(sharedRun.loop?.events || []), incoming]
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id || candidate.sequence === entry.sequence) === index)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-160);
      const loop = {
        ...sharedRun.loop,
        events,
        topology: projection.topology || sharedRun.loop.topology,
        contextual_workspaces: projection.contextual_workspaces,
        stage: projection.contextual_workspaces.context.timeline.stage
      };
      sharedRunReconnectAttempts = 0;
      sharedRunReconnectRequiresSchemaFrame = false;
      sharedRun = {
        ...sharedRun,
        loop,
        last_sequence: Math.max(sharedRun.last_sequence || 0, incoming.sequence),
        stream_state: "connected",
        error: null
      };
      if (sharedRunFollowing) cursor = Math.max(0, events.length - 1);
      synchronizeCanonicalIncidentStage(sharedRunModel());
      agentTeam = {
        ...agentTeam,
        loop,
        loop_after: sharedRun.last_sequence,
        loop_items: appendLoopTimelineItem(agentTeam.loop_items, incoming)
      };
      persistSharedRun();
      // The focused Incident canvas also consumes the selected run's strict
      // topology-view overlay. Refresh that authoritative browser projection
      // as soon as SSE binds a new topology/revision, rather than leaving a
      // completed replay on the pending canvas until a manual reload.
      if (needsAuthoritativeBrowserProjection) void refresh({ synchronizeIncidentStage: true });
      if (incoming.type.startsWith("agent_team.") && agentTeam.panel === "session") void hydrateAgentTeamSession({ stream: false });
      render();
      ensureSelectedLiveComponentDetail();
    } catch {
      stream.close();
      if (sharedRun?.run_id !== runId) return;
      sharedRunReconnectRequiresSchemaFrame = true;
      scheduleSharedRunReconnect({ error: "Shared run stream is incompatible." });
    }
  });
  stream.addEventListener("local-fault-loop-state", () => {
    if (agentLoopEventSource !== stream || sharedRun?.run_id !== runId) return;
    stream.close();
    void hydrateSharedRun();
  });
  stream.onerror = () => {
    if (agentLoopEventSource !== stream || sharedRun?.run_id !== runId) return;
    stream.close();
    scheduleSharedRunReconnect();
  };
}

function appendLoopTimelineItem(items, event) {
  const item = safeAgentLoopTimelineItem(event);
  return item && !(items || []).some((entry) => entry.id === item.id) ? [...(items || []), item].slice(-64) : items || [];
}

async function refreshDevelopmentStatus() {
  try {
    developmentStatus = await request("/api/development/status");
  } catch {
    developmentStatus = null;
  }
  if (!state) return;
  renderDevelopmentControl();
  updateControls();
}

function isIncidentWorkspace() {
  return mode === "incident";
}

function isIncidentCompareStage() {
  return isIncidentWorkspace() && incidentStage === "verify";
}

function incidentAgentPageMode() {
  return INCIDENT_STAGES.find((stage) => stage.id === incidentStage)?.pageMode || "diagnose";
}

function incidentStageEvidence(shared) {
  const events = shared?.events || [];
  const has = (type) => events.some((event) => event.type === type);
  const workflow = incidentWorkflowEvidence(events);
  return {
    investigate: Boolean(shared?.topology && incidentFocusWorkspace(shared.topology, shared.topology.snapshots?.incident, diagnoseViewTopology(state?.topology_views)).availability === "ready"),
    decide: has("local_fault_loop.plan.proposed") || shared?.workspace_actions?.open_recovery_console?.available === true,
    execute: workflow.authorityGranted || workflow.repairExecuted,
    verify: workflow.verificationAttempted
  };
}

function resetIncidentStageForRun(runId) {
  if (!runId || incidentStageRunId === runId) return;
  incidentStageRunId = runId;
  incidentStageFollowsAuthority = true;
}

function synchronizeCanonicalIncidentStage(shared, { force = false } = {}) {
  if (!shared) return;
  resetIncidentStageForRun(shared.run_id);
  authoritativeIncidentStage = canonicalIncidentWorkspaceStage(shared);
  if (force || incidentStageFollowsAuthority) {
    incidentStage = authoritativeIncidentStage;
    incidentStageFollowsAuthority = true;
  }
}

function setIncidentStage(nextStage) {
  if (!INCIDENT_STAGES.some((stage) => stage.id === nextStage)) return;
  const shared = sharedRunModel();
  const evidence = incidentStageEvidence(shared);
  if (shared && !evidence[nextStage]) {
    showToast(`${INCIDENT_STAGES.find((stage) => stage.id === nextStage)?.label || "This stage"} is awaiting a server-recorded prerequisite.`);
    return;
  }
  incidentStage = nextStage;
  incidentStageFollowsAuthority = nextStage === authoritativeIncidentStage;
  mode = "incident";
  if (shared && sharedRunFollowing) cursor = Math.max(0, shared.events.length - 1);
  render();
}

function render() {
  if (!state) return;
  if (els["app-shell"].dataset.controlPlaneMode === "incident") return;
  const focusedIncidentStage = document.activeElement?.closest?.("[data-incident-stage]")?.dataset.incidentStage || null;
  const canvasKey = canvasProjectionKey();
  const controlPlaneCanvasIsMounted = Boolean(els["canvas-layers"].querySelector(".control-plane-twin-layer"));
  const shouldRenderCanvas = canvasKey !== renderedCanvasKey || controlPlaneCanvasIsMounted;
  const previousPositions = shouldRenderCanvas && renderedMode && renderedMode !== mode ? captureCanvasNodePositions() : new Map();
  renderHeader();
  renderMetrics();
  if (shouldRenderCanvas) renderCanvas();
  renderIncidentStageRail(focusedIncidentStage);
  renderTimeline();
  renderApproval();
  renderDevelopmentControl();
  renderDrawer();
  renderOperationsTeamRail();
  updateControls();
  if (shouldRenderCanvas) animateCanvasTransition(previousPositions);
  renderedMode = mode;
  renderedCanvasKey = canvasKey;
}

function canvasProjectionKey() {
  const shared = sharedRunModel();
  if (shared && mode !== "architecture") return `${mode}:${incidentStage}:${shared.run_id}:${shared.projection_revision}:${state?.topology_views?.run_id || "unavailable"}:${state?.topology_views?.projection_revision || "unavailable"}:${shared.timeline.position}:${cursor}`;
  if (mode === "architecture") {
    const detail = architectureDetail?.scope === "architecture"
      ? `${architectureDetail.nodeId}:${architectureDetail.loading ? "loading" : architectureDetail.failed ? "unavailable" : architectureDetail.detail?.detail_revision || "compact"}`
      : "compact";
    return `architecture:${architectureView()?.projection_revision || "unavailable"}:${detail}`;
  }
  if (mode === "live") return `live:${liveTopologyView()?.projection_revision || "unavailable"}`;
  return `${mode}:${state?.run_id || "unavailable"}:${state?.topology_views?.projection_revision || "unavailable"}:${cursor}`;
}

function renderHeader() {
  const shared = sharedRunModel();
  const workflow = incidentWorkflowEvidence(shared?.events || []);
  const frame = shared ? null : currentFrame();
  const source = mode === "live" ? liveSource(liveTopologyView()) : sourceState();
  const titles = { architecture: "Architecture", live: "Runtime activity", incident: "Incident workspace", replay: "Incident diagnosis", agents: "Recovery Console", compare: "Recovery comparison" };
  const canvasTitles = { architecture: "Architecture", live: "Observed runtime", incident: "Incident workspace", replay: "Incident reconstruction", agents: "Developer recovery workspace", compare: "Incident vs verified" };
  els["incident-title"].textContent = shared
    ? workflow.verificationFailed
      ? "Recovery verification incident"
      : shared.state === "needs_human"
        ? "Evidence gap incident"
        : "Checkout / payment incident"
    : state.incident.title;
  els["incident-summary"].textContent = shared
    ? workflow.verificationFailed
      ? `${shared.events.length} server-recorded updates · Repair executed; verification failed`
      : `${shared.events.length} server-recorded updates`
    : state.incident.summary;
  renderSharedRunConnectionStatus();
  els.severity.textContent = shared ? (shared.state === "needs_human" ? "Unknown" : "SEV-2") : state.incident.severity;
  els.environment.textContent = shared ? "Incident workspace" : state.incident.environment;
  const sharedStageLabel = workflow.verificationFailed ? "Verification failed" : humanStageLabel(shared?.stage);
  els["incident-stage"].textContent = shared ? sharedStageLabel : state.stage;
  els["workspace-title"].textContent = titles[mode];
  els["canvas-title"].textContent = canvasTitles[mode];
  const architecture = mode === "architecture" ? architectureView() : null;
  const architectureSystems = architecture ? architectureBoundaries(architecture.graph) : null;
  els.stage.textContent = mode === "architecture" ? architectureSystems ? `${architectureSystems.observed.nodes.length + architectureSystems.flowpulse.nodes.length} components` : "Architecture unavailable" : isIncidentWorkspace() ? `${INCIDENT_STAGES.find((stage) => stage.id === incidentStage)?.label || "Incident"} · ${shared ? sharedStageLabel : "Awaiting canonical evidence"}` : shared ? sharedStageLabel : mode === "live" ? telemetryStatusLabel(source.status) : mode === "agents" ? humanStageLabel(agentControl().report.stage) : mode === "compare" ? "Incident vs verified" : timelineStages()[cursor].label;
  els["status-text"].textContent = modeStatus();
  els["ledger-state"].textContent = `${canonicalEvents().length} immutable events`;
  els["capture-label"].textContent = captureLabel();
  const canonicalWorkspacePending = (isIncidentWorkspace() || ["replay", "agents", "compare"].includes(mode)) && !shared;
  els["capture-label"].className = `capture-label source-${canonicalWorkspacePending ? "unavailable" : isIncidentCompareStage() || mode === "compare" ? compareProvenance(state.events).tone : source.status}`;
  els["zoom-controls"].hidden = !isCanvasNavigationMode(mode);
  updateZoomControls();
  els["canvas-caption"].textContent = isIncidentWorkspace() && shared ? `${INCIDENT_STAGES.find((stage) => stage.id === incidentStage)?.label || "Incident"} · ${canonicalDiagnosisCaption(shared)}` : mode === "replay" && shared ? canonicalDiagnosisCaption(shared) : modeCaption(frame);
  els["app-shell"].dataset.mode = mode;
  els["app-shell"].dataset.workspaceMode = isIncidentWorkspace() ? `incident-${incidentStage}` : mode === "replay" ? "diagnose" : mode;
  // Expose the product-facing workspace name without changing the internal
  // replay state used by the deterministic timeline and existing CSS.
  els["app-shell"].mode = isIncidentWorkspace() ? "incident" : mode === "replay" ? "diagnose" : mode;
  els["timeline-dock"].hidden = !(isIncidentWorkspace() || ["replay", "agents", "compare"].includes(mode));
  els["live-button"].hidden = !state.live_available;
  renderThemeToggle();
  for (const button of document.querySelectorAll("button.mode-button[data-mode]")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (state.langfuse_enabled) {
    els["langfuse-link"].classList.remove("is-disabled");
    els["langfuse-link"].textContent = "Open Langfuse trace";
    els["langfuse-link"].href = state.langfuse_url;
  } else {
    els["langfuse-link"].classList.add("is-disabled");
    els["langfuse-link"].textContent = "Tracing not configured";
  }
}

function renderSharedRunConnectionStatus() {
  const retryPending = sharedRunReconnectTimer !== null;
  const connectionMessage = sharedRun?.stream_state === "reconnecting" && retryPending
    ? "Reconnecting to live incident updates"
    : sharedRun?.stream_state === "stale" && retryPending
      ? "Live incident updates are stale; retrying"
      : ["reconnecting", "stale"].includes(sharedRun?.stream_state)
        ? "Live incident updates are unavailable. Retry manually."
      : "";
  els["shared-run-connection"].hidden = !connectionMessage;
  els["shared-run-connection"].textContent = connectionMessage;
  els["shared-run-connection"].dataset.state = sharedRun?.stream_state || "";
  if (!connectionMessage) return;
  els["incident-strip"].hidden = false;
  els["incident-strip"].classList.add("is-connection-status");
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("flowpulse-theme", theme); } catch { /* theme still applies for this session */ }
  document.cookie = `flowpulse-theme=${theme}; max-age=31536000; path=/; samesite=lax`;
  renderThemeToggle();
}

function renderThemeToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  els["theme-toggle"].setAttribute("aria-pressed", String(dark));
  els["theme-toggle"].setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to pure black theme");
  els["theme-toggle-label"].textContent = dark ? "Light" : "Black";
}

function renderMetrics() {
  const shared = sharedRunModel();
  if (shared && mode !== "architecture") {
    renderSharedRunMetrics(shared);
    return;
  }
  if (sharedRun?.loop && mode !== "architecture") {
    els["metric-checkout-label"].textContent = "System";
    els["metric-payment-label"].textContent = "State";
    els["metric-kafka-label"].textContent = "Updates";
    setMetric("checkout", "Loading", "Waiting for the server view");
    setMetric("payment", humanStageLabel(sharedRun.loop.state), "Server state");
    setMetric("kafka", String(sharedRun.loop.events?.length || 0), "Recorded updates");
    return;
  }
  if (mode === "agents") {
    const control = agentControl();
    const team = projectAgentCollaborators(control);
    const active = team.nodes.filter((node) => ["running", "waiting", "rejected"].includes(node.status)).length;
    els["metric-checkout-label"].textContent = "Collaborators";
    els["metric-payment-label"].textContent = "Working";
    els["metric-kafka-label"].textContent = "Control events";
    setMetric("checkout", String(team.nodes.length), "specialists remain isolated");
    setMetric("payment", String(active), team.nodes.find((node) => node.id === team.currentId)?.label || "Commander");
    setMetric("kafka", String(control.orchestration?.proposal_count || 0), control.langfuse === "observing" ? "harness + Langfuse" : "harness validated");
    return;
  }
  if (mode === "architecture") {
    const view = architectureView();
    const boundaries = view ? architectureBoundaries(view.graph) : null;
    els["metric-checkout-label"].textContent = "Components";
    els["metric-payment-label"].textContent = "Dependencies";
    els["metric-kafka-label"].textContent = "FlowPulse";
    setMetric("checkout", String(boundaries?.observed.nodes.length || 0), view ? "System view" : "Backend view unavailable");
    setMetric("payment", String(boundaries?.observed.relations.length || 0), view ? "Observed relationships" : "No compatible view");
    setMetric("kafka", String(boundaries?.flowpulse.nodes.length || 0), view ? `${view.external_change_evidence.relation_count} evidence relation` : "Control system unavailable");
    return;
  }
  if (mode === "live" || state.mode === "development") {
    const live = mode === "live" ? liveTopologyView() : null;
    const source = mode === "live" ? liveSource(live) : sourceState();
    const topology = mode === "live"
      ? topologyIntegrity(live?.runtime_data.graph || { nodes: [], edges: [] })
      : topologyIntegrity(source.topology);
    const visibleDependencies = mode === "live" ? 0 : topology?.edges?.length || 0;
    els["metric-checkout-label"].textContent = "Services";
    els["metric-payment-label"].textContent = "Dependencies";
    els["metric-kafka-label"].textContent = "Last update";
    setMetric("checkout", String(topology?.nodes?.length || 0), "");
    setMetric("payment", String(topology?.edges?.length || 0), mode === "live" ? "projected runtime paths" : `${visibleDependencies} primary paths shown${topology.unlinked_node_ids.length ? ` · ${topology.unlinked_node_ids.length} gaps` : ""}`);
    setMetric("kafka", source.freshness_ms == null ? "—" : formatAge(source.freshness_ms), source.freshness_ms == null ? telemetryStatusLabel(source.status) : "");
    return;
  }
  els["metric-checkout-label"].textContent = "Checkout errors";
  els["metric-payment-label"].textContent = "Payment";
  els["metric-kafka-label"].textContent = "Kafka lag";
  if (isIncidentWorkspace() || ["replay", "agents", "compare"].includes(mode)) {
    setMetric("checkout", "Unavailable", "Awaiting canonical evidence");
    setMetric("payment", "Unavailable", "Awaiting canonical evidence");
    setMetric("kafka", "Unavailable", "Awaiting canonical evidence");
    return;
  }
  const metrics = currentFrame().metrics;
  for (const [name, metric] of Object.entries(metrics)) setMetric(name, metric.value, metric.note);
}

function renderSharedRunMetrics(shared) {
  els["metric-checkout-label"].textContent = "Checkout errors";
  els["metric-payment-label"].textContent = "Payment reachable";
  els["metric-kafka-label"].textContent = "Kafka lag";
  const snapshot = isIncidentWorkspace() && ["investigate", "decide"].includes(incidentStage)
    ? shared.topology.snapshots.incident
    : shared.topology.current;
  const current = canonicalWorkspaceVisual(shared.topology, snapshot);
  if (current.availability !== "ready") {
    for (const [name, metric] of Object.entries(current.metrics)) setMetric(name, metric.value, metric.note);
    return;
  }
  if (isIncidentCompareStage() || mode === "compare") {
    const verification = incidentVerificationProjection(shared);
    const incident = canonicalWorkspaceVisual(shared.topology, shared.topology.snapshots.incident);
    const verified = canonicalWorkspaceVisual(shared.topology, shared.topology.snapshots.verified);
    if (incident.availability !== "ready" || verified.availability !== "ready" || !verification.passed) {
      const verificationNote = verification.failed ? "Independent verification failed" : "Verification pending";
      setMetric("checkout", "Unavailable", verificationNote);
      setMetric("payment", "Unavailable", verificationNote);
      setMetric("kafka", "Unavailable", verificationNote);
      return;
    }
    setMetric("checkout", `${incident.metrics.checkout.value} → ${verified.metrics.checkout.value}`, "incident to verified evidence");
    setMetric("payment", `${incident.metrics.payment.value} → ${verified.metrics.payment.value}`, "incident to verified evidence");
    setMetric("kafka", `${incident.metrics.kafka.value} → ${verified.metrics.kafka.value}`, "incident to verified evidence");
    return;
  }
  for (const [name, metric] of Object.entries(current.metrics)) setMetric(name, metric.value, metric.note);
}

function setMetric(name, value, note) {
  els[`metric-${name}`].textContent = value;
  els[`metric-${name}-note`].textContent = note;
}

function renderCanvas() {
  stopLiveSignalLoop();
  if (!isIncidentWorkspace()) {
    els["incident-stage-panel"].hidden = true;
    els["incident-stage-panel"].innerHTML = "";
  }
  const shared = sharedRunModelAtCursor();
  const canonicalWorkspace = isIncidentWorkspace() || ["replay", "agents", "compare"].includes(mode);
  els["twin-canvas"].classList.toggle("is-compare-mode", isIncidentCompareStage() || mode === "compare");
  els["twin-canvas"].classList.toggle("is-source-topology", mode === "architecture" || mode === "live" || canonicalWorkspace);
  els["twin-canvas"].classList.toggle("is-architecture-source", mode === "architecture");
  els["twin-canvas"].classList.toggle("is-live-source", mode === "live" || isIncidentWorkspace() || mode === "replay" || mode === "compare");
  els["twin-canvas"].classList.toggle("is-agent-source", false);
  configureCanvasWorld(mode === "live" || isIncidentWorkspace() || mode === "replay" || mode === "compare");
  if (mode === "architecture") {
    renderSourceCanvas("architecture");
    return;
  }
  if (mode === "live") {
    if (sharedRun?.loop && !shared) return renderCanonicalTopologyPending();
    renderSourceCanvas("live", shared?.topology || null, shared ? "Live canonical topology." : null);
    return;
  }
  if (canonicalWorkspace && !shared) {
    const label = isIncidentWorkspace() ? "Incident workspace" : mode === "agents" ? "Recovery Console" : mode === "compare" ? "Compare" : "Diagnose";
    renderCanonicalTopologyPending(`${label} is waiting for the backend-owned canonical topology binding.`);
    return;
  }
  if (isIncidentWorkspace()) {
    renderIncidentWorkspaceCanvas(shared);
    return;
  }
  if (mode === "agents") {
    renderAgentCanvas();
    return;
  }
  if (mode === "compare") {
    renderCanonicalCompareCanvas(shared);
    return;
  }
  const diagnosis = incidentFocusLayerMarkup(shared.topology, shared.topology.snapshots.incident, { layerName: "current", workspace: "diagnose", pulse: true });
  if (diagnosis.visual.availability !== "ready") {
    renderCanonicalTopologyPending("Diagnose is waiting for a matching server-projected causal path.");
    return;
  }
  els["canvas-layers"].innerHTML = diagnosis.markup;
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  bindCanonicalCanvasIdentity(diagnosis.visual, "diagnose-canvas");
  const annotations = sharedRunAnnotations(shared).filter((annotation) => annotation.id !== "recovery");
  const change = diagnosis.visual.change_record;
  if (change) {
    const affected = change.affected_node_ids
      .map((id) => diagnosis.visual.nodes.find((node) => node.id === id)?.label)
      .filter(Boolean)
      .join(", ");
    annotations.push({ id: "observed-change", tone: "warning", title: "Observed change", copy: `${affected || "Affected component"} has linked change evidence.` });
  }
  setAnnotations(annotations.slice(-2));
  els["twin-canvas"].setAttribute("aria-label", "Incident diagnosis.");
  startIncidentFocusSignals();
}

function renderIncidentWorkspaceCanvas(shared) {
  const topology = shared.topology;
  const snapshot = ["investigate", "decide"].includes(incidentStage) ? topology.snapshots.incident : topology.current;
  if (incidentStage === "verify") {
    renderCanonicalCompareCanvas(shared);
    renderIncidentStagePanel(shared);
    return;
  }
  const workspace = incidentFocusLayerMarkup(topology, snapshot, {
    layerName: "current",
    workspace: incidentStage === "investigate" ? "diagnose" : "recovery",
    pulse: incidentStage === "investigate" || incidentStage === "execute"
  });
  if (workspace.visual.availability !== "ready") {
    renderIncidentStagePanel(shared);
    renderCanonicalTopologyPending("Incident is waiting for a matching server-projected causal path.");
    return;
  }
  els["canvas-layers"].innerHTML = workspace.markup;
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  bindCanonicalCanvasIdentity(workspace.visual, "incident-workspace-canvas");
  const annotations = sharedRunAnnotations(shared).filter((annotation) => annotation.id !== "recovery");
  if (incidentStage === "investigate" && workspace.visual.change_record) {
    const labels = workspace.visual.change_record.affected_node_ids.map((id) => workspace.visual.nodes.find((node) => node.id === id)?.label).filter(Boolean);
    annotations.push({ id: "observed-change", tone: "warning", title: "Observed change", copy: `${labels.join(", ") || "Affected component"} is linked to recorded change evidence.` });
  }
  setAnnotations(annotations.slice(-2));
  els["twin-canvas"].setAttribute("aria-label", `${INCIDENT_STAGES.find((stage) => stage.id === incidentStage)?.label || "Incident"} workspace.`);
  renderIncidentStagePanel(shared);
  startIncidentFocusSignals();
}

function canonicalDiagnosisCaption(shared) {
  const incident = shared.events.find((event) => event.type === "local_fault_loop.fault.injected") || shared.events.at(-1);
  const count = shared.events.length;
  return `${incident?.recorded_at ? formatTime(incident.recorded_at) : "Recorded incident"} · ${count} recorded update${count === 1 ? "" : "s"}`;
}

function renderCanonicalCompareCanvas(shared) {
  const topology = shared.topology;
  const verification = incidentVerificationProjection(shared);
  const verified = verification.passed;
  const incident = incidentFocusLayerMarkup(topology, topology.snapshots.incident, { layerName: "before", workspace: "compare", pulse: true });
  bindCanonicalCanvasIdentity(incident.visual, "compare-canvas", verified ? "verified" : "verification_pending");
  if (incident.visual.availability !== "ready") {
    renderCanonicalTopologyPending("Compare is waiting for a complete canonical incident snapshot.");
    return;
  }
  if (!verified) {
    els["canvas-layers"].innerHTML = incidentFocusLayerMarkup(topology, topology.snapshots.incident, { layerName: "current", workspace: "compare", pulse: false }).markup;
    els["compare-handle"].hidden = true;
    els["compare-canvas-range"].hidden = true;
    setAnnotations([{ id: "recovery", tone: "warning", title: verification.failed ? "Verification failed" : "Verification pending", copy: verification.failed ? "A repair was executed, but independent verification failed. Review the recorded evidence before another action." : "Compare remains locked until this run records passed independent verification." }]);
    els["twin-canvas"].setAttribute("aria-label", verification.failed ? "Verification failed after a recorded repair." : "Verification is pending for the recorded repair.");
    return;
  }
  const recovered = incidentFocusLayerMarkup(topology, topology.snapshots.verified, { layerName: "after", workspace: "compare", pulse: false });
  if (recovered.visual.availability !== "ready") {
    renderCanonicalTopologyPending("Compare is waiting for a complete canonical verified snapshot.");
    return;
  }
  els["canvas-layers"].innerHTML = `${recovered.markup}${incident.markup}`;
  els["compare-handle"].hidden = false;
  els["compare-canvas-range"].hidden = false;
  setAnnotations([]);
  els["twin-canvas"].setAttribute("aria-label", "Compare incident and verified snapshots.");
  els["compare-canvas-range"].setAttribute("aria-label", "Compare incident and verified recovery");
  renderComparePosition();
  startIncidentFocusSignals();
}

function incidentActionLabel(value, fallback) {
  const text = typeof value === "string" ? value.replaceAll("_", " ").trim() : "";
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : fallback;
}

function renderIncidentStagePanel(shared) {
  const panel = els["incident-stage-panel"];
  if (!isIncidentWorkspace() || !shared) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const events = shared.events || [];
  const plan = [...events].reverse().find((event) => event.type === "local_fault_loop.plan.proposed");
  const authority = [...events].reverse().find((event) => event.type === "local_fault_loop.authority.decided");
  const repair = [...events].reverse().find((event) => event.type === "local_fault_loop.repair.executed");
  const workflow = incidentWorkflowEvidence(events);
  const verification = incidentVerificationProjection(shared);
  const stage = INCIDENT_STAGES.find((item) => item.id === incidentStage);
  const common = `<header><span>${escapeHtml(stage?.label || "Incident")}</span><strong>${escapeHtml(workflow.verificationFailed ? "Verification failed" : humanStageLabel(shared.stage))}</strong></header>`;
  if (incidentStage === "investigate") {
    panel.hidden = false;
    panel.innerHTML = `${common}<p>Follow the highlighted causal path. Ask an agent for evidence or select a service for its current context.</p><button type="button" data-agent-team-role="investigator">Ask Investigator</button>`;
    return;
  }
  if (incidentStage === "decide") {
    panel.hidden = false;
    const scope = incidentActionLabel(plan?.payload?.scope || plan?.payload?.action || plan?.payload?.repair, "Plan not recorded");
    panel.innerHTML = `${common}<dl><div><dt>Scope</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(plan?.payload?.risk || "Not evaluated")}</dd></div><div><dt>Owner gate</dt><dd>${escapeHtml(recoveryGateLabel(events))}</dd></div></dl><p>Approval remains a backend-recorded owner decision.</p><button type="button" data-agent-team-role="orchestrator">Ask Orchestrator</button>`;
    return;
  }
  if (incidentStage === "execute") {
    const workflow = recoveryWorkflowProjection(events);
    const active = workflow?.nodes?.find((node) => node.status === "running") || workflow?.nodes?.find((node) => node.id === workflow?.currentId);
    const workingNow = active?.label || (repair ? "Repair completed" : authority ? "Awaiting execution" : "Awaiting owner decision");
    panel.hidden = false;
    const recordedAction = repair
      ? `${incidentActionLabel(repair.payload?.repair, "Recorded repair")} · ${incidentActionLabel(repair.payload?.result, "Completed")}`
      : "Agents only report server-recorded work; they do not bypass the gate.";
    panel.innerHTML = `${common}<dl><div><dt>Execution</dt><dd>${escapeHtml(repair ? "Recorded" : authority ? recoveryGateLabel(events) : "Awaiting owner decision")}</dd></div><div><dt>Working now</dt><dd>${escapeHtml(workingNow)}</dd></div><div><dt>Verification</dt><dd>${escapeHtml(verification.passed ? "Passed" : verification.failed ? "Failed" : "Pending independent check")}</dd></div></dl><p>${escapeHtml(recordedAction)}</p><button type="button" data-agent-team-role="orchestrator">Ask Orchestrator</button>`;
    return;
  }
  panel.hidden = false;
  const verificationLabel = verification.passed ? "Passed" : verification.failed ? "Failed" : "Awaiting independent check";
  const verificationCopy = verification.passed
    ? "Drag the divider to compare the incident snapshot with independently verified recovery."
    : verification.failed
      ? "A repair was executed, but independent verification failed. Review the recorded evidence before another action."
      : "Compare stays locked until the backend records independent verification.";
  panel.innerHTML = `${common}<dl><div><dt>Verification</dt><dd>${escapeHtml(verificationLabel)}</dd></div><div><dt>Snapshots</dt><dd>${escapeHtml(verification.passed ? "Incident and verified" : "Incident only")}</dd></div><div><dt>Evidence</dt><dd>${escapeHtml(`${shared.citations.length} cited records`)}</dd></div></dl><p>${escapeHtml(verificationCopy)}</p><button type="button" data-agent-team-role="evaluator">Ask Evaluator</button>`;
}

function renderIncidentStageRail(focusedStage = null) {
  const rail = els["incident-stage-rail"];
  const shared = sharedRunModel();
  rail.hidden = !isIncidentWorkspace();
  if (!isIncidentWorkspace()) {
    rail.innerHTML = "";
    return;
  }
  const evidence = incidentStageEvidence(shared);
  rail.innerHTML = INCIDENT_STAGES.map((stage, index) => {
    const active = stage.id === incidentStage;
    const enabled = Boolean(shared && evidence[stage.id]);
    const stageStatus = !enabled ? "Pending" : active ? (stage.id === authoritativeIncidentStage ? "Current" : "Viewing") : "Recorded";
    return `<button type="button" class="incident-stage-button ${active ? "is-active" : ""}" data-incident-stage="${stage.id}" aria-current="${active ? "step" : "false"}" ${enabled ? "" : "disabled"}><span>${index + 1}</span><strong>${escapeHtml(stage.label)}</strong><small>${stageStatus}</small></button>`;
  }).join("");
  if (INCIDENT_STAGES.some((stage) => stage.id === focusedStage)) rail.querySelector(`[data-incident-stage="${focusedStage}"]`)?.focus({ preventScroll: true });
}

function renderCanonicalTopologyPending(message = "Waiting for the backend-owned canonical topology projection.") {
  const incident = isIncidentWorkspace();
  const diagnose = mode === "replay";
  const title = incident ? "Start a guided incident replay" : diagnose ? "Diagnose needs an active incident" : "This workspace is not ready yet";
  const guidance = incident
    ? "Create a backend-owned canonical run, then follow its recorded evidence through the staged workspace."
    : diagnose
      ? "Start or select an incident in Live, then return when the server has projected the matching evidence."
      : message;
  const start = incident && !sharedRun?.run_id
    ? `<button type="button" class="button approve" data-start-guided-replay data-testid="start-guided-incident-replay" ${agentTeam.starting ? "disabled" : ""}>${agentTeam.starting ? "Starting replay…" : "Run guided replay"}</button>`
    : "";
  els["canvas-layers"].innerHTML = `<div class="source-empty canonical-workspace-pending"><i class="ph ph-circle-notch" aria-hidden="true"></i><strong>${title}</strong><span>${escapeHtml(guidance)}</span>${start}</div>`;
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  setAnnotations([]);
  clearCanonicalCanvasIdentity();
  els["twin-canvas"].setAttribute("aria-label", message);
}

// This complete-topology renderer remains for complete canonical surfaces.
// Incident workspaces use incidentFocusLayerMarkup below instead.
function canonicalTopologyLayerMarkup(topology, snapshot, { layerName = "current", pulse = false } = {}) {
  const visual = canonicalWorkspaceVisual(topology, snapshot);
  if (visual.availability !== "ready") return { visual, markup: "" };
  const positioned = livePositions(visual.nodes);
  const positions = new Map(positioned.map((node) => [node.id, node]));
  const nodeStates = Object.fromEntries(visual.nodes.map((node) => [node.id, node.status]));
  const source = {
    status: visual.source_truth?.source_health || "unavailable",
    label: visual.source_truth?.label || "Canonical source unavailable"
  };
  const runtimeEdges = visual.edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to));
  const renderedEdges = runtimeEdges;
  const pulseEdges = runtimeEdges.filter((edge) => edge.kind === "calls");
  const pulseSlots = livePulseSlots({ nodes: visual.nodes, edges: pulseEdges });
  const signalOrder = new Map(orderedSignalEdges(pulseEdges, pulseSlots).map((edge, index) => [edge.id, index]));
  const routeBuildOrder = new Map(orderedLiveRouteBuildEdges(renderedEdges, positioned).map((edge, index) => [edge.id, index]));
  const edges = renderedEdges.map((edge, index) => {
    const visualEdge = {
      ...edge,
      order: signalOrder.get(edge.id) ?? pulseEdges.length + index,
      routeOrder: routeBuildOrder.get(edge.id) ?? index,
      pulse: pulse && edge.kind === "calls",
      tone: edge.status,
      presentation: "standard"
    };
    const path = liveEdgePath(positions.get(edge.from), positions.get(edge.to), {
      canvasWidth: LIVE_WORLD.width,
      canvasHeight: LIVE_WORLD.height,
      nodeWidth: 180,
      nodeHeight: 60,
      lane: visualEdge.order
    });
    return fixedLiveEdgeMarkup(visualEdge, path, positions.get(edge.from)?.label || edge.from, positions.get(edge.to)?.label || edge.to);
  }).join("");
  const nodes = positioned.map((node) => sourceNodeMarkup(node, { layout: "live", source, nodeStates })).join("");
  const markup = `<div class="twin-layer layer-${escapeHtml(layerName)} canonical-topology-layer" data-canonical-run-id="${escapeHtml(visual.run_id)}" data-canonical-incident-id="${escapeHtml(visual.incident_id)}" data-projection-revision="${escapeHtml(visual.projection_revision)}" data-node-ids="${escapeHtml(visual.node_ids.join(","))}" data-edge-ids="${escapeHtml(visual.edge_ids.join(","))}" data-rendered-relation-count="${renderedEdges.length}"><svg class="edge-map fixed-live-edge-map" viewBox="0 0 ${LIVE_WORLD.width} ${LIVE_WORLD.height}" preserveAspectRatio="none">${edges}</svg>${nodes}</div>`;
  return { visual, markup };
}

// The focused incident workspaces deliberately share one pure server-owned
// projection. Architecture and Live continue to call their complete-topology
// renderers; this function is never a fallback for either view.
function incidentFocusLayerMarkup(topology, snapshot, { layerName = "current", workspace = "diagnose", pulse = false } = {}) {
  const focus = incidentFocusWorkspace(topology, snapshot, diagnoseViewTopology(state?.topology_views), {
    canvasWidth: LIVE_WORLD.width,
    canvasHeight: LIVE_WORLD.height,
    nodeWidth: 172,
    nodeHeight: 62
  });
  if (focus.availability !== "ready") return { visual: focus, markup: "" };
  const source = {
    status: focus.source_truth?.source_health || "unavailable",
    label: focus.source_truth?.label || "Canonical source unavailable"
  };
  const nodeStates = Object.fromEntries(focus.nodes.map((node) => [node.id, node.status]));
  // The Diagnose/incident Compare side uses the explicitly server-projected
  // overlay as its causal snapshot. Recovery and verified Compare retain their
  // recorded snapshot statuses instead of recoloring browser-side.
  if (workspace === "diagnose" || layerName === "before") {
    for (const node of focus.nodes) nodeStates[node.id] = "impact";
  }
  const markup = incidentFocusGraphMarkup({
    layerName,
    workspace,
    identity: { runId: focus.run_id, incidentId: focus.incident_id, revision: focus.projection_revision },
    nodes: focus.nodes.map((node) => {
      const state = nodeStates[node.id] || "observed";
      const profile = sourceComponentProfile(node);
      return { ...node, state, statusLabel: incidentFocusStatusLabel(state), ariaLabel: `${profile.capability}, ${kindLabel(node.kind)}, ${incidentFocusStatusLabel(state)}`, icon: iconForLive(node), transitionKey: transitionKey(node.id) };
    }),
    edges: focus.edges.map((edge) => ({
      ...edge,
      tone: workspace === "diagnose" || layerName === "before" ? "impact" : edge.status,
      pulse,
      ariaLabel: `${edge.label} from ${focus.nodes.find((node) => node.id === edge.from)?.label || edge.from} to ${focus.nodes.find((node) => node.id === edge.to)?.label || edge.to}`
    }))
  });
  return { visual: focus, markup };
}

function startIncidentFocusSignals() {
  if (!els["canvas-layers"].querySelector(".incident-focus-workspace [data-live-edge-id]")) return;
  applyIncidentFocusRouteDelays();
  // Focus nodes finish their one bounded entrance independently. Keep the
  // long-running signal loop on edges only so a packet cannot restart or
  // override a card's settled visibility during review or selection.
  clearLiveSignalClasses();
  requestAnimationFrame(() => startLiveSignalLoop({ nodeFeedback: false }));
}

function applyIncidentFocusRouteDelays() {
  for (const group of els["canvas-layers"].querySelectorAll(".incident-focus-workspace [data-live-route]")) {
    const delay = Number(group.dataset.routeOrder) * 54;
    const line = group.querySelector(".edge-line");
    if (Number.isSafeInteger(delay) && delay >= 0 && line) line.style.animationDelay = `${delay}ms`;
  }
}

function bindCanonicalCanvasIdentity(visual, testId, compareState = null) {
  if (visual.availability !== "ready") {
    clearCanonicalCanvasIdentity();
    return;
  }
  els["twin-canvas"].setAttribute("data-testid", testId);
  els["twin-canvas"].dataset.runId = visual.run_id;
  els["twin-canvas"].dataset.incidentId = visual.incident_id;
  els["twin-canvas"].dataset.projectionRevision = visual.projection_revision;
  els["twin-canvas"].dataset.canonicalNodeIds = visual.node_ids.join(",");
  els["twin-canvas"].dataset.canonicalEdgeIds = visual.edge_ids.join(",");
  if (compareState) els["twin-canvas"].dataset.compareState = compareState;
  else delete els["twin-canvas"].dataset.compareState;
}

function clearCanonicalCanvasIdentity() {
  for (const key of ["runId", "incidentId", "projectionRevision", "canonicalNodeIds", "canonicalEdgeIds", "compareState"]) delete els["twin-canvas"].dataset[key];
  els["twin-canvas"].setAttribute("data-testid", "canonical-topology-pending");
}

function renderSourceCanvas(layout, runTopology = null, ariaLabel = null) {
  const topologyTestId = layout === "architecture"
    ? "architecture-topology"
    : mode === "replay"
      ? "diagnose-topology"
      : mode === "compare"
        ? "compare-topology"
        : "live-topology";
  els["twin-canvas"].setAttribute("data-testid", topologyTestId);
  const architecture = layout === "architecture" ? architectureView() : null;
  const live = layout === "live" ? liveTopologyView() : null;
  const source = runTopology
    ? { status: runTopology.source_truth.source_health, label: runTopology.source_truth.label, topology: runTopology.graph, evidence: [], counts: {}, freshness_ms: null }
    : architecture ? architectureSource(architecture) : liveSource(live);
  const sourceTopology = architecture
    ? architecture.graph
    : runTopology?.graph
      ? topologyIntegrity({ nodes: runTopology.graph.nodes, edges: runTopology.graph.edges })
    : live?.runtime_data.graph
      ? topologyIntegrity({
        nodes: live.runtime_data.graph.nodes,
        edges: [...live.runtime_data.graph.edges, ...(live.runtime_data.supporting_relations || [])]
      })
      : null;
  const topology = layout === "live" && sourceTopology ? connectedLiveTopology(sourceTopology) : sourceTopology;
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  setAnnotations([]);
  if (!topology?.nodes?.length) {
    els["canvas-layers"].innerHTML = `<div class="source-empty">
      <i class="ph ph-plugs" aria-hidden="true"></i>
      <strong>${layout === "architecture" ? "Architecture projection unavailable" : "Live projection unavailable"}</strong>
      <span>${layout === "architecture" ? "The backend-owned complete topology view is missing or invalid. The six-node incident compatibility graph is not used as a fallback." : "The backend-owned Live topology view is missing or invalid. The compatibility source topology is not used as a fallback."}</span>
    </div>`;
    els["twin-canvas"].setAttribute("aria-label", layout === "architecture" ? "Architecture projection unavailable." : "Live projection unavailable.");
    return;
  }
  const positioned = layout === "architecture" ? null : livePositions(topology.nodes);
  const nodeStates = {
    ...Object.fromEntries(topology.nodes.map((node) => [node.id, node.status])),
    ...(runTopology?.current?.node_statuses || {})
  };
  if (layout === "architecture") {
    const boundaries = architectureBoundaries(topology);
    const selectedArchitectureDetail = architectureDetail?.scope === "architecture" ? architectureDetailContext(architectureDetail.nodeId) || controlDetailContext(architectureDetail.nodeId) : null;
    if (architectureDetail && (!selectedArchitectureDetail || !["runtime", "data", "control", "evidence"].includes(selectedArchitectureDetail.node.plane))) architectureDetail = null;
    const layerGroups = ARCHITECTURE_LAYERS.map((layer) => ({
      ...layer,
      members: boundaries.observed.nodes.filter((node) => node.layer === layer.id)
    }));
    const layerModules = layerGroups.map((layer) => {
      const layerStatus = architectureLayerStatus(layer.members);
      const detail = ["runtime", "data"].includes(selectedArchitectureDetail?.node.plane) && selectedArchitectureDetail?.node.layer === layer.id ? selectedArchitectureDetail : null;
      const anatomy = layer.members.map((node) => architectureThumbnailMarkup(node, nodeStates[node.id])).join("");
      const content = detail
        ? architectureComponentDetailMarkup(detail)
        : `<span class="architecture-layer-copy"><span class="architecture-layer-title"><strong>${escapeHtml(layer.label)}</strong></span></span>
          <span class="architecture-layer-anatomy" role="list" aria-label="${escapeHtml(layer.label)} components" data-architecture-member-count="${layer.members.length}">${anatomy}</span>`;
      return `<article class="architecture-layer-module is-${escapeHtml(layerStatus)}${detail ? " is-detail" : ""}" data-architecture-layer="${escapeHtml(layer.id)}" aria-label="${escapeHtml(detail ? `${detail.node.label} component detail. Click anywhere in this detail or press Escape to return to components.` : `${layer.label}, ${layer.members.length} components.`)}">${content}${detail ? "" : '<span class="architecture-status-dot" aria-hidden="true"></span>'}</article>`;
    }).join("");
    els["canvas-layers"].innerHTML = `<div class="twin-layer layer-current architecture-systems is-complete-topology">
      <section class="architecture-system architecture-observed-system" aria-label="Observed System Data Source Architecture">
        <span class="visually-hidden">Observed System Data Source Architecture. ${boundaries.observed.nodes.length} components and ${boundaries.observed.relations.length} backend-projected dependencies.</span>
        <div class="architecture-layer-grid">${layerModules}</div>
      </section>
      <div class="architecture-control-slot" aria-hidden="true"></div>
    </div>`;
    els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
    els["twin-canvas"].dataset.unlinkedNodes = "0";
    els["twin-canvas"].dataset.runtimeEdges = String(architecture.runtime_data.edge_count);
    els["twin-canvas"].dataset.controlRelations = String(architecture.control_system.relation_count);
    els["twin-canvas"].dataset.crossBoundaryRelations = String(architecture.external_change_evidence.relation_count);
    els["twin-canvas"].setAttribute("aria-label", `Static Observed System Architecture with ${boundaries.observed.nodes.length} runtime/data components and ${boundaries.observed.relations.length} retained runtime dependencies, separate from the FlowPulse Control System with ${boundaries.flowpulse.nodes.length} control/evidence components and ${architecture.external_change_evidence.relation_count} backend-projected external change evidence relations.`);
    return;
  }
  const positions = new Map(positioned.map((node) => [node.id, node]));
  // Live renders the complete canonical runtime graph. The source projection owns
  // endpoint validity, status and identity; this layer only assigns deterministic
  // visual routes and pulse timing.
  const runtimeEdges = topology.edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to));
  const pulseEdges = runtimeEdges.filter((edge) => edge.kind === "calls");
  const pulseSlots = livePulseSlots({ ...topology, edges: pulseEdges });
  const signalOrder = new Map(orderedSignalEdges(pulseEdges, pulseSlots).map((edge, index) => [edge.id, index]));
  const routeBuildOrder = new Map(orderedLiveRouteBuildEdges(runtimeEdges, positioned).map((edge, index) => [edge.id, index]));
  const nodes = positioned.map((node) => sourceNodeMarkup(node, { layout, source, nodeStates })).join("");
  const unlinkedPositionedNodes = positioned.filter((node) => node.layer === LIVE_UNLINKED_LAYER.id).length;
  const guideLayers = [...LIVE_LAYERS, ...(unlinkedPositionedNodes ? [LIVE_UNLINKED_LAYER] : [])];
  const guides = `<div class="live-guides" aria-hidden="true">${guideLayers.map((layer, index) => `<span class="live-guide-${index}">${escapeHtml(layer.label)}</span>`).join("")}</div>${topology.invalid_edges.length ? `<div class="topology-warning"><i class="ph ph-warning" aria-hidden="true"></i>${topology.invalid_edges.length} invalid dependency endpoint${topology.invalid_edges.length === 1 ? "" : "s"} omitted</div>` : ""}`;
  const plannedEdges = runtimeEdges.map((edge, index) => ({
    ...edge,
    order: signalOrder.get(edge.id) ?? pulseEdges.length + index,
    routeOrder: routeBuildOrder.get(edge.id) ?? index,
    pulse: edge.kind === "calls",
    tone: runTopology?.current?.edge_statuses?.[edge.id] || liveSignalTone(edge, nodeStates)
  }));
  // The Live view uses authored topology routes, not a generic obstacle solver.
  // Node coordinates and every port are derived from the same fixed world, so a
  // route always lands on the visible component that owns the dependency.
  const liveEdges = plannedEdges.map((edge) => {
    const path = liveEdgePath(positions.get(edge.from), positions.get(edge.to), {
      canvasWidth: LIVE_WORLD.width,
      canvasHeight: LIVE_WORLD.height,
      nodeWidth: 180,
      nodeHeight: 60,
      lane: edge.order
    });
    return fixedLiveEdgeMarkup(edge, path, positions.get(edge.from)?.label || edge.from, positions.get(edge.to)?.label || edge.to);
  }).join("");
  els["canvas-layers"].innerHTML = `${guides}<div class="twin-layer layer-current"><svg class="edge-map fixed-live-edge-map" viewBox="0 0 ${LIVE_WORLD.width} ${LIVE_WORLD.height}" preserveAspectRatio="none">${liveEdges}</svg>${nodes}</div>`;
  // A shared incident is driven entirely by the server's event stream. Preserve
  // the legacy visual pulse only for the standalone captured topology, never as
  // a surrogate for an active run's metrics or edge state.
  if (!runTopology && !sharedRunModel()) {
    applyLiveRouteDelays();
    const linkDuration = Math.min(1500, 340 + plannedEdges.length * 32);
    const renderGeneration = liveSignalGeneration;
    setTimeout(() => {
      if (renderGeneration === liveSignalGeneration && mode === "live") startLiveSignalLoop();
    }, linkDuration);
  }
  els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
  els["twin-canvas"].dataset.unlinkedNodes = String(topology.unlinked_node_ids.length);
  els["twin-canvas"].dataset.observedEdges = String(topology.edges.length);
  els["twin-canvas"].dataset.displayedEdges = String(runtimeEdges.length);
  if (runTopology) {
    els["twin-canvas"].dataset.runId = runTopology.run_id;
    els["twin-canvas"].dataset.incidentId = runTopology.incident_id;
    els["twin-canvas"].dataset.projectionRevision = runTopology.projection_revision;
    els["twin-canvas"].dataset.canonicalNodeCount = String(runTopology.node_ids.length);
    els["twin-canvas"].dataset.canonicalEdgeCount = String(runTopology.edge_ids.length);
  }
  setAnnotations(mode === "replay" ? developmentAnnotations(cursor) : []);
  els["twin-canvas"].setAttribute("aria-label", ariaLabel || `Runtime topology with ${positioned.length} observed services. ${runtimeEdges.length} projected dependency paths are rendered from ${topology.edges.length} authoritative dependencies${unlinkedPositionedNodes ? `, with ${unlinkedPositionedNodes} components lacking dependency evidence` : ""}.`);
}

function architectureLayerStatus(nodes) {
  const rank = ["root", "impact", "rejected", "fault", "pending", "warning", "change", "approval", "active", "recording", "healthy", "verified", "learned", "observed", "sleeping", "idle", "quiet", "dormant"];
  const order = (status) => {
    const index = rank.indexOf(status);
    return index === -1 ? rank.length : index;
  };
  return [...nodes].map((node) => node.status || "observed").sort((left, right) => order(left) - order(right))[0] || "observed";
}

function architectureThumbnailMarkup(node, status = "observed") {
  return `<span role="listitem"><button class="architecture-thumbnail-node is-${escapeHtml(status)}" type="button" title="${escapeHtml(node.label)}" data-architecture-thumbnail-id="${escapeHtml(node.id)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" aria-label="Show ${escapeHtml(node.label)} component detail. ${escapeHtml(kindLabel(node.kind))}, ${escapeHtml(statusLabel(status))}"><span class="architecture-thumbnail-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><span class="architecture-thumbnail-label">${escapeHtml(node.label)}</span><span class="architecture-status-dot" aria-hidden="true"></span></button></span>`;
}

function controlSystemTileMarkup(node, { rail = false } = {}) {
  const interaction = rail
    ? `data-agent-team-role="${escapeHtml(node.id)}"`
    : `data-control-node-id="${escapeHtml(node.id)}" data-architecture-control-id="${escapeHtml(node.id)}"`;
  return `<button class="source-node is-architecture-compact control-system-tile plane-${escapeHtml(node.plane || "control")} kind-${escapeHtml(node.kind)} is-${escapeHtml(node.status || "idle")}" type="button" ${interaction} data-status="${escapeHtml(agentNodeTone(node.status))}" aria-label="Show ${escapeHtml(node.label)} details. ${escapeHtml(statusLabel(node.status || "idle"))}">
    <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span>
    <span class="node-copy"><strong>${escapeHtml(node.label)}</strong></span>
    <span class="node-status-dot is-${escapeHtml(node.status || "idle")}" aria-hidden="true"></span>
  </button>`;
}

function sourceNodeMarkup(node, { layout, source, nodeStates, presentation = "standard", transitionIndex = null }) {
  const nodeState = node.connectivity === "unlinked" ? "unlinked" : nodeStates[node.id] || "dormant";
  const nodeStatus = layout === "incident-focus" ? incidentFocusStatusLabel(nodeState) : sourceStatusLabel(nodeState, source.status);
  const ariaStatus = nodeState === "unlinked" ? "Insufficient dependency evidence" : nodeStatus;
  const profile = sourceComponentProfile(node);
  // Live positions are a fixed, CSS-authored grid. The route world consumes the
  // same canonical percentages through livePositions(), so port geometry and
  // card placement cannot drift apart at a given viewport.
  const livePositionClass = layout === "live" ? ` live-column-${node.layerIndex} live-count-${node.layerSize} live-index-${node.layerPosition}` : layout === "incident-focus" ? " incident-focus-node" : "";
  // The focus canvas deliberately owns its port geometry. The helper emits a
  // bounded grid (four lanes by three rows), so semantic position classes keep
  // the authored port map stable while the general Live 50/50 baseline remains
  // available to the full topology.
  const incidentPositionClass = layout === "incident-focus"
    ? ` incident-focus-x-${Math.round(Number(node.x))} incident-focus-y-${Math.round(Number(node.y))}`
    : "";
  // The focused workspace is rendered alongside SVG relation groups, so CSS
  // structural selectors are not a reliable way to stagger node entry. Keep
  // the bounded order in the server-projected focus array instead.
  const incidentEntryClass = layout === "incident-focus" && Number.isInteger(transitionIndex)
    ? ` incident-focus-enter-${transitionIndex}`
    : "";
  const activeStatus = layout === "incident-focus" || ["impact", "root", "rejected", "warning", "pending", "active", "recording", "verified"].includes(nodeState) ? `<span class="node-status">${escapeHtml(nodeStatus)}</span>` : "";
  const signal = layout === "incident-focus" && node.signal ? `<span class="node-signal is-${escapeHtml(node.signal.tone)}">${escapeHtml(node.signal.value)}</span>` : "";
  const copy = `<span class="node-copy"><strong>${escapeHtml(node.label)}</strong>${activeStatus}${signal}</span>`;
  return `<button class="twin-node source-node plane-${escapeHtml(node.plane || "runtime")} kind-${escapeHtml(node.kind)} is-${nodeState} presentation-${escapeHtml(presentation)}${livePositionClass}${incidentPositionClass}${incidentEntryClass}" type="button" data-node-id="${escapeHtml(node.id)}" data-status="${escapeHtml(nodeState)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" aria-label="${escapeHtml(profile.capability)}, ${escapeHtml(kindLabel(node.kind))}, ${escapeHtml(ariaStatus)}">
    <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span>
    ${copy}
    <span class="node-status-dot" aria-hidden="true"></span>
  </button>`;
}

function incidentFocusStatusLabel(status) {
  const labels = {
    impact: "Affected",
    root: "Root cause",
    active: "In progress",
    verified: "Verified",
    observed: "Observed"
  };
  return labels[status] || "Status unavailable";
}

function liveSignalTone(edge, nodeStates) {
  if (nodeStates[edge.from] === "impact" || nodeStates[edge.to] === "impact") return "impact";
  const verified = incidentWorkflowEvidence(canonicalEvents()).verificationPassed;
  if (verified && ["checkout", "payment", "kafka", "accounting", "fraud-detection", "fraud"].some((id) => id === edge.from || id === edge.to)) return "verified";
  return "observed";
}

function applyLiveRouteDelays() {
  // Safari/WebKit does not reliably resolve a custom property in SVG animation
  // timing. Set the same deterministic delay through the SVG style API after
  // the markup exists so connection construction remains visibly staggered.
  for (const group of els["canvas-layers"].querySelectorAll("[data-live-route]")) {
    const delay = Number(group.dataset.routeOrder) * 32;
    const line = group.querySelector(".edge-line");
    if (Number.isSafeInteger(delay) && delay >= 0 && line) line.style.animationDelay = `${delay}ms`;
  }
}

function fixedLiveEdgeMarkup(edge, path, fromLabel, toLabel) {
  const label = `${edge.label} from ${fromLabel} to ${toLabel}`;
  const pulse = edge.pulse ? `data-live-edge-id="${escapeHtml(edge.id)}" data-live-projectile="single" data-signal-from="${escapeHtml(edge.from)}" data-signal-to="${escapeHtml(edge.to)}" data-signal-order="${edge.order}"` : "";
  // Projectiles start fully masked. The active class only changes display, so
  // this prevents one full-path paint before its first animation frame arrives.
  return `<g class="edge-group path-runtime relation-${escapeHtml(edge.kind)} signal-${escapeHtml(edge.tone)} presentation-${escapeHtml(edge.presentation || "standard")}" ${pulse} data-edge-id="${escapeHtml(edge.id)}" data-live-route="canonical-authored" data-route-order="${edge.routeOrder}"><path class="edge-line is-${escapeHtml(edge.tone)}" pathLength="1000" d="${path}"/><path class="signal-projectile signal-projectile-halo" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000" d="${path}" aria-hidden="true"/><path class="signal-projectile signal-projectile-core" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000" d="${path}" aria-hidden="true"/><path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" data-edge-id="${escapeHtml(edge.id)}" data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"/></g>`;
}

function positionLiveProjectile(path, projectile, progress, pathLength) {
  if (!projectile || !pathLength) return;
  // The packet is a short visible section of the exact canonical path, so it
  // follows every rounded elbow without reconstructing or drifting from it.
  const packetLength = Math.min(68, Math.max(32, pathLength * .065));
  const end = Math.max(0, Math.min(1000, progress * 1000));
  const normalizedPacketLength = Math.min(1000, packetLength * 1000 / pathLength);
  const start = Math.max(0, end - normalizedPacketLength);
  const visible = end - start;
  projectile.setAttribute("stroke-dasharray", `${visible.toFixed(3)} 1000`);
  projectile.setAttribute("stroke-dashoffset", `${(visible + 1000 - start).toFixed(3)}`);
}

function liveSignalTiming(pathLength) {
  const launch = .12;
  const terminal = .2;
  const naturalDuration = liveSignalDuration(pathLength, 760, launch, terminal);
  const duration = Math.max(720, Math.min(1600, naturalDuration));
  const speed = Math.max(1, pathLength * (1 + launch + terminal) * 1000 / duration);
  return { duration, speed, launch, terminal };
}

function scheduleLiveSignalFrame(callback) {
  // A timer-driven frame keeps the continuous pulse active in embedded review
  // webviews that throttle requestAnimationFrame for non-focused canvases.
  const frame = setTimeout(() => {
    liveSignalFrames.delete(frame);
    callback(Date.now());
  }, 16);
  liveSignalFrames.add(frame);
}

function startLiveSignalLoop({ nodeFeedback = true } = {}) {
  const groups = [...els["canvas-layers"].querySelectorAll("[data-live-edge-id]")]
    .sort((a, b) => Number(a.dataset.signalOrder) - Number(b.dataset.signalOrder));
  if (!groups.length) return;
  const nodes = new Map([...els["canvas-layers"].querySelectorAll("[data-node-id]")].map((node) => [node.dataset.nodeId, node]));
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const generation = liveSignalGeneration;
  // A bounded set of staggered lanes depicts concurrent captured traffic
  // without claiming that the browser observed live parallel execution.
  const concurrentPulseCount = Math.min(3, groups.length);
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      liveSignalTimers = liveSignalTimers.filter((candidate) => candidate !== timer);
      if (generation === liveSignalGeneration) callback();
    }, delay);
    liveSignalTimers.push(timer);
  };
  const nextGroup = (group) => {
    const index = groups.indexOf(group);
    return groups[(index + concurrentPulseCount) % groups.length];
  };
  const activate = (group) => {
    if (generation !== liveSignalGeneration) return;
    const from = nodes.get(group.dataset.signalFrom);
    const to = nodes.get(group.dataset.signalTo);
    if (nodeFeedback) from?.classList.add("is-signal-launch");
    if (reduced) {
      if (nodeFeedback) {
        from?.classList.remove("is-signal-launch");
        to?.classList.add("is-signal-arrival");
      }
      return;
    }
    const path = group.querySelector(".edge-line");
    const halo = group.querySelector(".signal-projectile-halo");
    const core = group.querySelector(".signal-projectile-core");
    if (!path || !core) return;
    const pathLength = path.getTotalLength();
    const timing = liveSignalTiming(pathLength);
    const duration = timing.duration;
    group.dataset.signalProgress = "0";
    group.dataset.signalPathLength = pathLength.toFixed(1);
    group.dataset.signalDuration = Math.round(duration);
    group.dataset.signalSpeed = timing.speed.toFixed(1);
    positionLiveProjectile(path, halo, 0, pathLength);
    positionLiveProjectile(path, core, 0, pathLength);
    group.classList.add("is-signal-active");
    let startedAt = null;
    const travel = (timestamp) => {
      if (generation !== liveSignalGeneration) return;
      startedAt ??= timestamp;
      const elapsed = timestamp - startedAt;
      const progress = liveSignalProgress(elapsed, pathLength, timing.speed, timing.launch, timing.terminal);
      group.dataset.signalProgress = progress.toFixed(3);
      positionLiveProjectile(path, halo, progress, pathLength);
      positionLiveProjectile(path, core, progress, pathLength);
      if (elapsed < duration && progress < 1) {
        scheduleLiveSignalFrame(travel);
        return;
      }
      scheduleLiveSignalFrame(() => {
        if (generation !== liveSignalGeneration) return;
        group.classList.remove("is-signal-active");
        if (nodeFeedback) {
          from?.classList.remove("is-signal-launch");
          to?.classList.add("is-signal-arrival");
          schedule(() => to?.classList.remove("is-signal-arrival"), 320);
        }
        schedule(() => activate(nextGroup(group)), 180);
      });
    };
    scheduleLiveSignalFrame(travel);
  };

  liveSignalIndex = Math.min(liveSignalIndex, groups.length - 1);
  clearLiveSignalClasses();
  groups.slice(0, concurrentPulseCount).forEach((group, index) => schedule(() => activate(group), index * 120));
}

function stopLiveSignalLoop() {
  liveSignalGeneration += 1;
  for (const frame of liveSignalFrames) clearTimeout(frame);
  liveSignalFrames.clear();
  for (const timer of liveSignalTimers) clearTimeout(timer);
  liveSignalTimers = [];
  clearLiveSignalClasses();
}

function clearLiveSignalClasses() {
  for (const group of els["canvas-layers"].querySelectorAll(".edge-group.is-signal-active")) group.classList.remove("is-signal-active");
  for (const node of els["canvas-layers"].querySelectorAll(".is-signal-launch, .is-signal-arrival")) {
    node.classList.remove("is-signal-launch", "is-signal-arrival", "signal-observed", "signal-impact", "signal-verified", "signal-change", "signal-approval");
  }
}

function renderAgentCanvas() {
  const shared = sharedRunModelAtCursor();
  if (shared) {
    renderSharedRecoveryCanvas(shared);
    return;
  }
  const control = agentControl();
  const team = projectAgentCollaborators(control);
  const report = control.report;
  const currentStage = report.stage || state.stage;
  const reportTitle = /^legacy_|_unavailable$/.test(report.title || "") ? "Recovery details unavailable" : report.title;
  const reportNarrative = /^(legacy_|.*_unavailable$)/.test(report.root_cause || report.summary || "")
    ? ""
    : (report.root_cause || report.summary || "");
  const summaryLabel = report.human_gate ? "Human review required" : report.verification ? "Verification status" : "Recovery status";
  const summaryDetail = report.human_gate ? "Human approval is required before remediation" : currentStage ? `Current stage · ${currentStage}` : "Awaiting the next recorded event";
  els["canvas-layers"].innerHTML = `<div class="recovery-console-layout">
    <section class="recovery-diagnosis" aria-label="Current diagnosis">
      <div class="diagnosis-state"><span>${escapeHtml(summaryLabel)}</span><strong>${escapeHtml(reportTitle)}</strong><small>${escapeHtml(summaryDetail)}</small></div>
      ${reportNarrative ? `<p>${escapeHtml(reportNarrative)}</p>` : ""}
      ${report.rejected_diagnosis ? `<div class="diagnosis-rejection"><span>Rejected hypothesis</span><strong>${escapeHtml(report.rejected_diagnosis.hypothesis_id)}</strong></div>` : ""}
      ${report.confidence != null ? `<div class="diagnosis-score"><span>Evaluator confidence</span><strong>${Math.round(report.confidence * 100)}%</strong></div>` : ""}
    </section>
    <section class="recovery-graph-panel recovery-workflow-facts" aria-label="Projected recovery workflow">
      <header><div><span>Recovery workflow</span><strong>${escapeHtml(team.nodes.find((node) => node.id === team.currentId)?.label || "Awaiting orchestration")}</strong></div><small>See Unified Context Rail</small></header>
      <div class="recovery-workflow-nodes">${team.nodes.map((node) => `<article class="recovery-workflow-node is-${escapeHtml(agentNodeTone(node.status))}"><i class="ph ph-${escapeHtml(node.icon)}" aria-hidden="true"></i><div><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(agentStatusLabel(node.status))}</small></div></article>`).join("")}</div>
    </section>
  </div>`;
  setAnnotations([]);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  els["twin-canvas"].setAttribute("aria-label", `Recovery Console. ${reportTitle}.`);
}

function renderSharedRecoveryCanvas(shared) {
  const events = shared.events;
  const roleEvent = (role) => [...events].reverse().find((event) => event.type === "local_fault_loop.role.response" && event.payload?.role === role)
    || [...events].reverse().find((event) => event.type === "local_fault_loop.role.working" && event.payload?.role === role);
  const stageEvent = (type) => [...events].reverse().find((event) => event.type === type);
  const plan = stageEvent("local_fault_loop.plan.proposed");
  const authority = stageEvent("local_fault_loop.authority.decided");
  const repair = stageEvent("local_fault_loop.repair.executed");
  const verification = stageEvent("local_fault_loop.verification.completed");
  const verificationProjection = incidentVerificationProjection(shared);
  const verificationTestId = verificationProjection.attempted ? ` data-testid="${verificationProjection.passed ? "verification-passed" : "verification-failed"}"` : "";
  const team = recoveryWorkflowProjection(events).nodes;
  const current = team.find((node) => node.status === "active") || team.find((node) => node.status === "blocked") || team.at(-1);
  const selectedRole = team.find((node) => node.id === recoverySelectedRole) || current;
  recoverySelectedRole = selectedRole.id;
  const detail = recoveryRoleDetail(selectedRole, { events, plan, authority, repair, verification, verificationProjection });
  const recoveryTopology = canonicalRecoveryTopologyMarkup(shared.topology);
  els["canvas-layers"].innerHTML = `<div class="recovery-console-layout" data-shared-run="${escapeHtml(shared.run_id)}" data-projection-revision="${escapeHtml(shared.projection_revision)}">
    <section class="recovery-diagnosis" aria-label="Recovery status">
      <div class="diagnosis-state"><span>Recovery status</span><strong>${escapeHtml(shared.state === "recovered" ? "Recovery complete" : humanStageLabel(shared.stage))}</strong><small data-testid="recovery-owner-gate">Owner gate · ${escapeHtml(recoveryGateLabel(events))}</small></div>
    </section>
    ${recoveryTopology.markup}
    <section class="recovery-graph-panel recovery-collaboration-panel recovery-workflow-facts" aria-label="Projected recovery workflow"${verificationTestId}>
      <header><div><span>Execution workflow</span><strong>${escapeHtml(current.status === "complete" ? "Workflow complete" : current.label)}</strong></div><small>${escapeHtml(current.task)}</small></header>
      <div class="recovery-execution-grid">
        <div class="recovery-workflow-nodes">${team.map((node, index) => `${index ? `<span class="recovery-handoff ${node.handoffActive ? "is-active" : ""}" aria-hidden="true"><i class="ph ph-arrow-right"></i></span>` : ""}<button type="button" class="recovery-workflow-node is-${escapeHtml(node.status)} ${node.id === selectedRole.id ? "is-selected" : ""}" data-shared-role="${escapeHtml(node.id)}" data-recovery-role="${escapeHtml(node.id)}" aria-pressed="${String(node.id === selectedRole.id)}"><i class="ph ph-${escapeHtml(node.icon)}" aria-hidden="true"></i><div><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.statusLabel)} · ${escapeHtml(node.task)}</small></div></button>`).join("")}</div>
        <section class="recovery-step-detail" data-testid="recovery-step-detail" data-recovery-detail-role="${escapeHtml(selectedRole.id)}" aria-label="${escapeHtml(selectedRole.label)} execution detail">
          <header><div><span>Selected step</span><strong>${escapeHtml(selectedRole.label)}</strong></div><em class="is-${escapeHtml(selectedRole.status)}">${escapeHtml(selectedRole.statusLabel)}</em></header>
          <dl>${detail.facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
          ${detail.evidence.length ? `<details><summary>${detail.evidence.length} cited record${detail.evidence.length === 1 ? "" : "s"}</summary><div>${detail.evidence.map((id) => `<code>${escapeHtml(id)}</code>`).join("")}</div></details>` : ""}
          ${detail.chatRole ? `<button type="button" class="recovery-ask-agent" data-recovery-chat-role="${escapeHtml(detail.chatRole)}">Ask ${escapeHtml(detail.chatLabel)}</button>` : ""}
        </section>
      </div>
    </section>
  </div>`;
  for (const button of els["canvas-layers"].querySelectorAll("[data-recovery-chat-role]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openAgentTeamSession(button.dataset.recoveryChatRole);
    });
  }
  setAnnotations([]);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  bindCanonicalCanvasIdentity(recoveryTopology.visual, "recovery-canvas");
  els["twin-canvas"].setAttribute("aria-label", "Recovery execution workspace.");
  startIncidentFocusSignals();
}

function recoveryRoleDetail(node, { events, plan, authority, repair, verification, verificationProjection }) {
  const roleEvent = node.role ? [...events].reverse().find((event) => event.type === "local_fault_loop.role.response" && event.payload?.role === node.role) : null;
  const evidence = [...new Set((roleEvent?.evidence_refs || (node.id === "recovery" ? [...(plan?.evidence_refs || []), ...(repair?.evidence_refs || [])] : verification?.evidence_refs || [])).filter(Boolean))];
  const plain = (value, fallback) => value ? plainLanguageAgentAnswer(String(value)).slice(0, 220) : fallback;
  if (node.id === "recovery") return {
    facts: [
      ["Input", plain(plan?.payload?.target, "Awaiting an evaluated repair plan")],
      ["Proposed action", plain(plan?.payload?.repair, "No action projected")],
      ["Execution", repair ? `${plain(repair.payload?.result, "Recorded")} · ${plain(repair.payload?.execution_scope, "bounded scope")}` : authority?.payload?.outcome === "needs_human" ? "Waiting for owner decision" : "Not executed"],
      ["Verification condition", Array.isArray(plan?.payload?.verification_plan) ? plan.payload.verification_plan.map((item) => item.replaceAll("_", " ")).join(" · ") : "Not projected"]
    ], evidence, chatRole: "orchestrator", chatLabel: "Orchestrator"
  };
  if (node.id === "verifier") {
    const guidance = incidentVerificationGuidance(verificationProjection);
    return {
      facts: [
        ["Input", repair ? "Bounded repair result" : "Awaiting repair execution"],
        ["Agent output", guidance.agentOutput],
        ["Proposed action", guidance.nextAction],
        ["Verification condition", verification?.payload?.recovery_slo?.target || "All projected checks pass"]
      ], evidence, chatRole: null, chatLabel: null
    };
  }
  return {
    facts: [
      ["Input", node.task],
      ["Agent output", plain(roleEvent?.payload?.safe_answer, "Awaiting canonical role output")],
      ["Proposed action", plain(roleEvent?.payload?.recommended_handoff?.reason, roleEvent ? "Output recorded" : "Not projected")],
      ["Verification condition", node.id === "evaluator" ? "Causal claim survives adversarial review" : "Cited evidence supports the handoff"]
    ], evidence, chatRole: node.role, chatLabel: node.label
  };
}

function canonicalRecoveryTopologyMarkup(topology) {
  const focus = incidentFocusLayerMarkup(topology, topology?.current, { layerName: "current", workspace: "recovery", pulse: true });
  if (focus.visual.availability !== "ready") {
    return { visual: focus.visual, markup: `<section class="recovery-graph-panel recovery-topology-panel" data-testid="recovery-topology-unavailable" aria-label="Canonical recovery topology unavailable"><div class="source-empty"><i class="ph ph-plugs" aria-hidden="true"></i><strong>Recovery topology unavailable</strong><span>Awaiting a complete canonical incident projection.</span></div></section>` };
  }
  return { visual: focus.visual, markup: `<section class="recovery-graph-panel recovery-topology-panel" data-testid="recovery-topology" aria-label="Recovery impact topology" data-canonical-node-count="${focus.visual.node_ids.length}" data-canonical-edge-count="${focus.visual.edge_ids.length}" data-node-ids="${escapeHtml(focus.visual.node_ids.join(","))}" data-edge-ids="${escapeHtml(focus.visual.edge_ids.join(","))}" data-projection-revision="${escapeHtml(focus.visual.projection_revision)}"><header><div><strong>Recovery impact</strong></div></header><div class="recovery-topology-map is-live-source">${focus.markup}</div></section>` };
}

function renderTwinLayer(frame, layerName, interactive, { runtimeOnly = false, includeControl = false } = {}) {
  const suffix = `${layerName}-${frame.index}`;
  const visibleNodes = runtimeOnly ? TWIN_NODES.filter((node) => node.plane === "runtime" || (includeControl && node.plane === "control")) : TWIN_NODES;
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = TWIN_EDGES.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)).map((edge) => {
    const status = frame.edgeStates[edge.id] || "quiet";
    const pulseSlot = PULSE_SLOTS[edge.id] ?? 0;
    const accessible = interactive ? `role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(labelFor(edge.from))} to ${escapeHtml(labelFor(edge.to))}" data-edge-id="${edge.id}"` : "aria-hidden=\"true\"";
    const plane = edge.evidence ? "evidence" : edge.control ? "control" : "runtime";
    return `<g class="edge-group edge-${edge.id} path-${plane}">
      <path class="edge-line is-${status}" d="${edge.path}" />
      <path class="pulse-flow pulse-slot-${pulseSlot} is-${status}" d="${edge.path}" pathLength="1" aria-hidden="true" />
      <path class="edge-hit" d="${edge.path}" ${accessible} />
    </g>`;
  }).join("");
  const nodes = visibleNodes.map((node) => {
    const status = frame.nodeStates[node.id] || "quiet";
    const sequence = IMPACT_SEQUENCE[node.id] ?? 0;
    const entering = frame.index === 2 && status === "impact" ? " is-entering" : "";
    const interaction = interactive ? `data-node-id="${node.id}" aria-label="${escapeHtml(kindLabel(node.kind))} ${escapeHtml(node.label)}, ${escapeHtml(nodeOrigin(node))}, ${escapeHtml(statusLabel(status))}"` : "tabindex=\"-1\" aria-hidden=\"true\"";
    return `<button class="twin-node plane-${node.plane} node-${node.id} sequence-${sequence} kind-${node.kind} is-${status}${entering}" type="button" data-status="${escapeHtml(status)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" ${interaction}>
      <span class="node-icon icon-${node.id}" aria-hidden="true"><i class="ph ph-${TWIN_ICONS[node.id]}"></i></span>
      <span class="node-copy">
        <strong>${escapeHtml(node.label)}</strong>
        <span class="node-status">${escapeHtml(statusLabel(status))}</span>
      </span>
      <span class="node-status-dot" aria-hidden="true"></span>
    </button>`;
  }).join("");
  return `<div class="twin-layer layer-${layerName}" data-layer="${suffix}">
    <svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="${interactive ? "false" : "true"}">${edges}</svg>
    ${nodes}
  </div>`;
}

function renderAnnotation(annotation) {
  const role = annotation.role === "outcome" ? "outcome" : "causal";
  const icon = role === "outcome" ? `<span class="note-icon" aria-hidden="true"><i class="ph ph-${annotationIcon(annotation.id)}"></i></span>` : "";
  return `<button class="causal-note note-${annotation.id} note-role-${role} tone-${annotation.tone}" type="button" data-annotation-id="${annotation.id}" aria-label="${role === "outcome" ? "Derived outcome" : "Causal event"}: ${escapeHtml(annotation.title)}">
    ${icon}<span class="note-copy"><strong>${escapeHtml(annotation.title)}</strong><span>${escapeHtml(annotation.copy)}</span></span>
  </button>`;
}

function setAnnotations(annotations) {
  els["annotation-layer"].classList.toggle("has-outcomes", annotations.some((annotation) => annotation.role === "outcome"));
  els["annotation-layer"].innerHTML = annotations.map(renderAnnotation).join("");
}

function renderComparePosition() {
  if (!(mode === "compare" || isIncidentCompareStage())) return;
  comparePercent = Math.max(0, Math.min(100, Number(comparePercent) || 0));
  els["twin-canvas"].style.setProperty("--compare-percent", `${comparePercent}%`);
  els["compare-value"].textContent = `${Math.round(comparePercent)}% incident`;
  els["compare-range"].value = String(comparePercent);
  els["compare-range"].setAttribute("aria-valuetext", `${Math.round(comparePercent)} percent incident, ${Math.round(100 - comparePercent)} percent verified`);
  els["compare-canvas-range"].value = String(comparePercent);
  els["compare-canvas-range"].setAttribute("aria-valuetext", `${Math.round(comparePercent)} percent incident, ${Math.round(100 - comparePercent)} percent verified`);
}

function compareDecisionModel() {
  const events = state?.events || [];
  const first = (type) => events.find((event) => event.type === type);
  const last = (type) => [...events].reverse().find((event) => event.type === type);
  const rejected = first("evaluation.rejected");
  const replan = first("plan.revised");
  const accepted = last("evaluation.accepted");
  const cause = [...events].reverse().find((event) => event.type === "hypothesis.proposed" && event.payload?.id === accepted?.payload?.hypothesis_id);
  const repair = first("repair.proposed");
  const approval = last("approval.granted") || first("approval.requested");
  const executed = last("repair.executed");
  const verification = last("verification.completed");
  const regression = last("regression.created");
  const policy = last("policy.evaluated");
  const verified = verification?.payload?.passed === true;
  return {
    rejected,
    replan,
    accepted,
    cause,
    repair,
    approval,
    executed,
    verification,
    regression,
    policy,
    verified,
    rootCause: cause?.payload?.title || "Causal finding is not yet recorded",
    rootCopy: accepted?.payload?.reason || "Awaiting evaluator-confirmed causal evidence.",
    recovery: repair?.payload?.action || "No bounded repair proposed",
    recoveryCopy: repair?.payload?.expected_effect || "The repair boundary will appear after a causal finding is accepted.",
    nextTime: replan?.payload?.reason || "Capture the initiating change and the first failing request before naming a cause."
  };
}

function compareEvidenceChips(event, limit = 3) {
  const refs = event?.evidence_refs || [];
  return refs.slice(0, limit).map((id) => `<code>${escapeHtml(id)}</code>`).join("") || "<span>Ledger record pending</span>";
}

function applyCompareFocus() {
  els["twin-canvas"].dataset.compareFocus = compareFocus;
  for (const button of document.querySelectorAll("[data-compare-focus]")) {
    button.setAttribute("aria-pressed", String(button.dataset.compareFocus === compareFocus));
  }
}

function handleCompareFocus(event) {
  const button = event.target.closest("[data-compare-focus]");
  if (!button || mode !== "compare") return;
  compareFocus = button.dataset.compareFocus;
  applyCompareFocus();
}

function setComparePercent(value) {
  comparePercent = value;
  renderComparePosition();
}

function startCompareDrag(event) {
  if (!claimCanvasPointer(event, "compare-divider")) return;
  compareDrag = event.pointerId;
  els["compare-handle"].classList.add("is-dragging");
  els["twin-canvas"].setPointerCapture?.(event.pointerId);
  updateCompareFromPointer(event.clientX);
  event.preventDefault();
}

function moveCompareDrag(event) {
  if (compareDrag !== event.pointerId || canvasPointer?.action !== "compare-divider") return;
  updateCompareFromPointer(event.clientX);
}

function endCompareDrag(event) {
  if (compareDrag !== event.pointerId || canvasPointer?.action !== "compare-divider") return;
  updateCompareFromPointer(event.clientX);
  compareDrag = null;
  canvasPointer = transitionCanvasPointer(event, "up");
  els["compare-handle"].classList.remove("is-dragging");
  els["twin-canvas"].releasePointerCapture?.(event.pointerId);
}

function updateCompareFromPointer(clientX) {
  const rect = els["twin-canvas"].getBoundingClientRect();
  setComparePercent(Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100));
}

function renderTimeline() {
  const shared = sharedRunModel();
  if (shared || sharedRun?.loop) {
    const events = shared?.events || sharedRun.loop.events || [];
    const currentIndex = Math.max(0, Math.min(cursor, Math.max(0, events.length - 1)));
    const markers = sharedTimelineMarkers(events);
    const recoveryTypes = new Set(["local_fault_loop.plan.proposed", "local_fault_loop.authority.decided", "local_fault_loop.repair.executed", "local_fault_loop.verification.completed", "local_fault_loop.recovered"]);
    const compactMarkers = isIncidentWorkspace() && ["decide", "execute", "verify"].includes(incidentStage)
      ? markers.filter((marker) => recoveryTypes.has(marker.event.type)).slice(-5)
      : markers.filter((marker) => Math.abs(marker.index - currentIndex) <= 1);
    els["stage-track"].style.setProperty("--stage-count", String(Math.max(1, compactMarkers.length)));
    els["stage-track"].innerHTML = compactMarkers.map((marker) => `<button class="stage-marker stage-${escapeHtml(marker.stage)} stage-group-incident ${marker.index <= currentIndex ? "is-available" : ""} ${marker.index === currentIndex ? "is-current" : ""}" type="button" data-shared-event-index="${marker.index}"><span>${escapeHtml(formatTime(marker.event.recorded_at))}</span><strong>${escapeHtml(marker.label)}</strong></button>`).join("");
    for (const button of els["stage-track"].querySelectorAll("[data-shared-event-index]")) button.addEventListener("click", () => seekSharedEvent(Number(button.dataset.sharedEventIndex)));
    els["timeline-range"].max = String(Math.max(0, events.length - 1));
    els["timeline-range"].value = String(currentIndex);
    els["timeline-range"].disabled = events.length < 2;
    const event = events[currentIndex];
    els["timeline-time"].textContent = event ? formatTime(event.recorded_at) : "Awaiting event";
    els["timeline-title"].textContent = event ? sharedEventLabel(event) : "Awaiting canonical event";
    els["timeline-copy"].textContent = event ? "View history" : "Awaiting event history";
    const compareStage = isIncidentCompareStage() || mode === "compare";
    els["compare-control"].hidden = !compareStage || !incidentCompareControlAvailable(shared);
    els["timeline-current"].hidden = compareStage;
    return;
  }
  const available = availableStage(state.events);
  const stages = timelineStages();
  const visible = stages.slice(0, available + 1);
  const compactStages = visible.filter((_, index) => Math.abs(index - Math.min(cursor, available)) <= 1);
  els["stage-track"].style.setProperty("--stage-count", String(Math.max(1, compactStages.length)));
  els["stage-track"].innerHTML = compactStages.map((stage) => {
    const index = stages.indexOf(stage);
    const enabled = index <= available || (index === 1 && available >= 2);
    return `<button class="stage-marker stage-${stage.id} stage-group-${stageGroup(index)} ${enabled ? "is-available" : ""} ${index === cursor && mode !== "compare" ? "is-current" : ""}" type="button" data-stage-index="${index}" ${enabled ? "" : "disabled"}>
      <span>${stage.time}</span><strong>${escapeHtml(stage.label)}</strong>
    </button>`;
  }).join("") + (available < stages.length - 1 ? `<span class="timeline-next">Next: ${escapeHtml(nextTimelineRequirement(available))}</span>` : "");
  for (const button of els["stage-track"].querySelectorAll("[data-stage-index]")) button.addEventListener("click", () => seek(Number(button.dataset.stageIndex)));
  els["timeline-range"].max = String(available);
  els["timeline-range"].value = String(Math.min(cursor, available));
  els["timeline-range"].disabled = mode !== "replay";
  els["timeline-time"].textContent = mode === "compare" ? "Before / after" : stages[cursor].time;
  els["timeline-title"].textContent = mode === "compare" ? "Incident vs verified" : stages[cursor].label;
  els["timeline-copy"].textContent = "View history";
  els["compare-control"].hidden = mode !== "compare";
  els["timeline-current"].hidden = mode === "compare";
}

function sharedTimelineMarkers(events) {
  const meaningful = new Set([
    "local_fault_loop.baseline.captured", "local_fault_loop.fault.injected", "local_fault_loop.observer.detected",
    "local_fault_loop.handoff.recorded", "local_fault_loop.role.working", "local_fault_loop.tool.requested", "local_fault_loop.tool.completed", "local_fault_loop.role.response", "local_fault_loop.hypothesis.proposed",
    "local_fault_loop.hypothesis.accepted", "local_fault_loop.evaluation.rejected", "local_fault_loop.evaluation.accepted",
    "local_fault_loop.plan.proposed", "local_fault_loop.authority.decided", "local_fault_loop.repair.executed",
    "local_fault_loop.verification.completed", "local_fault_loop.recovered", "local_fault_loop.stopped", "local_fault_loop.failed",
    "agent_team.message.received", "agent_team.handoff.recorded", "agent_team.tool.requested", "agent_team.tool.result.recorded", "agent_team.response.working", "agent_team.response.created"
  ]);
  return events.map((event, index) => ({ event, index, stage: event.payload?.stage || "event", label: sharedEventLabel(event) })).filter(({ event }) => meaningful.has(event.type)).slice(-32);
}

function sharedEventLabel(event) {
  const payload = event.payload || {};
  if (event.type.endsWith("handoff.recorded")) return `${payload.from || event.actor} → ${payload.to || "next role"}`;
  if (event.type === "local_fault_loop.role.response") return `${payload.role || event.actor} response`;
  if (event.type === "local_fault_loop.role.working") return `${payload.role || event.actor} started`;
  if (event.type === "local_fault_loop.tool.requested") return `${payload.role || event.actor} requested ${Array.isArray(payload.tools) ? payload.tools.join(", ") : "bounded tools"}`;
  if (event.type === "local_fault_loop.tool.completed") return `${payload.role || event.actor} received bounded evidence`;
  if (event.type === "agent_team.tool.requested") return `${event.actor} requested ${payload.tool || "tool"}`;
  if (event.type === "agent_team.tool.result.recorded") return `${event.actor} received ${payload.result_count || 0} result${payload.result_count === 1 ? "" : "s"}`;
  if (event.type === "agent_team.response.working") return "Agent investigation is in progress";
  if (event.type === "agent_team.response.created") return `${payload.responding_agent || event.actor} answered`;
  return event.type.replace(/^(local_fault_loop|agent_team)\./, "").replaceAll(".", " ");
}

function seekSharedEvent(index) {
  const events = sharedRunModel()?.events || [];
  cursor = Math.max(0, Math.min(events.length - 1, Number(index) || 0));
  sharedRunFollowing = cursor >= events.length - 1;
  stopPlayback();
  render();
}

function nextTimelineRequirement(index) {
  return ({
    0: "awaiting deployed-change evidence",
    1: "awaiting failure propagation evidence",
    2: "awaiting adversarial evaluation",
    3: "awaiting accepted causal evidence",
    4: "awaiting owner approval request",
    5: "awaiting recovery verification",
    6: "awaiting regression record"
  })[index] || "incident complete";
}

function renderApproval() {
  const shared = sharedRunModelAtCursor();
  const connectionVisible = ["reconnecting", "stale"].includes(sharedRun?.stream_state);
  if (shared) {
    const workflow = incidentWorkflowEvidence(shared.events);
    const visible = shared.state === "needs_human";
    els["approval-banner"].hidden = !visible;
    els["incident-strip"].hidden = !connectionVisible;
    els["incident-strip"].classList.toggle("is-connection-status", connectionVisible);
    els["approval-copy"].textContent = visible
      ? workflow.verificationFailed
        ? "Repair was executed, but independent verification failed. Operator decision is required."
        : "Evidence is insufficient. No repair or comparison was executed."
      : "Repair authority remains bounded to the isolated fixture event stream.";
    els["recovery-status-button"].textContent = workflow.verificationFailed
      ? "Review failed verification"
      : shared.workspace_actions.open_recovery_console.available ? "View recovery status" : "Recovery awaiting evidence";
    return;
  }
  if (connectionVisible) {
    els["approval-banner"].hidden = true;
    els["incident-strip"].hidden = false;
    els["incident-strip"].classList.add("is-connection-status");
    return;
  }
  const visible = state.waiting_for_approval && (mode === "live" || (mode === "replay" && cursor >= 5));
  const activeIncident = state.mode === "development" && activeIncidentState(state.events);
  els["approval-banner"].hidden = !visible;
  els["incident-strip"].hidden = visible || mode !== "live" || !activeIncident;
  els["incident-strip"].classList.remove("is-connection-status");
  els["approval-copy"].textContent = state.mode === "development" ? "Recovery requires a server-recorded owner decision." : "Rollback authority remains bounded to checkout:2.18.0.";
  els["recovery-status-button"].textContent = "View recovery status";
  els["recovery-status-button"].dataset.testid = "recovery-status";
  els["recovery-status-button"].setAttribute("aria-label", "View recovery status");
}

function renderDrawer() {
  // Live component detail is intentionally rendered in the persistent Team rail.
  // Keeping the canvas drawer out of this path preserves the graph and avoids
  // presenting two competing detail surfaces for the same selected node.
  if (mode === "architecture" || mode === "live" || isUnifiedRailWorkspace() || !selected || !state || agentTeam.panel === "session") {
    els["context-drawer"].hidden = true;
    return;
  }
  els["context-drawer"].hidden = false;
  const meta = selectionMeta(selected);
  els["context-drawer"].dataset.tone = drawerTone(selected);
  els["drawer-kind"].textContent = meta.kind;
  els["drawer-title"].textContent = meta.title;
  els["drawer-subtitle"].textContent = meta.subtitle;
  const tabs = drawerTabsForSelection(selected);
  if (!tabs.some(([id]) => id === activeTab)) activeTab = tabs[0]?.[0] || "evidence";
  els["drawer-tabs"].innerHTML = tabs.map(([id, label]) => `<button class="drawer-tab" id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-selected="${activeTab === id}" aria-controls="drawer-content">${label}</button>`).join("");
  els["drawer-content"].innerHTML = drawerContent(activeTab);
}

function controlSystemNodes() {
  const preferred = mode === "live" ? liveTopologyView()?.control_system : architectureView()?.control_system;
  const fallback = mode === "live" ? architectureView()?.control_system : liveTopologyView()?.control_system;
  const nodes = preferred?.nodes || fallback?.nodes || [];
  return nodes.length === 5 ? nodes : [];
}

function isUnifiedRailWorkspace(candidate = mode) {
  return candidate === "incident" || ["replay", "agents", "compare"].includes(candidate);
}

function railRuntimeNodes() {
  const view = liveTopologyView() || architectureView();
  const nodes = view?.runtime_data?.graph?.nodes || view?.graph?.nodes || [];
  return nodes.filter((node) => node && ["runtime", "data"].includes(node.plane));
}

function isRailRuntimeNode(id) {
  return typeof id === "string" && railRuntimeNodes().some((node) => node.id === id);
}

function isSelectionValidForMode(selection, destination) {
  if (!selection) return true;
  if (selection.type !== "node") return false;
  if (destination === "architecture") return false;
  if (["live", "incident", "replay", "agents", "compare"].includes(destination)) return isRailRuntimeNode(selection.id);
  return false;
}

function renderOperationsTeamRail() {
  const rail = els["operations-team-rail"];
  const shell = document.getElementById("app-shell") || els["app-shell"];
  const railMode = shell?.dataset.mode || mode;
  const unifiedRailMode = railMode === "incident" || ["replay", "agents", "compare"].includes(railMode);
  const controls = controlSystemNodes();
  const activeInput = document.activeElement?.matches?.("textarea[data-agent-team-input]") ? document.activeElement : null;
  const selectionStart = activeInput?.selectionStart;
  const selectionEnd = activeInput?.selectionEnd;
  const inspectorOpen = (railMode === "live" || unifiedRailMode) && selected?.type === "node" && isRailRuntimeNode(selected.id) && agentTeam.panel === "home";
  const workspaceEvidenceOpen = unifiedRailMode && Boolean(selected) && agentTeam.panel === "home" && !inspectorOpen;
  rail.dataset.liveInspector = inspectorOpen ? "true" : "false";
  if (shell) shell.dataset.liveInspector = inspectorOpen ? "true" : "false";
  rail.hidden = !controls.length;
  if (rail.hidden) {
    rail.innerHTML = "";
    return;
  }
  rail.innerHTML = inspectorOpen
    ? liveNodeInspectorRailMarkup()
    : workspaceEvidenceOpen
      ? workspaceEvidenceRailMarkup()
      : agentTeam.panel === "session"
        ? agentTeamSessionMarkup(controls)
        : isUnifiedRailWorkspace()
          ? workspaceSummaryRailMarkup()
          : agentTeamHomeMarkup(controls);
  bindOperationsTeamRailControls(rail);
  if (activeInput && agentTeam.panel === "session" && !agentTeam.sending) {
    const replacement = rail.querySelector("textarea[data-agent-team-input]");
    replacement?.focus();
    if (replacement && Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) replacement.setSelectionRange(selectionStart, selectionEnd);
  }
  restoreLiveInspectorSnapshot();
}

function bindOperationsTeamRailControls(rail) {
  for (const button of rail.querySelectorAll("[data-agent-team-role]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const restoreInspector = Boolean(selected?.type === "node" && isRailRuntimeNode(selected.id));
      void openAgentTeamSession(button.dataset.agentTeamRole, { restoreInspector, inspectorSnapshot: restoreInspector ? captureLiveInspectorSnapshot() : null });
    });
  }
  const form = rail.querySelector("[data-agent-team-composer]");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.stopPropagation();
    handleAgentTeamSubmit(event);
  });
  form.querySelector("[data-agent-team-input]")?.addEventListener("input", (event) => {
    event.stopPropagation();
    handleAgentTeamDraft(event);
  });
  form.querySelector("[data-agent-team-input]")?.addEventListener("keydown", (event) => {
    event.stopPropagation();
    handleAgentTeamComposerKeydown(event);
  });
  form.querySelector("[data-agent-team-send]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void submitAgentTeamComposer(form);
  });
}

function handleOperationsTeamRail(event) {
  if (event.target.closest("[data-workspace-evidence-close]")) {
    closeDrawer();
    return;
  }
  if (event.target.closest("[data-workspace-view-evidence]")) {
    selected = { type: "run", id: state?.run_id || "current" };
    activeTab = "evidence";
    renderDrawer();
    renderOperationsTeamRail();
    return;
  }
  const inspectorClose = event.target.closest("[data-live-inspector-close]");
  if (inspectorClose) {
    closeDrawer();
    return;
  }
  const inspectorDisclosure = event.target.closest("[data-live-inspector-disclosure]");
  if (inspectorDisclosure) {
    const key = inspectorDisclosure.dataset.liveInspectorDisclosure;
    if (["evidence", "events"].includes(key)) {
      liveInspector = { ...liveInspector, disclosures: { ...liveInspector.disclosures, [key]: !liveInspector.disclosures[key] } };
      renderOperationsTeamRail();
    }
    return;
  }
  const agentDisclosure = event.target.closest("[data-agent-team-disclosure]");
  if (agentDisclosure) {
    const key = agentDisclosure.dataset.agentTeamDisclosure;
    if (["capability", "run"].includes(key)) {
      agentTeam = { ...agentTeam, disclosures: { ...agentTeam.disclosures, [key]: !agentTeam.disclosures[key] } };
      renderOperationsTeamRail();
    }
    return;
  }
  const inspectorFocus = event.target.closest("[data-focus-entity]");
  if (inspectorFocus) {
    openDrawer({ type: "node", id: inspectorFocus.dataset.focusEntity }, "overview");
    return;
  }
  const sharedEvidence = event.target.closest("[data-shared-evidence-id]");
  if (sharedEvidence) {
    const componentId = canonicalSelectedComponent() || "checkout";
    if (agentTeam.panel === "session") closeAgentTeamSession({ restoreInspector: false });
    selected = null;
    openDrawer({ type: "node", id: componentId }, "evidence");
    return;
  }
  const askObserver = event.target.closest("[data-ask-observer]");
  if (askObserver) {
    void openAgentTeamSession("observer", { restoreInspector: true, inspectorSnapshot: captureLiveInspectorSnapshot() });
    return;
  }
  const suggestion = event.target.closest("[data-agent-team-suggestion]");
  if (suggestion) {
    setAgentTeamDraft(suggestion.dataset.agentTeamSuggestion || "", { focus: true });
    return;
  }
  if (event.target.closest("[data-agent-team-back]")) {
    closeAgentTeamSession({ restoreInspector: true });
    return;
  }
  const workspace = event.target.closest("[data-agent-team-workspace]");
  if (workspace && !workspace.disabled) {
    const stageByAction = {
      view_diagnosis: "investigate",
      open_recovery_console: "decide",
      compare_recovery: "verify"
    };
    const nextStage = stageByAction[workspace.dataset.agentTeamWorkspace];
    if (nextStage) setIncidentStage(nextStage);
    return;
  }
  if (event.target.closest("[data-agent-team-simulate]")) void runAgentTeamDemo();
}

async function handleAgentTeamSubmit(event) {
  const form = event.target.closest("[data-agent-team-composer]");
  if (!form) return;
  event.preventDefault();
  await submitAgentTeamComposer(form);
}

async function submitAgentTeamComposer(form) {
  const message = String(new FormData(form).get("message") || "");
  agentTeam = { ...agentTeam, draft: message.slice(0, 1500) };
  await sendAgentTeamMessage(message);
}

function handleAgentTeamComposerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || !event.target.matches("textarea[data-agent-team-input]")) return;
  const form = event.target.closest("[data-agent-team-composer]");
  if (!form || agentTeam.sending) return;
  event.preventDefault();
  form.requestSubmit();
}

function handleAgentTeamDraft(event) {
  if (!event.target.matches("textarea[data-agent-team-input]")) return;
  agentTeam = { ...agentTeam, draft: String(event.target.value || "").slice(0, 1500) };
}

function setAgentTeamDraft(value, { focus = false } = {}) {
  agentTeam = { ...agentTeam, draft: String(value || "").slice(0, 1500) };
  renderOperationsTeamRail();
  if (focus) els["operations-team-rail"].querySelector("textarea[data-agent-team-input]")?.focus();
}

function emptyLiveInspector(nodeId = null) {
  return {
    node_id: nodeId,
    disclosures: { evidence: false, events: false },
    scroll_top: 0,
    restore_pending: false
  };
}

function captureLiveInspectorSnapshot() {
  const body = els["operations-team-rail"].querySelector("[data-live-inspector-scroll]");
  return {
    node_id: selected?.type === "node" ? selected.id : null,
    disclosures: { ...liveInspector.disclosures },
    scroll_top: body?.scrollTop ?? liveInspector.scroll_top
  };
}

function restoreLiveInspectorSnapshot() {
  if (!liveInspector.restore_pending || selected?.type !== "node" || selected.id !== liveInspector.node_id) return;
  const body = els["operations-team-rail"].querySelector("[data-live-inspector-scroll]");
  if (!body) return;
  body.scrollTop = liveInspector.scroll_top;
  liveInspector = { ...liveInspector, restore_pending: false };
}

function liveNodeInspectorRailMarkup() {
  const context = selected?.type === "node" ? sourceComponentContext(selected.id) : null;
  if (!context) return agentTeamUnavailableMarkup("The selected runtime component is unavailable from the current topology projection.");
  if (context.detailLoading) return liveNodeInspectorLoadingMarkup(context);
  if (context.detailUnavailable || !context.detail) return liveNodeInspectorUnavailableMarkup(context);
  const inspector = nodeLiveInspectorProjection(context.detail);
  if (!inspector) return liveNodeInspectorUnavailableMarkup(context);
  const status = sourceStatusLabel(context.status, inspector.runtime.status);
  const freshness = inspector.runtime.freshness_ms == null ? null : formatAge(inspector.runtime.freshness_ms);
  const sourceLine = freshness ? `Updated ${freshness} ago` : "";
  return `<section class="architecture-system architecture-flowpulse-system live-node-inspector" aria-label="${escapeHtml(inspector.component.label)} live inspector">
    <header class="live-node-inspector-header">
      <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(inspector.component)}"></i></span>
      <div><strong>${escapeHtml(inspector.component.label)}</strong><span>${escapeHtml(status)}${sourceLine ? ` · ${escapeHtml(sourceLine)}` : ""}</span></div>
      <span class="node-status-dot is-${escapeHtml(context.status)}" aria-label="${escapeHtml(status)}"></span>
      <button type="button" class="live-inspector-close" data-live-inspector-close aria-label="Close component inspector"><i class="ph ph-x" aria-hidden="true"></i></button>
    </header>
    <div class="live-node-inspector-actions">
      <button type="button" class="live-agent-ask" data-ask-observer="${escapeHtml(inspector.component.id)}">Ask Observer</button>
    </div>
    <div class="live-node-inspector-body" data-live-inspector-scroll>
      ${liveInspectorPurposeMarkup(inspector)}
      ${liveInspectorPulseMarkup(sharedInspectorPulse(inspector))}
      ${liveInspectorEventStreamMarkup(inspector.event_stream)}
      ${liveInspectorDependenciesMarkup(inspector.dependencies)}
      ${liveInspectorEvidenceMarkup(inspector.evidence)}
      ${liveInspectorDataResourcesMarkup(inspector.data_resources)}
    </div>
  </section>`;
}

function liveNodeInspectorLoadingMarkup(context) {
  return `<section class="architecture-system architecture-flowpulse-system live-node-inspector live-node-inspector-state" aria-label="Loading ${escapeHtml(context.node.label)} detail">
    <header class="live-node-inspector-header"><span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(context.node)}"></i></span><div><strong>${escapeHtml(context.node.label)}</strong><span>Loading safe runtime detail</span></div><button type="button" class="live-inspector-close" data-live-inspector-close aria-label="Close component inspector"><i class="ph ph-x" aria-hidden="true"></i></button></header>
    <p>Loading the bounded server projection. The runtime canvas remains active.</p>
  </section>`;
}

function liveNodeInspectorUnavailableMarkup(context) {
  return `<section class="architecture-system architecture-flowpulse-system live-node-inspector live-node-inspector-state" aria-label="${escapeHtml(context.node.label)} detail unavailable">
    <header class="live-node-inspector-header"><span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(context.node)}"></i></span><div><strong>${escapeHtml(context.node.label)}</strong><span>${escapeHtml(sourceStatusLabel(context.status))}</span></div><button type="button" class="live-inspector-close" data-live-inspector-close aria-label="Close component inspector"><i class="ph ph-x" aria-hidden="true"></i></button></header>
    <p>Safe runtime detail is unavailable from the current backend projection.</p>
  </section>`;
}

function liveInspectorPurposeMarkup(inspector) {
  return `<section class="live-inspector-section live-inspector-purpose"><span>Operational role</span><strong>${escapeHtml(inspector.purpose.business_role)}</strong><p>${escapeHtml(inspector.purpose.description)}</p></section>`;
}

function sharedInspectorPulse(inspector) {
  const shared = sharedRunModelAtCursor();
  const current = shared?.selected_component === inspector.component.id ? shared.metric_samples.current : null;
  if (!current) return inspector.live_pulse;
  return [
    { kind: "Checkout error rate", title: "Checkout error rate", value: current.checkout_error_rate_percent, unit: "%", observed_at: current.recorded_at },
    { kind: "Payment reachability", title: "Payment reachability", value: current.payment_reachability_percent, unit: "%", observed_at: current.recorded_at },
    { kind: "Kafka lag", title: "Kafka lag", value: current.kafka_lag, unit: "", observed_at: current.recorded_at }
  ];
}

function liveInspectorPulseMarkup(items) {
  if (!items.length) return "";
  const value = (item) => item.kind === "event"
    ? item.title
    : item.value != null ? `${item.value}${item.unit ? ` ${item.unit}` : ""}` : item.after != null ? `${item.after}${item.unit ? ` ${item.unit}` : ""}` : item.before != null ? `${item.before}${item.unit ? ` ${item.unit}` : ""}` : null;
  const cards = items.map((item) => `<article><span>${escapeHtml(item.kind === "event" ? "Last event" : item.title)}</span>${value(item) ? `<strong>${escapeHtml(value(item))}</strong>` : ""}${item.observed_at ? `<small>${escapeHtml(formatTime(item.observed_at))}</small>` : ""}</article>`).join("");
  return `<section class="live-inspector-section"><span>Live pulse</span><div class="live-inspector-pulse">${cards}</div></section>`;
}

function liveInspectorEventStreamMarkup(events) {
  if (!events.length) return "";
  const visible = liveInspector.disclosures.events ? events : events.slice(0, 5);
  return `<section class="live-inspector-section"><span>Event stream</span><div class="live-inspector-events">${visible.map((event) => `<article><div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.event_kind)} · ${escapeHtml(formatTime(event.observed_at))}</small></div></article>`).join("")}</div>${events.length > 5 ? `<button type="button" class="live-inspector-disclosure" data-live-inspector-disclosure="events" aria-expanded="${String(liveInspector.disclosures.events)}">${liveInspector.disclosures.events ? "Show recent events" : `View ${events.length - 5} more`}</button>` : ""}</section>`;
}

function liveInspectorDependenciesMarkup(dependencies) {
  const group = (label, relation) => {
    const values = relation.visible;
    if (!values.length) return "";
    return `<div class="live-inspector-dependency-group"><span>${label}</span><div>${values.map((node) => `<button type="button" data-focus-entity="${escapeHtml(node.id)}"><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.relation)}</small></button>`).join("")}${relation.remaining ? `<span class="live-inspector-more">+${relation.remaining}</span>` : ""}</div></div>`;
  };
  const markup = `${group("Upstream", dependencies.upstream)}${group("Downstream", dependencies.downstream)}`;
  return markup ? `<section class="live-inspector-section"><span>Dependency impact</span><div class="live-inspector-dependencies">${markup}</div></section>` : "";
}

function liveInspectorEvidenceMarkup(evidence) {
  const freshness = evidence.freshness_ms == null ? null : `captured ${formatAge(evidence.freshness_ms)} ago`;
  const summary = `${evidence.record_count} evidence record${evidence.record_count === 1 ? "" : "s"}${freshness ? ` · ${freshness}` : ""}`;
  const open = liveInspector.disclosures.evidence;
  return `<section class="live-inspector-section live-inspector-evidence"><button type="button" class="live-inspector-disclosure" data-live-inspector-disclosure="evidence" aria-expanded="${String(open)}"><span>Evidence &amp; source</span><strong>${escapeHtml(summary)}</strong></button>${open ? `<div class="live-inspector-evidence-detail"><p>${escapeHtml(evidence.source_mode)} · ${escapeHtml(evidence.source_health)}</p>${evidence.observed_at ? `<p>Last event ${escapeHtml(formatTime(evidence.observed_at))}</p>` : ""}${evidence.provenance_refs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join("")}<code>${escapeHtml(evidence.topology_projection_revision.slice(0, 12))}…</code><code>${escapeHtml(evidence.detail_revision.slice(0, 12))}…</code></div>` : ""}</section>`;
}

function liveInspectorDataResourcesMarkup(resources) {
  if (!resources.length) return "";
  return `<section class="live-inspector-section"><span>Data resources</span><div class="live-inspector-data-resources">${resources.map((resource) => `<code>${escapeHtml(resource)}</code>`).join("")}</div></section>`;
}

function workspaceSummaryRailMarkup() {
  const report = agentControl().report || {};
  const controls = controlSystemNodes();
  const summary = workspaceSummaryModel(report);
  const available = summary.available !== false;
  return `<section class="architecture-system architecture-flowpulse-system unified-context-summary" aria-label="${escapeHtml(summary.title)}">
    <header class="unified-context-header"><div><span>FlowPulse</span><strong>${escapeHtml(summary.title)}</strong></div><span class="node-status-dot is-${escapeHtml(summary.tone)}" aria-label="${escapeHtml(summary.status)}"></span></header>
    <p class="unified-context-status">${escapeHtml(summary.status)}</p>
    ${available ? `<dl class="unified-context-facts">${summary.facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : `<p class="unified-context-empty">${escapeHtml(summary.empty)}</p>`}
    <div class="unified-context-actions">${summary.actions.map((action) => action.kind === "evidence" ? `<button type="button" data-workspace-view-evidence>${escapeHtml(action.label)}</button>` : `<button type="button" data-agent-team-role="${escapeHtml(action.role)}">${escapeHtml(action.label)}</button>`).join("")}</div>
    ${compactAgentSwitcherMarkup(controls)}
  </section>`;
}

function workspaceSummaryModel(report) {
  const compact = (facts) => facts.filter(([, value]) => typeof value === "string" && value.trim()).slice(0, 5);
  const shared = sharedRunModelAtCursor();
  if (shared) {
    const events = shared.events;
    const accepted = [...events].reverse().find((event) => event.type === "local_fault_loop.hypothesis.accepted");
    const plan = [...events].reverse().find((event) => event.type === "local_fault_loop.plan.proposed");
    const verification = incidentVerificationProjection(shared);
    if (mode === "replay") {
      const recoveryVerified = verification.passed;
      return {
      title: "Diagnosis Summary",
      status: recoveryVerified
        ? "Causal diagnosis accepted; recovery is verified"
        : shared.state === "needs_human"
          ? "Evidence requires human review before recovery"
          : accepted ? "Causal evidence is under evaluator review" : "Roles are collecting bounded evidence",
      tone: recoveryVerified ? "verified" : shared.state === "needs_human" ? "warning" : accepted ? "observed" : "active",
      facts: compact([["Current stage", humanStageLabel(shared.stage)], ["Causal hypothesis", accepted?.payload?.claim || "Not yet established"], ["Evidence", `${shared.citations.length} cited records`]]),
      actions: [{ label: "Ask Investigator", role: "investigator" }, { label: "Ask Observer", role: "observer" }, { label: "View cited evidence", kind: "evidence" }]
      };
    }
    if (mode === "agents") return {
      title: "Recovery Status",
      status: plan ? "Recovery proposal is projected from this run" : "Recovery proposal unavailable",
      tone: verification.passed ? "verified" : plan ? "active" : "idle",
      facts: compact([["Risk", plan?.payload?.risk || "Not projected"], ["Owner gate", recoveryGateLabel(events)], ["Verification", verification.passed ? "Passed" : verification.failed ? "Failed" : "Not projected"], ["Next permitted action", recoveryNextAction(events, verification)]]),
      actions: [{ label: "Ask Orchestrator", role: "orchestrator" }, { label: "Ask Evaluator", role: "evaluator" }]
    };
    return {
      title: "Verification Summary",
      status: verification.passed ? "Baseline, incident, and verified samples are server-recorded" : "Compare remains locked until independent verification",
      tone: verification.passed ? "verified" : "standby",
      available: verification.passed,
      empty: "Compare is unavailable until the backend records an implemented repair and independent verification.",
      facts: compact([["Recovery verdict", verification.passed ? "Verified" : "Not verified"], ["Verification", verification.passed ? "All checks passed" : verification.failed ? "Failed" : "Not recorded"], ["Rollback", events.some((event) => event.type === "local_fault_loop.repair.rolled_back") ? "Executed" : "Not needed"], ["Evidence", `${shared.citations.length} cited records`]]),
      actions: [{ label: "Ask Evaluator", role: "evaluator" }]
    };
  }
  const verdict = report.verification ? "Verified" : report.human_gate ? "Human gate required" : report.stage || "Awaiting server projection";
  if (mode === "replay") return {
    title: "Diagnosis Summary",
    status: report.root_cause ? "Evidence-grounded diagnosis" : "Awaiting evidence-grounded diagnosis",
    tone: report.rejected_diagnosis ? "warning" : "observed",
    facts: compact([
      ["Current hypothesis", report.root_cause || report.title],
      ["Evaluator", report.rejected_diagnosis?.reason || verdict],
      ["Evidence coverage", Array.isArray(report.citations) && report.citations.length ? `${report.citations.length} cited records` : "No cited records projected"],
      ["Active agent", agentControl().current_agent_id?.replaceAll("_", " ") || "Unavailable"]
    ]),
    actions: [{ label: "Ask Investigator", role: "investigator" }, { label: "Ask Evaluator", role: "evaluator" }, { label: "View cited evidence", kind: "evidence" }]
  };
  if (mode === "agents") return {
    title: "Recovery Status",
    status: report.repair ? "Bounded repair is server-projected" : "Recovery proposal unavailable",
    tone: report.verification ? "verified" : report.human_gate ? "warning" : "idle",
    facts: compact([
      ["Proposed repair", report.repair?.action || "Not projected"],
      ["Risk", report.repair?.risk || "Not projected"],
      ["Evaluator", report.rejected_diagnosis?.reason || verdict],
      ["Human gate", report.human_gate ? "Required" : "Not required by current projection"],
      ["Verification", report.verification || "Not projected"]
    ]),
    actions: [{ label: "Ask Orchestrator", role: "orchestrator" }, { label: "Ask Evaluator", role: "evaluator" }]
  };
  const compareAvailable = state?.topology_views?.readiness?.compare_available === true || report.verification === true;
  return {
    title: "Verification Summary",
    status: compareAvailable ? "Server-projected verification summary" : "Verification summary unavailable",
    tone: compareAvailable ? "verified" : "standby",
    available: compareAvailable,
    empty: "Compare is unavailable until the backend records verified recovery evidence.",
    facts: compact([
      ["Recovery verdict", report.verification ? "Verified" : "Not verified"],
      ["Passed checks", report.verification ? "Recorded by backend" : "Not projected"],
      ["Remaining risks", report.rejected_diagnosis?.reason || "Not projected"],
      ["Evidence", Array.isArray(report.citations) && report.citations.length ? `${report.citations.length} cited records` : "Not projected"],
      ["Evaluator", verdict]
    ]),
    actions: [{ label: "Ask Evaluator", role: "evaluator" }]
  };
}

function recoveryGateLabel(events) {
  const authority = [...events].reverse().find((event) => event.type === "local_fault_loop.authority.decided");
  if (!authority) return "Not yet decided";
  if (authority.payload?.outcome === "needs_human") return "Owner decision required";
  if (authority.payload?.outcome === "auto_execute_pre_authorized") return "Pre-authorized bounded execution";
  return String(authority.payload?.outcome || "Recorded").replaceAll("_", " ");
}

function recoveryNextAction(events, verification = incidentVerificationProjection({ events })) {
  if (verification.passed) return "Review verified recovery";
  if (verification.failed) return "Review failed verification with an operator";
  const authority = [...events].reverse().find((event) => event.type === "local_fault_loop.authority.decided");
  if (authority?.payload?.outcome === "needs_human") return "Owner decision outside this workspace";
  if (events.some((event) => event.type === "local_fault_loop.repair.executed")) return "Wait for independent verification";
  if (events.some((event) => event.type === "local_fault_loop.plan.proposed")) return "Wait for recorded authority decision";
  return "Wait for evaluated repair plan";
}

function compactAgentSwitcherMarkup(controls) {
  return `<nav class="unified-agent-switcher" aria-label="Open a FlowPulse role">${controls.map((node) => `<button type="button" data-agent-team-role="${escapeHtml(node.id)}" aria-label="Open ${escapeHtml(node.label)}"><i class="ph ph-${escapeHtml(iconForLive(node))}" aria-hidden="true"></i><span>${escapeHtml(node.label)}</span></button>`).join("")}</nav>`;
}

function workspaceEvidenceRailMarkup() {
  const meta = selectionMeta(selected);
  const source = sourceTruthLabel() || "Source truth unavailable";
  return `<section class="architecture-system architecture-flowpulse-system unified-context-evidence" aria-label="Workspace evidence detail">
    <header class="unified-context-header"><div><span>Workspace evidence</span><strong>${escapeHtml(meta.title)}</strong></div><button type="button" class="live-inspector-close" data-workspace-evidence-close aria-label="Close workspace evidence"><i class="ph ph-x" aria-hidden="true"></i></button></header>
    <p>${escapeHtml(meta.subtitle)}</p>
    <dl class="unified-context-facts"><div><dt>Source truth</dt><dd>${escapeHtml(source)}</dd></div><div><dt>Selection type</dt><dd>${escapeHtml(meta.kind)}</dd></div></dl>
    <p class="unified-context-note">This is a bounded workspace evidence view. It does not create component telemetry or authority.</p>
  </section>`;
}

function agentTeamHomeMarkup(controls) {
  const loop = agentTeam.loop;
  const liveAction = mode === "live"
    ? `<button type="button" class="agent-team-primary" data-agent-team-simulate data-testid="simulate-incident" ${agentTeam.starting ? "disabled" : ""}>${agentTeam.starting ? "Starting demo…" : "Simulate incident"}</button>`
    : "";
  const loopState = loop
    ? `<p class="agent-team-loop-state" aria-live="polite">${escapeHtml(loop.state === "running" ? "Demo loop is running" : `Demo loop ${loop.state.replaceAll("_", " ")}`)}</p>`
    : "";
  return `<section class="architecture-system architecture-flowpulse-system agent-team-home" aria-label="FlowPulse Control System">
    <header class="architecture-control-heading"><div><span>FlowPulse</span><strong>Control System</strong></div></header>
    ${liveAction}${loopState}
    <div class="architecture-flowpulse-nodes">${controls.map((node) => controlSystemTileMarkup(node, { rail: true })).join("")}</div>
  </section>`;
}

function agentTeamSessionMarkup(controls) {
  const role = agentTeam.role;
  const node = controls.find((item) => item.id === role);
  if (!node) return agentTeamUnavailableMarkup("Agent Team projection is unavailable.");
  const detail = node.detail || {};
  const provider = agentTeam.provider;
  const workspace = workspaceLabel();
  const component = selected?.type === "node" ? sourceComponentContext(selected.id)?.node?.label || selected.id : null;
  const activity = detail.activity?.summary || null;
  const title = role === "ledger" ? "Evidence Ledger" : node.label;
  // Keep the live rail readable: provenance and provider implementation belong
  // in the collapsed Run details disclosure, while unavailable provider state
  // remains explicit because it changes what the user can do.
  const context = [workspace, component].filter(Boolean).join(" · ");
  const providerLabel = provider?.availability === "available" ? null : provider ? "Provider unavailable" : null;
  const runId = agentTeam.loop?.run_id || agentTeam.run_id;
  const incidentId = agentTeam.loop?.incident_id || agentTeam.incident_id;
  const projectionRevision = canonicalProjectionRevision();
  const runDetail = [
    sourceTruthLabel() ? `<p><span>Source</span>${escapeHtml(sourceTruthLabel())}</p>` : "",
    provider?.truth_label ? `<p><span>Provider</span>${escapeHtml(provider.truth_label)}</p>` : ""
  ].join("");
  const canCompose = role !== "ledger" && Boolean(runId && incidentId && projectionRevision);
  return `<section class="architecture-system architecture-flowpulse-system agent-team-session" aria-label="${escapeHtml(title)} session">
    <header class="agent-team-session-header">
      <button type="button" class="agent-team-back" data-agent-team-back aria-label="Back to FlowPulse Team"><i class="ph ph-arrow-left" aria-hidden="true"></i></button>
      <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span>
      <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail.summary || "Server-projected capability")}</span></div>
      <span class="node-status-dot is-${escapeHtml(node.status || "idle")}" aria-label="${escapeHtml(statusLabel(node.status || "idle"))}"></span>
    </header>
    <p class="agent-team-context" aria-label="Current context">${escapeHtml(context)}${providerLabel ? ` · ${escapeHtml(providerLabel)}` : ""}${activity ? ` · ${escapeHtml(activity)}` : ""}</p>
    ${agentTeamDisclosureMarkup("capability", "Agent capability", `<strong>${escapeHtml(detail.summary || "Capability details unavailable")}</strong>${boundedListMarkup("Inputs", detail.inputs)}${boundedListMarkup("Outputs", detail.outputs)}${detail.authority ? `<p><span>Boundary</span>${escapeHtml(detail.authority)}</p>` : ""}${detail.provenance_refs?.length ? `<p><span>Provenance</span>${detail.provenance_refs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join("")}</p>` : ""}`)}
    ${runDetail ? agentTeamDisclosureMarkup("run", "Run details", runDetail) : ""}
    ${agentTeam.error ? `<p class="agent-team-error" role="alert">${escapeHtml(agentTeam.error)}</p>` : ""}
    <section class="agent-team-timeline" aria-live="polite">${agentTeamTimelineMarkup()}</section>
    ${agentTeamWorkspaceActionsMarkup()}
    ${canCompose ? `<form class="agent-team-composer" data-agent-team-composer data-testid="agent-chatbox" data-run-id="${escapeHtml(runId)}" data-incident-id="${escapeHtml(incidentId)}" data-projection-revision="${escapeHtml(projectionRevision)}" data-page-mode="${escapeHtml(({ architecture: "architecture", live: "live", replay: "diagnose", agents: "recovery", compare: "compare" })[mode] || "architecture")}" aria-busy="${String(agentTeam.sending)}"><textarea name="message" data-agent-team-input data-testid="agent-chat-input" maxlength="1500" required autocomplete="off" rows="2" placeholder="Ask ${escapeHtml(node.label)} about ${escapeHtml(component || "the selected node")}" ${agentTeam.sending ? "disabled" : ""}>${escapeHtml(agentTeam.draft || "")}</textarea><button type="submit" data-agent-team-send data-testid="agent-chat-send" ${agentTeam.sending ? "disabled" : ""}>${agentTeam.sending ? "Sending…" : "Send"}</button></form>${agentTeam.sending ? `<p class="agent-team-pending" role="status">${escapeHtml(node.label)} is working from the current bounded evidence.</p>` : ""}<div class="agent-team-suggestions"><button type="button" data-agent-team-suggestion="Why is this red?">Why is this red?</button><button type="button" data-agent-team-suggestion="What evidence would change this conclusion?">What evidence would change this conclusion?</button></div>` : `<p class="agent-team-readonly">${role === "ledger" ? "Evidence Ledger is read-only. It records cited evidence, hashes, and provenance." : "The current backend-owned topology revision is unavailable. Refresh before sending a question."}</p>`}
  </section>`;
}

function agentTeamDisclosureMarkup(key, title, content) {
  const open = Boolean(agentTeam.disclosures?.[key]);
  return `<section class="agent-team-disclosure"><button type="button" data-agent-team-disclosure="${key}" aria-expanded="${String(open)}"><span>${escapeHtml(title)}</span><i class="ph ph-caret-down" aria-hidden="true"></i></button>${open ? `<div>${content}</div>` : ""}</section>`;
}

function boundedListMarkup(label, items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<p><span>${escapeHtml(label)}</span>${items.map((item) => `<em>${escapeHtml(item)}</em>`).join("")}</p>`;
}

function agentTeamTimelineMarkup() {
  const shared = sharedRunModelAtCursor();
  // Agent chat records have their own append-only ledger sequence and can be
  // appended after a loop reaches its terminal event. A replay cursor limits
  // only loop-derived workspace facts; filtering these same-run messages by
  // the loop's final sequence would make a completed LOCAL CODEX answer
  // disappear from the visible sidebar.
  const messages = agentTeam.conversation?.messages || [];
  const loopItems = shared
    ? shared.events.reduce((items, event) => appendLoopTimelineItem(items, event), [])
    : agentTeam.loop_items || [];
  const entries = [...messages.map((message) => ({ source: "conversation", sequence: message.sequence, message })), ...loopItems.map((item) => ({ source: "loop", sequence: item.sequence, item }))]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-32);
  if (!entries.length) return `<p class="agent-team-empty">${agentTeam.role === "ledger" ? "No bounded ledger references are available for this run." : "Ask a question to start a server-owned conversation."}</p>`;
  return entries.map((entry) => entry.source === "conversation" ? agentTeamMessageMarkup(entry.message) : agentLoopItemMarkup(entry.item)).join("");
}

function agentTeamMessageMarkup(message) {
  if (message.kind === "handoff") return `<article class="agent-team-entry is-handoff"><strong>${escapeHtml(message.from)} → ${escapeHtml(message.to)}</strong><p>${escapeHtml(message.reason)}</p></article>`;
  if (message.kind === "assistant") return `<article class="agent-team-entry is-answer"><strong>${escapeHtml(message.responding_agent)}</strong><p>${escapeHtml(plainLanguageAgentAnswer(message.text))}</p>${agentTeamCitationMarkup(message.citations)}</article>`;
  if (message.kind === "user") return `<article class="agent-team-entry is-user"><strong>You → ${escapeHtml(message.requested_agent)}</strong><p>${escapeHtml(message.text)}</p></article>`;
  if (message.kind === "tool_request") return `<article class="agent-team-entry is-tool"><strong>${escapeHtml(message.agent)}</strong><p>Requested ${escapeHtml(message.tool)} for ${escapeHtml(message.component_id)}.</p></article>`;
  if (message.kind === "tool_result") return `<article class="agent-team-entry is-tool"><strong>${escapeHtml(message.agent)}</strong><p>${escapeHtml(message.tool)} returned ${message.result_count} bounded record${message.result_count === 1 ? "" : "s"}.</p>${agentTeamCitationMarkup(message.citations)}</article>`;
  if (message.kind === "tool_summary") return `<article class="agent-team-entry is-tool"><strong>${escapeHtml(message.agent)}</strong><p>${message.tools.map((tool) => `${escapeHtml(tool.tool)} · ${tool.result_count}`).join(" · ")}</p></article>`;
  if (message.kind === "working") return `<article class="agent-team-entry is-state"><strong>${escapeHtml(message.responding_agent)}</strong><p>Working from cited, bounded evidence.</p></article>`;
  if (message.kind === "context") return `<article class="agent-team-entry is-state"><strong>${escapeHtml(message.agent)}</strong><p>Context prepared from the current server projection.</p></article>`;
  if (message.kind === "human_gate") return `<article class="agent-team-entry is-state"><strong>${escapeHtml(message.responding_agent)}</strong><p>${escapeHtml(message.reason)}</p></article>`;
  if (message.kind === "error") return `<article class="agent-team-entry is-state"><strong>FlowPulse</strong><p>${escapeHtml(message.code)}</p></article>`;
  return "";
}

function agentLoopItemMarkup(item) {
  if (item.kind === "handoff") return `<article class="agent-team-entry is-handoff"><strong>${escapeHtml(item.from)} → ${escapeHtml(item.to)}</strong><p>${escapeHtml(item.reason)}</p></article>`;
  if (item.kind === "answer") return `<article class="agent-team-entry is-answer"><strong>${escapeHtml(item.role)}</strong><p>${escapeHtml(plainLanguageAgentAnswer(item.answer))}</p>${agentTeamCitationMarkup(item.citations)}</article>`;
  return `<article class="agent-team-entry is-state"><strong>${escapeHtml(item.label)}</strong></article>`;
}

function plainLanguageAgentAnswer(answer) {
  return String(answer || "")
    .replace(/\s*Citations?:\s*ev-local-[^\n]*/gi, "")
    .replace(/ev-local-[a-z0-9-]+/gi, "recorded evidence")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function agentTeamCitationMarkup(citations) {
  if (!Array.isArray(citations) || !citations.length) return "";
  return `<details class="agent-team-citations"><summary>${citations.length} cited record${citations.length === 1 ? "" : "s"}</summary><div>${citations.map((ref) => `<button type="button" class="citation" data-shared-evidence-id="${escapeHtml(ref)}">${escapeHtml(ref)}</button>`).join("")}</div></details>`;
}

function agentTeamWorkspaceActionsMarkup() {
  const actions = sharedRunModelAtCursor()?.workspace_actions || agentTeam.loop?.contextual_workspaces?.actions;
  if (!actions) return "";
  const labels = {
    view_diagnosis: "View Diagnosis",
    open_recovery_console: "Open Recovery Console",
    compare_recovery: "Compare Recovery"
  };
  return `<div class="agent-team-workspaces">${Object.entries(labels).map(([id, label]) => {
    const action = actions[id];
    return `<button type="button" data-agent-team-workspace="${id}" ${action?.available ? "" : "disabled"}>${escapeHtml(label)}</button>`;
  }).join("")}</div>`;
}

function agentTeamUnavailableMarkup(message) {
  return `<section class="architecture-system architecture-flowpulse-system agent-team-session"><p class="agent-team-error" role="alert">${escapeHtml(message)}</p><button type="button" class="agent-team-back" data-agent-team-back>Back to Team</button></section>`;
}

function restoreAgentTeamState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("flowpulse.agent-team.v1") || "null");
    if (saved && typeof saved === "object" && ["home", "session"].includes(saved.panel) && (saved.role === null || AGENT_TEAM_ROLES.includes(saved.role))) {
      return { panel: saved.panel, role: saved.role, conversation_id: typeof saved.conversation_id === "string" ? saved.conversation_id : null, run_id: typeof saved.run_id === "string" ? saved.run_id : null, incident_id: typeof saved.incident_id === "string" ? saved.incident_id : null, provider: null, conversation: null, loop: null, loop_items: [], error: null, sending: false, starting: false, restore_inspector: false, inspector_snapshot: null, disclosures: { capability: false, run: false }, stream_after: 0, loop_after: 0, draft: "" };
    }
  } catch { /* session restoration is optional and never becomes authority */ }
  return { panel: "home", role: null, conversation_id: null, run_id: null, incident_id: null, provider: null, conversation: null, loop: null, loop_items: [], error: null, sending: false, starting: false, restore_inspector: false, inspector_snapshot: null, disclosures: { capability: false, run: false }, stream_after: 0, loop_after: 0, draft: "" };
}

function persistAgentTeamState() {
  try {
    sessionStorage.setItem("flowpulse.agent-team.v1", JSON.stringify({
      panel: agentTeam.panel,
      role: agentTeam.role,
      conversation_id: agentTeam.conversation_id,
      run_id: agentTeam.run_id,
      incident_id: agentTeam.incident_id
    }));
  } catch { /* a private browsing storage failure must not affect the Team */ }
}

async function restoreAgentTeamSession() {
  if (agentTeamRestoreAttempted || agentTeam.panel !== "session" || !state) return;
  agentTeamRestoreAttempted = true;
  if (agentTeam.run_id !== canonicalRunId() || agentTeam.incident_id !== agentTeamIncidentId()) {
    agentTeam = { ...restoreAgentTeamState(), panel: "home", role: null, conversation_id: null, run_id: null, incident_id: null };
    persistAgentTeamState();
    renderOperationsTeamRail();
    return;
  }
  await hydrateAgentTeamSession();
}

function workspaceLabel() {
  return isIncidentWorkspace()
    ? `Incident · ${INCIDENT_STAGES.find((stage) => stage.id === incidentStage)?.label || "Investigate"}`
    : ({ architecture: "Architecture", live: "Live", replay: "Diagnose", agents: "Recovery Console", compare: "Compare" })[mode] || "Workspace";
}

function sourceTruthLabel() {
  if (sharedRunModel()) return "CAPTURED EVIDENCE";
  const view = mode === "live" ? liveTopologyView() : architectureView();
  return view?.truth?.label || state?.topology_views?.truth?.label || null;
}

function agentTeamConversationId() {
  if (agentTeam.conversation_id) return agentTeam.conversation_id;
  const runId = canonicalRunId();
  if (!runId) return null;
  const suffix = runId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(-110);
  return `conversation-${suffix}`;
}

function agentTeamIncidentId() {
  return canonicalIncidentId() || state?.topology_views?.incident_id || null;
}

async function openAgentTeamSession(role, { restoreInspector = false, inspectorSnapshot = null } = {}) {
  if (!AGENT_TEAM_ROLES.includes(role)) return;
  if (agentTeam.panel === "session" && agentTeam.role === role) {
    closeAgentTeamSession({ restoreInspector: true });
    return;
  }
  const controls = controlSystemNodes();
  const incidentId = agentTeamIncidentId();
  if (!controls.some((node) => node.id === role) || !canonicalRunId() || !incidentId) return;
  agentTeamEventSource?.close();
  agentTeam = {
    ...agentTeam,
    panel: "session",
    role,
    conversation_id: agentTeamConversationId(),
    run_id: canonicalRunId(),
    incident_id: incidentId,
    error: null,
    sending: false,
    restore_inspector: restoreInspector,
    inspector_snapshot: restoreInspector ? inspectorSnapshot || captureLiveInspectorSnapshot() : null,
    disclosures: { capability: false, run: false },
    conversation: null,
    draft: ""
  };
  persistAgentTeamState();
  renderDrawer();
  renderOperationsTeamRail();
  await hydrateAgentTeamSession();
}

function closeAgentTeamSession({ restoreInspector = false } = {}) {
  agentTeamEventSource?.close();
  agentTeamEventSource = null;
  const inspectorSnapshot = agentTeam.inspector_snapshot;
  const restore = restoreInspector && agentTeam.restore_inspector && Boolean(selected) && inspectorSnapshot?.node_id === selected.id;
  agentTeam = { ...agentTeam, panel: "home", role: null, conversation: null, error: null, sending: false, restore_inspector: false, inspector_snapshot: null, disclosures: { capability: false, run: false }, draft: "" };
  if (restore) {
    liveInspector = {
      node_id: inspectorSnapshot.node_id,
      disclosures: { ...emptyLiveInspector().disclosures, ...inspectorSnapshot.disclosures },
      scroll_top: inspectorSnapshot.scroll_top || 0,
      restore_pending: true
    };
  }
  persistAgentTeamState();
  renderDrawer();
  renderOperationsTeamRail();
  if (restore) ensureSelectedLiveComponentDetail();
}

async function hydrateAgentTeamSession({ stream = true } = {}) {
  if (agentTeam.panel !== "session" || !agentTeam.conversation_id) return;
  try {
    const [providerPayload, conversationPayload] = await Promise.all([
      request("/api/agent-control/provider"),
      request(`/api/agent-control/conversation?run_id=${encodeURIComponent(agentTeam.run_id)}&conversation_id=${encodeURIComponent(agentTeam.conversation_id)}`)
    ]);
    const provider = agentTeamProviderProjection(providerPayload);
    const conversation = agentTeamConversationProjection(conversationPayload, { conversationId: agentTeam.conversation_id });
    if (!provider || !conversation) throw new Error("Agent Team response is incompatible with the safe browser contract.");
    agentTeam = { ...agentTeam, provider, conversation, error: null };
    if (stream && !sharedRunModel()) connectAgentTeamConversationStream();
  } catch (error) {
    agentTeam = { ...agentTeam, error: error.message || "Agent Team is unavailable." };
  }
  renderDrawer();
  renderOperationsTeamRail();
}

function connectAgentTeamConversationStream() {
  if (agentTeam.panel !== "session" || !agentTeam.conversation_id || typeof EventSource !== "function") return;
  agentTeamEventSource?.close();
  agentTeamEventSource = new EventSource(`/api/agent-control/events?run_id=${encodeURIComponent(agentTeam.run_id)}&conversation_id=${encodeURIComponent(agentTeam.conversation_id)}&after=${agentTeam.stream_after || 0}`);
  agentTeamEventSource.addEventListener("agent-control", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const conversation = agentTeamConversationProjection(payload?.conversation, { conversationId: agentTeam.conversation_id });
      if (!conversation) throw new Error("Agent Team stream schema mismatch.");
      const lastEvent = Number(event.lastEventId || 0);
      agentTeam = { ...agentTeam, conversation, stream_after: Number.isSafeInteger(lastEvent) && lastEvent > agentTeam.stream_after ? lastEvent : agentTeam.stream_after, error: null };
      renderOperationsTeamRail();
    } catch {
      agentTeamEventSource?.close();
      agentTeam = { ...agentTeam, error: "Agent Team stream is unavailable because its response was incompatible." };
      renderOperationsTeamRail();
    }
  });
  agentTeamEventSource.onerror = () => {};
}

async function sendAgentTeamMessage(value) {
  const message = String(value || "").trim();
  if (!message || agentTeam.panel !== "session" || agentTeam.role === "ledger" || agentTeam.sending || !agentTeam.conversation_id || !agentTeam.run_id || !agentTeam.incident_id) return;
  const selectedComponent = canonicalSelectedComponent();
  const projectionRevision = canonicalProjectionRevision();
  if (!projectionRevision) {
    agentTeam = { ...agentTeam, error: "The server-owned topology revision is unavailable. Refresh before sending a question." };
    renderOperationsTeamRail();
    return;
  }
  agentTeam = { ...agentTeam, sending: true, error: null, draft: message };
  renderOperationsTeamRail();
  try {
    const idempotencyKey = `chat-${agentTeam.conversation_id.slice(-64)}-${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await request("/api/agent-control/chat", {
      method: "POST",
      body: JSON.stringify({
        run_id: agentTeam.run_id,
        incident_id: agentTeam.incident_id,
        projection_revision: projectionRevision,
        conversation_id: agentTeam.conversation_id,
        idempotency_key: idempotencyKey,
        requested_agent: agentTeam.role,
        page_mode: ({ architecture: "architecture", live: "live", replay: "diagnose", agents: "recovery", compare: "compare", incident: incidentAgentPageMode() })[mode] || "architecture",
        selected_component: selectedComponent,
        message
      })
    });
    const conversation = agentTeamConversationProjection(result?.conversation, { conversationId: agentTeam.conversation_id });
    if (!conversation) throw new Error("Agent Team response is incompatible with the safe browser contract.");
    agentTeam = { ...agentTeam, conversation, sending: false, draft: "" };
  } catch (error) {
    agentTeam = { ...agentTeam, sending: false, error: error.message || "Agent Team message failed.", draft: message };
  }
  renderOperationsTeamRail();
}

async function runAgentTeamDemo() {
  if (agentTeam.starting || (sharedRunModel() && !sharedRunTerminal())) return;
  agentTeam = { ...agentTeam, starting: true, error: null };
  renderOperationsTeamRail();
  try {
    const idempotencyKey = `demo-${crypto.randomUUID().replaceAll("-", "")}`;
    const payload = await request("/api/demo/agent-loop/run", {
      method: "POST",
      body: JSON.stringify({ case_id: "checkout-payment-config", round: 1, idempotency_key: idempotencyKey })
    });
    const loop = agentLoopStartProjection(payload);
    if (!loop) throw new Error("Demo loop response is incompatible with the safe browser contract.");
    bindCanonicalRunSelection(loop);
    sharedRun = { run_id: loop.run_id, incident_id: loop.incident_id, loop: null, last_sequence: 0, stream_state: "connecting", error: null };
    agentTeam = { ...agentTeam, loop, loop_items: [], loop_after: 0, starting: false };
    persistSharedRun();
    await hydrateSharedRun();
  } catch (error) {
    agentTeam = { ...agentTeam, starting: false, error: error.message || "Demo loop is unavailable." };
  }
  renderOperationsTeamRail();
}

function connectAgentLoopStream() {
  connectSharedRunStream();
}

function safeAgentLoopTimelineItem(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (event.type === "local_fault_loop.handoff.recorded" && AGENT_TEAM_ROLES.includes(payload.from) && AGENT_TEAM_ROLES.includes(payload.to) && typeof payload.reason === "string" && payload.reason.length <= 200) return { id: event.id, sequence: event.sequence, kind: "handoff", from: payload.from, to: payload.to, reason: payload.reason };
  if (event.type === "local_fault_loop.role.response" && AGENT_TEAM_ROLES.includes(payload.role) && typeof payload.safe_answer === "string" && payload.safe_answer.length <= 1_200 && Array.isArray(payload.citations)) return { id: event.id, sequence: event.sequence, kind: "answer", role: payload.role, answer: payload.safe_answer, citations: payload.citations.filter((ref) => typeof ref === "string").slice(0, 12) };
  if (["local_fault_loop.repair.executed", "local_fault_loop.verification.completed", "local_fault_loop.recovered", "local_fault_loop.stopped", "local_fault_loop.failed"].includes(event.type)) return { id: event.id, sequence: event.sequence, kind: "state", label: event.type.replace("local_fault_loop.", "").replaceAll(".", " ") };
  return null;
}

function drawerTabsForSelection(focus) {
  if (focus?.type === "control") return [["overview", "Overview"]];
  if (focus?.type === "node" && mode === "architecture" && architectureTopology()?.nodes.some((node) => node.id === focus.id)) {
    const source = sourceComponentContext(focus.id);
    return source ? sourceDrawerTabs(source) : [["overview", "Overview"]];
  }
  if (focus?.type === "node" && agentControl().graph.nodes.some((node) => node.id === focus.id)) return [["agent", "Brief"]];
  if (focus?.type === "agent-edge") return [["agent", "Handoff"]];
  if (focus?.type === "node") {
    const source = sourceComponentContext(focus.id);
    if (source) return sourceDrawerTabs(source);
    if (focus.id === "deployment") return [["changes", "Change"], ["evidence", "Evidence"], ["agent", "Reasoning"]];
    if (focus.id === "agent") return [["agent", "Reasoning"], ["evidence", "Evidence"]];
    if (focus.id === "evaluator") return [["eval", "Evaluation"], ["evidence", "Evidence"]];
    if (focus.id === "ledger") return [["evidence", "Evidence"], ["evolve", "Learning"]];
    const tabs = [["evidence", "Evidence"]];
    if (mode === "replay") tabs.push(["agent", "Reasoning"], ["eval", "Evaluation"]);
    return tabs;
  }
  if (["edge", "annotation"].includes(focus?.type)) return [["evidence", "Evidence"], ["agent", "Reasoning"], ["eval", "Evaluation"]];
  if (focus?.type === "stage") return [[tabForStage(cursor), "Stage detail"], ["evidence", "Evidence"]];
  return [["evidence", "Evidence"], ["agent", "Reasoning"], ["eval", "Evaluation"], ["repair", "Recovery"], ["verify", "Verification"], ["evolve", "Learning"]];
}

function sourceDrawerTabs(context) {
  const tabs = [["overview", "Overview"]];
  const detail = context.detail;
  const hasSignals = context.architecture
    ? context.node.signal_types.length
    : detail
      ? detail.observability.metrics.length + detail.observability.traces.length + detail.observability.logs.length + detail.observability.changes.length
      : context.evidence.length;
  const hasEvidence = context.architecture
    ? context.node.provenance_refs.length
    : detail
      ? detail.component.provenance_refs.length || detail.observability.logs.length || detail.observability.changes.length
      : context.evidence.length;
  if (hasSignals) tabs.push(["signals", "Signals"]);
  if (context.incoming.length || context.outgoing.length) tabs.push(["dependencies", "Dependencies"]);
  if (hasEvidence) tabs.push(["evidence", "Evidence"]);
  return tabs;
}

function selectionMeta(focus) {
  if (focus.type === "control") {
    const context = controlDetailContext(focus.id);
    return { kind: "FlowPulse capability", title: context?.node.label || focus.id, subtitle: context?.node.detail?.summary || "Safe control detail unavailable" };
  }
  if (focus.type === "node") {
    const context = sourceComponentContext(focus.id);
    if (context) return { kind: kindLabel(context.node.kind), title: context.node.label, subtitle: `${context.profile.capability} · ${context.profile.runtimeIdentity}` };
    const node = NODE_BY_ID.get(focus.id) || architectureTopology()?.nodes.find((item) => item.id === focus.id) || topologyIntegrity(sourceState().topology).nodes.find((item) => item.id === focus.id) || agentControl().graph.nodes.find((item) => item.id === focus.id);
    return { kind: kindLabel(node?.kind || "component"), title: node?.label || focus.id, subtitle: node?.connectivity === "unlinked" ? "Insufficient dependency evidence in the authoritative OTLP window" : node?.detail || "System component" };
  }
  if (focus.type === "agent-edge") {
    const edge = agentControl().graph.edges.find((item) => item.id === focus.id);
    return { kind: "Agent handoff", title: edge?.label || focus.id, subtitle: `${agentLabel(edge?.from)} to ${agentLabel(edge?.to)}` };
  }
  if (focus.type === "edge") {
    const edge = EDGE_BY_ID.get(focus.id) || architectureTopology()?.edges.find((item) => item.id === focus.id) || sourceState().topology?.edges?.find((item) => item.id === focus.id);
    return { kind: "Dependency path", title: edge?.label || focus.id, subtitle: `${labelFor(edge?.from)} to ${labelFor(edge?.to)}` };
  }
  if (focus.type === "annotation") return { kind: "Causal annotation", title: annotationTitle(focus.id), subtitle: TWIN_STAGES[cursor].label };
  if (focus.type === "stage") return { kind: "Replay stage", title: TWIN_STAGES[cursor].label, subtitle: `Captured incident time ${TWIN_STAGES[cursor].time}` };
  return { kind: "Incident run", title: state.incident.title, subtitle: `${state.events.length} immutable recorded events` };
}

function drawerTone(focus) {
  if (focus?.type === "control") return "agent";
  if (focus?.type === "node") {
    const source = sourceComponentContext(focus.id);
    if (source) {
      if (["impact", "root", "rejected"].includes(source.status)) return "impact";
      if (["warning", "unlinked"].includes(source.status)) return "warning";
      if (source.status === "verified") return "verified";
      return source.node.kind;
    }
    if (focus.id === "deployment") return "change";
    if (focus.id === "ledger") return "database";
    if (focus.id === "evaluator") return "evaluator";
    if (focus.id === "agent") return "agent";
    const collaborator = agentControl().graph.nodes.find((node) => node.id === focus.id);
    if (collaborator) return collaborator.id === "recovery-engineer" ? "change" : collaborator.id === "verifier" ? "api" : collaborator.id === "observer" ? "client" : "agent";
  }
  if (focus?.type === "agent-edge") return "agent";
  if (focus?.type === "edge") return "stream";
  return "agent";
}

function drawerContent(tab) {
  if (selected?.type === "control") {
    const context = controlDetailContext(selected.id);
    return context ? controlDrawerContent(context) : emptyDetail("Safe control detail is unavailable from the current backend projection.");
  }
  const component = selected?.type === "node" ? sourceComponentContext(selected.id) : null;
  if (selected?.type === "node" && !component && agentControl().graph.nodes.some((node) => node.id === selected.id)) return renderAgentOperationDetail(selected.id);
  if (selected?.type === "agent-edge") return renderAgentEdgeDetail(selected.id);
  if (component) return renderSourceDrawerContent(tab, component);
  const componentIntro = "";
  const visibleEvents = projectedEvents();
  const visibleEvidence = component ? [...projectedEvidence(visibleEvents), ...sourceState().evidence] : projectedEvidence(visibleEvents);
  const focusedEvidence = filterBySelection(visibleEvidence);
  const focusedEvents = filterEventsBySelection(visibleEvents);
  if (["metrics", "logs", "traces", "changes", "evidence"].includes(tab)) {
    const kinds = { metrics: ["metric"], logs: ["log"], traces: ["trace"], changes: ["deploy", "commit"], evidence: null }[tab];
    const records = kinds ? focusedEvidence.filter((item) => kinds.includes(item.kind)) : focusedEvidence;
    const recent = [...records].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 6);
    return componentIntro + (recent.length ? recent.map(renderEvidenceRecord).join("") : emptyDetail(`No component-scoped ${tab} evidence is available in the current authoritative window.`));
  }
  if (tab === "agent") {
    const records = focusedEvents.filter((event) => ["hypothesis.proposed", "plan.revised", "tool.called", "live.run.started", "live.run.completed", "live.run.failed"].includes(event.type));
    return componentIntro + (records.length ? records.map(renderEventRecord).join("") : emptyDetail("No agent reasoning is currently linked to this component."));
  }
  if (tab === "eval") {
    const records = focusedEvents.filter((event) => ["evaluation.rejected", "evaluation.accepted", "outcome.classified"].includes(event.type));
    return componentIntro + (records.length ? records.map(renderEventRecord).join("") : emptyDetail("No adversarial evaluation is currently linked to this component."));
  }
  if (tab === "repair") return componentIntro + renderRepairDetail(focusedEvents);
  if (tab === "verify") return componentIntro + renderVerificationDetail(focusedEvents);
  if (tab === "evolve") return componentIntro + renderEvolveDetail(focusedEvents);
  return emptyDetail("Select a detail category.");
}

function renderSourceDrawerContent(tab, context) {
  if (context.architecture) {
    if (tab === "overview") return renderArchitectureComponentContext(context);
    if (tab === "signals") return renderArchitectureSignalSummary(context);
    if (tab === "dependencies") return renderSourceDependencies(context);
    if (tab === "evidence") return renderArchitectureProvenance(context);
    return emptyDetail("No bounded architecture detail is available for this component.");
  }
  if (context.detailLoading) return liveComponentDetailLoadingMarkup(context);
  if (context.detail) return renderLiveComponentDetail(context, tab);
  if (context.detailUnavailable) return emptyDetail("Safe component detail is unavailable from the current backend projection.");
  if (tab === "overview") return `${renderSourceComponentContext(context)}${liveAgentAssessment(context)}`;
  if (tab === "signals") return renderSourceSignalSummary(context);
  if (tab === "dependencies") return renderSourceDependencies(context);
  if (tab === "evidence") return context.evidence.length
    ? [...context.evidence].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 6).map(renderEvidenceRecord).join("")
    : emptyDetail("No component-scoped evidence is available in the current authoritative window.");
  return emptyDetail("No detail is available for this component.");
}

function liveComponentDetailLoadingMarkup(context) {
  return `<section class="live-component-detail live-component-detail-state">
    <span>Loading safe backend detail</span>
    <strong>${escapeHtml(context.node.label)}</strong>
    <p>The runtime canvas remains active while this bounded read model is loaded.</p>
  </section>`;
}

function renderLiveComponentDetail(context, tab) {
  const detail = context.detail;
  const dependencySections = liveComponentRelationSections(detail.relationships);
  const signalSections = liveComponentObservabilitySections(detail.observability);
  const evidenceSections = liveComponentEvidenceSections(detail);
  if (tab === "signals") return signalSections || emptyDetail("No safe telemetry summary is available for this component in the current backend projection.");
  if (tab === "dependencies") return dependencySections || emptyDetail("No backend-projected dependency is available for this component.");
  if (tab === "evidence") return evidenceSections || emptyDetail("No bounded evidence or provenance is available for this component.");
  const statusFacts = [
    ["Current state", sourceStatusLabel(context.status, detail.runtime.status)],
    ["Source truth", detail.runtime.label],
    ["Source health", detail.component.source_health],
    detail.runtime.observed_at ? ["Observed at", formatTime(detail.runtime.observed_at)] : null,
    detail.runtime.freshness_ms != null ? ["Source age", formatAge(detail.runtime.freshness_ms)] : null,
    detail.component.signal_types.length ? ["Signal types", detail.component.signal_types.join(" · ")] : null
  ].filter(Boolean);
  return `<section class="live-component-detail">
    <header>
      <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(detail.component)}"></i></span>
      <div><span>${escapeHtml(kindLabel(detail.component.kind))}</span><strong>${escapeHtml(detail.component.label)}</strong></div>
      <span class="node-status-dot is-${escapeHtml(context.status)}" aria-label="${escapeHtml(sourceStatusLabel(context.status, detail.runtime.status))}"></span>
    </header>
    <section class="live-component-purpose"><span>Operational role</span><strong>${escapeHtml(detail.purpose.business_role)}</strong><p>${escapeHtml(detail.purpose.description)}</p></section>
    <dl class="live-component-facts">${statusFacts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    ${dependencySections}
    ${signalSections}
    ${liveComponentDataResourcesMarkup(detail.data_resources)}
    ${evidenceSections}
    <button type="button" class="live-agent-ask" data-ask-observer="${escapeHtml(detail.component.id)}">Ask Observer</button>
  </section>${liveAgentAssessment(context)}`;
}

function liveComponentRelationSections(relationships) {
  const group = (label, values) => values.length ? `<section class="live-component-section"><span>${escapeHtml(label)}</span><div class="live-component-relation-list">${values.map((related) => `<button type="button" data-focus-entity="${escapeHtml(related.id)}"><strong>${escapeHtml(related.label)}</strong><small>${escapeHtml(related.relation)}</small></button>`).join("")}</div></section>` : "";
  return `${group("Upstream dependencies", relationships.upstream)}${group("Downstream dependencies", relationships.downstream)}`;
}

function liveComponentObservabilitySections(observability) {
  const metricValue = (item) => [
    item.name,
    item.before != null && item.after != null ? `${item.before} → ${item.after}${item.unit ? ` ${item.unit}` : ""}` : item.value != null ? `${item.value}${item.unit ? ` ${item.unit}` : ""}` : null,
    item.aggregation,
    item.threshold
  ].filter(Boolean).join(" · ");
  const traceValue = (item) => [item.operation, item.peer_target, item.status, item.error, item.trace_ref ? `trace ${item.trace_ref}` : null].filter(Boolean).join(" · ");
  const changeValue = (item) => [item.target, item.flag, item.before != null && item.after != null ? `${item.before} → ${item.after}` : null, item.applied_at ? formatTime(item.applied_at) : null].filter(Boolean).join(" · ");
  const group = (label, items, describe) => items.length ? `<section class="live-component-section"><span>${escapeHtml(label)}</span><div class="live-component-observability">${items.map((item) => `<article><strong>${escapeHtml(item.title)}</strong>${describe(item) ? `<p>${escapeHtml(describe(item))}</p>` : ""}<small>${escapeHtml(item.source)} · ${escapeHtml(formatTime(item.observed_at))}</small><code>${escapeHtml(item.evidence_id)} · ${escapeHtml(item.record_sha256.slice(0, 12))}</code></article>`).join("")}</div></section>` : "";
  return [
    group("Metrics", observability.metrics, metricValue),
    group("Traces", observability.traces, traceValue),
    group("Recorded log events", observability.logs, (item) => item.summary || "Sanitized event metadata"),
    group("Configuration changes", observability.changes, changeValue)
  ].join("");
}

function liveComponentDataResourcesMarkup(resources) {
  if (!Array.isArray(resources) || !resources.length) return "";
  return `<section class="live-component-section"><span>Bounded data resources</span><div class="live-component-observability">${resources.map((resource) => `<article><strong>${escapeHtml(resource.kind)}</strong><p>${escapeHtml(resource.name || resource.id || "Canonical resource")}</p>${resource.consumer_group ? `<small>consumer group · ${escapeHtml(resource.consumer_group)}</small>` : ""}</article>`).join("")}</div></section>`;
}

function liveComponentEvidenceSections(detail) {
  const provenance = detail.component.provenance_refs;
  const records = [...detail.observability.logs, ...detail.observability.changes];
  if (!provenance.length && !records.length) return "";
  return `<section class="live-component-section"><span>Evidence and provenance</span><div class="live-component-evidence">${provenance.map((reference) => `<code>${escapeHtml(reference)}</code>`).join("")}${records.map((item) => `<code>${escapeHtml(item.evidence_id)} · ${escapeHtml(item.record_sha256.slice(0, 12))}</code>`).join("")}</div></section>`;
}

function liveAgentAssessment(context) {
  if (!["impact", "root", "rejected", "fault", "warning", "pending"].includes(context.status)) return "";
  const report = agentControl().report;
  if (!report?.summary || report.title === "Agent control unavailable" || report.summary === "No agent projection is available.") return "";
  return `<section class="live-agent-assessment"><span>Run-level agent assessment</span><strong>${escapeHtml(report.title)}</strong><p>${escapeHtml(report.summary)}</p></section>`;
}

function renderAgentOperationDetail(id) {
  const control = agentControl();
  const node = control.graph.nodes.find((item) => item.id === id);
  if (!node) return emptyDetail("Agent operation detail is unavailable.");
  const activity = control.activity.filter((item) => item.agent_id === id).slice(-4).reverse();
  const proposals = (control.orchestration?.proposals || []).filter((item) => item.agent_id === node.role);
  const manifest = node.manifest;
  const latestActivity = activity[0];
  const latestProposal = proposals.at(-1);
  return `<div class="detail-intro"><strong>${escapeHtml(agentStatusLabel(node.status))}</strong><span>${escapeHtml(node.detail)} · ledger sequence ${control.last_sequence}</span></div>
    ${latestActivity ? `<article class="detail-record"><header><span>Latest recorded work</span><span>sequence ${latestActivity.sequence}</span></header><h3>${escapeHtml(latestActivity.type)}</h3><p>${escapeHtml(latestActivity.summary)}</p>${latestActivity.evidence_refs.length ? `<div class="citation-list">${latestActivity.evidence_refs.map((ref) => `<span class="citation">${escapeHtml(ref)}</span>`).join("")}</div>` : ""}</article>` : emptyDetail("This role has not emitted an event in the current run.")}
    ${latestProposal ? `<article class="detail-record is-accepted"><header><span>Latest harness proposal</span><span>sequence ${latestProposal.sequence}</span></header><h3>${escapeHtml(latestProposal.type)}</h3><p>${escapeHtml(latestProposal.model)} · ${escapeHtml(latestProposal.agent_version)}</p><details class="record-disclosure"><summary>Proposal metadata and evidence</summary><pre class="payload">${escapeHtml(JSON.stringify({ prompt_hash: latestProposal.prompt_hash, budget: latestProposal.budget, evidence_refs: latestProposal.evidence_refs, parent_event_ids: latestProposal.parent_event_ids }, null, 2))}</pre></details></article>` : ""}
    ${manifest ? `<details class="agent-boundary"><summary>Role boundary and safeguards</summary><p>Can emit ${escapeHtml(manifest.emits.join(", "))}.</p><div class="citation-list">${manifest.tools.map((tool) => `<span class="citation">${escapeHtml(tool)}</span>`).join("") || '<span class="citation">No direct tools</span>'}</div><pre class="payload">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></details>` : `<details class="agent-boundary"><summary>System-owned boundary</summary><p>This component is deterministic infrastructure, not an LLM role.</p></details>`}`;
}

function renderAgentEdgeDetail(id) {
  const edge = agentControl().graph.edges.find((item) => item.id === id);
  if (!edge) return emptyDetail("Agent handoff detail is unavailable.");
  return `<div class="detail-intro"><strong>${escapeHtml(edge.label)}</strong><span>${escapeHtml(agentLabel(edge.from))} to ${escapeHtml(agentLabel(edge.to))}. This path is active only when matching ledger events exist.</span></div>`;
}

function renderEvidenceRecord(item) {
  return `<article class="detail-record">
    <header><span>${escapeHtml(item.id)}</span><span>${escapeHtml(item.source || item.kind)}</span></header>
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.fact)}</p>
    <div class="citation-list"><span class="citation">${escapeHtml(item.entity)}</span><span class="citation">${escapeHtml(formatTime(item.at))}</span></div>
    <details class="record-disclosure"><summary>Inspect signal &amp; provenance</summary>${renderTelemetryPreview(item)}
    ${item.provenance ? `<div class="telemetry-provenance"><span>${escapeHtml(item.provenance.file || "OTLP capture")}</span><span>bytes ${escapeHtml(item.provenance.byte_start ?? "n/a")}–${escapeHtml(item.provenance.byte_end ?? "n/a")}</span><span>sha256 ${escapeHtml(String(item.provenance.sha256 || "").slice(0, 16))}</span></div>` : ""}
    ${item.value ? `<pre class="payload">${escapeHtml(JSON.stringify(item.value, null, 2))}</pre>` : ""}</details>
  </article>`;
}

function renderTelemetryPreview(item) {
  if (!item?.provenance || !item.payload) return "";
  const rows = [];
  if (item.signal === "logs") {
    for (const resource of item.payload.resourceLogs || []) {
      for (const scope of resource.scopeLogs || []) {
        for (const record of scope.logRecords || []) {
          const body = otlpValue(record.body);
          if (body) rows.push(`${record.severityText || "LOG"} · ${body}${record.traceId ? ` · trace ${record.traceId.slice(0, 12)}` : ""}`);
        }
      }
    }
  }
  if (item.signal === "traces") {
    for (const resource of item.payload.resourceSpans || []) {
      for (const scope of resource.scopeSpans || []) {
        for (const span of scope.spans || []) rows.push(`${span.status?.code === 2 ? "ERROR" : "SPAN"} · ${span.name || "unnamed span"}${span.traceId ? ` · trace ${span.traceId.slice(0, 12)}` : ""}`);
      }
    }
  }
  if (item.signal === "metrics") {
    for (const resource of item.payload.resourceMetrics || []) {
      for (const scope of resource.scopeMetrics || []) {
        for (const metric of scope.metrics || []) rows.push(`METRIC · ${metric.name || "unnamed metric"}${metric.unit ? ` · ${metric.unit}` : ""}`);
      }
    }
  }
  if (!rows.length) return "";
  return `<ul class="telemetry-preview">${rows.slice(-5).map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>`;
}

function renderEventRecord(event) {
  const presentation = eventPresentation(event);
  return `<article class="detail-record is-${presentation.tone || "neutral"}">
    <header><span>${escapeHtml(event.actor)}</span><span>${formatOffset(event.offset_ms)}</span></header>
    <h3>${escapeHtml(presentation.title)}</h3>
    <p>${escapeHtml(presentation.copy)}</p>
    ${presentation.score ? `<div class="citation-list"><span class="citation">score ${presentation.score}</span></div>` : ""}
    ${event.evidence_refs.length ? `<div class="citation-list">${event.evidence_refs.map((id) => `<span class="citation">${escapeHtml(id)}</span>`).join("")}</div>` : ""}
    <details class="record-disclosure"><summary>Ledger payload</summary><pre class="payload">${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre></details>
  </article>`;
}

function renderRepairDetail(events) {
  const records = events.filter((event) => ["repair.proposed", "approval.requested", "approval.granted", "repair.executed"].includes(event.type));
  const repair = records.find((event) => event.type === "repair.proposed")?.payload || state.repair;
  const boundary = `<div class="detail-intro"><strong>Checkout-only rollback boundary</strong><span>${escapeHtml(repair.from)} to ${escapeHtml(repair.to)}. Abort if ${escapeHtml(repair.abort_if)}.</span></div>`;
  return boundary + (records.length ? records.map(renderEventRecord).join("") : emptyDetail("A bounded repair has not been proposed at this replay position."));
}

function renderVerificationDetail(events) {
  const verification = events.find((event) => event.type === "verification.completed");
  if (!verification) return emptyDetail("Verification waits for an approved and executed repair.");
  return `<div class="detail-intro"><strong>Recovery thresholds passed</strong><span>${state.mode === "development" ? "Verification uses fresh OTLP evidence recorded after the real local rollback." : "Verification uses captured post-repair evidence from the immutable incident bundle."}</span></div>${verification.payload.checks.map((check) => `<div class="verification-grid">
    <div class="verification-value"><span>Before</span><strong>${formatMetric(check.metric, check.before)}</strong></div>
    <div class="verification-value after"><span>${escapeHtml(check.threshold)}</span><strong>${formatMetric(check.metric, check.after)}</strong></div>
  </div>`).join("")}${renderEventRecord(verification)}`;
}

function renderEvolveDetail(events) {
  const regression = events.find((event) => event.type === "regression.created");
  const policy = events.find((event) => event.type === "policy.evaluated");
  if (!regression && !policy) return emptyDetail("Regression and policy evaluation appear after verified recovery.");
  return `${regression ? renderEventRecord(regression) : ""}${policy ? `<div class="detail-intro"><strong>${escapeHtml(policy.payload.candidate)}</strong><span>${escapeHtml(policy.payload.promotion.replaceAll("_", " "))}. Promotion still requires an owner.</span></div>${policy.payload.gates.map((gate) => `<div class="gate-row"><span class="gate-mark">${gate.passed ? "✓" : "×"}</span><div><strong>${escapeHtml(gate.label)}</strong><small>${escapeHtml(gate.id)}</small></div></div>`).join("")}${renderEventRecord(policy)}` : ""}`;
}

function projectedEvents() {
  const shared = sharedRunModelAtCursor();
  if (shared) return shared.events;
  if (mode !== "replay") return state.events;
  return eventsAtStage(state.events, cursor);
}

function projectedEvidence(events) {
  const ids = new Set(events.flatMap((event) => event.evidence_refs));
  return state.evidence.filter((item) => ids.has(item.id));
}

function filterBySelection(evidence) {
  if (selected?.type !== "node" && selected?.type !== "edge") return evidence;
  const entities = selectionEntities();
  if (!entities.size || selected?.id === "ledger" || selected?.id === "agent" || selected?.id === "evaluator") return evidence;
  return evidence.filter((item) => entities.has(item.entity));
}

function filterEventsBySelection(events) {
  if (selected?.type !== "node" && selected?.type !== "edge") return events;
  const entities = selectionEntities();
  if (!entities.size || ["ledger", "agent", "evaluator", "deployment"].includes(selected?.id)) return events;
  const evidenceIds = new Set(state.evidence.filter((item) => entities.has(item.entity)).map((item) => item.id));
  return events.filter((event) => (event.evidence_refs || []).some((id) => evidenceIds.has(id)) || [...entities].some((entity) => JSON.stringify(event.payload || {}).includes(entity)));
}

function selectionEntities() {
  const serviceIds = new Set([...(state.topology?.services || []).map((service) => service.id), ...(sourceState().topology?.nodes || []).map((node) => node.id)]);
  if (selected?.type === "node" && serviceIds.has(selected.id)) return new Set([selected.id]);
  if (selected?.type === "edge") {
    const edge = EDGE_BY_ID.get(selected.id) || sourceState().topology?.edges?.find((item) => item.id === selected.id);
    return new Set([edge?.from, edge?.to].filter((id) => serviceIds.has(id)));
  }
  return new Set();
}

function handleCanvasSelection(event) {
  if (event.target.closest("[data-start-guided-replay]")) {
    void runAgentTeamDemo();
    return;
  }
  const recoveryRole = event.target.closest("[data-recovery-role]");
  if (recoveryRole) {
    recoverySelectedRole = recoveryRole.dataset.recoveryRole;
    renderCanvas();
    return;
  }
  const sharedEvidence = event.target.closest("[data-shared-evidence-id]");
  if (sharedEvidence) {
    selected = null;
    openDrawer({ type: "node", id: canonicalSelectedComponent() || "checkout" }, "evidence");
    return;
  }
  const architectureDetailSurface = event.target.closest("[data-architecture-detail-id], [data-control-detail-id]");
  if (architectureDetailSurface) {
    closeArchitectureDetail({ restoreFocus: false });
    return;
  }
  const architectureThumbnail = event.target.closest("[data-architecture-thumbnail-id]");
  if (architectureThumbnail) {
    openArchitectureDetail(architectureThumbnail.dataset.architectureThumbnailId);
    return;
  }
  const controlNode = event.target.closest("[data-control-node-id]");
  if (controlNode) {
    openControlDetail(controlNode.dataset.controlNodeId, { focus: false });
    return;
  }
  const node = event.target.closest("[data-node-id]");
  const edge = event.target.closest("[data-edge-id]");
  const agentEdge = event.target.closest("[data-agent-edge-id]");
  if (node) openDrawer({ type: "node", id: node.dataset.nodeId }, defaultTabForNode(node.dataset.nodeId));
  else if (edge) openDrawer({ type: "edge", id: edge.dataset.edgeId }, "evidence");
  else if (agentEdge) openDrawer({ type: "agent-edge", id: agentEdge.dataset.agentEdgeId }, "agent");
}

function handleCanvasKeydown(event) {
  if (architectureDetail?.scope === mode && event.key === "Escape") {
    event.preventDefault();
    closeArchitectureDetail({ restoreFocus: true });
    return;
  }
  if (event.target.matches("[data-architecture-thumbnail-id]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openArchitectureDetail(event.target.dataset.architectureThumbnailId);
    return;
  }
  if (event.target.matches("[data-control-node-id]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openControlDetail(event.target.dataset.controlNodeId, { focus: true });
    return;
  }
  if (!event.target.matches("[data-node-id], [data-edge-id], [data-agent-edge-id]")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (event.target.dataset.nodeId) openDrawer({ type: "node", id: event.target.dataset.nodeId }, defaultTabForNode(event.target.dataset.nodeId));
    else if (event.target.dataset.agentEdgeId) openDrawer({ type: "agent-edge", id: event.target.dataset.agentEdgeId }, "agent");
    else openDrawer({ type: "edge", id: event.target.dataset.edgeId }, "evidence");
  }
}

function handleAnnotationSelection(event) {
  const note = event.target.closest("[data-annotation-id]");
  if (note) openDrawer({ type: "annotation", id: note.dataset.annotationId }, tabForAnnotation(note.dataset.annotationId));
}

function handleDrawerTab(event) {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  activeTab = tab.dataset.tab;
  renderDrawer();
}

function handleDrawerEntityFocus(event) {
  const askObserver = event.target.closest("[data-ask-observer]");
  if (askObserver) {
    void openAgentTeamSession("observer", { restoreInspector: true, inspectorSnapshot: captureLiveInspectorSnapshot() });
    return;
  }
  const suggestion = event.target.closest("[data-agent-team-suggestion]");
  if (suggestion) {
    setAgentTeamDraft(suggestion.dataset.agentTeamSuggestion || "", { focus: true });
    return;
  }
  const sharedEvidence = event.target.closest("[data-shared-evidence-id]");
  if (sharedEvidence) {
    openDrawer({ type: "node", id: canonicalSelectedComponent() || "checkout" }, "evidence");
    return;
  }
  const target = event.target.closest("[data-focus-entity]");
  if (target) openDrawer({ type: "node", id: target.dataset.focusEntity }, "overview");
}

function openDrawer(focus, tab = "evidence") {
  if (focus?.type === "node") focus = { ...focus, id: normalizeServiceId(focus.id) };
  if (selected?.type === focus?.type && selected?.id === focus?.id) {
    selected = null;
    renderDrawer();
    renderOperationsTeamRail();
    return;
  }
  selected = focus;
  if ((mode === "live" || isUnifiedRailWorkspace()) && focus?.type === "node" && isRailRuntimeNode(focus.id) && liveInspector.node_id !== focus.id) liveInspector = emptyLiveInspector(focus.id);
  activeTab = tab;
  if ((mode === "live" || isUnifiedRailWorkspace()) && focus?.type === "node" && isRailRuntimeNode(focus.id)) void requestLiveComponentDetail(focus.id);
  renderDrawer();
  renderOperationsTeamRail();
}

function ensureSelectedLiveComponentDetail() {
  if ((mode === "live" || isUnifiedRailWorkspace()) && selected?.type === "node" && isRailRuntimeNode(selected.id)) void requestLiveComponentDetail(selected.id);
}

function closeDrawer() {
  selected = null;
  liveInspector = emptyLiveInspector();
  renderDrawer();
  renderOperationsTeamRail();
  els["details-button"].focus();
}

function setMode(nextMode) {
  stopPlayback();
  if (!state) return;
  if (nextMode === "incident" && els["app-shell"].dataset.controlPlaneAdapter === "true") return;
  const shared = sharedRunModel();
  const actionByMode = { replay: "view_diagnosis", agents: "open_recovery_console", compare: "compare_recovery" };
  const requiredAction = actionByMode[nextMode];
  // The Diagnose canvas is an immutable incident snapshot. When the server
  // supplies its complete, revision-bound focus overlay, it remains useful for
  // post-incident review even if the loop has since terminally failed or
  // recovered and has therefore disabled the forward workflow action. This is
  // not a browser readiness inference: incidentFocusWorkspace validates the
  // exact server run, revision, six nodes, and five relations before allowing
  // the historical view. Recovery and Compare remain governed solely by their
  // server action gates.
  const serverFocusReady = nextMode === "replay" && shared && incidentFocusWorkspace(
    shared.topology,
    shared.topology?.snapshots?.incident,
    diagnoseViewTopology(state?.topology_views)
  ).availability === "ready";
  if (shared && requiredAction && shared.workspace_actions?.[requiredAction]?.available !== true && !serverFocusReady) {
    showToast(`This workspace is unavailable until ${shared.workspace_actions?.[requiredAction]?.prerequisites?.filter((item) => !item.satisfied).map((item) => item.id.replaceAll("_", " ")).join(" and ") || "its server prerequisites are recorded"}.`);
    return;
  }
  if (["incident", "replay", "agents", "compare"].includes(nextMode)) {
    // Workspace navigation returns to the approved summary rail. A chat
    // session is available only after the user explicitly opens an agent.
    selected = null;
    liveInspector = emptyLiveInspector();
    if (agentTeam.panel === "session") {
      agentTeamEventSource?.close();
      agentTeamEventSource = null;
      agentTeam = { ...agentTeam, panel: "home", role: null, conversation: null, error: null, sending: false, restore_inspector: false, inspector_snapshot: null, disclosures: { capability: false, run: false }, draft: "" };
      persistAgentTeamState();
    }
  }
  if (!isSelectionValidForMode(selected, nextMode)) {
    selected = null;
    liveInspector = emptyLiveInspector();
  }
  // A workspace switch cannot inherit a captured pointer from the previous
  // canvas. In particular, Compare's divider must never leak into Live pan.
  livePan = null;
  compareDrag = null;
  canvasPointer = null;
  els["twin-canvas"].classList.remove("is-panning");
  els["compare-handle"].classList.remove("is-dragging");
  mode = nextMode;
  if (architectureDetail?.scope !== mode) architectureDetail = null;
  if (shared && sharedRunFollowing) cursor = Math.max(0, shared.events.length - 1);
  else if (mode === "live" || mode === "agents") cursor = availableStage(state.events);
  render();
  ensureSelectedLiveComponentDetail();
}

function configureCanvasWorld(active) {
  const world = els["canvas-layers"];
  world.classList.toggle("is-live-world", active);
  els["twin-canvas"].classList.toggle("is-pan-enabled", active);
  if (!active) {
    world.style.width = "";
    world.style.height = "";
    world.style.inset = "";
    world.style.transform = "";
    return;
  }
  world.style.width = `${LIVE_WORLD.width}px`;
  world.style.height = `${LIVE_WORLD.height}px`;
  world.style.inset = "auto";
  if (!liveView.initialized || renderedMode !== mode) resetLiveView();
  else applyLiveView();
}

function setLiveZoom(nextScale) {
  if (!isCanvasNavigationMode(mode)) return;
  const scale = Math.max(LIVE_WORLD.minScale, Math.min(LIVE_WORLD.maxScale, Math.round(nextScale * 10) / 10));
  const rect = els["twin-canvas"].getBoundingClientRect();
  const center = { x: rect.width / 2, y: rect.height / 2 };
  const worldPoint = { x: (center.x - liveView.x) / liveView.scale, y: (center.y - liveView.y) / liveView.scale };
  liveView = { ...liveView, scale, x: center.x - worldPoint.x * scale, y: center.y - worldPoint.y * scale, initialized: true };
  applyLiveView();
}

function resetLiveView() {
  const rect = els["twin-canvas"].getBoundingClientRect();
  liveView = containedLiveView(rect);
  applyLiveView();
}

function containedLiveView(rect = els["twin-canvas"].getBoundingClientRect()) {
  return containedCanvasView({
    viewportWidth: rect.width,
    viewportHeight: rect.height,
    worldWidth: LIVE_WORLD.width,
    worldHeight: LIVE_WORLD.height,
    minScale: LIVE_WORLD.minScale,
    maxScale: 1,
    inset: 24
  });
}

function applyLiveView() {
  if (!isCanvasNavigationMode(mode)) return;
  els["canvas-layers"].style.transform = `translate(${Math.round(liveView.x)}px, ${Math.round(liveView.y)}px) scale(${liveView.scale})`;
  updateZoomControls();
}

function updateZoomControls() {
  if (!els["zoom-level"]) return;
  const fitted = containedLiveView();
  els["zoom-level"].textContent = `${Math.round(liveView.scale * 100)}%`;
  els["zoom-out"].disabled = !isCanvasNavigationMode(mode) || liveView.scale <= LIVE_WORLD.minScale;
  els["zoom-in"].disabled = !isCanvasNavigationMode(mode) || liveView.scale >= LIVE_WORLD.maxScale;
  els["zoom-reset"].disabled = !isCanvasNavigationMode(mode) || (Math.abs(liveView.scale - fitted.scale) < .001 && Math.abs(liveView.x - fitted.x) < 1 && Math.abs(liveView.y - fitted.y) < 1);
}

function startLivePan(event) {
  if (!claimCanvasPointer(event, "pan")) return;
  livePan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: liveView.x, y: liveView.y };
  els["twin-canvas"].classList.add("is-panning");
  els["twin-canvas"].setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveLivePan(event) {
  if (!livePan || event.pointerId !== livePan.pointerId || canvasPointer?.action !== "pan") return;
  liveView = { ...liveView, x: livePan.x + event.clientX - livePan.startX, y: livePan.y + event.clientY - livePan.startY, initialized: true };
  applyLiveView();
}

function endLivePan(event) {
  if (!livePan || event.pointerId !== livePan.pointerId || canvasPointer?.action !== "pan") return;
  livePan = null;
  canvasPointer = transitionCanvasPointer(event, "up");
  els["twin-canvas"].classList.remove("is-panning");
  els["twin-canvas"].releasePointerCapture?.(event.pointerId);
}

function transitionCanvasPointer(event, phase) {
  return canvasPointerTransition({
    current: canvasPointer,
    mode: isIncidentCompareStage() ? "compare" : mode,
    phase,
    pointerId: event.pointerId,
    button: event.button,
    isCompareHandle: Boolean(event.target.closest("#compare-handle")),
    isInteractive: Boolean(event.target.closest(".twin-node, .causal-note, .edge-hit, button, input, summary"))
  });
}

function claimCanvasPointer(event, action) {
  canvasPointer = transitionCanvasPointer(event, "down");
  return canvasPointer?.pointerId === event.pointerId && canvasPointer.action === action;
}

async function togglePlayback() {
  if (playing) {
    stopPlayback();
    render();
    return;
  }
  if (mode !== "replay") mode = "replay";
  if (sharedRunModel()) {
    await playSharedRunReplay();
    return;
  }
  await playReplay();
}

async function playSharedRunReplay() {
  if (playing) return;
  const events = sharedRunModel()?.events || [];
  playing = true;
  sharedRunFollowing = false;
  render();
  try {
    while (playing && cursor < events.length - 1) {
      cursor += 1;
      render();
      await wait(Math.max(180, Number(els["speed-select"].value) || 420));
    }
    sharedRunFollowing = cursor >= events.length - 1;
  } finally {
    playing = false;
    render();
  }
}

async function playReplay() {
  if (playing) return;
  playing = true;
  render();
  try {
    while (playing) {
      const available = availableStage(state.events);
      if (cursor < available) {
        cursor += 1;
        render();
        await wait(playDelay());
        continue;
      }
      if (state.waiting_for_approval) {
        showToast("Replay paused at the owner rollback gate.");
        break;
      }
      if (state.complete) {
        showToast("Recovery verified. Regression and evolve gates passed.");
        break;
      }
      await mutate("/api/next");
      await wait(Math.max(160, playDelay() * .45));
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    playing = false;
    render();
  }
}

async function stepForward() {
  stopPlayback();
  if (sharedRunModel()) {
    seekSharedEvent(cursor + 1);
    return;
  }
  if (mode !== "replay") mode = "replay";
  const available = availableStage(state.events);
  if (cursor < available) {
    cursor += 1;
    render();
    return;
  }
  if (state.waiting_for_approval) {
    showToast("Owner approval is required before repair execution.");
    render();
    return;
  }
  if (state.complete) {
    showToast("Replay is complete.");
    return;
  }
  try {
    await mutate("/api/next");
    const nextAvailable = availableStage(state.events);
    if (nextAvailable > cursor) cursor += 1;
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

function seek(index) {
  if (sharedRunModel()) {
    seekSharedEvent(index);
    return;
  }
  if (mode !== "replay") mode = "replay";
  const available = availableStage(state.events);
  cursor = Math.max(0, Math.min(available, Number(index) || 0));
  stopPlayback();
  render();
}

async function restartReplay() {
  stopPlayback();
  if (sharedRunModel()) {
    seekSharedEvent(0);
    return;
  }
  setBusy(true);
  try {
    state = await request("/api/reset", { method: "POST", body: "{}" });
    mode = "replay";
    cursor = 0;
    selected = null;
    showToast("A new immutable replay run is ready.");
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function monitorDevelopmentVerification() {
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(1_500);
    try {
      state = await request("/api/development/verify", { method: "POST", body: "{}" });
      cursor = availableStage(state.events);
      showToast("Fresh telemetry verified recovery without another human action.");
      render();
      return;
    } catch (error) {
      if (!/post-repair.*telemetry/i.test(error.message)) {
        showToast(error.message, true);
        return;
      }
    }
  }
  render();
}

async function handleDevelopmentAction() {
  if (!developmentStatus?.enabled) return;
  setBusy(true);
  try {
    const action = developmentAction();
    if (action === "connect") {
      showToast("Preparing the pinned Astronomy Shop runtime. This can take several minutes.");
      await request("/api/development/setup", { method: "POST", body: "{}" });
      await request("/api/development/start", { method: "POST", body: "{}" });
      showToast("Pinned local runtime started. Waiting for real OTLP telemetry.");
    } else if (action === "case") {
      state = await request("/api/development/case", { method: "POST", body: "{}" });
      mode = "live";
      showToast("Versioned payment-unreachable change applied to the local checkout runtime.");
    } else if (action === "investigate") {
      state = await request("/api/development/investigate", { method: "POST", body: "{}" });
      mode = "replay";
      cursor = availableStage(state.events);
      showToast("Evidence agent rejected weak service blame and reached the owner gate.");
    } else if (action === "verify") {
      state = await request("/api/development/verify", { method: "POST", body: "{}" });
      mode = "replay";
      cursor = availableStage(state.events);
      showToast("Fresh post-repair telemetry verified recovery and produced a regression record.");
    }
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function runLive() {
  stopPlayback();
  if (!state.live_available) {
    showToast("Set OPENAI_API_KEY to run a fresh GPT-5.6 investigation.", true);
    return;
  }
  setBusy(true);
  els["live-button"].textContent = "GPT-5.6 investigating";
  try {
    const response = await request("/api/live", { method: "POST", body: "{}" });
    state = response.state;
    mode = "live";
    cursor = availableStage(state.events);
    showToast(`Live evaluator score ${Math.round(response.result.evaluation.score * 100)}%.`);
    render();
  } catch (error) {
    let requestGeneration = null;
    try {
      const requestedRunId = selectedRunId;
      requestGeneration = beginCanonicalStateRequest();
      const nextState = await request(browserStatePath(requestedRunId));
      commitCanonicalStateResponse({
        requestedRunId,
        requestGeneration,
        nextState
      });
    } catch { /* keep the last visible projection */ }
    finally {
      if (requestGeneration !== null) settleSupersededCanonicalLoading(requestGeneration);
    }
    showToast(error.message, true);
    render();
  } finally {
    els["live-button"].textContent = "Run GPT-5.6";
    setBusy(false);
  }
}

async function mutate(path) {
  setBusy(true);
  try {
    state = await request(path, { method: "POST", body: "{}" });
    render();
    return state;
  } finally {
    setBusy(false);
  }
}

function currentFrame() {
  return frameFor(mode === "live" ? availableStage(state?.events || []) : cursor);
}

function sharedRunAnnotations(shared) {
  const notes = [];
  const has = (type) => shared.events.some((event) => event.type === type);
  if (has("local_fault_loop.fault.injected")) notes.push({ id: "deploy", tone: "change", title: "Controlled fault injected", copy: "Bounded fixture fault recorded." });
  if (has("local_fault_loop.observer.detected")) notes.push({ id: "propagation", tone: "impact", title: "Observer detected impact", copy: "Cited anomaly evidence opened the incident." });
  if (has("local_fault_loop.hypothesis.accepted")) notes.push({ id: "root", tone: "root", title: "Causal hypothesis accepted", copy: "Change, mechanism, and timing support the initiating condition." });
  if (has("local_fault_loop.verification.completed")) notes.push({ id: "recovery", role: "outcome", tone: shared.state === "recovered" ? "verified" : "warning", title: "Independent verification", copy: "Verification event controls recovery availability." });
  return notes.slice(-2);
}

function updateControls() {
  const shared = sharedRunModel();
  if (shared) {
    const max = Math.max(0, shared.events.length - 1);
    const replayable = max > 0;
    els["restart-button"].disabled = busy || !replayable;
    els["back-button"].disabled = busy || playing || !replayable || cursor <= 0;
    els["forward-button"].disabled = busy || playing || !replayable || cursor >= max;
    els["play-button"].disabled = busy || !replayable || cursor >= max && !playing;
    els["play-button"].textContent = playing ? "Pause replay" : cursor >= max ? "At current event" : "Play immutable history";
    els["live-button"].disabled = busy || playing || (shared.state === "running" && agentTeam.starting);
    els["details-button"].disabled = busy;
    els["development-button"].disabled = true;
    return;
  }
  const replay = mode === "replay";
  els["restart-button"].disabled = busy || playing || !replay;
  els["back-button"].disabled = busy || playing || !replay || cursor === 0;
  els["forward-button"].disabled = busy || playing || !replay || state?.waiting_for_approval || state?.complete;
  els["play-button"].disabled = busy || !replay || (state?.complete && cursor >= availableStage(state.events));
  els["play-button"].textContent = playing ? "Pause replay" : state?.waiting_for_approval ? "Paused at owner gate" : state?.complete && cursor >= availableStage(state.events) ? "Replay complete" : "Run guided replay";
  els["live-button"].disabled = busy || playing;
  els["details-button"].disabled = busy;
  els["development-button"].disabled = busy || playing;
}

function stopPlayback() {
  playing = false;
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle("is-busy", value);
  updateControls();
}

function setLoading(value) {
  els["app-shell"].classList.toggle("is-loading", value);
}

function showError(message) {
  els["error-message"].textContent = message;
  els["error-banner"].hidden = false;
}

function hideError() {
  els["error-banner"].hidden = true;
}

function showToast(message, error = false) {
  if (els["app-shell"].dataset.controlPlaneMode === "incident") return;
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${error ? " error" : ""}`;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

function eventPresentation(event) {
  const p = event.payload;
  switch (event.type) {
    case "hypothesis.proposed": return { title: p.title || "Hypothesis proposed", copy: p.claim || "A causal claim entered evaluation.", tone: "neutral", score: percent(p.confidence) };
    case "evaluation.rejected": return { title: "Evaluator rejected the diagnosis", copy: p.reason, tone: "rejected", score: percent(p.score) };
    case "plan.revised": return { title: "Investigator replanned", copy: p.reason, tone: "change" };
    case "evaluation.accepted": return { title: "Causal finding accepted", copy: p.reason, tone: "accepted", score: percent(p.score) };
    case "repair.proposed": return { title: "Bounded checkout rollback proposed", copy: p.expected_effect, tone: "approval" };
    case "approval.requested": return { title: "Owner approval requested", copy: p.reason, tone: "approval" };
    case "approval.granted": return { title: "Owner approved the rollback", copy: `${p.owner} approved ${p.scope}.`, tone: "accepted" };
    case "repair.executed": return { title: "Checkout rollback executed", copy: `${p.from} restored to ${p.to}.`, tone: "accepted" };
    case "verification.completed": return { title: "Recovery thresholds passed", copy: state.mode === "development" ? "Fresh post-repair checkout/payment OTLP verified the local rollback." : "Payment recovered, checkout errors fell, and Kafka lag drained without a Kafka repair.", tone: "verified" };
    case "outcome.classified": return { title: "Outcome classified", copy: `${p.classification}. Learning: ${p.secondary_learning}. ${p.explanation}`, tone: "verified" };
    case "regression.created": return { title: "Regression case created", copy: p.name, tone: "verified" };
    case "policy.evaluated": return { title: "Candidate policy evaluated", copy: `${p.candidate} is ${(p.promotion || "blocked").replaceAll("_", " ")}.`, tone: p.passed ? "verified" : "rejected" };
    case "tool.called": return { title: `Tool: ${p.tool}`, copy: `${p.result_count} evidence record${p.result_count === 1 ? "" : "s"} returned.`, tone: "neutral" };
    case "live.run.started": return { title: "Live GPT-5.6 loop started", copy: `Model ${p.model} is querying captured evidence.`, tone: "neutral" };
    case "live.run.completed": return { title: "Live GPT-5.6 loop completed", copy: p.evaluation?.reason || "Investigation completed.", tone: p.evaluation?.accepted ? "accepted" : "rejected", score: percent(p.evaluation?.score) };
    case "live.run.failed": return { title: "Live investigation stopped", copy: p.reason, tone: "rejected" };
    default: return { title: event.type.replaceAll(".", " "), copy: "Recorded in the append-only ledger.", tone: "neutral" };
  }
}

function timelineCopy(index) {
  if (state?.mode === "development") return [
    "Local runtime selected",
    "Versioned payment-unreachable change applied",
    "Fresh checkout/payment failures observed",
    "Unsupported payment-service blame rejected",
    "Change and failure telemetry establish root cause",
    "Checkout-only local rollback waits for approval",
    "Fresh post-repair OTLP verifies recovery",
    "Hashed capture and policy gates recorded"
  ][index];
  return [
    "Captured system baseline",
    "checkout:2.18.0 enters the system",
    "Payment failures lead downstream lag",
    "Kafka root-cause claim rejected at 22%",
    "Checkout endpoint regression confirmed",
    "Checkout-only rollback waits for approval",
    "Recovery thresholds pass",
    "Regression and policy gates recorded"
  ][index];
}

function modeStatus() {
  const shared = sharedRunModelAtCursor();
  if (shared) return ({ running: "Canonical run in progress", recovered: "Verified recovery recorded", needs_human: "Human evidence decision required", failed: "Canonical run failed" })[shared.state] || "Canonical run state";
  if (mode === "architecture") return architectureView() ? "Backend-owned architecture projection" : "Architecture projection unavailable";
  if (mode === "live") return sourceState().status === "live" ? "Fresh authoritative telemetry" : "Source truth preserved";
  if (mode === "agents") return `${agentControl().current_agent_id.replaceAll("_", " ")} · ledger synchronized`;
  if (mode === "compare") return compareProvenance(state.events).status;
  if (state.waiting_for_approval && cursor >= 5) return "Paused at human gate";
  if (state.complete && cursor >= 7) return "Verified and recorded";
  return "Deterministic reconstruction";
}

function humanStageLabel(stage) {
  const value = String(stage || "").trim().toLowerCase();
  const labels = {
    monitor: "Monitoring",
    monitoring: "Monitoring",
    incident_detected: "Incident detected",
    diagnosis_available: "Diagnosis ready",
    investigate: "Investigating",
    investigating: "Investigating",
    evaluate: "Evaluating evidence",
    evaluation: "Evaluating evidence",
    repair: "Preparing recovery",
    recovery: "Recovering",
    verify: "Verifying recovery",
    verification: "Verifying recovery",
    recovered: "Recovery verified",
    needs_human: "Human decision required",
    failed: "Run failed"
  };
  return labels[value] || (value ? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Awaiting status");
}

function telemetryStatusLabel(status) {
  if (status === "live") return "Telemetry active";
  if (status === "stale") return "Telemetry delayed";
  if (status === "unavailable") return "Telemetry unavailable";
  return "Telemetry ready";
}

function modeCaption(frame) {
  const shared = sharedRunModelAtCursor();
  if (shared) return `${humanStageLabel(shared.stage)} · ${shared.events.length} recorded updates`;
  if (mode === "architecture") {
    const view = architectureView();
    if (!view) return "Backend architecture projection unavailable";
    const systems = architectureBoundaries(view.graph);
    return `${view.truth.label} · ${systems.observed.nodes.length} components, ${systems.observed.relations.length} retained dependencies, ${systems.flowpulse.nodes.length} FlowPulse controls`;
  }
  if (mode === "live") {
    const source = sourceState();
    return source.status === "live"
      ? `Last update ${formatAge(source.freshness_ms)}`
      : telemetryStatusLabel(source.status);
  }
  if (mode === "agents") {
    const control = agentControl();
    return `${agentLabel(control.current_agent_id)} is ready`;
  }
  if (mode === "compare") return compareProvenance(state.events).caption;
  if (state.mode === "development") return `${timelineStages()[cursor].time} · ${eventsAtStage(state.events, cursor).length} recorded updates`;
  return `${frame.stage.time} · ${eventsAtStage(state.events, cursor).length} recorded updates`;
}

function tabForStage(index) {
  if (index <= 2) return "metrics";
  if (index === 3) return "eval";
  if (index === 4) return "changes";
  if (index === 5) return "repair";
  if (index === 6) return "verify";
  return "evolve";
}

function tabForAnnotation(id) {
  return ({ deploy: "changes", propagation: "traces", rejected: "eval", replan: "agent", root: "changes", gate: "repair", recovery: "verify", learning: "evolve" })[id] || "evidence";
}

function defaultTabForNode(id) {
  if (mode === "architecture" && architectureTopology()?.nodes.some((node) => node.id === id)) return "overview";
  if (agentControl().graph.nodes.some((node) => node.id === id)) return "agent";
  if (mode === "live" && sourceState().topology?.nodes?.some((node) => node.id === id)) return "overview";
  if (id === "deployment") return "changes";
  if (id === "agent") return "agent";
  if (id === "evaluator") return "eval";
  if (id === "ledger") return "evidence";
  return "metrics";
}

function annotationTitle(id) {
  return ({ deploy: "Deployment entered", propagation: "Failure propagated", rejected: "Kafka hypothesis rejected", replan: "Investigator replanned", root: "Root cause confirmed", gate: "Owner approval required", recovery: "Recovery verified", learning: "Regression recorded" })[id] || id;
}

function timelineStages() {
  const shared = sharedRunModel();
  if (shared) return sharedTimelineMarkers(shared.events).map(({ event, label }) => ({ id: event.id, label, time: formatTime(event.recorded_at) }));
  if (state?.mode !== "development") return TWIN_STAGES;
  return TWIN_STAGES.map((stage, index) => index === 3 ? { ...stage, label: "Wrong service blame rejected" } : stage);
}

function developmentAnnotations(index) {
  const notes = [];
  if (index >= 1) notes.push({ id: "deploy", tone: "change", title: "Versioned change applied", copy: "paymentUnreachable enabled through flagd" });
  if (index >= 2 && index < 6) notes.push({ id: "propagation", tone: "impact", title: "Real failure telemetry", copy: "Fresh checkout/payment OTLP spans failed" });
  if (index >= 3 && index < 6) notes.push({ id: "rejected", tone: "rejected", title: "Weak service blame rejected", copy: "Failure spans did not prove payment initiated it" });
  if (index >= 4 && index < 6) notes.push({ id: "root", tone: "root", title: "Root cause confirmed", copy: "Versioned checkout flag preceded the failures" });
  if (index >= 6) notes.push({ id: "recovery", role: "outcome", tone: "verified", title: "Recovery verified", copy: "Fresh healthy post-repair OTLP captured" });
  if (index >= 7) notes.push({ id: "learning", role: "outcome", tone: "learned", title: "Hashed regression recorded", copy: "Live evidence policy passed deterministic gates" });
  return notes.slice(-2);
}

function kindLabel(kind) {
  return ({ client: "Client", service: "Service", api: "API", stream: "Stream", worker: "Worker", topic: "Stream", job: "Worker", deployment: "Deployment", dataset: "Evidence dataset", change: "Deployment change", agent: "Investigation agent", evaluator: "Adversarial evaluator", database: "Evidence database", component: "Agent operation" })[kind] || "Component";
}

function nodeOrigin(node) {
  if (node.kind === "change") return "CHANGE RECORD";
  if (node.kind === "database") return "AUTHORITATIVE LEDGER";
  if (node.plane === "control") return "FLOWPULSE CONTROL";
  if (sharedRunModel()) return "RUNTIME · ISOLATED EVIDENCE";
  return "RUNTIME · CAPTURED OTLP";
}

function annotationIcon(id) { return id === "learning" ? "database" : "shield-check"; }
function stageGroup(index) { return index >= 6 ? "outcome" : index > 0 ? "incident" : "baseline"; }

function renderDevelopmentControl() {
  if (!developmentStatus?.enabled) {
    els["development-button"].hidden = true;
    return;
  }
  els["development-button"].hidden = false;
  const action = developmentAction();
  els["development-button"].textContent = ({ connect: "Connect local runtime", case: "Start real case", investigate: "Investigate live evidence", verify: "Verify recovery", complete: "Live case complete" })[action];
  els["development-button"].disabled = busy || action === "complete";
}

function developmentAction() {
  if (!developmentStatus?.ready) return "connect";
  if (state?.mode !== "development") return "case";
  const has = (type) => state.events.some((event) => event.type === type);
  if (has("policy.evaluated")) return "complete";
  if (has("repair.executed")) return "verify";
  if (!has("approval.requested")) return "investigate";
  return "complete";
}

function handleNavigation(tab) {
  closeWorkspaceMenu();
  for (const button of document.querySelectorAll("[data-nav-tab]")) button.classList.toggle("is-active", button.dataset.navTab === tab);
  if (tab === "map") closeDrawerWithoutFocus();
  if (tab === "incidents") openDrawer({ type: "run", id: canonicalRunId() }, "agent");
  if (tab === "changes") openDrawer({ type: "run", id: canonicalRunId() }, "changes");
  if (tab === "evaluations") openDrawer({ type: "run", id: canonicalRunId() }, "eval");
}

function sourceState() {
  return state?.source || { status: "disconnected", label: "Disconnected", topology: { nodes: [], edges: [] }, evidence: [], counts: {}, freshness_ms: null };
}

function sourceComponentContext(id) {
  if (!(mode === "live" || isUnifiedRailWorkspace())) return null;
  const shared = sharedRunModelAtCursor();
  const view = liveTopologyView() || architectureView();
  const source = shared
    ? { status: shared.topology.source_truth.source_health, label: shared.topology.source_truth.label, topology: shared.topology.graph, evidence: [], counts: {}, freshness_ms: null }
    : liveSource(view);
  const topology = shared?.topology?.graph
    ? topologyIntegrity({ nodes: shared.topology.graph.nodes, edges: shared.topology.graph.edges })
    : view?.runtime_data.graph
    ? topologyIntegrity({
      nodes: view.runtime_data.graph.nodes,
      edges: [...view.runtime_data.graph.edges, ...(view.runtime_data.supporting_relations || [])]
    })
    : null;
  if (!topology) return null;
  const node = topology.nodes.find((item) => item.id === id);
  if (!node) return null;
  const detailKey = liveComponentDetailKey(node.id, shared?.projection_revision || view?.projection_revision);
  const incoming = topology.edges.filter((edge) => edge.to === id).map((edge) => topology.nodes.find((item) => item.id === edge.from)).filter(Boolean);
  const outgoing = topology.edges.filter((edge) => edge.from === id).map((edge) => topology.nodes.find((item) => item.id === edge.to)).filter(Boolean);
  const sharedStatus = shared?.node_statuses?.[id] || null;
  return {
    node,
    profile: sourceComponentProfile(node, { sourceFacts: false }),
    incoming,
    outgoing,
    evidence: [],
    status: node.connectivity === "unlinked" ? "unlinked" : sharedStatus || node.status || "dormant",
    source,
    detail: detailKey ? liveComponentDetails.get(detailKey) || null : null,
    detailLoading: detailKey ? pendingLiveComponentDetails.has(detailKey) : false,
    detailUnavailable: detailKey ? unavailableLiveComponentDetails.has(detailKey) : false
  };
}

function liveComponentDetailKey(id, projectionRevision = sharedRunModel()?.projection_revision || liveTopologyView()?.projection_revision) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id) && typeof projectionRevision === "string" && /^[a-f0-9]{64}$/.test(projectionRevision)
    ? `${projectionRevision}:${id}`
    : null;
}

async function requestLiveComponentDetail(id) {
  if (!(mode === "live" || isUnifiedRailWorkspace()) || !isRailRuntimeNode(id)) return;
  const shared = sharedRunModel();
  const view = liveTopologyView() || architectureView();
  const topologyRevision = shared?.projection_revision || view?.projection_revision;
  const key = liveComponentDetailKey(id, topologyRevision);
  if (!key || liveComponentDetails.has(key) || pendingLiveComponentDetails.has(key) || unavailableLiveComponentDetails.has(key)) return;
  pendingLiveComponentDetails.add(key);
  if (selected?.type === "node" && selected.id === id) {
    renderDrawer();
    renderOperationsTeamRail();
  }
  try {
    const runId = canonicalRunId();
    const value = await request(`/api/components/${encodeURIComponent(id)}?run_id=${encodeURIComponent(runId)}&window=15m&signal=all&limit=8`);
    const { node_investigation: _nodeInvestigation, ...v1Detail } = value || {};
    const detail = componentDetailProjection(v1Detail, { nodeId: id, topologyRevision });
    // The response is already revision-bound to `view` above. Its cache key
    // carries that revision, so a concurrent canonical-state refresh simply
    // causes the next render to request the new key rather than rejecting a
    // verified read that arrived during the refresh.
    if (!detail) throw new Error("component_detail_unavailable");
    if (liveComponentDetails.size >= 22) liveComponentDetails.clear();
    liveComponentDetails.set(key, detail);
  } catch {
    unavailableLiveComponentDetails.add(key);
  } finally {
    pendingLiveComponentDetails.delete(key);
    if (selected?.type === "node" && selected.id === id && (mode === "live" || isUnifiedRailWorkspace())) {
      renderDrawer();
      renderOperationsTeamRail();
    }
  }
}

function architectureDetailContext(id) {
  const architecture = architectureView();
  const graph = architecture?.graph;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const node = nodes.find((item) => item?.id === id && ["runtime", "data"].includes(item.plane));
  if (!node) return null;
  const nodeById = new Map(nodes.filter((item) => typeof item?.id === "string").map((item) => [item.id, item]));
  const relations = (Array.isArray(graph?.edges) ? graph.edges : [])
    .filter((edge) => edge && nodeById.has(edge.from) && nodeById.has(edge.to) && (edge.from === id || edge.to === id))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const relationNodes = (direction) => relations
    .filter((edge) => direction === "incoming" ? edge.to === id : edge.from === id)
    .map((edge) => ({ edge, node: nodeById.get(direction === "incoming" ? edge.from : edge.to) }))
    .filter((item) => item.node?.plane === "runtime")
    .slice(0, 8);
  return {
    node,
    source: architectureSource(architecture),
    scope: "architecture",
    incoming: relationNodes("incoming"),
    outgoing: relationNodes("outgoing")
  };
}

function controlDetailContext(id) {
  const view = mode === "live" ? liveTopologyView() || architectureView() : architectureView() || liveTopologyView();
  const node = view?.control_system?.nodes?.find((item) => item?.id === id);
  if (!node?.detail) return null;
  return {
    node,
    source: { status: view.truth?.source_health || "unavailable", label: view.truth?.label || "UNAVAILABLE" },
    scope: "architecture",
    incoming: [],
    outgoing: []
  };
}

function controlDrawerContent(context) {
  const { node, source } = context;
  const detail = node.detail;
  const rows = [
    ["What it does", detail.summary],
    ["Inputs", detail.inputs.join(" · ")],
    ["Outputs", detail.outputs.join(" · ")],
    ["Authority boundary", detail.authority],
    ["Integration provenance", detail.provenance_refs.join(" · ")],
    detail.activity.summary ? ["Current activity", detail.activity.summary] : null,
    detail.activity.stage ? ["Workflow stage", detail.activity.stage] : null,
    Number.isInteger(detail.activity.last_sequence) ? ["Last recorded event", `Ledger sequence ${detail.activity.last_sequence}`] : null,
    detail.activity.last_recorded_at ? ["Recorded at", formatTime(detail.activity.last_recorded_at)] : null,
    detail.activity.evidence_refs.length ? ["Evidence references", detail.activity.evidence_refs.join(" · ")] : null,
    detail.activity.gate !== "unavailable" ? ["Gate result", detail.activity.gate] : null,
    detail.activity.source_health !== "unavailable" ? ["Source status", detail.activity.source_health] : null,
    source.label ? ["Projection source", source.label] : null
  ].filter(Boolean);
  return `<section class="team-rail-detail"><header><span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><div><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(statusLabel(node.status || "idle"))}</span></div><span class="node-status-dot is-${escapeHtml(node.status || "idle")}" aria-hidden="true"></span></header><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl><p class="team-rail-note">This is a read-only server projection. Agent conversation and consequential actions remain unavailable here.</p></section>`;
}

function architectureComponentDetailMarkup(context) {
  const { node } = context;
  const projection = architectureDetail?.detail || null;
  if (architectureDetail?.loading) return architectureDetailLoadingMarkup(node);
  if (!projection || architectureDetail?.failed) return architectureDetailUnavailableMarkup(node);
  const layerLabel = ARCHITECTURE_LAYERS.find((layer) => layer.id === node.layer)?.label;
  const signals = projection.component.signal_types.length ? projection.component.signal_types.join(" · ") : null;
  const provenance = projection.component.provenance_refs.length ? projection.component.provenance_refs.join(" · ") : null;
  const facts = [
    ["Status", statusLabel(projection.component.status)],
    ["Component ID", projection.component.id],
    layerLabel ? ["Architecture layer", layerLabel] : null,
    ["Source health", projection.component.source_health],
    projection.runtime.label ? ["Source", projection.runtime.label] : null,
    signals ? ["Signals", signals] : null,
    provenance ? ["Provenance", provenance] : null
  ].filter(Boolean);
  return `<section class="architecture-component-detail" data-architecture-detail-id="${escapeHtml(node.id)}" tabindex="-1" aria-label="${escapeHtml(`${node.label} component detail. Click anywhere in this detail or press Escape to return to components.`)}">
    <div class="architecture-detail-title"><span class="architecture-thumbnail-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><div><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(kindLabel(node.kind))}</span></div><span class="architecture-status-dot is-${escapeHtml(projection.component.status)}" aria-label="${escapeHtml(statusLabel(projection.component.status))}"></span></div>
    <section class="architecture-detail-purpose"><span>Operational role</span><strong>${escapeHtml(projection.purpose.business_role)}</strong><p>${escapeHtml(projection.purpose.description)}</p></section>
    <dl class="architecture-detail-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    ${componentRelationsMarkup("Depends on", projection.relationships.downstream)}
    ${componentRelationsMarkup("Depended on by", projection.relationships.upstream)}
    ${componentObservabilityMarkup(projection.observability)}
  </section>`;
}

function architectureDetailLoadingMarkup(node) {
  return `<section class="architecture-component-detail architecture-component-detail-state" data-architecture-detail-id="${escapeHtml(node.id)}" tabindex="-1" aria-label="${escapeHtml(`${node.label} details loading. Click to return to components.`)}"><div class="architecture-detail-title"><span class="architecture-thumbnail-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><div><strong>${escapeHtml(node.label)}</strong><span>Loading bounded backend detail</span></div></div></section>`;
}

function architectureDetailUnavailableMarkup(node) {
  return `<section class="architecture-component-detail architecture-component-detail-state" data-architecture-detail-id="${escapeHtml(node.id)}" tabindex="-1" aria-label="${escapeHtml(`${node.label} detail unavailable. Click to return to components.`)}"><div class="architecture-detail-title"><span class="architecture-thumbnail-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><div><strong>${escapeHtml(node.label)}</strong><span>Detail unavailable from the current backend projection</span></div></div></section>`;
}

function componentRelationsMarkup(label, relations = []) {
  if (!relations.length) return "";
  return `<section class="architecture-detail-relations"><span>${escapeHtml(label)}</span><div>${relations.map((related) => `<span><strong>${escapeHtml(related.label)}</strong><small>${escapeHtml(related.relation)}</small></span>`).join("")}</div></section>`;
}

function componentObservabilityMarkup(observability = {}) {
  const metricValue = (metric) => [metric.name, metric.before != null && metric.after != null ? `${metric.before} → ${metric.after}${metric.unit ? ` ${metric.unit}` : ""}` : metric.value != null ? `${metric.value}${metric.unit ? ` ${metric.unit}` : ""}` : null, metric.aggregation, metric.threshold].filter(Boolean).join(" · ");
  const traceValue = (trace) => [trace.operation, trace.peer_target, trace.status, trace.error, trace.trace_ref].filter(Boolean).join(" · ");
  const changeValue = (change) => [change.target, change.flag, change.before != null && change.after != null ? `${change.before} → ${change.after}` : null, change.applied_at ? formatTime(change.applied_at) : null].filter(Boolean).join(" · ");
  const list = (label, items, value) => items.length ? `<section class="architecture-detail-relations architecture-detail-observability"><span>${escapeHtml(label)}</span><div>${items.map((item) => `<span><strong>${escapeHtml(item.title)}</strong>${value(item) ? `<small>${escapeHtml(value(item))}</small>` : ""}<code>${escapeHtml(item.evidence_id)} · ${escapeHtml(item.record_sha256.slice(0, 12))}</code></span>`).join("")}</div></section>` : "";
  return [
    list("Metrics", observability.metrics || [], metricValue),
    list("Traces", observability.traces || [], traceValue),
    list("Recorded log events", observability.logs || [], () => "Redacted event metadata"),
    list("Configuration changes", observability.changes || [], changeValue)
  ].join("");
}

function controlComponentDetailMarkup(context) {
  const { node } = context;
  const detail = node.detail;
  const list = (label, values) => values.length ? `<section class="control-detail-list"><span>${escapeHtml(label)}</span><div>${values.map((value) => `<small>${escapeHtml(value)}</small>`).join("")}</div></section>` : "";
  return `<section class="architecture-component-detail control-component-detail" data-control-detail-id="${escapeHtml(node.id)}" tabindex="-1" aria-label="${escapeHtml(`${node.label} control detail. Click this detail or press Escape to return to the compact control.`)}">
    <div class="architecture-detail-title"><span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span><div><strong>${escapeHtml(node.label)}</strong></div><span class="node-status-dot is-${escapeHtml(node.status || "idle")}" aria-label="${escapeHtml(statusLabel(node.status))}"></span></div>
    <section class="architecture-detail-purpose"><span>What it does</span><strong>${escapeHtml(detail.summary)}</strong></section>
    <div class="control-detail-grid">${list("Inputs", detail.inputs)}${list("Outputs", detail.outputs)}</div>
    ${controlActivityMarkup(detail.activity)}
    <section class="architecture-detail-purpose"><span>Authority boundary</span><strong>${escapeHtml(detail.authority)}</strong></section>
    ${list("Integration provenance", detail.provenance_refs)}
  </section>`;
}

function controlActivityMarkup(activity = {}) {
  const entries = [
    activity.summary ? ["Current activity", activity.summary] : null,
    activity.stage ? ["Workflow stage", activity.stage] : null,
    Number.isInteger(activity.last_sequence) ? ["Last recorded event", `Ledger sequence ${activity.last_sequence}`] : null,
    activity.last_recorded_at ? ["Recorded at", formatTime(activity.last_recorded_at)] : null,
    Array.isArray(activity.evidence_refs) && activity.evidence_refs.length ? ["Evidence references", activity.evidence_refs.join(" · ")] : null,
    activity.gate && activity.gate !== "unavailable" ? ["Gate result", activity.gate] : null,
    activity.source_health && activity.source_health !== "unavailable" ? ["Source status", activity.source_health] : null
  ].filter(Boolean);
  if (!entries.length) return "";
  return `<dl class="control-detail-activity">${entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

async function openArchitectureDetail(id) {
  if (mode !== "architecture") return;
  const context = architectureDetailContext(id);
  if (!context || !ARCHITECTURE_LAYERS.some((layer) => layer.id === context.node.layer)) return;
  if (architectureDetail?.scope === "architecture" && architectureDetail.nodeId === context.node.id) {
    closeArchitectureDetail({ restoreFocus: true });
    return;
  }
  architectureDetail = { nodeId: context.node.id, scope: "architecture", loading: true, failed: false };
  selected = null;
  render();
  requestAnimationFrame(() => els["canvas-layers"].querySelector("[data-architecture-detail-id]")?.focus());
  const topologyRevision = architectureView()?.projection_revision;
  try {
    const runId = canonicalRunId();
    if (!runId) throw new Error("component_detail_unavailable");
    const value = await request(`/api/components/${encodeURIComponent(context.node.id)}?run_id=${encodeURIComponent(runId)}&window=15m&signal=all&limit=8`);
    const detail = componentDetailProjection(value, { nodeId: context.node.id, topologyRevision });
    if (!detail) throw new Error("component_detail_unavailable");
    if (architectureDetail?.scope === "architecture" && architectureDetail.nodeId === context.node.id) {
      architectureDetail = { nodeId: context.node.id, scope: "architecture", loading: false, failed: false, detail };
      render();
    }
  } catch {
    if (architectureDetail?.scope === "architecture" && architectureDetail.nodeId === context.node.id) {
      architectureDetail = { nodeId: context.node.id, scope: "architecture", loading: false, failed: true };
      render();
    }
  }
}

function openControlDetail(id, { focus = false } = {}) {
  if (mode !== "architecture") return;
  const context = controlDetailContext(id);
  if (!context) return;
  if (architectureDetail?.scope === "architecture" && architectureDetail.nodeId === context.node.id) {
    closeArchitectureDetail({ restoreFocus: focus });
    return;
  }
  architectureDetail = { nodeId: context.node.id, scope: "architecture" };
  selected = null;
  render();
  if (focus) requestAnimationFrame(() => els["canvas-layers"].querySelector(`[data-control-detail-id="${context.node.id}"]`)?.focus());
}

function closeArchitectureDetail({ restoreFocus = false } = {}) {
  const originId = architectureDetail?.nodeId;
  architectureDetail = null;
  render();
  if (!restoreFocus) return;
  requestAnimationFrame(() => {
    const selector = "[data-architecture-thumbnail-id], [data-architecture-control-id]";
    [...els["canvas-layers"].querySelectorAll(selector)].find((item) => (item.dataset.architectureThumbnailId || item.dataset.architectureControlId) === originId)?.focus();
  });
}

function sourceComponentProfile(node, { sourceFacts = true } = {}) {
  const observed = sourceFacts ? sourceComponentCatalog().get(node.id) || {} : {};
  const signals = [...new Set([...(node.signal_types || node.signals || []), ...(observed.signals || [])])].sort();
  const language = displayRuntimeLanguage(observed["telemetry.sdk.language"]);
  const runtimeParts = [`service.name=${node.id}`];
  if (language) runtimeParts.push(language);
  if (signals.length) runtimeParts.push(signals.join(" + "));
  const signalSummary = signals.map((signal) => `${signal.charAt(0).toUpperCase()}${signal.slice(1)}`).join(" + ");
  return {
    capability: COMPONENT_CAPABILITIES[node.id] || kindLabel(node.kind),
    runtimeIdentity: runtimeParts.join(" · "),
    runtimeSummary: [language, signalSummary].filter(Boolean).join(" · "),
    language,
    signals,
    attributes: observed
  };
}

function sourceComponentCatalog() {
  const source = sourceState();
  if (componentCatalogSource === source) return componentCatalogCache;
  const catalog = new Map();
  for (const item of source.evidence || []) {
    for (const key of ["resourceSpans", "resourceMetrics", "resourceLogs"]) {
      for (const resource of item.payload?.[key] || []) {
        const attributes = Object.fromEntries((resource.resource?.attributes || []).map((attribute) => [attribute.key, otlpValue(attribute.value)]));
        const service = attributes["service.name"];
        if (!service) continue;
        catalog.set(service, { ...(catalog.get(service) || {}), ...attributes, signals: [...new Set([...(catalog.get(service)?.signals || []), item.signal])].sort() });
      }
    }
  }
  componentCatalogSource = source;
  componentCatalogCache = catalog;
  return catalog;
}

function renderSourceComponentContext(context) {
  const { node, profile, incoming, outgoing, status, source } = context;
  const facts = [
    ["Current state", sourceStatusLabel(status, source.status)],
    ["Source truth", source.label],
    profile.runtimeSummary ? ["Runtime", profile.runtimeSummary] : null,
    profile.signals.length ? ["Signals", profile.signals.join(" · ")] : null,
    incoming.length || outgoing.length ? ["Dependencies", `${incoming.length} upstream · ${outgoing.length} downstream`] : null
  ].filter(Boolean);
  return `<section class="component-context is-${escapeHtml(status)}">
    <header><div><span>${escapeHtml(kindLabel(node.kind))}</span><strong>${escapeHtml(profile.capability)}</strong></div><span class="component-health">${escapeHtml(sourceStatusLabel(status, source.status))}</span></header>
    <dl>${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    <div class="component-runtime"><code>${escapeHtml(`service.name=${node.id}`)}</code>${source.freshness_ms != null ? `<span>${escapeHtml(formatAge(source.freshness_ms))} source age</span>` : ""}</div>
  </section>`;
}

function renderArchitectureComponentContext(context) {
  const { node, incoming, outgoing, source } = context;
  return `<section class="component-context is-${escapeHtml(node.status)}">
    <header><div><span>${escapeHtml(kindLabel(node.kind))}</span><strong>${escapeHtml(node.label)}</strong></div><span class="component-health">${escapeHtml(statusLabel(node.status))}</span></header>
    <dl><div><dt>Plane</dt><dd>${escapeHtml(node.plane)}</dd></div><div><dt>Layer</dt><dd>${escapeHtml(node.layer)}</dd></div><div><dt>Source truth</dt><dd>${escapeHtml(source.label)}</dd></div><div><dt>Relations</dt><dd>${incoming.length} in · ${outgoing.length} out</dd></div></dl>
    <div class="component-runtime"><code>${escapeHtml(node.id)}</code><span>${node.signal_types.length ? escapeHtml(node.signal_types.join(" + ")) : "No signal summary"}</span></div>
  </section>`;
}

function renderSourceSignalSummary(context) {
  const groups = new Map();
  for (const item of context.evidence) {
    const signal = item.signal || item.kind || "record";
    const group = groups.get(signal) || [];
    group.push(item);
    groups.set(signal, group);
  }
  if (!groups.size) return emptyDetail("No OTLP signal is available for this component in the current source window.");
  return `<section class="signal-summary">${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([signal, records]) => {
    const newest = [...records].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
    return `<article><header><strong>${escapeHtml(signal)}</strong><span>${records.length} record${records.length === 1 ? "" : "s"}</span></header><p>${escapeHtml(newest?.fact || newest?.title || "Captured signal")}</p><small>${escapeHtml(newest?.at ? formatTime(newest.at) : "Capture time unavailable")}</small></article>`;
  }).join("")}</section>`;
}

function renderArchitectureSignalSummary(context) {
  const signals = context.node.signal_types;
  if (!signals.length) return emptyDetail("No bounded signal summary is available for this component.");
  return `<section class="signal-summary">${signals.map((signal) => `<article><header><strong>${escapeHtml(signal)}</strong><span>Projected summary</span></header><p>Evidence-derived signal type from the backend topology view.</p><small>${escapeHtml(context.source.label)}</small></article>`).join("")}</section>`;
}

function renderArchitectureProvenance(context) {
  return `<section class="signal-summary">${context.node.provenance_refs.map((reference) => `<article><header><strong>Provenance</strong><span>Bounded reference</span></header><p><code>${escapeHtml(reference)}</code></p><small>${escapeHtml(context.source.label)}</small></article>`).join("")}</section>`;
}

function renderSourceDependencies(context) {
  const dependencyGroup = (label, nodes, empty) => `<article class="component-dependencies"><span>${label}</span><div>${nodes.length ? nodes.map((item) => `<button type="button" data-focus-entity="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join("") : `<small>${empty}</small>`}</div></article>`;
  return `<section class="dependency-summary">${dependencyGroup("Upstream", context.incoming, "Observed entry point")}${dependencyGroup("Downstream", context.outgoing, "No observed downstream dependency")}</section>`;
}

function otlpValue(value = {}) {
  return value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue ?? null;
}

function displayRuntimeLanguage(value) {
  return ({ go: "Go", js: "JavaScript", javascript: "JavaScript", nodejs: "Node.js", python: "Python", java: "Java", dotnet: ".NET", cpp: "C++", rust: "Rust", ruby: "Ruby", php: "PHP" })[String(value || "").toLowerCase()] || (value ? String(value) : "");
}

function architectureTopology() {
  return architectureViewTopology(state?.topology_views)?.graph || null;
}

function architectureView() {
  return architectureViewTopology(state?.topology_views);
}

function liveTopologyView() {
  return liveViewTopology(state?.topology_views);
}

function architectureSource(view) {
  return {
    status: view?.truth.source_health || "unavailable",
    label: view?.truth.label || "UNAVAILABLE",
    topology: view?.graph || { nodes: [], edges: [] },
    evidence: [],
    counts: {},
    freshness_ms: null
  };
}

function liveSource(view) {
  return {
    status: view?.truth.source_health || "unavailable",
    label: view?.truth.label || "UNAVAILABLE",
    topology: view?.runtime_data.graph || { nodes: [], edges: [] },
    evidence: [],
    counts: {},
    freshness_ms: null
  };
}

function captureLabel() {
  const shared = sharedRunModel();
  if (shared) return shared.state === "recovered" ? "Verified" : humanStageLabel(shared.stage);
  if (mode === "architecture") return architectureView() ? "System ready" : "Architecture unavailable";
  if (mode === "live") return liveTopologyView() ? "Telemetry ready" : "Live projection unavailable";
  if (["replay", "agents", "compare"].includes(mode)) return "Workspace loading";
  return state.mode === "development" ? "Incident workspace" : "System workspace";
}

function sourceOrigin(layout) {
  if (sharedRunModel()) return "CAPTURED EVIDENCE";
  if (layout === "architecture") return architectureView()?.truth.label || "UNAVAILABLE";
  if (layout === "live") return liveTopologyView()?.truth.label || "UNAVAILABLE";
  const source = sourceState();
  if (!source.topology?.nodes?.length) return "CAPTURED INCIDENT";
  if (source.status === "live") return "LIVE OTLP";
  if (state.mode === "development") return "HASHED OTLP";
  return "CAPTURED OTLP";
}

function transitionKey(id) {
  return id === "fraud" ? "fraud-detection" : id;
}

function captureCanvasNodePositions() {
  return new Map([...els["canvas-layers"].querySelectorAll("[data-transition-key]")].map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.dataset.transitionKey, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
  }));
}

function animateCanvasTransition(previousPositions) {
  if (!previousPositions.size || matchMedia("(prefers-reduced-motion: reduce)").matches || typeof Element.prototype.animate !== "function") return;
  requestAnimationFrame(() => {
    for (const node of els["canvas-layers"].querySelectorAll("[data-transition-key]")) {
      const rect = node.getBoundingClientRect();
      const previous = previousPositions.get(node.dataset.transitionKey);
      if (!previous) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 150, easing: "ease-out" });
        continue;
      }
      const x = previous.x - (rect.left + rect.width / 2);
      const y = previous.y - (rect.top + rect.height / 2);
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      const positionedNode = node.classList.contains("twin-node");
      node.animate([
        { transform: positionedNode ? `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` : `translate(${x}px, ${y}px)` },
        { transform: positionedNode ? "translate(-50%, -50%)" : "translate(0, 0)" }
      ], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    for (const map of els["canvas-layers"].querySelectorAll(".edge-map")) {
      map.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 120, easing: "ease-out" });
    }
  });
}

function closeWorkspaceMenu() {
  els["workspace-menu"].open = false;
}

function iconForLive(node) {
  const known = { frontend: "browser", "frontend-proxy": "arrows-left-right", checkout: "shopping-cart-simple", payment: "credit-card", kafka: "queue", accounting: "calculator", "fraud-detection": "shield-check", cart: "shopping-bag", shipping: "truck", currency: "currency-circle-dollar" };
  const displayClass = node.display_class || node.kind;
  return known[node.id] || ({ client: "browser", api: "plugs-connected", stream: "queue", worker: "gear", observer: "binoculars", orchestrator: "git-branch", agent: "robot", evaluator: "scales", ledger: "database", deployment: "git-commit", dataset: "database", topic: "queue", job: "gear", database: "database" })[displayClass] || "cube";
}

function statusLabel(status) {
  return ({ healthy: "Healthy", observed: "Observed", idle: "Sleeping", quiet: "Sleeping", dormant: "Sleeping", sleeping: "Sleeping", recording: "Recording", warning: "Pending", pending: "Pending", change: "Change pending", impact: "Fault", fault: "Fault", root: "Root cause", rejected: "Rejected", accepted: "Accepted", active: "Investigating", approval: "Approval required", verified: "Verified", learned: "Learning recorded" })[status] || status;
}

function sourceStatusLabel(status, sourceStatus) {
  if (status === "impact") return "Failure observed";
  if (status === "verified") return "Recovery verified";
  if (status === "unlinked") return "Evidence gap";
  if (status === "warning") return sourceStatus === "stale" ? "Stale telemetry" : "Waiting for telemetry";
  if (status === "dormant") return "No current signal";
  return sourceStatus === "live" ? "Live" : "Last known";
}

function labelFor(id) { return NODE_BY_ID.get(id)?.label || id || "unknown"; }
function agentLabel(id) { return agentControl().graph.nodes.find((node) => node.id === id)?.label || id || "unknown"; }
function agentControl() { return state?.agent_control || { authority: "append-only-ledger", langfuse: "not_configured", current_agent_id: "manager", last_sequence: 0, report: { title: "Agent control unavailable", summary: "No agent projection is available.", stage: state?.stage || "Unknown", data_mode: "captured_deterministic_replay", citations: [] }, actions: [], work_items: [], graph: { nodes: [], edges: [] }, activity: [], orchestration: { mode: "unavailable", proposal_count: 0, proposals: [], last_step: null } }; }
function agentIcon(id) { return ({ manager: "chats-circle", monitor: "activity", evidence: "magnifying-glass", diagnosis: "brain", evaluator: "scales", planner: "clipboard-text", owner: "user-focus", executor: "wrench", verification: "shield-check", evolve: "git-branch", test: "flask", ledger: "database", langfuse: "waveform" })[id] || "robot"; }
function agentNodeKind(node) { return ({ ledger: "database", langfuse: "database", executor: "change", owner: "evaluator", evaluator: "evaluator" })[node.id] || "agent"; }
function agentNodeTone(status) { return ({ running: "active", waiting: "approval", rejected: "rejected", complete: "verified", recording: "recording", observing: "learned", unconfigured: "quiet", standby: "quiet" })[status] || "quiet"; }
function agentEdgeTone(status) { return ({ active: "active", waiting: "approval", rejected: "rejected", complete: "verified", observing: "learned", quiet: "quiet" })[status] || "quiet"; }
function agentStatusLabel(status) { return ({ running: "Running", waiting: "Waiting for owner", rejected: "Rejected and replanning", complete: "Completed", recording: "Recording", observing: "Observing", unconfigured: "Not configured", standby: "Standby" })[status] || status; }
function collaboratorFinding(collaborator, control) {
  const report = control.report || {};
  if (collaborator.id === "observer") return collaborator.latestActivity?.summary || report.summary;
  if (collaborator.id === "investigator") return report.root_cause || report.rejected_diagnosis?.reason || "The evidence does not yet support a final causal claim.";
  if (collaborator.id === "critic") return report.rejected_diagnosis
    ? `${report.rejected_diagnosis.hypothesis_id} was rejected at ${Math.round(report.rejected_diagnosis.score * 100)}%: ${report.rejected_diagnosis.reason}`
    : report.confidence == null ? "No diagnosis has reached adversarial evaluation yet." : `The current evidence-grounded diagnosis scored ${Math.round(report.confidence * 100)}%.`;
  if (collaborator.id === "recovery-engineer") return report.repair
    ? `${report.repair.action}. Scope: ${report.repair.target} only${report.human_gate ? "; waiting for separate owner approval" : ""}.`
    : "A bounded repair is unavailable until the evaluator accepts a causal diagnosis.";
  if (collaborator.id === "verifier") return report.verification
    ? `Recovery checks ${report.verification.passed ? "passed" : "did not pass"}.${report.regression ? " Regression and learning records are available." : ""}`
    : "Verification waits for an approved execution receipt and fresh post-action evidence.";
  return report.summary;
}
function collaboratorCitations(collaborator, control) {
  const activityRefs = collaborator.latestActivity?.evidence_refs || [];
  return [...new Set([...activityRefs, ...(control.report?.citations || [])])].slice(0, 6);
}
function collaboratorEdgePath(from, to) {
  const start = { x: from.x * 10, y: from.y * 5.2 - 20 };
  const end = { x: to.x * 10, y: to.y * 5.2 - 20 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 1) return `M ${start.x} ${start.y + Math.sign(dy || 1) * 31} C ${start.x} ${start.y + dy * .42} ${end.x} ${end.y - dy * .42} ${end.x} ${end.y - Math.sign(dy || 1) * 31}`;
  const direction = Math.sign(dx);
  const xOffset = Math.min(108, Math.max(54, Math.abs(dx) * .38));
  const startX = start.x + direction * 31;
  const endX = end.x - direction * 31;
  return `M ${startX} ${start.y} C ${startX + direction * xOffset} ${start.y}, ${endX - direction * xOffset} ${end.y}, ${endX} ${end.y}`;
}
function recoveryActionIcon(id) { return ({ advance: "play", verify_recovery: "shield-check", review_recovery: "user-focus", review_learning: "flask", delegate_task: "paper-plane-tilt", review_pr: "git-pull-request", approve_pr_review: "check-circle", draft_jira: "ticket", approve_jira_draft: "check-square" })[id] || "arrow-right"; }
function recoveryActionReply(id) { return ({ advance: "The Manager delegated the next evidence-grounded step.", verify_recovery: "Verification monitoring is active.", delegate_task: "The diagnosis task was recorded in the immutable ledger.", review_pr: "A cited PR review draft is ready for human review; GitHub was not mutated.", approve_pr_review: "The internal PR review is approved and ready for a configured integration.", draft_jira: "A cited Jira ticket draft is ready for human review; Jira was not mutated.", approve_jira_draft: "The Jira draft is approved and ready for a configured integration." })[id] || "The recovery control state was updated."; }
function workItemTone(status) { return ({ recorded: "active", awaiting_human_review: "approval", ready_for_integration: "verified" })[status] || "quiet"; }
function workItemStatus(item) { const status = String(item.status || "recorded").replaceAll("_", " "); return item.integration_state === "not_configured" ? `${status} · draft only` : status; }
function emptyDetail(message) { return `<div class="drawer-empty">${escapeHtml(message)}</div>`; }
function closeDrawerWithoutFocus() { selected = null; els["context-drawer"].hidden = true; }
function playDelay() { return 820 / Number(els["speed-select"].value || 1); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function percent(value) { return value == null ? "" : `${Math.round(value * 100)}%`; }
function formatOffset(ms) { return `T+${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`; }
function formatTime(value) { return new Date(value).toISOString().slice(11, 19); }
function formatMetric(metric, value) { return metric.includes("percent") ? `${value}%` : Number(value).toLocaleString(); }
function formatAge(value) { return value == null ? "—" : value < 1000 ? "<1s" : value < 60_000 ? `${Math.floor(value / 1000)}s` : `${Math.floor(value / 60_000)}m`; }

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  } catch {
    throw new RequestError("Network request failed.", { kind: "network" });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new RequestError(response.ok ? "The server returned an invalid response." : `Request failed (${response.status})`, { status: response.status });
  }
  if (!response.ok) throw new RequestError(data?.error || `Request failed (${response.status})`, { status: response.status });
  return data;
}

function connectAgentStream() {
  if (!state?.run_id || typeof EventSource !== "function") return;
  if (streamedRunId === state.run_id && eventSource) return;
  eventSource?.close();
  streamedRunId = state.run_id;
  const after = state.agent_control?.last_sequence || 0;
  eventSource = new EventSource(`/api/agent-control/events?run_id=${encodeURIComponent(state.run_id)}&after=${after}`);
  eventSource.addEventListener("agent-control", (event) => {
    const projection = JSON.parse(event.data);
    if (projection.run_id !== state?.run_id || projection.last_sequence <= (state.agent_control?.last_sequence || 0)) return;
    state.agent_control = projection;
    clearTimeout(streamRefreshTimer);
    streamRefreshTimer = setTimeout(async () => {
      let requestGeneration = null;
      try {
        const requestedRunId = selectedRunId;
        requestGeneration = beginCanonicalStateRequest();
        const nextState = await request(browserStatePath(requestedRunId));
        if (commitCanonicalStateResponse({
          requestedRunId,
          requestGeneration,
          nextState
        }) !== "committed") return;
        cursor = availableStage(state.events);
        render();
        ensureSelectedLiveComponentDetail();
      } catch { /* the stream will retry without replacing the last valid projection */ }
      finally {
        if (requestGeneration !== null) settleSupersededCanonicalLoading(requestGeneration);
      }
    }, 80);
  });
  eventSource.onerror = () => {};
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]);
}

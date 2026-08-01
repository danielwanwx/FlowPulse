import { ControlPlaneClient, ControlPlaneClientError } from "./control-plane-client.mjs";
import { controlPlaneReducer, createControlPlaneState, investigationPresentation } from "./control-plane-contract.mjs";
import {
  applyTopologyNodePositions,
  activePulseEdgeIds,
  incidentTopologyView,
  latestBySequence,
  projectIncidentClock,
  topologyNodeMetadata
} from "./control-plane-topology-layout.mjs";
import {
  conciseTimestamp,
  formatIncidentDuration,
  incidentWorkspaceSnapshot
} from "./incident-workspace.mjs";
import { ControlPlaneV3Client } from "./control-plane-v3-client.mjs";
import { IncidentWorkbenchControllerV3 } from "./incident-workbench-controller-v3.mjs";
import { LiveIncidentAdapterV3 } from "./live-v3.mjs";

// This module intentionally mounts only into the mature app-shell. It owns
// presentation state, while all incident, gate, card, receipt, and evidence
// truth continues to come from the control-plane contract.
const client = new ControlPlaneClient();
const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const root = els["app-shell"];
const initialCaseId = requestedCaseId();
let state = createControlPlaneState({ caseId: initialCaseId, mode: initialCaseId ? "incident" : "architecture" });
let globalSubscription = null;
let caseSubscription = null;
let streamedCaseId = null;
let lastError = null;
let workspacePane = "overview";
let selectedCitationId = null;
let selectedIncidentComponentId = null;
const v2LegacyVisibility = new Map();
const pendingProjections = new Set();
const pendingActions = new Set();
const pendingReceipts = new Set();
const v3Client = new ControlPlaneV3Client();
const v3Workbench = new IncidentWorkbenchControllerV3({
  element: els["incident-workspace"],
  appShell: root,
  client: v3Client,
  onProjection: syncV3ProjectionChrome
});
const v3Live = new LiveIncidentAdapterV3({
  element: els["v3-live-incidents"],
  client: v3Client,
  topologyElement: null,
  legacyTopology: null,
  legacySurfaces: [],
  onOpen: openV3Incident
});

root.dataset.controlPlaneAdapter = "true";
for (const button of document.querySelectorAll("button.mode-button[data-mode]")) {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.mode;
    if (nextMode === "incident") {
      closeSubscriptions();
      v3Live.deactivate();
      state = { ...state, mode: nextMode };
      render();
      void v3Workbench.activate(requestedCaseId() || state.pinned_case_id);
      return;
    }
    v3Workbench.deactivate();
    if (nextMode !== "live") v3Live.deactivate();
    state = { ...state, mode: nextMode };
    render();
    if (nextMode === "live") {
      closeSubscriptions();
      void v3Live.activate();
      return;
    }
    void bootstrap();
  }, true);
}
els["open-incident-button"].addEventListener("click", () => dispatch({ type: "toast.focus" }));
els["retry-button"].addEventListener("click", bootstrap);
els["drawer-close"].addEventListener("click", () => {
  state = { ...state, selected_component_id: null };
  render();
});
els.toast.addEventListener("click", (event) => {
  if (event.target.closest("[data-control-focus]")) dispatch({ type: "toast.focus" });
});
els["canvas-layers"].addEventListener("click", (event) => {
  const node = event.target.closest("[data-control-component]");
  if (node?.dataset.clickable === "true") dispatch({ type: "node.clicked", component_id: node.dataset.controlComponent });
});
els["drawer-content"].addEventListener("click", (event) => {
  const card = event.target.closest("[data-control-action]");
  if (card && !card.disabled) dispatch({ type: "action.clicked", action_id: card.dataset.controlAction });
});
els["incident-workspace"].addEventListener("click", (event) => {
  const pane = event.target.closest("[data-incident-pane]");
  if (pane) {
    workspacePane = pane.dataset.incidentPane;
    if (workspacePane !== "evidence") selectedCitationId = null;
    render();
    return;
  }
  const citation = event.target.closest("[data-incident-citation]");
  if (citation) {
    workspacePane = "evidence";
    selectedCitationId = citation.dataset.incidentCitation;
    render();
    return;
  }
  const node = event.target.closest("[data-incident-node]");
  if (node) {
    workspacePane = "component";
    selectedIncidentComponentId = node.dataset.incidentNode;
    dispatch({ type: "node.clicked", component_id: node.dataset.incidentNode });
    return;
  }
  const component = event.target.closest("[data-incident-component]");
  if (component) {
    workspacePane = "component";
    selectedIncidentComponentId = component.dataset.incidentComponent;
    render();
    return;
  }
  const card = event.target.closest("[data-control-action]");
  if (card && !card.disabled) dispatch({ type: "action.clicked", action_id: card.dataset.controlAction });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || els["incident-workspace"].hidden || workspacePane === "overview") return;
  workspacePane = "overview";
  selectedCitationId = null;
  render();
});
els["timeline-current"].addEventListener("click", () => {
  if (state.toast) dispatch({ type: "toast.focus" });
});

render();
if (state.mode === "incident") void v3Workbench.activate(initialCaseId);
else if (state.mode === "live") {
  closeSubscriptions();
  void v3Live.activate();
}
else {
  void bootstrap();
}

async function bootstrap() {
  closeSubscriptions();
  lastError = null;
  dispatch({ type: "connection.reconnecting" });
  void loadPinnedCase();
  try {
    const summaries = await client.activeIncidents();
    dispatch({ type: "summaries.hydrated", summaries });
    openGlobalSubscription();
  } catch (error) {
    reportError(error);
  } finally {
    if (state.mode === "incident") root.classList.remove("is-loading");
    render();
  }
}

async function loadPinnedCase() {
  if (!initialCaseId) return;
  await runEffect({ type: "projection.load", case_id: initialCaseId, identity: null });
}

function dispatch(action) {
  const reduced = controlPlaneReducer(state, action);
  state = reduced.state;
  render();
  syncCaseSubscription();
  for (const effect of reduced.effects) void runEffect(effect);
}

async function runEffect(effect) {
  if (effect.type === "projection.load") {
    const key = `${effect.case_id}:${effect.identity?.projection_revision || "latest"}`;
    if (pendingProjections.has(key)) return;
    pendingProjections.add(key);
    try {
      const projection = await client.projection(effect.case_id, effect.identity);
      dispatch({ type: "projection.hydrated", projection, identity: effect.identity });
      if (initialCaseId === effect.case_id) dispatch({ type: "case.select", case_id: effect.case_id });
    } catch (error) {
      reportError(error);
    } finally {
      pendingProjections.delete(key);
    }
    return;
  }
  if (effect.type === "actions.load") {
    const key = `${effect.case_id}:${effect.identity.projection_revision}:${effect.identity.action_revision}`;
    if (pendingActions.has(key)) return;
    pendingActions.add(key);
    try {
      dispatch({ type: "actions.hydrated", identity: effect.identity, actions: await client.actions(effect.case_id) });
    } catch (error) {
      reportError(error);
    } finally {
      pendingActions.delete(key);
    }
    return;
  }
  if (effect.type === "node-explanation.start") {
    const caseId = state.projection?.case_id;
    if (!caseId) return;
    try {
      dispatch({ type: "explanation.receipt", receipt: await client.startNodeExplanation(caseId, effect.command) });
    } catch (error) {
      reportError(error);
    }
    return;
  }
  if (effect.type === "action.invoke") {
    try {
      dispatch({ type: "action.receipt", receipt: await client.invokeAction(effect.case_id, effect.action_id, effect.command) });
    } catch (error) {
      reportError(error);
    }
  }
}

function openGlobalSubscription() {
  if (globalSubscription) return;
  try {
    globalSubscription = client.subscribeGlobal({
      onNotification: (notification) => dispatch({ type: "notification.received", notification }),
      onConnection: (connection) => dispatch({ type: `connection.${connection}` })
    });
  } catch (error) {
    reportError(error);
  }
}

function syncCaseSubscription() {
  const projection = state.projection;
  if (!projection || streamedCaseId === projection.case_id) return;
  caseSubscription?.close();
  streamedCaseId = projection.case_id;
  try {
    caseSubscription = client.subscribeCase({
      caseId: projection.case_id,
      after: state.last_case_sequence,
      onEvent: (event) => {
        const explanationId = event.payload?.explanation_id;
        dispatch({ type: "case.event", event });
        if (typeof explanationId === "string" && ["COMPLETED", "DEGRADED"].includes(event.explanation_status)) {
          void loadExplanationReceipt(event.case_id, explanationId);
        }
      },
      onConnection: (connection) => dispatch({ type: `connection.${connection}` })
    });
  } catch (error) {
    reportError(error);
  }
}

async function loadExplanationReceipt(caseId, explanationId) {
  const key = `${caseId}:${explanationId}`;
  if (pendingReceipts.has(key)) return;
  pendingReceipts.add(key);
  try {
    dispatch({ type: "explanation.receipt", receipt: await client.nodeExplanationReceipt(caseId, explanationId) });
  } catch (error) {
    reportError(error);
  } finally {
    pendingReceipts.delete(key);
  }
}

function closeSubscriptions() {
  globalSubscription?.close();
  globalSubscription = null;
  caseSubscription?.close();
  caseSubscription = null;
  streamedCaseId = null;
}

function reportError(error) {
  lastError = error instanceof ControlPlaneClientError ? error.code : "control_plane_unavailable";
  dispatch({ type: "connection.degraded" });
}

function render() {
  if (state.mode === "incident") {
    root.dataset.controlPlaneMode = "incident";
    root.dataset.mode = "incident";
    root.dataset.incidentWorkspace = "v3";
    hideLegacyV2IncidentChrome();
    els["incident-workspace"].hidden = false;
    els["v3-live-incidents"].hidden = true;
    els["error-banner"].hidden = true;
    root.classList.remove("is-loading");
    els.environment.textContent = "Incident workflow";
    els["workspace-title"].textContent = v3Workbench.projection?.title || "Incident";
    els.stage.textContent = v3Workbench.projection?.current_attempt?.current_stage ? titleCase(v3Workbench.projection.current_attempt.current_stage) : "Opening";
    els["status-text"].textContent = "V3 workflow";
    renderModeButtons();
    renderToast();
    return;
  }
  if (state.mode === "live") {
    restoreLegacyV2Chrome();
    root.dataset.controlPlaneMode = "live";
    root.dataset.mode = "live";
    delete root.dataset.incidentWorkspace;
    els["incident-workspace"].hidden = true;
    els["v3-live-incidents"].hidden = false;
    root.classList.remove("is-loading");
    els.environment.textContent = "Live incidents";
    els["workspace-title"].textContent = "Runtime activity";
    els.stage.textContent = "V3 live overview";
    els["status-text"].textContent = "Live telemetry";
    renderModeButtons();
    renderToast();
    return;
  }
  if (state.mode !== "incident") {
    restoreLegacyV2Chrome();
    delete root.dataset.controlPlaneMode;
    delete root.dataset.incidentWorkspace;
    els["incident-workspace"].hidden = true;
    renderToast();
    return;
  }
  const projection = state.projection;
  root.dataset.controlPlaneMode = "incident";
  if (projection) {
    root.dataset.projectionRevision = String(projection.projection_revision);
    root.dataset.projectionSequence = String(projection.sequence);
  }
  root.dataset.mode = state.mode;
  root.classList.toggle("is-loading", !projection && state.connection === "connecting");
  els.environment.textContent = "Incident workspace";
  els["workspace-title"].textContent = viewTitle();
  els.stage.textContent = projection ? investigationPresentation(projection).stage : "Waiting";
  els["status-text"].textContent = connectionCopy(state.connection);
  els["canvas-title"].textContent = viewTitle();
  els["canvas-caption"].textContent = projection?.operator_summary ? operatorSummaryCopy(projection.operator_summary) : (state.connection === "degraded" ? "Awaiting server recovery." : emptyCanvasCopy());
  els["metric-checkout-label"].parentElement.hidden = true;
  els["metric-payment-label"].parentElement.hidden = true;
  els["metric-kafka-label"].parentElement.hidden = true;
  els["operations-team-rail"].hidden = true;
  els["approval-banner"].hidden = true;
  els["compare-control"].hidden = true;
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  els["incident-stage-panel"].hidden = true;
  els["shared-run-connection"].hidden = !["stale", "reconnecting", "degraded"].includes(state.connection);
  els["shared-run-connection"].dataset.state = state.connection;
  els["shared-run-connection"].textContent = connectionCopy(state.connection);
  renderModeButtons();
  renderError();
  renderToast();
  if (projection?.schema_version === "flowpulse.incident-projection.v2") {
    renderV2IncidentWorkspace(projection);
    hideLegacyV2IncidentChrome();
    if (projection) persistCaseId(projection.case_id);
    return;
  }
  restoreLegacyV2Chrome();
  delete root.dataset.incidentWorkspace;
  els["incident-workspace"].hidden = true;
  renderGraph();
  renderIncidentChrome();
  renderDrawer();
  if (projection) persistCaseId(projection.case_id);
}

function openV3Incident(caseId) {
  closeSubscriptions();
  v3Live.deactivate();
  state = { ...state, mode: "incident", pinned_case_id: caseId };
  render();
  void v3Workbench.activate(caseId);
}

function syncV3ProjectionChrome(projection) {
  if (state.mode !== "incident") return;
  root.dataset.projectionRevision = String(projection.projection_revision);
  root.dataset.projectionSequence = String(projection.sequence);
  els["workspace-title"].textContent = projection.title;
  const resolved = projection.lifecycle_state === "RESOLVED" || projection.current_attempt.status === "COMPLETED";
  els.stage.textContent = resolved ? "Resolved" : titleCase(projection.current_attempt.current_stage);
  els["status-text"].textContent = resolved ? "Recovery verified" : `${titleCase(projection.freshness.state)} · attempt ${projection.current_attempt.attempt_number}`;
}

function hideLegacyV2IncidentChrome() {
  for (const element of legacyV2ChromeElements()) {
    if (!v2LegacyVisibility.has(element)) v2LegacyVisibility.set(element, element.hidden);
    element.hidden = true;
  }
}

function restoreLegacyV2Chrome() {
  for (const [element, wasHidden] of v2LegacyVisibility) element.hidden = wasHidden;
  v2LegacyVisibility.clear();
}

function legacyV2ChromeElements() {
  return [
    document.querySelector(".canvas-shell"),
    els["operations-team-rail"],
    els["incident-strip"],
    els["context-drawer"],
    els["timeline-dock"],
    els["incident-stage-rail"]
  ].filter(Boolean);
}

function renderV2IncidentWorkspace(projection) {
  root.dataset.incidentWorkspace = "v2";
  els["incident-workspace"].hidden = false;
  const snapshot = incidentWorkspaceSnapshot(projection);
  const signal = snapshot.signal;
  const clock = snapshot.clock;
  const selectedNode = projection.graph.nodes.find((node) => node.component_id === state.selected_component_id) || null;
  const focus = projection.incident_focus || null;
  const pane = ["metrics", "activity", "evidence", "component"].includes(workspacePane) ? workspacePane : "overview";
  const isFresh = clock?.freshness === "CURRENT" && state.connection === "connected";
  const actionCards = state.actions.cards;
  const affected = snapshot.affectedNodes.length ? snapshot.affectedNodes : projection.graph.nodes;
  const evidenceCount = snapshot.citations.length;
  const activity = snapshot.activities[0] || null;
  const signalTitle = signal?.title || "No current signal published";
  const signalValue = signal?.display_value || "Unavailable";
  const sourceFreshness = signal?.freshness || clock?.freshness || "UNKNOWN";
  const currentStatus = signal?.status || projection.status;
  els["incident-workspace"].innerHTML = `
    <div class="iw-shell" data-freshness="${escapeHtml(String(sourceFreshness).toLowerCase())}">
      <header class="iw-heading">
        <div class="iw-heading-copy">
          <div class="iw-eyebrow"><span class="iw-status-dot ${isFresh ? "is-current" : "is-stale"}"></span><span>${escapeHtml(titleCase(sourceFreshness))} server projection</span><span>Sequence ${projection.sequence}</span></div>
          <h2>${escapeHtml(projection.operator_title || projection.incident_id)}</h2>
          <p>${escapeHtml(projection.operator_summary || "The server has not published an operator summary.")}</p>
        </div>
        <div class="iw-heading-actions" aria-label="Incident workspace panels">
          <button type="button" class="iw-panel-button" data-incident-pane="metrics"><span>Metric history</span><strong>${escapeHtml(signalValue)}</strong></button>
          <button type="button" class="iw-panel-button" data-incident-pane="activity"><span>Agent activity</span><strong>${snapshot.activities.length}</strong></button>
          <button type="button" class="iw-panel-button" data-incident-pane="evidence"><span>Evidence</span><strong>${evidenceCount}</strong></button>
        </div>
      </header>

      <div class="iw-stage-line" aria-label="Canonical incident state">
        <span class="iw-stage-chip is-${escapeHtml(String(projection.lifecycle_stage).toLowerCase())}">${escapeHtml(titleCase(projection.lifecycle_stage))}</span>
        <span>Lifecycle owned by Temporal</span>
        <span>Connector ${escapeHtml(titleCase(projection.connector_health[0]?.state || "unknown"))}</span>
        <span>${escapeHtml(titleCase(projection.status))}</span>
      </div>

      <div class="iw-overview-grid">
        <section class="iw-card iw-signal-card" aria-labelledby="iw-signal-title">
          <div class="iw-card-label">Current alert</div>
          <div class="iw-signal-main"><div><h3 id="iw-signal-title">${escapeHtml(signalTitle)}</h3><p>${escapeHtml(titleCase(currentStatus))} · ${escapeHtml(titleCase(signal?.trend || "unknown"))} · ${escapeHtml(signal?.source_label || "Source unavailable")}</p></div><strong>${escapeHtml(signalValue)}</strong></div>
          <dl class="iw-fact-row"><div><dt>Observed</dt><dd>${escapeHtml(conciseTimestamp(signal?.observed_at))}</dd></div><div><dt>Evidence</dt><dd>${signal?.evidence_refs?.length || 0} linked records</dd></div><div><dt>Authority</dt><dd>${escapeHtml(signal?.authority ? authorityCopy(signal.authority) : "Unavailable")}</dd></div></dl>
          <button type="button" class="iw-inline-link" data-incident-pane="metrics">Inspect server-owned time series <span aria-hidden="true">→</span></button>
        </section>

        <section class="iw-card iw-clock-card" aria-labelledby="iw-clock-title">
          <div class="iw-card-label">Incident clock</div>
          <h3 id="iw-clock-title">${escapeHtml(clock ? formatIncidentDuration(clock.elapsed_seconds) : "Unavailable")}</h3>
          <p>${clock?.freshness === "CURRENT" ? "Bounded from the server clock anchor." : "Frozen because the server clock is not current."}</p>
          <dl class="iw-fact-row"><div><dt>Clock state</dt><dd>${escapeHtml(titleCase(projection.incident_clock?.state || "unknown"))}</dd></div><div><dt>Last signal</dt><dd>${escapeHtml(conciseTimestamp(projection.incident_clock?.last_signal_at))}</dd></div><div><dt>Fresh until</dt><dd>${escapeHtml(conciseTimestamp(projection.incident_clock?.fresh_until))}</dd></div></dl>
        </section>

        <section class="iw-card iw-investigation-card" aria-labelledby="iw-investigation-title">
          <div class="iw-card-label">Investigate → Decide</div>
          <h3 id="iw-investigation-title">${escapeHtml(investigationTitle(projection))}</h3>
          <p>${escapeHtml(investigationCopy(projection))}</p>
          ${actionCards.length ? `<div class="iw-action-list">${actionCards.map((card) => `<article><div><span>Server-issued action</span><strong>${escapeHtml(card.title)}</strong><p>${escapeHtml(card.summary)}</p></div><button type="button" class="button" data-control-action="${escapeHtml(card.action_id)}"${state.actions.in_flight ? " disabled" : ""}>${escapeHtml(actionButtonCopy(card.cta))}</button></article>`).join("")}</div>` : `<div class="iw-no-action"><span>Next action</span><strong>No server-issued action is available</strong><p>The workspace will only show an action after the backend signs and revalidates it.</p></div>`}
        </section>

        <section class="iw-card iw-path-card" aria-labelledby="iw-path-title">
          <div class="iw-card-heading"><div><div class="iw-card-label">Affected path</div><h3 id="iw-path-title">${escapeHtml(focus?.affected_user_path_status === "KNOWN" ? "Known user impact path" : "Impact path under investigation")}</h3></div><button type="button" class="iw-inline-link" data-incident-pane="component">Open component detail <span aria-hidden="true">→</span></button></div>
          <p>${escapeHtml(focus?.affected_user_path_summary || focus?.rationale || "The server has not published a confirmed user-path summary.")}</p>
          <div class="iw-topology" role="list" aria-label="Affected components">
            ${affected.map((node, index) => {
              const inspectable = projection.impacted_path.includes(node.component_id);
              const target = inspectable
                ? `data-incident-node="${escapeHtml(node.component_id)}"`
                : `data-incident-component="${escapeHtml(node.component_id)}"`;
              return `<button type="button" class="iw-node ${node.impact_status === "impacted" ? "is-impacted" : ""}" ${target}><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(node.impact_status)} · ${escapeHtml(node.runtime_status)}</small></button>`;
            }).join("")}
          </div>
          <div class="iw-relation-list">${projection.graph.edges.filter((edge) => affected.some((node) => node.component_id === edge.source_component_id) && affected.some((node) => node.component_id === edge.target_component_id)).slice(0, 5).map((edge) => `<span>${escapeHtml(edge.source_component_id)} <b>→</b> ${escapeHtml(edge.target_component_id)}</span>`).join("")}</div>
        </section>

        <section class="iw-card iw-activity-preview" aria-labelledby="iw-activity-title">
          <div class="iw-card-heading"><div><div class="iw-card-label">Agent workspace</div><h3 id="iw-activity-title">${escapeHtml(activity?.tool_label || "No activity published")}</h3></div><button type="button" class="iw-inline-link" data-incident-pane="activity">View activity <span aria-hidden="true">→</span></button></div>
          <p>${escapeHtml(activity?.summary || "The server has not published agent activity for this incident.")}</p>
          <div class="iw-activity-meta"><span>${escapeHtml(titleCase(activity?.role || "unknown"))}</span><span>${escapeHtml(titleCase(activity?.state || "unknown"))}</span><span>${escapeHtml(conciseTimestamp(activity?.completed_at || activity?.started_at))}</span></div>
        </section>
      </div>
      ${incidentPaneMarkup(pane, projection, snapshot, selectedNode)}
    </div>`;
}

function incidentPaneMarkup(pane, projection, snapshot, selectedNode) {
  if (pane === "overview") return "";
  const title = ({ metrics: "Metric history", activity: "Agent activity", evidence: "Evidence records", component: "Component quick peek" })[pane];
  let content = "";
  if (pane === "metrics") {
    const points = snapshot.chart.points.map((point) => `${point.x},${point.y}`).join(" ");
    const latest = snapshot.signal;
    content = `<div class="iw-metric-detail"><div class="iw-chart-summary"><span>Current value</span><strong>${escapeHtml(latest?.display_value || "Unavailable")}</strong><small>${escapeHtml(latest?.title || "No current server signal")}</small></div><div class="iw-chart" role="img" aria-label="Server-owned metric samples"><svg viewBox="0 0 560 156" preserveAspectRatio="none"><path class="iw-chart-grid" d="M0 26H560M0 78H560M0 130H560"/>${points ? `<polyline points="${points}"/>${snapshot.chart.points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="3"/>`).join("")}` : ""}</svg>${points ? "" : "<p>No numeric sample was published by the backend.</p>"}</div><div class="iw-chart-range"><span>${snapshot.chart.min === null ? "No numeric sample" : `${snapshot.chart.min}${snapshot.chart.unit}`}</span><span>${snapshot.chart.max === null ? "" : `${snapshot.chart.max}${snapshot.chart.unit}`}</span><span>${snapshot.chart.points.length} server samples</span></div></div>`;
  } else if (pane === "activity") {
    content = `<ol class="iw-activity-list">${snapshot.activities.slice(0, 16).map((item) => `<li><div><strong>${escapeHtml(item.tool_label)}</strong><span>${escapeHtml(titleCase(item.state))}</span></div><p>${escapeHtml(item.summary)}</p><small>${escapeHtml(titleCase(item.role))} · ${escapeHtml(conciseTimestamp(item.completed_at || item.started_at))} · ${item.evidence_refs.length} linked records</small></li>`).join("") || "<li>No agent activity was published by the backend.</li>"}</ol>`;
  } else if (pane === "evidence") {
    const selected = snapshot.citations.find((citation) => citation.citation_id === selectedCitationId) || null;
    content = `${selected ? `<section class="iw-evidence-selected"><span>Selected citation</span><strong>${escapeHtml(selected.label)}</strong><p>${escapeHtml(titleCase(selected.provider))} · ${escapeHtml(titleCase(selected.freshness))} · observed ${escapeHtml(conciseTimestamp(selected.observed_at))}</p><code>${escapeHtml(selected.evidence_id)}</code></section>` : ""}<ul class="iw-evidence-list">${snapshot.citations.slice(0, 20).map((citation) => `<li><button type="button" data-incident-citation="${escapeHtml(citation.citation_id)}"><span>${escapeHtml(titleCase(citation.provider))}</span><strong>${escapeHtml(citation.label)}</strong><small>${escapeHtml(titleCase(citation.freshness))} · ${escapeHtml(conciseTimestamp(citation.observed_at))}</small></button></li>`).join("") || "<li>No citations were published by the backend.</li>"}</ul>`;
  } else {
    const node = selectedNode
      || projection.graph.nodes.find((item) => item.component_id === selectedIncidentComponentId)
      || projection.graph.nodes.find((item) => item.component_id === projection.incident_focus?.component_id)
      || projection.graph.nodes[0]
      || null;
    const relationships = node ? projection.graph.edges.filter((edge) => edge.source_component_id === node.component_id || edge.target_component_id === node.component_id) : [];
    const explanation = state.explanation.receipt?.explanation;
    const explanationAvailable = Boolean(node && projection.impacted_path.includes(node.component_id));
    const explanationCopy = explanation?.component_id === node?.component_id
      ? explanation.summary
      : state.explanation.status === "starting"
        ? "Starting the server-owned component explanation."
        : explanationAvailable
          ? "This component is eligible for a server-owned explanation."
          : "The current projection has not opened a server-side explanation for this component.";
    content = node ? `<div class="iw-component-detail"><div class="iw-component-status"><span>${escapeHtml(node.impact_status)}</span><h3>${escapeHtml(node.display_name)}</h3><p>${escapeHtml(node.runtime_status)} · ${escapeHtml(node.membership === "CLASSIFIED" ? node.classification_reason : "Connected to the incident graph")}</p></div><section><span>Server explanation</span><p>${escapeHtml(explanationCopy)}</p></section><section><span>Recorded relations</span><ul>${relationships.map((edge) => `<li>${escapeHtml(edge.source_component_id)} → ${escapeHtml(edge.target_component_id)} · ${escapeHtml(edge.status)}</li>`).join("") || "<li>No relation was published for this component.</li>"}</ul></section></div>` : "<p>The server has not published a component for this view.</p>";
  }
  return `<section class="iw-pane-layer" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="iw-pane"><header><div><span>Incident workspace</span><h2>${escapeHtml(title)}</h2></div><button type="button" class="icon-button" data-incident-pane="overview" aria-label="Close ${escapeHtml(title)}">Close</button></header>${content}</div></section>`;
}

function investigationTitle(projection) {
  if (projection.investigation_result?.disposition === "ACCEPTED") return "Investigation accepted by the server";
  if (projection.investigation_result) return "Investigation needs review";
  return "Evidence collection is active";
}

function investigationCopy(projection) {
  if (projection.investigation_result?.summary) return projection.investigation_result.summary;
  return projection.lifecycle_stage === "DECIDE"
    ? "The server advanced this incident to the decision stage."
    : "No conclusion is shown until the backend records an evidence-backed result.";
}

function renderModeButtons() {
  for (const button of document.querySelectorAll("button.mode-button[data-mode]")) {
    const selected = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function renderError() {
  const visible = ["degraded", "stale"].includes(state.connection);
  els["error-banner"].hidden = !visible;
  if (!visible) return;
  els["error-message"].textContent = errorCopy(lastError || state.connection);
}

function renderToast() {
  const toast = state.mode === "incident" ? null : state.toast;
  els.toast.hidden = !toast;
  if (!toast) return;
  els.toast.innerHTML = `<div><strong>${escapeHtml(toast.incident.title)}</strong><span>${escapeHtml(toast.incident.summary)}</span></div><button type="button" data-control-focus>Focus incident</button>`;
}

function renderGraph() {
  const projection = state.projection;
  if (!projection) {
    clearTopologyDensity();
    const copy = state.connection === "degraded" ? "" : emptyCanvasCopy();
    els["canvas-layers"].innerHTML = copy ? `<div class="control-plane-canvas-empty">${escapeHtml(copy)}</div>` : "";
    return;
  }
  const focusView = incidentTopologyView(projection);
  if (!focusView.available) {
    clearTopologyDensity();
    els["canvas-layers"].innerHTML = '<div class="control-plane-canvas-empty">The server has not published an auditable incident focus.</div>';
    return;
  }
  const layout = { density: "focus", canvas: null, positions: focusView.positions };
  applyTopologyDensity(layout);
  const { positions } = layout;
  const impacted = new Set(focusView.nodes.map((node) => node.component_id));
  const nodeById = new Map(focusView.nodes.map((node) => [node.component_id, node]));
  const pulseEdges = activePulseEdgeIds(projection);
  const edges = focusView.edges.map((edge, index) => edgeMarkup(edge, positions, impacted, nodeById, index, pulseEdges)).join("");
  const nodes = focusView.nodes.map((node) => nodeMarkup(node, true)).join("");
  els["canvas-layers"].innerHTML = `<div class="control-plane-twin-layer" data-topology-density="${layout.density}"><svg class="edge-map control-plane-edge-map" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${nodes}</div>`;
  applyTopologyNodePositions(els["canvas-layers"], positions);
}

function applyTopologyDensity(layout) {
  const canvas = els["twin-canvas"];
  if (layout.density !== "dense") {
    delete canvas.dataset.topologyDensity;
    delete root.dataset.topologyDensity;
    canvas.style.removeProperty("--control-plane-topology-width");
    canvas.style.removeProperty("--control-plane-topology-height");
    return;
  }
  canvas.dataset.topologyDensity = "dense";
  root.dataset.topologyDensity = "dense";
  canvas.style.setProperty("--control-plane-topology-width", `${layout.canvas.width}px`);
  canvas.style.setProperty("--control-plane-topology-height", `${layout.canvas.height}px`);
}

function clearTopologyDensity() {
  const canvas = els["twin-canvas"];
  delete canvas.dataset.topologyDensity;
  delete root.dataset.topologyDensity;
  canvas.style.removeProperty("--control-plane-topology-width");
  canvas.style.removeProperty("--control-plane-topology-height");
}

function nodeMarkup(node, impacted) {
  const clickable = state.projection?.schema_version !== "flowpulse.incident-projection.v2" && state.mode === "incident" && impacted && state.connection === "connected" && state.explanation.status !== "starting";
  const metadata = topologyNodeMetadata(node);
  return `<button type="button" class="twin-node control-plane-twin-node${impacted ? " is-impact" : " is-context"}${state.selected_component_id === node.component_id ? " is-selected" : ""}" data-control-component="${escapeHtml(node.component_id)}" data-clickable="${clickable}"${clickable ? "" : " disabled"}>
    <span class="node-icon" aria-hidden="true"><i class="ph ${impacted ? "ph-warning-circle" : "ph-cube"}"></i></span>
    <span class="node-copy"><strong>${escapeHtml(node.display_name)}</strong><small class="control-plane-node-metadata" title="${escapeHtml(metadata)}" aria-label="${escapeHtml(metadata)}">${escapeHtml(metadata)}</small></span>
  </button>`;
}

function edgeMarkup(edge, positions, impacted, nodes, index, pulseEdges = new Set()) {
  const source = positions.get(edge.source_component_id);
  const target = positions.get(edge.target_component_id);
  if (!source || !target || !nodes.has(edge.source_component_id) || !nodes.has(edge.target_component_id)) return "";
  const isImpacted = impacted.has(edge.source_component_id) && impacted.has(edge.target_component_id);
  const middle = (source.x + target.x) / 2;
  const path = `M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}`;
  const active = state.mode === "live"
    ? ["active", "healthy", "degraded"].includes(edge.status)
    : pulseEdges.has(edge.edge_id);
  return `<g class="edge-group${isImpacted ? " edge-impact" : ""}"><path class="edge-line${isImpacted ? " is-impact" : ""}" d="${path}"/><path class="pulse-flow${isImpacted ? " is-impact" : ""}${active ? " control-plane-live-pulse" : ""} pulse-slot-${index % 6}" d="${path}"/></g>`;
}

function renderIncidentChrome() {
  const projection = state.projection;
  const incidentMode = state.mode === "incident";
  els["incident-strip"].hidden = true;
  els["incident-stage-rail"].hidden = !projection || !incidentMode;
  els["timeline-dock"].hidden = true;
  if (!projection || !incidentMode) return;
  if (projection.schema_version === "flowpulse.incident-projection.v2") {
    els["incident-stage-rail"].innerHTML = `<button type="button" class="incident-stage-button is-active" disabled><span>1</span><strong>${escapeHtml(titleCase(projection.lifecycle_stage))}</strong><small>Backend lifecycle stage</small></button>`;
    return;
  }
  els["incident-stage-rail"].innerHTML = stageRailMarkup(investigationPresentation(projection));
}

function stageRailMarkup(investigation) {
  const current = investigation.stage === "DECIDE" ? "DECIDE" : "INVESTIGATE";
  const stages = [
    ["1", "Investigate", investigation.stage === "INVESTIGATE" ? investigationStatus(investigation) : "Recorded by server", current === "INVESTIGATE"],
    ["2", "Decide", current === "DECIDE" ? investigationStatus(investigation) : "Awaiting server decision", current === "DECIDE"]
  ];
  return stages.map(([number, title, detail, active]) => `<button type="button" class="incident-stage-button${active ? " is-active" : ""}" disabled><span>${number}</span><strong>${title}</strong><small>${escapeHtml(detail)}</small></button>`).join("");
}

function renderDrawer() {
  const projection = state.projection;
  const visible = Boolean(projection && state.mode === "incident");
  els["context-drawer"].hidden = !visible;
  els["drawer-tabs"].hidden = true;
  if (!visible) return;
  if (projection.schema_version === "flowpulse.incident-projection.v2") {
    renderV2Drawer(projection);
    return;
  }
  const node = projection.graph.nodes.find((candidate) => candidate.component_id === state.selected_component_id) || null;
  const focusNode = projection.graph.nodes.find((candidate) => candidate.component_id === projection.incident_focus?.component_id) || null;
  els["context-drawer"].dataset.tone = node && projection.impacted_path.includes(node.component_id) ? "impact" : "service";
  els["drawer-kind"].textContent = node ? "Selected component" : "Incident focus";
  els["drawer-title"].textContent = node?.display_name || focusNode?.display_name || projection.operator_title || "Incident context";
  els["drawer-subtitle"].textContent = node
    ? "Recorded agent context for this affected component."
    : projection.incident_focus?.rationale || "Waiting for the server focus recommendation.";
  els["drawer-content"].innerHTML = `${node ? explanationMarkup(projection, node) : incidentFocusMarkup(projection)}${actionProgressMarkup()}${actionCardsMarkup()}${investigationMarkup(investigationPresentation(projection))}`;
}

function renderV2Drawer(projection) {
  const signal = latestBySequence(projection.realtime_signals);
  const activities = projection.agent_workspace.activities;
  const activity = latestBySequence(activities);
  const health = projection.connector_health.map((connector) => `<li><strong>${escapeHtml(titleCase(connector.provider))}</strong><span>${escapeHtml(titleCase(connector.state))}</span><small>${escapeHtml(connector.reason_code || connector.truth_label)}</small></li>`).join("");
  const citations = projection.agent_workspace.citations.slice(-4).map((citation) => `<li><strong>${escapeHtml(citation.label)}</strong><span>${escapeHtml(titleCase(citation.freshness))}</span></li>`).join("");
  els["context-drawer"].dataset.tone = signal?.status === "CRITICAL" ? "impact" : "service";
  els["drawer-kind"].textContent = "Live agent workspace";
  els["drawer-title"].textContent = projection.operator_title || "Incident activity";
  const clock = projectIncidentClock(projection.incident_clock);
  els["drawer-subtitle"].textContent = `${titleCase(clock.freshness)} · ${formatElapsed(clock.elapsed_seconds)}`;
  els["drawer-content"].innerHTML = `
    <section class="component-context is-impact"><header><div><span>Current signal</span><strong>${escapeHtml(signal?.title || "No current signal")}</strong></div><small class="component-health">${escapeHtml(signal?.display_value || "Unavailable")}</small></header><p>${signal ? `${escapeHtml(titleCase(signal.status))} · ${escapeHtml(titleCase(signal.trend))} · ${escapeHtml(signal.source_label)}` : "The backend has not published a signal."}</p></section>
    <section class="component-context"><header><div><span>Agent activity</span><strong>${escapeHtml(activity?.tool_label || "No activity")}</strong></div><small class="component-health">${escapeHtml(activity ? titleCase(activity.state) : "Empty")}</small></header><p>${escapeHtml(activity?.summary || "The backend has not published agent activity.")}</p></section>
    <details class="agent-bar-section"><summary><span>Connector health</span><strong>${projection.connector_health.length}</strong></summary><ul class="investigation-claims">${health || "<li>No connector health published.</li>"}</ul></details>
    <details class="agent-bar-section"><summary><span>Citations</span><strong>${projection.agent_workspace.citations.length}</strong></summary><ul class="investigation-claims">${citations || "<li>No citations published.</li>"}</ul></details>`;
}

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s elapsed`;
}

function investigationMarkup(investigation) {
  if (!investigation.summary) return "";
  const claims = investigation.claims.map((claim) => `<li><strong>${escapeHtml(titleCase(claim.kind))}</strong><span>${escapeHtml(claim.statement)}</span></li>`).join("");
  const critic = investigation.critic
    ? `<details class="agent-bar-section"><summary><span>Independent critic</span><strong>${escapeHtml(criticOperatorStatusCopy(investigation.critic.operator_status))}</strong></summary><p>The independent server critic recorded ${escapeHtml(criticOperatorStatusCopy(investigation.critic.operator_status).toLowerCase())} for this investigation result.</p></details>`
    : "";
  return `<section class="investigation-result is-${escapeHtml(investigation.outcome)}"><details class="agent-bar-section"><summary><span>Investigation result</span><strong>${escapeHtml(investigationOutcomeCopy(investigation.outcome))}</strong></summary><p>${escapeHtml(investigation.summary)}</p>${claims ? `<ul class="investigation-claims">${claims}</ul>` : ""}<p class="investigation-truth">Evidence status: ${escapeHtml(truthLabelCopy(investigation.truth_label))}</p></details>${investigationEvidenceMarkup(investigation.evidence)}${critic}</section>`;
}

function explanationMarkup(projection, node) {
  const explanation = state.explanation;
  let body = "Select this affected component to read its recorded server explanation.";
  let evidence = [];
  let status = "Ready";
  if (explanation.status === "starting") {
    body = "Starting the recorded component explanation.";
    status = "Starting";
  }
  if (explanation.receipt) {
    body = explanation.receipt.explanation.summary;
    evidence = explanation.receipt.explanation.evidence_refs;
    status = explanation.receipt.reused ? "Reused" : explanationStateCopy(explanation.receipt.explanation.state);
  }
  const conversationItems = conversationItemsFor(projection, node, explanation.receipt);
  const conversation = conversationItemsMarkup(conversationItems);
  const summary = conversationItems.length ? "" : `<p>${escapeHtml(body)}</p>`;
  return `<section class="component-context is-impact"><header><div><span>Conversation Manager</span><strong>${escapeHtml(node.display_name)}</strong></div><small class="component-health">${escapeHtml(status)}</small></header>${summary}${conversation}${evidenceMarkup(evidence)}</section>`;
}

function incidentFocusMarkup(projection) {
  const focus = projection.incident_focus;
  if (!focus) return '<section class="incident-focus-summary is-unavailable"><strong>Incident focus unavailable</strong><p>The server has not published an auditable starting component.</p></section>';
  const node = projection.graph.nodes.find((candidate) => candidate.component_id === focus.component_id);
  const path = focus.affected_user_path_status === "KNOWN"
    ? focus.affected_user_path_summary
    : "The affected user path is not yet confirmed.";
  return `<section class="incident-focus-summary"><span>Recommended starting point</span><strong>${escapeHtml(node?.display_name || "Affected component")}</strong><p>${escapeHtml(focus.rationale)}</p><div><span>Affected user path</span><p>${escapeHtml(path)}</p></div><small>Select ${escapeHtml(node?.display_name || "the component")} on the graph to start or reuse its recorded explanation.</small></section>`;
}

function conversationItemsFor(projection, node, receipt) {
  const receiptItems = receipt?.explanation?.conversation_items || [];
  if (receiptItems.length) return receiptItems;
  return (projection?.conversation_items || []).filter((item) => item.component_id === node.component_id);
}

function conversationItemsMarkup(items) {
  if (!items.length) return "";
  return `<ol class="incident-conversation" aria-label="Recorded agent conversation">${items.map((item) => `<li><div><strong>Conversation Manager</strong><span>${escapeHtml(titleCase(item.knowledge_state))}</span></div><p>${escapeHtml(item.summary)}</p></li>`).join("")}</ol>`;
}

function actionCardsMarkup() {
  const cards = state.actions.cards;
  if (!cards.length) return "";
  return `<section class="control-plane-action-list" aria-label="Server-issued next actions">${cards.map((card) => `<article class="control-plane-action-card"><span>Server action</span><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.summary)}</p><button type="button" class="button" data-control-action="${escapeHtml(card.action_id)}"${state.actions.in_flight ? " disabled" : ""}>${escapeHtml(actionButtonCopy(card.cta))}</button></article>`).join("")}</section>`;
}

function actionProgressMarkup() {
  const inFlight = state.actions.in_flight;
  if (inFlight) return `<section class="detail-record is-pending"><header><span>Investigation progress</span><span>In progress</span></header><p>${escapeHtml(actionProgressCopy(inFlight.cta))}</p></section>`;
  const receipt = state.actions.receipt;
  if (!receipt) return "";
  const evidence = state.projection?.evidence_refs || [];
  return `<section class="detail-record is-accepted"><header><span>Investigation progress</span><span>${escapeHtml(actionReceiptCopy(receipt.status).label)}</span></header><p>${escapeHtml(actionReceiptCopy(receipt.status).copy)}</p>${evidenceMarkup(evidence)}</section>`;
}

function investigationEvidenceMarkup(evidence) {
  if (!evidence.length) return "";
  const details = evidence.map((item) => `<li>${escapeHtml(sourceKindCopy(item.source_kind))} · ${escapeHtml(freshnessCopy(item.freshness))} · ${escapeHtml(authorityCopy(item.authority))} · ${escapeHtml(proofScopeCopy(item.proof_scope))} · ${item.lineage_count ? `${item.lineage_count} parent record${item.lineage_count === 1 ? "" : "s"}` : "direct record"}</li>`).join("");
  return `<details class="agent-bar-section"><summary><span>Evidence</span><strong>${evidence.length} record${evidence.length === 1 ? "" : "s"}</strong></summary><ul class="telemetry-provenance">${details}</ul></details>`;
}

function evidenceMarkup(evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  const body = items.length ? items.map((value) => `<code>${escapeHtml(value)}</code>`).join("") : "No evidence references were returned.";
  return `<details class="record-disclosure"><summary>Show evidence</summary><div class="telemetry-provenance">${body}</div></details>`;
}

function viewTitle() {
  if (state.mode === "architecture") return "System architecture";
  if (state.mode === "live") return "Live system";
  return state.projection?.operator_title || "Incident";
}

function emptyCanvasCopy() {
  if (state.connection === "stale") return "Incident updates are stale. Waiting for a canonical projection.";
  return "Waiting for incident data from the server.";
}

function investigationStatus(investigation) {
  if (investigation.outcome === "accepted") return "Evidence accepted by the server";
  if (investigation.outcome === "degraded") return "Server result needs operator review";
  return "Waiting for server investigation";
}

function actionButtonCopy(cta) {
  return ({ request_gate_1: "Request investigation access", run_read_capability: "Read current evidence" })[cta] || "Review server action";
}

function actionProgressCopy(cta) {
  return cta === "request_gate_1" ? "Requesting investigation access from the server." : "Reading current incident evidence through the server.";
}

function actionReceiptCopy(status) {
  return status === "GATE1_GRANTED"
    ? { label: "Access recorded", copy: "Investigation access was recorded. Waiting for the server to refresh the available evidence." }
    : { label: "Evidence read recorded", copy: "The current evidence read was recorded. Waiting for the canonical investigation result." };
}

function explanationStateCopy(state) {
  return ({ COMPLETED: "Ready", DEGRADED: "Needs review", BLOCKED: "Blocked" })[state] || "Needs review";
}

function investigationOutcomeCopy(outcome) {
  return outcome === "accepted" ? "Accepted" : "Needs review";
}

function criticOperatorStatusCopy(status) {
  return ({ PASS: "Passed", REVISE: "Revision required", ABSTAIN: "No conclusion" })[status] || "Needs review";
}

function truthLabelCopy(label) {
  return ({ LIVE: "Current live evidence", TEST_DETERMINISTIC: "Deterministic test evidence", DEMO: "Demo evidence", DEGRADED: "Degraded evidence" })[label] || "Degraded evidence";
}

function operatorSummaryCopy(summary) {
  return String(summary).replace(/\b(TEST_DETERMINISTIC|DEGRADED)\b/g, (label) => truthLabelCopy(label).replace(/ evidence$/, ""));
}

function sourceKindCopy(kind) {
  return ({ METRIC: "Metric", LOG: "Log", TRACE: "Trace", CHANGE: "Change", CONFIG: "Configuration", TOPOLOGY: "Topology", KNOWLEDGE: "Knowledge", SOURCE_READBACK: "Source readback" })[kind] || "Recorded evidence";
}

function freshnessCopy(freshness) {
  return ({ CURRENT: "Current", AGING: "Aging", STALE: "Stale", UNKNOWN: "Unknown freshness" })[freshness] || "Unknown freshness";
}

function authorityCopy(authority) {
  return ({ T0_AUTHORITATIVE_CURRENT: "Authoritative current", T1_DIRECT_CURRENT: "Direct current", T2_DERIVED: "Derived", T3_HISTORICAL: "Historical", T4_UNTRUSTED: "Untrusted" })[authority] || "Untrusted";
}

function proofScopeCopy(scope) {
  return scope === "CURRENT_OBSERVATION" ? "Current observation" : "Reference only";
}

function titleCase(value) {
  return String(value).toLowerCase().replace(/(^|_)([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function requestedCaseId() {
  const value = new URL(window.location.href).searchParams.get("case_id");
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value || "") ? value : null;
}

function persistCaseId(caseId) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("case_id") === caseId) return;
  url.searchParams.set("case_id", caseId);
  history.replaceState(null, "", url);
}

function connectionCopy(connection) {
  return ({ connected: "Server projection connected", connecting: "Connecting to incident workspace", reconnecting: "Reconnecting to incident updates", stale: "Incident updates are stale", degraded: "Incident workspace unavailable" })[connection] || "Incident workspace unavailable";
}

function errorCopy(code) {
  if (code === "control_plane_auth_failed") return "The incident workspace is not authorized for this server session.";
  if (code === "control_plane_schema_invalid") return "The incident workspace returned an incompatible server projection.";
  if (code === "control_plane_identity_mismatch") return "The selected server identity no longer matches this workspace.";
  return "Incident data is unavailable. Retry after the server session is restored.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

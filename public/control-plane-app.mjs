import { ControlPlaneClient, ControlPlaneClientError } from "./control-plane-client.mjs";
import { controlPlaneReducer, createControlPlaneState, investigationPresentation } from "./control-plane-contract.mjs";

// This module intentionally mounts only into the mature app-shell. It owns
// presentation state, while all incident, gate, card, receipt, and evidence
// truth continues to come from the control-plane contract.
const client = new ControlPlaneClient();
const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const root = els["app-shell"];
const initialCaseId = requestedCaseId();
let state = createControlPlaneState();
let globalSubscription = null;
let caseSubscription = null;
let streamedCaseId = null;
let lastError = null;
const pendingProjections = new Set();
const pendingActions = new Set();
const pendingReceipts = new Set();

root.dataset.controlPlane = "true";
for (const button of document.querySelectorAll("button.mode-button[data-mode]")) {
  button.addEventListener("click", () => {
    state = { ...state, mode: button.dataset.mode };
    render();
  });
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
els["timeline-current"].addEventListener("click", () => {
  if (state.toast) dispatch({ type: "toast.focus" });
});

render();
await bootstrap();

async function bootstrap() {
  closeSubscriptions();
  lastError = null;
  dispatch({ type: "connection.reconnecting" });
  try {
    const summaries = await client.activeIncidents();
    dispatch({ type: "summaries.hydrated", summaries });
    openGlobalSubscription();
  } catch (error) {
    reportError(error);
  } finally {
    root.classList.remove("is-loading");
    render();
  }
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
  const projection = state.projection;
  root.dataset.mode = state.mode;
  root.classList.toggle("is-loading", !projection && state.connection === "connecting");
  els.environment.textContent = "Control plane / server projection";
  els["workspace-title"].textContent = viewTitle();
  els.stage.textContent = projection ? investigationPresentation(projection).stage : "Waiting";
  els["status-text"].textContent = connectionCopy(state.connection);
  els["canvas-title"].textContent = viewTitle();
  els["canvas-caption"].textContent = projection?.operator_summary || emptyCanvasCopy();
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
  renderGraph();
  renderIncidentChrome();
  renderDrawer();
  if (projection) persistCaseId(projection.case_id);
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
  const toast = state.toast;
  els.toast.hidden = !toast;
  if (!toast) return;
  els.toast.innerHTML = `<div><strong>${escapeHtml(toast.incident.title)}</strong><span>${escapeHtml(toast.incident.summary)}</span></div><button type="button" data-control-focus>Focus incident</button>`;
}

function renderGraph() {
  const projection = state.projection;
  if (!projection) {
    els["canvas-layers"].innerHTML = `<div class="control-plane-canvas-empty">${escapeHtml(emptyCanvasCopy())}</div>`;
    return;
  }
  const positions = graphPositions(projection.graph.nodes);
  const impacted = new Set(state.mode === "architecture" ? [] : projection.impacted_path);
  const nodeById = new Map(projection.graph.nodes.map((node) => [node.component_id, node]));
  const edges = projection.graph.edges.map((edge, index) => edgeMarkup(edge, positions, impacted, nodeById, index)).join("");
  const nodes = projection.graph.nodes.map((node) => nodeMarkup(node, positions.get(node.component_id), impacted.has(node.component_id))).join("");
  els["canvas-layers"].innerHTML = `<div class="control-plane-twin-layer"><svg class="edge-map control-plane-edge-map" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${nodes}</div>`;
}

function nodeMarkup(node, position, impacted) {
  const clickable = state.mode === "incident" && impacted && state.connection === "connected" && state.explanation.status !== "starting";
  const kind = node.membership === "CLASSIFIED" ? node.classification_reason : "Connected";
  return `<button type="button" class="twin-node control-plane-twin-node${impacted ? " is-impact" : ""}${state.selected_component_id === node.component_id ? " is-selected" : ""}" style="left:${position.x}%;top:${position.y}%" data-control-component="${escapeHtml(node.component_id)}" data-clickable="${clickable}"${clickable ? "" : " disabled"}>
    <span class="node-icon" aria-hidden="true"><i class="ph ${impacted ? "ph-warning-circle" : "ph-cube"}"></i></span>
    <span class="node-copy"><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(node.runtime_status)} · ${escapeHtml(kind)}</small></span>
  </button>`;
}

function edgeMarkup(edge, positions, impacted, nodes, index) {
  const source = positions.get(edge.source_component_id);
  const target = positions.get(edge.target_component_id);
  if (!source || !target || !nodes.has(edge.source_component_id) || !nodes.has(edge.target_component_id)) return "";
  const isImpacted = impacted.has(edge.source_component_id) && impacted.has(edge.target_component_id);
  const middle = (source.x + target.x) / 2;
  const path = `M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}`;
  const active = state.mode === "live" && ["active", "healthy", "degraded"].includes(edge.status);
  return `<g class="edge-group${isImpacted ? " edge-impact" : ""}"><path class="edge-line${isImpacted ? " is-impact" : ""}" d="${path}"/><path class="pulse-flow${isImpacted ? " is-impact" : ""}${active ? " control-plane-live-pulse" : ""} pulse-slot-${index % 6}" d="${path}"/></g>`;
}

function renderIncidentChrome() {
  const projection = state.projection;
  const incidentMode = state.mode === "incident";
  els["incident-strip"].hidden = !projection || !incidentMode;
  els["incident-stage-rail"].hidden = !projection || !incidentMode;
  els["timeline-dock"].hidden = !projection || !incidentMode;
  if (!projection || !incidentMode) return;
  els.severity.textContent = "ACTIVE";
  const investigation = investigationPresentation(projection);
  els["incident-title"].textContent = projection.operator_title || "Active incident";
  els["incident-summary"].textContent = projection.operator_summary || projection.status;
  els["incident-stage"].textContent = investigationStatus(investigation);
  els["open-incident-button"].textContent = state.focus_status === "loading" ? "Loading path" : "Incident focused";
  els["open-incident-button"].disabled = state.focus_status === "loading" || !state.toast;
  els["incident-stage-rail"].innerHTML = stageRailMarkup(investigation);
  els["stage-track"].style.setProperty("--stage-count", "4");
  els["stage-track"].innerHTML = stageTrackMarkup();
  els["timeline-time"].textContent = "Now";
  els["timeline-title"].textContent = investigation.stage === "CLOSED" ? "Verify" : titleCase(investigation.stage);
  els["timeline-copy"].textContent = investigationStatus(investigation);
}

function stageRailMarkup(investigation) {
  const current = investigation.stage === "CLOSED" ? "VERIFY" : investigation.stage;
  const stages = [
    ["1", "Investigate", investigation.stage === "INVESTIGATE" ? investigationStatus(investigation) : "Recorded by server", current === "INVESTIGATE"],
    ["2", "Decide", current === "DECIDE" ? investigationStatus(investigation) : "Locked by server", current === "DECIDE"],
    ["3", "Execute", current === "EXECUTE" ? "Server-owned stage" : "Locked by server", current === "EXECUTE"],
    ["4", "Verify", current === "VERIFY" ? "Server-owned stage" : "Locked by server", current === "VERIFY"]
  ];
  return stages.map(([number, title, detail, active]) => `<button type="button" class="incident-stage-button${active ? " is-active" : ""}" disabled><span>${number}</span><strong>${title}</strong><small>${escapeHtml(detail)}</small></button>`).join("");
}

function stageTrackMarkup() {
  const current = state.projection ? investigationPresentation(state.projection).stage : "INVESTIGATE";
  const normalized = current === "CLOSED" ? "VERIFY" : current;
  return ["Investigate", "Decide", "Execute", "Verify"].map((stage) => {
    const active = stage.toUpperCase() === normalized;
    return `<button type="button" class="stage-marker${active ? " is-current" : ""}" disabled><strong>${stage}</strong><span>${active ? "Current" : "Locked"}</span></button>`;
  }).join("");
}

function renderDrawer() {
  const projection = state.projection;
  const visible = Boolean(projection && state.mode === "incident");
  els["context-drawer"].hidden = !visible;
  els["drawer-tabs"].hidden = true;
  if (!visible) return;
  const node = projection.graph.nodes.find((candidate) => candidate.component_id === state.selected_component_id) || null;
  els["context-drawer"].dataset.tone = node && projection.impacted_path.includes(node.component_id) ? "impact" : "service";
  els["drawer-kind"].textContent = node ? "Component context" : "Incident workspace";
  els["drawer-title"].textContent = node?.display_name || projection.operator_title || "Investigate";
  els["drawer-subtitle"].textContent = node ? "Server-projected component context" : "Select an affected component to start its durable explanation.";
  els["drawer-content"].innerHTML = `${investigationMarkup(investigationPresentation(projection))}${node ? explanationMarkup(node) : '<div class="drawer-empty">Select a red affected component. That is the only interaction that starts or reuses a node explanation.</div>'}${actionCardsMarkup()}${actionReceiptMarkup()}`;
}

function investigationMarkup(investigation) {
  if (!investigation.summary) return "";
  const claims = investigation.claims.map((claim) => `<li><strong>${escapeHtml(titleCase(claim.kind))}</strong><span>${escapeHtml(claim.statement)}</span></li>`).join("");
  const critic = investigation.critic ? `<p class="investigation-critic">Independent review: ${escapeHtml(investigation.critic.identity)} · ${escapeHtml(investigation.critic.decision)}</p>` : "";
  return `<section class="detail-record investigation-result is-${escapeHtml(investigation.outcome)}"><header><span>Server investigation</span><span>${escapeHtml(titleCase(investigation.outcome))}</span></header><p>${escapeHtml(investigation.summary)}</p>${claims ? `<ul class="investigation-claims">${claims}</ul>` : ""}${critic}<p class="investigation-truth">Truth label: ${escapeHtml(investigation.truth_label || "DEGRADED")}</p>${investigationEvidenceMarkup(investigation.evidence)}</section>`;
}

function explanationMarkup(node) {
  const explanation = state.explanation;
  let body = "Select this affected component to read its durable server explanation.";
  let evidence = [];
  if (explanation.status === "starting") body = "Starting the recorded component explanation.";
  if (explanation.receipt) {
    body = explanation.receipt.explanation.summary;
    evidence = explanation.receipt.explanation.evidence_refs;
  }
  return `<section class="component-context is-impact"><header><div><span>Conversation Manager</span><strong>${escapeHtml(node.display_name)}</strong></div><small class="component-health">${escapeHtml(explanation.status)}</small></header><p>${escapeHtml(body)}</p>${evidenceMarkup(evidence)}</section>`;
}

function actionCardsMarkup() {
  const cards = state.actions.cards;
  if (!cards.length) return "";
  return `<section class="control-plane-action-list" aria-label="Server-issued next actions">${cards.map((card) => `<article class="control-plane-action-card"><span>${escapeHtml(card.taxonomy)}</span><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.summary)}</p><button type="button" class="button" data-control-action="${escapeHtml(card.action_id)}"${state.actions.in_flight ? " disabled" : ""}>${escapeHtml(card.cta)}</button></article>`).join("")}</section>`;
}

function actionReceiptMarkup() {
  const receipt = state.actions.receipt;
  if (!receipt) return "";
  const evidence = state.projection?.evidence_refs || [];
  return `<section class="detail-record is-accepted"><header><span>Server action receipt</span><span>${escapeHtml(receipt.status)}</span></header><p>Recorded by the server. Waiting for the canonical projection.</p>${evidenceMarkup(evidence)}</section>`;
}

function investigationEvidenceMarkup(evidence) {
  if (!evidence.length) return "";
  const details = evidence.map((item) => `<li>${escapeHtml(item.source_kind)} · ${escapeHtml(item.freshness)} · ${escapeHtml(item.authority)} · ${escapeHtml(item.proof_scope)} · ${item.lineage_count ? `${item.lineage_count} parent record${item.lineage_count === 1 ? "" : "s"}` : "direct record"}</li>`).join("");
  return `<details class="record-disclosure"><summary>Show evidence</summary><ul class="telemetry-provenance">${details}</ul></details>`;
}

function evidenceMarkup(evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  const body = items.length ? items.map((value) => `<code>${escapeHtml(value)}</code>`).join("") : "No evidence references were returned.";
  return `<details class="record-disclosure"><summary>Show evidence</summary><div class="telemetry-provenance">${body}</div></details>`;
}

function graphPositions(nodes) {
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  return new Map(nodes.map((node, index) => [node.component_id, {
    x: 13 + (index % columns) * (74 / Math.max(1, columns - 1)),
    y: 24 + Math.floor(index / columns) * (54 / Math.max(1, rows - 1))
  }]));
}

function viewTitle() {
  if (state.mode === "architecture") return "System architecture";
  if (state.mode === "live") return "Live system";
  return state.projection?.operator_title || "Incident";
}

function emptyCanvasCopy() {
  if (state.connection === "degraded") return "The canonical control-plane projection is unavailable.";
  if (state.connection === "stale") return "Incident updates are stale. Waiting for a canonical projection.";
  return "Waiting for a canonical incident projection.";
}

function investigateStatus(investigation) {
  if (investigation.outcome === "accepted") return "Evidence-backed result accepted by server";
  if (investigation.outcome === "degraded") return "Server investigation needs operator review";
  return "Server-owned investigation";
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
  return "The canonical control-plane projection could not be read. Retry after server access is restored.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

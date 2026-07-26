import { ControlPlaneClient, ControlPlaneClientError } from "./control-plane-client.mjs";
import { controlPlaneReducer, createControlPlaneState } from "./control-plane-contract.mjs";

const client = new ControlPlaneClient();
const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const initialCaseId = requestedCaseId();
let state = createControlPlaneState();
let globalSubscription = null;
let caseSubscription = null;
let streamedCaseId = null;
const pendingProjections = new Set();
const pendingReceipts = new Set();

for (const button of document.querySelectorAll("[data-control-mode]")) {
  button.addEventListener("click", () => {
    state = { ...state, mode: button.dataset.controlMode };
    render();
  });
}
els["control-plane-focus"].addEventListener("click", () => dispatch({ type: "toast.focus" }));
els["control-plane-retry"].addEventListener("click", bootstrap);
els["control-plane-canvas"].addEventListener("click", (event) => {
  const node = event.target.closest("[data-control-component]");
  if (node?.dataset.clickable === "true") dispatch({ type: "node.clicked", component_id: node.dataset.controlComponent });
});
els["control-plane-composer"].addEventListener("submit", (event) => event.preventDefault());

await bootstrap();

async function bootstrap() {
  closeGlobalSubscription();
  dispatch({ type: "connection.reconnecting" });
  try {
    const summaries = await client.activeIncidents();
    dispatch({ type: "summaries.hydrated", summaries });
    openGlobalSubscription();
  } catch (error) {
    dispatch({ type: "connection.degraded" });
    renderError(error);
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
      dispatch({ type: "connection.degraded" });
      renderError(error);
    } finally {
      pendingProjections.delete(key);
    }
    return;
  }
  if (effect.type === "node-explanation.start") {
    try {
      const receipt = await client.startNodeExplanation(state.projection.case_id, effect.command);
      dispatch({ type: "explanation.receipt", receipt });
    } catch (error) {
      dispatch({ type: "connection.degraded" });
      renderError(error);
    }
  }
}

function openGlobalSubscription() {
  if (globalSubscription) return;
  globalSubscription = client.subscribeGlobal({
    onNotification: (notification) => dispatch({ type: "notification.received", notification }),
    onConnection: (connection) => dispatch({ type: `connection.${connection}` })
  });
}

function syncCaseSubscription() {
  const projection = state.projection;
  if (!projection || streamedCaseId === projection.case_id) return;
  caseSubscription?.close();
  streamedCaseId = projection.case_id;
  caseSubscription = client.subscribeCase({
    caseId: projection.case_id,
    after: state.last_case_sequence,
    onEvent: (event) => {
      const selectedBeforeEvent = state.selected_component_id;
      dispatch({ type: "case.event", event });
      if (selectedBeforeEvent && ["COMPLETED", "DEGRADED"].includes(event.explanation_status) && typeof event.payload?.explanation_id === "string") {
        void loadReceipt(event.case_id, event.payload.explanation_id);
      }
    },
    onConnection: (connection) => dispatch({ type: `connection.${connection}` })
  });
}

async function loadReceipt(caseId, explanationId) {
  const key = `${caseId}:${explanationId}`;
  if (pendingReceipts.has(key)) return;
  pendingReceipts.add(key);
  try {
    dispatch({ type: "explanation.receipt", receipt: await client.nodeExplanationReceipt(caseId, explanationId) });
  } catch (error) {
    dispatch({ type: "connection.degraded" });
    renderError(error);
  } finally {
    pendingReceipts.delete(key);
  }
}

function closeGlobalSubscription() {
  globalSubscription?.close();
  globalSubscription = null;
  caseSubscription?.close();
  caseSubscription = null;
  streamedCaseId = null;
}

function render() {
  const projection = state.projection;
  const labels = { architecture: "System architecture", live: "Live system", incident: projection?.operator_title || "Incident" };
  els["control-plane-app"].dataset.mode = state.mode;
  els["control-plane-title"].textContent = labels[state.mode];
  els["control-plane-kicker"].textContent = state.mode === "incident" ? "Incident workspace" : "Server projection";
  els["control-plane-summary"].textContent = projection?.operator_summary || "Waiting for the canonical incident projection.";
  els["control-plane-status"].textContent = connectionLabel(state.connection);
  els["control-plane-status"].classList.toggle("is-degraded", ["degraded", "stale"].includes(state.connection));
  if (state.connection !== "degraded") els["control-plane-degraded"].hidden = true;
  els["control-plane-connection"].dataset.state = state.connection;
  els["control-plane-connection"].textContent = connectionCopy(state.connection);
  for (const button of document.querySelectorAll("[data-control-mode]")) {
    const active = button.dataset.controlMode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  renderToast();
  renderGraph();
  renderDecision();
  if (projection) persistCaseId(projection.case_id);
}

function renderToast() {
  const toast = state.toast;
  els["control-plane-toast"].hidden = !toast;
  if (!toast) return;
  els["control-plane-toast-title"].textContent = toast.incident.title;
  els["control-plane-toast-copy"].textContent = toast.incident.summary;
}

function renderGraph() {
  const projection = state.projection;
  if (!projection) {
    els["control-plane-canvas"].innerHTML = '<p class="control-plane-empty">Waiting for a server projection.</p>';
    return;
  }
  const nodes = projection.graph.nodes;
  const positions = graphPositions(nodes);
  const impacted = new Set(state.mode === "architecture" ? [] : projection.impacted_path);
  const nodeById = new Map(nodes.map((node) => [node.component_id, node]));
  const edges = projection.graph.edges.map((edge) => edgeMarkup(edge, positions, impacted, nodeById)).join("");
  const nodeMarkup = nodes.map((node) => {
    const position = positions.get(node.component_id);
    const isImpacted = impacted.has(node.component_id);
    const clickable = state.mode === "incident" && isImpacted && state.explanation.status !== "starting";
    const classification = node.membership === "CLASSIFIED" ? `<span class="control-plane-node-classification">${escapeHtml(node.classification_reason)}</span>` : "";
    return `<button type="button" class="control-plane-node${isImpacted ? " is-impacted" : ""}" style="left:${position.x}%;top:${position.y}%;transform:translate(-50%,-50%)" data-control-component="${escapeHtml(node.component_id)}" data-clickable="${clickable}"${clickable ? "" : " disabled"}>
      <span class="control-plane-node-name">${escapeHtml(node.display_name)}</span>
      <span class="control-plane-node-meta"><i class="control-plane-node-dot" aria-hidden="true"></i>${escapeHtml(node.runtime_status)}</span>${classification}
    </button>`;
  }).join("");
  els["control-plane-canvas"].innerHTML = `<div class="control-plane-graph"><svg class="control-plane-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${nodeMarkup}</div>`;
}

function renderDecision() {
  const show = state.mode === "incident" && (state.selected_component_id || state.focus_status === "loading");
  els["control-plane-decision"].hidden = !show;
  if (!show) return;
  if (state.focus_status === "loading") {
    els["control-plane-decision-title"].textContent = "Loading impacted path";
    els["control-plane-decision-copy"].textContent = "Waiting for the canonical projection before focusing this incident.";
    els["control-plane-conversation"].innerHTML = "";
    return;
  }
  const node = state.projection?.graph.nodes.find((candidate) => candidate.component_id === state.selected_component_id);
  if (!node) return;
  els["control-plane-decision-title"].textContent = node.display_name;
  const explanation = state.explanation;
  if (explanation.status === "starting") {
    els["control-plane-decision-copy"].textContent = "Starting the recorded component explanation.";
    els["control-plane-conversation"].innerHTML = '<div class="control-plane-conversation-card"><strong>Conversation Manager</strong><p>Reading the durable explanation status.</p></div>';
    return;
  }
  if (explanation.receipt) {
    const record = explanation.receipt.explanation;
    els["control-plane-decision-copy"].textContent = record.state === "DEGRADED" ? "Recorded context is available; live capabilities remain unavailable." : "Recorded component explanation.";
    const evidence = record.evidence_refs.length ? record.evidence_refs.map(escapeHtml).join(", ") : "No evidence references were returned.";
    els["control-plane-conversation"].innerHTML = `<div class="control-plane-conversation-card"><strong>Conversation Manager</strong><p>${escapeHtml(record.summary)}</p><details><summary>Show evidence</summary><p>${evidence}</p></details></div>`;
    return;
  }
  els["control-plane-decision-copy"].textContent = "Select an impacted component to read its durable explanation.";
  els["control-plane-conversation"].innerHTML = "";
}

function renderError(error) {
  const code = error instanceof ControlPlaneClientError ? error.code : "control_plane_unavailable";
  els["control-plane-degraded"].hidden = false;
  els["control-plane-degraded-copy"].textContent = errorCopy(code);
  render();
}

function graphPositions(nodes) {
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  return new Map(nodes.map((node, index) => [node.component_id, {
    x: 13 + (index % columns) * (74 / Math.max(1, columns - 1)),
    y: 18 + Math.floor(index / columns) * (64 / Math.max(1, rows - 1))
  }]));
}

function edgeMarkup(edge, positions, impacted, nodeById) {
  const source = positions.get(edge.source_component_id);
  const target = positions.get(edge.target_component_id);
  if (!source || !target || !nodeById.has(edge.source_component_id) || !nodeById.has(edge.target_component_id)) return "";
  const isImpacted = impacted.has(edge.source_component_id) && impacted.has(edge.target_component_id);
  const live = edge.status === "active" || edge.status === "healthy" || edge.status === "degraded";
  const midX = (source.x + target.x) / 2;
  return `<path class="control-plane-edge${isImpacted ? " is-impacted" : ""}${live ? " is-live" : ""}" d="M ${source.x} ${source.y} C ${midX} ${source.y}, ${midX} ${target.y}, ${target.x} ${target.y}"/>`;
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

function connectionLabel(connection) {
  return ({ connected: "Live", connecting: "Connecting", reconnecting: "Reconnecting", stale: "Updates stale", degraded: "Unavailable" })[connection] || "Unavailable";
}

function connectionCopy(connection) {
  return ({ connected: "Server projection connected", connecting: "Connecting to incident workspace", reconnecting: "Reconnecting to incident updates", stale: "Incident updates are stale", degraded: "Incident workspace unavailable" })[connection] || "Incident workspace unavailable";
}

function errorCopy(code) {
  if (code === "control_plane_auth_failed") return "The incident workspace is not authorized for this server session.";
  if (code === "control_plane_schema_invalid") return "The incident workspace returned an incompatible projection.";
  if (code === "control_plane_identity_mismatch") return "The incident projection no longer matches the selected server identity.";
  return "The canonical control-plane projection could not be read. Try again after access is restored.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

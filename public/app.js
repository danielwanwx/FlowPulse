import {
  ARCHITECTURE_LAYERS,
  LIVE_LAYERS,
  LIVE_UNLINKED_LAYER,
  PULSE_SLOTS,
  TWIN_STAGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_EDGES,
  activeIncidentState,
  availableStage,
  architecturePositions,
  architectureViewTopology,
  compareFrames,
  compareProvenance,
  eventsAtStage,
  frameFor,
  liveEdgePath,
  liveIncidentNodeStates,
  liveSignalDuration,
  liveSignalProgress,
  livePulseSlots,
  livePositions,
  orderedSignalEdges,
  primaryLiveEdges,
  projectAgentCollaborators,
  topologyIntegrity
} from "./twin-state.mjs";

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const IMPACT_SEQUENCE = { checkout: 0, payment: 1, kafka: 2, accounting: 3, fraud: 4 };
const NODE_BY_ID = new Map(TWIN_NODES.map((node) => [node.id, node]));
const EDGE_BY_ID = new Map(TWIN_EDGES.map((edge) => [edge.id, edge]));
const LIVE_WORLD = Object.freeze({ width: 1480, height: 680, minScale: .6, maxScale: 1.6, step: .1 });
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
const COLLABORATOR_ACTIONS = Object.freeze({
  commander: ["advance", "delegate_task", "draft_jira", "approve_jira_draft"],
  observer: ["advance", "delegate_task"],
  investigator: ["delegate_task"],
  critic: ["advance"],
  "recovery-engineer": ["review_recovery", "review_pr", "approve_pr_review"],
  verifier: ["verify_recovery", "review_learning"]
});

let state;
let developmentStatus;
let mode = "architecture";
let renderedMode = null;
let cursor = 0;
let playing = false;
let busy = false;
let comparePercent = 50;
let compareFocus = "impact";
let selected = null;
let activeTab = "evidence";
let toastTimer;
let eventSource;
let streamedRunId;
let streamRefreshTimer;
let managerOpen = false;
let managerReply = "";
let liveView = { scale: 1, x: 0, y: 0, initialized: false };
let livePan = null;
let compareDrag = null;
let liveSignalTimers = [];
let liveSignalIndex = 0;
let liveSignalFrame = null;
let liveSignalGeneration = 0;
let componentCatalogSource = null;
let componentCatalogCache = new Map();
let selectedCollaboratorId = "commander";
const recoveryDrafts = new Map();

for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
for (const button of document.querySelectorAll("[data-nav-tab]")) button.addEventListener("click", () => handleNavigation(button.dataset.navTab));
for (const button of document.querySelectorAll("[data-focus-entity]")) button.addEventListener("click", () => openDrawer({ type: "node", id: button.dataset.focusEntity }, "overview"));
els["retry-button"].addEventListener("click", refresh);
els["live-button"].addEventListener("click", () => { closeWorkspaceMenu(); runLive(); });
els["details-button"].addEventListener("click", () => { closeWorkspaceMenu(); openDrawer({ type: "run", id: state?.run_id }, "evidence"); });
els["open-incident-button"].addEventListener("click", () => openDrawer({ type: "run", id: state?.run_id }, "agent"));
els["manager-button"].addEventListener("click", () => { closeWorkspaceMenu(); openManager(); });
els["manager-open-button"].addEventListener("click", openManager);
els["manager-close"].addEventListener("click", closeManager);
els["manager-agents-button"].addEventListener("click", () => { closeManager(); setMode("agents"); });
els["manager-primary-action"].addEventListener("click", runManagerPrimaryAction);
els["manager-form"].addEventListener("submit", sendManagerMessage);
els["manager-activity"].addEventListener("click", handleManagerActivity);
els["development-button"].addEventListener("click", handleDevelopmentAction);
els["drawer-close"].addEventListener("click", closeDrawer);
els["restart-button"].addEventListener("click", restartReplay);
els["back-button"].addEventListener("click", () => seek(cursor - 1));
els["forward-button"].addEventListener("click", stepForward);
els["play-button"].addEventListener("click", togglePlayback);
els["approve-button"].addEventListener("click", approveRepair);
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
els["compare-review-rail"].addEventListener("click", handleCompareReview);
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
els["timeline-current"].addEventListener("click", () => openDrawer({ type: "stage", id: TWIN_STAGES[cursor].id }, tabForStage(cursor)));
els["canvas-layers"].addEventListener("click", handleCanvasSelection);
els["canvas-layers"].addEventListener("keydown", handleCanvasKeydown);
els["canvas-layers"].addEventListener("click", handleRecoveryConsoleAction);
els["annotation-layer"].addEventListener("click", handleAnnotationSelection);
els["drawer-tabs"].addEventListener("click", handleDrawerTab);
els["drawer-content"].addEventListener("click", handleDrawerEntityFocus);

await refresh();

async function refresh() {
  setLoading(true);
  try {
    [state, developmentStatus] = await Promise.all([
      request("/api/state"),
      request("/api/development/status").catch(() => null)
    ]);
    cursor = availableStage(state.events);
    connectAgentStream();
    hideError();
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function render() {
  if (!state) return;
  const previousPositions = renderedMode && renderedMode !== mode ? captureCanvasNodePositions() : new Map();
  renderHeader();
  renderMetrics();
  renderCanvas();
  renderTimeline();
  renderApproval();
  renderDevelopmentControl();
  renderDrawer();
  renderManager();
  updateControls();
  animateCanvasTransition(previousPositions);
  renderedMode = mode;
}

function renderHeader() {
  const frame = currentFrame();
  const source = sourceState();
  const titles = { architecture: "System architecture", live: "Runtime activity", replay: "Incident diagnosis", agents: "Recovery Console", compare: "Recovery comparison" };
  const canvasTitles = { architecture: "Observed architecture", live: "Observed runtime", replay: "Incident reconstruction", agents: "Developer recovery workspace", compare: "Incident vs verified" };
  els["incident-title"].textContent = state.incident.title;
  els["incident-summary"].textContent = state.incident.summary;
  els.severity.textContent = state.incident.severity;
  els.environment.textContent = state.incident.environment;
  els["incident-stage"].textContent = state.stage;
  els["workspace-title"].textContent = titles[mode];
  els["canvas-title"].textContent = canvasTitles[mode];
  const architecture = mode === "architecture" ? architectureView() : null;
  els.stage.textContent = mode === "architecture" ? architecture ? `${architecture.graph.nodes.length} backend components` : "Architecture unavailable" : mode === "live" ? source.label : mode === "agents" ? agentControl().report.stage : mode === "compare" ? "Incident vs verified" : timelineStages()[cursor].label;
  els["status-text"].textContent = modeStatus();
  els["ledger-state"].textContent = `${state.events.length} immutable events`;
  els["capture-label"].textContent = captureLabel();
  els["capture-label"].className = `capture-label source-${mode === "compare" ? compareProvenance(state.events).tone : source.status}`;
  els["zoom-controls"].hidden = mode !== "live";
  updateZoomControls();
  els["canvas-caption"].textContent = modeCaption(frame);
  els["app-shell"].dataset.mode = mode;
  els["timeline-dock"].hidden = !["replay", "agents", "compare"].includes(mode);
  els["live-button"].hidden = !state.live_available;
  renderThemeToggle();
  for (const button of document.querySelectorAll("[data-mode]")) {
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
    const topology = view?.graph;
    els["metric-checkout-label"].textContent = "Components";
    els["metric-payment-label"].textContent = "Dependencies";
    els["metric-kafka-label"].textContent = "Source truth";
    setMetric("checkout", String(topology?.nodes.length || 0), view ? `${view.runtime_data.node_count} runtime/data · ${view.control_evidence.node_count} FlowPulse` : "Backend view unavailable");
    setMetric("payment", String(topology?.edges.length || 0), view ? `${view.runtime_data.edge_count} runtime · ${view.control_evidence.relation_count} control/evidence` : "No compatibility fallback");
    setMetric("kafka", view?.truth.label || "UNAVAILABLE", "backend projection");
    return;
  }
  if (mode === "live" || state.mode === "development") {
    const source = sourceState();
    const topology = topologyIntegrity(source.topology);
    const visibleDependencies = mode === "live" ? primaryLiveEdges(topology).length : topology?.edges?.length || 0;
    els["metric-checkout-label"].textContent = "Services";
    els["metric-payment-label"].textContent = "Dependencies";
    els["metric-kafka-label"].textContent = "Source age";
    setMetric("checkout", String(topology?.nodes?.length || 0), "");
    setMetric("payment", String(topology?.edges?.length || 0), `${visibleDependencies} primary paths shown${topology.unlinked_node_ids.length ? ` · ${topology.unlinked_node_ids.length} gaps` : ""}`);
    setMetric("kafka", source.freshness_ms == null ? "—" : formatAge(source.freshness_ms), "");
    return;
  }
  els["metric-checkout-label"].textContent = "Checkout errors";
  els["metric-payment-label"].textContent = "Payment";
  els["metric-kafka-label"].textContent = "Kafka lag";
  if (mode === "compare") {
    setMetric("checkout", "38.4% → 0.8%", "incident to verified");
    setMetric("payment", "61.6% → 99.98%", "reachability");
    setMetric("kafka", "11,842 → 620", "lag draining");
    return;
  }
  const metrics = currentFrame().metrics;
  for (const [name, metric] of Object.entries(metrics)) setMetric(name, metric.value, metric.note);
}

function setMetric(name, value, note) {
  els[`metric-${name}`].textContent = value;
  els[`metric-${name}-note`].textContent = note;
}

function renderCanvas() {
  stopLiveSignalLoop();
  els["twin-canvas"].classList.toggle("is-compare-mode", mode === "compare");
  els["twin-canvas"].classList.toggle("is-source-topology", mode === "architecture" || mode === "live");
  els["twin-canvas"].classList.toggle("is-architecture-source", mode === "architecture");
  els["twin-canvas"].classList.toggle("is-live-source", mode === "live");
  els["twin-canvas"].classList.toggle("is-agent-source", mode === "agents");
  configureCanvasWorld(mode === "live");
  if (mode === "architecture") {
    renderSourceCanvas("architecture");
    return;
  }
  if (mode === "live") {
    renderSourceCanvas("live");
    return;
  }
  if (mode === "agents") {
    renderAgentCanvas();
    return;
  }
  if (mode === "compare") {
    const { incident, recovered } = compareFrames();
    const provenance = compareProvenance(state.events);
    els["canvas-layers"].innerHTML = `${renderTwinLayer(recovered, "after", true)}${renderTwinLayer(incident, "before", false)}`;
    renderCompareReviewRail();
    els["compare-handle"].hidden = false;
    els["compare-canvas-range"].hidden = false;
    setAnnotations([]);
    els["twin-canvas"].setAttribute("aria-label", `Compare incident impact on the left with ${provenance.aria} on the right`);
    els["compare-canvas-range"].setAttribute("aria-label", `Drag to compare incident with ${provenance.aria}`);
    renderComparePosition();
    return;
  }
  const frame = currentFrame();
  els["compare-review-rail"].hidden = true;
  els["canvas-layers"].innerHTML = renderTwinLayer(frame, "current", true);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  // Keep one causal cue on the canvas. The full evidence trail remains in the
  // drawer and timeline, so the diagnosis map can stay readable at a glance.
  const annotations = state.mode === "development" ? developmentAnnotations(cursor) : frame.annotations;
  setAnnotations(annotations.length ? [annotations.at(-1)] : []);
  els["twin-canvas"].setAttribute("aria-label", `Incident diagnosis at ${frame.stage.label}`);
}

function renderSourceCanvas(layout) {
  const architecture = layout === "architecture" ? architectureView() : null;
  const source = architecture ? architectureSource(architecture) : sourceState();
  const topology = architecture ? architecture.graph : topologyIntegrity(source.topology);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  els["compare-review-rail"].hidden = true;
  setAnnotations([]);
  if (!topology?.nodes?.length) {
    els["canvas-layers"].innerHTML = `<div class="source-empty">
      <i class="ph ph-plugs" aria-hidden="true"></i>
      <strong>${layout === "architecture" ? "Architecture projection unavailable" : escapeHtml(source.label)}</strong>
      <span>${layout === "architecture" ? "The backend-owned complete topology view is missing or invalid. The six-node incident compatibility graph is not used as a fallback." : source.status === "disconnected" ? "No OTLP capture is registered. Connect the pinned local runtime or open Diagnose." : "The collector files exist but do not contain a complete OTLP record yet."}</span>
    </div>`;
    els["twin-canvas"].setAttribute("aria-label", layout === "architecture" ? "Architecture projection unavailable." : `${source.label}. No observed service topology is available.`);
    return;
  }
  const positioned = layout === "architecture" ? architecturePositions(topology.nodes) : livePositions(topology.nodes);
  const nodeStates = layout === "architecture"
    ? Object.fromEntries(topology.nodes.map((node) => [node.id, node.status]))
    : liveIncidentNodeStates({ mode: state.mode, events: state.events, source });
  if (layout === "architecture") {
    const controlRelations = topology.edges.filter((edge) => ["control", "evidence"].includes(edge.plane));
    const tiers = ARCHITECTURE_LAYERS.map((layer, layerIndex) => {
      const members = positioned.filter((node) => node.layerIndex === layerIndex);
      if (!members.length) return "";
      const relations = layer.id === "control"
        ? controlRelations.filter((edge) => edge.plane === "control")
        : layer.id === "evidence"
          ? controlRelations.filter((edge) => edge.plane === "evidence")
          : [];
      return `<section class="architecture-tier architecture-tier-${layerIndex}" aria-label="${escapeHtml(layer.label)}">
        <header class="architecture-tier-label" data-plane="${escapeHtml(layer.id)}"><b aria-hidden="true">${String(layerIndex + 1).padStart(2, "0")}</b><span><strong>${escapeHtml(layer.label)}</strong><small>${escapeHtml(layer.description || "Observed services")}</small></span><em>${members.length} component${members.length === 1 ? "" : "s"}</em></header>
        <div class="architecture-tier-row">${members.map((node) => sourceNodeMarkup(node, { layout, source, nodeStates })).join("")}</div>
        ${relations.length ? `<div class="architecture-tier-relations" data-plane="${escapeHtml(layer.id)}">${relations.map((edge) => `<span>${escapeHtml(edge.label || edge.kind)} · ${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>`).join("")}</div>` : ""}
      </section>`;
    }).join("");
    els["canvas-layers"].innerHTML = `<div class="twin-layer layer-current architecture-stack is-complete-topology">${tiers}</div>`;
    els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
    els["twin-canvas"].dataset.unlinkedNodes = "0";
    els["twin-canvas"].dataset.runtimeEdges = String(architecture.runtime_data.edge_count);
    els["twin-canvas"].dataset.controlRelations = String(architecture.control_evidence.relation_count);
    els["twin-canvas"].setAttribute("aria-label", `Architecture block stack with ${architecture.runtime_data.node_count} runtime/data components and ${architecture.control_evidence.node_count} FlowPulse control/evidence components. ${architecture.runtime_data.edge_count} runtime dependencies and ${architecture.control_evidence.relation_count} control/evidence relations are projected by the backend.`);
    return;
  }
  const positions = new Map(positioned.map((node) => [node.id, node]));
  const primaryEdges = primaryLiveEdges(topology);
  const primaryTopology = { ...topology, edges: primaryEdges };
  const pulseSlots = livePulseSlots(primaryTopology);
  const signalOrder = new Map(orderedSignalEdges(primaryEdges, pulseSlots).map((edge, index) => [edge.id, index]));
  const edgeLayout = {
    canvasWidth: LIVE_WORLD.width,
    canvasHeight: LIVE_WORLD.height,
    nodeWidth: 156,
    nodeHeight: 76
  };
  const edges = primaryEdges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)).map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const lane = index % 2 ? Math.ceil(index / 2) : -Math.ceil((index + 1) / 2);
    const path = liveEdgePath(from, to, { ...edgeLayout, lane });
    const edgeState = liveSignalTone(edge, nodeStates);
    return `<g class="edge-group path-runtime signal-${edgeState}" data-live-edge-id="${escapeHtml(edge.id)}" data-signal-from="${escapeHtml(edge.from)}" data-signal-to="${escapeHtml(edge.to)}" data-signal-order="${signalOrder.get(edge.id) ?? index}"><path class="edge-line is-${edgeState}" d="${path}"/><g class="signal-droplet" aria-hidden="true"><circle class="signal-droplet-halo" r="6"/><circle class="signal-droplet-tail signal-droplet-tail-far" r=".8"/><circle class="signal-droplet-tail signal-droplet-tail-near" r="1.35"/><circle class="signal-droplet-body" r="2.6"/><circle class="signal-droplet-specular" r=".65"/></g><path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(from.label)} to ${escapeHtml(to.label)}" data-edge-id="${escapeHtml(edge.id)}" data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"/></g>`;
  }).join("");
  const nodes = positioned.map((node) => sourceNodeMarkup(node, { layout, source, nodeStates })).join("");
  const guideLayers = [...LIVE_LAYERS, ...(topology.unlinked_node_ids.length ? [LIVE_UNLINKED_LAYER] : [])];
  const guides = `<div class="live-guides" aria-hidden="true">${guideLayers.map((layer, index) => `<span class="live-guide-${index}">${escapeHtml(layer.label)}</span>`).join("")}</div>${topology.invalid_edges.length ? `<div class="topology-warning"><i class="ph ph-warning" aria-hidden="true"></i>${topology.invalid_edges.length} invalid dependency endpoint${topology.invalid_edges.length === 1 ? "" : "s"} omitted</div>` : ""}`;
  const change = layout === "live" ? renderLiveChange(positioned, edgeLayout) : { edge: "", node: "" };
  els["canvas-layers"].innerHTML = `${guides}<div class="twin-layer layer-current"><svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none">${edges}${change.edge}</svg>${nodes}${change.node}</div>`;
  startLiveSignalLoop();
  els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
  els["twin-canvas"].dataset.unlinkedNodes = String(topology.unlinked_node_ids.length);
  els["twin-canvas"].dataset.observedEdges = String(topology.edges.length);
  els["twin-canvas"].dataset.displayedEdges = String(primaryEdges.length);
  setAnnotations(mode === "replay" ? developmentAnnotations(cursor) : []);
  els["twin-canvas"].setAttribute("aria-label", `Runtime topology with ${positioned.length} observed services. ${primaryEdges.length} primary paths are shown from ${topology.edges.length} authoritative dependencies, with ${topology.unlinked_node_ids.length} components lacking dependency evidence from ${sourceOrigin(layout)}`);
}

function sourceNodeMarkup(node, { layout, source, nodeStates }) {
  const architecture = layout === "architecture";
  const nodeState = architecture ? nodeStates[node.id] || "observed" : node.connectivity === "unlinked" ? "unlinked" : nodeStates[node.id] || "dormant";
  const nodeStatus = architecture ? statusLabel(nodeState) : sourceStatusLabel(nodeState, source.status);
  const ariaStatus = nodeState === "unlinked" ? "Insufficient dependency evidence" : nodeStatus;
  const profile = architecture ? architectureComponentProfile(node) : sourceComponentProfile(node);
  const origin = architecture ? `${kindLabel(node.kind)} · ${node.plane} / ${node.layer}` : `RUNTIME · ${sourceOrigin(layout)}`;
  const detail = architecture ? `${node.provenance_refs.length} provenance ref${node.provenance_refs.length === 1 ? "" : "s"}` : node.detail || (nodeState === "unlinked" ? "dependency not observed" : "observed service.name");
  const livePositionClass = layout === "live" ? ` live-column-${node.layerIndex} live-count-${node.layerSize} live-index-${node.layerPosition}` : "";
  return `<button class="twin-node source-node plane-${escapeHtml(node.plane || "runtime")} kind-${escapeHtml(node.kind)} is-${nodeState}${livePositionClass}" type="button" data-node-id="${escapeHtml(node.id)}" data-status="${escapeHtml(nodeState)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" aria-label="${escapeHtml(architecture ? node.label : profile.capability)}, ${escapeHtml(kindLabel(node.kind))}, ${escapeHtml(architecture ? `${node.plane} plane ${node.layer} layer` : profile.runtimeIdentity)}, ${escapeHtml(ariaStatus)}">
    <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span>
    <span class="node-copy"><span class="node-origin">${escapeHtml(origin)}</span><strong>${escapeHtml(node.label)}</strong><span class="node-detail">${escapeHtml(detail)}</span><span class="node-status">${escapeHtml(nodeStatus)}</span></span>
    <span class="node-status-dot" aria-hidden="true"></span>
  </button>`;
}

function liveSignalTone(edge, nodeStates) {
  if (nodeStates[edge.from] === "impact" || nodeStates[edge.to] === "impact") return "impact";
  const verified = state.events.some((event) => event.type === "verification.completed" && event.payload?.passed === true);
  if (verified && ["checkout", "payment", "kafka", "accounting", "fraud-detection", "fraud"].some((id) => id === edge.from || id === edge.to)) return "verified";
  return "observed";
}

function renderLiveChange(positioned, edgeLayout) {
  const repair = [...state.events].reverse().find((event) => event.type === "repair.executed" || event.type === "approval.granted" || event.type === "approval.requested" || event.type === "repair.proposed");
  if (!repair) return { edge: "", node: "" };
  const checkout = positioned.find((node) => node.id === "checkout");
  if (!checkout) return { edge: "", node: "" };
  const changeNode = { x: 82, y: 8 };
  const path = liveEdgePath(changeNode, checkout, { ...edgeLayout, lane: -2 });
  const executed = state.events.some((event) => event.type === "repair.executed");
  const approved = state.events.some((event) => event.type === "approval.granted");
  const status = executed ? "verified" : approved ? "active" : "approval";
  const label = executed ? "Checkout rollback deployed" : approved ? "Rollback deployment queued" : "Checkout rollback proposed";
  return {
    edge: `<g class="edge-group path-control"><path class="edge-line is-${status}" d="${path}"/><path class="pulse-flow is-${status}" d="${path}" pathLength="1" aria-hidden="true"/><path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(label)} to checkout" data-edge-id="live-repair-checkout" data-edge-from="deployment" data-edge-to="checkout"/></g>`,
    node: `<button class="twin-node source-node live-change-node plane-control kind-change is-${status}" type="button" data-node-id="deployment" data-status="${status}" data-transition-key="deployment" aria-label="Deployment change, ${escapeHtml(label)}, ${escapeHtml(statusLabel(status))}"><span class="node-icon" aria-hidden="true"><i class="ph ph-git-commit"></i></span><span class="node-copy"><span class="node-origin">LEDGER CHANGE</span><strong>Checkout recovery</strong><span class="node-detail">${escapeHtml(repair.payload.target || "checkout")}</span><span class="node-status">${escapeHtml(statusLabel(status))}</span></span><span class="node-status-dot" aria-hidden="true"></span></button>`
  };
}

function startLiveSignalLoop() {
  const groups = [...els["canvas-layers"].querySelectorAll("[data-live-edge-id]")]
    .sort((a, b) => Number(a.dataset.signalOrder) - Number(b.dataset.signalOrder));
  if (!groups.length) return;
  const nodes = new Map([...els["canvas-layers"].querySelectorAll("[data-node-id]")].map((node) => [node.dataset.nodeId, node]));
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const generation = liveSignalGeneration;
  const remaining = new Set(groups.map((group) => group.dataset.liveEdgeId));
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      liveSignalTimers = liveSignalTimers.filter((candidate) => candidate !== timer);
      if (generation === liveSignalGeneration) callback();
    }, delay);
    liveSignalTimers.push(timer);
  };
  const pointAt = (path, progress) => path.getPointAtLength(path.getTotalLength() * Math.max(0, Math.min(1, progress)));
  const place = (circle, point) => {
    circle?.setAttribute("cx", point.x);
    circle?.setAttribute("cy", point.y);
  };
  const nextGroup = (group) => {
    remaining.delete(group.dataset.liveEdgeId);
    let next = groups.find((candidate) => remaining.has(candidate.dataset.liveEdgeId) && candidate.dataset.signalFrom === group.dataset.signalTo);
    next ||= groups.find((candidate) => remaining.has(candidate.dataset.liveEdgeId));
    if (!next) {
      for (const candidate of groups) remaining.add(candidate.dataset.liveEdgeId);
      next = groups[0];
    }
    liveSignalIndex = groups.indexOf(next);
    return next;
  };
  const activate = (group) => {
    if (generation !== liveSignalGeneration) return;
    clearLiveSignalClasses();
    const from = nodes.get(group.dataset.signalFrom);
    const to = nodes.get(group.dataset.signalTo);
    from?.classList.add("is-signal-launch");
    if (reduced) {
      from?.classList.remove("is-signal-launch");
      to?.classList.add("is-signal-arrival");
      return;
    }
    const path = group.querySelector(".edge-line");
    const halo = group.querySelector(".signal-droplet-halo");
    const body = group.querySelector(".signal-droplet-body");
    const specular = group.querySelector(".signal-droplet-specular");
    const nearTail = group.querySelector(".signal-droplet-tail-near");
    const farTail = group.querySelector(".signal-droplet-tail-far");
    if (!path || !body) return;
    const pathLength = path.getTotalLength();
    const duration = liveSignalDuration(pathLength);
    group.dataset.signalProgress = "0";
    group.dataset.signalPathLength = pathLength.toFixed(1);
    group.dataset.signalDuration = Math.round(duration);
    group.dataset.signalSpeed = "520";
    group.classList.add("is-signal-active");
    let startedAt = null;
    const travel = (timestamp) => {
      if (generation !== liveSignalGeneration) return;
      startedAt ??= timestamp;
      const elapsed = timestamp - startedAt;
      const progress = liveSignalProgress(elapsed, pathLength);
      group.dataset.signalProgress = progress.toFixed(3);
      const bodyPoint = pointAt(path, progress);
      place(body, bodyPoint);
      place(halo, bodyPoint);
      place(specular, { x: bodyPoint.x - 1.25, y: bodyPoint.y - 1.25 });
      place(nearTail, pointAt(path, progress - .016));
      place(farTail, pointAt(path, progress - .034));
      if (elapsed < duration && progress < 1) {
        liveSignalFrame = requestAnimationFrame(travel);
        return;
      }
      liveSignalFrame = requestAnimationFrame(() => {
        if (generation !== liveSignalGeneration) return;
        group.classList.remove("is-signal-active");
        from?.classList.remove("is-signal-launch");
        to?.classList.add("is-signal-arrival");
        schedule(() => activate(nextGroup(group)), 120);
      });
    };
    liveSignalFrame = requestAnimationFrame(travel);
  };

  liveSignalIndex = Math.min(liveSignalIndex, groups.length - 1);
  activate(groups[liveSignalIndex]);
}

function stopLiveSignalLoop() {
  liveSignalGeneration += 1;
  if (liveSignalFrame !== null) cancelAnimationFrame(liveSignalFrame);
  liveSignalFrame = null;
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
  els["compare-review-rail"].hidden = true;
  const control = agentControl();
  const team = projectAgentCollaborators(control);
  if (!team.nodes.some((node) => node.id === selectedCollaboratorId)) selectedCollaboratorId = "commander";
  const positions = new Map(team.nodes.map((node) => [node.id, node]));
  const selectedAgent = positions.get(selectedCollaboratorId) || team.nodes[0];
  const edges = team.edges.map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const path = collaboratorEdgePath(from, to);
    const pulse = ["active", "waiting", "rejected", "observing"].includes(edge.status)
      ? `<path class="pulse-flow is-${agentEdgeTone(edge.status)}" d="${path}" pathLength="1" aria-hidden="true"/>`
      : "";
    return `<g class="edge-group path-control collaborator-edge collaborator-edge-${index}"><path class="edge-line is-${agentEdgeTone(edge.status)}" d="${path}"/>${pulse}<path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(from.label)} to ${escapeHtml(to.label)}" data-agent-edge-id="${escapeHtml(edge.id)}"/></g>`;
  }).join("");
  const nodes = team.nodes.map((node) => {
    const selectedState = node.id === selectedAgent.id;
    return `<button class="collaborator-node collaborator-node-${escapeHtml(node.id)} is-${agentNodeTone(node.status)} ${selectedState ? "is-selected" : ""}" type="button" data-collaborator-id="${escapeHtml(node.id)}" data-status="${escapeHtml(agentNodeTone(node.status))}" aria-label="${escapeHtml(node.label)}, ${escapeHtml(agentStatusLabel(node.status))}" aria-pressed="${selectedState}">
      <span class="collaborator-icon icon-role-${escapeHtml(node.id)}" aria-hidden="true"><i class="ph ph-${escapeHtml(node.icon)}"></i><span class="node-status-dot"></span></span>
      <strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(agentStatusLabel(node.status))}</small>
    </button>`;
  }).join("");
  const report = control.report;
  const allowedActionIds = new Set(COLLABORATOR_ACTIONS[selectedAgent.id] || []);
  const actionButtons = control.actions.filter((action) => allowedActionIds.has(action.id)).map((action) => {
    const needsOwner = action.requires_owner === true;
    const externalDraft = ["pull_request", "work_item"].includes(action.kind);
    const note = needsOwner ? "Opens the separate human gate" : externalDraft ? "Ledger draft · connector not configured" : action.kind === "task" ? "Internal agent assignment" : "Ledger-governed control";
    return `<button class="recovery-action ${needsOwner ? "is-owner" : ""}" type="button" data-recovery-action="${escapeHtml(action.id)}" ${busy ? "disabled" : ""}><span><i class="ph ph-${recoveryActionIcon(action.id)}" aria-hidden="true"></i><strong>${escapeHtml(action.label)}</strong></span><small>${escapeHtml(note)}</small></button>`;
  }).join("") || `<p class="recovery-empty">No direct control is available for this collaborator at the current stage.</p>`;
  const activity = (control.activity || []).filter((item) => selectedAgent.activityIds.includes(item.agent_id)).slice(-3).reverse();
  const activityMarkup = activity.map((item) => `<button class="recovery-work-item" type="button" data-collaborator-inspect="${escapeHtml(item.agent_id)}"><span class="work-item-state is-${escapeHtml(agentNodeTone(positions.get(selectedAgent.id)?.status))}" aria-hidden="true"></span><span><strong>${escapeHtml(item.summary)}</strong><small>${escapeHtml(item.type.replaceAll(".", " "))}</small></span><code>${escapeHtml(String(item.sequence))}</code></button>`).join("") || `<p class="recovery-empty">No attributed activity has been recorded for this collaborator yet.</p>`;
  const finding = collaboratorFinding(selectedAgent, control);
  const citations = collaboratorCitations(selectedAgent, control);
  const conversation = (control.activity || []).filter((item) => item.collaborator_id === selectedAgent.id && ["manager.message.received", "manager.response.created"].includes(item.type)).slice(-4);
  const conversationMarkup = conversation.length
    ? conversation.map((item) => `<p class="collaboration-message ${item.type === "manager.message.received" ? "is-human" : "is-agent"}"><span>${item.type === "manager.message.received" ? "You" : selectedAgent.label}</span>${escapeHtml(item.summary)}</p>`).join("")
    : `<p class="collaboration-message is-agent"><span>${escapeHtml(selectedAgent.label)}</span>${escapeHtml(managerReply || finding)}</p>`;
  const quickPrompts = selectedAgent.prompts.slice(0, 2).map((prompt) => `<button type="submit" form="recovery-command-form" data-recovery-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join("");
  const internalRoles = selectedAgent.roleIds.map((id) => `<span>${escapeHtml(agentLabel(id))}</span>`).join("");
  const currentStage = report.stage || state.stage;
  const summaryLabel = report.human_gate ? "Owner gate" : report.verification ? "Verified" : "Current investigation";
  const summaryDetail = report.human_gate ? "Human approval required before remediation" : currentStage ? `Ledger stage · ${currentStage}` : "Awaiting the next ledger event";
  els["canvas-layers"].innerHTML = `<div class="recovery-console-layout">
    <section class="recovery-diagnosis" aria-label="Current diagnosis">
      <div class="diagnosis-state"><span>${escapeHtml(summaryLabel)}</span><strong>${escapeHtml(report.title)}</strong><small>${escapeHtml(summaryDetail)}</small></div>
      <p>${escapeHtml(report.root_cause || report.summary)}</p>
      ${report.rejected_diagnosis ? `<div class="diagnosis-rejection"><span>Rejected hypothesis</span><strong>${escapeHtml(report.rejected_diagnosis.hypothesis_id)}</strong></div>` : ""}
      ${report.confidence != null ? `<div class="diagnosis-score"><span>Evaluator confidence</span><strong>${Math.round(report.confidence * 100)}%</strong></div>` : ""}
    </section>
    <section class="recovery-graph-panel" aria-label="Agent execution graph">
      <header><div><span>Incident team</span><strong>${escapeHtml(team.nodes.find((node) => node.id === team.currentId)?.label || "Commander")}</strong></div><small>Current ledger owner</small></header>
      <div class="recovery-graph"><svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none">${edges}</svg>${nodes}<div class="agent-infrastructure-rail"><button type="button" data-collaborator-inspect="ledger"><i class="ph ph-database" aria-hidden="true"></i><span><strong>Evidence ledger</strong><small>Authority · ${escapeHtml(String(control.last_sequence))} events</small></span></button><button type="button" data-collaborator-inspect="langfuse"><i class="ph ph-waveform" aria-hidden="true"></i><span><strong>Langfuse</strong><small>Observability · ${control.langfuse === "observing" ? "connected" : "not configured"}</small></span></button></div></div>
    </section>
    <aside class="recovery-command" aria-label="${escapeHtml(selectedAgent.label)} collaboration panel" aria-live="polite">
      <header class="collaboration-header"><span class="collaboration-avatar icon-role-${escapeHtml(selectedAgent.id)} is-${escapeHtml(agentNodeTone(selectedAgent.status))}" aria-hidden="true"><i class="ph ph-${escapeHtml(selectedAgent.icon)}"></i><span class="node-status-dot"></span></span><div><span>${escapeHtml(agentStatusLabel(selectedAgent.status))}</span><strong id="collaboration-panel-title" tabindex="-1">${escapeHtml(selectedAgent.label)}</strong><small>${escapeHtml(selectedAgent.responsibility)}</small></div><button type="button" class="collaboration-inspect" data-collaborator-inspect="${escapeHtml(selectedAgent.currentRole)}">Inspect</button></header>
      <section class="collaboration-finding"><div class="recovery-section-title"><strong>Latest grounded signal</strong><span>${escapeHtml(selectedAgent.currentRole.replaceAll("_", " "))}</span></div><p>${escapeHtml(finding)}</p><div class="collaboration-citations">${citations.slice(0, 3).map((ref) => `<code>${escapeHtml(ref)}</code>`).join("") || "<span>Evidence not yet cited</span>"}</div></section>
      <section class="collaboration-prompts"><div>${quickPrompts}</div></section>
      <section class="collaboration-thread"><div class="recovery-section-title"><strong>Conversation</strong></div>${conversationMarkup}</section>
      <details class="recovery-context"><summary><span>Evidence, activity &amp; controls</span><small>${activity.length} updates · ${control.actions.filter((action) => allowedActionIds.has(action.id)).length} actions</small></summary><div class="recovery-context-body"><div class="collaboration-roles" aria-label="Isolated backend roles">${internalRoles}</div><section class="recovery-work-queue"><div class="recovery-section-title"><strong>Recent activity</strong></div>${activityMarkup}</section><section class="recovery-actions"><div class="recovery-section-title"><strong>Available controls</strong><span>Ledger governed</span></div>${actionButtons}</section></div></details>
      <form class="recovery-command-form" id="recovery-command-form">
        <label for="recovery-command-input">Ask ${escapeHtml(selectedAgent.label)} about this incident</label>
        <div><input id="recovery-command-input" name="message" type="text" maxlength="2000" autocomplete="off" value="${escapeHtml(recoveryDrafts.get(selectedAgent.id) || "")}" placeholder="Ask ${escapeHtml(selectedAgent.label)} about this incident…"><button class="button approve" type="submit" data-recovery-command-send ${busy ? "disabled" : ""}>Send</button></div>
        <small>Chat may assign safe work. Owner approval remains separate.</small>
      </form>
    </aside>
  </div>`;
  const commandForm = els["canvas-layers"].querySelector(".recovery-command-form");
  const fillPrompt = (button) => {
    recoveryDrafts.set(selectedAgent.id, button.dataset.recoveryPrompt);
    commandForm.elements.message.value = button.dataset.recoveryPrompt;
    commandForm.elements.message.focus();
  };
  commandForm.elements.message.addEventListener("input", () => {
    recoveryDrafts.set(selectedAgent.id, commandForm.elements.message.value);
  });
  commandForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.matches("[data-recovery-prompt]")) {
      fillPrompt(event.submitter);
      return;
    }
    await sendRecoveryCommand(commandForm);
  });
  setAnnotations([]);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  els["twin-canvas"].setAttribute("aria-label", `Recovery Console. ${control.report.title}. Selected collaborator ${selectedAgent.label}.`);
}

function renderTwinLayer(frame, layerName, interactive) {
  const suffix = `${layerName}-${frame.index}`;
  const edges = TWIN_EDGES.map((edge) => {
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
  const nodes = TWIN_NODES.map((node) => {
    const status = frame.nodeStates[node.id] || "quiet";
    const sequence = IMPACT_SEQUENCE[node.id] ?? 0;
    const entering = frame.index === 2 && status === "impact" ? " is-entering" : "";
    const interaction = interactive ? `data-node-id="${node.id}" aria-label="${escapeHtml(kindLabel(node.kind))} ${escapeHtml(node.label)}, ${escapeHtml(nodeOrigin(node))}, ${escapeHtml(statusLabel(status))}"` : "tabindex=\"-1\" aria-hidden=\"true\"";
    return `<button class="twin-node plane-${node.plane} node-${node.id} sequence-${sequence} kind-${node.kind} is-${status}${entering}" type="button" data-status="${escapeHtml(status)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" ${interaction}>
      <span class="node-icon icon-${node.id}" aria-hidden="true"><i class="ph ph-${TWIN_ICONS[node.id]}"></i></span>
      <span class="node-copy">
        <span class="node-origin">${escapeHtml(nodeOrigin(node))}</span>
        <strong>${escapeHtml(node.label)}</strong>
        <span class="node-detail">${escapeHtml(node.detail)}</span>
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
  if (mode !== "compare") return;
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

function renderCompareReviewRail() {
  if (mode !== "compare") return;
  const decision = compareDecisionModel();
  const provenance = compareProvenance(state.events);
  const approvalLabel = decision.approval?.type === "approval.granted" ? "Owner approved" : decision.approval?.type === "approval.requested" ? "Owner gate required" : "Owner gate not reached";
  const executionLabel = decision.executed ? "Rollback recorded" : "Execution not recorded";
  const verificationLabel = decision.verified ? "Recovery verified" : "Verification not yet passed";
  const learningLabel = decision.regression ? "Regression recorded" : "Regression pending";
  const focusItems = [
    ["impact", "Impact", "Before → verified operating state"],
    ["cause", "Cause", "Rejected symptom and confirmed mechanism"],
    ["recovery", "Recovery", "Bounded change, owner gate, verification"],
    ["learning", "Learning", "Reusable evidence path and policy record"]
  ];
  const focusButtons = focusItems.map(([id, label, copy]) => `<button type="button" data-compare-focus="${id}" aria-pressed="${String(compareFocus === id)}"><strong>${label}</strong><small>${copy}</small></button>`).join("");
  els["compare-review-rail"].hidden = false;
  els["compare-review-rail"].innerHTML = `<header class="compare-review-header">
    <span>DECISION REVIEW</span>
    <h2 id="compare-review-title">What changed, and why</h2>
    <p>${escapeHtml(provenance.caption)}</p>
  </header>
  <nav class="compare-review-focus" aria-label="Decision review focus">${focusButtons}</nav>
  <div class="compare-review-list">
    <section class="compare-review-section is-${compareFocus === "impact" ? "active" : "quiet"}">
      <button type="button" class="compare-review-item" data-compare-focus="impact" data-compare-tab="verify">
        <span class="compare-review-kicker">Impact → verified outcome</span>
        <strong>Checkout 38.4% → 0.8% errors</strong>
        <small>Payment 61.6% → 99.98% reachable · Kafka 11,842 → 620 lag</small>
      </button>
    </section>
    <section class="compare-review-section is-${compareFocus === "cause" ? "active" : "quiet"}">
      <button type="button" class="compare-review-item" data-compare-focus="cause" data-compare-tab="eval">
        <span class="compare-review-kicker">Causal decision</span>
        <strong>${escapeHtml(decision.rejected ? "Kafka initiation rejected" : "Evaluator record pending")}</strong>
        <small>${escapeHtml(decision.rejected?.payload?.reason || "No adversarial verdict is recorded for this run.")}</small>
        <span class="compare-evidence">${compareEvidenceChips(decision.rejected)}</span>
      </button>
      <button type="button" class="compare-review-item" data-compare-focus="cause" data-compare-tab="changes">
        <span class="compare-review-kicker">Confirmed mechanism</span>
        <strong>${escapeHtml(decision.rootCause)}</strong>
        <small>${escapeHtml(decision.rootCopy)}</small>
        <span class="compare-evidence">${compareEvidenceChips(decision.cause || decision.accepted)}</span>
      </button>
    </section>
    <section class="compare-review-section is-${compareFocus === "recovery" ? "active" : "quiet"}">
      <button type="button" class="compare-review-item" data-compare-focus="recovery" data-compare-tab="repair">
        <span class="compare-review-kicker">Bounded recovery</span>
        <strong>${escapeHtml(decision.recovery)}</strong>
        <small>${escapeHtml(decision.recoveryCopy)}</small>
        <span class="compare-review-state">${escapeHtml(approvalLabel)} · ${escapeHtml(executionLabel)} · ${escapeHtml(verificationLabel)}</span>
      </button>
    </section>
    <section class="compare-review-section is-${compareFocus === "learning" ? "active" : "quiet"}">
      <button type="button" class="compare-review-item" data-compare-focus="learning" data-compare-tab="evolve">
        <span class="compare-review-kicker">Next time</span>
        <strong>Start with deploy + first failing trace</strong>
        <small>${escapeHtml(decision.nextTime)}</small>
        <span class="compare-review-state">${escapeHtml(learningLabel)}${decision.policy ? ` · ${escapeHtml(String(decision.policy.payload?.promotion || "policy evaluated").replaceAll("_", " "))}` : ""}</span>
      </button>
    </section>
  </div>`;
  applyCompareFocus();
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
  renderCompareReviewRail();
}

function handleCompareReview(event) {
  const item = event.target.closest("[data-compare-tab]");
  if (item && mode === "compare") {
    event.stopPropagation();
    compareFocus = item.dataset.compareFocus;
    applyCompareFocus();
    openDrawer({ type: "run", id: state.run_id }, item.dataset.compareTab);
    els["context-drawer"].hidden = false;
    return;
  }
  const focus = event.target.closest("[data-compare-focus]");
  if (!focus || mode !== "compare") return;
  compareFocus = focus.dataset.compareFocus;
  renderCompareReviewRail();
}

function setComparePercent(value) {
  comparePercent = value;
  renderComparePosition();
}

function startCompareDrag(event) {
  if (mode !== "compare" || event.button !== 0 || event.target.closest(".twin-node, .causal-note, .edge-hit")) return;
  compareDrag = event.pointerId;
  els["compare-handle"].classList.add("is-dragging");
  els["twin-canvas"].setPointerCapture?.(event.pointerId);
  updateCompareFromPointer(event.clientX);
  event.preventDefault();
}

function moveCompareDrag(event) {
  if (compareDrag !== event.pointerId) return;
  updateCompareFromPointer(event.clientX);
}

function endCompareDrag(event) {
  if (compareDrag !== event.pointerId) return;
  updateCompareFromPointer(event.clientX);
  compareDrag = null;
  els["compare-handle"].classList.remove("is-dragging");
  els["twin-canvas"].releasePointerCapture?.(event.pointerId);
}

function updateCompareFromPointer(clientX) {
  const rect = els["twin-canvas"].getBoundingClientRect();
  setComparePercent(Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100));
}

function renderTimeline() {
  const available = availableStage(state.events);
  const stages = timelineStages();
  const visible = stages.slice(0, available + 1);
  els["stage-track"].style.setProperty("--stage-count", String(visible.length));
  els["stage-track"].innerHTML = visible.map((stage, index) => {
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
  els["timeline-copy"].textContent = timelineCopy(mode === "compare" ? 6 : cursor);
  els["compare-control"].hidden = mode !== "compare";
  els["timeline-current"].hidden = mode === "compare";
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
  const visible = state.waiting_for_approval && (mode === "live" || (mode === "replay" && cursor >= 5));
  const activeIncident = state.mode === "development" && activeIncidentState(state.events);
  els["approval-banner"].hidden = !visible;
  els["incident-strip"].hidden = visible || mode !== "live" || !activeIncident;
  els["approval-copy"].textContent = state.mode === "development" ? "Restore the known-good flag and recreate only the local checkout container." : "Rollback is bounded to checkout:2.18.0.";
  els["manager-open-button"].textContent = "Recover";
}

function renderManager() {
  els["manager-panel"].hidden = !managerOpen;
  if (!managerOpen || !state) return;
  const control = agentControl();
  const report = control.report;
  const action = control.actions[0];
  els["manager-title"].textContent = report.title;
  els["manager-subtitle"].textContent = `${report.data_mode === "real_local_runtime" ? "Real local runtime" : "Captured deterministic replay"} · ${control.authority}`;
  els["manager-status"].textContent = managerReply || report.summary;
  els["manager-report"].innerHTML = `<section class="manager-finding">
    <div><span>Current stage</span><strong>${escapeHtml(report.stage)}</strong></div>
    <div><span>Decision</span><strong>${report.human_gate ? "Owner required" : report.verification ? "Verified" : "Agent team active"}</strong></div>
    ${report.confidence == null ? "" : `<div><span>Evaluator score</span><strong>${Math.round(report.confidence * 100)}%</strong></div>`}
  </section>
  ${report.rejected_diagnosis ? `<section class="manager-callout is-rejected"><span>Rejected diagnosis</span><strong>${escapeHtml(report.rejected_diagnosis.hypothesis_id)}</strong><p>${escapeHtml(report.rejected_diagnosis.reason)}</p></section>` : ""}
  ${report.root_cause ? `<section class="manager-callout"><span>Confirmed root cause</span><p>${escapeHtml(report.root_cause)}</p></section>` : ""}
  ${report.repair ? `<section class="manager-callout is-recovery"><span>Bounded recovery</span><strong>${escapeHtml(report.repair.action)}</strong><p>${escapeHtml(report.repair.target)} only · ${escapeHtml(report.repair.from)} to ${escapeHtml(report.repair.to)}</p><p>${escapeHtml(report.repair.expected_effect)}</p></section>` : ""}
  <section class="manager-citations"><span>Immutable evidence</span><div>${report.citations.length ? report.citations.map((id) => `<code>${escapeHtml(id)}</code>`).join("") : "<small>No causal evidence cited yet.</small>"}</div></section>`;
  els["manager-activity-count"].textContent = `${control.activity.length} event${control.activity.length === 1 ? "" : "s"}`;
  els["manager-activity"].innerHTML = control.activity.slice(-8).reverse().map((item) => `<button type="button" data-manager-activity-id="${escapeHtml(item.id)}"><span class="agent-activity-icon is-${agentNodeTone(control.graph.nodes.find((node) => node.id === item.agent_id)?.status || "standby")}"><i class="ph ph-${agentIcon(item.agent_id)}" aria-hidden="true"></i></span><span><strong>${escapeHtml(control.graph.nodes.find((node) => node.id === item.agent_id)?.label || item.actor)}</strong><small>${escapeHtml(item.summary)}</small></span><time>${escapeHtml(String(item.sequence))}</time></button>`).join("") || `<div class="manager-empty">No specialist activity recorded yet.</div>`;
  els["manager-primary-action"].textContent = action?.label || "Review status";
  els["manager-primary-action"].dataset.action = action?.id || "review_learning";
  els["manager-primary-action"].disabled = busy || action?.id === "review_recovery";
  els["approve-button"].hidden = !report.human_gate;
  els["approve-button"].textContent = state.mode === "development" ? "Approve local checkout recovery" : "Approve bounded checkout recovery";
  els["approve-button"].disabled = busy;
}

function openManager() {
  managerOpen = true;
  selected = null;
  renderDrawer();
  renderManager();
  requestAnimationFrame(() => els["manager-close"].focus());
}

function closeManager() {
  managerOpen = false;
  renderManager();
  els["manager-button"].focus();
}

function handleManagerActivity(event) {
  const button = event.target.closest("[data-manager-activity-id]");
  if (!button) return;
  const activity = agentControl().activity.find((item) => item.id === button.dataset.managerActivityId);
  if (activity) openDrawer({ type: "node", id: activity.agent_id }, "agent");
}

async function runManagerPrimaryAction() {
  const action = els["manager-primary-action"].dataset.action;
  if (action === "review_learning") {
    closeManager();
    setMode("agents");
    return;
  }
  if (action === "review_recovery") return;
  setBusy(true);
  try {
    await request("/api/agent-control/action", { method: "POST", body: JSON.stringify({ action }) });
    state = await request("/api/state");
    cursor = availableStage(state.events);
    managerReply = action === "advance" ? "The Manager delegated the next safe step. The ledger projection has been updated." : "Verification monitoring is active.";
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
    if (mode === "agents") render();
  }
}

async function sendManagerMessage(event) {
  event.preventDefault();
  const message = els["manager-input"].value.trim();
  if (!message) return;
  setBusy(true);
  try {
    const result = await request("/api/agent-control/message", { method: "POST", body: JSON.stringify({ message }) });
    managerReply = result.message;
    els["manager-input"].value = "";
    state = await request("/api/state");
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
    if (mode === "agents") render();
  }
}

async function handleRecoveryConsoleAction(event) {
  const collaborator = event.target.closest("[data-collaborator-id]");
  if (collaborator && mode === "agents") {
    selectedCollaboratorId = collaborator.dataset.collaboratorId;
    renderAgentCanvas();
    requestAnimationFrame(() => els["canvas-layers"].querySelector(`[data-collaborator-id="${CSS.escape(selectedCollaboratorId)}"]`)?.focus());
    return;
  }
  const prompt = event.target.closest("[data-recovery-prompt]");
  if (prompt && mode === "agents") {
    const input = els["canvas-layers"].querySelector("#recovery-command-input");
    recoveryDrafts.set(selectedCollaboratorId, prompt.dataset.recoveryPrompt);
    input.value = prompt.dataset.recoveryPrompt;
    input.focus();
    return;
  }
  const inspect = event.target.closest("[data-collaborator-inspect]");
  if (inspect && mode === "agents") {
    openDrawer({ type: "node", id: inspect.dataset.collaboratorInspect }, "agent");
    return;
  }
  const commandButton = event.target.closest("[data-recovery-command-send]");
  if (commandButton) {
    event.preventDefault();
    event.stopPropagation();
    await sendRecoveryCommand(commandButton.closest("form"));
    return;
  }
  const workItem = event.target.closest("[data-recovery-work-item]");
  if (workItem) {
    openDrawer({ type: "run", id: state.run_id }, "agent");
    return;
  }
  const button = event.target.closest("[data-recovery-action]");
  if (!button || mode !== "agents") return;
  event.stopPropagation();
  const action = button.dataset.recoveryAction;
  if (action === "review_recovery") {
    managerReply = "Review the bounded checkout scope and immutable citations before using the separate owner approval control.";
    openManager();
    return;
  }
  if (action === "review_learning") {
    openDrawer({ type: "run", id: state.run_id }, "evolve");
    return;
  }
  setBusy(true);
  try {
    await request("/api/agent-control/action", { method: "POST", body: JSON.stringify({ action }) });
    state = await request("/api/state");
    cursor = availableStage(state.events);
    managerReply = recoveryActionReply(action);
    showToast(managerReply);
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
    if (mode === "agents") render();
  }
}

async function sendRecoveryCommand(form) {
  const input = form.elements.message;
  const message = input.value.trim();
  if (!message) return;
  const collaboratorId = selectedCollaboratorId;
  setBusy(true);
  try {
    const result = await request("/api/agent-control/message", { method: "POST", body: JSON.stringify({ message, collaborator_id: collaboratorId }) });
    managerReply = result.message;
    recoveryDrafts.delete(result.collaborator_id || collaboratorId);
    selectedCollaboratorId = result.collaborator_id || collaboratorId;
    state = await request("/api/state");
    cursor = availableStage(state.events);
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
    if (mode === "agents") render();
  }
}

function renderDrawer() {
  if (!selected || !state) {
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

function drawerTabsForSelection(focus) {
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
  if (context.architecture ? context.node.signal_types.length : context.evidence.length) tabs.push(["signals", "Signals"]);
  if (context.incoming.length || context.outgoing.length) tabs.push(["dependencies", "Dependencies"]);
  if (context.architecture ? context.node.provenance_refs.length : context.evidence.length) tabs.push(["evidence", "Evidence"]);
  return tabs;
}

function selectionMeta(focus) {
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
  return { kind: "Incident run", title: state.incident.title, subtitle: `${state.events.length} immutable events in ${state.run_id}` };
}

function drawerTone(focus) {
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
  if (tab === "overview") return renderSourceComponentContext(context);
  if (tab === "signals") return renderSourceSignalSummary(context);
  if (tab === "dependencies") return renderSourceDependencies(context);
  if (tab === "evidence") return context.evidence.length
    ? [...context.evidence].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 6).map(renderEvidenceRecord).join("")
    : emptyDetail("No component-scoped evidence is available in the current authoritative window.");
  return emptyDetail("No detail is available for this component.");
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
  const node = event.target.closest("[data-node-id]");
  const edge = event.target.closest("[data-edge-id]");
  const agentEdge = event.target.closest("[data-agent-edge-id]");
  if (node) openDrawer({ type: "node", id: node.dataset.nodeId }, defaultTabForNode(node.dataset.nodeId));
  else if (edge) openDrawer({ type: "edge", id: edge.dataset.edgeId }, "evidence");
  else if (agentEdge) openDrawer({ type: "agent-edge", id: agentEdge.dataset.agentEdgeId }, "agent");
}

function handleCanvasKeydown(event) {
  if (event.target.matches("[data-collaborator-id]") && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
    const nodes = [...els["canvas-layers"].querySelectorAll("[data-collaborator-id]")];
    const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
    nodes[(nodes.indexOf(event.target) + direction + nodes.length) % nodes.length]?.focus();
    event.preventDefault();
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
  const target = event.target.closest("[data-focus-entity]");
  if (target) openDrawer({ type: "node", id: target.dataset.focusEntity }, "overview");
}

function openDrawer(focus, tab = "evidence") {
  managerOpen = false;
  selected = focus;
  activeTab = tab;
  renderDrawer();
}

function closeDrawer() {
  selected = null;
  renderDrawer();
  els["details-button"].focus();
}

function setMode(nextMode) {
  stopPlayback();
  if (!state) return;
  mode = nextMode;
  if (mode === "live" || mode === "agents") cursor = availableStage(state.events);
  if (mode === "compare") closeDrawerWithoutFocus();
  render();
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
  if (!liveView.initialized || renderedMode !== "live") resetLiveView();
  else applyLiveView();
}

function setLiveZoom(nextScale) {
  if (mode !== "live") return;
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
  const inset = 24;
  const scale = Math.max(LIVE_WORLD.minScale, Math.min(1, (rect.width - inset * 2) / LIVE_WORLD.width, (rect.height - inset * 2) / LIVE_WORLD.height));
  return {
    scale,
    x: (rect.width - LIVE_WORLD.width * scale) / 2,
    y: (rect.height - LIVE_WORLD.height * scale) / 2,
    initialized: true
  };
}

function applyLiveView() {
  if (mode !== "live") return;
  els["canvas-layers"].style.transform = `translate(${Math.round(liveView.x)}px, ${Math.round(liveView.y)}px) scale(${liveView.scale})`;
  updateZoomControls();
}

function updateZoomControls() {
  if (!els["zoom-level"]) return;
  const fitted = containedLiveView();
  els["zoom-level"].textContent = `${Math.round(liveView.scale * 100)}%`;
  els["zoom-out"].disabled = mode !== "live" || liveView.scale <= LIVE_WORLD.minScale;
  els["zoom-in"].disabled = mode !== "live" || liveView.scale >= LIVE_WORLD.maxScale;
  els["zoom-reset"].disabled = mode !== "live" || (Math.abs(liveView.scale - fitted.scale) < .001 && Math.abs(liveView.x - fitted.x) < 1 && Math.abs(liveView.y - fitted.y) < 1);
}

function startLivePan(event) {
  if (mode !== "live" || event.button !== 0 || event.target.closest(".twin-node, .edge-hit, button, input, summary")) return;
  livePan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: liveView.x, y: liveView.y };
  els["twin-canvas"].classList.add("is-panning");
  els["twin-canvas"].setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveLivePan(event) {
  if (!livePan || event.pointerId !== livePan.pointerId) return;
  liveView = { ...liveView, x: livePan.x + event.clientX - livePan.startX, y: livePan.y + event.clientY - livePan.startY, initialized: true };
  applyLiveView();
}

function endLivePan(event) {
  if (!livePan || event.pointerId !== livePan.pointerId) return;
  livePan = null;
  els["twin-canvas"].classList.remove("is-panning");
  els["twin-canvas"].releasePointerCapture?.(event.pointerId);
}

async function togglePlayback() {
  if (playing) {
    stopPlayback();
    render();
    return;
  }
  if (mode !== "replay") mode = "replay";
  await playReplay();
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
  if (mode !== "replay") mode = "replay";
  const available = availableStage(state.events);
  cursor = Math.max(0, Math.min(available, Number(index) || 0));
  stopPlayback();
  render();
}

async function restartReplay() {
  stopPlayback();
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

async function approveRepair() {
  setBusy(true);
  try {
    const path = state.mode === "development" ? "/api/development/approve" : "/api/approve";
    state = await request(path, { method: "POST", body: JSON.stringify({ owner: state.mode === "development" ? "Local development owner" : "Commerce incident owner" }) });
    cursor = availableStage(state.events);
    mode = "agents";
    managerReply = "Owner approval matched the bounded proposal. The repair executor is now the only component allowed to mutate the checkout target.";
    showToast(state.mode === "development" ? "Local checkout rollback executed after owner approval." : "Checkout-only rollback approved and recorded.");
    render();
  } catch (error) {
    showToast(error.message, true);
    return;
  } finally {
    setBusy(false);
  }
  if (state.mode !== "development") await playReplay();
  else monitorDevelopmentVerification();
}

async function monitorDevelopmentVerification() {
  managerReply = "The verification agent is waiting for fresh post-repair OTLP evidence.";
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(1_500);
    try {
      state = await request("/api/development/verify", { method: "POST", body: "{}" });
      cursor = availableStage(state.events);
      managerReply = "Fresh post-repair OTLP passed verification. Evolve and Test recorded the regression gates.";
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
  managerReply = "Fresh verification telemetry did not arrive inside the local observation window. No further mutation was attempted.";
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
    try { state = await request("/api/state"); } catch { /* keep the last visible projection */ }
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

function updateControls() {
  const replay = mode === "replay";
  els["restart-button"].disabled = busy || playing || !replay;
  els["back-button"].disabled = busy || playing || !replay || cursor === 0;
  els["forward-button"].disabled = busy || playing || !replay || state?.waiting_for_approval || state?.complete;
  els["play-button"].disabled = busy || !replay || (state?.complete && cursor >= availableStage(state.events));
  els["play-button"].textContent = playing ? "Pause replay" : state?.waiting_for_approval ? "Paused at owner gate" : state?.complete && cursor >= availableStage(state.events) ? "Replay complete" : "Run guided replay";
  els["live-button"].disabled = busy || playing;
  els["details-button"].disabled = busy;
  els["approve-button"].disabled = busy;
  els["manager-primary-action"].disabled = busy || els["manager-primary-action"].dataset.action === "review_recovery";
  els["manager-send"].disabled = busy;
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
  if (mode === "architecture") return architectureView() ? "Backend-owned architecture projection" : "Architecture projection unavailable";
  if (mode === "live") return sourceState().status === "live" ? "Fresh authoritative telemetry" : "Source truth preserved";
  if (mode === "agents") return `${agentControl().current_agent_id.replaceAll("_", " ")} · ledger synchronized`;
  if (mode === "compare") return compareProvenance(state.events).status;
  if (state.waiting_for_approval && cursor >= 5) return "Paused at human gate";
  if (state.complete && cursor >= 7) return "Verified and recorded";
  return "Deterministic reconstruction";
}

function modeCaption(frame) {
  if (mode === "architecture") {
    const view = architectureView();
    return view
      ? `${view.truth.label} · ${view.runtime_data.node_count} runtime/data + ${view.control_evidence.node_count} FlowPulse components`
      : "Backend architecture projection unavailable";
  }
  if (mode === "live") {
    const source = sourceState();
    return source.status === "live"
      ? `Last record ${formatAge(source.freshness_ms)} · ${source.evidence.length} hashed signals`
      : source.label;
  }
  if (mode === "agents") {
    const control = agentControl();
    return `${agentLabel(control.current_agent_id)} · ledger ${control.last_sequence}`;
  }
  if (mode === "compare") return compareProvenance(state.events).caption;
  if (state.mode === "development") return `${timelineStages()[cursor].time} · hashed OTLP · ${eventsAtStage(state.events, cursor).length} events`;
  return `${frame.stage.time} · ${eventsAtStage(state.events, cursor).length} immutable events`;
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
  if (tab === "incidents") openDrawer({ type: "run", id: state?.run_id }, "agent");
  if (tab === "changes") openDrawer({ type: "run", id: state?.run_id }, "changes");
  if (tab === "evaluations") openDrawer({ type: "run", id: state?.run_id }, "eval");
}

function sourceState() {
  return state?.source || { status: "disconnected", label: "Disconnected", topology: { nodes: [], edges: [] }, evidence: [], counts: {}, freshness_ms: null };
}

function sourceComponentContext(id) {
  if (!["architecture", "live"].includes(mode)) return null;
  if (mode === "architecture") return architectureComponentContext(id);
  const source = sourceState();
  const topology = topologyIntegrity(source.topology);
  const node = topology.nodes.find((item) => item.id === id);
  if (!node) return null;
  const incoming = topology.edges.filter((edge) => edge.to === id).map((edge) => topology.nodes.find((item) => item.id === edge.from)).filter(Boolean);
  const outgoing = topology.edges.filter((edge) => edge.from === id).map((edge) => topology.nodes.find((item) => item.id === edge.to)).filter(Boolean);
  const evidence = source.evidence.filter((item) => item.entity === id || item.value?.services?.includes(id));
  const nodeStates = liveIncidentNodeStates({ mode: state.mode, events: state.events, source });
  return { node, profile: sourceComponentProfile(node), incoming, outgoing, evidence, status: node.connectivity === "unlinked" ? "unlinked" : nodeStates[id] || "dormant", source };
}

function architectureComponentContext(id) {
  const view = architectureView();
  const topology = view?.graph;
  const node = topology?.nodes.find((item) => item.id === id);
  if (!node) return null;
  const incoming = topology.edges.filter((edge) => edge.to === id).map((edge) => topology.nodes.find((item) => item.id === edge.from)).filter(Boolean);
  const outgoing = topology.edges.filter((edge) => edge.from === id).map((edge) => topology.nodes.find((item) => item.id === edge.to)).filter(Boolean);
  return {
    architecture: true,
    node,
    profile: architectureComponentProfile(node),
    incoming,
    outgoing,
    evidence: [],
    status: node.status,
    source: architectureSource(view)
  };
}

function sourceComponentProfile(node) {
  const observed = sourceComponentCatalog().get(node.id) || {};
  const signals = [...new Set([...(node.signals || []), ...(observed.signals || [])])].sort();
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

function architectureComponentProfile(node) {
  return {
    capability: `${node.plane} / ${node.layer}`,
    runtimeIdentity: node.id,
    runtimeSummary: node.signal_types.join(" + "),
    language: "",
    signals: [...node.signal_types],
    attributes: {}
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
  const { node, profile, incoming, outgoing, evidence, status, source } = context;
  return `<section class="component-context is-${escapeHtml(status)}">
    <header><div><span>${escapeHtml(kindLabel(node.kind))}</span><strong>${escapeHtml(profile.capability)}</strong></div><span class="component-health">${escapeHtml(sourceStatusLabel(status, source.status))}</span></header>
    <dl><div><dt>Source</dt><dd>${escapeHtml(source.status === "live" ? "Live OTLP" : source.label)}</dd></div><div><dt>Runtime</dt><dd>${escapeHtml(profile.language || "Not declared")}</dd></div><div><dt>Cited</dt><dd>${evidence.length} record${evidence.length === 1 ? "" : "s"}</dd></div></dl>
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

function captureLabel() {
  if (mode === "architecture") return architectureView()?.truth.label || "Architecture unavailable";
  if (mode === "live") return sourceState().status === "live" ? "Live OTLP" : sourceState().status === "captured" ? "Captured replay" : "Last-known OTLP";
  if (mode === "agents") return agentControl().langfuse === "observing" ? "Agent traces live" : "Ledger agent view";
  if (mode === "compare") return compareProvenance(state.events).label;
  return state.mode === "development" ? "Hashed incident" : "Captured incident";
}

function sourceOrigin(layout) {
  if (layout === "architecture") return architectureView()?.truth.label || "UNAVAILABLE";
  const source = sourceState();
  if (!source.topology?.nodes?.length) return "CAPTURED INCIDENT";
  if (source.status === "live") return "LIVE OTLP";
  if (state.mode === "development") return "HASHED OTLP";
  return layout === "live" ? "LAST-KNOWN OTLP" : "CAPTURED OTLP";
}

function transitionKey(id) {
  return id === "fraud" ? "fraud-detection" : id;
}

function captureCanvasNodePositions() {
  return new Map([...els["canvas-layers"].querySelectorAll(".twin-node[data-transition-key]")].map((node) => {
    const rect = node.getBoundingClientRect();
    return [node.dataset.transitionKey, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
  }));
}

function animateCanvasTransition(previousPositions) {
  if (!previousPositions.size || matchMedia("(prefers-reduced-motion: reduce)").matches || typeof Element.prototype.animate !== "function") return;
  requestAnimationFrame(() => {
    for (const node of els["canvas-layers"].querySelectorAll(".twin-node[data-transition-key]")) {
      const rect = node.getBoundingClientRect();
      const previous = previousPositions.get(node.dataset.transitionKey);
      if (!previous) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 150, easing: "ease-out" });
        continue;
      }
      const x = previous.x - (rect.left + rect.width / 2);
      const y = previous.y - (rect.top + rect.height / 2);
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      node.animate([
        { transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` },
        { transform: "translate(-50%, -50%)" }
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
  return known[node.id] || ({ client: "browser", api: "plugs-connected", stream: "queue", worker: "gear", change: "git-commit", agent: "robot", evaluator: "scales", ledger: "database", deployment: "git-commit", dataset: "database", topic: "queue", job: "gear", database: "database" })[displayClass] || "cube";
}

function statusLabel(status) {
  return ({ healthy: "Healthy", observed: "Observed", idle: "Idle", quiet: "Standby", dormant: "Not active", recording: "Recording", warning: "Change pending", change: "Deployment change", impact: "Impact", root: "Root cause", rejected: "Rejected", accepted: "Accepted", active: "Investigating", approval: "Approval required", verified: "Verified", learned: "Learning recorded" })[status] || status;
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
  return managerReply || report.summary;
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
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
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
      try {
        state = await request("/api/state");
        cursor = availableStage(state.events);
        render();
      } catch { /* the stream will retry without replacing the last valid projection */ }
    }, 80);
  });
  eventSource.onerror = () => {};
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]);
}

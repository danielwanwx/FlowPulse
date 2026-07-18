import {
  ARCHITECTURE_LAYERS,
  LIVE_LAYERS,
  LIVE_UNLINKED_LAYER,
  PULSE_SLOTS,
  TWIN_STAGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_EDGES,
  availableStage,
  architecturePositions,
  compareFrames,
  eventsAtStage,
  frameFor,
  liveEdgePath,
  liveIncidentNodeStates,
  livePulseSlots,
  livePositions,
  topologyIntegrity
} from "./twin-state.mjs";

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const DETAIL_TABS = [
  ["metrics", "Metrics"], ["logs", "Logs"], ["traces", "Traces"], ["changes", "Changes"],
  ["evidence", "Evidence"], ["agent", "Agent"], ["eval", "Eval"], ["repair", "Repair"],
  ["verify", "Verify"], ["evolve", "Evolve"]
];
const IMPACT_SEQUENCE = { checkout: 0, payment: 1, kafka: 2, accounting: 3, fraud: 4 };
const NODE_BY_ID = new Map(TWIN_NODES.map((node) => [node.id, node]));
const EDGE_BY_ID = new Map(TWIN_EDGES.map((edge) => [edge.id, edge]));
const LIVE_WORLD = Object.freeze({ width: 1480, height: 680, minScale: .6, maxScale: 1.6, step: .1 });

let state;
let developmentStatus;
let mode = "architecture";
let renderedMode = null;
let cursor = 0;
let playing = false;
let busy = false;
let comparePercent = 50;
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

for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
for (const button of document.querySelectorAll("[data-nav-tab]")) button.addEventListener("click", () => handleNavigation(button.dataset.navTab));
for (const button of document.querySelectorAll("[data-focus-entity]")) button.addEventListener("click", () => openDrawer({ type: "node", id: button.dataset.focusEntity }, "metrics"));
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
  els.stage.textContent = mode === "architecture" ? `${architectureTopology().nodes.length} observed services` : mode === "live" ? source.label : mode === "agents" ? agentControl().report.stage : mode === "compare" ? "Incident vs verified" : timelineStages()[cursor].label;
  els["status-text"].textContent = modeStatus();
  els["ledger-state"].textContent = `${state.events.length} immutable events`;
  els["capture-label"].textContent = captureLabel();
  els["capture-label"].className = `capture-label source-${source.status}`;
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
    const active = control.graph.nodes.filter((node) => ["running", "waiting", "rejected"].includes(node.status)).length;
    els["metric-checkout-label"].textContent = "Agent roles";
    els["metric-payment-label"].textContent = "Active";
    els["metric-kafka-label"].textContent = "Control events";
    setMetric("checkout", String(control.graph.nodes.length), "isolated roles and systems");
    setMetric("payment", String(active), control.current_agent_id.replaceAll("_", " "));
    setMetric("kafka", String(control.orchestration?.proposal_count || 0), control.langfuse === "observing" ? "harness + Langfuse" : "harness validated");
    return;
  }
  if (mode === "architecture" || mode === "live" || state.mode === "development") {
    const source = sourceState();
    const topology = topologyIntegrity(mode === "architecture" ? architectureTopology() : source.topology);
    els["metric-checkout-label"].textContent = "Services";
    els["metric-payment-label"].textContent = "Dependencies";
    els["metric-kafka-label"].textContent = "Source age";
    setMetric("checkout", String(topology?.nodes?.length || 0), "observed service.name");
    setMetric("payment", String(topology?.edges?.length || 0), mode === "architecture" ? "hidden in Architecture" : topology.unlinked_node_ids.length ? `${topology.unlinked_node_ids.length} evidence gap${topology.unlinked_node_ids.length === 1 ? "" : "s"}` : `${source.counts?.traces || 0} trace batches`);
    setMetric("kafka", source.freshness_ms == null ? "—" : formatAge(source.freshness_ms), source.status);
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
    els["canvas-layers"].innerHTML = `${renderTwinLayer(recovered, "after", true)}${renderTwinLayer(incident, "before", false)}`;
    els["compare-handle"].hidden = false;
    els["compare-canvas-range"].hidden = false;
    setAnnotations([]);
    els["twin-canvas"].setAttribute("aria-label", "Compare incident impact on the left with verified recovery on the right");
    renderComparePosition();
    return;
  }
  const frame = currentFrame();
  els["canvas-layers"].innerHTML = renderTwinLayer(frame, "current", true);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  setAnnotations(state.mode === "development" ? developmentAnnotations(cursor) : frame.annotations.slice(-2));
  els["twin-canvas"].setAttribute("aria-label", `Incident diagnosis at ${frame.stage.label}`);
}

function renderSourceCanvas(layout) {
  const source = sourceState();
  const topology = topologyIntegrity(layout === "architecture" ? architectureTopology() : source.topology);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  setAnnotations([]);
  if (!topology?.nodes?.length) {
    els["canvas-layers"].innerHTML = `<div class="source-empty">
      <i class="ph ph-plugs" aria-hidden="true"></i>
      <strong>${escapeHtml(source.label)}</strong>
      <span>${source.status === "disconnected" ? "No OTLP capture is registered. Connect the pinned local runtime or open Diagnose." : "The collector files exist but do not contain a complete OTLP record yet."}</span>
    </div>`;
    els["twin-canvas"].setAttribute("aria-label", `${source.label}. No observed service topology is available.`);
    return;
  }
  const positioned = layout === "architecture" ? architecturePositions(topology.nodes) : livePositions(topology.nodes);
  const nodeStates = layout === "live" ? liveIncidentNodeStates({ mode: state.mode, events: state.events, source }) : {};
  if (layout === "architecture") {
    const tiers = ARCHITECTURE_LAYERS.map((layer, layerIndex) => {
      const members = positioned.filter((node) => node.layerIndex === layerIndex);
      if (!members.length) return "";
      return `<section class="architecture-tier architecture-tier-${layerIndex}" aria-label="${escapeHtml(layer.label)}">
        <span class="architecture-tier-label" aria-hidden="true">${escapeHtml(layer.label)}</span>
        <div class="architecture-tier-row">${members.map((node) => sourceNodeMarkup(node, { layout, source, nodeStates })).join("")}</div>
      </section>`;
    }).join("");
    els["canvas-layers"].innerHTML = `<div class="twin-layer layer-current architecture-stack">${tiers}</div>`;
    els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
    els["twin-canvas"].dataset.unlinkedNodes = "0";
    els["twin-canvas"].setAttribute("aria-label", `Architecture block stack with ${positioned.length} observed services from ${sourceOrigin(layout)}. Dependency lines are intentionally hidden.`);
    return;
  }
  const positions = new Map(positioned.map((node) => [node.id, node]));
  const pulseSlots = livePulseSlots(topology);
  const edgeLayout = {
    canvasWidth: LIVE_WORLD.width,
    canvasHeight: LIVE_WORLD.height,
    nodeWidth: 144,
    nodeHeight: 64
  };
  const edges = topology.edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)).map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const lane = index % 2 ? Math.ceil(index / 2) : -Math.ceil((index + 1) / 2);
    const path = liveEdgePath(from, to, { ...edgeLayout, lane });
    const edgeState = liveSignalTone(edge, nodeStates);
    return `<g class="edge-group path-runtime signal-${edgeState}" data-live-edge-id="${escapeHtml(edge.id)}" data-signal-from="${escapeHtml(edge.from)}" data-signal-to="${escapeHtml(edge.to)}" data-signal-tone="${edgeState}" data-pulse-slot="${pulseSlots[edge.id] || 0}"><path class="edge-line is-${edgeState}" d="${path}"/><path class="pulse-flow is-${edgeState}" d="${path}" pathLength="1" aria-hidden="true"/><path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(from.label)} to ${escapeHtml(to.label)}" data-edge-id="${escapeHtml(edge.id)}" data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"/></g>`;
  }).join("");
  const nodes = positioned.map((node) => sourceNodeMarkup(node, { layout, source, nodeStates })).join("");
  const guideLayers = [...LIVE_LAYERS, ...(topology.unlinked_node_ids.length ? [LIVE_UNLINKED_LAYER] : [])];
  const guides = `<div class="live-guides" aria-hidden="true">${guideLayers.map((layer, index) => `<span class="live-guide-${index}">${escapeHtml(layer.label)}</span>`).join("")}</div>${topology.invalid_edges.length ? `<div class="topology-warning"><i class="ph ph-warning" aria-hidden="true"></i>${topology.invalid_edges.length} invalid dependency endpoint${topology.invalid_edges.length === 1 ? "" : "s"} omitted</div>` : ""}`;
  const change = layout === "live" ? renderLiveChange(positioned, edgeLayout) : { edge: "", node: "" };
  els["canvas-layers"].innerHTML = `${guides}<div class="twin-layer layer-current"><svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none">${edges}${change.edge}</svg>${nodes}${change.node}</div>`;
  startLiveSignalLoop();
  els["twin-canvas"].dataset.invalidEdges = String(topology.invalid_edges.length);
  els["twin-canvas"].dataset.unlinkedNodes = String(topology.unlinked_node_ids.length);
  setAnnotations(mode === "replay" ? developmentAnnotations(cursor) : []);
  els["twin-canvas"].setAttribute("aria-label", `Runtime topology with ${positioned.length} observed services, ${topology.edges.length} authoritative dependencies, and ${topology.unlinked_node_ids.length} components with insufficient dependency evidence from ${sourceOrigin(layout)}`);
}

function sourceNodeMarkup(node, { layout, source, nodeStates }) {
  const positionClass = layout === "architecture"
    ? `arch-layer-${node.layerIndex} arch-count-${node.layerSize} arch-index-${node.layerPosition}`
    : `live-column-${node.layerIndex} live-count-${node.layerSize} live-index-${node.layerPosition}`;
  const nodeState = node.connectivity === "unlinked" && layout === "live" ? "unlinked" : nodeStates[node.id] || "observed";
  const nodeStatus = nodeState === "impact" ? "Failure observed" : nodeState === "unlinked" ? "Evidence gap" : source.status === "live" ? "Observed" : "Last known";
  const ariaStatus = nodeState === "unlinked" ? "Insufficient dependency evidence" : nodeStatus;
  const origin = layout === "architecture" ? kindLabel(node.kind) : `RUNTIME · ${sourceOrigin(layout)}`;
  return `<button class="twin-node source-node plane-runtime kind-${escapeHtml(node.kind)} is-${nodeState} ${positionClass}" type="button" data-node-id="${escapeHtml(node.id)}" data-transition-key="${escapeHtml(transitionKey(node.id))}" aria-label="${escapeHtml(kindLabel(node.kind))} ${escapeHtml(node.label)}, ${escapeHtml(ariaStatus)}">
    <span class="node-icon" aria-hidden="true"><i class="ph ph-${iconForLive(node)}"></i></span>
    <span class="node-copy"><span class="node-origin">${escapeHtml(origin)}</span><strong>${escapeHtml(node.label)}</strong><span class="node-detail">${escapeHtml(node.detail || (nodeState === "unlinked" ? "dependency not observed" : "observed service.name"))}</span><span class="node-status">${escapeHtml(nodeStatus)}</span></span>
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
    node: `<button class="twin-node source-node live-change-node plane-control kind-change is-${status}" type="button" data-node-id="deployment" data-transition-key="deployment" aria-label="Deployment change, ${escapeHtml(label)}"><span class="node-icon" aria-hidden="true"><i class="ph ph-git-commit"></i></span><span class="node-copy"><span class="node-origin">LEDGER CHANGE</span><strong>Checkout recovery</strong><span class="node-detail">${escapeHtml(repair.payload.target || "checkout")}</span><span class="node-status">${escapeHtml(statusLabel(status))}</span></span><span class="node-status-dot" aria-hidden="true"></span></button>`
  };
}

function startLiveSignalLoop() {
  const groups = [...els["canvas-layers"].querySelectorAll("[data-live-edge-id]")]
    .sort((a, b) => Number(a.dataset.pulseSlot) - Number(b.dataset.pulseSlot) || a.dataset.liveEdgeId.localeCompare(b.dataset.liveEdgeId));
  if (!groups.length) return;
  const nodes = new Map([...els["canvas-layers"].querySelectorAll("[data-node-id]")].map((node) => [node.dataset.nodeId, node]));
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const activate = (group, persistent = false) => {
    clearLiveSignalClasses();
    const tone = group.dataset.signalTone || "observed";
    const from = nodes.get(group.dataset.signalFrom);
    const to = nodes.get(group.dataset.signalTo);
    group.classList.add("is-signal-active");
    from?.classList.add("is-signal-launch", `signal-${tone}`);
    if (persistent) {
      to?.classList.add("is-signal-arrival", `signal-${tone}`);
      return;
    }
    liveSignalTimers.push(setTimeout(() => {
      from?.classList.remove("is-signal-launch", `signal-${tone}`);
      to?.classList.add("is-signal-arrival", `signal-${tone}`);
    }, 310));
    liveSignalTimers.push(setTimeout(() => {
      group.classList.remove("is-signal-active");
      to?.classList.remove("is-signal-arrival", `signal-${tone}`);
    }, 760));
  };

  liveSignalIndex = Math.min(liveSignalIndex, groups.length - 1);
  activate(groups[liveSignalIndex], reduced);
  if (reduced) return;
  liveSignalTimers.push(setInterval(() => {
    liveSignalIndex = (liveSignalIndex + 1) % groups.length;
    activate(groups[liveSignalIndex]);
  }, 860));
}

function stopLiveSignalLoop() {
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
  const control = agentControl();
  const positions = new Map(control.graph.nodes.map((node) => [node.id, node]));
  const edgeLayout = {
    canvasWidth: 820,
    canvasHeight: 360,
    nodeWidth: 132,
    nodeHeight: 54
  };
  const edges = control.graph.edges.map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const path = liveEdgePath(from, to, { ...edgeLayout, lane: index % 5 - 2 });
    const pulse = ["active", "waiting", "rejected", "observing"].includes(edge.status)
      ? `<path class="pulse-flow is-${agentEdgeTone(edge.status)}" d="${path}" pathLength="1" aria-hidden="true"/>`
      : "";
    return `<g class="edge-group path-${edge.id.includes("langfuse") ? "evidence" : "control"}"><path class="edge-line is-${agentEdgeTone(edge.status)}" d="${path}"/>${pulse}<path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(from.label)} to ${escapeHtml(to.label)}" data-agent-edge-id="${escapeHtml(edge.id)}"/></g>`;
  }).join("");
  const nodes = control.graph.nodes.map((node) => `<button class="twin-node agent-operation-node agent-node-${escapeHtml(node.id)} kind-${agentNodeKind(node)} is-${agentNodeTone(node.status)}" type="button" data-node-id="${escapeHtml(node.id)}" data-agent-node-id="${escapeHtml(node.id)}" data-transition-key="agent-${escapeHtml(node.id)}" aria-label="${escapeHtml(node.label)}, ${escapeHtml(agentStatusLabel(node.status))}"><span class="node-icon" aria-hidden="true"><i class="ph ph-${agentIcon(node.id)}"></i></span><span class="node-copy"><span class="node-origin">${node.manifest ? escapeHtml(node.manifest.plane.toUpperCase()) : "CONTROL SYSTEM"}</span><strong>${escapeHtml(node.label)}</strong><span class="node-detail">${escapeHtml(node.detail)}</span><span class="node-status">${escapeHtml(agentStatusLabel(node.status))}</span></span><span class="node-status-dot" aria-hidden="true"></span></button>`).join("");
  const current = positions.get(control.current_agent_id);
  const report = control.report;
  const actionButtons = control.actions.map((action) => {
    const needsOwner = action.requires_owner === true;
    const externalDraft = ["pull_request", "work_item"].includes(action.kind);
    const note = needsOwner ? "Opens the separate human gate" : externalDraft ? "Ledger draft · connector not configured" : action.kind === "task" ? "Internal agent assignment" : "Ledger-governed control";
    return `<button class="recovery-action ${needsOwner ? "is-owner" : ""}" type="button" data-recovery-action="${escapeHtml(action.id)}" ${busy ? "disabled" : ""}><span><i class="ph ph-${recoveryActionIcon(action.id)}" aria-hidden="true"></i><strong>${escapeHtml(action.label)}</strong></span><small>${escapeHtml(note)}</small></button>`;
  }).join("");
  const workItems = (control.work_items || []).slice(-4).reverse().map((item) => `<button class="recovery-work-item" type="button" data-recovery-work-item="${escapeHtml(item.id)}"><span class="work-item-state is-${escapeHtml(workItemTone(item.status))}" aria-hidden="true"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(workItemStatus(item))}</small></span><code>${escapeHtml(String(item.sequence))}</code></button>`).join("") || `<p class="recovery-empty">No recovery work items have been recorded yet.</p>`;
  els["canvas-layers"].innerHTML = `<div class="recovery-console-layout">
    <section class="recovery-diagnosis" aria-label="Current diagnosis">
      <div class="diagnosis-state"><span>${report.human_gate ? "OWNER GATE" : report.verification ? "VERIFIED" : "DIAGNOSIS"}</span><strong>${escapeHtml(report.title)}</strong></div>
      <p>${escapeHtml(report.root_cause || report.summary)}</p>
      ${report.rejected_diagnosis ? `<div class="diagnosis-rejection"><span>Rejected ${escapeHtml(report.rejected_diagnosis.hypothesis_id)}</span><strong>${Math.round(report.rejected_diagnosis.score * 100)}%</strong></div>` : ""}
      <div class="diagnosis-score"><span>Evaluator</span><strong>${report.confidence == null ? "—" : `${Math.round(report.confidence * 100)}%`}</strong></div>
    </section>
    <section class="recovery-graph-panel" aria-label="Agent execution graph">
      <header><div><span>AGENT EXECUTION</span><strong>${escapeHtml(current?.label || "Manager")} · ${escapeHtml(agentStatusLabel(current?.status || "standby"))}</strong></div><small>Incident timeline synchronized</small></header>
      <div class="recovery-graph"><div class="agent-guides" aria-hidden="true"><span>Online incident team</span><span>Offline learning team</span></div><svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none">${edges}</svg>${nodes}</div>
    </section>
    <aside class="recovery-command" aria-label="Manager command and recovery actions">
      <header><span>MANAGER COMMAND</span><strong>Human-in-the-loop recovery</strong><small>${escapeHtml(managerReply || report.summary)}</small></header>
      <section class="recovery-work-queue"><div class="recovery-section-title"><strong>Work queue</strong><span>${control.work_items?.length || 0} recorded</span></div>${workItems}</section>
      <section class="recovery-actions"><div class="recovery-section-title"><strong>Available actions</strong><span>Ledger governed</span></div>${actionButtons}</section>
      <form class="recovery-command-form">
        <label for="recovery-command-input">Ask or assign the incident team</label>
        <div><input id="recovery-command-input" name="message" type="text" maxlength="2000" autocomplete="off" placeholder="Assign Diagnosis to verify the first failing trace"><button class="button approve" type="button" data-recovery-command-send ${busy ? "disabled" : ""}>Send</button></div>
        <small>Chat may assign safe work. Owner approval remains separate.</small>
      </form>
    </aside>
  </div>`;
  setAnnotations([]);
  els["compare-handle"].hidden = true;
  els["compare-canvas-range"].hidden = true;
  els["twin-canvas"].setAttribute("aria-label", `Recovery Console. ${control.report.title}. Current role ${current?.label || "Manager"}.`);
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
    return `<button class="twin-node plane-${node.plane} node-${node.id} sequence-${sequence} kind-${node.kind} is-${status}${entering}" type="button" data-transition-key="${escapeHtml(transitionKey(node.id))}" ${interaction}>
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
  els["stage-track"].innerHTML = stages.map((stage, index) => {
    const enabled = index <= available || (index === 1 && available >= 2);
    return `<button class="stage-marker stage-${stage.id} stage-group-${stageGroup(index)} ${enabled ? "is-available" : ""} ${index === cursor && mode !== "compare" ? "is-current" : ""}" type="button" data-stage-index="${index}" ${enabled ? "" : "disabled"}>
      <span>${stage.time}</span><strong>${escapeHtml(stage.label)}</strong>
    </button>`;
  }).join("");
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

function renderApproval() {
  const visible = state.waiting_for_approval && (mode === "live" || (mode === "replay" && cursor >= 5));
  els["approval-banner"].hidden = !visible;
  els["incident-strip"].hidden = visible || mode !== "live";
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
  const commandButton = event.target.closest("[data-recovery-command-send]");
  if (commandButton) {
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
  setBusy(true);
  try {
    const result = await request("/api/agent-control/message", { method: "POST", body: JSON.stringify({ message }) });
    managerReply = result.message;
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
  els["drawer-kind"].textContent = meta.kind;
  els["drawer-title"].textContent = meta.title;
  els["drawer-subtitle"].textContent = meta.subtitle;
  els["drawer-tabs"].innerHTML = DETAIL_TABS.map(([id, label]) => `<button class="drawer-tab" id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-selected="${activeTab === id}" aria-controls="drawer-content">${label}</button>`).join("");
  els["drawer-content"].innerHTML = drawerContent(activeTab);
}

function selectionMeta(focus) {
  if (focus.type === "node") {
    const node = NODE_BY_ID.get(focus.id) || topologyIntegrity(sourceState().topology).nodes.find((item) => item.id === focus.id) || agentControl().graph.nodes.find((item) => item.id === focus.id);
    return { kind: kindLabel(node?.kind || "component"), title: node?.label || focus.id, subtitle: node?.connectivity === "unlinked" ? "Insufficient dependency evidence in the authoritative OTLP window" : node?.detail || "System component" };
  }
  if (focus.type === "agent-edge") {
    const edge = agentControl().graph.edges.find((item) => item.id === focus.id);
    return { kind: "Agent handoff", title: edge?.label || focus.id, subtitle: `${agentLabel(edge?.from)} to ${agentLabel(edge?.to)}` };
  }
  if (focus.type === "edge") {
    const edge = EDGE_BY_ID.get(focus.id) || sourceState().topology?.edges?.find((item) => item.id === focus.id);
    return { kind: "Dependency path", title: edge?.label || focus.id, subtitle: `${labelFor(edge?.from)} to ${labelFor(edge?.to)}` };
  }
  if (focus.type === "annotation") return { kind: "Causal annotation", title: annotationTitle(focus.id), subtitle: TWIN_STAGES[cursor].label };
  if (focus.type === "stage") return { kind: "Replay stage", title: TWIN_STAGES[cursor].label, subtitle: `Captured incident time ${TWIN_STAGES[cursor].time}` };
  return { kind: "Incident run", title: state.incident.title, subtitle: `${state.events.length} immutable events in ${state.run_id}` };
}

function drawerContent(tab) {
  if (selected?.type === "node" && agentControl().graph.nodes.some((node) => node.id === selected.id)) return renderAgentOperationDetail(selected.id);
  if (selected?.type === "agent-edge") return renderAgentEdgeDetail(selected.id);
  const visibleEvents = projectedEvents();
  const visibleEvidence = projectedEvidence(visibleEvents);
  const focusedEvidence = filterBySelection(visibleEvidence);
  const focusedEvents = filterEventsBySelection(visibleEvents);
  if (["metrics", "logs", "traces", "changes", "evidence"].includes(tab)) {
    const kinds = { metrics: ["metric"], logs: ["log"], traces: ["trace"], changes: ["deploy", "commit"], evidence: null }[tab];
    const records = kinds ? focusedEvidence.filter((item) => kinds.includes(item.kind)) : focusedEvidence;
    return records.length ? records.map(renderEvidenceRecord).join("") : emptyDetail(`No ${tab} evidence is available at this replay position.`);
  }
  if (tab === "agent") {
    const records = focusedEvents.filter((event) => ["hypothesis.proposed", "plan.revised", "tool.called", "live.run.started", "live.run.completed", "live.run.failed"].includes(event.type));
    return records.length ? records.map(renderEventRecord).join("") : emptyDetail("Agent reasoning has not entered the ledger at this replay position.");
  }
  if (tab === "eval") {
    const records = focusedEvents.filter((event) => ["evaluation.rejected", "evaluation.accepted", "outcome.classified"].includes(event.type));
    return records.length ? records.map(renderEventRecord).join("") : emptyDetail("Adversarial evaluation has not entered the ledger at this replay position.");
  }
  if (tab === "repair") return renderRepairDetail(focusedEvents);
  if (tab === "verify") return renderVerificationDetail(focusedEvents);
  if (tab === "evolve") return renderEvolveDetail(focusedEvents);
  return emptyDetail("Select a detail category.");
}

function renderAgentOperationDetail(id) {
  const control = agentControl();
  const node = control.graph.nodes.find((item) => item.id === id);
  if (!node) return emptyDetail("Agent operation detail is unavailable.");
  const activity = control.activity.filter((item) => item.agent_id === id);
  const proposals = (control.orchestration?.proposals || []).filter((item) => item.agent_id === node.role);
  const manifest = node.manifest;
  return `<div class="detail-intro"><strong>${escapeHtml(agentStatusLabel(node.status))}</strong><span>${escapeHtml(node.detail)}. State is reconstructed from ledger sequence ${control.last_sequence}.</span></div>
    ${manifest ? `<article class="detail-record"><header><span>${escapeHtml(manifest.plane)}</span><span>${escapeHtml(manifest.mode)}</span></header><h3>Role boundary</h3><p>May emit: ${escapeHtml(manifest.emits.join(", "))}</p><div class="citation-list">${manifest.tools.map((tool) => `<span class="citation">${escapeHtml(tool)}</span>`).join("") || '<span class="citation">No direct tools</span>'}</div><pre class="payload">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></article>` : `<article class="detail-record"><h3>System-owned boundary</h3><p>This component is deterministic infrastructure, not an LLM role.</p></article>`}
    ${proposals.map((item) => `<article class="detail-record is-accepted"><header><span>Harness validated</span><span>sequence ${item.sequence}</span></header><h3>${escapeHtml(item.type)}</h3><p>${escapeHtml(item.model)} · ${escapeHtml(item.agent_version)}</p><div class="citation-list"><span class="citation">${escapeHtml(item.content_sha256.slice(0, 12))}</span>${item.evidence_refs.map((ref) => `<span class="citation">${escapeHtml(ref)}</span>`).join("")}</div><pre class="payload">${escapeHtml(JSON.stringify({ prompt_hash: item.prompt_hash, budget: item.budget, parent_event_ids: item.parent_event_ids }, null, 2))}</pre></article>`).join("")}
    ${activity.length ? activity.map((item) => `<article class="detail-record"><header><span>${escapeHtml(item.actor)}</span><span>sequence ${item.sequence}</span></header><h3>${escapeHtml(item.type)}</h3><p>${escapeHtml(item.summary)}</p>${item.evidence_refs.length ? `<div class="citation-list">${item.evidence_refs.map((ref) => `<span class="citation">${escapeHtml(ref)}</span>`).join("")}</div>` : ""}</article>`).join("") : emptyDetail("This role has not emitted an event in the current run.")}`;
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
    ${item.value ? `<pre class="payload">${escapeHtml(JSON.stringify(item.value, null, 2))}</pre>` : ""}
  </article>`;
}

function renderEventRecord(event) {
  const presentation = eventPresentation(event);
  return `<article class="detail-record is-${presentation.tone || "neutral"}">
    <header><span>${escapeHtml(event.actor)}</span><span>${formatOffset(event.offset_ms)}</span></header>
    <h3>${escapeHtml(presentation.title)}</h3>
    <p>${escapeHtml(presentation.copy)}</p>
    ${presentation.score ? `<div class="citation-list"><span class="citation">score ${presentation.score}</span></div>` : ""}
    ${event.evidence_refs.length ? `<div class="citation-list">${event.evidence_refs.map((id) => `<span class="citation">${escapeHtml(id)}</span>`).join("")}</div>` : ""}
    <pre class="payload">${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>
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
  return events.filter((event) => !event.evidence_refs.length || event.evidence_refs.some((id) => evidenceIds.has(id)));
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
  if (!event.target.matches("[data-edge-id], [data-agent-edge-id]")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (event.target.dataset.agentEdgeId) openDrawer({ type: "agent-edge", id: event.target.dataset.agentEdgeId }, "agent");
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
  if (nextMode === "compare" && state.mode === "development") {
    showToast("Compare is available for the verified complex replay. Restart Diagnose to open it.", true);
    return;
  }
  if (nextMode === "compare" && availableStage(state.events) < 6) {
    showToast("Complete recovery verification before opening Compare.", true);
    return;
  }
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
  liveView = {
    scale: 1,
    x: (rect.width - LIVE_WORLD.width) / 2,
    y: (rect.height - LIVE_WORLD.height) / 2,
    initialized: true
  };
  applyLiveView();
}

function applyLiveView() {
  if (mode !== "live") return;
  els["canvas-layers"].style.transform = `translate(${Math.round(liveView.x)}px, ${Math.round(liveView.y)}px) scale(${liveView.scale})`;
  updateZoomControls();
}

function updateZoomControls() {
  if (!els["zoom-level"]) return;
  els["zoom-level"].textContent = `${Math.round(liveView.scale * 100)}%`;
  els["zoom-out"].disabled = mode !== "live" || liveView.scale <= LIVE_WORLD.minScale;
  els["zoom-in"].disabled = mode !== "live" || liveView.scale >= LIVE_WORLD.maxScale;
  els["zoom-reset"].disabled = mode !== "live" || (liveView.scale === 1 && Math.abs(liveView.x - (els["twin-canvas"].clientWidth - LIVE_WORLD.width) / 2) < 1 && Math.abs(liveView.y - (els["twin-canvas"].clientHeight - LIVE_WORLD.height) / 2) < 1);
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
  if (mode === "architecture") return sourceState().status === "live" ? "Current source projection" : "Last-known source projection";
  if (mode === "live") return sourceState().status === "live" ? "Fresh authoritative telemetry" : "Source truth preserved";
  if (mode === "agents") return `${agentControl().current_agent_id.replaceAll("_", " ")} · ledger synchronized`;
  if (mode === "compare") return "Interactive state delta";
  if (state.waiting_for_approval && cursor >= 5) return "Paused at human gate";
  if (state.complete && cursor >= 7) return "Verified and recorded";
  return "Deterministic reconstruction";
}

function modeCaption(frame) {
  if (mode === "architecture") {
    const source = sourceState();
    return source.topology?.nodes?.length
      ? `${source.label} · ${architectureTopology().nodes.length} observed components arranged by system role.`
      : "Captured incident components arranged by system role; no external service has been invented.";
  }
  if (mode === "live") {
    const source = sourceState();
    return source.status === "live"
      ? `Real OTLP via Collector · last record ${formatAge(source.freshness_ms)} ago · ${source.evidence.length} hashed records in view.`
      : `${source.label}. This canvas does not synthesize services or telemetry.`;
  }
  if (mode === "agents") {
    const control = agentControl();
    return `${control.report.title}. ${control.langfuse === "observing" ? "Agent traces are mirrored to Langfuse." : "Langfuse is not configured; the ledger remains authoritative."}`;
  }
  if (mode === "compare") return "Drag the split to compare incident impact with verified recovery.";
  if (state.mode === "development") return `${timelineStages()[cursor].time} reconstruction from the hashed local OTLP capture and immutable ledger.`;
  return `${frame.stage.time} incident reconstruction from immutable ledger events.`;
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
  if (agentControl().graph.nodes.some((node) => node.id === id)) return "agent";
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
  return ({ client: "Client", service: "Service", api: "API", stream: "Stream", worker: "Worker", change: "Deployment change", agent: "Investigation agent", evaluator: "Adversarial evaluator", database: "Evidence database", component: "Agent operation" })[kind] || "Component";
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

function architectureTopology() {
  const topology = sourceState().topology;
  if (topology?.nodes?.length) return topology;
  const runtimeNodes = TWIN_NODES.filter((node) => node.plane === "runtime").map((node) => ({
    id: node.id,
    label: node.label,
    detail: node.detail,
    kind: node.kind
  }));
  const ids = new Set(runtimeNodes.map((node) => node.id));
  return {
    nodes: runtimeNodes,
    edges: TWIN_EDGES.filter((edge) => !edge.control && !edge.evidence && ids.has(edge.from) && ids.has(edge.to)).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label
    }))
  };
}

function captureLabel() {
  if (mode === "architecture") return sourceState().status === "live" ? "Live architecture" : "Captured architecture";
  if (mode === "live") return sourceState().status === "live" ? "Live OTLP" : "Last-known OTLP";
  if (mode === "agents") return agentControl().langfuse === "observing" ? "Agent traces live" : "Ledger agent view";
  if (mode === "compare") return "Verified comparison";
  return state.mode === "development" ? "Hashed incident" : "Captured incident";
}

function sourceOrigin(layout) {
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
  return known[node.id] || ({ client: "browser", api: "plugs-connected", stream: "queue", worker: "gear", database: "database" })[node.kind] || "cube";
}

function statusLabel(status) {
  return ({ healthy: "Healthy", observed: "Observed", quiet: "Standby", dormant: "Not active", recording: "Recording", warning: "Change pending", change: "Deployment change", impact: "Impact", root: "Root cause", rejected: "Rejected", active: "Investigating", approval: "Approval required", verified: "Verified", learned: "Learning recorded" })[status] || status;
}

function labelFor(id) { return NODE_BY_ID.get(id)?.label || id || "unknown"; }
function agentLabel(id) { return agentControl().graph.nodes.find((node) => node.id === id)?.label || id || "unknown"; }
function agentControl() { return state?.agent_control || { authority: "append-only-ledger", langfuse: "not_configured", current_agent_id: "manager", last_sequence: 0, report: { title: "Agent control unavailable", summary: "No agent projection is available.", stage: state?.stage || "Unknown", data_mode: "captured_deterministic_replay", citations: [] }, actions: [], work_items: [], graph: { nodes: [], edges: [] }, activity: [], orchestration: { mode: "unavailable", proposal_count: 0, proposals: [], last_step: null } }; }
function agentIcon(id) { return ({ manager: "chats-circle", monitor: "activity", evidence: "magnifying-glass", diagnosis: "brain", evaluator: "scales", planner: "clipboard-text", owner: "user-focus", executor: "wrench", verification: "shield-check", evolve: "git-branch", test: "flask", ledger: "database", langfuse: "waveform" })[id] || "robot"; }
function agentNodeKind(node) { return ({ ledger: "database", langfuse: "database", executor: "change", owner: "evaluator", evaluator: "evaluator" })[node.id] || "agent"; }
function agentNodeTone(status) { return ({ running: "active", waiting: "approval", rejected: "rejected", complete: "verified", recording: "recording", observing: "learned", unconfigured: "quiet", standby: "quiet" })[status] || "quiet"; }
function agentEdgeTone(status) { return ({ active: "active", waiting: "approval", rejected: "rejected", complete: "verified", observing: "learned", quiet: "quiet" })[status] || "quiet"; }
function agentStatusLabel(status) { return ({ running: "Running", waiting: "Waiting for owner", rejected: "Rejected and replanning", complete: "Completed", recording: "Recording", observing: "Observing", unconfigured: "Not configured", standby: "Standby" })[status] || status; }
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

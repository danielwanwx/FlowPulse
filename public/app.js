import {
  configuredIncidentProjectionClient,
  ProjectionUnavailableError,
  projectionPresentation
} from "./incident-projection-client.mjs";
import {
  projectionEdgeLayout,
  projectionTopologyLayout,
  replayPresentation
} from "./twin-state.mjs";

const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const client = configuredIncidentProjectionClient();
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
const STAGES = ["monitor", "agent_workbench", "decision_recovery"];
const SUBVIEWS = Object.freeze({
  monitor: ["architecture", "live", "replay", "evidence"],
  agent_workbench: ["loop", "evaluator", "replan"],
  decision_recovery: ["decision", "compare", "learning"]
});

let projection = null;
let presentation = null;
let viewStage = "monitor";
let subview = "architecture";
let cursor = 0;
let playing = false;
let playbackTimer = null;
let selected = null;
let drawerTab = "summary";
let zoom = 1;
let comparePercent = 50;

for (const button of document.querySelectorAll("[data-stage]")) button.addEventListener("click", () => selectStage(button.dataset.stage));
for (const metric of document.querySelectorAll("[data-focus]")) metric.addEventListener("click", () => openProjectionFocus(metric.dataset.focus));
els["theme-toggle"].addEventListener("click", toggleTheme);
els["retry-button"].addEventListener("click", refresh);
els["restart-button"].addEventListener("click", restartReplay);
els["back-button"].addEventListener("click", () => seek(cursor - 1));
els["forward-button"].addEventListener("click", () => seek(cursor + 1));
els["play-button"].addEventListener("click", togglePlayback);
els["timeline-range"].addEventListener("input", (event) => seek(Number(event.target.value)));
els["timeline-current"].addEventListener("click", () => openDrawer({ type: "frame", id: currentFrame()?.id }));
els["zoom-in"].addEventListener("click", () => setZoom(zoom + .1));
els["zoom-out"].addEventListener("click", () => setZoom(zoom - .1));
els["zoom-reset"].addEventListener("click", () => setZoom(1));
els["drawer-close"].addEventListener("click", closeDrawer);
els["compare-range"].addEventListener("input", (event) => setComparePercent(Number(event.target.value)));
els["compare-incident"].addEventListener("click", () => setComparePercent(70));
els["compare-even"].addEventListener("click", () => setComparePercent(50));
els["compare-verified"].addEventListener("click", () => setComparePercent(30));
els["subview-rail"].addEventListener("click", handleSubviewSelect);
els["twin-canvas"].addEventListener("click", handleCanvasClick);
els["twin-canvas"].addEventListener("keydown", handleCanvasKeydown);
els["drawer-tabs"].addEventListener("click", (event) => { const button = event.target.closest("[data-drawer-tab]"); if (button) { drawerTab = button.dataset.drawerTab; renderDrawer(); } });
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlayback(); });

await refresh();

async function refresh() {
  setLoading(true);
  hideError();
  try {
    projection = await client.load();
    presentation = projectionPresentation(projection);
    if (!STAGES.includes(viewStage)) viewStage = projection.stage.id;
    if (!SUBVIEWS[viewStage].includes(subview)) subview = SUBVIEWS[viewStage][0];
    cursor = Math.max(0, Math.min(cursor, Math.max(0, projection.timeline.frames.length - 1)));
  } catch (error) {
    projection = null;
    presentation = null;
    stopPlayback();
    showError(error instanceof ProjectionUnavailableError ? "Projection unavailable or non-actionable. FlowPulse will not substitute demo state." : "Projection unavailable. FlowPulse will not substitute demo state.");
  } finally {
    setLoading(false);
    render();
  }
}

function render() {
  renderHeader();
  renderTabs();
  renderMetrics();
  renderStagePanel();
  renderTopology();
  renderTimeline();
  renderDecisionPanel();
  renderDrawer();
  els["app-shell"].classList.remove("is-loading");
}

function renderHeader() {
  const value = projection;
  const axes = value ? [value.source_health, value.evidence_mode, value.execution_mode] : ["unavailable", "unavailable", "unavailable"];
  els.environment.textContent = value ? `${value.incident.id} · ${value.run_id}` : "bounded projection unavailable";
  els["source-badge"].className = `capture-label source-${axes[0]}`;
  els["source-badge"].textContent = `Source ${label(axes[0])}`;
  els["evidence-badge"].textContent = `Evidence ${label(axes[1])}`;
  els["execution-badge"].textContent = `Execution ${label(axes[2])}`;
  const dark = document.documentElement.dataset.theme === "dark";
  els["theme-toggle"].setAttribute("aria-pressed", String(dark));
  els["theme-toggle"].setAttribute("aria-label", dark ? "Switch to white theme" : "Switch to black theme");
  els["theme-toggle"].innerHTML = `<i class="ph ph-${dark ? "sun" : "moon"}" aria-hidden="true"></i><span class="visually-hidden">Toggle visual theme</span>`;
  els.stage.textContent = value ? value.stage.label : "Unavailable";
  els["status-text"].textContent = value ? `${label(value.stage_status)} · projection only` : "No valid browser projection";
  els["canvas-title"].textContent = value ? `${value.incident.title} reconstruction` : "Incident reconstruction unavailable";
  els["canvas-caption"].textContent = value ? `${value.graph.nodes.length} entities · ${value.graph.edges.length} evidence-backed relations · ${value.truncated ? "truncated" : "bounded"}` : "Server schema mismatch, stale source, or unavailable projection";
}

function renderTabs() {
  for (const button of document.querySelectorAll("[data-stage]")) {
    const active = button.dataset.stage === viewStage;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  els["workspace-panel"].setAttribute("aria-labelledby", `tab-${viewStage === "agent_workbench" ? "workbench" : viewStage === "decision_recovery" ? "decision" : "monitor"}`);
  els["app-shell"].dataset.stage = viewStage;
  els["app-shell"].dataset.subview = subview;
  const views = SUBVIEWS[viewStage] || [];
  els["subview-rail"].innerHTML = views.map((name) => `<button class="subview-button ${name === subview ? "is-active" : ""}" type="button" data-subview="${name}" aria-pressed="${String(name === subview)}">${escapeHtml(subviewLabel(name))}</button>`).join("");
}

function renderMetrics() {
  if (!projection) {
    setMetric("incident", "Unavailable", "no projection"); setMetric("evaluator", "Unavailable", "no evidence"); setMetric("owner", "Unavailable", "render-only"); return;
  }
  setMetric("incident", projection.incident.severity, projection.stage.label);
  setMetric("evaluator", label(projection.investigation.evaluator.verdict), `${projection.investigation.evaluator.evidence_refs.length} cited refs`);
  setMetric("owner", label(projection.human_gate.status), "server-derived only");
}

function setMetric(name, value, note) {
  els[`metric-${name}`].textContent = value;
  els[`metric-${name}-note`].textContent = note;
}

function renderStagePanel() {
  if (!projection) { els["stage-panel"].innerHTML = unavailableMarkup("No valid projection", "The browser cannot infer incident, gate, or recovery truth."); return; }
  if (viewStage === "agent_workbench") {
    const investigation = projection.investigation;
    els["stage-panel"].innerHTML = `<div class="stage-panel-heading"><span>Ledger-derived investigation</span><strong>${escapeHtml(label(projection.stage_status))}</strong></div>
      <ol class="loop-steps">
        ${loopStep("Snapshot", projection.timeline.frames.length > 0 ? "recorded" : "unavailable", "Projection timeline")}
        ${loopStep("Tools", projection.evidence.length ? "recorded" : "unavailable", `${projection.evidence.length} bounded evidence summaries`)}
        ${loopStep("Hypothesis", investigation.hypotheses.length ? "recorded" : "pending", `${investigation.hypotheses.length} projected candidates`)}
        ${loopStep("Evaluator", investigation.evaluator.verdict, refsText(investigation.evaluator.evidence_refs))}
        ${loopStep("Replan", investigation.replan.status, investigation.counter_evidence ? `Counter-evidence: ${refsText(investigation.counter_evidence.evidence_refs)}` : "No counter-evidence recorded")}
        ${loopStep("Diagnosis gate", investigation.diagnosis_gate.status, refsText(investigation.diagnosis_gate.evidence_refs))}
      </ol>
      <p>Evidence context: ${escapeHtml(investigation.counter_evidence ? `counter-evidence ${refsText(investigation.counter_evidence.evidence_refs)}` : "no counter-evidence recorded")}.</p>
      <p class="why-stopped">Why stopped: ${escapeHtml(projection.why_stopped.code || "No recorded stop condition")}</p>`;
  } else if (viewStage === "decision_recovery") {
    els["stage-panel"].innerHTML = `<div class="stage-panel-heading"><span>Server-derived recovery state</span><strong>${escapeHtml(label(projection.stage_status))}</strong></div>
      <dl class="decision-readout"><div><dt>Decision</dt><dd>${escapeHtml(label(projection.decision.status))}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(projection.decision.risk_tier || "Unavailable")}</dd></div><div><dt>Owner Gate</dt><dd>${escapeHtml(label(projection.human_gate.status))}</dd></div><div><dt>Action</dt><dd>${escapeHtml(label(projection.action.status))}</dd></div><div><dt>Verification</dt><dd>${escapeHtml(label(projection.verification.status))}</dd></div><div><dt>Learning</dt><dd>${escapeHtml(projection.learning.regression_id ? "recorded" : "not recorded")}</dd></div></dl>`;
  } else {
    const monitorCopy = {
      architecture: "Calm layer-oriented topology from bounded graph entities. Relations remain neutral until a cited replay frame activates them.",
      live: "Current source health and truth axes are projection-owned. The browser does not infer a live incident state.",
      replay: "Replay advances only the historical projection cursor. It cannot change incident, decision, approval, action, or verification truth.",
      evidence: "Safe evidence summaries are bounded and redacted. Select a node, edge, or timeline event for provenance."
    };
    els["stage-panel"].innerHTML = `<div class="stage-panel-heading"><span>Monitor · ${escapeHtml(subviewLabel(subview))}</span><strong>${escapeHtml(label(projection.stage_status))}</strong></div><p>${escapeHtml(monitorCopy[subview] || monitorCopy.architecture)}</p>`;
  }
}

function renderTopology() {
  const previous = captureNodeRects();
  const layers = els["canvas-layers"];
  if (!projection) { layers.innerHTML = ""; els["annotation-layer"].innerHTML = ""; return; }
  const graphMode = viewStage === "monitor" && subview === "architecture" ? "architecture" : "flow";
  const positioned = projectionTopologyLayout(projection.graph, { mode: graphMode });
  const edges = projectionEdgeLayout(projection.graph, positioned);
  const replay = replayPresentation(projection.timeline.frames, cursor);
  const nodeById = new Map(positioned.map((node) => [node.id, node]));
  layers.style.transform = `scale(${zoom})`;
  // `preserveAspectRatio="none"` keeps the deterministic percentage layout
  // and its evidence-backed SVG routes in the same coordinate system.
  layers.innerHTML = `${clusterMarkup(positioned, graphMode)}<svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none" role="group" aria-label="Evidence-backed causal relations"><defs><marker id="flow-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" class="edge-arrow"/></marker></defs>${edges.map((edge) => edgeMarkup(edge, replay)).join("")}</svg>${positioned.map((node) => nodeMarkup(node, replay)).join("")}`;
  // Keep selection local to the rendered projection geometry. These listeners
  // only open redacted detail and never mutate or derive incident authority.
  for (const node of layers.querySelectorAll("[data-node-id]")) node.addEventListener("click", () => openDrawer({ type: "node", id: node.dataset.nodeId }));
  for (const edge of layers.querySelectorAll("[data-edge-id]")) edge.addEventListener("click", () => openDrawer({ type: "edge", id: edge.dataset.edgeId }));
  els["annotation-layer"].innerHTML = annotationsMarkup(replay, nodeById);
  flipTopology(previous);
}

function edgeMarkup(edge, replay) {
  const route = compactEdgeRoute(edge);
  const path = route.path;
  const current = replay.current;
  const active = current && edgeTouchesFrame(edge, current);
  const tone = replayTone(current);
  const labelPoint = route.label;
  return `<g class="edge-group tone-${tone} ${active ? "is-replay-active" : ""}" data-edge-id="${escapeHtml(edge.id)}"><path class="edge-line" d="${path}" marker-end="url(#flow-arrow)"/><path class="pulse-flow packet-one" d="${path}"/><path class="pulse-flow packet-two" d="${path}"/><path class="pulse-flow packet-three" d="${path}"/><path class="edge-hit" data-edge-id="${escapeHtml(edge.id)}" d="${path}" tabindex="0" role="button" aria-label="Inspect relation ${escapeHtml(edge.from)} to ${escapeHtml(edge.to)}"/><g class="edge-label" transform="translate(${labelPoint.x} ${labelPoint.y})"><rect x="-31" y="-9" width="62" height="18" rx="7"/><text text-anchor="middle" y="3">${escapeHtml(edge.kind)}</text></g></g>`;
}

function compactEdgeRoute(edge) {
  const from = edge.fromNode;
  const to = edge.toNode;
  const fromCenter = { x: from.x * 10, y: from.y * 5.2 };
  const toCenter = { x: to.x * 10, y: to.y * 5.2 };
  const halfWidth = 75;
  const halfHeight = 32;
  const vertical = Math.abs(toCenter.y - fromCenter.y) > 38;
  if (!vertical) {
    const direction = Math.sign(toCenter.x - fromCenter.x) || 1;
    const start = { x: fromCenter.x + direction * halfWidth, y: fromCenter.y };
    const end = { x: toCenter.x - direction * halfWidth, y: toCenter.y };
    return { path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, label: { x: Math.round((start.x + end.x) / 2), y: Math.round(start.y - 14) } };
  }
  const direction = Math.sign(toCenter.y - fromCenter.y) || 1;
  const start = { x: fromCenter.x, y: fromCenter.y + direction * halfHeight };
  const end = { x: toCenter.x, y: toCenter.y - direction * halfHeight };
  // Short, deterministic elbows stay within the two related layers. This
  // avoids a shared outer corridor turning small relationships into U pipes.
  const laneOffset = ((edge.lane % 3) - 1) * 10;
  const midY = Math.round((start.y + end.y) / 2 + laneOffset);
  const radius = 7;
  const leftToRight = end.x >= start.x;
  const beforeFirst = { x: start.x, y: midY - direction * radius };
  const afterFirst = { x: start.x + (leftToRight ? radius : -radius), y: midY };
  const beforeSecond = { x: end.x - (leftToRight ? radius : -radius), y: midY };
  const afterSecond = { x: end.x, y: midY + direction * radius };
  return {
    path: `M ${start.x} ${start.y} L ${beforeFirst.x} ${beforeFirst.y} Q ${start.x} ${midY} ${afterFirst.x} ${afterFirst.y} L ${beforeSecond.x} ${beforeSecond.y} Q ${end.x} ${midY} ${afterSecond.x} ${afterSecond.y} L ${end.x} ${end.y}`,
    label: { x: Math.round((start.x + end.x) / 2), y: Math.round(midY - 12) }
  };
}

function nodeMarkup(node, replay) {
  const current = replay.current;
  const active = current && frameTouchesNode(node, current);
  const state = nodeVisualState(node, active);
  const kindClass = String(node.kind || "entity").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "entity";
  return `<button class="twin-node projection-node kind-${kindClass} is-${escapeHtml(state)} ${active ? "is-replay-active" : ""}" style="left:${node.x}%;top:${node.y}%" type="button" data-node-id="${escapeHtml(node.id)}" data-transition-key="${escapeHtml(node.id)}" aria-label="Inspect ${escapeHtml(node.label)}"><span class="node-status-dot" aria-hidden="true"></span><span class="node-icon"><i class="ph ph-${escapeHtml(node.glyph)}" aria-hidden="true"></i></span><span class="node-copy"><span class="node-origin">${escapeHtml(node.layer)}</span><strong>${escapeHtml(node.label)}</strong><span class="node-detail">${escapeHtml(node.kind)} · ${active ? "current replay signal" : "projection entity"}</span></span></button>`;
}

function nodeVisualState(node, active) {
  if (!projection) return "quiet";
  if (projection.stage_status === "verified") return "verified";
  if (active && replayTone(currentFrame()) === "fault") return "rejected";
  if (active && replayTone(currentFrame()) === "verified") return "verified";
  if (active) return "active";
  return node.layer === "evidence" ? "quiet" : "observed";
}

function clusterMarkup(positioned, mode) {
  const byLayer = new Map();
  for (const node of positioned) {
    const nodes = byLayer.get(node.layer) || [];
    nodes.push(node);
    byLayer.set(node.layer, nodes);
  }
  return [...byLayer.entries()].map(([layer, nodes]) => {
    const x = mode === "architecture" ? 3 : Math.max(2, Math.min(...nodes.map((node) => node.x - 8)));
    const y = mode === "architecture" ? Math.max(4, Math.min(...nodes.map((node) => node.y - 8))) : 8;
    const width = mode === "architecture" ? 94 : 16;
    const height = mode === "architecture" ? 15 : 84;
    return `<section class="graph-cluster graph-cluster-${escapeHtml(layer)} graph-cluster-${mode}" style="left:${x}%;top:${y}%;width:${width}%;height:${height}%"><span>${escapeHtml(clusterLabel(layer))}</span></section>`;
  }).join("");
}

function clusterLabel(layer) {
  return ({ upstream: "Runtime plane · entry", commerce: "Runtime plane · commerce", stream: "Runtime plane · stream and data", downstream: "Runtime plane · consumers", evidence: "FlowPulse control plane · evidence" })[layer] || "Projection group";
}

function replayTone(frame) {
  const type = String(frame?.type || "").toLowerCase();
  if (/verification\.completed|repair\.executed|recovery\.verified/.test(type)) return "verified";
  if (/rejected|failed|error|fault/.test(type)) return "fault";
  if (/deploy|change|decision|approval/.test(type)) return "change";
  return "flow";
}

function annotationsMarkup(replay, nodes) {
  if (!projection) return "";
  const notes = [];
  if (projection.investigation.evaluator.verdict === "rejected") notes.push({ tone: "rejected", title: "Unsupported Kafka hypothesis rejected", copy: "Evaluator counter-evidence is recorded in the projection." });
  if (projection.investigation.replan.status === "recorded") notes.push({ tone: "change", title: "Investigator replanned", copy: "A narrower evidence path is recorded." });
  if (projection.human_gate.status === "requested") notes.push({ tone: "gate", title: "Owner Gate pending", copy: "Decision controls remain disabled until D.1." });
  if (projection.verification.status === "passed") notes.push({ tone: "verified", title: "Recovery verification passed", copy: "A bounded verification record exists." });
  return notes.slice(0, 4).map((note, index) => `<button type="button" class="causal-note tone-${note.tone}" data-note-index="${index}" style="top:${24 + index * 54}px"><strong>${escapeHtml(note.title)}</strong><span>${escapeHtml(note.copy)}</span></button>`).join("");
}

function renderTimeline() {
  const frames = projection?.timeline.frames || [];
  cursor = Math.max(0, Math.min(cursor, Math.max(0, frames.length - 1)));
  const current = frames[cursor] || null;
  els["timeline-range"].max = String(Math.max(0, frames.length - 1));
  els["timeline-range"].value = String(cursor);
  els["timeline-range"].disabled = frames.length < 2;
  els["back-button"].disabled = !frames.length || cursor === 0;
  els["forward-button"].disabled = !frames.length || cursor >= frames.length - 1;
  els["restart-button"].disabled = !frames.length || cursor === 0;
  els["play-button"].disabled = frames.length < 2;
  els["play-button"].textContent = playing ? "Pause replay" : "Run guided replay";
  els["stage-track"].style.setProperty("--stage-count", String(Math.max(1, frames.length)));
  els["stage-track"].innerHTML = frames.map((frame, index) => `<button class="stage-marker ${index === cursor ? "is-current" : "is-available"}" data-frame-index="${index}" type="button"><span>${escapeHtml(formatTime(frame.at))}</span><strong>${escapeHtml(eventLabel(frame.type))}</strong></button>`).join("") || `<span class="timeline-next">No timeline frames available</span>`;
  for (const marker of els["stage-track"].querySelectorAll("button")) marker.addEventListener("click", () => seek(Number(marker.dataset.frameIndex)));
  els["timeline-time"].textContent = current ? formatTime(current.at) : "Unavailable";
  els["timeline-title"].textContent = current ? eventLabel(current.type) : "Unavailable";
  els["timeline-copy"].textContent = current ? `${current.actor} · ${current.evidence_refs.length} evidence refs` : "No valid projection is loaded";
  const compareVisible = Boolean(projection && viewStage === "decision_recovery");
  els["compare-control"].hidden = !compareVisible;
  if (compareVisible) setComparePercent(comparePercent, false);
}

function renderDecisionPanel() {
  const show = Boolean(projection && viewStage === "decision_recovery");
  els["decision-panel"].hidden = !show;
  els["compare-review-rail"].hidden = !show || subview !== "compare";
  if (!show) return;
  els["decision-panel"].innerHTML = `<div><span>Owner Gate</span><strong>${escapeHtml(label(projection.human_gate.status))}</strong></div><div><span>Decision ID</span><strong>${escapeHtml(projection.decision.decision_id || "Unavailable")}</strong></div><div><span>Contract</span><strong>${escapeHtml(projection.decision.contract_sha256 || "Unavailable")}</strong></div><div><span>Verification</span><strong>${escapeHtml(label(projection.verification.status))}</strong></div>`;
  if (subview === "compare") {
    const verified = projection.verification.status === "passed";
    els["compare-review-rail"].innerHTML = `<div class="compare-heading"><span>Before / after</span><strong>${verified ? "Incident versus verified recovery" : "Verified recovery unavailable"}</strong></div><div class="compare-split" style="--compare-percent:${comparePercent}%"><article><span>Incident</span><strong>${escapeHtml(label(projection.stage_status))}</strong><small>Historical cursor ${cursor + 1}/${projection.timeline.frames.length}</small></article><article><span>Recovery</span><strong>${escapeHtml(verified ? "passed" : "not recorded")}</strong><small>${escapeHtml(verified ? "Canonical verification projection" : "No claim is inferred")}</small></article></div>`;
  }
}

function handleCanvasClick(event) {
  const node = event.target.closest("[data-node-id]");
  const edge = event.target.closest("[data-edge-id]");
  if (node) openDrawer({ type: "node", id: node.dataset.nodeId });
  else if (edge) openDrawer({ type: "edge", id: edge.dataset.edgeId });
}

function handleCanvasKeydown(event) {
  if ((event.key === "Enter" || event.key === " ") && event.target.dataset.nodeId) { event.preventDefault(); openDrawer({ type: "node", id: event.target.dataset.nodeId }); }
  if ((event.key === "Enter" || event.key === " ") && event.target.dataset.edgeId) { event.preventDefault(); openDrawer({ type: "edge", id: event.target.dataset.edgeId }); }
}

function openProjectionFocus(focus) {
  if (!projection) return;
  if (focus === "evaluator") { viewStage = "agent_workbench"; subview = "evaluator"; }
  else if (focus === "owner") { viewStage = "decision_recovery"; subview = "decision"; }
  else { viewStage = "monitor"; subview = "architecture"; }
  render();
}

function openDrawer(next) { if (!projection) return; selected = next; drawerTab = "summary"; renderDrawer(); }
function closeDrawer() { selected = null; els["context-drawer"].hidden = true; }
function renderDrawer() {
  if (!projection || !selected) { els["context-drawer"].hidden = true; return; }
  const context = drawerContext(selected);
  els["context-drawer"].hidden = false;
  els["drawer-kind"].textContent = context.kind;
  els["drawer-title"].textContent = context.title;
  els["drawer-subtitle"].textContent = context.subtitle;
  const tabs = ["summary", "evidence", "facts", "causal", "lineage", "agent", "provenance"];
  els["drawer-tabs"].innerHTML = tabs.map((tab) => `<button class="drawer-tab" type="button" role="tab" aria-selected="${String(tab === drawerTab)}" data-drawer-tab="${tab}">${escapeHtml(label(tab))}</button>`).join("");
  els["drawer-content"].innerHTML = drawerContent(context, drawerTab);
}

function drawerContext(focus) {
  if (focus.type === "node") {
    const node = projection.graph.nodes.find((item) => item.id === focus.id);
    return node ? { kind: "Entity", title: node.label, subtitle: `${node.kind} · ${node.id}`, node } : { kind: "Unavailable", title: "Entity unavailable", subtitle: "The bounded projection no longer includes this entity." };
  }
  if (focus.type === "edge") {
    const edge = projection.graph.edges.find((item) => item.id === focus.id);
    return edge ? { kind: "Causal relation", title: `${edge.from} → ${edge.to}`, subtitle: `${edge.kind} · ${edge.id}`, edge } : { kind: "Unavailable", title: "Relation unavailable", subtitle: "The bounded projection no longer includes this relation." };
  }
  const frame = projection.timeline.frames.find((item) => item.id === focus.id);
  return frame ? { kind: "Timeline event", title: eventLabel(frame.type), subtitle: `${formatTime(frame.at)} · ${frame.actor}`, frame } : { kind: "Unavailable", title: "Timeline event unavailable", subtitle: "The selected event is outside this bounded page." };
}

function drawerContent(context, tab) {
  const relevantEvidence = context.node ? projection.evidence.filter((item) => item.entity === context.node.id) : context.frame ? projection.evidence.filter((item) => context.frame.evidence_refs.includes(item.id)) : projection.evidence;
  if (tab === "summary") return `<p>${escapeHtml(context.subtitle)}</p><p>All shown fields come from the bounded IncidentProjection v1. Missing values are intentionally unavailable.</p>`;
  if (tab === "evidence") return evidenceMarkup(relevantEvidence);
  if (tab === "facts") return `<p class="drawer-empty">Safe facts are limited to evidence kind, signal, entity, source, and provenance. Raw logs, prompts, payloads, and provider data are not exposed.</p>`;
  if (tab === "causal") return causalMarkup(context);
  if (tab === "lineage") return lineageMarkup(context);
  if (tab === "agent") return `<p>Evaluator: ${escapeHtml(label(projection.investigation.evaluator.verdict))}. Diagnosis gate: ${escapeHtml(label(projection.investigation.diagnosis_gate.status))}. Replan: ${escapeHtml(label(projection.investigation.replan.status))}.</p>`;
  return `<dl class="provenance-list"><div><dt>Projection revision</dt><dd>${escapeHtml(projection.projection_revision)}</dd></div><div><dt>Run</dt><dd>${escapeHtml(projection.run_id)}</dd></div><div><dt>Truth</dt><dd>${escapeHtml(`${projection.source_health} / ${projection.evidence_mode} / ${projection.execution_mode}`)}</dd></div></dl>`;
}

function evidenceMarkup(items) { return items.length ? `<ul class="evidence-list">${items.map((item) => `<li><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(`${item.kind} · ${item.signal} · ${item.entity}`)}</span><small>${escapeHtml(item.provenance_status)} · ${escapeHtml(item.record_sha256)}</small></li>`).join("")}</ul>` : `<p class="drawer-empty">No bounded evidence summary is available for this selection.</p>`; }
function causalMarkup(context) { const edges = context.node ? projection.graph.edges.filter((edge) => edge.from === context.node.id || edge.to === context.node.id) : context.edge ? [context.edge] : []; return edges.length ? `<ul class="evidence-list">${edges.map((edge) => `<li><strong>${escapeHtml(`${edge.from} → ${edge.to}`)}</strong><span>${escapeHtml(edge.kind)}</span></li>`).join("")}</ul>` : `<p class="drawer-empty">No causal relation is available in this bounded projection.</p>`; }
function lineageMarkup(context) { return `<p>${context.node ? `Entity ID: ${escapeHtml(context.node.id)}.` : "No entity lineage is available."} Provider identity is display metadata only and cannot change authority.</p>`; }

function selectStage(next) {
  if (!STAGES.includes(next)) return;
  viewStage = next;
  subview = SUBVIEWS[next][0];
  selected = null;
  render();
}

function handleSubviewSelect(event) {
  const button = event.target.closest("[data-subview]");
  if (!button || !SUBVIEWS[viewStage]?.includes(button.dataset.subview)) return;
  subview = button.dataset.subview;
  render();
}

function togglePlayback() { if (playing) stopPlayback(); else playReplay(); }
function playReplay() { if (!projection || projection.timeline.frames.length < 2) return; playing = true; tickPlayback(); renderTimeline(); }
function tickPlayback() {
  if (!playing || !projection) return;
  const length = projection.timeline.frames.length;
  if (cursor >= length - 1) cursor = 0;
  else cursor += 1;
  renderTopology(); renderTimeline(); renderDrawer();
  const multiplier = Number(els["speed-select"].value || 1);
  playbackTimer = setTimeout(tickPlayback, Math.round(960 / multiplier));
}
function stopPlayback() { playing = false; if (playbackTimer) clearTimeout(playbackTimer); playbackTimer = null; }
function restartReplay() { stopPlayback(); seek(0); }
function seek(next) { if (!projection) return; stopPlayback(); cursor = Math.max(0, Math.min(projection.timeline.frames.length - 1, Number(next) || 0)); renderTopology(); renderTimeline(); renderDrawer(); }

function setZoom(next) { zoom = Math.max(.6, Math.min(1.6, Math.round(next * 100) / 100)); els["zoom-level"].textContent = `${Math.round(zoom * 100)}%`; renderTopology(); }
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("flowpulse-theme", next); } catch { /* visual preference is optional */ }
  renderHeader();
}
function setComparePercent(next, rerender = true) { comparePercent = Math.max(0, Math.min(100, Number(next) || 50)); els["compare-range"].value = String(comparePercent); els["compare-value"].textContent = `${comparePercent}% incident`; if (rerender) renderDecisionPanel(); }
function currentFrame() { return projection?.timeline.frames[cursor] || null; }
function setLoading(value) { els["app-shell"].classList.toggle("is-loading", value); }
function showError(message) { els["error-message"].textContent = message; els["error-banner"].hidden = false; }
function hideError() { els["error-banner"].hidden = true; }
function unavailableMarkup(title, copy) { return `<div class="unavailable-state"><i class="ph ph-warning-circle" aria-hidden="true"></i><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span></div></div>`; }
function loopStep(name, status, copy) { return `<li data-status="${escapeHtml(status)}"><span>${escapeHtml(name)}</span><strong>${escapeHtml(label(status))}</strong><small>${escapeHtml(copy)}</small></li>`; }
function eventLabel(type) { return label(String(type || "unavailable").replaceAll(".", " ")); }
function subviewLabel(value) { return ({ architecture: "Architecture", live: "Live", replay: "Replay", evidence: "Evidence", loop: "Investigation loop", evaluator: "Evaluator", replan: "Replan", decision: "Decision", compare: "Compare", learning: "Learning" })[value] || label(value); }
function label(value) { return String(value || "unavailable").replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function refsText(refs) { return refs?.length ? `${refs.length} evidence refs` : "No bounded refs"; }
function formatTime(value) { const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toISOString().slice(11, 19) : "Unavailable"; }
function frameTouchesNode(node, frame) {
  if (!frame || !projection) return false;
  const evidenceEntities = new Set(frame.evidence_refs.map((id) => projection.evidence.find((item) => item.id === id)?.entity).filter(Boolean));
  const actor = String(frame.actor || "").toLowerCase();
  const type = String(frame.type || "").toLowerCase();
  return evidenceEntities.has(node.id) || actor === String(node.id).toLowerCase() || (/evaluat|diagnos/.test(type) && node.layer === "evidence");
}
function edgeTouchesFrame(edge, frame) { return frameTouchesNode(edge.fromNode, frame) || frameTouchesNode(edge.toNode, frame); }
function captureNodeRects() { return new Map([...document.querySelectorAll("[data-transition-key]")].map((node) => [node.dataset.transitionKey, node.getBoundingClientRect()])); }
function flipTopology(previous) {
  if (REDUCED_MOTION.matches) return;
  for (const node of document.querySelectorAll("[data-transition-key]")) {
    const prior = previous.get(node.dataset.transitionKey);
    if (!prior) { node.animate([{ opacity: .2, transform: "translate(-50%, -50%) scale(.98)" }, { opacity: 1, transform: "translate(-50%, -50%)" }], { duration: 160, easing: "ease-out" }); continue; }
    const current = node.getBoundingClientRect(); const dx = prior.left - current.left; const dy = prior.top - current.top;
    if (dx || dy) node.animate([{ transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))` }, { transform: "translate(-50%, -50%)" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

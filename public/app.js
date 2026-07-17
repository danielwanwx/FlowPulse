import {
  TWIN_STAGES,
  TWIN_NODES,
  TWIN_EDGES,
  availableStage,
  compareFrames,
  eventsAtStage,
  frameFor
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

let state;
let mode = "replay";
let cursor = 0;
let playing = false;
let busy = false;
let playToken = 0;
let comparePercent = 50;
let selected = null;
let activeTab = "evidence";
let toastTimer;

for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
for (const button of document.querySelectorAll("[data-focus-entity]")) button.addEventListener("click", () => openDrawer({ type: "node", id: button.dataset.focusEntity }, "metrics"));
els["retry-button"].addEventListener("click", refresh);
els["live-button"].addEventListener("click", runLive);
els["details-button"].addEventListener("click", () => openDrawer({ type: "run", id: state?.run_id }, "evidence"));
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
els["compare-incident"].addEventListener("click", () => setComparePercent(70));
els["compare-even"].addEventListener("click", () => setComparePercent(50));
els["compare-verified"].addEventListener("click", () => setComparePercent(30));
els["timeline-current"].addEventListener("click", () => openDrawer({ type: "stage", id: TWIN_STAGES[cursor].id }, tabForStage(cursor)));
els["canvas-layers"].addEventListener("click", handleCanvasSelection);
els["canvas-layers"].addEventListener("keydown", handleCanvasKeydown);
els["annotation-layer"].addEventListener("click", handleAnnotationSelection);
els["drawer-tabs"].addEventListener("click", handleDrawerTab);

await refresh();

async function refresh() {
  setLoading(true);
  try {
    state = await request("/api/state");
    cursor = availableStage(state.events);
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
  renderHeader();
  renderMetrics();
  renderCanvas();
  renderTimeline();
  renderApproval();
  renderDrawer();
  updateControls();
}

function renderHeader() {
  const frame = currentFrame();
  els["incident-title"].textContent = state.incident.title;
  els["incident-summary"].textContent = state.incident.summary;
  els.severity.textContent = state.incident.severity;
  els.environment.textContent = state.incident.environment;
  els.stage.textContent = mode === "compare" ? "Incident vs verified" : frame.stage.label;
  els["status-text"].textContent = modeStatus();
  els["ledger-state"].textContent = `${state.events.length} immutable events`;
  els["capture-label"].textContent = mode === "live" ? "Last-known captured state" : mode === "compare" ? "Verified comparison" : "Immutable replay";
  els["canvas-caption"].textContent = modeCaption(frame);
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

function renderMetrics() {
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
  if (mode === "compare") {
    const { incident, recovered } = compareFrames();
    els["canvas-layers"].innerHTML = `${renderTwinLayer(recovered, "after", true)}${renderTwinLayer(incident, "before", false)}`;
    els["compare-handle"].hidden = false;
    els["annotation-layer"].innerHTML = "";
    els["twin-canvas"].setAttribute("aria-label", "Compare incident impact on the left with verified recovery on the right");
    renderComparePosition();
    return;
  }
  const frame = currentFrame();
  els["canvas-layers"].innerHTML = renderTwinLayer(frame, "current", true);
  els["compare-handle"].hidden = true;
  els["annotation-layer"].innerHTML = frame.annotations.slice(-2).map(renderAnnotation).join("");
  els["twin-canvas"].setAttribute("aria-label", `${mode === "live" ? "Last-known captured" : "Replay"} system state at ${frame.stage.label}`);
}

function renderTwinLayer(frame, layerName, interactive) {
  const suffix = `${layerName}-${frame.index}`;
  const edges = TWIN_EDGES.map((edge) => {
    const status = frame.edgeStates[edge.id] || "quiet";
    const accessible = interactive ? `role="button" tabindex="0" aria-label="${escapeHtml(edge.label)} from ${escapeHtml(labelFor(edge.from))} to ${escapeHtml(labelFor(edge.to))}" data-edge-id="${edge.id}"` : "aria-hidden=\"true\"";
    return `<g class="edge-group edge-${edge.id}">
      <path class="edge-line is-${status}" d="${edge.path}" />
      <path class="pulse-flow is-${status}" d="${edge.path}" aria-hidden="true" />
      <path class="edge-hit" d="${edge.path}" ${accessible} />
    </g>`;
  }).join("");
  const nodes = TWIN_NODES.map((node) => {
    const status = frame.nodeStates[node.id] || "quiet";
    const sequence = IMPACT_SEQUENCE[node.id] ?? 0;
    const entering = frame.index === 2 && status === "impact" ? " is-entering" : "";
    const interaction = interactive ? `data-node-id="${node.id}" aria-label="${escapeHtml(kindLabel(node.kind))} ${escapeHtml(node.label)}, ${escapeHtml(statusLabel(status))}"` : "tabindex=\"-1\" aria-hidden=\"true\"";
    return `<button class="twin-node node-${node.id} sequence-${sequence} kind-${node.kind} is-${status}${entering}" type="button" ${interaction}>
      <strong>${escapeHtml(node.label)}</strong>
      <span class="node-detail">${escapeHtml(node.detail)}</span>
      <span class="node-status">${escapeHtml(statusLabel(status))}</span>
      <span class="state-ring" aria-hidden="true"></span>
    </button>`;
  }).join("");
  return `<div class="twin-layer layer-${layerName}" data-layer="${suffix}">
    <svg class="edge-map" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="${interactive ? "false" : "true"}">${edges}</svg>
    ${nodes}
  </div>`;
}

function renderAnnotation(annotation) {
  return `<button class="causal-note note-${annotation.id} tone-${annotation.tone}" type="button" data-annotation-id="${annotation.id}">
    <strong>${escapeHtml(annotation.title)}</strong><span>${escapeHtml(annotation.copy)}</span>
  </button>`;
}

function renderComparePosition() {
  if (mode !== "compare") return;
  comparePercent = Math.round(comparePercent / 10) * 10;
  for (const name of [...els["twin-canvas"].classList]) if (name.startsWith("compare-value-")) els["twin-canvas"].classList.remove(name);
  els["twin-canvas"].classList.add(`compare-value-${comparePercent}`);
  els["compare-value"].textContent = `${comparePercent}% incident`;
  els["compare-range"].value = String(comparePercent);
}

function setComparePercent(value) {
  comparePercent = value;
  renderComparePosition();
}

function renderTimeline() {
  const available = availableStage(state.events);
  els["stage-track"].innerHTML = TWIN_STAGES.map((stage, index) => {
    const enabled = index <= available || (index === 1 && available >= 2);
    return `<button class="stage-marker ${enabled ? "is-available" : ""} ${index === cursor && mode !== "compare" ? "is-current" : ""}" type="button" data-stage-index="${index}" ${enabled ? "" : "disabled"}>
      <span>${stage.time}</span><strong>${escapeHtml(stage.label)}</strong>
    </button>`;
  }).join("");
  for (const button of els["stage-track"].querySelectorAll("[data-stage-index]")) button.addEventListener("click", () => seek(Number(button.dataset.stageIndex)));
  els["timeline-range"].max = String(available);
  els["timeline-range"].value = String(Math.min(cursor, available));
  els["timeline-range"].disabled = mode !== "replay";
  els["timeline-time"].textContent = mode === "compare" ? "Before / after" : TWIN_STAGES[cursor].time;
  els["timeline-title"].textContent = mode === "compare" ? "Incident vs verified" : TWIN_STAGES[cursor].label;
  els["timeline-copy"].textContent = timelineCopy(mode === "compare" ? 6 : cursor);
  els["compare-control"].hidden = mode !== "compare";
  els["timeline-current"].hidden = mode === "compare";
}

function renderApproval() {
  const visible = state.waiting_for_approval && mode !== "compare" && (mode === "live" || cursor >= 5);
  els["approval-banner"].hidden = !visible;
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
    const node = NODE_BY_ID.get(focus.id);
    return { kind: kindLabel(node?.kind || "component"), title: node?.label || focus.id, subtitle: node?.detail || "System component" };
  }
  if (focus.type === "edge") {
    const edge = EDGE_BY_ID.get(focus.id);
    return { kind: "Dependency path", title: edge?.label || focus.id, subtitle: `${labelFor(edge?.from)} to ${labelFor(edge?.to)}` };
  }
  if (focus.type === "annotation") return { kind: "Causal annotation", title: annotationTitle(focus.id), subtitle: TWIN_STAGES[cursor].label };
  if (focus.type === "stage") return { kind: "Replay stage", title: TWIN_STAGES[cursor].label, subtitle: `Captured incident time ${TWIN_STAGES[cursor].time}` };
  return { kind: "Incident run", title: state.incident.title, subtitle: `${state.events.length} immutable events in ${state.run_id}` };
}

function drawerContent(tab) {
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
  const boundary = `<div class="detail-intro"><strong>Checkout-only rollback boundary</strong><span>${escapeHtml(state.repair.from)} to ${escapeHtml(state.repair.to)}. Abort if ${escapeHtml(state.repair.abort_if)}.</span></div>`;
  return boundary + (records.length ? records.map(renderEventRecord).join("") : emptyDetail("A bounded repair has not been proposed at this replay position."));
}

function renderVerificationDetail(events) {
  const verification = events.find((event) => event.type === "verification.completed");
  if (!verification) return emptyDetail("Verification waits for an approved and executed repair.");
  return `<div class="detail-intro"><strong>Recovery thresholds passed</strong><span>Verification uses captured post-repair evidence from the immutable incident bundle.</span></div>${verification.payload.checks.map((check) => `<div class="verification-grid">
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
  if (selected?.type === "node" && state.topology.services.some((service) => service.id === selected.id)) return new Set([selected.id]);
  if (selected?.type === "edge") {
    const edge = EDGE_BY_ID.get(selected.id);
    return new Set([edge?.from, edge?.to].filter((id) => state.topology.services.some((service) => service.id === id)));
  }
  return new Set();
}

function handleCanvasSelection(event) {
  const node = event.target.closest("[data-node-id]");
  const edge = event.target.closest("[data-edge-id]");
  if (node) openDrawer({ type: "node", id: node.dataset.nodeId }, defaultTabForNode(node.dataset.nodeId));
  else if (edge) openDrawer({ type: "edge", id: edge.dataset.edgeId }, "evidence");
}

function handleCanvasKeydown(event) {
  if (!event.target.matches("[data-edge-id]")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDrawer({ type: "edge", id: event.target.dataset.edgeId }, "evidence");
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
  if (nextMode === "compare" && availableStage(state.events) < 6) {
    showToast("Complete recovery verification before opening Compare.", true);
    return;
  }
  mode = nextMode;
  if (mode === "live") cursor = availableStage(state.events);
  if (mode === "compare") closeDrawerWithoutFocus();
  render();
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
  const token = ++playToken;
  render();
  try {
    while (playing && token === playToken) {
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
    if (token === playToken) playing = false;
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
    state = await request("/api/approve", { method: "POST", body: JSON.stringify({ owner: "Commerce incident owner" }) });
    showToast("Checkout-only rollback approved and recorded.");
    render();
  } catch (error) {
    showToast(error.message, true);
    return;
  } finally {
    setBusy(false);
  }
  await playReplay();
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
}

function stopPlayback() {
  playing = false;
  playToken += 1;
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
    case "verification.completed": return { title: "Recovery thresholds passed", copy: "Payment recovered, checkout errors fell, and Kafka lag drained without a Kafka repair.", tone: "verified" };
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
  if (mode === "live") return "Latest authoritative snapshot";
  if (mode === "compare") return "Interactive state delta";
  if (state.waiting_for_approval && cursor >= 5) return "Paused at human gate";
  if (state.complete && cursor >= 7) return "Verified and recorded";
  return "Deterministic reconstruction";
}

function modeCaption(frame) {
  if (mode === "live") return `Last-known captured state at ${frame.stage.time}. No streaming collector is connected.`;
  if (mode === "compare") return "Drag the split to compare incident impact with verified recovery.";
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
  if (id === "deployment") return "changes";
  if (id === "agent") return "agent";
  if (id === "evaluator") return "eval";
  if (id === "ledger") return "evidence";
  return "metrics";
}

function annotationTitle(id) {
  return ({ deploy: "Deployment entered", propagation: "Failure propagated", rejected: "Kafka hypothesis rejected", replan: "Investigator replanned", root: "Root cause confirmed", gate: "Owner approval required", recovery: "Recovery verified", learning: "Regression recorded" })[id] || id;
}

function kindLabel(kind) {
  return ({ client: "Client", service: "Service", api: "API", stream: "Stream", worker: "Worker", change: "Deployment change", agent: "Investigation agent", evaluator: "Adversarial evaluator", database: "Evidence database" })[kind] || "Component";
}

function statusLabel(status) {
  return ({ healthy: "Healthy", quiet: "Standby", dormant: "Not active", recording: "Recording", warning: "Change pending", change: "Deployment change", impact: "Impact", root: "Root cause", rejected: "Rejected", active: "Investigating", approval: "Approval required", verified: "Verified", learned: "Learning recorded" })[status] || status;
}

function labelFor(id) { return NODE_BY_ID.get(id)?.label || id || "unknown"; }
function emptyDetail(message) { return `<div class="drawer-empty">${escapeHtml(message)}</div>`; }
function closeDrawerWithoutFocus() { selected = null; els["context-drawer"].hidden = true; }
function playDelay() { return 820 / Number(els["speed-select"].value || 1); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function percent(value) { return value == null ? "" : `${Math.round(value * 100)}%`; }
function formatOffset(ms) { return `T+${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`; }
function formatTime(value) { return new Date(value).toISOString().slice(11, 19); }
function formatMetric(metric, value) { return metric.includes("percent") ? `${value}%` : Number(value).toLocaleString(); }

async function request(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]);
}

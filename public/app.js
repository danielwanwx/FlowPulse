const els = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const topologyPositions = {
  frontend: [21, 18], checkout: [50, 18], payment: [79, 18],
  kafka: [48, 54], accounting: [24, 82], fraud: [73, 82]
};
let state;
let selectedEvidenceId;
let running = false;
let toastTimer;

els["run-button"].addEventListener("click", runGuided);
els["next-button"].addEventListener("click", () => mutate("/api/next"));
els["reset-button"].addEventListener("click", () => mutate("/api/reset"));
els["approve-button"].addEventListener("click", approve);
els["live-button"].addEventListener("click", runLive);

await refresh();

async function refresh() {
  setBusy(true);
  try {
    state = await request("/api/state");
    render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function mutate(path, body = {}) {
  setBusy(true);
  try {
    state = await request(path, { method: "POST", body: JSON.stringify(body) });
    if (path === "/api/reset") selectedEvidenceId = null;
    render();
    return state;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  } finally {
    setBusy(false);
  }
}

async function runGuided() {
  if (running) return;
  running = true;
  els["run-button"].textContent = "Replay running";
  try {
    while (!state.complete && !state.waiting_for_approval) {
      await mutate("/api/next");
      await wait(620);
    }
    if (state.waiting_for_approval) showToast("Owner approval is required before the checkout rollback can run.");
    if (state.complete) showToast("Recovery verified. Regression gate passed.");
  } finally {
    running = false;
    els["run-button"].textContent = state.complete ? "Replay complete" : "Continue guided replay";
    updateControls();
  }
}

async function approve() {
  await mutate("/api/approve", { owner: "Commerce incident owner" });
  showToast("Checkout-only rollback approved and recorded in the ledger.");
  await runGuided();
}

async function runLive() {
  if (!state.live_available) {
    showToast("Set OPENAI_API_KEY in .env to run a fresh GPT-5.6 investigation.", true);
    return;
  }
  setBusy(true);
  els["live-button"].textContent = "GPT-5.6 investigating";
  try {
    const response = await request("/api/live", { method: "POST", body: "{}" });
    state = response.state;
    render();
    showToast(`Live evaluator score: ${Math.round(response.result.evaluation.score * 100)}%. Trace ${response.result.trace_id || "recorded locally"}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    els["live-button"].textContent = "Run fresh GPT-5.6";
    setBusy(false);
  }
}

function render() {
  renderHeader();
  renderMetrics();
  renderTopology();
  renderEvidence();
  renderTimeline();
  renderRepair();
  renderInspector();
  renderVerification();
  renderGates();
  updateControls();
}

function renderHeader() {
  els["incident-title"].textContent = state.incident.title;
  els["incident-summary"].textContent = state.incident.summary;
  els.severity.textContent = state.incident.severity;
  els.environment.textContent = state.incident.environment;
  els.stage.textContent = state.stage;
  els["status-text"].textContent = statusLabel(state.status);
  els["mode-badge"].textContent = state.mode === "replay" ? "Deterministic replay" : state.mode;
  els["ledger-state"].textContent = `${state.events.length} immutable events`;
  els["mode-badge"].className = `tag ${state.complete ? "success" : ""}`;
  if (state.langfuse_enabled) {
    els["langfuse-link"].classList.remove("is-disabled");
    els["langfuse-link"].href = state.langfuse_url;
  } else {
    els["langfuse-link"].classList.add("is-disabled");
    els["langfuse-link"].textContent = "Langfuse not configured";
  }
}

function renderMetrics() {
  const verified = hasEvent("verification.completed");
  setMetric("checkout", verified ? "0.8%" : "38.4%", verified ? "recovered" : "+37.7 pp", verified);
  setMetric("payment", verified ? "99.98%" : "61.6%", verified ? "reachable" : "degraded", verified);
  setMetric("kafka", verified ? "620" : "11,842", verified ? "draining" : "downstream", verified);
}

function setMetric(name, value, delta, good) {
  els[`metric-${name}`].textContent = value;
  els[`metric-${name}-delta`].textContent = delta;
  els[`metric-${name}-delta`].className = `metric-delta ${good ? "good" : "bad"}`;
}

function renderTopology() {
  const causeKnown = hasEvent("evaluation.accepted");
  const recovered = hasEvent("verification.completed");
  const impacted = new Set(hasEvent("loop.symptoms_collected") ? ["checkout", "payment", "kafka", "accounting", "fraud"] : []);
  const services = state.topology.services;
  const edges = state.topology.edges;
  els.topology.innerHTML = `<svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">${edges.map(([from, to]) => {
    const a = topologyPositions[from];
    const b = topologyPositions[to];
    const active = impacted.has(from) && impacted.has(to);
    return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="${recovered && active ? "recovered" : active ? "impacted" : ""}" vector-effect="non-scaling-stroke" />`;
  }).join("")}</svg>` + services.map((service) => {
    const [x, y] = topologyPositions[service.id];
    const classes = ["service-node", `node-${service.id}`, recovered && impacted.has(service.id) ? "recovered" : impacted.has(service.id) ? "impacted" : "", causeKnown && service.id === "checkout" ? "cause" : ""].filter(Boolean).join(" ");
    return `<div class="${classes}"><strong>${escapeHtml(service.label)}</strong><span>${escapeHtml(service.team)}</span></div>`;
  }).join("");
  els["topology-state"].textContent = recovered ? "Recovered" : impacted.size ? "Impact active" : "Awaiting evidence";
  els["topology-state"].className = `tag ${recovered ? "success" : impacted.size ? "danger" : ""}`;
}

function renderEvidence() {
  els["evidence-count"].textContent = state.evidence.length;
  if (!state.evidence.length) {
    els["evidence-list"].innerHTML = `<div class="empty-state">Evidence appears as tools query the captured incident.</div>`;
    return;
  }
  if (!selectedEvidenceId || !state.evidence.some((item) => item.id === selectedEvidenceId)) selectedEvidenceId = state.evidence.at(-1).id;
  els["evidence-list"].innerHTML = state.evidence.map((item) => `
    <button class="evidence-item ${item.id === selectedEvidenceId ? "selected" : ""}" type="button" data-evidence-id="${escapeHtml(item.id)}">
      <span class="evidence-kind">${escapeHtml(item.kind)}</span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.entity)} | ${timeOnly(item.at)}</small></span>
    </button>`).join("");
  for (const button of els["evidence-list"].querySelectorAll("button")) {
    button.addEventListener("click", () => {
      selectedEvidenceId = button.dataset.evidenceId;
      renderEvidence();
      renderInspector();
    });
  }
}

function renderTimeline() {
  const visible = state.events.filter((event) => [
    "hypothesis.proposed", "evaluation.rejected", "plan.revised", "evaluation.accepted",
    "repair.proposed", "approval.requested", "approval.granted", "repair.executed",
    "verification.completed", "outcome.classified", "regression.created", "policy.evaluated",
    "live.run.started", "live.run.completed", "live.run.failed"
  ].includes(event.type));
  els["event-count"].textContent = `${state.events.length} events`;
  if (!visible.length) {
    els.timeline.innerHTML = `<div class="empty-state large"><strong>No agent claims yet</strong><span>Start the guided replay to inspect every decision and citation.</span></div>`;
    return;
  }
  els.timeline.innerHTML = visible.map((event) => {
    const presentation = eventPresentation(event);
    return `<article class="timeline-entry ${presentation.tone}">
      <div class="entry-meta"><span>${escapeHtml(event.actor)} | ${offset(event.offset_ms)}</span>${presentation.score ? `<span class="entry-score">score ${presentation.score}</span>` : ""}</div>
      <div class="entry-title">${escapeHtml(presentation.title)}</div>
      <div class="entry-copy">${escapeHtml(presentation.copy)}</div>
      ${event.evidence_refs.length ? `<div class="citation-row">${event.evidence_refs.map((id) => `<span class="citation">${escapeHtml(id)}</span>`).join("")}</div>` : ""}
    </article>`;
  }).join("");
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

function renderRepair() {
  const proposed = eventOf("repair.proposed");
  const requested = eventOf("approval.requested");
  const approved = eventOf("approval.granted");
  const executed = eventOf("repair.executed");
  els["approve-button"].hidden = !requested || Boolean(approved);
  if (!proposed) {
    els["approval-tag"].textContent = "Not proposed";
    els["approval-tag"].className = "tag";
    els["repair-content"].innerHTML = `<div class="empty-state">A repair can appear only after an evidence-supported diagnosis passes evaluation.</div>`;
    return;
  }
  const repair = proposed.payload;
  els["approval-tag"].textContent = executed ? "Executed" : approved ? "Approved" : "Approval required";
  els["approval-tag"].className = `tag ${executed || approved ? "success" : "warning"}`;
  els["repair-content"].innerHTML = `<div class="repair-grid">
    <div class="data-cell"><span>Action</span><strong>${escapeHtml(repair.action)}</strong></div>
    <div class="data-cell"><span>Target</span><strong>${escapeHtml(repair.target)}</strong></div>
    <div class="data-cell"><span>Current</span><strong>${escapeHtml(repair.from)}</strong></div>
    <div class="data-cell"><span>Restore</span><strong>${escapeHtml(repair.to)}</strong></div>
    <div class="data-cell wide"><span>Abort condition</span><strong>${escapeHtml(repair.abort_if)}</strong></div>
  </div><div class="repair-boundary">Scope is locked to the checkout deployment. No Kafka or payment mutation is allowed.</div>`;
}

function renderInspector() {
  const evidence = state.evidence.find((item) => item.id === selectedEvidenceId);
  if (!evidence) {
    els.inspector.innerHTML = `<div class="empty-state">Select an evidence item to inspect its source fact.</div>`;
    return;
  }
  els.inspector.innerHTML = `<h3 class="inspector-title">${escapeHtml(evidence.title)}</h3>
    <div class="inspector-meta">${escapeHtml(evidence.id)} | ${escapeHtml(evidence.source || evidence.kind)} | ${escapeHtml(evidence.entity)}</div>
    <p class="inspector-fact">${escapeHtml(evidence.fact)}</p>
    ${evidence.value ? `<pre class="code-value">${escapeHtml(JSON.stringify(evidence.value, null, 2))}</pre>` : ""}`;
}

function renderVerification() {
  const verification = eventOf("verification.completed");
  if (!verification) {
    els["verification-tag"].textContent = "Pending";
    els["verification-tag"].className = "tag";
    els["verification-content"].innerHTML = `<div class="empty-state">Verification waits for an approved repair.</div>`;
    return;
  }
  els["verification-tag"].textContent = "Passed";
  els["verification-tag"].className = "tag success";
  els["verification-content"].innerHTML = verification.payload.checks.map((check) => `<div class="comparison">
    <div class="comparison-value"><span>Before</span><strong>${formatMetric(check.metric, check.before)}</strong></div>
    <div class="comparison-arrow">→</div>
    <div class="comparison-value after"><span>${escapeHtml(check.threshold)}</span><strong>${formatMetric(check.metric, check.after)}</strong></div>
  </div>`).join("");
}

function renderGates() {
  const evaluated = eventOf("policy.evaluated");
  if (!evaluated) {
    els["gates-tag"].textContent = "Locked";
    els["gates-tag"].className = "tag";
    els["gates-content"].innerHTML = `<div class="empty-state">A candidate policy is tested after recovery.</div>`;
    return;
  }
  els["gates-tag"].textContent = evaluated.payload.passed ? "Eligible" : "Blocked";
  els["gates-tag"].className = `tag ${evaluated.payload.passed ? "success" : "danger"}`;
  els["gates-content"].innerHTML = evaluated.payload.gates.map((gate) => `<div class="gate">
    <span class="gate-mark">${gate.passed ? "✓" : "×"}</span><div><strong>${escapeHtml(gate.label)}</strong><small>${escapeHtml(gate.id)}</small></div>
  </div>`).join("");
}

function updateControls() {
  els["next-button"].disabled = running || state.complete || state.waiting_for_approval;
  els["run-button"].disabled = running || state.complete || state.waiting_for_approval;
  els["live-button"].disabled = running;
  els["live-button"].title = state.live_available ? "Run a fresh Responses API investigation" : "Set OPENAI_API_KEY to enable live mode";
  els["run-button"].textContent = running ? "Replay running" : state.complete ? "Replay complete" : state.waiting_for_approval ? "Awaiting owner approval" : "Run guided replay";
}

function eventPresentation(event) {
  const p = event.payload;
  let presentation;
  switch (event.type) {
    case "hypothesis.proposed": presentation = [p.title || "Hypothesis proposed", p.claim || "Agent proposed a causal claim.", "", percent(p.confidence)]; break;
    case "evaluation.rejected": presentation = ["Evaluator rejected the diagnosis", p.reason, "rejected", percent(p.score)]; break;
    case "plan.revised": presentation = ["Investigator replanned", p.reason, "", ""]; break;
    case "evaluation.accepted": presentation = ["Causal finding accepted", p.reason, "accepted", percent(p.score)]; break;
    case "repair.proposed": presentation = ["Bounded checkout rollback proposed", p.expected_effect, "approval", ""]; break;
    case "approval.requested": presentation = ["Owner approval requested", p.reason, "approval", ""]; break;
    case "approval.granted": presentation = ["Owner approved the rollback", `${p.owner} approved ${p.scope}.`, "accepted", ""]; break;
    case "repair.executed": presentation = ["Checkout rollback executed", `${p.from} restored to ${p.to}.`, "accepted", ""]; break;
    case "verification.completed": presentation = ["Recovery thresholds passed", "Payment reachability recovered, checkout errors fell, and Kafka lag drained without a Kafka repair.", "verified", ""]; break;
    case "outcome.classified": presentation = ["Outcome classified", `${p.classification}; learning: ${p.secondary_learning}. ${p.explanation}`, "verified", ""]; break;
    case "regression.created": presentation = ["Regression case created", p.name, "verified", ""]; break;
    case "policy.evaluated": presentation = ["Candidate policy passed offline gates", `${p.candidate} is ${(p.promotion || "blocked").replaceAll("_", " ")}. Promotion still requires an owner.`, "verified", ""]; break;
    case "live.run.started": presentation = ["Live GPT-5.6 loop started", `Model ${p.model} is querying captured evidence through allowlisted tools.`, "", ""]; break;
    case "live.run.completed": presentation = ["Live GPT-5.6 loop completed", p.evaluation?.reason || "Investigation and adversarial evaluation completed.", p.evaluation?.accepted ? "accepted" : "rejected", percent(p.evaluation?.score)]; break;
    case "live.run.failed": presentation = ["Live investigation stopped", p.reason, "rejected", ""]; break;
    default: presentation = [event.type, JSON.stringify(p), "", ""];
  }
  const [title, copy, tone, score] = presentation;
  return { title, copy: copy || "Recorded in the append-only ledger.", tone, score };
}

function eventOf(type) { return state.events.find((event) => event.type === type); }
function hasEvent(type) { return Boolean(eventOf(type)); }
function statusLabel(status) { return ({ investigating: "Investigation active", approval_required: "Paused at human gate", resolved: "Verified and recorded" })[status] || status; }
function offset(ms) { return `T+${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`; }
function timeOnly(value) { return new Date(value).toISOString().slice(11, 19); }
function formatMetric(metric, value) { return metric.includes("percent") ? `${value}%` : Number(value).toLocaleString(); }
function percent(value) { return value == null ? "" : `${Math.round(value * 100)}%`; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function request(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setBusy(value) {
  document.body.classList.toggle("is-busy", value);
  if (!running) els["next-button"].disabled = value;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${error ? " error" : ""}`;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

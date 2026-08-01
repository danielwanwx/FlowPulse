import { incidentTopologyView } from "./control-plane-topology-layout.mjs";
import { INCIDENT_STAGES_V3, STAGE_STATES_V3, WORKFLOW_COMMANDS_V3 } from "./incident-v3-types.mjs";

export { INCIDENT_STAGES_V3, STAGE_STATES_V3 } from "./incident-v3-types.mjs";
const PANELS = new Set(["metrics", "evidence", "activity", "timeline", "component", "graph", "action", "audit"]);
const COMMANDS = new Set(WORKFLOW_COMMANDS_V3);
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function workbenchViewV3(projection, { reviewStage = null } = {}) {
  const attempt = projection?.current_attempt || null;
  const currentStage = INCIDENT_STAGES_V3.includes(attempt?.current_stage) ? attempt.current_stage : "DETECT";
  const currentIndex = INCIDENT_STAGES_V3.indexOf(currentStage);
  // A post-action rerun creates a child attempt that starts at Investigate or
  // Decide. Keep completed parent stages reviewable without exposing parent
  // results for stages that are still locked in the child attempt.
  const runs = new Map();
  for (const lineageAttempt of [...(projection?.attempt_history || []), ...(attempt ? [attempt] : [])]) {
    for (const run of lineageAttempt.stage_runs || []) runs.set(run.stage, run);
  }
  const reviewable = INCIDENT_STAGES_V3.includes(reviewStage)
    && INCIDENT_STAGES_V3.indexOf(reviewStage) < currentIndex
    && ["SUCCEEDED", "SUPERSEDED"].includes(runs.get(reviewStage)?.status);
  const visibleStage = reviewable ? reviewStage : currentStage;
  const rail = INCIDENT_STAGES_V3.map((stage, index) => {
    const run = index > currentIndex ? null : runs.get(stage) || null;
    const status = index > currentIndex ? "LOCKED" : run?.status || (index === currentIndex ? "READY" : "SUPERSEDED");
    return {
      stage,
      status,
      run,
      current: stage === currentStage,
      visible: stage === visibleStage,
      reviewable: index < currentIndex && ["SUCCEEDED", "SUPERSEDED"].includes(status),
      locked: index > currentIndex || status === "LOCKED"
    };
  });
  return {
    attempt,
    currentStage,
    visibleStage,
    visibleRun: runs.get(visibleStage) || null,
    reviewingHistory: visibleStage !== currentStage,
    rail
  };
}

export function buildWorkflowCommandV3(projection, command, {
  stage = null,
  reason = null,
  idempotencyKey
} = {}) {
  if (!COMMANDS.has(command)) throw new Error("workflow_command_invalid");
  const attempt = projection?.current_attempt;
  if (!attempt || !PATH_ID.test(attempt.attempt_id || "") || !INCIDENT_STAGES_V3.includes(attempt.current_stage)
    || !Number.isSafeInteger(attempt.workflow_revision) || attempt.workflow_revision < 0) throw new Error("workflow_identity_invalid");
  if (!PATH_ID.test(idempotencyKey || "")) throw new Error("workflow_idempotency_key_invalid");
  const value = {
    attempt_id: attempt.attempt_id,
    expected_stage: attempt.current_stage,
    expected_workflow_revision: attempt.workflow_revision,
    idempotency_key: idempotencyKey
  };
  if (command === "RERUN_FROM_STAGE") {
    if (!INCIDENT_STAGES_V3.includes(stage)) throw new Error("workflow_stage_invalid");
  }
  if (["RERUN_FROM_STAGE", "ESCALATE"].includes(command)) {
    const normalized = String(reason || "").trim();
    if (!normalized || normalized.length > 500) throw new Error("workflow_reason_invalid");
    value.reason = normalized;
  }
  return value;
}

export function parseIncidentWorkspaceUrlV3(url) {
  const caseId = url.searchParams.get("case_id");
  const reviewStage = url.searchParams.get("stage");
  const panel = url.searchParams.get("panel");
  const componentId = url.searchParams.get("component");
  return {
    caseId: PATH_ID.test(caseId || "") ? caseId : null,
    reviewStage: INCIDENT_STAGES_V3.includes(reviewStage) ? reviewStage : null,
    panel: PANELS.has(panel) ? panel : null,
    componentId: PATH_ID.test(componentId || "") ? componentId : null
  };
}

export function updateIncidentWorkspaceUrlV3(url, { caseId, reviewStage = null, panel = null, componentId = null }) {
  const next = new URL(url);
  setParam(next, "case_id", PATH_ID.test(caseId || "") ? caseId : null);
  setParam(next, "stage", INCIDENT_STAGES_V3.includes(reviewStage) ? reviewStage : null);
  setParam(next, "panel", PANELS.has(panel) ? panel : null);
  setParam(next, "component", PATH_ID.test(componentId || "") ? componentId : null);
  return next;
}

export function workbenchDurationV3(projection, now = Date.now()) {
  const clock = projection?.incident_clock;
  if (!clock) return { elapsed_seconds: 0, freshness: projection?.freshness?.state || "UNKNOWN" };
  if (clock.state !== "RUNNING" || clock.freshness !== "CURRENT") {
    return { elapsed_seconds: clock.elapsed_seconds, freshness: clock.freshness };
  }
  const asOf = Date.parse(clock.as_of);
  const freshUntil = Date.parse(clock.fresh_until);
  if (!Number.isFinite(asOf) || !Number.isFinite(freshUntil)) return { elapsed_seconds: clock.elapsed_seconds, freshness: "UNKNOWN" };
  const delta = Math.max(0, Math.floor((Math.min(now, freshUntil) - asOf) / 1000));
  return {
    elapsed_seconds: clock.elapsed_seconds + Math.min(delta, clock.max_interpolation_seconds),
    freshness: now > freshUntil ? "STALE" : "CURRENT"
  };
}

export function applyIncidentEventV3(state, event) {
  if (!Number.isSafeInteger(event?.sequence) || !Number.isSafeInteger(event?.projection_revision)) return { state, effect: "rehydrate" };
  if (event.sequence <= state.lastSequence) return { state, effect: null };
  if (event.sequence !== state.lastSequence + 1 || event.projection_revision < state.projectionRevision) return { state, effect: "rehydrate" };
  return {
    state: { lastSequence: event.sequence, projectionRevision: event.projection_revision },
    effect: event.projection_revision > state.projectionRevision ? "refresh" : null
  };
}

export function metricSeriesPathsV3(collection, width = 320, height = 96) {
  const allTimes = (collection?.series || []).flatMap((series) => series.points || [])
    .map((point) => Date.parse(point.timestamp || ""))
    .filter(Number.isFinite);
  const globalStart = allTimes.length ? Math.min(...allTimes) : 0;
  const globalEnd = allTimes.length ? Math.max(...allTimes) : globalStart;
  const timeSpan = Math.max(globalEnd - globalStart, 1);
  return (collection?.series || []).map((series) => {
    const numeric = (series.points || []).filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
    const min = numeric.length ? Math.min(...numeric.map((point) => point.value)) : null;
    const max = numeric.length ? Math.max(...numeric.map((point) => point.value)) : null;
    const valueSpan = min === null ? 1 : Math.max(max - min, Math.max(Math.abs(max) * 0.08, 0.0001));
    const lower = min === null ? 0 : min - valueSpan * 0.12;
    const upper = max === null ? 1 : max + valueSpan * 0.12;
    const segments = [];
    let current = [];
    for (const point of series.points || []) {
      const time = Date.parse(point.timestamp || "");
      if (typeof point.value !== "number" || !Number.isFinite(point.value) || !Number.isFinite(time)) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      current.push({
        timestamp: point.timestamp,
        value: point.value,
        evidence_refs: [...(point.evidence_refs || [])],
        x: Number(((time - globalStart) / timeSpan * width).toFixed(2)),
        y: Number((height - ((point.value - lower) / (upper - lower) * height)).toFixed(2))
      });
    }
    if (current.length) segments.push(current);
    return { seriesId: series.series_id, unit: series.unit, min, max, segments };
  });
}

export function metricTrendV3(series) {
  const numeric = [];
  for (const point of [...(series?.points || [])].reverse()) {
    if (typeof point.value !== "number" || !Number.isFinite(point.value)) break;
    numeric.unshift(point);
  }
  if (!numeric.length) return { direction: "unknown", label: "Trend unavailable" };
  if (numeric.length < 2) return { direction: "unknown", label: "Trend pending" };
  const first = numeric[0].value;
  const last = numeric.at(-1).value;
  const delta = last - first;
  const tolerance = Math.max(Math.abs(first) * 0.01, 0.000001);
  if (Math.abs(delta) <= tolerance) return { direction: "flat", label: "Flat" };
  const percent = first === 0 ? null : Math.abs(delta / first) * 100;
  const direction = delta > 0 ? "rising" : "falling";
  return {
    direction,
    label: `${direction === "rising" ? "Rising" : "Falling"}${percent === null ? "" : ` ${formatPercentChange(percent)}`}`
  };
}

export function renderIncidentWorkbenchV3(projection, ui = {}) {
  if (!projection) return loadingMarkup(ui.error);
  const view = workbenchViewV3(projection, ui);
  const duration = workbenchDurationV3(projection, ui.now);
  const connection = ui.connection || "connecting";
  if (projection.lifecycle_state === "RESOLVED" && projection.current_attempt?.status === "COMPLETED") {
    return finalAuditMarkup(projection, duration, connection, ui, view);
  }
  const available = new Set(projection.available_commands || []);
  const currentRun = view.rail.find((item) => item.current)?.run;
  const canNext = !view.reviewingHistory && currentRun?.status === "SUCCEEDED" && available.has(view.currentStage === "VERIFY" ? "COMPLETE_INCIDENT" : "NEXT");
  const freshness = duration.freshness || projection.freshness?.state || "UNKNOWN";
  return `<div class="iw3-shell" data-active-stage="${escapeHtml(view.visibleStage)}" data-current-stage="${escapeHtml(view.currentStage)}" data-connection="${escapeHtml(connection)}" data-freshness="${escapeHtml(String(freshness).toLowerCase())}">
    ${commandBarMarkup(projection, view, duration, freshness, connection)}
    ${commandErrorMarkup(ui.error)}
    ${stageRailMarkup(view)}
    <div class="iw3-workspace-body">
      <main class="iw3-stage-surface" id="incident-stage-surface" tabindex="-1">
        ${stageMarkup(view, projection, ui)}
      </main>
    </div>
    ${footerMarkup(view, available, projection.available_rerun_stages || [], canNext, ui.commandPending)}
    ${panelMarkup(view, projection, ui)}
  </div>`;
}

function finalAuditMarkup(projection, duration, connection, ui, view) {
  const report = projection.final_report || null;
  const verify = projection.current_attempt.stage_runs.find((run) => run.stage === "VERIFY") || null;
  const completedAt = projection.current_attempt.completed_at || report?.generated_at || verify?.completed_at;
  const completedSeries = metricSeriesAt(ui.series, completedAt);
  const completedUi = { ...ui, series: completedSeries };
  const startedAtMs = Date.parse(projection.incident_clock?.started_at || "");
  const completedAtMs = Date.parse(completedAt || "");
  const completedElapsed = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000))
    : duration.elapsed_seconds;
  const primary = view.reviewingHistory
    ? `<main class="iw3-stage-surface" id="incident-stage-surface" tabindex="-1">${stageMarkup(view, projection, completedUi)}</main>`
    : `<main class="iw3-resolution-surface" id="incident-stage-surface" tabindex="-1">
        <header class="iw3-resolution-hero"><div><span>Resolved</span><h3>${escapeHtml(pathLabel(projection))}</h3><div class="iw3-status-chips"><span data-tone="healthy">Recovered</span><span>${escapeHtml(formatDuration(completedElapsed))}</span></div></div><div class="iw3-tool-row"><button type="button" data-open-panel="graph">Dataflow</button><button type="button" data-open-panel="metrics">Monitor</button><button type="button" data-open-panel="audit">Incident audit</button></div></header>
        <div class="iw3-resolution-grid">
          <section class="iw3-panel iw3-resolution-signals">${signalCardsMarkup(completedSeries)}</section>
        </div>
      </main>`;
  return `<div class="iw3-shell iw3-resolved-shell" data-audit-report="${escapeHtml(report?.report_id || "unavailable")}" data-connection="${escapeHtml(connection)}">
    ${commandBarMarkup(projection, view, { elapsed_seconds: completedElapsed, freshness: "CURRENT" }, "CURRENT", "resolved")}
    ${stageRailMarkup(view)}
    <div class="iw3-workspace-body">
      ${primary}
    </div>
    ${panelMarkup(view, projection, completedUi)}
  </div>`;
}

function metricSeriesAt(collection, timestamp) {
  const cutoff = Date.parse(timestamp || "");
  if (!Number.isFinite(cutoff) || !collection?.series) return collection;
  return {
    ...collection,
    series: collection.series.map((series) => {
      const points = (series.points || []).filter((point) => Date.parse(point.timestamp || "") <= cutoff);
      const latest = points.at(-1);
      return {
        ...series,
        points,
        observed_window_end: latest?.timestamp || series.observed_window_end,
        freshness: latest?.freshness || series.freshness
      };
    }).filter((series) => series.points.length)
  };
}

function auditDetailMarkup(projection) {
  const report = projection.final_report || null;
  const records = new Map((projection.audit_records || []).map((record) => [record.audit_id, record]));
  const attempts = new Map([...(projection.attempt_history || []), projection.current_attempt].map((attempt) => [attempt.attempt_id, attempt]));
  const stageRecords = (report?.stage_output_audit_ids || []).map((auditId) => records.get(auditId)).filter((record) => record && record.record_type !== "INCIDENT_COMPLETED");
  const receiptRecords = (report?.action_receipt_audit_ids || []).map((auditId) => records.get(auditId)).filter(Boolean);
  const lineage = (report?.attempt_lineage || []).map((attemptId) => attempts.get(attemptId)).filter(Boolean);
  const lineageIds = new Set(report?.attempt_lineage || []);
  const approvals = (projection.audit_records || []).filter((record) => record.record_type === "APPROVAL_RECORDED" && lineageIds.has(record.attempt_id));
  const verificationRecords = (projection.audit_records || []).filter((record) => ["VERIFICATION_RECORDED", "INCIDENT_COMPLETED"].includes(record.record_type) && lineageIds.has(record.attempt_id));
  return `<div class="iw3-audit-surface" data-read-only="true">
      <header class="iw3-audit-hero"><div><span>Resolved · read-only</span><h4>Immutable incident audit</h4><p>${report ? "Bound to immutable workflow, approval, execution, and evidence records." : "The canonical projection has not published its final audit report."}</p></div>${report ? `<code>${escapeHtml(report.report_id)}</code>` : '<strong role="alert">Audit report unavailable</strong>'}</header>
      ${report ? `<div class="iw3-audit-grid">
        <section class="iw3-audit-card iw3-audit-integrity"><h4>Report integrity</h4><dl class="iw3-record"><div><dt>Content hash</dt><dd><code>${escapeHtml(report.content_hash)}</code></dd></div><div><dt>Generated</dt><dd>${escapeHtml(report.generated_at)}</dd></div><div><dt>Workflow revision</dt><dd>${escapeHtml(String(report.workflow_revision))}</dd></div><div><dt>Decision revision</dt><dd>${escapeHtml(String(report.decision_revision))}</dd></div></dl></section>
        <section class="iw3-audit-card"><h4>Attempt lineage</h4>${auditLineageMarkup(lineage)}</section>
        <section class="iw3-audit-card iw3-audit-span"><h4>Immutable stage outputs</h4><div class="iw3-audit-records">${stageRecords.map(auditStageMarkup).join("") || '<p class="iw3-empty">No referenced stage output records were published.</p>'}</div></section>
        <section class="iw3-audit-card"><h4>Human approvals</h4><div class="iw3-audit-records">${approvals.map(auditApprovalMarkup).join("") || '<p class="iw3-empty">No approval audit records were published.</p>'}</div></section>
        <section class="iw3-audit-card"><h4>Action receipts</h4><div class="iw3-audit-records">${receiptRecords.map(auditReceiptMarkup).join("") || '<p class="iw3-empty">No referenced action receipt records were published.</p>'}</div></section>
        <section class="iw3-audit-card iw3-audit-span"><h4>Verification</h4>${auditEvidenceMarkup(report.verification_evidence_refs)}<div class="iw3-audit-records">${verificationRecords.map(auditVerificationMarkup).join("") || '<p class="iw3-empty">No verification audit records were published.</p>'}</div></section>
      </div>` : ""}
    </div>`;
}

function auditLineageMarkup(lineage) {
  return `<ol class="iw3-audit-lineage">${lineage.map((attempt, index) => `<li><span>${index + 1}</span><div><strong>Attempt #${escapeHtml(String(attempt.attempt_number || index + 1))}</strong><code>${escapeHtml(attempt.attempt_id)}</code><small>${escapeHtml(titleCase(attempt.status))} · ${escapeHtml(attempt.created_reason || "Recorded attempt")} · r${escapeHtml(String(attempt.workflow_revision))}</small>${attempt.parent_attempt_id ? `<small>Parent ${escapeHtml(attempt.parent_attempt_id)}</small>` : ""}</div></li>`).join("") || '<li class="iw3-empty">No attempt lineage was published.</li>'}</ol>`;
}

function auditStageMarkup(record) {
  const output = record.stage_output || {};
  const details = Object.fromEntries(["root_cause", "recommendation", "risk", "rollback", "verification_conditions"].filter((key) => output[key] !== undefined && output[key] !== null).map((key) => [key, output[key]]));
  const evidence = uniqueOrdered([...(record.evidence_refs || []), ...(output.evidence_refs || [])]);
  return `<article class="iw3-audit-record" data-audit-id="${escapeHtml(record.audit_id)}"><header><div><span>${escapeHtml(stageLabel(record.stage))}</span><h5>${escapeHtml(output.summary || record.summary)}</h5></div><time datetime="${escapeHtml(record.recorded_at)}">${escapeHtml(record.recorded_at)}</time></header><dl class="iw3-record"><div><dt>Audit record</dt><dd><code>${escapeHtml(record.audit_id)}</code></dd></div><div><dt>Stage run</dt><dd><code>${escapeHtml(record.stage_run_id || "Unavailable")}</code></dd></div><div><dt>Workflow revision</dt><dd>${escapeHtml(String(record.workflow_revision))}</dd></div></dl>${Object.keys(details).length ? recordMarkup(details, "") : ""}${(output.facts || []).length ? `<h6>Facts</h6>${listMarkup(output.facts, "")}` : ""}<h6>Evidence references</h6>${auditEvidenceMarkup(evidence)}</article>`;
}

function auditApprovalMarkup(record) {
  return `<article class="iw3-audit-record" data-audit-id="${escapeHtml(record.audit_id)}"><header><div><span>${escapeHtml(record.approval_decision || "Recorded")}</span><h5>${escapeHtml(record.summary)}</h5></div><time datetime="${escapeHtml(record.recorded_at)}">${escapeHtml(record.recorded_at)}</time></header><dl class="iw3-record"><div><dt>Audit record</dt><dd><code>${escapeHtml(record.audit_id)}</code></dd></div><div><dt>Action</dt><dd><code>${escapeHtml(record.action_id || "Unavailable")}</code></dd></div><div><dt>Actor</dt><dd>${escapeHtml(record.actor_subject_id || "System")}</dd></div><div><dt>Decision revision</dt><dd>${escapeHtml(String(record.decision_revision))}</dd></div></dl></article>`;
}

function auditReceiptMarkup(record) {
  return `<article class="iw3-audit-record" data-audit-id="${escapeHtml(record.audit_id)}"><header><div><span>${escapeHtml(titleCase(record.record_type))}</span><h5>${escapeHtml(record.summary)}</h5></div><time datetime="${escapeHtml(record.recorded_at)}">${escapeHtml(record.recorded_at)}</time></header><dl class="iw3-record"><div><dt>Audit record</dt><dd><code>${escapeHtml(record.audit_id)}</code></dd></div><div><dt>Action</dt><dd><code>${escapeHtml(record.action_id || "Unavailable")}</code></dd></div></dl>${receiptMarkup(record.action_receipt)}${rollbackReceiptMarkup(record.rollback_receipt)}</article>`;
}

function auditVerificationMarkup(record) {
  return `<article class="iw3-audit-record" data-audit-id="${escapeHtml(record.audit_id)}"><header><div><span>${escapeHtml(titleCase(record.record_type))}</span><h5>${escapeHtml(record.summary)}</h5></div><time datetime="${escapeHtml(record.recorded_at)}">${escapeHtml(record.recorded_at)}</time></header>${auditEvidenceMarkup(record.evidence_refs || [])}</article>`;
}

function auditEvidenceMarkup(references) {
  return `<ul class="iw3-audit-evidence">${(references || []).map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("") || '<li class="iw3-empty">No evidence references were published.</li>'}</ul>`;
}

function uniqueOrdered(values) {
  return [...new Set(values)];
}

function commandBarMarkup(projection, view, duration, freshness, connection) {
  const graphAvailable = (projection.graph?.nodes || []).length > 0;
  return `<header class="iw3-command-bar">
    <div class="iw3-command-context"><span class="iw3-severity${projection.lifecycle_state === "RESOLVED" ? " is-resolved" : ""}">${escapeHtml(projection.lifecycle_state === "RESOLVED" ? "RESOLVED" : projection.severity)}</span><h2>${escapeHtml(pathLabel(projection))}</h2></div>
    <div class="iw3-command-chips" role="status" data-state="${escapeHtml(connection)}"><span data-incident-duration>${escapeHtml(formatDuration(duration.elapsed_seconds))}</span><span class="is-${escapeHtml(String(freshness).toLowerCase())}">${escapeHtml(titleCase(freshness))}</span><span>${escapeHtml(stageLabel(view.currentStage))}</span></div>
    <div class="iw3-tool-row"><button type="button" data-open-panel="graph"${graphAvailable ? "" : " disabled"}>Dataflow</button><button type="button" data-open-panel="metrics">Monitor</button><button type="button" data-open-panel="activity">Activity</button></div>
  </header>`;
}

function pathLabel(projection) {
  const nodes = new Map((projection.graph?.nodes || []).map((node) => [node.component_id, node]));
  const labels = (projection.impacted_path || []).map((id) => nodes.get(id)?.display_name || id).filter(Boolean);
  return labels.join(" → ") || projection.title || "Incident";
}

function stageRailMarkup(view) {
  return `<nav class="iw3-stage-rail" aria-label="Incident workflow">${view.rail.map((item, index) => `<button type="button" class="iw3-stage-step${item.current ? " is-current" : ""}${item.visible ? " is-visible" : ""}" data-stage="${item.stage}" data-stage-status="${item.status}" aria-label="${escapeHtml(`${stageLabel(item.stage)} · ${stateLabel(item.status)}`)}"${item.current || item.reviewable ? "" : " disabled"}${item.current ? ' aria-current="step"' : ""}><span>${index + 1}</span><strong>${stageLabel(item.stage)}</strong></button>`).join("")}</nav>`;
}

function stageLeadMarkup(stage, projection, run, series, now) {
  const path = pathLabel(projection);
  if (stage === "DETECT") return `<p class="iw3-stage-lead">${escapeHtml(path)} error elevated</p>`;
  if (stage === "TRIAGE") {
    const bounded = triageIsBounded(run);
    if (!bounded) return '<p class="iw3-stage-lead">Scope under review</p>';
    const facts = (run.output?.facts || []).length;
    const unknowns = (run.output?.unknowns || []).length;
    return `<p class="iw3-stage-lead">Affected path: ${escapeHtml(path)} · ${facts} facts · ${unknowns} open question${unknowns === 1 ? "" : "s"}</p>`;
  }
  if (stage === "INVESTIGATE") {
    const leading = leadingHypothesis((projection.hypotheses || []).filter((item) => item.stage_run_id === run.stage_run_id));
    return `<p class="iw3-stage-lead">${leading ? `Leading evidence path · ${Math.round(Number(leading.confidence || 0) * 100)}%` : `Investigating ${escapeHtml(path)}`}</p>`;
  }
  if (stage === "DECIDE") {
    const candidate = decisionCandidate(projection, run);
    const risk = compactRisk(candidate?.risk);
    const label = approvedActionLabel(candidate);
    return label ? `<p class="iw3-stage-lead">Recommended action: ${label}${risk ? ` · Risk: ${escapeHtml(risk)}` : ""}</p>` : "";
  }
  if (stage === "RESPOND") {
    const action = currentAction(projection, run);
    const label = approvedActionLabel(action);
    return label ? `<p class="iw3-stage-lead">${label} · ${escapeHtml(action.status === "AWAITING_APPROVAL" ? "Approval required" : titleCase(action.status))}</p>` : "";
  }
  if (stage === "VERIFY" && run.status === "RUNNING") {
    const deadline = Date.parse(run.verification_deadline_at || "");
    const remaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - (now ?? Date.now())) / 1000)) : null;
    const healthy = Number.isSafeInteger(run.output?.healthy_sample_count) ? run.output.healthy_sample_count : null;
    return `<p class="iw3-stage-lead">Observing post-action telemetry${remaining === null ? "" : ` · ${escapeHtml(formatDuration(remaining))} left`}${healthy === null ? "" : ` · ${healthy}/3 healthy samples`}</p>`;
  }
  return "";
}

function triageIsBounded(run) {
  return [run.output?.scope_status, run.output?.impact_scope?.status]
    .some((value) => ["BOUNDED", "CONFIRMED"].includes(String(value || "").toUpperCase()));
}

function compactPathMarkup(projection, now) {
  const nodes = new Map((projection.graph?.nodes || []).map((node) => [node.component_id, node]));
  const path = projection.impacted_path || [];
  return `<div class="iw3-path-visual" aria-label="${escapeHtml(pathLabel(projection))}">${path.map((id) => {
    const node = nodes.get(id) || { component_id: id, display_name: id };
    return `<span data-tone="${escapeHtml(graphNodeTone(node, projection, now))}">${escapeHtml(node.display_name)}</span>`;
  }).join('<i aria-hidden="true">→</i>')}</div>`;
}

function activityCapsuleMarkup(projection, stage, run) {
  const items = (projection.agent_activity || []).filter((activity) => activity.stage === stage && activity.stage_run_id === run?.stage_run_id).slice(-3);
  if (!items.length) return "";
  return `<div class="iw3-activity-capsules">${items.map((activity) => `<button type="button" data-open-panel="activity" data-state="${escapeHtml(String(activity.state || "UNKNOWN").toLowerCase())}"><span aria-hidden="true"></span>${escapeHtml(titleCase(activity.role || "AGENT"))} · ${(activity.evidence_refs || []).length} evidence · ${escapeHtml(titleCase(activity.state))}</button>`).join("")}</div>`;
}

function leadingHypothesis(items) {
  return [...(items || [])].sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0] || null;
}

function decisionCandidate(projection, run) {
  const actionIds = new Set(run?.output?.action_ids || []);
  return run?.output?.action_candidate || (projection.actions || []).find((item) => actionIds.has(item.action_id)) || null;
}

function currentAction(projection, run) {
  return (projection.actions || []).find((action) => action.attempt_id === projection.current_attempt?.attempt_id && action.stage_run_id === run?.stage_run_id) || null;
}

function approvedActionLabel(action) {
  return action?.command_id === "astronomy.restore-payment-and-recreate-checkout"
    ? "Restore Payment reachability"
    : null;
}

function compactRisk(value) {
  return /bounded/i.test(String(value || "")) ? "bounded" : null;
}

function actionPreflight(projection, action) {
  const candidate = [...(projection.current_attempt?.stage_runs || [])].reverse().find((run) => run.stage === "DECIDE" && run.output?.action_candidate)?.output?.action_candidate;
  if (!candidate || action.command_id !== "astronomy.restore-payment-and-recreate-checkout") return null;
  if (candidate.decision_revision !== action.decision_revision || candidate.command_id !== action.command_id || candidate.component_id !== action.component_id) return null;
  if (candidate.expected_before !== "paymentUnreachable=on" || candidate.observed_before !== "paymentUnreachable=on") return null;
  return candidate;
}

function graphFreshness(projection, now) {
  return workbenchDurationV3(projection, now).freshness;
}

function graphHealth(projection, now) {
  if (graphFreshness(projection, now) !== "CURRENT") return "stale";
  const tones = (projection.graph?.nodes || []).map((node) => graphNodeTone(node, projection, now));
  if (tones.includes("affected")) return "affected";
  return tones.includes("healthy") ? "healthy" : "observed";
}

function graphNodeTone(node, projection, now) {
  if (graphFreshness(projection, now) !== "CURRENT") return "stale";
  const runtime = String(node.runtime_status || "").toLowerCase();
  const impact = String(node.impact_status || "").toLowerCase();
  if (["healthy", "verified", "recovered", "ok"].includes(runtime) || ["healthy", "verified", "recovered"].includes(impact)) return "healthy";
  if (["critical", "degraded", "unreachable", "failed", "error"].includes(runtime) || ["impacted", "critical", "degraded"].includes(impact)) return "affected";
  return "observed";
}

function stageMarkup(view, projection, ui) {
  const run = view.visibleRun;
  if (!run) return `<section class="iw3-stage iw3-stage-empty" aria-labelledby="iw3-stage-title"><h3 id="iw3-stage-title">${stageLabel(view.visibleStage)}</h3></section>`;
  const header = `<header class="iw3-stage-heading"><div><span>${stageLabel(view.visibleStage)}</span><h3 id="iw3-stage-title">${stageLabel(view.visibleStage)}</h3>${stageLeadMarkup(view.visibleStage, projection, run, ui.series, ui.now)}</div><div class="iw3-run-state" data-state="${escapeHtml(run.status.toLowerCase())}" aria-label="${escapeHtml(stateLabel(run.status))}"><span aria-hidden="true"></span></div></header>`;
  const content = ({
    DETECT: () => detectMarkup(projection, run, ui.series, ui.now),
    TRIAGE: () => triageMarkup(projection, run, ui.now),
    INVESTIGATE: () => investigateMarkup(projection, run, ui.now),
    DECIDE: () => decideMarkup(projection, run, ui.now),
    RESPOND: () => respondMarkup(projection, run, ui.commandPending, ui.now),
    VERIFY: () => verifyMarkup(projection, run, ui.series, ui.now)
  })[view.visibleStage]();
  const failure = ["FAILED", "NEEDS_HUMAN"].includes(run.status)
    ? '<div class="iw3-stage-failure" role="alert" aria-label="Needs attention"></div>'
    : "";
  return `<section class="iw3-stage" aria-labelledby="iw3-stage-title">${header}${failure}${content}</section>`;
}

function detectMarkup(projection, run, series, now) {
  return `<div class="iw3-stage-deck">
    <section class="iw3-stage-card iw3-stage-card-signals">${signalCardsMarkup(series)}</section>
    <section class="iw3-stage-card iw3-stage-card-path">${compactPathMarkup(projection, now)}</section>
    ${activityCapsuleMarkup(projection, "DETECT", run)}
  </div>`;
}

function triageMarkup(projection, run, now) {
  const facts = run.output?.facts || [];
  const unknowns = run.output?.unknowns || [];
  return `<div class="iw3-stage-deck">
    <section class="iw3-stage-card iw3-stage-card-path">${compactPathMarkup(projection, now)}</section>
    ${triageIsBounded(run) ? `<section class="iw3-stage-card iw3-stage-card-stats"><strong>${facts.length} facts</strong><strong>${unknowns.length} open question${unknowns.length === 1 ? "" : "s"}</strong></section>` : ""}
    ${activityCapsuleMarkup(projection, "TRIAGE", run)}
  </div>`;
}

function investigateMarkup(projection, run, now) {
  const hypotheses = (projection.hypotheses || []).filter((item) => item.stage_run_id === run.stage_run_id);
  const queries = (projection.evidence_queries || []).filter((item) => item.stage_run_id === run.stage_run_id);
  const leading = leadingHypothesis(hypotheses);
  return `<div class="iw3-stage-deck">
    <section class="iw3-stage-card iw3-stage-card-path">${compactPathMarkup(projection, now)}</section>
    <section class="iw3-stage-card iw3-stage-card-stats"><strong>${leading ? `${Math.round(Number(leading.confidence || 0) * 100)}%` : "—"}</strong><strong>${queries.length === 1 ? "1 query" : `${queries.length} queries`}</strong><button type="button" data-open-panel="evidence">Evidence</button></section>
    ${activityCapsuleMarkup(projection, "INVESTIGATE", run)}
  </div>`;
}

function decideMarkup(projection, run, now) {
  return `<div class="iw3-stage-deck">
    <section class="iw3-stage-card iw3-stage-card-path">${compactPathMarkup(projection, now)}</section>
    ${activityCapsuleMarkup(projection, "DECIDE", run)}
  </div>`;
}

function respondMarkup(projection, run, pending, now) {
  const actions = (projection.actions || []).filter((action) =>
    action.attempt_id === projection.current_attempt.attempt_id
    && action.stage_run_id === run.stage_run_id
  );
  const available = new Set(projection.available_commands || []);
  return `<div class="iw3-stage-deck iw3-action-list">${actions.map((action) => {
    const revisionCurrent = action.decision_revision === projection.decision_revision;
    const preflight = actionPreflight(projection, action);
    const canApprove = Boolean(preflight) && action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("APPROVE_ACTION") && !pending;
    const canReject = Boolean(preflight) && action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("REJECT_ACTION") && !pending;
    const label = approvedActionLabel(action) || "Action";
    return `<article class="iw3-stage-card iw3-action-card" data-action-id="${escapeHtml(action.action_id)}"><header><strong>${label}</strong><span>${escapeHtml(action.status === "AWAITING_APPROVAL" ? "Approval required" : titleCase(action.status))}</span></header>${preflight ? `<div class="iw3-action-chips"><span>paymentUnreachable: on → off</span><span>Checkout: recreate</span><span>Scope: local Astronomy Shop</span></div>` : '<div class="iw3-action-chips"><span>Revalidation required</span></div>'}<button type="button" data-open-panel="action">Action details</button>${action.status === "AWAITING_APPROVAL" ? `<div class="iw3-action-buttons"><button type="button" data-action-decision="REJECT_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canReject ? "" : " disabled"}>Reject</button><button type="button" class="is-primary" data-action-decision="APPROVE_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canApprove ? "" : " disabled"}>${pending ? "Working…" : "Approve action"}</button></div>` : ""}</article>`;
  }).join("")}${activityCapsuleMarkup(projection, "RESPOND", run)}</div>`;
}

function verifyMarkup(projection, run, series, now) {
  const deadline = Date.parse(run.verification_deadline_at || "");
  const remaining = Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - (now ?? Date.now())) / 1000))
    : null;
  return `<div class="iw3-stage-deck">
    <section class="iw3-stage-card iw3-stage-card-observation"><strong data-verification-remaining${Number.isFinite(deadline) ? ` data-deadline="${escapeHtml(run.verification_deadline_at)}"` : ""}>${remaining === null ? "—" : escapeHtml(formatDuration(remaining))}</strong><span data-tone="${escapeHtml(graphHealth(projection, now))}">${escapeHtml(titleCase(graphHealth(projection, now)))}</span></section>
    <section class="iw3-stage-card iw3-stage-card-signals">${signalCardsMarkup(series)}</section>
    ${activityCapsuleMarkup(projection, "VERIFY", run)}
  </div>`;
}

function footerMarkup(view, available, availableRerunStages, canNext, pending) {
  const run = view.visibleRun;
  if (view.reviewingHistory) {
    const canRerun = available.has("RERUN_FROM_STAGE") && availableRerunStages.includes(view.visibleStage);
    return `<footer class="iw3-action-footer"><button type="button" data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="${escapeHtml(view.visibleStage)}"${canRerun && !pending ? "" : " disabled"}>Rerun from this stage</button></footer>`;
  }
  const failed = ["FAILED", "NEEDS_HUMAN"].includes(run?.status);
  const terminal = view.currentStage === "VERIFY";
  const revalidation = run?.failure_code === "REVALIDATION_REQUIRED" && available.has("RERUN_FROM_STAGE");
  const branchTarget = terminal && failed && available.has("RERUN_FROM_STAGE")
    ? (["DECIDE", "INVESTIGATE"].find((stage) => availableRerunStages.includes(stage)) || null)
    : null;
  const recovery = revalidation || branchTarget;
  const rerunTarget = revalidation ? "DECIDE" : branchTarget;
  const rerunLabel = `Rerun from ${stageLabel(rerunTarget || "DECIDE")}`;
  return `<footer class="iw3-action-footer"><div class="iw3-footer-actions">${failed && available.has("RETRY") ? `<button type="button" data-workflow-command="RETRY"${pending ? " disabled" : ""}>Retry</button>` : ""}${recovery ? `<button type="button" class="is-primary" data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="${escapeHtml(rerunTarget)}"${pending ? " disabled" : ""}>${escapeHtml(rerunLabel)}</button>` : ""}<button type="button" data-workflow-command="ESCALATE"${available.has("ESCALATE") && !pending ? "" : " disabled"}>Escalate</button>${recovery ? "" : `<button type="button" class="is-primary" data-workflow-command="${terminal ? "COMPLETE_INCIDENT" : "NEXT"}"${canNext && !pending ? " disabled" : ""}>${pending ? "Working…" : terminal ? "Complete incident" : "Next"}</button>`}</div></footer>`;
}

function commandErrorMarkup(error) {
  if (!error) return "";
  if (error === "control_plane_revalidation_required") {
    return '<div class="iw3-command-error" role="alert"><strong>Revalidation required</strong></div>';
  }
  return "";
}

function panelMarkup(view, projection, ui) {
  if (!ui.panel) return "";
  if (ui.panel === "graph") return graphModalMarkup(view, projection, ui.componentId, ui.now, ui.series);
  const title = ({ metrics: "Monitor", evidence: "Evidence", activity: "Activity", timeline: "Timeline", component: "Component", action: "Action details", audit: "Immutable incident audit" })[ui.panel] || "Detail";
  let body = "";
  if (ui.panel === "metrics") body = signalCardsMarkup(ui.series, true);
  else if (ui.panel === "activity") body = activityMarkup(projection, view.visibleStage, { stageRunId: view.visibleRun?.stage_run_id });
  else if (ui.panel === "evidence") body = evidenceMarkup(view.visibleRun, projection);
  else if (ui.panel === "component") body = componentMarkup(projection, ui.componentId);
  else if (ui.panel === "action") body = actionDetailMarkup(projection, view.visibleRun);
  else if (ui.panel === "audit") body = auditDetailMarkup(projection);
  else body = timelineMarkup(projection, view);
  return `<section class="iw3-detail-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-detail-title" tabindex="-1" data-workbench-modal><div class="iw3-detail${ui.panel === "audit" ? " is-audit" : ""}"><header><h3 id="iw3-detail-title">${escapeHtml(title)}</h3><button type="button" data-panel-close aria-label="Close ${escapeHtml(title)}">Close</button></header><div class="iw3-detail-body">${body}</div></div></section>`;
}

function actionDetailMarkup(projection, run) {
  const action = currentAction(projection, run)
    || (projection.actions || []).find((item) => item.receipt?.receipt_id === projection.current_attempt?.action_receipt_id)
    || null;
  if (!action) return '<p class="iw3-empty">No action is available for this stage.</p>';
  const candidate = actionPreflight(projection, action);
  return `<article class="iw3-action-detail"><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.summary || "")}</p><dl class="iw3-record"><div><dt>Command</dt><dd>${escapeHtml(action.command_label || action.command_id)}</dd></div><div><dt>Scope</dt><dd>${escapeHtml(action.blast_radius || "Not published")}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(action.risk || "Not published")}</dd></div><div><dt>Rollback</dt><dd>${escapeHtml(action.rollback_plan || "Not published")}</dd></div>${candidate ? `<div><dt>Preflight</dt><dd>${escapeHtml(candidate.observed_before)} → paymentUnreachable=off</dd></div>` : ""}</dl>${listMarkup(action.verification_conditions, "No verification conditions published.")}${receiptMarkup(action.receipt)}${rollbackReceiptMarkup(action.rollback_receipt)}</article>`;
}

function graphModalMarkup(view, projection, selectedComponent, now, series) {
  const impacted = new Set(projection.impacted_path || []);
  const relations = (projection.graph?.edges || [])
    .filter((edge) => impacted.has(edge.source_component_id) || impacted.has(edge.target_component_id));
  const componentIds = new Set([...impacted, ...relations.flatMap((edge) => [edge.source_component_id, edge.target_component_id])]);
  const topology = incidentTopologyView({
    graph: projection.graph,
    impacted_path: [...componentIds],
    incident_focus: { incident_relation_edge_ids: relations.map((edge) => edge.edge_id) }
  });
  const compact = topology.available && topology.nodes.length >= 2 && topology.nodes.length <= 3;
  const positions = compact
    ? new Map(topology.nodes.map((node, index) => [node.component_id, {
      x: topology.nodes.length === 2 ? 32 + index * 36 : 20 + index * 30,
      y: 50
    }]))
    : topology.positions;
  const activeEdges = graphFreshness(projection, now) === "CURRENT"
    ? new Set((projection.graph?.active_pulses || []).filter((pulse) => Date.parse(pulse.expires_at) > (now ?? Date.now())).flatMap((pulse) => pulse.edge_ids))
    : new Set();
  const nodeById = new Map(topology.nodes.map((node) => [node.component_id, node]));
  const edges = topology.available ? topology.edges.map((edge) => {
    const source = positions.get(edge.source_component_id);
    const target = positions.get(edge.target_component_id);
    if (!source || !target) return "";
    const middle = (source.x + target.x) / 2;
    const d = `M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}`;
    const tone = graphEdgeTone(edge, nodeById, projection, now);
    return `<path class="iw3-graph-edge is-${tone}" d="${d}"/>${activeEdges.has(edge.edge_id) ? `<path class="iw3-graph-pulse is-${tone}" d="${d}"/>` : ""}`;
  }).join("") : "";
  const nodes = topology.available ? topology.nodes.map((node) => {
    const position = positions.get(node.component_id);
    const tone = graphNodeTone(node, projection, now);
    return `<button type="button" class="iw3-graph-node is-${tone}${node.component_id === selectedComponent ? " is-selected" : ""}" data-graph-node="${escapeHtml(node.component_id)}" data-graph-x="${position.x}" data-graph-y="${position.y}"><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(titleCase(node.runtime_status))}</small></button>`;
  }).join("") : '<p class="iw3-graph-unavailable">No evidence-backed impact graph is available.</p>';
  const selected = nodeById.get(selectedComponent) || null;
  const metric = selected ? componentMetricLabel(series, selected.component_id) : null;
  const readOnly = view.reviewingHistory || projection.lifecycle_state === "RESOLVED" || projection.current_attempt?.status === "COMPLETED";
  const canInvestigateNode = !readOnly && view.currentStage === "INVESTIGATE" && view.visibleStage === "INVESTIGATE";
  return `<section class="iw3-graph-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-graph-title" tabindex="-1" data-workbench-modal data-graph-modal><div class="iw3-graph-dialog${compact ? " is-compact" : ""}"><header><div><span>${stageLabel(view.visibleStage)}</span><h3 id="iw3-graph-title">Dataflow</h3></div><button type="button" data-graph-close aria-label="Close Dataflow">Close</button></header><div class="iw3-graph-legend"><span data-tone="affected">Red: affected</span><span data-tone="healthy">Green: healthy</span><span data-tone="observed">Moving pulse: observed traffic</span><span data-tone="stale">Gray: no recent traffic / stale</span></div><div class="iw3-graph-canvas" role="region" aria-label="Evidence-backed incident topology" data-graph-layout="${compact ? "compact" : "topology"}"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodes}</div>${selected ? `<aside class="iw3-node-peek"><div><span>Selected component</span><h4>${escapeHtml(selected.display_name)}</h4><p>${escapeHtml(titleCase(selected.runtime_status))} · ${escapeHtml(titleCase(selected.impact_status))} · ${escapeHtml(metric || (graphFreshness(projection, now) === "CURRENT" ? "Fresh" : "Stale"))}</p></div>${readOnly ? `<span class="iw3-read-only-note">${view.reviewingHistory ? "Historical graph · read-only" : "Read-only"}</span>` : canInvestigateNode ? `<button type="button" data-agent-investigate="${escapeHtml(selected.component_id)}">Let Agent investigate this node</button>` : ""}</aside>` : ""}</div></section>`;
}

function signalCardsMarkup(collection, expanded = false) {
  const width = expanded ? 520 : 240;
  const height = 76;
  const allPaths = metricSeriesPathsV3(collection || { series: [] }, width, height);
  const paths = expanded ? allPaths : allPaths.slice(0, 3);
  const seriesById = new Map((collection?.series || []).map((series) => [series.series_id, series]));
  return `<div class="iw3-signal-cards${expanded ? " is-expanded" : ""}">${paths.map((path) => {
    const series = seriesById.get(path.seriesId);
    const latest = series?.points?.at(-1) || null;
    const current = latest && typeof latest.value === "number" && Number.isFinite(latest.value) ? latest : null;
    const tone = signalTone(series, current);
    const currentLabel = current
      ? formatMetric(current.value, series.unit)
      : expanded ? `Unavailable${latest?.missing_reason ? ` · ${titleCase(latest.missing_reason)}` : ""}` : "No sample";
    const trend = metricTrendV3(series);
    const observedStart = Date.parse(series?.observed_window_start || "");
    const observedEnd = Date.parse(series?.observed_window_end || "");
    const observedSeconds = Number.isFinite(observedStart) && Number.isFinite(observedEnd)
      ? Math.max(0, Math.round((observedEnd - observedStart) / 1000))
      : null;
    const d = path.segments.map((segment) => segment.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
    const fill = `var(--${({ affected: "red", warning: "amber", healthy: "green", observed: "blue" })[tone] || "faint"})`;
    const areas = path.segments.filter((segment) => segment.length > 1).map((segment, index) => `<polygon class="iw3-signal-area" data-series-segment="${index}" fill="${fill}" fill-opacity="0.12" points="${segment.map((point) => `${point.x},${point.y}`).join(" ")} ${segment.at(-1).x},${height} ${segment[0].x},${height}"/>`).join("");
    const compactFooter = `<span data-tone="${escapeHtml(String(series?.freshness || "unknown").toLowerCase())}">${escapeHtml(titleCase(series?.freshness || "unknown"))}</span>`;
    const detailFooter = `<span>${path.segments.reduce((count, segment) => count + segment.length, 0)} samples</span><span data-trend="${escapeHtml(trend.direction)}">${escapeHtml(trend.label)}</span><span>${observedSeconds === null ? "Window pending" : `${escapeHtml(formatDuration(observedSeconds))} window`}</span><span>${escapeHtml(thresholdCopy(series?.thresholds, series?.unit))}</span><span>${escapeHtml(titleCase(series?.freshness || "unknown"))} · ${escapeHtml(shortTime(latest?.timestamp))}</span>`;
    const label = expanded ? series?.label || series?.metric_key || path.seriesId : compactMetricLabel(series);
    return `<article class="iw3-signal-card" data-series-id="${escapeHtml(path.seriesId)}" data-tone="${tone}"><header><div><span>${escapeHtml(series?.component_id || "Component")}</span><h5>${escapeHtml(label)}</h5></div><strong>${escapeHtml(currentLabel)}</strong></header><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series?.label || path.seriesId)} samples">${areas}${d.map((value) => `<path d="${value}"/>`).join("")}</svg><footer>${expanded ? detailFooter : compactFooter}</footer></article>`;
  }).join("") || '<p class="iw3-empty">Waiting for typed metric samples.</p>'}</div>`;
}

function compactMetricLabel(series) {
  const key = String(series?.metric_key || "").toLowerCase();
  if (key.includes("error")) return "Errors";
  if (key.includes("latency") || key.includes("duration")) return "Latency";
  if (key.includes("request")) return "Traffic";
  return "Signal";
}

function signalTone(series, current) {
  if (!current || String(series?.freshness || "").toUpperCase() !== "CURRENT") return "stale";
  const critical = typeof series?.thresholds?.critical === "number" ? series.thresholds.critical : null;
  const warning = typeof series?.thresholds?.warning === "number" ? series.thresholds.warning : null;
  if (Number.isFinite(critical) && current.value >= critical) return "affected";
  if (Number.isFinite(warning) && current.value >= warning) return "warning";
  return Number.isFinite(critical) || Number.isFinite(warning) ? "healthy" : "observed";
}

function graphEdgeTone(edge, nodes, projection, now) {
  if (graphFreshness(projection, now) !== "CURRENT") return "stale";
  const tones = [nodes.get(edge.source_component_id), nodes.get(edge.target_component_id)].filter(Boolean).map((node) => graphNodeTone(node, projection, now));
  if (tones.includes("affected")) return "affected";
  return tones.every((tone) => tone === "healthy") ? "healthy" : "observed";
}

function componentMetricLabel(collection, componentId) {
  const series = (collection?.series || []).find((item) => item.component_id === componentId && /error|latency|duration/.test(item.metric_key || "") && typeof item.points?.at(-1)?.value === "number")
    || (collection?.series || []).find((item) => item.component_id === componentId && typeof item.points?.at(-1)?.value === "number");
  const point = series?.points?.at(-1);
  return point ? `${compactMetricLabel(series)} ${formatMetric(point.value, series.unit)}` : null;
}

function activityMarkup(projection, stage, { roles = null, excludeRoles = [], stageRunId = null } = {}) {
  const items = (projection.agent_activity || []).filter((activity) => activity.stage === stage
    && (!stageRunId || activity.stage_run_id === stageRunId)
    && (!roles || roles.includes(activity.role)) && !excludeRoles.includes(activity.role));
  return `<ol class="iw3-activity-list">${items.map((activity) => `<li data-state="${escapeHtml(activity.state.toLowerCase())}"><span aria-hidden="true"></span><div><strong>${escapeHtml(activity.label)}</strong><p>${escapeHtml(activity.summary)}</p><small>${escapeHtml(stateLabel(activity.state))} · ${escapeHtml(shortTime(activity.occurred_at))} · ${(activity.evidence_refs || []).length} evidence</small></div></li>`).join("") || "<li>No Agent activity has been published for this stage.</li>"}</ol>`;
}

function evidenceQueryMarkup(projection, run, expanded = false) {
  const queries = (projection.evidence_queries || []).filter((query) => query.stage_run_id === run?.stage_run_id);
  return `<ol class="iw3-query-list${expanded ? " is-expanded" : ""}">${queries.map((query) => {
    const scope = [...(query.component_ids || []), ...(query.edge_ids || [])];
    const observations = query.observation_timestamps || [];
    return `<li data-query-id="${escapeHtml(query.query_id)}" data-state="${escapeHtml(query.state.toLowerCase())}"><header><div><span>Allowlisted query</span><code>${escapeHtml(query.query_name)}</code></div><strong>${escapeHtml(stateLabel(query.state))}</strong></header><p>${escapeHtml(query.result_summary)}</p><footer><span>${scope.length} topology refs</span><span>${(query.evidence_refs || []).length} evidence</span><span>${observations.length} samples${observations.length ? ` · ${escapeHtml(shortTime(observations.at(-1)))}` : ""}</span>${query.triggered_replan ? "<mark>Replan triggered</mark>" : ""}</footer>${expanded ? `<dl class="iw3-record"><div><dt>Worker activity</dt><dd><code>${escapeHtml(query.worker_activity_id)}</code></dd></div><div><dt>Scope</dt><dd>${escapeHtml(scope.join(", ") || "No topology references")}</dd></div><div><dt>Observed</dt><dd>${escapeHtml(observations.join(", ") || "No completed observations")}</dd></div>${query.failure_code ? `<div><dt>Failure</dt><dd>${escapeHtml(query.failure_code)}</dd></div>` : ""}</dl><ul class="iw3-evidence-list">${(query.evidence_refs || []).map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("") || "<li>No query evidence references published.</li>"}</ul>` : ""}</li>`;
  }).join("") || '<li class="iw3-empty">Waiting for the Evidence Worker to execute an allowlisted query.</li>'}</ol>`;
}

function evidenceMarkup(run, projection) {
  return `<div class="iw3-evidence-detail"><section><h4>Evidence Worker queries</h4>${evidenceQueryMarkup(projection, run, true)}</section><section><h4>Stage evidence references</h4><ul class="iw3-evidence-list">${(run?.evidence_refs || []).map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("") || "<li>No stage evidence references published.</li>"}</ul></section></div>`;
}

function componentMarkup(projection, componentId) {
  const node = (projection.graph?.nodes || []).find((candidate) => candidate.component_id === componentId);
  if (!node) return '<p class="iw3-empty">Select a component from the diagnostic graph.</p>';
  return `<article class="iw3-component"><span>${escapeHtml(titleCase(node.impact_status))}</span><h4>${escapeHtml(node.display_name)}</h4><p>${escapeHtml(titleCase(node.runtime_status))}</p></article>`;
}

function timelineMarkup(projection, view) {
  return `<ol class="iw3-timeline">${view.rail.filter((item) => item.run).map((item) => `<li><span>${escapeHtml(shortTime(item.run.started_at))}</span><strong>${stageLabel(item.stage)}</strong><small>${stateLabel(item.status)}</small></li>`).join("")}</ol>`;
}

function listMarkup(items, empty) {
  return `<ul class="iw3-record-list">${(items || []).map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.statement || item.summary || (item.label && item.value ? `${item.label}: ${item.value}` : JSON.stringify(item)))}</li>`).join("") || `<li>${escapeHtml(empty)}</li>`}</ul>`;
}

function recordMarkup(value, empty) {
  if (value === null || value === undefined) return `<p class="iw3-empty">${escapeHtml(empty)}</p>`;
  if (typeof value === "string") return `<p>${escapeHtml(value)}</p>`;
  if (Array.isArray(value)) return listMarkup(value, empty);
  return `<dl class="iw3-record">${Object.entries(value).map(([key, item]) => `<div><dt>${escapeHtml(titleCase(key))}</dt><dd>${escapeHtml(Array.isArray(item) ? item.join(", ") : typeof item === "object" ? JSON.stringify(item) : String(item))}</dd></div>`).join("")}</dl>`;
}

function receiptMarkup(receipt) {
  return receipt ? `<div class="iw3-receipt" data-receipt-id="${escapeHtml(receipt.receipt_id || "recorded")}"><strong>Execution receipt</strong><code>${escapeHtml(receipt.receipt_id || receipt.status || "Recorded")}</code><span>${escapeHtml(receipt.output_summary || titleCase(receipt.status))}</span><small>${escapeHtml(shortTime(receipt.started_at))} → ${escapeHtml(shortTime(receipt.completed_at))} · ${escapeHtml(titleCase(receipt.status))}</small></div>` : "";
}

function rollbackReceiptMarkup(receipt) {
  return receipt ? `<div class="iw3-receipt is-rollback" data-rollback-receipt-id="${escapeHtml(receipt.rollback_receipt_id)}"><strong>Safe rollback receipt</strong><code>${escapeHtml(receipt.rollback_receipt_id)}</code><span>${escapeHtml(receipt.output_summary)}</span><small>${escapeHtml(shortTime(receipt.started_at))} → ${escapeHtml(shortTime(receipt.completed_at))} · ${escapeHtml(titleCase(receipt.status))}</small></div>` : "";
}

function thresholdCopy(thresholds, unit) {
  if (!thresholds || (thresholds.warning === null && thresholds.critical === null && thresholds.warning === undefined && thresholds.critical === undefined)) return "No threshold";
  const critical = thresholds.critical ?? thresholds.warning;
  return `Threshold ${formatMetric(critical, unit)}`;
}

function loadingMarkup(error) {
  return `<div class="iw3-shell is-loading"><main class="iw3-loading" role="${error ? "alert" : "status"}"><span aria-hidden="true"></span><h2>${error ? "Incident unavailable" : "Opening incident"}</h2><p>${escapeHtml(error || "Loading the canonical workflow state.")}</p>${error ? '<button type="button" data-workbench-retry>Retry</button>' : ""}</main></div>`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatMetric(value, unit) {
  const formatted = Number.isInteger(value) ? String(value) : Number(value).toLocaleString("en", { maximumFractionDigits: 2 });
  return unit === "percent" || unit === "%" ? `${formatted}%` : unit === "ms" ? `${formatted} ms` : unit ? `${formatted} ${unit}` : formatted;
}

function formatPercentChange(value) {
  if (!Number.isFinite(value)) return "";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function shortTime(value) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) return "Unavailable";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(parsed));
}

function stageLabel(stage) {
  return ({ DETECT: "Detect", TRIAGE: "Triage", INVESTIGATE: "Investigate", DECIDE: "Decide", RESPOND: "Respond", VERIFY: "Verify" })[stage] || titleCase(stage);
}

function stateLabel(state) {
  return ({ LOCKED: "Locked", READY: "Ready", RUNNING: "Running", SUCCEEDED: "Complete", FAILED: "Failed", NEEDS_HUMAN: "Needs human", SUPERSEDED: "Superseded", COMPLETED: "Complete", DEGRADED: "Degraded", STARTED: "Started" })[state] || titleCase(state || "unknown");
}

function connectionCopy(state) {
  return ({ connected: "Live updates connected", connecting: "Connecting to live updates", reconnecting: "Reconnecting to live updates", stale: "Live updates are stale", degraded: "Live updates unavailable" })[state] || "Live updates unavailable";
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/(^|_)([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function setParam(url, key, value) {
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

import { incidentTopologyView } from "./control-plane-topology-layout.mjs";
import { INCIDENT_STAGES_V3, STAGE_STATES_V3, WORKFLOW_COMMANDS_V3 } from "./incident-v3-types.mjs";

export { INCIDENT_STAGES_V3, STAGE_STATES_V3 } from "./incident-v3-types.mjs";
const PANELS = new Set(["metrics", "evidence", "activity", "timeline", "component", "graph", "audit"]);
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
    <header class="iw3-command-bar">
      <div class="iw3-command-title"><span class="iw3-severity">${escapeHtml(projection.severity)}</span><div><h2>${escapeHtml(projection.title)}</h2><p>${escapeHtml(projection.summary)}</p></div></div>
      <dl class="iw3-command-facts">
        <div><dt>State</dt><dd>${escapeHtml(titleCase(projection.lifecycle_state))}</dd></div>
        <div><dt>Duration</dt><dd data-incident-duration>${escapeHtml(formatDuration(duration.elapsed_seconds))}</dd></div>
        <div><dt>Freshness</dt><dd class="is-${escapeHtml(String(freshness).toLowerCase())}">${escapeHtml(titleCase(freshness))}</dd></div>
        <div><dt>Owner</dt><dd>${escapeHtml(projection.owner_subject_id)}</dd></div>
        <div><dt>Attempt</dt><dd>#${escapeHtml(String(projection.current_attempt.attempt_number || 1))} · r${escapeHtml(String(projection.workflow_revision))}</dd></div>
      </dl>
      <div class="iw3-stream-state" role="status" data-state="${escapeHtml(connection)}"><span aria-hidden="true"></span>${escapeHtml(connectionCopy(connection))}</div>
    </header>
    ${commandErrorMarkup(ui.error)}
    ${stageRailMarkup(view)}
    <div class="iw3-workspace-body">
      <main class="iw3-stage-surface" id="incident-stage-surface" tabindex="-1">
        ${view.reviewingHistory ? '<div class="iw3-review-banner"><strong>Reviewing completed stage</strong><span>This history is read-only. Rerun explicitly to change the workflow.</span></div>' : ""}
        ${stageMarkup(view, projection, ui)}
      </main>
      ${agentRoomMarkup(projection, view)}
    </div>
    ${footerMarkup(view, available, projection.available_rerun_stages || [], canNext, ui.commandPending)}
    ${panelMarkup(view, projection, ui)}
  </div>`;
}

function finalAuditMarkup(projection, duration, connection, ui, view) {
  const report = projection.final_report || null;
  const verify = projection.current_attempt.stage_runs.find((run) => run.stage === "VERIFY") || null;
  const action = [...(projection.actions || [])].reverse().find((item) => item.receipt) || null;
  const completedAt = projection.current_attempt.completed_at || report?.generated_at || verify?.completed_at;
  const completedSeries = metricSeriesAt(ui.series, completedAt);
  const completedUi = { ...ui, series: completedSeries };
  const startedAtMs = Date.parse(projection.incident_clock?.started_at || "");
  const completedAtMs = Date.parse(completedAt || "");
  const completedElapsed = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000))
    : duration.elapsed_seconds;
  const primary = view.reviewingHistory
    ? `<main class="iw3-stage-surface" id="incident-stage-surface" tabindex="-1"><div class="iw3-review-banner"><strong>Reviewing completed stage</strong><span>This resolved incident is read-only.</span></div>${stageMarkup(view, projection, completedUi)}</main>`
    : `<main class="iw3-resolution-surface" id="incident-stage-surface" tabindex="-1">
        <header class="iw3-resolution-hero"><div><span>Incident resolved</span><h3>Recovery verified</h3><p>${escapeHtml(verify?.output?.summary || verify?.summary || "Fresh post-action evidence satisfied the recovery conditions.")}</p></div><button type="button" data-open-panel="audit">Open audit details</button></header>
        <div class="iw3-resolution-grid">
          <section class="iw3-panel iw3-resolution-signals"><div class="iw3-panel-heading"><h4>Recovered signals</h4><button type="button" data-open-panel="metrics">Open metrics</button></div>${signalCardsMarkup(completedSeries)}</section>
          <section class="iw3-panel"><h4>Verification evidence</h4>${listMarkup((verify?.output?.facts || []).slice(0, 4), "No verification facts were published.")}</section>
          <section class="iw3-panel"><h4>Executed response</h4><strong class="iw3-resolution-action">${escapeHtml(action?.title || "Restore Payment reachability")}</strong><p>${escapeHtml(action?.receipt?.output_summary || "The bounded response completed before verification.")}</p><small>${escapeHtml(action?.component_id || "checkout")} · ${escapeHtml(titleCase(action?.execution_state || "succeeded"))}</small></section>
        </div>
      </main>`;
  return `<div class="iw3-shell iw3-resolved-shell" data-audit-report="${escapeHtml(report?.report_id || "unavailable")}" data-connection="${escapeHtml(connection)}">
    <header class="iw3-command-bar iw3-resolved-command">
      <div class="iw3-command-title"><span class="iw3-severity is-resolved">RESOLVED</span><div><h2>${escapeHtml(projection.title)}</h2><p>Checkout to Payment recovery was verified with fresh post-action telemetry.</p></div></div>
      <dl class="iw3-command-facts">
        <div><dt>State</dt><dd class="is-current">Resolved</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(completedElapsed))}</dd></div>
        <div><dt>Completed</dt><dd>${escapeHtml(shortTime(completedAt))}</dd></div>
        <div><dt>Owner</dt><dd>${escapeHtml(projection.owner_subject_id)}</dd></div>
        <div><dt>Attempt</dt><dd>#${escapeHtml(String(projection.current_attempt.attempt_number || 1))}</dd></div>
      </dl>
      <div class="iw3-stream-state" role="status" data-state="resolved"><span aria-hidden="true"></span>Audit sealed</div>
    </header>
    ${stageRailMarkup(view)}
    <div class="iw3-workspace-body">
      ${primary}
      ${agentRoomMarkup(projection, view, { completed: !view.reviewingHistory })}
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

function stageRailMarkup(view) {
  return `<nav class="iw3-stage-rail" aria-label="Incident workflow">${view.rail.map((item, index) => `<button type="button" class="iw3-stage-step${item.current ? " is-current" : ""}${item.visible ? " is-visible" : ""}" data-stage="${item.stage}" data-stage-status="${item.status}"${item.current || item.reviewable ? "" : " disabled"}${item.current ? ' aria-current="step"' : ""}><span>${index + 1}</span><strong>${stageLabel(item.stage)}</strong><small>${stateLabel(item.status)}</small></button>`).join("")}</nav>`;
}

function stageMarkup(view, projection, ui) {
  const run = view.visibleRun;
  if (!run) return `<section class="iw3-stage-empty" aria-labelledby="iw3-stage-title"><h3 id="iw3-stage-title">${stageLabel(view.visibleStage)}</h3><p>This stage has not started.</p></section>`;
  const header = `<header class="iw3-stage-heading"><div><span>${stageLabel(view.visibleStage)}</span><h3 id="iw3-stage-title">${escapeHtml(stageHeadline(view.visibleStage, run))}</h3><p>${escapeHtml(run.summary || stageDescription(view.visibleStage))}</p></div><div class="iw3-run-state" data-state="${escapeHtml(run.status.toLowerCase())}"><span aria-hidden="true"></span>${escapeHtml(stateLabel(run.status))}${run.status === "RUNNING" ? ` · ${run.progress_percent}%` : ""}</div></header>`;
  const content = ({
    DETECT: () => detectMarkup(projection, run, ui.series),
    TRIAGE: () => triageMarkup(projection, run),
    INVESTIGATE: () => investigateMarkup(projection, run),
    DECIDE: () => decideMarkup(projection, run),
    RESPOND: () => respondMarkup(projection, run, ui.commandPending),
    VERIFY: () => verifyMarkup(projection, run, ui.series, ui.now)
  })[view.visibleStage]();
  const failure = ["FAILED", "NEEDS_HUMAN"].includes(run.status)
    ? `<div class="iw3-stage-failure" role="alert"><strong>${escapeHtml(run.failure_code || stateLabel(run.status))}</strong><span>${escapeHtml(run.summary || "This stage requires operator attention.")}</span></div>`
    : "";
  return `<section class="iw3-stage" aria-labelledby="iw3-stage-title">${header}${failure}${content}</section>`;
}

function detectMarkup(projection, run, series) {
  return `<div class="iw3-detect-grid">
    <section class="iw3-panel iw3-signals"><div class="iw3-panel-heading"><h4>Live signals</h4><button type="button" data-open-panel="metrics">Open metrics</button></div>${signalCardsMarkup(series)}</section>
    <section class="iw3-panel"><h4>Impact path</h4>${impactPathMarkup(projection)}${projection.current_attempt.current_stage === "INVESTIGATE" ? '<button type="button" data-open-panel="graph">Open diagnostic graph</button>' : ""}</section>
    <section class="iw3-panel"><h4>Sources</h4><ul class="iw3-compact-list">${(projection.connectors || []).map((connector) => `<li><span>${escapeHtml(titleCase(connector.provider))}</span><strong>${escapeHtml(titleCase(connector.state))}</strong><small>${escapeHtml(shortTime(connector.observed_at))} · ${escapeHtml(String(connector.lag_seconds ?? 0))}s lag</small></li>`).join("") || "<li>No connector status published.</li>"}</ul></section>
    ${factsMarkup(run.output)}
  </div>`;
}

function triageMarkup(projection, run) {
  return `<div class="iw3-stage-grid"><section class="iw3-panel"><h4>Confirmed facts</h4>${listMarkup(run.output?.facts, "No confirmed facts yet.")}</section><section class="iw3-panel"><h4>Unknowns</h4>${listMarkup(run.output?.unknowns, "No open unknowns were published.")}</section><section class="iw3-panel iw3-span-two"><h4>Agent workstream</h4>${activityMarkup(projection, "TRIAGE", { stageRunId: run.stage_run_id })}</section></div>`;
}

function investigateMarkup(projection, run) {
  const hypotheses = (projection.hypotheses || []).filter((item) => item.stage_run_id === run.stage_run_id);
  return `<div class="iw3-stage-grid"><section class="iw3-panel"><div class="iw3-panel-heading"><h4>Hypotheses</h4><button type="button" data-open-panel="graph">Open diagnostic graph</button></div>${hypothesisMarkup(hypotheses)}</section><section class="iw3-panel"><h4>Independent critic</h4>${activityMarkup(projection, "INVESTIGATE", { roles: ["CRITIC"], stageRunId: run.stage_run_id })}</section><section class="iw3-panel iw3-span-two"><div class="iw3-panel-heading"><h4>Evidence Worker queries</h4><button type="button" data-open-panel="evidence">Review evidence</button></div>${evidenceQueryMarkup(projection, run)}${activityMarkup(projection, "INVESTIGATE", { excludeRoles: ["CRITIC", "EVIDENCE_WORKER"], stageRunId: run.stage_run_id })}</section></div>`;
}

function decideMarkup(projection, run) {
  const hypothesisIds = new Set(run.output?.hypothesis_ids || []);
  const rootCause = run.output?.root_cause || null;
  const candidates = (projection.hypotheses || []).filter((item) =>
    hypothesisIds.has(item.hypothesis_id) || (rootCause && item.statement === rootCause)
  );
  const likely = [...candidates].sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0];
  const actionIds = new Set(run.output?.action_ids || []);
  const recommendation = run.output?.action_candidate
    || (projection.actions || []).find((item) => actionIds.has(item.action_id));
  return `<div class="iw3-stage-grid"><section class="iw3-panel"><h4>Most likely cause</h4>${rootCause ? `<p class="iw3-root-cause">${escapeHtml(rootCause)}</p>${likely ? hypothesisMarkup([likely]) : ""}` : '<p class="iw3-empty">No root-cause decision has been published.</p>'}</section><section class="iw3-panel"><h4>Recommended response</h4>${recommendation ? actionDecisionMarkup(recommendation) : '<p class="iw3-empty">No response candidate has been published.</p>'}</section><section class="iw3-panel"><h4>Decision evidence</h4>${listMarkup(run.output?.facts, "No decision facts published.")}</section><section class="iw3-panel"><h4>Risk, rollback, verification</h4>${recommendation ? `<dl class="iw3-record"><div><dt>Blast radius</dt><dd>${escapeHtml(recommendation.blast_radius)}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(recommendation.risk)}</dd></div><div><dt>Rollback</dt><dd>${escapeHtml(recommendation.rollback_plan)}</dd></div></dl>${listMarkup(recommendation.verification_conditions, "No verification conditions published.")}` : '<p class="iw3-empty">No bounded action contract has been published.</p>'}</section></div>`;
}

function respondMarkup(projection, run, pending) {
  const actions = (projection.actions || []).filter((action) =>
    action.attempt_id === projection.current_attempt.attempt_id
    && action.stage_run_id === run.stage_run_id
  );
  const available = new Set(projection.available_commands || []);
  return `<div class="iw3-action-list">${actions.map((action) => {
    const revisionCurrent = action.decision_revision === projection.decision_revision;
    const canApprove = action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("APPROVE_ACTION") && !pending;
    const canReject = action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("REJECT_ACTION") && !pending;
    return `<article class="iw3-action-card" data-action-id="${escapeHtml(action.action_id)}"><header><div><span>${escapeHtml(titleCase(action.status))}</span><h4>${escapeHtml(action.title)}</h4></div><strong>${escapeHtml(action.component_id || "Local runtime")}</strong></header><p>${escapeHtml(action.summary || "")}</p><dl><div><dt>Command</dt><dd>${escapeHtml(action.command_label || "Bounded local action")}</dd></div><div><dt>Decision revision</dt><dd>${escapeHtml(String(action.decision_revision ?? projection.decision_revision))}</dd></div><div><dt>Blast radius</dt><dd>${escapeHtml(action.blast_radius || "Not published")}</dd></div><div><dt>Risk</dt><dd>${escapeHtml(action.risk || "Not published")}</dd></div><div><dt>Rollback</dt><dd>${escapeHtml(action.rollback_plan || "Not published")}</dd></div></dl><h5>Verification conditions</h5>${listMarkup(action.verification_conditions, "No verification conditions published.")}${action.status === "AWAITING_APPROVAL" ? `<div class="iw3-action-buttons"><button type="button" data-action-decision="REJECT_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canReject ? "" : " disabled"}>Reject</button><button type="button" class="is-primary" data-action-decision="APPROVE_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canApprove ? "" : " disabled"}>${pending ? "Working…" : "Approve action"}</button></div>` : `${receiptMarkup(action.receipt)}${rollbackReceiptMarkup(action.rollback_receipt)}`}</article>`;
  }).join("") || '<section class="iw3-panel"><h4>No action available</h4><p>The backend has not published an executable response.</p></section>'}</div>`;
}

function verifyMarkup(projection, run, series, now) {
  const action = (projection.actions || []).find((action) =>
    action.receipt?.receipt_id === projection.current_attempt.action_receipt_id
  );
  const deadline = Date.parse(run.verification_deadline_at || "");
  const remaining = Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - (now ?? Date.now())) / 1000))
    : null;
  return `<div class="iw3-stage-grid"><section class="iw3-panel"><h4>Verification status</h4>${recordMarkup(run.output?.summary || run.summary, "Verification is waiting for fresh evidence.")}${listMarkup(run.output?.facts, "No recovery facts published yet.")}</section><section class="iw3-panel"><h4>Observation window</h4><dl class="iw3-record"><div><dt>Progress</dt><dd>${escapeHtml(String(run.progress_percent))}%</dd></div><div><dt>Remaining</dt><dd data-verification-remaining${Number.isFinite(deadline) ? ` data-deadline="${escapeHtml(run.verification_deadline_at)}"` : ""}>${remaining === null ? "Awaiting deadline" : escapeHtml(formatDuration(remaining))}</dd></div><div><dt>Freshness</dt><dd>${escapeHtml(titleCase(projection.freshness.state))}</dd></div><div><dt>Last sample</dt><dd>${escapeHtml(shortTime(projection.freshness.observed_at))}</dd></div></dl>${receiptMarkup(action?.receipt)}${rollbackReceiptMarkup(action?.rollback_receipt)}${listMarkup(run.output?.unknowns, "No unresolved recovery conditions published.")}</section><section class="iw3-panel iw3-span-two"><div class="iw3-panel-heading"><h4>Fresh post-action signals</h4><button type="button" data-open-panel="metrics">Open metrics</button></div>${signalCardsMarkup(series)}</section></div>`;
}

function footerMarkup(view, available, availableRerunStages, canNext, pending) {
  const run = view.visibleRun;
  if (view.reviewingHistory) {
    const canRerun = available.has("RERUN_FROM_STAGE") && availableRerunStages.includes(view.visibleStage);
    return `<footer class="iw3-action-footer"><div><strong>${stageLabel(view.visibleStage)} complete</strong><span>Reviewing immutable run ${escapeHtml(run?.stage_run_id || "")}</span></div><button type="button" data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="${escapeHtml(view.visibleStage)}"${canRerun && !pending ? "" : " disabled"}>Rerun from this stage</button></footer>`;
  }
  const failed = ["FAILED", "NEEDS_HUMAN"].includes(run?.status);
  const terminal = view.currentStage === "VERIFY";
  const revalidation = run?.failure_code === "REVALIDATION_REQUIRED" && available.has("RERUN_FROM_STAGE");
  const branchTarget = terminal && failed && available.has("RERUN_FROM_STAGE")
    ? (["DECIDE", "INVESTIGATE"].find((stage) => availableRerunStages.includes(stage)) || null)
    : null;
  const recovery = revalidation || branchTarget;
  const rerunTarget = revalidation ? "DECIDE" : branchTarget;
  const rerunLabel = branchTarget ? `Branch from ${stageLabel(branchTarget)}` : "Rerun Decide";
  return `<footer class="iw3-action-footer"><div><strong>${escapeHtml(stateLabel(run?.status || "READY"))}</strong><span>${escapeHtml(footerCopy(run))}</span></div><div class="iw3-footer-actions">${failed && available.has("RETRY") ? `<button type="button" data-workflow-command="RETRY"${pending ? " disabled" : ""}>Retry</button>` : ""}${recovery ? `<button type="button" class="is-primary" data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="${escapeHtml(rerunTarget)}"${pending ? " disabled" : ""}>${escapeHtml(rerunLabel)}</button>` : ""}<button type="button" data-workflow-command="ESCALATE"${available.has("ESCALATE") && !pending ? "" : " disabled"}>Escalate</button>${recovery ? "" : `<button type="button" class="is-primary" data-workflow-command="${terminal ? "COMPLETE_INCIDENT" : "NEXT"}"${canNext && !pending ? "" : " disabled"}>${pending ? "Working…" : terminal ? "Complete incident" : "Next"}</button>`}</div></footer>`;
}

function commandErrorMarkup(error) {
  if (!error) return "";
  if (error === "control_plane_revalidation_required") {
    return '<div class="iw3-command-error" role="alert"><strong>Decision inputs changed</strong><span>The latest telemetry no longer matches this decision. Rerun Decide before entering Respond.</span></div>';
  }
  return `<div class="iw3-command-error" role="alert"><strong>Command was not accepted</strong><span>${escapeHtml(error)}</span></div>`;
}

function panelMarkup(view, projection, ui) {
  if (!ui.panel) return "";
  if (ui.panel === "graph") return graphModalMarkup(view, projection, ui.componentId, ui.now);
  const title = ({ metrics: "Metrics", evidence: "Evidence", activity: "Agent activity", timeline: "Timeline", component: "Component", audit: "Immutable incident audit" })[ui.panel] || "Detail";
  let body = "";
  if (ui.panel === "metrics") body = signalCardsMarkup(ui.series, true);
  else if (ui.panel === "activity") body = activityMarkup(projection, view.visibleStage);
  else if (ui.panel === "evidence") body = evidenceMarkup(view.visibleRun, projection);
  else if (ui.panel === "component") body = componentMarkup(projection, ui.componentId);
  else if (ui.panel === "audit") body = auditDetailMarkup(projection);
  else body = timelineMarkup(projection, view);
  return `<section class="iw3-detail-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-detail-title" tabindex="-1" data-workbench-modal><div class="iw3-detail${ui.panel === "audit" ? " is-audit" : ""}"><header><h3 id="iw3-detail-title">${escapeHtml(title)}</h3><button type="button" data-panel-close aria-label="Close ${escapeHtml(title)}">Close</button></header>${body}</div></section>`;
}

function agentRoomMarkup(projection, view, { completed = false } = {}) {
  const items = (projection.agent_activity || []).filter((activity) => completed
    || (activity.stage === view.visibleStage && activity.stage_run_id === view.visibleRun?.stage_run_id)).slice(-8);
  const canInvestigate = !completed && !view.reviewingHistory && view.currentStage === "INVESTIGATE";
  const component = projection.impacted_path?.[0] || null;
  return `<aside class="iw3-agent-room" aria-label="Agent room"><header><div><span>Agent room</span><strong>${completed ? "Incident handoff" : `${stageLabel(view.visibleStage)} team`}</strong></div><small>${items.some((item) => item.state === "RUNNING") ? "Working live" : completed ? "Read-only" : "Current stage"}</small></header><ol>${items.map((activity) => `<li data-state="${escapeHtml(activity.state.toLowerCase())}"><span aria-hidden="true"></span><div><strong>${escapeHtml(activity.label)}</strong><small>${escapeHtml(titleCase(activity.role || "agent"))} · ${escapeHtml(shortTime(activity.occurred_at))}</small><p>${escapeHtml(activity.summary)}</p><em>${(activity.evidence_refs || []).length} evidence</em></div></li>`).join("") || '<li class="iw3-agent-empty">Waiting for the current stage Agent to publish activity.</li>'}</ol>${canInvestigate && component ? `<footer><button type="button" data-agent-investigate="${escapeHtml(component)}">Ask Agent to investigate ${escapeHtml(component)}</button></footer>` : ""}</aside>`;
}

function graphModalMarkup(view, projection, selectedComponent, now) {
  const impacted = new Set(projection.impacted_path || []);
  const relations = (projection.graph?.edges || [])
    .filter((edge) => impacted.has(edge.source_component_id) || impacted.has(edge.target_component_id));
  const componentIds = new Set([...impacted, ...relations.flatMap((edge) => [edge.source_component_id, edge.target_component_id])]);
  const topology = incidentTopologyView({
    graph: projection.graph,
    impacted_path: [...componentIds],
    incident_focus: { incident_relation_edge_ids: relations.map((edge) => edge.edge_id) }
  });
  const activeEdges = new Set((projection.graph?.active_pulses || []).filter((pulse) => Date.parse(pulse.expires_at) > (now ?? Date.now())).flatMap((pulse) => pulse.edge_ids));
  const nodeById = new Map(topology.nodes.map((node) => [node.component_id, node]));
  const edges = topology.available ? topology.edges.map((edge) => {
    const source = topology.positions.get(edge.source_component_id);
    const target = topology.positions.get(edge.target_component_id);
    if (!source || !target) return "";
    const middle = (source.x + target.x) / 2;
    return `<path class="iw3-graph-edge${activeEdges.has(edge.edge_id) ? " is-active" : ""}" d="M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}"/>`;
  }).join("") : "";
  const nodes = topology.available ? topology.nodes.map((node) => {
    const position = topology.positions.get(node.component_id);
    return `<button type="button" class="iw3-graph-node${node.component_id === selectedComponent ? " is-selected" : ""}" data-graph-node="${escapeHtml(node.component_id)}" style="--x:${position.x}%;--y:${position.y}%"><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(titleCase(node.runtime_status))}</small></button>`;
  }).join("") : '<p class="iw3-graph-unavailable">No evidence-backed impact graph is available.</p>';
  const selected = nodeById.get(selectedComponent) || null;
  return `<section class="iw3-graph-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-graph-title" tabindex="-1" data-workbench-modal data-graph-modal><div class="iw3-graph-dialog"><header><div><span>${stageLabel(view.visibleStage)}</span><h3 id="iw3-graph-title">Diagnostic graph</h3></div><button type="button" data-graph-close aria-label="Close diagnostic graph">Close</button></header><div class="iw3-graph-canvas" role="region" aria-label="Evidence-backed incident topology"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${nodes}</div>${selected ? `<aside class="iw3-node-peek"><div><span>Selected component</span><h4>${escapeHtml(selected.display_name)}</h4><p>${escapeHtml(titleCase(selected.runtime_status))} · ${escapeHtml(titleCase(selected.impact_status))}</p></div>${view.reviewingHistory ? '<span class="iw3-read-only-note">Historical graph · read-only</span>' : `<button type="button" data-agent-investigate="${escapeHtml(selected.component_id)}">Let Agent investigate this node</button>`}</aside>` : ""}</div></section>`;
}

function signalCardsMarkup(collection, expanded = false) {
  const allPaths = metricSeriesPathsV3(collection || { series: [] }, expanded ? 520 : 240, 76);
  const paths = expanded ? allPaths : allPaths.slice(0, 4);
  const seriesById = new Map((collection?.series || []).map((series) => [series.series_id, series]));
  return `<div class="iw3-signal-cards${expanded ? " is-expanded" : ""}">${paths.map((path) => {
    const series = seriesById.get(path.seriesId);
    const latest = series?.points?.at(-1) || null;
    const current = latest && typeof latest.value === "number" && Number.isFinite(latest.value) ? latest : null;
    const currentLabel = current
      ? formatMetric(current.value, series.unit)
      : `Unavailable${latest?.missing_reason ? ` · ${titleCase(latest.missing_reason)}` : ""}`;
    const trend = metricTrendV3(series);
    const observedStart = Date.parse(series?.observed_window_start || "");
    const observedEnd = Date.parse(series?.observed_window_end || "");
    const observedSeconds = Number.isFinite(observedStart) && Number.isFinite(observedEnd)
      ? Math.max(0, Math.round((observedEnd - observedStart) / 1000))
      : null;
    const d = path.segments.map((segment) => segment.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
    return `<article class="iw3-signal-card" data-series-id="${escapeHtml(path.seriesId)}"><header><div><span>${escapeHtml(series?.component_id || "Component")}</span><h5>${escapeHtml(series?.label || series?.metric_key || path.seriesId)}</h5></div><strong>${escapeHtml(currentLabel)}</strong></header><svg viewBox="0 0 ${expanded ? 520 : 240} 76" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series?.label || path.seriesId)} samples">${d.map((value) => `<path d="${value}"/>`).join("")}</svg><footer><span>${path.segments.reduce((count, segment) => count + segment.length, 0)} samples</span><span data-trend="${escapeHtml(trend.direction)}">${escapeHtml(trend.label)}</span><span>${observedSeconds === null ? "Window pending" : `${escapeHtml(formatDuration(observedSeconds))} window`}</span><span>${escapeHtml(thresholdCopy(series?.thresholds, series?.unit))}</span><span>${escapeHtml(titleCase(series?.freshness || "unknown"))} · ${escapeHtml(shortTime(latest?.timestamp))}</span></footer></article>`;
  }).join("") || '<p class="iw3-empty">Waiting for typed metric samples.</p>'}</div>`;
}

function impactPathMarkup(projection) {
  const nodes = new Map((projection.graph?.nodes || []).map((node) => [node.component_id, node]));
  return `<ol class="iw3-impact-path">${(projection.impacted_path || []).map((id) => `<li><span aria-hidden="true"></span><strong>${escapeHtml(nodes.get(id)?.display_name || id)}</strong><small>${escapeHtml(titleCase(nodes.get(id)?.runtime_status || "unknown"))}</small></li>`).join("") || "<li>No impact path published.</li>"}</ol>`;
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

function hypothesisMarkup(items) {
  return `<ol class="iw3-hypotheses">${(items || []).map((item) => `<li><div><strong>${escapeHtml(typeof item === "string" ? item : item.statement || item.title || "Hypothesis")}</strong>${typeof item === "object" && item.confidence !== undefined ? `<span>${escapeHtml(`${Math.round(Number(item.confidence) * 100)}%`)}</span>` : ""}</div>${typeof item === "object" && item.falsification_condition ? `<p>Falsify with: ${escapeHtml(item.falsification_condition)}</p>` : ""}${typeof item === "object" ? `<small>${escapeHtml(titleCase(item.status || "open"))} · ${(item.supporting_evidence_refs || []).length} supporting · ${(item.contradicting_evidence_refs || []).length} contradicting</small>` : ""}</li>`).join("") || "<li>No hypothesis published yet.</li>"}</ol>`;
}

function actionDecisionMarkup(action) {
  return `<div class="iw3-decision-action"><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.summary)}</p><small>${escapeHtml(action.command_label || action.command_id)} · decision r${escapeHtml(String(action.decision_revision))}</small></div>`;
}

function factsMarkup(output) {
  if (!output?.facts?.length) return "";
  return `<section class="iw3-panel iw3-span-two"><h4>Detected facts</h4>${listMarkup(output.facts, "")}</section>`;
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

function stageHeadline(stage, run) {
  if (run.status === "RUNNING") return `${stageLabel(stage)} is running`;
  if (run.status === "SUCCEEDED") return `${stageLabel(stage)} is ready`;
  if (run.status === "FAILED") return `${stageLabel(stage)} needs attention`;
  return stageLabel(stage);
}

function stageDescription(stage) {
  return ({ DETECT: "Confirm the live incident signal.", TRIAGE: "Bound impact and unknowns.", INVESTIGATE: "Test evidence-backed hypotheses.", DECIDE: "Choose a bounded response.", RESPOND: "Approve and execute the local repair.", VERIFY: "Evaluate fresh post-action evidence." })[stage];
}

function footerCopy(run) {
  if (run?.status === "RUNNING") return "The next stage remains locked while this work runs.";
  if (run?.status === "SUCCEEDED") return "Review this result, then advance when ready.";
  if (run?.status === "FAILED") return "Retry this stage or escalate with a reason.";
  if (run?.status === "NEEDS_HUMAN") return "Human input is required before the workflow can continue.";
  return "Waiting for the backend to start this stage.";
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

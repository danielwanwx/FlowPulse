import { incidentTopologyView } from "./control-plane-topology-layout.mjs";
import { INCIDENT_STAGES_V3, STAGE_STATES_V3, WORKFLOW_COMMANDS_V3 } from "./incident-v3-types.mjs";
import { liveEdgePath } from "./twin-state.mjs";

export { INCIDENT_STAGES_V3, STAGE_STATES_V3 } from "./incident-v3-types.mjs";
const PANELS = new Set(["metrics", "evidence", "activity", "timeline", "component", "graph", "action", "audit"]);
const PORTAL_TABS = new Set(["now", "activity", "evidence"]);
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
  const edgeId = url.searchParams.get("edge");
  const seriesId = url.searchParams.get("series");
  const portalTab = url.searchParams.get("portal_tab");
  return {
    caseId: PATH_ID.test(caseId || "") ? caseId : null,
    reviewStage: INCIDENT_STAGES_V3.includes(reviewStage) ? reviewStage : null,
    panel: PANELS.has(panel) ? panel : null,
    componentId: PATH_ID.test(componentId || "") ? componentId : null,
    edgeId: PATH_ID.test(edgeId || "") ? edgeId : null,
    seriesId: PATH_ID.test(seriesId || "") ? seriesId : null,
    portalOpen: url.searchParams.get("portal") === "open",
    portalTab: PORTAL_TABS.has(portalTab) ? portalTab : "now"
  };
}

export function updateIncidentWorkspaceUrlV3(url, {
  caseId, reviewStage = null, panel = null, componentId = null,
  edgeId = null, seriesId = null, portalOpen = false, portalTab = "now"
}) {
  const next = new URL(url);
  setParam(next, "case_id", PATH_ID.test(caseId || "") ? caseId : null);
  setParam(next, "stage", INCIDENT_STAGES_V3.includes(reviewStage) ? reviewStage : null);
  setParam(next, "panel", PANELS.has(panel) ? panel : null);
  setParam(next, "component", PATH_ID.test(componentId || "") ? componentId : null);
  setParam(next, "edge", PATH_ID.test(edgeId || "") ? edgeId : null);
  setParam(next, "series", PATH_ID.test(seriesId || "") ? seriesId : null);
  setParam(next, "portal", portalOpen ? "open" : null);
  setParam(next, "portal_tab", PORTAL_TABS.has(portalTab) ? portalTab : null);
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
  const forwardCommand = view.currentStage === "VERIFY" ? "COMPLETE_INCIDENT" : "NEXT";
  const currentRun = view.rail.find((item) => item.current)?.run;
  const canNext = !view.reviewingHistory && currentRun?.status === "SUCCEEDED" && available.has(forwardCommand);
  const freshness = duration.freshness || projection.freshness?.state || "UNKNOWN";
  return `<div class="iw3-shell" data-active-stage="${escapeHtml(view.visibleStage)}" data-current-stage="${escapeHtml(view.currentStage)}" data-connection="${escapeHtml(connection)}" data-freshness="${escapeHtml(String(freshness).toLowerCase())}">
    ${commandBarMarkup(projection, view, duration, freshness, connection)}
    ${commandErrorMarkup(ui.error)}
    ${stageRailMarkup(view)}
    <div class="iw3-workspace-body${ui.portalOpen ? " is-portal-open" : ""}">
      <main class="iw3-stage-surface" id="incident-stage-surface" tabindex="-1">
        ${stageMarkup(view, projection, ui)}
      </main>
      ${agentPortalMarkup(view, projection, ui)}
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
    <div class="iw3-workspace-body${ui.portalOpen ? " is-portal-open" : ""}">
      ${primary}
      ${agentPortalMarkup(view, projection, completedUi)}
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
        freshness: String(series.freshness || "").toUpperCase() === "STALE"
          ? series.freshness
          : latest?.freshness || series.freshness
      };
    }).filter((series) => series.points.length)
  };
}

function metricSeriesAfter(collection, timestamp) {
  const cutoff = Date.parse(timestamp || "");
  if (!collection?.series || !Number.isFinite(cutoff)) return collection ? { ...collection, series: [] } : collection;
  return {
    ...collection,
    series: collection.series.map((series) => {
      const points = (series.points || []).filter((point) => Date.parse(point.timestamp || "") > cutoff);
      return {
        ...series,
        points,
        observed_window_start: points[0]?.timestamp || series.observed_window_start,
        observed_window_end: points.at(-1)?.timestamp || series.observed_window_end
      };
    }).filter((series) => series.points.length)
  };
}

function postActionTraceStatus(projection, run, cutoff) {
  const cutoffMs = Date.parse(cutoff || "");
  const edge = (projection.graph?.edges || []).find((candidate) => (
    [candidate.source_component_id, candidate.target_component_id].includes("checkout")
    && [candidate.source_component_id, candidate.target_component_id].includes("payment")
  ));
  if (!edge || !Number.isFinite(cutoffMs)) return { observed: false, evidenceRefs: [], observedAt: null };
  const match = (projection.evidence_queries || []).filter((query) => (
    (!run?.stage_run_id || query.stage_run_id === run.stage_run_id)
    && (query.edge_ids || []).includes(edge.edge_id)
  )).map((query) => {
    const observations = (query.observation_timestamps || []).filter((timestamp) => Date.parse(timestamp || "") > cutoffMs);
    return { observations, evidenceRefs: query.evidence_refs || [] };
  }).filter((item) => item.observations.length).at(-1);
  if (!match) return { observed: false, evidenceRefs: [], observedAt: null };
  return {
    observed: true,
    evidenceRefs: uniqueOrdered(match.evidenceRefs),
    observedAt: match.observations.at(-1)
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
    return `<p class="iw3-stage-lead">Affected path: ${escapeHtml(path)} · ${facts} fact${facts === 1 ? "" : "s"} · ${unknowns} open question${unknowns === 1 ? "" : "s"}</p>`;
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
  if (run.status === "SUCCEEDED" && (run.output?.facts || []).length > 0) return true;
  return [run.output?.scope_status, run.output?.impact_scope?.status]
    .some((value) => ["BOUNDED", "CONFIRMED"].includes(String(value || "").toUpperCase()));
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

export function incidentFlowViewV3(projection, {
  selectedComponent = null,
  series = null,
  now = Date.now(),
  presentation = "full"
} = {}) {
  const graph = projection?.graph || { nodes: [], edges: [], active_pulses: [] };
  const impacted = new Set(projection?.impacted_path || []);
  const graphEdges = new Map((graph.edges || []).map((edge) => [edge.edge_id, edge]));
  const activePulses = graphFreshness(projection, now) === "CURRENT"
    ? (graph.active_pulses || []).filter((pulse) => Date.parse(pulse.expires_at) > now)
    : [];
  const pulseEdgeIds = new Set(activePulses.flatMap((pulse) => pulse.edge_ids || []).filter((edgeId) => graphEdges.has(edgeId)));
  const pulseComponentIds = new Set(activePulses.flatMap((pulse) => pulse.component_ids || []));
  for (const edgeId of pulseEdgeIds) {
    const edge = graphEdges.get(edgeId);
    pulseComponentIds.add(edge.source_component_id);
    pulseComponentIds.add(edge.target_component_id);
  }
  const resolved = projection?.lifecycle_state === "RESOLVED";
  const edges = (graph.edges || []).filter((edge) => (
    pulseEdgeIds.has(edge.edge_id)
    || impacted.has(edge.source_component_id) && impacted.has(edge.target_component_id)
    || resolved && (impacted.has(edge.source_component_id) || impacted.has(edge.target_component_id))
  ));
  const componentIds = new Set([...impacted, ...pulseComponentIds, ...edges.flatMap((edge) => [edge.source_component_id, edge.target_component_id])]);
  const selectedNodes = [...componentIds]
    .map((componentId) => (graph.nodes || []).find((node) => node.component_id === componentId))
    .filter(Boolean);
  const topology = selectedNodes.length >= 1 && edges.length === 0
    ? { available: true, nodes: selectedNodes, edges: [], positions: new Map() }
    : incidentTopologyView({
      graph,
      impacted_path: [...componentIds],
      incident_focus: { incident_relation_edge_ids: edges.map((edge) => edge.edge_id) }
    });
  const compact = topology.available && topology.nodes.length >= 1 && topology.nodes.length <= 3;
  const positions = compact
    ? new Map(topology.nodes.map((node, index) => [node.component_id, {
      x: topology.nodes.length === 1 ? 50 : topology.nodes.length === 2 ? 32 + index * 36 : 20 + index * 30,
      y: 50
    }]))
    : topology.positions;
  const scopedEdgeIds = new Set(edges.map((edge) => edge.edge_id));
  const activeEdgeIds = new Set([...pulseEdgeIds].filter((edgeId) => scopedEdgeIds.has(edgeId)));
  return {
    available: Boolean(topology.available && topology.nodes.length),
    compact,
    presentation,
    nodes: topology.available ? topology.nodes.map((node) => ({
      ...node,
      selected: node.component_id === selectedComponent,
      metric_label: componentMetricLabel(series, node.component_id)
    })) : [],
    edges: topology.available ? topology.edges.filter((edge) => scopedEdgeIds.has(edge.edge_id)) : [],
    positions,
    activeEdgeIds
  };
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
  const content = stageWorkspaceMarkup(view, projection, run, ui);
  const failure = ["FAILED", "NEEDS_HUMAN"].includes(run.status)
    ? `<div class="iw3-stage-failure" role="alert"><strong>${escapeHtml(failureLabel(run))}</strong></div>`
    : "";
  return `<section class="iw3-stage" aria-labelledby="iw3-stage-title">${header}${failure}${content}</section>`;
}
function failureLabel(run) {
  if (run.failure_code === "codex_timeout") return "Agent timed out";
  if (String(run.failure_code || "").startsWith("codex_")) return "Agent unavailable";
  return run.status === "NEEDS_HUMAN" ? "Human attention required" : "Stage failed";
}

/*
 * The stage boundary is deliberately explicit.  The shell owns identity,
 * progress, commands, vitals, and the Agent Rail; each renderer below owns one
 * stage's primary engineering task.  A renderer receives only the currently
 * visible run and canonical projection, so a locked future run cannot leak into
 * the mounted workspace.
 */
function stageWorkspaceMarkup(view, projection, run, ui) {
  const stage = view.visibleStage;
  const shared = liveVitalsMarkup(projection, ui);
  const renderer = {
    DETECT: detectWorkspaceMarkup,
    TRIAGE: triageWorkspaceMarkup,
    INVESTIGATE: investigateWorkspaceMarkup,
    DECIDE: decideWorkspaceMarkup,
    RESPOND: respondWorkspaceMarkup,
    VERIFY: verifyWorkspaceMarkup
  }[stage] || emptyWorkspaceMarkup;
  return `<div class="iw3-stage-workspace iw3-stage-${stage.toLowerCase()}" data-stage-workspace="${stage.toLowerCase()}-${stageWorkspaceSignature(stage)}">${renderer(view, projection, run, ui)}${shared}</div>`;
}

function stageWorkspaceSignature(stage) {
  return ({
    DETECT: "signal-board",
    TRIAGE: "scope-severity",
    INVESTIGATE: "diagnosis-graph",
    DECIDE: "decision-matrix",
    RESPOND: "execution-console",
    VERIFY: "before-after-monitor"
  })[stage] || "workspace";
}

function emptyWorkspaceMarkup() {
  return '<section class="iw3-stage-card iw3-empty-workspace"><span>Stage workspace</span><strong>No stage-specific output has been published.</strong></section>';
}

function liveVitalsMarkup(projection, ui) {
  return `<section class="iw3-live-vitals" aria-label="Live Vitals"><header><div><span>Live Vitals</span><strong>Errors · Latency · Traffic</strong></div><button type="button" data-open-panel="metrics">Observability</button></header><div class="iw3-live-vitals-strip">${signalCardsMarkup(ui.series)}${healthCardMarkup(projection, ui.now)}</div></section>`;
}

function detectWorkspaceMarkup(view, projection, run, ui) {
  const freshness = graphFreshness(projection, ui.now);
  const connector = (projection.connectors || [])[0] || null;
  const firstObserved = run.started_at || projection.freshness?.observed_at;
  const lastObserved = projection.freshness?.observed_at || connector?.observed_at;
  const readiness = run.status === "SUCCEEDED" ? "Ready for Triage" : freshness === "CURRENT" ? "Admitting real samples" : "Waiting for current telemetry";
  const readinessConditions = run.output?.verification_conditions || [];
  const readinessMarkup = readinessConditions.length
    ? `<section class="iw3-detect-readiness"><header><span>Readiness checks</span><strong>${readinessConditions.length} condition${readinessConditions.length === 1 ? "" : "s"}</strong></header>${listMarkup(readinessConditions, "No readiness conditions published.")}</section>`
    : "";
  return `<section class="iw3-stage-card iw3-stage-detect-board" data-stage-signature="detect-signal-board">
    <header class="iw3-workspace-card-heading"><div><span>Signal Board</span><h4>What triggered this Incident?</h4><p>Only admitted Errors, Latency, Traffic, and connector state are shown.</p></div><span class="iw3-stage-readiness" data-tone="${escapeHtml(freshness === "CURRENT" ? "healthy" : "stale")}">${escapeHtml(readiness)}</span></header>
    <div class="iw3-detect-facts"><div><span>Alert duration</span><strong data-incident-duration>${escapeHtml(formatDuration(workbenchDurationV3(projection, ui.now).elapsed_seconds))}</strong></div><div><span>First observed</span><strong>${escapeHtml(shortTime(firstObserved))}</strong></div><div><span>Last sample</span><strong>${escapeHtml(shortTime(lastObserved))}</strong></div><div><span>Connector</span><strong>${escapeHtml(connector?.provider || "Unavailable")}</strong><small>${escapeHtml(connectorPresentationState(projection, connector, ui.now))}</small></div></div>
    ${readinessMarkup}<div class="iw3-detect-signals" aria-label="Primary incident signals">${signalCardsMarkup(ui.series)}</div>
    <div class="iw3-detect-flow"><header><div><span>Impacted path preview</span><strong>${escapeHtml(pathLabel(projection))}</strong></div><button type="button" data-open-panel="graph">Dataflow</button></header>${embeddedFlowMarkup(projection, ui.now, ui.series, { presentation: "detect" })}</div>
  </section>`;
}

function triageWorkspaceMarkup(view, projection, run, ui) {
  const facts = run.output?.facts || [];
  const unknowns = run.output?.unknowns || [];
  const questions = run.output?.questions || [];
  const bounded = triageIsBounded(run);
  const pathNodes = (projection.impacted_path || []).map((componentId) => (projection.graph?.nodes || []).find((node) => node.component_id === componentId)).filter(Boolean);
  return `<section class="iw3-stage-card iw3-stage-triage-map" data-stage-signature="triage-scope-severity">
    <header class="iw3-workspace-card-heading"><div><span>Scope / Severity</span><h4>Bound the affected user path</h4><p>Confirmed impact stays separate from adjacency that still needs evidence.</p></div><span class="iw3-stage-readiness" data-tone="${bounded ? "healthy" : "warning"}">${bounded ? "Scope bounded" : "Scope under review"}</span></header>
    <div class="iw3-triage-map" role="list" aria-label="Confirmed impacted path">${pathNodes.map((node) => `<button type="button" class="iw3-triage-node" role="listitem" data-component-select="${escapeHtml(node.component_id)}" aria-label="Open ${escapeHtml(node.display_name)} context"><span data-tone="${escapeHtml(graphNodeTone(node, projection, ui.now))}"></span><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(titleCase(node.impact_status || node.runtime_status))}</small></button>`).join("") || '<p class="iw3-empty">No confirmed impacted path has been published.</p>'}</div>
    <div class="iw3-triage-grid"><section><span>Severity</span><strong>${escapeHtml(projection.severity || "Unavailable")}</strong><small>Canonical incident severity</small></section><section><span>Correlation</span><strong>${escapeHtml(triageCorrelationLabel(projection, run))}</strong><small>Signals · traces · admitted changes</small></section><section><span>Confirmed facts</span><strong>${facts.length}</strong><details><summary>Show facts</summary>${listMarkup(facts, "No confirmed facts published.")}</details></section><section><span>Unknowns</span><strong>${unknowns.length}</strong><details><summary>Show unknowns</summary>${listMarkup(unknowns, "No open unknowns published.")}</details></section></div>
    ${questions.length ? `<details class="iw3-triage-questions"><summary>${questions.length} investigation question${questions.length === 1 ? "" : "s"}</summary>${listMarkup(questions, "No investigation questions published.")}</details>` : ""}
  </section>`;
}

function triageCorrelationLabel(projection, run) {
  const evidence = [...(run.evidence_refs || []), ...(run.output?.facts || [])];
  if (run.status === "SUCCEEDED" && evidence.length) return "Correlated";
  if (run.status === "RUNNING") return "Collecting";
  return projection.freshness?.state === "CURRENT" ? "Pending evidence" : "Stale source";
}

function investigateWorkspaceMarkup(view, projection, run, ui) {
  const hypotheses = (projection.hypotheses || []).filter((item) => item.stage_run_id === run.stage_run_id);
  const queries = (projection.evidence_queries || []).filter((item) => item.stage_run_id === run.stage_run_id);
  const leading = leadingHypothesis(hypotheses);
  const critic = (projection.agent_activity || []).filter((item) => item.stage_run_id === run.stage_run_id && ["CRITIC", "EVALUATOR"].includes(String(item.role || "").toUpperCase())).at(-1);
  return `<section class="iw3-stage-card iw3-stage-investigate-graph" data-stage-signature="investigate-diagnosis-graph">
    <header class="iw3-workspace-card-heading"><div><span>Diagnosis Graph</span><h4>Test hypotheses against evidence</h4><p>Direction is the historical Diagnose path: thin causal routes with short halo/core projectiles.</p></div><div class="iw3-investigate-status"><span>${hypotheses.length} hypothes${hypotheses.length === 1 ? "is" : "es"}</span><span>${queries.length} quer${queries.length === 1 ? "y" : "ies"}</span></div></header>
    <div class="iw3-investigate-layout"><div class="iw3-investigate-canvas">${embeddedFlowMarkup(projection, ui.now, ui.series, { presentation: "investigate" })}</div><aside class="iw3-investigate-findings"><section><span>Leading hypothesis</span><strong>${leading ? `${escapeHtml(leading.title || leading.claim || leading.id)} · ${Math.round(Number(leading.confidence || 0) * 100)}%` : "No hypothesis published"}</strong>${leading ? `<small>Evidence ${(leading.evidence_refs || []).length} · Falsification ${escapeHtml(leading.falsification_condition || leading.counter_evidence || "Not published")}</small>` : ""}</section><section><span>Evidence Worker</span><strong>${queries.length ? escapeHtml(stateLabel(queries.at(-1).state)) : "Awaiting query"}</strong><button type="button" data-open-panel="evidence">Evidence details</button></section><section><span>Critic</span><strong>${critic ? escapeHtml(stateLabel(critic.state)) : "Awaiting verdict"}</strong>${critic ? `<small>${escapeHtml(critic.label || critic.summary || "Verdict recorded")}</small>` : ""}</section></aside></div>
    <footer class="iw3-investigate-footer"><span>Node selection changes Agent Rail context.</span>${view.reviewingHistory ? '<span>Historical graph · read-only</span>' : '<span>Use “Investigate this node” to create an explicit task.</span>'}</footer>
  </section>`;
}

function decideWorkspaceMarkup(view, projection, run, ui) {
  const candidate = decisionCandidate(projection, run);
  const hypothesisIds = new Set(run.output?.hypothesis_ids || []);
  const hypotheses = (projection.hypotheses || []).filter((item) => item.stage_run_id === run.stage_run_id || hypothesisIds.has(item.hypothesis_id || item.id));
  const rootCause = run.output?.root_cause || leadingHypothesis(hypotheses)?.claim || leadingHypothesis(hypotheses)?.title || "No root cause summary published";
  const options = [candidate, ...(projection.actions || []).filter((action) => (run.output?.action_ids || []).includes(action.action_id))].filter(Boolean);
  return `<section class="iw3-stage-card iw3-stage-decide-matrix" data-stage-signature="decide-decision-matrix">
    <header class="iw3-workspace-card-heading"><div><span>Decision Matrix</span><h4>Compare bounded response options</h4><p>Decide records a recommendation; it never performs the mutation.</p></div><span class="iw3-stage-readiness" data-tone="${candidate ? "healthy" : "warning"}">${candidate ? "Recommendation ready" : "Waiting for candidate"}</span></header>
    <section class="iw3-decision-lead"><span>Leading root cause</span><strong>${escapeHtml(rootCause)}</strong><small>${run.output?.evidence_refs?.length || run.evidence_refs?.length || 0} supporting evidence references</small></section>
    <table class="iw3-decision-table" aria-label="Candidate response options"><thead><tr class="iw3-decision-row iw3-decision-head"><th scope="col">Option</th><th scope="col">Blast radius</th><th scope="col">Risk</th><th scope="col">Rollback</th><th scope="col">Verification</th></tr></thead><tbody>${options.map((option, index) => `<tr class="iw3-decision-row${index === 0 ? " is-selected" : ""}"><th scope="row">${escapeHtml(approvedActionLabel(option) || option.title || `Candidate ${index + 1}`)}${option.summary ? `<small>${escapeHtml(option.summary)}</small>` : ""}</th><td>${escapeHtml(option.blast_radius || "Not published")}</td><td>${escapeHtml(compactRisk(option.risk) || option.risk || "Not published")}</td><td>${escapeHtml(option.rollback_plan || "Not published")}</td><td>${escapeHtml((option.verification_conditions || []).at(0) || "Not published")}</td></tr>`).join("") || '<tr class="iw3-decision-row"><td colspan="5"><p class="iw3-empty">No response candidates have been published.</p></td></tr>'}</tbody></table>
    <div class="iw3-decision-foot"><span>Dry run</span><strong>${escapeHtml(decisionDryRunLabel(run, candidate))}</strong><span>Revision</span><strong>${escapeHtml(String(candidate?.decision_revision ?? projection.decision_revision ?? "Unavailable"))}</strong></div>
  </section>`;
}

function decisionDryRunLabel(run, candidate) {
  if (run.status === "FAILED" || run.status === "NEEDS_HUMAN") return "Revalidation required";
  if (candidate?.dry_run_result || candidate?.dry_run?.status) return candidate.dry_run_result || titleCase(candidate.dry_run.status);
  return candidate ? "Completed" : "Not published";
}

function respondWorkspaceMarkup(view, projection, run, ui) {
  const actions = (projection.actions || []).filter((action) => action.attempt_id === projection.current_attempt?.attempt_id && action.stage_run_id === run.stage_run_id);
  const action = actions[0] || null;
  const receipt = action?.receipt || null;
  const steps = action?.execution_steps || action?.steps || [];
  return `<section class="iw3-stage-card iw3-stage-respond-console" data-stage-signature="respond-execution-console">
    <header class="iw3-workspace-card-heading"><div><span>Execution Console</span><h4>Approve and observe the allowlisted action</h4><p>Targets and expected state are bound to the current decision revision.</p></div><span class="iw3-stage-readiness" data-tone="${action?.status === "AWAITING_APPROVAL" ? "warning" : action ? "healthy" : "stale"}">${escapeHtml(action ? titleCase(action.status) : "Waiting for action")}</span></header>
    ${action ? `<section class="iw3-execution-target"><div><span>Mutation target</span><strong>${escapeHtml(approvedActionLabel(action) || action.title || action.command_id)}</strong><small>${escapeHtml(action.component_id || "Component unavailable")}</small></div><dl><div><dt>Before</dt><dd>${escapeHtml(action.expected_before || action.observed_before || "Not published")}</dd></div><div><dt>Expected after</dt><dd>${escapeHtml(action.expected_after || "Not published")}</dd></div><div><dt>Receipt</dt><dd>${escapeHtml(receipt ? "Persisted" : "Pending")}</dd></div></dl></section>${receipt ? executionReceiptMarkup(receipt, action.rollback_receipt) : ""}${steps.length ? `<ol class="iw3-execution-steps">${steps.map((step, index) => { const objectStep = step && typeof step === "object"; const state = objectStep ? step.state || step.status : null; const label = typeof step === "string" ? step : objectStep ? step.label || step.summary || JSON.stringify(step) || "Execution step" : "Execution step"; return `<li data-step-state="${escapeHtml(state || "unavailable")}"><span>${index + 1}</span><strong>${escapeHtml(label)}</strong>${state ? `<small>${escapeHtml(titleCase(state))}</small>` : ""}</li>`; }).join("")}</ol>` : ""}${respondActionMarkup(projection, run, ui.commandPending)}` : '<p class="iw3-empty">No immutable execution action has been published for this stage.</p>'}
  </section>`;
}

function executionReceiptMarkup(receipt, rollbackReceipt) {
  const rollback = rollbackReceipt
    ? `${titleCase(rollbackReceipt.status || "Recorded")}${rollbackReceipt.output_summary ? ` · ${rollbackReceipt.output_summary}` : ""}`
    : "Not published";
  return `<dl class="iw3-execution-receipt"><div><dt>Receipt ID</dt><dd><code>${escapeHtml(receipt.receipt_id || "Not published")}</code></dd></div><div><dt>Started</dt><dd>${escapeHtml(shortTime(receipt.started_at))}</dd></div><div><dt>Ended</dt><dd>${escapeHtml(shortTime(receipt.completed_at))}</dd></div><div><dt>Result</dt><dd>${escapeHtml(receipt.output_summary || titleCase(receipt.status) || "Not published")}</dd></div><div><dt>Rollback</dt><dd>${escapeHtml(rollback)}</dd></div></dl>`;
}

function verifyWorkspaceMarkup(view, projection, run, ui) {
  const currentSeries = ui.series;
  const action = (projection.actions || []).find((item) => item.receipt?.receipt_id === projection.current_attempt?.action_receipt_id) || null;
  const cutoff = action?.receipt?.completed_at || action?.receipt?.started_at || run.started_at;
  const beforeSeries = metricSeriesAt(currentSeries, cutoff);
  const afterSeries = metricSeriesAfter(currentSeries, cutoff);
  const postActionTrace = postActionTraceStatus(projection, run, cutoff);
  const healthy = run.status === "SUCCEEDED";
  const deadline = Date.parse(run.verification_deadline_at || "");
  const remaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - (ui.now ?? Date.now())) / 1000)) : null;
  const graph = embeddedFlowMarkup(projection, ui.now, ui.series, { presentation: "verify" });
  return `<section class="iw3-stage-card iw3-stage-verify-monitor" data-stage-signature="verify-before-after-monitor">
    <header class="iw3-workspace-card-heading"><div><span>Before / After Monitor</span><h4>${healthy ? "Recovery confirmed" : "Confirm recovery with post-action evidence"}</h4><p>Only samples observed after the immutable action receipt count toward recovery.</p></div><span class="iw3-stage-readiness" data-tone="${healthy ? "healthy" : graphHealth(projection, ui.now)}">${healthy ? "Verified" : remaining === null ? stateLabel(run.status) : `${formatDuration(remaining)} remaining`}</span></header>
    <div class="iw3-verify-grid"><section><header><span>Before action</span><strong>${escapeHtml(shortTime(cutoff))}</strong></header>${signalCardsMarkup(beforeSeries)}</section><section><header><span>After action</span><strong>${escapeHtml(shortTime(afterSeries?.series?.flatMap((item) => item.points || []).map((point) => point.timestamp).filter(Boolean).sort().at(-1)))}</strong></header>${signalCardsMarkup(afterSeries)}</section></div>
    <section class="iw3-verify-graph"><header><div><span>Recovered dependency graph</span><strong>${escapeHtml(pathLabel(projection))}</strong></div><button type="button" data-open-panel="graph">Dataflow</button></header>${graph}</section>
    <section class="iw3-verify-trace" data-trace-status="${postActionTrace.observed ? "observed" : "not-observed"}"><span>Checkout → Payment post-action trace</span><strong>${postActionTrace.observed ? "Observed" : "Not observed"}</strong><small>${postActionTrace.observed ? `${postActionTrace.evidenceRefs.length} evidence references · ${escapeHtml(shortTime(postActionTrace.observedAt))}${postActionTrace.evidenceRefs.length ? ` · ${escapeHtml(postActionTrace.evidenceRefs.join(", "))}` : ""}` : "No post-action observation published"}</small></section>
    <div class="iw3-verify-conditions"><span>Verification conditions</span><strong>${escapeHtml(run.output?.summary || (healthy ? "All published checks passed" : "Waiting for independent healthy samples"))}</strong>${Number.isSafeInteger(run.output?.healthy_sample_count) ? `<small>${run.output.healthy_sample_count}/3 healthy samples</small>` : ""}</div>
  </section>`;
}

function respondActionMarkup(projection, run, pending) {
  const actions = (projection.actions || []).filter((action) =>
    action.attempt_id === projection.current_attempt.attempt_id
    && action.stage_run_id === run.stage_run_id
  );
  const available = new Set(projection.available_commands || []);
  return `<section class="iw3-stage-action iw3-action-list">${actions.map((action) => {
    const revisionCurrent = action.decision_revision === projection.decision_revision;
    const preflight = actionPreflight(projection, action);
    const canApprove = Boolean(preflight) && action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("APPROVE_ACTION") && !pending;
    const canReject = Boolean(preflight) && action.status === "AWAITING_APPROVAL" && revisionCurrent && available.has("REJECT_ACTION") && !pending;
    const label = approvedActionLabel(action) || "Action";
    return `<article class="iw3-action-card" data-action-id="${escapeHtml(action.action_id)}"><header><strong>${label}</strong><span>${escapeHtml(action.status === "AWAITING_APPROVAL" ? "Approval required" : titleCase(action.status))}</span></header>${preflight ? `<div class="iw3-action-chips"><span>paymentUnreachable: on → off</span><span>Checkout: recreate</span><span>Scope: local Astronomy Shop</span></div>` : '<div class="iw3-action-chips"><span>Revalidation required</span></div>'}<button type="button" data-open-panel="action">Action details</button>${action.status === "AWAITING_APPROVAL" ? `<div class="iw3-action-buttons"><button type="button" data-action-decision="REJECT_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canReject ? "" : " disabled"}>Reject</button><button type="button" class="is-primary" data-action-decision="APPROVE_ACTION" data-action-id="${escapeHtml(action.action_id)}"${canApprove ? "" : " disabled"}>${pending ? "Working…" : "Approve action"}</button></div>` : ""}</article>`;
  }).join("")}</section>`;
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
  return `<footer class="iw3-action-footer"><div class="iw3-footer-actions">${failed && available.has("RETRY") ? `<button type="button" data-workflow-command="RETRY"${pending ? " disabled" : ""}>Retry</button>` : ""}${recovery ? `<button type="button" class="is-primary" data-workflow-command="RERUN_FROM_STAGE" data-rerun-stage="${escapeHtml(rerunTarget)}"${pending ? " disabled" : ""}>${escapeHtml(rerunLabel)}</button>` : ""}<button type="button" data-workflow-command="ESCALATE"${available.has("ESCALATE") && !pending ? "" : " disabled"}>Escalate</button>${recovery ? "" : `<button type="button" class="is-primary" data-workflow-command="${terminal ? "COMPLETE_INCIDENT" : "NEXT"}"${canNext && !pending ? "" : " disabled"}>${pending ? "Working…" : terminal ? "Complete incident" : "Next"}</button>`}</div></footer>`;
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
  const title = ({ metrics: "Observability", evidence: "Evidence", activity: "Activity", timeline: "Timeline", component: "Component", action: "Action details", audit: "Immutable incident audit" })[ui.panel] || "Detail";
  let body = "";
  if (ui.panel === "metrics") body = observabilityMarkup(projection, ui.series, ui.now);
  else if (ui.panel === "activity") body = activityMarkup(projection, view.visibleStage, { stageRunId: view.visibleRun?.stage_run_id });
  else if (ui.panel === "evidence") body = evidenceMarkup(view.visibleRun, projection);
  else if (ui.panel === "component") body = componentMarkup(projection, ui.componentId);
  else if (ui.panel === "action") body = actionDetailMarkup(projection, view.visibleRun);
  else if (ui.panel === "audit") body = auditDetailMarkup(projection);
  else body = timelineMarkup(projection, view);
  return `<section class="iw3-detail-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-detail-title" tabindex="-1" data-workbench-modal><div class="iw3-detail${ui.panel === "audit" ? " is-audit" : ""}"><header><h3 id="iw3-detail-title">${escapeHtml(title)}</h3><button type="button" data-panel-close aria-label="Close ${escapeHtml(title)}">Close</button></header><div class="iw3-detail-body">${body}</div></div></section>`;
}

function observabilityMarkup(projection, series, now) {
  const points = (series?.series || []).flatMap((item) => item.points || []);
  const numeric = points.filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
  const latest = numeric.map((point) => point.timestamp).filter(Boolean).sort().at(-1);
  return `<div class="iw3-observability">
    <section class="iw3-observability-summary"><div><span>Observed samples</span><strong>${numeric.length}</strong><small>${latest ? `Latest ${escapeHtml(shortTime(latest))}` : "No numeric sample"}</small></div>${connectorSummaryMarkup(projection, now)}<div data-dashboard-state="unconfigured"><span>External dashboard</span><strong>Not configured</strong><small>External dashboard not configured</small></div></section>
    ${signalCardsMarkup(series, true)}
  </div>`;
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
  const flow = incidentFlowViewV3(projection, { selectedComponent, series, now, presentation: "full" });
  const nodeById = new Map(flow.nodes.map((node) => [node.component_id, node]));
  const edges = flow.available ? flow.edges.map((edge) => {
    const source = flow.positions.get(edge.source_component_id);
    const target = flow.positions.get(edge.target_component_id);
    if (!source || !target) return "";
    const tone = graphEdgeTone(edge, nodeById, projection, now);
    return historicalIncidentEdgeMarkup(edge, source, target, { tone, active: flow.activeEdgeIds.has(edge.edge_id), prefix: "iw3-graph", nodeById });
  }).join("") : "";
  const nodes = flow.available ? flow.nodes.map((node) => {
    const position = flow.positions.get(node.component_id);
    const tone = graphNodeTone(node, projection, now);
    return `<button type="button" class="iw3-graph-node is-${tone}${node.selected ? " is-selected" : ""}" data-graph-node="${escapeHtml(node.component_id)}" data-graph-x="${position.x}" data-graph-y="${position.y}"><span class="iw3-graph-node-state" aria-hidden="true"></span><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(node.metric_label || titleCase(node.runtime_status))}</small></button>`;
  }).join("") : '<p class="iw3-graph-unavailable">No evidence-backed impact graph is available.</p>';
  const selected = nodeById.get(selectedComponent) || null;
  const metric = selected?.metric_label || null;
  const readOnly = view.reviewingHistory || projection.lifecycle_state === "RESOLVED" || projection.current_attempt?.status === "COMPLETED";
  const canInvestigateNode = !readOnly && view.currentStage === "INVESTIGATE" && view.visibleStage === "INVESTIGATE";
  return `<section class="iw3-graph-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-graph-title" tabindex="-1" data-workbench-modal data-graph-modal><div class="iw3-graph-dialog${flow.compact ? " is-compact" : ""}"><header><div><span>${stageLabel(view.visibleStage)}</span><h3 id="iw3-graph-title">Dataflow</h3></div><button type="button" data-graph-close aria-label="Close Dataflow">Close</button></header><div class="iw3-graph-legend"><span data-tone="affected">Affected</span><span data-tone="healthy">Healthy</span><span data-tone="observed">Live pulse</span><span data-tone="stale">Stale</span></div><div class="iw3-graph-canvas is-live-source" role="region" aria-label="Evidence-backed incident topology" data-graph-layout="${flow.compact ? "compact" : "topology"}"><svg viewBox="0 0 1480 680" preserveAspectRatio="none">${edges}</svg>${nodes}</div>${selected ? `<aside class="iw3-node-peek"><div><span>Selected component</span><h4>${escapeHtml(selected.display_name)}</h4><p>${escapeHtml(titleCase(selected.runtime_status))} · ${escapeHtml(titleCase(selected.impact_status))} · ${escapeHtml(metric || (graphFreshness(projection, now) === "CURRENT" ? "Fresh" : "Stale"))}</p></div><div class="iw3-node-peek-actions"><button type="button" data-portal-component="${escapeHtml(selected.component_id)}">Open Agent Portal</button>${readOnly ? `<span class="iw3-read-only-note">${view.reviewingHistory ? "Historical graph · read-only" : "Read-only"}</span>` : canInvestigateNode ? `<button type="button" data-agent-investigate="${escapeHtml(selected.component_id)}">Let Agent investigate this node</button>` : ""}</div></aside>` : ""}</div></section>`;
}

function embeddedFlowMarkup(projection, now, series, { presentation = "embedded" } = {}) {
  const flow = incidentFlowViewV3(projection, { series, now, presentation });
  if (!flow.available) return '<p class="iw3-graph-unavailable">No evidence-backed impact graph is available.</p>';
  const nodeById = new Map(flow.nodes.map((node) => [node.component_id, node]));
  const edges = flow.edges.map((edge) => {
    const source = flow.positions.get(edge.source_component_id);
    const target = flow.positions.get(edge.target_component_id);
    if (!source || !target) return "";
    const tone = graphEdgeTone(edge, nodeById, projection, now);
    return historicalIncidentEdgeMarkup(edge, source, target, { tone, active: flow.activeEdgeIds.has(edge.edge_id), prefix: "iw3-home-graph", nodeById });
  }).join("");
  const nodes = flow.nodes.map((node) => {
    const position = flow.positions.get(node.component_id);
    const tone = graphNodeTone(node, projection, now);
    return `<button type="button" class="iw3-home-graph-node is-${tone}" data-home-graph-node="${escapeHtml(node.component_id)}" data-component-select="${escapeHtml(node.component_id)}" data-graph-x="${position.x}" data-graph-y="${position.y}" aria-label="Open ${escapeHtml(node.display_name)} in Agent Portal"><span aria-hidden="true"></span><strong>${escapeHtml(node.display_name)}</strong><small>${escapeHtml(node.metric_label || titleCase(node.runtime_status))}</small></button>`;
  }).join("");
  return `<div class="iw3-home-graph iw3-flow-visual is-${escapeHtml(presentation)} is-live-source" role="region" aria-label="Evidence-backed live impact flow"><svg viewBox="0 0 1480 680" preserveAspectRatio="none">${edges}</svg>${nodes}</div>`;
}

/** Ported Diagnose path geometry and signal projectile contract. */
export function historicalIncidentEdgePathV3(source, target, lane = 0) {
  return liveEdgePath(source, target, {
    canvasWidth: 1480,
    canvasHeight: 680,
    nodeWidth: 172,
    nodeHeight: 62,
    lane
  });
}

export function historicalIncidentEdgeMarkupV3(edge, source, target, {
  tone = "observed",
  active = false,
  prefix = "iw3-graph",
  nodeById = new Map()
} = {}) {
  const path = historicalIncidentEdgePathV3(source, target, edge.order || 0);
  const from = nodeById.get(edge.source_component_id)?.display_name || edge.source_component_id;
  const to = nodeById.get(edge.target_component_id)?.display_name || edge.target_component_id;
  const activeClass = active && tone !== "stale" ? " is-signal-active" : "";
  const signal = ({ affected: "impact", healthy: "verified", stale: "observed", observed: "observed" })[tone] || "observed";
  const pulseAttrs = activeClass ? `data-live-edge-id="${escapeHtml(edge.edge_id)}" data-live-projectile="single" data-signal-from="${escapeHtml(edge.source_component_id)}" data-signal-to="${escapeHtml(edge.target_component_id)}" data-signal-order="${escapeHtml(edge.order || 0)}"` : "";
  return `<g class="edge-group path-runtime relation-calls signal-${signal} presentation-affected ${escapeHtml(prefix)}-edge-group is-${escapeHtml(tone)}${activeClass}" ${pulseAttrs} data-edge-id="${escapeHtml(edge.edge_id)}" data-live-route="canonical-authored" data-route-order="${escapeHtml(edge.order || 0)}" data-graph-edge="${escapeHtml(edge.edge_id)}" data-home-graph-edge="${escapeHtml(edge.edge_id)}"><path class="edge-line is-${escapeHtml(tone)}" pathLength="1000" d="${path}"/><path class="signal-projectile signal-projectile-halo" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000" d="${path}" aria-hidden="true"/><path class="signal-projectile signal-projectile-core" pathLength="1000" stroke-dasharray="0 1000" stroke-dashoffset="1000" d="${path}" aria-hidden="true"/><path class="edge-hit" d="${path}" role="button" tabindex="0" aria-label="Open ${escapeHtml(from)} to ${escapeHtml(to)} relation in Agent Rail" data-edge-select="${escapeHtml(edge.edge_id)}" data-edge-source="${escapeHtml(edge.source_component_id)}" data-edge-target="${escapeHtml(edge.target_component_id)}" data-edge-id="${escapeHtml(edge.edge_id)}" data-edge-from="${escapeHtml(edge.source_component_id)}" data-edge-to="${escapeHtml(edge.target_component_id)}"/></g>`;
}

function historicalIncidentEdgeMarkup(edge, source, target, options) {
  return historicalIncidentEdgeMarkupV3(edge, source, target, options);
}

function healthCardMarkup(projection, now) {
  const connector = (projection.connectors || [])[0] || null;
  const flow = incidentFlowViewV3(projection, { now, presentation: "health" });
  const edge = flow.edges[0] || null;
  const connectorState = connectorPresentationState(projection, connector, now);
  const tone = connectorState === "current"
    ? edge ? graphEdgeTone(edge, new Map(flow.nodes.map((node) => [node.component_id, node])), projection, now) : "unavailable"
    : connectorState === "degraded" ? "warning" : connectorState;
  return `<article class="iw3-health-card" data-tone="${escapeHtml(tone)}"><span class="iw3-signal-card-head"><span class="iw3-signal-icon" aria-hidden="true"><i class="ph ph-plugs-connected"></i></span><span><small>${escapeHtml(connector?.provider || "Connector")}</small><strong>Dependency health</strong></span></span><div class="iw3-health-path"><strong>${escapeHtml(edge ? titleCase(edge.status || tone) : "Unavailable")}</strong><span>${escapeHtml(edge ? `${edge.source_component_id} → ${edge.target_component_id}` : "No evidence-backed edge")}</span></div>${connectorSummaryMarkup(projection, now)}</article>`;
}

function connectorSummaryMarkup(projection, now) {
  const connector = (projection.connectors || [])[0] || null;
  if (!connector) return '<div class="iw3-connector-summary" data-state="unavailable"><span>Connector</span><strong>Unavailable</strong><small>No connector health published</small></div>';
  const state = connectorPresentationState(projection, connector, now);
  const canonicalState = String(connector.state || "UNKNOWN").toUpperCase();
  const observedAt = connector.last_event_observed_at || connector.observed_at;
  const lag = Number.isSafeInteger(connector.lag_seconds) ? `${connector.lag_seconds}s lag` : null;
  const times = [observedAt ? `Observed ${shortTime(observedAt)}` : null, connector.fresh_until ? `Fresh until ${shortTime(connector.fresh_until)}` : null].filter(Boolean);
  const label = ({ current: "Connected", stale: "Stale", degraded: "Degraded", unavailable: "Unavailable" })[state];
  const sourceState = state === "current" ? null : `Source ${titleCase(canonicalState)}`;
  return `<div class="iw3-connector-summary" data-state="${state}"><span>${escapeHtml(connector.provider || "Connector")}</span><strong>${escapeHtml(label)}</strong><small>${escapeHtml([sourceState, lag, ...times].filter(Boolean).join(" · ") || "Health published")}</small></div>`;
}

function connectorPresentationState(projection, connector, now) {
  if (!connector) return "unavailable";
  const state = String(connector.state || "").toUpperCase();
  if (["UNAVAILABLE", "MISCONFIGURED", "DISABLED", "DISCONNECTED", "FAILED"].includes(state)) return "unavailable";
  if (state === "DEGRADED") return "degraded";
  if (state === "STALE") return "stale";
  if (state === "CONNECTED") return graphFreshness(projection, now) === "CURRENT" ? "current" : "stale";
  return "unavailable";
}

function signalCardsMarkup(collection, expanded = false) {
  const width = expanded ? 520 : 240;
  const height = expanded ? 116 : 78;
  const allPaths = metricSeriesPathsV3(collection || { series: [] }, width, height);
  const seriesItems = collection?.series || [];
  const compactKinds = ["error", "latency", "request"];
  const compactSeries = compactKinds.map((kind) => seriesItems.find((series) => {
    const key = String(series.metric_key || "").toLowerCase();
    return kind === "error" ? key.includes("error") : kind === "latency" ? key.includes("latency") || key.includes("duration") : key.includes("request");
  }));
  const compactPaths = compactSeries.map((series, index) => ({
    kind: compactKinds[index],
    path: allPaths.find((path) => path.seriesId === series?.series_id) || null
  }));
  const paths = expanded ? allPaths.map((path) => ({ kind: null, path })) : compactPaths;
  const seriesById = new Map((collection?.series || []).map((series) => [series.series_id, series]));
  return `<div class="iw3-signal-cards${expanded ? " is-expanded" : ""}">${paths.map(({ kind, path }) => {
    if (!path) return `<article class="iw3-signal-card is-unavailable" data-tone="stale"><span class="iw3-signal-card-head"><span class="iw3-signal-icon" aria-hidden="true"><i class="ph ph-waveform"></i></span><span><small>Telemetry</small><strong class="iw3-signal-card-label">${escapeHtml(({ error: "Errors", latency: "Latency", request: "Traffic" })[kind] || "Signal")}</strong></span></span><div class="iw3-signal-placeholder"></div><span class="iw3-signal-card-foot"><strong class="iw3-signal-card-value">No sample</strong><span>Source unavailable</span></span></article>`;
    const series = seriesById.get(path.seriesId);
    const latest = series?.points?.at(-1) || null;
    const current = latest && String(series?.freshness || "").toUpperCase() === "CURRENT"
      && typeof latest.value === "number" && Number.isFinite(latest.value) ? latest : null;
    const lastNumeric = current || lastNumericPoint(series);
    const tone = signalTone(series, current);
    const currentLabel = lastNumeric
      ? `${current ? "" : "Last "}${formatMetric(lastNumeric.value, series.unit)}`
      : expanded ? `Unavailable${latest?.missing_reason ? ` · ${titleCase(latest.missing_reason)}` : ""}` : "No sample";
    const trend = metricTrendV3(series);
    const observedStart = Date.parse(series?.observed_window_start || "");
    const observedEnd = Date.parse(series?.observed_window_end || "");
    const observedSeconds = Number.isFinite(observedStart) && Number.isFinite(observedEnd)
      ? Math.max(0, Math.round((observedEnd - observedStart) / 1000))
      : null;
    const sampleCount = (series?.points || []).filter((point) => typeof point.value === "number" && Number.isFinite(point.value)).length;
    const windowLabel = observedSeconds === null ? "Window pending" : `${current ? "Live" : "Last sample"} · ${formatDuration(observedSeconds)}`;
    const detailFooter = `<span>${path.segments.reduce((count, segment) => count + segment.length, 0)} samples</span><span data-trend="${escapeHtml(trend.direction)}">${escapeHtml(trend.label)}</span><span>${observedSeconds === null ? "Window pending" : `${escapeHtml(formatDuration(observedSeconds))} window`}</span><span>${escapeHtml(thresholdCopy(series?.thresholds, series?.unit))}</span><span>${escapeHtml(titleCase(series?.freshness || "unknown"))} · ${escapeHtml(shortTime(latest?.timestamp))}</span>`;
    const label = expanded ? series?.label || series?.metric_key || path.seriesId : compactMetricLabel(series);
    const visual = signalVisualMarkup(series, path, { width, height, tone });
    const compactFooter = `<span class="iw3-signal-window">${escapeHtml(windowLabel)} · ${sampleCount} sample${sampleCount === 1 ? "" : "s"}</span><span data-tone="${escapeHtml(String(series?.freshness || "unknown").toLowerCase())}">${escapeHtml(titleCase(series?.freshness || "unknown"))}</span>`;
    return `<button type="button" class="iw3-signal-card" data-component-select="${escapeHtml(series?.component_id || "")}" data-series-id="${escapeHtml(path.seriesId)}" data-tone="${tone}" data-signal-visual="${signalVisualKind(series)}" aria-label="Open ${escapeHtml(series?.component_id || "component")} in Agent Portal"><span class="iw3-signal-card-head">${signalIconMarkup(series)}<span><small>${escapeHtml(series?.component_id || "Component")}</small><strong class="iw3-signal-card-label">${escapeHtml(label)}</strong></span></span>${visual}<span class="iw3-signal-card-foot"><strong class="iw3-signal-card-value">${escapeHtml(currentLabel)}</strong>${expanded ? `<span class="iw3-signal-card-detail">${detailFooter}</span>` : compactFooter}</span></button>`;
  }).join("") || '<p class="iw3-empty">Waiting for typed metric samples.</p>'}</div>`;
}

function signalVisualKind(series) {
  const key = String(series?.metric_key || "").toLowerCase();
  if (key.includes("error")) return "area";
  if (key.includes("latency") || key.includes("duration")) return "stems";
  if (key.includes("request")) return "tiles";
  return "line";
}

function signalIconMarkup(series) {
  const kind = signalVisualKind(series);
  const icon = kind === "area" ? "activity" : kind === "stems" ? "waveform" : kind === "tiles" ? "queue" : "activity";
  return `<span class="iw3-signal-icon is-${kind}" aria-hidden="true"><i class="ph ph-${icon}"></i></span>`;
}

function signalVisualMarkup(series, path, { width, height, tone }) {
  const kind = signalVisualKind(series);
  const color = `var(--${({ affected: "red", warning: "amber", healthy: "green", observed: "blue" })[tone] || "faint"})`;
  if (kind === "tiles") return trafficTilesMarkup(series, { width, height, color });
  const samples = path.segments.flat();
  const latest = samples.at(-1) || null;
  if (kind === "stems") {
    return `<svg class="iw3-signal-viz is-stems" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series?.label || path.seriesId)} samples">${samples.map((point, index) => `<line class="iw3-signal-stem${index === samples.length - 1 ? " is-latest" : ""}" data-signal-stem="${index}" x1="${point.x}" x2="${point.x}" y1="${height - 7}" y2="${point.y}" stroke="${color}"/>`).join("")}${latest ? `<circle class="iw3-signal-dot" cx="${latest.x}" cy="${latest.y}" r="3.5" fill="${color}"/>` : ""}</svg>`;
  }
  const d = path.segments.map((segment) => segment.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
  const areas = kind === "area" ? path.segments.filter((segment) => segment.length > 1).map((segment, index) => `<polygon class="iw3-signal-area" data-series-segment="${index}" fill="${color}" fill-opacity="0.13" points="${segment.map((point) => `${point.x},${point.y}`).join(" ")} ${segment.at(-1).x},${height} ${segment[0].x},${height}"/>`).join("") : "";
  return `<svg class="iw3-signal-viz is-${kind}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series?.label || path.seriesId)} samples">${areas}${d.map((value, index) => `<path class="iw3-signal-line" data-series-segment="${index}" d="${value}" stroke="${color}"/>`).join("")}${latest ? `<circle class="iw3-signal-dot" cx="${latest.x}" cy="${latest.y}" r="3.5" fill="${color}"/>` : ""}</svg>`;
}

function trafficTilesMarkup(series, { width, height, color }) {
  const points = (series?.points || []).slice(-24);
  const numeric = points.filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
  const min = numeric.length ? Math.min(...numeric.map((point) => point.value)) : 0;
  const max = numeric.length ? Math.max(...numeric.map((point) => point.value)) : min;
  const columns = Math.min(8, Math.max(1, points.length));
  const rows = Math.max(1, Math.ceil(points.length / columns));
  const gap = 5;
  const tileWidth = Math.min(34, Math.max(10, (width - gap * (columns - 1)) / columns));
  const tileHeight = Math.max(10, Math.min(20, (height - gap * (rows - 1)) / rows));
  const gridWidth = tileWidth * columns + gap * (columns - 1);
  const left = (width - gridWidth) / 2;
  const gridHeight = tileHeight * rows + gap * (rows - 1);
  const top = (height - gridHeight) / 2;
  return `<svg class="iw3-signal-viz is-tiles" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(series?.label || "Traffic")} samples">${points.map((point, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
    const intensity = value === null ? 0.13 : max === min ? 0.62 : 0.26 + ((value - min) / (max - min) * 0.7);
    return `<rect class="iw3-signal-tile${value === null ? " is-gap" : ""}${index === points.length - 1 ? " is-latest" : ""}" data-signal-tile="${index}" x="${left + column * (tileWidth + gap)}" y="${top + row * (tileHeight + gap)}" width="${tileWidth}" height="${tileHeight}" rx="${Math.min(tileHeight / 2, 8)}" fill="${color}" fill-opacity="${intensity.toFixed(2)}"/>`;
  }).join("")}</svg>`;
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

function lastNumericPoint(series) {
  const points = series?.points || [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (typeof point?.value === "number" && Number.isFinite(point.value)) return point;
  }
  return null;
}

function graphEdgeTone(edge, nodes, projection, now) {
  if (graphFreshness(projection, now) !== "CURRENT") return "stale";
  const tones = [nodes.get(edge.source_component_id), nodes.get(edge.target_component_id)].filter(Boolean).map((node) => graphNodeTone(node, projection, now));
  if (tones.includes("affected")) return "affected";
  return tones.every((tone) => tone === "healthy") ? "healthy" : "observed";
}

function componentMetricLabel(collection, componentId, preferredSeriesId = null) {
  const metrics = collection?.series || [];
  const series = metrics.find((item) => item.component_id === componentId && item.series_id === preferredSeriesId)
    || metrics.find((item) => item.component_id === componentId && /error|latency|duration/.test(item.metric_key || "") && lastNumericPoint(item))
    || metrics.find((item) => item.component_id === componentId && lastNumericPoint(item));
  const point = lastNumericPoint(series);
  return typeof point?.value === "number" && Number.isFinite(point.value) ? `${compactMetricLabel(series)} ${formatMetric(point.value, series.unit)}` : null;
}

function componentMetricEvidenceRefs(collection, componentIds, preferredSeriesId = null) {
  const scoped = new Set(componentIds.filter(Boolean));
  const series = (collection?.series || []).filter((item) => scoped.has(item.component_id));
  const selected = series.filter((item) => item.series_id === preferredSeriesId);
  return uniqueOrdered((selected.length ? selected : series)
    .flatMap((series) => lastNumericPoint(series)?.evidence_refs || []));
}

function activityMarkup(projection, stage, { roles = null, excludeRoles = [], stageRunId = null } = {}) {
  const items = (projection.agent_activity || []).filter((activity) => activity.stage === stage
    && (!stageRunId || activity.stage_run_id === stageRunId)
    && (!roles || roles.includes(activity.role)) && !excludeRoles.includes(activity.role));
  const rows = items.map((activity) => `<li data-state="${escapeHtml(activity.state.toLowerCase())}"><span aria-hidden="true"></span><div><strong>${escapeHtml(activity.label)}</strong><p>${escapeHtml(activity.summary)}</p><small>${escapeHtml(stateLabel(activity.state))} · ${escapeHtml(shortTime(activity.occurred_at))} · ${(activity.evidence_refs || []).length} evidence</small></div></li>`).join("");
  return `<ol class="iw3-activity-list">${rows || '<li class="iw3-activity-empty"><p>No Agent activity has been published for this stage.</p></li>'}</ol>`;
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

function agentPortalMarkup(view, projection, ui) {
  const graph = projection.graph || { nodes: [], edges: [] };
  const edge = (graph.edges || []).find((item) => item.edge_id === ui.edgeId) || null;
  const componentId = ui.componentId || edge?.source_component_id || projection.impacted_path?.[0] || graph.nodes?.[0]?.component_id || null;
  const node = (graph.nodes || []).find((item) => item.component_id === componentId) || null;
  const tab = PORTAL_TABS.has(ui.portalTab) ? ui.portalTab : "now";
  const relatedQueries = (projection.evidence_queries || []).filter((query) => (
    query.component_ids?.includes(componentId) || (edge && query.edge_ids?.includes(edge.edge_id))
  ));
  const relatedActivity = (projection.agent_activity || []).filter((activity) => (
    activity.selected_component_id === componentId
    || (edge && activity.selected_edge_id === edge.edge_id)
  ));
  const scopedComponentIds = edge
    ? [componentId, edge.target_component_id]
    : [componentId];
  const evidenceRefs = uniqueOrdered([
    ...componentMetricEvidenceRefs(ui.series, scopedComponentIds, ui.seriesId),
    ...relatedQueries.flatMap((query) => query.evidence_refs || []),
    ...relatedActivity.flatMap((activity) => activity.evidence_refs || [])
  ]);
  const fresh = graphFreshness(projection, ui.now);
  const metric = componentId ? componentMetricLabel(ui.series, componentId, ui.seriesId) : null;
  const relation = edge ? `${node?.display_name || edge.source_component_id} → ${(graph.nodes || []).find((item) => item.component_id === edge.target_component_id)?.display_name || edge.target_component_id}` : null;
  const canAsk = !view.reviewingHistory
    && ["TRIAGE", "INVESTIGATE", "DECIDE"].includes(view.currentStage)
    && view.visibleStage === view.currentStage
    && projection.lifecycle_state !== "RESOLVED"
    && projection.current_attempt?.status !== "COMPLETED";
  const tabMarkup = tab === "now"
    ? portalNowMarkup(node, relation, metric, fresh, evidenceRefs.length, graphNodeTone(node || {}, projection, ui.now))
    : tab === "activity"
      ? portalActivityMarkup(relatedActivity)
      : portalEvidenceMarkup(relatedQueries, evidenceRefs);
  const stageEvents = stageAgentEvents(view, projection);
  const role = stageAgentRole(view.visibleStage);
  const context = ui.portalOpen
    ? `<div class="iw3-agent-context"><div class="iw3-portal-tabs" role="tablist" aria-label="Agent Rail context">${["now", "activity", "evidence"].map((item) => `<button type="button" role="tab" data-portal-tab="${item}" aria-selected="${tab === item}">${item === "now" ? "Now" : titleCase(item)}</button>`).join("")}</div><div class="iw3-portal-body">${tabMarkup}</div></div>`
    : `<div class="iw3-agent-events"><header><span>Actionable events</span><strong>${stageEvents.length ? `${stageEvents.length} latest` : "No events"}</strong></header>${stageEvents.length ? `<ol>${stageEvents.map(agentRailEventMarkup).join("")}</ol>` : '<p class="iw3-portal-empty">No scoped Agent event has been published for this stage run.</p>'}</div>`;
  const contextActions = ui.portalOpen
    ? `<button type="button" data-portal-close aria-label="Close Agent Rail context">Close context</button>`
    : "";
  return `<aside class="iw3-agent-portal iw3-agent-rail${ui.portalOpen ? " is-context-open" : ""}" role="${ui.portalOpen ? "dialog" : "complementary"}"${ui.portalOpen ? ' aria-modal="true"' : ""} aria-labelledby="iw3-agent-rail-title" aria-label="Agent Rail" data-agent-rail-dialog="${ui.portalOpen ? "true" : "false"}" data-agent-stage="${escapeHtml(view.visibleStage)}" data-agent-role="${escapeHtml(role)}" data-portal-context="${escapeHtml(componentId || "")}">
    <button type="button" class="iw3-agent-rail-toggle" data-agent-rail-toggle aria-expanded="${String(Boolean(ui.portalOpen))}">Agent Rail · ${escapeHtml(stageLabel(view.visibleStage))}</button>
    <header class="iw3-portal-header"><div><span>Agent Rail · ${escapeHtml(stageLabel(view.visibleStage))}</span><h3 id="iw3-agent-rail-title">${escapeHtml(role)}</h3><small>${escapeHtml(view.visibleRun?.stage_run_id || "Stage run unavailable")}</small></div>${contextActions}</header>
    ${context}
    <footer class="iw3-portal-footer"><div class="iw3-agent-rail-actions"><button type="button" data-open-panel="activity">Activity</button><button type="button" data-open-panel="evidence">Evidence</button>${ui.portalOpen ? '<button type="button" data-open-panel="graph">Dataflow</button>' : ""}</div>${portalAgentNoticeMarkup(ui.agentNotice)}${ui.portalOpen ? (canAsk ? `<div class="iw3-portal-composer"><textarea data-agent-question maxlength="1000" placeholder="Ask about this component or relation">${escapeHtml(ui.agentDraft || "")}</textarea><button type="button" class="is-primary" data-agent-question-submit${ui.commandPending ? " disabled" : ""}>${ui.commandPending === "START_AGENT_RUN" ? "Running…" : "Ask Agent"}</button></div>` : `<p>Agent questions unlock in Triage, Investigate, and Decide.</p>`) : ""}</footer>
  </aside>`;
}

function stageAgentRole(stage) {
  return ({ DETECT: "Observer", TRIAGE: "Observer", INVESTIGATE: "Investigator + Critic", DECIDE: "Evaluator", RESPOND: "Executor", VERIFY: "Verifier" })[stage] || "Agent";
}

function stageAgentEvents(view, projection) {
  const stage = view.visibleStage;
  const stageRunId = view.visibleRun?.stage_run_id;
  return (projection.agent_activity || [])
    .filter((activity) => activity.stage === stage && (!stageRunId || activity.stage_run_id === stageRunId))
    .slice()
    .sort((left, right) => Date.parse(left.occurred_at || "") - Date.parse(right.occurred_at || ""))
    .slice(-4)
    .reverse();
}

function agentRailEventMarkup(activity) {
  const state = String(activity.state || "UNKNOWN").toLowerCase();
  return `<li data-state="${escapeHtml(state)}"><span aria-hidden="true"></span><div><strong>${escapeHtml(activity.label || titleCase(activity.role || "Agent event"))}</strong><p>${escapeHtml(compactAgentEventSummary(activity.summary || "Recorded event"))}</p><small>${escapeHtml(stateLabel(activity.state))} · ${escapeHtml(shortTime(activity.occurred_at))} · ${(activity.evidence_refs || []).length} evidence</small></div></li>`;
}

function compactAgentEventSummary(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

function portalAgentNoticeMarkup(notice) {
  if (!notice?.message) return "";
  const state = ["pending", "success", "error"].includes(notice.state) ? notice.state : "pending";
  return `<p class="iw3-portal-agent-notice is-${state}" data-agent-run-state="${state}" role="${state === "error" ? "alert" : "status"}">${escapeHtml(notice.message)}</p>`;
}

function portalNowMarkup(node, relation, metric, freshness, evidenceCount, tone) {
  if (!node) return '<p class="iw3-portal-empty">No evidence-backed component is selected.</p>';
  return `<div class="iw3-portal-now"><section data-tone="${escapeHtml(tone)}"><span>Runtime</span><strong>${escapeHtml(titleCase(node.runtime_status))}</strong><small>${escapeHtml(titleCase(node.impact_status))}</small></section><section><span>Latest signal</span><strong>${escapeHtml(metric || "No numeric sample")}</strong><small>${escapeHtml(titleCase(freshness))}</small></section><section><span>Evidence</span><strong>${escapeHtml(String(evidenceCount))}</strong><small>${evidenceCount === 1 ? "reference" : "references"}</small></section>${relation ? `<section class="is-relation"><span>Relation</span><strong>${escapeHtml(relation)}</strong><small>Evidence-backed path</small></section>` : ""}</div>`;
}

function portalActivityMarkup(items) {
  if (!items.length) return '<p class="iw3-portal-empty">No scoped Agent activity has been published.</p>';
  return `<ol class="iw3-portal-activity">${items.slice(-5).reverse().map((activity) => `<li data-state="${escapeHtml(String(activity.state || "UNKNOWN").toLowerCase())}"><span aria-hidden="true"></span><div><strong>${escapeHtml(activity.label || titleCase(activity.role))}</strong><p>${escapeHtml(activity.summary)}</p><small>${escapeHtml(stateLabel(activity.state))} · ${escapeHtml(shortTime(activity.occurred_at))}</small></div></li>`).join("")}</ol>`;
}

function portalEvidenceMarkup(queries, refs) {
  if (!queries.length && !refs.length) return '<p class="iw3-portal-empty">No scoped evidence reference has been published yet.</p>';
  return `<div class="iw3-portal-evidence">${queries.slice(-3).map((query) => `<article><strong>${escapeHtml(query.query_name)}</strong><p>${escapeHtml(query.result_summary)}</p><small>${(query.evidence_refs || []).length} evidence · ${escapeHtml(stateLabel(query.state))}</small></article>`).join("")}<ul>${refs.map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("")}</ul></div>`;
}

function timelineMarkup(projection, view) {
  return `<ol class="iw3-timeline">${view.rail.filter((item) => item.run).map((item) => `<li><span>${escapeHtml(shortTime(item.run.started_at))}</span><strong>${stageLabel(item.stage)}</strong><small>${stateLabel(item.status)}</small></li>`).join("")}</ol>`;
}

function listMarkup(items, empty) {
  return `<ul class="iw3-record-list">${(items || []).map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.statement || item.summary || (item.label && item.value ? `${item.label}: ${item.value}` : JSON.stringify(item) || "Recorded item"))}</li>`).join("") || `<li>${escapeHtml(empty)}</li>`}</ul>`;
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
  if (unit === "requests") return `${formatted} ${Number(value) === 1 ? "request" : "requests"}`;
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

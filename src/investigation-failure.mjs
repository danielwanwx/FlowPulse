import { createHash } from "node:crypto";
import { safeFailure } from "./openai-response.mjs";

export function investigationFailure(error) {
  const modelFailure = safeFailure(error);
  if (modelFailure) return modelFailure;
  if (error?.name === "CausalEvidenceError") {
    return {
      classification: error.classification || "insufficient_evidence",
      code: "causal_evidence_rejected",
      httpStatus: 422,
      metadata: safeEpisodeMetadata(error.metadata),
      message: "The diagnosis did not satisfy the evidence gate."
    };
  }
  if (error?.name === "InsufficientEvidenceError") {
    return {
      classification: "insufficient_evidence",
      code: "insufficient_evidence",
      httpStatus: 422,
      metadata: safeEpisodeMetadata(error.metadata),
      message: "The evidence was insufficient to continue."
    };
  }
  return null;
}

export function investigationFailureClassification(error) {
  return investigationFailure(error)?.classification || "tool_data_failure";
}

export function recordInvestigationFailure({ runtime, runId, error, failedType, actor = "runtime" }) {
  const failure = investigationFailure(error) || {
    classification: "tool_data_failure",
    code: "unclassified_investigation_failure",
    httpStatus: 502,
    metadata: {},
    message: "The investigation could not continue."
  };
  failure.metadata = completeFailureEpisodeMetadata(failure.metadata, failure.code);
  const failureId = stableFailureId({ runId, failedType, classification: failure.classification, code: failure.code, metadata: failure.metadata });
  const payload = {
    failure_id: failureId,
    classification: failure.classification,
    code: failure.code,
    metadata: failure.metadata
  };
  appendFailureOnce(runtime, runId, "failure.episode.recorded", "runtime", {
    ...payload,
    episode: {
      schema_version: "flowpulse.failure_episode.v1",
      ...safeEpisodeMetadata(failure.metadata)
    }
  }, failureId);
  appendFailureOnce(runtime, runId, "outcome.classified", actor, payload, failureId);
  appendFailureOnce(runtime, runId, failedType, "runtime", payload, failureId);
  return { ...failure, failureId };
}

export function projectFailureEpisode(events = []) {
  const episode = [...events].reverse().find((event) => event.type === "failure.episode.recorded");
  if (!episode) return {
    legacy_detail_status: events.some((event) => event.type === "development.investigation.failed" || event.type === "live.run.failed")
      ? "legacy_detail_unavailable" : "not_recorded"
  };
  const detail = safeEpisodeMetadata(episode.payload?.episode);
  return {
    legacy_detail_status: "available",
    failure_id: safeText(episode.payload?.failure_id, 120),
    stage: detail.stage || null,
    attempt: detail.attempt ?? null,
    round: detail.round ?? null,
    validator_id: detail.validator_id || null,
    reason_code: detail.reason_code || null,
    field_path: detail.field_path || null,
    tool_coverage: detail.tool_coverage || [],
    missing_evidence_classes: detail.missing_evidence_classes || [],
    next_precondition: detail.next_precondition || null,
    context_sha256: detail.context_sha256 || null,
    harness: detail.harness || null
  };
}

export function investigationFailureEnvelope(failure, state) {
  return {
    error: {
      code: failure.code,
      classification: failure.classification,
      failure_id: failure.failureId,
      message: failure.message
    },
    state
  };
}

// Failure responses must remain usable when the live connector that caused the
// investigation failure is unavailable. This projection intentionally reads
// only the local ledger and the loaded incident bundle; it never asks a source
// adapter, evidence projection, agent control service, or observability sink.
export function localFailureState(runtime, runId) {
  const events = runtime.ledger.list(runId);
  const started = events.find((event) => event.type === "run.started");
  const requested = events.some((event) => event.type === "approval.requested");
  const granted = events.some((event) => event.type === "approval.granted");
  const complete = events.some((event) => event.type === "policy.evaluated");
  const last = events.at(-1);
  const incident = runtime.bundle?.incident || {};
  const failure = projectFailureEpisode(events);
  return {
    run_id: runId,
    mode: safeMode(started?.payload?.mode),
    status: "degraded",
    stage: "failure_response",
    waiting_for_approval: requested && !granted,
    complete,
    event_count: events.length,
    last_event: last ? {
      sequence: Number.isSafeInteger(last.sequence) ? last.sequence : null,
      type: safeEventType(last.type),
      recorded_at: safeRecordedAt(last.recorded_at)
    } : null,
    incident: {
      id: safeText(incident.id, 160),
      title: safeText(incident.title, 240),
      severity: safeText(incident.severity, 32),
      environment: safeText(incident.environment, 120)
    },
    evidence: [],
    source: {
      kind: "unavailable",
      status: "unavailable",
      authoritative: false,
      raw_records_excluded: true,
      reason: "Failure response uses only the local append-only ledger."
    },
    agent_control: {
      status: "unavailable",
      authority: "append-only-ledger"
    },
    harness: {
      manifest: failure.harness ? { version: failure.harness.version || null, sha256: failure.harness.manifest_sha256 || null } : { legacy_detail_status: failure.legacy_detail_status },
      current_stage: failure.stage || null,
      attempt: failure.attempt ?? null,
      last_context_sha256: failure.context_sha256 || null,
      failure: {
        legacy_detail_status: failure.legacy_detail_status,
        boundary: failure.stage || null,
        validator_id: failure.validator_id || null,
        reason_code: failure.reason_code || null,
        tool_coverage: failure.tool_coverage || [],
        missing_evidence_classes: failure.missing_evidence_classes || [],
        next_precondition: failure.next_precondition || null
      }
    }
  };
}

function appendFailureOnce(runtime, runId, type, actor, payload, failureId) {
  const id = `evt-${failureId}-${type.replaceAll(".", "-")}`;
  const event = {
    id,
    runId,
    incidentId: runtime.bundle?.incident?.id || "failure-audit",
    type,
    actor,
    payload,
    evidenceRefs: [],
    correlationId: `${runId}:failure:${failureId}:${type}`
  };
  if (typeof runtime.ledger.appendIfAbsent === "function") return runtime.ledger.appendIfAbsent(event);
  const existing = runtime.ledger.list(runId).find((item) => item.id === id || (item.type === type && item.payload?.failure_id === payload.failure_id));
  return existing ? { event: existing, inserted: false } : { event: runtime.append(runId, type, actor, payload), inserted: true };
}

function stableFailureId(value) {
  return `failure-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

const MAX_EPISODE_BYTES = 12 * 1024;
const EPISODE_TRUNCATION_RESERVE_BYTES = 256;

function safeEpisodeMetadata(value = {}) {
  const metadata = value && typeof value === "object" ? value : {};
  const toolCoverage = Array.isArray(metadata.tool_coverage) ? metadata.tool_coverage.slice(0, 24).map((item) => compact({
    tool: safeText(item?.tool, 80), entity: safeText(item?.entity, 120), attempt: safeInt(item?.attempt), round: safeInt(item?.round),
    result_count: safeInt(item?.result_count), selected_count: safeInt(item?.selected_count), omitted_count: safeInt(item?.omitted_count), context_sha256: safeHash(item?.context_sha256)
  })).filter((item) => item.tool && item.entity) : [];
  const harness = safeHarness(metadata.harness);
  const critical = compact({
    stage: ["investigator", "evaluator", "diagnosis_gate", "context_compiler", "evidence_snapshot"].includes(metadata.stage) ? metadata.stage : null,
    attempt: safePositiveInt(metadata.attempt),
    round: safeInt(metadata.round),
    validator_id: safeText(metadata.validator_id, 120),
    field_path: safeText(metadata.field_path, 160),
    reason_code: safeText(metadata.reason_code, 120),
    next_precondition: safeText(metadata.next_precondition, 160),
    context_sha256: safeHash(metadata.context_sha256),
    harness,
    response_ref: safeResponseHash(metadata.response_ref),
    response_body_ref: safeResponseHash(metadata.response_body_ref),
    response_body_bytes: safeInt(metadata.response_body_bytes),
    response_status: safeText(metadata.response_status, 80),
    usage: safeUsage(metadata.usage)
  });
  // The causal boundary must survive maximum legal detail. Build optional lists
  // deterministically under a reserve for explicit truncation counts; never
  // replace the episode with an empty object.
  const values = {
    tool_coverage: toolCoverage,
    selected_evidence_refs: safeIds(metadata.selected_evidence_refs),
    omitted_evidence_refs: safeOmitted(metadata.omitted_evidence_refs),
    missing_evidence_classes: safeStrings(metadata.missing_evidence_classes, 8, 80)
  };
  const truncation = safeTruncation(metadata.episode_truncation);
  const output = { ...critical, episode_truncation: truncation };
  for (const [key, entries] of Object.entries(values)) {
    const selected = [];
    for (const entry of entries) {
      const candidate = { ...output, [key]: [...selected, entry] };
      if (jsonBytes(candidate) > MAX_EPISODE_BYTES - EPISODE_TRUNCATION_RESERVE_BYTES) break;
      selected.push(entry);
    }
    if (selected.length) output[key] = selected;
    truncation[key] += entries.length - selected.length;
  }
  const bounded = compact(output);
  if (jsonBytes(bounded) <= MAX_EPISODE_BYTES) return bounded;

  // Defensive final path for future field additions: retain every critical
  // causal field and explicit loss accounting, never a generic fallback.
  const fallback = compact({
    ...critical,
    episode_truncation: Object.fromEntries(Object.entries(values).map(([key, entries]) => [key, truncation[key] + entries.length]))
  });
  return jsonBytes(fallback) <= MAX_EPISODE_BYTES ? fallback : critical;
}

function completeFailureEpisodeMetadata(value, code) {
  const metadata = value && typeof value === "object" ? value : {};
  const stage = metadata.stage || "evidence_snapshot";
  const beforeAuthority = stage === "evidence_snapshot";
  return safeEpisodeMetadata({
    ...metadata,
    stage,
    validator_id: metadata.validator_id || (beforeAuthority ? "selected_evidence_source" : code),
    reason_code: metadata.reason_code || (beforeAuthority ? `${code}_before_model_authority` : code),
    ...(metadata.field_path ? {} : (stage === "investigator" || stage === "evaluator" ? { field_path: "response.output" } : {})),
    ...(beforeAuthority ? {
      missing_evidence_classes: metadata.missing_evidence_classes || ["bounded_selected_evidence"],
      next_precondition: metadata.next_precondition || "provide_a_fresh_selected_evidence_source"
    } : {})
  });
}

function safeHarness(value) {
  if (!value || typeof value !== "object" || !safeHash(value.manifest_sha256)) return null;
  const skills = value.skills && typeof value.skills === "object" ? Object.fromEntries(["investigator", "evaluator"].flatMap((name) => {
    const skill = value.skills[name];
    return skill && safeText(skill.id, 120) && safeText(skill.version, 80) && safeHash(skill.sha256) ? [[name, { id: skill.id, version: skill.version, sha256: skill.sha256 }]] : [];
  })) : {};
  const protocols = value.protocols && typeof value.protocols === "object" ? Object.fromEntries(Object.entries(value.protocols)
    .filter(([key, hash]) => ["sha256", "tool_protocol_sha256", "investigator_evaluator_handoff_sha256", "owner_repair_sha256", "safe_failure_sha256"].includes(key) && safeHash(hash))) : {};
  return compact({ version: safeText(value.version, 80), manifest_sha256: safeHash(value.manifest_sha256), skills, protocols });
}

function safeUsage(value) {
  if (!value || typeof value !== "object") return null;
  return compact({ input_tokens: safeInt(value.input_tokens), output_tokens: safeInt(value.output_tokens), reasoning_tokens: safeInt(value.reasoning_tokens), total_tokens: safeInt(value.total_tokens) });
}
function safeIds(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, 160)))].sort().slice(0, 120) : []; }
function safeOmitted(value) {
  const reasons = new Set(["duplicate", "tool_record_cap", "tool_byte_cap", "attempt_record_cap", "attempt_byte_cap"]);
  return Array.isArray(value) ? value.filter((item) => safeText(item?.id, 160) && reasons.has(item.reason)).map((item) => ({ id: item.id, reason: item.reason })).slice(0, 120) : [];
}
function safeStrings(value, limit, itemLimit) { return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, itemLimit)))].sort().slice(0, limit) : []; }
function safeHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function safeResponseHash(value) { return typeof value === "string" && /^[a-f0-9]{16,64}$/i.test(value) ? value : null; }
function safeInt(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safePositiveInt(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function safeTruncation(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(["tool_coverage", "selected_evidence_refs", "omitted_evidence_refs", "missing_evidence_classes"].map((key) => [key, Number.isSafeInteger(source[key]) && source[key] >= 0 && source[key] <= 10_000 ? source[key] : 0]));
}
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && (!Array.isArray(item) || item.length) && (!(item && typeof item === "object" && !Array.isArray(item)) || Object.keys(item).length))); }
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function safeMode(value) {
  return ["replay", "live", "development"].includes(value) ? value : "unknown";
}

function safeEventType(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,120}$/.test(value) ? value : "unknown";
}

function safeRecordedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeText(value, limit) {
  if (typeof value !== "string") return null;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > 0 && bytes <= limit ? value : null;
}

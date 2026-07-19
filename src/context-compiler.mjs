import { createHash } from "node:crypto";

export const CONTEXT_MAX_RECORDS_PER_TOOL = 32;
export const CONTEXT_MAX_BYTES_PER_TOOL = 32 * 1024;
export const CONTEXT_MAX_UNIQUE_REFS_PER_ATTEMPT = 96;
export const CONTEXT_MAX_BYTES_PER_ATTEMPT = 128 * 1024;

const OMIT_REASONS = new Set(["duplicate", "tool_record_cap", "tool_byte_cap", "attempt_record_cap", "attempt_byte_cap"]);

export class ContextCompilationError extends Error {
  constructor(code, metadata = {}) {
    super("Context compilation rejected unsafe or incomplete evidence");
    this.name = "ContextCompilationError";
    this.code = code;
    this.classification = "insufficient_evidence";
    this.metadata = normalizeMetadata(metadata);
  }
}

export function createContextAccumulator() {
  return { selectedIds: new Set(), sentBytes: 0, toolCoverage: [], lastContextSha256: null };
}

export function compileToolContext({ items, tool, entity, attempt, round, accumulator = createContextAccumulator(), requiredEvidenceIds = [] } = {}) {
  if (!Array.isArray(items) || typeof tool !== "string" || typeof entity !== "string" || !positiveInt(attempt) || !positiveInt(round)) {
    throw new ContextCompilationError("context_input_invalid", { stage: "investigator", attempt, round, validator_id: "context_input" });
  }
  const required = new Set(requiredEvidenceIds);
  const unique = new Map();
  const omitted = [];
  for (const item of [...items].sort(compare)) {
    if (!isSafeEvidence(item)) throw new ContextCompilationError("context_evidence_invalid", {
      stage: "investigator", attempt, round, validator_id: "context_evidence_shape", field_path: "tool_result[]"
    });
    if (unique.has(item.id)) {
      omitted.push({ id: item.id, reason: "duplicate" });
      continue;
    }
    unique.set(item.id, item);
  }
  const ordered = [...unique.values()].sort((left, right) => Number(required.has(right.id)) - Number(required.has(left.id)) || compare(left, right));
  const selected = [];
  for (const item of ordered) {
    const newRef = !accumulator.selectedIds.has(item.id);
    const overToolRecords = selected.length >= CONTEXT_MAX_RECORDS_PER_TOOL;
    // The model receives the serialized array, not isolated record strings.
    // Include array delimiters and commas in every cap decision.
    const candidateBytes = payloadBytes([...selected, item]);
    const overToolBytes = candidateBytes > CONTEXT_MAX_BYTES_PER_TOOL;
    const overAttemptRecords = newRef && accumulator.selectedIds.size >= CONTEXT_MAX_UNIQUE_REFS_PER_ATTEMPT;
    // A repeated ref is still sent to the provider and therefore still spends
    // the attempt context budget. Unique-ref and sent-byte limits are separate.
    const overAttemptBytes = accumulator.sentBytes + candidateBytes > CONTEXT_MAX_BYTES_PER_ATTEMPT;
    const reason = overToolRecords ? "tool_record_cap"
      : overToolBytes ? "tool_byte_cap"
        : overAttemptRecords ? "attempt_record_cap"
          : overAttemptBytes ? "attempt_byte_cap" : null;
    if (reason) {
      if (required.has(item.id)) {
        throw new ContextCompilationError("context_required_evidence_omitted", {
          stage: "investigator", attempt, round, validator_id: "context_required_evidence",
          field_path: "tool_result[]", reason_code: reason,
          selected_evidence_refs: selected.map((entry) => entry.id),
          omitted_evidence_refs: [{ id: item.id, reason }],
          missing_evidence_classes: ["diagnosis_gate_required_record"],
          next_precondition: "increase_safe_context_budget_or_reduce_tool_scope"
        });
      }
      omitted.push({ id: item.id, reason });
      continue;
    }
    selected.push(item);
    if (newRef) {
      accumulator.selectedIds.add(item.id);
    }
  }
  for (const item of ordered.filter((item) => required.has(item.id))) {
    if (!selected.some((entry) => entry.id === item.id)) {
      throw new ContextCompilationError("context_required_evidence_missing", {
        stage: "investigator", attempt, round, validator_id: "context_required_evidence",
        missing_evidence_classes: ["diagnosis_gate_required_record"],
        next_precondition: "query_required_evidence"
      });
    }
  }
  const selectedRefs = selected.map((item) => item.id);
  const payload = JSON.stringify(selected);
  const toolBytes = Buffer.byteLength(payload, "utf8");
  if (toolBytes > CONTEXT_MAX_BYTES_PER_TOOL || accumulator.sentBytes + toolBytes > CONTEXT_MAX_BYTES_PER_ATTEMPT) {
    throw new ContextCompilationError("context_payload_budget_inconsistent", {
      stage: "investigator", attempt, round, validator_id: "context_payload_bytes",
      reason_code: toolBytes > CONTEXT_MAX_BYTES_PER_TOOL ? "tool_byte_cap" : "attempt_byte_cap",
      selected_evidence_refs: selectedRefs,
      missing_evidence_classes: requiredEvidenceIds.length ? ["diagnosis_gate_required_record"] : [],
      next_precondition: "reduce_tool_scope_or_start_a_new_attempt"
    });
  }
  accumulator.sentBytes += toolBytes;
  const context = {
    schema_version: "flowpulse.context.v1",
    stage: "investigator",
    attempt,
    round,
    tool,
    entity,
    authority_refs: selectedRefs,
    selected_count: selected.length,
    omitted_count: omitted.length,
    bytes: toolBytes,
    attempt_unique_ref_count: accumulator.selectedIds.size,
    attempt_bytes: accumulator.sentBytes,
    selected_evidence_refs: selectedRefs,
    omitted_evidence_refs: omitted.slice(0, 120),
    source_hashes: selected.map((item) => ({ id: item.id, hash: item.hash || item.provenance?.sha256 || null })).filter((item) => item.hash),
    non_authoritative_summary: true
  };
  const context_sha256 = hash(context);
  accumulator.toolCoverage.push({ tool, entity, attempt, round, result_count: items.length, selected_count: selected.length, omitted_count: omitted.length, context_sha256 });
  accumulator.lastContextSha256 = context_sha256;
  return {
    items: selected,
    payload,
    authorityRefs: new Set(selectedRefs),
    context: { ...context, context_sha256 },
    accumulator
  };
}

export function contextFailureMetadata(context = {}) {
  return normalizeMetadata({
    stage: context.stage || "investigator",
    attempt: context.attempt,
    round: context.round,
    validator_id: context.validator_id || "context_compiler",
    field_path: context.field_path,
    reason_code: context.reason_code || "context_compilation_rejected",
    tool_coverage: context.tool_coverage,
    selected_evidence_refs: context.selected_evidence_refs,
    omitted_evidence_refs: context.omitted_evidence_refs,
    missing_evidence_classes: context.missing_evidence_classes,
    next_precondition: context.next_precondition,
    context_sha256: context.context_sha256
  });
}

export function normalizeMetadata(metadata = {}) {
  const selected = boundedIds(metadata.selected_evidence_refs);
  const omitted = boundedOmitted(metadata.omitted_evidence_refs);
  const coverage = Array.isArray(metadata.tool_coverage) ? metadata.tool_coverage.slice(0, 24).map((item) => ({
    tool: safeText(item?.tool, 80), entity: safeText(item?.entity, 120), attempt: safeInt(item?.attempt), round: safeInt(item?.round),
    result_count: safeInt(item?.result_count), selected_count: safeInt(item?.selected_count), omitted_count: safeInt(item?.omitted_count), context_sha256: safeHash(item?.context_sha256)
  })) : [];
  return compact({
    stage: ["investigator", "evaluator", "diagnosis_gate", "context_compiler"].includes(metadata.stage) ? metadata.stage : null,
    attempt: safeInt(metadata.attempt),
    round: safeInt(metadata.round),
    validator_id: safeText(metadata.validator_id, 120),
    field_path: safeText(metadata.field_path, 160),
    reason_code: safeText(metadata.reason_code, 120),
    tool_coverage: coverage,
    selected_evidence_refs: selected,
    omitted_evidence_refs: omitted,
    missing_evidence_classes: Array.isArray(metadata.missing_evidence_classes) ? metadata.missing_evidence_classes.filter((item) => safeText(item, 80)).slice(0, 8) : [],
    next_precondition: safeText(metadata.next_precondition, 160),
    context_sha256: safeHash(metadata.context_sha256)
  });
}

function boundedIds(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, 160)))].sort().slice(0, 120) : []; }
function boundedOmitted(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!item || !safeText(item.id, 160) || !OMIT_REASONS.has(item.reason)) continue;
    const key = `${item.id}:${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id: item.id, reason: item.reason });
  }
  return output.sort((a, b) => `${a.id}:${a.reason}`.localeCompare(`${b.id}:${b.reason}`)).slice(0, 120);
}
function isSafeEvidence(item) { return item && typeof item === "object" && safeText(item.id, 160) && safeText(item.kind, 80) && safeText(item.source, 160) && (safeHash(item.hash) || safeHash(item.provenance?.sha256)); }
function compare(a, b) { return String(a.id).localeCompare(String(b.id)); }
function positiveInt(value) { return Number.isSafeInteger(value) && value > 0; }
function safeInt(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function safeText(value, max) { return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= max ? value : null; }
function payloadBytes(items) { return Buffer.byteLength(JSON.stringify(items), "utf8"); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && (!Array.isArray(item) || item.length))); }
function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { return Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value); }

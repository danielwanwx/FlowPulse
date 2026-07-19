import { createHash } from "node:crypto";

export const RESPONSE_LIMITS = Object.freeze({
  maxResponseBytes: 1_048_576,
  maxOutputItems: 32,
  maxToolCalls: 8,
  maxToolArgumentBytes: 2_048,
  maxReasoningBytes: 65_536,
  diagnosisTextBytes: 24_576,
  evaluationTextBytes: 12_288
});

const ALLOWED_OUTPUT_TYPES = new Set(["reasoning", "function_call", "message"]);
const ALLOWED_INCOMPLETE_REASONS = new Set(["max_output_tokens", "content_filter"]);
const SAFE_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress", "unknown"]);
const SAFE_STAGES = new Set(["investigator", "evaluator"]);
const MAX_CALL_ID_BYTES = 256;
const OMIT_REASONS = new Set(["duplicate", "tool_record_cap", "tool_byte_cap", "attempt_record_cap", "attempt_byte_cap"]);

export class ModelResponseError extends Error {
  constructor({ code, classification, httpStatus, metadata = {} }) {
    super(safeMessage(code));
    this.name = "ModelResponseError";
    this.code = code;
    this.classification = classification;
    this.httpStatus = httpStatus;
    this.metadata = metadata;
  }
}

export class ModelTransportError extends ModelResponseError {
  constructor(code = "transport_failed", metadata) { super({ code, classification: "model_transport_failure", httpStatus: code === "request_timeout" ? 504 : 502, metadata }); this.name = "ModelTransportError"; }
}

export class ModelApiError extends ModelResponseError {
  constructor(code = "api_response_invalid", metadata) { super({ code, classification: "model_api_failure", httpStatus: 502, metadata }); this.name = "ModelApiError"; }
}

export class ModelIncompleteError extends ModelResponseError {
  constructor(code = "response_incomplete", metadata) { super({ code, classification: "model_output_incomplete", httpStatus: 422, metadata }); this.name = "ModelIncompleteError"; }
}

export class ModelRefusalError extends ModelResponseError {
  constructor(metadata) { super({ code: "model_refusal", classification: "model_refusal", httpStatus: 422, metadata }); this.name = "ModelRefusalError"; }
}

export class ModelOutputInvalidError extends ModelResponseError {
  constructor(code = "structured_output_invalid", metadata) { super({ code, classification: "model_output_invalid", httpStatus: 422, metadata }); this.name = "ModelOutputInvalidError"; }
}

export class ModelBudgetExceededError extends ModelResponseError {
  constructor(code = "workflow_budget_exhausted", metadata) { super({ code, classification: "model_budget_exhausted", httpStatus: 422, metadata }); this.name = "ModelBudgetExceededError"; }
}

export function isModelResponseError(error) {
  return error instanceof ModelResponseError;
}

export async function requestOpenAIResponse({ fetchImpl = fetch, url, body, timeoutMs = 60_000, limits = RESPONSE_LIMITS }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ModelTransportError(timedOut ? "request_timeout" : "transport_failed", { timeout_ms: timeoutMs });
  }

  const { parsed, bodyRef, byteLength } = await readBoundedJson(response, limits.maxResponseBytes);
  const responseMeta = responseMetadata(parsed, { bodyRef, byteLength });
  if (!response.ok) {
    throw new ModelApiError("api_non_success", { ...responseMeta, upstream_status: response.status });
  }
  return { data: parsed, metadata: responseMeta };
}

export function inspectOpenAIResponse(data, metadata, { entities, stage, limits = RESPONSE_LIMITS }) {
  const safe = validateResponseState(data, metadata);
  const output = data.output;
  if (!Array.isArray(output) || output.length < 1 || output.length > limits.maxOutputItems) {
    throw new ModelOutputInvalidError("output_item_count_invalid", safe);
  }
  const types = output.map((item) => item?.type);
  if (types.some((type) => !ALLOWED_OUTPUT_TYPES.has(type))) {
    throw new ModelOutputInvalidError("output_type_not_allowlisted", { ...safe, output_type_counts: typeCounts(types) });
  }
  const replayItems = validateReplayItems(output, safe, limits);
  const calls = output.filter((item) => item.type === "function_call");
  const messages = output.filter((item) => item.type === "message");
  if (calls.length && messages.length) {
    throw new ModelOutputInvalidError("mixed_tool_and_terminal_output", { ...safe, output_type_counts: typeCounts(types) });
  }
  if (calls.length) {
    return {
      kind: "tool_calls",
      calls: validateToolCalls(calls, entities, safe, limits),
      replayItems,
      metadata: { ...safe, output_type_counts: typeCounts(types), stage }
    };
  }
  if (messages.length !== 1) {
    throw new ModelOutputInvalidError("terminal_message_count_invalid", { ...safe, output_type_counts: typeCounts(types) });
  }
  const message = messages[0];
  if (message.status !== "completed") {
    throw new ModelOutputInvalidError("terminal_message_not_completed", safe);
  }
  if (message.role !== "assistant") {
    throw new ModelOutputInvalidError("terminal_message_role_invalid", safe);
  }
  if (!Array.isArray(message.content) || message.content.length !== 1) {
    throw new ModelOutputInvalidError("terminal_content_count_invalid", safe);
  }
  const content = message.content[0];
  if (content?.type === "refusal") throw new ModelRefusalError({ ...safe, output_type_counts: typeCounts(types), stage });
  if (content?.type !== "output_text" || typeof content.text !== "string") {
    throw new ModelOutputInvalidError("terminal_content_invalid", { ...safe, output_type_counts: typeCounts(types) });
  }
  const maxTextBytes = stage === "evaluator" ? limits.evaluationTextBytes : limits.diagnosisTextBytes;
  const textBytes = Buffer.byteLength(content.text, "utf8");
  if (!textBytes || textBytes > maxTextBytes) {
    throw new ModelOutputInvalidError("structured_text_size_invalid", { ...safe, output_text_bytes: textBytes, stage });
  }
  let value;
  try {
    value = JSON.parse(content.text);
  } catch {
    throw new ModelOutputInvalidError("json_parse_failed", { ...safe, output_text_bytes: textBytes, stage });
  }
  if (!isPlainObject(value)) throw new ModelOutputInvalidError("structured_json_not_object", { ...safe, output_text_bytes: textBytes, stage });
  return {
    kind: "terminal",
    value,
    replayItems,
    metadata: { ...safe, output_type_counts: typeCounts(types), output_text_bytes: textBytes, stage }
  };
}

export function safeFailure(error) {
  if (isModelResponseError(error)) {
    return {
      classification: error.classification,
      code: error.code,
      httpStatus: error.httpStatus,
      metadata: safeFailureMetadata(error.metadata),
      message: safeMessage(error.code)
    };
  }
  return null;
}

// The request boundary owns stage context, while this module owns the response
// allowlist.  Merge only safe operational metadata onto typed provider errors.
export function attachModelFailureContext(error, context = {}) {
  if (!isModelResponseError(error)) return error;
  error.metadata = safeFailureMetadata({ ...(error.metadata || {}), ...context });
  return error;
}

export function safeFailureMetadata(metadata) {
  if (!isPlainObject(metadata)) return {};
  const safe = {};
  const responseRef = safeHashRef(metadata.response_ref);
  const bodyRef = safeHashRef(metadata.response_body_ref);
  const bodyBytes = safeInteger(metadata.response_body_bytes, RESPONSE_LIMITS.maxResponseBytes);
  const upstreamStatus = safeInteger(metadata.upstream_status, 599);
  const outputTextBytes = safeInteger(metadata.output_text_bytes, RESPONSE_LIMITS.maxResponseBytes);
  const maxOutputTokens = safeInteger(metadata.max_output_tokens, 49_152);
  const usedOutputTokens = safeInteger(metadata.used_output_tokens, 49_152);
  const usedResponses = safeInteger(metadata.used_responses, 10);
  const maxResponses = safeInteger(metadata.max_responses, 10);
  const stage = SAFE_STAGES.has(metadata.stage) ? metadata.stage : undefined;
  const attempt = safePositiveInteger(metadata.attempt, 2);
  const round = safeInteger(metadata.round, 24);
  const validatorId = safeText(metadata.validator_id, 120);
  const fieldPath = safeText(metadata.field_path, 160);
  const reasonCode = safeText(metadata.reason_code, 120);
  const nextPrecondition = safeText(metadata.next_precondition, 160);
  const contextSha256 = safeSha256(metadata.context_sha256);
  const harness = safeHarnessBinding(metadata.harness);
  const toolCoverage = safeToolCoverage(metadata.tool_coverage);
  const selectedEvidenceRefs = safeIds(metadata.selected_evidence_refs);
  const omittedEvidenceRefs = safeOmitted(metadata.omitted_evidence_refs);
  const missingEvidenceClasses = safeStrings(metadata.missing_evidence_classes, 8, 80);
  const responseStatus = SAFE_RESPONSE_STATUSES.has(metadata.response_status) ? metadata.response_status : undefined;
  const incompleteReason = [...ALLOWED_INCOMPLETE_REASONS, "unknown"].includes(metadata.incomplete_reason)
    ? metadata.incomplete_reason
    : undefined;
  const counts = safeOutputTypeCounts(metadata.output_type_counts);
  const usage = safeUsage(metadata.usage);
  if (responseRef) safe.response_ref = responseRef;
  if (bodyRef) safe.response_body_ref = bodyRef;
  if (bodyBytes !== undefined) safe.response_body_bytes = bodyBytes;
  if (upstreamStatus !== undefined && upstreamStatus >= 100) safe.upstream_status = upstreamStatus;
  if (outputTextBytes !== undefined) safe.output_text_bytes = outputTextBytes;
  if (maxOutputTokens !== undefined) safe.max_output_tokens = maxOutputTokens;
  if (usedOutputTokens !== undefined) safe.used_output_tokens = usedOutputTokens;
  if (usedResponses !== undefined) safe.used_responses = usedResponses;
  if (maxResponses !== undefined) safe.max_responses = maxResponses;
  if (stage) safe.stage = stage;
  if (attempt !== undefined) safe.attempt = attempt;
  if (round !== undefined) safe.round = round;
  if (validatorId) safe.validator_id = validatorId;
  if (fieldPath) safe.field_path = fieldPath;
  if (reasonCode) safe.reason_code = reasonCode;
  if (nextPrecondition) safe.next_precondition = nextPrecondition;
  if (contextSha256) safe.context_sha256 = contextSha256;
  if (harness) safe.harness = harness;
  if (toolCoverage.length) safe.tool_coverage = toolCoverage;
  if (selectedEvidenceRefs.length) safe.selected_evidence_refs = selectedEvidenceRefs;
  if (omittedEvidenceRefs.length) safe.omitted_evidence_refs = omittedEvidenceRefs;
  if (missingEvidenceClasses.length) safe.missing_evidence_classes = missingEvidenceClasses;
  if (responseStatus) safe.response_status = responseStatus;
  if (incompleteReason) safe.incomplete_reason = incompleteReason;
  if (counts) safe.output_type_counts = counts;
  if (usage) safe.usage = usage;
  return safe;
}

function validateResponseState(data, metadata) {
  if (!isPlainObject(data)) throw new ModelApiError("api_body_invalid", metadata);
  const safe = { ...metadata, response_status: safeStatus(data.status) };
  if (data.status === "incomplete") {
    const reason = ALLOWED_INCOMPLETE_REASONS.has(data.incomplete_details?.reason) ? data.incomplete_details.reason : "unknown";
    throw new ModelIncompleteError("response_incomplete", { ...safe, incomplete_reason: reason });
  }
  if (data.status !== "completed") {
    throw new ModelApiError("response_not_completed", safe);
  }
  if (data.error != null || data.incomplete_details != null) {
    throw new ModelOutputInvalidError("completed_response_state_invalid", safe);
  }
  return safe;
}

function validateReplayItems(output, metadata, limits) {
  for (const item of output) {
    if (!isPlainObject(item)) throw new ModelOutputInvalidError("output_item_invalid", metadata);
    if (item.type === "reasoning" && (typeof item.encrypted_content !== "string" || Buffer.byteLength(item.encrypted_content, "utf8") === 0)) {
      throw new ModelOutputInvalidError("encrypted_reasoning_missing", metadata);
    }
    if (item.type === "reasoning" && Buffer.byteLength(item.encrypted_content, "utf8") > limits.maxReasoningBytes) {
      throw new ModelOutputInvalidError("encrypted_reasoning_size_invalid", metadata);
    }
  }
  return output;
}

function validateToolCalls(calls, entities, metadata, limits) {
  if (calls.length > limits.maxToolCalls) throw new ModelOutputInvalidError("tool_call_count_invalid", metadata);
  const names = new Set(["query_metrics", "query_traces", "query_logs", "query_changes", "query_code", "query_deploys", "query_commits"]);
  const seen = new Set();
  return calls.map((call) => {
    if (call.status !== "completed") throw new ModelOutputInvalidError("tool_call_not_completed", metadata);
    if (!names.has(call.name) || typeof call.call_id !== "string" || Buffer.byteLength(call.call_id, "utf8") === 0 || Buffer.byteLength(call.call_id, "utf8") > MAX_CALL_ID_BYTES || seen.has(call.call_id)) {
      throw new ModelOutputInvalidError("tool_call_identity_invalid", metadata);
    }
    seen.add(call.call_id);
    if (typeof call.arguments !== "string" || Buffer.byteLength(call.arguments, "utf8") > limits.maxToolArgumentBytes) {
      throw new ModelOutputInvalidError("tool_arguments_size_invalid", metadata);
    }
    let args;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      throw new ModelOutputInvalidError("tool_arguments_json_invalid", metadata);
    }
    if (!isPlainObject(args) || Object.keys(args).length !== 1 || typeof args.entity !== "string" || !entities.includes(args.entity)) {
      throw new ModelOutputInvalidError("tool_arguments_not_allowlisted", metadata);
    }
    return { name: call.name, callId: call.call_id, args };
  });
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ModelApiError("api_body_too_large", { upstream_status: response.status });
  let bytes;
  try {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("response body is not streamable");
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ModelApiError("api_body_too_large", { upstream_status: response.status });
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    if (isModelResponseError(error)) throw error;
    throw new ModelApiError("api_body_unreadable", { upstream_status: response.status });
  }
  if (bytes.byteLength > maxBytes) throw new ModelApiError("api_body_too_large", { upstream_status: response.status });
  const bodyRef = hash(bytes);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ModelApiError("api_body_not_json", { upstream_status: response.status, response_body_ref: bodyRef, response_body_bytes: bytes.byteLength });
  }
  return { parsed, bodyRef, byteLength: bytes.byteLength };
}

function responseMetadata(data, { bodyRef, byteLength }) {
  const usage = data?.usage || {};
  return {
    response_ref: typeof data?.id === "string" ? hash(data.id) : null,
    response_body_ref: bodyRef,
    response_body_bytes: byteLength,
    response_status: safeStatus(data?.status),
    usage: {
      input_tokens: boundedInteger(usage.input_tokens),
      output_tokens: boundedInteger(usage.output_tokens),
      reasoning_tokens: boundedInteger(usage.output_tokens_details?.reasoning_tokens),
      total_tokens: boundedInteger(usage.total_tokens)
    }
  };
}

function typeCounts(types) {
  return types.reduce((counts, type) => {
    const key = ALLOWED_OUTPUT_TYPES.has(type) ? type : "other";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function safeStatus(value) {
  return ["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(value) ? value : "unknown";
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function safeInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safePositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : undefined;
}

function safeHashRef(value) {
  return typeof value === "string" && /^[a-f0-9]{16,64}$/i.test(value) ? value : undefined;
}

function safeUsage(value) {
  if (!isPlainObject(value)) return undefined;
  const usage = {};
  for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]) {
    const count = safeInteger(value[key], 49_152);
    if (count !== undefined) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function safeText(value, maximum) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= maximum ? value : undefined;
}

function safeSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function safeIds(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, 160)))].sort().slice(0, 120) : [];
}

function safeOmitted(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!safeText(item?.id, 160) || !OMIT_REASONS.has(item.reason)) continue;
    const key = `${item.id}:${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id: item.id, reason: item.reason });
  }
  return output.sort((left, right) => `${left.id}:${left.reason}`.localeCompare(`${right.id}:${right.reason}`)).slice(0, 120);
}

function safeStrings(value, limit, itemLimit) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, itemLimit)))].sort().slice(0, limit) : [];
}

function safeToolCoverage(value) {
  return Array.isArray(value) ? value.slice(0, 24).map((item) => compact({
    tool: safeText(item?.tool, 80), entity: safeText(item?.entity, 120), attempt: safePositiveInteger(item?.attempt, 2), round: safeInteger(item?.round, 24),
    result_count: safeInteger(item?.result_count, 10_000), selected_count: safeInteger(item?.selected_count, 96), omitted_count: safeInteger(item?.omitted_count, 10_000), context_sha256: safeSha256(item?.context_sha256)
  })).filter((item) => item.tool && item.entity) : [];
}

function safeHarnessBinding(value) {
  if (!isPlainObject(value) || !safeSha256(value.manifest_sha256)) return undefined;
  const skills = isPlainObject(value.skills) ? Object.fromEntries(["investigator", "evaluator"].flatMap((name) => {
    const skill = value.skills[name];
    return safeText(skill?.id, 120) && safeText(skill?.version, 80) && safeSha256(skill?.sha256)
      ? [[name, { id: skill.id, version: skill.version, sha256: skill.sha256 }]] : [];
  })) : {};
  const protocols = isPlainObject(value.protocols) ? Object.fromEntries(Object.entries(value.protocols)
    .filter(([key, hash]) => ["sha256", "tool_protocol_sha256", "investigator_evaluator_handoff_sha256", "owner_repair_sha256", "safe_failure_sha256"].includes(key) && safeSha256(hash))) : {};
  const model = isPlainObject(value.model) && safeText(value.model.id, 120) && safeText(value.model.reasoning_effort, 32) && typeof value.model.store === "boolean"
    ? { id: value.model.id, reasoning_effort: value.model.reasoning_effort, store: value.model.store } : undefined;
  return compact({ version: safeText(value.version, 80), manifest_sha256: safeSha256(value.manifest_sha256), model, skills, protocols });
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && (!Array.isArray(item) || item.length) && (!(item && typeof item === "object" && !Array.isArray(item)) || Object.keys(item).length)));
}

function safeOutputTypeCounts(value) {
  if (!isPlainObject(value)) return undefined;
  const counts = {};
  for (const type of ALLOWED_OUTPUT_TYPES) {
    const count = safeInteger(value[type], RESPONSE_LIMITS.maxOutputItems);
    if (count !== undefined) counts[type] = count;
  }
  return Object.keys(counts).length ? counts : undefined;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeMessage(code) {
  return ({
    transport_failed: "The model transport failed.",
    request_timeout: "The model request timed out.",
    api_non_success: "The model API returned a non-success response.",
    api_response_invalid: "The model API response was invalid.",
    api_body_invalid: "The model API response was invalid.",
    api_body_too_large: "The model API response exceeded the safety limit.",
    api_body_unreadable: "The model API response could not be read.",
    api_body_not_json: "The model API response was not JSON.",
    response_not_completed: "The model response did not complete.",
    response_incomplete: "The model response was incomplete.",
    model_refusal: "The model declined the request.",
    workflow_budget_exhausted: "The model workflow reached its safety budget."
  })[code] || "The model response could not be validated.";
}

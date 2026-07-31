import { open, stat } from "node:fs/promises";

const TRACE_WATERMARK_SCHEMA = "flowpulse.v3-local-trace-watermark.v1";
const FAILURE_EVIDENCE_SCHEMA = "flowpulse.v3-local-failure-evidence.v1";
const ASTRONOMY_TITLE = "Checkout cannot reach Payment";
const REPAIR_COMMAND = "astronomy.restore-payment-and-recreate-checkout";
const MAX_TRACE_LINE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

function fileIdentity(value) {
  if (!value) return null;
  return `${String(value.dev ?? "unknown")}:${String(value.ino ?? "unknown")}`;
}

async function readFileRange(path, start, length) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function missingFile(error) {
  return error?.code === "ENOENT";
}

export async function captureTraceWatermark(tracePath, dependencies = {}) {
  const statFile = dependencies.statFile || stat;
  const readRange = dependencies.readRange || readFileRange;
  const nowMs = dependencies.nowMs || Date.now;
  const recordedAtMs = Math.trunc(nowMs());
  let info = null;
  try {
    info = await statFile(tracePath);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
  const byteOffset = Number(info?.size || 0);
  let lineBoundary = byteOffset === 0;
  if (byteOffset > 0) {
    const last = await readRange(tracePath, byteOffset - 1, 1);
    lineBoundary = last.length === 1 && last[0] === 0x0a;
  }
  return {
    schema_version: TRACE_WATERMARK_SCHEMA,
    trace_path: tracePath,
    file_identity: fileIdentity(info),
    byte_offset: byteOffset,
    line_boundary: lineBoundary,
    recorded_at: new Date(recordedAtMs).toISOString(),
    recorded_at_unix_nano: (BigInt(recordedAtMs) * 1_000_000n).toString(),
  };
}

function otelValue(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  return null;
}

function attributes(values) {
  const result = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    if (typeof item?.key === "string") result.set(item.key, otelValue(item.value));
  }
  return result;
}

function spanUnixNano(span) {
  const raw = span?.endTimeUnixNano || span?.startTimeUnixNano;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function errorSpan(span) {
  const code = span?.status?.code;
  if (code === 2 || String(code || "").toUpperCase() === "STATUS_CODE_ERROR") return true;
  const values = attributes(span?.attributes);
  const rpcStatus = values.get("rpc.response.status_code") ?? values.get("rpc.grpc.status_code");
  return rpcStatus != null && !["0", "OK"].includes(String(rpcStatus).toUpperCase());
}

function paymentClientSpan(span) {
  const kind = String(span?.kind ?? "").toUpperCase();
  if (!["3", "SPAN_KIND_CLIENT", "CLIENT"].includes(kind)) return false;
  const values = attributes(span?.attributes);
  const targetMaterial = [
    span?.name,
    values.get("rpc.method"),
    values.get("rpc.service"),
    values.get("peer.service"),
    values.get("net.peer.name"),
    values.get("server.address"),
    values.get("url.full"),
    values.get("http.url"),
  ].filter((value) => value != null).join(" ").toLowerCase();
  return /(?:^|[./:_-])payment(?:service)?(?:$|[./:_-])/.test(targetMaterial);
}

function hasEnabledFaultEvent(span) {
  return (Array.isArray(span?.events) ? span.events : []).some((event) => {
    if (event?.name !== "feature_flag.evaluation") return false;
    const values = attributes(event.attributes);
    return values.get("feature_flag.key") === "paymentUnreachable"
      && (values.get("feature_flag.result.variant") === "on"
        || values.get("feature_flag.result.value") === true);
  });
}

function faultEventInLineage(candidate, spansById) {
  let current = candidate;
  const seen = new Set();
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (hasEnabledFaultEvent(current)) return true;
    const parentId = current.parentSpanId;
    if (!parentId || seen.has(parentId)) return false;
    seen.add(parentId);
    current = spansById.get(parentId);
  }
  return false;
}

function nanoToIso(value) {
  const milliseconds = Number(value / 1_000_000n);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/**
 * Accept only a real Checkout client error aimed at Payment whose ancestor
 * records paymentUnreachable=on in the same trace.  A generic error, a stale
 * record, or a frontend-only failure cannot open a V3 incident.
 */
export function checkoutPaymentFailureEvidence(batch, watermarkUnixNano) {
  let watermark;
  try {
    watermark = BigInt(watermarkUnixNano);
  } catch {
    throw new Error("Trace watermark timestamp is invalid");
  }
  for (const resourceSpans of Array.isArray(batch?.resourceSpans) ? batch.resourceSpans : []) {
    const resource = attributes(resourceSpans?.resource?.attributes);
    const serviceName = String(resource.get("service.name") || "").toLowerCase();
    if (!/(^|[-_.])checkout($|[-_.])/.test(serviceName)) continue;
    const scopes = resourceSpans.scopeSpans || resourceSpans.instrumentationLibrarySpans || [];
    const spans = scopes.flatMap((scope) => Array.isArray(scope?.spans) ? scope.spans : []);
    const byTrace = new Map();
    for (const span of spans) {
      if (typeof span?.traceId !== "string" || typeof span?.spanId !== "string") continue;
      if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, []);
      byTrace.get(span.traceId).push(span);
    }
    for (const [traceId, traceSpans] of byTrace) {
      const spansById = new Map(traceSpans.map((span) => [span.spanId, span]));
      for (const span of traceSpans) {
        const observedAt = spanUnixNano(span);
        if (observedAt == null || observedAt < watermark) continue;
        if (!errorSpan(span) || !paymentClientSpan(span) || !faultEventInLineage(span, spansById)) continue;
        return {
          schema_version: FAILURE_EVIDENCE_SCHEMA,
          trace_id: traceId,
          span_id: span.spanId,
          service_name: serviceName,
          span_name: span.name,
          observed_at: nanoToIso(observedAt),
          observed_at_unix_nano: observedAt.toString(),
          fault_flag: "paymentUnreachable",
          fault_variant: "on",
        };
      }
    }
  }
  return null;
}

function parsedEvidence(line, watermark) {
  if (!line.length) return null;
  let payload;
  try {
    payload = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  return checkoutPaymentFailureEvidence(payload, watermark.recorded_at_unix_nano);
}

export async function waitForPostWatermarkCheckoutPaymentFailure(
  tracePath,
  watermark,
  dependencies = {},
) {
  if (watermark?.schema_version !== TRACE_WATERMARK_SCHEMA || watermark.trace_path !== tracePath) {
    throw new Error("Trace watermark is not bound to the requested spool");
  }
  const statFile = dependencies.statFile || stat;
  const readRange = dependencies.readRange || readFileRange;
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const nowMs = dependencies.nowMs || Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 180_000;
  const pollMs = dependencies.pollMs ?? 1_000;
  const deadline = nowMs() + timeoutMs;
  let identity = watermark.file_identity;
  let cursor = watermark.byte_offset;
  let pending = Buffer.alloc(0);
  let skipFirstFragment = cursor > 0 && !watermark.line_boundary;

  while (nowMs() <= deadline) {
    let info = null;
    try {
      info = await statFile(tracePath);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    if (info) {
      const observedIdentity = fileIdentity(info);
      if (identity !== observedIdentity || Number(info.size) < cursor) {
        identity = observedIdentity;
        cursor = 0;
        pending = Buffer.alloc(0);
        skipFirstFragment = false;
      }
      const available = Number(info.size);
      while (cursor < available) {
        const length = Math.min(READ_CHUNK_BYTES, available - cursor);
        const chunk = await readRange(tracePath, cursor, length);
        if (!chunk.length) break;
        cursor += chunk.length;
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > MAX_TRACE_LINE_BYTES && !pending.includes(0x0a)) {
          throw new Error("OTel trace record exceeds the bounded launcher scan size");
        }
        let newline;
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (skipFirstFragment) {
            skipFirstFragment = false;
            continue;
          }
          const evidence = parsedEvidence(line, watermark);
          if (evidence) return { ...evidence, spool_file_identity: identity, spool_byte_offset: cursor };
        }
      }
    }
    await sleep(pollMs);
  }
  throw new Error(
    `No new post-watermark Checkout to Payment failure trace appeared in ${tracePath}`,
  );
}

function validateManifest(manifest) {
  if (manifest?.flag !== "paymentUnreachable"
    || manifest.before !== "off"
    || manifest.after !== "on"
    || manifest.known_good !== "off"
    || manifest.repair_command_id !== REPAIR_COMMAND) {
    throw new Error("Astronomy fault manifest is not the allowlisted V3 contract");
  }
}

function validateFlag(flag, manifest) {
  if (flag?.flag !== manifest.flag || ![manifest.after, manifest.known_good].includes(flag.variant)) {
    throw new Error("Astronomy allowlisted flag observation is invalid");
  }
}

export function astronomyActiveIncidentSummaries(snapshot) {
  return (Array.isArray(snapshot?.incidents) ? snapshot.incidents : []).filter((incident) => {
    const components = new Set(incident?.impacted_components || []);
    const astronomyIdentity = String(incident?.incident_id || "").startsWith("local-astronomy-")
      || (incident?.title === ASTRONOMY_TITLE && components.has("checkout") && components.has("payment"));
    return astronomyIdentity && incident?.lifecycle_state !== "RESOLVED";
  });
}

const REQUIRED_METRIC_KEYS = new Set([
  "checkout.payment.error_rate",
  "checkout.payment.mean_latency",
  "checkout.payment.request_count",
]);

function currentTimestamp(value, cutoff) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}

/** The local UI needs one current case, its real edge, and three OTel metrics. */
export function evaluateV3CaseReadiness({ projection, series }) {
  if (projection?.freshness?.state !== "CURRENT") {
    return { ready: false, reason: "v3_projection_not_current" };
  }
  const edge = (projection?.graph?.edges || []).find((item) => (
    item?.source_component_id === "checkout" && item?.target_component_id === "payment"
  ));
  if (!edge) return { ready: false, reason: "checkout_payment_edge_missing" };

  const observedMetrics = new Set();
  for (const metric of Array.isArray(series?.series) ? series.series : []) {
    if (!REQUIRED_METRIC_KEYS.has(metric?.metric_key)) continue;
    const hasRealPoint = (Array.isArray(metric.points) ? metric.points : []).some((point) => (
      typeof point?.value === "number"
      && Number.isFinite(point.value)
      && Array.isArray(point.evidence_refs)
      && point.evidence_refs.length > 0
    ));
    if (hasRealPoint) observedMetrics.add(metric.metric_key);
  }
  if (observedMetrics.size !== REQUIRED_METRIC_KEYS.size) {
    return { ready: false, reason: "metric_categories_incomplete" };
  }
  return {
    ready: true,
    reason: null,
    metric_keys: [...observedMetrics].sort(),
  };
}

export function hasExactProjectedFailureEvidence(envelopes, failureEvidence) {
  if (typeof failureEvidence?.trace_id !== "string" || typeof failureEvidence?.span_id !== "string") {
    return false;
  }
  const expectedAnchor = `trace:${failureEvidence.trace_id}:span:${failureEvidence.span_id}`;
  return (Array.isArray(envelopes) ? envelopes : []).some((evidence) => (
    evidence?.source_anchor === expectedAnchor
    && evidence?.source_kind === "TRACE"
    && evidence?.freshness === "CURRENT"
    && evidence?.proof_scope === "CURRENT_OBSERVATION"
  ));
}

function receiptEnvelope(action, receipt, kind) {
  return {
    kind,
    id: kind === "ROLLBACK" ? receipt.rollback_receipt_id : receipt.receipt_id,
    command_id: receipt.command_id,
    status: receipt.status,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    action_id: action.action_id,
  };
}

function receipts(projection) {
  const result = [];
  for (const action of Array.isArray(projection?.actions) ? projection.actions : []) {
    if (action?.receipt) result.push(receiptEnvelope(action, action.receipt, "ACTION"));
    if (action?.rollback_receipt) result.push(receiptEnvelope(action, action.rollback_receipt, "ROLLBACK"));
  }
  return result.sort((left, right) => Date.parse(left.completed_at) - Date.parse(right.completed_at));
}

export function classifyAstronomyProjectionRecovery(projection) {
  const attempt = projection?.current_attempt;
  if (!attempt || typeof attempt.current_stage !== "string") {
    throw new Error("Active Astronomy V3 projection has no current attempt");
  }
  const actions = Array.isArray(projection.actions) ? projection.actions : [];
  if (actions.some((action) => action?.execution_state === "RUNNING")) {
    throw new Error("Astronomy action is in-flight; launcher reconciliation requires human review");
  }
  const allReceipts = receipts(projection);
  const ambiguous = allReceipts.find((receipt) => !["SUCCEEDED", "ROLLED_BACK"].includes(receipt.status));
  if (ambiguous) {
    throw new Error(`Astronomy action receipt ${ambiguous.id} is ${ambiguous.status}; refusing to infer runtime state`);
  }
  let recoveryReceipt = null;
  if (attempt.action_executed) {
    const actionReceipt = allReceipts.find((receipt) => (
      receipt.kind === "ACTION" && receipt.id === attempt.action_receipt_id
    ));
    if (!actionReceipt || actionReceipt.status !== "SUCCEEDED") {
      throw new Error("Post-execution attempt is missing its immutable successful action receipt");
    }
    // A later safe rollback receipt is another real Checkout recreation and
    // therefore the runtime must match that latest mutation, not the original
    // Respond receipt.
    recoveryReceipt = allReceipts.at(-1);
  } else if (attempt.current_stage === "VERIFY") {
    throw new Error("Verify projection is missing a successful action receipt");
  }
  if (!recoveryReceipt && allReceipts.length) recoveryReceipt = allReceipts.at(-1);
  return recoveryReceipt
    ? { phase: "POST_EXECUTION", receipt: recoveryReceipt }
    : { phase: "PRE_EXECUTION", receipt: null };
}

export function assertPostExecutionAstronomyRuntime({ projection, flag, runtime, manifest }) {
  validateManifest(manifest);
  validateFlag(flag, manifest);
  const classified = classifyAstronomyProjectionRecovery(projection);
  if (classified.phase !== "POST_EXECUTION") {
    throw new Error("A pre-execution projection cannot be reconciled as repaired");
  }
  if (flag.variant !== manifest.known_good) {
    throw new Error("Post-execution Astronomy flag drifted from the receipt-bound known-good state");
  }
  if (classified.receipt.command_id !== manifest.repair_command_id) {
    throw new Error("Post-execution Astronomy receipt is outside the allowlist");
  }
  const receiptStarted = Date.parse(classified.receipt.started_at);
  const receiptCompleted = Date.parse(classified.receipt.completed_at);
  const runtimeStarted = Date.parse(runtime?.started_at);
  if (runtime?.running !== true || typeof runtime?.container_id !== "string" || !runtime.container_id
    || ![receiptStarted, receiptCompleted, runtimeStarted].every(Number.isFinite)
    || runtimeStarted < receiptStarted || runtimeStarted > receiptCompleted + 5_000) {
    throw new Error("Checkout runtime does not match the latest immutable execution receipt");
  }
  return { phase: classified.phase, receipt: classified.receipt, runtime };
}

/**
 * Recovery-aware startup boundary.  Only a launch with no active incident may
 * inject the real fault.  An existing incident is inspected first and never
 * silently mutated to fit its projection.
 */
export async function reconcileAstronomyLaunch({
  projection,
  manifest,
  readFlag,
  applyFault,
  readRuntime,
  captureWatermark,
  waitForFailure,
}) {
  validateManifest(manifest);
  const initialFlag = await readFlag();
  validateFlag(initialFlag, manifest);
  const watermark = await captureWatermark();

  if (projection) {
    const classified = classifyAstronomyProjectionRecovery(projection);
    if (classified.phase === "POST_EXECUTION") {
      const runtime = await readRuntime();
      const reconciled = assertPostExecutionAstronomyRuntime({
        projection, flag: initialFlag, runtime, manifest,
      });
      return {
        mode: "RESUME_POST_EXECUTION",
        case_id: projection.case_id,
        fault_applied: false,
        initial_flag: initialFlag,
        final_flag: initialFlag,
        watermark,
        recovery_receipt: reconciled.receipt,
        runtime,
        failure_evidence: null,
      };
    }
    if (initialFlag.variant !== manifest.after) {
      throw new Error("Pre-execution Astronomy projection requires paymentUnreachable to remain on");
    }
    const failureEvidence = await waitForFailure(watermark);
    return {
      mode: "RESUME_PRE_EXECUTION",
      case_id: projection.case_id,
      fault_applied: false,
      initial_flag: initialFlag,
      final_flag: initialFlag,
      watermark,
      recovery_receipt: null,
      runtime: null,
      failure_evidence: failureEvidence,
    };
  }

  let faultApplied = false;
  if (initialFlag.variant === manifest.known_good) {
    await applyFault();
    faultApplied = true;
  }
  const finalFlag = await readFlag();
  validateFlag(finalFlag, manifest);
  if (finalFlag.variant !== manifest.after) {
    throw new Error("Astronomy fault injection did not leave paymentUnreachable on");
  }
  const failureEvidence = await waitForFailure(watermark);
  return {
    mode: faultApplied ? "CREATE_AFTER_INJECTION" : "CREATE_REUSING_ACTIVE_FAULT",
    case_id: null,
    fault_applied: faultApplied,
    initial_flag: initialFlag,
    final_flag: finalFlag,
    watermark,
    recovery_receipt: null,
    runtime: null,
    failure_evidence: failureEvidence,
  };
}

/**
 * Start the Node internal bridge before the replacement Temporal worker.  A
 * persisted RUNNING stage may dispatch immediately when the worker starts, so
 * delaying Node until after case readiness creates a bounded-retry race.
 */
export async function coordinateV3LocalStartup({
  ensureAstronomy,
  startNodeBridge,
  startControlPlane,
  reconcileCase,
  waitForCase,
  announceReady,
  waitForNode,
  stopNode,
}) {
  await ensureAstronomy();
  const node = await startNodeBridge();
  try {
    await startControlPlane();
    const caseId = await reconcileCase();
    await waitForCase(caseId);
    await announceReady(caseId);
    return await waitForNode(node);
  } catch (error) {
    await stopNode(node);
    throw error;
  }
}

import { isPinnedCheckoutCodeEvidence } from "./code-evidence.mjs";

export const DIAGNOSIS_MIN_DISTINCT_FAILURES = 3;
export const DIAGNOSIS_BASELINE_MAX_AGE_MS = 5 * 60 * 1_000;

// The only executable local repair is for the checked-in checkout payment flag.
// Keep this predicate narrower than a generic service-error check.
export function isCheckoutPaymentUnreachableTrace(record) {
  const trace = record?.value?.trace || {};
  const failure = `${trace.error || ""}`.toLowerCase();
  const networkFailure = /econnrefused|connection refused|unavailable|connect(?:ion)? (?:failed|refused)|network unreachable|name resolver error|produced zero addresses|no such host|dns lookup/.test(failure);
  return isCheckoutPaymentDependencyTrace(record)
    // A bounded network error is sufficient when an exporter omitted status.
    && networkFailure;
}

export function isHealthyCheckoutPaymentTrace(record) {
  const trace = record?.value?.trace || {};
  return isCheckoutPaymentDependencyTrace(record)
    && ["ok", "unset"].includes(trace.status)
    && !trace.error;
}

export function isExecutableCheckoutPaymentEvidence(record, change = {}) {
  const trace = record?.value?.trace || {};
  const flag = trace.feature_flag || {};
  const appliedAt = Date.parse(change.applied_at || "");
  const evaluatedAt = Date.parse(flag.evaluated_at || "");
  const failureAt = Date.parse(trace.observed_at || "");
  return isCheckoutPaymentUnreachableTrace(record)
    && change.target === "checkout"
    && Boolean(change.flag)
    && change.after === "on"
    && flag.service === "checkout"
    && flag.key === change.flag
    && flag.variant === change.after
    && flag.value === true
    && flag.same_trace === true
    && flag.direct_parent === true
    && isHashRef(trace.trace_ref)
    && isHashRef(trace.span_ref)
    && isHashRef(trace.parent_ref)
    && isHashRef(flag.trace_ref)
    && isHashRef(flag.span_ref)
    && flag.trace_ref === trace.trace_ref
    && flag.span_ref === trace.parent_ref
    && Number.isFinite(appliedAt)
    && Number.isFinite(evaluatedAt)
    && Number.isFinite(failureAt)
    && appliedAt <= evaluatedAt
    && evaluatedAt < failureAt;
}

export function isKnownGoodCheckoutPaymentEvidence(record, change = {}, referenceAt = change.applied_at) {
  const trace = record?.value?.trace || {};
  const flag = trace.feature_flag || {};
  const evaluatedAt = Date.parse(flag.evaluated_at || "");
  const observedAt = Date.parse(trace.observed_at || "");
  const referenceMs = Date.parse(referenceAt || "");
  const knownGood = change.before || change.known_good;
  return isHealthyCheckoutPaymentTrace(record)
    && change.target === "checkout"
    && Boolean(change.flag)
    && knownGood === "off"
    && flag.service === "checkout"
    && flag.key === change.flag
    && flag.variant === knownGood
    && flag.value === false
    && flag.same_trace === true
    && flag.direct_parent === true
    && isHashRef(trace.trace_ref)
    && isHashRef(trace.span_ref)
    && isHashRef(trace.parent_ref)
    && isHashRef(flag.trace_ref)
    && isHashRef(flag.span_ref)
    && flag.trace_ref === trace.trace_ref
    && flag.span_ref === trace.parent_ref
    && Number.isFinite(evaluatedAt)
    && Number.isFinite(observedAt)
    && Number.isFinite(referenceMs)
    && evaluatedAt <= observedAt
    && observedAt < referenceMs
    && referenceMs - observedAt <= DIAGNOSIS_BASELINE_MAX_AGE_MS;
}

export function evaluateCheckoutPaymentDiagnosisGate(records, change = {}) {
  const baseline = records
    .filter((record) => isKnownGoodCheckoutPaymentEvidence(record, change))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  const code = records.find((record) => isPinnedCheckoutCodeEvidence(record, change)) || null;
  const distinct = new Map();
  for (const record of records.filter((item) => isExecutableCheckoutPaymentEvidence(item, change)).sort(compareAt)) {
    const traceRef = record.value.trace.trace_ref;
    if (!distinct.has(traceRef)) distinct.set(traceRef, record);
  }
  const failures = [...distinct.values()].slice(0, DIAGNOSIS_MIN_DISTINCT_FAILURES);
  const appliedAt = Date.parse(change.applied_at || "");
  const temporalOrder = Boolean(baseline) && Number.isFinite(appliedAt)
    && Date.parse(baseline.value.trace.observed_at) < appliedAt
    && failures.every((record) => Date.parse(record.value.trace.feature_flag.evaluated_at) >= appliedAt
      && Date.parse(record.value.trace.feature_flag.evaluated_at) < Date.parse(record.value.trace.observed_at));
  const checks = [
    gateCheck("initiating_change", Number.isFinite(appliedAt), []),
    gateCheck("implementation_semantics", Boolean(code), code ? [code.id] : []),
    gateCheck("controlled_off_on_contrast", Boolean(baseline), baseline ? [baseline.id] : []),
    gateCheck("repeated_direct_failures", failures.length >= DIAGNOSIS_MIN_DISTINCT_FAILURES, failures.map((record) => record.id)),
    gateCheck("temporal_order", temporalOrder, [...(baseline ? [baseline.id] : []), ...failures.map((record) => record.id)])
  ];
  return {
    phase: "diagnosis_pre_approval",
    passed: checks.every((check) => check.passed),
    checks,
    baseline,
    code,
    failures,
    required_records: [baseline, code, ...failures].filter(Boolean),
    missing: checks.filter((check) => !check.passed).map((check) => check.id)
  };
}

function isHashRef(value) { return /^[a-f0-9]{12}$/.test(String(value || "")); }

function gateCheck(id, passed, evidenceIds) { return { id, passed: Boolean(passed), evidence_ids: evidenceIds }; }
function compareAt(a, b) { return String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)); }

function isCheckoutPaymentDependencyTrace(record) {
  const trace = record?.value?.trace || {};
  const services = [record?.entity, trace.service, ...(record?.value?.services || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const dependency = `${trace.peer_target || ""} ${trace.operation || ""}`.toLowerCase();
  return record?.kind === "trace"
    && services.some((service) => service.includes("checkout"))
    && dependency.includes("payment");
}

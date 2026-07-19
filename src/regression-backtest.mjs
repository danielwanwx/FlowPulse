import { createHash } from "node:crypto";
import { evaluateCheckoutPaymentDiagnosisGate, isCheckoutPaymentUnreachableTrace, isHealthyCheckoutPaymentTrace } from "./incident-mechanism.mjs";
import { summarizeEvidence } from "./evidence-source.mjs";
import { harnessBinding, loadHarnessManifest } from "./harness-manifest.mjs";

export const DEVELOPMENT_BACKTEST_VERSION = "flowpulse.checkout-payment-backtest.v2";
export const RECOVERY_CHECK_IDS = ["flag_variant_restored", "fresh_checkout_payment_success", "no_fresh_resolver_failures"];
export const DEVELOPMENT_BACKTEST_GATE_IDS = [
  "unsupported_temporal_or_service_blame_rejected",
  "independent_evaluator_outcomes",
  "accepted_five_part_diagnosis_gate",
  "evidence_provenance_and_hash_bindings",
  "approval_before_repair",
  "allowlisted_repair_contract",
  "fresh_recovery_checks",
  "harness_contract_binding"
];

// This is intentionally a small, code-owned replay of the one competition policy.
// It takes already-sanitized frozen evidence only; raw OTLP never enters a ledger row.
export function buildDiagnosisBacktestSeed({ evidenceSource, diagnosis, evaluation, repairContract, rejected = null, harness = harnessBinding(loadHarnessManifest()) }) {
  if (repairContract && !rejected) throw new Error("Executable GPT workflow requires an independently rejected initial hypothesis before acceptance");
  if (!cloneHarness(harness)) throw new Error("A validated versioned harness binding is required for regression construction");
  const evidence = evidenceSource.summariesById(diagnosis.evidence_refs);
  const change = evidence.find((item) => item.kind === "change" && matchesContract(item.value?.change, repairContract));
  const gate = evaluateCheckoutPaymentDiagnosisGate(evidence, change?.value?.change);
  if (!change || !gate.passed) throw new Error(`Cannot build backtest seed without the complete Diagnosis Gate: ${gate.missing.join(", ")}`);
  const requiredIds = [change.id, ...gate.required_records.map((record) => record.id)];
  const records = requiredIds.map((id) => evidence.find((item) => item.id === id)).filter(Boolean);
  if (records.length !== requiredIds.length) throw new Error("Diagnosis Gate records were not available in the frozen snapshot");
  const bindings = records.map((record) => {
    const safeRecord = clone(record);
    return { id: safeRecord.id, sha256: sha256(safeRecord), record: safeRecord };
  }).sort(compareId);
  const metadata = evidenceSource.metadata();
  const snapshot = {
    id: evidenceSource.id || metadata.snapshot_id || metadata.id || null,
    mode: metadata.mode || null,
    content_sha256: metadata.content_hash || null,
    source_sha256: metadata.source_hash || null
  };
  const accepted = {
    diagnosis: clone(diagnosis),
    evaluation: clone(evaluation),
    evidence_ids: requiredIds,
    evidence_bindings: bindings
  };
  return {
    version: DEVELOPMENT_BACKTEST_VERSION,
    harness: cloneHarness(harness),
    snapshot,
    accepted,
    rejected: rejected ? { diagnosis: clone(rejected.diagnosis), evaluation: clone(rejected.evaluation) } : null,
    repair_contract: clone(repairContract),
    candidate_sha256: sha256({ diagnosis: accepted.diagnosis, evaluation: accepted.evaluation, repair_contract: repairContract, harness: cloneHarness(harness) })
  };
}

export function createDevelopmentRegressionArtifact({ runId, seed, verification, capture, repairContract }) {
  if (!seed || seed.version !== DEVELOPMENT_BACKTEST_VERSION) throw new Error("A versioned Diagnosis Gate seed is required for regression creation");
  const receipt = normalizeRecoveryReceipt(verification);
  const artifact = {
    version: DEVELOPMENT_BACKTEST_VERSION,
    source: "frozen_real_otlp_snapshot",
    run_id: runId,
    harness: cloneHarness(seed.harness),
    diagnosis: clone(seed),
    repair_contract: clone(repairContract),
    verification: {
      ...receipt,
      receipt_sha256: sha256(receipt)
    },
    capture: {
      id: capture?.id || null,
      sha256: capture?.sha256 || null,
      evidence_ids: [...new Set(capture?.evidence_ids || [])].sort()
    }
  };
  const artifact_sha256 = sha256(artifact);
  return {
    ...artifact,
    artifact_sha256,
    case_sha256: caseHash({ artifact, artifact_sha256 })
  };
}

// This receipt intentionally carries only the safe evidence projection.  It is
// bound into the regression artifact so the offline backtest can recompute
// recovery from observations instead of trusting verifier booleans.
export function buildRecoveryReceipt({ passed, repair_completed_at, source_status, flag_observed_at, checks, evidence_ids, evidence = [], evidence_bindings } = {}) {
  const bindings = normalizeEvidenceBindings({ evidence, evidence_bindings });
  const ids = [...new Set(evidence_ids || bindings.map((binding) => binding.id))].sort();
  return {
    passed: Boolean(passed),
    repair_completed_at: repair_completed_at || null,
    source_status: source_status || null,
    flag_observed_at: flag_observed_at || null,
    checks: clone(Array.isArray(checks) ? checks : []),
    evidence_ids: ids,
    evidence_bindings: bindings
  };
}

export function runDevelopmentBacktest({ artifact, events, repairContract }) {
  const safeArtifact = artifact && typeof artifact === "object" ? artifact : {};
  const diagnosis = safeArtifact.diagnosis || {};
  const accepted = diagnosis.accepted || {};
  const records = Array.isArray(accepted.evidence_bindings) ? accepted.evidence_bindings : [];
  const boundRecords = records.map((binding) => binding?.record).filter(Boolean);
  const change = boundRecords.find((record) => record.kind === "change" && matchesContract(record.value?.change, repairContract));
  const gate = evaluateCheckoutPaymentDiagnosisGate(boundRecords, change?.value?.change);
  const requiredIds = new Set([change?.id, ...gate.required_records.map((record) => record.id)].filter(Boolean));
  const artifactContract = exactContract(safeArtifact.repair_contract, repairContract);
  const evidenceBindings = records.length === requiredIds.size
    && records.every((binding) => binding && requiredIds.has(binding.id) && binding.sha256 === sha256(binding.record))
    && [...requiredIds].every((id) => (accepted.diagnosis?.evidence_refs || []).includes(id));
  const acceptedGate = Boolean(change && gate.passed && evidenceBindings && artifactContract && exactContract(accepted.diagnosis?.proposed_repair, repairContract));
  const rejected = diagnosis.rejected;
  const rejectedEvent = events.find((event) => event.type === "evaluation.rejected" && event.payload?.hypothesis_id === rejected?.diagnosis?.id);
  const acceptedEvent = events.find((event) => event.type === "evaluation.accepted" && event.payload?.hypothesis_id === accepted.diagnosis?.id);
  const unsupportedRejected = Boolean(rejected && rejected.evaluation?.accepted === false
    && rejected.evaluation?.classification !== "confirmed_system_bug" && rejectedEvent);
  const evaluatorOutcomes = Boolean(rejectedEvent && acceptedEvent
    && rejected.evaluation?.accepted === false && accepted.evaluation?.accepted === true);
  const control = controlGates(events, repairContract);
  const verificationEvent = events.filter((event) => event.type === "verification.completed").at(-1);
  const recovery = validateRecoveryReceipt({ artifact: safeArtifact, verificationEvent, change: change?.value?.change });
  const artifactBinding = safeArtifact.artifact_sha256 === sha256(withoutIntegrityHashes(safeArtifact));
  const caseBinding = safeArtifact.case_sha256 === caseHash({ artifact: withoutIntegrityHashes(safeArtifact), artifact_sha256: safeArtifact.artifact_sha256 });
  const harnessBound = sameHarness(safeArtifact.harness, diagnosis.harness);
  const candidateBinding = diagnosis.candidate_sha256 === sha256({ diagnosis: accepted.diagnosis, evaluation: accepted.evaluation, repair_contract: repairContract, harness: cloneHarness(diagnosis.harness) });
  const gateResults = [
    result("unsupported_temporal_or_service_blame_rejected", unsupportedRejected, "The rejected candidate has an independent non-acceptance verdict"),
    result("independent_evaluator_outcomes", evaluatorOutcomes, "Recorded evaluator outcomes match the rejected and accepted candidates"),
    result("accepted_five_part_diagnosis_gate", acceptedGate, "The accepted candidate recomputes all five pre-approval checks", gate.missing),
    result("evidence_provenance_and_hash_bindings", evidenceBindings && artifactContract && artifactBinding && caseBinding && candidateBinding, "Every required frozen evidence record and case/candidate binding matches"),
    result("approval_before_repair", control.approvalBeforeRepair, "Owner approval strictly precedes repair execution"),
    result("allowlisted_repair_contract", control.allowlistedRepairContract, "All repair control events match the exact checked-in contract"),
    result("fresh_recovery_checks", recovery.passed, "Fresh flag, success, and zero-resolver-failure observations recompute and bind to the receipt", recovery.missing),
    result("harness_contract_binding", harnessBound, "The regression artifact and diagnosis seed bind the same versioned harness contract")
  ];
  return {
    version: DEVELOPMENT_BACKTEST_VERSION,
    source: "executed_offline_backtest",
    case_sha256: safeArtifact.case_sha256 || null,
    artifact_sha256: safeArtifact.artifact_sha256 || null,
    candidate_sha256: diagnosis.candidate_sha256 || null,
    harness: cloneHarness(safeArtifact.harness),
    passed: gateResults.every((gate) => gate.passed),
    gates: gateResults
  };
}

// Pure, deterministic recovery gate.  The persisted verifier flags are only
// checked for consistency with recomputed receipt semantics; they never grant
// a pass by themselves.
export function validateRecoveryReceipt({ artifact, verificationEvent, change } = {}) {
  const expected = artifact?.verification && typeof artifact.verification === "object" ? artifact.verification : {};
  const verification = verificationEvent?.payload && typeof verificationEvent.payload === "object" ? verificationEvent.payload : {};
  const repairAt = timestamp(verification.repair_completed_at);
  const knownGood = change?.known_good || change?.before || null;
  const bindings = Array.isArray(expected.evidence_bindings) ? expected.evidence_bindings : [];
  const evidenceIds = [...new Set(expected.evidence_ids || [])].sort();
  const bindingsValid = bindings.length === evidenceIds.length
    && new Set(bindings.map((binding) => binding?.id)).size === bindings.length
    && bindings.every((binding) => binding?.id && evidenceIds.includes(binding.id) && binding.sha256 === sha256(binding.record));
  const refsBound = sameIds(verificationEvent?.evidence_refs, evidenceIds);
  const traces = bindings.map((binding) => binding.record).filter(Boolean);
  const allEvidenceFresh = traces.length > 0 && traces.every((record) => recoveryObservationAfter(record, repairAt));
  const flagFresh = strictlyAfter(verification.flag_observed_at, repairAt);
  const eventFresh = strictlyAfter(verificationEvent?.recorded_at, repairAt);
  const checks = checksById(verification.checks);
  const sourceLive = verification.source_status === "live";
  const flag = checks.flag_variant_restored;
  const healthy = checks.fresh_checkout_payment_success;
  const failures = checks.no_fresh_resolver_failures;
  const healthyCount = traces.filter(isHealthyCheckoutPaymentTrace).length;
  const failureCount = traces.filter(isCheckoutPaymentUnreachableTrace).length;
  const flagRestored = Boolean(knownGood && flag && flag.observed === knownGood && flag.expected === knownGood && flag.threshold === `== ${knownGood}` && flagFresh);
  const freshHealthy = Boolean(healthy && Number.isInteger(healthy.observed) && healthy.observed === healthyCount && healthyCount >= 1 && healthy.threshold === ">= 1" && allEvidenceFresh);
  const noFreshFailures = Boolean(failures && Number.isInteger(failures.observed) && failures.observed === failureCount && failureCount === 0 && failures.threshold === "== 0" && allEvidenceFresh);
  const recomputedPassed = Boolean(sourceLive && flagRestored && freshHealthy && noFreshFailures && eventFresh && bindingsValid && refsBound);
  const checkConsistency = Boolean(
    flag && healthy && failures
    && flag.passed === flagRestored
    && healthy.passed === freshHealthy
    && failures.passed === noFreshFailures
  );
  const actualReceipt = buildRecoveryReceipt({
    passed: verification.passed,
    repair_completed_at: verification.repair_completed_at,
    source_status: verification.source_status,
    flag_observed_at: verification.flag_observed_at,
    checks: verification.checks,
    evidence_ids: verificationEvent?.evidence_refs,
    evidence_bindings: bindings
  });
  const receiptBinding = expected.receipt_sha256 === sha256(actualReceipt);
  const recordedConsistency = verification.passed === recomputedPassed;
  const missing = [
    !sourceLive && "source_live",
    !knownGood && "known_good_flag",
    !flagRestored && "flag_variant_restored",
    !freshHealthy && "fresh_checkout_payment_success",
    !noFreshFailures && "no_fresh_resolver_failures",
    !allEvidenceFresh && "fresh_observation_times",
    !eventFresh && "fresh_verification_event",
    !bindingsValid && "evidence_hash_bindings",
    !refsBound && "verification_evidence_refs",
    !receiptBinding && "receipt_hash_binding",
    !checkConsistency && "recorded_check_consistency",
    !recordedConsistency && "recorded_verification_consistency"
  ].filter(Boolean);
  return { passed: recomputedPassed && checkConsistency && receiptBinding && recordedConsistency, missing };
}

export function controlGates(events, contract) {
  const required = ["repair.proposed", "approval.requested", "approval.granted", "repair.executed"];
  const found = Object.fromEntries(required.map((type) => [type, events.filter((event) => event.type === type)]));
  const approval = found["approval.granted"];
  const repair = found["repair.executed"];
  return {
    approvalBeforeRepair: approval.length === 1 && repair.length === 1 && Number.isFinite(approval[0].sequence)
      && Number.isFinite(repair[0].sequence) && approval[0].sequence < repair[0].sequence,
    allowlistedRepairContract: required.every((type) => found[type].length === 1 && exactContract(found[type][0].payload, contract))
  };
}

export function exactContract(candidate = {}, expected = {}) {
  return candidate?.repair_id === expected?.repair_id
    && candidate?.action === expected?.action
    && candidate?.target === expected?.target
    && candidate?.command_id === expected?.command_id;
}

function matchesContract(change = {}, contract = {}) {
  return change?.repair_id === contract?.repair_id
    && change?.target === contract?.target
    && change?.repair_command_id === contract?.command_id
    && contract?.action === `restore known-good ${change?.flag} flag and recreate checkout`;
}

function result(id, passed, label, missing = []) { return { id, label, passed: Boolean(passed), ...(missing.length ? { missing: missing.slice(0, 6) } : {}) }; }
function compareId(a, b) { return a.id.localeCompare(b.id); }
function sameIds(actual, expected) {
  const left = [...new Set(Array.isArray(actual) ? actual : [])].sort();
  const right = [...new Set(Array.isArray(expected) ? expected : [])].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeRecoveryReceipt(value = {}) {
  return buildRecoveryReceipt({
    passed: value.passed,
    repair_completed_at: value.repair_completed_at,
    source_status: value.source_status,
    flag_observed_at: value.flag_observed_at,
    checks: value.checks,
    evidence_ids: value.evidence_ids,
    evidence: value.evidence,
    evidence_bindings: value.evidence_bindings
  });
}
function normalizeEvidenceBindings({ evidence = [], evidence_bindings } = {}) {
  const source = Array.isArray(evidence_bindings)
    ? evidence_bindings.map((binding) => ({ id: binding?.id, sha256: binding?.sha256, record: clone(binding?.record ?? null) }))
    : (Array.isArray(evidence) ? evidence : []).map((record) => {
      const safeRecord = clone(summarizeEvidence(record));
      return { id: safeRecord.id, sha256: sha256(safeRecord), record: safeRecord };
    });
  const unique = new Map();
  for (const binding of source) {
    if (!binding?.id || unique.has(binding.id)) continue;
    unique.set(binding.id, binding);
  }
  return [...unique.values()].sort(compareId);
}
function checksById(checks) {
  const output = Object.create(null);
  if (!Array.isArray(checks) || checks.length !== RECOVERY_CHECK_IDS.length) return output;
  for (const id of RECOVERY_CHECK_IDS) {
    const matches = checks.filter((check) => check?.id === id);
    if (matches.length !== 1) return Object.create(null);
    output[id] = matches[0];
  }
  return output;
}
function recoveryObservationAfter(record, repairAt) {
  const observedAt = record?.value?.trace?.observed_at;
  return strictlyAfter(record?.at, repairAt) && strictlyAfter(observedAt, repairAt);
}
function strictlyAfter(value, threshold) {
  const valueAt = timestamp(value);
  return Number.isFinite(valueAt) && Number.isFinite(threshold) && valueAt > threshold;
}
function timestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : Number.NaN; }
function withoutIntegrityHashes(value) { const { case_sha256, artifact_sha256, ...rest } = value || {}; return rest; }
function caseHash({ artifact, artifact_sha256 }) {
  return sha256({
    version: artifact?.version || null,
    artifact_sha256: artifact_sha256 || null,
    candidate_sha256: artifact?.diagnosis?.candidate_sha256 || null,
    capture_sha256: artifact?.capture?.sha256 || null,
    harness_sha256: artifact?.harness?.manifest_sha256 || null
  });
}
function cloneHarness(value) {
  if (!value || typeof value !== "object" || typeof value.manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) return null;
  return clone({
    version: value.version || null,
    manifest_sha256: value.manifest_sha256,
    model: value.model || null,
    skills: value.skills || null,
    protocols: value.protocols || null
  });
}
function sameHarness(left, right) {
  const a = cloneHarness(left);
  const b = cloneHarness(right);
  return Boolean(a && b && sha256(a) === sha256(b));
}
export function sha256(value) { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

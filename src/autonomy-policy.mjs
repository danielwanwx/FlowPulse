import { createHash } from "node:crypto";

export const AUTONOMY_SCHEMA_VERSION = "flowpulse.autonomy.v1";
export const PREAUTHORIZATION_SCHEMA_VERSION = "flowpulse-preauthorization.v1";
export const PREAUTHORIZATION_REGISTRY_VERSION = "flowpulse-preauthorization-registry.v1";
export const LEGACY_DETAIL_UNAVAILABLE = "legacy_detail_unavailable";

const HEX_64 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA_256 = /^sha256:[a-f0-9]{64}$/;
const MAX_EVENT_BYTES = 12 * 1024;
const MAX_REFS = 32;

export class AutonomyPolicyError extends Error {
  constructor(code, fieldPath = null) {
    super("Autonomy policy validation failed");
    this.name = "AutonomyPolicyError";
    this.code = code;
    this.field_path = fieldPath;
  }
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalDecisionHash(decision) {
  assertPlainObject(decision, "decision", "decision_schema_invalid");
  const { decision_sha256: _ignored, ...unsigned } = decision;
  return sha256Canonical(unsigned);
}

export function buildAuthorityGateBinding(input) {
  assertExactObject(input, ["event_id", "event_type", "snapshot_sha256", "evidence_refs"], "authority_gate", "authority_evidence_invalid");
  const eventId = requireText(input.event_id, "authority_gate.event_id", 160, "authority_evidence_invalid");
  const eventType = requireText(input.event_type, "authority_gate.event_type", 80, "authority_evidence_invalid");
  const snapshotSha256 = requireHash(input.snapshot_sha256, "authority_gate.snapshot_sha256", "authority_evidence_invalid");
  const evidenceRefs = normalizedRefArray(input.evidence_refs, "authority_gate.evidence_refs", MAX_REFS, "authority_evidence_invalid", true);
  return freezeClone({
    event_id: eventId,
    event_type: eventType,
    event_sha256: sha256Canonical({ event_id: eventId, event_type: eventType, snapshot_sha256: snapshotSha256, evidence_refs: evidenceRefs }),
    snapshot_sha256: snapshotSha256,
    evidence_refs: evidenceRefs
  });
}

export function resolvePreauthorization({ registry, environment, contract, selected_ref = null }) {
  if (selected_ref != null) fail("client_preauthorization_selection_forbidden", "selected_ref");
  assertExactObject(registry, ["schema_version", "envelopes"], "registry", "preauthorization_registry_invalid");
  if (registry.schema_version !== PREAUTHORIZATION_REGISTRY_VERSION) fail("preauthorization_registry_version_invalid", "registry.schema_version");
  if (!Array.isArray(registry.envelopes) || registry.envelopes.length === 0 || registry.envelopes.length > 32) {
    fail("preauthorization_registry_invalid", "registry.envelopes");
  }
  const environmentValue = requireText(environment, "environment", 80, "preauthorization_environment_invalid");
  assertContract(contract, "contract");
  const matches = registry.envelopes.filter((candidate) => candidate?.environment === environmentValue && contractsEqual(candidate?.action_contract, contract));
  if (matches.length === 0) fail("preauthorization_not_found", "registry.envelopes");
  if (matches.length !== 1) fail("preauthorization_ambiguous", "registry.envelopes");
  return structuredClone(matches[0]);
}

export function validatePreauthorizationEnvelope(envelope, contract, bindings, now) {
  assertEnvelope(envelope);
  assertContract(contract, "contract");
  const binding = buildBinding({ ...bindings, contract, target: bindings?.target ?? contract.target });
  if (!contractsEqual(envelope.action_contract, contract)) fail("preauthorization_contract_mismatch", "action_contract");
  if (envelope.environment !== binding.environment) fail("preauthorization_environment_mismatch", "environment");
  if (envelope.status === "revoked") fail("preauthorization_revoked", "status");
  if (envelope.status !== "active") fail("preauthorization_status_invalid", "status");
  const issuedAt = parseTimestamp(envelope.issued_at, "issued_at");
  const expiresAt = parseTimestamp(envelope.expires_at, "expires_at");
  const at = parseTimestamp(now, "now");
  if (issuedAt >= expiresAt) fail("preauthorization_window_invalid", "expires_at");
  if (at >= expiresAt) fail("preauthorization_expired", "expires_at");
  if (at < issuedAt) fail("preauthorization_not_active_yet", "issued_at");
  if (binding.target !== envelope.action_contract.target) fail("preauthorization_target_mismatch", "target");
  return freezeClone({
    preauthorization_id: envelope.id,
    envelope_sha256: sha256Canonical(envelope),
    policy_sha256: envelope.policy_sha256,
    contract_sha256: sha256Canonical(contract),
    binding,
    binding_sha256: sha256Canonical(binding),
    expires_at: envelope.expires_at,
    max_attempts: envelope.limits.max_attempts,
    required_verification_check_ids: [...envelope.required_verification_check_ids],
    notification_targets: [...envelope.notification_targets]
  });
}

export function preauthorizationClaimId({ incident_id, environment, target, contract_sha256, envelope_sha256 }) {
  assertExactObject({ incident_id, environment, target, contract_sha256, envelope_sha256 }, ["incident_id", "environment", "target", "contract_sha256", "envelope_sha256"], "claim_scope", "consumption_input_invalid");
  const scope = {
    incident_id: requireText(incident_id, "incident_id", 160, "consumption_input_invalid"),
    environment: requireText(environment, "environment", 80, "consumption_input_invalid"),
    target: requireText(target, "target", 160, "consumption_input_invalid"),
    contract_sha256: requireHash(contract_sha256, "contract_sha256", "consumption_input_invalid"),
    envelope_sha256: requireHash(envelope_sha256, "envelope_sha256", "consumption_input_invalid")
  };
  return `preauthorization-claim-${sha256Canonical(scope).slice(0, 32)}`;
}

export function failureLockKey({ incident_id, contract_sha256, target }) {
  const scope = {
    incident_id: requireText(incident_id, "incident_id", 160, "failure_lock_invalid"),
    contract_sha256: requireHash(contract_sha256, "contract_sha256", "failure_lock_invalid"),
    target: requireText(target, "target", 160, "failure_lock_invalid")
  };
  return `autonomy-lock-${sha256Canonical(scope).slice(0, 32)}`;
}

export function hasFailureLock({ events, incident_id, contract_sha256, target }) {
  const result = inspectFailureLockState({ events, incident_id, contract_sha256, target });
  if (result.status === "unavailable") fail("failure_lock_state_unavailable", "failure_lock_events");
  return result.status === "locked";
}

export function evaluateAutonomyDecision(input) {
  assertExactObject(input, [
    "registry", "contract", "environment", "incident_id", "run_id", "snapshot_sha256", "target", "now", "impact", "source",
    "authority_evidence", "advisory", "action", "notification", "truth_mode", "failure_lock_events"
  ], "input", "autonomy_input_invalid");
  const binding = buildBinding(input);
  const contract = freezeClone(input.contract);
  const impact = normalizeImpact(input.impact);
  const source = normalizeSource(input.source);
  const authorityEvidence = normalizeAuthorityEvidence(input.authority_evidence, binding.snapshot_sha256);
  const advisory = normalizeAdvisory(input.advisory, authorityEvidence.evidence_refs);
  const action = normalizeAction(input.action);
  const notification = normalizeNotification(input.notification);
  const truthMode = normalizeTruthMode(input.truth_mode);

  let envelope = null;
  let preauthorization = null;
  let preauthorizationError = null;
  try {
    envelope = resolvePreauthorization({ registry: input.registry, environment: binding.environment, contract });
    preauthorization = validatePreauthorizationEnvelope(envelope, contract, binding, input.now);
  } catch (error) {
    if (!(error instanceof AutonomyPolicyError)) throw error;
    preauthorizationError = error;
    envelope = null;
  }
  if (preauthorization && !sameSet(notification.target_refs, preauthorization.notification_targets)) {
    fail("notification_targets_mismatch", "notification.target_refs");
  }

  const contractHash = preauthorization?.contract_sha256 ?? sha256Canonical(contract);
  const lockState = inspectFailureLockState({
    events: input.failure_lock_events,
    incident_id: binding.incident_id,
    contract_sha256: contractHash,
    target: binding.target
  });
  const factors = buildFactors({ impact, source, authorityEvidence, action, notification, truthMode, preauthorization, preauthorizationError, lockState });
  const passed = factors.every((factor) => factor.passed);
  const reasonCodes = unique(factors.filter((factor) => !factor.passed).map((factor) => factor.reason_code).filter(Boolean));
  const riskClass = classifyRisk(impact, action);
  const outcome = passed
    ? "auto_execute_pre_authorized"
    : riskClass === "medium"
      ? "human_review_required"
      : riskClass === "high"
        ? "explicit_human_decision_required"
        : "blocked";
  const decision = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    decided_at: requireText(input.now, "now", 40, "autonomy_input_invalid"),
    impact,
    risk_class: riskClass,
    outcome,
    human_gate: passed ? "preauthorized" : riskClass === "medium" ? "owner_required" : riskClass === "high" ? "explicit_decision_required" : "not_required",
    incident_id: binding.incident_id,
    run_id: binding.run_id,
    environment: binding.environment,
    target: binding.target,
    snapshot_sha256: binding.snapshot_sha256,
    binding,
    binding_sha256: sha256Canonical(binding),
    contract,
    contract_sha256: contractHash,
    preauthorization_envelope: envelope,
    envelope_sha256: preauthorization?.envelope_sha256 ?? null,
    policy_sha256: preauthorization?.policy_sha256 ?? null,
    preauthorization_id: preauthorization?.preauthorization_id ?? null,
    preauthorization_error_code: preauthorizationError?.code ?? null,
    authority_evidence: authorityEvidence,
    advisory,
    source,
    action,
    notification,
    truth_mode: truthMode,
    failure_lock_state: lockState,
    factor_results: factors,
    reason_codes: reasonCodes,
    evidence_refs: authorityEvidence.evidence_refs,
    execution: {
      truth_mode: "captured_simulation",
      receipt_type: null,
      satisfies_live_production_gate: false,
      satisfies_executed_offline_backtest: false
    },
    action_event_type: passed ? "action.simulated" : null,
    legacy_detail_status: LEGACY_DETAIL_UNAVAILABLE
  };
  decision.decision_sha256 = canonicalDecisionHash(decision);
  return freezeClone(decision);
}

export function revalidateExecutionAuthority(input) {
  assertExactObject(input, ["decision", "registry", "now", "source", "failure_lock_events", "executor_enabled"], "revalidation", "revalidation_input_invalid");
  const decision = assertCanonicalDecision(input.decision);
  const source = normalizeSource(input.source);
  const reasons = [];
  try {
    const envelope = resolvePreauthorization({ registry: input.registry, environment: decision.environment, contract: decision.contract });
    const current = validatePreauthorizationEnvelope(envelope, decision.contract, decision.binding, input.now);
    if (current.envelope_sha256 !== decision.envelope_sha256 || current.contract_sha256 !== decision.contract_sha256 || current.policy_sha256 !== decision.policy_sha256) {
      reasons.push("preauthorization_binding_changed");
    }
  } catch (error) {
    if (!(error instanceof AutonomyPolicyError)) throw error;
    reasons.push(error.code);
  }
  const lockState = inspectFailureLockState({
    events: input.failure_lock_events,
    incident_id: decision.incident_id,
    contract_sha256: decision.contract_sha256,
    target: decision.target
  });
  if (lockState.status === "locked") reasons.push("autonomy_failure_locked");
  if (lockState.status === "unavailable") reasons.push("failure_lock_state_unavailable");
  if (source.status !== "live" || !source.fresh) reasons.push("live_source_required");
  if (input.executor_enabled !== true) reasons.push("executor_disabled");
  if (decision.truth_mode === "captured_simulation") reasons.push("captured_simulation_not_executable");
  return freezeClone({ schema_version: AUTONOMY_SCHEMA_VERSION, passed: reasons.length === 0, reason_codes: unique(reasons), decision_sha256: decision.decision_sha256 });
}

export function buildAutonomyDecisionEvent(decision) {
  const canonical = assertCanonicalDecision(decision);
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    decision_sha256: canonical.decision_sha256,
    decided_at: canonical.decided_at,
    impact: canonical.impact,
    risk_class: canonical.risk_class,
    outcome: canonical.outcome,
    human_gate: canonical.human_gate,
    binding: canonical.binding,
    binding_sha256: canonical.binding_sha256,
    contract_sha256: canonical.contract_sha256,
    envelope_sha256: canonical.envelope_sha256,
    policy_sha256: canonical.policy_sha256,
    preauthorization_id: canonical.preauthorization_id,
    authority_evidence: safeAuthorityEvidence(canonical.authority_evidence),
    factor_results: canonical.factor_results,
    reason_codes: canonical.reason_codes,
    notification: canonical.notification,
    execution: canonical.execution,
    action_event_type: canonical.action_event_type,
    legacy_detail_status: canonical.legacy_detail_status
  };
  ensureByteLimit(payload, MAX_EVENT_BYTES, "autonomy_decision_payload_too_large");
  return freezeClone({
    id: `autonomy-decision-${canonical.decision_sha256.slice(0, 32)}`,
    runId: canonical.run_id,
    incidentId: canonical.incident_id,
    type: "autonomy.decision.recorded",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: canonical.evidence_refs,
    correlationId: `autonomy-${canonical.decision_sha256.slice(0, 24)}`
  });
}

export function buildPreauthorizationConsumptionEvent(input) {
  assertExactObject(input, ["decision"], "consumption", "consumption_input_invalid");
  const decision = assertCanonicalDecision(input.decision);
  if (decision.outcome !== "auto_execute_pre_authorized" || !decision.preauthorization_envelope) fail("consumption_decision_not_eligible", "decision.outcome");
  const claimId = preauthorizationClaimId({
    incident_id: decision.incident_id,
    environment: decision.environment,
    target: decision.target,
    contract_sha256: decision.contract_sha256,
    envelope_sha256: decision.envelope_sha256
  });
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    claim_id: claimId,
    decision_sha256: decision.decision_sha256,
    binding_sha256: decision.binding_sha256,
    envelope_sha256: decision.envelope_sha256,
    contract_sha256: decision.contract_sha256,
    policy_sha256: decision.policy_sha256,
    snapshot_sha256: decision.snapshot_sha256,
    incident_id: decision.incident_id,
    run_id: decision.run_id,
    environment: decision.environment,
    target: decision.target,
    truth_mode: "reserved_for_future_live_executor"
  };
  ensureByteLimit(payload, MAX_EVENT_BYTES, "consumption_payload_too_large");
  return freezeClone({
    id: claimId,
    runId: decision.run_id,
    incidentId: decision.incident_id,
    type: "preauthorization.consumed",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: decision.evidence_refs,
    correlationId: `preauthorization-${sha256Canonical({ claimId, decision: decision.decision_sha256 }).slice(0, 24)}`
  });
}

export function buildFailureLockEvent(input) {
  assertExactObject(input, ["decision", "failed_event_ref", "reason_code"], "failure_lock", "failure_lock_input_invalid");
  const { decision, failed_event_ref, reason_code } = input;
  const canonical = assertCanonicalDecision(decision);
  const lockKey = failureLockKey({ incident_id: canonical.incident_id, contract_sha256: canonical.contract_sha256, target: canonical.target });
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    lock_key: lockKey,
    incident_id: canonical.incident_id,
    contract_sha256: canonical.contract_sha256,
    target: canonical.target,
    binding_sha256: canonical.binding_sha256,
    decision_sha256: canonical.decision_sha256,
    failed_event_ref: requireText(failed_event_ref, "failed_event_ref", 160, "failure_lock_input_invalid"),
    reason_code: requireText(reason_code, "reason_code", 80, "failure_lock_input_invalid")
  };
  return freezeClone({
    id: lockKey,
    runId: canonical.run_id,
    incidentId: canonical.incident_id,
    type: "autonomy.locked",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: canonical.evidence_refs,
    correlationId: `lock-${sha256Canonical(payload).slice(0, 24)}`
  });
}

function assertCanonicalDecision(value) {
  assertExactObject(value, [
    "schema_version", "decided_at", "impact", "risk_class", "outcome", "human_gate", "incident_id", "run_id", "environment", "target", "snapshot_sha256",
    "binding", "binding_sha256", "contract", "contract_sha256", "preauthorization_envelope", "envelope_sha256", "policy_sha256", "preauthorization_id",
    "preauthorization_error_code", "authority_evidence", "advisory", "source", "action", "notification", "truth_mode", "failure_lock_state", "factor_results",
    "reason_codes", "evidence_refs", "execution", "action_event_type", "legacy_detail_status", "decision_sha256"
  ], "decision", "decision_schema_invalid");
  if (value.schema_version !== AUTONOMY_SCHEMA_VERSION) fail("decision_schema_invalid", "decision.schema_version");
  const binding = buildBinding({ ...value.binding, contract: value.contract, target: value.target });
  if (canonicalJson(binding) !== canonicalJson(value.binding)) fail("decision_binding_mismatch", "decision.binding");
  if (binding.incident_id !== value.incident_id || binding.run_id !== value.run_id || binding.environment !== value.environment || binding.snapshot_sha256 !== value.snapshot_sha256 || binding.target !== value.target) {
    fail("decision_binding_mismatch", "decision.binding");
  }
  if (sha256Canonical(binding) !== value.binding_sha256) fail("decision_binding_hash_mismatch", "decision.binding_sha256");
  const contractHash = sha256Canonical(value.contract);
  if (contractHash !== value.contract_sha256) fail("decision_contract_hash_mismatch", "decision.contract_sha256");
  const impact = normalizeImpact(value.impact);
  const source = normalizeSource(value.source);
  const authorityEvidence = normalizeAuthorityEvidence(value.authority_evidence, binding.snapshot_sha256);
  const advisory = normalizeAdvisory(value.advisory, authorityEvidence.evidence_refs);
  const action = normalizeAction(value.action);
  const notification = normalizeNotification(value.notification);
  const truthMode = normalizeTruthMode(value.truth_mode);
  const lockState = normalizeFailureLockState(value.failure_lock_state, binding, contractHash);
  let preauthorization = null;
  let preauthorizationError = null;
  if (value.preauthorization_envelope == null) {
    if (value.envelope_sha256 !== null || value.policy_sha256 !== null || value.preauthorization_id !== null || typeof value.preauthorization_error_code !== "string") {
      fail("decision_preauthorization_mismatch", "decision.preauthorization_envelope");
    }
    preauthorizationError = value.preauthorization_error_code;
  } else {
    if (value.preauthorization_error_code !== null) fail("decision_preauthorization_mismatch", "decision.preauthorization_error_code");
    preauthorization = validatePreauthorizationEnvelope(value.preauthorization_envelope, value.contract, binding, value.decided_at);
    if (preauthorization.envelope_sha256 !== value.envelope_sha256 || preauthorization.policy_sha256 !== value.policy_sha256 || preauthorization.preauthorization_id !== value.preauthorization_id) {
      fail("decision_preauthorization_mismatch", "decision.envelope_sha256");
    }
    if (!sameSet(notification.target_refs, preauthorization.notification_targets)) fail("notification_targets_mismatch", "notification.target_refs");
  }
  const factors = buildFactors({ impact, source, authorityEvidence, action, notification, truthMode, preauthorization, preauthorizationError: preauthorizationError ? { code: preauthorizationError } : null, lockState });
  const passed = factors.every((factor) => factor.passed);
  const riskClass = classifyRisk(impact, action);
  const outcome = passed ? "auto_execute_pre_authorized" : riskClass === "medium" ? "human_review_required" : riskClass === "high" ? "explicit_human_decision_required" : "blocked";
  const humanGate = passed ? "preauthorized" : riskClass === "medium" ? "owner_required" : riskClass === "high" ? "explicit_decision_required" : "not_required";
  if (canonicalJson(factors) !== canonicalJson(value.factor_results) || canonicalJson(unique(factors.filter((factor) => !factor.passed).map((factor) => factor.reason_code).filter(Boolean))) !== canonicalJson(value.reason_codes)) {
    fail("decision_factor_mismatch", "decision.factor_results");
  }
  if (value.risk_class !== riskClass || value.outcome !== outcome || value.human_gate !== humanGate) fail("decision_outcome_mismatch", "decision.outcome");
  if (!sameSet(value.evidence_refs, authorityEvidence.evidence_refs)) fail("decision_evidence_refs_mismatch", "decision.evidence_refs");
  assertExactObject(value.execution, ["truth_mode", "receipt_type", "satisfies_live_production_gate", "satisfies_executed_offline_backtest"], "decision.execution", "decision_schema_invalid");
  if (value.execution.truth_mode !== "captured_simulation" || value.execution.receipt_type !== null || value.execution.satisfies_live_production_gate !== false || value.execution.satisfies_executed_offline_backtest !== false) {
    fail("decision_execution_truth_mismatch", "decision.execution");
  }
  if (value.action_event_type !== (passed ? "action.simulated" : null) || value.legacy_detail_status !== LEGACY_DETAIL_UNAVAILABLE) fail("decision_schema_invalid", "decision.action_event_type");
  if (canonicalDecisionHash(value) !== value.decision_sha256) fail("decision_hash_mismatch", "decision.decision_sha256");
  return freezeClone(value);
}

function buildFactors({ impact, source, authorityEvidence, action, notification, truthMode, preauthorization, preauthorizationError, lockState }) {
  const authorityRefs = authorityEvidence.evidence_refs;
  const notificationIsLocal = ["recorded_local", "simulated"].includes(notification.status) && ["captured_simulation", "local_ledger"].includes(notification.delivery_mode);
  const sourceCurrent = source.status === "captured_fixture" && source.fresh;
  const maxAttempts = preauthorization?.max_attempts ?? 0;
  return [
    factor("impact_low", impact.level, "low", impact.level === "low", "impact_not_low", []),
    factor("preauthorization_valid", preauthorization?.preauthorization_id ?? null, "active_exact_envelope", preauthorization != null, preauthorizationError?.code ?? "preauthorization_invalid", []),
    factor("source_fresh", { status: source.status, fresh: source.fresh }, "fresh_captured_fixture", sourceCurrent, source.fresh ? "source_status_not_captured_fixture" : "source_stale", []),
    factor("evidence_complete", authorityRefs.length, ">=1", authorityRefs.length > 0, "evidence_incomplete", authorityRefs),
    factor("evidence_fresh", source.fresh, true, source.fresh, "evidence_stale", authorityRefs),
    factor("evidence_non_conflicting", authorityEvidence.conflict_status, "none", authorityEvidence.conflict_status === "none", authorityEvidence.conflict_status === "conflicting" ? "evidence_conflicting" : "evidence_conflict_unknown", authorityRefs),
    factor("diagnosis_gate_passed", authorityEvidence.deterministic_gate.event_id, "verified diagnosis.gate.passed", true, null, authorityRefs),
    factor("evaluator_accepted", authorityEvidence.evaluator_gate.event_id, "verified evaluation.accepted", true, null, authorityRefs),
    factor("low_risk_action", action.risk, "low", action.risk === "low", "action_not_low_risk", []),
    factor("single_component_blast_radius", action.blast_radius_components, 1, action.blast_radius_components === 1, "blast_radius_exceeded", []),
    factor("reversible_idempotent", { reversible: action.reversible, idempotent: action.idempotent }, { reversible: true, idempotent: true }, action.reversible && action.idempotent, "action_not_reversible_idempotent", []),
    factor("rollback_verification_ready", { rollback_ready: action.rollback_ready, verification_ready: action.verification_ready }, { rollback_ready: true, verification_ready: true }, action.rollback_ready && action.verification_ready, "rollback_or_verification_not_ready", []),
    factor("attempt_within_preauthorization", action.attempt_count, maxAttempts, preauthorization != null && action.attempt_count <= maxAttempts, "preauthorization_attempt_limit_exceeded", []),
    factor("failure_lock_clear", lockState.status, "clear", lockState.status === "clear", lockState.status === "locked" ? "autonomy_failure_locked" : "failure_lock_state_unavailable", []),
    factor("truthful_captured_simulation", truthMode, "captured_simulation", truthMode === "captured_simulation" && source.status === "captured_fixture", "captured_simulation_required", []),
    factor("local_notification_recorded", { status: notification.status, delivery_mode: notification.delivery_mode }, "recorded_local_or_simulated", notificationIsLocal, "local_notification_required", [])
  ];
}

function factor(id, observed, expected, passed, reasonCode, evidenceRefs) {
  return freezeClone({ id, observed, expected, passed: Boolean(passed), reason_code: passed ? null : reasonCode, evidence_refs: [...evidenceRefs] });
}

function classifyRisk(impact, action) {
  if (["sev1", "high", "unknown"].includes(impact.level) || action.risk === "high" || action.risk === "unknown") return "high";
  if (impact.level === "medium" || action.risk === "medium") return "medium";
  return impact.level === "low" && action.risk === "low" ? "low" : "blocked";
}

function inspectFailureLockState({ events, incident_id, contract_sha256, target }) {
  if (!Array.isArray(events)) return freezeClone({ status: "unavailable", lock_key: failureLockKey({ incident_id, contract_sha256, target }) });
  const expectedKey = failureLockKey({ incident_id, contract_sha256, target });
  for (const event of events) {
    if (event?.type !== "autonomy.locked") continue;
    const payload = event.payload;
    const eventIncidentId = event.incident_id ?? event.incidentId;
    const touchesIncident = eventIncidentId === incident_id || payload?.incident_id === incident_id;
    if (!touchesIncident) continue;
    if (!isPlainObject(payload)) return freezeClone({ status: "unavailable", lock_key: expectedKey });
    const maybeRelated = payload.incident_id === incident_id && (
      payload.contract_sha256 === contract_sha256 || payload.target === target ||
      payload.contract_sha256 == null || payload.target == null || payload.lock_key == null
    );
    if (!maybeRelated) continue;
    try {
      assertExactObject(payload, ["schema_version", "lock_key", "incident_id", "contract_sha256", "target", "binding_sha256", "decision_sha256", "failed_event_ref", "reason_code"], "failure_lock.payload", "failure_lock_invalid");
      if (payload.schema_version !== AUTONOMY_SCHEMA_VERSION || eventIncidentId !== payload.incident_id) fail("failure_lock_invalid", "failure_lock.payload");
      requireText(payload.incident_id, "failure_lock.incident_id", 160, "failure_lock_invalid");
      requireHash(payload.contract_sha256, "failure_lock.contract_sha256", "failure_lock_invalid");
      requireText(payload.target, "failure_lock.target", 160, "failure_lock_invalid");
      requireHash(payload.binding_sha256, "failure_lock.binding_sha256", "failure_lock_invalid");
      requireHash(payload.decision_sha256, "failure_lock.decision_sha256", "failure_lock_invalid");
      requireText(payload.failed_event_ref, "failure_lock.failed_event_ref", 160, "failure_lock_invalid");
      requireText(payload.reason_code, "failure_lock.reason_code", 80, "failure_lock_invalid");
      const payloadKey = failureLockKey(payload);
      if (payloadKey !== payload.lock_key || event.id !== payloadKey) fail("failure_lock_invalid", "failure_lock.lock_key");
      if (payload.incident_id === incident_id && payload.contract_sha256 === contract_sha256 && payload.target === target) return freezeClone({ status: "locked", lock_key: expectedKey });
      if (payload.contract_sha256 === contract_sha256 || payload.target === target) return freezeClone({ status: "unavailable", lock_key: expectedKey });
    } catch {
      return freezeClone({ status: "unavailable", lock_key: expectedKey });
    }
  }
  return freezeClone({ status: "clear", lock_key: expectedKey });
}

function normalizeFailureLockState(value, binding, contractHash) {
  assertExactObject(value, ["status", "lock_key"], "failure_lock_state", "decision_schema_invalid");
  if (!["clear", "locked", "unavailable"].includes(value.status) || value.lock_key !== failureLockKey({ incident_id: binding.incident_id, contract_sha256: contractHash, target: binding.target })) {
    fail("decision_failure_lock_mismatch", "failure_lock_state");
  }
  return freezeClone(value);
}

function normalizeAuthorityEvidence(value, snapshotHash) {
  assertExactObject(value, ["snapshot_sha256", "evidence_refs", "conflict_status", "deterministic_gate", "evaluator_gate"], "authority_evidence", "authority_evidence_invalid");
  if (requireHash(value.snapshot_sha256, "authority_evidence.snapshot_sha256", "authority_evidence_invalid") !== snapshotHash) fail("authority_snapshot_mismatch", "authority_evidence.snapshot_sha256");
  const refs = normalizedRefArray(value.evidence_refs, "authority_evidence.evidence_refs", MAX_REFS, "authority_evidence_invalid", true);
  const deterministicGate = normalizeGate(value.deterministic_gate, "authority_evidence.deterministic_gate", snapshotHash, refs);
  const evaluatorGate = normalizeGate(value.evaluator_gate, "authority_evidence.evaluator_gate", snapshotHash, refs);
  if (!["none", "conflicting", "unknown"].includes(value.conflict_status)) fail("authority_evidence_invalid", "authority_evidence.conflict_status");
  return freezeClone({ snapshot_sha256: snapshotHash, evidence_refs: refs, conflict_status: value.conflict_status, deterministic_gate: deterministicGate, evaluator_gate: evaluatorGate });
}

function normalizeGate(value, path, snapshotHash, evidenceRefs) {
  assertExactObject(value, ["event_id", "event_type", "event_sha256", "snapshot_sha256", "evidence_refs"], path, "authority_evidence_invalid");
  const refs = normalizedRefArray(value.evidence_refs, `${path}.evidence_refs`, MAX_REFS, "authority_evidence_invalid", true);
  if (!sameSet(refs, evidenceRefs)) fail("authority_evidence_mismatch", `${path}.evidence_refs`);
  if (requireHash(value.snapshot_sha256, `${path}.snapshot_sha256`, "authority_evidence_invalid") !== snapshotHash) fail("authority_snapshot_mismatch", `${path}.snapshot_sha256`);
  const expectedType = path.endsWith("deterministic_gate") ? "diagnosis.gate.passed" : "evaluation.accepted";
  if (value.event_type !== expectedType) fail("authority_gate_type_mismatch", `${path}.event_type`);
  const eventId = requireText(value.event_id, `${path}.event_id`, 160, "authority_evidence_invalid");
  const eventSha256 = requireHash(value.event_sha256, `${path}.event_sha256`, "authority_evidence_invalid");
  const expectedHash = sha256Canonical({ event_id: eventId, event_type: expectedType, snapshot_sha256: snapshotHash, evidence_refs: refs });
  if (eventSha256 !== expectedHash) fail("authority_gate_hash_mismatch", `${path}.event_sha256`);
  return freezeClone({ event_id: eventId, event_type: expectedType, event_sha256: eventSha256, snapshot_sha256: snapshotHash, evidence_refs: refs });
}

function normalizeAdvisory(value, authorityRefs) {
  assertExactObject(value, ["kb_refs", "model_confidence"], "advisory", "advisory_invalid");
  const refs = normalizedRefArray(value.kb_refs, "advisory.kb_refs", MAX_REFS, "advisory_invalid", false);
  if (refs.some((ref) => authorityRefs.includes(ref))) fail("advisory_authority_overlap", "advisory.kb_refs");
  if (!(value.model_confidence === null || (typeof value.model_confidence === "number" && Number.isFinite(value.model_confidence) && value.model_confidence >= 0 && value.model_confidence <= 1))) {
    fail("advisory_invalid", "advisory.model_confidence");
  }
  return freezeClone({ kb_refs: refs, model_confidence: value.model_confidence });
}

function normalizeImpact(value) {
  assertExactObject(value, ["level"], "impact", "impact_invalid");
  if (!["low", "medium", "high", "sev1", "unknown"].includes(value.level)) fail("impact_invalid", "impact.level");
  return freezeClone(value);
}

function normalizeAction(value) {
  assertExactObject(value, ["risk", "reversible", "idempotent", "blast_radius_components", "rollback_ready", "verification_ready", "attempt_count"], "action", "action_invalid");
  if (!["low", "medium", "high", "unknown"].includes(value.risk)) fail("action_risk_invalid", "action.risk");
  for (const key of ["reversible", "idempotent", "rollback_ready", "verification_ready"]) if (typeof value[key] !== "boolean") fail("action_factor_invalid", `action.${key}`);
  if (!Number.isInteger(value.blast_radius_components) || value.blast_radius_components < 1 || value.blast_radius_components > 999) fail("action_blast_radius_invalid", "action.blast_radius_components");
  if (!Number.isInteger(value.attempt_count) || value.attempt_count < 1 || value.attempt_count > 99) fail("action_attempt_invalid", "action.attempt_count");
  return freezeClone(value);
}

function normalizeSource(value) {
  assertExactObject(value, ["status", "fresh"], "source", "source_invalid");
  if (!["live", "captured_fixture", "stale", "disconnected", "unavailable"].includes(value.status) || typeof value.fresh !== "boolean") fail("source_invalid", "source");
  return freezeClone(value);
}

function normalizeNotification(value) {
  assertExactObject(value, ["status", "delivery_mode", "target_refs"], "notification", "notification_invalid");
  if (!["not_required", "pending", "recorded_local", "simulated", "failed", "unavailable"].includes(value.status)) fail("notification_status_invalid", "notification.status");
  if (!["none", "local_ledger", "captured_simulation", "unavailable"].includes(value.delivery_mode)) fail("notification_delivery_mode_invalid", "notification.delivery_mode");
  return freezeClone({ status: value.status, delivery_mode: value.delivery_mode, target_refs: normalizedRefArray(value.target_refs, "notification.target_refs", 8, "notification_invalid", true) });
}

function normalizeTruthMode(value) {
  if (value !== "captured_simulation") fail("truth_mode_invalid", "truth_mode");
  return value;
}

function assertEnvelope(value) {
  assertExactObject(value, [
    "schema_version", "id", "policy_version", "policy_sha256", "status", "issued_by", "issued_at", "expires_at", "environment",
    "action_contract", "limits", "required_verification_check_ids", "notification_targets"
  ], "envelope", "preauthorization_schema_invalid");
  if (value.schema_version !== PREAUTHORIZATION_SCHEMA_VERSION) fail("preauthorization_version_invalid", "envelope.schema_version");
  requireText(value.id, "envelope.id", 120, "preauthorization_schema_invalid");
  requireText(value.policy_version, "envelope.policy_version", 80, "preauthorization_schema_invalid");
  requirePrefixedHash(value.policy_sha256, "envelope.policy_sha256", "preauthorization_schema_invalid");
  if (!['active', 'revoked'].includes(value.status)) fail("preauthorization_status_invalid", "envelope.status");
  requireText(value.issued_by, "envelope.issued_by", 160, "preauthorization_schema_invalid");
  requireText(value.environment, "envelope.environment", 80, "preauthorization_schema_invalid");
  assertContract(value.action_contract, "envelope.action_contract");
  assertExactObject(value.limits, ["max_components", "max_attempts", "require_idempotency", "require_rollback", "require_fresh_verification", "require_notification_receipt"], "envelope.limits", "preauthorization_schema_invalid");
  if (value.limits.max_components !== 1 || value.limits.max_attempts !== 1 || value.limits.require_idempotency !== true || value.limits.require_rollback !== true || value.limits.require_fresh_verification !== true || value.limits.require_notification_receipt !== true) {
    fail("preauthorization_scope_invalid", "envelope.limits");
  }
  normalizedRefArray(value.required_verification_check_ids, "envelope.required_verification_check_ids", 8, "preauthorization_schema_invalid", true);
  normalizedRefArray(value.notification_targets, "envelope.notification_targets", 8, "preauthorization_schema_invalid", true);
}

function assertContract(value, path) {
  assertExactObject(value, ["repair_id", "command_id", "target", "expected_before", "expected_after"], path, "contract_schema_invalid");
  for (const key of ["repair_id", "command_id", "target", "expected_before", "expected_after"]) requireText(value[key], `${path}.${key}`, 240, "contract_schema_invalid");
}

function buildBinding(input) {
  const contract = input?.contract;
  assertContract(contract, "contract");
  const target = requireText(input?.target, "target", 160, "binding_invalid");
  if (target !== contract.target) fail("binding_target_contract_mismatch", "target");
  return freezeClone({
    incident_id: requireText(input?.incident_id, "incident_id", 160, "binding_invalid"),
    run_id: requireText(input?.run_id, "run_id", 160, "binding_invalid"),
    environment: requireText(input?.environment, "environment", 80, "binding_invalid"),
    snapshot_sha256: requireHash(input?.snapshot_sha256, "snapshot_sha256", "binding_invalid"),
    target
  });
}

function safeAuthorityEvidence(value) {
  return freezeClone({
    snapshot_sha256: value.snapshot_sha256,
    evidence_refs: value.evidence_refs,
    conflict_status: value.conflict_status,
    deterministic_gate: { event_id: value.deterministic_gate.event_id, event_type: value.deterministic_gate.event_type, event_sha256: value.deterministic_gate.event_sha256 },
    evaluator_gate: { event_id: value.evaluator_gate.event_id, event_type: value.evaluator_gate.event_type, event_sha256: value.evaluator_gate.event_sha256 }
  });
}

function contractsEqual(left, right) {
  try {
    assertContract(left, "action_contract");
    assertContract(right, "contract");
    return sha256Canonical(left) === sha256Canonical(right);
  } catch {
    return false;
  }
}

function normalizedRefArray(value, path, max, code, required) {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > max) fail(code, path);
  const refs = value.map((entry, index) => requireText(entry, `${path}[${index}]`, 160, code));
  if (new Set(refs).size !== refs.length) fail(code, path);
  return [...refs].sort();
}

function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && [...left].sort().every((entry, index) => entry === [...right].sort()[index]);
}

function unique(values) {
  return [...new Set(values)];
}

function assertExactObject(value, keys, path, code = "schema_invalid") {
  assertPlainObject(value, path, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, path);
}

function assertPlainObject(value, path, code = "schema_invalid") {
  if (!isPlainObject(value)) fail(code, path);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireText(value, path, maxBytes, code = "schema_invalid") {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) fail(code, path);
  return value;
}

function requireHash(value, path, code = "schema_invalid") {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(code, path);
  return value;
}

function requirePrefixedHash(value, path, code) {
  if (typeof value !== "string" || !PREFIXED_SHA_256.test(value)) fail(code, path);
  return value;
}

function parseTimestamp(value, path) {
  requireText(value, path, 40, "preauthorization_schema_invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("preauthorization_schema_invalid", path);
  return parsed;
}

function ensureByteLimit(value, maxBytes, code) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) fail(code, "payload");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical_value_invalid", "value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) fail("canonical_value_invalid", "value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function freezeClone(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(code, fieldPath = null) {
  throw new AutonomyPolicyError(code, fieldPath);
}

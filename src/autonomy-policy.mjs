import { createHash } from "node:crypto";

export const AUTONOMY_SCHEMA_VERSION = "flowpulse.autonomy.v1";
export const PREAUTHORIZATION_SCHEMA_VERSION = "flowpulse-preauthorization.v1";
export const PREAUTHORIZATION_REGISTRY_VERSION = "flowpulse-preauthorization-registry.v1";
export const LEGACY_DETAIL_UNAVAILABLE = "legacy_detail_unavailable";

const HEX_64 = /^[a-f0-9]{64}$/;
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

export function resolvePreauthorization({ registry, environment, contract, selected_ref = null }) {
  if (selected_ref != null) fail("client_preauthorization_selection_forbidden", "selected_ref");
  assertExactObject(registry, ["schema_version", "envelopes"], "registry");
  if (registry.schema_version !== PREAUTHORIZATION_REGISTRY_VERSION) fail("preauthorization_registry_version_invalid", "registry.schema_version");
  if (!Array.isArray(registry.envelopes) || registry.envelopes.length === 0 || registry.envelopes.length > 32) {
    fail("preauthorization_registry_invalid", "registry.envelopes");
  }
  const environmentValue = requireText(environment, "environment", 80);
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
  return Object.freeze({
    preauthorization_id: envelope.id,
    envelope_sha256: sha256Canonical(envelope),
    policy_sha256: envelope.policy_sha256,
    contract_sha256: sha256Canonical(contract),
    binding,
    binding_sha256: sha256Canonical(binding),
    expires_at: envelope.expires_at,
    required_verification_check_ids: [...envelope.required_verification_check_ids],
    notification_target_refs: [...envelope.notification_target_refs]
  });
}

export function preauthorizationClaimId({ incident_id, contract_sha256, envelope_sha256 }) {
  const scope = {
    incident_id: requireText(incident_id, "incident_id", 160),
    contract_sha256: requireHash(contract_sha256, "contract_sha256"),
    envelope_sha256: requireHash(envelope_sha256, "envelope_sha256")
  };
  return `preauthorization-claim-${sha256Canonical(scope).slice(0, 32)}`;
}

export function failureLockKey({ incident_id, contract_sha256, target }) {
  const scope = {
    incident_id: requireText(incident_id, "incident_id", 160),
    contract_sha256: requireHash(contract_sha256, "contract_sha256"),
    target: requireText(target, "target", 160)
  };
  return `autonomy-lock-${sha256Canonical(scope).slice(0, 32)}`;
}

export function hasFailureLock({ events, incident_id, contract_sha256, target }) {
  if (!Array.isArray(events)) fail("failure_lock_events_invalid", "failure_lock_events");
  const lockKey = failureLockKey({ incident_id, contract_sha256, target });
  return events.some((event) => event?.type === "autonomy.locked" && event?.payload?.lock_key === lockKey);
}

export function evaluateAutonomyDecision(input) {
  assertPlainObject(input, "input");
  const binding = buildBinding(input);
  const contract = input.contract;
  let contractHash = null;
  let envelopeHash = null;
  let policyHash = null;
  let preauthorization = null;
  let preauthorizationError = null;
  try {
    const resolved = resolvePreauthorization({
      registry: input.registry,
      environment: binding.environment,
      contract,
      selected_ref: input.selected_preauthorization_ref ?? null
    });
    preauthorization = validatePreauthorizationEnvelope(resolved, contract, binding, input.now);
    contractHash = preauthorization.contract_sha256;
    envelopeHash = preauthorization.envelope_sha256;
    policyHash = preauthorization.policy_sha256;
  } catch (error) {
    if (!(error instanceof AutonomyPolicyError)) throw error;
    preauthorizationError = error;
    contractHash = safeContractHash(contract);
  }
  const evidence = normalizeEvidence(input.evidence);
  const action = normalizeAction(input.action);
  const source = normalizeSource(input.source);
  const notification = normalizeNotification(input.notification);
  const failureLockStateAvailable = Array.isArray(input.failure_lock_events);
  const locked = !failureLockStateAvailable || hasSafeFailureLock(input.failure_lock_events, binding, contractHash);
  const factors = [
    factor("preauthorization_valid", preauthorization != null, preauthorizationError?.code ?? null),
    factor("source_fresh", source.fresh && ["live", "captured_fixture"].includes(source.status), source.fresh ? null : "source_stale"),
    factor("evidence_complete", evidence.complete, evidence.complete ? null : "evidence_incomplete"),
    factor("evidence_fresh", evidence.fresh, evidence.fresh ? null : "evidence_stale"),
    factor("evidence_non_conflicting", !evidence.conflicting, evidence.conflicting ? "evidence_conflicting" : null),
    factor("diagnosis_gate_passed", evidence.diagnosis_gate_passed, evidence.diagnosis_gate_passed ? null : "diagnosis_gate_failed"),
    factor("evaluator_accepted", evidence.evaluator_accepted, evidence.evaluator_accepted ? null : "evaluator_not_accepted"),
    factor("low_risk_action", action.risk === "low", action.risk === "low" ? null : "action_not_low_risk"),
    factor("single_component_blast_radius", action.blast_radius_components === 1, action.blast_radius_components === 1 ? null : "blast_radius_exceeded"),
    factor("reversible_idempotent", action.reversible && action.idempotent, action.reversible && action.idempotent ? null : "action_not_reversible_idempotent"),
    factor("rollback_verification_ready", action.rollback_ready && action.verification_ready, action.rollback_ready && action.verification_ready ? null : "rollback_or_verification_not_ready"),
    factor("failure_lock_clear", !locked, !failureLockStateAvailable ? "failure_lock_state_unavailable" : locked ? "autonomy_failure_locked" : null),
    factor("truthful_captured_simulation", input.truth_mode === "captured_simulation" && source.status === "captured_fixture", "captured_simulation_required"),
    factor("local_notification_recorded", ["recorded_local", "simulated"].includes(notification.status) && ["captured_simulation", "local_ledger"].includes(notification.delivery_mode), "local_notification_required")
  ];
  const passed = factors.every((entry) => entry.passed);
  const reasonCodes = [...new Set(factors.filter((entry) => !entry.passed).map((entry) => entry.reason_code).filter(Boolean))];
  const riskClass = action.risk === "low" ? "low" : action.risk === "medium" ? "medium" : action.risk === "high" ? "high" : "blocked";
  const outcome = passed
    ? "auto_execute_pre_authorized"
    : riskClass === "medium"
      ? "human_review_required"
      : riskClass === "high"
        ? "explicit_human_decision_required"
        : "blocked";
  return deepFreeze({
    schema_version: AUTONOMY_SCHEMA_VERSION,
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
    contract_sha256: contractHash,
    envelope_sha256: envelopeHash,
    policy_sha256: policyHash,
    preauthorization_id: preauthorization?.preauthorization_id ?? null,
    factor_results: factors,
    reason_codes: reasonCodes,
    evidence_refs: [],
    notification,
    execution: {
      truth_mode: "captured_simulation",
      receipt_type: null,
      satisfies_live_production_gate: false,
      satisfies_executed_offline_backtest: false
    },
    action_event_type: passed ? "action.simulated" : null,
    legacy_detail_status: LEGACY_DETAIL_UNAVAILABLE
  });
}

export function revalidateExecutionAuthority(input) {
  const decision = evaluateAutonomyDecision(input);
  const reasons = [...decision.reason_codes];
  const source = normalizeSource(input.source);
  if (source.status !== "live") reasons.push("live_source_required");
  if (input.executor_enabled !== true) reasons.push("executor_disabled");
  if (input.already_consumed === true) reasons.push("preauthorization_already_consumed");
  return deepFreeze({
    schema_version: AUTONOMY_SCHEMA_VERSION,
    passed: reasons.length === 0,
    reason_codes: [...new Set(reasons)],
    decision
  });
}

export function buildAutonomyDecisionEvent(decision) {
  assertPlainObject(decision, "decision");
  if (decision.schema_version !== AUTONOMY_SCHEMA_VERSION) fail("autonomy_decision_schema_invalid", "schema_version");
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    risk_class: decision.risk_class,
    outcome: decision.outcome,
    human_gate: decision.human_gate,
    binding: decision.binding,
    binding_sha256: decision.binding_sha256,
    envelope_sha256: decision.envelope_sha256,
    contract_sha256: decision.contract_sha256,
    policy_sha256: decision.policy_sha256,
    preauthorization_id: decision.preauthorization_id,
    factor_results: decision.factor_results.map((entry) => ({ id: entry.id, passed: entry.passed, reason_code: entry.reason_code })),
    reason_codes: [...decision.reason_codes].slice(0, 24),
    evidence_refs: [...decision.evidence_refs].slice(0, MAX_REFS),
    notification: decision.notification,
    execution: decision.execution,
    action_event_type: decision.action_event_type,
    legacy_detail_status: decision.legacy_detail_status
  };
  ensureByteLimit(payload, MAX_EVENT_BYTES, "autonomy_decision_payload_too_large");
  return {
    id: `autonomy-decision-${sha256Canonical({ binding: decision.binding, outcome: decision.outcome, binding_sha256: decision.binding_sha256 }).slice(0, 32)}`,
    runId: decision.run_id,
    incidentId: decision.incident_id,
    type: "autonomy.decision.recorded",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: payload.evidence_refs,
    correlationId: `autonomy-${decision.binding_sha256.slice(0, 24)}`
  };
}

export function buildPreauthorizationConsumptionEvent({ claim_id, decision, run_id }) {
  const claimId = requireText(claim_id, "claim_id", 120);
  assertPlainObject(decision, "decision");
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    claim_id: claimId,
    envelope_sha256: requireHash(decision.envelope_sha256, "envelope_sha256"),
    contract_sha256: requireHash(decision.contract_sha256, "contract_sha256"),
    snapshot_sha256: requireHash(decision.snapshot_sha256, "snapshot_sha256"),
    incident_id: requireText(decision.incident_id, "incident_id", 160),
    environment: requireText(decision.environment, "environment", 80),
    target: requireText(decision.target, "target", 160),
    truth_mode: "reserved_for_future_live_executor"
  };
  return {
    id: claimId,
    runId: requireText(run_id, "run_id", 160),
    incidentId: payload.incident_id,
    type: "preauthorization.consumed",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: [],
    correlationId: `preauthorization-${sha256Canonical(payload).slice(0, 24)}`
  };
}

export function buildFailureLockEvent({ decision, failed_event_ref, reason_code }) {
  assertPlainObject(decision, "decision");
  const contractSha = requireHash(decision.contract_sha256, "contract_sha256");
  const lockKey = failureLockKey({ incident_id: decision.incident_id, contract_sha256: contractSha, target: decision.target });
  const payload = {
    schema_version: AUTONOMY_SCHEMA_VERSION,
    lock_key: lockKey,
    incident_id: decision.incident_id,
    contract_sha256: contractSha,
    target: decision.target,
    failed_event_ref: requireText(failed_event_ref, "failed_event_ref", 160),
    reason_code: requireText(reason_code, "reason_code", 80)
  };
  return {
    id: lockKey,
    runId: decision.run_id,
    incidentId: decision.incident_id,
    type: "autonomy.locked",
    actor: "autonomy-policy",
    payload,
    evidenceRefs: [],
    correlationId: `lock-${sha256Canonical(payload).slice(0, 24)}`
  };
}

function assertEnvelope(value) {
  assertExactObject(value, [
    "schema_version", "id", "policy_version", "policy_sha256", "status", "issued_at", "expires_at", "environment",
    "action_contract", "limits", "required_verification_check_ids", "notification_target_refs"
  ], "envelope");
  if (value.schema_version !== PREAUTHORIZATION_SCHEMA_VERSION) fail("preauthorization_version_invalid", "schema_version");
  requireText(value.id, "id", 120);
  requireText(value.policy_version, "policy_version", 80);
  requireHash(value.policy_sha256, "policy_sha256");
  if (!["active", "revoked"].includes(value.status)) fail("preauthorization_status_invalid", "status");
  requireText(value.environment, "environment", 80);
  assertContract(value.action_contract, "action_contract");
  assertExactObject(value.limits, ["max_components", "max_attempts", "reversible", "idempotent", "rollback_ready", "verification_ready", "notification_required"], "limits");
  if (value.limits.max_components !== 1 || value.limits.max_attempts !== 1 || value.limits.reversible !== true || value.limits.idempotent !== true || value.limits.rollback_ready !== true || value.limits.verification_ready !== true || value.limits.notification_required !== true) {
    fail("preauthorization_scope_invalid", "limits");
  }
  assertRefArray(value.required_verification_check_ids, "required_verification_check_ids", 8);
  assertRefArray(value.notification_target_refs, "notification_target_refs", 8);
}

function assertContract(value, path) {
  assertExactObject(value, ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"], path);
  for (const key of ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"]) requireText(value[key], `${path}.${key}`, 240);
}

function buildBinding(input) {
  const contract = input?.contract;
  assertContract(contract, "contract");
  const target = requireText(input?.target, "target", 160);
  if (target !== contract.target) fail("binding_target_contract_mismatch", "target");
  return {
    incident_id: requireText(input?.incident_id, "incident_id", 160),
    run_id: requireText(input?.run_id, "run_id", 160),
    environment: requireText(input?.environment, "environment", 80),
    snapshot_sha256: requireHash(input?.snapshot_sha256, "snapshot_sha256"),
    target
  };
}

function normalizeEvidence(value) {
  assertExactObject(value, ["complete", "fresh", "conflicting", "diagnosis_gate_passed", "evaluator_accepted"], "evidence");
  for (const key of Object.keys(value)) if (typeof value[key] !== "boolean") fail("evidence_factor_invalid", `evidence.${key}`);
  return value;
}

function normalizeAction(value) {
  assertExactObject(value, ["risk", "reversible", "idempotent", "blast_radius_components", "rollback_ready", "verification_ready"], "action");
  if (!["low", "medium", "high"].includes(value.risk)) fail("action_risk_invalid", "action.risk");
  for (const key of ["reversible", "idempotent", "rollback_ready", "verification_ready"]) if (typeof value[key] !== "boolean") fail("action_factor_invalid", `action.${key}`);
  if (!Number.isInteger(value.blast_radius_components) || value.blast_radius_components < 1 || value.blast_radius_components > 999) fail("action_blast_radius_invalid", "action.blast_radius_components");
  return value;
}

function normalizeSource(value) {
  assertExactObject(value, ["status", "fresh"], "source");
  if (!["live", "captured_fixture", "stale", "disconnected", "unavailable"].includes(value.status) || typeof value.fresh !== "boolean") fail("source_invalid", "source");
  return value;
}

function normalizeNotification(value) {
  assertExactObject(value, ["status", "delivery_mode"], "notification");
  if (!["not_required", "pending", "recorded_local", "simulated", "failed", "unavailable"].includes(value.status)) fail("notification_status_invalid", "notification.status");
  if (!["none", "local_ledger", "captured_simulation", "unavailable"].includes(value.delivery_mode)) fail("notification_delivery_mode_invalid", "notification.delivery_mode");
  return value;
}

function hasSafeFailureLock(events, binding, contractHash) {
  if (!Array.isArray(events) || !contractHash) return false;
  return hasFailureLock({ events, incident_id: binding.incident_id, contract_sha256: contractHash, target: binding.target });
}

function factor(id, passed, reasonCode) {
  return Object.freeze({ id, passed: Boolean(passed), reason_code: passed ? null : reasonCode });
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

function safeContractHash(value) {
  try {
    assertContract(value, "contract");
    return sha256Canonical(value);
  } catch {
    return null;
  }
}

function assertExactObject(value, keys, path) {
  assertPlainObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("schema_invalid", path);
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("schema_invalid", path);
}

function assertRefArray(value, path, max) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) fail("schema_invalid", path);
  const refs = value.map((entry, index) => requireText(entry, `${path}[${index}]`, 160));
  if (new Set(refs).size !== refs.length) fail("schema_invalid", path);
}

function requireText(value, path, maxBytes) {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) fail("schema_invalid", path);
  return value;
}

function requireHash(value, path) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail("schema_invalid", path);
  return value;
}

function parseTimestamp(value, path) {
  requireText(value, path, 40);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("schema_invalid", path);
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
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail("canonical_value_invalid", "value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(code, fieldPath = null) {
  throw new AutonomyPolicyError(code, fieldPath);
}

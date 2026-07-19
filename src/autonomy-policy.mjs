import { createHash } from "node:crypto";
import { Ledger } from "./ledger.mjs";
import { FrozenEvidenceSnapshot } from "./evidence-source.mjs";
import { AUTONOMY_POLICY_ARTIFACT } from "./autonomy-policy-artifacts.mjs";
import { FreshnessReceiptError, createSnapshotFreshnessReceipt, verifySnapshotFreshnessReceipt } from "./autonomy-freshness.mjs";

export const AUTONOMY_SCHEMA_VERSION = "flowpulse.autonomy.v1";
export const PREAUTHORIZATION_SCHEMA_VERSION = "flowpulse-preauthorization.v1";
export const PREAUTHORIZATION_REGISTRY_VERSION = "flowpulse-preauthorization-registry.v1";
export const LEGACY_DETAIL_UNAVAILABLE = "legacy_detail_unavailable";

const HEX_64 = /^[a-f0-9]{64}$/;
const PREFIXED_SHA_256 = /^sha256:[a-f0-9]{64}$/;
const MAX_EVENT_BYTES = 12 * 1024;
const MAX_REFS = 32;
const DERIVED_AUTHORITY = Symbol("flowpulse.derived-authority");

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

function canonicalDecisionHash(decision) {
  assertPlainObject(decision, "decision", "decision_schema_invalid");
  const { decision_sha256: _ignored, ...unsigned } = decision;
  return sha256Canonical(unsigned);
}

function deriveAuthorityEvidenceFromTrustedRows(input) {
  // This helper is deliberately private. Only the server-composition
  // capability can give it a Ledger-owned decoded stream and a
  // FrozenEvidenceSnapshot-owned manifest; request/model/UI JSON never
  // reaches this authority boundary.
  assertExactObject(input, ["ledger_events", "snapshot_manifest", "incident_id", "run_id", "contract", "freshness", "decided_at"], "authority_context", "authority_evidence_invalid");
  const incidentId = requireText(input.incident_id, "authority_context.incident_id", 160, "authority_evidence_invalid");
  const runId = requireText(input.run_id, "authority_context.run_id", 160, "authority_evidence_invalid");
  const snapshot = normalizeSnapshotManifest(input.snapshot_manifest);
  const contractHash = sha256Canonical(assertContractClone(input.contract, "authority_context.contract"));
  const freshness = normalizeSource(input.freshness);
  const decidedAt = parseTimestamp(input.decided_at, "authority_context.decided_at");
  const observedAt = parseTimestamp(freshness.observed_at, "authority_context.freshness.observed_at");
  const expiresAt = parseTimestamp(freshness.expires_at, "authority_context.freshness.expires_at");
  if (!freshness.fresh || decidedAt >= expiresAt || decidedAt < observedAt) fail("freshness_receipt_invalid", "authority_context.freshness");
  const events = normalizeDecodedLedgerStream(input.ledger_events, incidentId, runId);
  const evaluatorEvents = events.filter((event) => event.type === "evaluation.accepted");
  const diagnosisEvents = events.filter((event) => event.type === "diagnosis.gate.passed");
  if (evaluatorEvents.length !== 1 || diagnosisEvents.length !== 1) fail("authority_gate_event_conflict", "authority_context.ledger_events");

  const evaluator = evaluatorEvents[0];
  const diagnosis = diagnosisEvents[0];
  if (evaluator.sequence >= diagnosis.sequence) fail("authority_gate_order_invalid", "authority_context.ledger_events");
  const evaluatorAt = parseTimestamp(evaluator.recorded_at, "authority_context.evaluator.recorded_at");
  const diagnosisAt = parseTimestamp(diagnosis.recorded_at, "authority_context.diagnosis.recorded_at");
  if (evaluatorAt < observedAt || diagnosisAt < observedAt || evaluatorAt >= diagnosisAt || diagnosisAt > decidedAt || evaluatorAt > decidedAt || evaluatorAt >= expiresAt || diagnosisAt >= expiresAt) {
    fail("authority_gate_temporal_invalid", "authority_context.ledger_events");
  }
  const diagnosisPayload = normalizeDiagnosisGatePayload(diagnosis.payload, snapshot, contractHash);
  const evaluatorPayload = normalizeEvaluatorGatePayload(evaluator.payload);
  if (evaluatorPayload.hypothesis_id !== diagnosisPayload.hypothesis_id) fail("authority_gate_hypothesis_mismatch", "authority_context.ledger_events");
  if (!sameSet(evaluator.evidence_refs, diagnosisPayload.evidence_refs)
    || !sameSet(diagnosis.evidence_refs, diagnosisPayload.evidence_refs)
    || !sameSet(evaluatorPayload.counter_evidence_refs, evaluator.evidence_refs)
    || !sameSet(evaluatorPayload.counter_evidence_refs, diagnosisPayload.evidence_refs)) {
    fail("authority_gate_evidence_mismatch", "authority_context.ledger_events");
  }
  assertEvidenceMembership(diagnosisPayload.evidence_refs, snapshot);

  return freezeDerivedAuthority({
    schema_version: "flowpulse.authority-evidence.v1",
    snapshot_id: snapshot.id,
    snapshot_sha256: snapshot.content_sha256,
    snapshot_mode: snapshot.mode,
    snapshot_manifest_sha256: snapshot.manifest_sha256,
    contract_sha256: contractHash,
    evidence_refs: diagnosisPayload.evidence_refs,
    evidence_records: diagnosisPayload.evidence_refs.map((id) => snapshot.records.find((record) => record.id === id)),
    conflict_status: "none",
    deterministic_gate: gateBindingFromDecodedEvent(diagnosis),
    evaluator_gate: gateBindingFromDecodedEvent(evaluator)
  });
}

// Server composition registers only actual FrozenEvidenceSnapshot instances.
// The store is intentionally not a request-facing cache: later routes receive
// only a server-resolved run/incident selector and cannot supply a manifest.
class AuthoritySnapshotStore {
  #entries = new Map();

  register({ run_id, incident_id, snapshot }) {
    assertExactObject({ run_id, incident_id, snapshot }, ["run_id", "incident_id", "snapshot"], "snapshot_store.registration", "trusted_snapshot_invalid");
    const runId = requireText(run_id, "snapshot_store.registration.run_id", 160, "trusted_snapshot_invalid");
    const incidentId = requireText(incident_id, "snapshot_store.registration.incident_id", 160, "trusted_snapshot_invalid");
    if (!(snapshot instanceof FrozenEvidenceSnapshot)) fail("trusted_snapshot_invalid", "snapshot_store.registration.snapshot");
    const manifest = frozenSnapshotManifest(snapshot);
    const receipt = createSnapshotFreshnessReceipt({ manifest, frozen_at: snapshot.metadata().frozen_at });
    const key = snapshotStoreKey(runId, incidentId);
    if (this.#entries.has(key)) fail("trusted_snapshot_duplicate", "snapshot_store.registration");
    this.#entries.set(key, Object.freeze({ snapshot, manifest: freezeClone(manifest), receipt }));
  }

  get({ run_id, incident_id }) {
    const runId = requireText(run_id, "snapshot_store.lookup.run_id", 160, "trusted_snapshot_invalid");
    const incidentId = requireText(incident_id, "snapshot_store.lookup.incident_id", 160, "trusted_snapshot_invalid");
    return this.#entries.get(snapshotStoreKey(runId, incidentId)) ?? null;
  }
}

class ServerAutonomyAuthority {
  #ledger;
  #snapshots;
  #registry;
  #intents;

  constructor(options) {
    assertExactObject(options, ["ledger"], "trusted_authority_provider", "trusted_authority_provider_invalid");
    if (!(options.ledger instanceof Ledger)) fail("trusted_authority_provider_invalid", "trusted_authority_provider.ledger");
    assertArtifact(AUTONOMY_POLICY_ARTIFACT);
    this.#ledger = options.ledger;
    this.#snapshots = new AuthoritySnapshotStore();
    this.#registry = freezeClone(AUTONOMY_POLICY_ARTIFACT.registry);
    this.#intents = normalizeIntentRegistry(AUTONOMY_POLICY_ARTIFACT.intents);
  }

  registerFrozenSnapshot(input) { this.#snapshots.register(input); }

  decide(selector) {
    assertExactObject(selector, ["run_id", "incident_id", "intent_id"], "authority_selector", "authority_selector_invalid");
    const runId = requireText(selector.run_id, "authority_selector.run_id", 160, "authority_selector_invalid");
    const incidentId = requireText(selector.incident_id, "authority_selector.incident_id", 160, "authority_selector_invalid");
    const intentId = requireText(selector.intent_id, "authority_selector.intent_id", 160, "authority_selector_invalid");
    const intent = this.#intents.get(intentId);
    if (!intent) fail("authority_intent_not_found", "authority_selector.intent_id");
    const storedSnapshot = this.#snapshots.get({ run_id: runId, incident_id: incidentId });
    if (!storedSnapshot) fail("frozen_snapshot_unavailable", "authority_selector");
    if (canonicalJson(frozenSnapshotManifest(storedSnapshot.snapshot)) !== canonicalJson(storedSnapshot.manifest)) {
      fail("trusted_snapshot_drift", "authority_selector");
    }
    const manifest = storedSnapshot.manifest;
    const now = new Date().toISOString();
    let freshness;
    try {
      freshness = verifySnapshotFreshnessReceipt({ receipt: storedSnapshot.receipt, manifest, now });
    } catch (error) {
      if (error instanceof FreshnessReceiptError) fail(error.code, error.field_path);
      throw error;
    }
    const authority = deriveAuthorityEvidenceFromTrustedRows({
      ledger_events: this.#ledger.list(runId),
      snapshot_manifest: manifest,
      incident_id: incidentId,
      run_id: runId,
      contract: intent.contract,
      freshness,
      decided_at: now
    });
    let locks = null;
    try { locks = this.#ledger.listAutonomyLocks(); } catch { locks = null; }
    const decision = evaluateAutonomyDecision({
      registry: this.#registry,
      contract: intent.contract,
      environment: intent.environment,
      incident_id: incidentId,
      run_id: runId,
      snapshot_sha256: manifest.content_sha256,
      target: intent.contract.target,
      now,
      impact: intent.impact,
      source: freshness,
      derived_authority: authority,
      advisory: { kb_refs: [], model_confidence: null },
      action: intent.action,
      notification: intent.notification,
      truth_mode: intent.truth_mode,
      failure_lock_events: locks
    });
    return freezeClone({ decision, event: buildAutonomyDecisionEvent({ decision, derived_authority: authority }) });
  }
}

// Server composition is the only authority entry point. It accepts a real
// Ledger handle, but never policy, intent, receipt, clock, store, or raw
// evidence configuration. Routes/UI/model tools must not import this module.
export function createServerAutonomyAuthority(options) {
  const authority = new ServerAutonomyAuthority(options);
  return Object.freeze({
    registerServerFrozenSnapshot: (input) => authority.registerFrozenSnapshot(input),
    decide: (selector) => authority.decide(selector)
  });
}

function resolvePreauthorization({ registry, environment, contract, selected_ref = null }) {
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

function validatePreauthorizationEnvelope(envelope, contract, bindings, now) {
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

function hasFailureLock({ events, incident_id, contract_sha256, target }) {
  const result = inspectFailureLockState({ events, incident_id, contract_sha256, target });
  if (result.status === "unavailable") fail("failure_lock_state_unavailable", "failure_lock_events");
  return result.status === "locked";
}

function evaluateAutonomyDecision(input) {
  assertExactObject(input, [
    "registry", "contract", "environment", "incident_id", "run_id", "snapshot_sha256", "target", "now", "impact", "source",
    "derived_authority", "advisory", "action", "notification", "truth_mode", "failure_lock_events"
  ], "input", "autonomy_input_invalid");
  const binding = buildBinding(input);
  const contract = freezeClone(input.contract);
  const impact = normalizeImpact(input.impact);
  const source = normalizeSource(input.source);
  const authorityEvidence = requireDerivedAuthority(input.derived_authority, binding);
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
    authority_evidence_sha256: sha256Canonical(authorityEvidence),
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

function revalidateExecutionAuthority(input) {
  assertExactObject(input, ["decision", "registry", "now", "source", "failure_lock_events", "executor_enabled", "derived_authority"], "revalidation", "revalidation_input_invalid");
  const decision = assertCanonicalDecision(input.decision);
  const authorityEvidence = requireDerivedAuthority(input.derived_authority, decision.binding);
  const source = normalizeSource(input.source);
  const reasons = [];
  if (canonicalJson(authorityEvidence) !== canonicalJson(decision.authority_evidence)) reasons.push("authority_provenance_changed");
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

function buildAutonomyDecisionEvent(input) {
  assertExactObject(input, ["decision", "derived_authority"], "decision_event", "decision_event_input_invalid");
  const canonical = assertCanonicalDecision(input.decision);
  const authorityEvidence = requireDerivedAuthority(input.derived_authority, canonical.binding);
  if (canonicalJson(authorityEvidence) !== canonicalJson(canonical.authority_evidence)) fail("authority_provenance_changed", "derived_authority");
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
    authority_evidence_sha256: canonical.authority_evidence_sha256,
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

function buildPreauthorizationConsumptionEvent(input) {
  assertExactObject(input, ["decision", "derived_authority"], "consumption", "consumption_input_invalid");
  const decision = assertCanonicalDecision(input.decision);
  const authorityEvidence = requireDerivedAuthority(input.derived_authority, decision.binding);
  if (canonicalJson(authorityEvidence) !== canonicalJson(decision.authority_evidence)) fail("authority_provenance_changed", "derived_authority");
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
    authority_evidence_sha256: decision.authority_evidence_sha256,
    snapshot_manifest_sha256: decision.authority_evidence.snapshot_manifest_sha256,
    evaluator_gate: decision.authority_evidence.evaluator_gate,
    deterministic_gate: decision.authority_evidence.deterministic_gate,
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

function buildFailureLockEvent(input) {
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
    "preauthorization_error_code", "authority_evidence", "authority_evidence_sha256", "advisory", "source", "action", "notification", "truth_mode", "failure_lock_state", "factor_results",
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
  if (authorityEvidence.contract_sha256 !== contractHash) fail("decision_authority_contract_mismatch", "decision.authority_evidence.contract_sha256");
  if (sha256Canonical(authorityEvidence) !== value.authority_evidence_sha256) fail("decision_authority_evidence_hash_mismatch", "decision.authority_evidence_sha256");
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
    try {
      assertExactObject(event, ["sequence", "id", "run_id", "incident_id", "recorded_at", "offset_ms", "type", "actor", "payload", "payload_sha256", "evidence_refs", "parent_id", "correlation_id"], "failure_lock.event", "failure_lock_invalid");
      requireText(eventIncidentId, "failure_lock.incident_id", 160, "failure_lock_invalid");
      requireText(event.run_id, "failure_lock.run_id", 160, "failure_lock_invalid");
      requireText(event.id, "failure_lock.id", 160, "failure_lock_invalid");
      parseTimestamp(event.recorded_at, "failure_lock.recorded_at");
      if (!Number.isInteger(event.sequence) || event.sequence < 1 || !Number.isInteger(event.offset_ms)) fail("failure_lock_invalid", "failure_lock.sequence");
      requireText(event.actor, "failure_lock.actor", 160, "failure_lock_invalid");
      normalizedRefArray(event.evidence_refs, "failure_lock.evidence_refs", MAX_REFS, "failure_lock_invalid", false);
      if (!(event.parent_id === null || typeof event.parent_id === "string")) fail("failure_lock_invalid", "failure_lock.parent_id");
      requireText(event.correlation_id, "failure_lock.correlation_id", 160, "failure_lock_invalid");
      assertExactObject(payload, ["schema_version", "lock_key", "incident_id", "contract_sha256", "target", "binding_sha256", "decision_sha256", "failed_event_ref", "reason_code"], "failure_lock.payload", "failure_lock_invalid");
      if (requireHash(event.payload_sha256, "failure_lock.payload_sha256", "failure_lock_invalid") !== sha256Canonical(payload)) fail("failure_lock_invalid", "failure_lock.payload_sha256");
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

function requireDerivedAuthority(derived, binding) {
  if (!derived || derived[DERIVED_AUTHORITY] !== true) fail("authority_provenance_unverified", "derived_authority");
  const authority = freezeDerivedAuthority(normalizeAuthorityEvidence(derived, binding.snapshot_sha256));
  if (authority.snapshot_sha256 !== binding.snapshot_sha256) fail("authority_snapshot_mismatch", "derived_authority.snapshot_sha256");
  return authority;
}

function assertRegistry(value) {
  assertExactObject(value, ["schema_version", "envelopes"], "registry", "preauthorization_registry_invalid");
  if (value.schema_version !== PREAUTHORIZATION_REGISTRY_VERSION || !Array.isArray(value.envelopes) || value.envelopes.length === 0 || value.envelopes.length > 32) {
    fail("preauthorization_registry_invalid", "registry");
  }
  for (const envelope of value.envelopes) assertEnvelope(envelope);
}

function assertArtifact(value) {
  assertExactObject(value, ["schema_version", "version", "registry", "intents"], "autonomy_artifact", "autonomy_artifact_invalid");
  if (value.schema_version !== "flowpulse.autonomy-artifacts.v1") fail("autonomy_artifact_invalid", "autonomy_artifact.schema_version");
  requireText(value.version, "autonomy_artifact.version", 80, "autonomy_artifact_invalid");
  assertRegistry(value.registry);
  normalizeIntentRegistry(value.intents);
}

function normalizeIntentRegistry(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail("authority_intents_invalid", "trusted_authority_provider.intents");
  const intents = new Map();
  for (const [index, candidate] of value.entries()) {
    const path = `trusted_authority_provider.intents[${index}]`;
    assertExactObject(candidate, ["id", "environment", "contract", "impact", "action", "notification", "truth_mode"], path, "authority_intents_invalid");
    const id = requireText(candidate.id, `${path}.id`, 160, "authority_intents_invalid");
    if (intents.has(id)) fail("authority_intents_invalid", `${path}.id`);
    assertContract(candidate.contract, `${path}.contract`);
    const intent = freezeClone({
      id,
      environment: requireText(candidate.environment, `${path}.environment`, 80, "authority_intents_invalid"),
      contract: candidate.contract,
      impact: normalizeImpact(candidate.impact),
      action: normalizeAction(candidate.action),
      notification: normalizeNotification(candidate.notification),
      truth_mode: normalizeTruthMode(candidate.truth_mode)
    });
    intents.set(id, intent);
  }
  return intents;
}

function frozenSnapshotManifest(snapshot) {
  if (!(snapshot instanceof FrozenEvidenceSnapshot)) fail("trusted_snapshot_invalid", "snapshot");
  const metadata = snapshot.metadata();
  const id = requireText(snapshot.id, "snapshot.id", 160, "trusted_snapshot_invalid");
  const mode = requireText(metadata.mode, "snapshot.metadata.mode", 80, "trusted_snapshot_invalid");
  if (!["frozen_real_otlp_snapshot", "deterministic_replay"].includes(mode)) fail("trusted_snapshot_invalid", "snapshot.metadata.mode");
  if (!Array.isArray(snapshot.records) || snapshot.records.length === 0 || snapshot.records.length > 120) fail("trusted_snapshot_invalid", "snapshot.records");
  const records = snapshot.records.map((record, index) => {
    const hash = record?.provenance?.sha256 ?? record?.hash;
    return {
      id: requireText(record?.id, `snapshot.records[${index}].id`, 160, "trusted_snapshot_invalid"),
      sha256: requireHash(hash, `snapshot.records[${index}].sha256`, "trusted_snapshot_invalid"),
      source: requireText(record?.source, `snapshot.records[${index}].source`, 160, "trusted_snapshot_invalid"),
      mode: requireText(record?.mode ?? mode, `snapshot.records[${index}].mode`, 80, "trusted_snapshot_invalid")
    };
  }).sort(compareById);
  if (new Set(records.map((record) => record.id)).size !== records.length) fail("trusted_snapshot_invalid", "snapshot.records");
  const unsigned = { id, content_sha256: sha256Canonical(records), mode, records };
  return freezeClone({ ...unsigned, manifest_sha256: sha256Canonical(unsigned) });
}

function snapshotStoreKey(runId, incidentId) {
  return `${runId}\u0000${incidentId}`;
}

function assertContractClone(value, path) {
  assertContract(value, path);
  return freezeClone(value);
}

function normalizeSnapshotManifest(value) {
  assertExactObject(value, ["id", "content_sha256", "mode", "records", "manifest_sha256"], "snapshot_manifest", "authority_evidence_invalid");
  const id = requireText(value.id, "snapshot_manifest.id", 160, "authority_evidence_invalid");
  const contentSha256 = requireHash(value.content_sha256, "snapshot_manifest.content_sha256", "authority_evidence_invalid");
  const mode = requireText(value.mode, "snapshot_manifest.mode", 80, "authority_evidence_invalid");
  if (!["frozen_real_otlp_snapshot", "deterministic_replay"].includes(mode)) fail("authority_evidence_invalid", "snapshot_manifest.mode");
  if (!Array.isArray(value.records) || value.records.length === 0 || value.records.length > 120) fail("authority_evidence_invalid", "snapshot_manifest.records");
  const records = value.records.map((record, index) => {
    assertExactObject(record, ["id", "sha256", "source", "mode"], `snapshot_manifest.records[${index}]`, "authority_evidence_invalid");
    return {
      id: requireText(record.id, `snapshot_manifest.records[${index}].id`, 160, "authority_evidence_invalid"),
      sha256: requireHash(record.sha256, `snapshot_manifest.records[${index}].sha256`, "authority_evidence_invalid"),
      source: requireText(record.source, `snapshot_manifest.records[${index}].source`, 160, "authority_evidence_invalid"),
      mode: requireText(record.mode, `snapshot_manifest.records[${index}].mode`, 80, "authority_evidence_invalid")
    };
  }).sort(compareById);
  if (new Set(records.map((record) => record.id)).size !== records.length) fail("authority_evidence_invalid", "snapshot_manifest.records");
  const computedContentHash = sha256Canonical(records);
  if (computedContentHash !== contentSha256) fail("snapshot_manifest_content_hash_mismatch", "snapshot_manifest.content_sha256");
  const snapshot = { id, content_sha256: contentSha256, mode, records };
  if (requireHash(value.manifest_sha256, "snapshot_manifest.manifest_sha256", "authority_evidence_invalid") !== sha256Canonical(snapshot)) {
    fail("snapshot_manifest_hash_mismatch", "snapshot_manifest.manifest_sha256");
  }
  return freezeClone({ ...snapshot, manifest_sha256: value.manifest_sha256 });
}

function normalizeDecodedLedgerStream(value, incidentId, runId) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) fail("authority_evidence_invalid", "authority_context.ledger_events");
  const ids = new Set();
  let previousSequence = 0;
  return value.map((event, index) => {
    assertExactObject(event, ["sequence", "id", "run_id", "incident_id", "recorded_at", "offset_ms", "type", "actor", "payload", "payload_sha256", "evidence_refs", "parent_id", "correlation_id"], `authority_context.ledger_events[${index}]`, "authority_evidence_invalid");
    if (!Number.isInteger(event.sequence) || event.sequence < 1 || event.sequence <= previousSequence) fail("authority_ledger_sequence_invalid", `authority_context.ledger_events[${index}].sequence`);
    previousSequence = event.sequence;
    const id = requireText(event.id, `authority_context.ledger_events[${index}].id`, 160, "authority_evidence_invalid");
    if (ids.has(id)) fail("authority_ledger_event_duplicate", `authority_context.ledger_events[${index}].id`);
    ids.add(id);
    if (event.run_id !== runId || event.incident_id !== incidentId) fail("authority_ledger_scope_mismatch", `authority_context.ledger_events[${index}]`);
    parseTimestamp(event.recorded_at, `authority_context.ledger_events[${index}].recorded_at`);
    if (!Number.isInteger(event.offset_ms)) fail("authority_evidence_invalid", `authority_context.ledger_events[${index}].offset_ms`);
    requireText(event.type, `authority_context.ledger_events[${index}].type`, 80, "authority_evidence_invalid");
    requireText(event.actor, `authority_context.ledger_events[${index}].actor`, 160, "authority_evidence_invalid");
    assertPlainObject(event.payload, `authority_context.ledger_events[${index}].payload`, "authority_evidence_invalid");
    if (requireHash(event.payload_sha256, `authority_context.ledger_events[${index}].payload_sha256`, "authority_evidence_invalid") !== sha256Canonical(event.payload)) {
      fail("authority_ledger_payload_hash_mismatch", `authority_context.ledger_events[${index}].payload_sha256`);
    }
    const evidenceRefs = normalizedRefArray(event.evidence_refs, `authority_context.ledger_events[${index}].evidence_refs`, MAX_REFS, "authority_evidence_invalid", false);
    if (!(event.parent_id === null || typeof event.parent_id === "string")) fail("authority_evidence_invalid", `authority_context.ledger_events[${index}].parent_id`);
    requireText(event.correlation_id, `authority_context.ledger_events[${index}].correlation_id`, 160, "authority_evidence_invalid");
    return freezeClone({ ...event, evidence_refs: evidenceRefs });
  });
}

function normalizeDiagnosisGatePayload(value, snapshot, expectedContractHash) {
  assertAllowedObject(value, ["version", "harness", "snapshot", "accepted", "rejected", "repair_contract", "candidate_sha256", "context_sha256"], ["snapshot", "accepted"], "diagnosis_gate.payload", "authority_evidence_invalid");
  const snapshotBinding = value.snapshot;
  assertAllowedObject(snapshotBinding, ["id", "mode", "content_sha256", "source_sha256"], ["id", "mode", "content_sha256"], "diagnosis_gate.payload.snapshot", "authority_evidence_invalid");
  if (snapshotBinding.id !== snapshot.id || snapshotBinding.content_sha256 !== snapshot.content_sha256 || snapshotBinding.mode !== snapshot.mode) {
    fail("authority_gate_snapshot_mismatch", "diagnosis_gate.payload.snapshot");
  }
  const accepted = value.accepted;
  assertAllowedObject(accepted, ["diagnosis", "evaluation", "evidence_ids", "evidence_bindings", "proposed_action_contract_sha256"], ["diagnosis", "evaluation", "evidence_ids", "proposed_action_contract_sha256"], "diagnosis_gate.payload.accepted", "authority_evidence_invalid");
  const diagnosis = accepted.diagnosis;
  const evaluation = accepted.evaluation;
  assertAllowedObject(diagnosis, ["id", "title", "claim", "confidence", "initiating_change", "failure_mechanism", "propagation", "evidence_refs", "proposed_repair"], ["id", "evidence_refs"], "diagnosis_gate.payload.accepted.diagnosis", "authority_evidence_invalid");
  const hypothesisId = requireText(diagnosis.id, "diagnosis_gate.payload.accepted.diagnosis.id", 160, "authority_evidence_invalid");
  const evidenceRefs = normalizedRefArray(diagnosis.evidence_refs, "diagnosis_gate.payload.accepted.diagnosis.evidence_refs", MAX_REFS, "authority_evidence_invalid", true);
  const normalizedEvaluation = normalizeAcceptedEvaluation(evaluation, "diagnosis_gate.payload.accepted.evaluation", false);
  if (!sameSet(normalizedEvaluation.counter_evidence_refs, evidenceRefs)) fail("authority_gate_evidence_mismatch", "diagnosis_gate.payload.accepted.evaluation");
  if (!sameSet(accepted.evidence_ids, evidenceRefs)) fail("authority_gate_evidence_mismatch", "diagnosis_gate.payload.accepted.evidence_ids");
  if (requireHash(accepted.proposed_action_contract_sha256, "diagnosis_gate.payload.accepted.proposed_action_contract_sha256", "authority_evidence_invalid") !== expectedContractHash) {
    fail("authority_gate_contract_mismatch", "diagnosis_gate.payload.accepted.proposed_action_contract_sha256");
  }
  return { hypothesis_id: hypothesisId, evidence_refs: evidenceRefs };
}

function normalizeEvaluatorGatePayload(value) {
  // The older deterministic development event is intentionally not adapted
  // here: its compact evaluator payload cannot grant preauthorized autonomy.
  // Checkout remains a medium, per-incident Owner Gate until Slice 2 emits the
  // full versioned evaluator contract from the runtime itself.
  return normalizeAcceptedEvaluation(value, "evaluator_gate.payload", true);
}

function normalizeAcceptedEvaluation(value, path, requireHypothesisId) {
  assertAllowedObject(value, ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs", "hypothesis_id", "live", "attempt"], ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs", ...(requireHypothesisId ? ["hypothesis_id"] : [])], path, "authority_evidence_invalid");
  if (value.accepted !== true) fail("authority_evidence_invalid", `${path}.accepted`);
  const hypothesisId = requireHypothesisId ? requireText(value.hypothesis_id, `${path}.hypothesis_id`, 160, "authority_evidence_invalid") : null;
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) fail("authority_evidence_invalid", `${path}.score`);
  if (value.classification !== "confirmed_system_bug") fail("authority_evidence_invalid", `${path}.classification`);
  if (value.phase !== "diagnosis_pre_approval") fail("authority_evidence_invalid", `${path}.phase`);
  assertExactObject(value.gate_checks, ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"], `${path}.gate_checks`, "authority_evidence_invalid");
  if (Object.values(value.gate_checks).some((passed) => passed !== true)) fail("authority_evidence_invalid", `${path}.gate_checks`);
  requireText(value.reason, `${path}.reason`, 4096, "authority_evidence_invalid");
  if (!Array.isArray(value.missing_evidence) || value.missing_evidence.length !== 0) fail("authority_evidence_invalid", `${path}.missing_evidence`);
  const counterEvidenceRefs = normalizedRefArray(value.counter_evidence_refs, `${path}.counter_evidence_refs`, MAX_REFS, "authority_evidence_invalid", true);
  if (value.live != null && typeof value.live !== "boolean") fail("authority_evidence_invalid", `${path}.live`);
  if (value.attempt != null && (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 2)) fail("authority_evidence_invalid", `${path}.attempt`);
  return { hypothesis_id: hypothesisId, counter_evidence_refs: counterEvidenceRefs };
}

function assertEvidenceMembership(refs, snapshot) {
  const records = new Map(snapshot.records.map((record) => [record.id, record]));
  for (const ref of refs) if (!records.has(ref)) fail("authority_evidence_nonmember", "authority_context.snapshot_manifest.records");
}

function gateBindingFromDecodedEvent(event) {
  return freezeClone({ event_id: event.id, event_type: event.type, sequence: event.sequence, payload_sha256: event.payload_sha256 });
}

function normalizeAuthorityEvidence(value, snapshotHash) {
  assertExactObject(value, ["schema_version", "snapshot_id", "snapshot_sha256", "snapshot_mode", "snapshot_manifest_sha256", "contract_sha256", "evidence_refs", "evidence_records", "conflict_status", "deterministic_gate", "evaluator_gate"], "authority_evidence", "authority_evidence_invalid");
  if (value.schema_version !== "flowpulse.authority-evidence.v1") fail("authority_evidence_invalid", "authority_evidence.schema_version");
  requireText(value.snapshot_id, "authority_evidence.snapshot_id", 160, "authority_evidence_invalid");
  requireText(value.snapshot_mode, "authority_evidence.snapshot_mode", 80, "authority_evidence_invalid");
  requireHash(value.snapshot_manifest_sha256, "authority_evidence.snapshot_manifest_sha256", "authority_evidence_invalid");
  if (requireHash(value.snapshot_sha256, "authority_evidence.snapshot_sha256", "authority_evidence_invalid") !== snapshotHash) fail("authority_snapshot_mismatch", "authority_evidence.snapshot_sha256");
  const refs = normalizedRefArray(value.evidence_refs, "authority_evidence.evidence_refs", MAX_REFS, "authority_evidence_invalid", true);
  const evidenceRecords = normalizeAuthorityEvidenceRecords(value.evidence_records, refs);
  const deterministicGate = normalizeGate(value.deterministic_gate, "authority_evidence.deterministic_gate", snapshotHash, refs);
  const evaluatorGate = normalizeGate(value.evaluator_gate, "authority_evidence.evaluator_gate", snapshotHash, refs);
  if (evaluatorGate.sequence >= deterministicGate.sequence) fail("authority_gate_order_invalid", "authority_evidence");
  if (!["none", "conflicting", "unknown"].includes(value.conflict_status)) fail("authority_evidence_invalid", "authority_evidence.conflict_status");
  return freezeClone({
    schema_version: value.schema_version,
    snapshot_id: value.snapshot_id,
    snapshot_sha256: snapshotHash,
    snapshot_mode: value.snapshot_mode,
    snapshot_manifest_sha256: value.snapshot_manifest_sha256,
    contract_sha256: requireHash(value.contract_sha256, "authority_evidence.contract_sha256", "authority_evidence_invalid"),
    evidence_refs: refs,
    evidence_records: evidenceRecords,
    conflict_status: value.conflict_status,
    deterministic_gate: deterministicGate,
    evaluator_gate: evaluatorGate
  });
}

function normalizeAuthorityEvidenceRecords(value, refs) {
  if (!Array.isArray(value) || value.length !== refs.length) fail("authority_evidence_invalid", "authority_evidence.evidence_records");
  const records = value.map((record, index) => {
    assertExactObject(record, ["id", "sha256", "source", "mode"], `authority_evidence.evidence_records[${index}]`, "authority_evidence_invalid");
    return {
      id: requireText(record.id, `authority_evidence.evidence_records[${index}].id`, 160, "authority_evidence_invalid"),
      sha256: requireHash(record.sha256, `authority_evidence.evidence_records[${index}].sha256`, "authority_evidence_invalid"),
      source: requireText(record.source, `authority_evidence.evidence_records[${index}].source`, 160, "authority_evidence_invalid"),
      mode: requireText(record.mode, `authority_evidence.evidence_records[${index}].mode`, 80, "authority_evidence_invalid")
    };
  }).sort(compareById);
  if (new Set(records.map((record) => record.id)).size !== records.length || !sameSet(records.map((record) => record.id), refs)) {
    fail("authority_evidence_nonmember", "authority_evidence.evidence_records");
  }
  return records;
}

function normalizeGate(value, path, _snapshotHash, _evidenceRefs) {
  assertExactObject(value, ["event_id", "event_type", "sequence", "payload_sha256"], path, "authority_evidence_invalid");
  const expectedType = path.endsWith("deterministic_gate") ? "diagnosis.gate.passed" : "evaluation.accepted";
  if (value.event_type !== expectedType) fail("authority_gate_type_mismatch", `${path}.event_type`);
  const eventId = requireText(value.event_id, `${path}.event_id`, 160, "authority_evidence_invalid");
  if (!Number.isInteger(value.sequence) || value.sequence < 1) fail("authority_evidence_invalid", `${path}.sequence`);
  const payloadSha256 = requireHash(value.payload_sha256, `${path}.payload_sha256`, "authority_evidence_invalid");
  return freezeClone({ event_id: eventId, event_type: expectedType, sequence: value.sequence, payload_sha256: payloadSha256 });
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
  assertExactObject(value, ["status", "fresh", "truth_mode", "observed_at", "expires_at", "receipt_sha256"], "source", "source_invalid");
  if (!["live", "captured_fixture", "stale", "disconnected", "unavailable"].includes(value.status) || typeof value.fresh !== "boolean") fail("source_invalid", "source");
  if (!["captured_simulation", "live"].includes(value.truth_mode)) fail("source_invalid", "source.truth_mode");
  parseTimestamp(value.observed_at, "source.observed_at");
  parseTimestamp(value.expires_at, "source.expires_at");
  requireHash(value.receipt_sha256, "source.receipt_sha256", "source_invalid");
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
    schema_version: value.schema_version,
    snapshot_id: value.snapshot_id,
    snapshot_sha256: value.snapshot_sha256,
    snapshot_mode: value.snapshot_mode,
    snapshot_manifest_sha256: value.snapshot_manifest_sha256,
    contract_sha256: value.contract_sha256,
    evidence_refs: value.evidence_refs,
    evidence_records: value.evidence_records,
    conflict_status: value.conflict_status,
    deterministic_gate: value.deterministic_gate,
    evaluator_gate: value.evaluator_gate
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

function compareById(left, right) {
  return left.id.localeCompare(right.id);
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

function assertAllowedObject(value, allowedKeys, requiredKeys, path, code = "schema_invalid") {
  assertPlainObject(value, path, code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) fail(code, path);
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

function freezeDerivedAuthority(value) {
  const clone = structuredClone(value);
  Object.defineProperty(clone, DERIVED_AUTHORITY, { value: true, enumerable: false, configurable: false, writable: false });
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(code, fieldPath = null) {
  throw new AutonomyPolicyError(code, fieldPath);
}

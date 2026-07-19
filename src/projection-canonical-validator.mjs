import { sha256Canonical } from "./autonomy-policy.mjs";
import { sha256 as hashBoundEvidence } from "./regression-backtest.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GATE_CHECKS = ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"];
const RECOVERY_CHECKS = ["flag_variant_restored", "fresh_checkout_payment_success", "no_fresh_resolver_failures"];

// This module is intentionally a read-only structural validator. It derives no
// authority and is only used to prevent a browser projection from strengthening
// a ledger history that the server-owned Slice-B closure has not verified.
export function validateProjectionCanonicalChain({ events, chain, axes, evidence }) {
  if (chain == null) return chainResult("none");
  if (!plain(chain) || chain.schema_version !== "flowpulse.projection-authority.v1" || !["canonical", "legacy", "invalid"].includes(chain.status)) return chainResult("invalid", "projection_chain_shape_invalid");
  if (chain.status !== "canonical") return chainResult(chain.status, safeText(chain.reason || "legacy_detail_unavailable", 120));
  if (axes?.execution_mode !== "real_local_development" || axes?.evidence_mode !== "frozen_real_snapshot" || axes?.source_health !== "live") return chainResult("invalid", "projection_chain_truth_axis_invalid");
  if (!exactKeys(chain, ["schema_version", "status", "decision", "proposal", "request", "approval", "attempt", "execution", "verification"])) return chainResult("invalid", "projection_chain_fields_invalid");

  const identities = ["decision", "proposal", "request", "approval", "attempt", "execution", "verification"];
  const resolved = Object.fromEntries(identities.map((key) => [key, chain[key] == null ? null : eventFor(events, chain[key]) ]));
  if (!resolved.decision || !resolved.proposal || !resolved.request || !identities.every((key) => chain[key] == null || identityMatches(resolved[key], chain[key]))) return chainResult("invalid", "projection_chain_identity_invalid");
  if ((resolved.attempt && !resolved.approval) || (resolved.execution && !resolved.attempt) || (resolved.verification && !resolved.execution)) return chainResult("invalid", "projection_chain_link_missing");

  const { decision, proposal, request, approval, attempt, execution, verification } = resolved;
  if (!canonicalDecision(decision, axes)) return chainResult("invalid", "projection_chain_decision_invalid");
  const evaluator = events.find((event) => event.id === decision.payload.authority_evidence.evaluator.id) || null;
  const gate = events.find((event) => event.id === decision.payload.authority_evidence.diagnosis_gate.id) || null;
  if (!authorityIdentityMatches(evaluator, decision.payload.authority_evidence.evaluator) || !authorityIdentityMatches(gate, decision.payload.authority_evidence.diagnosis_gate)
    || !strictAcceptedEvaluation(evaluator) || !strictDiagnosisGate(gate, evaluator)
    || gate.payload.snapshot.id !== decision.payload.snapshot.id || gate.payload.snapshot.content_sha256 !== decision.payload.snapshot.content_sha256
    || gate.payload.snapshot.mode !== decision.payload.snapshot.mode
    || !sameCoreContract(gate.payload.repair_contract, decision.payload.contract)
    || !sameCoreContract(gate.payload.accepted.diagnosis.proposed_repair, decision.payload.contract)
    || !strictAuthorityEvidence(decision.payload.authority_evidence, decision.evidence_refs, gate, evidence, decision.payload.snapshot.mode)
    || !(evaluator.sequence < gate.sequence && gate.sequence < decision.sequence)) return chainResult("invalid", "projection_chain_evaluator_gate_invalid");
  if (!canonicalProposal(proposal, decision)) return chainResult("invalid", "projection_chain_proposal_invalid");
  if (!canonicalRequest(request, decision, proposal)) return chainResult("invalid", "projection_chain_request_invalid");
  if (!(decision.sequence < proposal.sequence && proposal.sequence < request.sequence)) return chainResult("invalid", "projection_chain_owner_gate_order_invalid");
  if (approval && (!canonicalApproval(approval, decision, request) || approval.sequence <= request.sequence)) return chainResult("invalid", "projection_chain_approval_invalid");
  if (attempt && (!canonicalAttempt(attempt, decision, approval) || attempt.sequence <= approval.sequence)) return chainResult("invalid", "projection_chain_attempt_invalid");
  if (execution && (!canonicalExecution(execution, decision, attempt) || execution.sequence <= attempt.sequence)) return chainResult("invalid", "projection_chain_execution_invalid");
  if (verification && (!canonicalVerification(verification, decision, execution, evidence) || verification.sequence <= execution.sequence)) return chainResult("invalid", "projection_chain_verification_invalid");
  return {
    status: "canonical", decision, proposal, request, approval, attempt, execution, verification,
    revision: { status: "canonical", identities: identities.map((key) => chain[key]).filter(Boolean) }
  };
}

export function validateProjectionInvestigation(events) {
  const accepted = last(events, "evaluation.accepted");
  const gate = last(events, "diagnosis.gate.passed");
  const rejected = last(events, "evaluation.rejected");
  const validAccepted = accepted && strictAcceptedEvaluation(accepted) ? accepted : null;
  const validGate = gate && strictDiagnosisGate(gate, validAccepted) ? gate : null;
  return {
    accepted: validAccepted,
    gate: validGate,
    rejected: rejected && safeRejectedEvaluation(rejected) ? rejected : null,
    replan: last(events, "plan.revised") || null
  };
}

function canonicalDecision(event, axes) {
  const payload = event?.payload;
  const required = ["schema_version", "run_id", "incident_id", "intent_id", "environment", "source_health", "evidence_mode", "execution_mode", "contract", "contract_sha256", "snapshot", "receipt_sha256", "authority_context_sha256", "artifact", "authority_evidence", "outcome", "reason_code", "capture_observed_at", "decision_sha256", "decision_id"];
  return canonicalHeader(event, "autonomy.decision.recorded", "authority-composition") && event.parent_id === null && event.correlation_id === event.id && exactKeys(payload, required)
    && payload.schema_version === "flowpulse.autonomy.v1" && payload.run_id === event.run_id && payload.incident_id === event.incident_id
    && id(payload.intent_id) && text(payload.environment, 80) && payload.outcome === "human_review_required" && payload.reason_code === "owner_gate_required"
    && payload.source_health === axes.source_health && payload.evidence_mode === axes.evidence_mode && payload.execution_mode === axes.execution_mode
    && fullContract(payload.contract) && payload.contract_sha256 === sha256Canonical(payload.contract) && isHash(payload.receipt_sha256)
    && isHash(payload.authority_context_sha256) && isHash(payload.decision_sha256) && event.id === `autonomy-decision-${payload.decision_sha256.slice(0, 32)}` && payload.decision_id === event.id
    && timestamp(payload.capture_observed_at) && artifactBinding(payload.artifact) && snapshotBinding(payload.snapshot) && authorityEvidence(payload.authority_evidence, event.evidence_refs);
}

function canonicalProposal(event, decision) {
  const expected = { ...decision.payload.contract, bounded: true, decision_id: decision.id, contract_sha256: decision.payload.contract_sha256 };
  return canonicalHeader(event, "repair.proposed", "authority-composition") && event.parent_id === null && event.correlation_id === decision.id
    && sameOrdered(event.evidence_refs, decision.evidence_refs) && exactCanonicalPayload(event.payload, expected);
}

function canonicalRequest(event, decision, proposal) {
  const expected = {
    ...decision.payload.contract,
    owner_team: "local-development",
    decision_id: decision.id,
    contract_sha256: decision.payload.contract_sha256,
    reason: "Consequential checkout remediation requires an explicit owner decision."
  };
  return canonicalHeader(event, "approval.requested", "authority-composition") && event.parent_id === proposal.id && event.correlation_id === decision.id
    && sameOrdered(event.evidence_refs, decision.evidence_refs) && exactCanonicalPayload(event.payload, expected);
}

function canonicalApproval(event, decision, request) {
  const expectedId = `approval-granted-${decision.payload.decision_sha256.slice(0, 32)}`;
  const payload = event?.payload;
  return canonicalHeader(event, "approval.granted", "owner") && event.id === expectedId && event.parent_id === null && event.correlation_id === decision.id
    && sameOrdered(event.evidence_refs, decision.evidence_refs) && exactKeys(payload, ["owner", "repair_id", "action", "target", "command_id", "expected_before", "expected_after", "scope", "decision_id", "contract_sha256"])
    && text(payload.owner, 160) && fullContractPart(payload) && sameContract(payload, decision.payload.contract) && payload.scope === "local checkout container only"
    && payload.decision_id === decision.id && payload.contract_sha256 === decision.payload.contract_sha256 && request.sequence < event.sequence;
}

function canonicalAttempt(event, decision, approval) {
  const expectedId = `repair-execution-attempt-${decision.payload.decision_sha256.slice(0, 32)}`;
  const expected = { approval_id: approval.id, decision_id: decision.id, contract_sha256: decision.payload.contract_sha256, contract: decision.payload.contract, execution_mode: decision.payload.execution_mode };
  return canonicalHeader(event, "repair.execution.attempted", "authority-composition") && event.id === expectedId && event.parent_id === approval.id && event.correlation_id === decision.id
    && sameOrdered(event.evidence_refs, decision.evidence_refs) && exactCanonicalPayload(event.payload, expected);
}

function canonicalExecution(event, decision, attempt) {
  const expectedId = `repair-executed-${decision.payload.decision_sha256.slice(0, 32)}`;
  const payload = event?.payload;
  const expectedBefore = valueAfterEquals(decision.payload.contract.expected_before);
  const expectedAfter = valueAfterEquals(decision.payload.contract.expected_after);
  return canonicalHeader(event, "repair.executed", "remediation") && event.id === expectedId && event.parent_id === attempt.id && event.correlation_id === decision.id
    && sameOrdered(event.evidence_refs, decision.evidence_refs) && exactKeys(payload, ["repair_id", "action", "target", "from", "to", "mode", "command_id", "completed_at", "decision_id", "approval_id", "contract_sha256"])
    && payload.repair_id === decision.payload.contract.repair_id && payload.action === decision.payload.contract.action && payload.target === decision.payload.contract.target
    && payload.from === expectedBefore && payload.to === expectedAfter && payload.mode === "local-development" && payload.command_id === decision.payload.contract.command_id
    && timestamp(payload.completed_at) && payload.decision_id === decision.id && payload.approval_id === attempt.payload.approval_id && payload.contract_sha256 === decision.payload.contract_sha256;
}

function canonicalVerification(event, decision, execution, evidence) {
  const payload = event?.payload;
  const repairAt = Date.parse(execution?.payload?.completed_at || "");
  const expectedGood = valueAfterEquals(decision.payload.contract.expected_after);
  const recoveryRefs = event?.evidence_refs?.slice(decision.evidence_refs.length) || [];
  if (!canonicalHeader(event, "verification.completed", "verifier") || event.parent_id !== execution.id || event.correlation_id !== decision.id
    || !exactKeys(payload, ["schema_version", "decision_id", "execution_id", "contract_sha256", "passed", "repair_completed_at", "source_status", "flag_observed_at", "checks"])
    || payload.schema_version !== "flowpulse.canonical-verification.v1" || payload.decision_id !== decision.id || payload.execution_id !== execution.id
    || payload.contract_sha256 !== decision.payload.contract_sha256 || payload.passed !== true || payload.repair_completed_at !== execution.payload.completed_at
    || payload.source_status !== "live" || !timestamp(payload.flag_observed_at) || Date.parse(payload.flag_observed_at) <= repairAt
    || !sameOrdered(event.evidence_refs.slice(0, decision.evidence_refs.length), decision.evidence_refs) || recoveryRefs.length === 0
    || new Set(event.evidence_refs).size !== event.evidence_refs.length || !strictRecoveryChecks(payload.checks, expectedGood)) return false;
  for (const ref of recoveryRefs) {
    const record = evidence?.get?.(ref);
    if (!record || Date.parse(record.at || "") <= repairAt) return false;
    const observedAt = record?.value?.trace?.observed_at;
    if (observedAt && Date.parse(observedAt) <= repairAt) return false;
  }
  return true;
}

function strictAcceptedEvaluation(event) {
  const payload = event?.payload;
  return canonicalHeader(event, "evaluation.accepted", "evaluator")
    && event.parent_id === null && event.correlation_id === `${event.run_id}:evaluation.accepted`
    && exactKeys(payload, ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs", "hypothesis_id"])
    && payload.accepted === true && payload.classification === "confirmed_system_bug" && payload.phase === "diagnosis_pre_approval" && Number.isFinite(payload.score)
    && text(payload.reason, 2048) && id(payload.hypothesis_id) && Array.isArray(payload.missing_evidence) && payload.missing_evidence.length === 0
    && exactBooleanMap(payload.gate_checks, GATE_CHECKS) && sameOrdered(payload.counter_evidence_refs, event.evidence_refs);
}

function strictDiagnosisGate(event, accepted) {
  const payload = event?.payload;
  if (!accepted || !canonicalHeader(event, "diagnosis.gate.passed", "runtime")
    || event.parent_id !== null || event.correlation_id !== `${event.run_id}:diagnosis.gate.passed`
    || !exactKeys(payload, ["version", "harness", "snapshot", "accepted", "rejected", "repair_contract", "candidate_sha256"])
    || !text(payload.version, 120) || !harnessBinding(payload.harness) || !snapshotSeed(payload.snapshot) || !fullCoreContract(payload.repair_contract) || !isHash(payload.candidate_sha256)
    || !plain(payload.accepted) || !exactKeys(payload.accepted, ["diagnosis", "evaluation", "evidence_ids", "evidence_bindings"])) return false;
  const diagnosis = payload.accepted.diagnosis;
  const evaluation = payload.accepted.evaluation;
  const refs = payload.accepted.evidence_ids;
  if (!strictDiagnosis(diagnosis) || !strictGateEvaluation(evaluation) || diagnosis.id !== accepted.payload.hypothesis_id
    || !sameOrdered(diagnosis.evidence_refs, refs)
    || !sameOrdered(refs, event.evidence_refs) || !sameOrdered(refs, accepted.evidence_refs) || !sameOrdered(evaluation.counter_evidence_refs, refs)
    || !sameAcceptedEvaluation(accepted.payload, evaluation) || !Array.isArray(payload.accepted.evidence_bindings)
    || payload.accepted.evidence_bindings.length !== refs.length || new Set(refs).size !== refs.length) return false;
  const bindingIds = payload.accepted.evidence_bindings.map((binding) => binding?.id);
  return sameOrdered(bindingIds, [...refs].sort())
    && payload.accepted.evidence_bindings.every((binding) => strictEvidenceBinding(binding, binding?.id) && refs.includes(binding.id));
}

function safeRejectedEvaluation(event) {
  const payload = event?.payload;
  return canonicalHeader(event, "evaluation.rejected", "evaluator") && plain(payload) && id(payload.hypothesis_id) && Number.isFinite(payload.score)
    && text(payload.reason, 2048) && Array.isArray(event.evidence_refs);
}

function strictDiagnosis(value) {
  return plain(value) && exactKeys(value, ["id", "title", "confidence", "claim", "initiating_change", "failure_mechanism", "propagation", "evidence_refs", "proposed_repair"])
    && id(value.id) && text(value.title, 512) && Number.isFinite(value.confidence) && text(value.claim, 4096) && text(value.initiating_change, 1024)
    && text(value.failure_mechanism, 2048) && Array.isArray(value.propagation) && value.propagation.length <= 32 && Array.isArray(value.evidence_refs)
    && fullCoreContract(value.proposed_repair, true);
}

function strictGateEvaluation(value) {
  return plain(value) && exactKeys(value, ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs"])
    && value.accepted === true && value.classification === "confirmed_system_bug" && value.phase === "diagnosis_pre_approval"
    && Number.isFinite(value.score) && text(value.reason, 2048) && Array.isArray(value.missing_evidence) && value.missing_evidence.length === 0
    && exactBooleanMap(value.gate_checks, GATE_CHECKS) && Array.isArray(value.counter_evidence_refs);
}

function strictEvidenceBinding(binding, idValue) {
  return plain(binding) && exactKeys(binding, ["id", "sha256", "record"]) && binding.id === idValue && isHash(binding.sha256)
    && plain(binding.record) && hashBoundEvidence(binding.record) === binding.sha256;
}

function strictAuthorityEvidence(value, refs, gate, evidence, snapshotMode) {
  if (!authorityEvidence(value, refs) || !gate?.payload?.accepted?.evidence_bindings || !sameOrdered(value.refs.map((item) => item.id), refs)) return false;
  const bindings = new Map(gate.payload.accepted.evidence_bindings.map((binding) => [binding.id, binding]));
  return value.refs.every((ref) => {
    const binding = bindings.get(ref.id);
    const record = evidence?.get?.(ref.id);
    const recordHash = record?.provenance?.sha256 || record?.hash;
    return binding && binding.sha256 === ref.sha256 && record && record.id === ref.id
      && recordHash === ref.record_sha256 && record.source === ref.source
      && ref.mode === snapshotMode && hashBoundEvidence(record) === ref.sha256;
  });
}

function strictRecoveryChecks(checks, expectedGood) {
  if (!Array.isArray(checks) || checks.length !== RECOVERY_CHECKS.length || checks.some((item, index) => item?.id !== RECOVERY_CHECKS[index] || !plain(item))) return false;
  const [flag, healthy, failures] = checks;
  return exactKeys(flag, ["id", "metric", "observed", "expected", "threshold", "passed"]) && flag.metric.endsWith("_variant") && flag.observed === expectedGood && flag.expected === expectedGood && flag.threshold === `== ${expectedGood}` && flag.passed === true
    && exactKeys(healthy, ["id", "metric", "observed", "threshold", "passed"]) && healthy.metric === "fresh_healthy_checkout_payment_traces" && Number.isInteger(healthy.observed) && healthy.observed >= 1 && healthy.threshold === ">= 1" && healthy.passed === true
    && exactKeys(failures, ["id", "metric", "observed", "threshold", "passed"]) && failures.metric === "fresh_checkout_payment_unreachable_traces" && failures.observed === 0 && failures.threshold === "== 0" && failures.passed === true;
}

function authorityEvidence(value, refs) {
  return plain(value) && exactKeys(value, ["evaluator", "diagnosis_gate", "refs"])
    && authorityEventIdentity(value.evaluator) && authorityEventIdentity(value.diagnosis_gate) && Array.isArray(value.refs)
    && value.refs.length === refs.length && value.refs.every((item, index) => plain(item) && item.id === refs[index] && isHash(item.sha256) && isHash(item.record_sha256) && text(item.source, 240) && text(item.mode, 120));
}
function artifactBinding(value) { return plain(value) && exactKeys(value, ["schema_version", "version", "registry_sha256", "intent_sha256", "envelope_sha256", "artifact_sha256"]) && text(value.schema_version, 120) && text(value.version, 80) && [value.registry_sha256, value.intent_sha256, value.envelope_sha256, value.artifact_sha256].every(isHash); }
function snapshotBinding(value) { return plain(value) && exactKeys(value, ["id", "content_sha256", "mode", "records", "manifest_sha256"]) && id(value.id) && isHash(value.content_sha256) && text(value.mode, 120) && Array.isArray(value.records) && isHash(value.manifest_sha256); }
function snapshotSeed(value) { return plain(value) && exactKeys(value, ["id", "mode", "content_sha256", "source_sha256"]) && id(value.id) && text(value.mode, 120) && isHash(value.content_sha256) && isHash(value.source_sha256); }
function harnessBinding(value) {
  return plain(value) && exactKeys(value, ["version", "manifest_sha256", "model", "skills", "protocols"])
    && text(value.version, 120) && isHash(value.manifest_sha256)
    && plain(value.model) && exactKeys(value.model, ["id", "reasoning_effort", "store"])
    && text(value.model.id, 120) && text(value.model.reasoning_effort, 80) && typeof value.model.store === "boolean"
    && plain(value.skills) && exactKeys(value.skills, ["investigator", "evaluator"])
    && skillBinding(value.skills.investigator) && skillBinding(value.skills.evaluator)
    && plain(value.protocols) && exactKeys(value.protocols, ["sha256", "tool_protocol_sha256", "investigator_evaluator_handoff_sha256", "owner_repair_sha256", "safe_failure_sha256"])
    && Object.values(value.protocols).every(isHash);
}
function skillBinding(value) { return plain(value) && exactKeys(value, ["id", "version", "sha256"]) && text(value.id, 160) && text(value.version, 80) && isHash(value.sha256); }
function fullContract(value) { return plain(value) && exactKeys(value, ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"]) && Object.values(value).every((item) => text(item, 512)); }
function fullContractPart(value) { return plain(value) && ["repair_id", "action", "command_id", "target", "expected_before", "expected_after"].every((key) => text(value[key], 512)); }
function fullCoreContract(value, allowReason = false) { const keys = allowReason ? ["repair_id", "action", "command_id", "target", "reason"] : ["repair_id", "action", "command_id", "target"]; return plain(value) && exactKeys(value, keys) && keys.every((key) => text(value[key], 2048)); }
function sameCoreContract(left, full) { return plain(left) && plain(full) && left.repair_id === full.repair_id && left.action === full.action && left.command_id === full.command_id && left.target === full.target; }
function sameContract(left, right) { return sha256Canonical({ repair_id: left.repair_id, action: left.action, command_id: left.command_id, target: left.target, expected_before: left.expected_before, expected_after: left.expected_after }) === sha256Canonical(right); }
function sameAcceptedEvaluation(accepted, gate) { return sha256Canonical({ accepted: accepted.accepted, score: accepted.score, classification: accepted.classification, phase: accepted.phase, gate_checks: accepted.gate_checks, reason: accepted.reason, missing_evidence: accepted.missing_evidence, counter_evidence_refs: accepted.counter_evidence_refs }) === sha256Canonical(gate); }
function canonicalHeader(event, type, actor) { return Boolean(event && event.type === type && event.actor === actor && id(event.id) && id(event.run_id) && id(event.incident_id) && timestamp(event.recorded_at) && Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isSafeInteger(event.offset_ms) && event.offset_ms === 0 && Array.isArray(event.evidence_refs) && event.evidence_refs.every(id) && new Set(event.evidence_refs).size === event.evidence_refs.length); }
function identityMatches(event, identity) { return eventIdentity(identity) && event?.id === identity.event_id && event.sequence === identity.sequence && (event.payload_sha256 || sha256Canonical(event.payload)) === identity.payload_sha256; }
function eventIdentity(value) { return plain(value) && exactKeys(value, ["event_id", "sequence", "payload_sha256"]) && id(value.event_id) && Number.isSafeInteger(value.sequence) && value.sequence > 0 && isHash(value.payload_sha256); }
function authorityEventIdentity(value) { return plain(value) && exactKeys(value, ["id", "sequence", "payload_sha256"]) && id(value.id) && Number.isSafeInteger(value.sequence) && value.sequence > 0 && isHash(value.payload_sha256); }
function authorityIdentityMatches(event, identity) { return authorityEventIdentity(identity) && event?.id === identity.id && event.sequence === identity.sequence && (event.payload_sha256 || sha256Canonical(event.payload)) === identity.payload_sha256; }
function eventFor(events, identity) { return identity && events.find((event) => event.id === identity.event_id) || null; }
function exactCanonicalPayload(value, expected) { return plain(value) && sha256Canonical(value) === sha256Canonical(expected); }
function exactBooleanMap(value, keys) { return plain(value) && exactKeys(value, keys) && keys.every((key) => value[key] === true); }
function exactKeys(value, keys) { if (!plain(value)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sameOrdered(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }
function valueAfterEquals(value) { return typeof value === "string" && value.includes("=") ? value.slice(value.indexOf("=") + 1) : null; }
function last(events, type) { return [...events].reverse().find((event) => event.type === type) || null; }
function chainResult(status, reason = null) { return { status, reason, revision: reason ? { status, reason } : { status } }; }
function id(value) { return typeof value === "string" && ID.test(value) && Buffer.byteLength(value, "utf8") <= 200; }
function text(value, limit) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= limit; }
function timestamp(value) { return text(value, 40) && Number.isFinite(Date.parse(value)); }
function isHash(value) { return typeof value === "string" && HASH.test(value); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function safeText(value, limit) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>&"']/g, " ").slice(0, limit) : "legacy_detail_unavailable"; }

import assert from "node:assert/strict";
import test from "node:test";
import { LiveOtlpEvidenceSource } from "../src/evidence-source.mjs";
import { EVALUATOR_INSTRUCTIONS, INVESTIGATOR_INSTRUCTIONS, CausalEvidenceError, validateDiagnosisCandidate, validateDiagnosisOutput, validateEvaluation, validateEvaluationOutput, validatePropagationClaims } from "../src/openai.mjs";
import { ModelOutputInvalidError } from "../src/openai-response.mjs";

test("investigator and evaluator use the phase-correct pre-approval contract", () => {
  assert.match(INVESTIGATOR_INSTRUCTIONS, /pre-approval Diagnosis Gate/);
  assert.match(INVESTIGATOR_INSTRUCTIONS, /Do not require or claim post-repair recovery/);
  assert.match(EVALUATOR_INSTRUCTIONS, /Do not require post-repair recovery/);
  assert.match(EVALUATOR_INSTRUCTIONS, /only when the candidate marks that propagation claim proven/);
  assert.doesNotMatch(EVALUATOR_INSTRUCTIONS, /recovery evidence is required/i);
});

test("propagation is optional when unproven and requires direct evidence when proven", () => {
  const kafka = evidence("kafka-metric", "kafka", "metric", "Kafka consumer lag increased.");
  const checkout = evidence("checkout-trace", "checkout", "trace", "Checkout payment resolver failed.");
  const source = new LiveOtlpEvidenceSource({ status: "live", evidence: [checkout, kafka] }).freeze({ executable: false });
  const base = { evidence_refs: [checkout.id], proposed_repair: { action: "no_execution", target: "checkout" } };
  assert.doesNotThrow(() => validateDiagnosisCandidate({ ...base, propagation: [] }, source));
  assert.doesNotThrow(() => validatePropagationClaims({ ...base, propagation: [{ entity: "kafka", status: "unproven", claim: "Kafka impact is not established.", evidence_refs: [] }] }, source));
  assert.throws(() => validatePropagationClaims({ ...base, propagation: [{ entity: "kafka", status: "proven", claim: "Kafka lag increased.", evidence_refs: [] }] }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "direct_propagation_evidence_missing");
  assert.throws(() => validatePropagationClaims({ ...base, propagation: [{ entity: "kafka", status: "proven", claim: "Kafka lag increased.", evidence_refs: [checkout.id] }] }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "direct_propagation_evidence_missing");
  assert.doesNotThrow(() => validatePropagationClaims({ evidence_refs: [checkout.id, kafka.id], propagation: [{ entity: "kafka", status: "proven", claim: "Kafka lag increased.", evidence_refs: [kafka.id] }] }, source));
  assert.throws(() => validatePropagationClaims({
    evidence_refs: [checkout.id, kafka.id],
    propagation: [{
      entity: "kafka",
      status: "proven",
      claim: "Kafka lag increased and accounting was delayed.",
      evidence_refs: [kafka.id]
    }]
  }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "cross_entity_propagation_claim");
  assert.throws(() => validatePropagationClaims({
    evidence_refs: [checkout.id, kafka.id],
    propagation: [{
      entity: "kafka",
      status: "proven",
      claim: "Kafka was unavailable.",
      evidence_refs: [kafka.id]
    }]
  }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "direct_propagation_evidence_missing");
  const genericKafka = evidence("kafka-generic", "kafka", "metric", "Kafka service observed.", "process.uptime");
  const genericSource = new LiveOtlpEvidenceSource({ status: "live", evidence: [checkout, genericKafka] }).freeze({ executable: false });
  assert.throws(() => validatePropagationClaims({ evidence_refs: [checkout.id, genericKafka.id], propagation: [{ entity: "kafka", status: "proven", claim: "Kafka lag increased.", evidence_refs: [genericKafka.id] }] }, genericSource), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "direct_propagation_evidence_missing");
});

test("an accepted evaluator verdict must encode every Diagnosis Gate check", () => {
  const source = { has: () => true };
  assert.throws(() => validateEvaluation({ accepted: true, phase: "diagnosis_pre_approval", gate_checks: {}, counter_evidence_refs: [] }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "diagnosis_gate_check_missing");
  assert.doesNotThrow(() => validateEvaluation({
    accepted: true,
    classification: "confirmed_system_bug",
    phase: "diagnosis_pre_approval",
    gate_checks: {
      initiating_change: true,
      temporal_order: true,
      implementation_semantics: true,
      controlled_off_on_contrast: true,
      repeated_direct_failures: true
    },
    counter_evidence_refs: []
  }, source));
  assert.throws(() => validateEvaluation({
    accepted: true,
    classification: "insufficient_evidence",
    phase: "diagnosis_pre_approval",
    gate_checks: {
      initiating_change: true,
      temporal_order: true,
      implementation_semantics: true,
      controlled_off_on_contrast: true,
      repeated_direct_failures: true
    },
    counter_evidence_refs: []
  }, source), (error) => error instanceof CausalEvidenceError && error.metadata.reason_code === "accepted_classification_mismatch");
});

test("runtime diagnosis and evaluator schemas reject structural output before semantic authority", () => {
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout" };
  const validDiagnosis = {
    id: "hypothesis-1", title: "Checkout payment endpoint is unreachable", claim: "The flag changes the checkout payment resolver.", confidence: 0.9,
    initiating_change: "paymentUnreachable changed off to on", failure_mechanism: "checkout cannot resolve payment", propagation: [], evidence_refs: ["ev-change", "ev-trace"],
    proposed_repair: { ...contract, reason: "Restore the checked-in known-good variant." }
  };
  const validEvaluation = {
    accepted: true, score: 0.95, classification: "confirmed_system_bug", phase: "diagnosis_pre_approval",
    gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
    reason: "The exact bounded causal gate is satisfied.", missing_evidence: [], counter_evidence_refs: []
  };
  assert.doesNotThrow(() => validateDiagnosisOutput(validDiagnosis, contract));
  assert.doesNotThrow(() => validateEvaluationOutput(validEvaluation));
  assert.throws(() => validateDiagnosisOutput({ ...validDiagnosis, extra: true }, contract), ModelOutputInvalidError);
  assert.throws(() => validateDiagnosisOutput({ ...validDiagnosis, confidence: "0.9" }, contract), ModelOutputInvalidError);
  assert.throws(() => validateDiagnosisOutput({ ...validDiagnosis, evidence_refs: ["ev-change", "ev-change"] }, contract), ModelOutputInvalidError);
  assert.throws(() => validateDiagnosisOutput({ ...validDiagnosis, propagation: [{ entity: "kafka", status: "unproven", claim: "not proven", evidence_refs: [], extra: true }] }, contract), ModelOutputInvalidError);
  assert.throws(() => validateDiagnosisOutput({ ...validDiagnosis, proposed_repair: { ...validDiagnosis.proposed_repair, extra: true } }, contract), ModelOutputInvalidError);
  assert.throws(() => validateEvaluationOutput({ ...validEvaluation, gate_checks: { initiating_change: true } }), ModelOutputInvalidError);
  assert.throws(() => validateEvaluationOutput({ ...validEvaluation, accepted: "true" }), ModelOutputInvalidError);
  const source = { list: () => ({ items: [{ id: "ev-change" }, { id: "ev-trace" }] }), has: (id) => id === "ev-change" || id === "ev-trace" };
  assert.throws(() => validateDiagnosisCandidate({ ...validDiagnosis, proposed_repair: { ...validDiagnosis.proposed_repair, command_id: "unapproved" } }, source, contract), (error) => error instanceof CausalEvidenceError && error.classification === "agent_false_positive");
  assert.throws(() => validateDiagnosisCandidate({ ...validDiagnosis, evidence_refs: ["unknown"] }, source, contract), (error) => error instanceof CausalEvidenceError && error.classification === "agent_false_positive");
});

function evidence(id, entity, kind, fact, metricName = "kafka.consumer.lag") {
  return {
    id,
    kind,
    signal: `${kind}s`,
    title: fact,
    fact,
    entity,
    source: "test",
    at: "2026-07-18T10:00:00.000Z",
    captured_at: "2026-07-18T10:00:00.000Z",
    value: { services: [entity], metric: kind === "metric" ? { name: metricName, value: 10 } : null },
    hash: id.padEnd(64, "0").slice(0, 64),
    provenance: { sha256: id.padEnd(64, "0").slice(0, 64), immutable_capture: true }
  };
}

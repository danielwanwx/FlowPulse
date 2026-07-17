import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTeamHarness, AGENT_SCHEMA_VERSION, ROLE_MANIFESTS, sealAgentProposal } from "../src/agent-team-harness.mjs";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

const CREATED_AT = "2026-07-16T15:42:30.000Z";
const DEADLINE_AT = "2026-07-16T15:47:30.000Z";

function setup() {
  const bundle = loadBundle();
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-agent-team-")), "ledger.db")),
    bundle
  });
  return { bundle, runtime, harness: new AgentTeamHarness({ runtime }), runId: runtime.startRun() };
}

function proposal({ bundle, runId, agentId, eventType, payloadType, payload, evidenceRefs = [], id = eventType }) {
  return sealAgentProposal({
    schema_version: AGENT_SCHEMA_VERSION,
    message_id: `msg-${id}`,
    idempotency_key: `idem-${id}`,
    incident_id: bundle.incident.id,
    run_id: runId,
    agent_id: agentId,
    agent_version: "p0-recorded-v1",
    prompt_hash: "sha256:recorded-judge-artifact",
    model: "recorded-fixture",
    created_at: CREATED_AT,
    parent_event_ids: [],
    evidence_refs: evidenceRefs,
    budget: {
      tool_calls_remaining: 8,
      turns_remaining: 2,
      tokens_remaining: 1800,
      deadline_at: DEADLINE_AT
    },
    event_type: eventType,
    payload_type: payloadType,
    payload
  });
}

test("recorded judge artifacts cross isolated proposal boundaries and preserve the owner gate", () => {
  const { bundle, runtime, harness, runId } = setup();
  const symptoms = ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"];
  const counterEvidence = ["ev-metric-kafka-healthy", "ev-timing-error-before-lag"];
  const causalEvidence = ["ev-deploy-checkout", "ev-trace-payment-refused", "ev-log-endpoint-fallback", "ev-commit-checkout"];

  const recorded = [
    proposal({ bundle, runId, agentId: "evidence", eventType: "evidence.requested", payloadType: "EvidencePlan", payload: { queries: ["query_symptoms"] }, id: "symptom-plan" }),
    proposal({ bundle, runId, agentId: "evidence", eventType: "evidence.manifest.proposed", payloadType: "EvidenceManifest", payload: { evidence_ids: symptoms }, evidenceRefs: symptoms, id: "symptom-manifest" }),
    proposal({ bundle, runId, agentId: "diagnosis", eventType: "diagnosis.proposed", payloadType: "DiagnosisCandidate", payload: { id: "hyp-kafka", title: "Kafka broker degradation initiated the incident", claim: "Growing consumer lag delayed accounting and fraud processing.", confidence: 0.72 }, evidenceRefs: symptoms.slice(1), id: "wrong-diagnosis" }),
    proposal({ bundle, runId, agentId: "adversarial_evaluator", eventType: "evaluation.rejected", payloadType: "EvaluationVerdict", payload: { hypothesis_id: "hyp-kafka", accepted: false, score: 0.22, reason: "Kafka lag is downstream; payment failures lead it by 171 seconds." }, evidenceRefs: counterEvidence, id: "reject-kafka" }),
    proposal({ bundle, runId, agentId: "evidence", eventType: "evidence.requested", payloadType: "EvidencePlan", payload: { queries: ["query_deploys", "query_traces", "query_logs", "query_commits"] }, id: "causal-plan" }),
    proposal({ bundle, runId, agentId: "evidence", eventType: "evidence.manifest.proposed", payloadType: "EvidenceManifest", payload: { evidence_ids: causalEvidence }, evidenceRefs: causalEvidence, id: "causal-manifest" }),
    proposal({ bundle, runId, agentId: "diagnosis", eventType: "diagnosis.proposed", payloadType: "DiagnosisCandidate", payload: { id: "hyp-checkout-config", title: "Checkout deployment selected an unreachable payment endpoint", claim: "checkout:2.18.0 fell back to payment:9090 after commit c7e1b9a renamed the payment environment key.", confidence: 0.96 }, evidenceRefs: causalEvidence, id: "root-diagnosis" }),
    proposal({ bundle, runId, agentId: "adversarial_evaluator", eventType: "evaluation.accepted", payloadType: "EvaluationVerdict", payload: { hypothesis_id: "hyp-checkout-config", accepted: true, score: 0.94, reason: "Change, mechanism, timing, and propagation are cited." }, evidenceRefs: causalEvidence, id: "accept-root" }),
    proposal({ bundle, runId, agentId: "remediation_planner", eventType: "repair.proposed", payloadType: "RemediationProposal", payload: { ...bundle.repair, bounded: true }, evidenceRefs: ["ev-deploy-checkout", "ev-commit-checkout"], id: "repair" })
  ];

  const appended = recorded.map((envelope) => harness.propose(envelope));
  runtime.append(runId, "approval.requested", "runtime", {
    repair_id: bundle.repair.id,
    owner_team: "commerce",
    reason: "Deployment rollback is consequential and requires owner approval."
  });

  const state = runtime.state(runId);
  assert.equal(state.waiting_for_approval, true);
  assert.equal(state.events.some((event) => event.type === "repair.executed"), false);
  assert.deepEqual(appended.map((event) => event.type), recorded.map((item) => item.event_type));
  assert.equal(appended.find((event) => event.type === "evaluation.rejected").payload.hypothesis_id, "hyp-kafka");
  assert.deepEqual(appended.find((event) => event.type === "repair.proposed").payload.verification_evidence, bundle.repair.verification_evidence);
  assert.equal(appended.every((event) => event.actor.startsWith("agent:") && event.payload._agent_proposal), true);

  const overBudget = proposal({
    bundle,
    runId,
    agentId: "diagnosis",
    eventType: "diagnosis.proposed",
    payloadType: "DiagnosisCandidate",
    payload: { id: "hyp-third", title: "Third candidate", claim: "Must not append", confidence: 0.1 },
    evidenceRefs: causalEvidence,
    id: "third-diagnosis"
  });
  assert.throws(() => harness.propose(overBudget), /diagnosis proposal budget exhausted/);
});

test("permissions isolate evaluator from remediation and Evolve from Test", () => {
  const { bundle, harness, runId } = setup();
  const evaluatorRepair = proposal({
    bundle,
    runId,
    agentId: "adversarial_evaluator",
    eventType: "repair.proposed",
    payloadType: "RemediationProposal",
    payload: { ...bundle.repair, bounded: true },
    id: "evaluator-repair"
  });
  const evolveBacktest = proposal({
    bundle,
    runId,
    agentId: "evolve",
    eventType: "backtest.completed",
    payloadType: "BacktestReport",
    payload: { candidate_id: "policy-v2", passed: true, gates: [] },
    id: "evolve-backtest"
  });
  const testCandidate = proposal({
    bundle,
    runId,
    agentId: "test",
    eventType: "policy.candidate.proposed",
    payloadType: "PolicyCandidate",
    payload: { id: "policy-v2" },
    id: "test-candidate"
  });

  assert.throws(() => harness.propose(evaluatorRepair), /adversarial_evaluator cannot emit repair\.proposed/);
  assert.throws(() => harness.propose(evolveBacktest), /evolve cannot emit backtest\.completed/);
  assert.throws(() => harness.propose(testCandidate), /test cannot emit policy\.candidate\.proposed/);
  assert.equal(Object.isFrozen(ROLE_MANIFESTS.evolve.tools), true);
  assert.equal(ROLE_MANIFESTS.test.tools.includes("write_quarantine_candidate"), false);
  assert.equal("runtime" in harness, false);
  assert.equal("ledger" in harness, false);
});

test("unknown evidence, exhausted envelopes, and illegal transitions fail before append", () => {
  const { bundle, runtime, harness, runId } = setup();
  const before = runtime.ledger.list(runId).length;
  const unknownEvidence = proposal({
    bundle,
    runId,
    agentId: "diagnosis",
    eventType: "diagnosis.proposed",
    payloadType: "DiagnosisCandidate",
    payload: { id: "hyp-unknown", title: "Unknown", claim: "Unsupported", confidence: 0.2 },
    evidenceRefs: ["ev-does-not-exist"],
    id: "unknown-evidence"
  });
  const missingManifest = proposal({
    bundle,
    runId,
    agentId: "diagnosis",
    eventType: "diagnosis.proposed",
    payloadType: "DiagnosisCandidate",
    payload: { id: "hyp-too-early", title: "Too early", claim: "No manifest", confidence: 0.2 },
    id: "missing-manifest"
  });
  const exhausted = sealAgentProposal({
    ...proposal({ bundle, runId, agentId: "evidence", eventType: "evidence.requested", payloadType: "EvidencePlan", payload: { queries: ["query_metrics"] }, id: "exhausted" }),
    budget: { tool_calls_remaining: 0, turns_remaining: 0, tokens_remaining: 0, deadline_at: DEADLINE_AT }
  });

  assert.throws(() => harness.propose(unknownEvidence), /unknown evidence/);
  assert.throws(() => harness.propose(missingManifest), /requires evidence\.manifest\.proposed/);
  assert.throws(() => harness.propose(exhausted), /budget exhausted/);
  assert.equal(runtime.ledger.list(runId).length, before);
});

test("duplicate proposals are idempotent and key collisions fail closed", () => {
  const { bundle, runtime, harness, runId } = setup();
  const first = proposal({
    bundle,
    runId,
    agentId: "evidence",
    eventType: "evidence.requested",
    payloadType: "EvidencePlan",
    payload: { queries: ["query_metrics"] },
    id: "idempotent-plan"
  });

  const accepted = harness.propose(first);
  const retried = harness.propose(first);
  const collision = sealAgentProposal({ ...first, payload: { queries: ["query_logs"] } });

  assert.equal(retried.id, accepted.id);
  assert.equal(runtime.ledger.list(runId).filter((event) => event.type === "evidence.requested").length, 1);
  assert.throws(() => harness.propose(collision), /idempotency key collision/);
});

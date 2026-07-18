import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import {
  AUTONOMY_SCHEMA_VERSION,
  AutonomyPolicyError,
  buildAutonomyDecisionEvent,
  deriveAuthorityEvidenceFromLedger,
  buildFailureLockEvent,
  buildPreauthorizationConsumptionEvent,
  canonicalDecisionHash,
  evaluateAutonomyDecision,
  failureLockKey,
  revalidateExecutionAuthority,
  resolvePreauthorization,
  sha256Canonical
} from "../src/autonomy-policy.mjs";

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T14:05:00.000Z";
const HASH = (character) => character.repeat(64);

function contract(overrides = {}) {
  return {
    repair_id: "repair-low-cache-flush-v1",
    command_id: "flowpulse.simulate-cache-flush",
    target: "edge-cache",
    expected_before: "stale",
    expected_after: "fresh",
    ...overrides
  };
}

function envelope(overrides = {}) {
  return {
    schema_version: "flowpulse-preauthorization.v1",
    id: "preauth-edge-cache-v1",
    policy_version: "2026-07-18",
    policy_sha256: `sha256:${HASH("c")}`,
    status: "active",
    issued_by: "authorized-owner",
    issued_at: "2026-07-18T11:00:00.000Z",
    expires_at: "2026-07-18T13:00:00.000Z",
    environment: "captured_demo",
    action_contract: contract(),
    limits: {
      max_components: 1,
      max_attempts: 1,
      require_idempotency: true,
      require_rollback: true,
      require_fresh_verification: true,
      require_notification_receipt: true
    },
    required_verification_check_ids: ["fresh-cache-read"],
    notification_targets: ["owner-demo"],
    ...overrides
  };
}

function registry(overrides = {}) {
  return { schema_version: "flowpulse-preauthorization-registry.v1", envelopes: [envelope()], ...overrides };
}

function authorityContext({ runId = "run-cache-1", incidentId = "inc-cache-1", snapshotHash = null, refs = ["ev-change", "ev-trace"], events = null, manifest = null } = {}) {
  const records = [
    { id: "ev-change", sha256: HASH("c"), source: "captured-ledger", mode: "captured_fixture" },
    { id: "ev-trace", sha256: HASH("d"), source: "captured-otlp", mode: "captured_fixture" }
  ];
  const contentHash = snapshotHash ?? sha256Canonical(records);
  const snapshot = manifest ?? { id: "snapshot-cache-1", content_sha256: contentHash, mode: "deterministic_replay", records };
  const acceptedDiagnosis = { id: "hyp-cache-1", evidence_refs: refs };
  const acceptedEvaluation = {
    accepted: true,
    score: 0.93,
    classification: "confirmed_system_bug",
    phase: "diagnosis_pre_approval",
    gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
    reason: "Independent evaluator accepted the bounded evidence.",
    missing_evidence: [],
    counter_evidence_refs: refs
  };
  const evaluationPayload = { ...acceptedEvaluation, hypothesis_id: "hyp-cache-1" };
  const diagnosisPayload = {
    snapshot: { id: snapshot.id, content_sha256: snapshot.content_sha256, mode: snapshot.mode },
    accepted: { diagnosis: acceptedDiagnosis, evaluation: acceptedEvaluation, evidence_ids: refs }
  };
  return {
    ledger_events: events ?? [
      decodedEvent({ sequence: 3, id: "evaluator-gate-1", runId, incidentId, type: "evaluation.accepted", payload: evaluationPayload, evidenceRefs: refs }),
      decodedEvent({ sequence: 4, id: "diagnosis-gate-1", runId, incidentId, type: "diagnosis.gate.passed", payload: diagnosisPayload, evidenceRefs: refs })
    ],
    snapshot_manifest: snapshot
  };
}

function decodedEvent({ sequence, id, runId, incidentId, type, payload, evidenceRefs }) {
  return {
    sequence,
    id,
    run_id: runId,
    incident_id: incidentId,
    recorded_at: `2026-07-18T12:0${sequence}:00.000Z`,
    offset_ms: 0,
    type,
    actor: "test",
    payload,
    payload_sha256: sha256Canonical(payload),
    evidence_refs: evidenceRefs,
    parent_id: null,
    correlation_id: `corr-${id}`
  };
}

function decodedLockEvent(event, sequence = 9) {
  return decodedEvent({
    sequence,
    id: event.id,
    runId: event.runId,
    incidentId: event.incidentId,
    type: event.type,
    payload: event.payload,
    evidenceRefs: event.evidenceRefs
  });
}

function derivedAuthority(context = authorityContext(), { incidentId = "inc-cache-1", runId = "run-cache-1" } = {}) {
  return deriveAuthorityEvidenceFromLedger({ ...context, incident_id: incidentId, run_id: runId });
}

function input(overrides = {}) {
  const selectedContract = overrides.contract ?? contract();
  return {
    registry: overrides.registry ?? registry(),
    contract: selectedContract,
    environment: "captured_demo",
    incident_id: "inc-cache-1",
    run_id: "run-cache-1",
    snapshot_sha256: authorityContext().snapshot_manifest.content_sha256,
    target: selectedContract.target,
    now: NOW,
    impact: { level: "low" },
    source: { status: "captured_fixture", fresh: true },
    derived_authority: overrides.derived_authority ?? derivedAuthority(),
    advisory: { kb_refs: ["kb-cache-runbook"], model_confidence: 1 },
    action: {
      risk: "low",
      reversible: true,
      idempotent: true,
      blast_radius_components: 1,
      rollback_ready: true,
      verification_ready: true,
      attempt_count: 1
    },
    notification: { status: "recorded_local", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] },
    truth_mode: "captured_simulation",
    failure_lock_events: [],
    ...overrides
  };
}

function expectPolicyError(fn, code) {
  assert.throws(fn, (error) => error instanceof AutonomyPolicyError && error.code === code);
}

test("high impact cannot auto-authorize an otherwise valid candidate", () => {
  const decision = evaluateAutonomyDecision(input({ impact: { level: "sev1" } }));
  assert.notEqual(decision.outcome, "auto_execute_pre_authorized");
  assert.equal(decision.factor_results.find((entry) => entry.id === "impact_low").passed, false);
});

test("authority evidence derives only from decoded ledger gates and frozen snapshot membership", () => {
  const context = authorityContext();
  const derived = deriveAuthorityEvidenceFromLedger({ ...context, incident_id: "inc-cache-1", run_id: "run-cache-1" });
  const decision = evaluateAutonomyDecision(input());
  assert.deepEqual(decision.evidence_refs, ["ev-change", "ev-trace"]);
  assert.equal(derived.deterministic_gate.event_id, "diagnosis-gate-1");
  assert.equal(derived.evaluator_gate.sequence, 3);
  assert.equal(derived.snapshot_manifest_sha256.length, 64);
  expectPolicyError(() => evaluateAutonomyDecision({ ...input(), derived_authority: structuredClone(derived) }), "authority_provenance_unverified");
  expectPolicyError(() => evaluateAutonomyDecision(input({ advisory: { kb_refs: ["ev-change"], model_confidence: 1 } })), "advisory_authority_overlap");
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...authorityContext({ refs: ["ev-change", "unknown-ref"] }), incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_evidence_nonmember");
  const alteredPayload = structuredClone(context);
  alteredPayload.ledger_events[0].payload.reason = "altered after decode";
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...alteredPayload, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_ledger_payload_hash_mismatch");
  const unknownGateSchema = authorityContext();
  unknownGateSchema.ledger_events[0].payload.untrusted_extra = true;
  unknownGateSchema.ledger_events[0].payload_sha256 = sha256Canonical(unknownGateSchema.ledger_events[0].payload);
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...unknownGateSchema, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_evidence_invalid");
  const alteredRecord = authorityContext();
  alteredRecord.snapshot_manifest.records[1].source = "altered-source";
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...alteredRecord, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "snapshot_manifest_content_hash_mismatch");
});

test("only the server-derived authority object can grant captured preauthorization", () => {
  const verified = derivedAuthority();
  assert.equal(evaluateAutonomyDecision(input({ derived_authority: verified })).outcome, "auto_execute_pre_authorized");
  const rawCopy = structuredClone(verified);
  expectPolicyError(() => evaluateAutonomyDecision(input({ derived_authority: rawCopy })), "authority_provenance_unverified");
  const forged = structuredClone(verified);
  forged.deterministic_gate.event_id = "ledger-event-that-does-not-exist";
  forged.deterministic_gate.payload_sha256 = HASH("f");
  expectPolicyError(() => evaluateAutonomyDecision(input({ derived_authority: forged })), "authority_provenance_unverified");
  expectPolicyError(() => evaluateAutonomyDecision(input({ snapshot_sha256: HASH("a"), derived_authority: verified })), "authority_snapshot_mismatch");
});

test("a valid low-impact decision derives authority from decoded immutable ledger rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-authority-ledger-"));
  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  const context = authorityContext();
  for (const event of context.ledger_events) {
    ledger.append({
      id: event.id,
      runId: event.run_id,
      incidentId: event.incident_id,
      recordedAt: event.recorded_at,
      offsetMs: event.offset_ms,
      type: event.type,
      actor: event.actor,
      payload: event.payload,
      evidenceRefs: event.evidence_refs,
      parentId: event.parent_id,
      correlationId: event.correlation_id
    });
  }
  const verified = deriveAuthorityEvidenceFromLedger({
    ledger_events: ledger.list("run-cache-1"),
    snapshot_manifest: context.snapshot_manifest,
    incident_id: "inc-cache-1",
    run_id: "run-cache-1"
  });
  assert.equal(evaluateAutonomyDecision(input({ derived_authority: verified })).outcome, "auto_execute_pre_authorized");
});

test("forged gate strings, cross-scope events, and invalid gate ordering cannot auto-authorize", () => {
  const forged = input();
  const forgedContext = {
    ledger_events: [
      decodedEvent({ sequence: 3, id: "forged-evaluator", runId: "run-cache-1", incidentId: "inc-cache-1", type: "evaluation.accepted", payload: { hypothesis_id: "forged", score: 1, reason: "forged" }, evidenceRefs: ["fabricated"] }),
      decodedEvent({ sequence: 4, id: "forged-diagnosis", runId: "run-cache-1", incidentId: "inc-cache-1", type: "diagnosis.gate.passed", payload: { snapshot: { id: "forged", content_sha256: HASH("a"), mode: "deterministic_replay" }, accepted: { diagnosis: { id: "forged", evidence_refs: ["fabricated"] }, evaluation: { accepted: true, counter_evidence_refs: ["fabricated"] }, evidence_ids: ["fabricated"] } }, evidenceRefs: ["fabricated"] })
    ],
    snapshot_manifest: { id: "forged", content_sha256: HASH("a"), mode: "deterministic_replay", records: [{ id: "fabricated", sha256: HASH("b"), source: "forged", mode: "captured_fixture" }] }
  };
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...forgedContext, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "snapshot_manifest_content_hash_mismatch");
  expectPolicyError(() => evaluateAutonomyDecision({ ...forged, derived_authority: { schema_version: "flowpulse.authority-evidence.v1" } }), "authority_provenance_unverified");

  const wrongRun = authorityContext();
  wrongRun.ledger_events[0].run_id = "other-run";
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...wrongRun, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_ledger_scope_mismatch");
  const wrongIncident = authorityContext();
  wrongIncident.ledger_events[0].incident_id = "other-incident";
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...wrongIncident, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_ledger_scope_mismatch");
  const reversed = authorityContext();
  reversed.ledger_events = [
    { ...reversed.ledger_events[1], sequence: 4 },
    { ...reversed.ledger_events[0], sequence: 5 }
  ];
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...reversed, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_gate_order_invalid");
  const duplicate = authorityContext();
  duplicate.ledger_events.splice(1, 0, decodedEvent({ sequence: 4, id: "evaluator-gate-2", runId: "run-cache-1", incidentId: "inc-cache-1", type: "evaluation.accepted", payload: { hypothesis_id: "hyp-cache-1", score: 0.9, reason: "duplicate" }, evidenceRefs: ["ev-change", "ev-trace"] }));
  duplicate.ledger_events[2].sequence = 5;
  expectPolicyError(() => deriveAuthorityEvidenceFromLedger({ ...duplicate, incident_id: "inc-cache-1", run_id: "run-cache-1" }), "authority_gate_event_conflict");
});

test("exact registry schema rejects renamed authority fields and client selection", () => {
  assert.equal(resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract() }).id, "preauth-edge-cache-v1");
  expectPolicyError(() => resolvePreauthorization({ registry: registry(), environment: "captured_demo", contract: contract(), selected_ref: "forged" }), "client_preauthorization_selection_forbidden");
  const renamed = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [envelope({ notification_target_refs: ["owner-demo"] })] }) }));
  assert.ok(renamed.reason_codes.includes("preauthorization_schema_invalid"));
  const missingIssuer = evaluateAutonomyDecision(input({ registry: registry({ envelopes: [envelope({ issued_by: undefined })] }) }));
  assert.ok(missingIssuer.reason_codes.includes("preauthorization_schema_invalid"));
});

test("every hard gate is conjunctive and a single mutation blocks captured automation", () => {
  const cases = [
    ["impact", { level: "medium" }, "impact_not_low"],
    ["impact", { level: "high" }, "impact_not_low"],
    ["source", { status: "captured_fixture", fresh: false }, "source_stale"],
    ["action", { ...input().action, risk: "medium" }, "action_not_low_risk"],
    ["action", { ...input().action, blast_radius_components: 2 }, "blast_radius_exceeded"],
    ["action", { ...input().action, reversible: false }, "action_not_reversible_idempotent"],
    ["action", { ...input().action, rollback_ready: false }, "rollback_or_verification_not_ready"],
    ["action", { ...input().action, attempt_count: 2 }, "preauthorization_attempt_limit_exceeded"],
    ["notification", { status: "failed", delivery_mode: "captured_simulation", target_refs: ["owner-demo"] }, "local_notification_required"],
    ["registry", registry({ envelopes: [envelope({ status: "revoked" })] }), "preauthorization_revoked"]
  ];
  for (const [field, value, reason] of cases) {
    const decision = evaluateAutonomyDecision(input({ [field]: value }));
    assert.notEqual(decision.outcome, "auto_execute_pre_authorized", `${field}:${reason}`);
    assert.ok(decision.reason_codes.includes(reason), `${field}:${decision.reason_codes.join(",")}`);
  }
  const conflicting = authorityContext();
  conflicting.ledger_events.push(decodedEvent({ sequence: 5, id: "second-diagnosis", runId: "run-cache-1", incidentId: "inc-cache-1", type: "diagnosis.gate.passed", payload: conflicting.ledger_events[1].payload, evidenceRefs: ["ev-change", "ev-trace"] }));
  expectPolicyError(() => derivedAuthority(conflicting), "authority_gate_event_conflict");
});

test("canonical decision and event builders reject any authority-field mutation", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.equal(canonicalDecisionHash(decision), decision.decision_sha256);
  const context = authorityContext();
  const event = buildAutonomyDecisionEvent({ decision, derived_authority: derivedAuthority(context) });
  assert.equal(event.type, "autonomy.decision.recorded");
  const changed = structuredClone(decision);
  changed.contract.expected_after = "wrong";
  expectPolicyError(() => buildAutonomyDecisionEvent({ decision: changed, derived_authority: derivedAuthority(context) }), "decision_contract_hash_mismatch");
  const changedHash = structuredClone(decision);
  changedHash.decision_sha256 = HASH("f");
  expectPolicyError(() => buildAutonomyDecisionEvent({ decision: changedHash, derived_authority: derivedAuthority(context) }), "decision_hash_mismatch");
  for (const [path, mutate] of [
    ["incident", (value) => { value.incident_id = "inc-other"; value.binding.incident_id = "inc-other"; }],
    ["run", (value) => { value.run_id = "run-other"; value.binding.run_id = "run-other"; }],
    ["environment", (value) => { value.environment = "other"; value.binding.environment = "other"; }],
    ["snapshot", (value) => { value.snapshot_sha256 = HASH("b"); value.binding.snapshot_sha256 = HASH("b"); }],
    ["target", (value) => { value.target = "other"; value.binding.target = "other"; }],
    ["policy", (value) => { value.policy_sha256 = `sha256:${HASH("b")}`; }],
    ["envelope", (value) => { value.envelope_sha256 = HASH("b"); }],
    ["authority", (value) => { value.authority_evidence.evaluator_gate.payload_sha256 = HASH("b"); }]
  ]) {
    const mutated = structuredClone(decision);
    mutate(mutated);
    assert.notEqual(canonicalDecisionHash(mutated), decision.decision_sha256, path);
    assert.throws(() => buildAutonomyDecisionEvent({ decision: mutated, derived_authority: derivedAuthority(context) }), AutonomyPolicyError, path);
  }
  assert.deepEqual(event.payload.authority_evidence.evidence_refs, ["ev-change", "ev-trace"]);
  assert.equal(Object.hasOwn(event.payload, "advisory"), false);
});

test("malformed or contradictory incident locks fail closed", () => {
  const valid = evaluateAutonomyDecision(input());
  const malformed = {
    type: "autonomy.locked",
    incident_id: valid.incident_id,
    payload: { incident_id: valid.incident_id, contract_sha256: valid.contract_sha256, target: valid.target, lock_key: "not-a-valid-lock" }
  };
  const decision = evaluateAutonomyDecision(input({ failure_lock_events: [malformed] }));
  assert.equal(decision.outcome, "blocked");
  assert.ok(decision.reason_codes.includes("failure_lock_state_unavailable"));
  const lock = decodedLockEvent(buildFailureLockEvent({ decision: valid, failed_event_ref: "repair-failed-1", reason_code: "verification_failed" }));
  const locked = evaluateAutonomyDecision(input({ failure_lock_events: [lock] }));
  assert.ok(locked.reason_codes.includes("autonomy_failure_locked"));
  assert.equal(failureLockKey({ incident_id: valid.incident_id, contract_sha256: valid.contract_sha256, target: valid.target }), lock.id);
  const headerPayloadMismatch = { ...lock, payload: { ...lock.payload, incident_id: "other-incident" } };
  const mismatched = evaluateAutonomyDecision(input({ failure_lock_events: [headerPayloadMismatch] }));
  assert.ok(mismatched.reason_codes.includes("failure_lock_state_unavailable"));
  const invalidHash = { ...lock, payload_sha256: HASH("e") };
  const invalid = evaluateAutonomyDecision(input({ failure_lock_events: [invalidHash] }));
  assert.ok(invalid.reason_codes.includes("failure_lock_state_unavailable"));
  const unrelated = structuredClone(lock);
  unrelated.payload.contract_sha256 = HASH("f");
  unrelated.payload.lock_key = failureLockKey({ incident_id: valid.incident_id, contract_sha256: HASH("f"), target: valid.target });
  unrelated.id = unrelated.payload.lock_key;
  unrelated.payload_sha256 = sha256Canonical(unrelated.payload);
  const clear = evaluateAutonomyDecision(input({ failure_lock_events: [unrelated] }));
  assert.equal(clear.failure_lock_state.status, "unavailable", "same target with an unverifiable authority binding remains fail-closed");
  const unrelatedTarget = structuredClone(lock);
  unrelatedTarget.payload.contract_sha256 = HASH("f");
  unrelatedTarget.payload.target = "other-component";
  unrelatedTarget.payload.lock_key = failureLockKey({ incident_id: valid.incident_id, contract_sha256: HASH("f"), target: "other-component" });
  unrelatedTarget.id = unrelatedTarget.payload.lock_key;
  unrelatedTarget.payload_sha256 = sha256Canonical(unrelatedTarget.payload);
  assert.equal(evaluateAutonomyDecision(input({ failure_lock_events: [unrelatedTarget] })).failure_lock_state.status, "clear");
});

test("consumption identity is internal, cross-run single-use, and cannot be overridden", () => {
  const first = evaluateAutonomyDecision(input());
  const secondContext = authorityContext({ runId: "run-cache-2" });
  const second = evaluateAutonomyDecision(input({ run_id: "run-cache-2", derived_authority: derivedAuthority(secondContext, { runId: "run-cache-2" }) }));
  const firstEvent = buildPreauthorizationConsumptionEvent({ decision: first, derived_authority: derivedAuthority() });
  const secondEvent = buildPreauthorizationConsumptionEvent({ decision: second, derived_authority: derivedAuthority(secondContext, { runId: "run-cache-2" }) });
  assert.equal(firstEvent.id, secondEvent.id);
  assert.equal(firstEvent.runId, "run-cache-1");
  expectPolicyError(() => buildPreauthorizationConsumptionEvent({ decision: first, derived_authority: derivedAuthority(), claim_id: "forged" }), "consumption_input_invalid");
  expectPolicyError(() => buildPreauthorizationConsumptionEvent({ decision: first, derived_authority: derivedAuthority(), run_id: "forged-run" }), "consumption_input_invalid");
});

test("independent concurrent writers preserve one immutable consumption winner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-"));
  const path = join(directory, "ledger.sqlite");
  new Ledger(path);
  const one = buildPreauthorizationConsumptionEvent({ decision: evaluateAutonomyDecision(input()), derived_authority: derivedAuthority() });
  const secondContext = authorityContext({ runId: "run-cache-2" });
  const two = buildPreauthorizationConsumptionEvent({ decision: evaluateAutonomyDecision(input({ run_id: "run-cache-2", derived_authority: derivedAuthority(secondContext, { runId: "run-cache-2" }) })), derived_authority: derivedAuthority(secondContext, { runId: "run-cache-2" }) });
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = [one, two].map((event) => startClaimWorker({ path, event, gate }));
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.inserted).length, 1);
  const ledger = new Ledger(path);
  const stored = ledger.get(one.id);
  assert.equal(stored.payload.decision_sha256, results.find((result) => result.inserted).event.payload.decision_sha256);
  assert.equal(ledger.list("run-cache-1").filter((entry) => entry.type === "preauthorization.consumed").length + ledger.list("run-cache-2").filter((entry) => entry.type === "preauthorization.consumed").length, 1);
});

test("pure policy neither freezes nor mutates caller-owned nested objects", () => {
  const source = input();
  const before = structuredClone(source);
  evaluateAutonomyDecision(source);
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(source.notification), false);
  source.notification.status = "failed";
  assert.equal(source.notification.status, "failed");
});

test("captured simulation stays distinct from execution and future live revalidation", () => {
  const decision = evaluateAutonomyDecision(input());
  assert.equal(decision.schema_version, AUTONOMY_SCHEMA_VERSION);
  assert.equal(decision.action_event_type, "action.simulated");
  assert.equal(decision.execution.satisfies_live_production_gate, false);
  assert.equal(decision.execution.satisfies_executed_offline_backtest, false);
  const revalidated = revalidateExecutionAuthority({ decision, registry: registry(), now: LATER, source: { status: "live", fresh: true }, failure_lock_events: [], executor_enabled: true, derived_authority: derivedAuthority() });
  assert.equal(revalidated.passed, false);
  assert.ok(revalidated.reason_codes.includes("preauthorization_expired"));
  const revoked = revalidateExecutionAuthority({ decision, registry: registry({ envelopes: [envelope({ status: "revoked" })] }), now: NOW, source: { status: "live", fresh: true }, failure_lock_events: [], executor_enabled: true, derived_authority: derivedAuthority() });
  assert.ok(revoked.reason_codes.includes("preauthorization_revoked"));
});

function startClaimWorker({ path, event, gate }) {
  const worker = new Worker(new URL("./helpers/autonomy-claim-worker.mjs", import.meta.url), { workerData: { path, event, gate } });
  let readyResolve;
  let resultResolve;
  let resultReject;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`claim worker exited ${code}`)); });
  });
  worker.on("message", (message) => {
    if (message.ready) readyResolve();
    if (message.result) resultResolve(message.result);
    if (message.error) resultReject(new Error(message.error));
  });
  return { ready, result };
}

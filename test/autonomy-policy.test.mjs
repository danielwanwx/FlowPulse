import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrozenEvidenceSnapshot } from "../src/evidence-source.mjs";
import { Ledger } from "../src/ledger.mjs";
import {
  AutonomyPolicyError,
  createServerAutonomyAuthority,
  failureLockKey,
  sha256Canonical
} from "../src/autonomy-policy.mjs";
import { AUTONOMY_POLICY_ARTIFACT } from "../src/autonomy-policy-artifacts.mjs";
import { FRESHNESS_MAX_AGE_MS, FreshnessReceiptError, createSnapshotFreshnessReceipt, verifySnapshotFreshnessReceipt } from "../src/autonomy-freshness.mjs";

const HASH = (character) => character.repeat(64);
const RUN = "run-cache-1";
const INCIDENT = "inc-cache-1";
const INTENT = "captured-cache-flush";

const intent = (id = INTENT) => AUTONOMY_POLICY_ARTIFACT.intents.find((candidate) => candidate.id === id);
const contract = (id = INTENT, overrides = {}) => ({ ...intent(id).contract, ...overrides });

function snapshot({ refs = ["ev-change", "ev-trace"], mode = "deterministic_replay", frozenAt = new Date(Date.now() - 3000).toISOString() } = {}) {
  const records = refs.map((id, index) => ({
    id,
    kind: "trace",
    source: index === 0 ? "captured-ledger" : "captured-otlp",
    mode: "captured_fixture",
    provenance: { sha256: HASH(index === 0 ? "c" : "d") }
  }));
  return new FrozenEvidenceSnapshot({
    id: "snapshot-cache-1",
    records,
    metadata: { mode, frozen_at: frozenAt, evidence_ids: refs, caps: { max_records: 120, max_bytes: 131072 } }
  });
}

function snapshotManifest(value) {
  const records = value.records.map((record) => ({
    id: record.id,
    sha256: record.provenance.sha256,
    source: record.source,
    mode: record.mode ?? value.metadata().mode
  })).sort((left, right) => left.id.localeCompare(right.id));
  const unsigned = { id: value.id, mode: value.metadata().mode, content_sha256: sha256Canonical(records), records };
  return { ...unsigned, manifest_sha256: sha256Canonical(unsigned) };
}

function evaluation(refs, overrides = {}) {
  return {
    accepted: true,
    score: 0.93,
    classification: "confirmed_system_bug",
    phase: "diagnosis_pre_approval",
    gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
    reason: "Independent evaluator accepted the bounded evidence.",
    missing_evidence: [],
    counter_evidence_refs: refs,
    ...overrides
  };
}

function appendGateEvents(ledger, { runId = RUN, incidentId = INCIDENT, frozen = snapshot(), actionContract = contract(), refs = frozen.records.map((record) => record.id), evaluationOverrides = {}, diagnosisOverrides = {}, reverse = false, timestamps = null } = {}) {
  const manifest = snapshotManifest(frozen);
  const acceptedEvaluation = evaluation(refs, evaluationOverrides);
  const evaluatorPayload = { ...acceptedEvaluation, hypothesis_id: "hyp-cache-1" };
  const diagnosisPayload = {
    snapshot: { id: manifest.id, content_sha256: manifest.content_sha256, mode: manifest.mode },
    accepted: {
      diagnosis: { id: "hyp-cache-1", evidence_refs: refs },
      evaluation: acceptedEvaluation,
      evidence_ids: refs,
      proposed_action_contract_sha256: sha256Canonical(actionContract),
      ...diagnosisOverrides
    }
  };
  const now = Date.now();
  const evaluatorEvent = { id: `eval-${runId}`, runId, incidentId, recordedAt: timestamps?.evaluator ?? new Date(now - 1500).toISOString(), type: "evaluation.accepted", actor: "evaluator", payload: evaluatorPayload, evidenceRefs: refs, correlationId: `corr-eval-${runId}` };
  const diagnosisEvent = { id: `gate-${runId}`, runId, incidentId, recordedAt: timestamps?.diagnosis ?? new Date(now - 750).toISOString(), type: "diagnosis.gate.passed", actor: "runtime", payload: diagnosisPayload, evidenceRefs: refs, correlationId: `corr-gate-${runId}` };
  for (const event of reverse ? [diagnosisEvent, evaluatorEvent] : [evaluatorEvent, diagnosisEvent]) ledger.append(event);
  return manifest;
}

function fixture({ intentId = INTENT, evaluationOverrides = {}, diagnosisOverrides = {}, locks = [], frozen = snapshot(), gateRefs = null, reverse = false, timestamps = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-authority-provider-"));
  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  appendGateEvents(ledger, { frozen, actionContract: intent(intentId).contract, refs: gateRefs ?? frozen.records.map((record) => record.id), evaluationOverrides, diagnosisOverrides, reverse, timestamps });
  for (const lock of locks) ledger.append(lock);
  const authority = createServerAutonomyAuthority({ ledger });
  authority.registerServerFrozenSnapshot({ run_id: RUN, incident_id: INCIDENT, snapshot: frozen });
  return { directory, ledger, authority, frozen };
}

function selector(overrides = {}) {
  return { run_id: RUN, incident_id: INCIDENT, intent_id: INTENT, ...overrides };
}

function expectPolicyError(fn, code) {
  assert.throws(fn, (error) => error instanceof AutonomyPolicyError && error.code === code);
}

test("policy has no provider/store constructor and its only composition factory rejects configuration", async () => {
  const policy = await import("../src/autonomy-policy.mjs");
  assert.equal(typeof policy.createServerAutonomyAuthority, "function");
  for (const key of ["createTrustedAuthorityProvider", "FrozenAuthoritySnapshotStore", "TrustedAuthorityProvider", "deriveAuthorityEvidenceFromLedger", "evaluateAutonomyDecision", "resolvePreauthorization", "buildAutonomyDecisionEvent", "buildPreauthorizationConsumptionEvent"]) {
    assert.equal(Object.hasOwn(policy, key), false, key);
  }
  for (const route of ["../src/server.mjs", "../src/openai.mjs", "../src/agent-control-service.mjs"]) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    assert.equal(source.includes("autonomy-policy.mjs"), false, `${route} must not compose autonomy authority`);
  }
});

test("server composition with an actual ledger and frozen snapshot can produce a low-impact captured decision", () => {
  const { authority } = fixture();
  const result = authority.decide(selector());
  assert.equal(result.decision.outcome, "auto_execute_pre_authorized");
  assert.equal(result.event.type, "autonomy.decision.recorded");
  assert.equal(result.decision.action_event_type, "action.simulated");
  assert.equal(result.decision.authority_evidence.contract_sha256, result.decision.contract_sha256);
  assert.equal(result.decision.authority_evidence.snapshot_manifest_sha256.length, 64);
  assert.equal(result.decision.execution.satisfies_live_production_gate, false);
  assert.equal(result.decision.execution.satisfies_executed_offline_backtest, false);
});

test("caller authority, registry, snapshot, locks, and raw JSON clones are rejected by the exact composition and selector boundaries", () => {
  const { authority, ledger } = fixture();
  const fakeRefs = ["fake-change", "fake-trace"];
  const fakeRecords = fakeRefs.map((id, index) => ({ id, sha256: HASH(index ? "e" : "f"), source: "forged", mode: "captured_fixture" }));
  const fakeEvaluation = evaluation(fakeRefs);
  const fakeManifest = { id: "forged", content_sha256: sha256Canonical(fakeRecords), mode: "deterministic_replay", records: fakeRecords };
  const forged = {
    registry: { schema_version: "forged", envelopes: [] },
    snapshot_manifest: fakeManifest,
    ledger_events: [
      { type: "evaluation.accepted", payload: { ...fakeEvaluation, hypothesis_id: "fake" }, evidence_refs: fakeRefs },
      { type: "diagnosis.gate.passed", payload: { snapshot: fakeManifest, accepted: { diagnosis: { id: "fake", evidence_refs: fakeRefs }, evaluation: fakeEvaluation, evidence_ids: fakeRefs, proposed_action_contract_sha256: sha256Canonical(contract()) } }, evidence_refs: fakeRefs }
    ],
    derived_authority: { schema_version: "flowpulse.authority-evidence.v1", payload_sha256: sha256Canonical(fakeEvaluation) },
    failure_lock_events: [],
    source: { status: "captured_fixture", fresh: true }
  };
  expectPolicyError(() => authority.decide({ ...selector(), ...forged }), "authority_selector_invalid");
  expectPolicyError(() => createServerAutonomyAuthority({ ledger, registry: forged.registry }), "trusted_authority_provider_invalid");
  const rawClone = JSON.parse(JSON.stringify(selector()));
  rawClone.decision = { outcome: "auto_execute_pre_authorized" };
  expectPolicyError(() => authority.decide(rawClone), "authority_selector_invalid");
});

test("evaluator authority is exact: only confirmed, complete, matching counter-evidence can pass", () => {
  const cases = [
    ["legacy-compact", { classification: undefined }, {}, "authority_evidence_invalid"],
    ["insufficient", { classification: "insufficient_evidence" }, {}, "authority_evidence_invalid"],
    ["missing", { missing_evidence: ["implementation_semantics"] }, {}, "authority_evidence_invalid"],
    ["counter", { counter_evidence_refs: ["ev-change"] }, {}, "authority_gate_evidence_mismatch"],
    ["gate-refs", {}, { evidence_ids: ["ev-change"] }, "authority_gate_evidence_mismatch"],
    ["nonmember", { counter_evidence_refs: ["unknown"] }, {}, "authority_gate_evidence_mismatch"]
  ];
  for (const [, evaluationOverrides, diagnosisOverrides, code] of cases) {
    const { authority } = fixture({ evaluationOverrides, diagnosisOverrides });
    expectPolicyError(() => authority.decide(selector()), code);
  }
});

test("the diagnosis gate binds the exact selected action contract", () => {
  const badContract = contract(INTENT, { expected_after: "different" });
  const { authority } = fixture({ diagnosisOverrides: { proposed_action_contract_sha256: sha256Canonical(badContract) } });
  expectPolicyError(() => authority.decide(selector()), "authority_gate_contract_mismatch");
});

test("wrong-scope, duplicate, reversed, and duplicate-reference gate streams fail closed", () => {
  const wrongScope = fixture();
  wrongScope.ledger.append({
    id: "cross-incident-evaluator",
    runId: RUN,
    incidentId: "other-incident",
    recordedAt: "2026-07-18T12:03:00.000Z",
    type: "evaluation.accepted",
    actor: "evaluator",
    payload: evaluation(["ev-change", "ev-trace"]),
    evidenceRefs: ["ev-change", "ev-trace"],
    correlationId: "cross-incident"
  });
  expectPolicyError(() => wrongScope.authority.decide(selector()), "authority_ledger_scope_mismatch");

  const duplicate = fixture();
  duplicate.ledger.append({
    id: "duplicate-evaluator",
    runId: RUN,
    incidentId: INCIDENT,
    recordedAt: "2026-07-18T12:03:00.000Z",
    type: "evaluation.accepted",
    actor: "evaluator",
    payload: { ...evaluation(["ev-change", "ev-trace"]), hypothesis_id: "hyp-cache-1" },
    evidenceRefs: ["ev-change", "ev-trace"],
    correlationId: "duplicate-evaluator"
  });
  expectPolicyError(() => duplicate.authority.decide(selector()), "authority_gate_event_conflict");
  expectPolicyError(() => fixture({ reverse: true }).authority.decide(selector()), "authority_gate_order_invalid");
  expectPolicyError(() => fixture({ gateRefs: ["ev-change", "ev-change"] }).authority.decide(selector()), "authority_evidence_invalid");
});

test("provider reads malformed and valid locks from the actual incident ledger, while unrelated target locks remain clear", () => {
  const current = contract();
  const exactKey = failureLockKey({ incident_id: INCIDENT, contract_sha256: sha256Canonical(current), target: current.target });
  const validExact = {
    id: exactKey,
    runId: "run-prior",
    incidentId: INCIDENT,
    recordedAt: "2026-07-18T11:55:00.000Z",
    type: "autonomy.locked",
    actor: "runtime",
    payload: {
      schema_version: "flowpulse.autonomy.v1",
      lock_key: exactKey,
      incident_id: INCIDENT,
      contract_sha256: sha256Canonical(current),
      target: current.target,
      binding_sha256: HASH("b"),
      decision_sha256: HASH("d"),
      failed_event_ref: "verification-failed",
      reason_code: "verification_failed"
    },
    evidenceRefs: [],
    correlationId: "lock-exact"
  };
  const locked = fixture({ locks: [validExact] }).authority.decide(selector());
  assert.equal(locked.decision.failure_lock_state.status, "locked");
  assert.equal(locked.decision.outcome, "blocked");

  const malformed = structuredClone(validExact);
  malformed.id = "lock-malformed";
  malformed.payload.incident_id = "other-incident";
  malformed.correlationId = "lock-malformed";
  const unavailable = fixture({ locks: [malformed] }).authority.decide(selector()).decision;
  assert.equal(unavailable.failure_lock_state.status, "unavailable");
  assert.equal(unavailable.outcome, "blocked");

  const missing = structuredClone(validExact);
  missing.id = "lock-missing";
  delete missing.payload.target;
  missing.correlationId = "lock-missing";
  const missingDecision = fixture({ locks: [missing] }).authority.decide(selector()).decision;
  assert.equal(missingDecision.failure_lock_state.status, "unavailable");
  assert.equal(missingDecision.outcome, "blocked");

  const other = structuredClone(validExact);
  other.payload.target = "other-component";
  other.payload.contract_sha256 = HASH("f");
  other.payload.lock_key = failureLockKey({ incident_id: INCIDENT, contract_sha256: HASH("f"), target: "other-component" });
  other.id = other.payload.lock_key;
  other.correlationId = "lock-other";
  const unrelated = fixture({ locks: [other] }).authority.decide(selector());
  assert.equal(unrelated.decision.failure_lock_state.status, "clear");
});

test("sev1, high, medium, and flagship checkout intents remain human-gated", () => {
  for (const [intentId, expected] of [["captured-medium-maintenance", "human_review_required"], ["captured-high-maintenance", "explicit_human_decision_required"], ["captured-sev1-maintenance", "explicit_human_decision_required"]]) {
    const { authority } = fixture({ intentId });
    assert.equal(authority.decide(selector({ intent_id: intentId })).decision.outcome, expected);
  }
  const { authority } = fixture({ intentId: "checkout-payment" });
  assert.equal(authority.decide(selector({ intent_id: "checkout-payment" })).decision.human_gate, "owner_required");
});

test("unknown snapshot membership and changed authority payloads fail closed", () => {
  const frozen = snapshot({ refs: ["ev-change"] });
  expectPolicyError(() => fixture({ frozen, gateRefs: ["ev-change", "unknown"] }).authority.decide(selector()), "authority_evidence_nonmember");
  const { authority, ledger } = fixture();
  const event = ledger.get(`eval-${RUN}`);
  event.payload.reason = "altered";
  // Ledger owns the stored payload, so a caller-side decoded clone cannot alter
  // the provider's authority input.
  assert.equal(authority.decide(selector()).decision.outcome, "auto_execute_pre_authorized");
});

test("snapshot registration binds the exact frozen manifest and detects later record drift", () => {
  const { authority, frozen } = fixture();
  assert.equal(Object.isFrozen(frozen.records), false);
  frozen.records[0].source = "altered-source";
  expectPolicyError(() => authority.decide(selector()), "trusted_snapshot_drift");
});

test("snapshot-bound freshness receipts reject expired, unknown, hash/mode mismatches, and clock rollback", () => {
  const frozenAt = new Date(Date.now() - 1000).toISOString();
  const frozen = snapshot({ frozenAt });
  const manifest = snapshotManifest(frozen);
  const receipt = createSnapshotFreshnessReceipt({ manifest, frozen_at: frozenAt });
  assert.equal(verifySnapshotFreshnessReceipt({ receipt, manifest, now: new Date(Date.now()).toISOString() }).status, "captured_fixture");
  const expired = { ...receipt, expires_at: new Date(Date.parse(receipt.observed_at) + FRESHNESS_MAX_AGE_MS + 1).toISOString() };
  expired.receipt_sha256 = sha256Canonical(Object.fromEntries(Object.entries(expired).filter(([key]) => key !== "receipt_sha256")));
  assert.throws(() => verifySnapshotFreshnessReceipt({ receipt: expired, manifest, now: new Date(Date.parse(expired.expires_at) + 1).toISOString() }), FreshnessReceiptError);
  const mismatched = { ...receipt, snapshot_content_sha256: HASH("f") };
  mismatched.receipt_sha256 = sha256Canonical(Object.fromEntries(Object.entries(mismatched).filter(([key]) => key !== "receipt_sha256")));
  assert.throws(() => verifySnapshotFreshnessReceipt({ receipt: mismatched, manifest, now: new Date(Date.now()).toISOString() }), (error) => error instanceof FreshnessReceiptError && error.code === "freshness_receipt_snapshot_mismatch");
  const modeMismatched = { ...receipt, snapshot_mode: "frozen_real_otlp_snapshot", source_mode: "live", truth_mode: "live" };
  modeMismatched.receipt_sha256 = sha256Canonical(Object.fromEntries(Object.entries(modeMismatched).filter(([key]) => key !== "receipt_sha256")));
  assert.throws(() => verifySnapshotFreshnessReceipt({ receipt: modeMismatched, manifest, now: new Date(Date.now()).toISOString() }), (error) => error instanceof FreshnessReceiptError && error.code === "freshness_receipt_snapshot_mismatch");
  const unknown = { ...receipt, schema_version: "unknown.v1" };
  unknown.receipt_sha256 = sha256Canonical(Object.fromEntries(Object.entries(unknown).filter(([key]) => key !== "receipt_sha256")));
  assert.throws(() => verifySnapshotFreshnessReceipt({ receipt: unknown, manifest, now: new Date(Date.now()).toISOString() }), (error) => error instanceof FreshnessReceiptError && error.code === "freshness_receipt_unknown");
  assert.throws(() => verifySnapshotFreshnessReceipt({ receipt, manifest, now: new Date(Date.parse(receipt.observed_at) - 1).toISOString() }), (error) => error instanceof FreshnessReceiptError && error.code === "freshness_clock_rollback");
});

test("future, stale, and temporally reordered authority gates fail closed", () => {
  const now = Date.now();
  const future = fixture({
    frozen: snapshot({ frozenAt: new Date(now - 3000).toISOString() }),
    timestamps: { evaluator: new Date(now - 1000).toISOString(), diagnosis: new Date(now + 60_000).toISOString() }
  });
  expectPolicyError(() => future.authority.decide(selector()), "authority_gate_temporal_invalid");
  const stale = fixture({
    frozen: snapshot({ frozenAt: new Date(now - FRESHNESS_MAX_AGE_MS - 1000).toISOString() })
  });
  expectPolicyError(() => stale.authority.decide(selector()), "freshness_receipt_expired");
  const reordered = fixture({
    frozen: snapshot({ frozenAt: new Date(now - 3000).toISOString() }),
    timestamps: { evaluator: new Date(now - 500).toISOString(), diagnosis: new Date(now - 1000).toISOString() }
  });
  expectPolicyError(() => reordered.authority.decide(selector()), "authority_gate_temporal_invalid");
});

test("reverse cross-run lock mismatches cannot hide outside the incident-header query", () => {
  const current = contract();
  const contractHash = sha256Canonical(current);
  const lockKey = failureLockKey({ incident_id: INCIDENT, contract_sha256: contractHash, target: current.target });
  const reverse = {
    id: lockKey,
    runId: "run-prior-other-header",
    incidentId: "other-incident",
    recordedAt: new Date(Date.now() - 1000).toISOString(),
    type: "autonomy.locked",
    actor: "runtime",
    payload: {
      schema_version: "flowpulse.autonomy.v1",
      lock_key: lockKey,
      incident_id: INCIDENT,
      contract_sha256: contractHash,
      target: current.target,
      binding_sha256: HASH("b"),
      decision_sha256: HASH("d"),
      failed_event_ref: "verification-failed",
      reason_code: "verification_failed"
    },
    evidenceRefs: [],
    correlationId: "reverse-cross-run-lock"
  };
  const decision = fixture({ locks: [reverse] }).authority.decide(selector()).decision;
  assert.equal(decision.failure_lock_state.status, "unavailable");
  assert.equal(decision.outcome, "blocked");
});

test("composition does not freeze or mutate caller-owned snapshot input", () => {
  const frozen = snapshot();
  const before = structuredClone(frozen.records);
  const { authority } = fixture({ frozen });
  authority.decide(selector());
  assert.deepEqual(frozen.records, before);
  assert.equal(Object.isFrozen(frozen.records), false);
});

test("independent workers preserve one immutable deterministic appendIfAbsent winner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-"));
  const path = join(directory, "ledger.sqlite");
  new Ledger(path);
  const id = "preauthorization-claim-worker-test";
  const events = ["run-cache-1", "run-cache-2"].map((runId) => ({
    id,
    runId,
    incidentId: INCIDENT,
    type: "preauthorization.consumed",
    actor: "test",
    payload: { decision_sha256: HASH(runId === "run-cache-1" ? "a" : "b") },
    evidenceRefs: [],
    correlationId: `worker-${runId}`
  }));
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = events.map((event) => startClaimWorker({ path, event, gate }));
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.inserted).length, 1);
  const stored = new Ledger(path).get(id);
  assert.equal(stored.payload.decision_sha256, results.find((result) => result.inserted).event.payload.decision_sha256);
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

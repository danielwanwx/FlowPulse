import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrozenEvidenceSnapshot } from "../src/evidence-source.mjs";
import { Ledger } from "../src/ledger.mjs";
import {
  AutonomyPolicyError,
  FrozenAuthoritySnapshotStore,
  createTrustedAuthorityProvider,
  failureLockKey,
  sha256Canonical
} from "../src/autonomy-policy.mjs";

const NOW = "2026-07-18T12:00:00.000Z";
const HASH = (character) => character.repeat(64);
const RUN = "run-cache-1";
const INCIDENT = "inc-cache-1";
const INTENT = "captured-cache-flush";

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

function intent(overrides = {}) {
  return {
    id: INTENT,
    environment: "captured_demo",
    contract: contract(),
    impact: { level: "low" },
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
    ...overrides
  };
}

function snapshot({ refs = ["ev-change", "ev-trace"], mode = "deterministic_replay" } = {}) {
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
    metadata: { mode, evidence_ids: refs, caps: { max_records: 120, max_bytes: 131072 } }
  });
}

function snapshotManifest(value) {
  const records = value.records.map((record) => ({
    id: record.id,
    sha256: record.provenance.sha256,
    source: record.source,
    mode: record.mode ?? value.metadata().mode
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { id: value.id, mode: value.metadata().mode, content_sha256: sha256Canonical(records), records };
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

function appendGateEvents(ledger, { runId = RUN, incidentId = INCIDENT, frozen = snapshot(), actionContract = contract(), refs = frozen.records.map((record) => record.id), evaluationOverrides = {}, diagnosisOverrides = {}, reverse = false } = {}) {
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
  const evaluatorEvent = { id: `eval-${runId}`, runId, incidentId, recordedAt: "2026-07-18T12:01:00.000Z", type: "evaluation.accepted", actor: "evaluator", payload: evaluatorPayload, evidenceRefs: refs, correlationId: `corr-eval-${runId}` };
  const diagnosisEvent = { id: `gate-${runId}`, runId, incidentId, recordedAt: "2026-07-18T12:02:00.000Z", type: "diagnosis.gate.passed", actor: "runtime", payload: diagnosisPayload, evidenceRefs: refs, correlationId: `corr-gate-${runId}` };
  for (const event of reverse ? [diagnosisEvent, evaluatorEvent] : [evaluatorEvent, diagnosisEvent]) ledger.append(event);
  return manifest;
}

function fixture({ intentOverrides = {}, registryOverrides = {}, evaluationOverrides = {}, diagnosisOverrides = {}, locks = [], frozen = snapshot(), gateRefs = null, reverse = false, source = { status: "captured_fixture", fresh: true } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-authority-provider-"));
  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  appendGateEvents(ledger, { frozen, actionContract: intent(intentOverrides).contract, refs: gateRefs ?? frozen.records.map((record) => record.id), evaluationOverrides, diagnosisOverrides, reverse });
  for (const lock of locks) ledger.append(lock);
  const snapshots = new FrozenAuthoritySnapshotStore();
  snapshots.register({ run_id: RUN, incident_id: INCIDENT, snapshot: frozen });
  const provider = createTrustedAuthorityProvider({
    ledger,
    snapshots,
    registry: registry(registryOverrides),
    intents: [intent(intentOverrides)],
    source_state: () => source,
    clock: () => NOW
  });
  return { directory, ledger, snapshots, provider, frozen };
}

function selector(overrides = {}) {
  return { run_id: RUN, incident_id: INCIDENT, intent_id: INTENT, ...overrides };
}

function expectPolicyError(fn, code) {
  assert.throws(fn, (error) => error instanceof AutonomyPolicyError && error.code === code);
}

test("public exports expose a trusted provider but no raw authority minting boundary", async () => {
  const policy = await import("../src/autonomy-policy.mjs");
  assert.equal(typeof policy.createTrustedAuthorityProvider, "function");
  assert.equal(typeof policy.FrozenAuthoritySnapshotStore, "function");
  for (const key of ["deriveAuthorityEvidenceFromLedger", "evaluateAutonomyDecision", "resolvePreauthorization", "buildAutonomyDecisionEvent", "buildPreauthorizationConsumptionEvent"]) {
    assert.equal(Object.hasOwn(policy, key), false, key);
  }
});

test("only server-owned Ledger plus frozen snapshot store can produce a low-impact captured decision", () => {
  const { provider } = fixture();
  const result = provider.decide(selector());
  assert.equal(result.decision.outcome, "auto_execute_pre_authorized");
  assert.equal(result.event.type, "autonomy.decision.recorded");
  assert.equal(result.decision.action_event_type, "action.simulated");
  assert.equal(result.decision.authority_evidence.contract_sha256, result.decision.contract_sha256);
  assert.equal(result.decision.authority_evidence.snapshot_manifest_sha256.length, 64);
  assert.equal(result.decision.execution.satisfies_live_production_gate, false);
  assert.equal(result.decision.execution.satisfies_executed_offline_backtest, false);
});

test("forged caller authority, registry, snapshot, locks, and raw JSON clones are rejected by the exact selector boundary", () => {
  const { provider } = fixture();
  const fakeRefs = ["fake-change", "fake-trace"];
  const fakeRecords = fakeRefs.map((id, index) => ({ id, sha256: HASH(index ? "e" : "f"), source: "forged", mode: "captured_fixture" }));
  const fakeEvaluation = evaluation(fakeRefs);
  const fakeManifest = { id: "forged", content_sha256: sha256Canonical(fakeRecords), mode: "deterministic_replay", records: fakeRecords };
  const forged = {
    registry: registry(),
    snapshot_manifest: fakeManifest,
    ledger_events: [
      { type: "evaluation.accepted", payload: { ...fakeEvaluation, hypothesis_id: "fake" }, evidence_refs: fakeRefs },
      { type: "diagnosis.gate.passed", payload: { snapshot: fakeManifest, accepted: { diagnosis: { id: "fake", evidence_refs: fakeRefs }, evaluation: fakeEvaluation, evidence_ids: fakeRefs, proposed_action_contract_sha256: sha256Canonical(contract()) } }, evidence_refs: fakeRefs }
    ],
    derived_authority: { schema_version: "flowpulse.authority-evidence.v1", payload_sha256: sha256Canonical(fakeEvaluation) },
    failure_lock_events: [],
    source: { status: "captured_fixture", fresh: true }
  };
  expectPolicyError(() => provider.decide({ ...selector(), ...forged }), "authority_selector_invalid");
  expectPolicyError(() => createTrustedAuthorityProvider({
    ledger: { list: () => forged.ledger_events, listIncident: () => [] },
    snapshots: { get: () => forged.snapshot_manifest },
    registry: forged.registry,
    intents: [intent()],
    source_state: () => forged.source,
    clock: () => NOW
  }), "trusted_authority_provider_invalid");
  const rawClone = JSON.parse(JSON.stringify(selector()));
  rawClone.decision = { outcome: "auto_execute_pre_authorized" };
  expectPolicyError(() => provider.decide(rawClone), "authority_selector_invalid");
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
    const { provider } = fixture({ evaluationOverrides, diagnosisOverrides });
    expectPolicyError(() => provider.decide(selector()), code);
  }
});

test("the diagnosis gate binds the exact selected action contract", () => {
  const badContract = contract({ expected_after: "different" });
  const { provider } = fixture({ diagnosisOverrides: { proposed_action_contract_sha256: sha256Canonical(badContract) } });
  expectPolicyError(() => provider.decide(selector()), "authority_gate_contract_mismatch");
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
  expectPolicyError(() => wrongScope.provider.decide(selector()), "authority_ledger_scope_mismatch");

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
  expectPolicyError(() => duplicate.provider.decide(selector()), "authority_gate_event_conflict");
  expectPolicyError(() => fixture({ reverse: true }).provider.decide(selector()), "authority_gate_order_invalid");
  expectPolicyError(() => fixture({ gateRefs: ["ev-change", "ev-change"] }).provider.decide(selector()), "authority_evidence_invalid");
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
  const locked = fixture({ locks: [validExact] }).provider.decide(selector());
  assert.equal(locked.decision.failure_lock_state.status, "locked");
  assert.equal(locked.decision.outcome, "blocked");

  const malformed = structuredClone(validExact);
  malformed.id = "lock-malformed";
  malformed.payload.incident_id = "other-incident";
  malformed.correlationId = "lock-malformed";
  const malformedProvider = fixture({ locks: [malformed] }).provider;
  const unavailable = malformedProvider.decide(selector()).decision;
  assert.equal(unavailable.failure_lock_state.status, "unavailable");
  assert.equal(unavailable.outcome, "blocked");

  const missing = structuredClone(validExact);
  missing.id = "lock-missing";
  delete missing.payload.target;
  missing.correlationId = "lock-missing";
  const missingDecision = fixture({ locks: [missing] }).provider.decide(selector()).decision;
  assert.equal(missingDecision.failure_lock_state.status, "unavailable");
  assert.equal(missingDecision.outcome, "blocked");

  const other = structuredClone(validExact);
  other.payload.target = "other-component";
  other.payload.contract_sha256 = HASH("f");
  other.payload.lock_key = failureLockKey({ incident_id: INCIDENT, contract_sha256: HASH("f"), target: "other-component" });
  other.id = other.payload.lock_key;
  other.correlationId = "lock-other";
  const unrelated = fixture({ locks: [other] }).provider.decide(selector());
  assert.equal(unrelated.decision.failure_lock_state.status, "clear");
});

test("high, medium, and flagship checkout intents remain human-gated", () => {
  for (const [level, expected] of [["medium", "human_review_required"], ["high", "explicit_human_decision_required"], ["sev1", "explicit_human_decision_required"]]) {
    const { provider } = fixture({ intentOverrides: { impact: { level } } });
    assert.equal(provider.decide(selector()).decision.outcome, expected);
  }
  const { provider } = fixture({ intentOverrides: { id: "checkout-payment", contract: contract({ target: "checkout" }), impact: { level: "medium" } } });
  assert.equal(provider.decide(selector({ intent_id: "checkout-payment" })).decision.human_gate, "owner_required");
});

test("source freshness, unknown snapshot membership, and changed authority payloads fail closed", () => {
  const stale = fixture({ source: { status: "stale", fresh: false } }).provider.decide(selector()).decision;
  assert.equal(stale.outcome, "blocked");
  assert.ok(stale.reason_codes.includes("source_stale"));
  const frozen = snapshot({ refs: ["ev-change"] });
  expectPolicyError(() => fixture({ frozen, gateRefs: ["ev-change", "unknown"] }).provider.decide(selector()), "authority_evidence_nonmember");
  const { provider, ledger } = fixture();
  const event = ledger.get(`eval-${RUN}`);
  event.payload.reason = "altered";
  // Ledger owns the stored payload, so a caller-side decoded clone cannot alter
  // the provider's authority input.
  assert.equal(provider.decide(selector()).decision.outcome, "auto_execute_pre_authorized");
});

test("snapshot registration binds the exact frozen manifest and detects later record drift", () => {
  const { provider, frozen } = fixture();
  assert.equal(Object.isFrozen(frozen.records), false);
  frozen.records[0].source = "altered-source";
  expectPolicyError(() => provider.decide(selector()), "trusted_snapshot_drift");
});

test("provider construction and decision do not freeze or mutate caller-owned configuration", () => {
  const inputRegistry = registry();
  const inputIntents = [intent()];
  const beforeRegistry = structuredClone(inputRegistry);
  const beforeIntents = structuredClone(inputIntents);
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-authority-purity-"));
  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  const frozen = snapshot();
  appendGateEvents(ledger, { frozen });
  const snapshots = new FrozenAuthoritySnapshotStore();
  snapshots.register({ run_id: RUN, incident_id: INCIDENT, snapshot: frozen });
  const provider = createTrustedAuthorityProvider({ ledger, snapshots, registry: inputRegistry, intents: inputIntents, source_state: () => ({ status: "captured_fixture", fresh: true }), clock: () => NOW });
  provider.decide(selector());
  assert.deepEqual(inputRegistry, beforeRegistry);
  assert.deepEqual(inputIntents, beforeIntents);
  assert.equal(Object.isFrozen(inputRegistry.envelopes[0]), false);
  inputRegistry.envelopes[0].status = "revoked";
  assert.equal(provider.decide(selector()).decision.outcome, "auto_execute_pre_authorized");
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

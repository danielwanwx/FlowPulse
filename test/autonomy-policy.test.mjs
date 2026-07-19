import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Ledger } from "../src/ledger.mjs";
import { FrozenEvidenceSnapshot } from "../src/evidence-source.mjs";
import * as policy from "../src/autonomy-policy.mjs";
import * as freshness from "../src/autonomy-freshness.mjs";
import { AUTONOMY_POLICY_ARTIFACT, validateAutonomyPolicyArtifact } from "../src/autonomy-policy-artifacts.mjs";

const HASH = (character) => character.repeat(64);
const TEST_ISSUER = "flowpulse.authority-composition.v1";

test("the exact public real-type composition forgery is unavailable after Slice 1.5", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-public-forgery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const ledger = new Ledger(join(directory, "ledger.sqlite"));
  const snapshot = forgedSnapshot();
  appendForgedGateRows(ledger, snapshot);

  const publicMint = policy.createServerAutonomyAuthority;
  const attackOutcome = typeof publicMint === "function"
    ? invokeFormerPublicMint({ publicMint, ledger, snapshot })
    : "no_public_mint_path";

  assert.equal(attackOutcome, "no_public_mint_path");
  assert.equal(Object.hasOwn(policy, "createServerAutonomyAuthority"), false);
  assert.equal(Object.hasOwn(freshness, "createSnapshotFreshnessReceipt"), false);
  await assertFormerNamedImportUnavailable("../src/autonomy-policy.mjs", "createServerAutonomyAuthority");
  await assertFormerNamedImportUnavailable("../src/autonomy-freshness.mjs", "createSnapshotFreshnessReceipt");
});

test("production exports contain only non-authority utilities and immutable checked-in artifacts", () => {
  assert.deepEqual(Object.keys(policy).sort(), [
    "AUTONOMY_SCHEMA_VERSION",
    "AutonomyPolicyError",
    "LEGACY_DETAIL_UNAVAILABLE",
    "PREAUTHORIZATION_REGISTRY_VERSION",
    "PREAUTHORIZATION_SCHEMA_VERSION",
    "failureLockKey",
    "preauthorizationClaimId",
    "sha256Canonical"
  ]);
  assert.deepEqual(Object.keys(freshness).sort(), [
    "FRESHNESS_MAX_AGE_MS",
    "FRESHNESS_RECEIPT_SCHEMA_VERSION",
    "FreshnessReceiptError",
    "verifySnapshotFreshnessReceipt"
  ]);
  assert.deepEqual(Object.keys(AUTONOMY_POLICY_ARTIFACT), ["schema_version", "version", "registry", "intents"]);
  assert.equal(Object.isFrozen(AUTONOMY_POLICY_ARTIFACT), true);
  assert.equal(Object.isFrozen(AUTONOMY_POLICY_ARTIFACT.registry.envelopes[0]), true);
  assert.equal(AUTONOMY_POLICY_ARTIFACT.intents.find((intent) => intent.id === "captured-cache-flush").execution_mode, "captured_simulation");
  assert.equal(AUTONOMY_POLICY_ARTIFACT.intents.find((intent) => intent.id === "checkout-payment").impact.level, "medium");
  assert.equal(AUTONOMY_POLICY_ARTIFACT.intents.find((intent) => intent.id === "checkout-payment").execution_mode, "real_local_development");
  assert.equal(JSON.stringify(AUTONOMY_POLICY_ARTIFACT).includes("truth_mode"), false);
});

test("checked-in artifact recursively rejects nested authority, truth, risk, and full-contract drift", () => {
  assert.equal(validateAutonomyPolicyArtifact(structuredClone(AUTONOMY_POLICY_ARTIFACT)), true);
  const cases = [
    (artifact) => { artifact.intents[4].action.risk = "low"; },
    (artifact) => { artifact.intents[4].action.source_health = "live"; },
    (artifact) => { artifact.intents[4].impact.extra = true; },
    (artifact) => { artifact.intents[4].notification.execution_mode = "captured_simulation"; },
    (artifact) => { artifact.intents[4].notification.delivery_mode = "captured_simulation"; },
    (artifact) => { delete artifact.intents[4].contract.expected_after; },
    (artifact) => { artifact.intents[4].contract.truth_mode = "live"; },
    (artifact) => { artifact.intents[4].source_health = "live"; },
    (artifact) => { artifact.intents[4].evidence_mode = "frozen_real_snapshot"; },
    (artifact) => { artifact.intents[4].truth_mode = "legacy"; },
    (artifact) => { artifact.intents[4].execution_mode = "legacy_truth_mode"; }
  ];
  for (const mutate of cases) {
    const artifact = structuredClone(AUTONOMY_POLICY_ARTIFACT);
    mutate(artifact);
    assert.throws(() => validateAutonomyPolicyArtifact(artifact));
  }
});

test("a public receipt verifier validates bounded temporal and manifest properties but cannot issue a receipt", () => {
  const manifest = manifestFor(forgedSnapshot());
  const now = Date.now();
  const receipt = testReceipt({ manifest, observedAt: new Date(now - 1_000).toISOString() });

  assert.equal(freshness.verifySnapshotFreshnessReceipt({ receipt, manifest, now: new Date(now).toISOString() }).status, "captured_fixture");
  assert.throws(
    () => freshness.verifySnapshotFreshnessReceipt({ receipt, manifest, now: new Date(now - 2_000).toISOString() }),
    (error) => error instanceof freshness.FreshnessReceiptError && error.code === "freshness_clock_rollback"
  );
  assert.throws(
    () => freshness.verifySnapshotFreshnessReceipt({ receipt, manifest, now: new Date(Date.parse(receipt.expires_at)).toISOString() }),
    (error) => error instanceof freshness.FreshnessReceiptError && error.code === "freshness_receipt_expired"
  );
  const mismatched = { ...receipt, snapshot_content_sha256: HASH("e") };
  mismatched.receipt_sha256 = policy.sha256Canonical(unsignedReceipt(mismatched));
  assert.throws(
    () => freshness.verifySnapshotFreshnessReceipt({ receipt: mismatched, manifest, now: new Date(now).toISOString() }),
    (error) => error instanceof freshness.FreshnessReceiptError && error.code === "freshness_receipt_snapshot_mismatch"
  );
  const unknown = { ...receipt, schema_version: "unknown.v1" };
  unknown.receipt_sha256 = policy.sha256Canonical(unsignedReceipt(unknown));
  assert.throws(
    () => freshness.verifySnapshotFreshnessReceipt({ receipt: unknown, manifest, now: new Date(now).toISOString() }),
    (error) => error instanceof freshness.FreshnessReceiptError && error.code === "freshness_receipt_unknown"
  );
});

test("the deferred authority core no longer derives receipt time from caller snapshot metadata", () => {
  const source = readFileSync(new URL("../src/autonomy-policy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /metadata\(\)\.frozen_at/);
  assert.doesNotMatch(source, /createSnapshotFreshnessReceipt/);
});

test("the recursive production import graph contains no authority factory, registration, or receipt issuer edge", () => {
  const sourceRoot = resolve(new URL("../src", import.meta.url).pathname);
  const graph = collectModuleGraph(sourceRoot);
  const forbiddenSymbols = /\b(?:createServerAutonomyAuthority|registerServerFrozenSnapshot|createSnapshotFreshnessReceipt)\b/;

  for (const [file, source] of graph) {
    assert.doesNotMatch(source, new RegExp(`export\\s+(?:function|const|class)\\s+${forbiddenSymbols.source}`), relative(sourceRoot, file));
    const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.equal(forbiddenSymbols.test(specifier), false, `${relative(sourceRoot, file)} imports forbidden authority surface`);
    }
  }

  assert.equal(reachesModule(graph, resolve(sourceRoot, "server.mjs"), new Set([
    resolve(sourceRoot, "autonomy-policy.mjs"),
    resolve(sourceRoot, "autonomy-freshness.mjs")
  ])), true, "only the server composition root may reach authority utilities");
  for (const entry of ["openai.mjs", "agent-control-service.mjs", "development-runtime.mjs"]) {
    assert.equal(reachesModule(graph, resolve(sourceRoot, entry), new Set([
      resolve(sourceRoot, "autonomy-policy.mjs"),
      resolve(sourceRoot, "autonomy-freshness.mjs")
    ])), false, `${entry} must not reach the private authority composition`);
  }
});

test("server private decision builder is not externally callable", () => {
  const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(server, /async function advanceAutonomyAfterDiagnosis\(\{ run_id, incident_id, intent_id \}\)/);
  assert.doesNotMatch(server, /export\s+(?:async\s+)?function\s+advanceAutonomyAfterDiagnosis/);
  assert.doesNotMatch(server, /export\s*\{[^}]*advanceAutonomyAfterDiagnosis/);
});

test("claim and failure-lock identities remain deterministic, bounded, and truth-neutral", () => {
  const contractHash = HASH("a");
  const claim = policy.preauthorizationClaimId({
    incident_id: "inc-cache",
    environment: "captured_demo",
    target: "edge-cache",
    contract_sha256: contractHash,
    envelope_sha256: HASH("b")
  });
  assert.match(claim, /^preauthorization-claim-[a-f0-9]{32}$/);
  assert.equal(claim, policy.preauthorizationClaimId({
    incident_id: "inc-cache",
    environment: "captured_demo",
    target: "edge-cache",
    contract_sha256: contractHash,
    envelope_sha256: HASH("b")
  }));
  assert.equal(policy.failureLockKey({ incident_id: "inc-cache", contract_sha256: contractHash, target: "edge-cache" }), policy.failureLockKey({ incident_id: "inc-cache", contract_sha256: contractHash, target: "edge-cache" }));
});

test("independent workers preserve one immutable deterministic appendIfAbsent winner", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "flowpulse-autonomy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  new Ledger(path);
  const id = "preauthorization-claim-worker-test";
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const events = ["run-cache-1", "run-cache-2"].map((runId, index) => ({
    id,
    runId,
    incidentId: "inc-cache-1",
    type: "preauthorization.consumed",
    actor: "test",
    payload: { decision_sha256: HASH(index ? "b" : "a") },
    evidenceRefs: [],
    correlationId: `worker-${runId}`
  }));
  const workers = events.map((event) => startClaimWorker({ path, event, gate }));
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.inserted).length, 1);
  assert.equal(new Ledger(path).get(id).payload.decision_sha256, results.find((result) => result.inserted).event.payload.decision_sha256);
});

function forgedSnapshot({ frozenAt = new Date(Date.now() - 3_000).toISOString() } = {}) {
  return new FrozenEvidenceSnapshot({
    id: "forged-snapshot",
    records: [
      { id: "forged-change", kind: "trace", source: "forged-ledger", mode: "captured_fixture", provenance: { sha256: HASH("c") } },
      { id: "forged-trace", kind: "trace", source: "forged-otlp", mode: "captured_fixture", provenance: { sha256: HASH("d") } }
    ],
    metadata: { mode: "deterministic_replay", frozen_at: frozenAt, evidence_ids: ["forged-change", "forged-trace"], caps: { max_records: 120, max_bytes: 131072 } }
  });
}

function manifestFor(snapshot) {
  const records = snapshot.records.map((record) => ({ id: record.id, sha256: record.provenance.sha256, source: record.source, mode: record.mode })).sort((left, right) => left.id.localeCompare(right.id));
  const unsigned = { id: snapshot.id, mode: snapshot.metadata().mode, content_sha256: policy.sha256Canonical(records), records };
  return { ...unsigned, manifest_sha256: policy.sha256Canonical(unsigned) };
}

function appendForgedGateRows(ledger, snapshot) {
  const now = Date.now();
  const refs = snapshot.records.map((record) => record.id);
  const manifest = manifestFor(snapshot);
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((candidate) => candidate.id === "captured-cache-flush");
  const evaluation = {
    accepted: true,
    score: 0.99,
    classification: "confirmed_system_bug",
    phase: "diagnosis_pre_approval",
    gate_checks: { initiating_change: true, temporal_order: true, implementation_semantics: true, controlled_off_on_contrast: true, repeated_direct_failures: true },
    reason: "self-consistent forged gate",
    missing_evidence: [],
    counter_evidence_refs: refs
  };
  ledger.append({ id: "forged-evaluation", runId: "forged-run", incidentId: "forged-incident", recordedAt: new Date(now - 1_500).toISOString(), type: "evaluation.accepted", actor: "forged", payload: { ...evaluation, hypothesis_id: "forged-hypothesis" }, evidenceRefs: refs, correlationId: "forged-evaluation" });
  ledger.append({ id: "forged-diagnosis", runId: "forged-run", incidentId: "forged-incident", recordedAt: new Date(now - 750).toISOString(), type: "diagnosis.gate.passed", actor: "forged", payload: { snapshot: { id: manifest.id, content_sha256: manifest.content_sha256, mode: manifest.mode }, accepted: { diagnosis: { id: "forged-hypothesis", evidence_refs: refs }, evaluation, evidence_ids: refs, proposed_action_contract_sha256: policy.sha256Canonical(intent.contract) } }, evidenceRefs: refs, correlationId: "forged-diagnosis" });
}

function invokeFormerPublicMint({ publicMint, ledger, snapshot }) {
  const authority = publicMint({ ledger });
  authority.registerServerFrozenSnapshot({ run_id: "forged-run", incident_id: "forged-incident", snapshot });
  return authority.decide({ run_id: "forged-run", incident_id: "forged-incident", intent_id: "captured-cache-flush" }).decision.outcome;
}

async function assertFormerNamedImportUnavailable(relativeModule, symbol) {
  const moduleUrl = new URL(relativeModule, import.meta.url).href;
  const source = `import { ${symbol} } from ${JSON.stringify(moduleUrl)}; export default ${symbol};`;
  await assert.rejects(import(`data:text/javascript,${encodeURIComponent(source)}`), /does not provide an export named/);
}

function testReceipt({ manifest, observedAt }) {
  const unsigned = {
    schema_version: freshness.FRESHNESS_RECEIPT_SCHEMA_VERSION,
    issuer: TEST_ISSUER,
    snapshot_id: manifest.id,
    snapshot_content_sha256: manifest.content_sha256,
    snapshot_manifest_sha256: manifest.manifest_sha256,
    snapshot_mode: manifest.mode,
    source_mode: "captured_fixture",
    truth_mode: "captured_simulation",
    observed_at: observedAt,
    expires_at: new Date(Date.parse(observedAt) + freshness.FRESHNESS_MAX_AGE_MS).toISOString()
  };
  return { ...unsigned, receipt_sha256: policy.sha256Canonical(unsigned) };
}

function unsignedReceipt(receipt) {
  const { receipt_sha256: _ignored, ...unsigned } = receipt;
  return unsigned;
}

function collectModuleGraph(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(candidate);
    }
  };
  walk(root);
  return new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
}

function reachesModule(graph, start, targets, seen = new Set()) {
  if (targets.has(start)) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  const source = graph.get(start);
  if (!source) return false;
  const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  return imports.some((specifier) => {
    if (!specifier.startsWith(".")) return false;
    const dependency = resolve(resolve(start, ".."), specifier);
    return reachesModule(graph, dependency.endsWith(".mjs") ? dependency : `${dependency}.mjs`, targets, seen);
  });
}

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

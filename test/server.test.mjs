import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";
import { LiveSource } from "../src/live-source.mjs";
import { summarizeEvidence, versionedChangeEvidence } from "../src/evidence-source.mjs";
import * as developmentAdapter from "../src/development-adapter.mjs";
import { failureLockKey, sha256Canonical } from "../src/autonomy-policy.mjs";
import { sha256 as hashBoundEvidence } from "../src/regression-backtest.mjs";

test("server-owned development path appends one canonical owner-gated authority decision", async (context) => {
  const fixture = await startAuthorityFixture(context);
  const response = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  const decisions = events.filter((event) => event.type === "autonomy.decision.recorded");
  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.match(decision.id, /^autonomy-decision-[a-f0-9]{32}$/);
  assert.equal(decision.payload.outcome, "human_review_required");
  assert.equal(decision.payload.execution_mode, "real_local_development");
  for (const key of ["receipt_sha256", "authority_context_sha256", "contract_sha256"]) assert.match(decision.payload[key], /^[a-f0-9]{64}$/);
  assert.equal(decision.payload.authority_evidence.refs.every((ref) => /^[a-f0-9]{64}$/.test(ref.sha256)), true);
  const proposal = events.find((event) => event.type === "repair.proposed");
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(proposal && approval);
  assert.equal(decision.sequence < proposal.sequence && proposal.sequence < approval.sequence, true);
  assert.equal(events.some((event) => event.type === "repair.executed"), false);
});

test("simultaneous cold-start investigations single-flight one canonical authority decision", async (context) => {
  const fixture = await startAuthorityFixture(context);
  const [left, right] = await Promise.all([postJson(fixture.port, "/api/development/investigate"), postJson(fixture.port, "/api/development/investigate")]);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(right.status, 200, JSON.stringify(right.body));
  const repeat = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.filter((event) => event.type === "autonomy.decision.recorded").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.proposed").length, 1);
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
  assert.equal(events.filter((event) => event.type === "evaluation.accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "diagnosis.gate.passed").length, 1);
});

test("a conflicting pre-existing decision claim fails closed without an Owner Gate", async (context) => {
  const fixture = await startAuthorityFixture(context, { conflictingDecision: {} });
  const response = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(response.status, 422, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested" || event.type === "approval.granted" || event.type === "repair.executed"), false);
});

test("a pre-existing decision with a tampered receipt or context fails closed", async (context) => {
  for (const patch of [{ path: "$.receipt_sha256", value: "f".repeat(64) }, { path: "$.authority_context_sha256", value: "e".repeat(64) }]) {
    const fixture = await startAuthorityFixture(context, { conflictingDecision: patch });
    const response = await postJson(fixture.port, "/api/development/investigate");
    assert.equal(response.status, 422, JSON.stringify(response.body));
    const events = new Ledger(fixture.dbPath).list(fixture.runId);
    assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested"), false);
  }
});

test("a relevant ledger failure lock is terminal and never creates an Owner Gate", async (context) => {
  const fixture = await startAuthorityFixture(context);
  const contract = { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout", expected_before: "paymentUnreachable=on", expected_after: "paymentUnreachable=off" };
  const contract_sha256 = sha256Canonical(contract);
  const incidentId = loadBundle().incident.id;
  new Ledger(fixture.dbPath).append({ id: "test-relevant-autonomy-lock", runId: fixture.runId, incidentId, type: "autonomy.locked", actor: "test", payload: { incident_id: incidentId, contract_sha256, target: "checkout", lock_key: failureLockKey({ incident_id: incidentId, contract_sha256, target: "checkout" }) } });
  const response = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.find((event) => event.type === "autonomy.decision.recorded")?.payload.outcome, "non_actionable");
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested" || event.type === "repair.executed"), false);
});

test("future capture timestamps fail closed before an autonomy decision", async (context) => {
  const fixture = await startAuthorityFixture(context, { futureCapture: true });
  const response = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(response.status, 422, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.some((event) => event.type === "autonomy.decision.recorded" || event.type === "repair.proposed" || event.type === "approval.requested"), false);
});

test("stale capture and caller authority fields fail closed before investigation", async (context) => {
  const stale = await startAuthorityFixture(context, { staleCapture: true });
  const staleResponse = await postJson(stale.port, "/api/development/investigate");
  assert.equal(staleResponse.status, 422, JSON.stringify(staleResponse.body));
  assert.equal(new Ledger(stale.dbPath).list(stale.runId).some((event) => event.type === "autonomy.decision.recorded"), false);

  const fixture = await startAuthorityFixture(context);
  const injected = await postJson(fixture.port, "/api/development/investigate", { risk: "low", snapshot: "caller", receipt: "caller", execution_mode: "captured_simulation" });
  assert.equal(injected.status, 409);
  assert.equal(new Ledger(fixture.dbPath).list(fixture.runId).some((event) => /^(evaluation\.accepted|diagnosis\.gate\.passed|autonomy\.decision\.recorded)$/.test(event.type)), false);
});

test("misordered evaluator and gate rows, hypothesis/evaluator drift, and altered actual snapshot evidence fail closed", async (context) => {
  for (const option of ["misorderedEvaluator", "hypothesisMismatch", "tamperedEvaluator", "tamperedEvidence"]) {
    const fixture = await startAuthorityFixture(context, { [option]: true });
    const response = await postJson(fixture.port, "/api/development/investigate");
    assert.equal(response.status, 422, `${option}: ${JSON.stringify(response.body)}`);
    const events = new Ledger(fixture.dbPath).list(fixture.runId);
    assert.equal(events.some((event) => event.type === "autonomy.decision.recorded" || event.type === "repair.proposed" || event.type === "approval.requested"), false, option);
  }
});

test("a lock inserted after the Owner Gate request blocks approval and compatibility approval cannot corrupt it", async (context) => {
  const fixture = await startAuthorityFixture(context);
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const generic = await postJson(fixture.port, "/api/approve", { owner: "forged generic owner" });
  assert.equal(generic.status, 409);
  const contract = checkoutContract();
  const contract_sha256 = sha256Canonical(contract);
  const incidentId = loadBundle().incident.id;
  new Ledger(fixture.dbPath).append({ id: "test-late-autonomy-lock", runId: fixture.runId, incidentId, type: "autonomy.locked", actor: "test", payload: { incident_id: incidentId, contract_sha256, target: "checkout", lock_key: failureLockKey({ incident_id: incidentId, contract_sha256, target: "checkout" }) } });
  const approval = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
  assert.equal(approval.status, 500);
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.some((event) => event.type === "approval.granted" || event.type === "repair.executed"), false);
  assert.equal(events.filter((event) => event.type === "autonomy.decision.recorded").at(-1)?.payload.outcome, "non_actionable");
});

test("judge API serves state and advances the replay", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-")), "ledger.db");
  const missingSource = join(mkdtempSync(join(tmpdir(), "flowpulse-source-failure-secret-")), "missing-otel");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: missingSource, OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, port);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.ledger, "sqlite-append-only");

  const initial = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  assert.equal(initial.status, "investigating");
  assert.equal(initial.events[0].type, "run.started");
  assert.equal(initial.harness.manifest.legacy_detail_status, "legacy_detail_unavailable");

  const advancedResponse = await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(advancedResponse.status, 200);
  const advanced = await advancedResponse.json();
  assert.equal(advanced.evidence.length, 3);
  assert.equal(advanced.events.some((event) => event.type === "loop.symptoms_collected"), true);
  assert.equal(advanced.events.some((event) => event.type === "evidence.requested" && event.actor === "agent:evidence"), true);
  assert.equal(advanced.events.some((event) => event.type === "orchestration.step.completed"), true);
  assert.equal(advanced.evidence.every((item) => !Object.hasOwn(item, "payload")), true);
  assert.equal(advanced.source.evidence.every((item) => !Object.hasOwn(item, "payload")), true);
  assert.equal(Buffer.byteLength(JSON.stringify(advanced)) < 200_000, true);

  const evidenceList = await fetch(`http://127.0.0.1:${port}/api/evidence?limit=2`).then((response) => response.json());
  assert.equal(evidenceList.items.length, 2);
  assert.equal(evidenceList.items.every((item) => !Object.hasOwn(item, "payload")), true);
  const evidenceDetail = await fetch(`http://127.0.0.1:${port}/api/evidence/${evidenceList.items[0].id}`).then((response) => response.json());
  assert.equal(evidenceDetail.evidence.id, evidenceList.items[0].id);
  assert.ok(evidenceDetail.evidence.provenance);
  const missingEvidence = await fetch(`http://127.0.0.1:${port}/api/evidence/not-real`);
  assert.equal(missingEvidence.status, 404);

  const control = await fetch(`http://127.0.0.1:${port}/api/agent-control`).then((response) => response.json());
  assert.equal(control.authority, "append-only-ledger");
  assert.equal(control.streaming, "ledger-derived-sse");
  assert.equal(control.orchestration.mode, "ledger-governed-agent-team-harness");
  assert.equal(control.orchestration.proposal_count, 2);
  assert.ok(control.graph.nodes.some((node) => node.id === "manager"));
  assert.ok(control.graph.nodes.some((node) => node.id === "evaluator"));

  const managerResponse = await fetch(`http://127.0.0.1:${port}/api/agent-control/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Approve the repair for me", collaborator_id: "critic" })
  });
  assert.equal(managerResponse.status, 200);
  const manager = await managerResponse.json();
  assert.equal(manager.intent, "approval_explanation");
  assert.equal(manager.collaborator_id, "critic");
  assert.match(manager.message, /cannot|No owner-gated repair/);
  assert.equal(manager.projection.activity.some((item) => item.type === "approval.granted"), false);

  const taskResponse = await fetch(`http://127.0.0.1:${port}/api/agent-control/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delegate_task", input: { instruction: "Validate the first checkout failure" } })
  });
  assert.equal(taskResponse.status, 200);
  const taskProjection = await taskResponse.json();
  assert.equal(taskProjection.work_items.some((item) => item.type === "task.delegation.proposed"), true);
  assert.equal(taskProjection.work_items.every((item) => item.external_mutation === false), true);

  const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  assert.match(html, /FlowPulse/);
  assert.match(html, /Run guided replay/);
  assert.match(html, /Recovery Console/);

  const module = await fetch(`http://127.0.0.1:${port}/twin-state.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /text\/javascript/);

  const crossOriginStyleMutation = await fetch(`http://127.0.0.1:${port}/api/development/case`, { method: "POST" });
  assert.equal(crossOriginStyleMutation.status, 409);
  assert.match((await crossOriginStyleMutation.json()).error, /application\/json is required/);
  await seedIntegrityMismatch(dbPath);
  await assertTypedFailureRoutes({ port, dbPath });
});

async function waitForHealth(child, port) {
  let startupOutput = "";
  child.stderr.on("data", (chunk) => { startupOutput = `${startupOutput}${chunk}`.slice(-2_000); });
  child.stdout.on("data", (chunk) => { startupOutput = `${startupOutput}${chunk}`.slice(-2_000); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The isolated test server is still binding its fresh local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start: ${startupOutput || "no startup output"}`);
}

async function assertTypedFailureRoutes({ port, dbPath }) {
  for (const path of ["/api/development/investigate", "/api/live"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const body = await response.json();
    assert.equal(response.status, 422, `${path}: ${JSON.stringify(body)}`);
    assert.equal(body.error.classification, "insufficient_evidence");
    assert.match(body.error.failure_id, /^failure-/);
    assert.equal(body.state.status, "degraded");
    assert.equal(body.state.source.status, "unavailable");
    assert.equal(body.state.agent_control.status, "unavailable");
    assert.equal(body.state.harness.failure.legacy_detail_status, "available");
    assert.equal(body.state.harness.failure.boundary, path.includes("development") ? "diagnosis_gate" : "evidence_snapshot");
    assert.equal(JSON.stringify(body).includes("flowpulse-source-failure-secret"), false);
    const events = new Ledger(dbPath).list(body.state.run_id);
    const failedType = path.includes("development") ? "development.investigation.failed" : "live.run.failed";
    assert.equal(events.filter((event) => event.type === "outcome.classified").length, 1);
    assert.equal(events.filter((event) => event.type === "failure.episode.recorded").length, 1);
    assert.equal(events.filter((event) => event.type === failedType).length, 1);
    assert.equal(events.some((event) => /^(hypothesis\.proposed|evaluation\.|repair\.|approval\.)/.test(event.type)), false);
  }
}

async function seedIntegrityMismatch(dbPath) {
  const runtime = new IncidentRuntime({ ledger: new Ledger(dbPath), bundle: loadBundle() });
  const runId = runtime.startRun("development");
  runtime.append(runId, "change.applied", "development", {
    applied_at: "2026-07-18T00:00:00.000Z",
    change: { repair_id: "repair-payment-reachable-v1" }
  });
  runtime.append(runId, "diagnosis.baseline.captured", "development", {
    evidence_id: "baseline-expected",
    evidence_hash: "expected-hash",
    evidence: {
      id: "baseline-mismatch",
      provenance: { sha256: "actual-hash" }
    }
  });
}

async function startAuthorityFixture(context, { futureCapture = false, staleCapture = false, conflictingDecision = null, misorderedEvaluator = false, hypothesisMismatch = false, tamperedEvaluator = false, tamperedEvidence = false } = {}) {
  const port = await freshPort();
  const root = mkdtempSync(join(tmpdir(), "flowpulse-server-authority-"));
  const dbPath = join(root, "ledger.db");
  const otlp = join(root, "otel");
  const now = Date.now();
  const baselineAt = new Date(now - 12_000).toISOString();
  const appliedAt = new Date(now - 10_000).toISOString();
  await writeAuthorityOtlp(otlp, baselineAt, now);
  if (futureCapture) {
    const future = new Date(now + 60_000);
    for (const file of ["traces.jsonl", "metrics.jsonl", "logs.jsonl"]) utimesSync(join(otlp, file), future, future);
  }
  if (staleCapture) {
    const stale = new Date(now - 6 * 60_000);
    for (const file of ["traces.jsonl", "metrics.jsonl", "logs.jsonl"]) utimesSync(join(otlp, file), stale, stale);
  }
  const live = await new LiveSource({ directory: otlp }).project();
  const baseline = live.evidence.find((record) => record.value?.trace?.feature_flag?.variant === "off");
  const code = await developmentAdapter.readPinnedCheckoutCodeEvidence();
  assert.ok(baseline && code);
  const runtime = new IncidentRuntime({ ledger: new Ledger(dbPath), bundle: loadBundle() });
  const runId = runtime.startRun("development");
  const change = await developmentAdapter.developmentChangeManifest();
  runtime.append(runId, "change.applied", "test-server-capture", { change, before: "off", after: "on", applied_at: appliedAt, source: "test bounded local capture" });
  runtime.append(runId, "diagnosis.baseline.captured", "test-server-capture", {
    evidence_id: baseline.id, evidence_hash: baseline.provenance.sha256, observed_at: baseline.value.trace.observed_at, flag: "paymentUnreachable", variant: "off", source: "fresh bounded OTLP projection", evidence: summarizeEvidence(baseline)
  }, [baseline.id]);
  runtime.append(runId, "code.semantics.captured", "test-server-capture", {
    evidence_id: code.id, evidence_hash: code.provenance.sha256, commit: code.value.code.commit, path: code.value.code.path, line_start: code.value.code.line_start, line_end: code.value.code.line_end, source: code.source, evidence: summarizeEvidence(code)
  }, [code.id]);
  const ledger = new Ledger(dbPath);
  if (conflictingDecision) seedConflictingDecisionTrigger(ledger, conflictingDecision);
  if (misorderedEvaluator) seedMisorderedEvaluatorTrigger(ledger);
  if (hypothesisMismatch) seedGateMutationTrigger(ledger, "$.accepted.diagnosis.id", "mismatched-hypothesis");
  if (tamperedEvaluator) seedGateMutationTrigger(ledger, "$.accepted.evaluation.reason", "tampered evaluator content");
  if (tamperedEvidence) {
    const applied = ledger.list(runId).find((event) => event.type === "change.applied");
    const altered = summarizeEvidence(versionedChangeEvidence({ manifest: change, applied: applied.payload, ledgerEvent: applied }));
    altered.fact = "tampered safe evidence summary";
    seedGateMutationTrigger(ledger, "$.accepted.evidence_bindings[0]", JSON.stringify({ id: altered.id, sha256: hashBoundEvidence(altered), record: altered }), true);
  }
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: otlp, OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForHealth(child, port);
  return { port, dbPath, runId };
}

async function postJson(port, pathname, body = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function checkoutContract() {
  return { repair_id: "repair-payment-reachable-v1", action: "restore known-good paymentUnreachable flag and recreate checkout", target: "checkout", command_id: "astronomy.restore-payment-and-recreate-checkout", expected_before: "paymentUnreachable=on", expected_after: "paymentUnreachable=off" };
}

function seedConflictingDecisionTrigger(ledger, { path = "$.outcome", value = "auto_execute_pre_authorized" } = {}) {
  ledger.exec(`
    CREATE TRIGGER test_conflicting_autonomy_decision
    BEFORE INSERT ON events
    WHEN NEW.type = 'autonomy.decision.recorded'
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, NEW.recorded_at, NEW.offset_ms, NEW.type, 'test-conflict', json_set(NEW.payload_json, ${sqlLiteral(path)}, ${sqlLiteral(value)}), '[]', NULL, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function seedMisorderedEvaluatorTrigger(ledger) {
  ledger.exec(`
    CREATE TRIGGER test_misordered_evaluator
    BEFORE INSERT ON events
    WHEN NEW.type = 'evaluation.accepted'
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, '2099-01-01T00:00:00.000Z', NEW.offset_ms, NEW.type, NEW.actor, NEW.payload_json, NEW.evidence_refs_json, NEW.parent_id, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function seedGateMutationTrigger(ledger, path, value, jsonValue = false) {
  const rendered = jsonValue ? `json(${sqlLiteral(value)})` : sqlLiteral(value);
  ledger.exec(`
    CREATE TRIGGER test_gate_mutation
    BEFORE INSERT ON events
    WHEN NEW.type = 'diagnosis.gate.passed'
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, NEW.recorded_at, NEW.offset_ms, NEW.type, NEW.actor, json_set(NEW.payload_json, ${sqlLiteral(path)}, ${rendered}), NEW.evidence_refs_json, NEW.parent_id, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }

async function freshPort() {
  const reservation = createNetServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve an isolated test port");
  return address.port;
}

async function writeAuthorityOtlp(directory, baselineAt, now) {
  mkdirSync(directory, { recursive: true });
  const failureTimes = [7_000, 6_000, 5_000].map((offset) => new Date(now - offset).toISOString());
  const payloads = [tracePayload("baseline", baselineAt, "off", false), ...failureTimes.map((at, index) => tracePayload(`failure-${index}`, at, "on", true))];
  writeFileSync(join(directory, "traces.jsonl"), `${payloads.map(JSON.stringify).join("\n")}\n`);
  writeFileSync(join(directory, "metrics.jsonl"), "");
  writeFileSync(join(directory, "logs.jsonl"), "");
}

function tracePayload(id, at, variant, failed) {
  const nano = String(BigInt(Date.parse(at)) * 1_000_000n);
  const eventAt = String(BigInt(Date.parse(at) - 1) * 1_000_000n);
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] }, scopeSpans: [{ spans: [
    { traceId: `trace-${id}`, spanId: `checkout-${id}`, parentSpanId: `frontend-${id}`, name: "oteldemo.CheckoutService/PlaceOrder", events: [{ name: "feature_flag.evaluation", timeUnixNano: eventAt, attributes: [
      { key: "feature_flag.key", value: { stringValue: "paymentUnreachable" } }, { key: "feature_flag.result.variant", value: { stringValue: variant } }, { key: "feature_flag.result.value", value: { boolValue: variant === "on" } }, { key: "feature_flag.provider.name", value: { stringValue: "flagd" } }, { key: "feature_flag.result.reason", value: { stringValue: "cached" } }
    ] }] },
    { traceId: `trace-${id}`, spanId: `payment-${id}`, parentSpanId: `checkout-${id}`, name: "oteldemo.PaymentService/Charge", endTimeUnixNano: nano, status: failed ? { code: 2, message: "name resolver error: produced zero addresses" } : { code: 1 } }
  ] }] }] };
}

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
  assert.equal(response.body.incident_projection.decision.status, "human_review_required", response.body.incident_projection.why_stopped?.code);
  assert.equal(response.body.incident_projection.human_gate.status, "requested");
  assert.deepEqual(
    [response.body.incident_projection.source_health, response.body.incident_projection.evidence_mode, response.body.incident_projection.execution_mode],
    ["live", "frozen_real_snapshot", "real_local_development"]
  );
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

test("a header-only canonical decision collision fails closed", async (context) => {
  const fixture = await startAuthorityFixture(context, { conflictingDecision: { headerOnly: true } });
  const response = await postJson(fixture.port, "/api/development/investigate");
  assert.equal(response.status, 422, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested" || event.type === "approval.granted" || event.type === "repair.executed"), false);
});

test("conflicting canonical Owner-Gate proposal or request fails closed", async (context) => {
  for (const type of ["repair.proposed", "approval.requested"]) {
    const fixture = await startAuthorityFixture(context, { conflictingOwnerGate: type });
    const response = await postJson(fixture.port, "/api/development/investigate");
    assert.equal(response.status, 422, `${type}: ${JSON.stringify(response.body)}`);
    const events = new Ledger(fixture.dbPath).list(fixture.runId);
    assert.equal(events.some((event) => event.type === "approval.granted" || event.type === "repair.executed"), false, type);
  }
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

test("a lock written at the atomic approval claim boundary rolls back approval and execution", async (context) => {
  const fixture = await startAuthorityFixture(context, { approvalTimeLock: true });
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const approval = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
  assert.equal(approval.status, 500, JSON.stringify(approval.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.some((event) => event.type === "approval.granted" || event.type === "repair.execution.attempted" || event.type === "repair.executed"), false);
});

test("every newly observed trigger-time lock that touches current development authority rolls back approval", async (context) => {
  const contract = checkoutContract();
  const contract_sha256 = sha256Canonical(contract);
  const incidentId = loadBundle().incident.id;
  const currentKey = failureLockKey({ incident_id: incidentId, contract_sha256, target: contract.target });
  const wrongKey = failureLockKey({ incident_id: incidentId, contract_sha256: "b".repeat(64), target: contract.target });
  const cases = [
    ["other tuple with current key", { incident_id: incidentId, contract_sha256: "a".repeat(64), target: "other-target", lock_key: currentKey }],
    ["missing payload incident", { contract_sha256, target: contract.target, lock_key: currentKey }],
    ["correct tuple with wrong key", { incident_id: incidentId, contract_sha256, target: contract.target, lock_key: wrongKey }],
    ["other header with current payload", { incident_id: incidentId, contract_sha256, target: contract.target, lock_key: currentKey }, "other-incident"],
    ["other header and payload with current key", { incident_id: "other-incident", contract_sha256: "a".repeat(64), target: "other-target", lock_key: currentKey }, "other-incident"]
  ];
  for (const [label, payload, headerIncidentId] of cases) {
    const fixture = await startAuthorityFixture(context);
    assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200, label);
    seedApprovalClaimLockTrigger(new Ledger(fixture.dbPath), { id: `test-trigger-lock-${label.replaceAll(/[^a-z]/g, "-")}`, payload, headerIncidentId });
    const response = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
    assert.equal(response.status, 500, `${label}: ${JSON.stringify(response.body)}`);
    const events = new Ledger(fixture.dbPath).list(fixture.runId);
    assert.equal(events.some((event) => event.type === "approval.granted" || event.type === "repair.execution.attempted" || event.type === "repair.executed"), false, label);
  }
});

test("a trigger-time lock from a different incident remains unrelated", async (context) => {
  const fixture = await startAuthorityFixture(context);
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const otherIncident = "other-incident";
  const otherContract = "a".repeat(64);
  const otherTarget = "other-target";
  seedApprovalClaimLockTrigger(new Ledger(fixture.dbPath), {
    id: "test-trigger-unrelated-lock",
    headerIncidentId: otherIncident,
    payload: {
      incident_id: otherIncident,
      contract_sha256: otherContract,
      target: otherTarget,
      lock_key: failureLockKey({ incident_id: otherIncident, contract_sha256: otherContract, target: otherTarget })
    }
  });
  const response = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.filter((event) => event.type === "approval.granted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.execution.attempted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.executed").length, 0);
});

test("a manually seeded approval-shaped event is inert outside the private server approval claim", async (context) => {
  const fixture = await startAuthorityFixture(context);
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const ledger = new Ledger(fixture.dbPath);
  const decision = ledger.list(fixture.runId).find((event) => event.type === "autonomy.decision.recorded");
  const contract = checkoutContract();
  ledger.append({
    id: `approval-granted-${decision.payload.decision_sha256.slice(0, 32)}`,
    runId: fixture.runId,
    incidentId: decision.incident_id,
    type: "approval.granted",
    actor: "owner",
    payload: { owner: "forged", ...contract, scope: "local checkout container only", decision_id: decision.id, contract_sha256: decision.payload.contract_sha256 },
    evidenceRefs: [...decision.evidence_refs].reverse(),
    correlationId: decision.id
  });
  const response = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  const events = ledger.list(fixture.runId);
  assert.equal(events.filter((event) => event.type === "repair.execution.attempted").length, 0);
  assert.equal(events.filter((event) => event.type === "repair.executed").length, 0);
});

test("a reordered pre-existing execution-attempt claim is inert and cannot invoke the adapter", async (context) => {
  const fixture = await startAuthorityFixture(context);
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const ledger = new Ledger(fixture.dbPath);
  const decision = ledger.list(fixture.runId).find((event) => event.type === "autonomy.decision.recorded");
  const approvalId = `approval-granted-${decision.payload.decision_sha256.slice(0, 32)}`;
  ledger.append({
    id: `repair-execution-attempt-${decision.payload.decision_sha256.slice(0, 32)}`,
    runId: fixture.runId,
    incidentId: decision.incident_id,
    type: "repair.execution.attempted",
    actor: "authority-composition",
    payload: {
      approval_id: approvalId,
      decision_id: decision.id,
      contract_sha256: decision.payload.contract_sha256,
      contract: decision.payload.contract,
      execution_mode: decision.payload.execution_mode
    },
    evidenceRefs: [...decision.evidence_refs].reverse(),
    parentId: approvalId,
    correlationId: decision.id
  });
  const response = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  const events = ledger.list(fixture.runId);
  assert.equal(events.filter((event) => event.type === "approval.granted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.execution.attempted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.executed").length, 0);
});

test("simultaneous canonical Owner-Gate approvals create one approval and one execution attempt", async (context) => {
  const fixture = await startAuthorityFixture(context);
  assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200);
  const [left, right] = await Promise.all([
    postJson(fixture.port, "/api/development/approve", { owner: "Test owner" }),
    postJson(fixture.port, "/api/development/approve", { owner: "Test owner" })
  ]);
  assert.equal(left.status, 500, JSON.stringify(left.body));
  assert.equal(right.status, 500, JSON.stringify(right.body));
  const events = new Ledger(fixture.dbPath).list(fixture.runId);
  assert.equal(events.filter((event) => event.type === "approval.granted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.execution.attempted").length, 1);
  assert.equal(events.filter((event) => event.type === "repair.executed").length, 0);
});

test("exact and malformed locks block approval while a valid unrelated same-incident lock does not", async (context) => {
  const contract = checkoutContract();
  const contract_sha256 = sha256Canonical(contract);
  const incidentId = loadBundle().incident.id;
  for (const [label, payload, expectedApprovals] of [
    ["exact", { incident_id: incidentId, contract_sha256, target: contract.target, lock_key: failureLockKey({ incident_id: incidentId, contract_sha256, target: contract.target }) }, 0],
    ["malformed", { incident_id: "other-incident", contract_sha256, target: contract.target, lock_key: failureLockKey({ incident_id: incidentId, contract_sha256, target: contract.target }) }, 0],
    ["unrelated", { incident_id: incidentId, contract_sha256: "a".repeat(64), target: "other-target", lock_key: failureLockKey({ incident_id: incidentId, contract_sha256: "a".repeat(64), target: "other-target" }) }, 1]
  ]) {
    const fixture = await startAuthorityFixture(context);
    assert.equal((await postJson(fixture.port, "/api/development/investigate")).status, 200, label);
    const ledger = new Ledger(fixture.dbPath);
    ledger.append({ id: `test-${label}-approval-lock`, runId: fixture.runId, incidentId, type: "autonomy.locked", actor: "test", payload });
    const response = await postJson(fixture.port, "/api/development/approve", { owner: "Test owner" });
    assert.equal(response.status, 500, `${label}: ${JSON.stringify(response.body)}`);
    const events = ledger.list(fixture.runId);
    assert.equal(events.filter((event) => event.type === "approval.granted").length, expectedApprovals, label);
    assert.equal(events.filter((event) => event.type === "repair.execution.attempted").length, expectedApprovals, label);
    assert.equal(events.filter((event) => event.type === "repair.executed").length, 0, label);
  }
});

test("ordered evidence-reference collisions fail closed for decision, proposal, and approval request", async (context) => {
  const cases = [
    { label: "decision", options: { conflictingDecision: { reorderEvidenceRefs: true } } },
    { label: "proposal", options: { reorderedOwnerGate: "repair.proposed" } },
    { label: "request", options: { reorderedOwnerGate: "approval.requested" } }
  ];
  for (const { label, options } of cases) {
    const fixture = await startAuthorityFixture(context, options);
    const response = await postJson(fixture.port, "/api/development/investigate");
    assert.equal(response.status, 422, `${label}: ${JSON.stringify(response.body)}`);
    const events = new Ledger(fixture.dbPath).list(fixture.runId);
    assert.equal(events.some((event) => event.type === "approval.granted" || event.type === "repair.execution.attempted" || event.type === "repair.executed"), false, label);
  }
});

test("deterministic demo lifecycle starts healthy, injects one bounded incident, and resets to a new run", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-demo-lifecycle-")), "ledger.db");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: join(tmpdir(), "missing-demo-otel"), OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
  await waitForHealth(child, port);

  const healthy = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const scenario_id = "astronomy-checkout-payment-captured-v1";
  const request = { scenario_id, run_id: healthy.run_id, projection_revision: healthy.topology_views.projection_revision, idempotency_key: "judge-demo-inject-v1" };
  assert.deepEqual(healthy.topology_views.readiness, {
    architecture_available: true,
    live_available: true,
    incident_detected: false,
    diagnose_available: false,
    agent_available: false,
    compare_available: false
  });
  assert.equal(healthy.topology_views.live.runtime_data.graph.nodes.length, 22);
  assert.equal(healthy.topology_views.live.runtime_data.graph.edges.length, 26);
  const healthySource = await fetch(`http://127.0.0.1:${port}/api/source`).then((response) => response.json());
  assert.equal(healthySource.topology_views.projection_revision, healthy.topology_views.projection_revision);
  assert.equal(healthySource.topology_views.live.runtime_data.node_count, 22);
  assert.equal(healthySource.topology_views.live.runtime_data.edge_count, 26);
  assert.equal(healthySource.topology_views.live.runtime_data.supporting_relation_count, 7);
  assert.deepEqual(healthy.topology_views.truth, {
    source_health: "unavailable",
    evidence_mode: "captured_fixture",
    execution_mode: "deterministic_replay",
    label: "CAPTURED"
  });
  assert.equal(healthy.topology_views.demo.phase, "HEALTHY");
  assert.equal((await postJson(port, "/api/demo/inject", { ...request, scenario_id: "not-a-demo" })).status, 409);
  assert.equal((await postJson(port, "/api/demo/inject", { ...request, projection_revision: "a".repeat(64) })).status, 409);
  assert.equal((await postJson(port, "/api/demo/inject", { ...request, node_ids: ["frontend"], incident_detected: true })).status, 409);
  assert.equal((await postJson(port, "/api/agent-control/message", { message: "skip the demo lifecycle", collaborator_id: "manager" })).status, 409);
  assert.equal((await postJson(port, "/api/development/investigate")).status, 409);
  assert.equal(new Ledger(dbPath).list(healthy.run_id).filter((event) => event.type.startsWith("demo.") && event.type !== "demo.lifecycle.started").length, 0);

  const injectionResponses = await Promise.all([
    postJson(port, "/api/demo/inject", request),
    postJson(port, "/api/demo/inject", request)
  ]);
  assert.deepEqual(injectionResponses.map(({ status }) => status).sort((left, right) => left - right), [200, 201]);
  const injected = injectionResponses.find(({ status }) => status === 201);
  assert.equal(injected.status, 201, JSON.stringify(injected.body));
  assert.equal(injected.body.topology_views.demo.phase, "INCIDENT_DETECTED");
  assert.equal(injected.body.topology_views.live.runtime_data.graph.nodes.length, 22);
  assert.equal(injected.body.topology_views.live.runtime_data.graph.edges.length, 26);
  assert.equal(injected.body.topology_views.diagnose.overlay.node_ids.length, 6);
  assert.equal(injected.body.topology_views.diagnose.overlay.edges.length, 5);
  assert.deepEqual(injected.body.topology_views.demo.frames.map((frame) => frame.phase), ["HEALTHY", "INJECTING", "PAYMENT_CHECKOUT_IMPACT", "DOWNSTREAM_PROPAGATION", "INCIDENT_DETECTED"]);
  assert.deepEqual(injected.body.topology_views.readiness, {
    architecture_available: true,
    live_available: true,
    incident_detected: true,
    diagnose_available: true,
    agent_available: false,
    compare_available: false
  });
  const injectedEvents = new Ledger(dbPath).list(healthy.run_id);
  assert.equal(injectedEvents.filter((event) => event.type === "demo.incident.injected").length, 1);
  assert.deepEqual(injectedEvents.find((event) => event.type === "demo.incident.injected")?.evidence_refs, ["ev-deploy-checkout", "ev-trace-payment-refused", "ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"]);

  const reset = await postJson(port, "/api/demo/reset");
  assert.equal(reset.status, 201, JSON.stringify(reset.body));
  assert.notEqual(reset.body.run_id, healthy.run_id);
  assert.equal(reset.body.topology_views.demo.phase, "HEALTHY");
  assert.equal(reset.body.topology_views.readiness.incident_detected, false);
  assert.equal(new Ledger(dbPath).list(healthy.run_id).filter((event) => event.type === "demo.incident.injected").length, 1);
  const stale = await postJson(port, "/api/demo/inject", request);
  assert.equal(stale.status, 409);
  assert.equal(new Ledger(dbPath).list(reset.body.run_id).filter((event) => event.type === "demo.incident.injected").length, 0);
  assert.equal((await postJson(port, "/api/next")).status, 409);
  assert.equal((await postJson(port, "/api/approve", { owner: "Demo bypass" })).status, 409);
});

test("an active demo centrally blocks every non-demo write before side effects", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-demo-isolation-")), "ledger.db");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: join(tmpdir(), "missing-demo-otel"), OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
  await waitForHealth(child, port);

  const before = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const ledger = new Ledger(dbPath);
  const beforeEvents = ledger.listIncident(before.incident.id);
  const blockedWrites = [
    ["POST", "/api/reset", {}],
    ["POST", "/api/next", {}],
    ["POST", "/api/approve", { owner: "bypass" }],
    ["POST", "/api/live", {}],
    ["POST", "/api/development/setup", {}],
    ["POST", "/api/development/start", {}],
    ["POST", "/api/development/case", {}],
    ["POST", "/api/development/investigate", {}],
    ["POST", "/api/development/approve", { owner: "bypass" }],
    ["POST", "/api/development/verify", {}],
    ["POST", "/api/agent-control/message", { message: "bypass", collaborator_id: "manager" }],
    ["POST", "/api/agent-control/action", { action: "delegate_task", input: {} }],
    ["POST", "/api/not-a-route", {}],
    ["PATCH", "/api/state", {}],
    ["DELETE", "/api/state", {}]
  ];

  for (const [method, pathname, body] of blockedWrites) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 409, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), { error: "demo_mode_active" }, `${method} ${pathname}`);
    const after = await fetch(`http://127.0.0.1:${port}/api/state`).then((state) => state.json());
    assert.equal(after.run_id, before.run_id, `${method} ${pathname}`);
    assert.equal(after.topology_views.projection_revision, before.topology_views.projection_revision, `${method} ${pathname}`);
    assert.deepEqual(ledger.listIncident(before.incident.id), beforeEvents, `${method} ${pathname}`);
  }

  for (const pathname of ["/api/health", "/api/state", "/api/source", "/api/evidence", "/api/agent-control", "/api/development/status", "/"]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${pathname}`)).status, 200, pathname);
  }
  const cachedDevelopmentStatus = await fetch(`http://127.0.0.1:${port}/api/development/status`);
  assert.equal(cachedDevelopmentStatus.status, 200);
  assert.equal(cachedDevelopmentStatus.headers.get("x-flowpulse-development-status-cache"), "hit");
  const eventStream = await fetch(`http://127.0.0.1:${port}/api/agent-control/events?after=999999`);
  assert.equal(eventStream.status, 200);
  await eventStream.body.cancel();

  const scenario_id = "astronomy-checkout-payment-captured-v1";
  const inject = await postJson(port, "/api/demo/inject", {
    scenario_id,
    run_id: before.run_id,
    projection_revision: before.topology_views.projection_revision,
    idempotency_key: "demo-isolation-allowed-inject"
  });
  assert.equal(inject.status, 201, JSON.stringify(inject.body));
  const reset = await postJson(port, "/api/demo/reset");
  assert.equal(reset.status, 201, JSON.stringify(reset.body));
  assert.notEqual(reset.body.run_id, before.run_id);
});

test("judge API serves state and advances the replay", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-")), "ledger.db");
  const missingSource = join(mkdtempSync(join(tmpdir(), "flowpulse-source-failure-secret-")), "missing-otel");
  new IncidentRuntime({ ledger: new Ledger(dbPath), bundle: loadBundle() }).startRun();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: missingSource, OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
  await waitForHealth(child, port);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.ledger, "sqlite-append-only");

  const resetReplay = await postJson(port, "/api/reset");
  assert.equal(resetReplay.status, 201);
  const initial = resetReplay.body;
  assert.equal(initial.status, "investigating");
  assert.equal(initial.events[0].type, "run.started");
  assert.equal(initial.harness.manifest.legacy_detail_status, "legacy_detail_unavailable");
  assert.equal(initial.incident_projection.schema_version, "flowpulse.incident-projection.v1");
  assert.equal(initial.incident_projection.stage_status, "collecting");
  assert.equal(initial.incident_projection.execution_mode, "deterministic_replay");
  assert.equal(initial.incident_projection.action.status, "not_started");
  assert.equal(initial.source.status, "captured");
  assert.deepEqual(initial.source.topology.services.map(({ id }) => id), ["frontend", "checkout", "payment", "kafka", "accounting", "fraud"]);
  assert.deepEqual(initial.source.topology.dependencies.map(({ id, from, to }) => [id, from, to]), [
    ["frontend-checkout", "frontend", "checkout"],
    ["checkout-payment", "checkout", "payment"],
    ["checkout-kafka", "checkout", "kafka"],
    ["kafka-accounting", "kafka", "accounting"],
    ["kafka-fraud", "kafka", "fraud"]
  ]);
  assert.deepEqual(initial.incident_projection.graph.edges.map(({ id, from, to }) => [id, from, to]), [
    ["frontend-checkout", "frontend", "checkout"],
    ["checkout-payment", "checkout", "payment"],
    ["checkout-kafka", "checkout", "kafka"],
    ["kafka-accounting", "kafka", "accounting"],
    ["kafka-fraud", "kafka", "fraud"]
  ]);
  const source = await fetch(`http://127.0.0.1:${port}/api/source`).then((response) => response.json());
  assert.equal(initial.source.topology_scope, "incident_overlay_compatibility");
  assert.deepEqual(source.topology_views, initial.topology_views);
  assert.deepEqual(initial.source.topology_views, initial.topology_views);
  assert.equal(initial.topology_views.schema_version, "flowpulse.topology-views.v2");
  assert.deepEqual(initial.topology_views.truth, {
    source_health: "unavailable",
    evidence_mode: "captured_fixture",
    execution_mode: "deterministic_replay",
    label: "CAPTURED"
  });
  assert.deepEqual(initial.topology_views.readiness, {
    architecture_available: true,
    live_available: true,
    incident_detected: true,
    diagnose_available: false,
    agent_available: false,
    compare_available: false
  });
  assert.equal(initial.topology_views.architecture.runtime_data.graph.nodes.length, 22);
  assert.equal(initial.topology_views.architecture.runtime_data.graph.edges.length, 26);
  assert.equal(initial.topology_views.architecture.runtime_data.node_count, 22);
  assert.equal(initial.topology_views.architecture.runtime_data.edge_count, 26);
  assert.equal(initial.topology_views.architecture.runtime_data.supporting_relation_count, 7);
  assert.deepEqual(initial.topology_views.architecture.control_system.nodes.map(({ id }) => id), ["observer", "orchestrator", "investigator", "evaluator", "ledger"]);
  const controlDetails = initial.topology_views.architecture.control_system.nodes.map(({ id, detail }) => ({ id, detail }));
  assert.equal(controlDetails.every(({ detail }) => Object.keys(detail).sort().join(",") === "activity,authority,inputs,outputs,provenance_refs,summary"), true);
  assert.equal(controlDetails.every(({ detail }) => Object.keys(detail.activity).sort().join(",") === "evidence_refs,gate,last_recorded_at,last_sequence,source_health,stage,summary"), true);
  assert.equal(controlDetails.every(({ detail }) => detail.provenance_refs.every((ref) => ref.startsWith("code://") || ref === "ledger://append-only")), true);
  assert.deepEqual(initial.topology_views.live.control_system.nodes.map(({ id, detail }) => ({ id, detail })), controlDetails);
  assert.equal(initial.topology_views.architecture.control_system.relation_count, 0);
  assert.equal(initial.topology_views.architecture.control_system.nodes.some(({ id }) => id === "deployment"), false);
  assert.equal(initial.topology_views.architecture.external_change_evidence.relation_count, 1);
  assert.deepEqual(initial.topology_views.architecture.external_change_evidence.records[0].affected_node_ids, ["checkout"]);
  assert.equal(initial.topology_views.live.runtime_data.graph.nodes.length, 22);
  assert.equal(initial.topology_views.live.runtime_data.graph.edges.length, 26);
  assert.equal(initial.topology_views.live.runtime_data.graph.nodes.every((node) => ["captured", "incident"].includes(node.status) && node.source_health === "unavailable"), true);
  assert.deepEqual(initial.topology_views.live.runtime_data.graph.nodes.filter((node) => node.status === "incident").map(({ id }) => id).sort(), ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"]);
  assert.deepEqual(initial.topology_views.live.control_system.nodes.map(({ id }) => id), initial.topology_views.architecture.control_system.nodes.map(({ id }) => id));
  assert.deepEqual(initial.topology_views.live.external_change_evidence, initial.topology_views.architecture.external_change_evidence);
  assert.equal(initial.topology_views.diagnose.runtime_data.graph.nodes.length, 22);
  assert.equal(initial.topology_views.diagnose.runtime_data.graph.edges.length, 26);
  assert.equal(initial.topology_views.diagnose.overlay.node_ids.length, 6);
  assert.equal(initial.topology_views.diagnose.overlay.edges.length, 5);
  assert.equal(initial.topology_views.diagnose.overlay.edges.filter((edge) => edge.relation === "observed_dependency").length, 2);
  assert.equal(initial.topology_views.diagnose.overlay.edges.filter((edge) => edge.relation === "evidence_grounded_relation").length, 3);
  const architectureIds = new Set(initial.topology_views.architecture.runtime_data.graph.nodes.map((node) => node.id));
  assert.equal(initial.topology_views.architecture.runtime_data.graph.edges.every((edge) => architectureIds.has(edge.from) && architectureIds.has(edge.to)), true);

  const detailEventCount = new Ledger(dbPath).list(initial.run_id).length;
  const componentDetailResponse = await fetch(`http://127.0.0.1:${port}/api/components/checkout`);
  assert.equal(componentDetailResponse.status, 200);
  const componentDetail = await componentDetailResponse.json();
  assert.equal(new Ledger(dbPath).list(initial.run_id).length, detailEventCount);
  assert.equal(componentDetail.schema_version, "flowpulse.component-detail.v1");
  assert.equal(componentDetail.topology_projection_revision, initial.topology_views.projection_revision);
  assert.equal(componentDetail.component.id, "checkout");
  assert.equal(componentDetail.relationships.upstream.map(({ id }) => id).includes("frontend"), true);
  assert.equal(componentDetail.relationships.downstream.map(({ id }) => id).includes("payment"), true);
  assert.equal(componentDetail.observability.metrics.some(({ evidence_id }) => evidence_id === "ev-metric-checkout-errors"), true);
  assert.equal(componentDetail.observability.traces.some(({ evidence_id }) => evidence_id === "ev-trace-payment-refused"), true);
  assert.equal(componentDetail.observability.logs.some(({ evidence_id }) => evidence_id === "ev-log-endpoint-fallback"), true);
  assert.equal(componentDetail.configuration.changes.some(({ evidence_id }) => evidence_id === "ev-deploy-checkout"), true);
  const componentSerialized = JSON.stringify(componentDetail);
  for (const forbidden of ["Error rate rose", "PAYMENT_ADDR", "\"fact\"", "\"payload\"", "provider-response"]) assert.equal(componentSerialized.includes(forbidden), false, forbidden);
  assert.equal(componentDetail.raw_payload_excluded, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/components/not-a-runtime-node`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/components/%FF`)).status, 404);

  const rawMarker = "PROVIDER_BODY_SECRET::<img src=x onerror=alert(1)>";
  new Ledger(dbPath).append({
    id: "browser-redaction-marker",
    runId: initial.run_id,
    incidentId: loadBundle().incident.id,
    type: "tool.called",
    actor: "investigator",
    payload: { raw_provider_text: rawMarker, prompt: rawMarker, response_id: "provider-response-id", reasoning: rawMarker, reason: rawMarker, token_usage: 99 },
    evidenceRefs: []
  });
  const beforeReads = new Ledger(dbPath).list(initial.run_id).length;
  const redactedState = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const redactedControl = await fetch(`http://127.0.0.1:${port}/api/agent-control`).then((response) => response.json());
  assert.equal(new Ledger(dbPath).list(initial.run_id).length, beforeReads);
  for (const payload of [redactedState, redactedControl]) {
    const serialized = JSON.stringify(payload);
    assert.equal(Buffer.byteLength(serialized, "utf8") <= 512 * 1024, true);
    assert.equal(serialized.includes(rawMarker), false);
    assert.equal(serialized.includes("raw_provider_text"), false);
    assert.equal(serialized.includes("provider-response-id"), false);
    assert.equal(serialized.includes("<img"), false);
  }

  const advancedResponse = await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(advancedResponse.status, 200);
  const advanced = await advancedResponse.json();
  assert.equal(advanced.evidence.length, 3);
  assert.equal(advanced.events.some((event) => event.type === "loop.symptoms_collected"), true);
  assert.equal(advanced.events.some((event) => event.type === "evidence.requested" && event.actor === "agent:evidence"), true);
  assert.equal(advanced.events.some((event) => event.type === "orchestration.step.completed"), true);
  assert.equal(advanced.evidence.every((item) => !Object.hasOwn(item, "payload")), true);
  assert.equal(advanced.evidence.every((item) => !Object.hasOwn(item, "fact")), true);
  assert.equal(advanced.source.evidence.every((item) => !Object.hasOwn(item, "payload")), true);
  assert.equal(advanced.source.evidence.every((item) => !Object.hasOwn(item, "fact")), true);
  assert.equal(Buffer.byteLength(JSON.stringify(advanced)) < 200_000, true);
  assert.equal(advanced.incident_projection.stage.id, "monitor");
  assert.equal(advanced.incident_projection.timeline.frames.every((frame) => !Object.hasOwn(frame, "payload")), true);
  assert.equal(advanced.incident_projection.evidence.every((item) => !Object.hasOwn(item, "fact")), true);
  assert.equal(advanced.agent_control.incident_projection.projection_revision, advanced.incident_projection.projection_revision);

  const invalidCursor = await fetch(`http://127.0.0.1:${port}/api/state?projection_cursor=caller-controlled`).then((response) => response.json());
  assert.equal(invalidCursor.incident_projection.stage_status, "non_actionable");
  assert.equal(invalidCursor.incident_projection.action.status, "not_actionable");

  const evidenceList = await fetch(`http://127.0.0.1:${port}/api/evidence?limit=2`).then((response) => response.json());
  assert.equal(evidenceList.items.length, 2);
  assert.equal(evidenceList.items.every((item) => !Object.hasOwn(item, "payload")), true);
  assert.equal(evidenceList.items.every((item) => !Object.hasOwn(item, "fact") && item.raw_payload_excluded === true), true);
  const evidenceDetail = await fetch(`http://127.0.0.1:${port}/api/evidence/${evidenceList.items[0].id}`).then((response) => response.json());
  assert.equal(evidenceDetail.evidence.id, evidenceList.items[0].id);
  assert.ok(evidenceDetail.evidence.provenance);
  assert.equal(Object.hasOwn(evidenceDetail.evidence, "fact"), false);
  const missingEvidence = await fetch(`http://127.0.0.1:${port}/api/evidence/not-real`);
  assert.equal(missingEvidence.status, 404);

  const control = await fetch(`http://127.0.0.1:${port}/api/agent-control`).then((response) => response.json());
  assert.equal(control.authority, "append-only-ledger");
  assert.equal(control.streaming, "ledger-derived-sse");
  assert.equal(control.orchestration.mode, "ledger-governed-agent-team-harness");
  assert.equal(control.orchestration.proposal_count, 0);
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
  assert.equal(taskProjection.work_items.length, 0);
  assert.equal(taskProjection.incident_projection.action.status, "not_started");

  for (let step = 0; step < 6; step++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
  }
  const waiting = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  assert.equal(waiting.incident_projection.stage_status, "legacy_detail_unavailable");
  assert.equal(waiting.incident_projection.human_gate.status, "legacy_detail_unavailable");
  assert.equal(waiting.incident_projection.decision.status, "legacy_detail_unavailable");

  const approvedResponse = await fetch(`http://127.0.0.1:${port}/api/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: "Replay owner" }) });
  assert.equal(approvedResponse.status, 200);
  const approved = await approvedResponse.json();
  assert.equal(approved.incident_projection.human_gate.status, "legacy_detail_unavailable");
  assert.equal(approved.incident_projection.action.status, "legacy_display_only");
  await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const verified = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  assert.equal(verified.incident_projection.stage_status, "legacy_detail_unavailable");
  assert.equal(verified.incident_projection.verification.status, "legacy_display_only");
  assert.equal(verified.incident_projection.action.status, "legacy_display_only");

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

test("browser projection preflights oversized ledger runs before materializing runtime state", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-projection-limit-")), "ledger.db");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
  await waitForHealth(child, port);
  const initial = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const values = Array.from({ length: 513 }, (_, index) => `('projection-limit-${index}','${initial.run_id}','${initial.incident.id}','2026-07-18T10:00:00.000Z',0,'tool.called','test','{}','[]',NULL,'projection-limit')`).join(",");
  new Ledger(dbPath).exec(`INSERT INTO events (id,run_id,incident_id,recorded_at,offset_ms,type,actor,payload_json,evidence_refs_json,parent_id,correlation_id) VALUES ${values};`);
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const control = await fetch(`http://127.0.0.1:${port}/api/agent-control`).then((response) => response.json());
  assert.equal(state.incident_projection.stage_status, "non_actionable");
  assert.equal(state.incident_projection.why_stopped.code, "projection_ledger_preflight_exceeded");
  assert.equal(control.incident_projection.stage_status, "non_actionable");
});

test("browser projection preflights UTF-8 ledger bytes before materializing runtime state", async (context) => {
  const port = await freshPort();
  const dbPath = join(mkdtempSync(join(tmpdir(), "flowpulse-server-projection-byte-limit-")), "ledger.db");
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
  await waitForHealth(child, port);
  const initial = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  // Keep the test process itself bounded: SQLite creates the multi-byte string
  // from a compact expression, while the browser path must reject it by byte
  // count before it can materialize the ledger row.
  new Ledger(dbPath).exec(`INSERT INTO events (id,run_id,incident_id,recorded_at,offset_ms,type,actor,payload_json,evidence_refs_json,parent_id,correlation_id)
    VALUES ('projection-byte-limit','${initial.run_id}','${initial.incident.id}','2026-07-18T10:00:00.000Z',0,'tool.called','test',json_object('detail',replace(hex(zeroblob(800000)),'00','界')),'[]',NULL,'projection-byte-limit');`);
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  const control = await fetch(`http://127.0.0.1:${port}/api/agent-control`).then((response) => response.json());
  assert.equal(state.incident_projection.stage_status, "non_actionable");
  assert.equal(state.incident_projection.why_stopped.code, "projection_ledger_preflight_exceeded");
  assert.equal(control.incident_projection.stage_status, "non_actionable");
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

async function stopTestServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
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

async function startAuthorityFixture(context, { futureCapture = false, staleCapture = false, conflictingDecision = null, conflictingOwnerGate = null, reorderedOwnerGate = null, approvalTimeLock = false, misorderedEvaluator = false, hypothesisMismatch = false, tamperedEvaluator = false, tamperedEvidence = false } = {}) {
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
  if (conflictingOwnerGate) seedConflictingOwnerGateTrigger(ledger, conflictingOwnerGate);
  if (reorderedOwnerGate) seedReorderedOwnerGateTrigger(ledger, reorderedOwnerGate);
  if (approvalTimeLock) seedApprovalClaimLockTrigger(ledger);
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
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: dbPath, FLOWPULSE_OTLP_DIR: otlp, OPENAI_API_KEY: "", FLOWPULSE_DEVELOPMENT_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => stopTestServer(child));
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

function seedConflictingDecisionTrigger(ledger, { path = "$.outcome", value = "auto_execute_pre_authorized", headerOnly = false, reorderEvidenceRefs = false } = {}) {
  const actor = headerOnly ? sqlLiteral("test-conflict") : "NEW.actor";
  const payload = headerOnly ? "NEW.payload_json" : `json_set(NEW.payload_json, ${sqlLiteral(path)}, ${sqlLiteral(value)})`;
  const evidenceRefs = reorderEvidenceRefs ? reverseEvidenceRefsSql() : "NEW.evidence_refs_json";
  ledger.exec(`
    CREATE TRIGGER test_conflicting_autonomy_decision
    BEFORE INSERT ON events
    WHEN NEW.type = 'autonomy.decision.recorded'
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, NEW.recorded_at, NEW.offset_ms, NEW.type, ${actor}, ${payload}, ${evidenceRefs}, NEW.parent_id, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function seedConflictingOwnerGateTrigger(ledger, type) {
  ledger.exec(`
    CREATE TRIGGER test_conflicting_owner_gate
    BEFORE INSERT ON events
    WHEN NEW.type = ${sqlLiteral(type)}
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, NEW.recorded_at, NEW.offset_ms, NEW.type, 'test-conflict', NEW.payload_json, NEW.evidence_refs_json, NEW.parent_id, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function seedReorderedOwnerGateTrigger(ledger, type) {
  ledger.exec(`
    CREATE TRIGGER test_reordered_owner_gate
    BEFORE INSERT ON events
    WHEN NEW.type = ${sqlLiteral(type)}
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (NEW.id, NEW.run_id, NEW.incident_id, NEW.recorded_at, NEW.offset_ms, NEW.type, NEW.actor, NEW.payload_json, ${reverseEvidenceRefsSql()}, NEW.parent_id, NEW.correlation_id);
      SELECT RAISE(IGNORE);
    END;
  `);
}

function reverseEvidenceRefsSql() {
  return "(SELECT json_group_array(value) FROM (SELECT value FROM json_each(NEW.evidence_refs_json) ORDER BY key DESC))";
}

function seedApprovalClaimLockTrigger(ledger, { id = "test-atomic-approval-lock", payload: providedPayload, headerIncidentId } = {}) {
  const contract = checkoutContract();
  const contract_sha256 = sha256Canonical(contract);
  const incidentId = loadBundle().incident.id;
  const payload = JSON.stringify(providedPayload || { incident_id: incidentId, contract_sha256, target: contract.target, lock_key: failureLockKey({ incident_id: incidentId, contract_sha256, target: contract.target }) });
  const headerIncident = headerIncidentId === undefined ? "NEW.incident_id" : sqlLiteral(headerIncidentId);
  ledger.exec(`
    CREATE TRIGGER test_lock_at_atomic_approval
    BEFORE INSERT ON events
    WHEN NEW.type = 'approval.granted'
    BEGIN
      INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
      VALUES (${sqlLiteral(id)}, NEW.run_id, ${headerIncident}, NEW.recorded_at, 0, 'autonomy.locked', 'test', ${sqlLiteral(payload)}, '[]', NULL, NEW.correlation_id);
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

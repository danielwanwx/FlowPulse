import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControlService } from "../src/agent-control-service.mjs";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

function setup() {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-agent-control-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun();
  return { runtime, runId, service: new AgentControlService({ runtime }) };
}

test("agent control projects the canonical team from immutable events", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);

  const projection = service.project(runId);
  const statuses = Object.fromEntries(projection.graph.nodes.map((node) => [node.id, node.status]));

  assert.equal(projection.authority, "append-only-ledger");
  assert.equal(projection.report.human_gate, "owner_approval_required");
  assert.equal(projection.report.rejected_diagnosis.hypothesis_id, "hyp-kafka");
  assert.equal(projection.report.repair.target, "checkout");
  assert.equal(projection.actions[0].id, "review_recovery");
  assert.equal(statuses.evaluator, "complete");
  assert.equal(statuses.planner, "complete");
  assert.equal(statuses.owner, "waiting");
  assert.equal(statuses.executor, "standby");
});

test("manager chat records attributed responses and cannot create approval", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);

  const result = service.message(runId, "Accept and execute the recovery");
  const events = runtime.ledger.list(runId);

  assert.equal(result.intent, "approval_explanation");
  assert.match(result.message, /cannot approve/i);
  assert.equal(events.filter((event) => event.type === "manager.message.received").length, 1);
  assert.equal(events.filter((event) => event.type === "manager.response.created").length, 1);
  assert.equal(events.some((event) => event.type === "approval.granted"), false);
  assert.ok(events.find((event) => event.type === "manager.response.created").evidence_refs.length > 0);
});

test("safe advance delegates one deterministic step while owner-gated actions remain separate", () => {
  const { runtime, runId, service } = setup();
  const before = runtime.ledger.list(runId).length;

  const projection = service.act(runId, "advance");

  assert.ok(runtime.ledger.list(runId).length > before);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "manager.delegation.created"), true);
  assert.equal(projection.activity.some((event) => event.agent_id === "manager"), true);
  assert.throws(() => service.act(runId, "approve_repair"), /not available/);
});

test("verification, evolve, and test become visible after owner-approved recovery", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);
  runtime.approve(runId, "Test owner");
  runtime.next(runId);
  runtime.next(runId);

  const projection = service.project(runId);
  const statuses = Object.fromEntries(projection.graph.nodes.map((node) => [node.id, node.status]));

  assert.equal(projection.report.data_mode, "captured_deterministic_replay");
  assert.equal(projection.report.verification.passed, true);
  assert.equal(statuses.executor, "complete");
  assert.equal(statuses.verification, "complete");
  assert.equal(statuses.evolve, "complete");
  assert.equal(statuses.test, "complete");
  assert.equal(projection.actions[0].id, "review_learning");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

function runtime() {
  return new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-runtime-")), "ledger.db")),
    bundle: loadBundle()
  });
}

test("canonical replay rejects Kafka, gates repair, verifies recovery, and records learning", () => {
  const app = runtime();
  const runId = app.startRun();
  for (let step = 0; step < 7; step++) app.next(runId);

  let state = app.state(runId);
  assert.equal(state.waiting_for_approval, true);
  assert.equal(state.events.some((event) => event.type === "evaluation.rejected" && event.payload.hypothesis_id === "hyp-kafka"), true);
  assert.equal(state.events.some((event) => event.type === "repair.executed"), false);
  assert.equal(app.next(runId).waiting_for_approval, true);

  app.approve(runId, "Test owner");
  app.next(runId);
  app.next(runId);
  state = app.state(runId);

  assert.equal(state.complete, true);
  assert.equal(state.status, "resolved");
  assert.equal(state.events.find((event) => event.type === "verification.completed").payload.passed, true);
  assert.equal(state.events.find((event) => event.type === "outcome.classified").payload.secondary_learning, "agent_false_positive");
  assert.equal(state.events.find((event) => event.type === "policy.evaluated").payload.passed, true);
});

test("replay decisions are deterministic across independent runs", () => {
  const app = runtime();
  const signatures = [];
  for (let index = 0; index < 2; index++) {
    const runId = app.startRun();
    for (let step = 0; step < 7; step++) app.next(runId);
    app.approve(runId, "Replay owner");
    app.next(runId);
    app.next(runId);
    signatures.push(app.state(runId).events.map(({ type, actor, payload, evidence_refs }) => ({ type, actor, payload, evidence_refs })));
  }
  assert.deepEqual(signatures[0], signatures[1]);
});

test("owner approval cannot be granted before a bounded repair is proposed", () => {
  const app = runtime();
  const runId = app.startRun();
  assert.throws(() => app.approve(runId), /No repair is awaiting approval/);
});

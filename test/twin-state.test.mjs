import test from "node:test";
import assert from "node:assert/strict";
import {
  PULSE_SLOTS,
  TWIN_EDGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_STAGES,
  availableStage,
  compareFrames,
  eventsAtStage,
  frameFor
} from "../public/twin-state.mjs";

test("every component has a vector icon and causal pulses remain sequential", () => {
  assert.deepEqual(Object.keys(TWIN_ICONS).sort(), TWIN_NODES.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(PULSE_SLOTS).sort(), TWIN_EDGES.map(({ id }) => id).sort());
  assert.ok(PULSE_SLOTS["deployment-checkout"] < PULSE_SLOTS["frontend-checkout"]);
  assert.ok(PULSE_SLOTS["frontend-checkout"] < PULSE_SLOTS["checkout-payment"]);
  assert.ok(PULSE_SLOTS["checkout-payment"] < PULSE_SLOTS["checkout-kafka"]);
  assert.ok(PULSE_SLOTS["checkout-kafka"] < PULSE_SLOTS["kafka-accounting"]);
  assert.ok(PULSE_SLOTS["kafka-accounting"] < PULSE_SLOTS["kafka-fraud"]);
});

test("digital twin keeps stable component identities and coordinates across every stage", () => {
  const identities = TWIN_NODES.map(({ id, x, y }) => ({ id, x, y }));
  const edges = TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path }));
  for (let index = 0; index < TWIN_STAGES.length; index++) {
    const frame = frameFor(index);
    assert.deepEqual(TWIN_NODES.map(({ id, x, y }) => ({ id, x, y })), identities);
    assert.deepEqual(TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path })), edges);
    assert.deepEqual(Object.keys(frame.nodeStates).sort(), identities.map(({ id }) => id).sort());
  }
});

test("ledger milestones deterministically unlock the replay stages", () => {
  const events = [
    { type: "incident.opened" },
    { type: "loop.symptoms_collected" },
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "verification.completed" },
    { type: "policy.evaluated" }
  ];
  assert.equal(availableStage(events.slice(0, 1)), 0);
  assert.equal(availableStage(events.slice(0, 2)), 2);
  assert.equal(availableStage(events.slice(0, 3)), 3);
  assert.equal(availableStage(events.slice(0, 4)), 4);
  assert.equal(availableStage(events.slice(0, 5)), 5);
  assert.equal(availableStage(events.slice(0, 6)), 6);
  assert.equal(availableStage(events), 7);
});

test("seeking the same stage reconstructs identical canvas state", () => {
  const first = frameFor(4);
  const second = frameFor(4);
  assert.deepEqual(first, second);
  assert.equal(first.nodeStates.checkout, "root");
  assert.equal(first.nodeStates.payment, "root");
  assert.equal(first.edgeStates["checkout-payment"], "root");
  assert.ok(first.annotations.some((note) => note.id === "replan"));
});

test("compare uses incident and verified frames without changing layout", () => {
  const { incident, recovered } = compareFrames();
  assert.equal(incident.nodeStates.checkout, "impact");
  assert.equal(recovered.nodeStates.checkout, "verified");
  assert.equal(incident.metrics.checkout.value, "38.4%");
  assert.equal(recovered.metrics.checkout.value, "0.8%");
  assert.equal(TWIN_NODES.length, 10);
});

test("stage projection preserves evaluator, owner, recovery, and evolve ordering", () => {
  const events = [
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "approval.granted" },
    { type: "repair.executed" },
    { type: "verification.completed" },
    { type: "regression.created" },
    { type: "policy.evaluated" }
  ];
  assert.deepEqual(eventsAtStage(events, 3).map(({ type }) => type), ["evaluation.rejected"]);
  assert.deepEqual(eventsAtStage(events, 5).map(({ type }) => type), ["evaluation.rejected", "evaluation.accepted", "approval.requested"]);
  assert.deepEqual(eventsAtStage(events, 7).map(({ type }) => type), events.map(({ type }) => type));
});

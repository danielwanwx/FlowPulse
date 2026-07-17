import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARCHITECTURE_LAYERS,
  PULSE_SLOTS,
  TWIN_EDGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_STAGES,
  availableStage,
  architecturePositions,
  compareFrames,
  eventsAtStage,
  frameFor
} from "../public/twin-state.mjs";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("light and pure-black themes have a persisted accessible toggle", () => {
  assert.match(indexHtml, /id="theme-toggle"[^>]+aria-label="Switch to pure black theme"/);
  assert.match(appJs, /localStorage\.setItem\("flowpulse-theme", theme\)/);
  assert.match(appJs, /flowpulse-theme=\$\{theme\}/);
  assert.match(stylesCss, /:root\[data-theme="dark"\]/);
  assert.match(stylesCss, /\.theme-toggle:focus-visible/);
});

test("the product opens on architecture and keeps advanced actions in an accessible menu", () => {
  assert.match(indexHtml, /id="app-shell"[^>]+data-mode="architecture"/);
  assert.match(indexHtml, /data-mode="architecture">Architecture</);
  assert.match(indexHtml, /data-mode="replay">Diagnose</);
  assert.match(indexHtml, /id="workspace-menu"[^>]*class="workspace-menu"/);
  assert.match(indexHtml, /id="live-button"[^>]*>Run GPT-5\.6</);
  assert.match(indexHtml, /id="details-button"[^>]*>Inspect run</);
  assert.match(appJs, /let mode = "architecture"/);
});

test("architecture layout is deterministic, layered, and leaves room for complete cards", () => {
  const nodes = ARCHITECTURE_LAYERS.flatMap((layer) => layer.ids.map((id, index) => ({ id, label: id, kind: index === 0 ? "client" : "service" })));
  const first = architecturePositions(nodes);
  const second = architecturePositions([...nodes].reverse());
  const coordinates = (items) => Object.fromEntries(items.map(({ id, layer, x, y }) => [id, { layer, x, y }]));
  assert.deepEqual(coordinates(first), coordinates(second));
  assert.deepEqual([...new Set(first.map(({ layer }) => layer))], ARCHITECTURE_LAYERS.map(({ id }) => id));
  assert.ok(first.every(({ x, y }) => x >= 6 && x <= 94 && y >= 17 && y <= 81));
  for (const y of new Set(first.map((node) => node.y))) {
    const xs = first.filter((node) => node.y === y).map((node) => node.x).sort((a, b) => a - b);
    for (let index = 1; index < xs.length; index++) assert.ok((xs[index] - xs[index - 1]) * 11 >= 124);
  }
  assert.match(appJs, /arch-count-\$\{node\.layerSize\}/);
  assert.doesNotMatch(appJs, /style="left:\$\{node\.x\}/);
});

test("every component has a vector icon and causal pulses remain sequential", () => {
  assert.deepEqual(Object.keys(TWIN_ICONS).sort(), TWIN_NODES.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(PULSE_SLOTS).sort(), TWIN_EDGES.map(({ id }) => id).sort());
  assert.ok(PULSE_SLOTS["deployment-checkout"] < PULSE_SLOTS["frontend-checkout"]);
  assert.ok(PULSE_SLOTS["frontend-checkout"] < PULSE_SLOTS["checkout-payment"]);
  assert.ok(PULSE_SLOTS["checkout-payment"] < PULSE_SLOTS["checkout-kafka"]);
  assert.ok(PULSE_SLOTS["checkout-kafka"] < PULSE_SLOTS["kafka-accounting"]);
  assert.ok(PULSE_SLOTS["kafka-accounting"] < PULSE_SLOTS["kafka-fraud"]);
});

test("runtime, control-plane, and derived-outcome semantics stay explicit", () => {
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "runtime").map(({ id }) => id),
    ["frontend", "checkout", "payment", "kafka", "accounting", "fraud"]
  );
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "control").map(({ id }) => id),
    ["deployment", "agent", "evaluator", "ledger"]
  );
  assert.deepEqual(
    frameFor(7).annotations.filter(({ role }) => role === "outcome").map(({ id }) => id),
    ["recovery", "learning"]
  );
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROJECTION_LAYERS,
  liveEdgePath,
  projectionEdgeLayout,
  projectionGlyph,
  projectionLayer,
  projectionTopologyLayout,
  replayPresentation
} from "../public/twin-state.mjs";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const graph = {
  nodes: [
    { id: "gateway", label: "Storefront gateway", kind: "api" },
    { id: "checkout", label: "Checkout", kind: "service" },
    { id: "orders", label: "orders.v1", kind: "topic" },
    { id: "accounting", label: "Accounting", kind: "consumer" },
    { id: "warehouse", label: "Warehouse", kind: "warehouse" },
    { id: "evaluator", label: "Evaluator", kind: "evaluator" }
  ],
  edges: [
    { id: "gateway-checkout", from: "gateway", to: "checkout", kind: "request" },
    { id: "checkout-orders", from: "checkout", to: "orders", kind: "publish" },
    { id: "orders-accounting", from: "orders", to: "accounting", kind: "consume" },
    { id: "accounting-warehouse", from: "accounting", to: "warehouse", kind: "load" }
  ]
};

test("the restored competition shell has three primary tabs, four Monitor subviews, and an explicit visual-only theme choice", () => {
  const tabs = [...index.matchAll(/<button[^>]+data-stage="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["monitor", "agent_workbench", "decision_recovery"]);
  assert.match(index, /role="tablist"/);
  assert.match(index, /data-stage="decision_recovery">Decision &amp; Recovery/);
  assert.match(index, /id="theme-toggle"/);
  assert.match(index, /color-scheme" content="light dark"/);
  assert.match(app, /monitor: \["architecture", "live", "replay", "evidence"\]/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(styles, /linear-gradient|radial-gradient|backdrop-filter/);
});

test("projection topology uses deterministic layered entity geometry and Phosphor glyph mapping", () => {
  const first = projectionTopologyLayout(graph);
  const second = projectionTopologyLayout({ ...graph, nodes: [...graph.nodes].reverse() });
  assert.deepEqual(first.map(({ id, layer, x, y, glyph }) => ({ id, layer, x, y, glyph })), second.map(({ id, layer, x, y, glyph }) => ({ id, layer, x, y, glyph })));
  assert.deepEqual(first.map(({ layer }) => layer), ["upstream", "commerce", "stream", "stream", "downstream", "evidence"]);
  assert.equal(projectionGlyph({ kind: "topic" }), "queue");
  assert.equal(projectionGlyph({ kind: "warehouse" }), "warehouse");
  assert.equal(projectionGlyph({ id: "checkout", kind: "service" }), "shopping-cart-simple");
  assert.equal(projectionGlyph({ id: "kafka", kind: "service" }), "queue");
  assert.equal(projectionLayer({ kind: "evaluator" }), "evidence");
  assert.equal(PROJECTION_LAYERS.length, 5);
  const edges = projectionEdgeLayout(graph, first);
  assert.equal(edges.length, graph.edges.length);
  for (const edge of edges) assert.match(liveEdgePath(edge.fromNode, edge.toNode, { canvasWidth: 1000, canvasHeight: 520, nodeWidth: 150, nodeHeight: 64, lane: edge.lane }), /^M .+ L .+ Q /);
  const architecture = projectionTopologyLayout(graph, { mode: "architecture" });
  assert.deepEqual(architecture.map(({ id, x, y }) => ({ id, x, y })), projectionTopologyLayout(graph, { mode: "architecture" }).map(({ id, x, y }) => ({ id, x, y })));
  assert.notDeepEqual(architecture.map(({ id, y }) => ({ id, y })), first.map(({ id, y }) => ({ id, y })));
});

test("replay cursor is deterministic presentation state and never produces an authority mutation", () => {
  const frames = [
    { id: "one", sequence: 1, evidence_refs: ["e1"] },
    { id: "two", sequence: 2, evidence_refs: ["e2"] }
  ];
  assert.deepEqual(replayPresentation(frames, 1).visible.map((frame) => frame.id), ["one", "two"]);
  assert.equal(replayPresentation(frames, 99).cursor, 1);
  assert.match(app, /replayPresentation\(projection\.timeline\.frames, cursor\)/);
  assert.doesNotMatch(app, /fetch\([^)]*approve|fetch\([^)]*development\/approve|fetch\([^)]*agent-control\/action/);
});

test("the frontend keeps topology, drawers, compare, zoom, packets, and reduced motion as projection presentation", () => {
  for (const id of ["twin-canvas", "context-drawer", "compare-range", "zoom-in", "zoom-out", "timeline-range"]) assert.match(index, new RegExp(`id="${id}"`));
  assert.match(app, /function renderDrawer\(\)/);
  assert.match(app, /layers\.querySelectorAll\("\[data-node-id\]"\)/);
  assert.match(app, /layers\.querySelectorAll\("\[data-edge-id\]"\)/);
  assert.match(app, /function setComparePercent/);
  assert.match(app, /function setZoom/);
  assert.match(app, /function flipTopology/);
  assert.match(styles, /@keyframes causal-packet/);
  assert.match(app, /preserveAspectRatio="none"/);
  assert.match(styles, /\.edge-group\.is-replay-active \.pulse-flow/);
  assert.match(app, /edge-label/);
  assert.match(app, /graph-cluster/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /transform: translate\(-50%, -50%\)/);
});

test("the browser import boundary contains projection rendering only and all consequential controls stay disabled", () => {
  assert.match(app, /configuredIncidentProjectionClient/);
  assert.doesNotMatch(app, /autonomy-policy|autonomy-freshness|authorityReceipt|DevelopmentRuntime|openai\.mjs|ledger\.mjs|executor|approval\.granted/);
  assert.match(index, /id="approve-control"[^>]+disabled/);
  assert.match(index, /id="reject-control"[^>]+disabled/);
  assert.match(index, /id="defer-control"[^>]+disabled/);
  assert.match(index, /id="action-control"[^>]+disabled/);
  assert.match(index, /D\.1 adds server-resolved decision-ID-bound actions/);
});

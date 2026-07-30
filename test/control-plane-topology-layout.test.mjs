import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activePulseEdgeIds,
  applyTopologyNodePositions,
  incidentTopologyView,
  latestBySequence,
  topologyLayout,
  topologyNodeMetadata
} from "../public/control-plane-topology-layout.mjs";

test("component-only signals never pulse edges and backend pulses stop at expiry", () => {
  const projection = {
    graph: { edges: [{ edge_id: "edge-1" }] },
    realtime_signals: [{ component_ids: ["checkout"], edge_ids: [] }],
    active_graph_pulses: [{ edge_ids: ["edge-1"], expires_at: "2026-07-30T00:00:20Z" }]
  };
  assert.deepEqual([...activePulseEdgeIds(projection, Date.parse("2026-07-30T00:00:19Z"))], ["edge-1"]);
  assert.deepEqual([...activePulseEdgeIds(projection, Date.parse("2026-07-30T00:00:20Z"))], []);
  assert.deepEqual([...activePulseEdgeIds({ ...projection, active_graph_pulses: [] }, Date.parse("2026-07-30T00:00:19Z"))], []);
});

test("V2 signal and activity selection uses canonical sequence rather than array order", () => {
  assert.equal(latestBySequence([{ sequence: 58, id: "current" }, { sequence: 4, id: "oldest" }]).id, "current");
  assert.equal(latestBySequence([{ sequence: 29, id: "started" }, { sequence: 30, id: "completed" }]).id, "completed");
  assert.equal(latestBySequence([]), null);
});

const stylesCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const controlPlaneApp = await readFile(new URL("../public/control-plane-app.mjs", import.meta.url), "utf8");

const canonicalNodes = Array.from({ length: 22 }, (_, index) => ({
  component_id: `server-projected-component-${index + 1}`
}));

function bounds(position, layout) {
  const centerX = position.x * layout.canvas.width / 100;
  const centerY = position.y * layout.canvas.height / 100;
  return {
    left: centerX - layout.card.width / 2,
    right: centerX + layout.card.width / 2,
    top: centerY - layout.card.height / 2,
    bottom: centerY + layout.card.height / 2
  };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test("a dense 22-node server topology uses a deterministic scrollable layout without overlapping cards", () => {
  const layout = topologyLayout(canonicalNodes);

  assert.equal(layout.density, "dense");
  assert.deepEqual(layout.canvas, { width: 916, height: 672 });
  assert.deepEqual(layout.card, { width: 176, height: 72 });
  assert.equal(layout.positions.size, canonicalNodes.length);
  assert.deepEqual([...layout.positions.keys()], canonicalNodes.map((node) => node.component_id));

  const boxes = [...layout.positions.values()].map((position) => bounds(position, layout));
  for (const [index, box] of boxes.entries()) {
    assert.ok(box.left >= 0 && box.right <= layout.canvas.width, `card ${index} stays within the scrollable canvas width`);
    assert.ok(box.top >= 0 && box.bottom <= layout.canvas.height, `card ${index} stays within the scrollable canvas height`);
    for (const later of boxes.slice(index + 1)) assert.equal(overlaps(box, later), false, `card ${index} does not overlap another canonical card`);
  }
});

test("dense canonical node positions are applied through the DOM style API after markup insertion", () => {
  const layout = topologyLayout(canonicalNodes);
  const elements = canonicalNodes.map((node) => ({
    dataset: { controlComponent: node.component_id },
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); }
    }
  }));
  const container = { querySelectorAll: () => elements };

  applyTopologyNodePositions(container, layout.positions);

  for (const node of elements) {
    const position = layout.positions.get(node.dataset.controlComponent);
    assert.equal(node.style.values.get("left"), `${position.x}%`);
    assert.equal(node.style.values.get("top"), `${position.y}%`);
  }
});

test("dense cards bound contract-valid long metadata to the declared row height without losing its accessible text", () => {
  const runtimeStatus = "s".repeat(512);
  const metadata = topologyNodeMetadata({
    membership: "CLASSIFIED",
    classification_reason: "Relationship unavailable",
    runtime_status: runtimeStatus
  });
  const layout = topologyLayout(canonicalNodes);
  const firstColumn = [...layout.positions.values()].filter((_, index) => index % 4 === 0);

  assert.equal(metadata, `${runtimeStatus} · Relationship unavailable`);
  assert.ok(metadata.length > layout.card.width);
  assert.equal(layout.card.height, 72);
  assert.ok((firstColumn[1].y - firstColumn[0].y) * layout.canvas.height / 100 > layout.card.height);
  assert.match(stylesCss, /\.control-plane-twin-node \{ width: 176px; height: 72px; min-height: 72px; overflow: hidden;/);
  assert.match(stylesCss, /\.control-plane-node-metadata \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(controlPlaneApp, /class="control-plane-node-metadata" title="\$\{escapeHtml\(metadata\)\}" aria-label="\$\{escapeHtml\(metadata\)\}"/);
});

test("Incident presents only the server-audited six-node, five-relation focus graph", () => {
  const impactedPath = ["frontend", "checkout", "payment", "kafka", "accounting", "fraud-detection"];
  const relationIds = [
    "incident-relation-frontend-checkout",
    "incident-relation-checkout-payment",
    "incident-relation-checkout-kafka",
    "incident-relation-kafka-accounting",
    "incident-relation-kafka-fraud-detection"
  ];
  const contextNodes = Array.from({ length: 16 }, (_, index) => ({
    component_id: `context-${index + 1}`,
    display_name: `Context ${index + 1}`
  }));
  const nodes = [
    ...impactedPath.map((component_id) => ({ component_id, display_name: component_id })),
    ...contextNodes
  ];
  const edges = [
    { edge_id: relationIds[0], source_component_id: "frontend", target_component_id: "checkout" },
    { edge_id: relationIds[1], source_component_id: "checkout", target_component_id: "payment" },
    { edge_id: relationIds[2], source_component_id: "checkout", target_component_id: "kafka" },
    { edge_id: relationIds[3], source_component_id: "kafka", target_component_id: "accounting" },
    { edge_id: relationIds[4], source_component_id: "kafka", target_component_id: "fraud-detection" },
    ...contextNodes.slice(1).map((node, index) => ({
      edge_id: `context-relation-${index + 1}`,
      source_component_id: contextNodes[index].component_id,
      target_component_id: node.component_id
    })),
    ...Array.from({ length: 9 }, (_, index) => ({
      edge_id: `context-extra-${index + 1}`,
      source_component_id: contextNodes[index].component_id,
      target_component_id: impactedPath[index % impactedPath.length]
    }))
  ];

  const view = incidentTopologyView({
    graph: { nodes, edges },
    impacted_path: impactedPath,
    incident_focus: {
      component_id: "checkout",
      incident_relation_edge_ids: relationIds
    }
  });

  assert.equal(nodes.length, 22);
  assert.equal(edges.length, 29);
  assert.equal(view.available, true);
  assert.deepEqual(view.nodes.map((node) => node.component_id), impactedPath);
  assert.deepEqual(view.edges.map((edge) => edge.edge_id), relationIds);
  assert.deepEqual(view.positions.get("frontend"), { x: 13, y: 46 });
  assert.deepEqual(view.positions.get("checkout"), { x: 42, y: 46 });
  assert.deepEqual(view.positions.get("payment"), { x: 76, y: 22 });
  assert.deepEqual(view.positions.get("kafka"), { x: 65, y: 68 });
  assert.deepEqual(view.positions.get("accounting"), { x: 88, y: 51 });
  assert.deepEqual(view.positions.get("fraud-detection"), { x: 88, y: 81 });
});

test("Incident fails closed when the backend focus contract is absent", () => {
  const view = incidentTopologyView({
    graph: {
      nodes: [{ component_id: "checkout", display_name: "Checkout" }],
      edges: []
    },
    impacted_path: ["checkout"]
  });

  assert.deepEqual(view, {
    available: false,
    reason: "incident_focus_unavailable",
    nodes: [],
    edges: [],
    positions: new Map()
  });
});

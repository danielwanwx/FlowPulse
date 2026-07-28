import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyTopologyNodePositions, topologyLayout, topologyNodeMetadata } from "../public/control-plane-topology-layout.mjs";

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

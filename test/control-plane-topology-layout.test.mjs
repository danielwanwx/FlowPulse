import test from "node:test";
import assert from "node:assert/strict";
import { applyTopologyNodePositions, topologyLayout } from "../public/control-plane-topology-layout.mjs";

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

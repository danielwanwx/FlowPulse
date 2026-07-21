import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { measuredLiveRoute, roundedMeasuredRoutePath } from "../public/live-routing.mjs";
import { livePositions } from "../public/twin-state.mjs";

const manifest = JSON.parse(await readFile(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url), "utf8"));
const WORLD = { width: 1480, height: 680, nodeWidth: 180, nodeHeight: 60 };

function boxesFor(nodes) {
  return livePositions(nodes).map((node) => ({
    id: node.id,
    left: node.x / 100 * WORLD.width - WORLD.nodeWidth / 2,
    right: node.x / 100 * WORLD.width + WORLD.nodeWidth / 2,
    top: node.y / 100 * WORLD.height - WORLD.nodeHeight / 2,
    bottom: node.y / 100 * WORLD.height + WORLD.nodeHeight / 2
  }));
}

function onBoundary(point, box) {
  const inside = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  const touching = [point.x - box.left, point.x - box.right, point.y - box.top, point.y - box.bottom].some((value) => Math.abs(value) < .001);
  return inside && touching;
}

function intersectsOpenRect(a, b, rect) {
  if (a.x === b.x) return a.x > rect.left && a.x < rect.right && Math.max(Math.min(a.y, b.y), rect.top) < Math.min(Math.max(a.y, b.y), rect.bottom);
  if (a.y === b.y) return a.y > rect.top && a.y < rect.bottom && Math.max(Math.min(a.x, b.x), rect.left) < Math.min(Math.max(a.x, b.x), rect.right);
  return false;
}

test("measured Live routes start and end on actual component boundaries without crossing other components", () => {
  const boxes = boxesFor(manifest.nodes);
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const routes = manifest.edges.map((edge, order) => ({ edge, route: measuredLiveRoute({ from: byId.get(edge.from), to: byId.get(edge.to), obstacles: boxes, order }) }));

  assert.equal(routes.length, 22);
  for (const { edge, route } of routes) {
    assert.equal(onBoundary(route.points[0], byId.get(edge.from)), true, `${edge.id} must leave the source boundary`);
    assert.equal(onBoundary(route.points.at(-1), byId.get(edge.to)), true, `${edge.id} must enter the target boundary`);
    for (const box of boxes) {
      if ([edge.from, edge.to].includes(box.id)) continue;
      for (let index = 1; index < route.points.length; index += 1) {
        assert.equal(intersectsOpenRect(route.points[index - 1], route.points[index], box), false, `${edge.id} crosses ${box.id}`);
      }
    }
  }
});

test("measured Live route selection and rounded SVG output remain deterministic", () => {
  const boxes = boxesFor(manifest.nodes);
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const edge = manifest.edges.find((candidate) => candidate.id === "frontend->shipping");
  const first = measuredLiveRoute({ from: byId.get(edge.from), to: byId.get(edge.to), obstacles: boxes, order: 3 });
  const second = measuredLiveRoute({ from: byId.get(edge.from), to: byId.get(edge.to), obstacles: [...boxes].reverse(), order: 3 });
  const path = roundedMeasuredRoutePath(first.points);

  assert.deepEqual(second, first);
  assert.match(path, /^M /);
  assert.match(path, /Q /);
  assert.equal(first.points.length >= 4, true);
});

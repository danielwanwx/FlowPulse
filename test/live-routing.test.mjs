import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { LIVE_ROUTE_WORLD, fixedLiveRouteBoxes, plannedLiveRoutes, roundedMeasuredRoutePath } from "../public/live-routing.mjs";
import { livePositions } from "../public/twin-state.mjs";

const manifest = JSON.parse(await readFile(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url), "utf8"));
const WORLD = LIVE_ROUTE_WORLD;

function boxesFor(nodes) {
  return fixedLiveRouteBoxes(livePositions(nodes));
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

test("fixed Live routes start and end on actual component boundaries without crossing other components", () => {
  const boxes = boxesFor(manifest.nodes);
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const routes = plannedLiveRoutes(livePositions(manifest.nodes), manifest.edges);

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

test("fixed Live route selection and rounded SVG output remain deterministic", () => {
  const positioned = livePositions(manifest.nodes);
  const first = plannedLiveRoutes(positioned, manifest.edges);
  const second = plannedLiveRoutes(positioned, [...manifest.edges].reverse());
  const path = roundedMeasuredRoutePath(first.find(({ edge }) => edge.id === "frontend->shipping").route.points);

  assert.deepEqual(second, first);
  assert.match(path, /^M /);
  assert.match(path, /Q /);
  assert.equal(first.every(({ route }) => route.points.length >= 2), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { liveEdgePath, liveEdgeRoute, livePositions } from "../public/twin-state.mjs";

const manifest = JSON.parse(await readFile(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url), "utf8"));
const WORLD = Object.freeze({ width: 1480, height: 680, nodeWidth: 180, nodeHeight: 60 });
const relations = Object.freeze([...manifest.edges, ...manifest.supporting_relations]);

function rectFor(node) {
  return {
    left: node.x / 100 * WORLD.width - WORLD.nodeWidth / 2,
    right: node.x / 100 * WORLD.width + WORLD.nodeWidth / 2,
    top: node.y / 100 * WORLD.height - WORLD.nodeHeight / 2,
    bottom: node.y / 100 * WORLD.height + WORLD.nodeHeight / 2
  };
}

function onBoundary(point, box) {
  const inside = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  const touching = [point.x - box.left, point.x - box.right, point.y - box.top, point.y - box.bottom].some((value) => Math.abs(value) < .001);
  return inside && touching;
}

function intersectsOpenRect(a, b, rect) {
  if (Math.abs(a.x - b.x) < .001) return a.x > rect.left && a.x < rect.right && Math.max(Math.min(a.y, b.y), rect.top) < Math.min(Math.max(a.y, b.y), rect.bottom);
  if (Math.abs(a.y - b.y) < .001) return a.y > rect.top && a.y < rect.bottom && Math.max(Math.min(a.x, b.x), rect.left) < Math.min(Math.max(a.x, b.x), rect.right);
  return false;
}

function routeFor(edge, index, positions) {
  const byId = new Map(positions.map((node) => [node.id, node]));
  const lane = index % 2 ? Math.ceil(index / 2) : -Math.ceil((index + 1) / 2);
  return liveEdgeRoute(byId.get(edge.from), byId.get(edge.to), {
    canvasWidth: WORLD.width,
    canvasHeight: WORLD.height,
    nodeWidth: WORLD.nodeWidth,
    nodeHeight: WORLD.nodeHeight,
    lane
  });
}

test("authored Live routes start and end on the rendered component boundaries without crossing another component", () => {
  const positions = livePositions(manifest.nodes);
  const byId = new Map(positions.map((node) => [node.id, node]));

  assert.equal(positions.length, 22);
  assert.equal(manifest.edges.length, 26);
  assert.equal(manifest.supporting_relations.length, 7);
  for (const [index, edge] of relations.entries()) {
    const route = routeFor(edge, index, positions);
    assert.equal(onBoundary(route[0], rectFor(byId.get(edge.from))), true, `${edge.id} must leave ${edge.from}`);
    assert.equal(onBoundary(route.at(-1), rectFor(byId.get(edge.to))), true, `${edge.id} must enter ${edge.to}`);
    for (let point = 1; point < route.length; point += 1) {
      const previous = route[point - 1];
      const current = route[point];
      assert.equal(previous.x === current.x || previous.y === current.y, true, `${edge.id} must use only orthogonal route segments`);
    }
    for (const node of positions) {
      if ([edge.from, edge.to].includes(node.id)) continue;
      const rect = rectFor(node);
      for (let point = 1; point < route.length; point += 1) {
        assert.equal(intersectsOpenRect(route[point - 1], route[point], rect), false, `${edge.id} crosses ${node.id}`);
      }
    }
  }
});

test("authored Live paths are deterministic circuit-board routes with one rounded-corner grammar", () => {
  const positions = livePositions(manifest.nodes);
  const first = relations.map((edge, index) => ({ id: edge.id, route: routeFor(edge, index, positions) }));
  const second = relations.map((edge, index) => ({ id: edge.id, route: routeFor(edge, index, positions) }));
  const frontendToCart = manifest.edges.find((edge) => edge.id === "frontend->cart");
  const direct = liveEdgePath(positions.find((node) => node.id === frontendToCart.from), positions.find((node) => node.id === frontendToCart.to), {
    canvasWidth: WORLD.width,
    canvasHeight: WORLD.height,
    nodeWidth: WORLD.nodeWidth,
    nodeHeight: WORLD.nodeHeight,
    lane: 1
  });

  assert.deepEqual(second, first);
  assert.match(direct, /^M [^]+ Q /);
  assert.doesNotMatch(direct, /\bC\b/);
  assert.equal(first.some(({ route }) => route.length > 2), true);
});

test("every captured dependency has one endpoint-valid route and no implicit topology relation is added", () => {
  const positions = livePositions(manifest.nodes);
  const routed = relations.map((edge, index) => ({ edge, route: routeFor(edge, index, positions) }));
  const routeIds = routed.map(({ edge }) => edge.id).sort();
  const connectedNodeIds = new Set(relations.flatMap(({ from, to }) => [from, to]));

  assert.equal(routed.length, 33);
  assert.deepEqual(routeIds, relations.map(({ id }) => id).sort());
  assert.equal(new Set(routeIds).size, routeIds.length);
  assert.deepEqual([...connectedNodeIds].sort(), manifest.nodes.map(({ id }) => id).sort());
  for (const { edge, route } of routed) {
    const path = liveEdgePath(
      positions.find((node) => node.id === edge.from),
      positions.find((node) => node.id === edge.to),
      { canvasWidth: WORLD.width, canvasHeight: WORLD.height, nodeWidth: WORLD.nodeWidth, nodeHeight: WORLD.nodeHeight }
    );
    assert.equal(route.length >= 2, true, `${edge.id} needs an authored route`);
    assert.match(path, /^M /, `${edge.id} needs an SVG path`);
    assert.doesNotMatch(path, /\bC\b/, `${edge.id} must not mix Bezier routing into the shared grammar`);
  }
});

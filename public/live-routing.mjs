// The densest canonical Live column has a 14px card gap. Keep a visible but
// practical 5px corridor on each side so measured paths can use that evidence
// layout instead of being forced around the entire canvas.
const BASE_CLEARANCE = 5;
const PORT_INSET = 12;
const TURN_PENALTY = 12;

// The Live canvas has a fixed, backend-derived world. Keeping its route
// geometry in that world makes every canonical dependency stable across a
// resize, zoom, and detail-rail toggle; the browser only scales the result.
export const LIVE_ROUTE_WORLD = Object.freeze({ width: 1480, height: 680, nodeWidth: 180, nodeHeight: 60 });

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function point(x, y) {
  return { x: number(x), y: number(y) };
}

function center(box) {
  return point((box.left + box.right) / 2, (box.top + box.bottom) / 2);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function unique(values) {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort((left, right) => left - right);
}

function compact(points) {
  return points.filter((candidate, index) => {
    const previous = points[index - 1];
    if (!previous) return true;
    return Math.abs(candidate.x - previous.x) > .001 || Math.abs(candidate.y - previous.y) > .001;
  }).filter((candidate, index, values) => {
    const previous = values[index - 1];
    const next = values[index + 1];
    if (!previous || !next) return true;
    return !(Math.abs(previous.x - candidate.x) < .001 && Math.abs(candidate.x - next.x) < .001)
      && !(Math.abs(previous.y - candidate.y) < .001 && Math.abs(candidate.y - next.y) < .001);
  });
}

function expanded(box, clearance) {
  return {
    id: box.id,
    left: box.left - clearance,
    right: box.right + clearance,
    top: box.top - clearance,
    bottom: box.bottom + clearance
  };
}

function pointInOpenRect(value, rect) {
  return value.x > rect.left && value.x < rect.right && value.y > rect.top && value.y < rect.bottom;
}

function segmentHitsRect(start, end, rect) {
  if (Math.abs(start.x - end.x) < .001) {
    return start.x > rect.left && start.x < rect.right
      && Math.max(Math.min(start.y, end.y), rect.top) < Math.min(Math.max(start.y, end.y), rect.bottom);
  }
  if (Math.abs(start.y - end.y) < .001) {
    return start.y > rect.top && start.y < rect.bottom
      && Math.max(Math.min(start.x, end.x), rect.left) < Math.min(Math.max(start.x, end.x), rect.right);
  }
  return true;
}

function segmentClear(start, end, obstacles) {
  return obstacles.every((obstacle) => !segmentHitsRect(start, end, obstacle));
}

function portFor(box, side, offset) {
  const midpoint = center(box);
  if (side === "left" || side === "right") {
    return point(side === "left" ? box.left : box.right, clamp(midpoint.y + offset, box.top + PORT_INSET, box.bottom - PORT_INSET));
  }
  return point(clamp(midpoint.x + offset, box.left + PORT_INSET, box.right - PORT_INSET), side === "top" ? box.top : box.bottom);
}

function exteriorPoint(port, side, clearance) {
  if (side === "left") return point(port.x - clearance, port.y);
  if (side === "right") return point(port.x + clearance, port.y);
  if (side === "top") return point(port.x, port.y - clearance);
  return point(port.x, port.y + clearance);
}

function sidePairs(from, to, order) {
  const start = center(from);
  const end = center(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const sameColumn = Math.abs(dx) < Math.min(from.right - from.left, to.right - to.left) / 3;
  if (sameColumn) {
    return order % 2 ? [["left", "left"], ["right", "right"], [dy >= 0 ? "bottom" : "top", dy >= 0 ? "top" : "bottom"]]
      : [["right", "right"], ["left", "left"], [dy >= 0 ? "bottom" : "top", dy >= 0 ? "top" : "bottom"]];
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    const forward = dx >= 0;
    return forward
      ? [["right", "left"], ["bottom", "top"], ["top", "bottom"]]
      : [["left", "right"], ["bottom", "top"], ["top", "bottom"]];
  }
  const downward = dy >= 0;
  return downward
    ? [["bottom", "top"], [dx >= 0 ? "right" : "left", dx >= 0 ? "left" : "right"]]
    : [["top", "bottom"], [dx >= 0 ? "right" : "left", dx >= 0 ? "left" : "right"]];
}

function queuePush(queue, item) {
  queue.push(item);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (queue[parent].cost <= item.cost) break;
    queue[index] = queue[parent];
    index = parent;
  }
  queue[index] = item;
}

function queuePop(queue) {
  if (!queue.length) return null;
  const first = queue[0];
  const final = queue.pop();
  if (!queue.length) return first;
  let index = 0;
  while (index * 2 + 1 < queue.length) {
    let child = index * 2 + 1;
    if (child + 1 < queue.length && queue[child + 1].cost < queue[child].cost) child += 1;
    if (queue[child].cost >= final.cost) break;
    queue[index] = queue[child];
    index = child;
  }
  queue[index] = final;
  return first;
}

function gridRoute(start, end, obstacles, clearance) {
  const minX = Math.min(...obstacles.map((box) => box.left), start.x, end.x) - clearance * 2;
  const maxX = Math.max(...obstacles.map((box) => box.right), start.x, end.x) + clearance * 2;
  const minY = Math.min(...obstacles.map((box) => box.top), start.y, end.y) - clearance * 2;
  const maxY = Math.max(...obstacles.map((box) => box.bottom), start.y, end.y) + clearance * 2;
  const xs = unique([minX, maxX, start.x, end.x, ...obstacles.flatMap((box) => [box.left, box.right])]);
  const ys = unique([minY, maxY, start.y, end.y, ...obstacles.flatMap((box) => [box.top, box.bottom])]);
  const startX = xs.indexOf(Math.round(start.x * 1000) / 1000);
  const startY = ys.indexOf(Math.round(start.y * 1000) / 1000);
  const endX = xs.indexOf(Math.round(end.x * 1000) / 1000);
  const endY = ys.indexOf(Math.round(end.y * 1000) / 1000);
  if (startX < 0 || startY < 0 || endX < 0 || endY < 0) return null;
  const keyFor = (x, y, direction) => `${x}:${y}:${direction}`;
  const nodes = new Map();
  const queue = [];
  const startKey = keyFor(startX, startY, "start");
  nodes.set(startKey, { x: startX, y: startY, direction: "start", cost: 0, previous: null });
  queuePush(queue, nodes.get(startKey));
  let target = null;
  while (queue.length) {
    const current = queuePop(queue);
    const currentKey = keyFor(current.x, current.y, current.direction);
    if (nodes.get(currentKey)?.cost !== current.cost) continue;
    if (current.x === endX && current.y === endY) {
      target = current;
      break;
    }
    const adjacent = [
      [current.x - 1, current.y, "horizontal"], [current.x + 1, current.y, "horizontal"],
      [current.x, current.y - 1, "vertical"], [current.x, current.y + 1, "vertical"]
    ];
    for (const [x, y, direction] of adjacent) {
      if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
      const currentPoint = point(xs[current.x], ys[current.y]);
      const nextPoint = point(xs[x], ys[y]);
      if (obstacles.some((box) => pointInOpenRect(nextPoint, box))) continue;
      if (!segmentClear(currentPoint, nextPoint, obstacles)) continue;
      const distance = Math.abs(nextPoint.x - currentPoint.x) + Math.abs(nextPoint.y - currentPoint.y);
      const cost = current.cost + distance + (current.direction !== "start" && current.direction !== direction ? TURN_PENALTY : 0);
      const key = keyFor(x, y, direction);
      if (nodes.has(key) && nodes.get(key).cost <= cost) continue;
      const next = { x, y, direction, cost, previous: current };
      nodes.set(key, next);
      queuePush(queue, next);
    }
  }
  if (!target) return null;
  const points = [];
  for (let current = target; current; current = current.previous) points.unshift(point(xs[current.x], ys[current.y]));
  return compact(points);
}

function routeLength(points) {
  return points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
}

/**
 * Builds a deterministic, measured route from real component bounds. Each
 * canonical dependency starts and ends at a component boundary and never crosses
 * another component's padded visual footprint.
 */
export function measuredLiveRoute({ from, to, obstacles = [], order = 0 } = {}) {
  if (!from?.id || !to?.id) throw new Error("measured Live routes require source and target component boxes");
  const all = [...obstacles].map((box) => ({ id: String(box.id), left: number(box.left), right: number(box.right), top: number(box.top), bottom: number(box.bottom) })).sort((left, right) => left.id.localeCompare(right.id));
  const source = all.find((box) => box.id === String(from.id)) || { id: String(from.id), left: number(from.left), right: number(from.right), top: number(from.top), bottom: number(from.bottom) };
  const target = all.find((box) => box.id === String(to.id)) || { id: String(to.id), left: number(to.left), right: number(to.right), top: number(to.top), bottom: number(to.bottom) };
  const clearance = BASE_CLEARANCE;
  // Source and target own their boundary ports. They are deliberately omitted
  // from obstacle checks so the final short port segment may enter its card;
  // every other visible card remains a padded no-route zone.
  const padded = all
    .filter((box) => box.id !== source.id && box.id !== target.id)
    .map((box) => expanded(box, clearance));
  const offset = ((Math.abs(Math.trunc(order)) % 5) - 2) * 6;
  const routes = sidePairs(source, target, order).map(([fromSide, toSide], preference) => {
    const start = portFor(source, fromSide, offset);
    const end = portFor(target, toSide, -offset);
    const interior = gridRoute(exteriorPoint(start, fromSide, clearance), exteriorPoint(end, toSide, clearance), padded, clearance);
    if (!interior) return null;
    const points = compact([start, ...interior, end]);
    return { points, score: routeLength(points) + preference * 0.01 };
  }).filter(Boolean).sort((left, right) => left.score - right.score);
  if (!routes.length) throw new Error(`no clear measured route for ${source.id} to ${target.id}`);
  return Object.freeze({ points: Object.freeze(routes[0].points.map((value) => Object.freeze(value))) });
}

export function fixedLiveRouteBoxes(positioned = []) {
  return positioned.map((node) => {
    const centerX = Number(node.x) / 100 * LIVE_ROUTE_WORLD.width;
    const centerY = Number(node.y) / 100 * LIVE_ROUTE_WORLD.height;
    return {
      id: String(node.id),
      left: centerX - LIVE_ROUTE_WORLD.nodeWidth / 2,
      right: centerX + LIVE_ROUTE_WORLD.nodeWidth / 2,
      top: centerY - LIVE_ROUTE_WORLD.nodeHeight / 2,
      bottom: centerY + LIVE_ROUTE_WORLD.nodeHeight / 2
    };
  });
}

/**
 * Plans canonical paths once from the fixed Live world. This deliberately
 * avoids post-layout DOM measurement: a dependency path is a property of the
 * projected topology and its fixed node placement, not the current viewport.
 */
export function plannedLiveRoutes(positioned = [], edges = []) {
  const boxes = fixedLiveRouteBoxes(positioned);
  const byId = new Map(boxes.map((box) => [box.id, box]));
  return [...edges]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) throw new Error(`fixed Live route endpoint unavailable for ${edge.id}`);
      const route = measuredLiveRoute({ from, to, obstacles: boxes, order: Number.isFinite(edge.order) ? edge.order : index });
      return { edge, route, path: roundedMeasuredRoutePath(route.points) };
    });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function toward(origin, target, distance) {
  const length = Math.hypot(target.x - origin.x, target.y - origin.y);
  if (!length) return origin;
  return point(origin.x + (target.x - origin.x) * distance / length, origin.y + (target.y - origin.y) * distance / length);
}

export function roundedMeasuredRoutePath(points = []) {
  if (points.length < 2) return "";
  if (points.length === 2) return `M ${round(points[0].x)} ${round(points[0].y)} L ${round(points[1].x)} ${round(points[1].y)}`;
  const commands = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const radius = Math.min(14, Math.hypot(current.x - previous.x, current.y - previous.y) / 2, Math.hypot(next.x - current.x, next.y - current.y) / 2);
    const before = toward(current, previous, radius);
    const after = toward(current, next, radius);
    commands.push(`L ${round(before.x)} ${round(before.y)}`, `Q ${round(current.x)} ${round(current.y)} ${round(after.x)} ${round(after.y)}`);
  }
  const end = points.at(-1);
  commands.push(`L ${round(end.x)} ${round(end.y)}`);
  return commands.join(" ");
}

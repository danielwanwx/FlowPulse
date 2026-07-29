const DENSE_NODE_THRESHOLD = 13;
const DENSE_CARD = Object.freeze({ width: 176, height: 72 });
const DENSE_GAP = Object.freeze({ x: 44, y: 32 });
const DENSE_PADDING = Object.freeze({ x: 40, y: 40 });
const STAFF_INCIDENT_POSITIONS = Object.freeze({
  frontend: Object.freeze({ x: 13, y: 46 }),
  checkout: Object.freeze({ x: 42, y: 46 }),
  payment: Object.freeze({ x: 76, y: 22 }),
  kafka: Object.freeze({ x: 65, y: 68 }),
  accounting: Object.freeze({ x: 88, y: 51 }),
  "fraud-detection": Object.freeze({ x: 88, y: 81 })
});

export function topologyLayout(nodes) {
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.max(1, Math.ceil(nodes.length / columns));
  if (nodes.length < DENSE_NODE_THRESHOLD) return spaciousLayout(nodes, columns, rows);

  const canvas = {
    width: columns * DENSE_CARD.width + (columns - 1) * DENSE_GAP.x + DENSE_PADDING.x * 2,
    height: rows * DENSE_CARD.height + (rows - 1) * DENSE_GAP.y + DENSE_PADDING.y * 2
  };
  return {
    density: "dense",
    canvas,
    card: DENSE_CARD,
    positions: new Map(nodes.map((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = DENSE_PADDING.x + DENSE_CARD.width / 2 + column * (DENSE_CARD.width + DENSE_GAP.x);
      const y = DENSE_PADDING.y + DENSE_CARD.height / 2 + row * (DENSE_CARD.height + DENSE_GAP.y);
      return [node.component_id, { x: x / canvas.width * 100, y: y / canvas.height * 100 }];
    }))
  };
}

export function applyTopologyNodePositions(container, positions) {
  for (const node of container.querySelectorAll("[data-control-component]")) {
    const position = positions.get(node.dataset.controlComponent);
    if (!position) continue;
    node.style.setProperty("left", `${position.x}%`);
    node.style.setProperty("top", `${position.y}%`);
  }
}

export function topologyNodeMetadata(node) {
  const kind = node.membership === "CLASSIFIED" ? node.classification_reason : "Connected";
  return `${node.runtime_status} · ${kind}`;
}

export function incidentTopologyView(projection) {
  const focus = projection?.incident_focus;
  if (!focus) return unavailableIncidentTopology();
  const orderedNodeIds = projection.impacted_path;
  const orderedEdgeIds = focus.incident_relation_edge_ids;
  if (!Array.isArray(orderedNodeIds) || !orderedNodeIds.length || !Array.isArray(orderedEdgeIds) || !orderedEdgeIds.length) {
    return unavailableIncidentTopology();
  }
  const nodes = new Map(projection.graph.nodes.map((node) => [node.component_id, node]));
  const edges = new Map(projection.graph.edges.map((edge) => [edge.edge_id, edge]));
  const selectedNodes = orderedNodeIds.map((componentId) => nodes.get(componentId));
  const selectedEdges = orderedEdgeIds.map((edgeId) => edges.get(edgeId));
  const selectedNodeIds = new Set(orderedNodeIds);
  if (selectedNodes.some((node) => !node) || selectedEdges.some((edge) => !edge)
    || selectedEdges.some((edge) => !selectedNodeIds.has(edge.source_component_id) || !selectedNodeIds.has(edge.target_component_id))) {
    return unavailableIncidentTopology();
  }
  const positions = orderedNodeIds.every((componentId) => STAFF_INCIDENT_POSITIONS[componentId])
    ? new Map(orderedNodeIds.map((componentId) => [componentId, STAFF_INCIDENT_POSITIONS[componentId]]))
    : spaciousLayout(selectedNodes, Math.max(1, Math.min(3, Math.ceil(Math.sqrt(selectedNodes.length)))), Math.max(1, Math.ceil(selectedNodes.length / 3))).positions;
  return { available: true, reason: null, nodes: selectedNodes, edges: selectedEdges, positions };
}

function spaciousLayout(nodes, columns, rows) {
  return {
    density: "spacious",
    canvas: null,
    card: null,
    positions: new Map(nodes.map((node, index) => [node.component_id, {
      x: 13 + (index % columns) * (74 / Math.max(1, columns - 1)),
      y: 24 + Math.floor(index / columns) * (54 / Math.max(1, rows - 1))
    }]))
  };
}

function unavailableIncidentTopology() {
  return {
    available: false,
    reason: "incident_focus_unavailable",
    nodes: [],
    edges: [],
    positions: new Map()
  };
}

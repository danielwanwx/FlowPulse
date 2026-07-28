import { topologyIntegrity } from "./twin-state.mjs";

// Live is an operational flow surface. It renders only components that the
// backend has connected with a real projected edge; classified zero-degree
// components remain available in the Architecture view.
export function connectedLiveTopology(topology) {
  const canonical = topologyIntegrity(topology);
  const connected = new Set(canonical.edges.flatMap((edge) => [edge.from, edge.to]));
  return {
    ...canonical,
    nodes: canonical.nodes.filter((node) => connected.has(node.id)),
    edges: canonical.edges.filter((edge) => connected.has(edge.from) && connected.has(edge.to)),
    unlinked_node_ids: []
  };
}

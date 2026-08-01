import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLiveEventV3,
  LiveIncidentAdapterV3,
  liveIncidentMatchesProjectionV3,
  liveTopologyProjectionSetV3,
  renderLiveIncidentsV3,
  renderLiveTopologyV3
} from "../public/live-v3.mjs";
import { v3LiveSnapshot, v3Projection } from "./helpers/v3-fixtures.mjs";

test("V3 Live card and Incident projection preserve the same identity, impact, severity, freshness, and stage", () => {
  const snapshot = v3LiveSnapshot();
  const projection = v3Projection();
  const incident = snapshot.incidents[0];
  assert.equal(liveIncidentMatchesProjectionV3(incident, projection), true);
  const html = renderLiveIncidentsV3(snapshot, "connected");
  for (const value of [projection.case_id, projection.severity, "Current", ...projection.impacted_path]) assert.match(html, new RegExp(value));
  assert.match(html, new RegExp(`data-open-live-case="${projection.case_id}"`));
  assert.equal(liveIncidentMatchesProjectionV3({ ...incident, severity: "SEV-2" }, projection), false);
});

test("dedicated V3 topology renders projection-only nodes plus canonical edges and pulses", () => {
  const projection = projectionWithV3OnlyNode();
  const now = Date.parse("2026-07-31T12:00:10Z");
  const [graph] = liveTopologyProjectionSetV3([projection], now);
  assert.equal(graph.nodes.some((node) => node.component_id === "v3-only"), true);
  assert.deepEqual(graph.edges.map((edge) => edge.edge_id), projection.graph.edges.map((edge) => edge.edge_id));
  assert.deepEqual(graph.edges.filter((edge) => edge.active).map((edge) => edge.edge_id), ["payment-v3-only"]);
  assert.deepEqual(graph.active_pulses[0].edge_ids, ["payment-v3-only"]);

  const html = renderLiveTopologyV3([projection], "connected", now);
  assert.match(html, /data-v3-live-node="v3-only"/);
  assert.match(html, /data-v3-live-edge="payment-v3-only"/);
  assert.match(html.match(/<path[^>]*data-v3-live-edge="payment-v3-only"[^>]*>/)?.[0] || "", /is-active/);
  assert.doesNotMatch(html, /legacy-only/);
});

test("Live activation hides legacy topology, renders a V3-only node, removes completed graph, and restores cleanup", async () => {
  const projection = projectionWithV3OnlyNode();
  const snapshot = snapshotForProjection(projection);
  let liveHandlers = null;
  let projectionCalls = 0;
  let streamClosed = false;
  const client = {
    liveSnapshot: async () => structuredClone(snapshot),
    projection: async () => { projectionCalls += 1; return structuredClone(projection); },
    subscribeLive: (handlers) => { liveHandlers = handlers; return { close: () => { streamClosed = true; } }; }
  };
  const canvas = { dataset: {} };
  const root = { dataset: {} };
  const topologyElement = fakeElement({ hidden: true, parentElement: canvas });
  const legacyTopology = fakeLegacyTopology(false, '<div data-node-id="legacy-only"></div>');
  const legacyLoading = fakeLegacyTopology(false, '<span>legacy loading</span>');
  const legacyAnnotation = fakeLegacyTopology(false, '<span>legacy annotation</span>');
  const legacyStagePanel = fakeLegacyTopology(true, '<span>legacy stage</span>');
  const adapter = new LiveIncidentAdapterV3({
    element: fakeElement({ hidden: true }), topologyElement, legacyTopology,
    legacyRoot: root,
    legacySurfaces: [legacyLoading, legacyAnnotation, legacyStagePanel],
    client, onOpen() {}
  });

  await adapter.activate();
  assert.equal(legacyTopology.hidden, true);
  assert.equal(legacyTopology.getAttribute("aria-hidden"), "true");
  assert.equal(legacyLoading.hidden, true);
  assert.equal(legacyAnnotation.hidden, true);
  assert.equal(legacyStagePanel.hidden, true);
  assert.equal(topologyElement.hidden, false);
  assert.equal(canvas.dataset.v3LiveTopology, "true");
  assert.equal(root.dataset.v3LiveActive, "true");
  assert.match(topologyElement.innerHTML, /data-v3-live-node="v3-only"/);
  assert.doesNotMatch(topologyElement.innerHTML, /legacy-only/);
  assert.equal(projectionCalls, 1);

  const incident = snapshot.incidents[0];
  liveHandlers.onEvent({
    schema_version: "flowpulse.live-event.v3", event_id: "live-complete", sequence: snapshot.sequence + 1,
    event_type: "incident.completed", occurred_at: "2026-07-31T12:01:00Z",
    incident: { ...incident, sequence: incident.sequence + 1, projection_revision: incident.projection_revision + 1, lifecycle_state: "RESOLVED" }
  });
  assert.equal(adapter.projections.size, 0);
  assert.doesNotMatch(topologyElement.innerHTML, /data-v3-live-graph=/);

  adapter.deactivate();
  assert.equal(streamClosed, true);
  assert.equal(topologyElement.hidden, true);
  assert.equal(topologyElement.innerHTML, "");
  assert.equal(canvas.dataset.v3LiveTopology, undefined);
  assert.equal(root.dataset.v3LiveActive, undefined);
  assert.equal(legacyTopology.hidden, false);
  assert.equal(legacyTopology.getAttribute("aria-hidden"), null);
  assert.equal(legacyLoading.hidden, false);
  assert.equal(legacyAnnotation.hidden, false);
  assert.equal(legacyStagePanel.hidden, true);
  assert.equal(legacyLoading.getAttribute("aria-hidden"), null);
  assert.equal(legacyTopology.innerHTML.includes("legacy-only"), true);
});

test("V3 Live integration overlays incidents without replacing the established runtime canvas", async () => {
  const [app, styles, html] = await Promise.all([
    readSource("../public/control-plane-app.mjs"),
    readSource("../public/styles.css"),
    readSource("../public/index.html")
  ]);
  assert.doesNotMatch(html, /id="v3-live-topology"/);
  assert.match(app, /topologyElement: null/);
  assert.match(app, /legacyTopology: null/);
  assert.match(app, /legacySurfaces: \[\]/);
  assert.doesNotMatch(app, /legacyRoot: root/);
  assert.doesNotMatch(styles, /data-v3-live-active/);
});

test("an ordered Live SSE update refreshes only the affected V3 projection", async () => {
  const first = projectionWithV3OnlyNode();
  const snapshot = snapshotForProjection(first);
  const second = structuredClone(first);
  second.sequence += 1;
  second.projection_revision += 1;
  second.graph.nodes.find((node) => node.component_id === "v3-only").runtime_status = "recovering";
  let current = first;
  let handlers = null;
  const calls = [];
  const client = {
    liveSnapshot: async () => structuredClone(snapshot),
    projection: async (caseId) => { calls.push(caseId); return structuredClone(current); },
    subscribeLive: (value) => { handlers = value; return { close() {} }; }
  };
  const topologyElement = fakeElement({ hidden: true, parentElement: { dataset: {} } });
  const adapter = new LiveIncidentAdapterV3({
    element: fakeElement({ hidden: true }), topologyElement, legacyTopology: fakeLegacyTopology(false), client, onOpen() {}
  });
  await adapter.activate();
  current = second;
  const incident = snapshot.incidents[0];
  handlers.onEvent({
    schema_version: "flowpulse.live-event.v3", event_id: "live-update", sequence: snapshot.sequence + 1,
    event_type: "incident.updated", occurred_at: "2026-07-31T12:00:20Z",
    incident: { ...incident, sequence: second.sequence, projection_revision: second.projection_revision }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [first.case_id, first.case_id]);
  assert.match(topologyElement.innerHTML, /data-runtime-status="recovering"/);
  adapter.deactivate();
});

test("a Live gap during projection hydration performs one trailing canonical rehydrate", async () => {
  const projection = projectionWithV3OnlyNode();
  const snapshot = snapshotForProjection(projection);
  let snapshotCalls = 0;
  let projectionCalls = 0;
  let releaseFirstProjection;
  const firstProjection = new Promise((resolve) => { releaseFirstProjection = resolve; });
  const streams = [];
  const client = {
    liveSnapshot: async () => {
      snapshotCalls += 1;
      return structuredClone(snapshot);
    },
    projection: async () => {
      projectionCalls += 1;
      if (projectionCalls === 1) return firstProjection;
      return structuredClone(projection);
    },
    subscribeLive: (handlers) => {
      const stream = { handlers, closed: false };
      streams.push(stream);
      return { close: () => { stream.closed = true; } };
    }
  };
  const adapter = new LiveIncidentAdapterV3({
    element: fakeElement({ hidden: true }),
    topologyElement: fakeElement({ hidden: true, parentElement: { dataset: {} } }),
    legacyTopology: fakeLegacyTopology(false), client, onOpen() {}
  });

  const activation = adapter.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streams.length, 1);
  streams[0].handlers.onConnection("stale");
  assert.equal(streams[0].closed, true);
  releaseFirstProjection(structuredClone(projection));
  await activation;

  assert.equal(snapshotCalls, 2);
  assert.equal(projectionCalls, 2);
  assert.equal(streams.length, 2);
  assert.equal(streams[1].closed, false);
  assert.notEqual(adapter.subscription, null);
  assert.equal(adapter.connection, "connected");
  adapter.deactivate();
});

test("a completed incident is removed from the active Live snapshot immediately", () => {
  const snapshot = v3LiveSnapshot();
  const incident = snapshot.incidents[0];
  const next = applyLiveEventV3(snapshot, {
    sequence: snapshot.sequence + 1,
    occurred_at: "2026-07-31T12:01:00Z",
    event_type: "incident.completed",
    incident: { ...incident, lifecycle_state: "RESOLVED" }
  });
  assert.equal(next.sequence, snapshot.sequence + 1);
  assert.deepEqual(next.incidents, []);
});

function projectionWithV3OnlyNode() {
  const projection = v3Projection();
  const template = projection.graph.nodes[0];
  projection.graph.nodes.push({
    ...template,
    component_id: "v3-only",
    canonical_identity: "service:v3-only",
    display_name: "V3-only worker",
    runtime_status: "critical",
    impact_status: "impacted"
  });
  projection.graph.edges.push({
    edge_id: "payment-v3-only",
    source_component_id: "payment",
    target_component_id: "v3-only",
    status: "critical"
  });
  projection.graph.active_pulses = [{
    pulse_id: "pulse-v3-only",
    edge_ids: ["payment-v3-only"],
    expires_at: "2026-07-31T12:00:30Z"
  }];
  projection.impacted_path.push("v3-only");
  return projection;
}

function snapshotForProjection(projection) {
  const snapshot = v3LiveSnapshot();
  snapshot.sequence = projection.sequence;
  snapshot.incidents[0] = {
    ...snapshot.incidents[0],
    case_id: projection.case_id,
    incident_id: projection.incident_id,
    run_id: projection.run_id,
    topology_revision: projection.topology_revision,
    projection_revision: projection.projection_revision,
    sequence: projection.sequence,
    severity: projection.severity,
    lifecycle_state: projection.lifecycle_state,
    freshness: structuredClone(projection.freshness),
    impacted_components: [...projection.impacted_path],
    current_stage: projection.current_attempt.current_stage
  };
  return snapshot;
}

function fakeElement({ hidden = false, parentElement = null } = {}) {
  return { hidden, parentElement, innerHTML: "", addEventListener() {} };
}

function fakeLegacyTopology(hidden, innerHTML = "") {
  const attributes = new Map();
  return {
    hidden,
    innerHTML,
    getAttribute: (name) => attributes.has(name) ? attributes.get(name) : null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name)
  };
}

async function readSource(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(path, import.meta.url), "utf8");
}

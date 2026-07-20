import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARCHITECTURE_LAYERS,
  AGENT_COLLABORATORS,
  LIVE_LAYERS,
  PULSE_SLOTS,
  TWIN_EDGES,
  TWIN_ICONS,
  TWIN_NODES,
  TWIN_STAGES,
  activeIncidentState,
  architectureBoundaries,
  architectureViewTopology,
  availableStage,
  architecturePositions,
  compareFrames,
  compareProvenance,
  eventsAtStage,
  frameFor,
  liveEdgePath,
  liveEdgeRoute,
  liveIncidentNodeStates,
  liveSignalDuration,
  liveSignalProgress,
  livePulseSlots,
  livePositions,
  orderedSignalEdges,
  primaryLiveEdges,
  projectAgentCollaborators,
  topologyIntegrity
} from "../public/twin-state.mjs";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const architectureRefinementCss = stylesCss.slice(stylesCss.lastIndexOf("/* Architecture refinement: compact nested anatomy"));
const architectureMaterialCss = architectureRefinementCss.slice(0, architectureRefinementCss.indexOf("@media (max-width: 1320px)"));
const topologyManifest = JSON.parse(readFileSync(new URL("../data/topology/otel-demo-system-v1.json", import.meta.url), "utf8"));

function backendArchitectureView() {
  const controls = [
    { id: "deployment", kind: "deployment", display_class: "change", plane: "control", layer: "change", label: "Deployment", status: "observed", source_health: "unavailable", signal_types: [], provenance_refs: ["evidence://ev-deploy-checkout"] },
    { id: "agent", kind: "service", display_class: "agent", plane: "control", layer: "investigation", label: "Investigator", status: "idle", source_health: "unavailable", signal_types: [], provenance_refs: ["code://flowpulse/investigator"] },
    { id: "evaluator", kind: "service", display_class: "evaluator", plane: "control", layer: "evaluation", label: "Evaluator", status: "idle", source_health: "unavailable", signal_types: [], provenance_refs: ["code://flowpulse/evaluator"] },
    { id: "ledger", kind: "dataset", display_class: "ledger", plane: "evidence", layer: "evidence", label: "Evidence Ledger", status: "recording", source_health: "unavailable", signal_types: [], provenance_refs: ["ledger://append-only"] }
  ];
  const controlEdges = [{ id: "deployment-checkout", from: "deployment", to: "checkout", kind: "affects", plane: "control", label: "Deployment evidence", status: "observed", provenance_refs: ["evidence://ev-deploy-checkout"] }];
  const nodes = [...topologyManifest.nodes, ...controls];
  const edges = [...topologyManifest.edges, ...controlEdges];
  return {
    schema_version: "flowpulse.topology-views.v1",
    truth: { source_health: "unavailable", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay", label: "CAPTURED" },
    architecture: {
      graph: { nodes, edges, total_nodes: nodes.length, total_edges: edges.length, truncated: false },
      runtime_data: { node_count: 22, edge_count: 22 },
      control_evidence: { node_count: 4, relation_count: 1 }
    }
  };
}

test("Architecture accepts only the complete backend topology view and retains separate control evidence counts", () => {
  const view = architectureViewTopology(backendArchitectureView());
  assert.ok(view);
  assert.equal(view.graph.nodes.length, 26);
  assert.equal(view.runtime_data.node_count, 22);
  assert.equal(view.runtime_data.edge_count, 22);
  assert.equal(view.control_evidence.node_count, 4);
  assert.equal(view.control_evidence.relation_count, 1);
  assert.deepEqual(view.graph.nodes.filter((node) => ["control", "evidence"].includes(node.plane)).map((node) => node.id).sort(), ["agent", "deployment", "evaluator", "ledger"]);
  assert.equal(view.graph.edges.filter((edge) => edge.plane === "runtime").length, 22);
  assert.equal(view.graph.edges.filter((edge) => ["control", "evidence"].includes(edge.plane)).length, 1);
  const ids = new Set(view.graph.nodes.map((node) => node.id));
  assert.equal(view.graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)), true);
  const boundaries = architectureBoundaries(view.graph);
  assert.equal(boundaries.observed.nodes.length, 22);
  assert.equal(boundaries.observed.relations.length, 22);
  assert.equal(boundaries.flowpulse.nodes.length, 4);
  assert.equal(boundaries.flowpulse.internal_relations.length, 0);
  assert.equal(boundaries.cross_boundary_relations.length, 1);
  assert.equal(boundaries.cross_boundary_relations[0].id, "deployment-checkout");
  assert.equal(boundaries.observed.nodes.some((node) => ["deployment", "agent", "evaluator", "ledger"].includes(node.id)), false);
  assert.equal(boundaries.flowpulse.nodes.every((node) => ["control", "evidence"].includes(node.plane)), true);
  const positioned = new Map(architecturePositions(boundaries.observed.nodes).map((node) => [node.id, node]));
  for (const node of boundaries.observed.nodes) {
    assert.equal(positioned.get(node.id).layer, node.layer);
  }

  assert.equal(architectureViewTopology({ schema_version: "flowpulse.topology-views.v1", architecture: { graph: { nodes: topologyManifest.nodes, edges: topologyManifest.edges } } }), null);
  const invalid = backendArchitectureView();
  invalid.architecture.graph.edges[0] = { ...invalid.architecture.graph.edges[0], to: "missing" };
  assert.equal(architectureViewTopology(invalid), null);
  const unsafe = backendArchitectureView();
  unsafe.architecture.graph.nodes[0] = { ...unsafe.architecture.graph.nodes[0], raw_trace: "not browser-safe" };
  assert.equal(architectureViewTopology(unsafe), null);

  const architectureFunction = appJs.match(/function architectureTopology\(\) \{[\s\S]+?\n\}/)?.[0] || "";
  assert.match(architectureFunction, /architectureViewTopology\(state\?\.topology_views\)/);
  assert.doesNotMatch(architectureFunction, /sourceState\(|TWIN_NODES|TWIN_EDGES/);
  assert.match(appJs, /architectureComponentContext/);
  assert.match(appJs, /function architectureView\(\) \{[\s\S]+architectureViewTopology\(state\?\.topology_views\)/);
  assert.match(appJs, /architecture-observed-system/);
  assert.match(appJs, /architecture-flowpulse-system/);
  assert.match(appJs, /architectureBoundaries\(topology\)/);
  assert.match(appJs, /Cross-boundary evidence summary/);
});

test("light and pure-black themes have a persisted accessible toggle", () => {
  assert.match(indexHtml, /id="theme-toggle"[^>]+aria-label="Switch to pure black theme"/);
  assert.match(appJs, /localStorage\.setItem\("flowpulse-theme", theme\)/);
  assert.match(appJs, /flowpulse-theme=\$\{theme\}/);
  assert.match(stylesCss, /:root\[data-theme="dark"\]/);
  assert.match(stylesCss, /\.theme-toggle:focus-visible/);
});

test("the product opens on architecture and keeps advanced actions in an accessible menu", () => {
  assert.match(indexHtml, /id="app-shell"[^>]+data-mode="architecture"/);
  assert.match(indexHtml, /data-mode="architecture">Architecture</);
  assert.match(indexHtml, /data-mode="replay">Diagnose</);
  assert.match(indexHtml, /id="workspace-menu"[^>]*class="workspace-menu"/);
  assert.match(indexHtml, /id="live-button"[^>]*>Run GPT-5\.6</);
  assert.match(indexHtml, /id="details-button"[^>]*>Inspect run</);
  assert.match(appJs, /let mode = "architecture"/);
  assert.match(stylesCss, /\.mission-bar \{[^}]+display: flex;[^}]+justify-content: center;/s);
  assert.match(stylesCss, /\.mission-summary \{[^}]+clip-path: inset\(50%\)/s);
  assert.match(stylesCss, /\.stage-readout \{ display: none;/);
});

test("architecture uses a technical four-layer overview and exposes all Client Applications detail inline", () => {
  const observed = new Set(["load-generator", "frontend-web", "frontend-proxy", "frontend", "checkout", "cart", "payment", "currency", "shipping", "product-catalog", "recommendation", "ad", "email", "kafka", "accounting", "fraud-detection", "quote", "image-provider", "flagd", "telemetry-docs", "otelcol-contrib", "astronomy-db"]);
  const nodes = ARCHITECTURE_LAYERS.flatMap((layer) => layer.ids.filter((id) => observed.has(id)).map((id, index) => ({ id, label: id, kind: index === 0 ? "client" : "service" })));
  const first = architecturePositions(nodes);
  const second = architecturePositions([...nodes].reverse());
  const coordinates = (items) => Object.fromEntries(items.map(({ id, layer, x, y }) => [id, { layer, x, y }]));
  assert.deepEqual(coordinates(first), coordinates(second));
  assert.deepEqual([...new Set(first.map(({ layer }) => layer))], ARCHITECTURE_LAYERS.map(({ id }) => id));
  assert.ok(ARCHITECTURE_LAYERS.every(({ description }) => typeof description === "string" && description.length > 0));
  assert.ok(first.every(({ x, y }) => x >= 6 && x <= 94 && y >= 18 && y <= 82));
  assert.deepEqual([...new Set(first.map(({ layerSize }) => layerSize))], [2, 4, 6, 10]);
  for (const y of new Set(first.map((node) => node.y))) {
    const xs = first.filter((node) => node.y === y).map((node) => node.x).sort((a, b) => a - b);
    for (let index = 1; index < xs.length; index++) assert.ok((xs[index] - xs[index - 1]) * 12.8 >= 116);
  }
  assert.equal(architecturePositions([...nodes, { id: "agent", label: "Investigator", kind: "service", plane: "control", layer: "investigation" }]).some((node) => node.id === "agent"), false);
  assert.deepEqual(Object.fromEntries(ARCHITECTURE_LAYERS.map((layer) => [layer.id, topologyManifest.nodes.filter((node) => node.layer === layer.id).length])), {
    experience: 6,
    commerce: 9,
    processing: 3,
    platform: 4
  });
  assert.equal(ARCHITECTURE_LAYERS.find((layer) => layer.id === "experience")?.label, "Client applications");
  assert.equal(ARCHITECTURE_LAYERS.find((layer) => layer.id === "experience")?.description, "browser and traffic-entry services");
  assert.match(appJs, /if \(layout === "architecture"\) \{[\s\S]+architecture-systems/);
  assert.match(appJs, /architecture-observed-system/);
  assert.match(appJs, /architecture-flowpulse-system/);
  assert.match(appJs, /architecture-layer-grid/);
  assert.match(appJs, /architecture-layer-anatomy/);
  assert.match(appJs, /data-architecture-member-count/);
  assert.match(appJs, /data-architecture-thumbnail-id/);
  assert.match(appJs, /layer\.members\.map\(\(node\)/);
  assert.doesNotMatch(appJs, /layer\.members\.slice\(0, 4\)/);
  assert.match(appJs, /data-architecture-layer="experience"/);
  assert.match(appJs, /data-architecture-back/);
  assert.match(appJs, /renderArchitectureInlineNode\(architectureComponentContext\(node\.id\)\)/);
  assert.match(appJs, /architecture-inline-node-card/);
  assert.doesNotMatch(appJs, /architectureDetailNodeId|renderArchitectureComponentDetail|data-architecture-component-back|architectureFace === "component"/);
  assert.match(appJs, /node\.layer === layer\.id/);
  assert.match(appJs, /architectureFace === "experience"/);
  assert.match(appJs, /architectureCompact: true/);
  assert.match(appJs, /function setArchitectureFace\(/);
  assert.match(appJs, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(appJs, /dataset\.runtimeEdges/);
  assert.match(appJs, /dataset\.controlRelations/);
  assert.doesNotMatch(appJs, /architecture-edge-map|queueArchitectureRelationRender|architectureRelationPath|data-architecture-edge/);
  assert.doesNotMatch(stylesCss, /\.architecture-edge-map|\.architecture-edge-line|\.architecture-edge-group/);
  assert.match(stylesCss, /\.architecture-layer-grid \{[^}]+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(stylesCss, /\.architecture-workspace-turn \{[^}]+transform-style: preserve-3d;[^}]+250ms/s);
  assert.match(stylesCss, /\.architecture-workspace-turn\.is-turning-forward,[^}]+rotateY\(88deg\)/s);
  assert.match(stylesCss, /\.architecture-workspace-turn\.is-turning-back,[^}]+rotateY\(-88deg\)/s);
  assert.match(stylesCss, /\.architecture-workspace-face \{[^}]+backface-visibility: hidden;/s);
  assert.match(stylesCss, /\.architecture-experience-nodes \{[^}]+grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(architectureRefinementCss, /--architecture-vector: #58758e;/);
  assert.match(architectureRefinementCss, /\.architecture-observed-system \{[^}]+background: transparent;[^}]+box-shadow: none;[^}]+backdrop-filter: none;/s);
  assert.match(architectureRefinementCss, /\.architecture-workspace-face \{[^}]+background: transparent;[^}]+box-shadow: none;[^}]+backdrop-filter: none;/s);
  assert.match(architectureRefinementCss, /\.architecture-thumbnail-node \{[^}]+min-height: 54px;[^}]+grid-template-columns: 32px minmax\(0, 1fr\);[^}]+border-radius: var\(--architecture-node-radius\);/s);
  assert.match(architectureRefinementCss, /\.architecture-flowpulse-nodes \.source-node\.is-architecture-compact \{[^}]+height: 54px;[^}]+min-height: 54px;[^}]+grid-template-columns: 32px minmax\(0, 1fr\);/s);
  assert.match(architectureRefinementCss, /@media \(max-width: 1320px\) \{[\s\S]+?\.architecture-layer-anatomy \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: 7px; \}/);
  assert.match(architectureRefinementCss, /\.architecture-thumbnail-icon,\s*\.is-architecture-source \.source-node\.is-architecture-compact \.node-icon \{[^}]+color: var\(--architecture-vector\);/s);
  assert.match(architectureRefinementCss, /\.architecture-inline-node-card \{[^}]+border: 0;[^}]+border-radius: var\(--architecture-node-radius\);[^}]+background: rgba\(255, 255, 255, \.18\);/s);
  assert.match(architectureRefinementCss, /\.architecture-inline-node-facts dd \{[^}]+overflow-wrap: anywhere;[^}]+white-space: normal;/s);
  assert.doesNotMatch(architectureRefinementCss, /\.architecture-component-card|\.architecture-component-detail-face/);
  assert.match(architectureRefinementCss, /\.architecture-thumbnail-node \{[^}]+border-radius: var\(--architecture-node-radius\);[^}]+background: rgba\(255, 255, 255, \.18\);/s);
  assert.match(architectureRefinementCss, /\.source-node\.is-architecture-compact \{[^}]+border-radius: var\(--architecture-node-radius\);[^}]+background: rgba\(255, 255, 255, \.18\);/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.workspace-menu-panel,[\s\S]+?\.state-key \{[^}]+border: 0;[^}]+background: rgba\(255, 255, 255, \.3\);/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.context-drawer \{[^}]+background: rgba\(249, 251, 252, \.36\);/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.canvas-toolbar \{[^}]+grid-template-columns: minmax\(0, 1fr\) auto auto;/s);
  assert.match(architectureRefinementCss, /\.app-shell\[data-mode="architecture"\] \.canvas-toolbar > div:first-child \{ display: none; \}/);
  assert.doesNotMatch(architectureMaterialCss, /box-shadow: (?:0|-\d)/);
  assert.match(stylesCss, /\.is-architecture-source \.source-node\.is-architecture-compact \{[^}]+border: 0;[^}]+border-radius: var\(--architecture-node-radius\);/s);
  assert.match(stylesCss, /--architecture-page-radius: 22px;[\s\S]+--architecture-system-radius: 22px;[\s\S]+--architecture-node-radius: 14px;[\s\S]+--architecture-control-radius: 14px;/);
  assert.match(stylesCss, /--architecture-font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif;/);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-system \{[^}]+border: 0;[^}]+background: var\(--architecture-surface\);/s);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-flowpulse-system \{[^}]+background: var\(--architecture-surface-muted\);/s);
  assert.match(stylesCss, /@media \(prefers-reduced-transparency: reduce\)[\s\S]+backdrop-filter: none;/s);
  assert.match(stylesCss, /@supports not \(\(backdrop-filter: blur\(1px\)\)/);
  assert.match(stylesCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]+architecture-workspace-turn\.is-turning-forward/);
  assert.match(appJs, /service\.name=\$\{node\.id\}/);
  assert.match(appJs, /telemetry\.sdk\.language/);
  assert.match(appJs, /const origin = architecture \? `\$\{kindLabel\(node\.kind\)\} · \$\{node\.plane\} \/ \$\{node\.layer\}`/);
  assert.match(appJs, /class="visually-hidden">Observed System Data Source Architecture/);
  assert.doesNotMatch(appJs, /<header class="architecture-system-heading" data-system="observed">/);
  assert.doesNotMatch(appJs, /<strong>Data Source Architecture<\/strong>/);
  assert.doesNotMatch(appJs, /runtime and data source projection/);
  assert.doesNotMatch(appJs, /Technology stack overview/);
  assert.doesNotMatch(appJs, /metric-checkout-label"\]\.textContent = "Observed system"/);
  assert.doesNotMatch(appJs, /metric-payment-label"\]\.textContent = "Runtime dependencies"/);
});

test("live layout keeps the same deterministic layers with more room for dependency pulses", () => {
  const nodes = LIVE_LAYERS.flatMap((layer) => layer.ids.map((id, index) => ({ id, label: id, kind: index === 0 ? "client" : "service" })));
  const first = livePositions(nodes);
  const second = livePositions([...nodes].reverse());
  const coordinates = (items) => Object.fromEntries(items.map(({ id, layer, x, y }) => [id, { layer, x, y }]));
  assert.deepEqual(coordinates(first), coordinates(second));
  assert.deepEqual([...new Set(first.map(({ layer }) => layer))], LIVE_LAYERS.map(({ id }) => id));
  assert.deepEqual([...new Set(first.map(({ x }) => x))], [10, 30, 50, 70]);
  assert.ok(first.every(({ y }) => y >= 6.25 && y <= 93.75));
  assert.doesNotMatch(stylesCss, /\.architecture-guides/);
  assert.match(stylesCss, /\.live-guides span[^}]+top: 10px/s);
  assert.match(appJs, /livePositions\(topology\.nodes\)/);
  assert.match(indexHtml, /id="zoom-out"[^>]+aria-label="Zoom out"/);
  assert.match(indexHtml, /id="zoom-in"[^>]+aria-label="Zoom in"/);
  assert.match(appJs, /minScale: \.6, maxScale: 1\.6/);
  assert.match(appJs, /function containedLiveView/);
  assert.match(appJs, /\(rect\.width - inset \* 2\) \/ LIVE_WORLD\.width/);
  assert.match(appJs, /live-column-\$\{node\.layerIndex\} live-count-\$\{node\.layerSize\} live-index-\$\{node\.layerPosition\}/);
  assert.match(stylesCss, /\.is-live-source \.live-count-7\.live-index-6 \{ top: 87\.5%; \}/);
});

test("live topology normalizes endpoints and explains true telemetry islands", () => {
  const projected = topologyIntegrity({
    nodes: [{ id: "Frontend Web" }, { id: "checkout" }, { id: "telemetry_docs" }],
    edges: [
      { id: "web-checkout", from: "frontend_web", to: "checkout" },
      { id: "bad", from: "checkout", to: "missing-service" }
    ]
  });
  assert.deepEqual(projected.edges.map(({ from, to }) => [from, to]), [["frontend-web", "checkout"]]);
  assert.deepEqual(projected.invalid_edges.map(({ id }) => id), ["bad"]);
  assert.deepEqual(projected.unlinked_node_ids, ["telemetry-docs"]);
  assert.equal(projected.nodes.find(({ id }) => id === "telemetry-docs").connectivity, "unlinked");
  assert.match(appJs, /Insufficient dependency evidence/);
});

test("captured browser topology consumes the bounded projection aliases and keeps every valid replay edge", () => {
  const projected = topologyIntegrity({
    services: [
      { id: "frontend", kind: "client" }, { id: "checkout", kind: "service" }, { id: "payment", kind: "api" },
      { id: "kafka", kind: "stream" }, { id: "accounting", kind: "worker" }, { id: "fraud", kind: "worker" }
    ],
    dependencies: [
      { id: "frontend-checkout", from: "frontend", to: "checkout" },
      { id: "checkout-payment", from: "checkout", to: "payment" },
      { id: "checkout-kafka", from: "checkout", to: "kafka" },
      { id: "kafka-accounting", from: "kafka", to: "accounting" },
      { id: "kafka-fraud", from: "kafka", to: "fraud" }
    ]
  });
  assert.equal(projected.nodes.length, 6);
  assert.equal(projected.edges.length, 5);
  assert.deepEqual(primaryLiveEdges(projected).map(({ id }) => id), [
    "checkout-kafka", "checkout-payment", "frontend-checkout", "kafka-accounting", "kafka-fraud"
  ]);
  assert.match(appJs, /const topology = architecture \? architecture\.graph : topologyIntegrity\(source\.topology\)/);
  assert.match(appJs, /sourceState\(\)\.status === "captured" \? "Captured replay"/);
  assert.match(stylesCss, /\.is-live-source \.edge-group \.edge-line \{ stroke: #9ca5b0; stroke-width: 1\.5; opacity: \.82; \}/);
  assert.match(appJs, /event\.target\.matches\("\[data-node-id\], \[data-edge-id\], \[data-agent-edge-id\]"\)/);
  assert.match(appJs, /event\.target\.dataset\.nodeId\) openDrawer\(\{ type: "node"/);
});

test("B1 recovery console keeps six collaborators visible while owner approval stays separate", () => {
  assert.match(indexHtml, /data-mode="agents">Recovery Console</);
  assert.match(indexHtml, /id="manager-panel"[^>]+aria-labelledby="manager-title"/);
  assert.match(indexHtml, /id="approve-button"[^>]+hidden>Approve bounded recovery/);
  assert.match(indexHtml, /Chat can explain or delegate safe work\. It cannot approve remediation\./);
  assert.match(appJs, /mode = "agents"/);
  assert.equal(AGENT_COLLABORATORS.length, 6);
  assert.deepEqual(AGENT_COLLABORATORS.map(({ id }) => id), ["commander", "observer", "investigator", "critic", "recovery-engineer", "verifier"]);
  assert.match(appJs, /data-collaborator-id/);
  assert.match(stylesCss, /\.collaborator-node\.is-selected \.collaborator-icon/);
  assert.match(appJs, /class="recovery-console-layout"/);
  assert.match(appJs, /data-recovery-action/);
  assert.match(appJs, /Ask \$\{escapeHtml\(selectedAgent\.label\)\} about this incident/);
  assert.match(appJs, /Owner approval remains separate/);
});

test("collaborator projection deterministically aggregates isolated backend roles", () => {
  const control = {
    current_agent_id: "owner",
    report: { human_gate: "owner_approval_required" },
    graph: { nodes: [
      { id: "manager", status: "running" }, { id: "monitor", status: "complete" }, { id: "evidence", status: "complete" },
      { id: "diagnosis", status: "complete" }, { id: "evaluator", status: "complete" }, { id: "planner", status: "complete" },
      { id: "executor", status: "standby" }, { id: "verification", status: "standby" }, { id: "evolve", status: "standby" }, { id: "test", status: "standby" }
    ] },
    activity: [{ id: "ev-1", agent_id: "evidence", summary: "Cited deployment evidence", evidence_refs: ["ev-deploy-checkout"] }]
  };
  const team = projectAgentCollaborators(control);
  assert.equal(team.nodes.length, 6);
  assert.equal(team.currentId, "recovery-engineer");
  assert.equal(team.nodes.find(({ id }) => id === "observer").latestActivity.id, "ev-1");
  assert.equal(team.nodes.find(({ id }) => id === "recovery-engineer").status, "waiting");
  assert.equal(team.edges.find(({ id }) => id === "critic-recovery").status, "waiting");
  assert.equal(team.nodes.some(({ id }) => ["owner", "ledger", "langfuse"].includes(id)), false);
});

test("every component has a vector icon and causal pulses remain sequential", () => {
  assert.deepEqual(Object.keys(TWIN_ICONS).sort(), TWIN_NODES.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(PULSE_SLOTS).sort(), TWIN_EDGES.map(({ id }) => id).sort());
  assert.ok(PULSE_SLOTS["deployment-checkout"] < PULSE_SLOTS["frontend-checkout"]);
  assert.ok(PULSE_SLOTS["frontend-checkout"] < PULSE_SLOTS["checkout-payment"]);
  assert.ok(PULSE_SLOTS["checkout-payment"] < PULSE_SLOTS["checkout-kafka"]);
  assert.ok(PULSE_SLOTS["checkout-kafka"] < PULSE_SLOTS["kafka-accounting"]);
  assert.ok(PULSE_SLOTS["kafka-accounting"] < PULSE_SLOTS["kafka-fraud"]);
});

test("runtime, control-plane, and derived-outcome semantics stay explicit", () => {
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "runtime").map(({ id }) => id),
    ["frontend", "checkout", "payment", "kafka", "accounting", "fraud"]
  );
  assert.deepEqual(
    TWIN_NODES.filter(({ plane }) => plane === "control").map(({ id }) => id),
    ["deployment", "agent", "evaluator", "ledger"]
  );
  assert.deepEqual(
    frameFor(7).annotations.filter(({ role }) => role === "outcome").map(({ id }) => id),
    ["recovery", "learning"]
  );
});

test("digital twin keeps stable component identities and coordinates across every stage", () => {
  const identities = TWIN_NODES.map(({ id, x, y }) => ({ id, x, y }));
  const edges = TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path }));
  for (let index = 0; index < TWIN_STAGES.length; index++) {
    const frame = frameFor(index);
    assert.deepEqual(TWIN_NODES.map(({ id, x, y }) => ({ id, x, y })), identities);
    assert.deepEqual(TWIN_EDGES.map(({ id, from, to, path }) => ({ id, from, to, path })), edges);
    assert.deepEqual(Object.keys(frame.nodeStates).sort(), identities.map(({ id }) => id).sort());
  }
});

test("ledger milestones deterministically unlock the replay stages", () => {
  const events = [
    { type: "incident.opened" },
    { type: "loop.symptoms_collected" },
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "verification.completed" },
    { type: "policy.evaluated" }
  ];
  assert.equal(availableStage(events.slice(0, 1)), 0);
  assert.equal(availableStage(events.slice(0, 2)), 2);
  assert.equal(availableStage(events.slice(0, 3)), 3);
  assert.equal(availableStage(events.slice(0, 4)), 4);
  assert.equal(availableStage(events.slice(0, 5)), 5);
  assert.equal(availableStage(events.slice(0, 6)), 6);
  assert.equal(availableStage(events), 7);
});

test("seeking the same stage reconstructs identical canvas state", () => {
  const first = frameFor(4);
  const second = frameFor(4);
  assert.deepEqual(first, second);
  assert.equal(first.nodeStates.checkout, "root");
  assert.equal(first.nodeStates.payment, "root");
  assert.equal(first.edgeStates["checkout-payment"], "root");
  assert.ok(first.annotations.some((note) => note.id === "replan"));
});

test("compare uses incident and verified frames without changing layout", () => {
  const { incident, recovered } = compareFrames();
  assert.equal(incident.nodeStates.checkout, "impact");
  assert.equal(recovered.nodeStates.checkout, "verified");
  assert.equal(incident.metrics.checkout.value, "38.4%");
  assert.equal(recovered.metrics.checkout.value, "0.8%");
  assert.equal(TWIN_NODES.length, 10);
  assert.match(indexHtml, /id="compare-range"[^>]+step="1"/);
  assert.match(indexHtml, /id="compare-canvas-range"[^>]+type="range"[^>]+step="1"/);
  assert.match(appJs, /--compare-percent/);
  assert.match(appJs, /addEventListener\("pointerdown", startCompareDrag\)/);
  assert.match(appJs, /function updateCompareFromPointer\(clientX\)/);
  assert.doesNotMatch(appJs, /Math\.round\(comparePercent \/ 10\)/);
  assert.doesNotMatch(stylesCss, /\.compare-value-\d+/);
});

test("compare exposes causal, recovery, and learning decisions beside the deterministic split", () => {
  assert.match(indexHtml, /id="compare-review-rail"/);
  assert.match(indexHtml, /data-compare-focus="impact"/);
  assert.match(indexHtml, /data-compare-focus="learning"/);
  assert.match(appJs, /function compareDecisionModel\(\)/);
  assert.match(appJs, /evaluation\.rejected/);
  assert.match(appJs, /repair\.proposed/);
  assert.match(appJs, /verification\.completed/);
  assert.match(appJs, /regression\.created/);
  assert.match(appJs, /function handleCompareReview/);
  assert.match(stylesCss, /\.compare-review-rail/);
  assert.match(stylesCss, /data-compare-focus="cause"/);
});

test("compare is always available and labels captured previews separately from current verification", () => {
  assert.deepEqual(compareProvenance([]), {
    label: "Captured recovery preview",
    tone: "preview",
    status: "Deterministic captured preview",
    caption: "Verified recovery is projected from the deterministic captured incident bundle",
    aria: "captured deterministic recovery preview"
  });
  assert.equal(compareProvenance([{ type: "verification.completed", payload: { passed: false } }]).label, "Captured recovery preview");
  assert.deepEqual(compareProvenance([{ type: "verification.completed", payload: { passed: true } }]), {
    label: "Current verified run",
    tone: "verified",
    status: "Authoritative current-run comparison",
    caption: "Passed recovery verification recorded in the current immutable ledger",
    aria: "current run with passed recovery verification"
  });
  const setModeSource = appJs.match(/function setMode\(nextMode\) \{[\s\S]+?\n\}/)?.[0] || "";
  assert.doesNotMatch(setModeSource, /nextMode === "compare"/);
  assert.match(appJs, /Drag to compare incident with \$\{provenance\.aria\}/);
  assert.match(appJs, /mode === "compare" \? compareProvenance\(state\.events\)\.tone : source\.status/);
  assert.match(stylesCss, /\.capture-label\.source-preview::before \{ background: var\(--amber\); \}/);
});

test("live connector paths terminate at card boundaries for target viewport widths", () => {
  const from = { x: 6, y: 25 };
  const to = { x: 31, y: 25 };
  for (const canvasWidth of [1100, 1280, 1440]) {
    const route = liveEdgeRoute(from, to, { canvasWidth, canvasHeight: 520, nodeWidth: 144, nodeHeight: 58 });
    const { x: startX, y: startY } = route[0];
    const { x: endX, y: endY } = route.at(-1);
    const halfCard = (144 / canvasWidth) * 500;
    assert.ok(Math.abs(startX - (from.x * 10 + halfCard)) < 0.01);
    assert.ok(Math.abs(endX - (to.x * 10 - halfCard)) < 0.01);
    assert.equal(startY, from.y * 5.2);
    assert.equal(endY, to.y * 5.2);
  }

  const crossLayer = liveEdgeRoute({ x: 31, y: 17 }, { x: 68, y: 61 }, {
    canvasWidth: 1440,
    canvasHeight: 620,
    nodeWidth: 144,
    nodeHeight: 58,
    lane: 1
  });
  const scaledHalfWidth = 144 * (1000 / 1440) / 2;
  assert.ok(Math.abs(crossLayer[0].x - (310 + scaledHalfWidth)) < 0.01);
  assert.ok(Math.abs(crossLayer.at(-1).x - (680 - scaledHalfWidth)) < 0.01);
  assert.ok(crossLayer.some(({ y }) => y < 40 || y > 480));
  assert.match(liveEdgePath(from, to), /^M .+ L .+ Q /);
});

test("reserved live routes avoid every non-endpoint card", () => {
  const topology = topologyIntegrity({
    nodes: [
      { id: "frontend", kind: "client" }, { id: "checkout", kind: "service" }, { id: "cart", kind: "service" },
      { id: "payment", kind: "api" }, { id: "kafka", kind: "stream" }, { id: "flagd", kind: "service" }
    ],
    edges: [
      { id: "front-checkout", from: "frontend", to: "checkout" },
      { id: "checkout-cart", from: "checkout", to: "cart" },
      { id: "checkout-payment", from: "checkout", to: "payment" },
      { id: "cart-flagd", from: "cart", to: "flagd" }
    ]
  });
  const positions = livePositions(topology.nodes);
  const byId = new Map(positions.map((node) => [node.id, node]));
  const halfWidth = 144 * (1000 / 1480) / 2;
  const halfHeight = 58 * (520 / 680) / 2;
  for (const [index, edge] of topology.edges.entries()) {
    const lane = index % 2 ? Math.ceil(index / 2) : -Math.ceil((index + 1) / 2);
    const route = liveEdgeRoute(byId.get(edge.from), byId.get(edge.to), { canvasWidth: 1480, canvasHeight: 680, lane });
    for (const node of positions.filter(({ id }) => ![edge.from, edge.to].includes(id))) {
      const rect = { left: node.x * 10 - halfWidth, right: node.x * 10 + halfWidth, top: node.y * 5.2 - halfHeight, bottom: node.y * 5.2 + halfHeight };
      for (let point = 1; point < route.length; point++) assert.equal(segmentHitsRect(route[point - 1], route[point], rect), false, `${edge.id} crosses ${node.id}`);
    }
  }
});

function segmentHitsRect(a, b, rect) {
  if (a.x === b.x) return a.x > rect.left && a.x < rect.right && Math.max(Math.min(a.y, b.y), rect.top) < Math.min(Math.max(a.y, b.y), rect.bottom);
  if (a.y === b.y) return a.y > rect.top && a.y < rect.bottom && Math.max(Math.min(a.x, b.x), rect.left) < Math.min(Math.max(a.x, b.x), rect.right);
  return false;
}

test("live pulses follow deterministic topology depth with one segment per edge", () => {
  const topology = {
    nodes: ["frontend", "checkout", "payment", "kafka", "accounting"].map((id) => ({ id })),
    edges: [
      { id: "frontend->checkout", from: "frontend", to: "checkout" },
      { id: "checkout->payment", from: "checkout", to: "payment" },
      { id: "checkout->kafka", from: "checkout", to: "kafka" },
      { id: "kafka->accounting", from: "kafka", to: "accounting" }
    ]
  };
  assert.deepEqual(livePulseSlots(topology), {
    "frontend->checkout": 0,
    "checkout->kafka": 1,
    "checkout->payment": 2,
    "kafka->accounting": 3
  });
  assert.deepEqual(orderedSignalEdges(topology.edges, livePulseSlots(topology)).map(({ id }) => id), [
    "frontend->checkout",
    "checkout->kafka",
    "kafka->accounting",
    "checkout->payment"
  ]);
  assert.match(appJs, /data-live-edge-id/);
  assert.match(appJs, /data-signal-order/);
  assert.match(appJs, /classList\.toggle\("is-live-source", mode === "live"\)/);
  assert.match(appJs, /classList\.add\("is-signal-active"\)/);
  assert.match(appJs, /is-signal-launch/);
  assert.match(appJs, /is-signal-arrival/);
  assert.match(appJs, /class="signal-droplet"/);
  assert.match(appJs, /signal-droplet-tail-far/);
  assert.match(appJs, /path\.getPointAtLength\(path\.getTotalLength\(\) \* Math\.max/);
  assert.match(appJs, /place\(body, bodyPoint\)/);
  assert.match(appJs, /group\.dataset\.signalProgress = progress\.toFixed\(3\)/);
  assert.match(stylesCss, /\.is-live-source \.edge-group \{ --edge-signal: var\(--live-pulse\); \}/);
  assert.match(stylesCss, /--live-pulse: #159fe8/);
  assert.match(stylesCss, /\.signal-droplet-halo \{[^}]+opacity: \.15/s);
  assert.match(stylesCss, /\.edge-group\.is-signal-active \.signal-droplet \{ display: block; \}/);
  assert.doesNotMatch(stylesCss, /\.edge-group\.is-signal-active \.edge-line[^}]+animation/s);
  assert.doesNotMatch(appJs, /class="signal-trace"/);
  assert.doesNotMatch(appJs.match(/function startLiveSignalLoop\(\)[\s\S]+?\n\}/)?.[0] || "", /setInterval/);
  assert.match(appJs, /candidate\.dataset\.signalFrom === group\.dataset\.signalTo/);
  assert.match(appJs, /liveSignalDuration\(pathLength\)/);
  assert.match(appJs, /liveSignalProgress\(elapsed, pathLength\)/);
  assert.doesNotMatch(stylesCss.match(/@keyframes signal-node-arrival \{[\s\S]+?\n\}/)?.[0] || "", /border-color/);
  assert.match(stylesCss, /prefers-reduced-motion:[\s\S]+\.edge-group\.is-signal-active \.signal-droplet \{ display: none;/s);
  assert.match(appJs, /data-recovery-command-send/);
  assert.match(appJs, /sendRecoveryCommand\(commandButton\.closest\("form"\)\)/);
});

test("live renders a deterministic primary dependency skeleton without losing connected components", () => {
  const topology = topologyIntegrity({
    nodes: ["load-generator", "frontend-web", "frontend-proxy", "frontend", "checkout", "cart", "payment", "flagd"].map((id) => ({ id, kind: "service" })),
    edges: [
      { id: "load-generator->frontend-proxy", from: "load-generator", to: "frontend-proxy" },
      { id: "frontend-web->frontend-proxy", from: "frontend-web", to: "frontend-proxy" },
      { id: "frontend-proxy->frontend", from: "frontend-proxy", to: "frontend" },
      { id: "frontend->checkout", from: "frontend", to: "checkout" },
      { id: "frontend->cart", from: "frontend", to: "cart" },
      { id: "checkout->cart", from: "checkout", to: "cart" },
      { id: "checkout->payment", from: "checkout", to: "payment" },
      { id: "load-generator->flagd", from: "load-generator", to: "flagd" },
      { id: "cart->flagd", from: "cart", to: "flagd" }
    ]
  });
  const selected = primaryLiveEdges(topology);
  const selectedReversed = primaryLiveEdges({ nodes: [...topology.nodes].reverse(), edges: [...topology.edges].reverse() });
  const authoritative = new Set(topology.edges.map(({ id }) => id));
  const covered = new Set(selected.flatMap((edge) => [edge.from, edge.to]));
  const connected = new Set(topology.edges.flatMap((edge) => [edge.from, edge.to]));

  assert.ok(selected.length < topology.edges.length);
  assert.ok(selected.every(({ id }) => authoritative.has(id)));
  assert.deepEqual([...covered].sort(), [...connected].sort());
  assert.deepEqual(selectedReversed.map(({ id }) => id), selected.map(({ id }) => id));
  const inboundCounts = selected.reduce((counts, { to }) => counts.set(to, (counts.get(to) || 0) + 1), new Map());
  assert.equal(Math.max(...inboundCounts.values()), 2);
  assert.match(appJs, /const primaryEdges = primaryLiveEdges\(topology\)/);
  assert.match(appJs, /dataset\.observedEdges/);
  assert.match(appJs, /dataset\.displayedEdges/);
});

test("live signal travel keeps one physical speed and slows only at the destination", () => {
  const short = liveSignalDuration(100);
  const long = liveSignalDuration(300);
  assert.ok(Math.abs(long / short - 3) < 1e-9);
  assert.equal(liveSignalProgress(100, 520), .1);
  const terminalStartMs = (.84 * 520 / 520) * 1000;
  assert.equal(liveSignalProgress(terminalStartMs, 520), .84);
  assert.ok(liveSignalProgress(terminalStartMs + 100, 520) > .84);
  assert.equal(liveSignalProgress(liveSignalDuration(520), 520), 1);
});

test("active incident chrome appears only for unresolved real-development runs", () => {
  const unresolved = [{ type: "incident.opened" }];
  const resolved = [...unresolved, { type: "verification.completed", payload: { passed: true } }];
  assert.equal(activeIncidentState(unresolved), true);
  assert.equal(activeIncidentState(resolved), false);
  assert.match(appJs, /state\.mode === "development" && activeIncidentState\(state\.events\)/);
  assert.match(appJs, /mode !== "live" \|\| !activeIncident/);
});

test("source component drawers expose only data-bearing topology, signals, and immutable provenance", () => {
  assert.match(appJs, /function sourceComponentContext\(id\)/);
  assert.match(appJs, /function sourceDrawerTabs\(context\)/);
  assert.match(appJs, /Overview/);
  assert.match(appJs, /function renderSourceSignalSummary\(context\)/);
  assert.match(appJs, /Upstream/);
  assert.match(appJs, /Downstream/);
  assert.match(appJs, /function renderTelemetryPreview\(item\)/);
  assert.match(appJs, /item\.provenance\.byte_start/);
  assert.match(appJs, /item\.provenance\.sha256/);
  assert.match(stylesCss, /\.component-context/);
  assert.match(stylesCss, /\.signal-summary/);
  assert.match(stylesCss, /\.telemetry-preview/);
});

test("timeline renders only recorded milestones and labels the next evidence requirement", () => {
  assert.match(appJs, /const visible = stages\.slice\(0, available \+ 1\)/);
  assert.match(appJs, /function nextTimelineRequirement\(index\)/);
  assert.match(appJs, /awaiting recovery verification/);
  assert.match(stylesCss, /\.timeline-next/);
  assert.match(stylesCss, /--stage-count/);
});

test("recovery console keeps chat primary while secondary summary chrome stays hidden", () => {
  assert.match(stylesCss, /\[data-mode="agents"\] \.metric-cluster, \.app-shell\[data-mode="agents"\] \.legend-menu \{ display: none;/);
  assert.match(appJs, /Latest grounded signal/);
  assert.match(appJs, /Current ledger owner/);
  assert.match(appJs, /Evidence, activity &amp; controls/);
});

test("pure-black mode keeps structural component and connector edges high contrast", () => {
  assert.match(stylesCss, /:root\[data-theme="dark"\][\s\S]+--line-strong: #f0f0f0;/s);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.edge-line \{ stroke: #e7e7e7;/);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.twin-node \{[^}]+border-color: rgba\(255, 255, 255, \.78\)/s);
  assert.match(stylesCss, /\.is-architecture-source \.architecture-tier \.source-node \{ border-color: #f5f5f5; \}/);
});

test("live incident state requires referenced explicit development failure evidence", () => {
  const source = {
    status: "live",
    authoritative: true,
    topology: { nodes: [{ id: "checkout" }, { id: "payment" }, { id: "kafka" }], edges: [] },
    evidence: [{
      id: "live-failure",
      signal: "traces",
      value: { services: ["checkout", "payment"] },
      payload: {
        resourceSpans: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
          scopeSpans: [{ spans: [{ name: "payment", status: { code: 2, message: "unavailable" } }] }]
        }]
      }
    }]
  };
  const active = liveIncidentNodeStates({
    mode: "development",
    source,
    events: [{ type: "evidence.queried", evidence_refs: ["live-failure"] }]
  });
  assert.deepEqual(active, { checkout: "impact", payment: "impact", kafka: "observed" });
  assert.deepEqual(liveIncidentNodeStates({ mode: "captured", source, events: [{ evidence_refs: ["live-failure"] }] }), {
    checkout: "observed", payment: "observed", kafka: "observed"
  });
  assert.deepEqual(liveIncidentNodeStates({
    mode: "development",
    source,
    events: [
      { type: "evidence.queried", evidence_refs: ["live-failure"] },
      { type: "verification.completed", payload: { passed: true }, evidence_refs: [] }
    ]
  }), { checkout: "verified", payment: "verified", kafka: "observed" });
  assert.deepEqual(liveIncidentNodeStates({ source: { status: "stale", topology: source.topology } }), {
    checkout: "warning", payment: "warning", kafka: "warning"
  });
  assert.deepEqual(liveIncidentNodeStates({ source: { status: "disconnected", topology: source.topology } }), {
    checkout: "dormant", payment: "dormant", kafka: "dormant"
  });
});

test("every canvas mode exposes the shared status-dot contract with compact toolbar copy", () => {
  assert.match(appJs, /data-status="\$\{escapeHtml\(nodeState\)\}"/);
  assert.match(appJs, /data-status="\$\{escapeHtml\(agentNodeTone\(node\.status\)\)\}"/);
  assert.match(appJs, /data-status="\$\{escapeHtml\(status\)\}" data-transition-key/);
  assert.match(appJs, /node\.connectivity === "unlinked" \? "unlinked"/);
  assert.match(stylesCss, /\.twin-node\.is-observed[^}]+var\(--blue\)/);
  assert.match(stylesCss, /\.twin-node\.is-healthy[^}]+var\(--green\)/);
  assert.match(stylesCss, /\.twin-node\.is-warning[^}]+var\(--amber\)/);
  assert.match(stylesCss, /\.twin-node\.is-impact[^}]+var\(--red\)/);
  assert.match(stylesCss, /\.twin-node\.is-quiet[^}]+var\(--faint\)/);
  assert.match(indexHtml, />Status<\/strong>/);
  assert.match(indexHtml, /Live \/ active/);
  assert.match(indexHtml, /Failure \/ rejected/);
  assert.match(stylesCss, /\.metric small:empty \{ display: none; \}/);
  assert.match(appJs, /node\.connectivity === "unlinked" \? "unlinked" : nodeStates\[id\]/);
  assert.match(appJs, /sourceStatusLabel\(status, source\.status\)/);
  assert.match(stylesCss, /\.component-context\.is-warning, \.component-context\.is-unlinked/);
  assert.doesNotMatch(appJs, /observed components arranged by system role/);
  assert.doesNotMatch(appJs, /This canvas does not synthesize services or telemetry/);
});

test("component vectors stay transparent, semantically colored, and status-independent", () => {
  assert.match(stylesCss, /\.node-icon \{[^}]+border: 0;[^}]+color: var\(--icon\);[^}]+background: transparent;/);
  assert.match(stylesCss, /\.collaborator-icon \{[^}]+border: 0;[^}]+color: var\(--icon\);[^}]+background: transparent;[^}]+box-shadow: none;/);
  assert.match(stylesCss, /\.collaboration-avatar \{[^}]+border: 0;[^}]+color: var\(--icon\);[^}]+background: transparent;/);
  assert.match(stylesCss, /\.source-node\.kind-stream \{ --icon: #d97706;/);
  assert.match(stylesCss, /\.source-node\.kind-database \{ --icon: #059669;/);
  assert.match(stylesCss, /\.collaborator-node-recovery-engineer, \.icon-role-recovery-engineer \{ --icon: #ea580c;/);
  assert.match(appJs, /collaborator-icon icon-role-\$\{escapeHtml\(node\.id\)\}/);
  assert.match(appJs, /collaboration-avatar icon-role-\$\{escapeHtml\(selectedAgent\.id\)\}/);
  assert.match(stylesCss, /:root\[data-theme="dark"\] \.node-icon \{ color: var\(--icon\); background: transparent; \}/);
  assert.match(stylesCss, /\.twin-node\.is-impact[^}]+--signal: var\(--red\)/);
  assert.match(stylesCss, /\.collaborator-node\.is-verified \.node-status-dot[^}]+background: var\(--green\)/);
});

test("the contextual drawer and workspace menu use restrained semantic color", () => {
  assert.match(appJs, /context-drawer"\]\.dataset\.tone = drawerTone\(selected\)/);
  assert.match(appJs, /function drawerTone\(focus\)/);
  assert.match(appJs, /\["impact", "root", "rejected"\]\.includes\(source\.status\)/);
  assert.match(appJs, /source\.status === "verified"/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="stream"\] \{ --drawer-accent: #d97706;/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="impact"\] \{ --drawer-accent: var\(--red\); \}/);
  assert.match(stylesCss, /\.context-drawer\[data-tone="verified"\] \{ --drawer-accent: var\(--green\); \}/);
  assert.match(stylesCss, /\.drawer-header[^}]+box-shadow: inset 3px 0 0 var\(--drawer-accent\)/s);
  assert.match(stylesCss, /\.drawer-tab\[aria-selected="true"\][^}]+box-shadow: inset 0 -2px 0 var\(--drawer-accent\)/s);
  assert.match(stylesCss, /\.nav-button\[data-nav-tab="incidents"\] \{ --menu-accent: var\(--red\); \}/);
  assert.match(stylesCss, /\.nav-button::before[^}]+background: var\(--menu-accent, var\(--faint\)\)/s);
});

test("stage projection preserves evaluator, owner, recovery, and evolve ordering", () => {
  const events = [
    { type: "evaluation.rejected" },
    { type: "evaluation.accepted" },
    { type: "approval.requested" },
    { type: "approval.granted" },
    { type: "repair.executed" },
    { type: "verification.completed" },
    { type: "regression.created" },
    { type: "policy.evaluated" }
  ];
  assert.deepEqual(eventsAtStage(events, 3).map(({ type }) => type), ["evaluation.rejected"]);
  assert.deepEqual(eventsAtStage(events, 5).map(({ type }) => type), ["evaluation.rejected", "evaluation.accepted", "approval.requested"]);
  assert.deepEqual(eventsAtStage(events, 7).map(({ type }) => type), events.map(({ type }) => type));
});

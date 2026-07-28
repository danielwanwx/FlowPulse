import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connectedLiveTopology } from "../public/live-topology-renderer.mjs";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const controlPlaneApp = await readFile(new URL("../public/control-plane-app.mjs", import.meta.url), "utf8");
const legacyApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const stylesCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

test("the established FlowPulse shell is the only visible standard-path workspace", () => {
  assert.doesNotMatch(indexHtml, /id="control-plane-app"/);
  assert.match(indexHtml, /id="app-shell"[^>]*data-mode="architecture"(?![^>]*\bhidden\b)/);
  assert.match(indexHtml, /id="twin-canvas"/);
  assert.match(indexHtml, /id="context-drawer"/);
  assert.match(indexHtml, /id="incident-stage-rail"/);
  assert.match(indexHtml, /id="timeline-dock"/);
  const modes = [...indexHtml.matchAll(/class="mode-button[^>]*data-mode="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ["architecture", "live", "incident"]);
  assert.match(indexHtml, /src="\/app\.js"[\s\S]*src="\/control-plane-app\.mjs"/);
  assert.doesNotMatch(controlPlaneApp, /\/api\/(?:state|source|demo|agent-control)\b/);
  assert.match(controlPlaneApp, /new ControlPlaneClient\(\)/);
});

test("Architecture and Live retain the baseline renderer while the control-plane adapter owns Incident only", () => {
  assert.match(legacyApp, /renderSourceCanvas\("architecture"\)/);
  assert.match(legacyApp, /renderSourceCanvas\("live", shared\?\.topology/);
  assert.match(legacyApp, /if \(nextMode === "incident" && els\["app-shell"\]\.dataset\.controlPlaneAdapter === "true"\) return;/);
  assert.match(controlPlaneApp, /if \(state\.mode !== "incident"\) \{[\s\S]*?return;/);
  assert.match(controlPlaneApp, /root\.dataset\.controlPlaneMode = "incident"/);
});

test("Live omits zero-degree components and preserves only backend-projected edges", () => {
  const rendered = connectedLiveTopology({
    nodes: [
      { id: "checkout" },
      { id: "payment" },
      { id: "telemetry-docs", membership: "CLASSIFIED", classification_reason: "Relationship unavailable" }
    ],
    edges: [{ id: "checkout-payment", from: "checkout", to: "payment", kind: "calls" }]
  });
  assert.deepEqual(rendered.nodes.map((node) => node.id), ["checkout", "payment"]);
  assert.deepEqual(rendered.edges.map((edge) => edge.id), ["checkout-payment"]);
});

test("narrow Architecture gives the original observed canvas and Control System separate reachable regions", () => {
  const start = stylesCss.indexOf("/* narrow-architecture-ownership */");
  const end = stylesCss.indexOf("/* end-narrow-architecture-ownership */");
  const narrowArchitecture = start >= 0 && end > start ? stylesCss.slice(start, end) : "";
  assert.match(narrowArchitecture, /\.app-shell\[data-mode\] \.mode-switch \{ width: 100%; min-width: 0; \}/);
  assert.match(narrowArchitecture, /\.app-shell\[data-mode="architecture"\] \.operations-team-rail,[\s\S]*?\.app-shell\[data-mode="live"\] \.operations-team-rail \{ position: static; width: auto; height: auto;/);
  assert.match(narrowArchitecture, /\.app-shell\[data-mode="architecture"\] \.architecture-systems \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.match(narrowArchitecture, /\.app-shell\[data-mode="architecture"\] \.architecture-control-slot \{ display: none; \}/);
});

test("the decision workspace renders only the projection-owned investigation presentation", () => {
  assert.match(controlPlaneApp, /import \{ controlPlaneReducer, createControlPlaneState, investigationPresentation \}/);
  assert.match(controlPlaneApp, /investigationMarkup\(investigationPresentation\(projection\)\)/);
  assert.match(controlPlaneApp, /stageRailMarkup\(investigation\)/);
  assert.match(controlPlaneApp, /investigationEvidenceMarkup\(investigation\.evidence\)/);
  assert.doesNotMatch(controlPlaneApp, /receipt\.reason/);
  assert.doesNotMatch(controlPlaneApp, /workspace\.investigation\.[a-z]+.*summary/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const controlPlaneApp = await readFile(new URL("../public/control-plane-app.mjs", import.meta.url), "utf8");

test("the established FlowPulse shell is the only visible standard-path workspace", () => {
  assert.doesNotMatch(indexHtml, /id="control-plane-app"/);
  assert.match(indexHtml, /id="app-shell"[^>]*data-mode="architecture"(?![^>]*\bhidden\b)/);
  assert.match(indexHtml, /id="twin-canvas"/);
  assert.match(indexHtml, /id="context-drawer"/);
  assert.match(indexHtml, /id="incident-stage-rail"/);
  assert.match(indexHtml, /id="timeline-dock"/);
  const modes = [...indexHtml.matchAll(/class="mode-button[^>]*data-mode="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ["architecture", "live", "incident"]);
  assert.doesNotMatch(indexHtml, /src="\/app\.js"/);
  assert.match(indexHtml, /src="\/control-plane-app\.mjs"/);
  assert.doesNotMatch(controlPlaneApp, /\/api\/(?:state|source|demo|agent-control)\b/);
  assert.match(controlPlaneApp, /new ControlPlaneClient\(\)/);
});

test("the decision workspace renders only the projection-owned investigation presentation", () => {
  assert.match(controlPlaneApp, /import \{ controlPlaneReducer, createControlPlaneState, investigationPresentation \}/);
  assert.match(controlPlaneApp, /investigationMarkup\(investigationPresentation\(projection\)\)/);
  assert.match(controlPlaneApp, /stageRailMarkup\(investigation\)/);
  assert.match(controlPlaneApp, /investigationEvidenceMarkup\(investigation\.evidence\)/);
  assert.doesNotMatch(controlPlaneApp, /receipt\.reason/);
  assert.doesNotMatch(controlPlaneApp, /workspace\.investigation\.[a-z]+.*summary/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function documentText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const readme = documentText("README.md");
const harness = documentText("docs/architecture/flowpulse-harness.md");
const audit = documentText("docs/architecture/2026-07-19-backend-capability-audit.md");
const localFaultLoop = documentText("docs/architecture/local-fault-to-recovery-loop-contract.md");
const nodeInvestigation = documentText("docs/architecture/node-investigation-plane-frontend-contract.md");
const agentTeam = documentText("docs/architecture/agent-team-chat-backend-contract.md");
const northStarDocuments = new Map([
  ["README", readme],
  ["harness", harness],
  ["capability audit", audit],
  ["local-fault loop", localFaultLoop],
  ["node investigation", nodeInvestigation],
  ["Agent Team", agentTeam]
]);

function assertNoMatchingLines(pattern, description) {
  for (const [name, source] of northStarDocuments) {
    const matches = source.split(/\r?\n/).filter((line) => pattern.test(line));
    assert.deepEqual(matches, [], `${name} must not ${description}: ${matches.join(" | ")}`);
  }
}

function assertNoUnshippedControlPlaneClaim() {
  const delivery = /\b(?:is|are|has|have)\s+(?:integrated|available|live|shipped|delivered)\b/i;
  const futureQualifier = /\b(?:not|until|target|planned|missing)\b/i;
  const controlPlane = /\b(?:FastAPI|Temporal)(?:\/Temporal)?\b[^.\n]{0,160}\b(?:control-plane equivalent|control plane|integration)\b/i;

  for (const [name, source] of northStarDocuments) {
    const matches = source.split(/\r?\n/).filter((line) => {
      const controlPlaneMatch = controlPlane.exec(line);
      if (!controlPlaneMatch) return false;
      const controlPlaneClause = line.slice(controlPlaneMatch.index);
      const delivered = delivery.exec(controlPlaneClause);
      return delivered && !futureQualifier.test(line.slice(0, controlPlaneMatch.index + delivered.index));
    });
    assert.deepEqual(matches, [], `${name} must not claim an unshipped control-plane integration: ${matches.join(" | ")}`);
  }
}

test("North Star documents keep the agent-operating-system direction behind current proof and Temporal authority", () => {
  assert.match(readme, /model-agnostic/i);
  assert.match(readme, /company-multiplayer/i);
  assert.match(readme, /easy enough for anyone to use/i);
  assert.match(readme, /governed enough to act on real systems/i);
  assert.match(readme, /Incident[^.]{0,80}first vertical/i);
  assert.match(readme, /Architecture[^.]{0,80}Live[^.]{0,80}Incident/i);
  assert.match(readme, /append-only ledger and server-side policy record bounded local replay state/i);
  assert.match(readme, /do not own incident lifecycle transitions/i);
  assert.match(readme, /Temporal alone owns lifecycle transitions/i);

  assert.match(harness, /Temporal is the sole lifecycle authority\./);
  assert.match(harness, /Evidence Ledger.*current incident proof/i);
  assert.match(harness, /Knowledge Plane.*bounded priors/i);
  assert.match(harness, /Gate 1.*Gate 2/s);
  assert.match(harness, /tenant-scoped/i);
  assert.match(harness, /compatibility\/demo/i);

  assert.match(audit, /Historical audit and compatibility status/i);
  assert.match(audit, /real FastAPI\/Temporal control-plane equivalents/i);
  assert.doesNotMatch(audit, /production authority closure|only production authority composition root|The production decision, approval claim/i);
});

test("North Star documents reject contradictory workspace, shipped-control-plane, and Node-authority claims", () => {
  for (const [name, source] of northStarDocuments) {
    if (["README", "harness", "capability audit"].includes(name)) continue;
    assert.match(source, /Compatibility status/i, `${name} document must declare its compatibility status`);
    assert.match(source, /real FastAPI\/Temporal control-plane equivalent/i, `${name} document must name the replacement boundary`);
    assert.match(source, /does not grant (?:lifecycle |incident )?authority/i, `${name} document must deny browser/compatibility authority`);
  }

  assertNoMatchingLines(/\b(?:Diagnose|Recovery(?: Console)?|Compare)\b[^.\n]{0,100}\b(?:top[- ]level|primary|main|persistent)\s+(?:view|workspace)/i, "present a legacy incident workspace as primary navigation");
  assertNoUnshippedControlPlaneClaim();
  assertNoMatchingLines(/\b(?:Node|src\/server\.mjs|server-side policy)\b[^.\n]{0,180}\b(?:only\s+)?production authority(?:\s+(?:closure|composition root))?\b/i, "claim production authority for the Node compatibility path");
  assertNoMatchingLines(/\b(?:Node|src\/server\.mjs|server-side policy)\b[^.\n]{0,120}\b(?:owns?|is|are|serves as)\b[^.\n]{0,80}\b(?:sole lifecycle authority|incident lifecycle authority)\b/i, "claim lifecycle authority for the Node compatibility path");
  assertNoMatchingLines(/\bproduction (?:authority closure|decision|approval claim|authority composition root)\b/i, "describe a compatibility decision path as production authority");

  assert.match(agentTeam, /Provider truth labels remain independent/i);
  assert.match(agentTeam, /LOCAL CODEX/, "provider labels remain documented");
  assert.match(agentTeam, /OPENAI API/, "provider labels remain documented");
  assert.match(agentTeam, /RECORDED\/DEMO/, "provider labels remain documented");
});

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

function normalizedClaimFragments(source) {
  return source
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z#*-])/)
    .filter(Boolean);
}

function matchingClaimFragments(source, matchesClaim) {
  return normalizedClaimFragments(source).filter(matchesClaim);
}

const legacyWorkspace = "(?:Diagnose|Recovery(?:\\s+Console)?|Compare)";
const primaryWorkspaceRole = "(?:(?:top[-\\s]?level|primary|main|persistent)\\s+(?:navigation\\s+)?(?:views?|workspaces?))";

function findLegacyPrimaryWorkspaceClaims(source) {
  const legacyBeforeRole = new RegExp(`\\b${legacyWorkspace}\\b[^.]{0,240}\\b${primaryWorkspaceRole}\\b`, "i");
  const roleBeforeLegacy = new RegExp(`\\b${primaryWorkspaceRole}\\b[^.]{0,240}\\b${legacyWorkspace}\\b`, "i");
  return matchingClaimFragments(source, (fragment) => legacyBeforeRole.test(fragment) || roleBeforeLegacy.test(fragment));
}

const controlPlaneReference = "(?:FastAPI|Temporal)(?:\\s*\\/\\s*(?:FastAPI|Temporal))?\\s+(?:control[-\\s]?plane|integration|control[-\\s]?plane\\s+equivalents?)";
const deliveryVerb = "(?:integrated|available|live|shipped|delivered)";
const deliveryAdverb = "(?:(?:already|now|fully|currently)\\s+)*";
const deliveryPredicate = `(?:is|are|has|have|was|were)\\s+${deliveryAdverb}${deliveryVerb}`;
const activeDelivery = `(?:(?:we|the\\s+(?:team|platform|product)|FlowPulse)\\s+)?(?:(?:have|has|had)\\s+)?${deliveryAdverb}(?:ship(?:ped|s)?|deliver(?:ed|s)?|integrat(?:ed|es))`;
const negatedDelivery = new RegExp(`\\b(?:not|never)\\s+(?:(?:yet|already|now|fully|currently)\\s+)*${deliveryVerb}\\b`, "i");
const deferredControlPlane = new RegExp(`\\buntil\\b[^.]{0,120}\\b${controlPlaneReference}\\b[^.]{0,120}\\b${deliveryPredicate}\\b`, "i");

function findShippedControlPlaneClaims(source) {
  const controlPlaneBeforeDelivery = new RegExp(`\\b${controlPlaneReference}\\b[^.]{0,160}\\b${deliveryPredicate}\\b`, "i");
  const deliveryBeforeControlPlane = new RegExp(`\\b${activeDelivery}\\b[^.]{0,160}\\b${controlPlaneReference}\\b`, "i");
  return matchingClaimFragments(source, (fragment) => {
    if (negatedDelivery.test(fragment) || deferredControlPlane.test(fragment)) return false;
    return controlPlaneBeforeDelivery.test(fragment) || deliveryBeforeControlPlane.test(fragment);
  });
}

const nodeCompatibilityPath = "(?:Node(?:\\.js)?|src\\/server\\.mjs|server-side\\s+policy)";
const lifecycleAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies))";
const productionAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+)?production\\s+authorit(?:y|ies)(?:\\s+(?:closure|composition\\s+root))?";
const compatibilityDenial = /\b(?:does\s+not|do\s+not|is\s+not|are\s+not|cannot|can't|never|without|no)\b[^.]{0,120}\b(?:authority|authorities|owns?|governs?|controls?)\b/i;

function findNodeLifecycleAuthorityClaims(source) {
  const nodeBeforeAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,160}\\b${lifecycleAuthority}\\b`, "i");
  const authorityBeforeNode = new RegExp(`\\b${lifecycleAuthority}\\b[^.]{0,160}\\b${nodeCompatibilityPath}\\b`, "i");
  const activeNodeOwnership = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,80}\\b(?:alone|solely|exclusively|now|currently)\\s+(?:owns?|governs?|controls?)\\b[^.]{0,120}\\b(?:incident\\s+)?lifecycle(?:\\s+transitions?)?\\b`, "i");
  const authorityBelongsToNode = new RegExp("\\b(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies)\\b[^.]{0,80}\\b(?:solely|only|exclusively)\\b[^.]{0,80}\\b" + nodeCompatibilityPath + "\\b", "i");
  return matchingClaimFragments(source, (fragment) => !compatibilityDenial.test(fragment)
    && (nodeBeforeAuthority.test(fragment)
      || authorityBeforeNode.test(fragment)
      || activeNodeOwnership.test(fragment)
      || authorityBelongsToNode.test(fragment)));
}

function findNodeProductionAuthorityClaims(source) {
  const nodeBeforeAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,160}\\b${productionAuthority}\\b`, "i");
  const authorityBeforeNode = new RegExp(`\\b${productionAuthority}\\b[^.]{0,160}\\b${nodeCompatibilityPath}\\b`, "i");
  return matchingClaimFragments(source, (fragment) => !compatibilityDenial.test(fragment)
    && (nodeBeforeAuthority.test(fragment) || authorityBeforeNode.test(fragment)));
}

function assertNoDocumentClaims(findClaims, description) {
  for (const [name, source] of northStarDocuments) {
    const matches = findClaims(source);
    assert.deepEqual(matches, [], `${name} must not ${description}: ${matches.join(" | ")}`);
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

  assertNoDocumentClaims(findLegacyPrimaryWorkspaceClaims, "present a legacy incident workspace as primary navigation");
  assertNoDocumentClaims(findShippedControlPlaneClaims, "claim an unshipped control-plane integration");
  assertNoDocumentClaims(findNodeProductionAuthorityClaims, "claim production authority for the Node compatibility path");
  assertNoDocumentClaims(findNodeLifecycleAuthorityClaims, "claim lifecycle authority for the Node compatibility path");

  assert.match(agentTeam, /Provider truth labels remain independent/i);
  assert.match(agentTeam, /LOCAL CODEX/, "provider labels remain documented");
  assert.match(agentTeam, /OPENAI API/, "provider labels remain documented");
  assert.match(agentTeam, /RECORDED\/DEMO/, "provider labels remain documented");
});

test("North Star contradiction detectors reject natural language mutations without rejecting qualified compatibility facts", () => {
  assert.deepEqual(
    findLegacyPrimaryWorkspaceClaims("The primary workspaces are Diagnose, Recovery Console, and Compare."),
    ["The primary workspaces are Diagnose, Recovery Console, and Compare."]
  );
  assert.deepEqual(
    findLegacyPrimaryWorkspaceClaims("We still ship Diagnose as a primary workspace."),
    ["We still ship Diagnose as a primary workspace."]
  );
  assert.deepEqual(
    findLegacyPrimaryWorkspaceClaims("Compare\nremains our main view."),
    ["Compare remains our main view."]
  );
  assert.deepEqual(findLegacyPrimaryWorkspaceClaims("Incident is the unified workspace; Diagnose is a compatibility label."), []);

  assert.deepEqual(
    findShippedControlPlaneClaims("FastAPI/Temporal control plane integration is already shipped."),
    ["FastAPI/Temporal control plane integration is already shipped."]
  );
  assert.deepEqual(
    findShippedControlPlaneClaims("The platform team has fully delivered the FastAPI/Temporal control-plane integration."),
    ["The platform team has fully delivered the FastAPI/Temporal control-plane integration."]
  );
  assert.deepEqual(
    findShippedControlPlaneClaims("FastAPI/Temporal\ncontrol plane integration\nis now live."),
    ["FastAPI/Temporal control plane integration is now live."]
  );
  assert.deepEqual(findShippedControlPlaneClaims("The planned FastAPI/Temporal control-plane integration is not yet available."), []);
  assert.deepEqual(
    findShippedControlPlaneClaims("FastAPI/Temporal control plane integration is already shipped, not mocked."),
    ["FastAPI/Temporal control plane integration is already shipped, not mocked."]
  );

  assert.deepEqual(
    findNodeLifecycleAuthorityClaims("The sole lifecycle authority is Node."),
    ["The sole lifecycle authority is Node."]
  );
  assert.deepEqual(
    findNodeLifecycleAuthorityClaims("Node exclusively governs incident lifecycle transitions."),
    ["Node exclusively governs incident lifecycle transitions."]
  );
  assert.deepEqual(
    findNodeLifecycleAuthorityClaims("Node\nis now the only lifecycle authority."),
    ["Node is now the only lifecycle authority."]
  );
  assert.deepEqual(
    findNodeLifecycleAuthorityClaims("The only lifecycle authorities are Node and src/server.mjs."),
    ["The only lifecycle authorities are Node and src/server.mjs."]
  );
  assert.deepEqual(findNodeLifecycleAuthorityClaims("The Node compatibility surface does not grant lifecycle authority."), []);

  assert.deepEqual(
    findNodeProductionAuthorityClaims("Production authorities belong solely to Node."),
    ["Production authorities belong solely to Node."]
  );
  assert.deepEqual(findNodeProductionAuthorityClaims("The Node compatibility path is not a production authority."), []);
});

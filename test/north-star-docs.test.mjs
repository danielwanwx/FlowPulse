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

function normalizedClaimClauses(source) {
  return source
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;])\s+/)
    .flatMap((sentence) => {
      const leadingContrast = sentence.match(/^(?:although|whereas|while)\b[^,;]*,\s*/i);
      if (leadingContrast) {
        return [sentence.slice(0, leadingContrast[0].length - 2), sentence.slice(leadingContrast[0].length)];
      }
      return sentence.split(/,\s+(?=(?:and|but|however|yet|whereas)\b)|\s+(?=(?:and|but|however|yet|whereas)\b)/i);
    })
    .map((clause) => clause.replace(/^(?:and|but|however|yet|whereas|although|while)\s+/i, "").trim())
    .filter(Boolean);
}

function matchingClaimClauses(source, matchesClaim) {
  return normalizedClaimClauses(source).filter(matchesClaim);
}

const legacyWorkspace = "(?:Diagnose|Recovery(?:\\s+Console)?|Compare)";
const primaryWorkspaceRole = "(?:(?:top[-\\s]?level|primary|main|persistent|default|core|only)\\s+(?:navigation\\s+)?(?:views?|workspaces?))";
const workspaceDenial = "(?:not|never|isn't|aren't|wasn't|weren't)";

function hasNegatedWorkspaceClaim(clause) {
  const legacyBeforeNegation = new RegExp(`\\b${legacyWorkspace}\\b[^.;]{0,80}\\b${workspaceDenial}\\b[^.;]{0,40}\\b${primaryWorkspaceRole}\\b`, "i");
  const roleBeforeNegation = new RegExp(`\\b${primaryWorkspaceRole}\\b[^.;]{0,80}\\b${workspaceDenial}\\b[^.;]{0,40}\\b${legacyWorkspace}\\b`, "i");
  return legacyBeforeNegation.test(clause) || roleBeforeNegation.test(clause);
}

function findLegacyPrimaryWorkspaceClaims(source) {
  const legacyBeforeRole = new RegExp(`\\b${legacyWorkspace}\\b[^.]{0,240}\\b${primaryWorkspaceRole}\\b`, "i");
  const roleBeforeLegacy = new RegExp(`\\b${primaryWorkspaceRole}\\b[^.]{0,240}\\b${legacyWorkspace}\\b`, "i");
  return matchingClaimClauses(source, (clause) => !hasNegatedWorkspaceClaim(clause)
    && (legacyBeforeRole.test(clause) || roleBeforeLegacy.test(clause)));
}

const controlPlaneProvider = "(?:FastAPI|Temporal)(?:\\s*\\/\\s*(?:FastAPI|Temporal))?";
const controlPlaneReference = `(?:${controlPlaneProvider}\\s+(?:control[-\\s]?plane(?:\\s+(?:integration|equivalents?))?|integration)|(?:the\\s+)?control[-\\s]?plane\\s+integration\\s+(?:with|for)\\s+${controlPlaneProvider})`;
const deliveryVerb = "(?:integrated|available|live|shipped|delivered)";
const deliveryModifier = "(?:(?:already|now|fully|currently)\\s+)?";
const deliveryPredicate = `(?:is|are|was|were|has|have|had)\\s+${deliveryModifier}(?:been\\s+)?${deliveryModifier}${deliveryVerb}`;
const activeDelivery = `(?:(?:we|the\\s+(?:team|platform|product)|FlowPulse)\\s+)?(?:(?:have|has|had)\\s+)?${deliveryModifier}(?:ship(?:ped|s)?|deliver(?:ed|s)?|integrat(?:ed|es))`;
const negatedDelivery = new RegExp(`\\b(?:not|never)\\s+(?:(?:yet|already|now|fully|currently)\\s+)?(?:been\\s+)?${deliveryVerb}\\b`, "i");
const deferredControlPlane = new RegExp(`\\buntil\\b[^.]{0,120}\\b${controlPlaneReference}\\b[^.]{0,120}\\b${deliveryPredicate}\\b`, "i");
const conditionalControlPlane = new RegExp(`\\b(?:if|when)\\b[^.]{0,120}\\b${controlPlaneReference}\\b[^.]{0,120}\\b${deliveryPredicate}\\b`, "i");
const trailingConditionalControlPlane = new RegExp(`\\b${controlPlaneReference}\\b[^.]{0,160}\\b${deliveryPredicate}\\b[^.]{0,120}\\b(?:if|when)\\b`, "i");

function findShippedControlPlaneClaims(source) {
  const controlPlaneBeforeDelivery = new RegExp(`\\b${controlPlaneReference}\\b[^.]{0,160}\\b${deliveryPredicate}\\b`, "i");
  const deliveryBeforeControlPlane = new RegExp(`\\b${activeDelivery}\\b[^.]{0,160}\\b${controlPlaneReference}\\b`, "i");
  return matchingClaimClauses(source, (clause) => {
    if (negatedDelivery.test(clause) || deferredControlPlane.test(clause) || conditionalControlPlane.test(clause) || trailingConditionalControlPlane.test(clause)) return false;
    return controlPlaneBeforeDelivery.test(clause) || deliveryBeforeControlPlane.test(clause);
  });
}

const nodeCompatibilityPath = "(?:Node(?:\\.js)?|src\\/server\\.mjs|server-side\\s+policy)";
const lifecycleAuthorityNoun = "(?:(?:the\\s+)?(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies))";
const lifecycleAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies))";
const productionAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+)?production\\s+authorit(?:y|ies)(?:\\s+(?:closure|composition\\s+root))?";

function hasNegatedNodeAuthorityClaim(clause, authority) {
  const nodeBeforeNegation = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.;]{0,100}\\b(?:is|are|does|do|can|cannot|serves?\\s+as|owns?)?\\s*(?:not|never|no)\\b[^.;]{0,80}\\b${authority}\\b`, "i");
  const negationBeforeNode = new RegExp(`\\b(?:not|never|no)\\b[^.;]{0,80}\\b${authority}\\b[^.;]{0,100}\\b${nodeCompatibilityPath}\\b`, "i");
  const authorityBeforeNegatedNode = new RegExp(`\\b${authority}\\b[^.;]{0,80}\\b(?:is|are|belongs?\\s+to|serves?\\s+as)\\s+(?:not|never|no)\\b[^.;]{0,40}\\b${nodeCompatibilityPath}\\b`, "i");
  return nodeBeforeNegation.test(clause) || negationBeforeNode.test(clause) || authorityBeforeNegatedNode.test(clause);
}

function hasNegatedNodeLifecycleOwnership(clause) {
  const nodeBeforeNegatedOwnership = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.;]{0,80}\\b(?:does\\s+not|do\\s+not|cannot|can't|never)\\s+(?:own|govern|control)s?\\b[^.;]{0,120}\\b(?:the\\s+)?(?:incident\\s+)?lifecycle(?:\\s+transitions?)?\\b`, "i");
  return nodeBeforeNegatedOwnership.test(clause);
}

function findNodeLifecycleAuthorityClaims(source) {
  const nodeBeforeAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,160}\\b${lifecycleAuthority}\\b`, "i");
  const authorityBeforeNode = new RegExp(`\\b${lifecycleAuthorityNoun}\\b[^.]{0,160}\\b${nodeCompatibilityPath}\\b`, "i");
  const nodeCopularAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,80}\\b(?:is|are|serves?\\s+as)\\b[^.]{0,80}\\b${lifecycleAuthorityNoun}\\b`, "i");
  const nodeOwnsLifecycle = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,80}\\b(?:owns?|governs?|controls?)\\b[^.]{0,120}\\b(?:the\\s+)?(?:incident\\s+)?lifecycle(?:\\s+transitions?)?\\b`, "i");
  const authorityBelongsToNode = new RegExp("\\b(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies)\\b[^.]{0,80}\\b(?:solely|only|exclusively)\\b[^.]{0,80}\\b" + nodeCompatibilityPath + "\\b", "i");
  return matchingClaimClauses(source, (clause) => !hasNegatedNodeAuthorityClaim(clause, lifecycleAuthorityNoun)
    && !hasNegatedNodeLifecycleOwnership(clause)
    && (nodeBeforeAuthority.test(clause)
      || authorityBeforeNode.test(clause)
      || nodeCopularAuthority.test(clause)
      || nodeOwnsLifecycle.test(clause)
      || authorityBelongsToNode.test(clause)));
}

function findNodeProductionAuthorityClaims(source) {
  const nodeBeforeAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,160}\\b${productionAuthority}\\b`, "i");
  const authorityBeforeNode = new RegExp(`\\b${productionAuthority}\\b[^.]{0,160}\\b${nodeCompatibilityPath}\\b`, "i");
  return matchingClaimClauses(source, (clause) => !hasNegatedNodeAuthorityClaim(clause, productionAuthority)
    && (nodeBeforeAuthority.test(clause) || authorityBeforeNode.test(clause)));
}

function assertNoDocumentClaims(findClaims, description) {
  for (const [name, source] of northStarDocuments) {
    const matches = findClaims(source);
    assert.deepEqual(matches, [], `${name} must not ${description}: ${matches.join(" | ")}`);
  }
}

function assertClaimDetected(findClaims, source) {
  const matches = findClaims(source);
  assert.equal(matches.length, 1, `expected a contradiction in: ${source}; found: ${matches.join(" | ")}`);
}

function assertClaimAllowed(findClaims, source) {
  assert.deepEqual(findClaims(source), [], `expected no contradiction in: ${source}`);
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

test("North Star contradiction detectors evaluate wording and negation at clause scope", () => {
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "The primary workspaces are Diagnose, Recovery Console, and Compare.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "We still ship Diagnose as a primary workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare\nremains our main view.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare is the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare, despite being a legacy label, is the default workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare is not a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare isn't a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Incident is the unified workspace; Diagnose is a compatibility label.");

  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The platform team has fully delivered the FastAPI/Temporal control-plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal\ncontrol plane integration\nis now live.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI is not yet available, but the Temporal control plane integration is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration has been shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The control-plane integration with Temporal is shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration is already shipped, not mocked.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The planned FastAPI/Temporal control-plane integration is not yet available.");
  assertClaimAllowed(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration has not been shipped.");
  assertClaimAllowed(findShippedControlPlaneClaims, "When FastAPI/Temporal control plane integration is delivered, retire this compatibility path.");
  assertClaimAllowed(findShippedControlPlaneClaims, "If migration succeeds, the FastAPI/Temporal control plane integration is delivered.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration is delivered if migration succeeds.");

  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The sole lifecycle authority is Node.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node exclusively governs incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node owns the incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node does not own browser state, and Node owns incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Although the browser is not the sole lifecycle authority, Node is the sole lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The browser does not own lifecycle authority whereas Node is the sole lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node, despite being a compatibility layer, is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node\nis now the only lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The only lifecycle authorities are Node and src/server.mjs.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The browser does not own lifecycle authority, but Node is the sole lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The Node compatibility surface does not grant lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The Node compatibility surface does not own incident lifecycle transitions.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The lifecycle authority is not Node.");

  assertClaimDetected(findNodeProductionAuthorityClaims, "Production authorities belong solely to Node.");
  assertClaimAllowed(findNodeProductionAuthorityClaims, "The Node compatibility path is not a production authority.");
});

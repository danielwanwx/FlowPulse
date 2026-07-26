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

const expectedNorthStarGuardrails = {
  schema_version: "flowpulse.north-star-guardrails.v2",
  product_model_agnostic: true,
  product_company_multiplayer: true,
  incident_response_first_vertical: true,
  top_level_navigation: ["Architecture", "Live", "Incident"],
  stage_order: ["Investigate", "Decide", "Execute", "Verify"],
  lifecycle_authority: "Temporal",
  current_proof_authority: "Evidence Ledger",
  knowledge_plane_role: "bounded_prior",
  human_gates: ["Gate 1", "Gate 2"],
  tenant_isolation: true,
  provider_truth_labels: ["LOCAL CODEX", "OPENAI API", "RECORDED/DEMO"],
  frontend_generated_prohibited: ["incidents", "agent_messages", "recommendations", "gates", "evidence", "actions", "verification", "success"],
  dry_run_before_writes: true,
  fastapi_temporal_control_plane: "not_integrated",
  node_compatibility_path: "compatibility_demo"
};

function topLevelJsonKeys(json) {
  const keys = [];
  let depth = 0;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      continue;
    }
    if (character !== "\"") continue;

    let end = index + 1;
    while (end < json.length) {
      if (json[end] === "\\") {
        end += 2;
        continue;
      }
      if (json[end] === "\"") break;
      end += 1;
    }
    if (end >= json.length) throw new Error("North Star guardrail metadata has an unterminated JSON string");

    let next = end + 1;
    while (/\s/.test(json[next] ?? "")) next += 1;
    if (depth === 1 && json[next] === ":") keys.push(JSON.parse(json.slice(index, end + 1)));
    index = end;
  }
  return keys;
}

function readNorthStarGuardrails(source) {
  const guardrailCommentStarts = Array.from(source.matchAll(/<!--[\t\n\f\r ]*north-star-guardrails[\w-]*/gi));
  if (guardrailCommentStarts.length !== 1) {
    throw new Error(`README must contain exactly one North Star guardrail metadata block; found ${guardrailCommentStarts.length}`);
  }

  const blocks = Array.from(source.matchAll(/<!-- north-star-guardrails-v2\n([\s\S]*?)\n-->/g));
  if (blocks.length !== 1) throw new Error("README must use the current North Star guardrail metadata block");

  const rawMetadata = blocks[0][1];
  const keys = topLevelJsonKeys(rawMetadata);
  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicateKeys.length > 0) throw new Error(`North Star guardrail metadata has duplicate JSON keys: ${duplicateKeys.join(", ")}`);

  let metadata;
  try {
    metadata = JSON.parse(rawMetadata);
  } catch {
    throw new Error("North Star guardrail metadata must contain valid JSON");
  }
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata), "North Star guardrail metadata must be a JSON object");
  assert.deepEqual(Object.keys(metadata).sort(), Object.keys(expectedNorthStarGuardrails).sort(), "North Star guardrail metadata keys must be exact");
  assert.deepEqual(metadata, expectedNorthStarGuardrails, "North Star guardrail metadata values must match the approved contract");
  return metadata;
}

function metadataSource(json, marker = "north-star-guardrails-v2") {
  return `<!-- ${marker}\n${json}\n-->`;
}

const northStarGuardrails = readNorthStarGuardrails(readme);

function normalizedClaimClauses(source) {
  return source
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .flatMap(splitClaimSentence)
    .filter(Boolean);
}

function splitClaimSentence(sentence) {
  const leadingContrast = sentence.match(/^(?:although|whereas|while)\b[^,;]*,\s*/i);
  const parts = leadingContrast
    ? [sentence.slice(0, leadingContrast[0].length - 2), sentence.slice(leadingContrast[0].length)]
    : sentence.split(/;\s*|,\s+(?=(?:but|however|yet|whereas)\b)|\s+(?=(?:but|however|yet|whereas)\b)|,\s+(?=and\s+(?:(?:Node(?:\.js)?|Compare|it)\s+)?(?:is|are|remains?|becomes?|acts?\s+as|owns?|governs?|controls?|serves?\s+as)\b)|\s+(?=and\s+(?:(?:Node(?:\.js)?|Compare|it)\s+)?(?:is|are|remains?|becomes?|acts?\s+as|owns?|governs?|controls?|serves?\s+as)\b)/i);
  let subject = null;

  return parts.map((part) => {
    let clause = part.replace(/^(?:and|but|however|yet|whereas|although|while)\s+/i, "").trim();
    const explicitSubject = sharedClaimSubject(clause);
    if (explicitSubject) subject = explicitSubject;
    if (subject && /^(?:it\b|(?:is|are|remains?|becomes?|acts?\s+as|owns?|governs?|controls?|serves?\s+as)\b)/i.test(clause)) {
      clause = `${subject} ${clause.replace(/^it\b\s*/i, "")}`;
    }
    return clause;
  });
}

function sharedClaimSubject(clause) {
  const node = clause.match(/^(?:the\s+)?Node(?:\.js)?\b/i);
  if (node) return node[0];
  const compare = clause.match(/^(?:the\s+)?Compare\b/i);
  if (compare) return compare[0];
  const legacy = clause.match(new RegExp(`^(?:the\\s+)?${legacyWorkspace}\\b`, "i"));
  if (legacy) return legacy[0];
  const temporal = clause.match(/^Temporal\b/i);
  if (temporal) return temporal[0];
  const controlPlane = clause.match(new RegExp(`^(?:the\\s+)?${controlPlaneReference}\\b`, "i"));
  return controlPlane?.[0] ?? null;
}

function normalizeClaimText(source) {
  return source.replace(/[’‘]/g, "'");
}

function matchingClaimClauses(source, matchesClaim) {
  return normalizedClaimClauses(normalizeClaimText(source)).filter(matchesClaim);
}

const legacyWorkspace = "(?:Diagnose|Recovery(?:\\s+Console)?|Compare)";
const primaryWorkspaceRole = "(?:(?:top[-\\s]?level|primary|main|persistent|default|core|only)\\s+(?:(?:navigation\\s+)?(?:views?|workspaces?)|navigation))";
const rhetoricalOnlyQualifier = "(?:(?:the\\s+)?(?:only|just|merely|simply|solely|exclusively))";
const predicateAdverb = "(?:(?:absolutely|already|certainly|currently|definitely|fully|just|now|really|simply|still)\\s+)?";
const workspaceDenial = `(?:not(?!\\s+${rhetoricalOnlyQualifier}\\b)|never|isn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|aren't(?!\\s+${rhetoricalOnlyQualifier}\\b)|wasn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|weren't(?!\\s+${rhetoricalOnlyQualifier}\\b))`;

function hasNegatedWorkspaceClaim(clause) {
  const legacyBeforeNegation = new RegExp(`\\b${legacyWorkspace}\\b\\s+(?:(?:is|are|remains?|serves?\\s+as)\\s+)?${predicateAdverb}${workspaceDenial}\\b[^.;]{0,40}\\b${primaryWorkspaceRole}\\b`, "i");
  const roleBeforeNegation = new RegExp(`\\b${primaryWorkspaceRole}\\b\\s+(?:(?:is|are|remains?)\\s+)?${predicateAdverb}${workspaceDenial}\\b[^.;]{0,40}\\b${legacyWorkspace}\\b`, "i");
  return legacyBeforeNegation.test(clause) || roleBeforeNegation.test(clause);
}

function findLegacyPrimaryWorkspaceClaims(source) {
  const legacyBeforeRole = new RegExp(`\\b${legacyWorkspace}\\b[^.]{0,240}\\b${primaryWorkspaceRole}\\b`, "i");
  const roleBeforeLegacy = new RegExp(`\\b${primaryWorkspaceRole}\\b[^.]{0,240}\\b${legacyWorkspace}\\b`, "i");
  return matchingClaimClauses(source, (clause) => !hasNegatedWorkspaceClaim(clause)
    && (legacyBeforeRole.test(clause) || roleBeforeLegacy.test(clause)));
}

const controlPlaneProvider = "(?:FastAPI|Temporal)(?:\\s*\\/\\s*(?:FastAPI|Temporal))?";
const controlPlaneReference = `(?:${controlPlaneProvider}\\s+(?:control[-\\s]?plane(?:\\s+(?:integration|equivalents?))?|integration)|(?:the\\s+)?control[-\\s]?plane\\s+integration\\s+(?:with|for)\\s+${controlPlaneProvider}|(?:the\\s+)?control[-\\s]?plane\\s+integration\\s*,?\\s*powered\\s+by\\s+${controlPlaneProvider})`;
const deliveryVerb = "(?:integrated|available|live|shipped|delivered)";
const deliveryModifier = "(?:(?:already|now|fully|currently)\\s+)?";
const deliveryPredicate = `(?:is|are|was|were|has|have|had)\\s+${deliveryModifier}(?:been\\s+)?${deliveryModifier}${deliveryVerb}`;
const controlPlaneSubject = new RegExp(`\\b${controlPlaneReference}\\b`, "i");
const deferredControlPlane = new RegExp(`\\buntil\\b[^.]{0,120}\\b${controlPlaneReference}\\b[^.]{0,120}\\b${deliveryPredicate}\\b`, "i");
const conditionalControlPlane = new RegExp(`\\b(?:if|when|once|after|provided\\s+that)\\b[^.]{0,120}\\b${controlPlaneReference}\\b[^.]{0,120}\\b${deliveryPredicate}\\b`, "i");
const trailingConditionalControlPlane = new RegExp(`\\b${controlPlaneReference}\\b[^.]{0,160}\\b${deliveryPredicate}\\b[^.]{0,120}\\b(?:if|when|once|after|provided\\s+that)\\b`, "i");

function controlPlaneDeliveryVerdict(clause) {
  const normalized = normalizeClaimText(clause)
    .replace(/,\s*(?:(?:after|before|during|following|upon|despite|without|with)\b[^,]*|[A-Za-z]+ly)\s*,/g, " ");
  const integration = controlPlaneSubject.exec(normalized);
  if (!integration) return "absent";

  const tokens = Array.from(normalized.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?|[.,;:/-]/g), (match) => ({
    value: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length
  }));
  const spanStart = tokens.findIndex((token) => token.end > integration.index);
  const spanEnd = tokens.findLastIndex((token) => token.start < integration.index + integration[0].length) + 1;
  if (spanStart < 0 || spanEnd <= spanStart) return "absent";

  const actions = new Set(["ship", "shipped", "deliver", "delivered", "integrate", "integrated"]);
  const completedStates = new Set(["shipped", "delivered", "integrated", "live", "available"]);
  const modals = new Set(["will", "shall", "should", "may", "might", "can", "could", "would", "must"]);
  const negations = new Set(["not", "never", "haven't", "hasn't", "hadn't", "didn't", "don't", "doesn't", "won't", "can't"]);
  const rhetoricalTerms = new Set(["only", "just", "merely", "simply", "solely", "exclusively"]);
  const predicateSeparators = new Set([".", ";", ",", "and", "but", "because", "however", "so", "then", "whereas", "while", "yet"]);
  const prepositionalObjectMarkers = new Set(["about", "for", "of", "on", "regarding", "to"]);
  const objectTailModifiers = new Set(["after", "already", "at", "before", "but", "by", "during", "for", "from", "in", "itself", "on", "that", "then", "today", "tomorrow", "which", "with", "yesterday"]);
  const passiveWords = new Set(["am", "are", "be", "been", "being", "did", "has", "have", "had", "is", "was", "were", "will", "shall", "should", "may", "might", "can", "could", "would", "must", "not", "never", "no", "means", "by", "already", "certainly", "confidently", "definitely", "fully", "just", "now", "really", "successfully", "yet", ...rhetoricalTerms]);
  const isQualified = (predicate) => predicate.some((token, index) => (negations.has(token) && !rhetoricalTerms.has(predicate[index + 1]))
    || (token === "no" && predicate[index + 1] === "means")
    || modals.has(token)
    || (["plan", "plans", "planned", "intend", "intends", "intended", "expect", "expects", "expected"].includes(token) && predicate[index + 1] === "to"));
  const predicateStart = (actionIndex) => {
    for (let index = actionIndex - 1; index >= 0; index -= 1) {
      if (predicateSeparators.has(tokens[index].value)) return index + 1;
    }
    return 0;
  };
  const bindsIntegrationObject = (actionIndex) => {
    const before = tokens.slice(actionIndex + 1, spanStart).map((token) => token.value);
    if (before.some((token) => prepositionalObjectMarkers.has(token) || token === "-" || token === "/")) return false;
    const next = tokens[spanEnd]?.value;
    return !next
      || predicateSeparators.has(next)
      || objectTailModifiers.has(next)
      || next.endsWith("ly");
  };

  for (let actionIndex = spanStart - 1; actionIndex >= 0; actionIndex -= 1) {
    if (predicateSeparators.has(tokens[actionIndex].value)) break;
    if (!actions.has(tokens[actionIndex].value)) continue;
    if (!bindsIntegrationObject(actionIndex)) continue;
    const predicate = tokens.slice(predicateStart(actionIndex), actionIndex).map((token) => token.value);
    if (isQualified(predicate)) return "qualified";
    if (completedStates.has(tokens[actionIndex].value)) return "completed";
    return predicate.includes("did") ? "completed" : "qualified";
  }

  for (let actionIndex = spanEnd; actionIndex < tokens.length; actionIndex += 1) {
    if (predicateSeparators.has(tokens[actionIndex].value) && tokens[actionIndex].value !== ",") break;
    if (!actions.has(tokens[actionIndex].value) && !completedStates.has(tokens[actionIndex].value)) continue;
    const predicate = tokens.slice(spanEnd, actionIndex)
      .map((token) => token.value)
      .filter((token) => token !== ",");
    if (!predicate.every((token) => passiveWords.has(token) || token.endsWith("ly"))) return "absent";
    if (isQualified(predicate)) return "qualified";
    return completedStates.has(tokens[actionIndex].value) || predicate.includes("did") ? "completed" : "qualified";
  }
  return "absent";
}

function findShippedControlPlaneClaims(source) {
  return matchingClaimClauses(source, (clause) => {
    if (deferredControlPlane.test(clause) || conditionalControlPlane.test(clause) || trailingConditionalControlPlane.test(clause)) return false;
    return controlPlaneDeliveryVerdict(clause) === "completed";
  });
}

const nodeCompatibilityPath = "(?:Node(?:\\.js)?|src\\/server\\.mjs|server-side\\s+policy)";
const lifecycleAuthorityNoun = "(?:(?:the\\s+)?(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies))";
const lifecycleAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+(?:incident\\s+)?lifecycle\\s+authorit(?:y|ies))";
const productionAuthority = "(?:(?:the\\s+)?(?:sole|only|primary|exclusive)\\s+)?production\\s+authorit(?:y|ies)(?:\\s+(?:closure|composition\\s+root))?";
const authorityDenial = `(?:not(?!\\s+${rhetoricalOnlyQualifier}\\b)|never|no|isn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|aren't(?!\\s+${rhetoricalOnlyQualifier}\\b)|wasn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|weren't(?!\\s+${rhetoricalOnlyQualifier}\\b)|doesn't|don't|cannot|can't)`;
const contractedAuthorityDenial = `(?:isn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|aren't(?!\\s+${rhetoricalOnlyQualifier}\\b)|wasn't(?!\\s+${rhetoricalOnlyQualifier}\\b)|weren't(?!\\s+${rhetoricalOnlyQualifier}\\b))`;

function hasNegatedNodeAuthorityClaim(clause, authority) {
  const directNodeNegation = new RegExp(`\\b${nodeCompatibilityPath}\\b(?:\\s+(?:compatibility|demo|server|path|surface)){0,4}\\s+(?:(?:is|are|was|were|remains?|serves?\\s+as|does|do|can)\\s+)?${authorityDenial}\\b[^.;]{0,40}\\b${authority}\\b`, "i");
  const directNodeAdverbialDenial = new RegExp(`\\b${nodeCompatibilityPath}\\b(?:\\s+(?:compatibility|demo|server|path|surface)){0,4}\\s+(?:(?:is|are|was|were|remains?|serves?\\s+as|does|do|can)\\s+)?${predicateAdverb}${authorityDenial}\\b[^.;]{0,40}\\b${authority}\\b`, "i");
  const authorityBeforeNegatedNode = new RegExp(`\\b${authority}\\b[^.;]{0,80}\\b(?:(?:is|are|belongs?\\s+to|serves?\\s+as)\\s+${authorityDenial}|${contractedAuthorityDenial})\\b[^.;]{0,40}\\b${nodeCompatibilityPath}\\b`, "i");
  const authorityBeforeAdverbialNegatedNode = new RegExp(`\\b${authority}\\b[^.;]{0,80}\\b(?:is|are|belongs?\\s+to|serves?\\s+as)\\s+${predicateAdverb}${authorityDenial}\\b[^.;]{0,40}\\b${nodeCompatibilityPath}\\b`, "i");
  const authorityDoesNotBelongToNode = new RegExp(`\\b${authority}\\b[^.;]{0,80}\\b(?:does\\s+not|doesn't)\\s+belong\\s+to\\s+${nodeCompatibilityPath}\\b`, "i");
  return directNodeAdverbialDenial.test(clause) || directNodeNegation.test(clause) || authorityBeforeAdverbialNegatedNode.test(clause) || authorityBeforeNegatedNode.test(clause) || authorityDoesNotBelongToNode.test(clause);
}

function hasNegatedNodeLifecycleOwnership(clause) {
  const nodeBeforeNegatedOwnership = new RegExp(`\\b${nodeCompatibilityPath}\\b(?:\\s+(?:compatibility|demo|server|path|surface)){0,4}\\s+(?:does\\s+not|do\\s+not|doesn't|don't|cannot|can't|never)\\s+(?:own|govern|control)s?\\s+(?:the\\s+)?(?:incident\\s+)?lifecycle(?:\\s+transitions?)?\\b`, "i");
  return nodeBeforeNegatedOwnership.test(clause);
}

function findNodeLifecycleAuthorityClaims(source) {
  const nodeBeforeAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,160}\\b${lifecycleAuthority}\\b`, "i");
  const authorityBeforeNode = new RegExp(`\\b${lifecycleAuthorityNoun}\\b[^.]{0,160}\\b${nodeCompatibilityPath}\\b`, "i");
  const nodeCopularAuthority = new RegExp(`\\b${nodeCompatibilityPath}\\b[^.]{0,80}\\b(?:is|are|isn't|aren't|wasn't|weren't|remains?|becomes?|acts?\\s+as|serves?\\s+as)\\b[^.]{0,80}\\b${lifecycleAuthorityNoun}\\b`, "i");
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
  assert.deepEqual(northStarGuardrails, expectedNorthStarGuardrails);

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

test("North Star metadata is complete, unique, duplicate-safe, and exact", () => {
  const canonicalJson = JSON.stringify(expectedNorthStarGuardrails, null, 2);
  const guardrailDriftFixtures = [
    ["model-agnostic positioning", "product_model_agnostic", false],
    ["company-multiplayer positioning", "product_company_multiplayer", false],
    ["Incident as the first vertical", "incident_response_first_vertical", false],
    ["top-level views", "top_level_navigation", ["Architecture", "Live", "Compare"]],
    ["incident stage order", "stage_order", ["Investigate", "Execute", "Decide", "Verify"]],
    ["Temporal lifecycle authority", "lifecycle_authority", "Node"],
    ["Evidence Ledger current-proof authority", "current_proof_authority", "browser"],
    ["Knowledge as a bounded prior", "knowledge_plane_role", "current_proof"],
    ["Gate 1 and Gate 2", "human_gates", ["Gate 1"]],
    ["tenant isolation", "tenant_isolation", false],
    ["provider truth labels", "provider_truth_labels", ["LOCAL CODEX"]],
    ["frontend-generated success prohibition", "frontend_generated_prohibited", ["incidents", "agent_messages"]],
    ["dry run before writes", "dry_run_before_writes", false],
    ["unintegrated control-plane status", "fastapi_temporal_control_plane", "integrated"],
    ["Node compatibility/demo status", "node_compatibility_path", "production_authority"]
  ];

  assert.deepEqual(readNorthStarGuardrails(metadataSource(canonicalJson)), expectedNorthStarGuardrails);
  assert.throws(() => readNorthStarGuardrails("# FlowPulse"), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(metadataSource("{not valid JSON}")), /valid JSON/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n${metadataSource(canonicalJson)}`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(metadataSource(canonicalJson, "north-star-guardrails-v1")), /current North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n${metadataSource(canonicalJson, "north-star-guardrails-v1")}`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n${metadataSource(canonicalJson, "north-star-guardrails-v2 ")}`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n${metadataSource(canonicalJson, "north-star-guardrails-v2\t")}`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n<!--\f north-star-guardrails-v2\n${canonicalJson}\n-->`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}\n${metadataSource(canonicalJson, "NORTH-star-GUARDRAILS-v2")}`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(`${metadataSource(canonicalJson)}<!-- north-star-guardrails-v2 -->`), /exactly one North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails("<!-- north-star-guardrails-v2\n{\"schema_version\":\"flowpulse.north-star-guardrails.v2\"}"), /current North Star guardrail metadata block/);
  assert.throws(() => readNorthStarGuardrails(metadataSource('{"schema_version":"flowpulse.north-star-guardrails.v2","schema_version":"drifted"}')), /duplicate JSON keys/);

  const { tenant_isolation: omittedGuardrail, ...withoutTenantIsolation } = expectedNorthStarGuardrails;
  assert.throws(() => readNorthStarGuardrails(metadataSource(JSON.stringify(withoutTenantIsolation))), /keys must be exact/);
  assert.throws(() => readNorthStarGuardrails(metadataSource(JSON.stringify({ ...expectedNorthStarGuardrails, unapproved: true }))), /keys must be exact/);

  for (const [description, key, value] of guardrailDriftFixtures) {
    assert.throws(
      () => readNorthStarGuardrails(metadataSource(JSON.stringify({ ...expectedNorthStarGuardrails, [key]: value }))),
      /values must match the approved contract/,
      `${description} must not drift`
    );
  }
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
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare is a legacy label, but it remains the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare is a legacy label; it remains the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare, not Incident, is the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare is not only a primary workspace but also the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare isn't only a primary workspace but also the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare isn't the only primary workspace but also the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare is not merely a primary workspace but also the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Compare isn't exclusively a primary workspace but also the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Diagnose is a legacy label, but it remains the default workspace.");
  assertClaimDetected(findLegacyPrimaryWorkspaceClaims, "Top-level navigation includes Architecture, Live, and Compare.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare is not a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare isn't a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare isn’t a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare is definitely not a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Compare is certainly not a primary workspace.");
  assertClaimAllowed(findLegacyPrimaryWorkspaceClaims, "Incident is the unified workspace; Diagnose is a compatibility label.");

  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The platform team has fully delivered the FastAPI/Temporal control-plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal\ncontrol plane integration\nis now live.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI is not yet available, but the Temporal control plane integration is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration has been shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The control-plane integration with Temporal is shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The control-plane integration, powered by Temporal, is shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration is already shipped, not mocked.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The planned FastAPI/Temporal control-plane integration is not yet available.");
  assertClaimAllowed(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration has not been shipped.");
  assertClaimAllowed(findShippedControlPlaneClaims, "When FastAPI/Temporal control plane integration is delivered, retire this compatibility path.");
  assertClaimAllowed(findShippedControlPlaneClaims, "If migration succeeds, the FastAPI/Temporal control plane integration is delivered.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration is delivered if migration succeeds.");
  assertClaimAllowed(findShippedControlPlaneClaims, "Once FastAPI/Temporal control plane integration is delivered, retire the compatibility path.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration is future work, but it is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control-plane integration is future work; it is already shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "FastAPI/Temporal control plane integration is already shipped and will deliver more features.");
  assertClaimDetected(findShippedControlPlaneClaims, "We did ship the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We've shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We have definitely shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We just shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "Our team shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "The product team delivered the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "Our team confidently shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We shipped our FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We shipped this FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration did ship yesterday.");
  assertClaimDetected(findShippedControlPlaneClaims, "We shipped, after review, the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration, after review, was shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "We did not delay the rollout and shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We could document the rollout because we shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "We plan to improve the UI and have shipped the FastAPI/Temporal control plane integration.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration has definitely been shipped.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration shipped yesterday.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration was confidently delivered.");
  assertClaimDetected(findShippedControlPlaneClaims, "We have not merely shipped the FastAPI/Temporal control plane integration but verified it.");
  assertClaimDetected(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration was not only shipped but verified.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We have not shipped the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We never shipped the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We haven't shipped the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We haven’t shipped the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We have by no means shipped the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We shipped documentation for the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We delivered a design for the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We shipped the FastAPI/Temporal control plane integration-related documentation.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We shipped the FastAPI/Temporal control plane integration mock.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We shipped the FastAPI/Temporal control plane integration demo.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We delivered the FastAPI/Temporal control plane integration test fixture.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The FastAPI/Temporal control plane integration will have been delivered by Q4.");
  assertClaimAllowed(findShippedControlPlaneClaims, "The team will ship documentation for the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We will ship the FastAPI/Temporal control plane integration after approval.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We will fully deliver the FastAPI/Temporal control plane integration after approval.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We shall have delivered the FastAPI/Temporal control plane integration after approval.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We plan to deliver the FastAPI/Temporal control plane integration after approval.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We should have delivered the FastAPI/Temporal control plane integration after approval.");
  assertClaimAllowed(findShippedControlPlaneClaims, "Our team did not ship the FastAPI/Temporal control plane integration.");
  assertClaimAllowed(findShippedControlPlaneClaims, "We might have delivered the FastAPI/Temporal control plane integration after approval.");

  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The sole lifecycle authority is Node.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node exclusively governs incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node owns the incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node does not own browser state, and Node owns incident lifecycle transitions.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Although the browser is not the sole lifecycle authority, Node is the sole lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The browser does not own lifecycle authority whereas Node is the sole lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is not only the lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node isn't only the lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node isn't the only lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node isn't simply the lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node isn't exclusively the lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is not solely the lifecycle authority but also the executor.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node, not Temporal, is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node, despite being a compatibility layer, is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is a compatibility layer, but it is the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node is a compatibility layer; it remains the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node remains the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node acts as the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node becomes the lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "Node\nis now the only lifecycle authority.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The only lifecycle authorities are Node and src/server.mjs.");
  assertClaimDetected(findNodeLifecycleAuthorityClaims, "The browser does not own lifecycle authority, but Node is the sole lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The Node compatibility surface does not grant lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The Node compatibility surface does not own incident lifecycle transitions.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The lifecycle authority is not Node.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The lifecycle authority is definitely not Node.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The lifecycle authority isn't Node.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "The lifecycle authority does not belong to Node.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "Node doesn't own lifecycle transitions.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "Temporal replaces Node, but it remains the lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "Node isn't the sole lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "Node is definitely not the lifecycle authority.");
  assertClaimAllowed(findNodeLifecycleAuthorityClaims, "Node is absolutely not the lifecycle authority.");

  assertClaimDetected(findNodeProductionAuthorityClaims, "Production authorities belong solely to Node.");
  assertClaimAllowed(findNodeProductionAuthorityClaims, "The Node compatibility path is not a production authority.");
});

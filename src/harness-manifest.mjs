import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const TOOL_NAMES = ["query_metrics", "query_traces", "query_logs", "query_changes", "query_code", "query_deploys", "query_commits"];
const MAX_ARTIFACT_BYTES = 64 * 1024;

export class HarnessManifestError extends Error {
  constructor(code) {
    super("Harness manifest validation failed");
    this.name = "HarnessManifestError";
    this.code = code;
    this.classification = "tool_data_failure";
  }
}

export function loadHarnessManifest({ rootDir = SOURCE_ROOT, model = process.env.OPENAI_MODEL || "gpt-5.6" } = {}) {
  const harnessDir = resolve(rootDir, "harness");
  const manifest = readJson(resolve(harnessDir, "flowpulse-harness.v1.json"), "harness_manifest_unreadable");
  assertExactKeys(manifest, ["version", "model", "budgets", "skills", "protocols", "canonical_sha256"], "harness_manifest_shape_invalid");
  if (manifest.version !== "flowpulse.harness.v1") throw new HarnessManifestError("harness_manifest_version_unknown");
  if (!HASH.test(manifest.canonical_sha256) || manifest.canonical_sha256 !== sha256(canonical({ ...manifest, canonical_sha256: undefined }))) {
    throw new HarnessManifestError("harness_manifest_hash_mismatch");
  }
  const modelConfig = validateModel(manifest.model, model);
  const budgets = validateBudgets(manifest.budgets);
  const skills = validateSkills(manifest.skills, harnessDir);
  const protocols = validateProtocols(manifest.protocols, harnessDir);
  return deepFreeze({
    version: manifest.version,
    manifest_sha256: manifest.canonical_sha256,
    model: modelConfig,
    budgets,
    skills,
    protocols
  });
}

export function harnessBinding(harness) {
  return {
    version: harness.version,
    manifest_sha256: harness.manifest_sha256,
    model: {
      id: harness.model.id,
      reasoning_effort: harness.model.reasoning_effort,
      store: harness.model.store
    },
    skills: Object.fromEntries(Object.entries(harness.skills).map(([name, skill]) => [name, {
      id: skill.id,
      version: skill.version,
      sha256: skill.sha256
    }])),
    protocols: {
      sha256: harness.protocols.sha256,
      tool_protocol_sha256: harness.protocols.tool_protocol_sha256,
      investigator_evaluator_handoff_sha256: harness.protocols.investigator_evaluator_handoff_sha256,
      owner_repair_sha256: harness.protocols.owner_repair_sha256,
      safe_failure_sha256: harness.protocols.safe_failure_sha256
    }
  };
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function validateModel(value, model) {
  assertExactKeys(value, ["default", "allowed", "reasoning_effort", "store"], "harness_model_shape_invalid");
  if (typeof value.default !== "string" || !Array.isArray(value.allowed) || !value.allowed.every((item) => typeof item === "string") || !value.allowed.includes(value.default)
    || !value.allowed.includes(model) || value.reasoning_effort !== "medium" || value.store !== false) {
    throw new HarnessManifestError("harness_model_config_invalid");
  }
  return { id: model, reasoning_effort: value.reasoning_effort, store: value.store };
}

function validateBudgets(value) {
  const keys = ["max_tool_rounds", "max_total_tool_calls", "max_paid_responses", "max_workflow_output_tokens", "investigator_max_output_tokens", "evaluator_max_output_tokens", "min_request_output_tokens"];
  assertExactKeys(value, keys, "harness_budget_shape_invalid");
  for (const key of keys) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new HarnessManifestError("harness_budget_value_invalid");
  if (value.evaluator_max_output_tokens < value.min_request_output_tokens || value.investigator_max_output_tokens < value.min_request_output_tokens
    || value.max_workflow_output_tokens < value.investigator_max_output_tokens || value.max_total_tool_calls < value.max_tool_rounds) {
    throw new HarnessManifestError("harness_budget_relationship_invalid");
  }
  return { ...value };
}

function validateSkills(value, harnessDir) {
  assertExactKeys(value, ["investigator", "evaluator"], "harness_skill_registry_invalid");
  const out = {};
  for (const name of ["investigator", "evaluator"]) {
    const skill = value[name];
    assertExactKeys(skill, ["id", "version", "file", "sha256"], "harness_skill_shape_invalid");
    if (typeof skill.id !== "string" || typeof skill.version !== "string" || !safeFile(skill.file) || !HASH.test(skill.sha256)) throw new HarnessManifestError("harness_skill_metadata_invalid");
    const content = readText(resolve(harnessDir, skill.file), "harness_skill_unreadable");
    if (sha256(content) !== skill.sha256) throw new HarnessManifestError("harness_skill_hash_mismatch");
    out[name] = { id: skill.id, version: skill.version, sha256: skill.sha256, content };
  }
  return out;
}

function validateProtocols(value, harnessDir) {
  const keys = ["file", "sha256", "tool_protocol_sha256", "investigator_evaluator_handoff_sha256", "owner_repair_sha256", "safe_failure_sha256"];
  assertExactKeys(value, keys, "harness_protocol_registry_invalid");
  if (!safeFile(value.file) || !keys.slice(1).every((key) => HASH.test(value[key]))) throw new HarnessManifestError("harness_protocol_metadata_invalid");
  const text = readText(resolve(harnessDir, value.file), "harness_protocol_unreadable");
  if (sha256(text) !== value.sha256) throw new HarnessManifestError("harness_protocol_hash_mismatch");
  const protocols = parseJson(text, "harness_protocol_json_invalid");
  if (protocols.version !== "flowpulse.protocols.v1" || !protocols.tool_protocol || !protocols.investigator_evaluator_handoff || !protocols.owner_repair || !protocols.safe_failure) {
    throw new HarnessManifestError("harness_protocol_version_unknown");
  }
  const actual = {
    tool_protocol_sha256: sha256(protocols.tool_protocol),
    investigator_evaluator_handoff_sha256: sha256(protocols.investigator_evaluator_handoff),
    owner_repair_sha256: sha256(protocols.owner_repair),
    safe_failure_sha256: sha256(protocols.safe_failure)
  };
  for (const [key, hash] of Object.entries(actual)) if (value[key] !== hash) throw new HarnessManifestError("harness_protocol_component_hash_mismatch");
  const names = protocols.tool_protocol.tool_names;
  if (!Array.isArray(names) || names.length !== TOOL_NAMES.length || names.some((name, index) => name !== TOOL_NAMES[index])) {
    throw new HarnessManifestError("harness_tool_protocol_invalid");
  }
  return { ...value, ...actual, schema: protocols.tool_protocol, definitions: protocols };
}

function readJson(path, code) { return parseJson(readText(path, code), code); }
function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new HarnessManifestError(code); } }
function readText(path, code) {
  try {
    const value = readFileSync(path, "utf8");
    if (!value.length || Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("bounded");
    return value;
  } catch { throw new HarnessManifestError(code); }
}
function safeFile(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9.-]*\.(md|json)$/.test(value); }
function assertExactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessManifestError(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new HarnessManifestError(code);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

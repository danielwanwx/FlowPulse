import { createHash } from "node:crypto";

export const AUTONOMY_SCHEMA_VERSION = "flowpulse.autonomy.v1";
export const PREAUTHORIZATION_SCHEMA_VERSION = "flowpulse-preauthorization.v1";
export const PREAUTHORIZATION_REGISTRY_VERSION = "flowpulse-preauthorization-registry.v1";
export const LEGACY_DETAIL_UNAVAILABLE = "legacy_detail_unavailable";

const HEX_64 = /^[a-f0-9]{64}$/;

export class AutonomyPolicyError extends Error {
  constructor(code, fieldPath = null) {
    super("Autonomy policy validation failed");
    this.name = "AutonomyPolicyError";
    this.code = code;
    this.field_path = fieldPath;
  }
}

// These utilities are non-authority primitives. Slice 2 must compose the
// server-owned ledger, capture store, receipt issuer, and decision provider
// inside the runtime closure; this module intentionally exposes no mint path.
export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function preauthorizationClaimId(input) {
  assertExactObject(input, ["incident_id", "environment", "target", "contract_sha256", "envelope_sha256"], "claim_scope", "consumption_input_invalid");
  const scope = {
    incident_id: requireText(input.incident_id, "incident_id", 160, "consumption_input_invalid"),
    environment: requireText(input.environment, "environment", 80, "consumption_input_invalid"),
    target: requireText(input.target, "target", 160, "consumption_input_invalid"),
    contract_sha256: requireHash(input.contract_sha256, "contract_sha256", "consumption_input_invalid"),
    envelope_sha256: requireHash(input.envelope_sha256, "envelope_sha256", "consumption_input_invalid")
  };
  return `preauthorization-claim-${sha256Canonical(scope).slice(0, 32)}`;
}

export function failureLockKey(input) {
  assertExactObject(input, ["incident_id", "contract_sha256", "target"], "failure_lock", "failure_lock_invalid");
  const scope = {
    incident_id: requireText(input.incident_id, "incident_id", 160, "failure_lock_invalid"),
    contract_sha256: requireHash(input.contract_sha256, "contract_sha256", "failure_lock_invalid"),
    target: requireText(input.target, "target", 160, "failure_lock_invalid")
  };
  return `autonomy-lock-${sha256Canonical(scope).slice(0, 32)}`;
}

function assertExactObject(value, keys, path, code) {
  if (!isPlainObject(value)) fail(code, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, path);
}

function requireText(value, path, maxBytes, code) {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) fail(code, path);
  return value;
}

function requireHash(value, path, code) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail(code, path);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical_value_invalid", "value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) fail("canonical_value_invalid", "value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code, fieldPath) {
  throw new AutonomyPolicyError(code, fieldPath);
}

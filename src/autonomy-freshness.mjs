import { createHash } from "node:crypto";

export const FRESHNESS_RECEIPT_SCHEMA_VERSION = "flowpulse.snapshot-freshness.v1";
export const FRESHNESS_MAX_AGE_MS = 5 * 60 * 1000;

const FRESHNESS_RECEIPT_ISSUER = "flowpulse.authority-composition.v1";
const HEX_64 = /^[a-f0-9]{64}$/;

export class FreshnessReceiptError extends Error {
  constructor(code, fieldPath = null) {
    super("Snapshot freshness validation failed");
    this.name = "FreshnessReceiptError";
    this.code = code;
    this.field_path = fieldPath;
  }
}

// Verification is safe for a bounded projection. Receipt issuance stays inside
// the future server-owned capture closure and is deliberately not exported.
export function verifySnapshotFreshnessReceipt({ receipt, manifest, now }) {
  assertExactObject(receipt, [
    "schema_version", "issuer", "snapshot_id", "snapshot_content_sha256", "snapshot_manifest_sha256",
    "snapshot_mode", "source_mode", "truth_mode", "observed_at", "expires_at", "receipt_sha256"
  ], "receipt");
  const snapshot = normalizeManifest(manifest);
  if (receipt.schema_version !== FRESHNESS_RECEIPT_SCHEMA_VERSION || receipt.issuer !== FRESHNESS_RECEIPT_ISSUER) fail("freshness_receipt_unknown", "receipt");
  if (!isHash(receipt.receipt_sha256)) fail("freshness_receipt_invalid", "receipt.receipt_sha256");
  const { receipt_sha256: receiptHash, ...unsigned } = receipt;
  if (sha256Canonical(unsigned) !== receiptHash) fail("freshness_receipt_hash_mismatch", "receipt.receipt_sha256");
  if (receipt.snapshot_id !== snapshot.id || receipt.snapshot_content_sha256 !== snapshot.content_sha256 || receipt.snapshot_manifest_sha256 !== snapshot.manifest_sha256 || receipt.snapshot_mode !== snapshot.mode) {
    fail("freshness_receipt_snapshot_mismatch", "receipt");
  }
  const expected = sourceForMode(snapshot.mode);
  if (receipt.source_mode !== expected.source_mode || receipt.truth_mode !== expected.truth_mode) fail("freshness_receipt_mode_mismatch", "receipt");
  const observedAt = timestamp(receipt.observed_at, "receipt.observed_at");
  const expiresAt = timestamp(receipt.expires_at, "receipt.expires_at");
  const currentAt = timestamp(now, "now");
  if (expiresAt - observedAt !== FRESHNESS_MAX_AGE_MS) fail("freshness_receipt_window_invalid", "receipt.expires_at");
  if (currentAt < observedAt) fail("freshness_clock_rollback", "now");
  if (currentAt >= expiresAt) fail("freshness_receipt_expired", "receipt.expires_at");
  return Object.freeze({
    status: expected.source_mode,
    fresh: true,
    truth_mode: expected.truth_mode,
    observed_at: receipt.observed_at,
    expires_at: receipt.expires_at,
    receipt_sha256: receiptHash
  });
}

function normalizeManifest(value) {
  assertExactObject(value, ["id", "content_sha256", "mode", "records", "manifest_sha256"], "manifest");
  if (typeof value.id !== "string" || !value.id || !isHash(value.content_sha256) || !isHash(value.manifest_sha256)) fail("freshness_receipt_invalid", "manifest");
  if (!Array.isArray(value.records) || value.records.length === 0 || !["deterministic_replay", "frozen_real_otlp_snapshot"].includes(value.mode)) fail("freshness_receipt_invalid", "manifest");
  return value;
}

function sourceForMode(mode) {
  if (mode === "deterministic_replay") return { source_mode: "captured_fixture", truth_mode: "captured_simulation" };
  if (mode === "frozen_real_otlp_snapshot") return { source_mode: "live", truth_mode: "live" };
  fail("freshness_receipt_mode_mismatch", "manifest.mode");
}

function assertExactObject(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("freshness_receipt_invalid", path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("freshness_receipt_invalid", path);
}

function timestamp(value, path) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 40) fail("freshness_receipt_invalid", path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("freshness_receipt_invalid", path);
  return parsed;
}

function isHash(value) { return typeof value === "string" && HEX_64.test(value); }

function fail(code, fieldPath) { throw new FreshnessReceiptError(code, fieldPath); }

function sha256Canonical(value) { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

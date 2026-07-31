import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildV3LocalConfig,
  publicV3LocalConfig,
} from "../scripts/v3-local-config.mjs";

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = "a".repeat(40);
const oid = "b".repeat(40);

test("V3 local config binds API, worker, Node, OTel, and independent secrets", () => {
  let index = 0;
  const values = ["o", "e", "r"].map((prefix) => prefix.repeat(64));
  const config = buildV3LocalConfig({
    environment: {},
    rootDir: root,
    gitSha: sha,
    workflowBlobOid: oid,
    cleanWorktree: true,
    secretFactory: () => values[index++],
  });
  const env = config.runtimeEnvironment;
  assert.equal(sha, env.FLOWPULSE_PRODUCER_GIT_SHA);
  assert.equal(oid, env.FLOWPULSE_WORKSPACE_WORKFLOW_BLOB_OID);
  assert.equal(env.FLOWPULSE_TEST_OWNER_TOKEN, env.FLOWPULSE_CONTROL_PLANE_BEARER);
  assert.match(env.FLOWPULSE_V3_INTERNAL_BRIDGE_URL, /host\.docker\.internal:4173$/);
  assert.equal(env.FLOWPULSE_V3_INTERNAL_BRIDGE_URL, env.FLOWPULSE_V3_SAFE_ROLLBACK_URL);
  assert.notEqual(env.FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET, env.FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET);
  assert.equal("0", env.FLOWPULSE_ENABLE_DETERMINISTIC_TEST_PROVIDERS);
  assert.equal("", env.FLOWPULSE_PROMETHEUS_URL);
  assert.equal("/flowpulse-otel", env.FLOWPULSE_OTEL_SPOOL_ROOT);
  assert.deepEqual(JSON.parse(env.FLOWPULSE_TEST_FIXTURE_CONTEXT_JSON), {
    tenant_id: "tenant-v3-aaaaaaaaaaaa",
    subject_id: "owner-v3-local",
    roles: ["owner"],
  });
  assert.equal("tenant-v3-aaaaaaaaaaaa", env.FLOWPULSE_REALTIME_TENANT_ID);
  assert.equal("owner-v3-local", env.FLOWPULSE_REALTIME_ACTOR_SUBJECT_ID);
  assert.equal("0.5", env.FLOWPULSE_REALTIME_SCHEDULER_INTERVAL_SECONDS);
  assert.equal(true, publicV3LocalConfig(config).preserves_postgres_and_minio_volumes);
  assert.equal(true, publicV3LocalConfig(config).startable);
});

test("V3 local config rejects weak or shared authority secrets", () => {
  assert.throws(() => buildV3LocalConfig({
    environment: { FLOWPULSE_TEST_OWNER_TOKEN: "short" },
    rootDir: root,
    gitSha: sha,
    workflowBlobOid: oid,
    cleanWorktree: true,
  }), /32-256/);
  const shared = "s".repeat(64);
  assert.throws(() => buildV3LocalConfig({
    environment: {
      FLOWPULSE_TEST_OWNER_TOKEN: shared,
      FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET: shared,
      FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET: shared,
    },
    rootDir: root,
    gitSha: sha,
    workflowBlobOid: oid,
    cleanWorktree: true,
  }), /must be independent/);
});

test("V3 local dry-run is non-mutating, attested, and never prints secrets", async () => {
  const result = await execute(process.execPath, [
    "scripts/start-v3-local.mjs",
    "--dry-run",
    "--json",
  ], { cwd: root, timeout: 20_000, maxBuffer: 1_000_000 });
  const summary = JSON.parse(result.stdout);
  assert.match(summary.producer_git_sha, /^[a-f0-9]{40}$/);
  assert.match(summary.workspace_workflow_blob_oid, /^[a-f0-9]{40}$/);
  assert.notEqual("unattested", summary.producer_git_sha);
  assert.equal(true, summary.preserves_postgres_and_minio_volumes);
  assert.equal(true, summary.secret_metadata.independent);
  assert.equal(undefined, summary.owner_token);
  assert.equal(undefined, summary.bridge_secret);
  assert.equal(undefined, summary.rollback_secret);
});

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export const V3_LOCAL_CONFIG_SCHEMA = "flowpulse.v3-local-runtime-config.v1";

function requiredGitObject(name, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`${name} must be an attested 40-character Git object`);
  }
  return value.toLowerCase();
}

function port(value) {
  const parsed = Number(value ?? 4173);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error("FLOWPULSE_V3_UI_PORT must be a non-privileged TCP port");
  }
  return parsed;
}

function generatedSecret() {
  return randomBytes(32).toString("hex");
}

function secret(name, value, factory) {
  const resolved = value == null || value === "" ? factory() : value;
  if (
    typeof resolved !== "string"
    || Buffer.byteLength(resolved, "utf8") < 32
    || Buffer.byteLength(resolved, "utf8") > 256
    || /[\u0000-\u001f\u007f]/.test(resolved)
  ) {
    throw new Error(`${name} must contain 32-256 non-control bytes`);
  }
  return resolved;
}

export function buildV3LocalConfig({
  environment = process.env,
  rootDir,
  gitSha,
  workflowBlobOid,
  cleanWorktree,
  secretFactory = generatedSecret,
} = {}) {
  if (typeof rootDir !== "string" || !rootDir) {
    throw new Error("FlowPulse repository root is required");
  }
  const producerGitSha = requiredGitObject(
    "FLOWPULSE_PRODUCER_GIT_SHA",
    gitSha,
  );
  const workflowOid = requiredGitObject(
    "FLOWPULSE_WORKSPACE_WORKFLOW_BLOB_OID",
    workflowBlobOid,
  );
  const uiPort = port(environment.FLOWPULSE_V3_UI_PORT);
  const ownerToken = secret(
    "FLOWPULSE_TEST_OWNER_TOKEN",
    environment.FLOWPULSE_TEST_OWNER_TOKEN,
    secretFactory,
  );
  const bridgeSecret = secret(
    "FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET",
    environment.FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET,
    secretFactory,
  );
  const rollbackSecret = secret(
    "FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET",
    environment.FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET,
    secretFactory,
  );
  if (new Set([ownerToken, bridgeSecret, rollbackSecret]).size !== 3) {
    throw new Error("V3 owner, execution, and rollback secrets must be independent");
  }

  const otelHostDir = resolve(
    environment.FLOWPULSE_OTEL_HOST_DIR
      || resolve(rootDir, "outputs", "live", "otel"),
  );
  const nodeBaseUrl = `http://host.docker.internal:${uiPort}`;
  const browserBaseUrl = `http://127.0.0.1:${uiPort}`;
  const controlPlaneUrl = "http://127.0.0.1:8090";
  const tenantId = environment.FLOWPULSE_V3_TENANT_ID || "tenant-v3-local";
  const ownerSubjectId = environment.FLOWPULSE_V3_OWNER_SUBJECT_ID || "owner-v3-local";
  const runtimeEnvironment = {
    ...environment,
    FLOWPULSE_PRODUCER_GIT_SHA: producerGitSha,
    FLOWPULSE_WORKSPACE_WORKFLOW_BLOB_OID: workflowOid,
    FLOWPULSE_TEST_OWNER_TOKEN: ownerToken,
    FLOWPULSE_TEST_FIXTURE_CONTEXT_JSON: JSON.stringify({
      tenant_id: tenantId,
      subject_id: ownerSubjectId,
      roles: ["owner"],
    }),
    FLOWPULSE_PROVIDER_MODE: "standard",
    FLOWPULSE_ENABLE_DETERMINISTIC_TEST_PROVIDERS: "0",
    FLOWPULSE_PROMETHEUS_URL: "",
    FLOWPULSE_PROMETHEUS_BINDINGS_JSON: "[]",
    FLOWPULSE_CONNECTOR_ALLOWED_ORIGINS: "",
    FLOWPULSE_CONNECTOR_ALLOW_PRIVATE_ORIGINS: "0",
    FLOWPULSE_OTEL_HOST_DIR: otelHostDir,
    FLOWPULSE_OTEL_SPOOL_ROOT: "/flowpulse-otel",
    FLOWPULSE_REALTIME_SCHEDULER_INTERVAL_SECONDS: "2",
    FLOWPULSE_REALTIME_TENANT_ID: tenantId,
    FLOWPULSE_REALTIME_ACTOR_SUBJECT_ID: ownerSubjectId,
    FLOWPULSE_V3_INTERNAL_BRIDGE_URL: nodeBaseUrl,
    FLOWPULSE_V3_INTERNAL_BRIDGE_HMAC_SECRET: bridgeSecret,
    FLOWPULSE_V3_SAFE_ROLLBACK_URL: nodeBaseUrl,
    FLOWPULSE_V3_SAFE_ROLLBACK_HMAC_SECRET: rollbackSecret,
    FLOWPULSE_CONTROL_PLANE_URL: controlPlaneUrl,
    FLOWPULSE_CONTROL_PLANE_BEARER: ownerToken,
    FLOWPULSE_DEVELOPMENT_ENABLED: "1",
    FLOWPULSE_OTLP_DIR: otelHostDir,
    FLOWPULSE_RUNTIME_GIT_SHA: producerGitSha,
    HOST: "127.0.0.1",
    PORT: String(uiPort),
  };

  return {
    schemaVersion: V3_LOCAL_CONFIG_SCHEMA,
    rootDir: resolve(rootDir),
    controlPlaneDir: resolve(rootDir, "control_plane"),
    otelHostDir,
    producerGitSha,
    workflowBlobOid: workflowOid,
    cleanWorktree: Boolean(cleanWorktree),
    uiPort,
    browserBaseUrl,
    controlPlaneUrl,
    runtimeEnvironment,
    secretMetadata: {
      ownerTokenBytes: Buffer.byteLength(ownerToken, "utf8"),
      bridgeHmacBytes: Buffer.byteLength(bridgeSecret, "utf8"),
      rollbackHmacBytes: Buffer.byteLength(rollbackSecret, "utf8"),
      independent: true,
    },
    compose: {
      services: ["api", "worker", "temporal", "postgres", "minio"],
      buildSha: producerGitSha,
      preservesVolumes: true,
    },
  };
}

export function publicV3LocalConfig(config) {
  return {
    schema_version: config.schemaVersion,
    producer_git_sha: config.producerGitSha,
    workspace_workflow_blob_oid: config.workflowBlobOid,
    clean_worktree: config.cleanWorktree,
    startable: config.cleanWorktree,
    ui_url: `${config.browserBaseUrl}/`,
    control_plane_url: config.controlPlaneUrl,
    otel_host_dir: config.otelHostDir,
    compose_services: config.compose.services,
    preserves_postgres_and_minio_volumes: config.compose.preservesVolumes,
    secret_metadata: config.secretMetadata,
  };
}

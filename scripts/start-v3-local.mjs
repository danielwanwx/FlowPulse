import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildV3LocalConfig,
  publicV3LocalConfig,
} from "./v3-local-config.mjs";
import {
  astronomyActiveIncidentSummaries,
  captureTraceWatermark,
  coordinateV3LocalStartup,
  evaluateV3CaseReadiness,
  hasExactProjectedFailureEvidence,
  reconcileAstronomyLaunch,
  waitForPostWatermarkCheckoutPaymentFailure,
} from "./v3-local-recovery.mjs";

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argumentsSet = new Set(process.argv.slice(2));
const dryRun = argumentsSet.has("--dry-run");
const jsonOutput = argumentsSet.has("--json");
const forceNewCase = argumentsSet.has("--new-case");

function progress(message) {
  if (!jsonOutput) process.stdout.write(`[FlowPulse V3] ${message}\n`);
}

async function git(...args) {
  return (await execute("git", args, {
    cwd: root,
    timeout: 15_000,
    maxBuffer: 2_000_000,
  })).stdout.trim();
}

async function runtimeConfig() {
  const [gitSha, workflowBlobOid, status] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD:control_plane/flowpulse_cp/workspace_workflow.py"),
    git("status", "--porcelain", "--untracked-files=all"),
  ]);
  return buildV3LocalConfig({
    environment: process.env,
    rootDir: root,
    gitSha,
    workflowBlobOid,
    cleanWorktree: status.length === 0,
  });
}

async function run(command, args, options = {}) {
  progress(`${command} ${args.join(" ")}`);
  return execute(command, args, {
    cwd: options.cwd || root,
    env: options.env,
    timeout: options.timeout || 300_000,
    maxBuffer: 4_000_000,
  });
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  }).catch((error) => {
    throw new Error(`UI port ${port} is unavailable: ${error.message}`);
  });
}

async function astronomyJson(command, environment) {
  try {
    const result = await execute(process.execPath, [
      "scripts/live-demo.mjs",
      command,
    ], {
      cwd: root,
      env: environment,
      timeout: 20_000,
      maxBuffer: 2_000_000,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (command !== "check") throw error;
    return null;
  }
}

async function astronomyStatus(environment) {
  return astronomyJson("check", environment);
}

async function ensureAstronomy(config) {
  let status = await astronomyStatus(config.runtimeEnvironment);
  if (!status || status.revision !== status.pin) {
    await run(process.execPath, ["scripts/live-demo.mjs", "setup"], {
      env: config.runtimeEnvironment,
      timeout: 360_000,
    });
  }
  status = await astronomyStatus(config.runtimeEnvironment);
  if (!status || status.revision !== status.pin) {
    throw new Error("Pinned Astronomy Shop setup did not attest its revision");
  }
  if (!status.ready) {
    await run(process.execPath, ["scripts/live-demo.mjs", "start"], {
      env: config.runtimeEnvironment,
      timeout: 360_000,
    });
  }
  const readyDeadline = Date.now() + 120_000;
  while (Date.now() < readyDeadline) {
    status = await astronomyStatus(config.runtimeEnvironment);
    if (status?.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!status?.ready) {
    throw new Error("Pinned Astronomy Shop did not become ready");
  }
}

async function startControlPlane(config) {
  const compose = ["compose", "--progress", "quiet"];
  await run("docker", [...compose, "config", "--quiet"], {
    cwd: config.controlPlaneDir,
    env: config.runtimeEnvironment,
    timeout: 60_000,
  });
  await run("docker", [
    ...compose,
    "up",
    "--build",
    "--detach",
    "--wait",
  ], {
    cwd: config.controlPlaneDir,
    env: config.runtimeEnvironment,
    timeout: 600_000,
  });
  await Promise.all(["api", "worker", "authz"].map((service) => (
    verifyServiceAttestation(config, service)
  )));
  await waitForHttp(`${config.controlPlaneUrl}/healthz`, null, 120_000);
}

async function verifyServiceAttestation(config, service) {
  const container = (await execute("docker", [
    "compose", "ps", "--quiet", service,
  ], {
    cwd: config.controlPlaneDir,
    env: config.runtimeEnvironment,
    timeout: 20_000,
  })).stdout.trim();
  if (!container) throw new Error(`${service} container is not running`);
  const [sha, workflowOid] = await Promise.all([
    execute("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"io.flowpulse.producer_git_sha\"}}",
      container,
    ], { timeout: 20_000 }),
    execute("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"io.flowpulse.workspace_workflow_blob_oid\"}}",
      container,
    ], { timeout: 20_000 }),
  ]);
  if (
    sha.stdout.trim() !== config.producerGitSha
    || workflowOid.stdout.trim() !== config.workflowBlobOid
  ) {
    throw new Error(`${service} image attestation does not match the current Git SHA`);
  }
}

async function waitForHttp(url, token, timeout) {
  const deadline = Date.now() + timeout;
  let lastError = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${url} remained unavailable: ${lastError}`);
}

async function apiJson(config, path, { method = "GET", body } = {}) {
  const response = await fetch(new URL(path, config.controlPlaneUrl), {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.runtimeEnvironment.FLOWPULSE_TEST_OWNER_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function inspectActiveAstronomyProjection(config) {
  const snapshot = await apiJson(config, "/v3/live/snapshot");
  const active = astronomyActiveIncidentSummaries(snapshot);
  if (active.length > 1) {
    throw new Error("Multiple active local Astronomy incidents exist; refusing to guess which runtime state to resume");
  }
  if (forceNewCase && active.length) {
    throw new Error("--new-case cannot mutate the runtime while an Astronomy incident is still active");
  }
  if (forceNewCase || active.length === 0) return null;
  return apiJson(
    config,
    `/v3/incidents/${encodeURIComponent(active[0].case_id)}/projection`,
  );
}

async function createAstronomyCase(config) {
  const projection = await apiJson(config, "/v1/incidents", {
    method: "POST",
    body: {
      incident_id: `local-astronomy-${randomUUID()}`,
      title: "Checkout cannot reach Payment",
      severity: "SEV2",
      environment: "local-astronomy",
      affected_entities: ["checkout", "payment"],
      observed_at: new Date().toISOString(),
      summary: "Current telemetry shows Checkout requests to Payment are failing.",
    },
  });
  return projection.case_id;
}

async function reconcileAstronomyCase(config) {
  const projection = await inspectActiveAstronomyProjection(config);
  const tracePath = join(config.otelHostDir, "traces.jsonl");
  const manifest = await astronomyJson("manifest", config.runtimeEnvironment);
  const result = await reconcileAstronomyLaunch({
    projection,
    manifest,
    readFlag: () => astronomyJson("flag", config.runtimeEnvironment),
    applyFault: async () => {
      progress("applying allowlisted paymentUnreachable case to the pinned Astronomy Shop");
      await astronomyJson("case", config.runtimeEnvironment);
    },
    readRuntime: () => astronomyJson("runtime", config.runtimeEnvironment),
    captureWatermark: () => captureTraceWatermark(tracePath),
    waitForFailure: (watermark) => waitForPostWatermarkCheckoutPaymentFailure(
      tracePath,
      watermark,
    ),
  });
  progress(
    `Astronomy launch reconciled (${result.mode}); flag=${result.final_flag.variant}; watermark=${result.watermark.recorded_at}@${result.watermark.byte_offset}`,
  );
  if (result.failure_evidence) {
    progress(
      `new real checkout→payment failure trace: ${result.failure_evidence.trace_id} at ${result.failure_evidence.observed_at}`,
    );
  } else {
    progress(
      `post-execution runtime matches receipt ${result.recovery_receipt.id}; fault remains off`,
    );
  }
  const caseId = projection?.case_id || await createAstronomyCase(config);
  return { case_id: caseId, reconciliation: result };
}

async function waitForV3Case(config, context) {
  const caseId = context.case_id;
  const deadline = Date.now() + 180_000;
  let lastError = "not projected";
  while (Date.now() < deadline) {
    try {
      const [projection, sourceProjection, series] = await Promise.all([
        apiJson(config, `/v3/incidents/${encodeURIComponent(caseId)}/projection`),
        apiJson(config, `/v2/incidents/${encodeURIComponent(caseId)}/projection`),
        apiJson(config, `/v3/incidents/${encodeURIComponent(caseId)}/series`),
      ]);
      const readiness = evaluateV3CaseReadiness({
        projection,
        sourceProjection,
        series,
        reconciliation: context.reconciliation,
      });
      if (projection.case_id === caseId && readiness.ready) {
        const expectedFailure = context.reconciliation.failure_evidence;
        if (expectedFailure) {
          const envelopes = await Promise.all(readiness.edge_evidence_refs.map((evidenceId) => (
            apiJson(
              config,
              `/v2/incidents/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(evidenceId)}`,
            )
          )));
          if (!hasExactProjectedFailureEvidence(envelopes, expectedFailure)) {
            lastError = "the exact post-watermark failure trace is not yet in the canonical evidence ledger";
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            continue;
          }
        }
        return projection;
      }
      lastError = readiness.reason || "projection identity mismatch";
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`V3 case ${caseId} did not receive real telemetry: ${lastError}`);
}

async function startNodeBridge(config) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: config.runtimeEnvironment,
    stdio: "inherit",
  });
  await Promise.race([
    waitForHttp(`${config.browserBaseUrl}/`, null, 30_000),
    new Promise((_, reject) => child.once("exit", (code) => {
      reject(new Error(`Node/BFF exited before listening (code ${code ?? 1})`));
    })),
  ]);
  progress("Node/BFF internal bridge is listening; waiting for V3 backend readiness");
  return child;
}

async function announceUiReady(config, context) {
  const url = `${config.browserBaseUrl}/?case_id=${encodeURIComponent(context.case_id)}`;
  progress(`UI ready: ${url}`);
}

async function waitForNode(child) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  process.exitCode = code;
  return code;
}

async function stopNode(child) {
  if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
}

const config = await runtimeConfig();
if (dryRun) {
  const summary = publicV3LocalConfig(config);
  process.stdout.write(`${JSON.stringify(summary, null, jsonOutput ? 0 : 2)}\n`);
} else {
  if (!config.cleanWorktree) {
    throw new Error(
      "V3 local start refuses a dirty worktree because containers and Node would not share an attestable Git SHA",
    );
  }
  await assertPortAvailable(config.uiPort);
  await coordinateV3LocalStartup({
    ensureAstronomy: () => ensureAstronomy(config),
    startNodeBridge: () => startNodeBridge(config),
    startControlPlane: () => startControlPlane(config),
    reconcileCase: () => reconcileAstronomyCase(config),
    waitForCase: (context) => waitForV3Case(config, context),
    announceReady: (context) => announceUiReady(config, context),
    waitForNode,
    stopNode,
  });
}

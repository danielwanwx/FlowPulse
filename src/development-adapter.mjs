import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const integration = join(root, "integrations", "astronomy-shop");
const runtimeRoot = join(root, "outputs", "live");
const checkout = join(runtimeRoot, "opentelemetry-demo");
const capture = join(runtimeRoot, "otel");

export async function developmentStatus() {
  const pin = await readJson(join(integration, "pin.json"));
  const result = { enabled: process.env.FLOWPULSE_DEVELOPMENT_ENABLED === "1", pin: pin.commit, checkout, capture, docker: false, revision: null, flag_api: false };
  try {
    await execute("docker", ["compose", "version"], { timeout: 8_000 });
    result.docker = true;
  } catch { /* surfaced as a read-only diagnostic */ }
  try {
    result.revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: checkout, timeout: 8_000 })).stdout.trim();
  } catch { /* setup has not completed */ }
  try {
    const response = await fetch(`${await resolveFlagUrl()}/api/read`, { signal: AbortSignal.timeout(3_000) });
    result.flag_api = response.ok;
  } catch { /* runtime is not running */ }
  result.ready = result.enabled && result.docker && result.revision === pin.commit && result.flag_api;
  return result;
}

export async function setupDevelopment() {
  assertEnabled();
  const pin = await readJson(join(integration, "pin.json"));
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(capture, { recursive: true });
  try {
    await stat(join(checkout, ".git"));
  } catch {
    await execute("git", ["clone", "--filter=blob:none", pin.repository, checkout], { timeout: 180_000 });
  }
  await execute("git", ["fetch", "--depth", "1", "origin", pin.commit], { cwd: checkout, timeout: 180_000 });
  await execute("git", ["checkout", "--detach", pin.commit], { cwd: checkout, timeout: 60_000 });
  return developmentStatus();
}

export async function startDevelopment() {
  assertEnabled();
  const status = await developmentStatus();
  if (status.revision !== status.pin) throw new Error("Pinned Astronomy Shop checkout is required; run npm run live:setup first");
  await mkdir(capture, { recursive: true });
  const result = await execute("docker", composeArgs("up", "-d", "--remove-orphans"), { cwd: checkout, env: composeEnv(), timeout: 300_000, maxBuffer: 2_000_000 });
  return { ...await developmentStatus(), command_id: "astronomy.start-full", stdout: summarize(result.stdout), stderr: summarize(result.stderr) };
}

export async function applyDevelopmentCase() {
  assertEnabled();
  const status = await developmentStatus();
  if (!status.ready) throw new Error("The pinned local Astronomy Shop runtime is not ready");
  const change = await readJson(join(integration, "change.payment-unreachable.json"));
  const flags = await readFlags();
  if (!flags.flags?.[change.flag]) throw new Error(`Upstream flag ${change.flag} is unavailable`);
  const before = flags.flags[change.flag].defaultVariant;
  flags.flags[change.flag].defaultVariant = change.after;
  await writeFlags(flags);
  return { change, before, after: change.after, applied_at: new Date().toISOString(), source: "official flagd-ui API" };
}

export async function executeApprovedRollback({ commandId }) {
  assertEnabled();
  const change = await readJson(join(integration, "change.payment-unreachable.json"));
  if (commandId !== change.repair_command_id) throw new Error("Repair command is outside the allowlist");
  const flags = await readFlags();
  if (!flags.flags?.[change.flag]) throw new Error(`Upstream flag ${change.flag} is unavailable`);
  flags.flags[change.flag].defaultVariant = change.known_good;
  await writeFlags(flags);
  const result = await execute("docker", composeArgs("up", "-d", "--no-deps", "--force-recreate", "checkout"), {
    cwd: checkout, env: composeEnv(), timeout: change.timeout_seconds * 1_000, maxBuffer: 1_000_000
  });
  return { change, completed_at: new Date().toISOString(), command_id: commandId, stdout: summarize(result.stdout), stderr: summarize(result.stderr) };
}

export async function stopDevelopment() {
  assertEnabled();
  const result = await execute("docker", composeArgs("down"), { cwd: checkout, env: composeEnv(), timeout: 180_000, maxBuffer: 1_000_000 });
  return { stopped: true, stdout: summarize(result.stdout), stderr: summarize(result.stderr) };
}

export async function finalizeCapture({ runId, evidenceIds }) {
  const pin = await readJson(join(integration, "pin.json"));
  const files = [];
  for (const name of ["traces.jsonl", "metrics.jsonl", "logs.jsonl"]) {
    const path = join(capture, name);
    const info = await stat(path);
    files.push({ name, bytes: info.size, sha256: await hashPrefix(path, info.size) });
  }
  const content = { schema_version: 1, run_id: runId, upstream_commit: pin.commit, files, evidence_ids: [...new Set(evidenceIds)].sort() };
  const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const manifest = { id: `capture-${digest.slice(0, 16)}`, sha256: digest, created_at: new Date().toISOString(), ...content };
  const directory = join(runtimeRoot, "captures", runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return manifest;
}

function composeArgs(...tail) {
  return ["compose", "--progress", "quiet", "--env-file", join(checkout, ".env"), "-f", join(checkout, "compose.yaml"), "-f", join(checkout, "compose.full.yaml"), "-f", join(integration, "compose.flowpulse.yaml"), ...tail];
}

function composeEnv() {
  return {
    ...process.env,
    FLOWPULSE_CAPTURE_DIR: capture,
    OTEL_COLLECTOR_CONFIG: join(checkout, "src", "otel-collector", "otelcol-config.yml"),
    OTEL_COLLECTOR_CONFIG_FULL: join(checkout, "src", "otel-collector", "otelcol-config-full.yml"),
    OTEL_COLLECTOR_CONFIG_EXTRAS: join(integration, "otelcol-flowpulse.yml")
  };
}

async function readFlags() {
  const response = await fetch(`${await resolveFlagUrl()}/api/read`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`flagd-ui read failed (${response.status})`);
  return response.json();
}

async function writeFlags(data) {
  const response = await fetch(`${await resolveFlagUrl()}/api/write`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`flagd-ui write failed (${response.status})`);
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function resolveFlagUrl() {
  if (process.env.FLOWPULSE_FLAGD_UI_URL) return process.env.FLOWPULSE_FLAGD_UI_URL;
  const result = await execute("docker", ["port", "flagd-ui", "4000/tcp"], { timeout: 5_000 });
  const address = result.stdout.trim().split(/\r?\n/)[0].replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  if (!address) throw new Error("flagd-ui port is unavailable");
  return `http://${address}`;
}
function assertEnabled() { if (process.env.FLOWPULSE_DEVELOPMENT_ENABLED !== "1") throw new Error("Local development mutation is disabled"); }
function summarize(value = "") { return value.trim().slice(-4_000); }

function hashPrefix(path, bytes) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { start: 0, end: Math.max(0, bytes - 1) });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

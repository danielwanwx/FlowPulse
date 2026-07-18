import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const required = [
  "README.md", "LICENSE", "data/incidents/astronomy-checkout.json", "docs/judge-script.md",
  "docs/submission/devpost.md", "docs/submission/video-script.md", "docs/submission/submission-checklist.md",
  "docs/submission/screenshots/01-architecture.jpg", "docs/submission/screenshots/02-evaluator-rejection.jpg",
  "docs/submission/screenshots/03-owner-gate.jpg", "docs/submission/screenshots/04-verified-compare.jpg",
  "docs/qa/2026-07-18-competition-backend-hardening-qa.md", "Dockerfile", ".dockerignore"
];

for (const path of required) await stat(new URL(path, root));
await assertTrackedFilesAreSafe();
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
await smokeFreshServer();
console.log("submission:check passed — deterministic judge path is self-contained and credential-free.");

async function assertTrackedFilesAreSafe() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "git ls-files failed");
  const files = result.stdout.split("\0").filter(Boolean);
  const forbidden = files.filter((path) => /^(node_modules\/|\.env$|\.flowpulse\/|outputs\/live\/)|\.(?:db|sqlite3?|log)$/i.test(path));
  assert.deepEqual(forbidden, [], `Forbidden tracked runtime artifacts: ${forbidden.join(", ")}`);
  const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk(?:-lf)?-[A-Za-z0-9_-]{20,}\b/;
  for (const path of files.filter((file) => /\.(?:mjs|js|json|md|ya?ml|env|txt)$/i.test(file) || file === "README.md")) {
    const body = await readFile(new URL(path, root), "utf8");
    assert.equal(secretPattern.test(body), false, `Potential secret in tracked file: ${path}`);
    for (const [, value] of body.matchAll(/(?:OPENAI_API_KEY|LANGFUSE_SECRET_KEY)\s*=\s*([^\s#]+)/g)) {
      assert.equal(["your-key", "sk-lf-..."].includes(value), true, `Potential credential assignment in tracked file: ${path}`);
    }
  }
}

async function smokeFreshServer() {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-submission-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", FLOWPULSE_DB: join(directory, "ledger.db"), FLOWPULSE_DEVELOPMENT_ENABLED: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForServer(child, port);
    const health = await request(port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    let state = (await request(port, "/api/state")).body;
    assert.equal(state.status, "investigating");
    for (let index = 0; index < 7; index++) state = (await request(port, "/api/next", "POST")).body;
    assert.equal(state.waiting_for_approval, true);
    assert.equal(state.events.some((event) => event.type === "evaluation.rejected" && event.payload.hypothesis_id === "hyp-kafka"), true);
    assert.equal(state.events.some((event) => event.type === "repair.executed"), false);
    state = (await request(port, "/api/approve", "POST", { owner: "Release check owner" })).body;
    state = (await request(port, "/api/next", "POST")).body;
    state = (await request(port, "/api/next", "POST")).body;
    assert.equal(state.complete, true);
    assert.equal(state.status, "resolved");
    assert.equal(state.events.some((event) => event.type === "regression.created"), true);
    assert.equal(state.events.some((event) => event.type === "policy.evaluated" && event.payload.passed), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
    child.once("error", reject);
  });
}

function request(port, path, method = "GET", body = undefined) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fresh judge server did not start")), 8_000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes(`127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (/Error|EADDRINUSE/.test(chunk.toString())) {
        clearTimeout(timeout);
        reject(new Error(chunk.toString()));
      }
    });
    child.once("exit", (code) => {
      if (code) reject(new Error(`Fresh judge server exited ${code}`));
    });
  });
}

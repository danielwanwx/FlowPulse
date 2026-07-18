import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

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
console.log("submission:check passed — tests include an isolated fresh-port health and deterministic owner-gate API smoke.");

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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, HOST: "127.0.0.1" } });
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
    child.once("error", reject);
  });
}

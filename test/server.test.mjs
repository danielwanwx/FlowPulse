import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("judge API serves state and advances the replay", async (context) => {
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), FLOWPULSE_DB: join(mkdtempSync(join(tmpdir(), "flowpulse-server-")), "ledger.db") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForServer(child, port);

  const initial = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  assert.equal(initial.status, "investigating");
  assert.equal(initial.events[0].type, "run.started");

  const advancedResponse = await fetch(`http://127.0.0.1:${port}/api/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(advancedResponse.status, 200);
  const advanced = await advancedResponse.json();
  assert.equal(advanced.evidence.length, 3);
  assert.equal(advanced.events.some((event) => event.type === "loop.symptoms_collected"), true);

  const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  assert.match(html, /FlowPulse/);
  assert.match(html, /Run guided replay/);

  const module = await fetch(`http://127.0.0.1:${port}/twin-state.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /text\/javascript/);

  const crossOriginStyleMutation = await fetch(`http://127.0.0.1:${port}/api/development/case`, { method: "POST" });
  assert.equal(crossOriginStyleMutation.status, 409);
  assert.match((await crossOriginStyleMutation.json()).error, /application\/json is required/);
});

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes(`127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (/Error|EADDRINUSE/.test(text)) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(`Server exited with ${code}`));
    });
  });
}

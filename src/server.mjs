import "./load-env.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.mjs";
import { loadBundle } from "./bundle.mjs";
import { IncidentRuntime } from "./runtime.mjs";
import { runLiveInvestigation } from "./openai.mjs";
import { initializeObservability, shutdownObservability } from "./observability.mjs";
import { LiveSource } from "./live-source.mjs";
import { DevelopmentRuntime } from "./development-runtime.mjs";
import * as developmentAdapter from "./development-adapter.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const dbPath = process.env.FLOWPULSE_DB || join(root, ".flowpulse", "ledger.db");
const port = Number(process.env.PORT || 4310);
const ledger = new Ledger(dbPath);
const bundle = loadBundle();
const runtime = new IncidentRuntime({ ledger, bundle });
const liveSource = new LiveSource({ directory: process.env.FLOWPULSE_OTLP_DIR || join(root, "outputs", "live", "otel") });
const development = new DevelopmentRuntime({ runtime, source: liveSource, adapter: developmentAdapter });
runtime.ensureRun();
const langfuseEnabled = await initializeObservability().catch((error) => {
  console.warn(`Langfuse disabled: ${error.message}`);
  return false;
});

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "OPTIONS") return send(response, 204, "");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(response, 200, await stateWithSource());
    }
    if (url.pathname === "/api/source" && request.method === "GET") {
      return json(response, 200, await liveSource.project());
    }
    if (url.pathname === "/api/development/status" && request.method === "GET") {
      return json(response, 200, await developmentAdapter.developmentStatus());
    }
    if (url.pathname === "/api/development/setup" && request.method === "POST") {
      requireJson(request);
      return json(response, 200, await developmentAdapter.setupDevelopment());
    }
    if (url.pathname === "/api/development/start" && request.method === "POST") {
      requireJson(request);
      return json(response, 200, await developmentAdapter.startDevelopment());
    }
    if (url.pathname === "/api/development/case" && request.method === "POST") {
      requireJson(request);
      const runId = await development.start();
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/investigate" && request.method === "POST") {
      requireJson(request);
      const runId = runtime.ensureRun();
      await development.investigate(runId);
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/approve" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      await development.approve(runId, body.owner || "Development owner");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/verify" && request.method === "POST") {
      requireJson(request);
      const runId = runtime.ensureRun();
      await development.verify(runId);
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/reset" && request.method === "POST") {
      const runId = runtime.startRun();
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/next" && request.method === "POST") {
      const runId = runtime.ensureRun();
      runtime.next(runId);
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      runtime.approve(runId, body.owner || "Incident owner");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/live" && request.method === "POST") {
      const runId = runtime.startRun("live");
      try {
        const result = await runLiveInvestigation({ runtime, runId });
        return json(response, 200, { result, state: await stateWithSource(runId) });
      } catch (error) {
        runtime.append(runId, "live.run.failed", "runtime", {
          classification: error.message.includes("approved boundary") ? "agent_false_positive" : "tool_data_failure",
          reason: error.message
        });
        return json(response, 422, { error: error.message, state: await stateWithSource(runId) });
      }
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      const source = await liveSource.project();
      return json(response, 200, { ok: true, ledger: "sqlite-append-only", langfuse: langfuseEnabled, source: source.status });
    }
    if (request.method !== "GET") return json(response, 404, { error: "Not found" });
    return serveStatic(url.pathname, response);
  } catch (error) {
    return json(response, error.message.includes("required") ? 409 : 500, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`FlowPulse ready at http://127.0.0.1:${port}`);
  console.log(`Mode: deterministic replay${process.env.OPENAI_API_KEY ? " + live GPT-5.6" : ""}${langfuseEnabled ? " + Langfuse" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await shutdownObservability().catch(() => {});
    process.exit(0);
  });
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, "");
  const path = join(publicDir, safe);
  if (!path.startsWith(publicDir)) return json(response, 404, { error: "Not found" });
  try {
    const body = await readFile(path);
    response.writeHead(200, { "content-type": mime(extname(path)), "cache-control": "no-store" });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function requireJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("application/json is required for local development actions");
  }
}

function setHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:");
}

function json(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function mime(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[extension] || "application/octet-stream";
}

async function stateWithSource(runId = runtime.ensureRun()) {
  const source = await liveSource.project();
  const projected = runtime.state(runId);
  const referenced = new Set(projected.events.flatMap((event) => event.evidence_refs));
  const liveEvidence = source.evidence.filter((item) => referenced.has(item.id));
  return { ...projected, evidence: [...projected.evidence, ...liveEvidence], source };
}

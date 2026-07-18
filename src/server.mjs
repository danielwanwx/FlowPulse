import "./load-env.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.mjs";
import { loadBundle } from "./bundle.mjs";
import { IncidentRuntime } from "./runtime.mjs";
import { runLiveInvestigation } from "./openai.mjs";
import { initializeObservability, shutdownObservability, withAgentControlTrace } from "./observability.mjs";
import { LiveSource } from "./live-source.mjs";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, versionedChangeEvidence } from "./evidence-source.mjs";
import { DevelopmentRuntime } from "./development-runtime.mjs";
import * as developmentAdapter from "./development-adapter.mjs";
import { AgentControlService } from "./agent-control-service.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const dbPath = process.env.FLOWPULSE_DB || join(root, ".flowpulse", "ledger.db");
const port = Number(process.env.PORT || 4310);
const ledger = new Ledger(dbPath);
const bundle = loadBundle();
const runtime = new IncidentRuntime({ ledger, bundle });
const liveSource = new LiveSource({ directory: process.env.FLOWPULSE_OTLP_DIR || join(root, "outputs", "live", "otel") });
const development = new DevelopmentRuntime({ runtime, source: liveSource, adapter: developmentAdapter });
const capturedEvidence = new CapturedBundleEvidenceSource(bundle);
const snapshots = new Map();
runtime.ensureRun();
const langfuseEnabled = await initializeObservability().catch((error) => {
  console.warn(`Langfuse disabled: ${error.message}`);
  return false;
});
const agentControl = new AgentControlService({ runtime, langfuseEnabled });

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "OPTIONS") return send(response, 204, "");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(response, 200, await stateWithSource());
    }
    if (url.pathname === "/api/source" && request.method === "GET") {
      return json(response, 200, await sourceProjection(runtime.ensureRun()));
    }
    if (url.pathname === "/api/evidence" && request.method === "GET") {
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || runtime.ensureRun());
      return json(response, 200, { source: source.metadata(), ...source.list({
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        entity: url.searchParams.get("entity") || undefined
      }) });
    }
    if (url.pathname.startsWith("/api/evidence/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/evidence/".length));
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || runtime.ensureRun());
      return json(response, 200, { source: source.metadata(), evidence: source.detail(id) });
    }
    if (url.pathname === "/api/agent-control" && request.method === "GET") {
      return json(response, 200, agentControl.project(runtime.ensureRun()));
    }
    if (url.pathname === "/api/agent-control/events" && request.method === "GET") {
      return streamAgentEvents(request, response, url);
    }
    if (url.pathname === "/api/agent-control/message" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: "manager-message",
        input: { message: body.message, collaborator_id: body.collaborator_id }
      }, async (trace) => {
        const generation = trace.generation("flowpulse.manager-response", {
          input: { message: body.message, collaborator_id: body.collaborator_id },
          model: process.env.OPENAI_MODEL || "deterministic-ledger-projection",
          metadata: { run_id: runId, authority: "flowpulse-ledger" }
        });
        const result = agentControl.message(runId, body.message, body.collaborator_id);
        generation.update({ output: { intent: result.intent, collaborator_id: result.collaborator_id, message: result.message, citations: result.projection.report.citations } });
        generation.end();
        return result;
      }));
    }
    if (url.pathname === "/api/agent-control/action" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: String(body.action || ""),
        input: { action: body.action, parameters: body.input || {} }
      }, async (trace) => {
        const tool = trace.tool("flowpulse.agent-action", { input: { action: body.action, parameters: body.input || {} }, metadata: { run_id: runId } });
        const projection = agentControl.act(runId, body.action, body.input || {});
        tool.update({ output: { current_agent_id: projection.current_agent_id, last_event_id: projection.last_event_id } });
        tool.end();
        return projection;
      }));
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
      const snapshot = await freezeLiveEvidence(runId);
      if (process.env.OPENAI_API_KEY) await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot, repairContract: development.repairContract(runId) });
      else await development.investigate(runId, snapshot);
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
      agentControl.advance(runId, "timeline-advance");
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
        const snapshot = await freezeLiveEvidence(runId);
        const result = await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot });
        return json(response, 200, { result, state: await stateWithSource(runId) });
      } catch (error) {
        runtime.append(runId, "live.run.failed", "runtime", {
          classification: error instanceof InsufficientEvidenceError ? "insufficient_evidence" : error.message.includes("approved boundary") ? "agent_false_positive" : "tool_data_failure",
          reason: error.message
        });
        return json(response, 422, { error: error.message, state: await stateWithSource(runId) });
      }
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      const source = await liveSource.project();
      return json(response, 200, { ok: true, ledger: "sqlite-append-only", agent_control: "ledger-governed-agent-team-harness", langfuse: langfuseEnabled, source: source.status });
    }
    if (request.method !== "GET") return json(response, 404, { error: "Not found" });
    return serveStatic(url.pathname, response);
  } catch (error) {
    return json(response, error.message.includes("Unknown evidence id") ? 404 : error.message.includes("required") ? 409 : 500, { error: error.message });
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
  const projected = runtime.state(runId);
  const referenced = new Set(projected.events.flatMap((event) => event.evidence_refs));
  const source = await selectedEvidenceSource(runId);
  return {
    ...projected,
    evidence: source.summariesById(referenced),
    source: await sourceProjection(runId, source),
    agent_control: agentControl.project(runId)
  };
}

async function selectedEvidenceSource(runId = runtime.ensureRun()) {
  if (snapshots.has(runId)) return snapshots.get(runId);
  const mode = runtime.state(runId).mode;
  if (mode === "replay") return capturedEvidence;
  return new LiveOtlpEvidenceSource(await liveSource.project());
}

async function sourceProjection(runId = runtime.ensureRun(), source = null) {
  const selected = source || await selectedEvidenceSource(runId);
  const project = await liveSource.project();
  const metadata = selected.metadata();
  return {
    ...metadata,
    kind: "otlp-jsonl",
    live_status: project.status,
    last_observed_at: project.last_observed_at,
    freshness_ms: project.freshness_ms,
    counts: project.counts,
    topology: project.topology,
    errors: project.errors,
    evidence: selected.list({ limit: 50 }).items,
    raw_records_excluded: true
  };
}

async function freezeLiveEvidence(runId) {
  const live = new LiveOtlpEvidenceSource(await liveSource.project());
  const runEvents = runtime.ledger.list(runId);
  const applied = runEvents.find((event) => event.type === "change.applied");
  const after = applied?.payload.applied_at;
  const supplementalRecords = applied ? [versionedChangeEvidence({
    manifest: await developmentAdapter.developmentChangeManifest(),
    applied: applied.payload,
    ledgerEvent: applied
  })] : [];
  const snapshot = live.freeze({ incidentId: bundle.incident.id, runId, after, supplementalRecords });
  snapshots.set(runId, snapshot);
  const metadata = snapshot.metadata();
  runtime.append(runId, "evidence.snapshot.created", "runtime", {
    snapshot_id: snapshot.id,
    mode: metadata.mode,
    source_hash: metadata.source_hash,
    content_hash: metadata.content_hash,
    record_count: metadata.record_count,
    source_record_count: metadata.source_record_count,
    bytes: metadata.bytes,
    caps: metadata.caps,
    truncated: metadata.truncated,
    frozen_at: metadata.frozen_at
  }, snapshot.snapshot.evidence_ids);
  return snapshot;
}

function streamAgentEvents(request, response, url) {
  const runId = url.searchParams.get("run_id") || runtime.ensureRun();
  let lastSequence = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const sendProjection = () => {
    const projection = agentControl.project(runId);
    if (projection.last_sequence <= lastSequence) return;
    lastSequence = projection.last_sequence;
    response.write(`id: ${lastSequence}\nevent: agent-control\ndata: ${JSON.stringify(projection)}\n\n`);
  };
  sendProjection();
  const interval = setInterval(() => {
    if (response.destroyed) return;
    sendProjection();
    response.write(": heartbeat\n\n");
  }, 1_000);
  request.on("close", () => clearInterval(interval));
}

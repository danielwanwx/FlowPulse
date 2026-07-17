import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveSource } from "../src/live-source.mjs";

test("reports a disconnected source without inventing telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-empty-"));
  const source = await new LiveSource({ directory }).project();
  assert.equal(source.status, "disconnected");
  assert.equal(source.authoritative, false);
  assert.deepEqual(source.counts, { traces: 0, metrics: 0, logs: 0 });
  assert.deepEqual(source.topology, { nodes: [], edges: [] });
});

test("projects deterministic service topology and hashed provenance from OTLP JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-"));
  const trace = {
    resourceSpans: [
      resourceSpans("frontend", [{ traceId: "t1", spanId: "a", name: "POST /checkout" }]),
      resourceSpans("checkout", [{ traceId: "t1", spanId: "b", parentSpanId: "a", name: "PlaceOrder" }]),
      resourceSpans("payment", [{ traceId: "t1", spanId: "c", parentSpanId: "b", name: "Charge" }])
    ]
  };
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify(trace)}\n`);
  await writeFile(join(directory, "metrics.jsonl"), `${JSON.stringify({ resourceMetrics: [] })}\n`);
  await writeFile(join(directory, "logs.jsonl"), `${JSON.stringify({ resourceLogs: [] })}\n`);

  const source = await new LiveSource({ directory, now: () => Date.now() }).project();
  assert.equal(source.status, "live");
  assert.equal(source.authoritative, true);
  assert.deepEqual(source.topology.nodes.map(({ id, kind }) => ({ id, kind })), [
    { id: "checkout", kind: "service" },
    { id: "frontend", kind: "client" },
    { id: "payment", kind: "api" }
  ]);
  assert.deepEqual(source.topology.edges.map(({ id }) => id), ["checkout->payment", "frontend->checkout"]);
  assert.match(source.evidence[0].id, /^live-tra-[a-f0-9]{12}$/);
  assert.match(source.evidence[0].provenance.sha256, /^[a-f0-9]{64}$/);
  assert.equal(source.evidence[0].provenance.file, "traces.jsonl");
  assert.equal(source.evidence[0].provenance.byte_start, 0);
  assert.equal(source.evidence[0].provenance.byte_end > source.evidence[0].provenance.byte_start, true);
});

test("labels old captures as stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-stale-"));
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [] })}\n`);
  const source = await new LiveSource({ directory, now: () => Date.now() + 60_000, freshnessMs: 30_000 }).project();
  assert.equal(source.status, "stale");
});

function resourceSpans(service, spans) {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
    scopeSpans: [{ spans }]
  };
}

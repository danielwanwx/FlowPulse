import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveSource } from "../src/live-source.mjs";
import { InsufficientEvidenceError, LiveOtlpEvidenceSource, versionedChangeEvidence } from "../src/evidence-source.mjs";

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

test("derives bounded trace, log, and metric facts without exposing payload as a fact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-facts-"));
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [resourceSpans("checkout", [{ name: "POST /checkout", status: { code: 2, message: "connection refused" }, attributes: [{ key: "server.address", value: { stringValue: "payment" } }, { key: "server.port", value: { intValue: "8080" } }] }])] })}\n`);
  await writeFile(join(directory, "logs.jsonl"), `${JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] }, scopeLogs: [{ logRecords: [{ severityText: "ERROR", body: { stringValue: "payment call refused" }, traceId: "abc", spanId: "def" }] }] }] })}\n`);
  await writeFile(join(directory, "metrics.jsonl"), `${JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] }, scopeMetrics: [{ metrics: [{ name: "checkout.errors", unit: "1", sum: { dataPoints: [{ asInt: "42" }] } }] }] }] })}\n`);
  const source = await new LiveSource({ directory }).project();
  const trace = source.evidence.find((item) => item.kind === "trace");
  const log = source.evidence.find((item) => item.kind === "log");
  const metric = source.evidence.find((item) => item.kind === "metric");
  assert.deepEqual(trace.value.trace, { service: "checkout", operation: "POST /checkout", peer_target: "payment:8080", status: "error", error: "connection refused", observed_at: null });
  assert.deepEqual(log.value.log, { service: "checkout", severity: "ERROR", message: "payment call refused", trace_ref: "ba7816bf8f01", span_ref: "cb8379ac2098", observed_at: null });
  assert.deepEqual(metric.value.metric, { service: "checkout", name: "checkout.errors", value: 42, unit: "1", aggregation: "sum", observed_at: null });
  assert.equal(Object.hasOwn(trace.value, "payload"), false);
});

test("selects later failing spans and error logs over earlier healthy batch records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-representative-"));
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [resourceSpans("checkout", [
    { name: "GET /health", status: { code: 1 } },
    { name: "POST /checkout", status: { code: 2, message: "ECONNREFUSED" }, attributes: [{ key: "server.address", value: { stringValue: "payment" } }, { key: "server.port", value: { intValue: "8080" } }] }
  ])] })}\n`);
  await writeFile(join(directory, "logs.jsonl"), `${JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] }, scopeLogs: [{ logRecords: [
    { severityText: "INFO", body: { stringValue: "request started" } },
    { severityText: "ERROR", body: { stringValue: "payment ECONNREFUSED" } }
  ] }] }] })}\n`);
  const source = await new LiveSource({ directory }).project();
  assert.equal(source.evidence.find((item) => item.kind === "trace").value.trace.operation, "POST /checkout");
  assert.equal(source.evidence.find((item) => item.kind === "trace").value.trace.status, "error");
  assert.equal(source.evidence.find((item) => item.kind === "log").value.log.severity, "ERROR");
  assert.equal(source.evidence.find((item) => item.kind === "log").value.log.message, "payment ECONNREFUSED");
});

test("projects a checkout flag evaluation from the direct parent of its payment failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-flag-causal-"));
  const evaluatedAt = "2026-07-18T10:00:01.000Z";
  const failedAt = "2026-07-18T10:00:01.009Z";
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [resourceSpans("checkout", [
    {
      traceId: "raw-trace-id",
      spanId: "place-order",
      parentSpanId: "frontend",
      name: "oteldemo.CheckoutService/PlaceOrder",
      events: [featureFlagEvent("on", evaluatedAt)]
    },
    {
      traceId: "raw-trace-id",
      spanId: "payment-call",
      parentSpanId: "place-order",
      name: "oteldemo.PaymentService/Charge",
      endTimeUnixNano: nano(failedAt),
      status: { code: 2, message: "name resolver error: produced zero addresses" }
    }
  ])] })}\n`);
  const source = await new LiveSource({ directory }).project();
  const trace = source.evidence.find((item) => item.kind === "trace").value.trace;
  assert.equal(trace.observed_at, failedAt);
  assert.match(trace.trace_ref, /^[a-f0-9]{12}$/);
  assert.match(trace.span_ref, /^[a-f0-9]{12}$/);
  assert.equal(trace.parent_ref, trace.feature_flag.span_ref);
  assert.deepEqual(trace.feature_flag, {
    service: "checkout",
    key: "paymentUnreachable",
    variant: "on",
    value: true,
    provider: "flagd",
    reason: "cached",
    evaluated_at: evaluatedAt,
    trace_ref: trace.trace_ref,
    span_ref: trace.parent_ref,
    same_trace: true,
    direct_parent: true
  });
  assert.equal(JSON.stringify(trace).includes("raw-trace-id"), false);
  assert.equal(JSON.stringify(trace).includes("context.id"), false);
});

test("projects a recent flag-off checkout-to-payment success for the controlled baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-flag-baseline-"));
  const evaluatedAt = "2026-07-18T09:59:58.999Z";
  const succeededAt = "2026-07-18T09:59:59.000Z";
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [resourceSpans("checkout", [
    {
      traceId: "baseline-trace-id",
      spanId: "place-order",
      parentSpanId: "frontend",
      name: "oteldemo.CheckoutService/PlaceOrder",
      events: [
        featureFlagEvent("off", evaluatedAt),
        featureFlagEvent("off", "2026-07-18T10:00:00.000Z", "kafkaQueueProblems")
      ]
    },
    {
      traceId: "baseline-trace-id",
      spanId: "payment-call",
      parentSpanId: "place-order",
      name: "oteldemo.PaymentService/Charge",
      endTimeUnixNano: nano(succeededAt),
      status: { code: 1 }
    }
  ])] })}\n`);
  const project = await new LiveSource({ directory }).project();
  const trace = project.evidence.find((item) => item.kind === "trace").value.trace;
  assert.equal(trace.status, "ok");
  assert.equal(trace.observed_at, succeededAt);
  assert.deepEqual(trace.feature_flag, {
    service: "checkout",
    key: "paymentUnreachable",
    variant: "off",
    value: false,
    provider: "flagd",
    reason: "cached",
    evaluated_at: evaluatedAt,
    trace_ref: trace.trace_ref,
    span_ref: trace.parent_ref,
    same_trace: true,
    direct_parent: true
  });
});

test("does not attach a flagd-only evaluation from another trace to a checkout failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-flagd-only-"));
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [
    resourceSpans("flagd", [{ traceId: "flag-trace", spanId: "flag", name: "resolveBoolean", events: [featureFlagEvent("on", "2026-07-18T10:00:01.000Z")] }]),
    resourceSpans("checkout", [{ traceId: "checkout-trace", spanId: "payment", parentSpanId: "place-order", name: "oteldemo.PaymentService/Charge", status: { code: 2, message: "ECONNREFUSED" } }])
  ] })}\n`);
  const source = await new LiveSource({ directory }).project();
  const trace = source.evidence.find((item) => item.kind === "trace").value.trace;
  assert.equal(Object.hasOwn(trace, "feature_flag"), false);
});

test("uses the selected failing span timestamp rather than a later healthy span in the same batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-live-selected-time-"));
  const before = "2026-07-18T09:59:59.000Z";
  const after = "2026-07-18T10:00:00.000Z";
  await writeFile(join(directory, "traces.jsonl"), `${JSON.stringify({ resourceSpans: [resourceSpans("checkout", [
    {
      name: "POST /checkout payment",
      endTimeUnixNano: nano(before),
      status: { code: 2, message: "ECONNREFUSED" },
      attributes: [{ key: "server.address", value: { stringValue: "payment" } }, { key: "server.port", value: { intValue: "8080" } }]
    },
    { name: "GET /health", endTimeUnixNano: nano("2026-07-18T10:01:00.000Z"), status: { code: 1 } }
  ])] })}\n`);
  const project = await new LiveSource({ directory }).project();
  const trace = project.evidence.find((item) => item.kind === "trace");
  assert.equal(trace.at, before);
  assert.equal(trace.value.trace.observed_at, before);

  const change = versionedChangeEvidence({
    manifest: manifest(),
    applied: { before: "off", after: "on", applied_at: after },
    ledgerEvent: { id: "evt-change", recorded_at: after }
  });
  assert.throws(() => new LiveOtlpEvidenceSource(project).freeze({ supplementalRecords: [change], executable: true, after }), InsufficientEvidenceError);
});

function resourceSpans(service, spans) {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
    scopeSpans: [{ spans }]
  };
}

function nano(iso) { return String(BigInt(Date.parse(iso)) * 1_000_000n); }

function featureFlagEvent(variant, at, key = "paymentUnreachable") {
  return {
    name: "feature_flag.evaluation",
    timeUnixNano: nano(at),
    attributes: [
      { key: "feature_flag.key", value: { stringValue: key } },
      { key: "feature_flag.result.variant", value: { stringValue: variant } },
      { key: "feature_flag.result.value", value: { boolValue: variant === "on" } },
      { key: "feature_flag.provider.name", value: { stringValue: "flagd" } },
      { key: "feature_flag.result.reason", value: { stringValue: "cached" } },
      { key: "feature_flag.context.id", value: { stringValue: "raw-context-id" } }
    ]
  };
}

function manifest() {
  return {
    id: "change-payment-unreachable-v1",
    target: "checkout",
    flag: "paymentUnreachable",
    known_good: "off",
    after: "on",
    repair_id: "repair-payment-reachable-v1",
    repair_command_id: "astronomy.restore-payment-and-recreate-checkout"
  };
}

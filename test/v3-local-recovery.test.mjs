import assert from "node:assert/strict";
import test from "node:test";
import {
  astronomyActiveIncidentSummaries,
  captureTraceWatermark,
  checkoutPaymentFailureEvidence,
  coordinateV3LocalStartup,
  evaluateV3CaseReadiness,
  hasExactProjectedFailureEvidence,
  reconcileAstronomyLaunch,
  waitForPostWatermarkCheckoutPaymentFailure,
} from "../scripts/v3-local-recovery.mjs";

const manifest = {
  id: "change-payment-unreachable-v1",
  target: "checkout",
  flag: "paymentUnreachable",
  before: "off",
  after: "on",
  known_good: "off",
  repair_command_id: "astronomy.restore-payment-and-recreate-checkout",
};

function flag(variant) {
  return { flag: "paymentUnreachable", variant, observed_at: "2026-07-31T12:00:00.000Z" };
}

function watermark(overrides = {}) {
  return {
    schema_version: "flowpulse.v3-local-trace-watermark.v1",
    trace_path: "/capture/traces.jsonl",
    file_identity: "1:2",
    byte_offset: 100,
    line_boundary: true,
    recorded_at: "2026-07-31T12:00:00.000Z",
    recorded_at_unix_nano: "1785499200000000000",
    ...overrides,
  };
}

function failureBatch({
  traceId = "trace-new",
  observedNano = "1785499201000000000",
  statusCode = 2,
  variant = "on",
  target = "oteldemo.PaymentService/Charge",
} = {}) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
      scopeSpans: [{ spans: [
        {
          traceId,
          spanId: "checkout-server",
          name: "oteldemo.CheckoutService/PlaceOrder",
          kind: 2,
          startTimeUnixNano: observedNano,
          endTimeUnixNano: observedNano,
          events: [{
            name: "feature_flag.evaluation",
            attributes: [
              { key: "feature_flag.key", value: { stringValue: "paymentUnreachable" } },
              { key: "feature_flag.result.variant", value: { stringValue: variant } },
            ],
          }],
          status: { code: statusCode },
        },
        {
          traceId,
          spanId: "payment-client",
          parentSpanId: "checkout-server",
          name: target,
          kind: 3,
          startTimeUnixNano: observedNano,
          endTimeUnixNano: observedNano,
          attributes: [{
            key: "rpc.response.status_code",
            value: { stringValue: statusCode === 2 ? "UNAVAILABLE" : "OK" },
          }],
          status: statusCode === 2 ? { code: 2 } : {},
        },
      ] }],
    }],
  };
}

function preExecutionProjection(stage = "INVESTIGATE") {
  return {
    case_id: "case-live",
    current_attempt: {
      attempt_id: "attempt-1",
      current_stage: stage,
      action_executed: false,
      action_receipt_id: null,
    },
    actions: [],
  };
}

function postExecutionProjection() {
  return {
    case_id: "case-live",
    current_attempt: {
      attempt_id: "attempt-1",
      current_stage: "VERIFY",
      action_executed: true,
      action_receipt_id: "receipt-1",
    },
    actions: [{
      action_id: "action-1",
      execution_state: "SUCCEEDED",
      receipt: {
        receipt_id: "receipt-1",
        command_id: "astronomy.restore-payment-and-recreate-checkout",
        status: "SUCCEEDED",
        started_at: "2026-07-31T12:00:00.000Z",
        completed_at: "2026-07-31T12:00:10.000Z",
      },
      rollback_receipt: null,
    }],
  };
}

const matchingRuntime = {
  container_id: "checkout-new",
  started_at: "2026-07-31T12:00:05.000Z",
  running: true,
};

function readinessFixture() {
  const projection = {
    freshness: { state: "CURRENT" },
    graph: {
      edges: [{
        edge_id: "checkout->payment",
        source_component_id: "checkout",
        target_component_id: "payment",
        status: "critical",
      }],
    },
    connectors: [
      {
        connector_id: "connector-otel-primary",
        state: "CONNECTED",
        observed_at: "2026-07-31T12:00:02.000Z",
        fresh_until: "2026-07-31T12:01:00.000Z",
      },
      {
        connector_id: "connector-otel-metrics",
        state: "CONNECTED",
        observed_at: "2026-07-31T12:00:03.000Z",
        fresh_until: "2026-07-31T12:01:00.000Z",
      },
    ],
  };
  const sourceProjection = {
    realtime_signals: [{
      signal_id: "signal-failure",
      provider: "OTEL",
      freshness: "CURRENT",
      connector_state: "CONNECTED",
      status: "CRITICAL",
      component_ids: ["checkout", "payment"],
      edge_ids: ["checkout->payment"],
      evidence_refs: ["evidence-failure"],
      observed_at: "2026-07-31T12:00:02.000Z",
    }],
  };
  const series = {
    series: [
      "checkout.payment.error_rate",
      "checkout.payment.mean_latency",
      "checkout.payment.request_count",
    ].map((metricKey, index) => ({
      metric_key: metricKey,
      source_connector_id: "connector-otel-metrics",
      freshness: "CURRENT",
      points: [{
        sequence: 1,
        timestamp: `2026-07-31T12:00:0${index + 3}.000Z`,
        value: index + 1,
        freshness: "CURRENT",
        evidence_refs: [`evidence-metric-${index}`],
      }],
    })),
  };
  const reconciliation = {
    mode: "CREATE_AFTER_INJECTION",
    failure_evidence: { observed_at: "2026-07-31T12:00:01.000Z" },
    recovery_receipt: null,
  };
  return { projection, sourceProjection, series, reconciliation };
}

test("failure evidence requires a new checkout client error to Payment with the enabled fault in its lineage", () => {
  const current = checkoutPaymentFailureEvidence(
    failureBatch(),
    watermark().recorded_at_unix_nano,
  );
  assert.equal(current.trace_id, "trace-new");
  assert.equal(current.span_name, "oteldemo.PaymentService/Charge");

  assert.equal(checkoutPaymentFailureEvidence(failureBatch({
    observedNano: "1785499199000000000",
  }), watermark().recorded_at_unix_nano), null, "stale appended telemetry is rejected");
  assert.equal(checkoutPaymentFailureEvidence(failureBatch({
    statusCode: 0,
  }), watermark().recorded_at_unix_nano), null, "healthy Payment spans are rejected");
  assert.equal(checkoutPaymentFailureEvidence(failureBatch({
    variant: "off",
  }), watermark().recorded_at_unix_nano), null, "healthy flag lineage is rejected");
  assert.equal(checkoutPaymentFailureEvidence(failureBatch({
    target: "oteldemo.CurrencyService/Convert",
  }), watermark().recorded_at_unix_nano), null, "unrelated dependency errors are rejected");
});

test("trace scanner starts at the launch byte watermark and ignores a stale record appended later", async () => {
  const stale = Buffer.from(`${JSON.stringify(failureBatch({
    traceId: "trace-stale",
    observedNano: "1785499199000000000",
  }))}\n`);
  const fresh = Buffer.from(`${JSON.stringify(failureBatch({ traceId: "trace-fresh" }))}\n`);
  const appended = Buffer.concat([stale, fresh]);
  let clock = 0;
  const evidence = await waitForPostWatermarkCheckoutPaymentFailure(
    "/capture/traces.jsonl",
    watermark(),
    {
      statFile: async () => ({ size: 100 + appended.length, dev: 1, ino: 2 }),
      readRange: async (_path, start, length) => appended.subarray(start - 100, start - 100 + length),
      nowMs: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      timeoutMs: 100,
      pollMs: 10,
    },
  );
  assert.equal(evidence.trace_id, "trace-fresh");
});

test("trace watermark records inode, byte boundary, and wall-clock cutoff", async () => {
  const captured = await captureTraceWatermark("/capture/traces.jsonl", {
    statFile: async () => ({ size: 42, dev: 7, ino: 9 }),
    readRange: async () => Buffer.from("\n"),
    nowMs: () => Date.parse("2026-07-31T12:00:00.000Z"),
  });
  assert.equal(captured.file_identity, "7:9");
  assert.equal(captured.byte_offset, 42);
  assert.equal(captured.line_boundary, true);
  assert.equal(captured.recorded_at_unix_nano, "1785499200000000000");
});

test("new incident launch applies the allowlisted case iff the flag is off and waits for post-watermark failure", async () => {
  const calls = [];
  const flags = [flag("off"), flag("on")];
  const result = await reconcileAstronomyLaunch({
    projection: null,
    manifest,
    readFlag: async () => { calls.push("read-flag"); return flags.shift(); },
    captureWatermark: async () => { calls.push("watermark"); return watermark(); },
    applyFault: async () => { calls.push("apply-fault"); },
    readRuntime: async () => { throw new Error("must not read runtime"); },
    waitForFailure: async () => { calls.push("wait-failure"); return { trace_id: "trace-new" }; },
  });
  assert.equal(result.mode, "CREATE_AFTER_INJECTION");
  assert.equal(result.fault_applied, true);
  assert.deepEqual(calls, ["read-flag", "watermark", "apply-fault", "read-flag", "wait-failure"]);
});

test("new incident launch reuses an already-on fault without issuing a second mutation", async () => {
  let applied = false;
  const result = await reconcileAstronomyLaunch({
    projection: null,
    manifest,
    readFlag: async () => flag("on"),
    captureWatermark: async () => watermark(),
    applyFault: async () => { applied = true; },
    readRuntime: async () => matchingRuntime,
    waitForFailure: async () => ({ trace_id: "trace-new" }),
  });
  assert.equal(result.mode, "CREATE_REUSING_ACTIVE_FAULT");
  assert.equal(applied, false);
});

test("pre-execution resume requires the fault to remain on and never repairs projection drift", async () => {
  let applied = false;
  let waited = false;
  await assert.rejects(() => reconcileAstronomyLaunch({
    projection: preExecutionProjection(),
    manifest,
    readFlag: async () => flag("off"),
    captureWatermark: async () => watermark(),
    applyFault: async () => { applied = true; },
    readRuntime: async () => matchingRuntime,
    waitForFailure: async () => { waited = true; },
  }), /requires paymentUnreachable to remain on/);
  assert.equal(applied, false);
  assert.equal(waited, false);
});

test("pre-execution resume waits for a new failure sample but does not reapply the fault", async () => {
  let applied = false;
  const result = await reconcileAstronomyLaunch({
    projection: preExecutionProjection(),
    manifest,
    readFlag: async () => flag("on"),
    captureWatermark: async () => watermark(),
    applyFault: async () => { applied = true; },
    readRuntime: async () => matchingRuntime,
    waitForFailure: async () => ({ trace_id: "trace-resume" }),
  });
  assert.equal(result.mode, "RESUME_PRE_EXECUTION");
  assert.equal(result.failure_evidence.trace_id, "trace-resume");
  assert.equal(applied, false);
});

test("post-execution Verify resumes only when the flag is off and Checkout matches the immutable receipt", async () => {
  let applied = false;
  let waited = false;
  const result = await reconcileAstronomyLaunch({
    projection: postExecutionProjection(),
    manifest,
    readFlag: async () => flag("off"),
    captureWatermark: async () => watermark(),
    applyFault: async () => { applied = true; },
    readRuntime: async () => matchingRuntime,
    waitForFailure: async () => { waited = true; },
  });
  assert.equal(result.mode, "RESUME_POST_EXECUTION");
  assert.equal(result.recovery_receipt.id, "receipt-1");
  assert.equal(applied, false);
  assert.equal(waited, false);
});

test("post-execution restart fails closed on flag or Checkout runtime drift", async () => {
  const invoke = ({ observedFlag = flag("off"), runtime = matchingRuntime } = {}) => reconcileAstronomyLaunch({
    projection: postExecutionProjection(),
    manifest,
    readFlag: async () => observedFlag,
    captureWatermark: async () => watermark(),
    applyFault: async () => { throw new Error("must not mutate"); },
    readRuntime: async () => runtime,
    waitForFailure: async () => { throw new Error("must not wait for failure"); },
  });
  await assert.rejects(() => invoke({ observedFlag: flag("on") }), /flag drifted/);
  await assert.rejects(() => invoke({
    runtime: { ...matchingRuntime, started_at: "2026-07-31T12:01:00.000Z" },
  }), /does not match/);
});

test("active Astronomy selection excludes resolved cases and does not confuse unrelated incidents", () => {
  const incidents = astronomyActiveIncidentSummaries({ incidents: [
    {
      case_id: "resolved",
      incident_id: "local-astronomy-old",
      title: "Checkout cannot reach Payment",
      lifecycle_state: "RESOLVED",
      impacted_components: ["checkout", "payment"],
    },
    {
      case_id: "unrelated",
      incident_id: "database-lag",
      title: "Database lag",
      lifecycle_state: "ACTIVE",
      impacted_components: ["database"],
    },
    {
      case_id: "active",
      incident_id: "local-astronomy-new",
      title: "Checkout cannot reach Payment",
      lifecycle_state: "ACTIVE",
      impacted_components: ["checkout", "payment"],
    },
  ] });
  assert.deepEqual(incidents.map((item) => item.case_id), ["active"]);
});

test("case readiness requires a current projected edge and three real metric categories", () => {
  const fixture = readinessFixture();
  assert.equal(evaluateV3CaseReadiness(fixture).ready, true);

  const missingEdge = structuredClone(fixture);
  missingEdge.projection.graph.edges = [];
  assert.equal(evaluateV3CaseReadiness(missingEdge).reason, "checkout_payment_edge_missing");

  const incompleteSeries = structuredClone(fixture);
  incompleteSeries.series.series.pop();
  assert.equal(evaluateV3CaseReadiness(incompleteSeries).reason, "metric_categories_incomplete");
});

test("canonical evidence must carry the exact post-watermark trace and span anchor", () => {
  const failure = { trace_id: "trace-fresh", span_id: "payment-client" };
  const envelope = {
    source_anchor: "trace:trace-fresh:span:payment-client",
    source_kind: "TRACE",
    freshness: "CURRENT",
    proof_scope: "CURRENT_OBSERVATION",
  };
  assert.equal(hasExactProjectedFailureEvidence([envelope], failure), true);
  assert.equal(hasExactProjectedFailureEvidence([
    { ...envelope, source_anchor: "trace:trace-other:span:payment-client" },
  ], failure), false);
  assert.equal(hasExactProjectedFailureEvidence([
    { ...envelope, freshness: "STALE" },
  ], failure), false);
});

test("launcher brings up the Node bridge before the worker and announces UI only after case readiness", async () => {
  const calls = [];
  const node = { id: "node" };
  await coordinateV3LocalStartup({
    ensureAstronomy: async () => { calls.push("astronomy"); },
    startNodeBridge: async () => { calls.push("node-bridge"); return node; },
    startControlPlane: async () => { calls.push("control-plane-worker"); },
    reconcileCase: async () => { calls.push("reconcile"); return "case-live"; },
    waitForCase: async () => { calls.push("case-ready"); },
    announceReady: async () => { calls.push("ui-ready"); },
    waitForNode: async (value) => { assert.equal(value, node); calls.push("wait-node"); },
    stopNode: async () => { calls.push("stop-node"); },
  });
  assert.deepEqual(calls, [
    "astronomy",
    "node-bridge",
    "control-plane-worker",
    "reconcile",
    "case-ready",
    "ui-ready",
    "wait-node",
  ]);
});

test("launcher stops the early bridge if backend reconciliation fails", async () => {
  const node = { id: "node" };
  let stopped = null;
  await assert.rejects(() => coordinateV3LocalStartup({
    ensureAstronomy: async () => {},
    startNodeBridge: async () => node,
    startControlPlane: async () => {},
    reconcileCase: async () => { throw new Error("projection drift"); },
    waitForCase: async () => {},
    announceReady: async () => {},
    waitForNode: async () => {},
    stopNode: async (value) => { stopped = value; },
  }), /projection drift/);
  assert.equal(stopped, node);
});

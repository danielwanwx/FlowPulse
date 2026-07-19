import { createHash } from "node:crypto";

let sdk;
let tracing;

export async function initializeObservability() {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return false;
  const [{ NodeSDK }, { LangfuseSpanProcessor }, tracingModule] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@langfuse/otel"),
    import("@langfuse/tracing")
  ]);
  sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  tracing = tracingModule;
  return true;
}

export async function shutdownObservability() {
  await sdk?.shutdown();
}

export async function withIncidentTrace({ runId, incidentId, input }, work) {
  if (!tracing) return work(noopContext());
  return tracing.startActiveObservation("flowpulse.incident-investigation", async (span) => {
    span.update({
      input,
      metadata: { run_id: runId, incident_id: incidentId, authority: "flowpulse-ledger" }
    });
    const context = {
      traceRef: safeRef(tracing.getActiveTraceId()),
      generation: (name, details) => startObservation(name, details, "generation"),
      tool: (name, details) => startObservation(name, details, "tool"),
      evaluator: (name, details) => startObservation(name, details, "evaluator")
    };
    try {
      const output = await work(context);
      span.update({ output: { status: "completed" } });
      return output;
    } catch (error) {
      span.update({ output: safeFailureOutput(error) });
      throw error;
    }
  });
}

export async function withAgentControlTrace({ runId, incidentId, action, input }, work) {
  if (!tracing) return work(noopContext());
  return tracing.propagateAttributes({
    sessionId: incidentId,
    metadata: {
      run_id: runId,
      incident_id: incidentId,
      authority: "flowpulse-ledger",
      control_action: action
    },
    tags: ["flowpulse", "agent-control", action]
  }, () => tracing.startActiveObservation("flowpulse.agent-control", async (span) => {
    span.update({ input, metadata: { run_id: runId, incident_id: incidentId, action } });
    const context = {
      traceId: tracing.getActiveTraceId(),
      agent: (name, details) => startObservation(name, details, "agent"),
      generation: (name, details) => startObservation(name, details, "generation"),
      tool: (name, details) => startObservation(name, details, "tool"),
      evaluator: (name, details) => startObservation(name, details, "evaluator")
    };
    try {
      const output = await work(context);
      span.update({ output: { status: "completed", last_event_id: output?.projection?.last_event_id || output?.last_event_id || null } });
      return output;
    } catch (error) {
      span.update({ output: safeFailureOutput(error) });
      throw error;
    }
  }, { asType: "agent" }));
}

function startObservation(name, details, asType) {
  if (!tracing) return noopObservation();
  return tracing.startObservation(name, details, { asType });
}

function noopContext() {
  return {
    traceRef: null,
    agent: () => noopObservation(),
    generation: () => noopObservation(),
    tool: () => noopObservation(),
    evaluator: () => noopObservation()
  };
}

function safeFailureOutput(error) {
  return {
    status: "failed",
    code: error?.code || "internal_error",
    classification: error?.classification || "internal_error"
  };
}

function safeRef(value) {
  return typeof value === "string" && value.length
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : null;
}

function noopObservation() {
  return { update() { return this; }, end() {} };
}

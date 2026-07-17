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
      traceId: tracing.getActiveTraceId(),
      generation: (name, details) => startObservation(name, details, "generation"),
      tool: (name, details) => startObservation(name, details, "tool"),
      evaluator: (name, details) => startObservation(name, details, "evaluator")
    };
    try {
      const output = await work(context);
      span.update({ output: { status: "completed" } });
      return output;
    } catch (error) {
      span.update({ output: { status: "failed", error: error.message } });
      throw error;
    } finally {
      span.end();
    }
  });
}

function startObservation(name, details, asType) {
  if (!tracing) return noopObservation();
  return tracing.startObservation(name, details, { asType });
}

function noopContext() {
  return {
    traceId: null,
    generation: () => noopObservation(),
    tool: () => noopObservation(),
    evaluator: () => noopObservation()
  };
}

function noopObservation() {
  return { update() { return this; }, end() {} };
}

import { withIncidentTrace } from "./observability.mjs";

const MODEL = () => process.env.OPENAI_MODEL || "gpt-5.6";
const API_URL = "https://api.openai.com/v1/responses";
const MAX_TOOL_ROUNDS = 6;

export async function runLiveInvestigation({ runtime, runId, evidenceSource, repairContract = null }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for live mode");
  if (!evidenceSource?.metadata || !evidenceSource?.query) throw new Error("A selected bounded evidence source is required for live mode");
  const sourceMetadata = evidenceSource.metadata();
  if (sourceMetadata.mode !== "live_gpt_5_6_frozen_otlp_snapshot") throw new Error("GPT-5.6 live mode requires a frozen live OTLP snapshot");
  if (repairContract && !evidenceSource.query({ kind: "change", entity: repairContract.target }).length) {
    throw new Error("Executable GPT investigation requires a frozen applied change record");
  }
  const { bundle } = runtime;
  runtime.append(runId, "live.run.started", "runtime", { model: MODEL(), authority: "flowpulse-ledger" });

  return withIncidentTrace({
    runId,
    incidentId: bundle.incident.id,
    input: { title: bundle.incident.title, symptoms: bundle.incident.summary }
  }, async (observability) => {
    let feedback = null;
    let finalResult;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (feedback) {
        runtime.append(runId, "plan.revised", "live-investigator", {
          reason: feedback.reason,
          missing_evidence: feedback.missing_evidence,
          attempt
        });
      }
      const diagnosis = await investigate({ runtime, runId, observability, feedback, evidenceSource, repairContract });
      validateDiagnosis(diagnosis, evidenceSource, repairContract);
      runtime.append(runId, "hypothesis.proposed", "live-investigator", {
        ...diagnosis,
        live: true,
        attempt
      }, diagnosis.evidence_refs);

      const evaluation = await evaluate({ diagnosis, evidenceSource, observability, attempt });
      runtime.append(runId, evaluation.accepted ? "evaluation.accepted" : "evaluation.rejected", "live-evaluator", {
        ...evaluation,
        hypothesis_id: diagnosis.id,
        live: true,
        attempt
      }, evaluation.counter_evidence_refs);
      finalResult = { diagnosis, evaluation, trace_id: observability.traceId, attempt };
      if (evaluation.accepted) break;
      feedback = evaluation;
    }

    runtime.append(runId, "live.run.completed", "runtime", finalResult, finalResult.diagnosis.evidence_refs);
    if (finalResult.evaluation.accepted && repairContract) {
      runtime.append(runId, "repair.proposed", "live-investigator", {
        ...repairContract,
        diagnosis_id: finalResult.diagnosis.id,
        bounded: true,
        expected_effect: finalResult.diagnosis.proposed_repair.reason
      }, finalResult.diagnosis.evidence_refs);
      runtime.append(runId, "approval.requested", "runtime", {
        ...repairContract,
        owner_team: "local-development",
        reason: "The frozen OTLP finding passed adversarial evaluation. This exact local checkout repair still requires owner approval."
      });
    } else if (finalResult.evaluation.accepted) {
      runtime.append(runId, "outcome.classified", "live-evaluator", {
        classification: "insufficient_evidence",
        explanation: "This is a model-only frozen-evidence investigation. No applied development change contract exists, so FlowPulse did not create an executable repair or approval request."
      }, finalResult.diagnosis.evidence_refs);
    } else {
      runtime.append(runId, "outcome.classified", "live-evaluator", {
        classification: "insufficient_evidence",
        explanation: "The live diagnosis did not pass the adversarial evaluator within the replan budget."
      }, finalResult.evaluation.counter_evidence_refs);
    }
    return finalResult;
  });
}

async function investigate({ runtime, runId, observability, feedback, evidenceSource, repairContract }) {
  const { bundle } = runtime;
  const tools = toolDefinitions(evidenceSource);
  const input = [{
    role: "user",
    content: [
      `Investigate this production incident: ${bundle.incident.summary}`,
      "Use the evidence tools. Distinguish initiating cause from downstream symptoms.",
      repairContract
        ? `Cite only evidence IDs returned by tools. Your repair must exactly be ${JSON.stringify(repairContract)}.`
        : "Cite only evidence IDs returned by tools. This model-only run has no executable repair contract; use no_execution.",
      "Query only the services needed to prove or disprove the current causal chain, then stop.",
      feedback ? `The evaluator rejected the prior attempt: ${JSON.stringify(feedback)}` : ""
    ].filter(Boolean).join("\n")
  }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: MODEL(),
      instructions: "You are the FlowPulse incident investigator. Build a causal chain from change to mechanism to propagation. Never treat correlation as proof.",
      input,
      tools,
      tool_choice: round === 0 ? "required" : "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "medium" },
      max_output_tokens: 1800,
      store: false,
      safety_identifier: "flowpulse-build-week",
      text: { format: diagnosisFormat(repairContract) }
    };
    const response = await callOpenAI(body, observability, `investigator.round-${round + 1}`);
    input.push(...response.output);
    const calls = response.output.filter((item) => item.type === "function_call");
    if (!calls.length) return parseStructuredText(response);

    for (const call of calls) {
      const args = JSON.parse(call.arguments);
      const observation = observability.tool(call.name, { input: args, metadata: { run_id: runId } });
      const result = executeTool(evidenceSource, call.name, args);
      observation.update({ output: result });
      observation.end();
      runtime.append(runId, "tool.called", "live-investigator", {
        tool: call.name,
        arguments: args,
        result_count: result.length,
        live: true,
        evidence_mode: evidenceSource.metadata().mode
      }, result.map((item) => item.id));
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  throw new Error("Live investigator exceeded the tool-round budget");
}

async function evaluate({ diagnosis, evidenceSource, observability, attempt }) {
  const cited = evidenceSource.summariesById(diagnosis.evidence_refs);
  const body = {
    model: MODEL(),
    instructions: "You are an adversarial incident evaluator. Reject causal claims unless evidence proves initiating change, failure mechanism, temporal ordering, and propagation. Downstream Kafka lag alone is not a root cause.",
    input: `Candidate diagnosis:\n${JSON.stringify(diagnosis)}\n\nCited evidence:\n${JSON.stringify(cited)}`,
    reasoning: { effort: "medium" },
    max_output_tokens: 1000,
    store: false,
    safety_identifier: "flowpulse-build-week",
    text: { format: evaluationFormat() }
  };
  const response = await callOpenAI(body, observability, `evaluator.attempt-${attempt}`, true);
  return parseStructuredText(response);
}

async function callOpenAI(body, observability, name, evaluator = false) {
  const started = performance.now();
  const observation = (evaluator ? observability.evaluator : observability.generation)(name, {
    model: body.model,
    input: body.input,
    metadata: { reasoning_effort: body.reasoning?.effort, store: body.store }
  });
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `OpenAI request failed (${response.status})`);
    observation.update({
      output: data.output,
      usageDetails: {
        input: data.usage?.input_tokens,
        output: data.usage?.output_tokens,
        total: data.usage?.total_tokens
      },
      metadata: { latency_ms: Math.round(performance.now() - started), response_id: data.id }
    });
    return data;
  } catch (error) {
    observation.update({ output: { error: error.message }, metadata: { latency_ms: Math.round(performance.now() - started) } });
    throw error;
  } finally {
    observation.end();
  }
}

export function executeTool(evidenceSource, name, args) {
  const kindByTool = {
    query_metrics: "metric",
    query_traces: "trace",
    query_logs: "log",
    query_deploys: "deploy",
    query_commits: "commit",
    query_changes: "change"
  };
  const kind = kindByTool[name];
  if (!kind) throw new Error(`Tool is not allowlisted: ${name}`);
  return evidenceSource.query({ kind, entity: args.entity }).filter((item) => !item.id.startsWith("ev-verify-"));
}

function toolDefinitions(evidenceSource) {
  const entities = evidenceSource.entities();
  return ["metrics", "traces", "logs", "changes", "deploys", "commits"].map((name) => ({
    type: "function",
    name: `query_${name}`,
    description: `Return captured ${name} evidence for one incident entity.`,
    strict: true,
    parameters: {
      type: "object",
      properties: { entity: { type: "string", enum: entities } },
      required: ["entity"],
      additionalProperties: false
    }
  }));
}

function diagnosisFormat(repairContract) {
  const repair = repairContract
    ? {
        properties: {
          repair_id: { type: "string", enum: [repairContract.repair_id] },
          action: { type: "string", enum: [repairContract.action] },
          target: { type: "string", enum: [repairContract.target] },
          command_id: { type: "string", enum: [repairContract.command_id] },
          reason: { type: "string" }
        },
        required: ["repair_id", "action", "target", "command_id", "reason"]
      }
    : {
        properties: {
          action: { type: "string", enum: ["no_execution"] },
          target: { type: "string", enum: ["checkout"] },
          reason: { type: "string" }
        },
        required: ["action", "target", "reason"]
      };
  return {
    type: "json_schema",
    name: "flowpulse_diagnosis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        claim: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        initiating_change: { type: "string" },
        failure_mechanism: { type: "string" },
        propagation: { type: "array", items: { type: "string" } },
        evidence_refs: { type: "array", items: { type: "string" } },
        proposed_repair: {
          type: "object",
          properties: repair.properties,
          required: repair.required,
          additionalProperties: false
        }
      },
      required: ["id", "title", "claim", "confidence", "initiating_change", "failure_mechanism", "propagation", "evidence_refs", "proposed_repair"],
      additionalProperties: false
    }
  };
}

function evaluationFormat() {
  return {
    type: "json_schema",
    name: "flowpulse_evaluation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        accepted: { type: "boolean" },
        score: { type: "number", minimum: 0, maximum: 1 },
        classification: { type: "string", enum: ["confirmed_system_bug", "agent_false_positive", "insufficient_evidence", "tool_data_failure", "repair_failure", "regression"] },
        reason: { type: "string" },
        missing_evidence: { type: "array", items: { type: "string" } },
        counter_evidence_refs: { type: "array", items: { type: "string" } }
      },
      required: ["accepted", "score", "classification", "reason", "missing_evidence", "counter_evidence_refs"],
      additionalProperties: false
    }
  };
}

function parseStructuredText(response) {
  for (const output of response.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.type === "refusal") throw new Error(`Model refused: ${content.refusal}`);
      if (content.type === "output_text") return JSON.parse(content.text);
    }
  }
  throw new Error("OpenAI response did not contain structured output");
}

export function validateDiagnosis(diagnosis, evidenceSource, repairContract = null) {
  const known = new Set(evidenceSource.list({ limit: 50 }).items.map((item) => item.id));
  const allKnown = diagnosis.evidence_refs.every((id) => evidenceSource.has ? evidenceSource.has(id) : known.has(id));
  if (!diagnosis.evidence_refs.length || !allKnown) {
    throw new Error("Diagnosis contains missing or unknown evidence references");
  }
  if (!repairContract) {
    if (diagnosis.proposed_repair.target !== "checkout" || diagnosis.proposed_repair.action !== "no_execution") throw new Error("Model-only investigation proposed an executable repair");
    return;
  }
  const proposed = diagnosis.proposed_repair;
  if (proposed.repair_id !== repairContract.repair_id || proposed.action !== repairContract.action || proposed.target !== repairContract.target || proposed.command_id !== repairContract.command_id) {
    throw new Error("Diagnosis proposed a repair outside the approved boundary");
  }
}

import { withIncidentTrace } from "./observability.mjs";
import { evaluateCheckoutPaymentDiagnosisGate } from "./incident-mechanism.mjs";
import { buildDiagnosisBacktestSeed } from "./regression-backtest.mjs";
import {
  ModelBudgetExceededError,
  ModelOutputInvalidError,
  attachModelFailureContext,
  isModelResponseError,
  inspectOpenAIResponse,
  requestOpenAIResponse,
  safeFailureMetadata
} from "./openai-response.mjs";
import { harnessBinding, loadHarnessManifest } from "./harness-manifest.mjs";
import { compileToolContext, ContextCompilationError, createContextAccumulator } from "./context-compiler.mjs";

const API_URL = "https://api.openai.com/v1/responses";
const INITIAL_HARNESS = loadHarnessManifest();
export const INVESTIGATOR_INSTRUCTIONS = INITIAL_HARNESS.skills.investigator.content;
export const EVALUATOR_INSTRUCTIONS = INITIAL_HARNESS.skills.evaluator.content;

export class CausalEvidenceError extends Error {
  constructor(_message, classification = "insufficient_evidence", metadata = {}) {
    super("Causal evidence rejected");
    this.name = "CausalEvidenceError";
    this.classification = classification;
    this.metadata = safeCausalMetadata(metadata);
    this.code = this.metadata.reason_code || "causal_evidence_rejected";
  }
}

export async function runLiveInvestigation({ runtime, runId, evidenceSource, repairContract = null, requestResponse = requestOpenAIResponse, withTrace = withIncidentTrace }) {
  const harness = loadHarnessManifest();
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for live mode");
  if (!evidenceSource?.metadata || !evidenceSource?.query) throw new Error("A selected bounded evidence source is required for live mode");
  const sourceMetadata = evidenceSource.metadata();
  if (sourceMetadata.mode !== "frozen_real_otlp_snapshot") throw new Error("GPT-5.6 live mode requires a frozen real OTLP snapshot");
  if (repairContract && !evidenceSource.query({ kind: "change", entity: repairContract.target }).length) {
    throw new Error("Executable GPT investigation requires a frozen applied change record");
  }
  const { bundle } = runtime;
  runtime.append(runId, "live.run.started", "runtime", {
    model: harness.model.id,
    execution_mode: "gpt_5_6",
    evidence_mode: sourceMetadata.mode,
    authority: "flowpulse-ledger",
    harness: harnessBinding(harness)
  });

  try {
    return await withTrace({
    runId,
    incidentId: bundle.incident.id,
    input: { incident_id: bundle.incident.id, title: bundle.incident.title }
  }, async (observability) => {
    let feedback = null;
    let finalResult;
    let rejected = null;
    const pendingModelEvents = [];
    const budget = createWorkflowBudget(harness);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (feedback) {
        pendingModelEvents.push({ type: "plan.revised", actor: "live-investigator", payload: {
          reason: feedback.reason,
          missing_evidence: feedback.missing_evidence,
          attempt
        } });
      }
      const investigated = await investigate({ runtime, runId, observability, feedback, evidenceSource, repairContract, attempt, budget, requestResponse, harness });
      const { diagnosis, queriedEvidenceIds } = investigated;
      const diagnosisMetadata = investigationMetadata(investigated, harness);
      try {
        validateDiagnosisOutput(diagnosis, repairContract);
      } catch (error) {
        throw attachModelFailureContext(error, diagnosisMetadata);
      }
      validateDiagnosisCandidate(diagnosis, evidenceSource, repairContract, queriedEvidenceIds, diagnosisMetadata);
      pendingModelEvents.push({ type: "hypothesis.proposed", actor: "live-investigator", payload: {
        ...diagnosis,
        live: true,
        attempt
      }, evidenceRefs: diagnosis.evidence_refs });

      const evaluated = await evaluate({ diagnosis, evidenceSource, observability, attempt, budget, requestResponse, harness, investigated });
      const { evaluation, suppliedEvidenceIds } = evaluated;
      const evaluatorMetadata = evaluationMetadata(evaluated, investigated, harness);
      try {
        validateEvaluationOutput(evaluation);
      } catch (error) {
        throw attachModelFailureContext(error, evaluatorMetadata);
      }
      validateEvaluation(evaluation, evidenceSource, suppliedEvidenceIds, evaluatorMetadata);
      if (evaluation.accepted) validateDiagnosis(diagnosis, evidenceSource, repairContract, queriedEvidenceIds, diagnosisMetadata);
      pendingModelEvents.push({ type: evaluation.accepted ? "evaluation.accepted" : "evaluation.rejected", actor: "live-evaluator", payload: {
        ...evaluation,
        hypothesis_id: diagnosis.id,
        live: true,
        attempt
      }, evidenceRefs: evaluation.counter_evidence_refs });
      finalResult = { diagnosis, evaluation, observability_ref: observability.traceRef, attempt };
      if (evaluation.accepted) {
        if (repairContract) {
          if (!rejected) throw new CausalEvidenceError("Executable GPT workflow requires an independently rejected initial hypothesis before acceptance", "agent_false_positive", {
            stage: "diagnosis_gate", attempt, validator_id: "independent_rejection", reason_code: "initial_rejection_missing",
            tool_coverage: investigated.toolCoverage, selected_evidence_refs: [...queriedEvidenceIds], context_sha256: investigated.lastContextSha256,
            missing_evidence_classes: ["independent_rejected_hypothesis"], next_precondition: "complete_adversarial_rejection"
          });
          const seed = buildDiagnosisBacktestSeed({ evidenceSource, diagnosis, evaluation, repairContract, rejected });
          pendingModelEvents.push({ type: "diagnosis.gate.passed", actor: "runtime", payload: { ...seed, harness: harnessBinding(harness), context_sha256: investigated.lastContextSha256 }, evidenceRefs: seed.accepted.evidence_ids });
        }
        break;
      }
      rejected = { diagnosis, evaluation };
      feedback = evaluation;
    }

    for (const event of pendingModelEvents) runtime.append(runId, event.type, event.actor, event.payload, event.evidenceRefs);
    runtime.append(runId, "live.run.completed", "runtime", { ...finalResult, harness: harnessBinding(harness) }, finalResult.diagnosis.evidence_refs);
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
      }, finalResult.diagnosis.evidence_refs);
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
  } catch (error) {
    if (isModelResponseError(error)) {
      error.metadata = safeFailureMetadata({ ...(error.metadata || {}), harness: error.metadata?.harness || harnessBinding(harness) });
    } else if (error && typeof error === "object") {
      const existing = error.metadata && typeof error.metadata === "object" ? error.metadata : {};
      error.metadata = safeCausalMetadata({ ...existing, harness: existing.harness || harnessBinding(harness) });
    }
    throw error;
  }
}

async function investigate({ runtime, runId, observability, feedback, evidenceSource, repairContract, attempt, budget, requestResponse, harness }) {
  const { bundle } = runtime;
  const tools = toolDefinitions(evidenceSource, harness);
  const input = [{
    role: "user",
    content: [
      `Investigate this production incident: ${bundle.incident.summary}`,
      "Use the evidence tools. Distinguish initiating cause from downstream symptoms.",
      attempt === 1
        ? "This is the initial falsification pass: test the tempting Kafka/downstream-lag explanation using symptom-layer evidence before querying initiating changes. Return the strongest hypothesis that this limited evidence actually supports so the adversarial evaluator can challenge it."
        : "This is the evidence replan: use the evaluator feedback to query the initiating change and exact failure mechanism.",
      repairContract
        ? `Cite only evidence IDs returned by tools. Your repair must exactly be ${JSON.stringify(repairContract)}.`
        : "Cite only evidence IDs returned by tools. This model-only run has no executable repair contract; use no_execution.",
      "Query only the services needed to prove or disprove the current causal chain, then stop.",
      feedback ? `The evaluator rejected the prior attempt: ${JSON.stringify(feedback)}` : ""
    ].filter(Boolean).join("\n")
  }];

  const queriedEvidenceIds = new Set();
  const accumulator = createContextAccumulator();
  const requiredEvidenceIds = evidenceSource.metadata?.().reserved_causal_ids || [];
  for (let round = 0; round < harness.budgets.max_tool_rounds; round++) {
    const body = {
      model: harness.model.id,
      instructions: harness.skills.investigator.content,
      input,
      tools,
      tool_choice: round === 0 ? "required" : "auto",
      parallel_tool_calls: true,
      reasoning: { effort: harness.model.reasoning_effort, context: "all_turns" },
      include: ["reasoning.encrypted_content"],
      max_output_tokens: budget.requestLimit("investigator"),
      store: harness.model.store,
      safety_identifier: "flowpulse-build-week",
      text: { format: diagnosisFormat(repairContract) }
    };
    const responseContext = investigatorResponseMetadata({ attempt, round: round + 1, harness, accumulator });
    const response = await callOpenAI(body, observability, `investigator.round-${round + 1}`, false, responseContext, requestResponse);
    let inspected;
    try {
      inspected = inspectOpenAIResponse(response.data, { ...response.metadata, ...responseContext }, { entities: evidenceSource.entities(), stage: "investigator" });
      budget.consumeResponse(inspected.metadata, "investigator");
    } catch (error) {
      throw attachModelFailureContext(error, responseContext);
    }
    input.push(...inspected.replayItems);
    if (inspected.kind === "terminal") return { diagnosis: inspected.value, queriedEvidenceIds, toolCoverage: accumulator.toolCoverage, lastContextSha256: accumulator.lastContextSha256, attempt, round: round + 1 };

    budget.consumeToolCalls(inspected.calls.length);
    for (const call of inspected.calls) {
      const observation = observability.tool(call.name, { input: { entity: call.args.entity }, metadata: { run_id: runId, evidence_mode: evidenceSource.metadata().mode } });
      const result = executeTool(evidenceSource, call.name, call.args);
      let compiled;
      try {
        compiled = compileToolContext({ items: result, tool: call.name, entity: call.args.entity, attempt, round: round + 1, accumulator, requiredEvidenceIds });
      } catch (error) {
        if (!(error instanceof ContextCompilationError)) throw error;
        throw new CausalEvidenceError("Context compiler could not preserve required evidence", "insufficient_evidence", {
          ...error.metadata,
          reason_code: error.metadata?.reason_code || error.code,
          stage: "context_compiler",
          attempt,
          round: round + 1,
          tool_coverage: accumulator.toolCoverage,
          harness: harnessBinding(harness)
        });
      }
      for (const id of compiled.authorityRefs) queriedEvidenceIds.add(id);
      observation.update({ output: { result_count: result.length, evidence_ref_count: compiled.authorityRefs.size, context_sha256: compiled.context.context_sha256 } });
      observation.end();
      runtime.append(runId, "context.compiled", "runtime", {
        ...compiled.context,
        harness: harnessBinding(harness)
      }, [...compiled.authorityRefs]);
      runtime.append(runId, "tool.called", "live-investigator", {
        tool: call.name,
        arguments: call.args,
        attempt,
        round: round + 1,
        result_count: result.length,
        selected_count: compiled.authorityRefs.size,
        selected_evidence_refs: [...compiled.authorityRefs].sort(),
        context_sha256: compiled.context.context_sha256,
        live: true,
        evidence_mode: evidenceSource.metadata().mode,
        harness: harnessBinding(harness)
      }, [...compiled.authorityRefs]);
      // The compiler accounts for this exact serialized payload.
      input.push({ type: "function_call_output", call_id: call.callId, output: compiled.payload });
    }
  }
  throw new ModelBudgetExceededError("tool_round_budget_exhausted", { stage: "investigator", attempt, max_tool_rounds: harness.budgets.max_tool_rounds });
}

async function evaluate({ diagnosis, evidenceSource, observability, attempt, budget, requestResponse, harness, investigated }) {
  const cited = evidenceSource.summariesById(diagnosis.evidence_refs);
  const body = {
    model: harness.model.id,
    instructions: harness.skills.evaluator.content,
    input: `Candidate diagnosis:\n${JSON.stringify(diagnosis)}\n\nCited evidence:\n${JSON.stringify(cited)}`,
    reasoning: { effort: harness.model.reasoning_effort, context: "current_turn" },
    include: ["reasoning.encrypted_content"],
    max_output_tokens: budget.requestLimit("evaluator"),
    store: harness.model.store,
    safety_identifier: "flowpulse-build-week",
    text: { format: evaluationFormat() }
  };
  const responseContext = evaluatorResponseMetadata({ attempt, harness, investigated });
  const response = await callOpenAI(body, observability, `evaluator.attempt-${attempt}`, true, responseContext, requestResponse);
  let inspected;
  try {
    inspected = inspectOpenAIResponse(response.data, { ...response.metadata, ...responseContext }, { entities: evidenceSource.entities(), stage: "evaluator" });
    budget.consumeResponse(inspected.metadata, "evaluator");
    if (inspected.kind !== "terminal") throw new ModelOutputInvalidError("evaluator_returned_tool_call", inspected.metadata);
  } catch (error) {
    throw attachModelFailureContext(error, responseContext);
  }
  return { evaluation: inspected.value, suppliedEvidenceIds: new Set(cited.map((item) => item.id)), attempt, toolCoverage: investigated.toolCoverage, lastContextSha256: investigated.lastContextSha256 };
}

async function callOpenAI(body, observability, name, evaluator = false, stage = {}, requestResponse = requestOpenAIResponse) {
  const started = performance.now();
  const observation = (evaluator ? observability.evaluator : observability.generation)(name, {
    model: body.model,
    input: { input_item_count: Array.isArray(body.input) ? body.input.length : 1 },
    metadata: { reasoning_effort: body.reasoning?.effort, store: body.store, stage: stage.stage, attempt: stage.attempt, round: stage.round }
  });
  try {
    const result = await requestResponse({ url: API_URL, body });
    observation.update({
      output: { status: result.metadata.response_status, output_item_count: Array.isArray(result.data.output) ? result.data.output.length : 0 },
      usageDetails: {
        input: result.metadata.usage.input_tokens,
        output: result.metadata.usage.output_tokens,
        total: result.metadata.usage.total_tokens
      },
      metadata: { latency_ms: Math.round(performance.now() - started), response_ref: result.metadata.response_ref, response_body_ref: result.metadata.response_body_ref }
    });
    return result;
  } catch (error) {
    observation.update({ output: { status: "failed", code: error.code || "internal_error", classification: error.classification || "internal_error" }, metadata: { latency_ms: Math.round(performance.now() - started) } });
    throw attachModelFailureContext(error, stage);
  } finally {
    observation.end();
  }
}

export function createWorkflowBudget(harness = loadHarnessManifest()) {
  const limits = harness.budgets;
  let responses = 0;
  let toolCalls = 0;
  let outputTokens = 0;
  return {
    requestLimit(stage) {
      if (responses >= limits.max_paid_responses) throw new ModelBudgetExceededError("paid_response_budget_exhausted", { max_paid_responses: limits.max_paid_responses });
      const remaining = limits.max_workflow_output_tokens - outputTokens;
      if (remaining < limits.min_request_output_tokens) throw new ModelBudgetExceededError("workflow_token_budget_exhausted", { max_output_tokens: limits.max_workflow_output_tokens, used_output_tokens: outputTokens });
      responses += 1;
      return Math.min(stage === "evaluator" ? limits.evaluator_max_output_tokens : limits.investigator_max_output_tokens, remaining);
    },
    consumeResponse(metadata, stage) {
      const used = metadata?.usage?.output_tokens;
      if (!Number.isSafeInteger(used) || used < 0) throw new ModelOutputInvalidError("usage_output_tokens_invalid", { ...metadata, stage });
      outputTokens += used;
      if (outputTokens > limits.max_workflow_output_tokens) throw new ModelBudgetExceededError("workflow_token_budget_exhausted", { max_output_tokens: limits.max_workflow_output_tokens, used_output_tokens: outputTokens, stage });
    },
    consumeToolCalls(count) {
      toolCalls += count;
      if (toolCalls > limits.max_total_tool_calls) throw new ModelBudgetExceededError("tool_call_budget_exhausted", { max_tool_calls: limits.max_total_tool_calls, used_tool_calls: toolCalls });
    }
  };
}

export function executeTool(evidenceSource, name, args) {
  const kindByTool = {
    query_metrics: "metric",
    query_traces: "trace",
    query_logs: "log",
    query_deploys: "deploy",
    query_commits: "commit",
    query_changes: "change",
    query_code: "code"
  };
  const kind = kindByTool[name];
  if (!kind) throw new Error(`Tool is not allowlisted: ${name}`);
  return evidenceSource.query({ kind, entity: args.entity }).filter((item) => !item.id.startsWith("ev-verify-"));
}

function toolDefinitions(evidenceSource, harness) {
  const entities = evidenceSource.entities();
  const labels = {
    query_metrics: "metrics", query_traces: "traces", query_logs: "logs", query_changes: "changes", query_code: "pinned code semantics", query_deploys: "deploys", query_commits: "commits"
  };
  return harness.protocols.schema.tool_names.map((name) => ({
    type: "function",
    name,
    description: `Return captured ${labels[name]} evidence for one incident entity.`,
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
        propagation: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity: { type: "string", enum: ["kafka", "accounting", "fraud", "checkout_retries", "other"] },
              status: { type: "string", enum: ["proven", "unproven"] },
              claim: { type: "string" },
              evidence_refs: { type: "array", items: { type: "string" } }
            },
            required: ["entity", "status", "claim", "evidence_refs"],
            additionalProperties: false
          }
        },
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
        phase: { type: "string", enum: ["diagnosis_pre_approval"] },
        gate_checks: {
          type: "object",
          properties: {
            initiating_change: { type: "boolean" },
            temporal_order: { type: "boolean" },
            implementation_semantics: { type: "boolean" },
            controlled_off_on_contrast: { type: "boolean" },
            repeated_direct_failures: { type: "boolean" }
          },
          required: ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"],
          additionalProperties: false
        },
        reason: { type: "string" },
        missing_evidence: { type: "array", items: { type: "string" } },
        counter_evidence_refs: { type: "array", items: { type: "string" } }
      },
      required: ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs"],
      additionalProperties: false
    }
  };
}

const MAX_EVIDENCE_REFS = 24;
const MAX_PROPAGATION_CLAIMS = 5;
const EVIDENCE_ID_BYTES = 160;
const PROPAGATION_ENTITIES = new Set(["kafka", "accounting", "fraud", "checkout_retries", "other"]);
const PROPAGATION_STATUSES = new Set(["proven", "unproven"]);
const EVALUATION_CLASSIFICATIONS = new Set(["confirmed_system_bug", "agent_false_positive", "insufficient_evidence", "tool_data_failure", "repair_failure", "regression"]);
const DIAGNOSIS_GATE_CHECKS = ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"];

export function validateDiagnosisOutput(value, repairContract = null) {
  assertExactObject(value, ["id", "title", "claim", "confidence", "initiating_change", "failure_mechanism", "propagation", "evidence_refs", "proposed_repair"], "diagnosis");
  assertText(value.id, 128, "diagnosis_id");
  assertText(value.title, 512, "diagnosis_title");
  assertText(value.claim, 2_048, "diagnosis_claim");
  assertFiniteRange(value.confidence, 0, 1, "diagnosis_confidence");
  assertText(value.initiating_change, 2_048, "diagnosis_initiating_change");
  assertText(value.failure_mechanism, 2_048, "diagnosis_failure_mechanism");
  assertEvidenceRefs(value.evidence_refs, "diagnosis_evidence_refs");
  if (!Array.isArray(value.propagation) || value.propagation.length > MAX_PROPAGATION_CLAIMS) invalidOutput("diagnosis_propagation_count_invalid");
  for (const claim of value.propagation) {
    assertExactObject(claim, ["entity", "status", "claim", "evidence_refs"], "propagation_claim");
    assertEnum(claim.entity, PROPAGATION_ENTITIES, "propagation_entity");
    assertEnum(claim.status, PROPAGATION_STATUSES, "propagation_status");
    assertText(claim.claim, 1_024, "propagation_claim_text");
    assertEvidenceRefs(claim.evidence_refs, "propagation_evidence_refs");
  }
  const repairKeys = repairContract
    ? ["repair_id", "action", "target", "command_id", "reason"]
    : ["action", "target", "reason"];
  assertExactObject(value.proposed_repair, repairKeys, "proposed_repair");
  for (const key of repairKeys) assertText(value.proposed_repair[key], key === "reason" ? 2_048 : 256, `proposed_repair_${key}`);
  return value;
}

export function validateEvaluationOutput(value) {
  assertExactObject(value, ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs"], "evaluation");
  if (typeof value.accepted !== "boolean") invalidOutput("evaluation_accepted_invalid");
  assertFiniteRange(value.score, 0, 1, "evaluation_score");
  assertEnum(value.classification, EVALUATION_CLASSIFICATIONS, "evaluation_classification");
  if (value.phase !== "diagnosis_pre_approval") invalidOutput("evaluation_phase_invalid");
  assertExactObject(value.gate_checks, DIAGNOSIS_GATE_CHECKS, "evaluation_gate_checks");
  for (const key of DIAGNOSIS_GATE_CHECKS) if (typeof value.gate_checks[key] !== "boolean") invalidOutput("evaluation_gate_check_invalid");
  assertText(value.reason, 4_096, "evaluation_reason");
  assertStringList(value.missing_evidence, 24, 512, "evaluation_missing_evidence");
  assertEvidenceRefs(value.counter_evidence_refs, "evaluation_counter_evidence_refs");
  return value;
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidOutput(`${label}_object_invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidOutput(`${label}_keys_invalid`);
}

function assertText(value, maxBytes, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > maxBytes) invalidOutput(`${label}_invalid`);
}

function assertFiniteRange(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) invalidOutput(`${label}_invalid`);
}

function assertEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) invalidOutput(`${label}_invalid`);
}

function assertEvidenceRefs(value, label) {
  assertStringList(value, MAX_EVIDENCE_REFS, EVIDENCE_ID_BYTES, label);
}

function assertStringList(value, maximum, itemBytes, label) {
  if (!Array.isArray(value) || value.length > maximum) invalidOutput(`${label}_count_invalid`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") === 0 || Buffer.byteLength(item, "utf8") > itemBytes || seen.has(item)) {
      invalidOutput(`${label}_item_invalid`);
    }
    seen.add(item);
  }
}

function invalidOutput(code) {
  throw new ModelOutputInvalidError(code);
}

function investigationMetadata(investigated, harness) {
  return {
    stage: "investigator",
    attempt: investigated.attempt,
    round: investigated.round,
    validator_id: "current_attempt_tool_lineage",
    tool_coverage: investigated.toolCoverage,
    selected_evidence_refs: [...investigated.queriedEvidenceIds],
    context_sha256: investigated.lastContextSha256,
    harness: harnessBinding(harness)
  };
}

function investigatorResponseMetadata({ attempt, round, harness, accumulator }) {
  return {
    stage: "investigator",
    attempt,
    round,
    validator_id: "responses_boundary",
    field_path: "response.output",
    tool_coverage: accumulator.toolCoverage,
    selected_evidence_refs: [...accumulator.selectedIds],
    context_sha256: accumulator.lastContextSha256,
    harness: harnessBinding(harness)
  };
}

function evaluatorResponseMetadata({ attempt, harness, investigated }) {
  return {
    stage: "evaluator",
    attempt,
    round: 0,
    validator_id: "responses_boundary",
    field_path: "response.output",
    tool_coverage: investigated.toolCoverage,
    selected_evidence_refs: [...investigated.queriedEvidenceIds],
    context_sha256: investigated.lastContextSha256,
    harness: harnessBinding(harness)
  };
}

function evaluationMetadata(evaluated, investigated, harness) {
  return {
    ...investigationMetadata(investigated, harness),
    stage: "evaluator",
    attempt: evaluated.attempt,
    round: 0,
    validator_id: "evaluator_counter_evidence_lineage"
  };
}

function causalError(classification, metadata, validatorId, fieldPath, reasonCode, missingEvidenceClasses, nextPrecondition) {
  return new CausalEvidenceError("Causal evidence validation failed", classification, {
    ...metadata,
    validator_id: validatorId,
    field_path: fieldPath,
    reason_code: reasonCode,
    missing_evidence_classes: missingEvidenceClasses,
    next_precondition: nextPrecondition
  });
}

function safeCausalMetadata(value = {}) {
  const binding = value.harness || {};
  const coverage = Array.isArray(value.tool_coverage) ? value.tool_coverage.slice(0, 24).map((item) => ({
    tool: safeText(item?.tool, 80), entity: safeText(item?.entity, 120), attempt: safeInt(item?.attempt), round: safeInt(item?.round),
    result_count: safeInt(item?.result_count), selected_count: safeInt(item?.selected_count), omitted_count: safeInt(item?.omitted_count), context_sha256: safeHash(item?.context_sha256)
  })).filter((item) => item.tool && item.entity) : [];
  return compact({
    stage: ["investigator", "evaluator", "diagnosis_gate", "context_compiler"].includes(value.stage) ? value.stage : null,
    attempt: safePositiveInt(value.attempt),
    round: safeNonNegativeInt(value.round),
    validator_id: safeText(value.validator_id, 120),
    field_path: safeText(value.field_path, 160),
    reason_code: safeText(value.reason_code, 120),
    tool_coverage: coverage,
    selected_evidence_refs: safeIds(value.selected_evidence_refs),
    omitted_evidence_refs: safeOmitted(value.omitted_evidence_refs),
    missing_evidence_classes: safeStrings(value.missing_evidence_classes, 8, 80),
    next_precondition: safeText(value.next_precondition, 160),
    context_sha256: safeHash(value.context_sha256),
    harness: safeHarnessBinding(binding)
  });
}

function safeHarnessBinding(value) {
  if (!value || typeof value !== "object") return null;
  const skills = value.skills && typeof value.skills === "object" ? Object.fromEntries(["investigator", "evaluator"].flatMap((name) => {
    const item = value.skills[name];
    return item && safeText(item.id, 120) && safeText(item.version, 80) && safeHash(item.sha256) ? [[name, { id: item.id, version: item.version, sha256: item.sha256 }]] : [];
  })) : {};
  const protocols = value.protocols && typeof value.protocols === "object" ? Object.fromEntries(Object.entries(value.protocols)
    .filter(([key, item]) => ["sha256", "tool_protocol_sha256", "investigator_evaluator_handoff_sha256", "owner_repair_sha256", "safe_failure_sha256"].includes(key) && safeHash(item))) : {};
  const model = value.model && typeof value.model === "object" && safeText(value.model.id, 120) && safeText(value.model.reasoning_effort, 32) && typeof value.model.store === "boolean"
    ? { id: value.model.id, reasoning_effort: value.model.reasoning_effort, store: value.model.store } : null;
  const output = compact({ version: safeText(value.version, 80), manifest_sha256: safeHash(value.manifest_sha256), model, skills, protocols });
  return output.manifest_sha256 ? output : null;
}

function safeIds(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, 160)))].sort().slice(0, 120) : []; }
function safeOmitted(value) {
  const reasons = new Set(["duplicate", "tool_record_cap", "tool_byte_cap", "attempt_record_cap", "attempt_byte_cap"]);
  return Array.isArray(value) ? value.filter((item) => safeText(item?.id, 160) && reasons.has(item.reason)).map((item) => ({ id: item.id, reason: item.reason })).slice(0, 120) : [];
}
function safeStrings(value, limit, itemLimit) { return Array.isArray(value) ? [...new Set(value.filter((item) => safeText(item, itemLimit)))].sort().slice(0, limit) : []; }
function safeText(value, limit) { return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 && Buffer.byteLength(value, "utf8") <= limit ? value : null; }
function safeHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function safeInt(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safePositiveInt(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function safeNonNegativeInt(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && (!Array.isArray(item) || item.length) && (!(item && typeof item === "object" && !Array.isArray(item)) || Object.keys(item).length))); }

export function validateDiagnosis(diagnosis, evidenceSource, repairContract = null, queriedEvidenceIds = null, metadata = {}) {
  validateDiagnosisCandidate(diagnosis, evidenceSource, repairContract, queriedEvidenceIds, metadata);
  if (repairContract) validateExecutableCausalEvidence(diagnosis.evidence_refs, evidenceSource, repairContract, metadata);
}

export function validateDiagnosisCandidate(diagnosis, evidenceSource, repairContract = null, queriedEvidenceIds = null, metadata = {}) {
  if (!diagnosis || typeof diagnosis !== "object" || !Array.isArray(diagnosis.evidence_refs) || !diagnosis.proposed_repair || typeof diagnosis.proposed_repair !== "object") {
    throw causalError("agent_false_positive", metadata, "diagnosis_candidate_shape", "diagnosis", "diagnosis_shape_invalid", [], "return_typed_diagnosis");
  }
  const known = new Set(evidenceSource.list({ limit: 50 }).items.map((item) => item.id));
  const allKnown = diagnosis.evidence_refs.every((id) => typeof id === "string" && (evidenceSource.has ? evidenceSource.has(id) : known.has(id)));
  if (!diagnosis.evidence_refs.length) {
    throw causalError("insufficient_evidence", metadata, "diagnosis_evidence_refs", "diagnosis.evidence_refs", "evidence_refs_empty", ["cited_evidence"], "query_and_cite_evidence");
  }
  if (!allKnown) {
    throw causalError("agent_false_positive", metadata, "diagnosis_evidence_refs", "diagnosis.evidence_refs", "unknown_evidence_ref", ["known_snapshot_evidence"], "cite_known_snapshot_evidence");
  }
  if (queriedEvidenceIds && diagnosis.evidence_refs.some((id) => !queriedEvidenceIds.has(id))) {
    throw causalError("agent_false_positive", metadata, "current_attempt_tool_lineage", "diagnosis.evidence_refs", "known_but_unqueried_evidence", ["current_attempt_tool_result"], "query_cited_evidence_in_current_attempt");
  }
  validatePropagationClaims(diagnosis, evidenceSource, metadata);
  if (!repairContract) {
    if (diagnosis.proposed_repair.target !== "checkout" || diagnosis.proposed_repair.action !== "no_execution") {
      throw causalError("agent_false_positive", metadata, "model_only_repair_boundary", "diagnosis.proposed_repair", "executable_repair_in_model_only", ["no_execution_repair"], "return_no_execution_repair");
    }
    return;
  }
  const proposed = diagnosis.proposed_repair;
  if (proposed.repair_id !== repairContract.repair_id || proposed.action !== repairContract.action || proposed.target !== repairContract.target || proposed.command_id !== repairContract.command_id) {
    throw causalError("agent_false_positive", metadata, "repair_contract", "diagnosis.proposed_repair", "repair_contract_mismatch", ["exact_allowlisted_repair_contract"], "use_exact_allowlisted_repair");
  }
}

export function validateEvaluation(evaluation, evidenceSource, suppliedEvidenceIds = null, metadata = {}) {
  if (!evaluation || typeof evaluation !== "object" || !Array.isArray(evaluation.counter_evidence_refs)) {
    throw causalError("agent_false_positive", metadata, "evaluator_shape", "evaluation", "evaluation_shape_invalid", ["typed_evaluation"], "return_typed_evaluation");
  }
  const unknown = evaluation.counter_evidence_refs.some((id) => typeof id !== "string" || !evidenceSource.has(id));
  if (unknown) throw causalError("agent_false_positive", metadata, "evaluator_counter_evidence", "evaluation.counter_evidence_refs", "unknown_evidence_ref", ["supplied_candidate_evidence"], "cite_supplied_evidence_only");
  const wasSupplied = (id) => !suppliedEvidenceIds || (typeof suppliedEvidenceIds.has === "function"
    ? suppliedEvidenceIds.has(id)
    : suppliedEvidenceIds.includes(id));
  if (suppliedEvidenceIds && evaluation.counter_evidence_refs.some((id) => !wasSupplied(id))) {
    throw causalError("agent_false_positive", metadata, "evaluator_counter_evidence_lineage", "evaluation.counter_evidence_refs", "unsupplied_evaluator_evidence", ["supplied_candidate_evidence"], "cite_supplied_evidence_only");
  }
  if (evaluation.accepted) {
    const checks = evaluation.gate_checks || {};
    const required = ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"];
    if (evaluation.phase !== "diagnosis_pre_approval" || required.some((id) => checks[id] !== true)) {
      throw causalError("agent_false_positive", metadata, "evaluator_diagnosis_gate", "evaluation.gate_checks", "diagnosis_gate_check_missing", ["five_part_diagnosis_gate"], "evaluate_all_preapproval_gates");
    }
    if (evaluation.classification !== "confirmed_system_bug") {
      throw causalError("agent_false_positive", metadata, "evaluator_outcome_classification", "evaluation.classification", "accepted_classification_mismatch", ["confirmed_system_bug"], "align_evaluator_outcome");
    }
  }
}

export function validateExecutableCausalEvidence(ids, evidenceSource, repairContract, metadata = {}) {
  const cited = evidenceSource.summariesById(ids);
  const change = cited.find((item) => item.kind === "change" && item.value?.change?.repair_id === repairContract.repair_id
    && item.value.change.target === repairContract.target
    && item.value.change.repair_command_id === repairContract.command_id
    && repairContract.action === `restore known-good ${item.value.change.flag} flag and recreate checkout`);
  const gate = evaluateCheckoutPaymentDiagnosisGate(cited, change?.value?.change);
  if (!change || !gate.passed) {
    throw causalError("insufficient_evidence", metadata, "five_part_diagnosis_gate", "diagnosis.evidence_refs", "diagnosis_gate_evidence_missing", gate.missing, "query_complete_diagnosis_gate_evidence");
  }
}

export function validatePropagationClaims(diagnosis, evidenceSource, metadata = {}) {
  const claims = Array.isArray(diagnosis.propagation) ? diagnosis.propagation : [];
  const cited = new Set(diagnosis.evidence_refs || []);
  for (const claim of claims) {
    if (!claim || typeof claim !== "object" || !["proven", "unproven"].includes(claim.status) || !Array.isArray(claim.evidence_refs)) {
      throw causalError("agent_false_positive", metadata, "propagation_contract", "diagnosis.propagation", "propagation_shape_invalid", ["typed_propagation_contract"], "return_typed_propagation");
    }
    if (claim.status === "unproven") {
      if (claim.evidence_refs.length) throw causalError("agent_false_positive", metadata, "propagation_contract", "diagnosis.propagation", "unproven_claim_has_refs", ["unproven_propagation_without_refs"], "remove_unproven_claim_refs");
      continue;
    }
    const claimText = String(claim.claim || "").toLowerCase();
    const crossEntity = ["kafka", "accounting", "fraud"].some((entity) => entity !== claim.entity && claimText.includes(entity))
      || (claim.entity !== "checkout_retries" && /retr(?:y|ies|ied)/.test(claimText));
    if (crossEntity) throw causalError("agent_false_positive", metadata, "propagation_scope", "diagnosis.propagation", "cross_entity_propagation_claim", ["single_entity_propagation"], "split_or_mark_propagation_unproven");
    const refs = evidenceSource.summariesById(claim.evidence_refs);
    if (!claim.evidence_refs.length || claim.evidence_refs.some((id) => !cited.has(id) || !evidenceSource.has(id))
      || refs.length !== claim.evidence_refs.length || !refs.some((item) => directlySupportsPropagation(item, claim.entity, claimText))) {
      throw causalError("insufficient_evidence", metadata, "propagation_evidence", "diagnosis.propagation", "direct_propagation_evidence_missing", ["direct_propagation_evidence"], "query_and_cite_direct_propagation_evidence");
    }
  }
}

function directlySupportsPropagation(item, entity, claimText) {
  const evidenceEntity = String(item.entity || "").toLowerCase();
  const text = `${item.fact || ""} ${item.value?.metric?.name || ""} ${item.value?.log?.message || ""}`.toLowerCase();
  const entityMatches = entity === "checkout_retries"
    ? evidenceEntity.includes("checkout")
    : ["kafka", "accounting", "fraud"].includes(entity) && evidenceEntity.includes(entity);
  if (!entityMatches) return false;
  const asserted = propagationSignals(claimText);
  const observed = propagationSignals(text);
  return asserted.length > 0 && asserted.every((signal) => observed.includes(signal));
}

function propagationSignals(text) {
  const patterns = {
    lag: /\blag(?:ged|ging)?\b/,
    backlog: /\bbacklog(?:ged|ging|s)?\b/,
    queue: /\bqueue(?:d|s|ing)?\b/,
    retry: /\bretr(?:y|ies|ied|ying)\b/,
    delay: /\bdelay(?:ed|ing|s)?\b|\blate\b/,
    consumer: /\bconsumer(?:s)?\b/,
    error: /\berror(?:s)?\b|\bfail(?:ed|ure|ures|ing)?\b/,
    unavailable: /\bunavailable\b|\bunreachable\b/,
    processing: /\bprocessing\b/
  };
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal);
}

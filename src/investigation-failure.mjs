export function investigationFailureClassification(error) {
  if (error?.name === "CausalEvidenceError") return error.classification || "insufficient_evidence";
  if (error?.name === "InsufficientEvidenceError") return "insufficient_evidence";
  return error?.message?.includes("approved boundary") ? "agent_false_positive" : "tool_data_failure";
}

export function recordInvestigationFailure({ runtime, runId, error, failedType, actor = "runtime" }) {
  const classification = investigationFailureClassification(error);
  const reason = String(error?.message || "Investigation failed").slice(0, 400);
  const events = runtime.ledger.list(runId);
  if (!events.some((event) => event.type === "outcome.classified" && event.payload?.classification === classification)) {
    runtime.append(runId, "outcome.classified", actor, { classification, explanation: reason });
  }
  runtime.append(runId, failedType, "runtime", { classification, reason });
  return classification;
}

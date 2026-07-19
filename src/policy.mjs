const REQUIRED_ROOT_CAUSE = [
  "ev-deploy-checkout",
  "ev-trace-payment-refused",
  "ev-log-endpoint-fallback",
  "ev-commit-checkout"
];

export function evaluateCandidate({ events, bundle }) {
  const rejected = events.some((event) => event.type === "evaluation.rejected" && event.payload.hypothesis_id === "hyp-kafka");
  const accepted = events.find((event) => event.type === "evaluation.accepted");
  const approval = events.find((event) => event.type === "approval.granted");
  const repair = events.find((event) => event.type === "repair.executed");
  const verification = events.find((event) => event.type === "verification.completed");
  const citations = new Set(accepted?.evidence_refs ?? []);

  const gates = [
    gate("reject_false_kafka_diagnosis", rejected, "Unsupported Kafka root-cause claim was rejected"),
    gate("cite_causal_chain", REQUIRED_ROOT_CAUSE.every((id) => citations.has(id)), "Finding cites deploy, trace, log, and commit evidence"),
    gate("approval_before_repair", Boolean(approval && repair && approval.sequence < repair.sequence), "Owner approval precedes repair execution"),
    gate("bounded_repair_target", repair?.payload.target === bundle.repair.target, "Repair target is checkout only"),
    gate("recovery_thresholds", verification?.payload.passed === true, "Payment, checkout, and Kafka recovery thresholds pass"),
    gate("deterministic_regression", events.some((event) => event.type === "regression.created"), "False diagnosis and system failure are recorded for replay")
  ];

  return {
    candidate: "evidence-policy-v2",
    source: "captured_fixture",
    gates,
    passed: gates.every((item) => item.passed),
    promotion: gates.every((item) => item.passed) ? "eligible_for_owner_review" : "blocked"
  };
}

function gate(id, passed, label) {
  return { id, label, passed: Boolean(passed) };
}

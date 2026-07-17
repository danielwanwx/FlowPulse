export const TWIN_STAGES = [
  { id: "healthy", label: "Healthy", time: "15:41" },
  { id: "deploy", label: "Deploy", time: "15:42" },
  { id: "propagate", label: "Propagate", time: "15:43" },
  { id: "rejected", label: "Wrong hypothesis rejected", time: "15:46" },
  { id: "root-cause", label: "Root cause", time: "15:48" },
  { id: "owner-gate", label: "Owner gate", time: "15:50" },
  { id: "recover", label: "Recover", time: "16:02" },
  { id: "learn", label: "Learn", time: "16:07" }
];

export const TWIN_NODES = [
  { id: "frontend", label: "Frontend", detail: "storefront", kind: "client", x: 10, y: 46 },
  { id: "checkout", label: "Checkout", detail: "commerce service", kind: "service", x: 27, y: 46 },
  { id: "payment", label: "Payment API", detail: "money movement", kind: "api", x: 48, y: 24 },
  { id: "kafka", label: "orders.v1", detail: "Kafka stream", kind: "stream", x: 48, y: 59 },
  { id: "accounting", label: "Accounting", detail: "consumer worker", kind: "worker", x: 69, y: 46 },
  { id: "fraud", label: "Fraud", detail: "risk worker", kind: "worker", x: 69, y: 74 },
  { id: "deployment", label: "checkout:2.18.0", detail: "deploy-checkout-442", kind: "change", x: 27, y: 14 },
  { id: "agent", label: "Investigator", detail: "evidence agent", kind: "agent", x: 87, y: 27 },
  { id: "evaluator", label: "Evaluator", detail: "adversarial check", kind: "evaluator", x: 87, y: 51 },
  { id: "ledger", label: "Evidence ledger", detail: "append-only SQLite", kind: "database", x: 87, y: 76 }
];

export const TWIN_ICONS = {
  frontend: "browser",
  checkout: "shopping-cart-simple",
  payment: "credit-card",
  kafka: "queue",
  accounting: "calculator",
  fraud: "shield-check",
  deployment: "git-commit",
  agent: "robot",
  evaluator: "scales",
  ledger: "database"
};

export const PULSE_SLOTS = {
  "frontend-checkout": 1,
  "deployment-checkout": 0,
  "checkout-payment": 2,
  "checkout-kafka": 3,
  "kafka-accounting": 4,
  "kafka-fraud": 5,
  "agent-evaluator": 0,
  "evaluator-ledger": 1,
  "checkout-ledger": 2,
  "kafka-ledger": 3
};

export const TWIN_EDGES = [
  { id: "frontend-checkout", from: "frontend", to: "checkout", label: "cart request", path: "M 155 239 C 185 239 205 239 225 239" },
  { id: "checkout-payment", from: "checkout", to: "payment", label: "payment call", path: "M 332 226 C 382 226 378 125 430 125" },
  { id: "checkout-kafka", from: "checkout", to: "kafka", label: "order publish", path: "M 332 252 C 382 252 385 307 430 307" },
  { id: "kafka-accounting", from: "kafka", to: "accounting", label: "accounting consume", path: "M 525 306 C 575 306 592 239 635 239" },
  { id: "kafka-fraud", from: "kafka", to: "fraud", label: "fraud consume", path: "M 525 322 C 575 322 590 385 635 385" },
  { id: "deployment-checkout", from: "deployment", to: "checkout", label: "deployment change", path: "M 270 104 C 270 136 270 168 270 199", control: true },
  { id: "agent-evaluator", from: "agent", to: "evaluator", label: "candidate diagnosis", path: "M 870 174 C 870 202 870 228 870 248", control: true },
  { id: "evaluator-ledger", from: "evaluator", to: "ledger", label: "score and record", path: "M 870 302 C 870 332 870 360 870 382", control: true },
  { id: "checkout-ledger", from: "checkout", to: "ledger", label: "cited checkout evidence", path: "M 300 270 C 320 485 730 486 820 420", evidence: true },
  { id: "kafka-ledger", from: "kafka", to: "ledger", label: "cited Kafka evidence", path: "M 490 335 C 520 465 730 468 820 420", evidence: true }
];

export function availableStage(events = []) {
  const has = (type) => events.some((event) => event.type === type);
  if (has("policy.evaluated")) return 7;
  if (has("verification.completed")) return 6;
  if (has("approval.requested")) return 5;
  if (has("evaluation.accepted")) return 4;
  if (has("evaluation.rejected")) return 3;
  if (has("loop.symptoms_collected")) return 2;
  return 0;
}

export function frameFor(stageIndex) {
  const index = clampStage(stageIndex);
  const nodeStates = Object.fromEntries(TWIN_NODES.map((node) => [node.id, node.kind === "change" ? "dormant" : node.kind === "database" ? "recording" : "healthy"]));
  const edgeStates = Object.fromEntries(TWIN_EDGES.map((edge) => [edge.id, edge.control || edge.evidence ? "quiet" : "healthy"]));
  const annotations = [];

  if (index >= 1) {
    nodeStates.deployment = "change";
    nodeStates.checkout = "warning";
    edgeStates["deployment-checkout"] = "change";
    annotations.push({ id: "deploy", tone: "change", title: "Deployment entered", copy: "checkout:2.18.0 from commit c7e1b9a", x: 35, y: 8 });
  }
  if (index >= 2 && index < 6) {
    for (const id of ["checkout", "payment", "kafka", "accounting", "fraud"]) nodeStates[id] = "impact";
    for (const id of ["checkout-payment", "checkout-kafka", "kafka-accounting", "kafka-fraud"]) edgeStates[id] = "impact";
    annotations.push({ id: "propagation", tone: "impact", title: "Failure propagated", copy: "ECONNREFUSED precedes Kafka lag by 171s", x: 52, y: 7 });
  }
  if (index >= 3) {
    nodeStates.agent = index >= 6 ? "verified" : "active";
    nodeStates.evaluator = index >= 6 ? "verified" : "rejected";
    edgeStates["agent-evaluator"] = index >= 6 ? "verified" : "rejected";
    annotations.push({ id: "rejected", tone: "rejected", title: "Kafka hypothesis rejected", copy: "22% score. Broker health is normal.", x: 69, y: 13 });
  }
  if (index >= 3 && index < 6) {
    annotations.push({ id: "replan", tone: "change", title: "Investigator replanned", copy: "Search upstream change and first failing span", x: 72, y: 30 });
  }
  if (index >= 4 && index < 6) {
    nodeStates.checkout = "root";
    nodeStates.payment = "root";
    edgeStates["checkout-payment"] = "root";
    annotations.push({ id: "root", tone: "root", title: "Root cause confirmed", copy: "Unset PAYMENT_ADDR selected payment:9090", x: 42, y: 34 });
  }
  if (index >= 5 && index < 6) {
    nodeStates.deployment = "approval";
    annotations.push({ id: "gate", tone: "gate", title: "Owner approval required", copy: "Rollback is locked to checkout only", x: 25, y: 65 });
  }
  if (index >= 6) {
    for (const id of ["checkout", "payment", "kafka", "accounting", "fraud", "deployment"]) nodeStates[id] = "verified";
    for (const id of ["checkout-payment", "checkout-kafka", "kafka-accounting", "kafka-fraud", "deployment-checkout"]) edgeStates[id] = "verified";
    annotations.push({ id: "recovery", tone: "verified", title: "Recovery verified", copy: "Payment 99.98%. Errors 0.8%. Lag 620.", x: 43, y: 8 });
  }
  if (index >= 7) {
    nodeStates.agent = "learned";
    nodeStates.evaluator = "learned";
    nodeStates.ledger = "learned";
    for (const id of ["agent-evaluator", "evaluator-ledger", "checkout-ledger", "kafka-ledger"]) edgeStates[id] = "learned";
    annotations.push({ id: "learning", tone: "learned", title: "Regression recorded", copy: "evidence-policy-v2 passed six offline gates", x: 70, y: 7 });
  }

  return {
    index,
    stage: TWIN_STAGES[index],
    nodeStates,
    edgeStates,
    annotations,
    metrics: metricSnapshot(index)
  };
}

export function compareFrames() {
  return { incident: frameFor(2), recovered: frameFor(6) };
}

export function metricSnapshot(index) {
  if (index >= 6) return {
    checkout: { value: "0.8%", note: "verified" },
    payment: { value: "99.98%", note: "reachable" },
    kafka: { value: "620", note: "draining" }
  };
  if (index >= 2) return {
    checkout: { value: "38.4%", note: "errors" },
    payment: { value: "61.6%", note: "reachable" },
    kafka: { value: "11,842", note: "lag" }
  };
  return {
    checkout: { value: "0.7%", note: "captured baseline" },
    payment: { value: "Nominal", note: "pre-incident" },
    kafka: { value: "182", note: "lag baseline" }
  };
}

export function eventsAtStage(events = [], stageIndex) {
  const index = clampStage(stageIndex);
  const allowed = new Set(stageEventTypes(index));
  return events.filter((event) => allowed.has(event.type));
}

function stageEventTypes(index) {
  const groups = [
    ["run.started", "incident.opened"],
    [],
    ["evidence.queried", "loop.symptoms_collected", "hypothesis.proposed", "loop.initial_hypothesis"],
    ["evaluation.rejected", "loop.hypothesis_rejected", "plan.revised", "loop.replanned"],
    ["tool.called", "loop.causal_evidence_collected", "evaluation.accepted", "loop.root_cause_confirmed"],
    ["repair.proposed", "approval.requested", "loop.approval_requested"],
    ["approval.granted", "repair.executed", "loop.repair_executed", "verification.completed"],
    ["outcome.classified", "regression.created", "policy.evaluated", "loop.learning_complete"]
  ];
  return groups.slice(0, index + 1).flat();
}

function clampStage(value) {
  return Math.max(0, Math.min(TWIN_STAGES.length - 1, Number(value) || 0));
}

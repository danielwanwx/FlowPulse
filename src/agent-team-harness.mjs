import { createHash } from "node:crypto";

export const AGENT_SCHEMA_VERSION = "flowpulse.agent_team.v1";

export const ROLE_MANIFESTS = deepFreeze({
  monitor: {
    plane: "online",
    mode: "read_only_semantic_triage",
    reads: ["incident.detected", "runtime.signal", "topology.snapshot"],
    emits: ["triage.annotation.proposed"],
    tools: ["read_topology", "read_metric_summary"],
    forbidden: ["incident.open", "incident.close", "repair.proposed", "repair.executed"]
  },
  evidence: {
    plane: "online",
    mode: "read_only_parallel_collection",
    reads: ["incident.scope", "evidence.plan.approved", "source.catalog"],
    emits: ["evidence.requested", "evidence.manifest.proposed"],
    tools: ["query_metrics", "query_traces", "query_logs", "query_deploys", "query_commits"],
    forbidden: ["diagnosis.proposed", "repair.proposed", "repair.executed"]
  },
  diagnosis: {
    plane: "online",
    mode: "maker",
    reads: ["evidence.manifest.accepted", "incident.scope"],
    emits: ["diagnosis.proposed", "evidence.gap.proposed"],
    tools: [],
    forbidden: ["evaluation.accepted", "evaluation.rejected", "repair.executed", "approval.granted"]
  },
  adversarial_evaluator: {
    plane: "online",
    mode: "checker",
    reads: ["diagnosis.proposed", "cited.evidence", "counter_evidence.catalog", "evaluation.rubric"],
    emits: ["evaluation.accepted", "evaluation.rejected"],
    tools: ["verify_evidence_ref"],
    forbidden: ["diagnosis.proposed", "repair.proposed", "repair.executed", "policy.promoted"]
  },
  remediation_planner: {
    plane: "online",
    mode: "maker",
    reads: ["evaluation.accepted", "runbook.catalog", "repair.allowlist"],
    emits: ["repair.proposed"],
    tools: ["read_runbook"],
    forbidden: ["repair.executed", "approval.granted", "verification.proposed"]
  },
  verification: {
    plane: "online",
    mode: "post_action_checker",
    reads: ["execution.receipt", "verification.plan", "post_action.evidence"],
    emits: ["verification.proposed"],
    tools: ["query_post_action_metrics", "query_post_action_traces", "query_post_action_logs"],
    forbidden: ["repair.executed", "threshold.edited", "policy.promoted"]
  },
  evolve: {
    plane: "offline",
    mode: "maker",
    reads: ["closed.incident", "false_diagnosis.record", "regression.schema"],
    emits: ["regression.candidate.proposed", "policy.candidate.proposed"],
    tools: ["write_quarantine_candidate"],
    forbidden: ["production.queried", "backtest.completed", "policy.promoted"]
  },
  test: {
    plane: "offline",
    mode: "checker",
    reads: ["frozen.policy.candidate", "versioned.replay.suite"],
    emits: ["backtest.completed"],
    tools: ["run_deterministic_replay"],
    forbidden: ["candidate.edited", "production.queried", "policy.candidate.proposed", "policy.promoted"]
  }
});

const EVENT_PAYLOAD_TYPES = Object.freeze({
  "triage.annotation.proposed": "TriageAnnotation",
  "evidence.requested": "EvidencePlan",
  "evidence.manifest.proposed": "EvidenceManifest",
  "diagnosis.proposed": "DiagnosisCandidate",
  "evidence.gap.proposed": "EvidenceGap",
  "evaluation.accepted": "EvaluationVerdict",
  "evaluation.rejected": "EvaluationVerdict",
  "repair.proposed": "RemediationProposal",
  "verification.proposed": "VerificationReport",
  "regression.candidate.proposed": "RegressionCandidate",
  "policy.candidate.proposed": "PolicyCandidate",
  "backtest.completed": "BacktestReport"
});

const EVENT_PREREQUISITES = Object.freeze({
  "triage.annotation.proposed": ["incident.opened"],
  "evidence.requested": ["incident.opened"],
  "evidence.manifest.proposed": ["evidence.requested"],
  "diagnosis.proposed": ["evidence.manifest.proposed"],
  "evidence.gap.proposed": ["evidence.manifest.proposed"],
  "evaluation.accepted": ["diagnosis.proposed"],
  "evaluation.rejected": ["diagnosis.proposed"],
  "repair.proposed": ["evaluation.accepted"],
  "verification.proposed": ["repair.executed"],
  "regression.candidate.proposed": ["outcome.classified"],
  "policy.candidate.proposed": ["outcome.classified"],
  "backtest.completed": ["policy.candidate.proposed"]
});

const ROLE_PROPOSAL_LIMITS = Object.freeze({
  monitor: 1,
  evidence: 8,
  diagnosis: 2,
  adversarial_evaluator: 2,
  remediation_planner: 2,
  verification: 3,
  evolve: 1
});

const REQUIRED_ENVELOPE_FIELDS = [
  "schema_version",
  "message_id",
  "idempotency_key",
  "content_sha256",
  "incident_id",
  "run_id",
  "agent_id",
  "agent_version",
  "prompt_hash",
  "model",
  "created_at",
  "parent_event_ids",
  "evidence_refs",
  "budget",
  "event_type",
  "payload_type",
  "payload"
];

export class AgentTeamHarness {
  #runtime;

  constructor({ runtime }) {
    if (!runtime?.append || !runtime?.ledger?.list || !runtime?.bundle?.incident?.id) {
      throw new Error("AgentTeamHarness requires an IncidentRuntime");
    }
    this.#runtime = runtime;
  }

  propose(envelope) {
    validateEnvelope(envelope);

    const events = this.#runtime.ledger.list(envelope.run_id);
    const duplicate = findIdempotentEvent(events, envelope);
    if (duplicate) return duplicate;

    validateScope(envelope, events, this.#runtime.bundle);
    validatePermission(envelope);
    validateTransition(envelope, events);
    validateRoleBudget(envelope, events);

    const parentId = envelope.parent_event_ids.at(-1) ?? null;
    return this.#runtime.append(
      envelope.run_id,
      envelope.event_type,
      `agent:${envelope.agent_id}`,
      {
        ...envelope.payload,
        _agent_proposal: {
          schema_version: envelope.schema_version,
          message_id: envelope.message_id,
          idempotency_key: envelope.idempotency_key,
          content_sha256: envelope.content_sha256,
          agent_id: envelope.agent_id,
          agent_version: envelope.agent_version,
          prompt_hash: envelope.prompt_hash,
          model: envelope.model,
          created_at: envelope.created_at,
          parent_event_ids: envelope.parent_event_ids,
          budget: envelope.budget,
          payload_type: envelope.payload_type
        }
      },
      envelope.evidence_refs,
      0,
      parentId
    );
  }
}

export function sealAgentProposal(envelope) {
  const proposal = structuredClone(envelope);
  delete proposal.content_sha256;
  return { ...proposal, content_sha256: proposalContentHash(proposal) };
}

export function proposalContentHash(envelope) {
  const proposal = structuredClone(envelope);
  delete proposal.content_sha256;
  return createHash("sha256").update(stableJson(proposal)).digest("hex");
}

function validateEnvelope(envelope) {
  if (!isRecord(envelope)) throw new Error("Agent proposal must be an object");
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!(field in envelope)) throw new Error(`Agent proposal missing ${field}`);
  }
  if (envelope.schema_version !== AGENT_SCHEMA_VERSION) throw new Error("Unsupported agent proposal schema");
  for (const field of ["message_id", "idempotency_key", "incident_id", "run_id", "agent_id", "agent_version", "prompt_hash", "model", "event_type", "payload_type"]) {
    if (typeof envelope[field] !== "string" || !envelope[field].trim()) throw new Error(`Agent proposal has invalid ${field}`);
  }
  if (!Array.isArray(envelope.parent_event_ids) || !envelope.parent_event_ids.every(nonEmptyString)) {
    throw new Error("Agent proposal has invalid parent_event_ids");
  }
  if (!Array.isArray(envelope.evidence_refs) || !envelope.evidence_refs.every(nonEmptyString)) {
    throw new Error("Agent proposal has invalid evidence_refs");
  }
  if (new Set(envelope.parent_event_ids).size !== envelope.parent_event_ids.length) throw new Error("Agent proposal has duplicate parent_event_ids");
  if (new Set(envelope.evidence_refs).size !== envelope.evidence_refs.length) throw new Error("Agent proposal has duplicate evidence_refs");
  if (!isRecord(envelope.payload) || "_agent_proposal" in envelope.payload) throw new Error("Agent proposal payload must be a plain object");
  validateTimestamp(envelope.created_at, "created_at");
  validateBudget(envelope.budget, envelope.created_at);
  if (!/^[a-f0-9]{64}$/.test(envelope.content_sha256) || envelope.content_sha256 !== proposalContentHash(envelope)) {
    throw new Error("Agent proposal content hash mismatch");
  }
  validatePayload(envelope.payload_type, envelope.payload);
}

function validateBudget(budget, createdAt) {
  if (!isRecord(budget)) throw new Error("Agent proposal has invalid budget");
  for (const field of ["tool_calls_remaining", "turns_remaining", "tokens_remaining"]) {
    if (!Number.isSafeInteger(budget[field]) || budget[field] < 0) throw new Error(`Agent proposal has invalid budget.${field}`);
  }
  validateTimestamp(budget.deadline_at, "budget.deadline_at");
  if (budget.turns_remaining === 0 || budget.tokens_remaining === 0) throw new Error("Agent proposal budget exhausted");
  if (Date.parse(budget.deadline_at) < Date.parse(createdAt)) throw new Error("Agent proposal deadline precedes creation");
}

function validateScope(envelope, events, bundle) {
  if (envelope.incident_id !== bundle.incident.id) throw new Error("Agent proposal incident scope mismatch");
  if (!events.some((event) => event.type === "run.started" && event.incident_id === envelope.incident_id)) {
    throw new Error("Agent proposal references an unknown run");
  }
  const eventIds = new Set(events.map((event) => event.id));
  const unknownParent = envelope.parent_event_ids.find((id) => !eventIds.has(id));
  if (unknownParent) throw new Error(`Agent proposal references unknown parent event: ${unknownParent}`);
  const evidenceIds = new Set(bundle.evidence.map((item) => item.id));
  const unknownEvidence = envelope.evidence_refs.find((id) => !evidenceIds.has(id));
  if (unknownEvidence) throw new Error(`Agent proposal references unknown evidence: ${unknownEvidence}`);
}

function validatePermission(envelope) {
  const role = ROLE_MANIFESTS[envelope.agent_id];
  if (!role) throw new Error(`Unknown agent role: ${envelope.agent_id}`);
  if (!role.emits.includes(envelope.event_type)) {
    throw new Error(`Agent ${envelope.agent_id} cannot emit ${envelope.event_type}`);
  }
  const expectedPayload = EVENT_PAYLOAD_TYPES[envelope.event_type];
  if (expectedPayload !== envelope.payload_type) {
    throw new Error(`${envelope.event_type} requires ${expectedPayload}`);
  }
}

function validateTransition(envelope, events) {
  for (const prerequisite of EVENT_PREREQUISITES[envelope.event_type] ?? []) {
    if (!events.some((event) => event.type === prerequisite)) {
      throw new Error(`${envelope.event_type} requires ${prerequisite}`);
    }
  }
  if (envelope.payload_type === "EvaluationVerdict") {
    const diagnosisIds = new Set(events.filter((event) => event.type === "diagnosis.proposed").map((event) => event.payload.id));
    if (!diagnosisIds.has(envelope.payload.hypothesis_id)) throw new Error("Evaluation verdict references unknown diagnosis");
    if ((envelope.event_type === "evaluation.accepted") !== envelope.payload.accepted) {
      throw new Error("Evaluation verdict does not match event type");
    }
  }
}

function validateRoleBudget(envelope, events) {
  const limit = ROLE_PROPOSAL_LIMITS[envelope.agent_id];
  if (!limit) return;
  const consumed = events.filter((event) => event.payload?._agent_proposal?.agent_id === envelope.agent_id).length;
  if (consumed >= limit) throw new Error(`Agent ${envelope.agent_id} proposal budget exhausted`);
}

function findIdempotentEvent(events, envelope) {
  const existing = events.find((event) => event.payload?._agent_proposal?.idempotency_key === envelope.idempotency_key);
  if (!existing) return null;
  if (existing.payload._agent_proposal.content_sha256 !== envelope.content_sha256) {
    throw new Error("Agent proposal idempotency key collision");
  }
  return existing;
}

function validatePayload(type, payload) {
  const validators = {
    TriageAnnotation: () => requireString(payload, "summary"),
    EvidencePlan: () => requireStringArray(payload, "queries"),
    EvidenceManifest: () => requireStringArray(payload, "evidence_ids"),
    DiagnosisCandidate: () => {
      requireString(payload, "id");
      requireString(payload, "title");
      requireString(payload, "claim");
      requireUnitNumber(payload, "confidence");
    },
    EvidenceGap: () => requireStringArray(payload, "missing"),
    EvaluationVerdict: () => {
      requireString(payload, "hypothesis_id");
      if (typeof payload.accepted !== "boolean") throw new Error("EvaluationVerdict requires boolean accepted");
      requireUnitNumber(payload, "score");
      requireString(payload, "reason");
    },
    RemediationProposal: () => {
      requireString(payload, "id");
      requireString(payload, "action");
      requireString(payload, "target");
      if (payload.bounded !== true) throw new Error("RemediationProposal must be bounded");
    },
    VerificationReport: () => {
      if (typeof payload.passed !== "boolean" || !Array.isArray(payload.checks)) throw new Error("VerificationReport requires passed and checks");
    },
    RegressionCandidate: () => {
      requireString(payload, "id");
      requireString(payload, "name");
    },
    PolicyCandidate: () => requireString(payload, "id"),
    BacktestReport: () => {
      requireString(payload, "candidate_id");
      if (typeof payload.passed !== "boolean" || !Array.isArray(payload.gates)) throw new Error("BacktestReport requires passed and gates");
    }
  };
  const validate = validators[type];
  if (!validate) throw new Error(`Unsupported agent payload type: ${type}`);
  validate();
}

function requireString(value, field) {
  if (!nonEmptyString(value[field])) throw new Error(`${field} must be a non-empty string`);
}

function requireStringArray(value, field) {
  if (!Array.isArray(value[field]) || value[field].length === 0 || !value[field].every(nonEmptyString)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
}

function requireUnitNumber(value, field) {
  if (typeof value[field] !== "number" || value[field] < 0 || value[field] > 1) throw new Error(`${field} must be between 0 and 1`);
}

function validateTimestamp(value, field) {
  if (!nonEmptyString(value) || Number.isNaN(Date.parse(value))) throw new Error(`Agent proposal has invalid ${field}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) if (item && typeof item === "object" && !Object.isFrozen(item)) deepFreeze(item);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

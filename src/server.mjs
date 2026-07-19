import "./load-env.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.mjs";
import { loadBundle } from "./bundle.mjs";
import { IncidentRuntime } from "./runtime.mjs";
import { runLiveInvestigation } from "./openai.mjs";
import { initializeObservability, shutdownObservability, withAgentControlTrace } from "./observability.mjs";
import { LiveSource } from "./live-source.mjs";
import { CapturedBundleEvidenceSource, InsufficientEvidenceError, LiveOtlpEvidenceSource, summarizeEvidence, versionedChangeEvidence } from "./evidence-source.mjs";
import { investigationFailureEnvelope, localFailureState, projectFailureEpisode, recordInvestigationFailure } from "./investigation-failure.mjs";
import { DevelopmentRuntime } from "./development-runtime.mjs";
import * as developmentAdapter from "./development-adapter.mjs";
import { AgentControlService } from "./agent-control-service.mjs";
import { harnessBinding, loadHarnessManifest } from "./harness-manifest.mjs";
import { AUTONOMY_POLICY_ARTIFACT, validateAutonomyPolicyArtifact } from "./autonomy-policy-artifacts.mjs";
import { failureLockKey, sha256Canonical } from "./autonomy-policy.mjs";
import { FRESHNESS_MAX_AGE_MS, FRESHNESS_RECEIPT_SCHEMA_VERSION, verifySnapshotFreshnessReceipt } from "./autonomy-freshness.mjs";
import { sha256 as hashBoundEvidence } from "./regression-backtest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const dbPath = process.env.FLOWPULSE_DB || join(root, ".flowpulse", "ledger.db");
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "127.0.0.1";
const ledger = new Ledger(dbPath);
const bundle = loadBundle();
const runtime = new IncidentRuntime({ ledger, bundle });
const liveSource = new LiveSource({ directory: process.env.FLOWPULSE_OTLP_DIR || join(root, "outputs", "live", "otel") });
const development = new DevelopmentRuntime({ runtime, source: liveSource, adapter: developmentAdapter });
const capturedEvidence = new CapturedBundleEvidenceSource(bundle);
const snapshots = new Map();
const developmentInvestigations = new Map();
// This key and map intentionally remain module-private. They bind an issued
// receipt to this server's capture and cannot be reconstructed by a request.
const authorityReceiptSecret = randomBytes(32);
const authorityReceiptBindings = new Map();
const CAPTURE_CLOCK_SKEW_MS = 1_000;
runtime.ensureRun();
validateAutonomyPolicyArtifact(AUTONOMY_POLICY_ARTIFACT);
const langfuseEnabled = await initializeObservability().catch(() => {
  console.warn("Langfuse disabled");
  return false;
});
const agentControl = new AgentControlService({ runtime, langfuseEnabled });

const server = createServer(async (request, response) => {
  setHeaders(response);
  if (request.method === "OPTIONS") return send(response, 204, "");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/state" && request.method === "GET") {
      return json(response, 200, await stateWithSource());
    }
    if (url.pathname === "/api/source" && request.method === "GET") {
      return json(response, 200, await sourceProjection(runtime.ensureRun()));
    }
    if (url.pathname === "/api/evidence" && request.method === "GET") {
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || runtime.ensureRun());
      return json(response, 200, { source: source.metadata(), ...source.list({
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        entity: url.searchParams.get("entity") || undefined
      }) });
    }
    if (url.pathname.startsWith("/api/evidence/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/evidence/".length));
      const source = await selectedEvidenceSource(url.searchParams.get("run_id") || runtime.ensureRun());
      return json(response, 200, { source: source.metadata(), evidence: source.detail(id) });
    }
    if (url.pathname === "/api/agent-control" && request.method === "GET") {
      return json(response, 200, agentControl.project(runtime.ensureRun()));
    }
    if (url.pathname === "/api/agent-control/events" && request.method === "GET") {
      return streamAgentEvents(request, response, url);
    }
    if (url.pathname === "/api/agent-control/message" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: "manager-message",
        input: { message: body.message, collaborator_id: body.collaborator_id }
      }, async (trace) => {
        const generation = trace.generation("flowpulse.manager-response", {
          input: { message: body.message, collaborator_id: body.collaborator_id },
          model: process.env.OPENAI_MODEL || "deterministic-ledger-projection",
          metadata: { run_id: runId, authority: "flowpulse-ledger" }
        });
        const result = agentControl.message(runId, body.message, body.collaborator_id);
        generation.update({ output: { intent: result.intent, collaborator_id: result.collaborator_id, message: result.message, citations: result.projection.report.citations } });
        generation.end();
        return result;
      }));
    }
    if (url.pathname === "/api/agent-control/action" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      return json(response, 200, await withAgentControlTrace({
        runId,
        incidentId: runtime.bundle.incident.id,
        action: String(body.action || ""),
        input: { action: body.action, parameters: body.input || {} }
      }, async (trace) => {
        const tool = trace.tool("flowpulse.agent-action", { input: { action: body.action, parameters: body.input || {} }, metadata: { run_id: runId } });
        const projection = agentControl.act(runId, body.action, body.input || {});
        tool.update({ output: { current_agent_id: projection.current_agent_id, last_event_id: projection.last_event_id } });
        tool.end();
        return projection;
      }));
    }
    if (url.pathname === "/api/development/status" && request.method === "GET") {
      return json(response, 200, await developmentAdapter.developmentStatus());
    }
    if (url.pathname === "/api/development/setup" && request.method === "POST") {
      requireJson(request);
      return json(response, 200, await developmentAdapter.setupDevelopment());
    }
    if (url.pathname === "/api/development/start" && request.method === "POST") {
      requireJson(request);
      return json(response, 200, await developmentAdapter.startDevelopment());
    }
    if (url.pathname === "/api/development/case" && request.method === "POST") {
      requireJson(request);
      const runId = await development.start();
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/investigate" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      if (!isEmptyObject(body)) return json(response, 409, { error: "Development investigation accepts no caller authority input" });
      const runId = runtime.ensureRun();
      try {
        await singleFlightDevelopmentInvestigation(runId);
        return json(response, 200, await stateWithSource(runId));
      } catch (error) {
        const failure = recordInvestigationFailure({
          runtime,
          runId,
          error,
          failedType: "development.investigation.failed",
          actor: "development-evaluator"
        });
        return json(response, failure.httpStatus, investigationFailureEnvelope(failure, localFailureState(runtime, runId)));
      }
    }
    if (url.pathname === "/api/development/approve" && request.method === "POST") {
      requireJson(request);
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      const owner = approvalOwner(body);
      if (!owner) return json(response, 409, { error: "An explicit bounded owner is required" });
      await approveDevelopmentAfterAuthority({ run_id: runId, incident_id: runtime.bundle.incident.id, intent_id: "checkout-payment", owner });
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/development/verify" && request.method === "POST") {
      requireJson(request);
      const runId = runtime.ensureRun();
      await development.verify(runId);
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/reset" && request.method === "POST") {
      const runId = runtime.startRun();
      return json(response, 201, await stateWithSource(runId));
    }
    if (url.pathname === "/api/next" && request.method === "POST") {
      const runId = runtime.ensureRun();
      agentControl.advance(runId, "timeline-advance");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const body = await readJson(request);
      const runId = runtime.ensureRun();
      if (runMode(runId) === "development") return json(response, 409, { error: "Development approval requires the canonical development Owner Gate" });
      runtime.approve(runId, body.owner || "Incident owner");
      return json(response, 200, await stateWithSource(runId));
    }
    if (url.pathname === "/api/live" && request.method === "POST") {
      const runId = runtime.startRun("live");
      try {
        const snapshot = await freezeLiveEvidence(runId);
        const result = await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot });
        return json(response, 200, { result, state: await stateWithSource(runId) });
      } catch (error) {
        const failure = recordInvestigationFailure({ runtime, runId, error, failedType: "live.run.failed", actor: "live-evaluator" });
        return json(response, failure.httpStatus, investigationFailureEnvelope(failure, localFailureState(runtime, runId)));
      }
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      const source = await liveSource.project();
      return json(response, 200, { ok: true, ledger: "sqlite-append-only", agent_control: "ledger-governed-agent-team-harness", langfuse: langfuseEnabled, source: source.status });
    }
    if (request.method !== "GET") return json(response, 404, { error: "Not found" });
    return serveStatic(url.pathname, response);
  } catch (error) {
    const message = error?.message?.startsWith("application/json is required")
      ? "application/json is required"
      : error?.message?.includes("Unknown evidence id")
        ? "Not found"
        : "Request could not be completed";
    const status = message === "Not found" ? 404 : message === "application/json is required" ? 409 : 500;
    return json(response, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`FlowPulse ready at http://${host}:${port}`);
  console.log(`Mode: deterministic replay${process.env.OPENAI_API_KEY ? " + live GPT-5.6" : ""}${langfuseEnabled ? " + Langfuse" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await shutdownObservability().catch(() => {});
    process.exit(0);
  });
}

// The following boundary is intentionally local to this server module. It is
// invoked only after an investigator has persisted diagnosis.gate.passed; no
// route, model tool, fixture, or client can import a decision provider.
async function singleFlightDevelopmentInvestigation(runId) {
  const existing = developmentInvestigations.get(runId);
  if (existing) return existing;
  const work = (async () => {
    const existingGate = ledger.list(runId).some((event) => event.type === "diagnosis.gate.passed");
    const snapshot = snapshots.get(runId) || await freezeLiveEvidence(runId);
    if (!existingGate) {
      if (process.env.OPENAI_API_KEY) await runLiveInvestigation({ runtime, runId, evidenceSource: snapshot, repairContract: development.repairContract(runId) });
      else await development.investigate(runId, snapshot);
    }
    await advanceAutonomyAfterDiagnosis({ run_id: runId, incident_id: runtime.bundle.incident.id, intent_id: "checkout-payment" });
  })();
  developmentInvestigations.set(runId, work);
  try {
    return await work;
  } finally {
    if (developmentInvestigations.get(runId) === work) developmentInvestigations.delete(runId);
  }
}

async function approveDevelopmentAfterAuthority({ run_id, incident_id, intent_id, owner }) {
  const decision = await advanceAutonomyAfterDiagnosis({ run_id, incident_id, intent_id });
  if (decision?.payload?.outcome !== "human_review_required") throw autonomyFailure("owner_gate_not_actionable", "autonomy.decision.recorded");
  const events = ledger.list(run_id);
  const request = events.find((event) => event.type === "approval.requested" && event.payload?.decision_id === decision.id);
  const proposal = events.find((event) => event.type === "repair.proposed" && event.payload?.decision_id === decision.id);
  if (!request || !proposal || !exactFullContract(request.payload, decision.payload.contract) || !exactFullContract(proposal.payload, decision.payload.contract)) {
    throw autonomyFailure("owner_gate_contract_invalid", "approval.requested");
  }
  const claim = claimCanonicalDevelopmentApproval({ run_id, incident_id, intent_id, owner, decision, proposal, request });
  return executeCanonicalDevelopmentApproval({ run_id, decision, proposal, request, approval: claim });
}

async function advanceAutonomyAfterDiagnosis({ run_id, incident_id, intent_id }) {
  assertAutonomySelector({ run_id, incident_id, intent_id });
  validateAutonomyPolicyArtifact(AUTONOMY_POLICY_ARTIFACT);
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intent_id);
  if (!intent) throw autonomyFailure("unknown_intent", "intent_id");
  const manifest = captureAuthoritySnapshot({ run_id, incident_id, intent_id });
  const events = ledger.list(run_id);
  const now = trustedNow();
  const validated = validateAuthorityPrerequisites({ events, manifest, intent, now, incident_id, run_id });
  const issued = issueAuthorityFreshnessReceipt({ run_id, incident_id, intent_id, manifest, validated });
  verifyAuthorityReceipt({ receipt: issued.receipt, binding: issued.binding, manifest, validated, now });
  const locks = readAuthorityLocks({ incident_id, run_id, contract_sha256: validated.contract_sha256, target: intent.contract.target });
  const decision = buildAuthorityDecision({ run_id, incident_id, intent, manifest, validated, receipt: issued.receipt, locks });
  return appendDecisionAndPendingOwnerContract({ decision, validated, intent });
}

function captureAuthoritySnapshot({ run_id, incident_id, intent_id }) {
  const snapshot = snapshots.get(run_id);
  if (!snapshot || typeof snapshot.metadata !== "function" || !Array.isArray(snapshot.records)) throw autonomyFailure("snapshot_unavailable", "snapshot");
  const metadata = snapshot.metadata();
  if (metadata.mode !== "frozen_real_otlp_snapshot" || metadata.run_id !== run_id || metadata.incident_id !== incident_id || metadata.source_status !== "live") {
    throw autonomyFailure("snapshot_scope_or_source_invalid", "snapshot.metadata");
  }
  const snapshotRecords = new Map();
  const records = snapshot.records.map((record) => {
    const summary = summarizeEvidence(record);
    snapshotRecords.set(record.id, record);
    return {
      id: record.id,
      sha256: record.provenance?.sha256 || record.hash,
      source: record.source,
      mode: metadata.mode,
      summary_sha256: hashBoundEvidence(summary)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!records.length || records.some((record) => !validHash(record.sha256) || !validHash(record.summary_sha256) || !boundedText(record.id, 160) || !boundedText(record.source, 240))) throw autonomyFailure("snapshot_manifest_invalid", "snapshot.records");
  const expectedIds = [...metadata.evidence_ids].sort();
  if (expectedIds.length !== records.length || expectedIds.some((id, index) => id !== records[index].id)) throw autonomyFailure("snapshot_manifest_drift", "snapshot.evidence_ids");
  const core = { id: snapshot.id, content_sha256: metadata.content_hash, mode: metadata.mode, records };
  const frozenAt = timestamp(metadata.frozen_at);
  const sourceObservedAt = timestamp(metadata.source_last_observed_at);
  if (!boundedText(intent_id, 120) || !frozenAt || !sourceObservedAt || sourceObservedAt - frozenAt > CAPTURE_CLOCK_SKEW_MS || !validHash(core.content_sha256)) throw autonomyFailure("snapshot_manifest_invalid", "snapshot.metadata");
  const captureFrozenAt = new Date(Math.max(frozenAt, sourceObservedAt)).toISOString();
  return { ...core, manifest_sha256: sha256Canonical(core), frozen_at: captureFrozenAt, source_observed_at: metadata.source_last_observed_at, snapshot_records: snapshotRecords };
}

function issueAuthorityFreshnessReceipt({ run_id, incident_id, intent_id, manifest, validated }) {
  // A receipt describes the server-owned capture, never a decision-time refresh.
  const observed_at = manifest.frozen_at;
  const expires_at = new Date(timestamp(observed_at) + FRESHNESS_MAX_AGE_MS).toISOString();
  const unsigned = {
    schema_version: FRESHNESS_RECEIPT_SCHEMA_VERSION,
    issuer: "flowpulse.authority-composition.v1",
    snapshot_id: manifest.id,
    snapshot_content_sha256: manifest.content_sha256,
    snapshot_manifest_sha256: manifest.manifest_sha256,
    snapshot_mode: manifest.mode,
    source_mode: "live",
    truth_mode: "live",
    observed_at,
    expires_at
  };
  const receipt = { ...unsigned, receipt_sha256: sha256Canonical(unsigned) };
  const binding = authorityBinding({ run_id, incident_id, intent_id, manifest: stripManifest(manifest), validated, artifact: artifactBinding(intent_id), receipt_sha256: receipt.receipt_sha256 });
  authorityReceiptBindings.set(receipt.receipt_sha256, binding);
  return { receipt, binding };
}

function verifyAuthorityReceipt({ receipt, binding, manifest, validated, now }) {
  try {
    verifySnapshotFreshnessReceipt({ receipt, manifest: stripManifest(manifest), now });
  } catch (error) {
    throw autonomyFailure(error?.code || "freshness_receipt_invalid", error?.field_path || "receipt");
  }
  const stored = authorityReceiptBindings.get(receipt.receipt_sha256);
  const expected = authorityBinding({ run_id: validated.run_id, incident_id: validated.incident_id, intent_id: validated.intent_id, manifest: stripManifest(manifest), validated, artifact: artifactBinding(validated.intent_id), receipt_sha256: receipt.receipt_sha256 });
  if (!stored || !binding || !safeEqual(stored, binding) || !safeEqual(stored, expected)) throw autonomyFailure("freshness_receipt_binding_mismatch", "receipt");
}

function validateAuthorityPrerequisites({ events, manifest, intent, now, incident_id, run_id }) {
  if (!Array.isArray(events) || !events.length || events.some((event, index) => !validLedgerEvent(event, incident_id, run_id) || (index && event.sequence <= events[index - 1].sequence))) {
    throw autonomyFailure("ledger_scope_or_sequence_invalid", "events");
  }
  const accepted = events.filter((event) => event.type === "evaluation.accepted");
  const gates = events.filter((event) => event.type === "diagnosis.gate.passed");
  if (accepted.length !== 1 || gates.length !== 1) throw autonomyFailure("authority_gate_count_invalid", "events");
  const evaluation = accepted[0];
  const gate = gates[0];
  const decisionAt = timestamp(now);
  const sourceObservedAt = timestamp(manifest.source_observed_at);
  const frozenAt = timestamp(manifest.frozen_at);
  const evaluationAt = timestamp(evaluation.recorded_at);
  const gateAt = timestamp(gate.recorded_at);
  if (!decisionAt || !sourceObservedAt || !frozenAt || !evaluationAt || !gateAt
    || sourceObservedAt > frozenAt || frozenAt > evaluationAt || evaluationAt > gateAt || gateAt > decisionAt
    || decisionAt - frozenAt >= FRESHNESS_MAX_AGE_MS || evaluation.sequence >= gate.sequence) {
    throw autonomyFailure("authority_gate_order_invalid", "events");
  }
  const payload = evaluation.payload;
  const expectedChecks = ["initiating_change", "temporal_order", "implementation_semantics", "controlled_off_on_contrast", "repeated_direct_failures"];
  if (payload?.accepted !== true || payload.classification !== "confirmed_system_bug" || payload.phase !== "diagnosis_pre_approval" || !expectedChecks.every((key) => payload.gate_checks?.[key] === true) || !Array.isArray(payload.missing_evidence) || payload.missing_evidence.length) {
    throw autonomyFailure("evaluator_not_authoritative", "evaluation.accepted");
  }
  const diagnosis = gate.payload?.accepted?.diagnosis;
  const gateEvaluation = gate.payload?.accepted?.evaluation;
  const refs = gate.payload?.accepted?.evidence_ids;
  const contract = intent.contract;
  const contract_sha256 = sha256Canonical(contract);
  if (!diagnosis || !gateEvaluation || !boundedText(diagnosis.id, 160) || payload.hypothesis_id !== diagnosis.id || !sameCanonicalEvaluation(payload, gateEvaluation) || !Array.isArray(refs) || !sameSet(refs, evaluation.evidence_refs) || !sameSet(refs, payload.counter_evidence_refs) || !sameSet(refs, diagnosis.evidence_refs) || !sameSet(refs, gate.evidence_refs) || !sameSet(payload.counter_evidence_refs, gateEvaluation.counter_evidence_refs)) {
    throw autonomyFailure("authority_evidence_refs_invalid", "diagnosis.gate.passed");
  }
  const change = events.find((event) => event.type === "change.applied")?.payload?.change;
  if (!coreContractMatches(diagnosis.proposed_repair, contract) || !coreContractMatches(gate.payload?.repair_contract, contract) || !contractMatchesCapturedChange(contract, change) || gate.payload?.snapshot?.id !== manifest.id || gate.payload?.snapshot?.content_sha256 !== manifest.content_sha256 || gate.payload?.snapshot?.mode !== manifest.mode) {
    throw autonomyFailure("authority_contract_or_snapshot_mismatch", "diagnosis.gate.passed");
  }
  const manifestById = new Map(manifest.records.map((record) => [record.id, record]));
  if (new Set(refs).size !== refs.length || refs.length === 0 || refs.some((id) => !manifestById.has(id))) throw autonomyFailure("authority_evidence_membership_invalid", "evidence_refs");
  const bindings = gate.payload?.accepted?.evidence_bindings;
  if (!Array.isArray(bindings) || bindings.length !== refs.length || new Set(bindings.map((item) => item?.id)).size !== bindings.length || bindings.some((item) => {
    const record = manifestById.get(item?.id);
    const safeRecord = item?.record;
    const sourceRecord = manifest.snapshot_records.get(item?.id);
    const currentSummary = sourceRecord ? summarizeEvidence(sourceRecord) : null;
    const evidenceHash = currentSummary?.provenance?.sha256 || currentSummary?.hash;
    return !record || !sourceRecord || !validHash(item.sha256) || item.sha256 !== record.summary_sha256 || item.sha256 !== hashBoundEvidence(safeRecord) || record.summary_sha256 !== hashBoundEvidence(currentSummary) || hashBoundEvidence(safeRecord) !== hashBoundEvidence(currentSummary) || evidenceHash !== record.sha256 || currentSummary?.source !== record.source;
  })) throw autonomyFailure("authority_evidence_binding_invalid", "evidence_bindings");
  return {
    run_id, incident_id, intent_id: intent.id, evaluation_event_id: evaluation.id, evaluation_sequence: evaluation.sequence,
    evaluation_payload_sha256: evaluation.payload_sha256, diagnosis_event_id: gate.id, diagnosis_sequence: gate.sequence,
    diagnosis_payload_sha256: gate.payload_sha256, evidence_refs: [...refs].sort(), evidence_bindings: bindings.map((item) => ({ id: item.id, sha256: item.sha256, record_sha256: item.record.provenance?.sha256 || item.record.hash, source: item.record.source, mode: manifest.mode })).sort((a, b) => a.id.localeCompare(b.id)), contract_sha256,
    gate_identity_sha256: sha256Canonical({ evaluator: { id: evaluation.id, sequence: evaluation.sequence, payload_sha256: evaluation.payload_sha256 }, diagnosis_gate: { id: gate.id, sequence: gate.sequence, payload_sha256: gate.payload_sha256 }, evidence_bindings: bindings.map((item) => ({ id: item.id, sha256: item.sha256 })).sort((a, b) => a.id.localeCompare(b.id)), contract_sha256 })
  };
}

function readAuthorityLocks({ incident_id, run_id, contract_sha256, target }) {
  let locks;
  try { locks = ledger.listAutonomyLocks(); } catch { throw autonomyFailure("failure_lock_state_unavailable", "autonomy.locked"); }
  for (const event of locks) {
    const payload = event?.payload;
    const touches = event?.incident_id === incident_id || payload?.incident_id === incident_id;
    if (!touches) continue;
    if (!validLedgerEvent(event, event.incident_id, event.run_id) || !payload || payload.incident_id !== event.incident_id || !boundedText(payload.target, 160) || !validHash(payload.contract_sha256) || payload.lock_key !== failureLockKey({ incident_id: payload.incident_id, contract_sha256: payload.contract_sha256, target: payload.target })) {
      throw autonomyFailure("failure_lock_state_unavailable", "autonomy.locked");
    }
    if (payload.incident_id === incident_id && payload.contract_sha256 === contract_sha256 && payload.target === target) return { blocked: true, event_id: event.id, observed_sequence: locks.at(-1)?.sequence || 0 };
  }
  return { blocked: false, observed_sequence: locks.at(-1)?.sequence || 0 };
}

function buildAuthorityDecision({ run_id, incident_id, intent, manifest, validated, receipt, locks }) {
  const impact = intent.impact?.level;
  const blocked = locks.blocked === true;
  const human = !blocked && (impact !== "low" || intent.id === "checkout-payment");
  const artifact = artifactBinding(intent.id);
  const immutableIdentity = {
    run_id, incident_id, intent_id: intent.id, environment: intent.environment,
    artifact, manifest: stripManifest(manifest), gate_identity_sha256: validated.gate_identity_sha256,
    contract_sha256: validated.contract_sha256, evidence_bindings: validated.evidence_bindings,
    source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: intent.execution_mode,
    lock_event_id: locks.event_id || null, receipt_sha256: receipt.receipt_sha256
  };
  const decision_sha256 = sha256Canonical(immutableIdentity);
  const payload = {
    schema_version: "flowpulse.autonomy.v1", run_id, incident_id, intent_id: intent.id, environment: intent.environment,
    source_health: "live", evidence_mode: "frozen_real_snapshot", execution_mode: intent.execution_mode,
    contract: intent.contract, contract_sha256: validated.contract_sha256, snapshot: stripManifest(manifest),
    receipt_sha256: receipt.receipt_sha256, authority_context_sha256: authorityBinding(immutableIdentity),
    artifact, authority_evidence: {
      evaluator: { id: validated.evaluation_event_id, sequence: validated.evaluation_sequence, payload_sha256: validated.evaluation_payload_sha256 },
      diagnosis_gate: { id: validated.diagnosis_event_id, sequence: validated.diagnosis_sequence, payload_sha256: validated.diagnosis_payload_sha256 },
      refs: validated.evidence_bindings
    },
    outcome: blocked ? "non_actionable" : human ? "human_review_required" : "auto_execute_pre_authorized",
    reason_code: blocked ? "failure_lock_present" : human ? "owner_gate_required" : "preauthorized_low_risk",
    capture_observed_at: manifest.source_observed_at,
    decision_sha256
  };
  return { ...payload, decision_sha256, decision_id: `autonomy-decision-${decision_sha256.slice(0, 32)}` };
}

function appendDecisionAndPendingOwnerContract({ decision, validated, intent }) {
  const inserted = ledger.appendIfAbsent({ id: decision.decision_id, runId: decision.run_id, incidentId: decision.incident_id, type: "autonomy.decision.recorded", actor: "authority-composition", payload: decision, evidenceRefs: validated.evidence_refs, correlationId: decision.decision_id });
  if (!inserted.inserted && !sameCanonicalDecisionEvent(inserted.event, decision, validated.evidence_refs)) throw autonomyFailure("authority_claim_conflict", "decision_id");
  if (decision.outcome === "human_review_required") {
    const ownerGate = canonicalOwnerGate({ decision, intent, evidenceRefs: validated.evidence_refs });
    const proposal = ledger.appendIfAbsent(ownerGate.proposal);
    if (!proposal.inserted && !sameCanonicalOwnerGateEvent(proposal.event, ownerGate.proposal, inserted.event)) throw autonomyFailure("owner_gate_proposal_conflict", "repair.proposed");
    const request = ledger.appendIfAbsent(ownerGate.request);
    if (!request.inserted && !sameCanonicalOwnerGateEvent(request.event, ownerGate.request, proposal.event)) throw autonomyFailure("owner_gate_request_conflict", "approval.requested");
    if (!(inserted.event.sequence < proposal.event.sequence && proposal.event.sequence < request.event.sequence)) throw autonomyFailure("owner_gate_order_invalid", "approval.requested");
  }
  return inserted.event;
}

function canonicalOwnerGate({ decision, intent, evidenceRefs }) {
  const proposalId = `repair-proposed-${decision.decision_sha256.slice(0, 32)}`;
  const requestId = `approval-request-${decision.decision_sha256.slice(0, 32)}`;
  return {
    proposal: {
      id: proposalId,
      runId: decision.run_id,
      incidentId: decision.incident_id,
      type: "repair.proposed",
      actor: "authority-composition",
      payload: { ...intent.contract, bounded: true, decision_id: decision.decision_id, contract_sha256: decision.contract_sha256 },
      evidenceRefs,
      correlationId: decision.decision_id
    },
    request: {
      id: requestId,
      runId: decision.run_id,
      incidentId: decision.incident_id,
      type: "approval.requested",
      actor: "authority-composition",
      payload: { ...intent.contract, owner_team: "local-development", decision_id: decision.decision_id, contract_sha256: decision.contract_sha256, reason: "Consequential checkout remediation requires an explicit owner decision." },
      evidenceRefs,
      correlationId: decision.decision_id,
      parentId: proposalId
    }
  };
}

function claimCanonicalDevelopmentApproval({ run_id, incident_id, intent_id, owner, decision, proposal, request }) {
  assertAutonomySelector({ run_id, incident_id, intent_id });
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intent_id);
  if (!intent || !sameCanonicalDecisionEvent(decision, decision.payload, decision.evidence_refs)) throw autonomyFailure("canonical_decision_invalid", "autonomy.decision.recorded");
  const ownerGate = canonicalOwnerGate({ decision: decision.payload, intent, evidenceRefs: decision.evidence_refs });
  if (!sameCanonicalOwnerGateEvent(proposal, ownerGate.proposal, decision) || !sameCanonicalOwnerGateEvent(request, ownerGate.request, proposal) || !(decision.sequence < proposal.sequence && proposal.sequence < request.sequence)) {
    throw autonomyFailure("owner_gate_contract_or_order_invalid", "approval.requested");
  }
  const locks = readAuthorityLocks({ incident_id, run_id, contract_sha256: decision.payload.contract_sha256, target: intent.contract.target });
  if (locks.blocked) throw autonomyFailure("failure_lock_present", "autonomy.locked");
  const approvalId = `approval-granted-${decision.payload.decision_sha256.slice(0, 32)}`;
  const approvalPayload = { owner, ...decision.payload.contract, scope: "local checkout container only", decision_id: decision.id, contract_sha256: decision.payload.contract_sha256 };
  const inserted = atomicApprovalClaim({
    approvalId,
    approvalPayload,
    decision,
    proposal,
    request,
    observedLockSequence: locks.observed_sequence,
    contract_sha256: decision.payload.contract_sha256,
    target: intent.contract.target,
    lock_key: failureLockKey({ incident_id, contract_sha256: decision.payload.contract_sha256, target: intent.contract.target })
  });
  if (!inserted) throw autonomyFailure("atomic_approval_claim_rejected", "approval.granted");
  const approval = ledger.get(approvalId);
  if (!sameCanonicalApprovalEvent(approval, { approvalId, approvalPayload, decision, request })) throw autonomyFailure("atomic_approval_claim_invalid", "approval.granted");
  return approval;
}

// This is deliberately server-local: only the request that atomically inserted
// the canonical approval may create the one-shot execution-attempt claim.
// A previously seeded approval event is inert because it never reaches here.
async function executeCanonicalDevelopmentApproval({ run_id, decision, proposal, request, approval }) {
  const events = ledger.list(run_id);
  const currentDecision = events.find((event) => event.id === decision.id);
  const currentProposal = events.find((event) => event.id === proposal.id);
  const currentRequest = events.find((event) => event.id === request.id);
  const currentApproval = events.find((event) => event.id === approval.id);
  if (!sameCanonicalDecisionEvent(currentDecision, decision.payload, decision.evidence_refs)
    || !sameCanonicalOwnerGateEvent(currentProposal, canonicalOwnerGate({ decision: decision.payload, intent: intentForDecision(decision), evidenceRefs: decision.evidence_refs }).proposal, currentDecision)
    || !sameCanonicalOwnerGateEvent(currentRequest, canonicalOwnerGate({ decision: decision.payload, intent: intentForDecision(decision), evidenceRefs: decision.evidence_refs }).request, currentProposal)
    || !sameCanonicalApprovalEvent(currentApproval, { approvalId: approval.id, approvalPayload: approval.payload, decision: currentDecision, request: currentRequest })) {
    throw autonomyFailure("canonical_execution_chain_invalid", "approval.granted");
  }
  const attemptPayload = {
    approval_id: approval.id,
    decision_id: decision.id,
    contract_sha256: decision.payload.contract_sha256,
    contract: decision.payload.contract,
    execution_mode: decision.payload.execution_mode
  };
  const attemptId = `repair-execution-attempt-${decision.payload.decision_sha256.slice(0, 32)}`;
  const attempt = ledger.appendIfAbsent({
    id: attemptId,
    runId: run_id,
    incidentId: decision.incident_id,
    type: "repair.execution.attempted",
    actor: "authority-composition",
    payload: attemptPayload,
    evidenceRefs: decision.evidence_refs,
    parentId: approval.id,
    correlationId: decision.id
  });
  if (!attempt.inserted || !sameCanonicalExecutionAttempt(attempt.event, { attemptId, attemptPayload, decision, approval })) {
    throw autonomyFailure("execution_attempt_already_claimed", "repair.execution.attempted");
  }
  const result = await developmentAdapter.executeApprovedRollback({ commandId: decision.payload.contract.command_id });
  const change = development.changeFor(run_id);
  const executedPayload = {
    repair_id: change.repair_id,
    action: decision.payload.contract.action,
    target: decision.payload.contract.target,
    from: change.after,
    to: change.known_good,
    mode: "local-development",
    command_id: result.command_id,
    completed_at: result.completed_at,
    decision_id: decision.id,
    approval_id: approval.id,
    contract_sha256: decision.payload.contract_sha256
  };
  const executed = ledger.appendIfAbsent({
    id: `repair-executed-${decision.payload.decision_sha256.slice(0, 32)}`,
    runId: run_id,
    incidentId: decision.incident_id,
    type: "repair.executed",
    actor: "remediation",
    payload: executedPayload,
    evidenceRefs: decision.evidence_refs,
    parentId: attempt.id,
    correlationId: decision.id
  });
  if (!executed.inserted) throw autonomyFailure("repair_execution_record_conflict", "repair.executed");
  return result;
}

function intentForDecision(decision) {
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((candidate) => candidate.id === decision.payload?.intent_id);
  if (!intent) throw autonomyFailure("canonical_decision_intent_invalid", "autonomy.decision.recorded");
  return intent;
}

function atomicApprovalClaim({ approvalId, approvalPayload, decision, proposal, request, observedLockSequence, contract_sha256, target, lock_key }) {
  const parameters = sqliteParameters({
    approval_id: approvalId,
    approval_payload: JSON.stringify(approvalPayload),
    approval_correlation_id: decision.id,
    decision_id: decision.id,
    decision_payload: JSON.stringify(decision.payload),
    proposal_id: proposal.id,
    proposal_payload: JSON.stringify(proposal.payload),
    request_id: request.id,
    request_payload: JSON.stringify(request.payload),
    run_id: decision.run_id,
    incident_id: decision.incident_id,
    evidence_refs: JSON.stringify(decision.evidence_refs),
    observed_lock_sequence: String(observedLockSequence),
    contract_sha256,
    target,
    lock_key
  });
  const text = (name) => `CAST(@${name} AS TEXT)`;
  const script = `${parameters}
BEGIN IMMEDIATE;
INSERT INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
SELECT ${text("approval_id")}, ${text("run_id")}, ${text("incident_id")}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 'approval.granted', 'owner', ${text("approval_payload")}, ${text("evidence_refs")}, NULL, ${text("approval_correlation_id")}
WHERE EXISTS (SELECT 1 FROM events d WHERE d.id=${text("decision_id")} AND d.run_id=${text("run_id")} AND d.incident_id=${text("incident_id")} AND d.type='autonomy.decision.recorded' AND d.actor='authority-composition' AND d.parent_id IS NULL AND d.correlation_id=${text("decision_id")} AND d.offset_ms=0 AND d.payload_json=${text("decision_payload")} AND d.evidence_refs_json=${text("evidence_refs")})
  AND EXISTS (SELECT 1 FROM events p WHERE p.id=${text("proposal_id")} AND p.run_id=${text("run_id")} AND p.incident_id=${text("incident_id")} AND p.type='repair.proposed' AND p.actor='authority-composition' AND p.parent_id IS NULL AND p.correlation_id=${text("decision_id")} AND p.offset_ms=0 AND p.payload_json=${text("proposal_payload")} AND p.evidence_refs_json=${text("evidence_refs")})
  AND EXISTS (SELECT 1 FROM events r WHERE r.id=${text("request_id")} AND r.run_id=${text("run_id")} AND r.incident_id=${text("incident_id")} AND r.type='approval.requested' AND r.actor='authority-composition' AND r.parent_id=${text("proposal_id")} AND r.correlation_id=${text("decision_id")} AND r.offset_ms=0 AND r.payload_json=${text("request_payload")} AND r.evidence_refs_json=${text("evidence_refs")})
  AND (SELECT sequence FROM events WHERE id=${text("decision_id")}) < (SELECT sequence FROM events WHERE id=${text("proposal_id")})
  AND (SELECT sequence FROM events WHERE id=${text("proposal_id")}) < (SELECT sequence FROM events WHERE id=${text("request_id")})
  AND NOT EXISTS (SELECT 1 FROM events WHERE run_id=${text("run_id")} AND type='approval.granted')
  AND NOT EXISTS (SELECT 1 FROM events l
    WHERE l.type='autonomy.locked'
      AND l.sequence > CAST(@observed_lock_sequence AS INTEGER)
      AND (l.incident_id=${text("incident_id")} OR json_extract(l.payload_json,'$.incident_id')=${text("incident_id")})
      AND (
        l.incident_id != ${text("incident_id")}
        OR json_extract(l.payload_json,'$.incident_id') != ${text("incident_id")}
        OR json_type(l.payload_json,'$.contract_sha256') != 'text'
        OR json_type(l.payload_json,'$.target') != 'text'
        OR json_type(l.payload_json,'$.lock_key') != 'text'
        OR (json_extract(l.payload_json,'$.contract_sha256')=${text("contract_sha256")}
          AND json_extract(l.payload_json,'$.target')=${text("target")}
          AND json_extract(l.payload_json,'$.lock_key') != ${text("lock_key")})
        OR (json_extract(l.payload_json,'$.contract_sha256')=${text("contract_sha256")}
          AND json_extract(l.payload_json,'$.target')=${text("target")}
          AND json_extract(l.payload_json,'$.lock_key')=${text("lock_key")})
      ));
SELECT changes() AS approval_inserted;
INSERT OR ROLLBACK INTO events (id, run_id, incident_id, recorded_at, offset_ms, type, actor, payload_json, evidence_refs_json, parent_id, correlation_id)
SELECT ${text("decision_id")}, ${text("run_id")}, ${text("incident_id")}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 'approval.guard', 'authority-composition', '{}', '[]', NULL, ${text("decision_id")}
WHERE changes() = 1
  AND EXISTS (SELECT 1 FROM events l
    WHERE l.type='autonomy.locked'
      AND l.sequence > CAST(@observed_lock_sequence AS INTEGER)
      AND (l.incident_id=${text("incident_id")} OR json_extract(l.payload_json,'$.incident_id')=${text("incident_id")})
      AND (
        l.incident_id != ${text("incident_id")}
        OR json_extract(l.payload_json,'$.incident_id') != ${text("incident_id")}
        OR json_type(l.payload_json,'$.contract_sha256') != 'text'
        OR json_type(l.payload_json,'$.target') != 'text'
        OR json_type(l.payload_json,'$.lock_key') != 'text'
        OR (json_extract(l.payload_json,'$.contract_sha256')=${text("contract_sha256")}
          AND json_extract(l.payload_json,'$.target')=${text("target")}
          AND json_extract(l.payload_json,'$.lock_key') != ${text("lock_key")})
        OR (json_extract(l.payload_json,'$.contract_sha256')=${text("contract_sha256")}
          AND json_extract(l.payload_json,'$.target')=${text("target")}
          AND json_extract(l.payload_json,'$.lock_key')=${text("lock_key")})
      ));
COMMIT;
`;
  try {
    const output = ledger.exec(script).trim().split(/\s+/).filter(Boolean);
    return output[0] === "1";
  } catch {
    return false;
  }
}

function sqliteParameters(values) {
  return [".parameter init", ...Object.entries(values).map(([name, value]) => `.parameter set @${name} X'${Buffer.from(String(value), "utf8").toString("hex")}'`)].join("\n");
}

function assertAutonomySelector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "incident_id,intent_id,run_id" || !boundedText(value.run_id, 160) || !boundedText(value.incident_id, 160) || !boundedText(value.intent_id, 120)) throw autonomyFailure("authority_selector_invalid", "selector");
}
function artifactBinding(intentId) {
  const intent = AUTONOMY_POLICY_ARTIFACT.intents.find((item) => item.id === intentId);
  if (!intent) throw autonomyFailure("unknown_intent", "intent_id");
  return {
    schema_version: AUTONOMY_POLICY_ARTIFACT.schema_version,
    version: AUTONOMY_POLICY_ARTIFACT.version,
    registry_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT.registry),
    intent_sha256: sha256Canonical(intent),
    envelope_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT.registry.envelopes.filter((envelope) => envelope.action_contract.repair_id === intent.contract.repair_id)),
    artifact_sha256: sha256Canonical(AUTONOMY_POLICY_ARTIFACT)
  };
}
function stripManifest(manifest) { return { id: manifest.id, content_sha256: manifest.content_sha256, mode: manifest.mode, records: manifest.records, manifest_sha256: manifest.manifest_sha256 }; }
function authorityBinding(value) { return createHmac("sha256", authorityReceiptSecret).update(sha256Canonical(value), "utf8").digest("hex"); }
function safeEqual(left, right) { return typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function trustedNow() { return new Date().toISOString(); }
function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : null; }
function boundedText(value, bytes) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= bytes; }
function validLedgerEvent(event, incident_id, run_id) { return event && event.incident_id === incident_id && event.run_id === run_id && Number.isInteger(event.sequence) && event.sequence > 0 && boundedText(event.id, 200) && boundedText(event.recorded_at, 40) && validHash(event.payload_sha256) && Array.isArray(event.evidence_refs); }
function sameSet(left, right) { return Array.isArray(left) && Array.isArray(right) && new Set(left).size === left.length && new Set(right).size === right.length && left.length === right.length && [...left].every((item) => right.includes(item)); }
function sameOrderedRefs(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]); }
function sameCanonicalDecisionEvent(event, decision, evidenceRefs) {
  return Boolean(event && event.id === decision.decision_id && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "autonomy.decision.recorded" && event.actor === "authority-composition" && event.parent_id == null && event.correlation_id === decision.decision_id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, evidenceRefs) && sha256Canonical(event.payload) === sha256Canonical(decision));
}
function sameCanonicalOwnerGateEvent(event, candidate, parent) {
  return Boolean(event && event.id === candidate.id && event.run_id === candidate.runId && event.incident_id === candidate.incidentId && event.type === candidate.type && event.actor === candidate.actor && event.parent_id === (candidate.parentId || null) && event.correlation_id === candidate.correlationId && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, candidate.evidenceRefs) && sha256Canonical(event.payload) === sha256Canonical(candidate.payload) && Number.isInteger(parent?.sequence) && parent.sequence < event.sequence);
}
function sameCanonicalApprovalEvent(event, { approvalId, approvalPayload, decision, request }) {
  return Boolean(event && event.id === approvalId && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "approval.granted" && event.actor === "owner" && event.parent_id == null && event.correlation_id === decision.id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, decision.evidence_refs) && sha256Canonical(event.payload) === sha256Canonical(approvalPayload) && request.sequence < event.sequence);
}
function sameCanonicalExecutionAttempt(event, { attemptId, attemptPayload, decision, approval }) {
  return Boolean(event && event.id === attemptId && event.run_id === decision.run_id && event.incident_id === decision.incident_id && event.type === "repair.execution.attempted" && event.actor === "authority-composition" && event.parent_id === approval.id && event.correlation_id === decision.id && event.offset_ms === 0 && timestamp(event.recorded_at) && sameOrderedRefs(event.evidence_refs, decision.evidence_refs) && sha256Canonical(event.payload) === sha256Canonical(attemptPayload));
}
function coreContractMatches(value, contract) {
  return Boolean(value && Object.keys(value).every((key) => ["repair_id", "action", "target", "command_id", "reason"].includes(key)) && ["repair_id", "action", "target", "command_id"].every((key) => value[key] === contract[key]) && (!Object.hasOwn(value, "reason") || boundedText(value.reason, 2_048)));
}
function exactFullContract(value, contract) {
  return Boolean(value && contract && ["repair_id", "action", "target", "command_id", "expected_before", "expected_after"].every((key) => value[key] === contract[key]));
}
function contractMatchesCapturedChange(contract, change) {
  return Boolean(change && contract.repair_id === change.repair_id && contract.target === change.target && contract.command_id === change.repair_command_id && contract.action === `restore known-good ${change.flag} flag and recreate checkout` && contract.expected_before === `${change.flag}=${change.after}` && contract.expected_after === `${change.flag}=${change.known_good}`);
}
function sameCanonicalEvaluation(eventPayload, gatePayload) {
  const keys = ["accepted", "score", "classification", "phase", "gate_checks", "reason", "missing_evidence", "counter_evidence_refs"];
  if (!eventPayload || !gatePayload || Object.keys(gatePayload).sort().join(",") !== keys.sort().join(",")) return false;
  return sha256Canonical(Object.fromEntries(keys.map((key) => [key, eventPayload[key]]))) === sha256Canonical(gatePayload);
}
function isEmptyObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0); }
function approvalOwner(value) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && boundedText(value.owner, 160) ? value.owner : null; }
function runMode(runId) { return ledger.list(runId).find((event) => event.type === "run.started")?.payload?.mode || null; }
function autonomyFailure(code, field_path) { const error = new InsufficientEvidenceError("Autonomy authority boundary rejected the run"); error.code = code; error.metadata = { stage: "authority_decision", validator_id: "server_authority_closure", reason_code: code, field_path, next_precondition: "produce_a_matching_frozen_diagnosis_gate" }; return error; }

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, "");
  const path = join(publicDir, safe);
  if (!path.startsWith(publicDir)) return json(response, 404, { error: "Not found" });
  try {
    const body = await readFile(path);
    response.writeHead(200, { "content-type": mime(extname(path)), "cache-control": "no-store" });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function requireJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("application/json is required for local development actions");
  }
}

function setHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:");
}

function json(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function mime(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[extension] || "application/octet-stream";
}

async function stateWithSource(runId = runtime.ensureRun()) {
  const projected = runtime.state(runId);
  const referenced = new Set(projected.events.flatMap((event) => event.evidence_refs));
  const source = await selectedEvidenceSource(runId);
  return {
    ...projected,
    evidence: source.summariesById(referenced),
    source: await sourceProjection(runId, source),
    agent_control: agentControl.project(runId),
    harness: harnessProjection(projected.events)
  };
}

async function selectedEvidenceSource(runId = runtime.ensureRun()) {
  if (snapshots.has(runId)) return snapshots.get(runId);
  const mode = runtime.state(runId).mode;
  if (mode === "replay") return capturedEvidence;
  return new LiveOtlpEvidenceSource(await liveSource.project());
}

async function sourceProjection(runId = runtime.ensureRun(), source = null) {
  const selected = source || await selectedEvidenceSource(runId);
  const project = await liveSource.project();
  const metadata = selected.metadata();
  return {
    ...metadata,
    kind: "otlp-jsonl",
    live_status: project.status,
    last_observed_at: project.last_observed_at,
    freshness_ms: project.freshness_ms,
    counts: project.counts,
    topology: project.topology,
    errors: project.errors,
    evidence: selected.list({ limit: 50 }).items,
    raw_records_excluded: true
  };
}

async function freezeLiveEvidence(runId) {
  const harness = harnessBinding(loadHarnessManifest());
  let live = new LiveOtlpEvidenceSource(await liveSource.project());
  const runEvents = runtime.ledger.list(runId);
  const applied = runEvents.find((event) => event.type === "change.applied");
  const after = applied?.payload.applied_at;
  const supplementalRecords = [];
  if (applied) {
    const baselineCapture = runEvents.find((event) => event.type === "diagnosis.baseline.captured");
    const codeCapture = runEvents.find((event) => event.type === "code.semantics.captured");
    const baseline = baselineCapture?.payload?.evidence;
    const code = codeCapture?.payload?.evidence;
    const verifiedCode = await developmentAdapter.readPinnedCheckoutCodeEvidence();
    const baselineMatchesCapture = Boolean(baseline
      && baselineCapture?.payload?.evidence_id
      && baselineCapture?.payload?.evidence_hash
      && baseline.id === baselineCapture.payload.evidence_id
      && (baseline.provenance?.sha256 || baseline.hash) === baselineCapture.payload.evidence_hash);
    const codeMatchesCapture = Boolean(code
      && codeCapture?.payload?.evidence_id
      && codeCapture?.payload?.evidence_hash
      && code.id === codeCapture.payload.evidence_id
      && (code.provenance?.sha256 || code.hash) === codeCapture.payload.evidence_hash
      && verifiedCode.id === code.id
      && (verifiedCode.provenance?.sha256 || verifiedCode.hash) === (code.provenance?.sha256 || code.hash));
    if (!baselineMatchesCapture || !codeMatchesCapture) {
      throw new InsufficientEvidenceError("Development snapshot cannot recover the exact pre-change baseline and pinned code evidence", {
        stage: "diagnosis_gate",
        attempt: 0,
        round: 0,
        validator_id: "snapshot_integrity_binding",
        field_path: "diagnosis.baseline.captured",
        reason_code: "captured_baseline_or_code_integrity_mismatch",
        missing_evidence_classes: ["immutable_baseline_or_code_semantics"],
        next_precondition: "capture_matching_baseline_and_pinned_code_evidence"
      });
    }
    const changeEvidence = versionedChangeEvidence({
      manifest: applied.payload.change,
      applied: applied.payload,
      ledgerEvent: applied
    });
    const collected = await development.collectDiagnosisEvidence(runId, { baseline, code, changeEvidence });
    live = new LiveOtlpEvidenceSource(collected.project);
    supplementalRecords.push(...collected.records, changeEvidence);
  }
  const snapshot = live.freeze({ incidentId: bundle.incident.id, runId, after, supplementalRecords, executable: Boolean(applied), harness });
  snapshots.set(runId, snapshot);
  const metadata = snapshot.metadata();
  runtime.append(runId, "evidence.snapshot.created", "runtime", {
    snapshot_id: snapshot.id,
    mode: metadata.mode,
    source_hash: metadata.source_hash,
    content_hash: metadata.content_hash,
    record_count: metadata.record_count,
    source_record_count: metadata.source_record_count,
    bytes: metadata.bytes,
    caps: metadata.caps,
    truncated: metadata.truncated,
    reserved_causal_ids: metadata.reserved_causal_ids,
    frozen_at: metadata.frozen_at,
    harness
  }, snapshot.snapshot.evidence_ids);
  return snapshot;
}

function harnessProjection(events = []) {
  const contextual = [...events].reverse().find((event) => event.type === "context.compiled");
  const bound = [...events].reverse().find((event) => event.payload?.harness)?.payload?.harness || null;
  const failure = projectFailureEpisode(events);
  return {
    manifest: bound ? {
      version: bound.version || null,
      sha256: bound.manifest_sha256 || null
    } : { legacy_detail_status: "legacy_detail_unavailable" },
    current_stage: contextual?.payload?.stage || failure.stage || null,
    attempt: contextual?.payload?.attempt ?? failure.attempt ?? null,
    last_context_sha256: contextual?.payload?.context_sha256 || failure.context_sha256 || null,
    failure: {
      legacy_detail_status: failure.legacy_detail_status,
      boundary: failure.stage || null,
      validator_id: failure.validator_id || null,
      reason_code: failure.reason_code || null,
      tool_coverage: failure.tool_coverage || [],
      missing_evidence_classes: failure.missing_evidence_classes || [],
      next_precondition: failure.next_precondition || null
    }
  };
}

function streamAgentEvents(request, response, url) {
  const runId = url.searchParams.get("run_id") || runtime.ensureRun();
  let lastSequence = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const sendProjection = () => {
    const projection = agentControl.project(runId);
    if (projection.last_sequence <= lastSequence) return;
    lastSequence = projection.last_sequence;
    response.write(`id: ${lastSequence}\nevent: agent-control\ndata: ${JSON.stringify(projection)}\n\n`);
  };
  sendProjection();
  const interval = setInterval(() => {
    if (response.destroyed) return;
    sendProjection();
    response.write(": heartbeat\n\n");
  }, 1_000);
  request.on("close", () => clearInterval(interval));
}

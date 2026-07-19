import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { localFailureState, projectFailureEpisode, recordInvestigationFailure } from "../src/investigation-failure.mjs";
import { harnessBinding, loadHarnessManifest } from "../src/harness-manifest.mjs";
import { Ledger } from "../src/ledger.mjs";
import { CausalEvidenceError } from "../src/openai.mjs";
import { ModelOutputInvalidError } from "../src/openai-response.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

test("development GPT causal failures classify once and never create repair or approval events", () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-investigation-failure-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun("development");
  const secret = "provider-body-secret call-raw encrypted-reasoning";
  const error = new CausalEvidenceError("Diagnosis lacks the exact cited change and post-change failure evidence required for executable repair", "insufficient_evidence", {
    stage: "diagnosis_gate", attempt: 2, round: 3, validator_id: "five_part_diagnosis_gate", field_path: "diagnosis.evidence_refs",
    reason_code: "diagnosis_gate_evidence_missing", tool_coverage: [{ tool: "query_traces", entity: "checkout", attempt: 2, round: 3, result_count: 3, selected_count: 3, context_sha256: "a".repeat(64) }],
    selected_evidence_refs: ["ev-change", "ev-trace"], omitted_evidence_refs: [{ id: "ev-log", reason: "tool_record_cap" }],
    missing_evidence_classes: ["pinned_code_semantics"], next_precondition: "query_complete_diagnosis_gate_evidence", context_sha256: "a".repeat(64),
    harness: harnessBinding(loadHarnessManifest()), raw_model_text: secret, call_id: secret
  });
  const failure = recordInvestigationFailure({
    runtime,
    runId,
    error,
    failedType: "development.investigation.failed",
    actor: "development-evaluator"
  });
  assert.equal(failure.classification, "insufficient_evidence");
  assert.match(failure.failureId, /^failure-/);
  const events = runtime.ledger.list(runId);
  assert.equal(events.filter((event) => event.type === "outcome.classified").length, 1);
  assert.equal(events.filter((event) => event.type === "development.investigation.failed").length, 1);
  assert.equal(events.filter((event) => event.type === "failure.episode.recorded").length, 1);
  const episode = projectFailureEpisode(events);
  assert.deepEqual({ stage: episode.stage, attempt: episode.attempt, round: episode.round, validator_id: episode.validator_id, reason_code: episode.reason_code }, {
    stage: "diagnosis_gate", attempt: 2, round: 3, validator_id: "five_part_diagnosis_gate", reason_code: "diagnosis_gate_evidence_missing"
  });
  assert.equal(episode.legacy_detail_status, "available");
  assert.equal(episode.harness.manifest_sha256, harnessBinding(loadHarnessManifest()).manifest_sha256);
  assert.equal(Buffer.byteLength(JSON.stringify(events.find((event) => event.type === "failure.episode.recorded").payload.episode), "utf8") <= 12 * 1024, true);
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(events.every((event) => !JSON.stringify(event).includes(error.message)), true);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested"), false);
});

test("failure audit insertion is idempotent across concurrent writers", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flowpulse-investigation-atomic-")), "ledger.db");
  const bundle = loadBundle();
  const runtimes = [0, 1].map(() => new IncidentRuntime({ ledger: new Ledger(path), bundle }));
  const runId = "run-atomic";
  runtimes[0].append(runId, "run.started", "runtime", { mode: "live" });
  const results = await Promise.all(runtimes.map((runtime) => Promise.resolve(recordInvestigationFailure({
    runtime,
    runId,
    error: new CausalEvidenceError("safe causal failure"),
    failedType: "live.run.failed",
    actor: "live-evaluator"
  }))));
  assert.equal(results[0].failureId, results[1].failureId);
  const events = runtimes[0].ledger.list(runId);
  assert.equal(events.filter((event) => event.type === "outcome.classified").length, 1);
  assert.equal(events.filter((event) => event.type === "live.run.failed").length, 1);
  assert.equal(events.filter((event) => event.type === "failure.episode.recorded").length, 1);
});

test("model response failures receive a bounded structured episode without model output", () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-model-episode-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun("live");
  const failure = recordInvestigationFailure({
    runtime,
    runId,
    error: new ModelOutputInvalidError("structured_output_invalid", { stage: "evaluator", raw_text: "seeded-secret", response_id: "resp-secret" }),
    failedType: "live.run.failed"
  });
  const episode = runtime.ledger.list(runId).find((event) => event.type === "failure.episode.recorded");
  assert.equal(failure.failureId, episode.payload.failure_id);
  assert.equal(episode.payload.episode.stage, "evaluator");
  assert.equal(episode.payload.episode.validator_id, "structured_output_invalid");
  assert.equal(episode.payload.episode.field_path, "response.output");
  assert.equal(JSON.stringify(episode).includes("seeded-secret"), false);
  assert.equal(JSON.stringify(episode).includes("resp-secret"), false);
});

test("local failure state stays bounded when a normal state projection is unavailable", () => {
  const runtime = {
    bundle: { incident: { id: "incident-local", title: "Bounded incident", severity: "SEV-2", environment: "local" } },
    ledger: {
      list: () => [
        { sequence: 1, type: "run.started", recorded_at: "2026-07-18T00:00:00.000Z", payload: { mode: "live" } },
        { sequence: 2, type: "live.run.failed", recorded_at: "2026-07-18T00:00:01.000Z", payload: { secret: "must-not-leak" } }
      ]
    },
    state() { throw new Error("source projection failure: must-not-leak"); }
  };
  const state = localFailureState(runtime, "run-local");
  assert.equal(state.status, "degraded");
  assert.equal(state.source.status, "unavailable");
  assert.equal(state.agent_control.status, "unavailable");
  assert.equal(state.event_count, 2);
  assert.equal(JSON.stringify(state).includes("must-not-leak"), false);
  assert.equal(state.harness.failure.legacy_detail_status, "legacy_detail_unavailable");
});

test("legacy failure rows remain immutable and project as unavailable detail rather than inferred current diagnostics", () => {
  const detail = projectFailureEpisode([{ type: "development.investigation.failed", payload: { classification: "insufficient_evidence" } }]);
  assert.deepEqual(detail, { legacy_detail_status: "legacy_detail_unavailable" });
});

test("maximum legal failure metadata keeps the causal boundary while truncating optional detail", () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-failure-size-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun("development");
  const harness = harnessBinding(loadHarnessManifest());
  const selected = Array.from({ length: 120 }, (_, index) => `ev-selected-${String(index).padStart(3, "0")}-${"a".repeat(130)}`);
  const omitted = Array.from({ length: 120 }, (_, index) => ({ id: `ev-omitted-${String(index).padStart(3, "0")}-${"b".repeat(131)}`, reason: "tool_byte_cap" }));
  const coverage = Array.from({ length: 24 }, (_, index) => ({
    tool: `query_traces_${"t".repeat(60)}`, entity: `checkout-${"e".repeat(100)}`, attempt: 2, round: index,
    result_count: 32, selected_count: 32, omitted_count: 120, context_sha256: "c".repeat(64)
  }));
  const failure = recordInvestigationFailure({
    runtime,
    runId,
    error: new CausalEvidenceError("large safe metadata", "insufficient_evidence", {
      stage: "diagnosis_gate", attempt: 2, round: 3, validator_id: "five_part_diagnosis_gate", field_path: "diagnosis.evidence_refs",
      reason_code: "diagnosis_gate_evidence_missing", next_precondition: "query_complete_diagnosis_gate_evidence",
      context_sha256: "d".repeat(64), harness, tool_coverage: coverage,
      selected_evidence_refs: selected, omitted_evidence_refs: omitted,
      missing_evidence_classes: Array.from({ length: 8 }, (_, index) => `missing_${index}`)
    }),
    failedType: "development.investigation.failed"
  });
  const events = runtime.ledger.list(runId);
  const episode = events.find((event) => event.type === "failure.episode.recorded");
  assert.equal(events.filter((event) => event.type === "failure.episode.recorded").length, 1);
  assert.equal(failure.failureId, episode.payload.failure_id);
  assert.equal(Buffer.byteLength(JSON.stringify(episode.payload.episode), "utf8") <= 12 * 1024, true);
  assert.deepEqual({
    stage: episode.payload.episode.stage,
    attempt: episode.payload.episode.attempt,
    round: episode.payload.episode.round,
    validator_id: episode.payload.episode.validator_id,
    field_path: episode.payload.episode.field_path,
    reason_code: episode.payload.episode.reason_code,
    next_precondition: episode.payload.episode.next_precondition,
    manifest: episode.payload.episode.harness.manifest_sha256,
    context: episode.payload.episode.context_sha256
  }, {
    stage: "diagnosis_gate", attempt: 2, round: 3, validator_id: "five_part_diagnosis_gate", field_path: "diagnosis.evidence_refs",
    reason_code: "diagnosis_gate_evidence_missing", next_precondition: "query_complete_diagnosis_gate_evidence",
    manifest: harness.manifest_sha256, context: "d".repeat(64)
  });
  assert.equal(Object.values(episode.payload.episode.episode_truncation).some((count) => count > 0), true);
});

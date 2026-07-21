import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ledger } from "../src/ledger.mjs";
import { LOCAL_FAULT_LOOP_CASES, LOCAL_FAULT_LOOP_SCHEMA_VERSION, LocalFaultLoop, LocalFaultLoopError } from "../src/local-fault-loop.mjs";

test("three isolated reversible fault cases complete three evidence-grounded rounds each and preserve a negative human stop", async () => {
  const adapter = localCodexAdapter();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-local-fault-loop-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: adapter, now: () => Date.UTC(2026, 6, 20, 12, 0, 0) });
  const suite = await loop.runAll();

  assert.equal(suite.schema_version, LOCAL_FAULT_LOOP_SCHEMA_VERSION);
  assert.equal(suite.run_count, 10);
  assert.equal(suite.positive_run_count, 9);
  assert.equal(suite.recovered_count, 9);
  assert.equal(suite.negative_case.state, "needs_human");
  assert.equal(new Set(suite.runs.map((run) => run.run_id)).size, 10);
  assert.equal(new Set(suite.runs.map((run) => run.incident_id)).size, 10);
  assert.equal(adapter.calls.length, 40);
  assert.equal(adapter.calls.every((call) => call.topology.schema_version === "flowpulse.topology-views.v2" && /^[a-f0-9]{64}$/.test(call.topology.projection_revision)), true);

  for (const definition of LOCAL_FAULT_LOOP_CASES) {
    const runs = suite.runs.filter((run) => run.case_id === definition.id);
    assert.equal(runs.length, 3);
    for (const run of runs) {
      assert.equal(run.state, "recovered");
      assert.equal(run.citations.length > 0, true);
      assert.deepEqual(run.role_responses.map((item) => item.role), ["observer", "orchestrator", "investigator", "evaluator"]);
      assert.equal(run.role_responses.every((item) => item.provider.provider_kind === "codex-local" && item.citations.length > 0), true);
      assert.equal(run.events.every((event, index) => index === 0 || event.sequence > run.events[index - 1].sequence), true);
      assert.equal(run.events.some((event) => event.type === "local_fault_loop.evaluation.rejected" && event.payload.false_causal_rejected === true), true);
      assert.equal(run.events.some((event) => event.type === "local_fault_loop.evaluation.accepted" && event.payload.root_cause_accuracy === true), true);
      assert.equal(run.events.some((event) => event.type === "local_fault_loop.authority.decided" && event.payload.outcome === "auto_execute_pre_authorized"), true);
      assert.equal(run.events.some((event) => event.type === "local_fault_loop.repair.executed" && event.payload.execution_scope === "local_memory_only"), true);
      const verification = run.events.find((event) => event.type === "local_fault_loop.verification.completed");
      assert.equal(verification.payload.passed, true);
      assert.equal(verification.payload.checks.every((check) => check.passed), true);
    }
  }

  const negative = suite.runs.find((run) => run.case_id === "insufficient-evidence");
  assert.equal(negative.state, "needs_human");
  assert.equal(negative.events.some((event) => event.type === "local_fault_loop.authority.decided" && event.payload.outcome === "needs_human"), true);
  assert.equal(negative.events.some((event) => event.type === "local_fault_loop.repair.executed"), false);
});

test("a missing local Codex provider fails the loop without recorded fallback or repair", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-local-fault-loop-failure-")), "ledger.db"));
  const loop = new LocalFaultLoop({
    ledger,
    modelAdapter: {
      async preflight() { return { provider_kind: "recorded", availability: "available", truth_label: "RECORDED/DEMO", model_label: "recorded", failure_reason: null }; },
      async respond() { throw new Error("must not run"); }
    }
  });

  await assert.rejects(() => loop.run({ caseId: "checkout-payment-config", round: 1 }), (error) => error instanceof LocalFaultLoopError && error.code === "local_codex_provider_unavailable");
  const runId = ledger.query("SELECT run_id FROM events WHERE type='local_fault_loop.run.started' LIMIT 1;")[0].run_id;
  const events = ledger.list(runId);
  assert.equal(events.some((event) => event.type === "local_fault_loop.failed" && event.payload.reason === "local_codex_provider_unavailable"), true);
  assert.equal(events.some((event) => event.type === "local_fault_loop.repair.executed"), false);
});

test("a local provider failure is terminal, classified safely, and never replaced by recorded output", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-local-fault-loop-provider-failure-")), "ledger.db"));
  const failure = Object.assign(new Error("redacted"), { code: "provider_output_schema_invalid" });
  const loop = new LocalFaultLoop({
    ledger,
    modelAdapter: {
      async preflight() { return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null }; },
      async respond() { throw failure; }
    }
  });

  await assert.rejects(() => loop.run({ caseId: "checkout-payment-config", round: 1 }), (error) => error instanceof LocalFaultLoopError && error.code === "local_codex_provider_response_failed");
  const failed = ledger.query("SELECT payload_json FROM events WHERE type='local_fault_loop.failed' LIMIT 1;")[0];
  assert.deepEqual(JSON.parse(failed.payload_json), { state: "failed", reason: "local_codex_provider_response_failed", provider_failure_reason: "provider_output_schema_invalid" });
  assert.equal(ledger.query("SELECT count(*) AS count FROM events WHERE type='local_fault_loop.role.response';")[0].count, 0);
});

test("failed verification rolls back, re-investigates once, and stops after two failed bounded repairs", async () => {
  const adapter = localCodexAdapter();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-local-fault-loop-retry-")), "ledger.db"));
  const loop = new LocalFaultLoop({
    ledger,
    modelAdapter: adapter,
    fixtureOptions: { verificationFailuresByCase: { "checkout-payment-config": 1, "kafka-consumer-pause": 2 } }
  });

  const recovered = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  assert.equal(recovered.state, "recovered");
  assert.equal(recovered.events.filter((event) => event.type === "local_fault_loop.repair.executed").length, 2);
  assert.equal(recovered.events.filter((event) => event.type === "local_fault_loop.repair.rolled_back").length, 1);
  assert.equal(recovered.events.filter((event) => event.type === "local_fault_loop.role.response").length, 6);
  assert.deepEqual(recovered.events.filter((event) => event.type === "local_fault_loop.verification.completed").map((event) => event.payload.passed), [false, true]);

  const stopped = await loop.run({ caseId: "kafka-consumer-pause", round: 1 });
  assert.equal(stopped.state, "needs_human");
  assert.equal(stopped.events.some((event) => event.type === "local_fault_loop.recovered"), false);
  assert.equal(stopped.events.filter((event) => event.type === "local_fault_loop.repair.executed").length, 2);
  assert.equal(stopped.events.filter((event) => event.type === "local_fault_loop.repair.rolled_back").length, 2);
  assert.equal(stopped.final.payload.reason, "fixture_recovery_verification_failed");
});

function localCodexAdapter() {
  const calls = [];
  return {
    calls,
    async preflight() { return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null }; },
    async respond({ role, context }) {
      calls.push({ role, evidence: context.evidence.map((item) => item.id), topology: context.topology });
      return { answer: `${role} bounded local fixture response.`, recommended_handoff: null };
    }
  };
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { DevelopmentRuntime } from "../src/development-runtime.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";
import { LiveOtlpEvidenceSource, versionedChangeEvidence } from "../src/evidence-source.mjs";

test("real-development loop rejects weak blame, gates rollback, then verifies fresh evidence", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-")), "ledger.db")),
    bundle: loadBundle()
  });
  let repaired = false;
  const source = {
    async project() {
      return {
        status: "live",
        evidence: [repaired ? healthyEvidence() : failureEvidence()]
      };
    }
  };
  const adapter = {
    async applyDevelopmentCase() {
      return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test flag API" };
    },
    async executeApprovedRollback({ commandId }) {
      repaired = true;
      return { command_id: commandId, completed_at: "2026-07-17T12:01:00.000Z", stdout: "checkout recreated", stderr: "" };
    }
  };
  const development = new DevelopmentRuntime({ runtime, source, adapter });
  const runId = await development.start();
  await development.investigate(runId);

  let state = development.state(runId);
  assert.equal(state.waiting_for_approval, true);
  assert.equal(state.events.some((event) => event.type === "evaluation.rejected" && event.payload.hypothesis_id === "hyp-payment-service"), true);
  assert.equal(state.events.some((event) => event.type === "repair.executed"), false);

  await development.approve(runId, "Test development owner");
  await development.verify(runId);
  state = development.state(runId);
  assert.equal(state.complete, true);
  assert.equal(state.events.find((event) => event.type === "repair.executed").payload.mode, "local-development");
  assert.equal(state.events.find((event) => event.type === "verification.completed").payload.passed, true);
  assert.equal(state.events.find((event) => event.type === "policy.evaluated").payload.promotion, "eligible_for_owner_review");
});

test("development investigation stops when fresh telemetry cannot prove the mechanism", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-empty-")), "ledger.db")),
    bundle: loadBundle()
  });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", source: "test" }; } };
  const development = new DevelopmentRuntime({ runtime, source: { async project() { return { status: "live", evidence: [] }; } }, adapter });
  const runId = await development.start();
  await assert.rejects(() => development.investigate(runId), /not available/);
  assert.equal(development.state(runId).events.find((event) => event.type === "outcome.classified").payload.classification, "insufficient_evidence");
});

test("mismatched approval request cannot execute the checked-in development repair", async () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-mismatch-")), "ledger.db")),
    bundle: loadBundle()
  });
  let executions = 0;
  const development = new DevelopmentRuntime({
    runtime,
    source: { async project() { return { status: "live", evidence: [failureEvidence()] }; } },
    adapter: {
      async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; },
      async executeApprovedRollback() { executions += 1; return { command_id: "should-not-run" }; }
    }
  });
  const runId = await development.start();
  runtime.append(runId, "approval.requested", "test", { repair_id: "unrelated", action: "other", target: "payment", command_id: "other" });
  await assert.rejects(() => development.approve(runId), /does not match/);
  assert.equal(executions, 0);
});

test("frozen development investigation cites both the captured change and failure trace", async () => {
  const runtime = new IncidentRuntime({ ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-development-frozen-")), "ledger.db")), bundle: loadBundle() });
  const adapter = { async applyDevelopmentCase() { return { change: change(), before: "off", after: "on", applied_at: "2026-07-17T12:00:00.000Z", source: "test" }; } };
  const source = { async project() { return { status: "live", evidence: [failureEvidence()] }; } };
  const development = new DevelopmentRuntime({ runtime, source, adapter });
  const runId = await development.start();
  const applied = runtime.ledger.list(runId).find((event) => event.type === "change.applied");
  const changeEvidence = versionedChangeEvidence({ manifest: applied.payload.change, applied: applied.payload, ledgerEvent: applied });
  const failure = { ...failureEvidence(), kind: "trace", entity: "checkout", value: { services: ["checkout"], trace: { status: "error", error: "ECONNREFUSED" } } };
  const frozen = new LiveOtlpEvidenceSource({ status: "live", evidence: [failure] }).freeze({ supplementalRecords: [changeEvidence], executable: true, after: applied.payload.applied_at });
  await development.investigate(runId, frozen);
  const expected = new Set([changeEvidence.id, failure.id]);
  for (const type of ["hypothesis.proposed", "evaluation.accepted", "repair.proposed", "approval.requested"]) {
    const event = runtime.ledger.list(runId).filter((item) => item.type === type).at(-1);
    assert.equal(event.evidence_refs.some((id) => expected.has(id)), true);
    assert.equal(event.evidence_refs.includes(changeEvidence.id), true);
    assert.equal(event.evidence_refs.includes(failure.id), true);
  }
});

function change() {
  return {
    id: "change-payment-unreachable-v1",
    target: "checkout",
    flag: "paymentUnreachable",
    after: "on",
    known_good: "off",
    repair_id: "repair-payment-reachable-v1",
    repair_command_id: "astronomy.restore-payment-and-recreate-checkout",
    timeout_seconds: 120,
    abort_if: "checkout unhealthy"
  };
}

function failureEvidence() {
  return {
    id: "live-tra-failure",
    signal: "traces",
    at: "2026-07-17T12:00:30.000Z",
    value: { services: ["checkout"] },
    payload: { resourceSpans: [{ resource: { service: "checkout" }, scopeSpans: [{ spans: [{ name: "payment", status: { code: 2, message: "unavailable" } }] }] }] }
  };
}

function healthyEvidence() {
  return {
    id: "live-tra-healthy",
    signal: "traces",
    at: "2026-07-17T12:01:30.000Z",
    value: { services: ["checkout", "payment"] },
    payload: { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "payment", status: { code: 1 } }] }] }] }
  };
}

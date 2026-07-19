import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControlService } from "../src/agent-control-service.mjs";
import { loadBundle } from "../src/bundle.mjs";
import { Ledger } from "../src/ledger.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

function setup() {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-agent-control-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun();
  return { runtime, runId, service: new AgentControlService({ runtime }) };
}

test("agent control projects the canonical team from immutable events", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);

  const projection = service.project(runId);
  const statuses = Object.fromEntries(projection.graph.nodes.map((node) => [node.id, node.status]));

  assert.equal(projection.authority, "append-only-ledger");
  assert.equal(projection.report.human_gate, "owner_approval_required");
  assert.equal(projection.report.rejected_diagnosis.hypothesis_id, "hyp-kafka");
  assert.equal(projection.report.repair.target, "checkout");
  assert.equal(projection.actions[0].id, "review_recovery");
  assert.equal(statuses.evaluator, "complete");
  assert.equal(statuses.planner, "complete");
  assert.equal(statuses.owner, "waiting");
  assert.equal(statuses.executor, "standby");
});

test("manager chat records attributed responses and cannot create approval", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);

  const result = service.message(runId, "Accept and execute the recovery");
  const events = runtime.ledger.list(runId);

  assert.equal(result.intent, "approval_explanation");
  assert.match(result.message, /cannot approve/i);
  assert.equal(events.filter((event) => event.type === "manager.message.received").length, 1);
  assert.equal(events.filter((event) => event.type === "manager.response.created").length, 1);
  assert.equal(events.some((event) => event.type === "approval.granted"), false);
  assert.ok(events.find((event) => event.type === "manager.response.created").evidence_refs.length > 0);
});

test("B1 collaboration messages stay role-scoped without changing specialist authority", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);

  const result = service.message(runId, "Explain the rejected Kafka hypothesis", "critic");
  const messages = runtime.ledger.list(runId).filter((event) => ["manager.message.received", "manager.response.created"].includes(event.type));

  assert.equal(result.collaborator_id, "critic");
  assert.match(result.message, /Critic: hyp-kafka scored 22%/);
  assert.equal(messages.every((event) => event.payload.collaborator_id === "critic"), true);
  assert.equal(result.projection.activity.filter((item) => item.collaborator_id === "critic").length, 2);
  assert.equal(runtime.state(runId).waiting_for_approval, true);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "approval.granted"), false);

  assert.equal(service.message(runId, "Summarize", "unknown-role").collaborator_id, "commander");
});

test("Observer chat cites its collected evidence before a root cause is accepted", () => {
  const { runtime, runId, service } = setup();
  service.advance(runId);

  const result = service.message(runId, "Show the first failing trace", "observer");
  const response = runtime.ledger.list(runId).findLast((event) => event.type === "manager.response.created");

  assert.match(result.message, /Observer: 3 immutable evidence records are currently cited/);
  assert.deepEqual(response.evidence_refs, ["ev-metric-checkout-errors", "ev-metric-kafka-lag", "ev-log-consumer-delay"]);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "approval.granted"), false);
});

test("safe advance delegates one deterministic step while owner-gated actions remain separate", () => {
  const { runtime, runId, service } = setup();
  const before = runtime.ledger.list(runId).length;

  const projection = service.act(runId, "advance");

  assert.ok(runtime.ledger.list(runId).length > before);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "manager.delegation.created"), true);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "evidence.requested" && event.actor === "agent:evidence"), true);
  assert.equal(runtime.ledger.list(runId).some((event) => event.type === "orchestration.step.completed" && event.payload.validation === "agent_team_harness"), true);
  assert.equal(projection.orchestration.proposal_count, 2);
  assert.equal(projection.activity.some((event) => event.agent_id === "manager"), true);
  assert.throws(() => service.act(runId, "approve_repair"), /not available/);
});

test("the complete replay crosses the typed harness before every specialist runtime step", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) service.advance(runId);
  assert.equal(runtime.state(runId).waiting_for_approval, true);
  runtime.approve(runId, "Test owner");
  service.advance(runId);
  service.advance(runId);

  const state = runtime.state(runId);
  const projection = service.project(runId);
  const completed = state.events.filter((event) => event.type === "orchestration.step.completed");

  assert.equal(state.complete, true);
  assert.equal(completed.length, 9);
  assert.equal(completed.filter((event) => event.payload.validation === "agent_team_harness").length, 8);
  assert.equal(completed.find((event) => event.payload.target === "executor").payload.validation, "owner_gate_and_allowlist");
  assert.equal(projection.orchestration.proposal_count, 14);
  assert.equal(projection.orchestration.proposals.every((item) => item.content_sha256.length === 64), true);
  assert.equal(state.events.some((event) => event.type === "backtest.completed" && event.actor === "agent:test"), true);
  assert.equal(state.events.find((event) => event.type === "backtest.completed").payload.source, "captured_fixture");
});

test("verification, evolve, and test become visible after owner-approved recovery", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) runtime.next(runId);
  runtime.approve(runId, "Test owner");
  runtime.next(runId);
  runtime.next(runId);

  const projection = service.project(runId);
  const statuses = Object.fromEntries(projection.graph.nodes.map((node) => [node.id, node.status]));

  assert.equal(projection.report.data_mode, "captured_deterministic_replay");
  assert.equal(projection.report.verification.passed, true);
  assert.equal(statuses.executor, "complete");
  assert.equal(statuses.verification, "complete");
  assert.equal(statuses.evolve, "complete");
  assert.equal(statuses.test, "complete");
  assert.equal(projection.actions[0].id, "review_learning");
});

test("recovery-console work proposals are idempotent, cited, and never mutate external systems", () => {
  const { runtime, runId, service } = setup();
  for (let step = 0; step < 7; step++) service.advance(runId);

  service.act(runId, "delegate_task", { instruction: "Recheck the checkout endpoint evidence" });
  service.act(runId, "review_pr");
  service.act(runId, "approve_pr_review");
  service.act(runId, "draft_jira");
  service.act(runId, "approve_jira_draft");
  const beforeRepeat = runtime.ledger.list(runId).length;
  assert.throws(() => service.act(runId, "approve_jira_draft"), /not available/);

  const events = runtime.ledger.list(runId);
  const workEvents = events.filter((event) => ["task.delegation.proposed", "pr.review.proposed", "pr.review.recorded", "workitem.draft.proposed", "workitem.draft.approved"].includes(event.type));
  assert.equal(events.length, beforeRepeat);
  assert.equal(workEvents.length, 5);
  assert.equal(workEvents.every((event) => event.payload.external_mutation === false), true);
  assert.equal(workEvents.every((event) => event.evidence_refs.length > 0), true);
  assert.equal(workEvents.every((event) => event.payload.idempotency_key.startsWith(runId)), true);
  assert.equal(events.some((event) => event.type === "approval.granted"), false);

  const projection = service.project(runId);
  assert.equal(projection.work_items.length, 5);
  assert.equal(projection.work_items.at(-1).status, "ready_for_integration");
  assert.equal(projection.work_items.at(-1).integration_state, "not_configured");
});

test("manager chat can dispatch a safe internal task without crossing the owner gate", () => {
  const { runtime, runId, service } = setup();
  service.message(runId, "Assign the diagnosis agent to validate the first failing trace");
  const events = runtime.ledger.list(runId);
  const task = events.find((event) => event.type === "task.delegation.proposed");

  assert.ok(task);
  assert.equal(task.payload.target_agent, "diagnosis");
  assert.equal(task.payload.external_mutation, false);
  assert.equal(events.some((event) => event.type === "approval.granted"), false);
});

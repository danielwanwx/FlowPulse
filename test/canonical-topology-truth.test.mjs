import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ledger } from "../src/ledger.mjs";
import { LocalFaultLoop } from "../src/local-fault-loop.mjs";
import { agentLoopProjection, canonicalPresentationFocus, canonicalWorkspaceVisual, recoveryWorkflowProjection, sharedRunReadModel } from "../public/twin-state.mjs";

test("one canonical run topology is the exact Live, Diagnose, Recovery, and Compare truth", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-topology-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: localCodexAdapter() });
  const run = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  const shared = sharedRunReadModel(run);

  // This deliberately fails until the backend supplies a bounded canonical graph
  // and the real-run read model uses that graph rather than the legacy six-node
  // frame helpers.
  assert.ok(shared?.topology, "missing backend-owned canonical topology projection");
  const workspaces = [shared.topology.live, shared.topology.diagnose, shared.topology.recovery, shared.topology.compare];
  for (const workspace of workspaces) {
    assert.equal(workspace.run_id, run.run_id);
    assert.equal(workspace.incident_id, run.incident_id);
    assert.equal(workspace.projection_revision, shared.topology.projection_revision);
    assert.deepEqual(workspace.node_ids, shared.topology.node_ids);
    assert.deepEqual(workspace.edge_ids, shared.topology.edge_ids);
  }
  assert.equal(shared.topology.node_ids.includes("fraud"), false);
  assert.equal(shared.topology.node_ids.includes("fraud-detection"), true);
  assert.equal(shared.topology.verification.passed, true);
  assert.equal(shared.topology.compare.state, "verified");
  assert.equal(shared.topology.affected_node_ids.every((id) => shared.topology.snapshots.verified.node_statuses[id] === "verified"), true);
  assert.equal(shared.topology.affected_edge_ids.every((id) => shared.topology.snapshots.verified.edge_statuses[id] === "verified"), true);
});

test("Compare remains verification_pending for the same canonical run without a passed verification", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-topology-negative-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: localCodexAdapter() });
  const run = await loop.run({ caseId: "insufficient-evidence", round: 1 });
  const shared = sharedRunReadModel(run);

  assert.equal(run.state, "needs_human");
  assert.equal(shared?.topology.verification.passed, false);
  assert.equal(shared?.topology.verification.snapshot, null);
  assert.equal(shared?.topology.compare.state, "verification_pending");
  assert.equal(run.events.some((event) => event.type === "local_fault_loop.repair.executed"), false);
});

test("canonical workspace visuals preserve the active graph identities and fail closed without a usable snapshot", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-visual-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: localCodexAdapter() });
  const run = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  const shared = sharedRunReadModel(run);

  const incident = canonicalWorkspaceVisual(shared.topology, shared.topology.snapshots.incident);
  const verified = canonicalWorkspaceVisual(shared.topology, shared.topology.snapshots.verified);
  assert.equal(incident.availability, "ready");
  assert.equal(verified.availability, "ready");
  assert.deepEqual(incident.node_ids, shared.topology.node_ids);
  assert.deepEqual(incident.edge_ids, shared.topology.edge_ids);
  assert.deepEqual(verified.node_ids, shared.topology.node_ids);
  assert.deepEqual(verified.edge_ids, shared.topology.edge_ids);
  assert.equal(incident.nodes.find((node) => node.id === "checkout").status, "impact");
  assert.equal(verified.nodes.find((node) => node.id === "checkout").status, "verified");
  assert.equal(incident.metrics.checkout.value, "38.4%");
  assert.equal(verified.metrics.checkout.value, "0.8%");

  const missingSnapshot = canonicalWorkspaceVisual(shared.topology, null);
  assert.equal(missingSnapshot.availability, "unavailable");
  assert.deepEqual(missingSnapshot.node_ids, []);
  assert.deepEqual(missingSnapshot.edge_ids, []);
  assert.equal(missingSnapshot.metrics.checkout.value, "Unavailable");
  assert.equal(missingSnapshot.metrics.payment.value, "Unavailable");
  assert.equal(missingSnapshot.metrics.kafka.value, "Unavailable");
});

test("Diagnose emphasis fails closed when a canonical loop lacks the matching server-projected causal overlay", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-focus-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: localCodexAdapter() });
  const run = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  const shared = sharedRunReadModel(run);
  const focus = canonicalPresentationFocus(shared.topology, shared.topology.snapshots.incident);

  assert.equal(focus.availability, "unavailable");
  assert.deepEqual(focus.node_ids, []);
  assert.deepEqual(focus.affected_node_ids, []);
  assert.deepEqual(focus.affected_edge_ids, []);
});

test("Diagnose accepts the same canonical identities when the independent projection uses its own deterministic order", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-focus-order-")), "ledger.db"));
  const loop = new LocalFaultLoop({ ledger, modelAdapter: localCodexAdapter() });
  const run = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  const shared = sharedRunReadModel(run);
  const overlay = [
    { id: "checkout->kafka", from: "checkout", to: "kafka", relation: "evidence_grounded_relation" },
    { id: "checkout->payment", from: "checkout", to: "payment", relation: "observed_dependency" },
    { id: "frontend->checkout", from: "frontend", to: "checkout", relation: "observed_dependency" },
    { id: "kafka->accounting", from: "kafka", to: "accounting", relation: "evidence_grounded_relation" },
    { id: "kafka->fraud-detection", from: "kafka", to: "fraud-detection", relation: "evidence_grounded_relation" }
  ];
  const diagnoseView = {
    run_id: shared.run_id,
    incident_id: shared.incident_id,
    projection_revision: shared.projection_revision,
    runtime_data: {
      graph: {
        nodes: [...shared.topology.graph.nodes].reverse(),
        edges: [...shared.topology.graph.edges].reverse()
      },
      supporting_relations: overlay
        .filter(({ relation }) => relation === "evidence_grounded_relation")
        .map(({ id, from, to }) => ({ id, from, to }))
    },
    overlay: {
      status: "available",
      node_ids: ["accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment"],
      edges: overlay
    }
  };

  const focus = canonicalPresentationFocus(shared.topology, shared.topology.snapshots.incident, diagnoseView);
  assert.equal(focus.availability, "ready");
  assert.deepEqual(focus.affected_node_ids, diagnoseView.overlay.node_ids);
  assert.deepEqual(focus.affected_edge_ids, overlay.map(({ id }) => id));
});

test("strict loop parsing accepts a recorded same-role advisory without inventing a cross-role handoff", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-canonical-advisory-")), "ledger.db"));
  const loop = new LocalFaultLoop({
    ledger,
    modelAdapter: localCodexAdapter({
      orchestrator: { to: "orchestrator", reason: "Continue the bounded workflow selection." }
    })
  });
  const run = await loop.run({ caseId: "checkout-payment-config", round: 1 });
  const response = run.role_responses.find(({ role }) => role === "orchestrator");
  const advisory = response?.recommended_handoff;

  assert.deepEqual(advisory, { to: "orchestrator", reason: "Continue the bounded workflow selection." });
  assert.deepEqual(response?.handoff, advisory, "the loop preserves the bounded provider recommendation in its compatibility handoff field");
  assert.equal(run.events.some((event) => event.type === "local_fault_loop.handoff.recorded" && event.actor === "orchestrator" && event.payload?.ownership === "model_recommended"), false);
  assert.equal(agentLoopProjection(run, { runId: run.run_id })?.run_id, run.run_id);
  assert.equal(sharedRunReadModel(run)?.topology.run_id, run.run_id);
});

test("recovery workflow follows recorded agent handoffs and never invents a Commander", () => {
  const events = [
    { sequence: 1, type: "local_fault_loop.role.response", actor: "observer", payload: { role: "observer" } },
    { sequence: 2, type: "local_fault_loop.role.response", actor: "orchestrator", payload: { role: "orchestrator" } },
    { sequence: 3, type: "local_fault_loop.role.response", actor: "investigator", payload: { role: "investigator" } },
    { sequence: 4, type: "local_fault_loop.role.response", actor: "evaluator", payload: { role: "evaluator" } },
    { sequence: 5, type: "local_fault_loop.repair.executed", actor: "remediation", payload: {} },
    { sequence: 6, type: "local_fault_loop.verification.completed", actor: "verifier", payload: { passed: true } }
  ];
  const workflow = recoveryWorkflowProjection(events);
  assert.deepEqual(workflow.nodes.map((node) => node.id), ["observer", "orchestrator", "investigator", "evaluator", "recovery", "verifier"]);
  assert.equal(workflow.nodes.every((node) => node.status === "complete"), true);
  assert.equal(workflow.nodes.some((node) => node.id === "commander"), false);
  assert.equal(workflow.nodes.every((node, index) => node.sequence === index + 1), true);

  const commanderWorkflow = recoveryWorkflowProjection([
    ...events,
    { sequence: 7, type: "local_fault_loop.commander.noted", actor: "commander", payload: {} }
  ]);
  assert.equal(commanderWorkflow.nodes.at(-1).id, "commander");
  assert.equal(commanderWorkflow.nodes.at(-1).sequence, 7);
});

function localCodexAdapter(advisories = {}) {
  return {
    async preflight() {
      return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null };
    },
    async respond({ role }) {
      return { answer: `${role} bounded local fixture response.`, recommended_handoff: advisories[role] || null };
    }
  };
}

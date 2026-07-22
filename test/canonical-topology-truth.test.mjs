import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ledger } from "../src/ledger.mjs";
import { LocalFaultLoop } from "../src/local-fault-loop.mjs";
import { sharedRunReadModel } from "../public/twin-state.mjs";

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

function localCodexAdapter() {
  return {
    async preflight() {
      return { provider_kind: "codex-local", availability: "available", truth_label: "LOCAL CODEX", model_label: "Codex CLI", failure_reason: null };
    },
    async respond({ role }) {
      return { answer: `${role} bounded local fixture response.`, recommended_handoff: null };
    }
  };
}

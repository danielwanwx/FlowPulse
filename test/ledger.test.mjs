import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.mjs";

test("ledger appends ordered JSON events and rejects mutation", () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-ledger-")), "ledger.db"));
  const first = ledger.append({
    runId: "run-test",
    incidentId: "inc-test",
    type: "run.started",
    actor: "test",
    payload: { mode: "replay" }
  });
  const second = ledger.append({
    runId: "run-test",
    incidentId: "inc-test",
    type: "evidence.queried",
    actor: "test",
    evidenceRefs: ["ev-1"],
    payload: { result_count: 1 }
  });

  assert.equal(second.sequence, first.sequence + 1);
  assert.deepEqual(ledger.list("run-test").map((event) => event.type), ["run.started", "evidence.queried"]);
  assert.deepEqual(ledger.get(second.id).evidence_refs, ["ev-1"]);
  assert.throws(() => ledger.exec("UPDATE events SET actor='tampered';"), /append-only/);
  assert.throws(() => ledger.exec("DELETE FROM events;"), /append-only/);
});

test("starting a new run preserves prior run history", () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-runs-")), "ledger.db"));
  for (const runId of ["run-a", "run-b"]) {
    ledger.append({ runId, incidentId: "inc-test", type: "run.started", actor: "test" });
  }
  assert.equal(ledger.latestRun("inc-test"), "run-b");
  assert.equal(ledger.list("run-a").length, 1);
});

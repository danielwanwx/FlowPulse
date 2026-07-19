import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  assert.equal(ledger.get(second.id).payload_sha256, canonicalHash({ result_count: 1 }));
  assert.throws(() => ledger.exec("UPDATE events SET actor='tampered';"), /append-only/);
  assert.throws(() => ledger.exec("DELETE FROM events;"), /append-only/);
});

function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

test("starting a new run preserves prior run history", () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-runs-")), "ledger.db"));
  for (const runId of ["run-a", "run-b"]) {
    ledger.append({ runId, incidentId: "inc-test", type: "run.started", actor: "test" });
  }
  assert.equal(ledger.latestRun("inc-test"), "run-b");
  assert.equal(ledger.list("run-a").length, 1);
});

test("autonomy lock query is type-scoped, globally ordered, and bounded", () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-lock-query-")), "ledger.db"));
  ledger.append({ runId: "run-a", incidentId: "other", type: "run.started", actor: "test" });
  const first = ledger.append({ runId: "run-a", incidentId: "other", type: "autonomy.locked", actor: "test", payload: { marker: "first" } });
  const second = ledger.append({ runId: "run-b", incidentId: "inc-test", type: "autonomy.locked", actor: "test", payload: { marker: "second" } });
  assert.deepEqual(ledger.listAutonomyLocks().map((event) => event.id), [first.id, second.id]);
  assert.throws(() => ledger.listAutonomyLocks(1), /bounded limit/);
  assert.throws(() => ledger.listAutonomyLocks(513), /Invalid autonomy lock limit/);
});

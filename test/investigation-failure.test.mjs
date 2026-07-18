import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBundle } from "../src/bundle.mjs";
import { recordInvestigationFailure } from "../src/investigation-failure.mjs";
import { Ledger } from "../src/ledger.mjs";
import { CausalEvidenceError } from "../src/openai.mjs";
import { IncidentRuntime } from "../src/runtime.mjs";

test("development GPT causal failures classify once and never create repair or approval events", () => {
  const runtime = new IncidentRuntime({
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "flowpulse-investigation-failure-")), "ledger.db")),
    bundle: loadBundle()
  });
  const runId = runtime.startRun("development");
  const error = new CausalEvidenceError("Diagnosis lacks the exact cited change and post-change failure evidence required for executable repair");
  const classification = recordInvestigationFailure({
    runtime,
    runId,
    error,
    failedType: "development.investigation.failed",
    actor: "development-evaluator"
  });
  assert.equal(classification, "insufficient_evidence");
  const events = runtime.ledger.list(runId);
  assert.equal(events.filter((event) => event.type === "outcome.classified").length, 1);
  assert.equal(events.filter((event) => event.type === "development.investigation.failed").length, 1);
  assert.equal(events.some((event) => event.type === "repair.proposed" || event.type === "approval.requested"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  compileToolContext,
  ContextCompilationError,
  createContextAccumulator,
  CONTEXT_MAX_BYTES_PER_ATTEMPT,
  CONTEXT_MAX_BYTES_PER_TOOL,
  CONTEXT_MAX_RECORDS_PER_TOOL
} from "../src/context-compiler.mjs";

test("context compiler is deterministic, provenance-preserving, and its summaries are explicitly non-authoritative", () => {
  const accumulator = createContextAccumulator();
  const result = compileToolContext({
    tool: "query_traces", entity: "checkout", attempt: 1, round: 1, accumulator,
    items: [record("ev-b", "b"), record("ev-a", "a"), record("ev-b", "b")]
  });
  assert.deepEqual(result.context.authority_refs, ["ev-a", "ev-b"]);
  assert.equal(result.context.non_authoritative_summary, true);
  assert.equal(result.items.every((item) => item.provenance.sha256 === item.hash && item.source === "frozen-test"), true);
  const repeat = compileToolContext({ tool: "query_traces", entity: "checkout", attempt: 1, round: 1, accumulator: createContextAccumulator(), items: [record("ev-b", "b"), record("ev-a", "a"), record("ev-b", "b")] });
  assert.equal(result.context.context_sha256, repeat.context.context_sha256);
  assert.equal(result.context.omitted_evidence_refs.some((item) => item.reason === "duplicate"), true);
});

test("context compiler enforces record caps and fails closed rather than silently dropping a gate-required record", () => {
  const items = Array.from({ length: CONTEXT_MAX_RECORDS_PER_TOOL + 1 }, (_, index) => record(`ev-${String(index).padStart(3, "0")}`, String(index)));
  const ordinary = compileToolContext({ tool: "query_traces", entity: "checkout", attempt: 1, round: 1, items });
  assert.equal(ordinary.items.length, CONTEXT_MAX_RECORDS_PER_TOOL);
  assert.equal(ordinary.context.omitted_evidence_refs.length, 1);
  assert.equal(ordinary.authorityRefs.has(ordinary.context.omitted_evidence_refs[0].id), false);
  assert.throws(() => compileToolContext({
    tool: "query_traces", entity: "checkout", attempt: 1, round: 1, items,
    requiredEvidenceIds: items.map((item) => item.id)
  }), (error) => error instanceof ContextCompilationError && error.code === "context_required_evidence_omitted");
});

test("context compiler rejects unsafe records instead of manufacturing an authority reference", () => {
  assert.throws(() => compileToolContext({
    tool: "query_traces", entity: "checkout", attempt: 1, round: 1,
    items: [{ id: "ev-unsafe", kind: "trace", entity: "checkout", source: "frozen-test" }]
  }), (error) => error instanceof ContextCompilationError && error.code === "context_evidence_invalid");
});

test("context compiler measures the exact serialized array transmitted to the provider", () => {
  const items = boundarySizedRecords();
  const individualBytes = items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  assert.equal(individualBytes <= CONTEXT_MAX_BYTES_PER_TOOL, true);
  assert.equal(Buffer.byteLength(JSON.stringify(items), "utf8") > CONTEXT_MAX_BYTES_PER_TOOL, true);
  const result = compileToolContext({ tool: "query_traces", entity: "checkout", attempt: 1, round: 1, items });
  assert.equal(result.items.length < items.length, true);
  assert.equal(result.payload, JSON.stringify(result.items));
  assert.equal(result.context.bytes, Buffer.byteLength(result.payload, "utf8"));
  assert.equal(result.context.bytes <= CONTEXT_MAX_BYTES_PER_TOOL, true);
});

test("context compiler charges repeated payloads against the attempt byte budget", () => {
  const accumulator = createContextAccumulator();
  const item = record("ev-repeat", "repeat");
  item.fact = "x".repeat(6_000);
  const payloads = [];
  for (let round = 1; round <= 24; round++) {
    const result = compileToolContext({ tool: "query_traces", entity: "checkout", attempt: 1, round, accumulator, items: [item] });
    payloads.push(result.payload);
    assert.equal(result.context.attempt_bytes, payloads.reduce((total, payload) => total + Buffer.byteLength(payload, "utf8"), 0));
    assert.equal(result.context.attempt_bytes <= CONTEXT_MAX_BYTES_PER_ATTEMPT, true);
  }
  assert.equal(payloads.some((payload) => payload === "[]"), true);
  assert.equal(accumulator.selectedIds.size, 1);
});

test("context compiler fails closed when a required record cannot fit a payload cap", () => {
  const items = [record("ev-required-overflow", "required")];
  items[0].fact = "x".repeat(CONTEXT_MAX_BYTES_PER_TOOL);
  const required = items[0].id;
  assert.throws(() => compileToolContext({
    tool: "query_traces", entity: "checkout", attempt: 1, round: 1, items,
    requiredEvidenceIds: [required]
  }), (error) => error instanceof ContextCompilationError && error.code === "context_required_evidence_omitted" && error.metadata.reason_code === "tool_byte_cap");
});

function record(id, suffix) {
  const hash = `${suffix}`.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a");
  return {
    id, kind: "trace", entity: "checkout", source: "frozen-test", fact: `bounded ${id}`,
    hash, provenance: { sha256: hash }, value: { trace: { status: "error" } }
  };
}

function boundarySizedRecords() {
  const items = Array.from({ length: CONTEXT_MAX_RECORDS_PER_TOOL }, (_, index) => record(`ev-boundary-${String(index).padStart(2, "0")}`, String(index)));
  const base = items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  const padding = Math.floor((CONTEXT_MAX_BYTES_PER_TOOL - base) / items.length);
  for (const item of items) item.fact = "x".repeat(Math.max(0, padding));
  while (items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0) + 2 + items.length - 1 <= CONTEXT_MAX_BYTES_PER_TOOL) {
    items[0].fact += "x";
  }
  return items;
}

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  AgentTeamProviderError,
  createAgentTeamProvider,
  createCodexLocalAdapter,
  createOpenAIResponsesAdapter,
  createRecordedChatAdapter,
  validateProviderResponse
} from "../src/agent-team-provider.mjs";

const CONTEXT = Object.freeze({
  role: "observer",
  message: "Show bounded source freshness.",
  page_mode: "architecture",
  selected_component: "checkout",
  topology: { schema_version: "flowpulse.topology-views.v2", projection_revision: "a".repeat(64) },
  source_truth: { source_health: "live", evidence_mode: "captured_fixture", execution_mode: "deterministic_replay", source_status: "captured", freshness_ms: 0 },
  incident: { run_id: "run-test", incident_id: "incident-test", stage: "Monitor", stage_status: "collecting" },
  human_gate: { status: "not_required" },
  evidence: [],
  tool_allowlist: ["read_source_freshness"]
});

test("provider selection is explicit and recorded remains truthfully labeled without credentials", async () => {
  const provider = createAgentTeamProvider({ providerKind: "recorded" });
  const result = await provider.respond({ role: "observer", context: CONTEXT });

  assert.deepEqual(provider.capability(), {
    provider_kind: "recorded",
    availability: "available",
    truth_label: "RECORDED/DEMO",
    model_label: "recorded-agent-team-v1",
    failure_reason: null
  });
  assert.match(result.answer, /^Observer:/);
  assert.equal(createAgentTeamProvider({ providerKind: "not-real" }).capability().availability, "unavailable");
});

test("Codex local preflight and invocation use an ephemeral read-only temp workspace with no auth or API-key environment", async () => {
  const fixture = scriptedSpawn({ output: JSON.stringify({ answer: "Local Codex answer." }) });
  const provider = createCodexLocalAdapter({ spawnImpl: fixture.spawn, timeoutMs: 100 });

  assert.equal((await provider.preflight()).availability, "available");
  const result = await provider.respond({ role: "observer", context: CONTEXT });
  const invocation = fixture.calls.find((call) => call.args[0] === "exec");

  assert.equal(result.answer, "Local Codex answer.");
  assert.equal(provider.capability().truth_label, "LOCAL CODEX");
  for (const part of ["--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "approval_policy=\"never\"", "web_search=\"disabled\""]) assert.equal(invocation.args.includes(part), true, part);
  assert.equal(invocation.options.cwd, invocation.args[invocation.args.indexOf("-C") + 1]);
  assert.equal(invocation.options.cwd.includes("flowpulse-agent-team-codex-"), true);
  assert.equal(Object.hasOwn(invocation.options.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(invocation.options.env, "CODEX_ACCESS_TOKEN"), false);
  assert.equal(Object.hasOwn(invocation.options.env, "CODEX_HOME"), false);
  assert.equal(JSON.stringify(invocation).includes("auth.json"), false);
  assert.equal(invocation.args.some((item) => item.includes("flowpulse-agent-backend")), false);
});

test("Codex local reports unavailable, unauthenticated, timeout, nonzero, invalid, and oversized output safely", async () => {
  const unavailable = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ versionCode: 1 }).spawn, timeoutMs: 20 });
  assert.equal((await unavailable.preflight()).failure_reason, "codex_cli_unavailable");

  const unauthenticated = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ login: "Not logged in" }).spawn, timeoutMs: 20 });
  assert.equal((await unauthenticated.preflight()).failure_reason, "codex_unauthenticated");

  const timedOut = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ neverClose: true }).spawn, timeoutMs: 5 });
  assert.equal((await timedOut.preflight()).failure_reason, "codex_timeout");

  const nonzero = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ execCode: 2 }).spawn, timeoutMs: 100 });
  await nonzero.preflight();
  await assert.rejects(() => nonzero.respond({ role: "observer", context: CONTEXT }), (error) => error instanceof AgentTeamProviderError && error.code === "codex_exec_nonzero");
  assert.deepEqual(nonzero.capability(), {
    provider_kind: "codex-local",
    availability: "unavailable",
    truth_label: "LOCAL CODEX",
    model_label: "Codex CLI",
    failure_reason: "codex_exec_nonzero"
  });

  const invalid = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ output: "not-json" }).spawn, timeoutMs: 100 });
  await invalid.preflight();
  await assert.rejects(() => invalid.respond({ role: "observer", context: CONTEXT }), /provider_output_schema_invalid/);

  const oversized = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ stdout: "x".repeat(128) }).spawn, timeoutMs: 100, outputLimitBytes: 64 });
  await oversized.preflight();
  await assert.rejects(() => oversized.respond({ role: "observer", context: CONTEXT }), /codex_output_too_large/);
});

test("Codex cancellation terminates its child and cleans up, while output labels cannot be forged", async () => {
  const fixture = scriptedSpawn({ holdExec: true });
  const provider = createCodexLocalAdapter({ spawnImpl: fixture.spawn, timeoutMs: 1_000 });
  await provider.preflight();
  const controller = new AbortController();
  const pending = provider.respond({ role: "observer", context: CONTEXT, signal: controller.signal });
  await waitFor(() => fixture.calls.some((call) => call.args[0] === "exec"));
  controller.abort();
  await assert.rejects(() => pending, (error) => error instanceof AgentTeamProviderError && error.code === "codex_cancelled");
  assert.equal(fixture.calls.find((call) => call.args[0] === "exec").child.killed, true);

  assert.throws(() => validateProviderResponse({ answer: "fine", provider_kind: "openai-responses" }), /provider_output_schema_invalid/);
  assert.throws(() => validateProviderResponse({ answer: "fine", recommended_handoff: { to: "ledger", reason: "no" } }), /provider_output_schema_invalid/);
});

test("recorded, Responses, and Codex adapters share the same validated output envelope", async () => {
  const recorded = await createRecordedChatAdapter().respond({ role: "observer", context: CONTEXT });
  const responses = await createOpenAIResponsesAdapter({
    requestResponse: async () => ({ output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ answer: "OpenAI answer." }) }] }] })
  }).respond({ role: "observer", context: CONTEXT });
  const codex = createCodexLocalAdapter({ spawnImpl: scriptedSpawn({ output: JSON.stringify({ answer: "Codex answer." }) }).spawn, timeoutMs: 100 });
  await codex.preflight();
  const local = await codex.respond({ role: "observer", context: CONTEXT });

  for (const result of [recorded, responses, local]) assert.equal(Object.keys(result).sort().join(","), "answer,model,provider,usage");
});

function scriptedSpawn({ versionCode = 0, loginCode = 0, login = "Logged in", execCode = 0, output = JSON.stringify({ answer: "ok" }), stdout = "", neverClose = false, holdExec = false } = {}) {
  const calls = [];
  const spawn = (_command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const call = { args, options, child };
    calls.push(call);
    queueMicrotask(() => {
      if (neverClose) return;
      if (args[0] === "--version") return close(versionCode, "codex-cli 0.test\n");
      if (args[0] === "login") return close(loginCode, `${login}\n`);
      if (args[0] !== "exec") return close(1, "");
      if (holdExec) return;
      if (stdout) child.stdout.emit("data", stdout);
      if (execCode === 0) writeFileSync(args[args.indexOf("--output-last-message") + 1], output);
      close(execCode, "");
    });
    function close(code, body) {
      if (body) child.stdout.emit("data", body);
      child.emit("close", code);
    }
    return child;
  };
  return { spawn, calls };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

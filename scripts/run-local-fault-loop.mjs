import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentTeamProvider } from "../src/agent-team-provider.mjs";
import { Ledger } from "../src/ledger.mjs";
import { LocalFaultLoop } from "../src/local-fault-loop.mjs";
import { loadTopologyManifest } from "../src/topology-manifest.mjs";
import { composeTopologyViews } from "../src/topology-projection.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(process.env.FLOWPULSE_LOOP_OUTPUT_DIR || join(root, "outputs", "local-fault-loop"));
const temp = await mkdtemp(join(tmpdir(), "flowpulse-local-fault-loop-"));
const provider = createAgentTeamProvider({ providerKind: process.env.FLOWPULSE_AGENT_PROVIDER || "" });
const capability = await provider.preflight();
if (capability.provider_kind !== "codex-local" || capability.availability !== "available") {
  throw new Error("FLOWPULSE_AGENT_PROVIDER=codex-local with an authenticated local Codex CLI is required; recorded output is not accepted for this E2E loop.");
}

const capturedTopology = composeTopologyViews({ manifest: loadTopologyManifest(), incidentProjection: {}, overlay: {}, controls: {} });
const loop = new LocalFaultLoop({
  ledger: new Ledger(join(temp, "ledger.db")),
  modelAdapter: provider,
  topologyProvider: async () => capturedTopology
});
const suite = await loop.runAll();
if (suite.positive_run_count !== 9 || suite.recovered_count !== 9 || suite.negative_case?.state !== "needs_human") {
  throw new Error("Local fault loop acceptance did not complete every required recovery and negative gate.");
}

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "loop-report.json"), `${JSON.stringify(suite, null, 2)}\n`),
  writeFile(join(outputDir, "verification-matrix.md"), matrix(suite))
]);
console.log(JSON.stringify({
  output_dir: outputDir,
  run_count: suite.run_count,
  recovered_count: suite.recovered_count,
  negative_state: suite.negative_case.state,
  provider: { provider_kind: capability.provider_kind, truth_label: capability.truth_label, model_label: capability.model_label }
}));

function matrix(suite) {
  const rows = suite.runs.map((run) => {
    const roles = run.role_responses.map((item) => item.role).join(", ");
    const verification = run.events.find((event) => event.type === "local_fault_loop.verification.completed");
    const verificationState = verification ? (verification.payload.passed ? "passed" : "failed") : "not-run";
    return `| ${run.case_id} | ${run.round} | ${run.state} | ${roles} | ${run.citations.length} | ${verificationState} |`;
  });
  return [
    "# Local fault-to-recovery verification matrix",
    "",
    "All rows are isolated in-memory fixture simulations. Model summaries are hashed in the JSON report; raw provider output is intentionally omitted.",
    "",
    "| Case | Round | Final state | Local Codex roles | Citation count | Verification |",
    "| --- | ---: | --- | --- | ---: | --- |",
    ...rows,
    ""
  ].join("\n");
}

# FlowPulse

FlowPulse is an evidence-grounded incident control loop for production systems. Its generic Production Workspace unifies real or captured telemetry, change data, adversarial evaluation, owner-approved remediation, recovery verification, and regression learning in one inspectable record.

The flagship incident uses captured OpenTelemetry Astronomy Shop evidence. A checkout change makes payment unreachable, retries amplify traffic, Kafka lag grows, and accounting and fraud processing fall behind. The investigator first blames Kafka. The evaluator rejects that unsupported diagnosis, the investigator replans across deploy, commit, trace, log, and metric evidence, then proposes a checkout-only rollback for owner approval.

## Judge demo

Prerequisites:

- Node.js 20 or newer
- `sqlite3` available on `PATH`

Run the verified judge path:

```bash
npm install
npm run judge
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310), then:

1. Open **Diagnose**, then click **Run guided replay**.
2. Watch the shared system canvas replay propagation and the evaluator reject the Kafka diagnosis.
3. Select nodes or causal annotations to inspect the deploy, trace, log, and commit evidence used in the replan.
4. Click **Recover** at the human gate. The Manager shows the rejected claim, accepted cause, evidence IDs, and bounded proposal; use the separate Owner approval control to authorize it.
5. Watch **Agents** show execution, verification, Evolve, and Test from the same ledger events, then open **Compare** to inspect incident versus verified state.

The interactive path takes about 20 seconds. It is deterministic and needs no cloud credentials.

To run the server without tests:

```bash
npm run demo
```

To run all automated checks:

```bash
npm test
```

## Incident Digital Twin

The primary interface is one deterministic system canvas with five views of the same component identities:

- **Architecture** opens by default as a compact, line-free block stack. It arranges only observed components into stable semantic layers so the current system shape is readable before runtime traffic is introduced.
- **Live** shows only services and dependencies observed in a connected OTLP source on a wider zoomable and pannable canvas. Orthogonal routes stay outside component plaques; services without an observed dependency are isolated in an explicit `Evidence gap` column rather than given invented edges. With no source it displays an honest `Disconnected` state rather than fixture topology.
- **Diagnose** reconstructs any incident milestone from immutable events. Play, pause, step, restart, seek, and speed controls all use the same projection function.
- **Agents** reconstructs the isolated Monitor, Evidence, Diagnosis, Evaluator, Planner, Owner, Executor, Verification, Evolve, and Test roles from attributed ledger events. Every deterministic judge step crosses the typed `AgentTeamHarness`, which enforces role permissions, evidence references, budgets, parent events, idempotency, and sealed content hashes before the canonical runtime transition.
- **Compare** places the impact and verified recovery projections on the same geometry with an interactive split.

The canvas keeps the architecture visible while moving dense telemetry and reasoning into a contextual drawer. **Recover** opens a dedicated Manager report and activity feed; Manager chat can explain evidence or delegate a safe catalog action, but it cannot approve remediation. Metrics, logs, traces, deploys, evidence citations, agent reasoning, adversarial evaluation, repair, verification, and evolve gates remain reachable by selecting a node, edge, or event.

## Real local development loop

FlowPulse includes an opt-in integration with the official OpenTelemetry Astronomy Shop. It pins upstream commit `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`, starts the full Kafka profile, and fans actual Collector output into hashed trace, metric, and log JSONL streams. The upstream source and raw captures stay under the gitignored `outputs/live` runtime directory.

Prerequisites are Docker Engine with Compose, about 6 GB of available memory, and about 14 GB of free disk. Enable local mutations only for this disposable environment:

```bash
export FLOWPULSE_DEVELOPMENT_ENABLED=1
npm run live:check
npm run live:setup
npm run live:start
```

Restart FlowPulse with the same environment variable, open **Live**, and use **Start real case**. The working path is:

1. Apply the repository-owned `paymentUnreachable` change through the real flagd UI API.
2. Wait for fresh checkout/payment OTLP failure evidence.
3. Run **Investigate live evidence**. The evaluator rejects unsupported payment-service blame, correlates the versioned change with actual failure telemetry, and proposes the single allowlisted repair.
4. Approve the owner gate. FlowPulse restores the known-good flag and recreates only the local checkout container.
5. Use **Verify recovery** after fresh post-repair OTLP appears. The ledger records verification, a hashed regression capture reference, and deterministic policy gates.

Stop the disposable stack without removing captures:

```bash
npm run live:stop
```

The local adapter accepts no free-form model command. It resolves a checked-in change manifest and a single command ID, validates the pinned checkout, and refuses mutation unless `FLOWPULSE_DEVELOPMENT_ENABLED=1`.

## Live GPT-5.6 mode

FlowPulse also includes a real investigator, tool, evaluator, and feedback loop built on the OpenAI Responses API. Copy the example environment file and add an API key:

```bash
cp .env.example .env
```

```dotenv
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-5.6
```

Restart the server. The **Run fresh GPT-5.6** control will:

- Give GPT-5.6 strict, allowlisted metric, trace, log, deploy, and commit tools.
- Execute model-selected tools against the captured evidence bundle.
- Validate every returned evidence ID and repair boundary.
- Send the candidate diagnosis to a separate GPT-5.6 adversarial evaluator.
- Replan once with evaluator feedback if the claim is rejected.
- Record model calls, tool calls, decisions, latency, usage, and scores in the FlowPulse ledger.

GPT-5.6 is used through the Responses API with medium reasoning effort, strict function schemas, structured outputs, explicit token limits, `store: false`, and a stable safety identifier. The official guidance recommends the Responses API for reasoning and tool-calling workflows and documents `gpt-5.6` as the flagship alias: [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model), [Function calling](https://developers.openai.com/api/docs/guides/function-calling), and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Langfuse tracing

Add Langfuse credentials to `.env`:

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACE_URL=https://cloud.langfuse.com/project/your-project
```

When configured, the live loop and Agent Control Service mirror parent incident observations plus Manager turns, specialist actions, GPT-5.6 generations, evaluator calls, tool calls, latency, token usage, correlation metadata, and evaluator output to Langfuse using its current OpenTelemetry integration. Langfuse remains best-effort observability. It cannot transition the incident, approve a repair, or promote a policy, and FlowPulse does not couple runtime behavior to Langfuse's internal ClickHouse schema. See the official [Langfuse tracing guide](https://langfuse.com/docs/observability/get-started) and [OpenTelemetry integration](https://langfuse.com/integrations/native/opentelemetry).

## Architecture

```text
real Collector JSONL or captured evidence bundle
        |
        v
allowlisted evidence tools <-> GPT-5.6 investigator
        |                         |
        |                         v
        |                   adversarial evaluator
        |                         |
        v                         v
code-owned incident state machine and human gate
        |
        +--> append-only SQLite ledger (runtime authority)
        +--> Langfuse observations (best-effort mirror)
        +--> deterministic digital-twin projections
        +--> deterministic regression gates
```

The runtime is intentionally small:

- One Node.js process serves the API and browser digital twin.
- SQLite triggers reject every update and delete to the event table.
- Starting a new replay appends a new run; it never clears history.
- UI state is projected from immutable events.
- Replay and real-development mode share the same ledger and safety boundaries.
- Consequential remediation cannot execute before an `approval.granted` event.
- Specialist agents emit proposals; only the coordinator and code-owned executor can request canonical runtime transitions, and the executor remains behind both the owner gate and the repair allowlist.

The original product contract is in [`docs/specs/2026-07-16-flowpulse-design.md`](docs/specs/2026-07-16-flowpulse-design.md). The current Incident Digital Twin contract is in [`docs/specs/2026-07-16-incident-digital-twin-redesign.md`](docs/specs/2026-07-16-incident-digital-twin-redesign.md). The real Production Workspace contract is in [`docs/specs/2026-07-17-live-development-workspace.md`](docs/specs/2026-07-17-live-development-workspace.md).
The Manager and synchronized specialist-operations contract is in [`docs/specs/2026-07-17-agent-control-and-transparent-recovery.md`](docs/specs/2026-07-17-agent-control-and-transparent-recovery.md).
The compact Architecture, routed Live, and harness-linkage refinement is in [`docs/superpowers/specs/2026-07-17-compact-architecture-and-orchestrated-live-design.md`](docs/superpowers/specs/2026-07-17-compact-architecture-and-orchestrated-live-design.md).

## Evidence bundle

[`data/incidents/astronomy-checkout.json`](data/incidents/astronomy-checkout.json) contains:

- A compact, normalized OTLP capture manifest covering metrics, logs, and traces
- Service topology and propagation edges
- Checkout, payment, and Kafka metrics
- Checkout and accounting logs
- A failing checkout-to-payment trace
- Checkout deployment metadata
- The AI-generated commit diff that changed payment endpoint resolution
- A bounded rollback definition
- Before and after verification evidence
- A deterministic regression case

Every material model claim must cite an evidence ID present in this bundle.

## Eval / Evolve control plane

FlowPulse distinguishes:

- `confirmed_system_bug`
- `agent_false_positive`
- `insufficient_evidence`
- `tool_data_failure`
- `repair_failure`
- `regression`

Candidate policy `evidence-policy-v2` must pass six deterministic gates: false-diagnosis rejection, causal evidence coverage, approval-before-repair ordering, bounded repair target, recovery thresholds, and regression creation. Passing makes it eligible for owner review, not automatically active.

## Safety contract

- Evidence scope is restricted to the selected incident bundle or the registered local OTLP spool.
- Tool names and schemas are fixed in code.
- Evidence references are validated after model generation.
- Only the checked-in checkout rollback boundary and allowlisted local command ID are accepted.
- The judge repair is a captured replay, never a production mutation.
- Owner approval is mandatory and immutable.
- Tool loops stop after six rounds; evaluator feedback gets one replan.
- Langfuse failure never affects runtime authority.

## How Codex and GPT-5.6 were used

Codex was the primary engineering environment for this repository. It was used to define the bounded product design, implement the ledger and state machine, build the cockpit, author the incident bundle, add the OpenAI and Langfuse adapters, write tests, run browser verification, and keep the repository scoped to the competition demo.

GPT-5.6 is part of the product, not only a development aid. In credentialed model mode it performs evidence acquisition through function tools against the captured bundle, produces a structured causal diagnosis and bounded repair proposal, and independently evaluates that diagnosis against an adversarial rubric. The real local-development path uses the same ledger and evidence/evaluator gates with actual OTLP data and a code-owned allowlisted adapter; it remains usable without model credentials. Deterministic replay exists alongside both paths so judges can evaluate the complete product without network access.

## Repository map

```text
data/incidents/                 captured incident and regression evidence
docs/specs/                     approved design contract
docs/judge-script.md            under-three-minute presentation path
public/                         dependency-free Incident Digital Twin
integrations/astronomy-shop/    pinned runtime and allowlisted change
src/ledger.mjs                  append-only SQLite authority
src/runtime.mjs                 bounded replay state machine
src/live-source.mjs             OTLP provenance and topology projection
src/development-runtime.mjs     local agent/evaluator/owner loop
src/development-adapter.mjs     allowlisted flag and Docker adapter
src/agent-control-service.mjs   ledger-derived Manager and agent graph projection
src/agent-team-harness.mjs      typed specialist proposal and role-isolation boundary
src/openai.mjs                  live GPT-5.6 tool and evaluator loop
src/observability.mjs           Langfuse OpenTelemetry mirror
src/policy.mjs                  deterministic promotion gates
src/server.mjs                  local API and static server
test/                           ledger, runtime, determinism, and API checks
```

## Limitations

The competition build ships one real local incident, one local repair type, and one complex captured judge incident. The real path requires a warmed Docker environment and treats Collector JSONL as a bounded append-only spool rather than a general telemetry warehouse. It does not connect to production, Kubernetes, or any external deployment authority. The complex Kafka-causality story remains captured replay because the live path claims only the simpler checkout/payment mechanism supported by observed local telemetry.

## License

MIT. See [`LICENSE`](LICENSE).

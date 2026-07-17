# FlowPulse

FlowPulse is an evidence-grounded incident control loop for production systems. It unifies telemetry, change data, adversarial evaluation, owner-approved remediation, recovery verification, and regression learning in one inspectable record.

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

1. Click **Run guided replay**.
2. Watch the evaluator reject the Kafka diagnosis.
3. Inspect the deploy, trace, log, and commit evidence used in the replan.
4. Click **Approve checkout rollback** at the human gate.
5. Watch recovery verification and the offline policy gates complete.

The interactive path takes about 20 seconds. It is deterministic and needs no cloud credentials.

To run the server without tests:

```bash
npm run demo
```

To run all automated checks:

```bash
npm test
```

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

When configured, the live loop mirrors a parent incident observation plus nested GPT-5.6 generations, evaluator calls, tool calls, latency, token usage, correlation metadata, and evaluator output to Langfuse using its current OpenTelemetry integration. Langfuse remains best-effort observability. It cannot transition the incident, approve a repair, or promote a policy. See the official [Langfuse tracing guide](https://langfuse.com/docs/observability/get-started) and [OpenTelemetry integration](https://langfuse.com/integrations/native/opentelemetry).

## Architecture

```text
captured evidence bundle
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
        +--> cockpit projections
        +--> deterministic regression gates
```

The runtime is intentionally small:

- One Node.js process serves the API and browser cockpit.
- SQLite triggers reject every update and delete to the event table.
- Starting a new replay appends a new run; it never clears history.
- UI state is projected from immutable events.
- Replay and live mode share the same ledger and safety boundaries.
- Consequential remediation cannot execute before an `approval.granted` event.

The approved design contract is in [`docs/specs/2026-07-16-flowpulse-design.md`](docs/specs/2026-07-16-flowpulse-design.md).

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

- Evidence scope is restricted to the selected incident bundle.
- Tool names and schemas are fixed in code.
- Evidence references are validated after model generation.
- Only `rollback_deployment` against `checkout` is accepted.
- The judge repair is a captured replay, never a production mutation.
- Owner approval is mandatory and immutable.
- Tool loops stop after six rounds; evaluator feedback gets one replan.
- Langfuse failure never affects runtime authority.

## How Codex and GPT-5.6 were used

Codex was the primary engineering environment for this repository. It was used to define the bounded product design, implement the ledger and state machine, build the cockpit, author the incident bundle, add the OpenAI and Langfuse adapters, write tests, run browser verification, and keep the repository scoped to the competition demo.

GPT-5.6 is part of the product, not only a development aid. In live mode it performs evidence acquisition through function tools, produces a structured causal diagnosis and bounded repair proposal, and independently evaluates that diagnosis against an adversarial rubric. Deterministic replay exists alongside the live loop so judges can evaluate the complete product even without credentials or network access.

## Repository map

```text
data/incidents/                 captured incident and regression evidence
docs/specs/                     approved design contract
docs/judge-script.md            under-three-minute presentation path
public/                         dependency-free incident cockpit
src/ledger.mjs                  append-only SQLite authority
src/runtime.mjs                 bounded replay state machine
src/openai.mjs                  live GPT-5.6 tool and evaluator loop
src/observability.mjs           Langfuse OpenTelemetry mirror
src/policy.mjs                  deterministic promotion gates
src/server.mjs                  local API and static server
test/                           ledger, runtime, determinism, and API checks
```

## Limitations

The competition build intentionally ships one incident, one repair type, and captured production evidence. A live OpenTelemetry collector and Kubernetes rollback adapter are clear extension points, but they are not judge-path dependencies and are not granted production authority in this repository.

## License

MIT. See [`LICENSE`](LICENSE).

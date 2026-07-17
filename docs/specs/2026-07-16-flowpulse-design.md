# FlowPulse competition design

## Product boundary

FlowPulse is a new standalone developer tool. It turns fragmented production telemetry into a bounded incident loop: investigate, challenge, repair, verify, and learn. This repository contains only the FlowPulse implementation, its captured evidence, its tests, and its documentation.

## Competition claim

FlowPulse does not merely summarize an incident. It makes causal claims earn their evidence, blocks consequential remediation behind owner approval, verifies the result, and turns both the system failure and the agent's false diagnosis into regression cases.

## Flagship story

An AI-generated checkout change makes the payment service unreachable in an OpenTelemetry Astronomy Shop incident. Checkout retries amplify traffic and contribute to Kafka lag, delaying accounting and fraud consumers.

The investigator initially blames Kafka. An adversarial evaluator rejects that hypothesis because the evidence only establishes downstream lag, not the initiating fault. The investigator replans across deployment, commit, trace, log, and metric evidence, identifies the checkout deployment as the causal change, proposes a checkout-only rollback, waits for owner approval, verifies recovery, classifies the outcome, and creates a deterministic regression case.

## Smallest winning architecture

FlowPulse runs as one Node.js process and a browser UI:

- Native HTTP server exposes the product API and static cockpit.
- Native SQLite stores append-only incident events.
- A code-owned state machine enforces transitions, limits, approval gates, and stop conditions.
- Captured evidence is stored as a versioned JSON incident bundle.
- Replay mode emits canonical decisions and tool evidence deterministically.
- Live mode uses the OpenAI Responses API with GPT-5.6, strict function tools, and structured outputs.
- Langfuse receives mirrored LLM/tool observations. It never controls runtime state.
- The UI renders projections derived from the ledger rather than mutable workflow state.

No microservices, workflow framework, frontend framework, message broker, or external database are required for the judge path.

## Runtime loop contract

### Goal

Produce an evidence-cited root-cause finding, a bounded repair proposal, verified recovery, and a reusable regression record.

### Input scope

The agent may use only evidence in the selected incident bundle through allowlisted tools. It may not invent telemetry, mutate arbitrary services, or broaden the repair target beyond the implicated deployment.

### Execute

1. Open the incident and inspect symptoms.
2. Query metrics and form an initial hypothesis.
3. Submit the hypothesis to the evaluator.
4. On rejection, record counter-evidence and replan.
5. Query deploy, commit, trace, and log evidence.
6. Submit the revised causal finding.
7. Propose a bounded rollback with target, reason, checks, timeout, and abort condition.
8. Pause for owner approval.
9. Execute the replay or allowlisted live repair adapter.
10. Query verification evidence and compare before versus after.
11. Classify the outcome and generate a regression case.
12. Run the case through deterministic policy gates.

### Checks

- Every hypothesis cites existing evidence IDs.
- A causal finding must include initiating change, failure mechanism, and downstream propagation.
- Counter-evidence must be visible and preserved.
- A repair target must match the implicated service and allowed action.
- Repair execution requires an approval ledger event.
- Recovery requires payment reachability, checkout error-rate, and Kafka-lag thresholds.
- Policy promotion requires all deterministic cases to pass.

### Feedback rules

- Unsupported hypothesis: reject, record the gap, and request the next evidence category.
- Missing evidence: classify `insufficient_evidence` and stop.
- Tool error or malformed data: classify `tool_data_failure` and stop after two attempts.
- Repair does not satisfy thresholds: classify `repair_failure`; do not retry a different mutation automatically.
- Regression gate failure: keep the candidate policy inactive and record the failed case.

### Records

All commands, evidence, hypotheses, evaluations, state transitions, approvals, repairs, verification checks, classifications, and policy-gate results are immutable ledger events with stable IDs and correlation IDs.

### Stop conditions

Success stops after verified recovery and a passing regression record. Failure stops on insufficient evidence, exhausted tool retries, rejected approval, failed repair verification, or any requested action outside the approved boundary.

### Human gates

The owner approves consequential remediation. A human also owns candidate-policy promotion and any expansion beyond the checkout-only rollback.

## Ledger

Each event contains:

- `id`, `incident_id`, and monotonic `sequence`
- `recorded_at` and incident-relative `offset_ms`
- `type`, `actor`, and `payload`
- `evidence_refs` and optional `parent_id`
- `correlation_id` for OpenAI and Langfuse trace linkage

SQLite constraints prevent updates and deletes. API code exposes append and read operations only. Projections compute the current incident stage, selected hypothesis, approval state, verification summary, and regression status.

## Evidence model

The sample bundle includes topology, metrics, traces, logs, commits, deploys, repair metadata, and verification snapshots. Evidence is addressed by stable IDs. Tool responses return evidence IDs plus compact facts, so model claims remain inspectable.

The canonical causal chain is:

`checkout commit -> checkout deployment -> incorrect payment endpoint -> connection refusal -> retries -> Kafka lag -> accounting/fraud delay`

Kafka lag is genuine evidence but counter-evidence to Kafka as the initiating cause.

## GPT-5.6 integration

Live mode uses the OpenAI Responses API and defaults to the `gpt-5.6` alias. The investigator receives only relevant strict function tools. Tool calls are executed by FlowPulse and recorded before their outputs return to the model. The evaluator is a separate GPT-5.6 call with a strict structured result and no remediation tool.

The code keeps reasoning effort and token ceilings explicit. It validates evidence references and policy fields even when structured output succeeds. Replay mode is clearly labeled and does not pretend to make live model calls.

## Langfuse boundary

When configured, FlowPulse mirrors model generations, tool spans, latency, token usage, cost metadata, scores, and incident correlation IDs to Langfuse. Telemetry export is best effort. A Langfuse timeout or outage records an observability warning but cannot change the incident state or approve a repair.

## Eval and Evolve control plane

Outcomes use six explicit classes:

- `confirmed_system_bug`
- `agent_false_positive`
- `insufficient_evidence`
- `tool_data_failure`
- `repair_failure`
- `regression`

A candidate policy is a versioned data record. Promotion gates check evidence citation, causal completeness, false-diagnosis rejection, approval enforcement, repair bounds, recovery thresholds, and deterministic replay snapshots. Promotion is a human action and remains unavailable while any gate fails.

## Cockpit

The judge sees one responsive dark operations cockpit with three working regions:

- Incident and topology: blast radius, service health, and replay position.
- Investigation: loop stages, hypotheses, evidence, counter-evidence, and evaluator decisions.
- Action and learning: rollback proposal, approval, verification, before/after comparison, classification, and regression result.

The topology is a semantic service graph built from real incident entities, not a decorative illustration. Motion is limited to replay progress, state transitions, and affected-path emphasis, with reduced-motion support. Keyboard focus, contrast, status text, loading, empty, and error states are required.

## Judge path

`npm run demo` starts FlowPulse in replay mode with a fresh disposable ledger. The cockpit provides a guided Run next control and an automatic 2-minute replay option. The sequence visibly includes the false Kafka diagnosis, evaluator rejection, evidence-driven correction, owner approval pause, rollback, verification, and regression gate.

`npm test` runs ledger, runtime, policy, API, and deterministic replay checks. `npm run judge` runs tests and starts the demo.

## Scope budget

- One flagship incident bundle
- One investigator and one evaluator role
- Six evidence query tools
- One repair type: checkout deployment rollback
- One owner approval gate
- One candidate policy and deterministic regression suite
- One cockpit route
- One local database

Live Kubernetes/OpenTelemetry ingestion is an adapter seam and documentation path, not a judge-path dependency.

## Acceptance

- Fresh setup works from the English README.
- Replay is deterministic and completes in under three minutes.
- Live mode makes real GPT-5.6 tool-calling and evaluator requests when credentials are present.
- Every material diagnosis cites evidence present in the bundle.
- The evaluator rejects the unsupported Kafka diagnosis.
- No repair runs without owner approval.
- Recovery is verified against explicit thresholds.
- The false diagnosis and system failure create a regression case.
- A failing backtest blocks policy promotion.
- Langfuse is observable but non-authoritative.
- The repository contains a license, sample bundle, tests, and documentation of Codex and GPT-5.6 usage.

## Explicit non-goals

FlowPulse does not provide general production write access, multi-tenancy, authentication, a policy-training pipeline, an incident-chat product, live cluster provisioning, or a generic telemetry warehouse in this build.

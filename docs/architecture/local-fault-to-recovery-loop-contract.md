# Local fault-to-recovery Agent Loop contract

## Compatibility status

This document describes the legacy Node local-fault-loop **compatibility/demo** simulator. It remains available for deterministic local evaluation until the real FastAPI/Temporal control-plane equivalent is integrated. It does not grant incident authority, lifecycle authority, tenant authorization, production mutation authority, or a substitute for backend current proof.

## Boundary

This is an isolated, deterministic fixture simulator. It never opens a cloud connection, container control socket, repository working tree, production database, account, or user-machine configuration. Every mutation is an in-memory, reversible fixture repair recorded in the append-only local SQLite ledger.

Successful end-to-end runs require `FLOWPULSE_AGENT_PROVIDER=codex-local` and an authenticated local Codex CLI. The loop rejects `recorded` and `openai-responses` as E2E providers; recorded remains available only to unit tests. Codex produces bounded role summaries, while FlowPulse code owns routing, evidence, authority, repair, verification, and final truth.

## Cases and authority

| Case ID | Initiating condition | Required false-causal rejection | Fixture repair | Authority |
| --- | --- | --- | --- | --- |
| `checkout-payment-config` | Checkout selects unreachable `payment:9090`; Kafka lag follows. | Kafka is the initiating cause. | Restore the checkout payment endpoint. | Low-risk, task-authorized local fixture repair. |
| `kafka-consumer-pause` | Isolated consumer group pauses before lag accumulates. | Checkout/payment failure initiated the lag. | Resume the isolated consumer group. | Low-risk, task-authorized local fixture repair. |
| `database-pool-exhaustion` | Isolated accounting pool reaches its connection ceiling. | Kafka broker health initiated accounting timeouts. | Reset the isolated connection pool. | Low-risk, task-authorized local fixture repair. |
| `insufficient-evidence` | Anomaly only; no origin/mechanism/timing evidence. | Any repair target is known. | None. | `needs_human`; no repair event is emitted. |

Each positive case runs three independent rounds. Every round has unique `run_id` and `incident_id`, an immutable event/evidence sequence, four local-Codex role calls, a bounded repair, and three post-repair checks: root condition removed, direct symptom cleared, and downstream lag converged.

## API

Start exactly one fixture run. `idempotency_key` is optional for one-off local CLI use and required for a browser retry-safe start:

```http
POST /api/demo/agent-loop/run
Content-Type: application/json

{"case_id":"checkout-payment-config","round":1,"idempotency_key":"live-demo-checkout-001"}
```

The request permits only `case_id`, `round` (1–3), and `idempotency_key`. It validates and reserves the immutable run/incident identity, then returns `202` before provider work starts:

```json
{
  "schema_version": "flowpulse.local-fault-loop.v2",
  "run_id": "local-loop-checkout-payment-config-1-...",
  "incident_id": "incident-local-checkout-payment-config-1-...",
  "state": "running",
  "stage": "monitor",
  "events_url": "/api/demo/agent-loop/events?run_id=...&after=0",
  "contextual_workspaces": {"context":{"run_id":"...","incident_id":"...","selected_component":"checkout","timeline":{"position":3,"event_id":"...","stage":"monitor","terminal_state":null}},"actions":{"view_diagnosis":{"available":false,"prerequisites":[{"id":"bounded_incident_opened","satisfied":false}]},"open_recovery_console":{"available":false,"prerequisites":[{"id":"evaluated_remediation_plan_or_repair_started","satisfied":false}]},"compare_recovery":{"available":false,"prerequisites":[{"id":"independent_verification_completed","satisfied":false},{"id":"implemented_repair_recovered","satisfied":false}]}}}
}
```

The same idempotency key returns this original identity and never starts a second fault injection, model sequence, repair, or verification. A reservation has a bounded server-side lease (three minutes by default). After a server interruption, an expired reservation is safely terminalized as `failed` with `local_fault_loop_interrupted`; it is never resumed because replaying a repair or model call could duplicate side effects. `insufficient-evidence` is a valid case ID for the no-repair `needs_human` path.

Read any recorded run without invoking a model:

```http
GET /api/demo/agent-loop?run_id=local-loop-kafka-consumer-pause-2-...
```

Replay only safe ordered events over SSE; the browser never polls or receives raw ledger rows:

```http
GET /api/demo/agent-loop/events?run_id=local-loop-kafka-consumer-pause-2-...&after=0
```

Each `local-fault-loop` event has the projected event ID/sequence/time, actor, event type, bounded payload, and evidence IDs. The stream replays events whose sequence is greater than `after` or `Last-Event-ID`, sends one-second heartbeats while the run is active, and emits exactly one terminal `local-fault-loop-state` event before closing. It never invokes another model or repair on reconnect.

Every GET and SSE event also carries `contextual_workspaces`. Its `context` preserves the canonical `run_id`, `incident_id`, selected component, and exact timeline sequence/event/stage. Its actions are advisory launch prerequisites only: `view_diagnosis` becomes available after `incident.opened`; `open_recovery_console` after an evaluated remediation plan or repair begins; and `compare_recovery` only after a repair was implemented, independently verified, and the terminal state is `recovered`. These flags never authorize, start, or alter the loop. Failed and insufficient-evidence runs therefore keep Compare unavailable while exposing their terminal state or human gate.

Provider capability checking is part of the background run so the POST remains fast. The local preflight only verifies that the configured Codex executable can run; it deliberately does not invoke `codex login status`, because that installed CLI command can block despite normal authenticated `codex exec` use. Authentication is therefore exercised only by the bounded real invocation (hard-capped at 120 seconds by default), whose nonzero/timeout result becomes a sanitized terminal failure. An unavailable or malformed `codex-local` provider never substitutes recorded text.

## Ordered event projection

The browser renders event order directly; it does not infer hidden transitions or read raw ledger rows.

| Event | Render stage | Required safe fields |
| --- | --- | --- |
| `local_fault_loop.baseline.captured` | monitor | baseline truth and citations |
| `local_fault_loop.fault.injected` | fault | bounded fault, affected components, reversible scope |
| `local_fault_loop.observer.detected` | detect | anomaly IDs and impacted components |
| `local_fault_loop.orchestrator.routed` / `.handoff.recorded` | diagnose | explicit requested/responding role and handoff reason; Observer → Orchestrator → Investigator → Evaluator transitions are runtime-owned (`ownership: "runtime_deterministic"`) rather than contingent on a model recommendation |
| `local_fault_loop.hypothesis.proposed` / `.evaluation.rejected` / `.evaluation.accepted` | diagnose/evaluate | cited hypothesis, score, false-causal decision |
| `local_fault_loop.plan.proposed` / `.authority.decided` | plan/approve-or-auto | risk, reversibility, authority outcome |
| `local_fault_loop.repair.executed` | repair | local-only bounded repair and attempt |
| `local_fault_loop.verification.completed` / `.recovered` | verify/recovered | independent checks and final state |
| `local_fault_loop.stopped` | needs-human | stop reason; no fabricated repair/verification |
| `local_fault_loop.failed` | failed | sanitized provider/topology failure classification; no recorded fallback |

When independent verification fails, the projection records `local_fault_loop.repair.rolled_back`, reinvestigates and replans once, then either recovers after the second bounded attempt or emits `local_fault_loop.stopped` with `needs_human`. It never marks a failed verification as recovered.

`local_fault_loop.role.response` and `role_responses` carry only schema-validated display data:

```json
{
  "role":"investigator",
  "requested_agent":"investigator",
  "responding_agent":"investigator",
  "state":"completed",
  "safe_answer":"Bounded explanation with cited evidence IDs.",
  "citations":["ev-local-..."],
  "handoff":null,
  "tools":[{"tool":"read_evidence_summaries","result_count":6}],
  "answer_sha256":"...",
  "answer_bytes":280
}
```

`safe_answer` is capped at 280 Unicode characters / 1,200 bytes, control characters and credential-shaped tokens are redacted, and invalid provider output terminates the run. The projection never exposes a raw prompt, model payload, chain of thought, raw logs/traces, secrets, or Codex credentials.

## Local execution and reports

Run the complete 9+1 suite only with local Codex:

```sh
FLOWPULSE_AGENT_PROVIDER=codex-local npm run demo:multi-case-loop
```

The command creates ignored local artifacts at `outputs/local-fault-loop/` by default:

- `loop-report.json`: machine-readable immutable-event projections for all ten runs.
- `verification-matrix.md`: concise case/round/final-state/role/citation/verification matrix.

The reports are evidence of the local fixture simulator only; they do not claim production remediation.

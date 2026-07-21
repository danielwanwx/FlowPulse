# Local fault-to-recovery Agent Loop contract

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

Start exactly one positive fixture run:

```http
POST /api/demo/agent-loop/run
Content-Type: application/json

{"case_id":"kafka-consumer-pause","round":2}
```

The request permits only `case_id` and `round` (1–3). The response is a fully replayable projection:

```json
{
  "schema_version": "flowpulse.local-fault-loop.v1",
  "run_id": "local-loop-kafka-consumer-pause-2-...",
  "incident_id": "incident-local-kafka-consumer-pause-2-...",
  "case_id": "kafka-consumer-pause",
  "round": 2,
  "state": "recovered",
  "stage": "recovered",
  "citations": ["ev-local-..."],
  "role_responses": [
    {"role":"observer","provider":{"provider_kind":"codex-local"},"answer_sha256":"...","answer_bytes":280,"citations":["ev-local-..."]}
  ],
  "events": []
}
```

Read any recorded run without invoking a model:

```http
GET /api/demo/agent-loop?run_id=local-loop-kafka-consumer-pause-2-...
```

Replay only safe ordered events over SSE; the browser never polls or receives raw ledger rows:

```http
GET /api/demo/agent-loop/events?run_id=local-loop-kafka-consumer-pause-2-...&after=0
```

Each `local-fault-loop` event has the projected event ID/sequence/time, actor, event type, bounded payload, and evidence IDs. A terminal `local-fault-loop-state` event carries `state`, `stage`, provider label, and final record. `Last-Event-ID` resumes the safe projection. The same stream works as an incremental projection when a run is in progress and as a full replay after it finishes.

If the configured provider is not an available `codex-local` provider, the POST returns `409` with `local_codex_provider_unavailable`. It never substitutes recorded text.

## Ordered event projection

The browser renders event order directly; it does not infer hidden transitions or read raw ledger rows.

| Event | Render stage | Required safe fields |
| --- | --- | --- |
| `local_fault_loop.baseline.captured` | monitor | baseline truth and citations |
| `local_fault_loop.fault.injected` | fault | bounded fault, affected components, reversible scope |
| `local_fault_loop.observer.detected` | detect | anomaly IDs and impacted components |
| `local_fault_loop.orchestrator.routed` / `.handoff.recorded` | diagnose | explicit requested/responding role and handoff reason |
| `local_fault_loop.hypothesis.proposed` / `.evaluation.rejected` / `.evaluation.accepted` | diagnose/evaluate | cited hypothesis, score, false-causal decision |
| `local_fault_loop.plan.proposed` / `.authority.decided` | plan/approve-or-auto | risk, reversibility, authority outcome |
| `local_fault_loop.repair.executed` | repair | local-only bounded repair and attempt |
| `local_fault_loop.verification.completed` / `.recovered` | verify/recovered | independent checks and final state |
| `local_fault_loop.stopped` | needs-human | stop reason; no fabricated repair/verification |
| `local_fault_loop.failed` | failed | sanitized provider/topology failure classification; no recorded fallback |

When independent verification fails, the projection records `local_fault_loop.repair.rolled_back`, reinvestigates and replans once, then either recovers after the second bounded attempt or emits `local_fault_loop.stopped` with `needs_human`. It never marks a failed verification as recovered.

`role_responses` carries only role ID, provider label, answer hash/byte count, schema-validated handoff metadata, and citation IDs. It never exposes a raw prompt, model payload, chain of thought, raw logs/traces, secrets, or Codex credentials.

## Local execution and reports

Run the complete 9+1 suite only with local Codex:

```sh
FLOWPULSE_AGENT_PROVIDER=codex-local npm run demo:multi-case-loop
```

The command creates ignored local artifacts at `outputs/local-fault-loop/` by default:

- `loop-report.json`: machine-readable immutable-event projections for all ten runs.
- `verification-matrix.md`: concise case/round/final-state/role/citation/verification matrix.

The reports are evidence of the local fixture simulator only; they do not claim production remediation.

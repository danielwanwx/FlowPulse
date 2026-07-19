# FlowPulse three-stage autonomy and incident-integration design

Status: approved product design; implementation requires a separate reviewed plan

Date: 2026-07-18

Baseline: `d0b3f85adc1c65b9c34600aa1d4f9830a6c32cb1`

Scope: competition P0 design only. This document grants no remediation,
provider, deployment, notification-delivery, or production authority.

## 1. Decision and loop contract

### Product decision

**FlowPulse — Incident Flight Recorder + Agentic Autotriage — is an
evidence-bound harness: it reconstructs causality, rejects unsupported
diagnoses, and advances only policy-safe actions through deterministic gates
and human approval.**

It is a Developer Tools product, not a generic observability dashboard,
connector marketplace, autonomous production responder, or data-platform
control plane.

The operating loop is:

```text
Monitor -> Agent Workbench -> Decision & Recovery -> Monitor
```

### Loop contract

| Element | Contract |
| --- | --- |
| Goal | Give an operator a replayable, evidence-backed incident decision without giving a model, UI, connector, or fixture remediation authority. |
| Inputs | Server-owned ledger, checked-in policy registry, frozen evidence snapshots, bounded source health, and typed repair contracts. |
| Execute | Normalize evidence, freeze it, investigate with bounded tools, challenge claims, apply deterministic gates, record a policy decision, then require the applicable human gate. |
| Check | Exact evidence/provenance/causal/contract/freshness/lock checks; post-action verification and offline backtest where a real action is permitted. |
| Feedback | Unknown, stale, malformed, contradictory, or unavailable input is non-actionable; it never falls back to fixture evidence or permissive UI state. |
| Record | The append-only ledger records evidence refs, evaluator outcome, decision, human action, receipt, verification, and learning result. |
| Stop | Stop at insufficient evidence, model/tool failure, stale source, evaluator rejection after the bounded replan, missing owner, failure lock, or failed verification. |
| Human gate | Checkout-to-payment remains per-incident Owner-Gated. Any external effect, publishing, or real low-risk rollout needs separate authorization. |

## 2. Honest capability ledger

The following labels are independent. A single label such as `live` must never
stand in for all three facts.

| Axis | Exact enum | Meaning |
| --- | --- | --- |
| `source_health` | `live | stale | disconnected | unavailable` | Current reachability and freshness of the source. |
| `evidence_mode` | `live_stream | frozen_real_snapshot | captured_fixture` | Where the evidence being reasoned over came from. |
| `execution_mode` | `deterministic_replay | gpt_model_only | real_local_development | captured_simulation` | What generated the workflow state or action record. |

Truth rules:

- A frozen real OTLP snapshot is `evidence_mode=frozen_real_snapshot`, even if
  its source was live when captured. It is never displayed as a live stream.
- The credential-free judge path is a captured fixture running in
  `deterministic_replay` mode.
- The historical real local Astronomy Shop proof is a narrower
  `real_local_development` record. It is not proof that the local stack is
  currently ready.
- The preserved paid GPT workflow is a `gpt_model_only` attempt over a frozen
  real snapshot that failed closed. It did not create a repair proposal,
  approval, or repair execution.
- A low-risk demonstration in P0 is `captured_fixture` plus
  `captured_simulation`; it emits `action.simulated`, never `repair.executed`,
  a live receipt, delivered notification, or executed-backtest proof.

Current product sources are the captured incident bundle and OTLP JSONL
projection. They remain the only product sources in P0.

## 3. Three operating stages

### Monitor

Monitor exposes health, source truth, topology, active incident state, changes,
and bounded evidence summaries. Architecture and Live remain Monitor subviews.

Entry: application load, ledger resume, or source-health update.

Exit: a deterministic trigger opens an incident, or a human starts an eligible
investigation against a server-owned frozen snapshot.

If source health is stale, disconnected, or unavailable, Monitor remains
visible and explicitly degraded. It must not start an investigation or present
captured data as live.

### Agent Workbench

Agent Workbench exposes a bounded evidence loop:

```text
goal -> snapshot -> bounded tools -> hypothesis -> independent evaluator
     -> at most one replan -> deterministic diagnosis gate -> policy decision
```

It shows selected and omitted evidence, tool coverage, hypotheses,
counter-evidence, evaluator outcome, and why the harness stopped. The model,
knowledge base, summaries, and role-card UI are advisory; immutable evidence
and deterministic validators are authoritative.

Exit: an accepted deterministic diagnosis yields a policy decision, or any
unverifiable condition yields a visible blocked/escalated decision with no
repair authority.

### Decision & Recovery

Decision & Recovery shows the policy decision, exact contract, risk factors,
blast radius, rollback, verification plan, Owner Gate, receipt, Compare view,
regression, backtest, and policy result.

Medium checkout-to-payment work requires an explicit per-incident Owner Gate.
Low P0 work is a captured policy simulation only. High, SEV-1, unavailable,
stale, conflicting, or locked decisions are non-actionable.

## 4. Authority model

The only future authority chain is:

```text
server-owned capture + append-only Ledger + checked-in registry
  + trusted time + private freshness receipt + bounded lock query
  -> private authority closure
  -> autonomy.decision.recorded
  -> bounded backend projection
  -> UI
```

### Slice 2 authority closure

Slice 2 creates the one private, non-exported server composition closure. It
owns the real Ledger, checked-in registry, capture/snapshot store, trusted time,
freshness issuance and verification, lock validation, and decision derivation.
Its only request-facing input is a server-resolved exact selector:

```json
{ "run_id": "...", "incident_id": "...", "intent_id": "..." }
```

The closure obtains all authority-bearing inputs itself. A route, request,
model, UI, fixture, replay cursor, or connector cannot submit or select risk,
registry, intent definition, snapshot, evidence set, freshness, lock state,
contract hash, preauthorization, receipt, or authority object.

The closure appends one canonical `autonomy.decision.recorded` event only after
it verifies the exact frozen snapshot, gate-event IDs/sequences/payload hashes,
evidence record IDs/hashes/sources/modes, contract hash/target/action, active
policy envelope, trusted freshness receipt, and relevant locks. It accepts no
legacy compact evaluator rows as authority.

Slice 2 is authority integration only. It does not add a new connector, UI,
projection, decision endpoint, executor, live auto-action, or browser test.

### Progressive autonomy

Every hard factor is conjunctive. Severity, model confidence, an advisory KB
item, a summary, or a notification record can only block or explain; none can
grant authority.

| Outcome | Required conditions | Execution |
| --- | --- | --- |
| `auto_execute_pre_authorized` | Low impact; exact active preauthorization; complete fresh evidence; accepted evaluator and deterministic gate; one reversible/idempotent component; exact contract; verification/rollback ready; zero related failures; recordable notification. | P0 does not enable a live executor. Only a captured simulation may demonstrate the state. |
| `human_review_required` | Causal mechanism and exact contract are proven but the action is customer-path or otherwise medium risk. | Owner approval required. Checkout-to-payment is always here. |
| `explicit_human_decision_required` or `blocked` | High/SEV-1, missing/contradictory/stale evidence, unavailable source, failed lock check, failed action/verification, or policy mismatch. | No FlowPulse execution. |

Any failed action or verification creates an incident + contract hash + target
failure lock. A new run cannot evade it. P0 has no unlock endpoint.

## 5. Canonical integration boundary

### EntityGraph

The canonical entity kinds are:

```text
service | deployment | dag | job | task | topic | dataset | table | query | incident
```

Each entity has a canonical ID, kind, bounded display name, namespace,
provider label, provenance ref, and hash. Relations are evidence-backed facts,
such as `calls`, `publishes_to`, `consumes_from`, `produces`, `reads`, `writes`,
`scheduled_by`, `deployed_by`, and `affects`. Provider identity is visual
metadata only; it never controls policy or authority.

### EvidenceEnvelope v1

Every normalized record has this logical contract:

```json
{
  "id": "ev_...",
  "schema_version": "flowpulse.evidence-envelope.v1",
  "source": {
    "connector_id": "...",
    "connector_version": "...",
    "evidence_mode": "live_stream | frozen_real_snapshot | captured_fixture"
  },
  "signal_kind": "trace | log | metric | change | lineage | run | incident",
  "observed_at": "RFC3339 timestamp",
  "frozen_at": "RFC3339 timestamp or null",
  "entity_refs": ["canonical entity IDs"],
  "safe_fact": "typed, allowlisted, bounded semantic fields",
  "provenance": { "record_hash": "sha256", "source_hash": "sha256" },
  "integrity_hash": "sha256",
  "redaction_version": "..."
}
```

No raw payload, trace/span/context ID, SQL text, credential, or
high-cardinality attribute is a valid `safe_fact`. Source-specific normalizers
must derive bounded semantic facts before this contract is emitted.

### Connector capability manifest

Each future connector declares immutable versioned metadata:

```text
connector id/version; supported entity and signal kinds; discover/topology/
evidence/action/verification capabilities; strict input/output schemas;
required scopes; source-health/freshness rules; page/byte limits; provenance;
risk class; and redaction version.
```

`action` and `verification` are reserved capability names. They are disabled in
P0 and cannot mint authority, bypass a FlowPulse policy decision, or execute a
repair.

### Connector scope

P0 provides only the contract plus two offline fixtures:

1. a lineage fixture showing `dag/job/task -> dataset/table`; and
2. a stream-and-warehouse fixture showing `topic -> consumer/job -> query/table`.

Those fixtures validate normalization and projection contracts. They do not
claim live Airflow, Kafka, dbt, Snowflake, BigQuery, Databricks, Spark,
Kubernetes, GitHub, or PagerDuty support.

OpenLineage JSONL ingestion and every vendor-specific adapter are P1. The
captured incident bundle and OTLP source remain the P0 product sources.

## 6. IncidentProjection v1

Projection is a later slice, not Slice 2. It is the sole browser-facing
incident state and is derived from ordered ledger events plus bounded source
projection; it never reads a UI mode, local timer, model text, or client risk
value.

Required top-level fields:

```text
schema_version, projection_revision, incident, stage, stage_status,
source_health, evidence_mode, execution_mode, graph, timeline,
investigation, decision, human_gate, action, verification, learning,
why_stopped, truncated, next_cursor
```

Hard limits for one serialized projection:

| Field | Limit |
| --- | ---: |
| Graph nodes | 128 |
| Graph edges | 256 |
| Timeline frames per page | 100 |
| Evidence summaries | 64 |
| Evidence refs per event | 32 |
| Serialized projection | 256 KiB UTF-8 |
| Strings | bounded, schema-specific UTF-8 limits; no free-form raw source data |

Projection uses deterministic ordering and deterministic truncation. It returns
`truncated=true` and an opaque `next_cursor` when more frames or detail exist.
Unknown schema/version/enum/cursor, stale source, lock-query overflow,
unavailable source, malformed event, or missing required reference yields an
explicit non-actionable projection; it never defaults to ready or automatic.

Legacy rows project `legacy_detail_unavailable`, never an inferred passing
decision.

## 7. Frontend design and ownership

The three primary tabs are exactly:

```text
Monitor -> Agent Workbench -> Decision & Recovery
```

Architecture and Live become Monitor subviews. Diagnose and evaluator activity
become Agent Workbench subviews. Owner Gate, receipt, verification, Compare,
and learning become Decision & Recovery subviews. The white visual incident
reconstruction, topology, timeline, right-side evidence drawer, reduced-motion
support, and Compare visual remain product differentiators.

The browser consumes one `IncidentProjectionClient` interface:

- `BackendIncidentProjectionClient` reads the bounded state/evidence APIs and
  event stream.
- `DemoBundleProjectionClient` reads an immutable generated captured
  projection with the identical schema.

Demo-client selection is build-time or server-owned and immutable. It cannot
come from a query string, localStorage, request body, model output, or UI
control. The demo client is read-only except fixed captured replay commands.

The replay cursor selects a historical rendered frame only. It cannot advance
the ledger, set current stage/risk/approval/action/verification, or influence
authority. Timers may animate presentation only. Provider glyphs are a pure
glyph registry and never control business logic.

The frontend never computes or carries risk, freshness, evidence completeness,
locks, contract hash, preauthorization, receipt validity, authority, action
truth, or repair truth. Unknown, stale, malformed, unavailable, or
schema-mismatched projection data disables action controls and displays why.

## 8. Slice separation and implementation order

The following ordering is mandatory; it prevents authority changes from being
hidden inside UI or integration work.

1. **Slice 2 — authority integration only.** Private closure, canonical
   decision record, checkout Owner-Gate preservation, failure locks, and
   authority tests. No projection/UI/connectors/endpoints/executor.
2. **Sol authority review.** No next slice begins without approval.
3. **Projection slice.** Implement bounded `IncidentProjection v1`, state API
   compatibility, cursor behavior, truth-label mapping, and golden tests.
4. **UI migration slice.** Move the existing visual replay into the three
   stages using projection only; no client-side decision inference.
5. **Decision interaction slice.** Add exact approve/reject/defer behavior
   after server-side contract binding and idempotent claims are proven.
6. **Demo and browser slice.** Add the low captured policy simulation, medium
   Owner-Gate replay, Playwright E2E, release checks, and copy corrections.

The P0 browser harness is Playwright. It must run two automated fresh-server
flows: the captured low-risk simulation and the medium checkout Owner-Gate
path. If the harness cannot be installed and run reliably within the allocated
time, stop and retain the existing deterministic judge path rather than claim
automated E2E coverage.

## 9. Flagship demo and submission truth

The default three-minute judge path is deterministic captured replay:

```text
versioned checkout configuration change -> payment failure -> retry/Kafka lag
-> downstream delay -> weak Kafka hypothesis rejected -> evidence replan
-> checkout-only repair proposal -> Owner Gate -> captured verification
-> regression record
```

This is explicitly `captured_fixture` + `deterministic_replay`. It may show
Kafka/accounting/fraud propagation only because the captured bundle supports
that narrative.

The recorded local proof is shown separately as narrower provenance:

```text
checkout flag change -> observed checkout flag consumption -> direct payment
resolver failure -> owner-approved allowlisted rollback -> fresh local proof
```

The two stories are never spliced into one causal timeline. No copy says
“AI-generated regression” without author/change provenance. No copy says GPT
performed the deterministic repair.

Parallel submission work, outside implementation authority, is time-critical:

- public/accessible repository and deterministic test instructions;
- a sub-three-minute public video showing the captured replay and truth labels;
- hosted deterministic URL or an equally clear test path;
- `/feedback` Session ID generated from the core development task;
- Devpost fields and final human review.

The stated submission deadline is 2026-07-21 17:00 PDT. This does not justify
weakening evidence, authority, or truth-label gates.

## 10. Acceptance gates

### Slice 2 authority gates

- Only the private server closure can produce a decision from real ledger,
  server-owned snapshot, registry, trusted time, receipt, and locks.
- A selector with any unknown/missing/mismatched field is non-actionable.
- Checkout always produces `human_review_required`; zero repair execution
  exists before Owner approval.
- Captured simulation cannot produce a live receipt, `repair.executed`,
  delivered notification, or executed-offline-backtest promotion.
- Stale/unknown/malformed source, receipt, gate event, evidence reference,
  snapshot, cursor, or lock-query result is non-actionable.

### Projection and frontend gates

- Projection contract/golden tests cover truth labels, bounds, truncation,
  legacy rows, stale/unavailable state, and evidence-link integrity.
- UI import guards prove no browser module imports policy authority, registry,
  receipt issuer/verifier for decisions, or executor controls.
- The browser renders the three stages exclusively from backend projection.
- Both Playwright paths verify source/evidence/execution truth labels, why
  stopped, Owner Gate ordering, and zero console errors at 1440x900 and
  1280x800.

### Demo and release gates

- The default demo works with no Docker, provider credential, or live source.
- It never labels a captured fixture, frozen snapshot, simulation, or
  deterministic repair as live GPT remediation.
- Existing deterministic replay, causal gates, Owner Gate, recovery checks,
  regression, and backtest remain green.

## 11. P0, P1, and explicit drops

### P0

- Slice 2 authority integration and its review.
- Bounded IncidentProjection and three-stage migration in later slices.
- Two offline connector-contract fixtures only.
- Captured low-risk policy simulation and checkout Owner-Gate replay.
- Playwright coverage for both paths and submission-ready truthful copy.

### P1

- OpenLineage JSONL ingestion.
- GitHub, Kubernetes, Airflow, dbt, Kafka, warehouse, Databricks, Spark,
  BigQuery/Dataflow, Snowflake, and PagerDuty adapters.
- External notification delivery, RBAC, policy authoring UI, external approval,
  and actual low-risk production rollout.
- Advisory retrieval and cross-run policy recommendations.

### Dropped for this competition

- Generic connector marketplace or multi-tenant observability SaaS.
- Free-form shell, Kubernetes, database, or production command execution.
- Generic multi-agent fan-out or personalized memory.
- Severity-only automation, automatic SEV-1 repair, retries after failed
  repair/verification, and historical ledger rewrites.

## 12. Stop conditions and user review gate

Stop implementation and return to the deterministic judge path if any of the
following occurs:

- authority composition would need a public provider, snapshot registration,
  freshness issuer, or caller-controlled clock;
- a required evidence record cannot fit the bounded projection;
- projection cannot distinguish frozen real, captured fixture, and live stream;
- a connector would need to issue authority or expose raw/sensitive payloads;
- browser E2E needs mock-only decision state;
- an implementation changes checkout from Owner-Gated medium risk; or
- timing forces a choice between truthful deterministic replay and unstable
  live integration.

This document is the written-spec gate. The user must review it before an
implementation plan is written or Slice 2 begins.

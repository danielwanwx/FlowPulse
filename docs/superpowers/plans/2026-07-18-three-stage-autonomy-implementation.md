# FlowPulse competition implementation plan: incident flight recorder

Status: authoritative implementation plan after approved design review

Date: 2026-07-18

Design input: commit 633d4bc210a939b63f9158f5e5a9a9fb860ea472,
docs/superpowers/specs/2026-07-18-three-stage-autonomy-design.md

Baseline authority hardening: d0b3f85adc1c65b9c34600aa1d4f9830a6c32cb1

Deadline: 2026-07-21 17:00 PDT

## 1. Goal and loop contract

### Goal

Ship the smallest credible Developer Tools submission for Incident Flight Recorder +
Agentic Autotriage: a white visual incident reconstruction that replays a causal
story, makes a rejected Kafka hypothesis and replan legible, keeps consequential
repair behind an Owner Gate, and distinguishes every evidence and execution mode.

### Loop contract

| Element | Contract |
| --- | --- |
| Input | Existing captured replay, server-owned ledger, checked-in policy artifacts, frozen evidence snapshots, current dirty harness work, and approved design spec. |
| Execute | Integrate authority first, then projection, then UI, then automated replay paths, then release evidence. |
| Check | Tests precede code in every slice; authority and truth labels fail closed; release checks use a fresh process. |
| Feedback | Unknown, stale, malformed, contradictory, or unavailable input is non-actionable and never falls back to fixture or permissive UI state. |
| Record | Ledger, bounded projection, QA record, release check, and this plan identify captured, frozen real, model-only, simulated, and real-local facts. |
| Stop | Stop on a public authority-mint seam, truth-label ambiguity, Owner-Gate regression, unbounded projection, mock-only browser state, or unavailable paid-run preconditions. |
| Human gates | Paid GPT run, disposable local owner approval, hosted URL, video upload, /feedback, and Devpost submission are explicit human or external gates. |

### Fixed invariants

1. The append-only ledger and deterministic validators are authoritative.
   Models, connectors, browser state, summaries, KB items, fixtures, and
   Langfuse never grant action authority.
2. Checkout-to-payment remains medium risk and per-incident Owner-Gated.
3. P0 low-risk behavior is captured policy simulation only: action.simulated,
   never repair.executed, external delivery, live receipt, or executed-backtest
   promotion.
4. Slice 2 is authority integration only. It includes no projection migration,
   UI migration, connector ingestion, decision endpoint, or executor change.
5. Credential-free captured replay remains the default judge path. A successful
   real GPT-5.6 proof is a separate release requirement, not a replacement.
6. No task may overwrite, stage, reset, or clean pre-existing dirty work.
7. All implementation, review, frontend/backend coordination, and release
   evidence remain in this competition session; no task is delegated outside it.

## 2. Current gap ledger

This ledger is the factual starting point. “Verified” means verified by the
cited committed work or the supervising thread's reported 151/151 test run; it
does not reclassify uncommitted files as committed.

| Area | Status | Current evidence | Remaining action or gate |
| --- | --- | --- | --- |
| Deterministic captured judge replay | complete and verified | src/runtime.mjs, src/bundle.mjs, test/runtime.test.mjs, submission check | Preserve as default and relabel through later projection/UI only. |
| Ledger authority primitives and public-mint hardening | complete and verified | commits through d0b3f85; src/ledger.mjs, src/autonomy-policy.mjs, src/autonomy-freshness.mjs, policy/ledger tests | Slice 2 composes them privately; it must not re-export factory, issuer, store, or registration seams. |
| GPT response boundary, harness manifest, context compiler, offline backtest | present but uncommitted | dirty openai, openai-response, context-compiler, harness-manifest, regression-backtest files and harness directory | Re-run, isolate, and commit this user-owned work before an overlapping Slice 2 edit. Do not recreate it. |
| Real local OTLP development proof | partial | dirty development adapter/runtime, code-evidence files, QA record | Runtime readiness and fresh evidence are external conditions; do not call it currently ready. |
| Successful real GPT-5.6 investigator/evaluator proof | blocked by runtime and credential gate | one preserved paid run failed closed; no accepted model recovery proof | One separately authorized, no-retry workflow only after preflight and fresh evidence. |
| Slice 2 private authority composition | missing | foundation exports only non-authority helpers | Implement after dirty harness isolation; Sol review is mandatory afterward. |
| Canonical autonomy.decision.recorded in runtime | missing | approved schema exists in spec; no current canonical path | Slice 2. |
| IncidentProjection v1 | partial | stateWithSource and evidence APIs exist; no v1 contract, caps, or orthogonal truth modes | Projection slice after Slice 2 review. |
| Three-stage UI and projection clients | partial | public app has five fixed modes, local cursor/timers, and Astronomy topology; no strict backend/demo client pair | Render-only UI slice consumes projection only; D.1 enables no controls until server contract passes. |
| Generic integration proof | missing | captured bundle and OTLP JSONL are product sources; no connector manifest | P0 contract plus two offline fixtures only. |
| OpenLineage and vendor ingestion | intentionally deferred | none | P1; no pre-deadline adapter. |
| Captured low-risk policy simulation | missing | checked-in low-risk artifact exists, but no ledger-derived action.simulated runtime path | Slice E.0 before browser E2E; no live action/receipt/backtest. |
| Automated browser E2E | missing | package has no Playwright dependency or script | P0 fresh-server Playwright paths after UI contract stabilizes. |
| Submission assets | partial / human-external | README, Devpost draft, video script, screenshots, checklist exist; hosted URL/video/confirmed Session ID pending | Parallel human track; update only after represented proof exists. |

## 3. Reconciled architecture and contracts

This plan replaces contradictory sequencing in the older plan. It retains the
existing authority tests but follows the approved design exactly.

### 3.1 Authority chain

    server-owned capture + actual Ledger + checked-in registry
      + trusted time + private freshness receipt + bounded lock query
      -> private authority closure
      -> autonomy.decision.recorded
      -> IncidentProjection v1
      -> UI

The private closure lives at the server composition root. Its only
request-facing input is the server-resolved selector:

    { run_id, incident_id, intent_id }

The closure reads Ledger rows and frozen snapshots itself and loads the
checked-in registry itself. Routes, requests, models, UI, fixtures, cursors, and
connectors cannot supply risk, registry, intent definition, snapshot, evidence
set, freshness, lock state, contract hash, preauthorization, receipt, or an
authority object.

The canonical decision binds schema/policy/envelope/contract hashes; exact
incident/run/environment; snapshot ID/content/manifest hash; freshness receipt
hash; gate event IDs/sequences/payload hashes; evidence ID/hash/source/mode
bindings; action/target; factor results; outcome; and bounded reason codes.

### 3.2 Truth labels

Every projection and visible screen carries all three independent fields:

    source_health:  live | stale | disconnected | unavailable
    evidence_mode:  live_stream | frozen_real_snapshot | captured_fixture
    execution_mode: deterministic_replay | gpt_model_only |
                    real_local_development | captured_simulation

Frozen real evidence is never presented as a live stream. The Kafka,
accounting, and fraud propagation story is captured-fixture-only. The real
local story is limited to checkout flag consumption and a direct payment
resolver failure. No copy says an AI generated the regression without a
recorded change-author/provenance field.

### 3.3 IncidentProjection v1

Projection is a later slice. It retains current state fields and adds:

    schema_version, projection_revision, incident, stage, stage_status,
    source_health, evidence_mode, execution_mode, graph, timeline,
    investigation, decision, human_gate, action, verification, learning,
    why_stopped, truncated, next_cursor

| Item | Limit |
| --- | ---: |
| Nodes | 128 |
| Edges | 256 |
| Timeline frames per page | 100 |
| Evidence summaries | 64 |
| Evidence refs per event | 32 |
| Serialized projection | 256 KiB UTF-8 |

Ordering and truncation are deterministic. Overflow returns truncated=true plus
an opaque next_cursor. Unknown schema, enum, or cursor; stale/disconnected/
unavailable source; missing evidence; malformed event; and lock overflow all
render unavailable/non-actionable. Legacy rows expose
legacy_detail_unavailable, never an inferred passing decision.

### 3.4 P0 connector boundary

P0 defines only a connector contract and two offline fixtures. Captured bundle
and OTLP JSONL remain the only product sources.

- Canonical entity kinds: service, deployment, dag, job, task, topic, dataset,
  table, query, incident.
- Evidence envelope: ID, schema version, connector ID/version, evidence mode,
  signal kind, observed/frozen time, entities, allowlisted safe fact,
  provenance hashes, integrity hash, and redaction version.
- Manifest capabilities: discover, topology, evidence, action, verification,
  with strict schemas, bounds, provenance, freshness, scope, and risk.
  Action and verification are reserved and disabled in P0.
- Fixtures: lineage fixture, dag/job/task -> dataset/table; stream-and-warehouse
  fixture, topic -> consumer/job -> query/table.

OpenLineage JSONL ingestion and all vendor adapters are P1. A connector cannot
create or choose a decision, contract, receipt, or action truth.

## 4. Slice A — worktree and authority preflight

Purpose: avoid overwriting user-owned harness work or building a Slice 2 closure
against unverified dirty inputs.

Files: no product file changes. Future commit isolation may include only
user-approved dirty harness files after their own review.

Checks first:

    git status --short
    npm test
    npm audit --audit-level=high
    git diff --check

Actions:

1. Record HEAD, status, and hashes for dirty paths.
2. Classify dirty files as harness, real-development, docs/submission, or
   unrelated user work.
3. If the reported 151/151 suite is reproducible, isolate the already-present
   harness change in its own commit before an authority-integration commit
   touches the same files.
4. Keep runtime databases, OTLP output, logs, credentials, and generated
   captures ignored.

Acceptance: only intended files are staged in any resulting commit; the
pre-existing dirty fingerprint remains identical outside that commit.

Stop: an overlapping dirty file cannot be safely isolated, a harness test fails,
or an authority regression appears. Stop rather than reset or rewrite user work.

## 5. Slice B — Slice 2 private authority integration only

Purpose: append a canonical fail-closed autonomy decision after a valid
diagnosis without adding projection, UI, connectors, routes, or execution.

### Exact two-phase orchestration

The authority seam is deliberately singular:

1. The exported investigation functions in `src/openai.mjs` and
   `src/development-runtime.mjs` may collect evidence, run the evaluator, append
   buffered hypothesis/evaluation events, and append `diagnosis.gate.passed`.
   They return a bounded diagnosis-gate result. They must never append
   `autonomy.decision.recorded`, `repair.proposed`, or `approval.requested`, and
   they receive no policy callback, provider, capability, registry, snapshot,
   receipt, lock list, clock, or authority object.
2. The existing `src/server.mjs` composition root owns one **non-exported**
   `advanceAutonomyAfterDiagnosis(selector)` closure. Its exact input is only
   `{ run_id, incident_id, intent_id }`. It re-reads the actual `Ledger`, loads
   the checked-in artifact internally, resolves the server-owned frozen capture,
   issues and verifies its trusted freshness receipt, queries locks, derives the
   decision, and appends `autonomy.decision.recorded` atomically.
3. Only that same private closure may, after a `human_review_required` decision,
   append the exact checked-in `repair.proposed` and `approval.requested` events.
   It derives their contract and evidence refs from the canonical decision; no
   exported runtime/model module can pre-append them.

This preserves the exact checkout order:

    diagnosis.gate.passed
    -> autonomy.decision.recorded(human_review_required)
    -> repair.proposed
    -> approval.requested
    -> approval.granted
    -> repair.executed
    -> verification.completed

The existing routes may call the private closure only as an internal continuation
of their current investigation handler. Slice B adds no endpoint, request field,
or executor behavior. Model-only investigations remain non-executable.

Allowed files, and no others:

- `src/server.mjs`: define the non-exported closure and wire the internal,
  selector-only continuation after an existing investigation completes.
- `src/openai.mjs`: stop at the verified diagnosis gate; remove any pre-decision
  proposal/approval append.
- `src/development-runtime.mjs`: stop at the verified diagnosis gate; remove any
  pre-decision proposal/approval append.
- `test/server.test.mjs`, `test/openai-contract.test.mjs`,
  `test/gpt-development-integration.test.mjs`,
  `test/development-runtime.test.mjs`, `test/ledger.test.mjs`, and
  `test/autonomy-policy.test.mjs`.

Slice B reuses the already-accepted `src/ledger.mjs`, `src/autonomy-policy.mjs`,
`src/autonomy-freshness.mjs`, and `src/autonomy-policy-artifacts.mjs` unchanged.
If those primitives are insufficient, stop and return to plan review; do not
expand the Slice B file set. Forbidden exports and seams: an authority
provider/factory, frozen-snapshot registration, freshness issuer, injected
clock, injected registry, policy callback/capability, or a
request/body/model/UI supplied authority field.

Write these red tests first:

1. `server authority closure emits one canonical decision`: a real Ledger,
   server-owned frozen snapshot, and checked-in registry produce exactly one
   decision; no public import can mint it.
2. `investigators stop before authority`: accepted GPT and deterministic
   development diagnosis gates leave zero `repair.proposed`/
   `approval.requested` until the private server continuation runs.
3. `checkout decision preserves exact Owner Gate`: checkout is medium,
   exact-contract-bound, and has zero `repair.executed` before
   `approval.granted`.
4. `authority inputs fail closed`: unknown selector, stale/expired/mismatched
   receipt, malformed/future/legacy evaluator, duplicate/conflicting evidence,
   contract mismatch, missing source, lock overflow, and exact/cross-run failure
   lock are non-actionable.
5. `authority claim conflict never grants execution`: an `appendIfAbsent`
   conflict creates no second decision/claim and cannot grant permission.

Focused verification:

    node --test test/autonomy-policy.test.mjs test/ledger.test.mjs \
      test/development-runtime.test.mjs test/runtime.test.mjs \
      test/openai-contract.test.mjs test/gpt-development-integration.test.mjs \
      test/server.test.mjs
    npm test
    npm audit --audit-level=high
    git diff --check

Acceptance: no public mint path, no route/body authority input, exact decision
bindings, checkout Owner Gate intact, and every negative test fails closed.

Records: record pre/post dirty fingerprints, the exact decision event ID and
binding hashes from the passing test, the focused/full test output, and the
isolated staged-file list.

Stop/rollback: a public issuer/provider/snapshot-registration seam, decision
before valid gate events, changed Owner-Gate order, or an overlapping dirty file
that cannot be safely isolated blocks the slice. Stop without staging or
committing in the overlap case. Otherwise revert only this slice's commit; never
reset user work.

## 6. Mandatory Sol review gate

After Slice B, stop. Sol must adversarially review exports/import graph, private
composition, selector-only inputs, receipt/time/snapshot/evidence bindings,
cross-run locks and bounded overflow, decision/contract/evaluator semantics, and
absence of endpoint/UI/connector/executor creep.

Only explicit approval unlocks the projection slice.

## 7. Slice C — IncidentProjection v1

Purpose: derive the sole browser-facing state from ordered ledger events and
bounded source metadata.

Files:

- Add src/incident-projection.mjs with pure projection, validation,
  deterministic ordering/truncation, and cursor helpers.
- src/server.mjs: attach compatible projection in stateWithSource while
  retaining existing top-level response fields.
- src/agent-control-service.mjs: consume projection rather than infer a second
  current stage/risk.
- src/autonomy-freshness.mjs: map receipt state into the three orthogonal truth
  fields without calling a frozen snapshot a live stream.
- Add test/incident-projection.test.mjs; extend server, agent-control-service,
  and twin-state contract tests only.

Write these red tests first:

1. Golden event streams: monitor healthy/degraded, collection, evaluator
   rejection/replan, medium Owner Gate, verification, blocked failure, legacy.
2. 129 nodes, 257 edges, 101 frames, 65 summaries, 33 refs/event, and a
   >256 KiB candidate prove deterministic truncation or non-actionable output.
3. Unknown schema/enum/cursor, stale/disconnected source, missing evidence,
   malformed/inverted events, and lock overflow cannot render ready.
4. Captured fixture, frozen real snapshot, GPT model-only, real-local
   development, and captured simulation render distinct truth-axis combinations.
5. Existing state/evidence/replay fields stay compatible while v1 is present.

Focused verification:

    node --test test/incident-projection.test.mjs test/server.test.mjs \
      test/agent-control-service.test.mjs test/twin-state.test.mjs
    npm test
    git diff --check

Acceptance: 256 KiB maximum is measured from serialized JSON, every overflow is
explicit, and UI consumers need no local policy calculation.

Stop: incompatible state response, need for raw telemetry/model text, or a
failure to distinguish frozen real from live stream.

## 8. Slice C.1 — connector contract and offline fixtures

Purpose: prove a generic evidence/dataflow boundary without claiming vendor
integration. This sidecar starts only after Slice C freezes the projection
schema and runs serially before UI work that consumes its fixtures. It does not
touch UI, authority composition, runtime ingestion, or the projection module.

Files:

- Add src/evidence-envelope.mjs for strict normalized-envelope validation.
- Add src/connector-manifest.mjs for versioned capability manifests.
- Add test/fixtures/integration/lineage-v1.json and
  test/fixtures/integration/stream-warehouse-v1.json.
- Add test/integration-contract.test.mjs.

`src/incident-projection.mjs` is explicitly out of scope here. The fixtures are
validated against the already-frozen v1 public schema; a needed schema change is
a return to Slice C with a new Sol review, not a parallel C.1 edit.

Red tests:

- entity kind, relation, envelope, manifest, provenance, hash, source mode,
  redaction, and byte-limit validation;
- both fixtures normalize to stable graph/evidence projections;
- unknown provider, raw SQL/credential/context ID, enabled action capability, or
  connector-supplied authority/contract/receipt fails closed;
- provider glyph changes never change policy output.

Focused verification:

    node --test test/integration-contract.test.mjs test/incident-projection.test.mjs
    npm test
    git diff --check

Acceptance: fixtures prove contract only; no claim of live Kafka, Airflow, dbt,
warehouse, OpenLineage, or vendor connectivity.

Stop: a vendor credential, live connector, OTLP-source change, or action
capability is required.

## 9. Slice D — three-stage frontend migration

Purpose: preserve white visual replay while replacing client-owned stage
inference with projection-driven Monitor, Agent Workbench, and Decision &
Recovery.

Files:

- public/index.html: exactly three primary tabs and accurate ARIA labels.
- public/app.js: add the exact `BackendIncidentProjectionClient` and
  `DemoBundleProjectionClient` implementations behind one strict
  `IncidentProjectionClient` schema boundary. Replace local
  stage/risk/approval/verification inference with backend projection; retain
  cursor/timers for presentation only.
- public/twin-state.mjs: retain deterministic geometry/glyphs but accept
  server-selected stage/frame data; remove policy inference.
- public/styles.css: stage navigation and truth badges without redesigning the
  white canvas or visual hierarchy.
- Extend test/twin-state.test.mjs and add a small frontend contract test only if
  it can be browser-independent.

Client selection is immutable build/server configuration, not a query parameter,
localStorage value, request body, model output, UI control, or fallback. Both
clients validate the identical projection schema. A backend fetch/schema failure
renders unavailable/non-actionable state; it never falls back to the demo
bundle. `DemoBundleProjectionClient` is read-only except for the fixed captured
replay command defined in Slice E.0.

Red tests:

1. Three primary tabs with keyboard/focus behavior; topology, drawer, timeline,
   Compare, zoom, and reduced motion remain reachable.
2. UI renders stage, risk, evidence, evaluator rejection/replan, Owner Gate,
   receipt, verification, and why-stopped only from a valid projection.
3. Unknown/missing/stale/schema-mismatched projection disables controls and
   labels unavailable.
4. Backend and demo clients pass the same projection golden cases; immutable
   client selection, backend failure, and schema failure cannot select or fall
   back to a demo truth mode.
5. UI imports no policy authority, registry, receipt issuer, executor, or model
   tool; localStorage/query/request cannot choose demo source/truth mode.
6. Historical cursor changes only the viewed frame and cannot append an event,
   authorize repair, or mark a current stage.

Slice D is render-only. All approve/reject/defer/action controls remain disabled
and explanatory until Slice D.1's server-resolved, decision-ID-bound, idempotent
endpoints have passed their tests. Existing `/api/approve` and
`/api/development/approve` compatibility routes and their default owner labels
must never be used as a temporary browser authority path.

Focused verification:

    node --test test/twin-state.test.mjs test/incident-projection.test.mjs test/server.test.mjs
    npm test
    git diff --check

Acceptance: Architecture/Live are Monitor; Diagnose/evaluator work is Agent
Workbench; Owner Gate/Compare/verification/learning are Decision & Recovery.
There is no mock-only authority state.

Stop: any UI behavior depends on local risk decision, untrusted fixture
selection, or lost evidence detail.

### Frontend-backend traceability

| Screen or action | Endpoint / source | Runtime transition | Ledger / projection | Rendered result | Contract test |
| --- | --- | --- | --- | --- | --- |
| Open Monitor | immutable `BackendIncidentProjectionClient` or `DemoBundleProjectionClient` selection; GET /api/state only for backend | none | ordered events + source -> IncidentProjection | source/truth badges, topology, current stage | client parity + server/projection golden |
| Inspect entity | GET /api/evidence/:id | none | bounded redacted evidence detail | drawer fact/hash/provenance | evidence API + UI contract |
| Start Workbench investigation | existing bounded investigation endpoint; server resolves run | snapshot -> tool loop -> evaluator -> deterministic gate | safe tool/failure/gate events -> projection | selected evidence, rejection/replan, why-stopped | openai/development + projection |
| Review medium decision | GET /api/state | none | canonical decision event -> projection | risk, contract, Owner Gate; controls disabled in D | projection + browser |
| Approve/reject/defer | D.1 only: POST /api/decision/* with decision_id and local actor only | server resolves active decision/contract | approval or defer event -> projection | returned loading/success/error state | server concurrency + browser |
| Run low policy demo | E.0 only: fixed captured replay command | server-resolved captured simulation | action.simulated -> projection | exact captured-simulation message | runtime/server + low E2E |
| Verify / Compare | GET state plus bounded evidence | code-owned verification only | verification/regression/backtest -> projection | before/after and learning result | runtime/backtest + medium E2E |

The UI cannot derive or submit risk, source freshness, registry, evidence set,
lock state, contract hash, preauthorization, authority, receipt, or repair
truth. Unknown/stale/schema-mismatched projection data is disabled/non-actionable.
Neither client may fall back from failed backend data to a demo bundle.

## 10. Slice D.1 — decision interaction hardening

Purpose: expose owner approve, reject, and defer as ledger-derived decisions
without letting a browser button select a run, contract, source, envelope, or
executor.

Files:

- src/server.mjs: add exact decision endpoints only after the private authority
  decision exists. Keep existing approval routes as compatibility wrappers that
  cannot bypass exact decision/contract/lock checks.
- src/development-runtime.mjs and src/runtime.mjs: reuse the exact existing
  approval boundary and add narrow reject/defer transitions only where a
  canonical decision is waiting.
- src/autonomy-policy.mjs: add pure validation/event builders only if the
  decision-ID and idempotent claim rules cannot stay in the private closure.
- Tests: test/server.test.mjs, test/development-runtime.test.mjs,
  test/runtime.test.mjs, test/agent-control-service.test.mjs.

Allowed browser payloads are a bounded current decision_id and a local demo
actor label. The server resolves every other value. P0 has no external RBAC or
notification delivery claim. This is the first slice that may enable the
previously disabled Slice D controls; compatibility endpoints/default owner
labels are not an alternative path and must reject requests without an exact
waiting decision.

Red tests:

1. Forged run, decision, owner, contract, source, envelope, or preauthorization
   fields append zero authority events.
2. Concurrent double approval produces one atomic claim, one approval, and one
   executor entry; the losing request receives a bounded conflict.
3. Reject/defer is one-shot; defer records missing evidence classes and next
   precondition, makes zero provider calls, and does not reset model budget.
4. Failed execution preserves approval history, emits repair.execution.failed
   and autonomy.locked, and prevents retry or cross-run auto eligibility.

Focused verification:

    node --test test/server.test.mjs test/development-runtime.test.mjs \
      test/runtime.test.mjs test/agent-control-service.test.mjs
    npm test
    git diff --check

Acceptance: every visible decision action is server-resolved, exact-contract
bound, idempotent, and ledger-derived. Checkout remains Owner-Gated.

Stop: any compatibility wrapper can bypass policy, an actor label becomes RBAC,
or a defer implicitly starts GPT/provider work.

## 11. Slice E.0 — deterministic captured-simulation backend

Purpose: add the low-risk captured-policy path required by the approved design
before browser automation. It is a ledger-derived simulation, not an executor,
receipt issuer, or production action.

Allowed files, and no others:

- `src/runtime.mjs`: define the code-owned fixed captured replay transition.
- `src/server.mjs`: expose it only through the existing fixed captured replay
  command after server-side run resolution; it accepts no risk, authority,
  contract, source, receipt, registry, or preauthorization fields.
- `test/runtime.test.mjs` and `test/server.test.mjs`.

The sole successful low-risk ledger sequence is:

    autonomy.decision.recorded(auto_execute_pre_authorized,
      evidence_mode=captured_fixture, execution_mode=captured_simulation)
    -> notification.recorded(status=recorded_local,
      delivery_mode=captured_simulation)
    -> action.simulated
    -> captured verification/learning events

It must never append `repair.executed`, `approval.granted`, a live receipt,
`backtest.completed(source=executed_offline_backtest)`, promotion, or an
external-delivery event. A captured-simulation run cannot mutate the selected
source or be reclassified as real local development.

Write these red tests first:

1. `captured low simulation is ledger-derived`: the fixed command creates the
   exact sequence from a server-resolved run and no request field selects policy
   or truth mode.
2. `captured simulation cannot acquire real action truth`: assert the forbidden
   events and receipt/promotion modes are absent.
3. `unknown or stale captured decision is non-actionable`: malformed decision,
   missing evidence, or unavailable source appends no `action.simulated`.

Focused verification:

    node --test test/runtime.test.mjs test/server.test.mjs
    npm test
    git diff --check

Acceptance: the low path is reproducible with no Docker or credentials, and its
only action label is `action.simulated`.

Stop/rollback: any need for a live action connector, writable source, model call,
external notification, or executed-backtest claim blocks the slice. Revert only
this isolated simulation commit.

## 12. Slice E — deterministic demos and automated browser E2E

Purpose: prove both product paths against a fresh server without Docker, OpenAI
credentials, local timer truth, or manual client state injection.

Files:

- package.json and package-lock.json: add the smallest Playwright dependency and
  test:e2e script only after measuring install/time feasibility.
- Add playwright.config.mjs with temporary ledger, isolated port, and
  deterministic source path.
- Add test/e2e/low-captured-simulation.spec.mjs and
  test/e2e/medium-owner-gate.spec.mjs.
- Extend scripts/submission-check.mjs only if browser smoke fits the
  under-three-minute judge budget; otherwise retain E2E as a release command.

Paths:

1. Low captured simulation: captured_fixture plus captured_simulation; hard
   factors pass; local/simulated notification and action.simulated occur; no
   real receipt or promotion appears.
2. Medium checkout Owner Gate: captured replay shows causal propagation,
   explicit Kafka rejection, replan to checkout/payment, zero execution before
   approval, exact contract, captured verification, and regression/backtest.

Both run at 1440x900 and 1280x800, fail on console errors, assert evidence-link
integrity, and prove no browser request sends risk, source, registry, contract,
envelope, or authority fields.

Focused verification:

    npm run test:e2e
    npm test
    npm audit --audit-level=high
    git diff --check

Acceptance: both paths are deterministic, browser-visible, and ledger-derived.
No mock stream, fixture, cursor, or timer mints authority.

Stop: Playwright cannot run reliably in time or requires a live stack/provider.
Keep current deterministic smoke and do not claim automated E2E completion.

## 13. Slice F — successful real GPT-5.6 release proof

Purpose: obtain one honest reproducible GPT evidence-to-recovery proof while
keeping deterministic replay as the default judge path.

This is not a coding slice. It starts only after all code slices pass and a
human explicitly authorizes one paid workflow.

Preconditions:

1. OPENAI_API_KEY exists without printing it; model is gpt-5.6 or an explicitly
   configured supported model.
2. Pinned disposable Astronomy Shop is ready, flag API healthy, flag off.
3. Dedicated ledger/capture/port is used; historical proof is not overwritten.
4. Frozen real snapshot contains exact applied change, pinned code semantics,
   flag-off checkout/payment success, and three distinct direct-parent flag-on
   payment resolver failures.

One-workflow acceptance:

    actual unsupported model hypothesis -> independent rejection -> one replan
    -> narrow checkout/payment diagnosis -> evaluator acceptance
    -> deterministic gate + exact tool lineage -> Owner Gate
    -> explicit authorized local approval -> allowlisted rollback
    -> fresh verification -> regression.created -> executed backtest -> policy

The captured replay, not this paid path, owns the judge-visible Kafka rejection.
The model's first rejected claim must be an actual unsupported result of the one
workflow; it must not be prompted, fabricated, or recorded as a scripted Kafka
answer. If the current deterministic gate still requires a rejection/replan, an
attempt-one direct acceptance fails closed rather than being rewritten.

Record run/snapshot IDs, safe hashes, tool/attempt counts, model usage,
evaluator verdicts, decision/approval/repair order, verification checks,
backtest gates, truth labels, and Langfuse availability. Never store provider
body/text, call IDs, reasoning, credentials, raw OTLP, or trace/span IDs.

Stop: any preflight, model, evaluator, causal, approval, repair, or recovery
failure ends the workflow with its safe classification. No paid retry. Restore
the flag off and stop only task-owned services. The submission may still use
deterministic replay but must state that successful GPT proof is absent. In that
case the competition submission may be truthful, but **release acceptance is
failed** and no artifact may call the product release-complete.

## 14. Slice G — release and submission handoff

Purpose: create truthful competition assets only after their represented paths
are verified.

Files, after proof only:

- README.md, docs/judge-script.md, QA record
- docs/submission/devpost.md, video-script.md, submission-checklist.md
- docs/submission/screenshots only from a current fresh process

Checks:

    npm test
    npm audit --audit-level=high
    npm run submission:check
    git diff --check

Release acceptance checklist (all items, including successful GPT proof, are
required to call the release complete):

- causal replay spans change/deploy/trace/log/metric and only
  fixture-supported dataflow propagation;
- Kafka rejection and checkout/payment replan are visually legible;
- Owner Gate, before/after recovery, and regression/backtest are visible;
- captured fixture, frozen real snapshot, GPT model-only, and real-local
  development have separate badges/copy;
- default judge path completes without Docker/OpenAI credentials in under three
  minutes;
- README includes Codex/GPT-5.6 explanation and judge test path;
- hosted URL, public narrated video, repository URL, and /feedback Session ID
  appear only after human verification.
- one successful, separately authorized real GPT-5.6 evidence-to-recovery proof
  is present with its honest narrow checkout/payment truth boundary.

Hosting, public video, /feedback generation, Devpost entry, and final
submission are human/external gates. No local implementation task performs or
claims them.

Stop: an asset cannot claim a mode, repair, GPT result, or hosted behavior that
is absent from the final QA record. Leave the field pending rather than infer it.

## 15. Critical-path schedule

| Window | Critical work | Parallel work allowed | Stop rule |
| --- | --- | --- | --- |
| Jul 18 immediately | inventory/isolate dirty harness; Slice B | submission copy audit only | no overlapping authority edit without isolation |
| Jul 19 first half | Slice B tests and implementation | none that changes product claims | Sol approval before projection |
| Jul 19 second half | Slice C projection, then C.1 fixture validation serially | video outline only from captured path | no projection-schema edits in C.1; no vendor ingestion |
| Jul 20 first half | Slice D render-only migration, then D.1 decision hardening | screenshots only after fresh state is stable | controls stay disabled until D.1 passes |
| Jul 20 second half | Slice E.0 captured simulation, then Slice E Playwright/release smoke | host/video preparation using verified captured demo | no live action or mock-only E2E state |
| Jul 21 before 10:00 PDT | final tests, submission check, deterministic rehearsal | human prepares public assets | no late scope increase |
| Jul 21 before 17:00 PDT | human verifies links, /feedback, Devpost fields, final submit | one GPT proof only if all preconditions and explicit authorization exist | no retry or publication by agent |

If schedule slips, drop only P1 adapters and unverified presentation polish. Do
not drop authority, projection limits, either browser E2E, or the successful
GPT release-acceptance requirement. A truthful deterministic submission may
proceed without that proof, but it is recorded as submission-only: release
acceptance remains failed and release-complete copy is prohibited.

## 16. Acceptance-to-test traceability

| Design acceptance | Primary tests | Browser/release proof |
| --- | --- | --- |
| Private selector-only authority | autonomy policy, ledger, development runtime, server negative tests | no UI/request authority fields |
| Checkout medium Owner Gate | development runtime, runtime, GPT integration event order | medium Owner-Gate E2E |
| Server-resolved decision actions | server/runtime/development concurrency and forged-ID tests | approve/reject/defer controls use returned projection only |
| Truth separation | incident projection golden/schema tests | badges in both E2E flows |
| Projection bounds and cursor | incident projection/server contract tests | unavailable-state rendering |
| No connector authority | integration contract fixture tests | provider glyph visual-only |
| Kafka rejection and replan | runtime/openai fixtures | captured replay E2E and video rehearsal |
| Before/after verification/learning | runtime/development/backtest tests | Compare/Decision & Recovery E2E |
| Low simulation truth | E.0 runtime/server exact event and forbidden-event tests | low captured-simulation E2E |
| Successful real GPT proof | GPT development integration fixture, then one authorized QA run | docs update only after actual run |
| Release reliability | full suite, audit, submission check, diff check | fresh-port rehearsal at both viewports |

## 17. P1 and dropped work

P1: OpenLineage JSONL ingestion; GitHub, Kubernetes, Airflow, dbt, Kafka,
warehouse, Databricks, Spark, BigQuery/Dataflow, Snowflake, and PagerDuty
adapters; external notifications; RBAC; policy authoring; advisory retrieval;
and actual low-risk production rollout.

Dropped for the competition: connector marketplace, multi-tenant SaaS, generic
multi-agent framework, free-form command execution, automatic SEV-1 repair,
retries after failed repair/verification, and a dashboard that hides causal
replay behind generic control-plane language.

## 18. Plan self-review and execution gates

This plan resolves prior scope mixing by making Slice 2 authority-only, then
serializing projection, connector-fixture validation, render-only UI, decision
controls, captured simulation, and browser work. It keeps all ingestion in P1,
makes deterministic captured replay the default demo, and treats successful
real GPT proof as a separate release-acceptance gate. It inventories rather than
overwrites dirty harness work. It includes no provider or Astronomy action in a
coding slice.

Before each slice, record HEAD, status, affected-file hashes, and intended
staged files. After each slice run focused tests, npm test, npm audit
--audit-level=high, and git diff --check. Commit each slice independently.
Sol review is mandatory after Slice 2. Any authority or truth-label ambiguity
is a stop-and-report condition, not an implementation choice.

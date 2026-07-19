# Three-stage autonomy P0 implementation plan

Status: implementation plan for approved design `9da4f9d`
Date: 2026-07-18
Execution authority: all implementation remains in this Build Week competition
session. Do not delegate project work to another session, repository, or thread.

## Goal and fixed boundaries

Implement the approved FlowPulse operating model:

```text
Monitor -> Agent Workbench -> Decision & Recovery
```

P0 adds a deterministic, ledger-backed autonomy decision layer. Only an exact,
active, versioned preauthorization envelope may permit a reversible,
single-component, low-blast-radius action to auto-execute. Every other
consequential action remains human-gated. The current `checkout -> payment`
rollback remains medium risk and retains its per-incident Owner Gate.

The loop is test-first and serial by default: goal -> input -> implement ->
check -> correct -> record -> stop. A slice is complete only after focused,
full, API-contract, and relevant UI integration checks pass.

### Hard invariants

1. The append-only ledger, code-owned runtime, deterministic validators, and
   allowlisted action contracts are authoritative.
2. Model output and retrieved history/KB are candidate or advisory material;
   neither can satisfy evidence, causal, repair, verification, or backtest
   gates.
3. Severity, evaluator score, model confidence, or a KB result alone never
   grant execution.
4. A stale/unknown factor, tool/model failure, missing required human owner,
   notification failure, failed action, or failed verification always selects a stricter
   outcome.
5. Captured fixture execution is never labeled real local or production
   execution.
6. An API client, model, or KB item can never select a preauthorization
   envelope, run, decision, owner identity, or action contract. The server
   resolves all authority-bearing references from the current ledger and its
   code-owned registry.
7. A preauthorization is consumed once, atomically, and is revalidated at the
   executor boundary. A failure lock is keyed to the incident plus exact action
   contract and survives a new run for that same incident.

### Non-goals

- Generic connector marketplace, generic agent framework, multi-agent fan-out,
  broad severity-based automation, or free-form shell/Kubernetes/database
  commands.
- Production notification delivery, external RBAC, generic policy authoring,
  or production auto-remediation.
- Historical ledger rewrites, Astronomy mutation, provider calls, deployment,
  publishing, or credit use while following this plan.

## Baseline seams and compatibility policy

| Concern | Existing seam | P0 extension |
| --- | --- | --- |
| State/API | `src/server.mjs`: `stateWithSource`, replay and development routes | Retain every current field; add bounded `autonomy` projection. |
| Ledger | `src/ledger.mjs` | Add event types only; old rows remain immutable and project `legacy_detail_unavailable`. |
| Runtime | `src/runtime.mjs`, `src/development-runtime.mjs` | Evaluate policy after deterministic diagnosis, preserve checkout approval ordering. |
| Model loop | `src/openai.mjs`, `src/investigation-failure.mjs` | No additional model authority; preserve bounded evaluator/causal gates. |
| UI | `public/index.html`, `public/app.js`, `public/twin-state.mjs` | Reorganize views around server-projected stages; no client risk/state calculation. |
| Tests | `test/runtime.test.mjs`, `test/development-runtime.test.mjs`, `test/server.test.mjs`, `test/twin-state.test.mjs` | Add pure policy/projection, contract, integration, and browser checks. |

Before any implementation slice, record `git rev-parse HEAD` and a stable
fingerprint of the pre-existing dirty worktree (for example, the SHA-256 of
`git status --porcelain=v1` plus its sorted path list). Every slice preserves
those unrelated paths and reports its own changed-file set.

### Versioned UI/API contract

Every `GET /api/state` and successful action response preserves current fields
and adds:

```json
{
  "autonomy": {
    "schema_version": "flowpulse.autonomy.v1",
    "stage": "monitor | agent_workbench | decision_recovery",
    "stage_status": "healthy | degraded | collecting | evaluating | replanning | ready | waiting_for_owner | executing | verifying | resolved | blocked | escalated",
    "decision": {
      "id": "ledger decision id or null",
      "risk_class": "low | medium | high | blocked | unavailable",
      "outcome": "observe_only | auto_execute_pre_authorized | human_review_required | explicit_human_decision_required | blocked | unavailable",
      "factor_results": [],
      "evidence_refs": [],
      "action_contract_ref": null,
      "preauthorization_ref": null,
      "reason_codes": []
    },
    "human_gate": "not_required | preauthorized | owner_required | explicit_decision_required | unavailable",
    "notification": {
      "status": "not_required | pending | recorded_local | simulated | delivered_external | failed | unavailable",
      "delivery_mode": "none | local_ledger | captured_simulation | external_receipt | unavailable"
    },
    "execution": {
      "truth_mode": "none | captured_simulation | local_development | unavailable",
      "receipt_ref": null
    },
    "failure_lock": { "active": false, "reason_code": null, "event_ref": null },
    "why_stopped": { "boundary": null, "reason_code": null, "next_precondition": null },
    "legacy_detail_status": "available | legacy_detail_unavailable"
  }
}
```

Unknown schema/enums or missing required fields must render unavailable and
non-actionable; the browser must never default to automatic execution. Source
status is explicit: `live`, `captured_fixture`, `stale`, `disconnected`, or
`unavailable`. Loading is a disabled, labelled visual shell; an error retains
only a clearly labelled stale canvas and the safe error envelope. Existing
routes remain until UI migration is complete.

Decision-route errors use bounded existing failure envelopes: `400` invalid
schema, `404` unknown current decision, `409` stale/mismatched/expired/
revoked/consumed/locked, and `422` failed deterministic precondition. No
authority event is appended for an invalid request. The client may send only a
bounded current `decision_id` and, for a human decision, a bounded local demo
actor label. It may not select a run, preauthorization, contract, source, or
executor. The local label is attribution in this P0, not authenticated
production RBAC.

## New event vocabulary

| Event | Required bounded payload | Effect |
| --- | --- | --- |
| `autonomy.decision.recorded` | schema/policy hashes, risk/outcome, factor results, evidence refs, action ref, optional preauth ref, notification target refs, reason enums | Records deterministic decision; no execution. |
| `preauthorization.consumed` | deterministic claim ID, envelope/policy/contract/snapshot hashes, incident/environment refs, consumed-at | Atomic single-use executor claim; only an inserted claim may enter a low-risk executor. |
| `approval.rejected` | request ref, owner, reason enum | Stops proposal. |
| `approval.deferred` | request ref, owner, reason enum, evidence-class enums | Returns to bounded evidence work. |
| `notification.requested` / `.recorded_local` / `.simulated` / `.failed` | decision/request refs and bounded local receipt enum | P0 has no external delivery claim. `delivered_external` is P1-only and requires a real connector receipt. |
| `escalation.requested` | decision ref, target-role ref, reason enum | Human workflow record only. |
| `autonomy.locked` | action/incident lineage, failed event ref, reason enum | Prevents later automatic execution across that lineage. P0 provides no unlock. |
| `repair.execution.failed` | approval/request/contract refs, bounded failure classification, lock ref | Preserves the historical approval while preventing any automatic retry. |
| `action.simulated` | fixed captured scenario ID, decision/contract refs, `truth_mode: captured_simulation` | Non-mutating captured policy demonstration; never a real repair receipt. |

The preauthorization envelope is versioned and strict: policy version/hash,
active status, issue/expiry time, exact environment, exact repair/command/
target/before/after contract, `max_components: 1`, `max_attempts: 1`,
idempotency/rollback/fresh-verification/notification requirements, verification
check IDs, and notification-target refs. A model, user prompt, or KB item can
never create, select, broaden, renew, or revoke it.

For P0, the only low path is a captured policy simulation. No live or local
development action connector is enabled by a P0 preauthorization; a local
notification record cannot satisfy a live or production auto-execution gate.

## Slice 0 — test fixtures and contract boundary

Purpose: establish stable test-first inputs before production code changes.

Files/functions:

- Add `test/autonomy-policy.test.mjs` and `test/three-stage-projection.test.mjs`.
- Extend test helpers in `test/development-runtime.test.mjs` and
  `test/server.test.mjs`; no production test hooks.

Tests first:

- canonical fixtures for low, medium, high, stale, missing-owner,
  notification-failed, expired-policy, contract-mismatch, and repeated-failure
  outcomes;
- the exact checkout repair contract appears only in medium fixtures;
- low fixture is explicitly `captured_fixture`, never real-local.
- preauthorization registry selection, post-decision expiry/revocation, atomic
  first-claim, second-consumption, cross-run replay, and concurrent-claim
  fixtures;
- forged client run/decision/owner/preauthorization identifiers, execution
  failure after approval, cross-run failure locks, and defer-with-zero-provider
  call fixtures;
- `recorded_local`/`simulated` notification fixtures that cannot satisfy a
  `live` or production gate, and `action.simulated` fixtures that are never a
  `repair.executed` receipt.

Implementation:

1. Create stable timestamps/IDs and expected `flowpulse.autonomy.v1` snapshots.
2. Keep factories in tests until Slice 1 introduces the pure module.

Verification:

```sh
node --test test/autonomy-policy.test.mjs test/three-stage-projection.test.mjs
```

Stop/rollback: if a low fixture needs to alter the checkout contract or invent
an unbounded action, stop and preserve the stricter manual boundary.

Frontend/backend coordination: no UI work here. These fixtures freeze the
contract consumed by later API and browser tests.

## Slice 1 — authority, ledger, and pure autonomy policy

Purpose: make risk decision deterministic and inspectable before wiring a
runtime or screen.

Files/functions:

- Add `src/autonomy-policy.mjs` with a server-composition-only authority
  capability. Its only decision selector is the server-resolved
  `{ run_id, incident_id, intent_id }`; the capability itself reads the actual
  ledger, frozen snapshot, checked-in versioned registry, snapshot-bound
  freshness receipt, and bounded type-scoped lock query. Raw ledger rows,
  manifests, envelopes, authority objects, risk, source state, freshness, and
  preauthorization references are not request/model/UI inputs. The provider
  returns the v1 decision plus canonical decision event.
- Extend `src/ledger.mjs` only with the bounded, globally ordered
  `autonomy.locked` type query and atomic `appendIfAbsent` claim use required
  for cross-run lock and single-use preauthorization. It must not rewrite
  historical rows.
- Extend `src/investigation-failure.mjs` only to project current safe failure
  fields into `why_stopped`.
- Extend `test/autonomy-policy.test.mjs`, `test/ledger.test.mjs`, and
  `test/investigation-failure.test.mjs`.

Data contract/events:

- The trusted provider returns the v1 decision schema and one canonical factor
  result for every hard gate.
- The provider derives authority only from the actual decoded append-only ledger
  stream and frozen snapshot store. It binds the evaluator and
  deterministic-gate event IDs, sequences, payload hashes, manifest hash, and
  selected evidence record hashes/sources/modes. Request/model/UI values cannot
  provide or deserialize this authority object; confidence alone cannot satisfy
  evidence completeness.
- The compact legacy `DevelopmentRuntime` evaluator rows are non-authoritative
  for this provider. Slice 2 must emit the full strict evaluator and
  proposed-action-contract binding before any runtime path can request a
  preauthorized decision; checkout remains an Owner-Gated medium-risk path.
- `autonomy.decision.recorded` appends once after deterministic diagnosis
  acceptance and before any action request.
- A decision binds `envelope_sha256`, `contract_sha256`, `incident_id`,
  `run_id`, `environment`, `snapshot_sha256`, and the exact snapshot manifest
  hash/freshness receipt. The server obtains the envelope only from its
  checked-in registry; no request, model response, or advisory item can choose
  it. Future/freshness-expired or receipt-mismatched gate events are
  non-actionable.
- A real executor revalidates the same bindings, current envelope status,
  expiry, source freshness, and incident-wide lock immediately before mutation.
  It may proceed only after its deterministic `preauthorization.consumed`
  `appendIfAbsent` claim reports `inserted: true`.
- In P0 the low decision may reach only `action.simulated` with
  `truth_mode: captured_simulation`; no live executor consumes a
  preauthorization, and the simulated path does not consume a real envelope.
- The module has no provider, network, UI, or ledger-write dependency.

Tests first:

- mutate every individual low factor and prove automatic execution becomes
  blocked/human-required;
- severity-only mutation never grants automatic execution;
- expired/revoked/wrong-version/wrong-hash/wrong-environment/wrong-target/
  multi-component/over-attempt envelope fails closed;
- registry ambiguity, client-selected envelope refs, binding mismatch,
  post-decision expiry/revocation, duplicate concurrent claim, second
  consumption, and cross-run reuse fail closed;
- stale/missing source, missing owner, failed notification, evaluator
  rejection, false positive, tool/model failure, and repeated failure prevent
  automatic execution;
- a low captured simulation accepts only `recorded_local` or `simulated`
  notification state and cannot be projected as `live`, `delivered_external`,
  `repair.executed`, or promotion evidence;
- factor evidence refs are current evidence IDs, never advisory refs;
- payloads are bounded and contain no secret/raw provider/OTLP/free command.

Implementation:

1. Use strict schema validation and canonical hash helpers compatible with the
   existing harness/backtest conventions.
2. Use conjunction hard gates, not a weighted score that can compensate for a
   failed safety factor.
3. Treat absent data as unknown/failed. Generate stable decision IDs for audit,
   never as credentials.
4. Bind failure history to `incident_id + contract_sha256 + target`, not only
   the active run. P0 has no unlock endpoint; an owner reset remains a future,
   separately-authorized control-plane action.

Verification:

```sh
node --test test/autonomy-policy.test.mjs test/ledger.test.mjs test/investigation-failure.test.mjs
```

Stop/rollback: a policy that cannot prove exact contract match returns
`human_review_required` or `blocked`; it never falls back to automatic action.

Frontend/backend coordination: UI remains unchanged. Slice 1's snapshots and
pure API are the sole risk rules; browser code must not duplicate them.

**Mandatory authority review:** stop after Slice 1. Sol must approve the
registry/binding/atomic-claim/incident-lock contract and its tests before Slice
2 changes any runtime, endpoint, UI, or simulation behavior.

## Slice 2 — runtime integration, failure lock, and Owner Gate preservation

Purpose: integrate policy after current causal/evaluator boundaries while
keeping checkout per-incident approval unchanged.

Files/functions:

- `src/development-runtime.mjs`: integrate policy after `diagnosis.gate.passed`
  in `investigate()`, retain `approve()`, append lock after failed repair or
  `verify()` failure, and record `repair.execution.failed` plus the same lock
  if the allowlisted executor throws after approval.
- `src/runtime.mjs`: project captured replay decisions through same pure policy
  without changing current deterministic approval ordering.
- `src/openai.mjs`: call policy only after evaluator acceptance and current
  deterministic validation; model-only mode stays non-executable.
- `src/regression-backtest.mjs` and `src/policy.mjs`: bind autonomy decision/
  preauth hashes in new artifacts while preserving old readers.
- Extend `test/development-runtime.test.mjs`, `test/runtime.test.mjs`,
  `test/openai-contract.test.mjs`, `test/gpt-development-integration.test.mjs`,
  and the existing backtest tests.

Expected order for medium checkout:

```text
diagnosis.gate.passed
  -> autonomy.decision.recorded(medium, human_review_required)
  -> repair.proposed -> approval.requested -> approval.granted
  -> repair.executed -> verification.completed
```

Tests first:

- checkout is medium and has zero `repair.executed` before approval;
- a valid envelope cannot lower checkout to low;
- low captured simulation needs every hard factor, a `recorded_local`/`simulated`
  notification record, and zero failure history; it is never
  a live action or real receipt;
- stale, missing required human owner, no evaluator/gate, tool/model failure, false positive,
  mismatch, expiry, or repeat failure has no automatic execution;
- failed verification appends a lock and blocks later auto eligibility;
- execution failure after a historical approval appends `repair.execution.failed`
  and an incident-wide lock, then permits neither a retry nor a second executor
  entry;
- a new run for the same incident/contract/target cannot evade a prior lock;
- old replay/development rows remain readable and unavailable/legacy, not pass.

Implementation:

1. Evaluate once per accepted diagnosis and append one decision event.
2. Preserve exact checkout contract and approval/executor path; require its
   outcome to be `human_review_required`.
3. Lock the exact action/incident lineage after repair or verification failure;
   do not create retries.
4. Bind new decision data into backtest as an additional consistency gate,
   never a replacement for existing recovery/backtest gates.
5. Preserve `captured_fixture` as advisory/demo provenance. Only an existing
   real development artifact with `source=executed_offline_backtest` can meet
   the current policy eligibility checks; a simulated action never can.

Verification:

```sh
node --test test/runtime.test.mjs test/development-runtime.test.mjs test/openai-contract.test.mjs test/gpt-development-integration.test.mjs
```

Stop/rollback: any change to approval-before-repair or the exact checkout
contract requires reverting this slice and Sol review.

Frontend/backend coordination: no optimistic UI mutation. Existing approval
responses remain compatible until Slice 3 migrates controls.

## Slice 3 — decision endpoints, notifications, and escalation

Purpose: provide evidence-backed human choices without coupling a UI button to
executor authority.

Files/functions:

- `src/server.mjs`: add bounded decision approve/reject/request-more-evidence
  endpoints and preserve `/api/approve` and `/api/development/approve` as
  compatibility wrappers that cannot bypass the new checks.
- `src/development-runtime.mjs` and `src/runtime.mjs`: add narrow reject/defer
  methods; reuse current exact-contract `approve()` for medium checkout.
- `src/autonomy-policy.mjs`: validate decision ID, state, contract, owner,
  preauthorization, and lock.
- Add a local ledger-only notification recorder only if no current helper fits;
  it never calls Slack/email/PagerDuty.
- Extend `test/server.test.mjs`, `test/development-runtime.test.mjs`,
  `test/runtime.test.mjs`, and `test/agent-control-service.test.mjs`.

| Intent | Endpoint | Success | Failure |
| --- | --- | --- | --- |
| Approve medium repair | `POST /api/decision/approve` with only bounded current `decision_id` and local actor label | atomically claim exact current decision, append `approval.granted`, then code-owned current executor, `200` state | `404/409/422`; no executor. |
| Reject repair | `POST /api/decision/reject` with current `decision_id` | one `approval.rejected`, `200` state | `404/409/422`; no executor. |
| Request evidence | `POST /api/decision/request-evidence` with current `decision_id` | one `approval.deferred`, missing classes and next precondition only | `409` executing/resolved; zero provider calls. |
| Notification result | internal P0 call only | bounded `notification.recorded_local` or `.simulated` event | cannot satisfy live/production auto execution. |

Tests first:

- body/schema/enum/size validation and safe envelopes;
- arbitrary run, decision, owner, or preauthorization ref supplied by the
  client append no authority event;
- unknown/stale decision, missing actor label, expired policy, mismatch, lock,
  and source freshness failure append no repair/execution;
- concurrent double approval creates exactly one claim, one approval, and one
  executor entry; the losing request returns a safe conflict;
- executor failure preserves approval history, appends exactly one
  `repair.execution.failed` and `autonomy.locked`, then blocks retry;
- reject/defer append exactly one terminal event, or an explicit bounded new
  investigation-generation transition, and retain refs;
- defer records missing evidence classes and next precondition, performs zero
  implicit GPT/provider calls, and never resets the original replan budget;
- notification failure is visible and blocks auto;
- legacy approval endpoint still requires exact owner-before-repair.

Implementation:

1. Resolve the active run and waiting decision server-side. A body run,
   contract, source, or preauthorization selector is rejected rather than used.
2. Require exact proposal/request/decision contract binding and an atomic,
   idempotent decision claim before the executor. The existing synchronous
   approval-to-executor boundary may remain code-owned, but the UI never calls
   an executor directly.
3. Use reason/evidence-class enums; arbitrary human notes are P1. A P0 actor
   label is explicitly local attribution, not production authentication.
4. Record local notification state before a captured simulation only. It is
   never external delivery and cannot unlock a live action.

Verification:

```sh
node --test test/server.test.mjs test/runtime.test.mjs test/development-runtime.test.mjs test/agent-control-service.test.mjs
```

Stop/rollback: if a compatibility wrapper can bypass policy/Owner Gate, leave
the old UI path active and stop for Sol review.

Frontend/backend coordination: every action response returns v1 state. UI
shows loading while in flight, then uses returned stage/error only; it never
sets approval/execution locally.

## Slice 4 — ledger-derived three-stage projection

Purpose: produce one server-owned projection for stage, risk, human gate,
notification, lockout, and why-stopped state.

Files/functions:

- Add `src/three-stage-projection.mjs` with
  `projectThreeStageState({ events, source, mode, failure })`,
  `projectAutonomyDecision(events)`, `projectWhyStopped(events)`, and
  `projectLegacyAutonomy(events)`.
- `src/server.mjs`: attach projection in `stateWithSource()`.
- `src/agent-control-service.mjs`: consume projection for report/current
  activity rather than adding another loose stage inference.
- `src/investigation-failure.mjs`: expose only existing safe failure fields.
- Add `test/three-stage-projection.test.mjs`; extend `test/server.test.mjs`,
  `test/agent-control-service.test.mjs`, and `test/twin-state.test.mjs`.

Contract:

- Projection derives from ordered ledger events plus source freshness. It never
  reads UI mode, raw model text, or a client-provided risk class.
- Stage is exactly `monitor`, `agent_workbench`, or `decision_recovery`.
- Existing rows without autonomy data project `legacy_detail_unavailable`, not
  a passing decision. Captured replay retains `captured_fixture` provenance.

Tests first:

- healthy, collecting, evaluator rejection/replan, ready medium Owner Gate,
  executing, verified/resolved, tool/model failure, stale source, missing owner,
  notification failure, and failure lock fixtures;
- duplicated/inverted decision events produce blocked rather than permissive
  state;
- absent/malformed decision is unavailable/blocked;
- state contract snapshot retains all existing top-level fields and validates
  v1 enums, nulls, stale and loading/error handling.

Implementation:

1. Keep projector pure and testable; do not put policy conditionals in
   `public/app.js`.
2. Establish precedence: failure lock and stale source override ready; resolved
   requires current verification/backtest/policy proof.
3. Add only the compact `autonomy` projection, not unbounded event payloads.

Verification:

```sh
node --test test/three-stage-projection.test.mjs test/server.test.mjs test/agent-control-service.test.mjs test/twin-state.test.mjs
```

Stop/rollback: any inability to distinguish captured from live, or missing
decision from passing decision, blocks UI work.

Frontend/backend coordination: `GET /api/state` is the sole source for stage,
risk, decision, and why-stopped. Contract tests render a real server response;
schema mismatch must yield a visible non-actionable unavailable state.

## Slice 5 — UI IA: Monitor, Agent Workbench, Decision & Recovery

Purpose: replace five primary modes with the approved three stages while
preserving topology, time replay, Compare, drawers, zoom, and accessibility.

Files/functions:

- `public/index.html`: replace only top-level mode switch and related ARIA
  labels; retain canvas/drawer/timeline controls.
- `public/app.js`: update `renderHeader`, `renderCanvas`, `renderAgentCanvas`,
  `renderApproval`, `renderManager`, `setMode`, and action handlers to consume
  `state.autonomy`.
- `public/twin-state.mjs`: add view mapping only if it accepts the server
  projection. It must not recreate risk rules.
- Extend `test/twin-state.test.mjs` and fresh-port integration tests in
  `test/server.test.mjs` or a focused browser test.

Tests first:

- exactly three primary tabs with keyboard names and focus order;
- Monitor preserves Architecture/Live and source stale/disconnected labels;
- Agent Workbench renders evaluator rejection, replan, evidence/tool coverage,
  and why-stopped from backend state;
- Decision & Recovery renders risk, contract, approval, receipt, verification,
  Compare, and learning from server state;
- unknown/missing schema disables controls; no client fixture may independently
  assign stage/risk/approval/verification.

Implementation:

1. Keep Architecture/Live as Monitor subviews; Diagnose and agent activity as
   Workbench subviews; approval/Compare/verification as Decision subviews.
2. Replace `Recover` with `Review recovery plan`; keep explicit approval tied
   to exact contract. Replace `Run GPT-5.6` with `Start investigation` plus
   source readiness; model provenance is secondary.
3. Preserve reduced motion, contrast, drawer, keyboard, zoom, and replay
   behavior.

Verification:

```sh
node --test test/twin-state.test.mjs test/server.test.mjs
npm test
```

Browser smoke uses a task-owned fresh process:

```sh
PORT=4318 HOST=127.0.0.1 npm start
```

At 1440x900 and 1280x800 exercise all three stages with keyboard navigation.
Record console errors/warnings, clipped controls, stale labels, and whether all
visible decisions came from fresh server state. Stop only that process.

Stop/rollback: if a transition requires client-created authority state, retain
the current view under the closest stage and defer it. Restore any unreachable
drawer/replay control before adding visual detail.

Frontend/backend coordination: UI actions call Slice 3 endpoints; returned
state is the only source for stage, approval, receipt, verification, and error.
No optimistic completion state is permitted.

## Slice 6 — evidence, options, risk, and why-stopped transparency

Purpose: make the stage model useful to engineers without expanding authority
or turning the visual canvas into a report wall.

Files/functions:

- `src/three-stage-projection.mjs` and `src/agent-control-service.mjs`: add
  bounded factor evidence, counter-evidence, option, blast-radius, rollback,
  verification, and safe stop projections.
- `src/server.mjs`: preserve bounded evidence list/detail behavior and attach
  only referenced safe summaries.
- `public/app.js`: extend existing drawer/Manager panel without a client cache
  or unauthoritative chat state.
- Extend `test/investigation-failure.test.mjs`, `test/server.test.mjs`,
  `test/agent-control-service.test.mjs`, and Slice 5 browser tests.

Contract:

- Every option exposes supporting/counter evidence refs, blast radius,
  rollback/verification refs, and authority enum `advisory`, `proposed`,
  `preauthorized`, `owner_required`, or `blocked`.
- `why_stopped` uses only safe failure-episode boundary, validator, reason,
  tool coverage, missing classes, and next precondition.
- Historical rows remain `legacy_detail_unavailable`; KB/history is separate
  `advisory_refs` and excluded from all authority counts.

Tests first:

- evidence refs resolve through bounded detail API; unknown/advisory refs cannot
  authorize;
- risk/options differ by server-projected authority, not color/style alone;
- seeded raw response IDs, secrets, model text, and OTLP payload are absent;
- stale/failed/unknown source disables action and shows next precondition;
- drawer-closed view remains sufficient to review decision facts.

Implementation:

1. Reuse existing evidence/failure projections; add only bounded composed
   fields required by the decision rail.
2. Show concise chips/summaries rather than duplicate payloads.

Verification:

```sh
node --test test/investigation-failure.test.mjs test/server.test.mjs test/agent-control-service.test.mjs
```

Stop/rollback: if explanation needs raw provider data, expose only current safe
reason/next precondition; do not expand persistence.

Frontend/backend coordination: every visible option, risk, evidence, decision,
receipt, verification, and why-stopped value needs a named API field and
contract-test assertion.

## Slice 7 — deterministic low-preauthorization and medium Owner-Gate demos

Purpose: prove both user journeys without turning a fixture into a false live
or production claim.

Files/functions:

- `src/runtime.mjs` or a narrow captured-fixture helper: one deterministic
  low-risk preauthorized **policy simulation** with a captured/test adapter
  only; it emits `action.simulated`, never `repair.executed`.
- `src/autonomy-policy.mjs`: exact envelope and deterministic local-notification
  record validation. A local record cannot satisfy a live or production gate.
- `src/development-runtime.mjs`: preserve checkout as medium and explicit
  owner-gated; add no live auto executor.
- `src/server.mjs`: if needed, a fixed no-input replay selector only. It cannot
  select a live source or arbitrary command.
- Extend `test/runtime.test.mjs`, `test/server.test.mjs`,
  `test/development-runtime.test.mjs`, `test/twin-state.test.mjs`, and browser
  smoke tests.

| Demo | Truth label | Allowed execution | Required proof |
| --- | --- | --- | --- |
| Low path | `captured_fixture`, deterministic policy simulation | fixed non-mutating captured/test adapter only; `action.simulated` | active exact envelope, all hard factors, `recorded_local`/`simulated` notification state, one component, fixture verification, no failure history |
| Checkout flagship | real local development when ready; otherwise deterministic replay | existing exact owner-approved local rollback only | medium decision, Owner Gate before execution, fresh verification, regression/backtest |

Tests first:

- low E2E event order: decision -> notification record -> `action.simulated` ->
  fixture verification -> learning projection; source and execution truth remain
  captured;
- expiry, missing receipt, failed factor, failure lock, and wrong contract deny
  even the captured simulation;
- medium path has zero execution before approval, exact contract afterward,
  fresh verification, regression/backtest/policy order;
- no fixture event can satisfy a real-local receipt, a production claim, or an
  `executed_offline_backtest` promotion condition;
- browser/API smoke follows both paths through backend projections, without
  manual client state injection.

Implementation:

1. Prefer a fixed captured adapter to a new live mutator. This is a policy
   simulation, not automatic production recovery or a repair receipt.
2. Render exactly: “Captured policy simulation: FlowPulse automatically advanced a preauthorized low-risk candidate through deterministic gates. No live production resource was changed.”
3. Label all captured elements in UI/API/docs and distinguish `action.simulated`
   from an execution receipt and from `executed_offline_backtest`. Reuse the
   existing checkout contract unchanged for medium path.

Verification:

```sh
node --test test/runtime.test.mjs test/server.test.mjs test/development-runtime.test.mjs test/twin-state.test.mjs
npm test
```

Browser/API smoke:

1. Start a fresh deterministic server and task-owned temporary ledger.
2. Exercise low captured policy simulation through Decision & Recovery and
   assert `captured_fixture` plus `truth_mode=captured_simulation` throughout.
3. Reset and exercise medium checkout replay through Owner Gate; assert zero
   pre-approval execution, exact contract, and verified Compare.
4. Run both at 1440x900 and 1280x800 with zero console errors/warnings.

Stop/rollback: if low path needs a live mutation, stop for a separately
approved action contract. Never relabel checkout as low or fixture as live.

Frontend/backend coordination: both demos are selected and advanced through
backend ledger projections. No frontend fixture assigns risk, approval, or
verification.

## Slice 8 — regression, browser QA, documentation, and release check

Purpose: close P0 without expanding it into P1.

Files/functions:

- Update `README.md`, `docs/judge-script.md`, `docs/submission/video-script.md`,
  QA, and architecture docs only after behavior is final.
- Update `public/index.html`/`public/app.js` copy only where backed by final
  projection. Add no runtime authority in this slice.

Tests first:

- source-label/copy assertions for captured fixture, real local, model-only,
  stale, and unavailable states;
- release smoke for all three stages and both demo paths;
- accessibility regression for stage controls, focus, reduced motion, and
  non-color state labels.

Implementation:

1. Document learning/policy eligibility as non-promotion.
2. Record only actual real-vs-captured proof in QA; do not update claims from
   unrun paths.
3. Capture screenshots only from the current fresh deterministic process.

Verification commands: `npm test`; `npm audit --audit-level=high`; `npm run
submission:check`; `git diff --check`.

Browser checklist: both target viewports; three stages; low captured and medium
Owner-Gate paths; drawer evidence; rejection/replan; approve/reject/defer;
verification/Compare/learning; loading/stale/error; keyboard/focus/contrast/
reduced motion; zero console errors/warnings.

Stop/rollback: misleading live/GPT/auto-remediation copy blocks release. Any
browser-only behavior without a backend contract test returns to Slice 4 or 5.

## Frontend-backend traceability

Every row below requires a contract test. Rows marked with browser behavior
also require fresh-port browser smoke; frontend state may not be injected.

| User action/screen | Endpoint | Runtime transition | Ledger events | Projection | Rendered UI | Test |
| --- | --- | --- | --- | --- | --- | --- |
| Open Monitor | `GET /api/state` | none | existing run/source | `stage=monitor`, source freshness | Monitor canvas/label | server contract + browser |
| Start investigation | existing investigation endpoint | snapshot -> tools/evaluator -> gate -> decision | snapshot/tool/hypothesis/evaluation/gate/decision | `agent_workbench` | Workbench evidence/replan | server/OpenAI + browser |
| Request evidence | `POST /api/decision/request-evidence` | defer only; no provider call or budget reset | `approval.deferred` | `agent_workbench` | request/why-stopped | endpoint + browser + provider-spy |
| Review medium | `GET /api/state` | none | decision/proposal/request | `decision_recovery`, owner required | factors/options/contract | projection + browser |
| Approve checkout | `POST /api/decision/approve` | exact current decision/contract -> atomic claim -> executor | approval/execution | executing/verifying | receipt/wait | ordering + concurrent endpoint + browser |
| Reject/defer | decision reject/request endpoint | stop/defer | rejected/deferred | watch/workbench | explicit outcome | no-execution + browser |
| Low demo | fixed replay endpoint if needed | preauth -> captured simulation -> fixture verify | autonomy/notification/`action.simulated`/verify | captured decision/recovery | exact captured-policy wording | fixture E2E + browser |
| Concurrent approval | two identical approve requests | one atomic claim -> at most one executor | one approval/execution or safe conflict | authoritative result | one receipt or conflict | concurrency integration + browser refresh |
| Local notification | fixed captured simulation | local ledger record only | `notification.recorded_local`/`.simulated` | captured-only label | never “Delivered” | projection + browser copy |
| Execution failure | approve with failing allowlisted test adapter | preserve approval -> failure -> incident-wide lock | `repair.execution.failed`, `autonomy.locked` | blocked across new run | why stopped/no retry | mutation + cross-run browser/API |
| Forged identifiers | any decision endpoint | reject before transition | none | unchanged/non-actionable | safe error | endpoint contract |
| Verification failure | verify endpoint | lock lineage | verification/classification/lock | blocked/escalated | why stopped | mutation + browser |
| Tool/model failure | investigate endpoint | safe stop | failure events | blocked workbench/decision | safe failure panel | contract + browser |

## Acceptance-to-test traceability

| Design acceptance | Required coverage |
| --- | --- |
| Three top-level stages and preserved replay | projection/twin tests and Slice 5/8 browser smoke |
| Ledger-derived transitions | projection and server contract snapshots |
| No severity-only auto action | policy factor mutation |
| Exact active preauthorization | policy tests and low fixture E2E |
| Atomic preauthorization lifecycle | concurrent-claim, expiry/revocation, second-consumption, and cross-run replay mutations |
| Checkout remains Owner Gate | development runtime/server/browser medium path |
| Stale/insufficient/tool/model stops | policy/failure/server tests |
| KB cannot authorize | policy/OpenAI/server projection tests |
| Reject/defer/request visible | server/runtime/browser Decision tests |
| Failure locks later auto action | runtime/policy/projection mutations |
| Failure lock crosses runs | ledger lineage/runtime/server mutation with the same incident/contract/target |
| Notification failure blocks low | policy/runtime/endpoint tests |
| Local notification truth label | projection/API/browser copy tests; it cannot satisfy a live gate |
| Exact decision endpoint authority | forged identifier, atomic approval, one-shot reject/defer, and executor-failure tests |
| Defer is not a hidden replan | endpoint/provider-spy/budget tests and explicit new-generation tests |
| Owner/contract/recovery/backtest gates | extended current runtime/backtest tests |
| Fixture cannot claim real action | runtime/server/UI label tests |
| Safe bounded why-stopped projection | investigation failure/server/drawer tests |
| Accessibility/no mock UI state | DOM/browser tests at both target viewports |

## Parallelization, Sol review, and stop conditions

Authority-critical work is serial:

```text
Plan patch -> Slice 0 -> Slice 1 -> Sol authority review -> Slice 2 -> Slice 3 -> Slice 4 -> Slice 7 -> Slice 8
```

Slice 5 and Slice 6 may run in parallel only after Slice 4's schema/enums and
contract tests are accepted. They must not both modify `public/app.js` or
`public/index.html`; otherwise they remain serial. Browser QA runs after both.
All work stays in this competition session.

Required Sol authority review after Slice 1 and before Slice 2:

1. Registry selection, decision/envelope/snapshot binding, revalidation, atomic
   single-use consumption, and incident-wide lock cannot be bypassed by a
   concurrent or cross-run request.
2. No existing real low-risk remediation contract exists. Sol must reject any
   attempt to classify checkout rollback as low, make a captured simulation a
   live mutator, or report `action.simulated` as a repair receipt.
3. P0 notification records are not external delivery. Sol must reject copy
   that claims page/email/Slack delivery or lets a local record satisfy a live
   gate.
4. The current development approval endpoint couples approval and execution.
   Sol must verify new wrappers preserve exact contract, atomic one-executor
   behavior, local-attribution-only owner semantics, and failure lockout.
5. New policy/backtest bindings must keep historical replay compatibility and
   captured-fixture versus executed-backtest truth labels.
6. Defer must not make an implicit provider call or reset the bounded replan;
   a new investigation generation must re-enter readiness/snapshot/budget gates.

Success: every slice has concrete file/function scope, API/event/projection
contract, test-first work, verification, rollback condition, frontend
integration, and no P1 authority creep.

Stop and report: authority conflict, unisolatable dirty-work overlap, low path
requiring a real unapproved mutation, or a projection permitting frontend-
created state.

## Self-review

The plan implements only approved progressive autonomy. It keeps checkout
Owner-Gated, blocks automatic action on every missing/unsafe factor, and treats
KB/model output as non-authoritative. All visible UI state is contractually
backend/ledger-derived; the captured low path is an explicitly non-mutating
policy simulation, never a real execution or receipt. P1 integrations and
production automation remain out of scope.

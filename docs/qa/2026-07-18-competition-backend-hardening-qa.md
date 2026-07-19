# Competition backend hardening QA

## Baseline

- Baseline commit: `7426364` (`refine: add semantic component color`)
- Baseline worktree: clean.
- Baseline automated suite: `npm test` — 55 passing, 0 failing.
- Credential-free local server smoke could not run until the previous local
  server was restarted; the old implementation exposed `LiveSource.project()`
  directly from `/api/source` and merged live records into `/api/state`, so its
  payload was unbounded by API contract rather than measured as a stable byte
  value.

## Backend checks

- `npm test` — 59 passing, 0 failing.
- `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:check` — ready: pinned Astronomy
  Shop revision, Docker, flag API, and local capture all reported ready. No case
  was started, failure injected, flag changed, container restarted, repair run,
  external model request made, deployment, or publish action performed.
- Local `/api/health` returned `ok: true`; `/api/state` was 42,394 bytes in the
  current live environment. It exposes safe summaries only; list/detail tests
  assert no `payload` property and preserve hash/provenance.
- `/api/evidence` is capped at 50 records / 48 KiB per page and returns cursor
  metadata. Unknown detail IDs return 404. A frozen GPT snapshot is capped at
  120 records / 512 KiB and records deterministic source/content hashes.
- Targeted tests prove stale or irrelevant OTLP cannot form a snapshot, frozen
  ordering is stable, the GPT tool reads only snapshot evidence rather than the
  static bundle, and an unknown cited ID fails closed.

## Browser smoke

- Latest local server restarted on `http://127.0.0.1:4310`.
- Architecture, Live, Diagnose, Recovery Console, and Compare were selected
  successfully at 1440×900 and 1280×800.
- Browser console: 0 errors, 0 warnings.
- Existing deterministic UI tests cover keyboard/accessibility contracts,
  semantic states, stable topology, owner gate, and the shared canvas modes.

## Evidence-mode honesty

- Default judge route: **deterministic replay** from immutable captured bundle.
- Local non-model evidence: **captured real evidence** or current OTLP metadata.
- Credentialed model route: **live GPT-5.6 over frozen OTLP snapshot** only.
  Stale/disconnected/irrelevant source results in `insufficient_evidence` and
  has no fixture fallback.

## Remaining external submission work

No public hosted URL, public YouTube demo, `/feedback` Session ID, or Devpost
submission was created by this QA pass. Those remain human-owned submission
steps.

## Acceptance repair 1

- The initial acceptance review correctly rejected generic live facts and a
  static-bundle rollback schema. This repair adds bounded semantic signal facts
  and a hashed applied-change evidence record to development snapshots.
- Example safe facts: trace `{ operation: "POST /checkout", peer_target:
  "payment:8080", status: "error", error: "connection refused" }`; log
  `{ severity: "ERROR", message: "payment call refused", trace_ref:
  "ba7816bf8f01" }` (a one-way bounded reference, not a raw trace ID);
  metric `{ name: "checkout.errors", value: 42, unit: "1", aggregation:
  "sum" }`; change `{ flag: "paymentUnreachable", before: "off", after:
  "on", repair_id: "repair-payment-reachable-v1" }`.
- The repair-contract test proves the model boundary, `repair.proposed`,
  `approval.requested`, and adapter command use the same ID/action/target/
  command. A mismatched approval request fails before adapter execution.
- No OpenAI request, flag mutation, container restart, deployment, push, or
  publish was performed during this repair pass.
- Final repair checks: `npm test` — 63 passing, 0 failing;
  `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:check` — ready; Architecture,
  Live, Diagnose, Recovery Console, and Compare smoke-tested with 0 browser
  console errors or warnings.

## Acceptance repair 2

- The second acceptance review rejected truncation-only safe fields, arbitrary
  first-record selection, cap starvation of failure evidence, and an executable
  path without a deterministic change-to-failure citation gate.
- Resolution: all projected message/target text uses one deterministic telemetry
  sanitizer; representative traces/logs/metrics prefer failure-bearing records;
  executable snapshots reserve the exact ledger-captured change plus a
  post-change checkout/payment failure before general cap selection; and the
  repair/approval path now requires those exact cited records in temporal order.
- `npm test` — **69 passing, 0 failing**. The suite covers sensitive-string
  exclusion in list/detail/tool/source projections, healthy-first/error-later
  batch selection, cap pressure over 120 records, frozen-manifest drift,
  unknown evaluator refs, irrelevant/missing/reversed causal citations, and
  approval-contract mismatch.
- Final current command (no mutation performed):
  `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:check` returned
  `docker: true`, `flag_api: false`, `ready: false`. This is an external local
  runtime gate; no Docker/server restart, incident injection, flag mutation,
  model request, repair, deploy, push, or publish was performed.
- A pre-existing server at `127.0.0.1:4310` returned HTTP 200. Its Architecture,
  Live, Diagnose, Recovery Console, and Compare views switched successfully
  with zero browser console warnings/errors. It was not restarted for this
  backend patch, so this visual smoke does not certify current live-development
  readiness or the newly loaded backend process.

## Acceptance repair 3

- The third acceptance review found that a known but irrelevant checkout database
  timeout could authorize the payment-unreachable repair, selected records could
  inherit a later batch timestamp, identifier/key redaction missed common
  variants, executable caps could return only a subset of reserved evidence, and
  GPT causal errors from the development route were not ledger-classified.
- Resolution: one shared mechanism predicate now requires a checkout → payment
  dependency plus a bounded network-unreachable signal. It is used by executable
  snapshot reservation, GPT diagnosis validation, and deterministic development
  investigation. A checkout `SELECT orders` / `postgres:5432` timeout is
  explicitly rejected; a checkout `payment:8080` `ECONNREFUSED` trace passes.
- Selected trace/log/metric facts now carry the selected signal's own time. The
  mixed-batch regression proves a pre-change failing checkout→payment span stays
  pre-change even if a later healthy span is present, so it cannot authorize the
  repair.
- Safe projections redact UUIDv7, `session_id`, `user.id`, `account-id`, and
  whitespace-separated `X-API-Key` values across list, detail, tool, and
  source-style output. Cap preflight rejects any executable snapshot that cannot
  retain both the exact captured change and exact failure trace. Development GPT
  causal failures record one `insufficient_evidence` classification and failure
  event with no repair/approval event.
- `npm test` — **73 passing, 0 failing**.
- Current non-mutating command: `env FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run
  live:check` returned `docker: true`, pinned revision
  `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`, `flag_api: false`, and
  `ready: false`. No Docker/server start or restart, incident injection, flag
  mutation, model request, repair, deploy, push, or publish was performed.
- Browser/API smoke was intentionally not repeated: the existing 4310 process
  was not restarted and cannot certify this commit. A current read-only
  `curl http://127.0.0.1:4310/api/health` could not connect, so browser/API QA
  is an external runtime gate rather than a pass. The unavailable flag API is
  likewise an external runtime gate, not a code-acceptance pass.

## Competition runtime proof — 2026-07-18

### Provenance and local environment

- Baseline code-accepted commit: `4fb1efc`. During the disposable Astronomy
  Shop proof, its checked-in bad-change case emitted the bounded, observed
  resolver failure `name resolver error: produced zero addresses` for
  `oteldemo.PaymentService/Charge`. This is a connection-level payment
  dependency failure but was not included in the strictly enumerated predicate.
  The narrow parser correction is committed separately as `6a88a9f`
  (`fix: recognize payment resolver failures`) with a regression test; it does
  not alter repair scope, UI, or evidence authority.
- `npm test` after the correction: **74 passing, 0 failing**.
- `env FLOWPULSE_DEVELOPMENT_ENABLED=1 node scripts/live-demo.mjs check`:
  `docker: true`, pinned Astronomy Shop revision
  `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`, `flag_api: true`, and
  `ready: true`.
- The proof server was explicitly launched from `6a88a9f` on fresh port
  `4317` (PID `45457`) with `FLOWPULSE_DEVELOPMENT_ENABLED=1` and isolated
  ledger DB `/tmp/flowpulse-runtime-proof-bPG51k/ledger.db`. Its
  `/api/health` returned `ok: true`, `source: live`, and `langfuse: false`.
  A pre-existing process on port `4310` was treated as stale and was not used
  as proof of the accepted code.

### Deterministic real-OTLP loop (fresh port 4317)

- Development run: `run-20ff4c5d-7d43-4222-98d4-c3701f74a7ae`.
- Applied change ledger event: `evt-e33ae8e0-d929-4571-9c86-aa42fa128f97`,
  applied `2026-07-18T07:10:23.347Z`. The exact checked-in contract was
  `repair-payment-reachable-v1`, target `checkout`, flag
  `paymentUnreachable`, `off → on`, command
  `astronomy.restore-payment-and-recreate-checkout`.
- Frozen real snapshot: `snapshot-ba794cf078b12d33`; source hash
  `6a5b9f0242b1005b13f62a267af776967fe9a065cdf1a0e03fef317ca1ff04fb`;
  content hash
  `ba794cf078b12d33c24cbd24bdcd5884df8a75452c7ad7e3c00e5eb40918e404`;
  27 selected records from 882 source records, 25,209 bytes. Its exact change
  evidence was `change-f06873478821fbd7`; its cited mechanism traces were
  `live-tra-a12fb005dc3e`, `live-tra-adc1843800e3`,
  `live-tra-347c7423e7c4`, and `live-tra-8716036e70c9`.
- The initial unsupported `hyp-payment-service` attribution was rejected.
  The revised change-plus-resolver-failure diagnosis was accepted, then created
  an allowlisted proposal and owner approval request. Before approval,
  `/api/state` showed `waiting_for_approval: true` and no `repair.executed`.
- Owner `Runtime proof owner` approved only the exact repair contract. The
  resulting `repair.executed` event completed at
  `2026-07-18T07:14:13.178Z`, recorded `on → off`, target `checkout`, command
  `astronomy.restore-payment-and-recreate-checkout`, and `mode:
  local-development`.
- Fresh post-repair OTLP included `live-tra-53ca903f1ab0` at
  `2026-07-18T07:14:17.522Z`, after execution. Verification completed at
  `2026-07-18T07:15:34.553Z`; `regression.created` produced capture
  `capture-9155e754d3a0a62c` with SHA-256
  `9155e754d3a0a62c499ca5fa98701cf7900bea566a6175d319fd1e133536dce9`; the
  subsequent policy evaluation passed as `eligible_for_owner_review`.
- Relevant append-only ledger sequence: `change.applied` (5),
  `evidence.snapshot.created` (7), `evaluation.rejected` (11),
  `evaluation.accepted` (18), `repair.proposed` (20),
  `approval.requested` (21), `approval.granted` (23), `repair.executed` (24),
  `verification.completed` (26), `regression.created` (28), and
  `policy.evaluated` (29).

### One bounded GPT-5.6 and observability check

- An existing project/runtime OpenAI credential was detected without printing
  it. Exactly one bounded `POST /api/development/investigate` was issued to a
  second fresh `6a88a9f` process on port `4318` (PID `65402`, isolated ledger
  DB `/tmp/flowpulse-runtime-gpt-proof-sV26uq/ledger.db`).
- GPT run `run-9fbefd2e-0de3-42a8-8792-b737d8f54835` froze snapshot
  `snapshot-3f352df63202eaec`. Its tool ledger showed `query_changes` citing
  `change-1b33493e6137d808` and `query_traces` citing
  `live-tra-39b7fe57935b`, `live-tra-386152a4ef46`, and
  `live-tra-55c0b0e14197`. It made one permitted replan, then correctly
  classified `insufficient_evidence`: the frozen source proved ordering and a
  checkout-side resolver failure but not a direct flag-consumption or
  propagation proof. It appended no `repair.proposed`, `approval.requested`,
  or repair execution.
- `/api/health` on both fresh processes reported `langfuse: false`. Langfuse
  tracing code remains integrated, but a trace link, model usage, and latency
  record are externally credential-gated and were not fabricated.

### Fresh-process browser smoke

- The exact fresh `4317` process was checked at **1440×900** and **1280×800**.
  Architecture, Live, Diagnose, Recovery Console, and Compare all rendered and
  switched. The Live checkout drawer showed source `live GPT-5.6 over frozen
  OTLP snapshot`, 11 cited records, and source age under one second; Diagnose
  showed the resolver failure and versioned change; Recovery Console showed the
  verified/regression state and separate owner gate; Compare showed the
  incident-versus-verified causal, recovery, and learning review.
- Browser console error/warning filter returned `[]` at both viewports. No
  visual redesign was performed and no screenshot was needed for this runtime
  proof.

### Remaining local/runtime gates

- The deterministic real-data owner-gated loop is complete. The one GPT run is
  intentionally left at `insufficient_evidence`, proving the fail-closed path
  rather than forcing an approval. It left the disposable local shop in its
  bad-case state; restoring it requires a new valid owner-gated run or a human
  local decision, and was not bypassed here.
- Langfuse credentials are absent, so a hosted trace/usage link remains an
  external observability gate. No Docker image, local ledger database,
  `outputs/live` capture, environment file, or secret was staged or committed.

## P0 Slice 3 — one bounded GPT-5.6 evidence-to-recovery attempt

### Environment and real evidence

- Repository HEAD was
  `60ee32f9fbee3ca2ae8aa367fa56baed2142b89d`; the proof used the current
  uncommitted P0 causal and verification gates. `OPENAI_API_KEY` was present
  but never printed. `OPENAI_MODEL` was `gpt-5.6`; Langfuse credentials were
  absent.
- The pinned Astronomy Shop revision remained
  `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`. After `npm run live:start`,
  `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:check` reported
  `docker: true`, `flag_api: true`, and `ready: true`.
- A fresh FlowPulse process served port `4322` with isolated ledger
  `/tmp/flowpulse-gpt-proof-oFDp6y/ledger.db`. `/api/health` reported
  `ok: true`, `source: live`, and `langfuse: false`.
- The allowlisted local executor first restored a leftover flag to `off` as
  preflight cleanup. Development run
  `run-1a22031d-066d-49a2-b00b-bbe2de360579` then recorded the real
  `paymentUnreachable` transition `off -> on` in change event
  `evt-794a57a6-f021-483c-a939-e7532c1f43a8` at
  `2026-07-18T17:00:42.740Z`.
- Read-only preflight found real causal trace `live-tra-bcd85a5e718d`: checkout
  evaluated `paymentUnreachable=on` at `2026-07-18T17:00:52.242Z`, and its
  direct child `PaymentService/Charge` failed with `name resolver error:
  produced zero addresses` at `2026-07-18T17:00:52.247Z`. Only redacted
  semantic fields and hashed references were exposed.

### Single paid workflow and evaluator verdicts

- Exactly one `POST /api/development/investigate` was issued. It froze
  snapshot `snapshot-6c545c261f2d6356` at
  `2026-07-18T17:03:54.746Z`, selecting 20 of 911 source records (18,892
  bytes). Source hash:
  `6e1b8d80fa2b54add5328ee644b031d03a5e10b9b46f1b3de260bbf65bd4d03c`;
  content hash:
  `6c545c261f2d635610a8c15fcf58ece45a6bbb6f9f11ab74a7fe647e19697811`.
- Exact change evidence was `change-8864247c2549b775` (SHA-256
  `8864247c2549b77564b58fd411d59fbeadfe9c2e23babe35cbebab390fdcd475`).
  The model's causal mechanism evidence was `live-tra-b0531f02878d`
  (SHA-256
  `b0531f02878dc998654637ab6a57c9a0cff586fa1e92f2105c60ac8990dea5a0`).
  Kafka symptom evidence included `live-met-c90b9e93a879` (SHA-256
  `c90b9e93a879caf81e33545daa74d0db5c48261ca7cea1b2af8b6dea2dae5905`).
- Attempt 1 queried checkout traces, payment traces, Kafka metrics, and checkout
  changes. The investigator did not actually blame Kafka; it found the
  checkout flag/resolver chain and treated Kafka as unsupported. The evaluator
  rejected it with score `0.62` and `insufficient_evidence`: one trace did not
  prove the incident-wide failure or downstream propagation, and one
  undimensioned Kafka sample could not falsify a Kafka mechanism.
- The ledger then recorded one allowed `plan.revised`. Attempt 2 queried the
  change, checkout traces/logs, Kafka metrics/logs/traces, payment
  metrics/traces/logs, and Kafka changes/deploys. The revised diagnosis
  correctly bounded its claim to the local E1 -> E2 -> E3 chain. The independent
  evaluator again rejected it with score `0.68` and
  `insufficient_evidence`: it still lacked code/config semantics linking the
  flag to resolver suppression, a controlled off/on comparison, repeated
  affected traces, fresh post-repair recovery evidence, and evidence for the
  wider retry/Kafka propagation claim.
- Relevant model-ledger order was `evidence.snapshot.created` (7),
  `live.run.started` (8), first `evaluation.rejected` (14), `plan.revised`
  (15), second `evaluation.rejected` (29), `live.run.completed` (30), and
  `outcome.classified` (31). The execution mode was `gpt_5_6`; the evidence
  mode remained the neutral `frozen_real_otlp_snapshot`.

### Fail-closed authority and cleanup

- After the two evaluator verdicts, the append-only ledger contained zero
  `repair.proposed`, `approval.requested`, `approval.granted`,
  `repair.executed`, `verification.completed`, `regression.created`, or
  `policy.evaluated` events. No Owner Gate was opened, no product repair was
  authorized or executed, and no recovery or five-gate policy result exists for
  this run.
- Because the single paid workflow failed acceptance, it was not retried. The
  same checked-in allowlisted executor was invoked only as task-authorized
  safety cleanup outside the product proof; it restored the flag to `off` at
  `2026-07-18T17:05:59.449Z`. The task-owned server on port `4322` was stopped,
  and `npm run live:stop` stopped the disposable Astronomy Shop stack.
- Final readiness was therefore intentionally `docker: true`, pinned revision,
  `flag_api: false`, and `ready: false`. This is a stopped clean environment,
  not a ready live demo. No Langfuse trace, token-usage record, latency record,
  model cost, or accepted-GPT recovery claim is made.

### Slice 3 acceptance result

**Blocked at adversarial evaluator acceptance.** Real E1 -> E2 -> E3 evidence
and the frozen-snapshot tool path were proven, but the required genuine
GPT-accepted diagnosis and owner-approved recovery did not occur. The earlier
successful real local repair remains deterministic, not GPT-executed.

## P0 Slice 3.1 — phase-correct evidence contract and no-GPT rehearsal

### Contract correction

- The prior paid evaluator result was preserved as historical evidence, but its
  contract was not accepted: post-repair recovery cannot be a pre-approval
  diagnosis prerequisite, and Kafka/accounting/fraud evidence cannot be
  mandatory when the revised diagnosis explicitly leaves wider propagation
  unproven.
- The pre-approval Diagnosis Gate now requires exactly: the initiating applied
  change; the reviewed pinned checkout implementation semantics; a recent
  flag-off checkout→payment success; three distinct post-change traces where
  checkout directly evaluates `paymentUnreachable=on` and the direct child
  Payment charge fails with the bounded resolver/unreachable mechanism; and
  strict baseline < change <= evaluations < failures ordering.
- Owner approval validates only the exact repair contract. Recovery remains in
  the post-action Verification Gate. Learning/promotion still requires approval
  ordering, the exact allowlisted repair contract, flag restoration, a fresh
  checkout→payment success, and zero fresh resolver failures.
- Propagation is claim-sensitive: an empty or explicitly unproven propagation
  section is allowed; any proven Kafka/accounting/fraud claim must cite direct
  supporting evidence. The deterministic captured incident may retain its
  wider propagation story because that fixture contains the relevant evidence.

### Pinned code semantics and bounded collection

- Allowlisted code evidence is bound to official Astronomy Shop commit
  `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`, path
  `src/checkout/main.go`, lines 565–575, and content SHA-256
  `da8ec864c0882d90f822bf06c42ffc2104e86b65ee4acdb2cb6238ccad137c69`.
  The safe record states only that `paymentUnreachable=true` replaces the
  normal Payment client with `badAddress:50051` before
  `PaymentService.Charge`; arbitrary repository contents are not queryable.
- Real checkout spans omit an explicit success status, which is the OTLP
  semantic default `UNSET`; the normalizer now maps that absence to `unset`.
  The parent PlaceOrder span also evaluates `kafkaQueueProblems` after Payment,
  so the causal extractor now admits only the reviewed `paymentUnreachable`
  event instead of selecting the last unrelated parent event.
- The Collector JSONL tail is high volume: an early rehearsal showed that the
  4 MiB bounded read window could rotate out earlier qualifying failures before
  a third arrived. FlowPulse now accumulates only safe, hashed, distinct
  qualifying summaries across bounded live projections (90-second maximum),
  then freezes them. The baseline and code records are stored as redacted
  append-only ledger projections at case start, so cap/tail rotation cannot
  silently erase the controlled contrast. Raw OTLP and raw trace/span IDs are
  not stored in those events or exposed by evidence detail APIs.

### Real no-GPT rehearsal

- `FLOWPULSE_DEVELOPMENT_ENABLED=1 npm run live:start` reported
  `docker: true`, exact pinned revision, `flag_api: true`, and `ready: true`.
  FlowPulse ran on fresh port `4321` with isolated ledger
  `/tmp/flowpulse-slice31-final.w94Q1w/ledger.db`; `OPENAI_API_KEY` and Langfuse
  credentials were explicitly absent from that process.
- Development run `run-2ac1974a-5b3f-4aae-960a-7cafe9fcc967` recorded the
  real off→on change at `2026-07-18T17:39:10.881Z`. Snapshot
  `snapshot-55d9b8ad9dc7c6e4` froze at `2026-07-18T17:39:44.358Z`, selecting 18
  of 876 bounded source records (19,981 bytes). Source SHA-256 was
  `b87267113b5fb5ff89fa8733102833e99f45f3c9209c5e96908a5709e1c8e778`;
  content SHA-256 was
  `55d9b8ad9dc7c6e4e46829b5e976f711d8dc28db64376fda133a2b27bd76b986`.
- Exact reserved causal records were:
  - baseline `live-tra-ad1e9733535e`, SHA-256
    `ad1e9733535eed39d94edb781feb60b5a1c20d9d80970acf6ea9e6a1a401c36f`,
    flag-off evaluation `2026-07-18T17:38:51.071Z`, successful Payment charge
    `2026-07-18T17:38:51.076Z`, hashed trace ref `55466b21bfc0`;
  - code `code-da8ec864c0882d90`, the pinned hash/commit/path/line range above;
  - change `change-f606059cb0a3b78a`, SHA-256
    `f606059cb0a3b78a6b72ff2d70182e19f2e988ffa52bf86f676bd0a678054737`;
  - failure `live-tra-122fd4e897d9`, SHA-256
    `122fd4e897d91f994bd954890935d4c00c5859ae7099cd8686183a30350d3aa1`,
    evaluation/failure `17:39:23.423Z`/`17:39:23.431Z`, trace ref
    `3110e7721ab4`;
  - failure `live-tra-a47456ce1566`, SHA-256
    `a47456ce1566902f21a215c584a5a936449ca28cf0c99556e0acc90fb02c754c`,
    evaluation/failure `17:39:26.328Z`/`17:39:26.333Z`, trace ref
    `c437b7f702bb`;
  - failure `live-tra-b4b8b4bbb544`, SHA-256
    `b4b8b4bbb544c1f09c430d2e19d4133c5c680208506305738b5783032073f42a`,
    evaluation/failure `17:39:41.781Z`/`17:39:41.789Z`, trace ref
    `a9d285af52d4`.
- All five pre-approval Diagnosis Gate checks passed. The deterministic
  rehearsal rejected unsupported payment-service blame, accepted only the
  narrow checkout flag→resolver mechanism, and opened the exact Owner Gate:
  `repair-payment-reachable-v1` / target `checkout` /
  `astronomy.restore-payment-and-recreate-checkout`.
- This task intentionally stopped before product approval. Counts were
  `approval.requested=1`, `approval.granted=0`, `repair.executed=0`,
  `verification.completed=0`, `regression.created=0`, and
  `policy.evaluated=0`. The execution mode was `deterministic`; no GPT or
  Langfuse call occurred.
- Task-authorized cleanup invoked the same checked-in allowlisted local command
  outside the product proof, restored `paymentUnreachable=off` at
  `2026-07-18T17:40:12.951Z`, stopped the task-owned server, and ran
  `npm run live:stop`. Final `live:check` truthfully reported `docker: true`,
  pinned revision, `flag_api: false`, and `ready: false` for the stopped stack.

### Verification commands

- Focused evidence/runtime suite: 48/48 passed.
- Full `npm test`: 99/99 passed.
- One non-authoritative parallel run started the focused suite and full suite at
  the same time and hit the server test's five-second startup timeout. The
  isolated `node --test test/server.test.mjs` check then passed 1/1, and the
  required sequential `npm test` run passed 99/99.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: passed.
- No OpenAI/GPT request, product approval, product repair, commit, push,
  deployment, or publication occurred in Slice 3.1.

### Five-axis review

- **Correctness:** diagnosis, approval, verification, and learning remain
  separate gates. The real rehearsal satisfied the full pre-approval gate; a
  proven propagation item must now name one typed entity and its cited record
  must contain the same asserted symptom, so a Kafka-lag record cannot support
  an availability or accounting claim.
- **Security:** pinned code path/commit/line/hash checks, hashed trace/span
  references, bounded safe projections, the exact repair contract, and the
  Owner Gate remain fail closed. No raw source file, raw OTLP payload, raw
  context ID, or credential was added to a model/browser/ledger projection.
- **Performance:** live collection is capped at 90 seconds and retains only
  bounded safe summaries across rolling 4 MiB source projections; the frozen
  snapshot still enforces record and byte caps.
- **Maintainability:** the implementation stays intentionally specific to the
  one reviewed competition incident and adds no framework, vendor, connector,
  or alternate action authority.
- **Observability and tests:** snapshot metadata records exact reserved causal
  IDs, hashes, cap usage, and execution mode. Positive and negative tests cover
  the code allowlist, baseline, repeatability, cap retention, propagation,
  Owner Gate, and recovery controls. No Critical or Required review finding
  remains open.

## P0 Slice 3.2 — one bounded paid GPT-5.6 proof attempt (blocked)

This was exactly one paid workflow, not a retry. It intentionally stopped
before a model diagnosis could be accepted, so it is not evidence of a
GPT-led recovery.

- Fresh development run: `run-3b0a2d8d-43fc-4940-9b26-fa83a98fcd3d`.
  The flag was confirmed `off` at `2026-07-18T18:02:20.780Z`, then the
  checked-in off→on change was applied through the product case API.
- Frozen real snapshot: `snapshot-bebe6e485c7d7ea6`, frozen
  `2026-07-18T18:04:17.834Z`; source SHA-256
  `4ee393e9e0177e0520abc6ac21f55f2606952632b641ed2c52fa7c1051f0dd23`;
  content SHA-256
  `bebe6e485c7d7ea6e0f31261d4bff7205b12e9becc80f1e0320c7ac5dafcce7b`.
  It selected 21 of 904 bounded source records (22,650 bytes).
- Reserved safe evidence included pinned code
  `code-da8ec864c0882d90` (SHA-256
  `da8ec864c0882d90f822bf06c42ffc2104e86b65ee4acdb2cb6238ccad137c69`),
  flag-off baseline `live-tra-a7c8a2b93e1a` (SHA-256
  `a7c8a2b93e1a7968b8b77275f2b4762abb1e1765303eed3488d21ac67db285e6`),
  applied change `change-132a8aa06922b33f` (SHA-256
  `132a8aa06922b33f622acc244dab218adf4d9a3b5450719e9dbd97a4fed07aff`),
  and three distinct direct-parent checkout flag-on → Payment resolver failures:
  `live-tra-b74d06a6ad0c` (SHA-256
  `b74d06a6ad0cf981bc6c6ef54730ed916a8dc78fdc66f7947fd77367a2594f76`,
  `18:03:36.568Z`), `live-tra-4a10ab556316` (SHA-256
  `4a10ab55631609c40a56110ab64af5a187a4a98218f6e3e5e5b6b8dff9ff3c54`,
  `18:03:51.182Z`), and `live-tra-08c105d0b961` (SHA-256
  `08c105d0b961b5c0d0906236105ff527cc53924ce4f5ed99578e2350396a5ebe`,
  `18:04:12.344Z`). The bounded facts state `PaymentService/Charge`,
  `paymentUnreachable=on`, same trace/direct parent, and the resolver error
  "name resolver error: produced zero addresses." No raw trace/span IDs or
  OTLP payloads are recorded here.
- One Responses API workflow using `gpt-5.6` began at ledger sequence 10 and
  made eight frozen-snapshot tool calls (sequences 11–18). The investigator's
  structured text was malformed and failed JSON parsing with
  `Expected ',' or '}' after property value in JSON at position 7937` before
  it emitted a hypothesis or evaluator input. The workflow was not rerun.
- The fail-closed outcome was appended once as `tool_data_failure` (sequence
  19), followed by `development.investigation.failed` (sequence 20). Counts:
  `hypothesis.proposed=0`, `evaluation.rejected=0`, `evaluation.accepted=0`,
  `repair.proposed=0`, `approval.requested=0`, `approval.granted=0`,
  `repair.executed=0`, `verification.completed=0`, `regression.created=0`,
  and `policy.evaluated=0`.
- No owner approval or product repair occurred. Task cleanup used the existing
  allowlisted local cleanup command outside the product ledger, restored the
  flag to `off` at `2026-07-18T18:06:20.550Z`, stopped the task-owned FlowPulse
  process, and stopped the disposable Astronomy Shop stack. Final
  `live:check` reported the expected stopped state: `docker: true`, pinned
  revision, `flag_api: false`, `ready: false`.

### Slice 3.2 historical follow-up

The historical paid-run failure remains immutable as an older
`tool_data_failure` event. It is not retroactively reclassified. Slice 3.2.1D
implements the replacement response boundary offline; no second paid workflow
was authorized.

## P0 Slice 3.2.1B — Responses boundary repair (offline only)

No OpenAI request, Astronomy Shop start, approval, repair, deployment, or
credentialed observability call occurred in this repair. The historical Slice
3.2 ledger remains immutable: its `tool_data_failure` event is an old-taxonomy
fact, not retroactively rewritten.

- `src/openai-response.mjs` bounds HTTP bodies to 1 MiB, hashes response
  metadata, and validates API status, incomplete state, refusal, output shape,
  tool calls, JSON size, and strict entity-only tool arguments before parsing.
  It uses the typed classifications `model_transport_failure`,
  `model_api_failure`, `model_output_incomplete`, `model_refusal`,
  `model_output_invalid`, and `model_budget_exhausted`.
- `store:false` tool rounds request encrypted reasoning for in-memory replay
  only. The ledger and observability receive no raw model input/output,
  refusal text, response/call IDs, encrypted reasoning, or API error text.
  Investigator/evaluator requests are capped at 12,288/8,192 output tokens;
  a workflow caps paid responses at 10, tool calls at 24, and actual output
  tokens at 49,152.
- A typed model boundary failure produces one stable `failure_id`, exactly one
  `outcome.classified` and one failed-run event, a bounded 422/502/504 API
  envelope, and no hypothesis, evaluator, repair, or approval event. Evidence
  and causal failures retain their existing classifications.
- Offline synthetic tests cover completed, incomplete, refusal, malformed,
  missing/multiple/mixed/oversized output, invalid or duplicate tool calls,
  encrypted-reasoning non-persistence, token budget exhaustion, transport,
  non-2xx/non-JSON, and exactly-once safe failure events. No new paid attempt
  was authorized; a separately authorized run is still required to prove a
  GPT-accepted diagnosis and recovery.
- Verification for this offline patch: focused response/failure/contract tests
  passed 10/10; full `npm test` passed 105/105; `npm audit
  --audit-level=high` found zero vulnerabilities; and `git diff --check`
  passed. The test seed used to probe non-persistence appears only in the test
  source, not in any generated ledger, API, or observability serialization.

## P0 Slice 3.2.1D — response-boundary hardening (offline only)

No OpenAI request, stack start, approval, repair, deployment, commit, push, or
publish occurred in this correction.

- Response items are now strict: terminal messages must be completed assistant
  messages, function calls must be completed, every replayed reasoning item
  must have bounded encrypted content, and call IDs are UTF-8 bounded.
- Incomplete/refusal states are inspected before token usage is consumed, so
  they retain their own typed classifications even if usage is absent. Runtime
  schema validation enforces exact diagnosis/evaluation keys, types, ranges,
  enums, byte limits, and unique evidence references before semantic gates run.
- Attempt hypothesis/evaluation events stay in memory until the whole bounded
  evaluator workflow reaches a terminal result. A malformed second attempt
  leaves no model authority event; tool-call audit remains available.
- Failure metadata is an explicit allowlist of hashes, bounded counters, and
  response state. It excludes raw response text/bodies, refusal text, response
  and call IDs, encrypted reasoning, API errors, and arbitrary metadata. The
  append-only ledger now uses deterministic `INSERT OR IGNORE` failure-event
  identities so duplicate writers create exactly one classification and one
  failed-run event.
- Offline synthetic coverage now includes strict item state, absent-usage
  incomplete responses, structural diagnosis/evaluation violations, safe
  envelopes/observability projections, second-attempt buffering, bounded
  rejection→replan, and concurrent duplicate failure audit. A separate explicit
  authorization and Sol re-review are required before any additional paid run.
- Verification: focused response/contract/failure/server tests passed 17/17;
  the full suite passed 111/111; `npm audit --audit-level=high` returned no
  high-severity vulnerability; and `git diff --check` passed.

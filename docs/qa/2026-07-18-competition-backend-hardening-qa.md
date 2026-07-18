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
  `{ severity: "ERROR", message: "payment call refused", trace_id: "abc" }`;
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

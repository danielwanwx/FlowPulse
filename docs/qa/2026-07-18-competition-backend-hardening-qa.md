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

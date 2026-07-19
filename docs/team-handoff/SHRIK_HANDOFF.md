# FlowPulse teammate handoff

**Teammate:** Shrik Wan (`@shrikisgood`, `shrikisgood@gmail.com`)
**Repository:** <https://github.com/danielwanwx/FlowPulse>
**Competition category:** Developer Tools

## Product thesis and flagship demo

FlowPulse is an incident flight recorder and bounded agentic autotriage loop.
It reconstructs an incident from captured or frozen evidence, makes a wrong
Kafka hypothesis visible and challengeable, replans to an evidence-backed
checkout-to-payment cause, keeps consequential repair behind an Owner Gate,
then records verification and regression learning. The append-only SQLite
ledger is authority; the model, connector, fixture, browser, cursor, and replay
never are.

The judge path is deterministic captured replay of the Astronomy Shop incident:
checkout configuration/change evidence -> payment failure -> retries/Kafka lag
-> evaluator rejects Kafka as root cause -> replan -> Owner Gate -> bounded
recovery/verification/learning. Real local OTLP and GPT-5.6 are separate,
truth-labelled proofs, not prerequisites for the default demo.

## Current git state

| Item | State |
| --- | --- |
| Branch | `main`, published to `origin/main` after this handoff commit |
| Backend-integration checkpoint | `3bf116ea7078713386044194c8734e69ddb5815e` |
| Accepted historical frontend visual baseline | `7426364` |
| Restored frontend commit | `cb1afd009a4a36593ea33107a4b276830e4e6cff` |
| Local review URL at handoff time | `http://127.0.0.1:4312/` if Daniel's local process remains running; it is not hosted |
| Generated local artifact | `state/connector_capabilities.json` stays intentionally untracked |

The restored browser shell is intentionally the accepted pre-integration UI:
Architecture, Live, Diagnose, Recovery Console, and Compare. It is served by
the preserved backend compatibility surface. This visual restoration is not
completion of the planned projection-only three-stage frontend migration.

## What stays preserved in the backend

- Append-only ledger and hardened authority: `src/ledger.mjs`,
  `src/autonomy-policy.mjs`, `src/autonomy-freshness.mjs`,
  `src/autonomy-policy-artifacts.mjs`, and `src/server.mjs`.
- Private server-owned decision/Owner-Gate composition, exact event binding,
  failure locks, and single-process at-most-one local adapter attempt.
- IncidentProjection v1 and canonical validation:
  `src/incident-projection.mjs` and `src/projection-canonical-validator.mjs`.
- Provider-neutral evidence-envelope/connector-manifest contracts and two
  captured fixtures: `src/evidence-envelope.mjs`,
  `src/connector-manifest.mjs`, and `test/fixtures/integration/`.
- Bounded evidence, development, OpenAI/GPT-5.6, observability, harness,
  evaluation, regression/backtest, and server test paths.

## Intentional decoupling

The newer projection-driven frontend was rejected visually. Its browser client
and test were removed in `cb1afd0`; no backend authority, projection, ledger,
connector, or evaluator work was rolled back. The next team must:

1. Keep the restored shell and white/black visual language as visual reference.
2. Integrate backend projection information only in small read-only slices.
3. Never let a browser value, compatibility endpoint, fixture, timer, or cursor
   infer or mint risk, approval, execution, verification, or authority.
4. Stop for Daniel's screenshot review after each slice.

## Run and verify

Prerequisites: macOS or Linux, Node.js 20+, and `sqlite3` on `PATH`. The
default judge path requires no Docker, OpenAI key, Langfuse account, or OTLP
collector.

```bash
git pull --ff-only origin main
npm ci
npm test
npm start
```

Open <http://127.0.0.1:4310>. Useful checks:

```bash
npm test
node --test test/twin-state.test.mjs
node --test test/ledger.test.mjs test/autonomy-policy.test.mjs \
  test/incident-projection.test.mjs test/server.test.mjs
```

`npm run judge` runs tests then starts the server. `npm run submission:check`
currently fails before tests because its secret scanner flags the tracked
`synthetic-test-only` test fixture; do not claim that wrapper passes until a
separate reviewed repair. Local OTLP commands are
opt-in only: `npm run live:check`, `live:setup`, `live:start`, `live:case`,
and `live:stop`; follow the README safeguards first.

## Authority and truth invariants

- The canonical append-only ledger is the only runtime authority.
- The server owns registry, frozen capture, trusted time, receipt,
  failure-lock validation, decision derivation, and canonical decision events.
- UI/model/connector/request data cannot carry risk, authority, freshness,
  evidence completeness, lock state, contract hash, receipt, or repair truth.
- Stale, unavailable, malformed, cross-scope, duplicate, or schema-mismatched
  data is non-actionable; backend failure never falls back to demo state.
- Source health, evidence mode, and execution mode stay distinct. Captured
  fixture, frozen real snapshot, GPT model-only, deterministic replay, and
  real-local development must never be conflated.
- Checkout/payment remains Owner-Gated. P0 does not claim autonomous live
  remediation or exactly-once external effects.

## Frontend acceptance direction

Preserve the accepted white technical canvas: compact, evidence-rich, spatial,
and not a generic card wall. Keep Architecture/Live/Diagnose/Recovery/Compare
useful while migration work is reviewed. Topology and timeline stay primary;
drawers hold bounded evidence/detail. Use existing Phosphor assets, no new
design system, no dark-only redesign, and no invented graph facts. A visual
checkpoint covers architecture, evaluator rejection/replan, Owner Gate,
recovery/compare, evidence drawer, and explicit unavailable state.

## Remaining work

### P0 — competition critical

1. Discover and test the smallest read-only adapter from IncidentProjection v1
   to the restored visual shell; do not broad-rewrite the UI.
2. Restore a coherent three-stage presentation only after Daniel accepts a
   visual checkpoint. The frontend remains non-authoritative.
3. Add two planned fresh-server browser E2E paths after UI contract stability:
   deterministic captured replay and bounded Owner-Gate flow.
4. Repair the `submission:check` false-positive scanner before release claims.
5. Produce truthful hosted/demo/video/Devpost materials and complete external
   owner-only submission gates.

### P1 — only after P0

- OpenLineage JSONL ingestion and vendor-specific adapters.
- Richer bounded topology/evidence views.
- More real local proof with explicit disposable-environment approval.

### P2 / drop for Build Week

- Connector marketplace, multi-tenant control plane, production deployment
  authority, unrestricted live remediation, and generic observability SaaS.

## Checkpoint, branch, and PR workflow

One task equals one bounded change. Before editing: pull, inspect status, run
the relevant baseline test. After editing: run focused tests, `git diff --check`,
launch locally if visual, capture screenshot/evidence, and stop for Daniel's
review. Do not combine a UI redesign, authority change, and submission work in
one commit.

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c shrik/flowpulse-integration
git add <explicit paths>
git commit -m "<scoped imperative message>"
git push -u origin shrik/flowpulse-integration
```

Open a PR to `main` with tests, screenshot paths/URLs, truth-mode labels, and a
clear statement that no browser authority was added. Daniel reviews before
merge. If collaborator push access is unavailable, use a fork and a PR.

## Devpost and provenance

Devpost submission `1094090` is **Draft (3/5)** in **Developer Tools**. The
remaining owner-owned work is a truthful hosted/public review path as
applicable, a public under-three-minute narrated YouTube video, final field
verification, terms checkbox, and final Submit.

The required Devpost `/feedback` field currently contains the original primary
Build Week session ID:

```text
019f6eaf-ded3-78e1-a9c3-8ae4fd6811e2
```

Keep it unless evidence shows the majority of core functionality shifted to
another session. Shrik obtains a `/feedback` ID for each new implementation
session and records it as **secondary provenance** in PR notes/handoff records;
it does not overwrite the required primary field by default.

See [session operations](STARTING_NEW_CODEX_SESSIONS.md),
[the PM prompt](PROMPT_PM_REVIEW_SESSION.md),
[the implementation prompt](PROMPT_IMPLEMENTATION_SESSION.md), and
[the Build Week checklist](../BUILD_WEEK_SUBMISSION_CHECKLIST.md).

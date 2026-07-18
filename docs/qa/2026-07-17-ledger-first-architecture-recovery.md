# Ledger-first Architecture and Recovery QA

**Date:** 2026-07-17
**Viewport:** 1440 × 900

## Automated checks

- `npm test` — 54 passing, 0 failing.
- `node --check public/app.js` and `node --check public/twin-state.mjs` — passing.
- `git diff --check` — passing.

## Browser checks

- Architecture showed four named source-derived layers with 21 live OTLP components; cards use transparent vectors and exposed status in accessible names.
- Checkout opened a compact Overview first, with only actual Signals, Dependencies, and Evidence tabs available after it.
- Recovery Console showed one current diagnosis, the six-role graph, a chat-first collaborator panel, and the current owner; secondary metrics and legend chrome were absent.
- Selecting Observer changed the collaboration panel to its scoped grounded signal and quick prompts.
- The incomplete ledger showed only Healthy, Deploy, and Propagate plus `Next: awaiting adversarial evaluation`; unreached recovery and learning milestones were not rendered as future completion.
- Browser console: 0 errors, 0 warnings. Page scroll width equalled the 1440px viewport; the contextual drawer was closed for the final Architecture page.

## Evidence and provenance note

Architecture and entity detail are derived from the current live/captured OTLP source projection. Incident progression remains an append-only ledger-backed deterministic replay. No external remediation, deployment, or telemetry-vendor operation was performed during this QA pass.

## Screenshots

- `architecture-ledger-first.png`
- `recovery-ledger-first.png`

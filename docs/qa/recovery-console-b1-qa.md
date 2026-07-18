# Recovery Console B1 QA

**Verified:** 2026-07-18  
**Server:** `http://127.0.0.1:4310/`  
**Authority:** append-only ledger; owner approval remains outside conversational agents.

## Automated checks

- `npm test` — 51 passing, 0 failing.
- `node --check public/app.js src/agent-control-service.mjs src/server.mjs` — passing.
- `git diff --check` — passing.

## Visible-browser checks

- 1440×900, light: Recovery Console presents six collaborator nodes, the persistent graph, a selected Observer panel, citations, scoped quick tasks, and a retained draft.
- 1280×800, pure black: no horizontal overflow and no collaborator-node overlap; the collaboration panel remains visible at 410px wide.
- Observer quick task prefilled the scoped chat input and submitted a ledger-attributed response citing three immutable evidence records.
- Architecture icon inspection: transparent background, zero icon border, monochrome ink; the checkout status dot retained its semantic blue state.
- Recovery icon inspection in pure black: transparent background, zero icon border, white monochrome vector.
- Keyboard `ArrowRight` moved focus from Observer to Investigator.
- Browser console: 0 errors and 0 warnings.

## Captures

- [Light, 1440×900](recovery-console-b1-light-1440x900.png)
- [Pure black, 1280×800](recovery-console-b1-dark-1280x800.png)

## Honest limitations

- Langfuse remains visibly marked as not configured in this local deterministic demo; it is observability only and does not become runtime authority.
- The browser QA uses captured/replayed incident evidence and a local server; it does not claim a live production deployment.

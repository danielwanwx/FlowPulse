# Canonical Presentation Adapter Design

## Scope

This checkpoint repairs the presentation adapter for Diagnose, Recovery Console, and Compare on `codex/frontend-architecture-polish-v2`. It starts from `codex/demo-integration` commit `505c7fe0223640fb7f3b2a10ba610034b1d6247c` and does not alter backend truth, APIs, authority, data fixtures, or the accepted Architecture and Live visual language.

The legacy worktree at `/Users/danielwan/Documents/Codex/2026-07-16/flowpulse` is protected. Its uncommitted `public/app.js`, `public/styles.css`, `public/twin-state.mjs`, `test/twin-state.test.mjs`, and untracked `state/` remain untouched. Useful intent from commits `ec9b82b`, `7ea9b61`, and `4923b18` is ported semantically only after comparison against the canonical baseline. No blind cherry-pick is permitted.

## Canonical data rule

Every workspace reads one server-owned canonical model:

- `run_id`, `incident_id`, and `projection_revision` stay identical across Architecture, Live, Diagnose, Recovery Console, Compare, and Agent Chat.
- Canonical node and edge IDs remain stable. Presentation may lower emphasis but may never replace a canonical graph with a browser-owned six-node graph.
- Ordered event stream, safe chat answers, citations, Owner Gate, execution, and verification are server projections. The browser does not advance stage, create a recovery result, or generate metrics with timers.
- Compare is rendered only when the canonical `verification.passed` and workspace gate permit it. Its incident and verified views use fixed canonical coordinates and snapshots, never old independent replay frames.

## Presentation strategy

The product remains a technical B2B operations console for engineering teams. Preserve the cold light-gray canvas, soft white floating surfaces, Apple-like system type, restrained blue accent, Phosphor glyphs, and shared rounded geometry. This is a preserve-mode redesign, with visual variance 5/10, motion 4/10, and information density 5/10.

### Diagnose

Diagnose uses the full 22-node canonical topology. The six-node evidence-backed incident overlay is prominent: affected nodes and relations use the existing fault styling; non-affected canonical nodes remain visible as low-emphasis context. The canvas shows no internal IDs, source implementation labels, or technical secondary headers. At most four human-readable KPI values, the current diagnosis stage, and cited evidence are visible. The timeline is compact; history belongs in the unified right rail or drawer. The rail is the only Control/Agent surface.

### Recovery Console

Recovery is never a blank page. Its main canvas projects only recorded facts from the current canonical run: proposal, handoff sequence, Owner Gate, execution, and independent verification. The affected topology retains its canonical identity. The right rail is the only status/chat surface; no legacy Commander or second control column remains. If a fact is absent, the canvas explicitly says it is awaiting a server record instead of substituting a success state.

### Compare

Compare appears only after backend verification is passed. It uses the same canonical node set and fixed coordinates for baseline, incident, and verified snapshots. The comparison divider changes which recorded snapshot is emphasized; it does not manufacture a second graph. The right rail remains the single contextual surface.

## Interaction and accessibility

Node selection opens the existing safe inspector without remounting the graph or restarting signals. Agent Chat preserves selected canonical node, draft text, conversation, citations, and ordered event cursor during SSE updates. Keyboard focus, Escape/Back restoration, reduced motion, and reduced transparency behavior remain shared with Architecture and Live.

## Verification

Focused tests cover canonical visual identity, six-node overlay emphasis, recovery workflow ordering, verification gating, Compare snapshot identity, and no legacy replay fallback. Browser QA uses one fresh canonical run at 1600x900: Architecture, Live, Diagnose, Recovery, Compare, Agent Chat input/answer/citation, and console error-free navigation. The run record must prove one run, incident, and revision across all views.

## Non-goals

No backend contract changes, new UI dependencies, mock telemetry, new agent role, Diagnose/Recovery/Compare behavioral redesign, production deployment, or merge to `codex/demo-integration` occurs in this branch.

## Commit plan

1. Protect and document this branch boundary.
2. Add canonical adapter tests, then minimally update shared presentation code and CSS.
3. Capture browser evidence and run focused plus full tests.
4. Commit and push `codex/frontend-architecture-polish-v2` for owner review. The branch is not self-merged.

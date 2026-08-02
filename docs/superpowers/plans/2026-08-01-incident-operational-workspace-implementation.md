# Incident Operational Workspace Implementation Plan

## Outcome

Turn the existing V3 Incident workbench into the approved work-state-first
workspace without replacing its workflow or data contracts. The first screen
must make the active stage, live failure path, changing telemetry, and current
agent work understandable at a glance. All drill-down surfaces remain available
on demand. The implementation must continue to fail closed when real data or
the control plane is unavailable.

## Current baseline

The branch already contains the required foundations:

- `public/incident-workspace-v3.mjs` renders one current stage, three real
  metric visual grammars, the full evidence-backed Dataflow modal, the Agent
  Portal, and all six workflow stages.
- `public/incident-workbench-controller-v3.mjs` owns canonical projection and
  series loading, SSE rehydration, commands, focus management, and URL state.
- `scripts/start-v3-local.mjs` starts the pinned Astronomy Shop, Node/BFF,
  control plane, Temporal worker, Postgres, and MinIO; it proves a new
  post-watermark `paymentUnreachable` trace before announcing a case.
- `scripts/v3-local-recovery.mjs` already rejects a case without the real
  Checkout-to-Payment edge and the error-rate, latency, and request-count
  evidence series.
- Existing uncommitted backend changes fix stale freshness intervals, explicit
  agent failures, and safe Temporal rollover. They are preserved and validated;
  this UI change does not replace them.

Observed blockers before implementation:

- Docker Desktop is not running, so the real control-plane stack cannot start.
- `npm run v3:local:dry-run` reports `clean_worktree: false`; the attested V3
  launcher intentionally refuses to label uncommitted code as a Git SHA.

## Scope control

Use the smallest set of changes that creates the selected C layout:

- No framework or chart dependency.
- No new backend endpoint or database migration.
- No fake PagerDuty/Grafana integration or invented week/month history.
- No rewrite of workflow commands, action approval, or verification semantics.
- No unrelated Architecture/Live redesign.

## Task 1 — Lock the new home contract with renderer tests

**Files**

- Modify `test/incident-workspace-v3.test.mjs`.
- Modify `public/incident-workspace-v3.mjs` only after the tests express the
  intended structure.

**Tests to add**

1. The current stage surface renders one `iw3-operations-home` containing:
   current work status, embedded impact flow, signal strip, and agent activity.
2. Future stage content remains absent and locked.
3. The home renders four factual summaries when possible: three typed metric
   series plus one dependency/connector status derived from the canonical
   projection. If any source is unavailable, its card says unavailable/stale.
4. The home does not render projection `summary`, raw provider failures, full
   facts/unknowns, or future-stage conclusions.
5. Home nodes and edges use only `projection.graph` and `impacted_path`; a
   missing edge does not produce an inferred arrow.
6. Historical stages remain read-only and do not expose Agent or workflow
   mutation controls.

**Acceptance**

`node --test test/incident-workspace-v3.test.mjs` passes.

## Task 2 — Extract one reusable evidence-backed flow renderer

**Files**

- Modify `public/incident-workspace-v3.mjs`.
- Modify `test/incident-workspace-v3.test.mjs`.

**Implementation**

1. Extract the graph canvas data preparation currently embedded in
   `graphModalMarkup` into one pure helper that accepts projection, selected
   component, series, current time, and presentation mode.
2. Reuse it for:
   - a compact embedded home flow;
   - the existing full Dataflow modal.
3. Keep the current evidence rules:
   - nodes come from `projection.graph.nodes`;
   - edges come from `projection.graph.edges`;
   - pulse classes come from non-expired `active_pulses`;
   - node status uses canonical runtime/impact state and freshness;
   - no edge or dependency is guessed from text.
4. The embedded flow opens the Agent Portal when a node or edge is clicked.
   `Open Dataflow` opens the complete graph without changing the current stage.
5. Keep graph node investigation available only in the current Investigate
   stage and keep historical/resolved graphs read-only.

**Acceptance**

- Compact and modal graphs render the same node/edge identities.
- Reduced-motion disables pulse animation but preserves state colors.
- Existing graph and portal tests remain green.

## Task 3 — Build the work-state-first stage composition

**Files**

- Modify `public/incident-workspace-v3.mjs`.
- Modify `public/styles.css`.

**Implementation**

1. Replace each stage's loose deck with a stable operations composition:
   - `iw3-work-status`: stage state, progress, latest activity, and the next
     required human/system condition;
   - `iw3-home-flow`: compact live impact graph and explicit full-graph action;
   - `iw3-home-signals`: real metric cards and connector/dependency health;
   - stage-specific action surface only where required.
2. Keep stage specialization minimal:
   - Detect: data sufficiency and connector freshness.
   - Triage: bounded scope counts and latest agent activity.
   - Investigate: leading hypothesis confidence and evidence-query count.
   - Decide: recommended allowlisted action and bounded risk.
   - Respond: existing approval card and execution status.
   - Verify: observation countdown, healthy-sample count, and post-action
     telemetry.
3. Do not expand facts, unknowns, hypotheses, evidence refs, receipts, or audit
   records on the home. Their existing modal/drawer routes remain the detail
   surfaces.

**Acceptance**

- Every stage has the same visual hierarchy but different factual work state.
- The page never becomes an all-stage report.
- `Next` availability still comes exclusively from server-issued commands and
  current run status.

## Task 4 — Make real telemetry the visual center

**Files**

- Modify `public/incident-workspace-v3.mjs`.
- Modify `public/styles.css`.
- Modify `test/incident-workspace-v3.test.mjs`.

**Implementation**

1. Keep the existing area, stems, and tiles grammars for error rate, latency,
   and traffic. Show up to three series on the compact home and all available
   series in Monitor.
2. Add one non-chart status card from `projection.connectors` and the
   Checkout-to-Payment graph edge. It must show provider, state, lag, and
   observed/fresh-until timestamps only when the projection supplies them.
3. Rename the detail surface to `Observability` while keeping the existing
   Monitor button label if desired for space. The modal contains:
   - all real series at the available retention window;
   - connector health;
   - the latest observation timestamp and sample count;
   - an honest `External dashboard not configured` state.
4. Do not offer one-week or one-month selectors unless the returned series
   actually spans those windows. Display the real observed duration instead.
5. Preserve gaps and missing reasons; never bridge missing samples with a line.

**Acceptance**

- Three distinct real numeric samples cause a visible path/value change.
- A missing or stale series displays its last real value as `Last …` and a
  stale/unavailable state.
- No sine wave, random number, extrapolated point, or frontend timestamp is
  used as telemetry.

## Task 5 — Stabilize Agent Portal and progressive disclosure

**Files**

- Modify `public/incident-workbench-controller-v3.mjs`.
- Modify `public/incident-workspace-v3.mjs`.
- Modify `public/styles.css`.
- Modify `test/incident-workspace-v3.test.mjs`.

**Implementation**

1. Remove the reserved empty right column when the portal is closed.
2. Opening a node, edge, or metric opens the portal with that exact context;
   closing it restores the stage to the full width.
3. Portal tabs remain `Now`, `Activity`, and `Evidence`. Keep the agent composer
   only in current Triage/Investigate/Decide.
4. Preserve the pending/success/error notice for a requested Agent run and its
   selected component identity across SSE projection refreshes.
5. Persist case, review stage, panel, component, edge, series, portal state, and
   portal tab in the URL. A reload must restore the same view.
6. Keep prose compact. Full activity/evidence text appears only after the user
   opens the related tab or modal.

**Acceptance**

- No unexplained blank rail is visible.
- Portal focus, Escape close, and focus restoration work for keyboard users.
- Duplicate clicks do not start duplicate Agent runs or workflow commands.

## Task 6 — Apply the selected visual language and responsive layout

**Files**

- Modify `public/styles.css`.

**Implementation**

1. Use the existing V3 glass variables and recent borderless overrides; do not
   introduce a second theme system.
2. Use rounded, borderless glass cards, soft gray inactive surfaces, blue work
   state, red affected state, and green recovered state.
3. Make the embedded flow the largest module without creating unused white
   space. Keep the fixed footer actions visible without covering stage content.
4. Desktop target: flow and work state in the main column, portal in a 320–360px
   rail when open, compact signal cards below/alongside.
5. `451×859` target: one document flow, horizontally scrollable stage rail,
   full-width cards, portal as an in-flow panel, and full-screen scrollable
   modals. No page-level horizontal overflow.
6. Ensure icon baseline, number/unit alignment, minimum touch target, focus ring,
   modal scroll containment, and reduced-motion behavior.

**Acceptance**

- Browser screenshots at desktop and `451×859` show no clipping, overlap,
  misplaced icons, or unreachable controls.
- The full graph remains legible and scrollable at narrow widths.

## Task 7 — Preserve and validate backend correctness fixes

**Files**

- Preserve the existing changes in:
  - `control_plane/flowpulse_cp/workspace_v3_guided.py`
  - `control_plane/flowpulse_cp/workspace_v3_runtime.py`
  - `control_plane/flowpulse_cp/workspace_workflow.py`
  - their two focused test files.

**Validation**

1. Stale realtime sync clamps `fresh_until` to `observed_at` rather than
   creating an invalid interval.
2. A manual Agent provider failure terminally fails the current stage,
   publishes Retry/Escalate, and safely rebases over concurrent realtime writes.
3. Temporal continue-as-new waits until no active update or freshness timer can
   be lost.
4. No backend schema or persistence change is added for the UI composition.

**Acceptance**

Run the focused guided workflow and stage runtime tests. Any failure in these
areas blocks browser acceptance.

## Task 8 — Automated verification

Run in this order:

1. `node --test test/incident-workspace-v3.test.mjs`
2. `node --test test/control-plane-v3-client.test.mjs test/control-plane-v3-contract.test.mjs test/live-v3.test.mjs test/twin-state.test.mjs`
3. `git diff --check`
4. `PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest tests.test_workspace_v3_guided_workflow tests.test_workspace_v3_stage_runtime -v` from `control_plane/`
5. Run the broader Node/Python suites only if local disk capacity permits;
   distinguish infrastructure failures from product assertions.

Review the actual diff for scope, duplicate rendering logic, invented data,
broken server command authority, URL-state regressions, and CSS overrides that
affect Architecture or Live.

## Task 9 — Real Incident runtime and screenshot QA

This task starts only after automated checks pass.

1. Start Docker Desktop and confirm the daemon is healthy.
2. Because the official launcher requires an attested clean tree, obtain
   explicit approval before creating any verification commit or other clean
   runtime snapshot. Do not mislabel a dirty tree.
3. Run `npm run v3:local -- --new-case` without deleting Postgres or MinIO
   volumes.
4. Verify the launcher observed a post-watermark Checkout-to-Payment failure
   trace and published a ready V3 case with all three required metric categories.
5. In the browser, manually cover and screenshot:
   - Live active Incident and affected topology;
   - Detect home and changing samples;
   - node, edge, and metric portal contexts;
   - Activity, Evidence, Observability, and Dataflow;
   - Triage, Investigate, Decide, Respond approval, Verify, and final audit;
   - refresh/SSE restore;
   - desktop and `451×859` layouts.
6. Compare every capture against the selected C mockup and record defects by
   severity. Repair only concrete failures, rerun targeted tests, and recapture.

## Definition of done

- A real `paymentUnreachable` Incident appears in Live and Incident with the
  same case, components, severity, freshness, and path.
- The current stage, active failure flow, latest metrics, and Agent work are
  understandable without opening a report or reading long prose.
- All drill-down controls work and restore after refresh.
- The six-stage workflow remains server-controlled and can be exercised through
  real approval, execution, and post-action verification.
- Automated tests pass and the final screenshot set contains no critical layout
  or interaction defects.


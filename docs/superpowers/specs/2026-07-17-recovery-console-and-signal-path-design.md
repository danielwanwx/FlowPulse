# FlowPulse Recovery Console and Signal Path Design

Date: 2026-07-17  
Status: Approved direction (Option A), pending implementation review  
Scope: bounded frontend refinement plus ledger-governed internal work-item proposals; no external GitHub or Jira mutations

## Goal

Make the three operational views communicate distinct jobs without changing the authoritative incident facts or expanding the telemetry backend:

1. **Architecture** is a compact, connection-free component stack that reveals the current system shape at a glance.
2. **Live** is a readable runtime topology where a single colored signal visibly activates its full route and sequentially acknowledges source and destination components.
3. **Recovery Console** is the developer-facing incident recovery workspace for diagnosis review, task delegation, PR review proposals, owner approval, Jira ticket drafts, and agent execution visibility.

The immutable incident/evidence ledger remains runtime authority. Langfuse remains observability only. GitHub and Jira actions are drafts until a separately configured integration and human authorization exist.

## Product Boundary

### In scope

- Compact Architecture layout with zero visual gaps inside each tier.
- Shared-border component blocks with stable vector icons and accessible names.
- Deterministic Live signal sequencing, active-edge illumination, and source/target acknowledgement.
- High-contrast pure-black theme borders and connectors.
- Rename the user-facing Agents mode to Recovery Console while retaining the internal `agents` mode key for compatibility.
- Recompose the Agents view into diagnosis, agent execution, manager conversation, and action queue regions.
- Ledger-governed internal proposals for task delegation, PR review, and Jira ticket drafting.
- Deterministic tests and visible-browser QA.

### Out of scope

- Calling GitHub, Jira, Slack, or any other external service.
- Creating, approving, merging, or deploying a real PR.
- Creating a real Jira ticket.
- Replacing the current OpenTelemetry capture path.
- Changing incident causal facts, the owner remediation gate, or the agent-team harness authority rules.
- Backend framework or database redesign.

## Information Architecture

### Shared shell

The five primary modes remain Architecture, Live, Diagnose, Recovery Console, and Compare. The top-level title, metric strip, timeline, and contextual evidence drawer continue to project the same authoritative state.

### Architecture

Architecture uses a centered stepped stack:

- Each semantic tier is a single border-collapsed row.
- Cards inside a row have no horizontal gap; adjacent cards share one border.
- Rows touch vertically; a tier begins directly where the previous tier ends.
- Wider tiers sit below narrower tiers to create a compact pyramid/building-block silhouette.
- No dependency connectors or pulses appear in this mode.
- Each component keeps its type-specific vector icon, label, and origin metadata.
- Selecting a component still opens the evidence drawer.

This is a static structural projection, not a dependency diagram. Its purpose is architecture comprehension and mode orientation.

### Live

Live keeps the deterministic ranked topology and zoom/pan controls. Visual priority is:

1. component health;
2. currently active dependency path;
3. direction and arrival;
4. quiet background relationships.

Default edges use a restrained neutral stroke. Only one deterministic pulse slot is visually dominant at a time. During its activation window:

- the full corresponding edge changes to the signal color;
- a compact pulse travels from source to target;
- the source component receives a short launch acknowledgement;
- the target component receives a later arrival acknowledgement;
- an active-only terminal marker confirms direction without adding permanent arrow clutter.

Signal colors encode meaning:

- blue/cyan: observed healthy runtime flow;
- amber: deployment/change propagation;
- red: failure propagation;
- green: remediation verification and recovered traffic.

Incident components remain red in Live when explicit authoritative development evidence identifies them. Captured demo data is not mislabeled as live telemetry.

### Recovery Console

Recovery Console replaces the generic Agent Operations presentation with four coordinated regions:

1. **Diagnosis brief** — current accepted/rejected diagnosis, evidence score, causal statement, and owner-gate state.
2. **Agent execution graph** — the isolated agent roles and current handoffs, linked to the same incident timeline.
3. **Manager command** — human/manager conversation, grounded report, and safe task delegation entry.
4. **Action queue** — stage-aware proposals for:
   - assign investigation task;
   - review PR draft;
   - request owner approval;
   - draft Jira ticket;
   - inspect verification or regression record.

The Action queue must visually distinguish:

- proposed;
- awaiting human review;
- approved internally;
- blocked because an external integration is not configured;
- completed in the FlowPulse ledger.

No control may imply that an external PR or Jira ticket exists when it does not.

## Mode and Interaction State

The existing internal mode values remain stable:

```text
architecture -> live -> replay -> agents -> compare
                               \-> manager panel
```

User-facing labels become:

```text
architecture: Architecture
live:         Live
replay:       Diagnose
agents:       Recovery Console
compare:      Compare
```

Recovery Console actions follow this bounded state machine:

```text
available
  -> draft proposed
  -> human review required
  -> internally approved or rejected
  -> ready for integration (when no connector exists)
```

Owner approval for consequential remediation remains separate:

```text
repair proposed -> owner approval required -> repair may execute
```

Chat, PR review, Jira drafting, or internal task delegation cannot satisfy the owner recovery gate.

## Data and Ledger Mapping

The frontend consumes the current `/api/agent-control`, incident state, and live-source projections. It does not infer new causal facts.

Safe internal actions append explicit proposal events through the existing agent-control boundary. Recommended event vocabulary:

- `task.delegation.proposed`
- `task.delegation.accepted`
- `pr.review.proposed`
- `pr.review.recorded`
- `workitem.draft.proposed`
- `workitem.draft.approved`

Every proposal records:

- run ID;
- actor/agent ID;
- action kind;
- title and bounded summary;
- evidence references;
- creation timestamp;
- integration state (`not_configured`, `ready`, or `internal_only`);
- human decision when present;
- idempotency key.

The implementation should prefer one generic safe-action endpoint and schema over separate endpoints for every button. Consequential remediation continues through the existing approval endpoint.

## Visual Grammar

### Architecture blocks

- Rectangular geometry, 2–4 px outer radius only at the four perimeter corners.
- Internal cards have square corners.
- Shared 1 px dividers; no shadows between attached cards.
- Compact height while preserving full labels and icons.
- Tier label appears once per row, not repeated in every card.
- Type distinction comes from vector icon shape and restrained icon color, not card background color.

### Live nodes and edges

- Nodes keep white/light-neutral surfaces or pure-black surfaces depending on theme.
- Edge routing remains outside non-endpoint node bounds.
- Quiet edges stay visible but subordinate.
- Active path illumination raises contrast and stroke width for the full route.
- Node acknowledgement uses a crisp outline/ring and a brief brightness change, not a soft decorative glow.

### Pure-black theme

- Primary component borders: high-contrast near-white.
- Selected/active borders: pure white plus semantic state accent.
- Primary connectors: visible white at a lower opacity than active paths.
- Tier dividers and canvas guides: white with sufficient contrast.
- Secondary metadata may remain gray, but no structural boundary may depend on low-contrast gray.
- Red, green, amber, blue/cyan remain semantic and must meet contrast requirements against black.

### Recovery Console

- Diagnosis brief uses one strong summary band, not multiple generic cards.
- Agent execution remains a graph, but the canvas no longer consumes the entire mode.
- The command and action queue form a recognizable developer console.
- Buttons are task-specific: `Assign task`, `Review PR draft`, `Request owner approval`, `Draft Jira ticket`, and `Inspect verification`.
- Missing integrations are labeled `Draft only · connector not configured`.

## Animation Semantics

### Deterministic Live cycle

Each valid topology edge receives a stable pulse slot from the existing topology-depth ordering. One slot owns the dominant visual state at a time.

For each slot:

1. source node launch acknowledgement;
2. full edge activation;
3. pulse travels along the route;
4. target node arrival acknowledgement;
5. edge returns to the quiet state;
6. next slot begins.

The cycle must be derived from stable topology data, not random timers. Re-rendering the same topology produces the same order.

### Incident and recovery

- Explicit incident paths activate in red.
- Deployment/change paths activate in amber.
- Verification paths activate in green after verified recovery.
- Healthy unrelated paths retain blue/cyan when active.

### Reduced motion

With `prefers-reduced-motion: reduce`:

- no moving pulse or flashing brightness;
- the currently selected/active route remains statically highlighted;
- source and target receive persistent non-animated outlines;
- all information remains available through text and accessible labels.

## Error and Empty States

- Invalid or unresolved topology edges remain excluded from rendering and are reported as evidence gaps.
- An unlinked component remains explicitly labeled `Insufficient dependency evidence`; the UI does not fabricate a connector.
- If no live stream exists, Live preserves the honest captured/last-known label.
- If an internal action append fails, keep the draft in the UI only long enough to show an error; do not present it as recorded.
- If GitHub/Jira connectors are absent, controls create ledger drafts and clearly stop at `Ready for integration`.
- If agent-control state is unavailable, Diagnosis remains accessible and Recovery Console shows a retryable degraded state.

## Accessibility

- All component, edge, agent, and action controls keep descriptive accessible names.
- Active signal direction is exposed in edge labels (`from` and `to`) and never depends on motion alone.
- Architecture reading order follows tier order and then left-to-right order within each tier.
- Keyboard users can select nodes, inspect edges, send manager messages, and operate each proposal action.
- Focus indicators remain visible in light and pure-black themes.
- Structural borders and text meet WCAG AA contrast targets.
- Status changes use an `aria-live` region without announcing every decorative pulse cycle.

## Acceptance Tests

### Architecture

- Every tier has zero visual gap between adjacent component blocks.
- Consecutive tiers touch vertically and form a compact stepped stack.
- Internal shared borders render once; perimeter corners alone are rounded.
- No connector or pulse is present in Architecture markup.
- Every component label and vector icon is complete and selectable at 1440×900 and 1280×800.

### Live

- Every valid edge is routed without crossing a non-endpoint node.
- Every true telemetry island is explicitly labeled; no relationship is invented.
- The active edge receives a full-route semantic color.
- Source acknowledgement precedes target acknowledgement.
- The same topology produces the same pulse sequence on every render.
- Incident paths use red; change uses amber; recovery uses green.
- Reduced-motion mode retains static route and endpoint identification.

### Recovery Console

- The user-facing menu and title say `Recovery Console`.
- Accepted/rejected diagnosis and evidence scores remain visible.
- Task delegation, PR review draft, owner approval, and Jira ticket draft are distinct actions.
- Safe action proposals append exactly once to the ledger with evidence references and idempotency keys.
- Chat and safe action proposals cannot bypass owner recovery approval.
- UI never claims that GitHub/Jira was mutated when no connector exists.
- Agent execution stays synchronized with the incident timeline.

### Themes and quality

- Pure-black theme component borders, structural dividers, and connectors are visibly near-white.
- Light and pure-black themes have zero browser console errors or warnings.
- Existing backend/runtime tests remain green.
- Focused deterministic UI/state tests cover compact stacking, pulse sequencing classes, action states, and theme tokens.
- Representative Architecture, Live active-path, Recovery Console, and pure-black screenshots are stored under `docs/qa`.

## Verification Loop

1. Implement the smallest data/state additions first and test ledger idempotency.
2. Implement Architecture shared-border geometry and verify target viewport dimensions.
3. Implement Live active-path sequencing and verify routing, direction, incident color, and reduced motion.
4. Implement Recovery Console composition and safe action queue.
5. Run the complete automated suite and audit.
6. Restart the latest server on port 4310.
7. Run visible-browser QA in light and pure-black themes.
8. Capture the required screenshots and verify zero console errors/warnings.
9. Commit only after the worktree contains the verified implementation and QA records.

## Feedback Rules

- If Architecture still reads as separated cards, remove spacing and shadows; do not add connectors.
- If Live relationships remain ambiguous, reduce simultaneous emphasis and strengthen the single active path; do not add more permanent arrows.
- If a route crosses a non-endpoint component, fix deterministic routing; do not hide the relationship.
- If the Recovery Console becomes card-heavy, consolidate around diagnosis, execution, command, and action queue; do not delete evidence.
- If a proposal appears externally completed, correct the status copy and ledger schema before continuing.
- If pure-black structural boundaries are hard to see, increase white contrast before adding effects.
- If a change threatens causal provenance, owner gating, or existing API behavior, restore compatibility before proceeding.

## Stop Conditions

Success requires all acceptance checks, automated tests, visible-browser QA, screenshot records, latest server at port 4310, a committed implementation, and a clean worktree.

Stop and report only for a material scope conflict, required external credentials/authority, or three failed attempts at the same blocking issue.

## Self-review Against the Approved Direction

- Architecture is specified as a zero-gap, border-collapsed stepped stack with no connectors.
- Live uses colored, full-route activation plus sequential source/target acknowledgement.
- Recovery Console is explicitly a developer recovery surface rather than a generic agent graph.
- PR/Jira behavior is honest, ledger-governed, and non-mutating externally.
- Pure-black structural edges are high-contrast white.
- Existing evidence provenance, owner gate, deterministic replay, and backend boundaries are preserved.
- The design avoids a backend rewrite and introduces only the minimum safe-action schema needed by the requested controls.


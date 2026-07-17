# FlowPulse Incident Digital Twin redesign

Date: 2026-07-16
Status: approved for implementation

## Loop contract

Goal: replace the report-first dark cockpit with one light Incident Digital Twin canvas that supports Live, Replay, and Compare while preserving the current runtime, evidence, human gate, verification, and judge story.

Input scope:

- The standalone FlowPulse repository only.
- Existing `/api/state`, `/api/next`, `/api/reset`, `/api/approve`, and `/api/live` behavior.
- The captured Astronomy Shop incident, immutable SQLite ledger, and current evidence IDs.
- Native HTML, CSS, and JavaScript. No new runtime dependency.

Checks:

- Backend tests stay green.
- A pure client projection test proves deterministic stage reconstruction.
- The complete judge story remains reachable.
- Live, Replay, and Compare use the same node identities and layout.
- Target viewport checks cover 1440x900 and 1280x800.
- Browser console has no errors or warnings.

Feedback rules:

- Connector collision: fix deterministic routing, never hide the edge.
- Canvas clutter: move secondary facts into the drawer, never delete evidence.
- Unclear motion: bind it to a state transition or remove it.
- Lost fact or citation: restore it in the relevant drawer tab.
- API regression: restore compatibility before visual iteration.

Records:

- This spec and decision log.
- Client projection tests.
- Browser QA screenshots and acceptance notes under `docs/qa`.
- Final commit and clean worktree.

Stop: success requires all checks, screenshots, latest server on port 4310, a final visible browser page, committed changes, and a clean worktree. Stop early only for scope expansion, external authority, credentials, or three repeated failures on one blocker.

## Design read

This is a dense B2B developer tool for incident responders and competition judges. The visual language combines SpaceX-style mission clarity with the restraint of a large technology infrastructure product: large white operational space, strong black hierarchy, crisp geometry, one blue interaction accent, semantic amber/red/green state colors, and motion that explains data flow. It borrows the reference's discipline and confidence, not its assets, marketing composition, typography, or copy.

Design dials:

- Design variance: 4. Deterministic alignment matters more than expressive asymmetry.
- Motion intensity: 6. Repeated pulses and staged transitions communicate runtime state.
- Visual density: 7. The canvas stays primary while detail remains one selection away.

## Information architecture

The first viewport has four persistent regions:

1. A 56px product bar with FlowPulse identity, incident status, immutable event count, and optional Langfuse link.
2. A compact incident and mode bar with Live, Replay, Compare, severity, environment, stage, and primary actions.
3. A shared central canvas occupying about 65-75% of the viewport height and most of its width. A contextual drawer overlays the right side only when requested.
4. A bottom incident timeline with transport, stage markers, scrub, speed, and the current event annotation.

Dense evidence is progressive disclosure. Selecting a system node, dependency edge, timeline stage, or annotation opens the drawer. The old report columns do not appear by default.

## Mode state machine

```text
                    select Live
           +--------------------------+
           |                          v
       Replay <-------------------- Live
          |  select Replay             |
          |                            |
          +--------> Compare <---------+
                  select Compare
```

Mode changes never mutate the ledger.

### Live

- Shows the latest authoritative ledger projection.
- Labels itself `Last-known captured state` because no streaming collector is present.
- Healthy or recovered edges emit restrained repeated blue or green pulses.
- Incident edges retain semantic red when the latest state is unresolved.
- Timeline controls are read-only except refresh and mode switching.

### Replay

- Reconstructs the canvas from immutable event milestones.
- Client cursor can move backward through already available stages without ledger mutation.
- Advancing beyond available history requests the existing next runtime transition.
- Playback pauses at the owner gate. Only explicit approval can continue.
- Restart calls the existing reset endpoint, creating a new append-only run.

### Compare

- Uses the same node IDs, coordinates, connectors, and labels.
- The verified state is the base layer. The incident state is clipped from the left by an interactive range control.
- The handle exposes the percentage of incident versus recovered state.
- Before and after metric deltas stay visible in the contextual drawer.

## Timeline stages and event mapping

| Stage | Required ledger signal | Canvas meaning |
| --- | --- | --- |
| Healthy | `incident.opened` | Calm architecture before the captured change |
| Deploy | available with Propagate | Amber deployment change enters checkout |
| Propagate | `loop.symptoms_collected` | Checkout/payment failure propagates to Kafka consumers |
| Wrong hypothesis rejected | `evaluation.rejected` | Kafka claim is crossed out with score and counter-evidence |
| Root cause | `evaluation.accepted` | Checkout change and payment endpoint failure are cited |
| Owner gate | `approval.requested` | Checkout-only rollback waits for owner approval |
| Recover | `verification.completed` | Affected paths transition to verified green |
| Learn | `policy.evaluated` | Regression and candidate policy gates are recorded |

Deploy precedes propagation in incident time. The runtime may discover its evidence later; the UI marks the stage available only when authoritative history has reached propagation and never presents the change as a new ledger claim.

Timeline seeking is a pure function of the immutable event set plus cursor. Repeating a seek to the same stage must return the same node states, edge states, annotations, and metric snapshot.

## Stable component grammar

All components include a text label and a silhouette that does not depend on color:

- Client: browser-window rectangle with a top rail. Used by Frontend.
- Service/API: solid rectangle with explicit input/output ports. Used by Checkout and Payment.
- Stream/topic: parallel horizontal lanes with directional chevrons. Used by Kafka.
- Worker/compute: cut-corner process tile. Used by Accounting and Fraud.
- Database/ledger: cylinder. Used by the real FlowPulse append-only evidence ledger.
- Deployment/change: amber folded-corner ticket linked to Checkout.
- Agent: circular investigator node with an orbit mark.
- Evaluator: diamond decision node.
- Evidence: small cited records and the evidence ledger connection.

Every node is a keyboard-focusable button with an accessible name containing component type, label, and current state. Every dependency path is keyboard focusable and named by source and target.

## Deterministic canvas layout

The system uses a fixed rank layout in a 1000x520 logical canvas:

- Rank 0: Frontend.
- Rank 1: Checkout with Deployment above it.
- Rank 2: Payment above Kafka.
- Rank 3: Accounting and Fraud.
- Control plane: Investigator, Evaluator, and Evidence ledger aligned on the right.

Routes use fixed cubic paths. System paths remain behind nodes. Control-plane evidence routes use a separate lower lane. No random layout or force simulation is allowed.

## Motion semantics

- Healthy data movement: repeated blue dash pulses at 0.65-0.85 seconds per cycle.
- Deployment: one amber scale/opacity entry attached to Checkout.
- Failure: red state rings appear in captured order from Checkout to Payment, Kafka, Accounting, and Fraud.
- Evaluator rejection: a red causal annotation appears beside Kafka with the 22% score and counter-evidence.
- Replan: an amber annotation redirects attention upstream toward Checkout.
- Recovery: affected edges and status rings switch to green only when verification is present.
- Learning: evidence-ledger and evaluator connections become green when the regression and policy evaluation exist.

There is no glow, gradient, floating decoration, or motion without a state meaning. Under `prefers-reduced-motion: reduce`, pulses stop and all transitions become immediate.

## Data mapping

The client projection consumes only:

- `state.events` for stage availability, decisions, approval ordering, verification, and evolve state.
- `state.evidence` for citations and entity/kind detail.
- `state.topology` for real service nodes and dependencies.
- `state.repair`, `state.thresholds`, and incident metadata for bounded repair and recovery facts.

The component catalog adds only real FlowPulse control-plane nodes: Deployment record, Investigator, Evaluator, and the append-only evidence ledger. It does not add an unobserved production service.

## Contextual drawer

Drawer tabs preserve the existing information depth:

- Metrics
- Logs
- Traces
- Changes
- Evidence
- Agent
- Eval
- Repair
- Verify
- Evolve

Evidence tabs preserve IDs, source kind, entity, timestamp, fact, and payload. Agent/Eval tabs preserve claims, confidence, scores, reasons, counter-evidence, and citations. Repair/Verify/Evolve preserve boundary, approval, checks, regression, and all six promotion gates.

The drawer has a visible close button, focus-safe controls, no modal focus trap, and remains an overlay so the shared canvas geometry never relayouts.

## Error, loading, and empty states

- Initial API request: canvas skeleton lines and `Loading authoritative state` status.
- API error: persistent inline banner with Retry. Existing data remains visible when available.
- No evidence at selected stage: drawer states that evidence has not yet entered the ledger.
- Live unavailable: the GPT-5.6 action explains the missing key without disabling deterministic replay.
- Langfuse unavailable: label `Tracing not configured`; runtime functions normally.
- Owner gate: playback pauses and presents the existing bounded approval action.

## Accessibility

- White and light-neutral theme only for this pass.
- Body text meets WCAG AA; interactive focus uses a 2px blue outline with offset.
- Semantic buttons control modes, nodes, edges, tabs, markers, and transport.
- The range inputs have visible labels and current values.
- Status is never encoded only by color. Labels such as Healthy, Impact, Rejected, Approval required, Verified, and Eligible remain visible.
- `aria-live` announces stage, approval, recovery, and errors.
- SVG network layer has a descriptive accessible label; decorative pulse copies are hidden.
- Reduced-motion disables infinite animation and animated entry.

## Responsive behavior

At 1440x900 and 1280x800, the canvas remains above the timeline with all nodes inside its bounds. The drawer overlays at 380px rather than shrinking or moving nodes. At widths below 900px, the canvas becomes horizontally scrollable with a 980px logical minimum and the drawer becomes a full-width bottom sheet. The timeline markers become horizontally scrollable. No causal detail is removed.

## Acceptance tests

1. Live, Replay, and Compare use the same ten node IDs and deterministic coordinates.
2. Seeking any available stage twice returns deep-equal projection data.
3. Replay shows Kafka rejection before root-cause acceptance.
4. Playback stops at `approval.requested` and cannot execute repair without `approval.granted`.
5. Verification shows 99.98% payment reachability, 0.8% checkout errors, and Kafka lag 620.
6. Learn shows regression creation and all six policy gates.
7. Compare slider changes the incident clip from 0 to 100 without changing node positions.
8. Every system node and dependency is keyboard focusable and named.
9. Reduced-motion removes all infinite animation.
10. Browser console has zero errors and warnings at 1440x900 and 1280x800.
11. Representative screenshots cover Live, Propagation, Root Cause/Owner Gate, Recovery, and Compare.
12. Existing backend tests and focused projection tests pass.

## Decision log

- Keep native HTML/CSS/JavaScript. It is already sufficient and avoids a framework migration.
- Use one pure `twin-state.mjs` module for deterministic projection and Node tests.
- Use CSS/SVG dash animation rather than an animation dependency.
- Use fixed semantic layout rather than force-directed layout.
- Keep the drawer closed by default so the canvas is the hero.
- Treat Live as an honest last-known captured state until a streaming collector exists.
- Use client-side Compare layers because the backend already exposes the required verified facts.
- Interpret the SpaceX reference as mission-control hierarchy, decisive scale, high contrast, and restrained motion. Rebuild that language from original CSS/SVG inside FlowPulse without importing external visual assets.

## Self-review

- Placeholder scan: no unfinished marker or unresolved choice.
- Consistency: stage mapping, component grammar, motion, drawer data, and tests use the same authoritative inputs.
- Scope: no backend rewrite, vendor integration, credential need, production action, or imported asset.
- Ambiguity: Live is explicitly last-known, Compare is explicitly incident versus verified, and timeline seeking is explicitly bounded by available ledger history.
- Contract coverage: information architecture, mode state machine, visual grammar, animation, data mapping, errors, accessibility, acceptance tests, decision record, screenshots, and real-versus-captured behavior are specified.

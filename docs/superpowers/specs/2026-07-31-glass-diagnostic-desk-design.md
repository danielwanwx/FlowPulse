# FlowPulse Incident Glass Diagnostic Desk

**Status:** approved direction A with Staff text-review gate

**Scope:** Incident V3 presentation only. The workflow, projection, SSE,
metrics, graph evidence, and command API remain unchanged.

## Outcome

Incident becomes a sparse diagnosis desk rather than a report. It preserves
the six-stage, user-driven workflow, but the first screen answers only:

1. What is happening now?
2. What is the system / Agent checking now?
3. What can the engineer do now?

Everything else is opt-in.

## Layout

- A compact status strip shows only real values: severity, affected path,
  elapsed time, freshness, and current stage. Owner, revision, connector,
  and audit identifiers move to details.
- The six-stage rail remains, but it is visually thin and does not repeat the
  stage state in the header, hero, rail, and footer.
- The main surface is a glass diagnostic canvas with one primary stage card
  and at most two supporting cards. There is no permanent Agent sidebar.
- `Dataflow`, `Monitor`, and `Activity` are first-level tools. Details open in
  frosted modal/drawer surfaces rather than expanding into the canvas.
- The footer retains the durable workflow action (Next, Retry, Escalate,
  approval, or Complete) and does not repeat explanatory prose.

## Stage cards

Each stage displays only an approved, evidence-bound compact state:

| Stage | Canvas focus |
| --- | --- |
| Detect | Elevated Checkout-to-Payment error signal plus up to three live values |
| Triage | Affected path, fact count, and open-question count; scope is only shown as bounded after evidence confirms it |
| Investigate | Leading evidence path / confidence, query and activity counts, and direct Dataflow access |
| Decide | Recommended action and compact bounded-risk chip |
| Respond | Action title and real approval/execution state |
| Verify | Post-action observation countdown, healthy-sample count, and real health state |

No stage renders raw evidence, long lists, Agent reasoning, transcripts,
citations, revision/owner identifiers, rollback prose, or future-stage results
by default.

## Staff-reviewed text policy

The independent Staff reviewer approved this inline allowlist:

- `SEV-x`, affected path, duration, freshness, and current stage.
- One current-stage fact that is already evidenced, or the exact current
  action state.
- Up to three real metric values.
- Compact confidence, risk, approval, execution, observation, or health chips.
- `role · evidence count · state` for Agent activity.

Approved conditional templates:

- Detect: `Checkout → Payment error elevated`.
- Triage: `Affected path: Checkout → Payment · N facts · N open question`;
  otherwise `Scope under review`.
- Investigate: `Leading evidence path · NN%`; before a result, `Investigating
  Checkout → Payment`.
- Decide: `Recommended action: Restore Payment reachability · Risk: bounded`.
- Respond: `Restore Payment reachability · Approval required`, or real
  execution state.
- Verify: `Observing post-action telemetry · MM:SS left · N/3 healthy samples`.

The following must be user-opened only: summaries, citations, evidence IDs,
Agent reasoning/transcripts, detailed hypotheses, threshold explanations,
connector/owner/revision metadata, risk and rollback narratives, receipts,
unknowns, and all audit history. New inline prose requires another Staff
review before it is added.

## Dataflow and monitoring

`Dataflow` is available from every current stage where evidence-backed graph
data exists. Its large glass modal shows only server-projected nodes, edges,
and active pulses:

- red = affected evidence;
- green = fresh healthy evidence;
- gray = no recent traffic or stale data;
- a moving pulse = an active observed traffic pulse, never a browser-invented
  animation.

Selecting a node opens a compact Quick Peek with its actual state and current
metric. Explicitly asking the Agent to investigate remains a separate action.

`Monitor` opens a component/edge-focused time-series modal. It begins with the
selected impact path and three signals; full labels and threshold explanation
are available only inside that modal.

## Visual system and responsive behavior

- Reuse existing FlowPulse translucent surfaces, blur, border, shadow, font,
  icon, and motion tokens. No new dependency or component framework.
- Use proportional text for human decisions; reserve mono for compact values,
  time, and identifiers inside opened details.
- Restore the Diagnosis language: a soft system canvas behind layered frosted
  panes, rather than opaque report cards on a flat page.
- Fix the `641px–900px` layout collapse by explicitly retaining the V3 main
  grid there. The current global narrow rule changes `main` to block and
  leaves the Incident workspace at roughly 20px high.
- At narrow widths, panes stack and modals remain keyboard accessible; there
  is no page-level horizontal overflow.

## Minimal implementation boundary

Modify only the V3 Incident renderer/controller styles and their focused
tests. Do not change backend state machines, contracts, persistence,
authorization, or telemetry. Reuse the existing graph, metric series, modal,
focus-management, URL-restoration, and workflow-command paths.

## Acceptance

- The default canvas has no permanent long text or Agent transcript.
- A staff engineer can see the real current fault, freshness, and next action
  without scrolling.
- Graph and Monitor are prominent tools and show only real projection data.
- Graph node/edge colors change only with real graph/freshness evidence.
- The current V3 workflow, action gating, modal focus handling, and URL state
  keep working.
- The viewport between 641px and 900px no longer collapses the workbench.

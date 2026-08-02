# FlowPulse V3 Stage-Native Incident Workspace Design

**Date:** 2026-08-02  
**Status:** User-approved design, pending written-spec review  
**Branch:** `codex/agentic-realtime-incident-platform`

## 1. Problem

The current V3 workflow has the correct backend progression, but the Incident UI still behaves like one static report template. `Detect → Triage → Investigate → Decide → Respond → Verify` changes headings, counters, and small action cards while retaining essentially the same central composition.

This causes three concrete failures:

1. Clicking **Next** does not feel like starting a different engineering task.
2. The central Dataflow uses oversized triangular arrowheads and an arrow button that do not match the preserved Diagnose visual language.
3. The Agent Portal does not clearly communicate the distinct role, events, and required action for each stage.

The redesign must make each workflow stage an operational workspace while preserving one continuous Incident shell.

## 2. Product Principles

1. **One stage, one primary job.** The central workspace must visibly and functionally change after a successful Next transition.
2. **Shared continuity, not shared content.** Header, progress rail, Agent Rail, Live Vitals, and command bar remain stable. The stage workspace does not.
3. **Visual evidence before prose.** Graphs, signals, comparisons, progress, and state changes are primary. Long explanation, logs, and evidence IDs require explicit disclosure.
4. **Canonical facts only.** Every node, edge, metric, event, action, and state comes from V3 projection, series, receipts, or audit data.
5. **No future leakage.** A renderer reads the current stage and immutable history only. It must not publish future-stage conclusions.
6. **Historical Diagnose motion is reused, not imitated.** The proven path geometry and signal-projectile implementation are ported directly.

## 3. Selected Architecture

Use one shared Incident shell with six independently rendered stage workspaces.

### 3.1 Shared shell

The following elements remain mounted across stage transitions:

- Incident identity, severity, duration, freshness, owner, and attempt.
- Six-stage progress rail.
- Persistent desktop Agent Rail.
- Compact Live Vitals strip for Errors, Latency, and Traffic.
- Fixed Retry, Escalate, Next, approval, and completion command area.

The shell preserves case ID, attempt ID, selected stage, selected node or edge, Agent tab, and open detail panel across refresh and SSE rehydration.

### 3.2 Stage view boundary

Replace the single `operationsHomeMarkup` composition with a stage-view boundary:

```text
IncidentProjectionV3 + MetricSeriesV3 + UI state
                    |
                    v
          buildStageWorkspaceView(stage)
                    |
        +-----------+-----------+
        |                       |
        v                       v
stage-specific renderer    stage Agent Rail view
```

Each renderer owns its central layout, dominant visualization, stage summary, and stage-specific interaction. Shared shell components receive only the minimal derived view they need.

## 4. Stage Workspaces

### 4.1 Detect — Signal Board

**Primary job:** Understand what triggered the Incident and whether evidence is current enough to proceed.

The central workspace contains:

- Alert duration, first observed time, last sample, and freshness.
- Three primary signal cards: error, latency, and traffic.
- Connector health and the exact data source.
- Compact impacted-path preview using thin paths and a moving signal when a current pulse exists.
- Incident-creation readiness conditions and their pass or wait states.

The Agent Rail uses the **Observer** role and shows notification events:

- Alert created.
- First admitted failure sample.
- Impact path changed.
- Connector degraded or recovered.
- Detect is ready for Triage.

Detect does not show hypotheses, root cause, or repair recommendations.

### 4.2 Triage — Scope and Severity Map

**Primary job:** Bound impact and define the investigation question.

The central workspace contains:

- A compact scope map of affected user path and confirmed components.
- Current severity and the evidence that supports it.
- Modular counts and expandable lists for confirmed facts, unknowns, and questions.
- Correlation status for signals, traces, and admitted changes.
- A clear boundary between confirmed impact and unconfirmed adjacency.

The Agent Rail uses the **Observer** role and shows scope decisions:

- Severity assessment or revision.
- Fact confirmed.
- Unknown added or resolved.
- Investigation question created.
- Triage is ready for Investigate.

Triage does not present a root-cause graph or repair plan.

### 4.3 Investigate — Diagnosis Graph

**Primary job:** Test hypotheses against evidence and counter-evidence.

This is the only stage whose central workspace is the full historical-style Diagnose graph. It contains:

- Evidence-backed service, stream, change, hypothesis, and control nodes.
- Thin causal paths without arrowheads.
- Short moving signal projectiles that communicate direction.
- A hypothesis list with confidence, supporting evidence, and falsification condition.
- Evidence Worker query status and Critic verdict.
- At most one explicit replan indicator.

The Agent Rail uses **Investigator** and **Critic** events:

- Evidence query started or completed.
- Hypothesis created, promoted, weakened, or rejected.
- Counter-evidence found.
- Critic coverage check passed or failed.
- Replan occurred.
- Investigation is ready for Decide.

Clicking a graph node changes the Agent Rail context. It does not create a new task. A separate **Investigate this node** command is required to start additional work.

### 4.4 Decide — Decision Matrix

**Primary job:** Compare bounded response options without executing anything.

The central workspace contains:

- Leading root cause and supporting evidence summary.
- Candidate actions shown as comparable rows or columns.
- Dry-run result.
- Blast radius, risk, rollback method, and verification conditions.
- Selected recommendation and `decision_revision`.
- Revalidation state when premises have changed.

The Agent Rail uses the **Evaluator** role and shows decision events:

- Candidate admitted or rejected.
- Dry run completed.
- Risk or blast-radius check changed.
- Recommendation selected.
- Revalidation required.

Decide never performs the mutation.

### 4.5 Respond — Execution Console

**Primary job:** Approve and observe the real allowlisted action.

The central workspace contains:

- Exact feature flag, component, command, and mutation targets.
- Before-state and expected after-state.
- Independent Approve or Reject control.
- Ordered execution steps with live state.
- Receipt ID, start and finish time, result, and rollback status.

The Agent Rail uses the **Executor** role and shows execution events:

- Approval requested, approved, or rejected.
- Revision mismatch.
- Flag mutation started or completed.
- Checkout recreation started or completed.
- Receipt persisted.
- Execution failed or rollback started.

Next remains disabled until a successful immutable execution receipt exists.

### 4.6 Verify — Before/After Monitor

**Primary job:** Confirm recovery using only post-action evidence.

The central workspace contains:

- Before and after Errors, Latency, and Traffic comparisons.
- A new Checkout-to-Payment trace indicator.
- Recovered dependency graph using the same real graph identity.
- Observation-window countdown while running.
- Verification conditions and pass or fail state.
- Rollback or `NEEDS_HUMAN` result when recovery fails.

The Agent Rail uses the **Verifier** role and shows recovery events:

- Fresh post-action trace observed.
- Healthy sample admitted.
- Verification condition passed or failed.
- Observation window completed.
- Rollback started, succeeded, or failed.
- Incident is ready to complete.

When Verify succeeds, the workspace says **Recovery confirmed** and shows recovery-signal counts. It must not continue to say that it is waiting for samples.

## 5. Historical Diagnose Path and Motion Reuse

The new Investigate graph must reuse the historical implementation from the preserved Diagnose branch rather than recreating a similar animation.

### 5.1 Source baseline

Use the implementation preserved around `f20c484` and `a2f51b9`:

- Historical graph assembly: `incidentFocusLayerMarkup` and its canonical path data.
- Historical SVG edge group: `edge-line`, `signal-projectile-halo`, `signal-projectile-core`, and `edge-hit`.
- Historical signal timing and activation logic near the signal-projectile animation code.
- Historical CSS for `.signal-projectile`, halo/core widths and opacity, incident impact tone, verified tone, and reduced-motion handling.

The key SVG contract is:

```html
<g class="edge-group ...">
  <path class="edge-line ..." d="..." />
  <path class="signal-projectile signal-projectile-halo" d="..." />
  <path class="signal-projectile signal-projectile-core" d="..." />
  <path class="edge-hit" d="..." />
</g>
```

### 5.2 Required behavior

- No `marker-end` arrowhead.
- No triangular pulse.
- No circular arrow button placed over the edge.
- Base edge width remains visually thin.
- Direction is shown by the short moving halo/core projectile.
- Affected paths use the historical red treatment.
- Verified paths use the historical green treatment.
- Stale paths are dashed and do not animate.
- Reduced-motion disables projectile movement while preserving the edge state.

### 5.3 Adaptation boundary

Do not cherry-pick the old page or restore legacy state ownership. Port only the bounded graph renderer, path geometry helpers, projectile activation logic, and matching CSS. Node, edge, pulse, status, timing, evidence, and selection come from the V3 canonical projection and current UI state.

## 6. Persistent Agent Rail

### 6.1 Desktop behavior

The Agent Rail is always visible on desktop. Its container does not remount during Next. The role, event list, context, and required action update with the stage.

### 6.2 Mobile behavior

At constrained widths, the Agent Rail becomes a single stage-aware button and opens as a drawer. Closing it restores focus to the trigger.

### 6.3 Information density

The default view shows at most four actionable events. Each event contains:

- Short event title.
- One-line factual result.
- State and time.
- Evidence count when relevant.

Full Agent reasoning, long summaries, raw logs, and evidence IDs are hidden behind explicit Activity, Evidence, Logs, or Details disclosures.

### 6.4 Context binding

Ask Agent requests bind to:

- Case ID.
- Attempt ID.
- Current stage and stage-run ID.
- Workflow revision.
- Selected component or edge.
- Current evidence revision.

## 7. Live Vitals Continuity Strip

Errors, Latency, and Traffic remain visible as a compact strip across all stages. The strip provides continuous incident context but never displaces the stage workspace.

- Detect and Verify may promote the same series into larger stage-specific charts.
- Other stages keep only compact current value, trend, freshness, and sparkline.
- Clicking a vital opens the Observability detail panel.
- Missing or stale series show an explicit missing or stale state.

## 8. Failure and Staleness Behavior

- A failed stage retains its stage-specific workspace and all admitted data.
- Failure appears in context with Retry, supplement-evidence, and Escalate actions.
- The UI never replaces a failed stage with a generic report page.
- Connector staleness freezes the last real sample and marks the timestamp and connector state.
- Expired pulses stop moving and cannot keep a dependency visually active.
- Agent failure appears as a failed event in the stage Agent Rail; no simulated conclusion is substituted.
- SSE gaps trigger canonical rehydration without changing the visible stage.
- Future-stage renderers remain unmounted and cannot expose future output.

## 9. Responsive and Accessibility Contract

- Desktop uses central workspace plus persistent Agent Rail.
- Tablet may place Agent Rail below the main workspace while retaining stage identity.
- `451×859` uses a drawer for Agent content and a horizontally scrollable stage rail inside its own container.
- No page-level horizontal overflow.
- Modal and drawer focus is trapped and restored.
- Graph nodes and edge hit targets are keyboard accessible.
- Reduced-motion disables signal projectile animation.
- Color is never the sole status indicator.

## 10. Verification Plan

### 10.1 Renderer tests

For each stage, cover `READY`, `RUNNING`, `SUCCEEDED`, and `FAILED` or `NEEDS_HUMAN` where applicable.

Assertions include:

- Stage-specific structural signature is present.
- Other stage workspace signatures are absent.
- Future output is absent.
- Agent role and events match the stage-run ID.
- Live Vitals remain real, current, stale, or explicitly missing.

### 10.2 Historical animation parity tests

- Path output uses the ported geometry helper.
- Edge SVG contains line, halo, core, and hit paths.
- No marker arrowhead or arrow overlay button exists.
- Active pulse toggles the historical projectile class.
- Stale and reduced-motion states disable movement.
- Affected and verified tones match the historical CSS contract.

### 10.3 Browser QA

Run one real Astronomy Shop Incident through all six stages and capture:

- Detect signal board and notification feed.
- Triage scope map and scope decisions.
- Investigate historical-style Diagnose graph and Investigator/Critic feed.
- Decide matrix and Evaluator decision events.
- Respond approval, execution progress, and receipt.
- Verify before/after monitor, recovered graph, and completion state.

Also test Dataflow node selection, Ask Agent context, Activity, Evidence, Observability, refresh restoration, SSE reconnect, desktop, and `451×859`.

## 11. Non-Goals

- No new production-hardening layer.
- No new frontend framework or chart dependency.
- No migration back to the legacy replay state machine.
- No fake Grafana panel or invented historical retention.
- No backend schema expansion unless a required stage fact is genuinely absent from the current V3 contract.
- No change to Temporal advance, approval, receipt, rollback, or audit authority.

## 12. Acceptance Criteria

The redesign is complete only when:

1. Next visibly starts a different engineering task and central workspace.
2. Investigate matches the preserved Diagnose path and signal animation behavior.
3. No arrowhead, triangular pulse, or edge arrow button remains.
4. Each stage has a distinct Agent role and factual event feed.
5. Live Vitals remain compact and continuously update from real series.
6. A real Incident can complete Detect through Verify without future-stage leakage or report-wall regression.


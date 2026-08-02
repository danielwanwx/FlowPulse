# FlowPulse Incident Control Hierarchy and Diagnose Graph Reuse

**Date:** 2026-08-02  
**Status:** User-approved design, pending written-spec review

## 1. Problem

The current Incident workspace has four connected usability failures:

1. Detect renders the same signal metrics twice through `Signals` and `Live Vitals`.
2. SSE and clock-driven full renders replace the scroll container and return the user to the top of the stage.
3. Titles and permanent explanatory copy sound generated rather than operational.
4. Navigation, state, metadata, filters, and commands all use similar pill controls, so the primary action is unclear.

The current V3 Dataflow is also only an approximation of the historical Diagnose graph. Similar colors and projectiles are insufficient: its layout and curve generation differ from the accepted interface.

## 2. Comparator Findings

The interaction model follows patterns documented by mature incident and observability products:

- PagerDuty promotes only current lifecycle actions such as Acknowledge and Resolve. Less common operations live under `More`.
- Grafana IRM separates current response commands from classification labels and uses an `Actions` menu for secondary operations.
- Datadog separates incident information into stable views such as Overview, Timeline, and Notifications.
- Grafana labels are metadata used for routing and filtering, not feature navigation.
- Grafana, Datadog, and New Relic keep panel titles short and place interpretation help in descriptions or tooltips instead of permanent dashboard prose.

FlowPulse will use the same hierarchy without copying a competitor's visual styling.

## 3. Control Hierarchy

### 3.1 Primary command

Only one command receives primary visual emphasis:

| Stage | Primary command |
| --- | --- |
| Detect | Next |
| Triage | Next |
| Investigate | Next |
| Decide | Next |
| Respond | Approve or Execute, according to backend state |
| Verify | Complete |

`Retry` appears directly only when the current stage fails. `Escalate`, `Rerun`, historical audit, and other low-frequency operations move to a `More` menu. Next never substitutes for approval.

### 3.2 View tools

The global incident header exposes at most three quiet text tools:

- `Dependencies`
- `Metrics`
- `Activity`

They are view navigation, not feature tags. They use one neutral style and an active state only when the corresponding panel is open.

### 3.3 Status and metadata

Pill or badge styling is reserved for compact state:

- severity;
- workflow or stage status;
- freshness;
- service and environment metadata where filtering or identification requires them.

Feature names, evidence counts, readiness explanations, and panel navigation must not appear as decorative tags.

## 4. Naming Contract

Use direct operational nouns:

| Current label | Approved label |
| --- | --- |
| Signal Board | Signals |
| Live Vitals | Metrics |
| Live impact flow / Dataflow | Dependencies |
| Scope / Severity | Impact |
| Diagnosis Graph | Diagnosis |
| Decision Matrix | Plan |
| Execution Console | Execution |
| Before / After Monitor | Verification |
| Agent Rail | Activity |

Stage names in the workflow rail remain `Detect`, `Triage`, `Investigate`, `Decide`, `Respond`, and `Verify` because they describe the durable backend workflow.

Titles state the object or task. They do not ask rhetorical questions or explain the product. Remove permanent copy such as:

- “What triggered this Incident?”
- “Only admitted Errors, Latency, Traffic, and connector state are shown.”
- “Test hypotheses against evidence.”
- “Direction is the historical Diagnose path...”

Necessary interpretation, thresholds, caveats, and provenance move to an accessible tooltip, Details disclosure, or the relevant panel.

Empty states use the shortest factual form, for example `No activity yet`, `No trace observed`, or `No candidate available`.

## 5. Detect Composition

Detect contains one signal presentation only:

1. compact incident identity and stage rail;
2. one `Signals` panel with error rate, latency, and traffic;
3. alert duration, first sample, latest sample, and source health;
4. compact `Dependencies` preview;
5. stage command area.

The shared Metrics strip is omitted in Detect because its content would duplicate Signals. Triage through Respond use the compact Metrics strip for continuity. Verify owns a stage-specific before/after comparison and therefore also omits a duplicate shared strip.

## 6. Original Diagnose Graph as the Single Implementation

### 6.1 Required reuse

Investigate and every Dependencies modal use the exact historical Diagnose graph implementation:

- the same graph membership and canonical node identities;
- the same node layout;
- the same curve and route geometry;
- the same edge grouping;
- the same signal projectile activation and timing;
- the same affected, stale, and recovered treatments;
- the same selection hit targets and keyboard behavior.

The accepted baseline is the historical `incidentFocusLayerMarkup` implementation and its supporting helpers/CSS around commits `f20c484` and `a2f51b9`.

### 6.2 Shared module boundary

Extract the bounded Diagnose graph renderer into one shared module. Both the historical Diagnose surface and V3 consume that module. Do not copy the renderer into V3 and do not keep a V3-specific substitute.

The shared module owns presentation only. V3 continues to supply canonical nodes, edges, pulse state, freshness, evidence identity, and selection from `IncidentProjectionV3`. It does not restore the old workflow or state machine.

### 6.3 Removal

Delete the V3-specific geometry and animation paths that compete with the shared renderer. No fallback approximation is shown when canonical graph input is missing; the UI displays a compact unavailable state instead.

## 7. Activity Panel

The desktop panel title is `Activity`. The current role may appear as quiet metadata, for example `Observer · Detect`, rather than as a second large heading.

The default view contains at most four current-stage events. `Activity` and `Evidence` remain ordinary tabs, not colored pills. Long output, logs, IDs, and explanations stay behind disclosure.

The mobile Activity drawer follows the same content hierarchy.

## 8. Scroll Stability

The controller must preserve scroll state across non-navigational renders.

Before replacing markup, capture scroll positions for stable, explicitly marked containers:

- the main stage surface;
- Activity events/body;
- any open detail panel.

After rendering, restore each existing container's scroll position. Clock ticks, SSE connection updates, projection refreshes, and command pending-state renders must not move focus or scroll.

Intentional navigation may reset position:

- selecting a different stage;
- opening a modal or drawer;
- closing a modal and restoring its trigger;
- explicitly selecting a graph node whose detail must become visible.

No global window-scroll workaround is added; only the actual local scroll owners are preserved.

## 9. Responsive Behavior

- Desktop keeps the main stage and Activity panel side by side.
- Tablet may stack Activity below the stage without turning every view control into a pill.
- At `451×859`, Activity remains a closed drawer trigger until requested.
- The command bar contains one primary command and one `More` menu; it must not become a horizontally scrolling tag row.

## 10. Verification

Automated coverage must assert:

1. Detect emits the signal cards once and does not render the shared Metrics strip.
2. Verify does not render a second shared Metrics strip.
3. Triage through Respond retain the compact Metrics strip.
4. Deprecated generated titles and permanent explanatory sentences are absent.
5. Only approved metadata receives badge styling.
6. Secondary commands are reachable through `More`; failure makes Retry directly available.
7. Diagnose and V3 render through the same shared graph function.
8. V3-specific substitute geometry and animation are absent.
9. SSE, clock, and refresh renders preserve every marked scroll position.
10. Intentional stage navigation and modal focus behavior remain correct.

Browser acceptance covers Detect, Investigate, Dependencies modal, Activity, one stage transition, an SSE update while scrolled, desktop, and `451×859`.

## 11. Non-Goals

- No backend workflow or schema changes.
- No new chart or UI dependency.
- No new design system.
- No restoration of the historical Diagnose workflow state machine.
- No new labels or feature buttons for future capabilities.

## 12. Acceptance Criteria

The change is accepted when:

1. Detect has no repeated metrics panel.
2. Passive realtime updates never return the user to Signals.
3. The interface uses short operational nouns and minimal permanent prose.
4. A responder can identify the single primary action immediately.
5. Feature navigation, state, metadata, and commands have visibly different roles.
6. Investigate and every Dependencies modal render the original Diagnose graph from the same implementation.

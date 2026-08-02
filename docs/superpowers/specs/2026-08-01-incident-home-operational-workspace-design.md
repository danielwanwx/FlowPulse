# Incident Home Operational Workspace

## Purpose

Replace the report-like Incident landing page with a stage-oriented operating
workspace. A staff engineer must immediately see the active failure, its impact,
the current workflow stage, and the freshest evidence without reading a wall of
AI-generated prose.

## Scope

This spec covers the Incident home and its real-data validation path. It keeps
the existing `Detect → Triage → Investigate → Decide → Respond → Verify` state
machine and the right-side Agent Portal. It does not add production integrations,
new alert sources, or fake telemetry.

## Information architecture

The home uses the selected **C: work-state-first** composition:

1. A compact header shows severity, elapsed duration, data freshness, owner,
   and the six-stage rail. It never duplicates a narrative incident report.
2. The primary left workspace presents the current stage and a Diagnosis-style
   live impact flow. Nodes such as Checkout, Payment, and Orders are sourced
   from the current projection's topology and traces. Affected nodes use red;
   recovered/healthy nodes use green; a pulse represents observed propagation.
3. Four compact metric cards directly below or alongside the flow show only
   real error rate, latency, traffic, and dependency health samples. Each card
   can open its detail view; it never invents points or trends.
4. The floating right Agent Portal shows the current operation, new evidence,
   and next human action. Long explanations remain collapsed behind explicit
   detail affordances.
5. Diagnostic Graph, component logs/traces, activity, monitoring, and
   PD/Grafana open as focused drawer or modal surfaces. They are not squeezed
   into the default home view. A Grafana/PD panel renders live connector data
   when available and a clear unavailable state plus retry/deep-link otherwise.

## Interaction model

The workspace keeps a stable shell while the main stage area changes. Users can
click a flow node for a small evidence preview, then explicitly open the full
diagnostic graph or ask the agent to investigate that component. Selecting a
completed stage is read-only; a rerun is explicit. Future stages remain locked.
`Next` advances the persisted workflow only after the current stage succeeds.

The application restores case ID, stage, selected component, open panel, and
Agent Portal tab after refresh or SSE reconnect. Data is marked stale when the
connector has no recent sample; the UI does not silently substitute a mock state.

## Data contract and failure behavior

Live and Incident resolve the same V3 case/projection, component states,
freshness, and impact path. Astronomy Shop's `paymentUnreachable` is the local
test incident. OTel/Prometheus samples, trace evidence, and persisted projection
events are the only inputs to the graph and metric cards.

If the control plane or a connector is unavailable, the page explicitly shows
the unavailable/stale state and preserves the affected controls for retry. It
must not claim a working Incident, generate synthetic charts, or expose later
workflow results.

## Validation and screenshot review

Once a real case exists, manually exercise and capture: Incident home, component
peek, Agent Portal, Activity, Monitor, Dataflow/Diagnostic Graph, PD/Grafana
panel, each workflow stage, approval, and Verify. Review each capture for
overflow, clipping, icon alignment, typography, spacing, meaningful labels,
modal focus/scroll behavior, stale indicators, stage locks, refresh recovery,
and correspondence with the Live page.

The acceptance outcome is a real `paymentUnreachable` case whose changing
telemetry is visible in both Live and Incident, whose stage workflow is
operable end-to-end, and whose home makes the failure and current human/agent
work legible at a glance.

## Non-goals

- No random, sinusoidal, or frontend-generated metrics.
- No all-stage report view or permanently expanded AI prose.
- No production credentials, production repair, or destructive database reset.

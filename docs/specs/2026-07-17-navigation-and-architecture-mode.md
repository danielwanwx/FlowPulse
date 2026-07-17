# FlowPulse navigation and architecture-mode refinement

**Status:** approved implementation boundary
**Date:** 2026-07-17

## Goal

Reduce the first-viewport cognitive load and make the default product state explain the observed technical architecture before the user enters live runtime activity or incident diagnosis.

The change is frontend-only. Existing APIs, incident facts, evidence IDs, replay ordering, owner approval, verification, regression, and Evolve behavior remain authoritative and unchanged.

## Input scope

- Existing `public/index.html`, `public/app.js`, `public/styles.css`, and `public/twin-state.mjs`.
- Existing `/api/state` and `/api/development/status` responses.
- Real or captured OpenTelemetry topology already exposed as `state.source.topology`.
- Existing captured Astronomy Shop incident graph when a live topology is unavailable.

No new dependency, backend endpoint, telemetry vendor, credential, or asset is permitted.

## Information architecture

### Application bar

The persistent application bar exposes only:

1. FlowPulse identity.
2. Current environment.
3. Concise source/mode status.
4. Theme switch.
5. One overflow menu.

`Production workspace`, the four always-visible global navigation buttons, tracing configuration text, and immutable-event count leave the primary bar. They remain reachable inside the overflow menu or run drawer.

### Context bar

The second row contains:

- one dynamic page title;
- the four-mode switch;
- one compact current-state readout;
- at most one contextual development action.

Long explanatory copy and duplicate labels are removed from the default viewport.

### Canvas toolbar

The toolbar contains the current canvas title, a short source-accurate caption, and three key metrics. The entity legend becomes an on-demand native disclosure.

## Mode state machine

The product-level modes are:

1. `Architecture` — default state.
2. `Live` — observed runtime activity from the current source.
3. `Diagnose` — the existing deterministic incident replay, internally retaining the current `replay` identifier for compatibility.
4. `Compare` — the existing incident-versus-verified comparison.

Transitions:

```text
Architecture <-> Live
Architecture <-> Diagnose
Live <-> Diagnose
Diagnose -> Compare after verification
Compare -> Architecture | Live | Diagnose
```

Architecture and Live hide the incident timeline. Diagnose and Compare expose it. Consequential repair still pauses at the existing Owner gate.

## Architecture canvas

Architecture uses `state.source.topology` when authoritative OTLP topology exists. If it does not, the canvas uses the evidence-backed captured incident components and labels the source honestly; it never invents services.

Source nodes are placed deterministically into four semantic layers:

1. Experience and entry.
2. Commerce services.
3. Async, payment, and risk processing.
4. Platform, configuration, observability, and data.

Layer membership is based on known Astronomy Shop component identity, followed by a deterministic fallback for unknown services. Each row has bounded spacing and stable ordering.

## Live and Diagnose transition semantics

Architecture and Live render the same source node identities. Diagnose reuses the same stable IDs for the overlapping incident components. On mode change:

- matching nodes use a FLIP-style position animation;
- new nodes fade into their target role;
- new connectors fade in after node motion begins;
- the transition lasts about 520ms with a restrained ease-out curve;
- there is no random relayout, zoom, glow, or decorative motion;
- `prefers-reduced-motion` skips interpolation and renders the target state immediately.

The graph is replaced only after positions are captured, so the animation does not create a second source of layout truth.

## Data mapping

| UI state | Authority | Canvas data |
| --- | --- | --- |
| Architecture | current source projection | `state.source.topology`, or captured runtime subset when unavailable |
| Live | current source projection | `state.source.topology`, source freshness, hashed evidence counts |
| Diagnose | append-only incident ledger | existing `frameFor(cursor)` and incident topology |
| Compare | append-only incident ledger | existing incident and verified frames |

Metrics in Architecture and Live show observed service count, dependency count or trace volume, and source freshness. Diagnose and Compare preserve their existing incident metrics.

## Error and empty states

- Disconnected source: show the existing honest empty state and direct the user to connect the pinned runtime or use Diagnose.
- Stale source: retain the captured topology, label it as last-known/captured, and do not imply streaming.
- Compare before verification: retain the existing blocking message.
- Missing optional Langfuse configuration: show only inside the overflow menu and do not affect runtime behavior.

## Accessibility

- Four mode buttons retain `aria-pressed` and explicit names.
- The overflow menu and legend use native `details`/`summary` semantics.
- Icon-only theme and menu controls retain descriptive accessible names.
- Architecture layer labels are present visually but not repeated by every node.
- Node accessible names retain kind, source, and state.
- Keyboard selection and drawer access remain unchanged.
- Reduced-motion behavior is deterministic and immediate.

## Checks

- Default mode is Architecture.
- Architecture, Live, Diagnose, and Compare work on the shared canvas.
- The same topology produces identical Architecture coordinates across repeated renders.
- Architecture-to-Live retains matching node IDs.
- Architecture-to-Diagnose animates shared incident components and introduces control-plane nodes without overlap.
- The top application bar has no horizontal overflow at 1440x900 or 1280x800.
- The visible top-level controls are limited to the four modes, theme, overflow, and one contextual action.
- Tracing state, immutable event count, navigation, Run GPT, and Inspect run remain reachable from the overflow menu.
- The incident timeline is hidden in Architecture/Live and complete in Diagnose/Compare.
- Existing backend and deterministic replay tests remain green.
- Browser console contains zero errors and warnings.

## Feedback rules

- Node overlap -> adjust deterministic row capacity and spacing; do not hide observed components.
- Transition feels decorative -> shorten it or remove secondary fades; preserve identity movement only.
- Information becomes unreachable -> restore it to the overflow menu or contextual drawer, not the primary bar.
- Source cannot prove a service -> omit it or label the captured fallback; never synthesize telemetry.
- Replay, approval, or evidence behavior regresses -> restore compatibility before visual refinement.

## Records and stop conditions

Record changed files, automated tests, target-viewport browser checks, console results, representative Architecture and Diagnose screenshots, and the real-versus-captured boundary.

Success requires all checks to pass, the latest server to run on port 4310, the final page to remain open, the implementation to be committed, and the worktree to be clean.

Stop only for a backend redesign requirement, missing external authority, or three failed attempts at the same blocking issue.

## Self-review

- The design removes information from the primary viewport without deleting access.
- Architecture is a real source projection, not a new mock dataset.
- Replay remains compatible through the existing internal `replay` mode identifier.
- Animation has deterministic identity and reduced-motion behavior.
- Scope is limited to the approved frontend refinement.
- No placeholders, unresolved product choices, or new dependencies remain.

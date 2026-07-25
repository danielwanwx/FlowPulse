# Incident Focus Workspaces Design

## Goal and scope

This checkpoint restores a clear incident narrative to Diagnose, Recovery Console, and Compare without changing FlowPulse's backend truth contract. Architecture and Live remain complete, backend-owned canonical topology views. The three incident workspaces instead render one bounded incident-focus projection from the same immutable run so an engineer can follow the exact causal path through diagnosis, recovery, and verification.

This is a preserve-mode redesign for a technical B2B operations product: visual variance 4/10, motion intensity 5/10, information density 5/10. It retains the accepted cold-gray field, soft white glass surfaces, rounded geometry, compact Team rail, system typography, and restrained blue accent.

In scope:

- Diagnose, Recovery Console, and Compare presentation adapters.
- A shared pure incident-focus projection/layout helper, focused tests, and CSS needed for the three focused canvases.
- Deterministic path/node entrance and projected-flow motion.

Out of scope:

- Backend/API/fixture changes, new mock data, a static legacy replay frame, agent behavior, authority, metrics generation, Architecture or Live topology membership, a second Control System overlay, and a wider page redesign.

## Truth and identity contract

`sharedRunReadModel` remains the only browser source for canonical run state. Every focused workspace must bind and expose the same server-owned `run_id`, `incident_id`, and `projection_revision`; canonical node and edge IDs are never recreated from labels or DOM positions.

The focus membership comes solely from the strict server-projected Diagnose overlay and is valid only when all of the following agree with the selected canonical topology:

- `overlay.node_ids` are exactly the backend affected node IDs;
- `overlay.edges` are exactly the backend affected relations, including relation kind and endpoint IDs;
- the overlay and runtime-data graph match the run, incident, revision, and canonical node/edge identity sets;
- any external change record is rendered only if it is already server-projected, references focused canonical node IDs, and has bounded provenance references.

The browser does not infer additional affected components from labels, graph adjacency, status color, or a static six-node map. A missing or mismatched focus projection is unavailable: the canvas shows a concise, human-readable waiting/error state and renders no substitute graph.

## Shared focus projection and layout

The implementation introduces one pure `incidentFocusWorkspace` seam. It receives a validated canonical topology, a server snapshot, and the validated Diagnose overlay. It returns either an unavailable reason or:

- stable run/incident/revision/source identity;
- the ordered focus node IDs and affected relation IDs exactly as supplied by the backend;
- only focus nodes and relations, plus an optional bounded change-evidence record;
- canonical status and at most one decision-useful, backend-sourced metric per node;
- one deterministic coordinate map and one port-aware cubic Bezier path per relation.

Positions are calculated from canonical source-node coordinates and normalized into a fixed spacious focus canvas. The helper preserves ordering and relative direction without reading rendered DOM. It keeps card bounds inside the usable canvas and derives explicit source/destination ports from their relative positions. All three workspaces consume this same output, so nodes and curves stay spatially continuous.

No focus node may display generic filler such as `failure observed`, duplicate status prose, a run ID, an incident ID, a revision, or provenance implementation labels. It displays its name, one readable state, and only one safe metric when the server snapshot supplies a decision-useful value. Missing metrics are omitted.

## Workspace information models

### Diagnose

Diagnose always selects the immutable incident snapshot, even after the run's current snapshot is recovered. This truthfully shows the incident under investigation rather than claiming the system is presently failing.

The main canvas contains only the backend focus projection: expected affected nodes/relations and optional evidence-grounded change record. Soft red emphasizes proven fault/impact paths. At most four KPI values, the server-projected diagnosis state, and concise cited evidence stay visible. The existing right Team rail remains the only context/agent surface. The timeline stays compact.

### Recovery Console

Recovery uses the same focus node coordinates and curves as Diagnose. It overlays recorded proposal, Owner Gate, execution, and independent-verification facts in the existing workflow presentation; absent facts remain visibly awaiting server evidence. It never creates a fictional successful repair or a second chat/control panel.

### Compare

Compare is available only if server verification passed. It reuses the same focus geometry for incident and verified snapshots. Its divider changes the recorded snapshot emphasis instead of spawning a second legacy frame. Human-visible timeline labels describe product events while the underlying event identity remains unchanged.

## Motion and interaction

Switching among incident workspaces is deterministic and lasts 450–650 ms. Focus nodes enter/morph at their shared coordinates, then paths draw/fade in by causal order. A small luminous packet follows the affected SVG curve using the existing requestAnimationFrame and SVG path-length mechanism; it depicts projected flow only and does not create metrics or advance lifecycle state.

`prefers-reduced-motion` presents the completed snapshot without pulse/path animation. A node click retains the existing safe inspector and Team rail behavior; it must not remount the canvas or restart unrelated Live pulses. The rail retains its established gutter and never obscures the focus canvas.

## Failure behavior, accessibility, and performance

Strict validation happens before layout. Unknown schema keys, mismatched run identity, invalid endpoints, extra focus membership, malformed metrics, and missing required overlay data fail closed. Empty state copy explains that the matching backend incident projection is unavailable, without mock content.

Focus cards and paths retain keyboard semantics, textual accessible names for status/metric, visible focus, and contrast-safe fault emphasis. Motion is limited to opacity, transform, SVG stroke, and path packet position. One small SVG focus graph avoids layout-thrashing or timer-driven state.

## Verification loop

Inputs: strict canonical topology, selected immutable snapshot, Diagnose overlay, recovery/verification server facts, and the existing unified Team rail.

Loop:

1. Add tests for exact server focus membership, shared geometry/run binding, fail-closed invalid input, concise node copy, full Architecture/Live membership, and no static fallback.
2. Implement the pure focus projection/layout helper and make Diagnose, Recovery, and Compare consume it.
3. Verify a fresh one-port run at 1600×900: incident Diagnose, Recovery, and verified Compare have matching IDs/geometry, fitted curves, no rail overlap, and no console errors.
4. Run focused tests, `git diff --check`, and the full suite. Stop and report any truth-contract or test failure rather than weakening validation.

Rollback rule: if a workspace lacks the matching focus projection, retain its concise unavailable canvas and do not fall back to a full topology, old replay frame, or browser-owned relation set.

## Acceptance criteria

- Architecture and Live still render the complete canonical topology; no focused filtering leaks into those views.
- Diagnose, Recovery, and Compare each render exactly the server focus node/relation IDs, bind the same run/incident/revision, and use one shared geometry.
- Diagnose is incident-focused when current run state is recovered; Recovery and Compare show only their corresponding server snapshots/facts.
- All focus curve endpoints meet the selected card ports, no node/edge/rail clips at 1600×900, and fault emphasis is restrained.
- No mock fallback, generic duplicate failure text, raw logs, IDs, revisions, or invented metrics appears.
- Reduced motion is static, console is clean, focused and full tests remain green.

## Reviewable commits

1. This approved design specification only.
2. Tests plus shared focus projection/layout and the three workspace adapters, with browser screenshots and test evidence. The branch stops for owner review after this implementation commit and is not merged automatically.

# Architecture visual polish design

**Status:** Owner-approved design checkpoint, implementation not yet authorized

**Branch baseline:** `codex/frontend-architecture-polish` at `890489d8acf1b861905317acab6d0c6c81ff5148`
**Scope:** Architecture view only, light theme only

## Purpose

FlowPulse Architecture should read as a finished technical operations surface: an engineer can distinguish the monitored system from FlowPulse itself, understand the relevant topology at a glance, and inspect a projected component without mistaking the page for an editable diagram or a generic card dashboard.

This is redesign-preserve work. The existing information architecture, read-only backend contract, topology counts, lifecycle behavior, theme toggle behavior, keyboard selection, and detail drawer remain intact. The visual language is refined; no new authority or product workflow is introduced.

## Locked design dials

| Dial | Decision |
| --- | --- |
| Design variance | 5/10, a meaningful polish of the existing surface rather than a visual reinvention |
| Motion intensity | 4/10, only stateful signal and feedback motion |
| Visual density | 7/10, substantial information at the default desktop view without microscopic type |
| Checkpoint theme | Light only. The existing theme toggle is not removed or changed in this checkpoint. |
| Color | Solid colors only. One FlowPulse blue is the primary accent. Red is reserved for fault. |
| Prohibited effects | No gradients, outer glow, dirty-black panels, glass blur, or decorative animation |
| Corner radii | System containers 16px; nodes 12px; controls 8px |

## Current-state audit

The current Architecture contract is semantically correct: it renders `topology_views.architecture`, keeps the 22 runtime/data components separate from the four FlowPulse control/evidence components, and exposes only the backend-projected cross-boundary evidence relation. The visual execution nevertheless reads as a line-art sketch for five concrete reasons:

1. The dominant visual primitives are 1px rules and compact monospace labels. The existing architecture node override removes elevation and uses square corners, so it loses the tangible component-surface hierarchy of the rest of the product.
2. The 22 components are arranged as compressed layer rows, but their 22 runtime dependencies are summarized instead of being legibly routed through the workspace. This makes the data model feel like a list rather than a topology.
3. Icons are colored glyphs without an icon-tile surface, labels are generally 11px or below, and metadata is 7.5px or below. Category recognition and scanability are therefore weak at 1440x900.
4. The observed system and FlowPulse control plane now have distinct boundaries, but both still rely on the same thin-rule vocabulary. The difference in ownership needs an unmistakable container hierarchy and an explicit relation legend.
5. The observed-system stack centers short rows in a large canvas. That leaves meaningful empty area while the useful cards and captions remain too small.

The design must correct these presentation issues without changing graph identity, component counts, evidence provenance, readiness, or authority semantics.

## Semantic architecture and data boundary

### Observed System / Data Source Architecture

This is the main topology workspace. It contains exactly the backend-projected 22 runtime/data nodes and 22 runtime dependency edges from `topology_views.architecture`. Its internal groups may organize these nodes by the existing backend-projected plane/layer/kind metadata. It is the monitored stack, not FlowPulse.

### FlowPulse Control System

This is a visibly separate sidecar/control plane containing exactly the backend-projected Deployment, Investigator, Evaluator, and Evidence Ledger nodes. It is never a numbered continuation layer of the observed stack. Its internal relations render only when present in the backend projection.

### Cross-boundary evidence relations

Cross-boundary relations connect the two boundaries only when the backend supplies an evidence-grounded relation with its provenance. The client neither fills missing arrows nor creates a generic "FlowPulse watches everything" relation. The currently projected deployment-to-checkout evidence relation is illustrative, not a license to add other arrows.

### Contract and authority invariants

- Architecture consumes only `topology_views.architecture` for graph IDs, labels, kinds, planes, layers, state, provenance, and relations.
- An absent, invalid, or unavailable canonical architecture projection renders the existing bounded unavailable state. It never falls back to the 6/5 incident compatibility graph.
- The browser does not infer incident state, readiness, risk, approval, repair, receipt, execution, verification, or causal claims.
- Detail cards expose only already-projected safe fields. Raw traces, logs, prompts, credentials, and provider payloads remain excluded.
- Count and relation copy remains split: **Observed system: 22 components / 22 dependencies**; **FlowPulse: 4 control/evidence components**; **Cross-boundary evidence relations: backend-provided count**.

## Visual system

### Design tokens

The implementation should introduce or normalize scoped Architecture tokens rather than changing global application tokens.

| Token family | Light-theme rule |
| --- | --- |
| Canvas | Off-white/light neutral, with a subtle solid dot or grid texture at low contrast |
| System surfaces | White solid fill, 1px neutral border, 16px radius; use one restrained tinted shadow only where a surface is explicitly elevated |
| Node surfaces | White solid fill, 1px cool-neutral border, 12px radius; no inflated pills or blobs |
| Controls | White/neutral solid fill, 8px radius, clear focus ring |
| Copy | Near-black primary text, readable neutral metadata; node title 14–15px semibold, metadata 11–12px |
| Primary accent | Existing FlowPulse blue for selection, active flow, and FlowPulse boundary affordances |
| Semantic status | Red = fault only; amber = caution; green = verified recovery; status is not a category color |
| Category colors | Allowed on icon tiles or compact glyphs only; never as rainbow node-card fills |

### Page composition and system-boundary hierarchy

At desktop widths, the workspace has three clear levels:

1. A compact toolbar and metric strip establishes source truth and the split system counts.
2. The **Observed System / Data Source Architecture** occupies the primary, largest surface. Its layer/group frames organize the runtime/data nodes and preserve breathing room for routed runtime dependencies.
3. The **FlowPulse Control System** is a bounded sidecar surface, visually related through the blue accent but unmistakably outside the observed-system boundary. A compact cross-boundary evidence rail sits between or below the two surfaces according to available viewport space.

Neither boundary should look like a continuation of the other. Runtime dependencies remain inside the observed-system surface. FlowPulse internal/control relations remain inside the control-system surface. Evidence/action relations cross boundaries only when projected and carry the evidence/control treatment described below.

### Node anatomy and component taxonomy

Each topology node has the same anatomy: a component-type icon tile, title, small kind/layer metadata, concise projected status, optional provenance count, and a quiet status indicator. The existing Phosphor icon dependency is reused.

| Entity class | Required icon family |
| --- | --- |
| API/service | plugs, browser, or service glyph already mapped by the app |
| Stream/Kafka | queue/stream glyph |
| Database/warehouse/dataset | database/storage glyph |
| Job/worker | gear/worker glyph |
| Deployment | existing commit/deployment glyph |
| Investigator/evaluator | existing robot/scales glyphs |
| Evidence ledger | existing database/evidence glyph |

The icon tile conveys component category. The separate status dot/text conveys current state. Selection uses a high-contrast blue border and existing detail behavior, not glow.

### Edge routing, arrowheads, and legend

All graph views will eventually share this relation grammar, but this checkpoint applies it only to Architecture:

| Relation class | Route and treatment | Legend copy |
| --- | --- | --- |
| Runtime dependency | Visible 1.5–2px cool-neutral orthogonal or gently curved route, compact arrowhead, inside Observed System | Runtime dependency |
| FlowPulse internal/control | Distinct but quiet blue-gray route, inside FlowPulse Control System | FlowPulse control relation |
| Cross-boundary evidence/action | Sparse FlowPulse-blue route with evidence/control label and provenance affordance | Evidence-grounded cross-boundary relation |

Routes must avoid node cards, labels, ports, and group headings. Edge labels appear only for the selected relation or a cross-boundary relation; ordinary runtime labels remain hidden to prevent clutter. Arrowheads are compact. If a join/split is needed by the projected graph, use a small restrained diamond rather than a large decorative hub. No relation is introduced merely to make the topology look connected.

The existing concise legend becomes the single source of visual explanation for these three relation classes plus status semantics. It must state that the page is CAPTURED/LAST-KNOWN/UNAVAILABLE according to backend truth, never imply production LIVE data for a captured source.

### Typography, spacing, and density

- Use the existing product typeface and monospace metadata face; do not add a font dependency.
- Node titles are 14–15px semibold and truncate only after preserving a useful accessible name.
- Metadata is 11–12px with sufficient contrast, not a primary visual texture.
- System titles and count labels must remain readable at 1280x800.
- Use deliberate internal padding and 12–20px gaps; reduce empty canvas by placing group frames and relationship routes where the information is, not by shrinking everything.

## Interaction and motion

- Existing pan, zoom, reset/fit, node/edge selection, keyboard activation, and drawer behavior are preserved. Architecture remains structured and calm rather than becoming an editable flowchart.
- Pointer hover and keyboard focus provide a compact, high-contrast feedback state. Focus must remain visible on nodes, edges, controls, and legend interactions.
- Node/edge click or Enter/Space opens the existing safe detail surface using only projected fields.
- A relation pulse is allowed only when it communicates projected flow or a state transition. It follows the actual rendered relation, uses transform/opacity/stroke movement rather than layout animation, and does not run merely as decoration.
- `prefers-reduced-motion: reduce` makes pulses/static transitions immediate while preserving selection, labels, and legibility.

## Responsive behavior

### 1440x900 acceptance

- Both system boundaries, the principal observed topology, source state, and legend are visible without browser zoom.
- The 22 runtime/data nodes, 22 runtime dependencies, four FlowPulse nodes, and projected cross-boundary relation are identifiable from the workspace hierarchy.
- No node, control, relation label, drawer, or count is clipped or overlaps a node card.

### 1280x800 acceptance

- The same semantic split persists, with the FlowPulse sidecar retaining a clearly separate surface.
- Runtime groups may compact or reflow within the observed-system surface, but they cannot become unreadably small or overlap routed relations.
- The cross-boundary relation rail may move below the system surfaces, but remains explicit and accessible.

At narrower widths, the existing responsive/reflow behavior may stack system surfaces. This checkpoint does not add a mobile-specific topology redesign.

## Non-goals

- No changes to Live, Diagnose, Agent Control, Recovery, Compare, demo lifecycle, or backend state.
- No frontend authority, lifecycle, or readiness inference.
- No new charting/graph framework, font package, icon package, or custom decorative SVG system.
- No dark-theme redesign; the existing toggle remains outside this checkpoint.
- No invented topology, dependence on a live connector, production telemetry claim, or additional cross-boundary arrows.

## Acceptance tests and screenshot checklist

Before review, implementation must demonstrate:

1. Architecture renders only the valid canonical projection and preserves the 22 runtime/data + 22 runtime dependency + four FlowPulse split.
2. The client does not use `source.topology` as an Architecture fallback.
3. A unit/contract test proves every rendered relation endpoint exists and category follows the backend-projected boundary classification.
4. A visual/DOM test proves FlowPulse nodes are never placed inside observed-system layers, and no unprojected relation is drawn.
5. Keyboard focus, Enter/Space selection, and existing drawer content remain accessible.
6. Reduced-motion mode stops ornamental movement while retaining projected state and readable edges.
7. No browser console error, failed API request, or raw/sensitive content reaches the page.

Required screenshots:

- Architecture initial at 1440x900.
- Architecture selected runtime node at 1440x900.
- Architecture selected cross-boundary evidence relation at 1440x900.
- Architecture initial at 1280x800.
- Architecture with reduced motion enabled.
- Architecture unavailable state, demonstrating no 6/5 compatibility fallback.

## Reviewable implementation plan

Each step is a separate reviewable commit. Stop after every step for owner review; do not automatically continue.

1. **Token and shell pass**: add Architecture-scoped light-theme tokens and system-boundary surface hierarchy. Preserve all graph IDs and layout behavior. Capture initial 1440x900 and 1280x800 evidence.
2. **Node taxonomy pass**: apply the existing icon mappings to clear icon tiles and improve node typography/metadata. Add selection/focus and keyboard regression coverage.
3. **Relation pass**: render only backend-projected runtime, control, and cross-boundary relations with their distinct treatments, arrowheads, and the concise legend. Add endpoint/category/no-invention contract tests.
4. **Density and motion pass**: resolve overlaps/reflow at both desktop targets, add motivated projected relation pulse behavior, and verify reduced motion. Capture the complete screenshot checklist.
5. **Review/polish pass**: run frontend and server regressions, audit console/network output, inspect the full diff against `890489d`, and prepare a small final Architecture-only commit series for owner approval.

Rollback for any step is its own commit revert. If the implementation requires a backend contract change, additional graph data, an authority change, or a redesign of another view, stop and return to owner review rather than extending this checkpoint.

## Open owner decisions

No blocking product decision remains for this specification. During implementation, the owner should approve the exact runtime edge-routing density after the first relation-pass screenshots, because the 22 backend-projected dependencies may require a choice between a compact all-edge rendering and a selected-path emphasis that still preserves backend truth.

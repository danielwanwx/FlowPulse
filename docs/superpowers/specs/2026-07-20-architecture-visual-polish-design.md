# FlowPulse Spatial Glass architecture visual polish

**Status:** Owner-approved static Architecture overview refinement. Implementation is limited to the four-layer Architecture overview and its separate FlowPulse control surface.

**Branch baseline:** `codex/frontend-architecture-polish` at `c352e89c08f384a45891c1b60f34c38ff7854dff`
**Superseded visual implementation:** `b1fefe36849587efb3594c74fce9c791166ff928` is an inspectable solid-panel candidate, not the material direction for future work.
**Scope:** Architecture view only. Light spatial theme only. The existing theme toggle and all non-Architecture views remain behaviorally unchanged.

## Purpose and design read

**FlowPulse Spatial Glass** is a web approximation inspired by the spatial layering, depth, and frosted material cues associated with Apple Vision Pro interfaces. It is not, and must not claim to be, Apple's native Liquid Glass implementation.

The Architecture page must stop reading as a line-art diagram while remaining an honest engineering topology and evidence-control product. Architecture is one static layered technology-stack overview, not a connected graph view or a drill-down workspace. The observed stack must be easy to scan, FlowPulse itself must remain visibly separate, and the canonical component inventory must be visible directly in each layer without a second face, node flip, or right-side component drawer.

This is redesign-preserve work. Existing navigation, canonical backend topology contracts, graph identity and counts, lifecycle logic, keyboard behavior, and theme-toggle behavior remain intact. Header, navigation, source status, and the FlowPulse control surface remain fixed around one static central workspace. Architecture child nodes are display surfaces, not click targets; the browser remains read-only and does not acquire authority.

## Locked design dials

| Dial | Decision |
| --- | --- |
| Design variance | 4/10: a targeted material and hierarchy refinement, not a new product or graph model |
| Motion intensity | 4/10: only projected state/flow feedback and direct interaction response |
| Visual density | 7/10: both system boundaries and principal topology are useful at the default desktop view |
| Checkpoint theme | Light spatial theme. Do not remove or redesign the existing theme toggle in this checkpoint. |
| Primary accent | FlowPulse blue. Status color remains independent of category color; red means fault only. |
| Material | Flat translucent white surfaces over a cool-gray spatial canvas. Alpha contrast only separates material levels; no inner highlights, cast shadows, white-edge effects, or stacked shells. |
| Prohibited effects | No rainbow or AI-purple mesh gradients, outer neon glow, pure-black shadows, dirty-black panels, glass on every primitive, decorative perpetual motion, or Apple-native implementation claims. |
| Radius system | Primary glass surfaces 22px; nested nodes 14px; navigation and compact status controls may be pill-shaped. |

## Current-state audit

The Architecture contract is already semantically correct: `topology_views.architecture` carries 22 runtime/data components and 22 runtime dependencies separately from four FlowPulse control/evidence components and backend-projected cross-boundary relations. The current visual execution nevertheless reads as a line-art sketch for concrete reasons:

1. The Overview identifies four layers but leaves their surfaces too empty. A judge cannot scan the actual composition of a layer at a glance.
2. Repeated titles and source copy compete with the one page-level task: recognize the architecture and choose a layer to inspect.
3. Heavy display weights, mono metadata, and strongly ruled cards make the interface feel like a white-card wireframe rather than a nested spatial surface.
4. The observed system and FlowPulse control plane have distinct data boundaries but need a shared material grammar with a clearer difference in elevation and tint.
5. The large canvas needs purposeful hierarchy through one neutral canvas and translucent nested modules with distinct alpha levels, not opaque blocks, outlines, cast shadows, white-edge effects, or decorative graph treatment.
6. The solid-panel shell in `b1fefe3` improves hierarchy but is obsolete: it relies too heavily on opaque surfaces, borders, and shadows instead of the approved flat transparent material hierarchy below.

The result must be corrected with spatial materials and stronger information hierarchy, without changing graph identity, topology counts, evidence provenance, readiness, or authority semantics.

## Semantic architecture and authority boundary

### Observed System / Data Source Architecture

This is the main workspace and is derived from the 22 backend-projected runtime/data nodes in `topology_views.architecture`. The Overview front groups them into four backend-grounded modules: **Client applications**, **Commerce edge & APIs**, **Core services**, and **Async data & platform**. Each module includes a compact thumbnail anatomy of its canonical member nodes: an existing icon glyph and a short safe label. The 22 runtime dependencies remain intact in the backend contract for Live, diagnosis, and safe detail, but Architecture renders no dependency paths, arrows, pulses, or node-to-node lines.

### FlowPulse Control System

This is a separately bounded control surface containing exactly the backend-projected Deployment, Investigator, Evaluator, and Evidence Ledger nodes. It is never presented as a numbered continuation layer of the monitored stack. Its internal and cross-boundary relation counts are summarized only when the backend projection provides them.

### Cross-boundary evidence summary

Cross-boundary relations remain available only if supplied by the backend and evidence-grounded by projection provenance. Architecture keeps their count and safe metadata available to accessibility and other appropriate views, but does not draw or decorate them in the static canvas. The client does not connect FlowPulse to monitored components to make the page look complete.

### Contract and authority invariants

- Architecture consumes only `topology_views.architecture` for graph IDs, labels, kinds, planes, layers, statuses, provenance, and relations.
- Missing, invalid, or unavailable canonical Architecture projection renders the existing bounded unavailable state. It never falls back to the 6/5 incident compatibility graph.
- The browser never infers or authorizes incident state, readiness, risk, approval, repair, receipt, execution, verification, or causal claims.
- Detail content contains only already-projected safe fields. Raw traces, logs, prompts, credentials, and provider payloads remain excluded.
- Count copy remains explicit: **Observed system: 22 components / 22 dependencies retained**; **FlowPulse: 4 control/evidence components**; **Cross-boundary evidence relations: backend-provided count**.

## Central workspace information model

Architecture is one static, non-editable summary surface. It has no local face state and cannot strengthen backend readiness, authority, or source truth.

- Four large translucent modules represent **Client applications**, **Commerce edge & APIs**, **Core services**, and **Async data & platform**.
- Each module derives its canonical technical name, count, and compact member anatomy from the backend Architecture projection. All 22 members remain visible as consistent icon-and-name mini modules, so the user can identify the whole stack without drilling in.
- A mini module is an information surface, not a button: no flip, nested page, keyboard activation, node selection, or duplicate detail drawer is rendered in Architecture.
- Each layer and each FlowPulse control node receives a small upper-right status dot from its exact backend-projected status. Green means an explicit healthy/verified state, red means a proven fault/impact, amber means a projected warning/change/approval state, blue means observed/active/recording, and muted gray means idle/quiet/dormant. Captured `observed` data must stay blue rather than being falsely labelled healthy.
- FlowPulse Control System remains an independent translucent side surface containing exactly Deployment, Investigator, Evaluator, and Evidence Ledger. It is not a fifth layer.
- Architecture renders no dependency line, SVG edge map, arrowhead, pulse, node-to-node line, cross-boundary line, internal relation diagram, or relation selection. Backend relation data remains available to Live, diagnosis, and safe detail elsewhere.

## Spatial Glass token system

Use Architecture-scoped CSS variables and existing stack primitives. These values describe web materials and fallbacks; they do not pretend to reproduce native Apple materials.

| Token family | Intent | Light spatial rule and fallback |
| --- | --- | --- |
| Spatial background | Establish quiet depth behind the workspace | Cool neutral field with a subtle, low-saturation tonal atmosphere and minimal noise. No multicolor marketing mesh. Fallback is a solid off-white neutral. |
| Page glass | Contain the Architecture workspace | 22px radius; translucent light-neutral material over a visible cool-gray canvas. Fallback uses an opaque off-white surface and normal contrast. |
| Observed-system matte glass | Make the monitored system the primary plane | One transparent workspace, not a second raised shell. Spacing and alpha-separated layer modules do the grouping. |
| FlowPulse control glass | Distinguish the control plane without treating it as runtime | 22px radius; separate translucent surface with a restrained FlowPulse-blue tint and slightly higher alpha. The tint never means incident severity. |
| Nested node glass | Make member anatomy clear without creating a card wall | 14px radius; consistent translucent white face, readable text, no ordinary border, highlight, blur, or shadow. |
| Floating controls | Give menus/toolbar highest interaction priority | Compact, pill-shaped only where status or navigation semantics call for it; otherwise use the same 14px nested-control geometry, contrast, and visible focus ring. |
| Static node anatomy | Make the stack inventory visible without another interaction layer | Every layer shows the same 14px mini component module: icon, canonical short name, and truthfully projected status dot. |
| Run-level drawer | Keep non-Architecture inspection coherent without a dark modal | 22px radius; translucent matte glass with alpha separation only. Architecture does not open this drawer for component mini modules. |
| Text | Preserve readability on translucent material | Near-black primary, dark neutral secondary, WCAG-readable metadata. Never use low-contrast gray text merely to look glassy. |
| Accent and status | Encode intent, not material | FlowPulse blue for selected/active/control treatment. Red=fault only, amber=caution, green=verified recovery. Category color is limited to icon bases or compact glyph detail. |
| Shape scale | Make the system coherent | 22px primary glass, 14px nested nodes and controls, pills only for compact status/navigation. Icon bases are circular or 12px rounded squares. |

Decorative borders, top highlights, shadow effects, and separator hairlines are removed where material contrast, padding, or alignment communicates the grouping more clearly. An essential fallback outline may appear only in reduced-transparency mode.

## Shape consistency and material hierarchy

### Shape rules

- Primary glass boundaries and any run-level drawer use 22px. Nested node modules and ordinary controls use 14px. Do not introduce another radius tier.
- Avoid ad hoc pills and mixed square/rounded corners. Pills remain limited to compact navigation or status semantics.
- Icons sit on a circular or 12px rounded-square base. The base identifies category; it cannot imply authority or severity.
- Status/toggle controls may be pill-shaped because their compact state semantics benefit from it. Node cards and system boundaries may not become pills.

### Material hierarchy

The view must retain these levels from back to front:

1. **Cool-gray spatial canvas**: quiet neutral depth visible through all Architecture modules.
2. **Observed System field**: one transparent workspace containing the four macro layer modules.
3. **FlowPulse Control surface**: a visibly separate, restrained blue-tinted translucent module.
4. **Layer and component modules**: higher-alpha 22px and 14px surfaces, respectively, with no shadow, highlight, border, or nested glass shell.
5. **Fixed navigation and controls**: use the same alpha-only material where Architecture styling applies.

The page uses alpha rather than optical elevation. Backdrop blur may be retained only on a bounded outer surface when it materially improves the fallback-safe spatial field; it must never be applied to layer, node, icon, or status-dot modules. Nested high-radius blurs, cast shadows, and white-edge effects are forbidden.

## Page composition and system-boundary hierarchy

At desktop sizes the page has two clear semantic zones:

1. The **Observed System / Data Source Architecture** occupies the largest transparent workspace. It presents four large technical layer modules, each with its complete compact member anatomy directly visible.
2. The **FlowPulse Control System** occupies a distinct, spatially fixed side surface. Safe projected cross-boundary evidence is summarized as compact metadata instead of a route.

Architecture has no in-canvas source/status toolbar, metric cluster, or legend control. Canonical counts, source truth, and relations remain backend-owned and available to other views or accessible metadata, but are not repeated as a separate visual strip. Runtime dependencies are retained as backend truth but are not drawn in Architecture. Live owns connection animation and runtime flow.

At 1440px, the two boundaries and principal topology are visible without browser zoom. At 1280px, the control surface may reposition below or beside the observed workspace, but it must preserve its independent boundary, readable title, and explicit evidence summary.

## Node anatomy and component visual taxonomy

Every backend-projected node uses a consistent anatomy:

1. Existing component-type icon on a circular or 12px-square category base.
2. Canonical short node title in the product face, aligned consistently across observed and FlowPulse control modules.
3. One upper-right status dot from backend-projected status; it never substitutes for component category or source truth.
4. No visible runtime/kind/layer/provenance facts on Architecture mini modules. Accessibility labels carry bounded safe identity and status.

| Entity class | Existing icon-family intent | Category treatment |
| --- | --- | --- |
| API/service | Existing service, plug, browser, or API glyph | Cool neutral/blue category base |
| Stream/Kafka | Existing queue/stream glyph | Stream category base |
| Database, warehouse, dataset | Existing storage/database glyph | Storage category base |
| Job/worker | Existing gear/worker glyph | Work category base |
| Deployment | Existing commit/deployment glyph | FlowPulse control base |
| Investigator/evaluator | Existing robot/scales glyph | FlowPulse control base |
| Evidence ledger | Existing database/evidence glyph | FlowPulse evidence base |

Architecture component modules are static, non-selectable inventory. The browser cannot generate a causal narrative, map missing fault evidence to healthy, or infer authority from displayed status.

## Architecture relation and legend rules

Architecture has no SVG dependency renderer, edge selection, arrowheads, relation pulses, ports, join/split diamonds, or node-to-node lines. Backend relation arrays remain untouched. Runtime connections and animated flow belong to Live; diagnosis may use the bounded incident overlay; detail may summarize safe relation metadata.

The Architecture surface does not render a legend. Four macro modules and the visually separate FlowPulse control surface communicate the system split directly; safe provenance remains bounded backend-projected metadata, never inferred or connected client-side.

## Typography, spacing, and density

- Use the native Apple system stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif`. Use body weights 400-500 and heading weights no heavier than 600.
- Remove visible runtime/kind/layer metadata from Architecture modules and use it only as accessibility meaning. Do not use monospace as a default visual texture.
- The sole visible page title is **Architecture**. Remove redundant visible copy such as Observed architecture, Observed System, Data Source Architecture, CAPTURED runtime and data source projection, explanatory paragraphs, metric clusters, and Legend controls that do not improve immediate scanning. Semantic labels remain available through `aria-label` or visually-hidden text.
- System titles, layer counts, controls, and bounded source truth in their owning locations remain readable at 1280x800.
- Prefer deliberate 12-24px internal spacing over artificial empty canvas. Surface depth, alignment, and layer rhythm should help users parse the system before they inspect a layer.
- Canonical short names must remain legible without truncation at the target desktop sizes. Long safe names retain accessible labels rather than creating a secondary Architecture detail interaction.

## Interaction, accessibility, and motion

- Preserve existing page navigation. Architecture layers, mini modules, and FlowPulse control modules are information surfaces rather than interactive controls; non-Architecture and run-level inspection retain their appropriate drawer behavior. Architecture remains structured and calm, never an editable flowchart. Live retains its own graph pan, zoom, route selection, and flow animation behavior unchanged.
- Pointer hover and keyboard focus remain visible for actual page controls and menus in both transparency and fallback modes. Architecture mini modules remain static readable information surfaces.
- `prefers-reduced-motion: reduce` has no Architecture transition to suppress; it preserves the existing static arrangement.
- `prefers-reduced-transparency: reduce` or a no-`backdrop-filter` environment replaces translucent/blurred materials with high-contrast opaque off-white surfaces, essential borders, and the same semantic hierarchy.
- Animations may change only transform and opacity. They must not animate layout geometry, alter reading order, or create decorative perpetual motion.

## Responsive acceptance criteria

### 1440x900

- Both named system boundaries, four observed layer modules, and the FlowPulse control surface are visible without browser zoom; no Architecture metric/Legend strip consumes canvas height.
- The four macro surfaces show compact thumbnail anatomy for 6/9/3/4 canonical members, zero Architecture edges, zero expanded observed-node detail grid, and no clipping.
- The material hierarchy is obvious through transparency only: observed system is the primary workspace; FlowPulse is a separate blue-tinted control surface; modules have no ordinary border, white top edge, shadow, or additional nested shell.

### 1280x800

- The observed/control split remains unmistakable even if the control surface or evidence summary reflows.
- Layer modules compact only within their backend-projected bounds; no title or component count becomes unreadably small.
- Fixed page controls, fallback unavailable state, and non-Architecture run-level drawer in its owning view remain keyboard reachable and unclipped. Architecture modules remain static.

## Architecture-only non-goals

- Do not redesign Live, Diagnose, Agent Control, Recovery, Compare, demo lifecycle, or backend state.
- Do not add client-side authority, readiness, lifecycle, or graph inference.
- Do not add a graph framework, animation package, font package, icon package, custom decorative SVG system, or native-platform claim.
- Do not change topology contracts, counts, data provenance, theme toggle behavior, or backend APIs.
- Do not invent nodes, runtime dependencies, cross-boundary arrows, incident paths, production telemetry, or live-source claims.

## Acceptance tests and screenshot checklist

Implementation review must show:

1. Architecture renders only the valid canonical projection and keeps the 22 runtime/data + 22 retained runtime dependency + four FlowPulse split.
2. The client does not use `source.topology` as an Architecture fallback.
3. Architecture contains four macro layers with canonical counts 6/9/3/4, a compact icon-and-label anatomy for every member, zero Architecture edge paths, and zero arrowheads.
4. Architecture has exactly 22 observed mini modules and four separately represented FlowPulse control/evidence modules. No mini module opens an Architecture component face or component drawer.
5. FlowPulse nodes never render inside observed-system layers; no relation is drawn.
6. Each layer and FlowPulse node presents an upper-right status dot from its backend-projected status. The browser never converts captured `observed` into healthy.
7. Redundant visible labels are absent while accessibility labels retain the observed-system and control-plane meaning. Architecture modules are not keyboard controls; actual page controls keep visible focus contrast.
8. Reduced-motion and reduced-transparency fallbacks preserve meaning and readability. Architecture material levels differ by alpha only, never cast shadow, inner highlight, white edge, or blur on nested modules.
8. No browser console error, failed API request, or raw/sensitive content reaches the page.

Required screenshots:

- Architecture Overview at 1440x900.
- Architecture Overview at 1280x800.
- Architecture with reduced motion enabled.
- Architecture with reduced transparency or blur fallback enabled.
- Architecture unavailable state proving there is no 6/5 compatibility fallback.

## Reviewable implementation plan

Each step is a separate reviewable commit. Stop after every step for owner review. Do not automatically continue.

1. **Static architecture pass**: show compact canonical anatomy in all four layers; simplify visible hierarchy to one Architecture title; remove the in-canvas metric/Legend toolbar; remove Architecture face transition, Back control, node detail, and drawer activation; restyle FlowPulse with matching alpha-only nested modules and backend-owned status dots.
2. **Owner screenshot gate**: review 1440x900 and 1280x800 static Overview evidence before expanding any other page.
3. **Deferred runtime detail**: place richer component detail in Live or another owner-approved diagnostic surface, never by adding another Architecture face.
4. **Final density pass**: keep the FlowPulse side surface, menu, and run-level sidebar under one translucent alpha-only material system; verify fallback materials, reduced motion/transparency, console/network cleanliness, and no Architecture edge renderer.

The old `b1fefe3` CSS is not an implementation base by default. A future owner-approved implementation may reuse individual safe layout or token mechanics only after confirming that they satisfy this Spatial Glass material hierarchy; otherwise it supersedes them in a new explicit change. Rollback for any new implementation step is its own revert commit. If the work requires a backend contract change, new graph data, authority change, or another-page redesign, stop and return to owner review.

## Owner decisions recorded

- The pilot is Architecture only. Do not scale this system to other pages in this checkpoint.
- The approved material direction is FlowPulse Spatial Glass, not the prior opaque solid-panel direction.
- The product may borrow high-level spatial-interface cues but must not claim native Apple material behavior or copy an Apple product surface.
- Architecture is a layered stack overview, not a connected graph. Live owns connection animation.
- Architecture is now one static overview. It does not offer any layer detail face, component flip, node selection, or component drawer.
- All 22 observed components remain visible in the four technical layers; FlowPulse retains four independent control/evidence modules with their own backend-owned status dots.
- The remaining owner gate is review of that static Architecture sample before any other page receives the system.
- The approved refinement removes shadows, white-edge effects, and excessive surface nesting. It uses a cool-gray canvas plus alpha-only transparent white modules and does not change any backend contract, graph count, lifecycle state, or non-Architecture page.

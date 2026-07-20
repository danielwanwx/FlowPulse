# FlowPulse Spatial Glass architecture visual polish

**Status:** Owner-approved spatial-glass refinement checkpoint. Implementation is limited to Architecture Overview and the existing Client applications detail sample.

**Branch baseline:** `codex/frontend-architecture-polish` at `c352e89c08f384a45891c1b60f34c38ff7854dff`
**Superseded visual implementation:** `b1fefe36849587efb3594c74fce9c791166ff928` is an inspectable solid-panel candidate, not the material direction for future work.
**Scope:** Architecture view only. Light spatial theme only. The existing theme toggle and all non-Architecture views remain behaviorally unchanged.

## Purpose and design read

**FlowPulse Spatial Glass** is a web approximation inspired by the spatial layering, depth, and frosted material cues associated with Apple Vision Pro interfaces. It is not, and must not claim to be, Apple's native Liquid Glass implementation.

The Architecture page must stop reading as a line-art diagram while remaining an honest engineering topology and evidence-control product. Architecture is a static layered technology-stack overview, not a connected graph view. Its central glass workspace has two faces: a high-level layer overview and one selected layer's complete internal anatomy. The observed stack must be easy to scan, FlowPulse itself must remain visibly separate, and all safe child-node detail must be present directly in the layer anatomy rather than hidden behind another flip or repeated in a right-side drawer.

This is redesign-preserve work. Existing navigation, canonical backend topology contracts, graph identity and counts, lifecycle logic, keyboard behavior, and theme-toggle behavior remain intact. Header, navigation, source status, and the FlowPulse control surface remain fixed while only the central workspace changes face. Architecture child nodes are display surfaces, not click targets; the browser remains read-only and does not acquire authority.

## Locked design dials

| Dial | Decision |
| --- | --- |
| Design variance | 4/10: a targeted material and hierarchy refinement, not a new product or graph model |
| Motion intensity | 4/10: only projected state/flow feedback and direct interaction response |
| Visual density | 7/10: both system boundaries and principal topology are useful at the default desktop view |
| Checkpoint theme | Light spatial theme. Do not remove or redesign the existing theme toggle in this checkpoint. |
| Primary accent | FlowPulse blue. Status color remains independent of category color; red means fault only. |
| Material | Frosted matte surfaces, restrained inner highlights, layered translucency, and bounded backdrop blur. Alpha contrast, not cast shadows, separates material levels. |
| Prohibited effects | No rainbow or AI-purple mesh gradients, outer neon glow, pure-black shadows, dirty-black panels, glass on every primitive, decorative perpetual motion, or Apple-native implementation claims. |
| Radius system | Primary glass surfaces 22px; nested nodes 14px; navigation and compact status controls may be pill-shaped. |

## Current-state audit

The Architecture contract is already semantically correct: `topology_views.architecture` carries 22 runtime/data components and 22 runtime dependencies separately from four FlowPulse control/evidence components and backend-projected cross-boundary relations. The current visual execution nevertheless reads as a line-art sketch for concrete reasons:

1. The Overview identifies four layers but leaves their surfaces too empty. A judge cannot scan the actual composition of a layer without opening its detail face.
2. Repeated titles and source copy compete with the one page-level task: recognize the architecture and choose a layer to inspect.
3. Heavy display weights, mono metadata, and strongly ruled cards make the interface feel like a white-card wireframe rather than a nested spatial surface.
4. The observed system and FlowPulse control plane have distinct data boundaries but need a shared material grammar with a clearer difference in elevation and tint.
5. The large canvas needs purposeful depth through translucent nested surfaces with distinct alpha levels, not opaque blocks, outlines, cast shadows, or decorative graph treatment.
6. The solid-panel shell in `b1fefe3` improves hierarchy but is obsolete: it relies too heavily on opaque surfaces, borders, and shadows instead of the approved material hierarchy below.

The result must be corrected with spatial materials and stronger information hierarchy, without changing graph identity, topology counts, evidence provenance, readiness, or authority semantics.

## Semantic architecture and authority boundary

### Observed System / Data Source Architecture

This is the main workspace and is derived from the 22 backend-projected runtime/data nodes in `topology_views.architecture`. The Overview front groups them into four backend-grounded modules: **Client applications**, **Commerce edge & APIs**, **Core services**, and **Async data & platform**. Each module includes a compact thumbnail anatomy of its canonical member nodes: an existing icon glyph and a short safe label. The 22 runtime dependencies remain intact in the backend contract for Live, diagnosis, and safe detail, but Architecture renders no dependency paths, arrows, pulses, or node-to-node lines.

### FlowPulse Control System

This is a separately bounded control surface containing exactly the backend-projected Deployment, Investigator, Evaluator, and Evidence Ledger nodes. It is never presented as a numbered continuation layer of the monitored stack. Its internal and cross-boundary relation counts are summarized only when the backend projection provides them.

### Cross-boundary evidence summary

Cross-boundary relations remain available only if supplied by the backend and evidence-grounded by projection provenance. Architecture summarizes their count and safe metadata in the FlowPulse surface or Client applications anatomy. It does not draw a line through the canvas. The client does not connect FlowPulse to monitored components to make the page look complete.

### Contract and authority invariants

- Architecture consumes only `topology_views.architecture` for graph IDs, labels, kinds, planes, layers, statuses, provenance, and relations.
- Missing, invalid, or unavailable canonical Architecture projection renders the existing bounded unavailable state. It never falls back to the 6/5 incident compatibility graph.
- The browser never infers or authorizes incident state, readiness, risk, approval, repair, receipt, execution, verification, or causal claims.
- Detail content contains only already-projected safe fields. Raw traces, logs, prompts, credentials, and provider payloads remain excluded.
- Count copy remains explicit: **Observed system: 22 components / 22 dependencies retained**; **FlowPulse: 4 control/evidence components**; **Cross-boundary evidence relations: backend-provided count**.

## Central workspace interaction model

The central Architecture glass workspace has two bounded faces. This is local presentation state only and cannot strengthen backend readiness, authority, or source truth.

### Overview front

- Four large glass modules represent Client applications, Commerce edge & APIs, Core services, and Async data & platform.
- Each module derives its name, count, short responsibility, and compact thumbnail anatomy from the canonical Architecture projection and the fixed backend layer contract. Every thumbnail exposes an existing icon glyph plus a short canonical member label.
- Overview keeps member thumbnails compact rather than expanding six, nine, three, or four full node cards. No dependency line or Architecture SVG edge map is present.
- FlowPulse Control System remains an independent glass side surface with the four canonical control/evidence nodes. It is not a fifth layer.
- Clicking or keyboard-activating Client applications turns the central workspace to its internal anatomy face.

### Client applications detail back

- The detail face occupies the same central workspace bounds and material as Overview.
- It renders exactly the six canonical Client applications nodes and no observed node from another layer.
- Each node directly presents its existing icon, safe projected label, kind, truthful source label, status, ordered signal summary, direct upstream and downstream labels, and bounded provenance references. The browser adds no causal or authority claims.
- A clear Back to overview control and breadcrumb/context title restore the Overview face.
- Child nodes do not flip, route, or open a duplicate right-side component drawer. They are not keyboard targets; the direct information is visible in their own bounded cards.
- The other three layer detail faces are explicitly deferred until the owner approves this sample.

### Transition and focus

- A 420-520ms 3D workspace turn communicates moving from Overview into Client applications. Front and back use proper `backface-visibility` so mirrored text is never visible.
- Only transform and opacity animate. Header, navigation, source status, system counts, and FlowPulse Control System remain spatially fixed.
- Focus moves to the Back control after entering the Client applications face and returns to the Client applications module after leaving it.
- `prefers-reduced-motion: reduce` replaces the turn with a short opacity transition or instant swap.
- Browser history and refresh do not receive a new route in this sample. Face state remains bounded local presentation state.

## Spatial Glass token system

Use Architecture-scoped CSS variables and existing stack primitives. These values describe web materials and fallbacks; they do not pretend to reproduce native Apple materials.

| Token family | Intent | Light spatial rule and fallback |
| --- | --- | --- |
| Spatial background | Establish quiet depth behind the workspace | Cool neutral field with a subtle, low-saturation tonal atmosphere and minimal noise. No multicolor marketing mesh. Fallback is a solid off-white neutral. |
| Page glass | Contain the Architecture workspace | 22px radius; translucent light-neutral material, bounded blur/saturation, and one faint inner highlight. Fallback uses an opaque off-white surface and normal contrast. |
| Observed-system matte glass | Make the monitored system the primary plane | 22px radius; 45-58% translucent white/matte surface with spacing and depth doing most grouping work. |
| FlowPulse control glass | Distinguish the control plane without treating it as runtime | 22px radius; separate surface with a restrained FlowPulse-blue refraction/tint and slightly higher contrast. The tint never means incident severity. |
| Nested node glass | Make member anatomy clear without creating a card wall | 14px radius; suspended translucent white face, readable text, and no ordinary border or cast shadow. |
| Floating controls | Give menus/toolbar highest interaction priority | Compact, pill-shaped only where status or navigation semantics call for it; otherwise use the same 14px nested-control geometry, contrast, and visible focus ring. |
| Inline node detail | Make all projected Client applications facts visible without another interaction layer | The Client applications workspace uses 14px translucent nested cards with direct safe facts. There is one Back control for the layer and no duplicate component drawer. |
| Run-level drawer | Elevate non-component inspection without a dark modal | 22px radius; translucent matte glass, bounded blur, and a stronger alpha level rather than a cast shadow. |
| Text | Preserve readability on translucent material | Near-black primary, dark neutral secondary, WCAG-readable metadata. Never use low-contrast gray text merely to look glassy. |
| Accent and status | Encode intent, not material | FlowPulse blue for selected/active/control treatment. Red=fault only, amber=caution, green=verified recovery. Category color is limited to icon bases or compact glyph detail. |
| Shape scale | Make the system coherent | 22px primary glass, 14px nested nodes and controls, pills only for compact status/navigation. Icon bases are circular or 12px rounded squares. |

Decorative borders and separator hairlines are removed where material contrast, depth, padding, or alignment communicates the grouping more clearly. Borders remain only where needed for contrast, keyboard focus, selected state, or a fallback without transparency.

## Shape consistency and material hierarchy

### Shape rules

- Primary glass boundaries and any run-level drawer use 22px. Nested nodes, inline detail cards, and ordinary controls use 14px. Do not introduce another radius tier.
- Avoid ad hoc pills and mixed square/rounded corners. Pills remain limited to compact navigation or status semantics.
- Icons sit on a circular or 12px rounded-square base. The base identifies category; it cannot imply authority or severity.
- Status/toggle controls may be pill-shaped because their compact state semantics benefit from it. Node cards and system boundaries may not become pills.

### Material hierarchy

The view must retain these levels from back to front:

1. **Spatial background**: quiet cool-neutral depth and minimal texture.
2. **Observed System matte-glass workspace**: the primary architectural field.
3. **FlowPulse Control glass surface**: clearly separate, with a restrained blue refraction/tint and its own nested control nodes.
4. **Layer thumbnail anatomy and inline Client applications nodes**: clearer, higher-opacity objects suspended inside their parent glass surface.
5. **Floating toolbar and menu controls**: highest operational affordance above the workspace.
6. **An elevated run-level drawer**: strongest inspection level when another view actually needs it, never an opaque black overlay. Architecture child-node detail stays inline.

Blur is used only on page, system-boundary, control, and drawer surfaces. Node cards use the lowest practical blur or a higher-opacity fallback. Nested high-radius blurs are forbidden. The implementation budget is one full-page spatial background treatment plus bounded, non-overlapping blur surfaces; it must avoid placing a backdrop-filter on every node, edge, or label.

## Page composition and system-boundary hierarchy

At desktop sizes the page has two clear semantic zones:

1. The **Observed System / Data Source Architecture** occupies the largest matte-glass workspace. Its Overview face presents four large layer modules. Its Client applications face presents only that layer's six internal nodes with all bounded safe detail directly visible.
2. The **FlowPulse Control System** occupies a distinct, spatially fixed side surface. Safe projected cross-boundary evidence is summarized as compact metadata instead of a route.

Architecture has no in-canvas source/status toolbar, metric cluster, or legend control. Canonical counts, source truth, and relations remain backend-owned and available to other views or accessible metadata, but are not repeated as a separate visual strip. Runtime dependencies are retained as backend truth but are not drawn in Architecture. Live owns connection animation and runtime flow.

At 1440px, the two boundaries and principal topology are visible without browser zoom. At 1280px, the control surface may reposition below or beside the observed workspace, but it must preserve its independent boundary, readable title, and explicit evidence summary.

## Node anatomy and component visual taxonomy

Every backend-projected node uses a consistent anatomy:

1. Existing component-type icon on a circular or 12px-square category base.
2. 14–15px semibold product-face node title.
3. 11–12px readable metadata for backend-projected kind/layer/status.
4. Compact provenance/evidence reference only where projected and bounded.
5. Separate status indicator that never substitutes for component category.

| Entity class | Existing icon-family intent | Category treatment |
| --- | --- | --- |
| API/service | Existing service, plug, browser, or API glyph | Cool neutral/blue category base |
| Stream/Kafka | Existing queue/stream glyph | Stream category base |
| Database, warehouse, dataset | Existing storage/database glyph | Storage category base |
| Job/worker | Existing gear/worker glyph | Work category base |
| Deployment | Existing commit/deployment glyph | FlowPulse control base |
| Investigator/evaluator | Existing robot/scales glyph | FlowPulse control base |
| Evidence ledger | Existing database/evidence glyph | FlowPulse evidence base |

Architecture child nodes are not selectable: each presents its bounded projected detail directly. Layer activation uses a slightly clearer, raised glass state and restrained FlowPulse-blue accent, never a border glow. The browser cannot generate a causal narrative from the displayed fields.

## Architecture relation and legend rules

Architecture has no SVG dependency renderer, edge selection, arrowheads, relation pulses, ports, join/split diamonds, or node-to-node lines. Backend relation arrays remain untouched. Runtime connections and animated flow belong to Live; diagnosis may use the bounded incident overlay; detail may summarize safe relation metadata.

The Architecture surface does not render a legend. Four macro modules and the visually separate FlowPulse control surface communicate the system split directly; safe provenance remains bounded backend-projected metadata, never inferred or connected client-side.

## Typography, spacing, and density

- Use the native Apple system stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif`. Use body weights 400-500 and heading weights no heavier than 600.
- Remove visible runtime/kind/layer metadata from Overview and use it only as accessibility meaning or safe inline layer-detail content. Do not use monospace as a default visual texture.
- The sole visible page title is **Architecture**. Remove redundant visible copy such as Observed architecture, Observed System, Data Source Architecture, CAPTURED runtime and data source projection, explanatory paragraphs, metric clusters, and Legend controls that do not improve immediate scanning. Semantic labels remain available through `aria-label` or visually-hidden text.
- System titles, layer counts, controls, and bounded source truth in their owning locations remain readable at 1280x800.
- Prefer deliberate 12-24px internal spacing over artificial empty canvas. Surface depth, alignment, and layer rhythm should help users parse the system before they inspect a layer.
- Details truncate only after retaining a meaningful accessible name. Full safe projected text remains visible within the Client applications cards or through an appropriate run-level drawer in another view.

## Interaction, accessibility, and motion

- Preserve existing navigation and keyboard activation. The Client applications module turns to the inline detail face; non-Architecture and run-level inspection retain their appropriate drawer behavior. Architecture remains structured and calm, never an editable flowchart. Live retains its own graph pan, zoom, route selection, and flow animation behavior unchanged.
- Pointer hover and keyboard focus provide direct, high-contrast feedback. Focus stays visible on layer modules, controls, and menu items in both transparency and fallback modes. Inline child-node cards are static, readable information surfaces rather than hidden interaction targets.
- Click or Enter/Space on Client applications opens the safe inline layer detail using only projected fields. It must not show a right-side component drawer.
- `prefers-reduced-motion: reduce` turns the workspace transition into an immediate or short-opacity state change.
- `prefers-reduced-transparency: reduce` or a no-`backdrop-filter` environment replaces translucent/blurred materials with high-contrast opaque off-white surfaces, essential borders, and the same semantic hierarchy.
- Animations may change only transform and opacity. They must not animate layout geometry, alter reading order, or create decorative perpetual motion.

## Responsive acceptance criteria

### 1440x900

- Both named system boundaries, four observed layer modules, FlowPulse control surface, and current face context are visible without browser zoom; no Architecture metric/Legend strip consumes canvas height.
- Overview shows four macro surfaces with compact thumbnail anatomy for 6/9/3/4 canonical members, zero Architecture edges, and no expanded observed-node grid. Client applications detail shows six readable canonical nodes with their safe direct facts. No count, label, control, or detail card is clipped.
- The material hierarchy is obvious: observed system is the primary workspace; FlowPulse is a separate blue-tinted control surface; inline details are readable without a third face or drawer.

### 1280x800

- The observed/control split remains unmistakable even if the control surface or evidence summary reflows.
- Layer modules compact only within their backend-projected bounds; no title or component count becomes unreadably small.
- Module activation, Back to overview, inline detail, run-level drawer in its owning view, and fallback unavailable state remain keyboard reachable and unclipped.

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
3. Overview contains four macro layers with canonical counts 6/9/3/4, a compact icon-and-label anatomy for each member, zero expanded observed-node grid, zero Architecture edge paths, and zero arrowheads.
4. Client applications detail contains exactly six canonical nodes, no observed node from another layer, and four separately represented FlowPulse nodes. Every node exposes its bounded projected facts inline, with no Architecture component face or component drawer.
5. FlowPulse nodes never render inside observed-system layers; no relation is drawn.
6. Redundant visible labels are absent while accessibility labels retain the observed-system and control-plane meaning. Layer/module focus, Enter/Space activation, Back behavior, inline node detail, and visible focus contrast remain accessible.
7. Reduced-motion and reduced-transparency fallbacks preserve meaning and readability. Architecture material levels differ by alpha and inner highlight only, not cast shadows.
8. No browser console error, failed API request, or raw/sensitive content reaches the page.

Required screenshots:

- Architecture Overview at 1440x900.
- Architecture Client applications detail at 1440x900.
- Architecture Overview at 1280x800.
- Architecture with reduced motion enabled.
- Architecture with reduced transparency or blur fallback enabled.
- Architecture unavailable state proving there is no 6/5 compatibility fallback.

## Reviewable implementation plan

Each step is a separate reviewable commit. Stop after every step for owner review. Do not automatically continue.

1. **Spatial-glass anatomy refinement**: add compact canonical thumbnail anatomy to all four Overview modules; simplify visible hierarchy to one Architecture title; remove the in-canvas metric/Legend toolbar; update typography/material scale; restyle FlowPulse with matching nested glass. Preserve the 420-520ms workspace turn, Back control, and direct inline node facts.
2. **Owner screenshot gate**: review 1440x900 and 1280x800 Overview and Client applications evidence before implementing another detail face.
3. **Deferred layer details**: implement Edge & Commerce, Core Services, and Async, Data & Platform only after explicit owner approval, reusing the validated face transition and canonical layer membership.
4. **Final density pass**: keep all Client applications detail direct and inline; unify it, the FlowPulse side surface, menu, and run-level sidebar under one translucent material system; verify fallback materials, reduced motion/transparency, focus restoration, console/network cleanliness, and no Architecture edge renderer.

The old `b1fefe3` CSS is not an implementation base by default. A future owner-approved implementation may reuse individual safe layout or token mechanics only after confirming that they satisfy this Spatial Glass material hierarchy; otherwise it supersedes them in a new explicit change. Rollback for any new implementation step is its own revert commit. If the work requires a backend contract change, new graph data, authority change, or another-page redesign, stop and return to owner review.

## Owner decisions recorded

- The pilot is Architecture only. Do not scale this system to other pages in this checkpoint.
- The approved material direction is FlowPulse Spatial Glass, not the prior opaque solid-panel direction.
- The product may borrow high-level spatial-interface cues but must not claim native Apple material behavior or copy an Apple product surface.
- Architecture is a layered stack overview, not a connected graph. Live owns connection animation.
- The first implementation sample includes only Overview and Client applications detail. The other three details require a later owner gate.
- Architecture child-node detail appears directly within the Client applications face. There is no third central-workspace face and no duplicate component drawer.
- The remaining owner gate is review of that complete Overview/Client applications sample before any other layer face or page receives the system.
- The approved refinement adds compact Overview anatomy and a simplified visible hierarchy. It does not change any backend contract, graph count, lifecycle state, or non-Architecture page.

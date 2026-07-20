# FlowPulse Spatial Glass architecture visual polish

**Status:** Owner-approved written-design checkpoint. Implementation requires a separate owner approval.

**Branch baseline:** `codex/frontend-architecture-polish` at `890489d8acf1b861905317acab6d0c6c81ff5148`
**Superseded visual implementation:** `b1fefe36849587efb3594c74fce9c791166ff928` is an inspectable solid-panel candidate, not the material direction for future work.
**Scope:** Architecture view only. Light spatial theme only. The existing theme toggle and all non-Architecture views remain behaviorally unchanged.

## Purpose and design read

**FlowPulse Spatial Glass** is a web approximation inspired by the spatial layering, depth, and frosted material cues associated with Apple Vision Pro interfaces. It is not, and must not claim to be, Apple's native Liquid Glass implementation.

The Architecture page must stop reading as a line-art diagram while remaining an honest engineering topology and evidence-control product. Architecture is a static layered technology-stack overview, not a connected graph view. Its central glass workspace has two faces: a high-level layer overview and one selected layer's internal node anatomy. The observed stack must be easy to scan, FlowPulse itself must remain visibly separate, and selected detail must feel elevated without turning the product into a flowchart editor, marketing page, or generic card grid.

This is redesign-preserve work. Existing navigation, canonical backend topology contracts, graph identity and counts, lifecycle logic, node selection, keyboard behavior, drawer behavior, and theme-toggle behavior remain intact. Header, navigation, and source status remain fixed while only the central workspace changes face. The browser remains read-only and does not acquire authority.

## Locked design dials

| Dial | Decision |
| --- | --- |
| Design variance | 5/10: a substantial material and hierarchy refinement, not a new product or graph model |
| Motion intensity | 4/10: only projected state/flow feedback and direct interaction response |
| Visual density | 7/10: both system boundaries and principal topology are useful at the default desktop view |
| Checkpoint theme | Light spatial theme. Do not remove or redesign the existing theme toggle in this checkpoint. |
| Primary accent | FlowPulse blue. Status color remains independent of category color; red means fault only. |
| Material | Frosted matte surfaces, restrained inner highlights, layered translucency, bounded backdrop blur, and soft tinted depth shadows. |
| Prohibited effects | No rainbow or AI-purple mesh gradients, outer neon glow, pure-black shadows, dirty-black panels, glass on every primitive, decorative perpetual motion, or Apple-native implementation claims. |
| Radius system | Page glass 24px; system boundary 20px; node/card 16px; control/menu/input 12px; only status/toggle may be pill-shaped. |

## Current-state audit

The Architecture contract is already semantically correct: `topology_views.architecture` carries 22 runtime/data components and 22 runtime dependencies separately from four FlowPulse control/evidence components and backend-projected cross-boundary relations. The current visual execution nevertheless reads as a line-art sketch for concrete reasons:

1. The dominant primitives are thin gray borders, separator hairlines, and edge strokes. Rendering all 22 dependencies makes Architecture read like an editable graph instead of a technology-stack overview.
2. The observed system and FlowPulse control plane have distinct data boundaries but share nearly the same panel/rule vocabulary. A reader can still mistake the control system for another runtime layer.
3. Compact mono labels, undersized metadata, and glyph-only category cues make 22 components read as technical annotation rather than tangible operational objects.
4. Dependency routes, arrowheads, and selection targets compete with the architectural layers. Those relations belong in Live, diagnosis, and safe detail, not on the Architecture canvas.
5. The large canvas lacks a purposeful depth hierarchy. Empty space is not consistently used to separate systems, layers, routes, and inspection surfaces.
6. The solid-panel shell in `b1fefe3` improves hierarchy but is obsolete: it relies too heavily on opaque surfaces, borders, and shadows instead of the approved material hierarchy below.

The result must be corrected with spatial materials and stronger information hierarchy, without changing graph identity, topology counts, evidence provenance, readiness, or authority semantics.

## Semantic architecture and authority boundary

### Observed System / Data Source Architecture

This is the main workspace and is derived from the 22 backend-projected runtime/data nodes in `topology_views.architecture`. The Overview front groups them into four backend-grounded modules: Experience, Edge & Commerce, Core Services, and Async, Data & Platform. The 22 runtime dependencies remain intact in the backend contract for Live, diagnosis, and safe detail, but Architecture renders no dependency paths, arrows, pulses, or node-to-node lines.

### FlowPulse Control System

This is a separately bounded control surface containing exactly the backend-projected Deployment, Investigator, Evaluator, and Evidence Ledger nodes. It is never presented as a numbered continuation layer of the monitored stack. Its internal and cross-boundary relation counts are summarized only when the backend projection provides them.

### Cross-boundary evidence summary

Cross-boundary relations remain available only if supplied by the backend and evidence-grounded by projection provenance. Architecture summarizes their count and safe metadata in the FlowPulse surface or detail drawer. It does not draw a line through the canvas. The client does not connect FlowPulse to monitored components to make the page look complete.

### Contract and authority invariants

- Architecture consumes only `topology_views.architecture` for graph IDs, labels, kinds, planes, layers, statuses, provenance, and relations.
- Missing, invalid, or unavailable canonical Architecture projection renders the existing bounded unavailable state. It never falls back to the 6/5 incident compatibility graph.
- The browser never infers or authorizes incident state, readiness, risk, approval, repair, receipt, execution, verification, or causal claims.
- Detail content contains only already-projected safe fields. Raw traces, logs, prompts, credentials, and provider payloads remain excluded.
- Count copy remains explicit: **Observed system: 22 components / 22 dependencies retained**; **FlowPulse: 4 control/evidence components**; **Cross-boundary evidence relations: backend-provided count**.

## Central workspace interaction model

The central Architecture glass workspace has two bounded faces. This is local presentation state only and cannot strengthen backend readiness, authority, or source truth.

### Overview front

- Four large glass modules represent Experience, Edge & Commerce, Core Services, and Async, Data & Platform.
- Each module derives its name, membership, count, short responsibility, and representative existing icon glyphs from the canonical Architecture projection and the fixed backend layer contract.
- Observed component node cards are not expanded on Overview. No dependency line or Architecture SVG edge map is present.
- FlowPulse Control System remains an independent glass side surface with the four canonical control/evidence nodes. It is not a fifth layer.
- Clicking or keyboard-activating Experience turns the central workspace to the Experience detail face.

### Experience detail back

- The detail face occupies the same central workspace bounds and material as Overview.
- It renders exactly the six canonical Experience nodes and no observed node from another layer.
- Existing icons and projected label, kind, layer, status, signal type, provenance, and evidence references provide the internal anatomy. The browser adds no causal or authority claims.
- A clear Back to overview control and breadcrumb/context title restore the Overview face.
- Node click, Enter, or Space opens the existing safe detail drawer.
- The other three layer detail faces are explicitly deferred until the owner approves this sample.

### Transition and focus

- A 420-520ms 3D workspace turn communicates moving from overview into a layer. Front and back use proper `backface-visibility` so mirrored text is never visible.
- Only transform and opacity animate. Header, navigation, source status, system counts, and FlowPulse Control System remain spatially fixed.
- Focus moves to the Experience heading or Back control after entering detail and returns to the Experience module after leaving.
- `prefers-reduced-motion: reduce` replaces the turn with a short opacity transition or instant swap.
- Browser history and refresh do not receive a new route in this sample. Face state remains bounded local presentation state.

## Spatial Glass token system

Use Architecture-scoped CSS variables and existing stack primitives. These values describe web materials and fallbacks; they do not pretend to reproduce native Apple materials.

| Token family | Intent | Light spatial rule and fallback |
| --- | --- | --- |
| Spatial background | Establish quiet depth behind the workspace | Cool neutral field with a subtle, low-saturation tonal atmosphere and minimal noise. No multicolor marketing mesh. Fallback is a solid off-white neutral. |
| Page glass | Contain the Architecture workspace | 24px radius; translucent light neutral surface, modest blur, one faint inner highlight, soft blue-gray tinted depth shadow. Fallback uses an opaque off-white surface and normal border contrast. |
| Observed-system matte glass | Make the monitored system the primary plane | 20px radius; slightly denser translucent white/matte surface than the page container, with spacing and depth doing most grouping work. |
| FlowPulse control glass | Distinguish the control plane without treating it as runtime | 20px radius; separate surface with a restrained FlowPulse-blue refraction/tint and slightly higher contrast. The tint never means incident severity. |
| Node/card glass | Make components clear floating objects | 16px radius; higher opacity than boundary surfaces, readable white/light neutral face, limited blur only if the background remains legible, and a restrained local depth shadow. |
| Floating controls | Give menus/toolbar highest interaction priority | 12px radius; highest opacity and contrast among surfaces, solid/translucent fallback, visible focus ring. |
| Detail drawer | Elevate inspection without a dark modal | 16px radius; highest local elevation, readable matte glass, bounded blur, and a stronger but tinted shadow. |
| Text | Preserve readability on translucent material | Near-black primary, dark neutral secondary, WCAG-readable metadata. Never use low-contrast gray text merely to look glassy. |
| Accent and status | Encode intent, not material | FlowPulse blue for selected/active/control treatment. Red=fault only, amber=caution, green=verified recovery. Category color is limited to icon bases or compact glyph detail. |
| Shape scale | Make the system coherent | 24px page, 20px system, 16px node/card, 12px controls, pills only for compact state/toggle. Icon bases are circular or 12px rounded squares. |

Decorative borders and separator hairlines are removed where material contrast, depth, padding, or alignment communicates the grouping more clearly. Borders remain only where needed for contrast, keyboard focus, selected state, or a fallback without transparency.

## Shape consistency and material hierarchy

### Shape rules

- A larger radius means a larger conceptual container. Do not give a node and a system boundary the same silhouette.
- Node, toolbar, drawer, and boundary shapes must use the locked scale. Avoid ad hoc pills and mixed square/rounded corners.
- Icons sit on a circular or 12px rounded-square base. The base identifies category; it cannot imply authority or severity.
- Status/toggle controls may be pill-shaped because their compact state semantics benefit from it. Node cards and system boundaries may not become pills.

### Material hierarchy

The view must retain these levels from back to front:

1. **Spatial background**: quiet cool-neutral depth and minimal texture.
2. **Observed System matte-glass workspace**: the primary architectural field.
3. **FlowPulse Control glass surface**: clearly separate, with a restrained blue refraction/tint.
4. **Floating component nodes**: clearer, higher-opacity objects inside the active layer anatomy.
5. **Floating toolbar and menu controls**: highest operational affordance above the workspace.
6. **Elevated detail drawer**: strongest inspection level, never an opaque black overlay.

Blur is used only on page, system-boundary, control, and drawer surfaces. Node cards use the lowest practical blur or a higher-opacity fallback. Nested high-radius blurs are forbidden. The implementation budget is one full-page spatial background treatment plus bounded, non-overlapping blur surfaces; it must avoid placing a backdrop-filter on every node, edge, or label.

## Page composition and system-boundary hierarchy

At desktop sizes the page has three clear semantic zones:

1. A compact, floating source/status toolbar establishes backend truth and the split system counts.
2. The **Observed System / Data Source Architecture** occupies the largest matte-glass workspace. Its Overview face presents four large layer modules. Its Experience face presents only that layer's six internal nodes.
3. The **FlowPulse Control System** occupies a distinct, spatially fixed side surface. Safe projected cross-boundary evidence is summarized as compact metadata instead of a route.

Runtime dependencies are retained as backend truth but are not drawn in Architecture. Live owns connection animation and runtime flow. The Architecture legend explains layer membership, source truth, retained dependency count, and FlowPulse's separate control role without displaying relation paths.

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

Selection uses a slightly clearer, raised glass state and restrained FlowPulse-blue accent plus existing detail behavior. It never relies on a border glow. The selected node may reveal projected provenance; it cannot generate causal narrative in the browser.

## Architecture relation and legend rules

Architecture has no SVG dependency renderer, edge selection, arrowheads, relation pulses, ports, join/split diamonds, or node-to-node lines. Backend relation arrays remain untouched. Runtime connections and animated flow belong to Live; diagnosis may use the bounded incident overlay; detail may summarize safe relation metadata.

The Architecture legend is text-first and concise:

- Four modules are observed-system architectural layers.
- FlowPulse is a separate control system.
- The runtime dependency count is retained from the canonical backend projection but not drawn here.
- Cross-boundary evidence count and safe provenance metadata are backend-projected and summarized, never inferred or connected client-side.

## Typography, spacing, and density

- Use the current product face for titles, names, navigation, and buttons. Use monospace only for IDs, evidence references, timestamps, and technical values.
- Avoid pervasive uppercase, wide tracking, and 7–9px technical labels. Metadata is 11–12px and must meet readable contrast on every material fallback.
- System titles, count copy, source truth, controls, and legend remain readable at 1280x800.
- Prefer deliberate 12–24px internal spacing over artificial empty canvas. Surface depth, alignment, and layer rhythm should help users parse the system before they inspect a layer.
- Details truncate only after retaining a meaningful accessible name. Full safe projected text remains available through the existing detail behavior.

## Interaction, accessibility, and motion

- Preserve existing navigation, node selection, keyboard activation, and detail drawer behavior. Architecture remains structured and calm, never an editable flowchart. Live retains its own graph pan, zoom, route selection, and flow animation behavior unchanged.
- Pointer hover and keyboard focus provide direct, high-contrast feedback. Focus stays visible on layer modules, nodes, controls, menu items, and legend interactions in both transparency and fallback modes.
- Click or Enter/Space opens the existing safe detail surface using only projected fields.
- `prefers-reduced-motion: reduce` turns the workspace transition into an immediate or short-opacity state change.
- `prefers-reduced-transparency: reduce` or a no-`backdrop-filter` environment replaces translucent/blurred materials with high-contrast opaque off-white surfaces, essential borders, and the same semantic hierarchy.
- Animations may change only transform and opacity. They must not animate layout geometry, alter reading order, or create decorative perpetual motion.

## Responsive acceptance criteria

### 1440x900

- The source/status toolbar, both named system boundaries, four observed layer modules, FlowPulse control surface, legend, and current face context are visible without browser zoom.
- Overview shows no expanded observed node cards. Experience detail shows six readable canonical nodes. No count, label, drawer, or control is clipped.
- The material hierarchy is obvious: observed system is the primary workspace; FlowPulse is a separate blue-tinted control surface; selected detail is elevated.

### 1280x800

- The observed/control split remains unmistakable even if the control surface or evidence summary reflows.
- Layer modules compact only within their backend-projected bounds; no title or component count becomes unreadably small.
- Toolbar, module activation, Back, node selection, drawer, legend, and fallback unavailable state remain keyboard reachable and unclipped.

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
3. Overview contains four layer modules, zero expanded observed nodes, zero Architecture edge paths, and zero arrowheads.
4. Experience detail contains exactly six canonical Experience nodes, no observed node from another layer, and four separately represented FlowPulse nodes.
5. FlowPulse nodes never render inside observed-system layers; no relation is drawn.
6. Layer/module and node focus, Enter/Space activation, Back behavior, drawer content, and visible focus contrast remain accessible.
7. Reduced-motion and reduced-transparency fallbacks preserve meaning and readability.
8. No browser console error, failed API request, or raw/sensitive content reaches the page.

Required screenshots:

- Architecture Overview at 1440x900.
- Architecture Experience detail at 1440x900.
- Architecture selected Experience node and detail drawer at 1440x900.
- Architecture Overview at 1280x800.
- Architecture with reduced motion enabled.
- Architecture with reduced transparency or blur fallback enabled.
- Architecture unavailable state proving there is no 6/5 compatibility fallback.

## Reviewable implementation plan

Each step is a separate reviewable commit. Stop after every step for owner review. Do not automatically continue.

1. **Overview plus Experience sample**: supersede the rejected connected-graph canvas with the complete Spatial Glass Overview front, Experience detail back, fixed FlowPulse side surface, 420-520ms workspace turn, Back control, node selection, toolbar, legend, and drawer treatment. Preserve canonical backend data and non-Architecture behavior.
2. **Owner screenshot gate**: review 1440x900 and 1280x800 Overview, Experience, and selected-node evidence before implementing another detail face.
3. **Deferred layer details**: implement Edge & Commerce, Core Services, and Async, Data & Platform only after explicit owner approval, reusing the validated face transition and canonical layer membership.
4. **Final density and accessibility pass**: verify fallback materials, reduced motion/transparency, focus restoration, console/network cleanliness, and no Architecture edge renderer.

The old `b1fefe3` CSS is not an implementation base by default. A future owner-approved implementation may reuse individual safe layout or token mechanics only after confirming that they satisfy this Spatial Glass material hierarchy; otherwise it supersedes them in a new explicit change. Rollback for any new implementation step is its own revert commit. If the work requires a backend contract change, new graph data, authority change, or another-page redesign, stop and return to owner review.

## Owner decisions recorded

- The pilot is Architecture only. Do not scale this system to other pages in this checkpoint.
- The approved material direction is FlowPulse Spatial Glass, not the prior opaque solid-panel direction.
- The product may borrow high-level spatial-interface cues but must not claim native Apple material behavior or copy an Apple product surface.
- Architecture is a layered stack overview, not a connected graph. Live owns connection animation.
- The first implementation sample includes only Overview and Experience detail. The other three details require a later owner gate.
- The remaining owner gate is review of that complete Overview/Experience sample before any other layer face or page receives the system.

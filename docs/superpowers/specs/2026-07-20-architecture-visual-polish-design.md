# FlowPulse Spatial Glass architecture visual polish

**Status:** Owner-approved written-design checkpoint. Implementation requires a separate owner approval.

**Branch baseline:** `codex/frontend-architecture-polish` at `890489d8acf1b861905317acab6d0c6c81ff5148`
**Superseded visual implementation:** `b1fefe36849587efb3594c74fce9c791166ff928` is an inspectable solid-panel candidate, not the material direction for future work.
**Scope:** Architecture view only. Light spatial theme only. The existing theme toggle and all non-Architecture views remain behaviorally unchanged.

## Purpose and design read

**FlowPulse Spatial Glass** is a web approximation inspired by the spatial layering, depth, and frosted material cues associated with Apple Vision Pro interfaces. It is not, and must not claim to be, Apple's native Liquid Glass implementation.

The Architecture page must stop reading as a line-art diagram while remaining an honest engineering topology and evidence-control product. It should feel like a finished digital-twin control surface: the observed stack is easy to scan, FlowPulse itself is visibly separate, evidence-backed relations are legible, and selected detail feels elevated without turning the product into a flowchart editor, marketing page, or generic card grid.

This is redesign-preserve work. Existing navigation, canonical backend topology contracts, graph identity and counts, lifecycle logic, selection, pan/zoom, keyboard behavior, drawer behavior, and theme-toggle behavior remain intact. The browser remains read-only and does not acquire authority.

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

1. The dominant primitives are thin gray borders, separator hairlines, and edge strokes. They establish adjacency but not surface, priority, or ownership.
2. The observed system and FlowPulse control plane have distinct data boundaries but share nearly the same panel/rule vocabulary. A reader can still mistake the control system for another runtime layer.
3. Compact mono labels, undersized metadata, and glyph-only category cues make 22 components read as technical annotation rather than tangible operational objects.
4. Edges visually compete with cards rather than receding behind them. Their routing, labels, and group boundaries can make the topology feel like a wireframe instead of a spatial workspace.
5. The large canvas lacks a purposeful depth hierarchy. Empty space is not consistently used to separate systems, layers, routes, and inspection surfaces.
6. The solid-panel shell in `b1fefe3` improves hierarchy but is obsolete: it relies too heavily on opaque surfaces, borders, and shadows instead of the approved material hierarchy below.

The result must be corrected with spatial materials and stronger information hierarchy, without changing graph identity, topology counts, evidence provenance, readiness, or authority semantics.

## Semantic architecture and authority boundary

### Observed System / Data Source Architecture

This is the main workspace and contains exactly the 22 backend-projected runtime/data nodes and 22 runtime dependency edges from `topology_views.architecture`. Backend-projected plane, layer, kind, status, provenance, and relation metadata organize the system. It is the monitored stack, not FlowPulse.

### FlowPulse Control System

This is a separately bounded control surface containing exactly the backend-projected Deployment, Investigator, Evaluator, and Evidence Ledger nodes. It is never presented as a numbered continuation layer of the monitored stack. Its internal relations render only when the backend projection provides them.

### Cross-boundary evidence relations

Cross-boundary relations render only if supplied by the backend and evidence-grounded by projection provenance. The client does not connect FlowPulse to every monitored component to make the page look complete. The projected deployment-to-checkout relation is an example, not permission to create generic arrows.

### Contract and authority invariants

- Architecture consumes only `topology_views.architecture` for graph IDs, labels, kinds, planes, layers, statuses, provenance, and relations.
- Missing, invalid, or unavailable canonical Architecture projection renders the existing bounded unavailable state. It never falls back to the 6/5 incident compatibility graph.
- The browser never infers or authorizes incident state, readiness, risk, approval, repair, receipt, execution, verification, or causal claims.
- Detail content contains only already-projected safe fields. Raw traces, logs, prompts, credentials, and provider payloads remain excluded.
- Count copy remains explicit: **Observed system: 22 components / 22 dependencies**; **FlowPulse: 4 control/evidence components**; **Cross-boundary evidence relations: backend-provided count**.

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
4. **Floating component nodes**: clearer, higher-opacity objects above routes.
5. **Floating toolbar and menu controls**: highest operational affordance above the workspace.
6. **Elevated detail drawer**: strongest inspection level, never an opaque black overlay.

Blur is used only on page, system-boundary, control, and drawer surfaces. Node cards use the lowest practical blur or a higher-opacity fallback. Nested high-radius blurs are forbidden. The implementation budget is one full-page spatial background treatment plus bounded, non-overlapping blur surfaces; it must avoid placing a backdrop-filter on every node, edge, or label.

## Page composition and system-boundary hierarchy

At desktop sizes the page has three clear semantic zones:

1. A compact, floating source/status toolbar establishes backend truth and the split system counts.
2. The **Observed System / Data Source Architecture** occupies the largest matte-glass workspace. Backend-projected runtime/data groups organize the 22 nodes and their dependencies without hiding the spatial graph.
3. The **FlowPulse Control System** occupies a distinct control surface or sidecar. A sparse cross-boundary evidence rail can sit between or adjacent to the surfaces when the viewport permits.

Runtime dependencies remain entirely within the observed-system surface. FlowPulse internal/control relations remain inside the control surface. Cross-boundary evidence/control relations alone cross between them. The legend is concise and explains those three relation categories plus backend source truth.

At 1440px, the two boundaries and principal topology are visible without browser zoom. At 1280px, the control surface may reposition below or beside the observed workspace, but it must preserve its independent boundary, readable title, and explicit relation rail.

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

Selection uses a high-contrast FlowPulse-blue outline or inset ring plus existing detail behavior. It never relies on glow. The selected node may reveal a projected relation label or provenance affordance; it cannot generate causal narrative in the browser.

## Relation routing, selection, state, and legend

Graph edges remain semantically necessary. The visual goal is to move them behind component cards and make them read as an engineered flow rather than foreground sketch marks.

| Relation class | Default rendering | Selected/state rendering | Legend copy |
| --- | --- | --- |
| Runtime dependency | 1.5–2px translucent cool gray/blue route, smooth Bezier or rounded orthogonal geometry, compact arrowhead, inside Observed System | Selected path becomes higher contrast; pulse only for actual projected flow/state transition | Runtime dependency |
| FlowPulse internal/control | Quiet FlowPulse blue-gray route, inside the control surface | Higher contrast only when selected or backend state requires it | FlowPulse control relation |
| Cross-boundary evidence/control | Sparse FlowPulse-blue route with provenance affordance, crossing only between the two surfaces | Label shown because the relation is important; no invented action implication | Evidence-grounded cross-boundary relation |
| Fault path | Runtime route remains semantically same | Restrained red state after a projected fault, never a category color | Projected fault state |

- Routes must avoid node cards, toolbar controls, titles, labels, ports, and text. Compact arrowheads point in the backend-projected relation direction.
- Ordinary labels stay hidden. Labels appear only for a selected relation or an important cross-boundary relation.
- A small restrained diamond may represent a backend-projected join/split only when necessary. It is not a decorative hub.
- Fast repeated electronic pulses may travel along a rendered relation only when a projected flow/state transition requires it. The motion uses transform, opacity, or stroke effects, not layout geometry.
- Reduced motion removes pulses and transition movement while retaining route, selected state, fault state, and label meaning.

## Typography, spacing, and density

- Use the current product face for titles, names, navigation, and buttons. Use monospace only for IDs, evidence references, timestamps, and technical values.
- Avoid pervasive uppercase, wide tracking, and 7–9px technical labels. Metadata is 11–12px and must meet readable contrast on every material fallback.
- System titles, count copy, source truth, controls, and legend remain readable at 1280x800.
- Prefer deliberate 12–24px internal spacing over artificial empty canvas. Surface depth, alignment, and routes should help users parse the system before they zoom.
- Details truncate only after retaining a meaningful accessible name. Full safe projected text remains available through the existing detail behavior.

## Interaction, accessibility, and motion

- Preserve existing pan, zoom, fit/reset, node/edge selection, keyboard activation, and detail drawer behavior. Architecture remains structured and calm, never an editable flowchart.
- Pointer hover and keyboard focus provide direct, high-contrast feedback. Focus stays visible on nodes, edges, controls, menu items, and legend interactions in both transparency and fallback modes.
- Click or Enter/Space opens the existing safe detail surface using only projected fields.
- `prefers-reduced-motion: reduce` turns pulses and material transitions into immediate/static states.
- `prefers-reduced-transparency: reduce` or a no-`backdrop-filter` environment replaces translucent/blurred materials with high-contrast opaque off-white surfaces, essential borders, and the same semantic hierarchy.
- Animations may change only transform, opacity, or stroke. They must not animate graph layout geometry, alter reading order, or create decorative perpetual motion.

## Responsive acceptance criteria

### 1440x900

- The source/status toolbar, both named system boundaries, principal 22-node observed topology, FlowPulse control surface, legend, and current selected detail state are visible without browser zoom.
- Node titles and metadata remain readable, routes do not run through cards/titles/controls, and no count, label, drawer, or control is clipped.
- The material hierarchy is obvious: observed system is the primary workspace; FlowPulse is a separate blue-tinted control surface; selected detail is elevated.

### 1280x800

- The observed/control split remains unmistakable even if the control surface or evidence rail reflows.
- Runtime groups compact only within their backend-projected bounds; no node becomes unreadably small and no relation crosses title or card text.
- Toolbar, pan/zoom, selection, drawer, legend, and fallback unavailable state remain keyboard reachable and unclipped.

## Architecture-only non-goals

- Do not redesign Live, Diagnose, Agent Control, Recovery, Compare, demo lifecycle, or backend state.
- Do not add client-side authority, readiness, lifecycle, or graph inference.
- Do not add a graph framework, animation package, font package, icon package, custom decorative SVG system, or native-platform claim.
- Do not change topology contracts, counts, data provenance, theme toggle behavior, or backend APIs.
- Do not invent nodes, runtime dependencies, cross-boundary arrows, incident paths, production telemetry, or live-source claims.

## Acceptance tests and screenshot checklist

Implementation review must show:

1. Architecture renders only the valid canonical projection and keeps the 22 runtime/data + 22 runtime dependency + four FlowPulse split.
2. The client does not use `source.topology` as an Architecture fallback.
3. Every rendered relation endpoint exists and follows backend-projected boundary classification.
4. FlowPulse nodes never render inside observed-system layers; no unprojected relation is drawn.
5. Node/edge focus, Enter/Space selection, drawer content, and visible focus contrast remain accessible.
6. Reduced-motion and reduced-transparency fallbacks preserve meaning and readability.
7. No browser console error, failed API request, or raw/sensitive content reaches the page.

Required screenshots:

- Architecture initial at 1440x900.
- Architecture selected runtime node at 1440x900.
- Architecture selected cross-boundary evidence relation at 1440x900.
- Architecture initial at 1280x800.
- Architecture with reduced motion enabled.
- Architecture with reduced transparency or blur fallback enabled.
- Architecture unavailable state proving there is no 6/5 compatibility fallback.

## Reviewable implementation plan

Each step is a separate reviewable commit. Stop after every step for owner review. Do not automatically continue.

1. **Complete Architecture style sample**: replace the obsolete solid-panel shell with the complete Spatial Glass composition for Architecture: spatial background, page/workspace material, two system boundaries, representative node/card material, toolbar, legend, and drawer treatment. It must be reviewable at 1440x900 and 1280x800; it is not a half-styled token-only pass. Preserve graph IDs, layout behavior, backend data, and interactions.
2. **Node taxonomy and focus pass**: apply existing component icon mappings to consistent icon bases, title/metadata scale, selected treatment, and keyboard/focus regression coverage.
3. **Relation material pass**: style only backend-projected runtime, control, and cross-boundary relations with their distinct route, arrowhead, selection, and legend treatment. Add endpoint/category/no-invention regression tests.
4. **Density, state, and motion pass**: resolve overlap/reflow at both desktop targets, apply only motivated projected relation pulse/fault treatment, and verify reduced-motion/reduced-transparency behavior.
5. **Review/polish pass**: run frontend/server regressions, audit console/network behavior and blur performance, inspect the full diff against `890489d`, and prepare an Architecture-only commit series for owner approval.

The old `b1fefe3` CSS is not an implementation base by default. A future owner-approved implementation may reuse individual safe layout or token mechanics only after confirming that they satisfy this Spatial Glass material hierarchy; otherwise it supersedes them in a new explicit change. Rollback for any new implementation step is its own revert commit. If the work requires a backend contract change, new graph data, authority change, or another-page redesign, stop and return to owner review.

## Owner decisions recorded

- The pilot is Architecture only. Do not scale this system to other pages in this checkpoint.
- The approved material direction is FlowPulse Spatial Glass, not the prior opaque solid-panel direction.
- The product may borrow high-level spatial-interface cues but must not claim native Apple material behavior or copy an Apple product surface.
- The remaining owner gate is review of the complete first Architecture style sample before node/relation/motion follow-up work begins.

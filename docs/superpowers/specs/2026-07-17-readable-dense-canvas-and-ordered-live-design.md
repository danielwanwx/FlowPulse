# Readable Dense Canvas and Ordered Live Signal Design

Date: 2026-07-17  
Status: Approved for implementation

## Goal

Make every FlowPulse surface easier to read, make Architecture use the canvas deliberately, and make Live traffic explain one causal route at a time without changing backend truth or topology.

## Scope

- Increase small UI text through a restrained shared typography scale.
- Replace the forced Architecture pyramid silhouette with a compact, deterministic block wall that preserves semantic tiers.
- Reconstruct Live signal motion as one ordered edge activation at a time.
- Fit the complete observed Live topology inside the default canvas at 1440x900 and 1280x800.
- Preserve current component identities, evidence provenance, drawers, themes, reduced motion, and all runtime APIs.

No backend, telemetry, evidence, incident-fact, integration, or external-action changes are permitted.

## Typography

Body copy remains 14px. Text currently below practical dashboard readability is raised by role:

- Component titles: 12-13px in Architecture; at least 11px elsewhere.
- Component metadata and status: 8-10px.
- Toolbar, menu, timeline, drawer, Manager, and Recovery Console supporting text: generally +1-2px, without scaling container geometry blindly.
- Monospace provenance labels may remain smaller than body text, but no primary decision or control label may depend on text below 8px.

Long names keep ellipsis or a controlled two-line title; increasing text must not cause card clipping.

## Architecture block wall

Architecture remains line-free and keeps the four authoritative semantic tiers. Each tier is a deterministic, centered row of touching cards, but the rows no longer need to form a pyramid. Card width is responsive within a bounded range and the widest tier defines the visual mass.

- Shared borders overlap by one pixel; there is no visible inter-card gap.
- Cards grow to approximately 106-124px wide and 72-78px tall so the widest authoritative tier remains fully visible.
- The label rail and cards together occupy roughly 65-90% of the available canvas width and at least 40% of its useful height at target desktop sizes.
- The wall is vertically centered with limited padding; unused whitespace is distributed around the system rather than concentrated above it.
- At narrower widths the wall scales down as a unit before horizontal clipping is allowed.

## Ordered Live signal state machine

Live uses the existing authoritative dependency set and deterministic pulse-slot ordering. Exactly one edge is active at a time:

1. `idle`: all paths and components use their quiet state.
2. `launch`: the source component briefly highlights.
3. `transit`: one compact, water-drop-like monochrome signal with a short fading tail travels from source port to target port; no full-route trace is revealed or retained.
4. `arrival`: the animation samples the SVG path through its exact final point before the target component acknowledges it with a brief elevation shadow rather than a border flash.
5. `decay`: source, target, path, and pulse return to quiet state.
6. Advance to the next edge in deterministic topology order.

No two path activations may overlap. When the target has an unvisited outgoing dependency, it becomes the next source so the signal visibly hands off through a causal chain; only after a branch ends does traversal resume at the next deterministic root/branch. Live traffic animation is deliberately monochrome: black on the light canvas and bright white on the pure-black canvas. Semantic red, amber, and green remain available for persistent incident, change, and verification state, but they do not color the transient Live pulse. Connectors use rounded collision-safe orthogonal bends, matching the visual clarity of Diagnose without changing authoritative endpoints. Reduced motion removes travel animation and shows a stable endpoint acknowledgement.

## Header hierarchy

The global header owns product, workspace, source, and theme status. The mode row exposes only the five Digital Twin modes; its duplicate left page title and right source/stage readout remain available to assistive technology but are not presented as competing visual headings. The canvas toolbar owns the current view title, caption, metrics, zoom, and legend.

## Default Live framing

The Live world remains zoomable and pannable, but initial entry, reload, and reset compute a contain fit from the current canvas size and the fixed Live world. The full graph is visible by default with a small safety inset. Manual zoom or pan is preserved until the user resets or leaves and re-enters Live.

The fit must not invent dependencies or change the routing model. All observed components, including explicit evidence-gap islands, remain inside the default viewport.

## Responsive and accessibility behavior

- Validate at 1440x900 and 1280x800.
- Every Architecture and Live component must stay fully visible after the default transition settles.
- Focus rings, accessible component names, directional edge names, dark-theme contrast, and reduced-motion behavior remain intact.
- Semantic type must continue to be conveyed by vector icon and text, not color alone.

## Acceptance checks

- Architecture component title computes to at least 12px at 1440x900 and 1280x800.
- Architecture uses at least 60% of canvas width and has no horizontal or vertical gaps between cards within a tier boundary.
- Live entry shows every observed component without user dragging.
- Live components have a visible gap and no overlap at target viewports.
- Live signal order is stable across reloads.
- At most one edge has the active signal class at any instant.
- Source highlight precedes target highlight; the target never highlights before the pulse completes; active trace and pulse extinguish before the next edge activates.
- The signal body reaches `getPointAtLength(totalLength)` before arrival state is applied; a short local tail may follow it, but no full connector receives an active highlight.
- Live signal body and short tail compute to black in light mode and bright white in pure-black mode.
- Node acknowledgement changes elevation/shadow without changing the complete card border color.
- No component overlap or label clipping at target viewports.
- Browser console has zero errors and warnings.
- Existing runtime, ledger, harness, and replay tests remain green.

## Stop conditions

Success requires passing the acceptance checks, committing the implementation, leaving the standalone worktree clean, and keeping the final page open on port 4310. Stop only if the requested fit would require hiding components, inventing topology, or changing backend scope.

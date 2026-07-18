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
- Cards grow to approximately 144-156px wide and 64-70px tall when space permits.
- The overall wall occupies roughly 65-75% of the available canvas width and at least 45% of its useful height at target desktop sizes.
- The wall is vertically centered with limited padding; unused whitespace is distributed around the system rather than concentrated above it.
- At narrower widths the wall scales down as a unit before horizontal clipping is allowed.

## Ordered Live signal state machine

Live uses the existing authoritative dependency set and deterministic pulse-slot ordering. Exactly one edge is active at a time:

1. `idle`: all paths and components use their quiet state.
2. `launch`: the source component briefly highlights.
3. `transit`: the entire selected path lights with its semantic tone while one pulse segment travels from source to target.
4. `arrival`: the target component acknowledges the pulse while the path remains lit.
5. `decay`: source, target, path, and pulse return to quiet state.
6. Advance to the next edge in deterministic topology order.

No two path activations may overlap. Incident paths use red, verified recovery paths green, and healthy observed traffic blue. Reduced motion removes travel animation but shows one stable route and its endpoints.

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
- Live signal order is stable across reloads.
- At most one edge has the active signal class at any instant.
- Source highlight precedes target highlight; active edge and pulse extinguish before the next edge activates.
- Active edge color matches observed, impact, or verified semantic state.
- No component overlap or label clipping at target viewports.
- Browser console has zero errors and warnings.
- Existing runtime, ledger, harness, and replay tests remain green.

## Stop conditions

Success requires passing the acceptance checks, committing the implementation, leaving the standalone worktree clean, and keeping the final page open on port 4310. Stop only if the requested fit would require hiding components, inventing topology, or changing backend scope.

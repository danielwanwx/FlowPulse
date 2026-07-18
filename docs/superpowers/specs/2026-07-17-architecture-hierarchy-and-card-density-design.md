# Architecture hierarchy and card density refinement

## Goal

Make the Architecture view readable as a layered system at both the judge viewport and the narrow in-app browser while removing card copy that does not help identify a component.

## Bounded design

- Preserve the four deterministic Architecture tiers and their current OTLP-derived membership.
- Render each tier as a compact group with an always-visible numbered divider, label, and component count.
- Keep Architecture line-free. Layer boundaries communicate structure; Live remains the dependency view.
- Architecture cards show only business capability, real component name, a concise observed runtime summary when space permits, and the realtime status dot.
- Remove repeated `service.name=<id>` text from cards. The complete service identity, language, signals, topology neighbors, evidence IDs, hashes, and offsets remain in the contextual drawer.
- At narrow widths, use a wrapping shared-border grid, retain every tier label, hide the optional runtime summary, and fit the Architecture canvas without horizontal panning.

## Checks

- Four tier labels remain visible below 1080px.
- No Architecture card repeats its visible component name as `service.name`.
- Architecture has no connector markup.
- Cards remain keyboard-selectable and preserve evidence-grounded accessible names and status dots.
- Automated tests pass, browser console is clean, and the narrow visible page shows every layer as a distinct group.

## Stop conditions

Stop when the hierarchy is visually legible, the narrow canvas no longer requires horizontal panning, the evidence drawer retains full detail, tests pass, and the worktree is committed and clean. Do not change backend topology, OTLP authority, Live routing, or incident semantics.

## QA record

- Default visible viewport (619×859): four tier labels and 22 status-bearing components are visible; the 595×520 stack fits inside the 619×528 canvas with no horizontal overflow.
- 1280×800 and 1440×900: the complete 22-component stack is contained with zero node overlaps.
- Card copy contains no repeated `service.name`; the concise runtime summary remains available on wide viewports and the complete identity remains in the evidence drawer.
- Browser console: zero errors and zero warnings.
- Screenshot: `docs/qa/architecture-layered-density.jpg`.

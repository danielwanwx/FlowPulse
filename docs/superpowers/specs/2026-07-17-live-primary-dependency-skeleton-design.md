# Live primary dependency skeleton

## Goal

Make Live read like the Diagnose graph: a small, deterministic set of clear service handoffs instead of every observed dependency drawn at once.

## Decision

- Keep the complete OTLP-derived topology as runtime authority and use it for metrics, evidence, and node upstream/downstream details.
- Render a deterministic primary-path subset on the Live canvas. Each target prefers one closest upstream dependency; a minimal coverage pass keeps every component that has observed dependencies attached to the visible skeleton.
- Pulse only the visible primary paths. Do not invent a bus, merge unrelated dependencies, or change causal direction.
- Label the compression explicitly as `primary paths shown` while retaining the full observed dependency count.

## Checks

- Reordering the same nodes or edges produces the same visible edge IDs.
- Every visible edge exists in the authoritative topology.
- Every component with at least one authoritative dependency remains incident to a visible edge.
- The visible edge count is lower than the authoritative count when redundant fan-in exists.
- Full upstream and downstream dependency lists remain available in the contextual drawer.

## QA record

- Automated suite: 45/45 passing.
- Visible Live state: 21 nodes, 23 authoritative dependencies, 15 primary paths rendered, and one sequential active signal.
- Layout: zero component overlaps; every card retains an accessible name.
- Browser console: zero warnings and zero errors.
- Screenshot: `docs/qa/live-primary-dependency-skeleton.jpg`.

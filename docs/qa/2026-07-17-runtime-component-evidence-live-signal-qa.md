# Runtime component evidence and Live signal QA

## Browser QA — 1440×900

- Architecture: 21 real OTLP-observed components rendered in four business layers. Cards expose manager-facing capability plus actual `service.name`, observed runtime language when present, and signal types.
- Architecture geometry: the compact stack fits the viewport; adjacent block borders intentionally meet. All 21 component identities remain selectable and complete in their accessible names.
- Live: 21 nodes and 22 authoritative dependencies; 0 invalid endpoints, 0 node overlaps, and 0 nodes outside the viewport. Five source components remain honestly labeled as evidence gaps because the current trace window has no observed dependency edge for them.
- Signal: one active signal at a time, 2.6-unit core, cyan halo on light and near-white halo on pure black. Sampled route duration/path ratios stayed between 2.225 and 2.233 ms per SVG unit, confirming proportional constant-speed travel; the final 16% decelerates into the target.
- Incident chrome: hidden for the captured/replay run shown in Live. Deterministic state tests verify it appears only for an unresolved real-development incident and disappears after passed verification.
- Checkout drawer: 17 component-scoped OTLP records in the inspected window, with actual log bodies, span names, trace IDs, upstream Frontend, six downstream services, `service.name=checkout`, Go runtime metadata, evidence IDs, file names, byte ranges, and SHA-256 citations.
- Browser console: 0 errors and 0 warnings.

## Automated checks

- `npm test`: 44 tests expected after this refinement, including proportional signal timing, terminal deceleration, active-incident gating, and source-scoped drawer/provenance coverage.

## Screenshots

- `architecture-business-runtime-1440x900.jpg`
- `live-bright-constant-speed-signal-1440x900.jpg`
- `checkout-real-evidence-drawer-1440x900.jpg`

## Real vs captured

- Real: current OpenTelemetry Collector JSONL projection, service/resource attributes, live component set, trace-derived dependencies, logs, spans, metrics, timestamps, hashes, and capture byte offsets.
- Captured/deterministic: the canonical Astronomy Shop diagnosis ledger and replay stages. This iteration did not trigger a new failure in the running local shop; real-development impact coloring remains exercised by the existing development-runtime integration test and evidence-grounded state test.

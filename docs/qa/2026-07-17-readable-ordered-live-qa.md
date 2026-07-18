# Readable Canvas and Ordered Live QA

Date: 2026-07-17

## Automated checks

- `npm test`: 41/41 passing.
- Deterministic signal order is covered by `orderedSignalEdges` tests.
- Rounded connector output, boundary termination, non-endpoint card avoidance, contain fit, theme contrast, and sequential timing hooks are covered by focused state/UI tests.

## Visible browser checks

The latest standalone FlowPulse app was verified at `http://127.0.0.1:4310/` against the live local OTLP projection.

| Check | 1280x800 | 1440x900 |
| --- | --- | --- |
| Complete Live graph visible by default | Pass, 83% contain fit | Pass, 94% contain fit |
| Observed components outside canvas | 0 | 0 |
| Component overlaps | 0 | 0 |
| Component title size | 12px | 12px |
| Concurrent active Live edges | Maximum 1 | Maximum 1 |

Sequential sampling across a complete route confirmed: source launch, progressive trace dash offset from approximately `0.95` to `0`, target arrival only after completion, decay, then the next route. Light mode computed both pulse and trace as `rgb(11, 11, 12)`; pure-black mode computed both as `rgb(245, 245, 245)`. Browser diagnostic logs returned zero errors and zero warnings.

## Captures

- `readable-architecture-1280.png`: compact line-free authoritative architecture wall.
- `ordered-live-pulse-light.png`: fitted light Live topology with black active route.
- `ordered-live-pulse-dark.png`: fitted pure-black Live topology with white active route and high-contrast component edges.

## Runtime truth

The browser showed the current local `Live OTLP` source (21-22 observed services during sampling, depending on current collector freshness) and authoritative dependency projection. The visual ordering and pulse animation are deterministic UI projections; they do not invent telemetry, dependencies, remediation, or incident evidence.

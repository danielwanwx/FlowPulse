# Readable Canvas and Ordered Live QA

Date: 2026-07-17

## Automated checks

- `npm test`: 41/41 passing.
- Deterministic signal order is covered by `orderedSignalEdges` tests.
- Rounded connector output, boundary termination, non-endpoint card avoidance, contain fit, theme contrast, exact SVG path sampling, and causal handoff hooks are covered by focused state/UI tests.

## Visible browser checks

The latest standalone FlowPulse app was verified at `http://127.0.0.1:4310/` against the live local OTLP projection.

| Check | 1280x800 | 1440x900 |
| --- | --- | --- |
| Complete Live graph visible by default | Pass, 83% contain fit | Pass, 94% contain fit |
| Observed components outside canvas | 0 | 0 |
| Component overlaps | 0 | 0 |
| Component title size | 12px | 12px |
| Concurrent active Live edges | Maximum 1 | Maximum 1 |

Sequential sampling across complete routes confirmed the droplet advancing through `0.995` progress before target arrival, then handing off directly from `cart` to `cart → flagd`. The animation now positions its final frame with `getPointAtLength(totalLength)` and paints it once before arrival state is applied. The selected connector stays at its quiet `0.35` opacity and `1.45px` width; only the compact signal body and two short tail particles move.

Light mode computed the droplet as `rgb(11, 11, 12)`; pure-black mode computed it as `rgb(245, 245, 245)`. During arrival the component border remained the unchanged `rgba(11, 11, 12, 0.11)` while elevation changed to a stronger shadow and approximately `1.011` scale. The duplicate mission title and stage/source readout are visually suppressed while remaining accessible; the mode switch is the only visible content in that row. Browser diagnostic logs returned zero errors and zero warnings.

## Captures

- `readable-architecture-1280.png`: compact line-free authoritative architecture wall.
- `ordered-live-pulse-light.png`: fitted light Live topology with black active route.
- `ordered-live-pulse-dark.png`: fitted pure-black Live topology with white active route and high-contrast component edges.
- `live-water-drop-1440.png`: simplified header and compact monochrome water-drop signal without a retained active route.

## Runtime truth

The browser showed the current local `Live OTLP` source (21-22 observed services during sampling, depending on current collector freshness) and authoritative dependency projection. The visual ordering and pulse animation are deterministic UI projections; they do not invent telemetry, dependencies, remediation, or incident evidence.

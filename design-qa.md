# Design QA

Date: 2026-07-17
Target: `http://127.0.0.1:4310/`
Viewport captured: 1280 x 720; prior target coverage retained at 1440 x 900 and 1280 x 800
State coverage: real Live OTLP, deterministic propagation, root cause, owner gate, recovery, and Compare

## Visual truth

- Selected source direction: Production Workspace option A.
- Same-input comparison: `docs/qa/production-workspace-source-comparison.png`.
- Final implementation: `docs/qa/production-workspace-live-otlp.png`.
- Replay and comparison evidence: the `production-workspace-*.png` set in `docs/qa`.

## Mandatory checks

| Surface | Result | Evidence |
| --- | --- | --- |
| Product framing | Passed | Generic `Production system map` is the H1; the incident is contextual rather than the product identity. |
| Typography | Passed | Near-black hierarchy remains readable without terminal-heavy styling. |
| Layout | Passed | All 22 observed services fit as complete, non-overlapping plaques in the 1280 x 720 Live viewport. |
| Components | Passed | Phosphor vectors distinguish clients, services, APIs, streams, workers, and control-plane roles without relying on color. |
| Source truth | Passed | `Live OTLP`, freshness, observed counts, hashed capture, and replay labels are derived from runtime state. |
| Interaction | Passed | Live, Replay, timeline seeking, drawer navigation, owner gate, recovery, and Compare were exercised. |
| Accessibility | Passed | Named controls, status text, visible focus treatment, non-color labels, and reduced-motion CSS are present. |
| Browser runtime | Passed | Console reported 0 errors and 0 warnings after the final Live capture. |

## Source comparison review

The implementation preserves the selected source hierarchy: stable product bar, generic system-map heading, source badge, canvas-first composition, incident context, and progressive detail. It intentionally adds denser production evidence, replay controls, and owner/evaluator state because those are core FlowPulse functions. Surfaces remain white, structural lines neutral, and color is localized to vector icons, semantic beacons, and pulses.

## Honest limitations

- The real local topology is projected from the latest bounded OTLP JSONL window, not a general telemetry warehouse.
- The complex Kafka-causality case remains the deterministic captured judge replay; the live case makes only the checkout/payment claim supported by observed local evidence.
- The browser environment exposed 1280 x 720 for the final real-data capture; the earlier 1280 x 800 and 1440 x 900 checks remain in the QA set.

final result: passed

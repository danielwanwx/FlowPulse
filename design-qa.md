# Design QA

Date: 2026-07-17  
Target: `http://127.0.0.1:4310/`  
Viewport coverage: 1440 x 900 and 1280 x 800  
State coverage: captured Live, Replay propagation, Replay owner gate, and Compare

## Visual truth

- User reference: `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-adc83c1e-d650-4ae0-a49c-a27251e8c6ce.png`
- Full comparison: `docs/qa/monochrome-reference-comparison.png`
- Focused comparison: `docs/qa/monochrome-node-detail-comparison.png`
- Implementation evidence: `docs/qa/monochrome-beacon-propagation.png`

## Mandatory surface checks

| Surface | Result | Evidence |
| --- | --- | --- |
| Typography | Passed | Near-black hierarchy remains readable without uppercase-heavy terminal treatment. |
| Spacing and layout | Passed | Shared deterministic geometry remains stable; zero within-layer node intersections at both target viewports. |
| Colors and tokens | Passed | Canvas, modules, annotations, and evidence surfaces are pure white; structure is neutral black/gray; state color is localized to semantic beacons and moving signals. |
| Image assets | Passed | No imported visual assets or decorative raster dependencies were introduced. |
| Copy and content | Passed | Evidence IDs, status labels, metrics, causal notes, owner gate, and captured-live disclosure remain unchanged and reachable. |
| Interaction | Passed | Live, Replay, Compare, timeline seeking, node selection, and compare split remain operable. |
| Accessibility | Passed | Status text accompanies every beacon; component shapes do not rely on color; focus names remain intact; reduced-motion disables semantic pulse animation. |

## Comparison history

1. Replaced colored module fills and thick state outlines with white surfaces, thin neutral borders, and a small top-right state beacon.
2. Moved propagation emphasis from full-card rings to timestamp-driven beacons and edge pulses.
3. Adjusted beacon offsets for clipped API, worker, deployment, agent, evaluator, and database shapes.
4. Rechecked Compare at 1280 x 800; duplicated incident/verified layers overlap by design, while each layer independently has zero node intersections.

## Browser QA

- Console: 0 errors, 0 warnings.
- Target viewports: passed.
- Representative screenshots: passed.
- Visual comparison against the supplied light reference: passed for the requested material, contrast, and localized color treatment while retaining FlowPulse component grammar.

Final result: `passed`

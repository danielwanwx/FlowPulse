# Incident Digital Twin QA record

Date: 2026-07-17

Build under test: standalone FlowPulse repository, latest working tree served at `http://127.0.0.1:4310/`.

## Automated checks

- `npm test`: 12 tests passed, 0 failed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `node --check public/app.js`: passed.
- `node --check public/twin-state.mjs`: passed.
- `git diff --check`: passed.

The focused state tests prove stable component identities and coordinates, deterministic stage reconstruction, a fixed incident-versus-verified compare projection, and evaluator/owner/recovery/evolve ordering.

## Visible-browser acceptance

- Completed a fresh guided Astronomy Shop replay from Healthy through Learn: 29 immutable events.
- Confirmed Kafka's 22% confidence false diagnosis is rejected by the evaluator before evidence replan.
- Confirmed deploy, trace, log, metric, and commit evidence converge on the checkout-to-payment endpoint change.
- Confirmed repair remains blocked at the Owner gate until **Approve checkout rollback** is activated.
- Confirmed captured verification reaches 99.98% payment reachability, 0.8% checkout errors, and Kafka lag 620.
- Confirmed the regression record and all six evolve gates appear after recovery.
- Sought Propagate -> Healthy -> Propagate and received the same canvas projection on both Propagate visits.
- Exercised Live, Replay, and Compare on the same canvas, including the interactive 70% incident compare preset.
- Verified all 10 nodes and 10 edges expose accessible names and keyboard focus targets; component types use nine shape treatments rather than color alone.
- Verified repeated semantic edge pulses use 0.75 s healthy and 0.58 s impact cycles; reduced-motion CSS disables pulse animation.
- Checked 1440 x 900 and 1280 x 800: no node/annotation collisions, out-of-bounds nodes, or horizontal overflow.
- Browser console: 0 errors, 0 warnings.

## Screenshot set

- `live-last-known.png` - honest captured-live ledger projection.
- `replay-propagation.png` - red propagation through checkout, payment, Kafka, and workers.
- `replay-root-cause-owner-gate.png` - checkout root cause and bounded owner approval gate.
- `replay-recovery.png` - verified green recovery and learning state.
- `compare-incident-vs-verified.png` - interactive incident/recovery split on shared geometry.
- `viewport-1280x800-owner-gate.png` - compact target viewport check.

### Monochrome beacon refinement

- `monochrome-beacon-captured-live.png` - pure-white captured-live projection with verified beacons.
- `monochrome-beacon-propagation.png` - neutral node surfaces with localized impact and change beacons.
- `monochrome-beacon-owner-gate.png` - localized root-cause, evaluator rejection, and owner-gate states.
- `monochrome-beacon-compare.png` - interactive incident/verified split at 1440 x 900.
- `monochrome-beacon-compare-1280.png` - compact compare check at 1280 x 800.
- `monochrome-reference-comparison.png` - full-view reference-to-implementation comparison.
- `monochrome-node-detail-comparison.png` - focused node-material and status-beacon comparison.

The refinement keeps every module surface white and every structural line neutral. State color is restricted to small, labeled semantic beacons and timestamp-driven edge pulses. A per-layer geometry check found zero node intersections in Compare at 1280 x 800; the paired incident/verified layers intentionally share the same coordinates. Browser console remained at 0 errors and 0 warnings.

## Runtime truth boundary

Real in this build: append-only SQLite authority, runtime state machine, API/tool/evaluator orchestration, owner approval ordering, deterministic policy gates, optional GPT-5.6 loop, optional Langfuse observations, and the UI projection from ledger events.

Captured fixture behavior: Astronomy Shop OTLP evidence, the production rollback effect, before/after recovery values, and the default guided investigation narrative. The UI labels captured-live state explicitly and never represents the replay as an active external telemetry stream or a production mutation.

# Incident Digital Twin QA record

Date: 2026-07-17

Build under test: standalone FlowPulse repository, latest working tree served at `http://127.0.0.1:4310/`.

## Automated checks

- `npm test`: 35 tests passed, 0 failed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `node --check public/app.js`: passed.
- `node --check public/twin-state.mjs`: passed.
- `git diff --check`: passed.

The focused state tests prove stable component identities and coordinates, complete icon coverage, ordered causal pulse slots, deterministic stage reconstruction, a fixed incident-versus-verified compare projection, and evaluator/owner/recovery/evolve ordering.

## Visible-browser acceptance

- Completed a fresh guided Astronomy Shop replay from Healthy through Learn: 29 immutable events.
- Confirmed Kafka's 22% confidence false diagnosis is rejected by the evaluator before evidence replan.
- Confirmed deploy, trace, log, metric, and commit evidence converge on the checkout-to-payment endpoint change.
- Confirmed repair remains blocked at the Owner gate until **Approve checkout rollback** is activated.
- Confirmed captured verification reaches 99.98% payment reachability, 0.8% checkout errors, and Kafka lag 620.
- Confirmed the regression record and all six evolve gates appear after recovery.
- Sought Propagate -> Healthy -> Propagate and received the same canvas projection on both Propagate visits.
- Exercised Live, Replay, and Compare on the same canvas, including the interactive 70% incident compare preset.
- Verified all 10 nodes and 10 edges expose accessible names and keyboard focus targets; all 10 component identities have distinct colored vector symbols inside complete white plaques.
- Sampled the Propagate animation across a full 5.6 s cycle: maximum concurrent data pulses was one. Deployment, request, payment, stream, accounting, and fraud edges advance through deterministic slots rather than a repeated dash train.
- Verified reduced-motion CSS disables pulse and status-transition animation.
- Checked 1440 x 900 and 1280 x 800: no node/annotation collisions, out-of-bounds nodes, or horizontal overflow.
- Browser console: 0 errors, 0 warnings.

## Screenshot set

### Production Workspace and real OTLP

- `production-workspace-live-otlp.png` - 22 real Astronomy Shop services observed from current Collector output.
- `production-workspace-replay-propagation.png` - deterministic cross-system propagation stage.
- `production-workspace-replay-root-cause.png` - evaluator-backed checkout/payment causal finding.
- `production-workspace-owner-gate.png` - consequential rollback paused at the owner gate.
- `production-workspace-recovery.png` - verified recovery and learning state.
- `production-workspace-compare.png` - incident and verified state on shared geometry.
- `production-workspace-source-comparison.png` - selected Production Workspace source and implementation in one comparison image.

The real local smoke used official OpenTelemetry Astronomy Shop commit `18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5`. The Collector produced advancing trace, metric, and log JSONL files; FlowPulse discovered 22 observed services including Checkout, Payment, Kafka, Accounting, and Fraud Detection. The live case applied `paymentUnreachable`, rejected unsupported payment-service blame, reached an owner gate, restored the known-good flag, recreated only Checkout, verified fresh post-repair traces, and wrote capture manifest `capture-4fda1c22d47c297b` with SHA-256 `4fda1c22d47c297bfc64641d64bcfeaf5836c2d2d6caac4f45ec5666c9068b6a`.

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

### Vector component and causal-pulse refinement

- `vector-pulse-live.png` - white component plaques with the complete ten-symbol vector family.
- `vector-pulse-propagation.png` - a single red pulse advancing through the incident path.
- `vector-pulse-owner-gate.png` - complete component labels at root cause and the owner gate.
- `vector-pulse-recovery.png` - verified recovery with the same stable icon and geometry system.
- `vector-pulse-compare.png` - static incident/verified comparison without competing animation.

The latest pass removes clipped irregular silhouettes, glowing status halos, and inline motion styles. A visible-browser geometry audit at every replay stage found zero clipped nodes, truncated component labels, node intersections, or annotation-to-node intersections. The in-app browser captured this refinement at its available 1280 x 720 viewport; this is a stricter vertical fit than the recorded 1280 x 800 target check. Browser console remained at 0 errors and 0 warnings.

### Runtime/control hierarchy and theme refinement

- `runtime-control-propagation-black-1440.png` - pure-black 1440 x 900 propagation with semantic red fault halos.
- `runtime-control-propagation-black-1280.png` - pure-black 1280 x 800 responsive check with no page overflow.
- `runtime-control-recovery-light-1440.png` - light recovery state with distinct verification and regression outcomes.

This approved refinement separates observed runtime entities from the FlowPulse control plane through source labels, solid versus dashed relationships, and distinct node material. Red halos now apply only to impacted runtime nodes, while evaluator rejection remains a control-plane state. Recovery and regression render as selectable derived outcomes rather than component cards. The Light/Pure black toggle preserves all semantic colors and accessible names. Browser geometry checks reported zero node, annotation, or plane-label intersections at both target viewports; browser console remained at 0 errors and 0 warnings.

### Architecture-first navigation refinement

- `architecture-first-1440.png` - default Architecture projection from 21 current OTLP-observed services.
- `architecture-first-propagation-1280.png` - Diagnose propagation at 1280 x 800.
- `architecture-first-owner-gate-1280.png` - checkout/payment root cause and bounded owner gate.
- `architecture-first-recovery-1280.png` - verified recovery after owner approval.
- `architecture-first-compare-1280.png` - interactive incident-versus-verified split.

The app now opens on a four-layer Architecture view, then reuses stable service identities when switching to Live or Diagnose. Global navigation, tracing state, immutable event count, Run GPT-5.6, and Inspect run remain accessible from the native workspace menu. Geometry audits at 1440 x 900 and 1280 x 800 found zero source-node intersections, clipped cards, document overflow, mission-bar overflow, or topbar overflow. Light and pure-black themes passed, the full evaluator/owner/recovery/evolve story completed, and the browser console reported 0 errors and 0 warnings.

### Interactive Compare and agentic Live refinement

- `agentic-compare-interactive-70-1440.jpg` - the canvas-native Compare control at 70% incident on the 1440 × 900 target.
- `agentic-compare-interactive-30-1280.jpg` - the same continuous wipe at 30% incident on the 1280 × 800 target.
- `agentic-live-single-pulse-1440.jpg` - the real OTLP service graph with complete 144 px plaques, boundary-connected paths, and one active causal pulse segment.

The Compare range now updates the canvas handle, incident clip, dock range, and accessible value continuously at 1% precision. Live edges terminate at measured component boundaries and use unique topology-ordered 420 ms pulse slots; five visible-browser samples found at most one active segment. An unresolved local-development failure can color only services named by referenced failing trace evidence, and successful verification clears that impact state. The final real Live capture was healthy and therefore remained honestly observed rather than being forced red for a screenshot.

### Manager and Agent Operations refinement

- `agent-control-architecture-1440x900.png` - four-layer architecture with structural dashed guides distinct from runtime dependencies.
- `agent-control-architecture-dark-1440x900.png` - the same source projection in the persisted pure-black theme.
- `agent-control-live-1440x900.png` - current real OTLP topology, layer-spaced routing, sequential pulse segments, and the ledger-derived completed checkout change.
- `agent-control-manager-owner-gate-1440x900.png` - Manager report with the rejected Kafka diagnosis, accepted checkout/payment cause, immutable evidence IDs, bounded rollback, and separate Owner control.
- `agent-control-operations-1440x900.png` - ledger-synchronized specialist graph for Monitor, Evidence, Diagnosis, Evaluator, Planner, Owner, Executor, Verification, Evolve, and Test.
- `agent-control-recovery-1440x900.png` - post-approval verification at 99.98% payment reachability, 0.8% checkout errors, and Kafka lag 620.
- `agent-control-compare-1440x900.png` - continuously draggable 64% incident / 36% verified canvas split.

The visible browser completed the full owner-gated flow and confirmed the evaluator's 22% Kafka diagnosis rejection, evidence replan, checkout/payment root cause, bounded checkout-only rollback, verification, regression creation, and policy backtest. The Manager chat is ledger-grounded and cannot manufacture an approval; the consequential action remains a separate control. The Agent Operations projection is delivered over ledger-derived server-sent events, and every active handoff is reconstructed from attributed immutable events. Geometry checks found zero node intersections for 13 Agent Operations components and 22 Live components at 1280 x 800. Live rendered 23 single-segment pulse paths with deterministic delays; browser console inspection returned 0 errors and 0 warnings.

Langfuse was intentionally shown as `Not configured` during this local QA because no credentials were supplied. The integration path mirrors manager, agent, tool, and evaluator observations when credentials exist, while the append-only incident ledger remains runtime authority. No direct ClickHouse internal-schema dependency is used.

## Runtime truth boundary

Real in this build: official local Astronomy Shop containers, current Collector OTLP traces/metrics/logs, observed topology, flagd change, checkout-only Docker recreation, append-only SQLite authority, evaluator loop, owner approval ordering, post-repair verification, hashed capture manifest, deterministic policy gates, optional GPT-5.6 loop, optional Langfuse observations, and the UI projection from runtime state.

Captured fixture behavior: the complex Kafka propagation evidence, its production rollback effect, exact before/after recovery values, and the default guided judge narrative. The UI distinguishes that immutable replay from `Live OTLP` and from the hashed local capture.

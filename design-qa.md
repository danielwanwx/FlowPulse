# Design QA

Date: 2026-07-17
Target: `http://127.0.0.1:4310/`
Viewports: 1440 × 900 and 1280 × 800
Scope: interactive Compare wipe; connected Live topology; globally sequenced pulse; evidence-gated Live incident coloring; P0 orchestration harness compatibility

## Visual truth

- User-provided Live reference: `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-48e72623-260d-4e13-ad01-1b9bf1634cb7.png`.
- User-provided Compare reference: `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-18659b31-e87d-4025-92a9-f84d784d3885.png`.
- Same-input visual review paired each reference with the implementation captures below.
- Final captures:
  - `docs/qa/agentic-live-single-pulse-1440.jpg`
  - `docs/qa/agentic-compare-interactive-70-1440.jpg`
  - `docs/qa/agentic-compare-interactive-30-1280.jpg`

## Mandatory checks

| Surface | Result | Evidence |
| --- | --- | --- |
| Compare interaction | Passed | A native, canvas-aligned range changes the wipe continuously at 1% precision. Browser QA set 50 → 70 and 50 → 30; both the dock control and canvas handle synchronized, and the settled clips were exactly `inset(0 30% 0 0)` and `inset(0 70% 0 0)`. |
| Compare animation | Passed | The same shared `--compare-percent` drives the handle and incident clip; the existing 160 ms layer transition remains visible for presets and range changes. |
| Live connections | Passed | All rendered edges use the measured 144 × 58 card boundary, not fixed center offsets. Browser QA rendered 21–22 real OTLP services with 22 edges and no visibly detached endpoint. |
| Component completeness | Passed | Source plaques widened to 144 px. DOM geometry checks found zero clipped component titles at both target widths. |
| Causal pulse | Passed | Edges are ordered by deterministic topology depth and stable edge ID, then assigned unique 420 ms slots. Five browser samples reported `[0, 1, 1, 1, 1]` visible pulses; no pulse train or overlapping active segment remained. |
| Live incident state | Passed | `liveIncidentNodeStates` only marks services on a referenced, explicit failing trace in an unresolved `development` run; checkout and payment become `impact`, their path becomes red, and successful verification clears the state. Captured replay evidence is never projected onto an unrelated Live graph. |
| Real source truth | Passed | The visible Live capture is real local OTLP via Collector with sub-second freshness and runtime-derived service/dependency counts. No unresolved development incident was active during the final capture, so the real Live graph correctly remained observed rather than falsely red. |
| Guided incident story | Passed | Visible seeking reconstructed Wrong hypothesis rejected → Root cause → Owner gate → Recover → Learn. The associated copy preserved Kafka rejection at 22%, checkout root cause, bounded rollback wait, verification, and regression/policy recording. |
| Responsive layout | Passed | 1440 × 900 and 1280 × 800 had no document overflow; Compare had no within-layer node overlap. |
| Accessibility | Passed | The canvas Compare control has an accessible slider name and synchronized `aria-valuetext`; existing named modes, focus states, semantic component labels, non-color statuses, and reduced-motion fallback remain intact. |
| Browser runtime | Passed | A fresh in-app-browser run completed Architecture, Live, Compare, and Diagnose stage checks with 0 console errors and 0 warnings. |
| Automated tests | Passed | `npm test`: 29/29, including four orchestration harness tests and focused deterministic Compare/Live state tests. |

## Honest limitations

- Live is a bounded local Astronomy Shop OTLP window, not a general telemetry warehouse.
- The final real Live capture was healthy. The red Live projection was verified with the same evidence shape used by the local development runtime and is guarded against unsupported coloring; no new fault was injected merely to obtain a red screenshot.
- P0 orchestration is an additive contract/replay harness. It does not yet start separate workers or live specialist model calls, and it does not replace the append-only incident ledger as runtime authority.

final result: passed

## 2026-07-31 Incident glass workspace

### Comparison input

Reviewed in one side-by-side image input:

- Reference: `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-54028d5d-24be-47aa-9a7a-199fabb7b516.png`
- Implementation: `/private/tmp/flowpulse-agent-portal-evidence.jpg`
- Composite: `/private/tmp/flowpulse-reference-vs-portal-final.jpg`

The reference is a health dashboard and the implementation is an incident workspace, so this checks the shared visual language rather than copying the product layout.

### Verified

- Soft ice-grey canvas, rounded translucent panels, and low-contrast shadow hierarchy replace hard card borders.
- Signal cards, path nodes, graph nodes, and controls are rounded, borderless glass surfaces; blue is reserved for navigation/actions and red/green for live incident state.
- The right Agent Portal is hidden until a real component or relation is selected. Its displayed evidence count includes the latest metric-point references, not a fabricated text summary.
- Dataflow renders only the real evidence-backed `Checkout → Payment` path, with a directional edge, bounded active pulse, and a component-to-Portal action. A valid one-node path remains inspectable.
- Full-suite verification passed (`437` passed, `1` intentionally skipped); the focused V3 workspace suite passed `29/29` after the two Staff-review fixes.

### Independent Staff review

An independent Staff review initially found two P1 issues: metric evidence was omitted from the Portal count, and a one-node path could render unavailable. Both were fixed and re-reviewed with no P0/P1/P2 remaining.

final result: passed

## 2026-07-31 Evidence-backed metric diagrams

### Comparison input

Visual grammar was compared against the supplied reference cards:

- `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-c9cd0759-c762-4022-98d5-bdc70ea6fc55.png`
- `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-fca6b75d-33b1-4219-9867-d687b108d79c.png`
- `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-0aaf95d3-8607-4698-9908-7489aa974bc0.png`
- `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-71bbe562-97b4-4d9c-a8a2-1b024279c4e8.png`
- `/var/folders/2j/cqqt4_3j51z2f5s1q0m9_8nw0000gn/T/codex-clipboard-0e626852-4d8b-4a48-bad5-a0e06b9284cc.png`

Implementation capture: `/private/tmp/flowpulse-metric-final.jpg`.

### Verified

- Error rate uses an exact real-sample line with a quiet semantic area and current marker; latency uses one vertical stem per real numeric sample; traffic uses one rounded tile per real sample and preserves gaps.
- The compact card hierarchy is label/icon → diagram → current value, with the actual observed live window and sample count. It has no invented seven-day or month control.
- The Monitor dialog expands the same real series, including window, threshold, freshness, and evidence context.
- Selecting a card persists its `series` identifier in the URL and keeps the Agent Portal on that exact metric. A terminal gap shows `No numeric sample`; it never substitutes Errors or another available metric.
- The current V3 API exposes only its bounded recent observed window. Historic 7D/30D views remain intentionally absent until the backend owns a range/downsampling contract.

### Independent Staff review

The independent Staff reviewer found one P1: a selected series ending in a gap could fall back to a different metric in Agent Portal. The fix preserves the selected series and adds a gap regression test. Post-fix review found no P0/P1/P2 issues. Focused V3 tests passed `30/30`.

final result: passed

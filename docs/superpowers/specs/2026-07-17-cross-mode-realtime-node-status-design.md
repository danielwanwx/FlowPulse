# Cross-mode realtime node status

## Goal

Use every node's top-right status dot as a consistent, evidence-grounded signal across Architecture, Live, Diagnose, Recovery Console, and Compare, while removing redundant small copy from the workspace chrome.

## Approaches considered

1. CSS-only recoloring: smallest diff, but Architecture would still lack an honest status projection.
2. Shared frontend projection: reuse source freshness, explicit referenced OTLP failures, verification events, replay frames, and Agent ledger states. Recommended because it preserves existing runtime authority without backend scope.
3. New backend health aggregation: richer health scoring, but it expands backend scope and would require thresholds not present in the evidence contract.

## Status contract

- Blue: live observation, investigation, recording, or active work.
- Green: healthy baseline or verified outcome.
- Amber: stale/connecting data, change, owner wait, or dependency evidence gap.
- Red: explicit failure, root cause, or rejected result.
- Gray: dormant, standby, unavailable, or unconfigured.

Architecture and Live use the same OTLP-derived projection. Explicit failure state is applied only for referenced, authoritative development evidence. Verification turns only the previously affected services green. Diagnose and Compare remain deterministic ledger projections. Recovery Console remains an Agent ledger projection.

## Copy hierarchy

- Keep the environment, source badge, canvas title, essential dependency-gap note, and human-gate copy.
- Remove redundant metric notes such as `observed service.name` and the repeated `live` label.
- Shorten canvas captions to source freshness, immutable event count, or the one interaction instruction needed by that mode.
- Put the full color semantics in the on-demand Legend rather than the default toolbar.

## Acceptance

- Every rendered node exposes a status class, `data-status`, visible status label, and accessible status name.
- Architecture and Live show identical state for the same source component.
- Evidence-gap components are amber and visibly distinct in both source views.
- Explicit referenced development failures are red; verified affected services are green.
- Diagnose, Compare, and Recovery Console keep their existing causal state behavior.
- No new backend API, inferred health score, or synthetic telemetry is introduced.
- Automated tests and visible-browser checks pass with zero console warnings or errors.

## QA record

- Automated suite: 46/46 passing.
- Architecture: 21 real source components; 17 live-observed blue and four dependency-evidence gaps amber in the inspected window.
- Architecture/Live parity: zero component status differences for the same OTLP projection.
- Diagnose: healthy, change, impact, and recording dots render as green, amber, red, and blue.
- Recovery Console: active, standby, recording, and verified dots render as blue, gray, blue, and green.
- Accessibility: every inspected source component has a status-bearing accessible name; the on-demand Legend exposes all five status meanings.
- Browser console: zero warnings and zero errors.
- Screenshot: `docs/qa/architecture-realtime-status.jpg`.

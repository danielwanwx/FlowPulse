# Live + Incident Unified Workspace — Phase 0 Implementation Plan

**Design authority:** frontend commit `2d13da2`

**Backend baseline:** `b3d975885671e03e610485606a55879891f10b00`

## Goal

Make the current Incident Workspace safe for continuous realtime operation
before introducing the V3 Live and Incident read models.

## Slice 0A — V3 identity contracts

- Add a stable public incident-run identity distinct from Temporal execution
  run IDs.
- Add a monotonic current-execution pointer and compare-and-swap rollover
  command.
- Add a V3 action command bound to `decision_revision`, not
  `projection_revision`.
- Keep all frozen V2 models unchanged.

## Slice 0B — Durable execution pointer

- Add append-only Temporal execution-generation records.
- Add one current pointer per tenant/public incident run.
- Implement transactional generation `N -> N+1` compare-and-swap.
- Resolve the current execution immediately before scheduler describe/signal.
- Record the physical generation that accepts each command.

## Slice 0C — Continue-as-new

- Add deterministic rollover thresholds below Temporal history limits.
- Carry bounded identity, revision watermarks, active references, cursor
  watermarks, and timer descriptors.
- Persist idempotency receipts outside workflow state.
- Preserve case/global event sequences across rollover.

## Slice 0D — Decision revision

- Generate V3 action cards against `decision_revision`.
- Mint and validate V3 authorization assertions against stable public identity
  and `decision_revision`.
- Add V3 BFF/API action routes.
- Preserve frozen V2 replay and compatibility behavior.

## Slice 0E — Verification

- Unit-test identity and rollover invariants.
- Test in-flight command rollover and retry.
- Test SSE reconnect without sequence reset.
- Run a Temporal soak beyond the previous history-size failure point.
- Verify V2 clients continue to decode frozen contracts.

Phase 1 unified Live projection does not begin until every Phase 0 acceptance
test passes.

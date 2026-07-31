# FlowPulse V3 Agentic Realtime Incident Workflow

Date: 2026-07-31
Status: approved for implementation

## Outcome

FlowPulse V3 turns Incident from a static report into a user-driven, durable workflow:

`Detect -> Triage -> Investigate -> Decide -> Respond -> Verify`

Only the current stage is active and visible. A stage must finish before the user can advance. `Next` is a backend command that signals the Temporal workflow, not a client-only navigation action. Future stages stay locked and are not computed in advance.

The first complete acceptance scenario is the Astronomy Shop checkout to payment incident produced by the `paymentUnreachable` fault. Live and Incident share one V3 truth, Agent work is evidence-bound, repair requires human approval, and verification uses only fresh post-action telemetry.

## Workflow contract

Every incident owns one or more immutable workflow attempts. An attempt tracks a current stage and stage runs with these states:

`LOCKED | READY | RUNNING | SUCCEEDED | FAILED | NEEDS_HUMAN | SUPERSEDED`

- `Next` is enabled only for a succeeded current stage and idempotently starts the next stage.
- A failed stage cannot be skipped. The user may retry, add evidence, or escalate to `NEEDS_HUMAN` with a reason.
- Reviewing a completed stage is read-only.
- Rerunning before execution creates a new stage run, supersedes downstream runs, increments `workflow_revision`, and relocks future stages.
- Rerunning an earlier stage after an action executed creates a child attempt from current system state. The original approval, receipt, and verification remain immutable.
- Verify is terminal. Successful fresh evidence enables incident completion; failed verification rolls back or stops at `NEEDS_HUMAN`.

## Data and authority

The backend is the sole workflow and evidence authority. Temporal owns transitions and timers, Postgres owns append-only records and projections, MinIO owns raw artifacts, and the browser submits typed commands only.

Public state separates `signal_revision`, `decision_revision`, `workspace_revision`, `topology_revision`, and `workflow_revision`. Metric ticks never invalidate an action unless a material decision precondition changed.

Prometheus and the Astronomy Shop OTel file exporter provide real telemetry every two seconds. Typed metric series retain timestamps, numeric values, units, thresholds, gaps, and evidence references. A Temporal timer persists stale state after thirty seconds without accepted data.

Codex CLI may generate hypotheses and criticism inside bounded activities. Model output is untrusted data and cannot choose tools, authorize actions, execute shell text, or declare verification success.

## Product experience

Live is the realtime multi-incident entry point. Opening an incident enters a single full-height stage workbench with:

- a six-stage progress rail and incident command bar;
- one current-stage surface;
- a fixed Retry, Escalate, and Next action footer;
- URL-restorable metric, evidence, activity, timeline, component, and graph detail surfaces.

The full diagnostic graph is available from Investigate in an accessible modal. Viewing a node is side-effect free. Starting a node investigation is an explicit command.

Motion communicates accepted samples, current agent progress, graph pulses, and state changes only. Stale data freezes. The browser never fabricates values, typing, pulses, or activity.

## Safety and observability

All commands validate tenant, actor, expected attempt, expected stage, expected revision, and idempotency key. Consequential execution requires a separate approval bound to the action and decision revision. The only V3 local repair is the allowlisted Astronomy command that disables `paymentUnreachable` and recreates checkout.

Workflow commands and activities emit structured events with request, case, attempt, stage-run, and action correlation identifiers. Metrics cover command rate, errors, duration, stage latency, connector health, SSE gaps, and verification outcomes with bounded labels.

## Acceptance

- No next-stage activity exists before a valid `Next` command.
- Refresh and SSE reconnect restore the same attempt, stage, and open detail state.
- At least three distinct real samples update signal values and sparklines in order.
- Connector loss produces durable stale state after thirty seconds and recovers on new data.
- Live and Incident agree on case, component impact, severity, freshness, and topology.
- Agent stages publish started, progress, and terminal events with evidence lineage.
- Approval and execution are idempotent, authorized, and auditable.
- Verification uses only post-action evidence and covers success, rollback, and human escalation.
- Desktop and 451 by 859 layouts have no page-level horizontal overflow and all modals support keyboard focus management and reduced motion.
- V1 and V2 contracts remain compatible while the new UI uses V3 exclusively.

## Delivery boundary

This release is a local production-grade loop. It may mutate the local Astronomy Shop only. It does not merge to main, deploy production, use production credentials, or write to production systems.

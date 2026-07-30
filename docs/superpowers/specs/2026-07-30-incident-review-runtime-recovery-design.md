# Incident Review Runtime Recovery Design

**Status:** Approved design, pending written-spec review

**Date:** 2026-07-30

**Scope:** Backend-first recovery of one fresh Incident Workspace for frontend
review. This is a bounded stability checkpoint, not a long-term Temporal
lifecycle redesign.

## Goal

Restore a truthful local Incident review environment:

1. A fresh, credential-free `TEST_DETERMINISTIC` Incident initializes through
   FastAPI, Temporal, Postgres, and MinIO.
2. Its canonical V2 projection and ordered V2 SSE continue advancing during the
   review window.
3. A closed Temporal workflow stops creating new connector source events and
   outbox work.
4. The frontend runs on port 4173 against the exact backend runtime and opens
   the fresh pinned case for Daniel's review.

Architecture and Live remain unchanged. Incident remains limited to the
approved Investigate-to-Decide slice.

## Observed failures

The recovery addresses two confirmed failures:

- Fresh workflows can fail initialization because a graph node marked
  `CONNECTED` has no corresponding edge, violating
  `connected_node_requires_edge`.
- The realtime scheduler continues polling cases whose Temporal workflow has
  closed. It therefore creates source facts and dispatch rows that cannot be
  accepted. The existing database must be preserved; accumulated records are
  not deleted by this checkpoint.

The older canonical workflow also exceeded Temporal's history-size limit.
Long-term history rollover is explicitly deferred.

## Chosen approach

Use a fresh-case isolation recovery with two narrow source repairs:

1. Repair initialization so the topology provider produces a graph satisfying
   the frozen Incident graph contract.
2. Add a fail-closed workflow-acceptance check before connector polling. A case
   whose exact Temporal execution is closed or unavailable must not produce a
   new source event or dispatch.

Dispatch work already targeting a closed execution must transition to the
existing terminal rejection representation. A failure for one case must not
block dispatch for another case.

No alternate lifecycle authority, browser inference, mock projection, or
historical replay may satisfy acceptance.

## Component boundaries

### Topology initialization

The existing topology provider remains the only source of initialization graph
data. The repair must preserve the approved six impacted nodes and five audited
relations. It must not weaken model validation or silently remove connected
nodes.

The regression seam is the workflow initialization input and resulting
`IncidentProjection`: every connected node must participate in at least one
canonical edge.

### Scheduler eligibility

Before polling a connector for a projected case, the worker checks the exact
`workflow_id` and `workflow_run_id`.

- Open execution: polling and normal durable admission may proceed.
- Closed execution: skip polling and record bounded telemetry.
- Temporal unavailable or indeterminate: fail closed and skip polling for that
  tick.

This check happens before the connector reads the provider and before any
source event, cursor, reconciliation run, or outbox row is committed.

The scheduler may continue processing other eligible cases in the same tick.

### Existing pending dispatch

If dispatch reaches an exact workflow execution that is already closed,
`TerminalRealtimeDispatchError` remains the terminal boundary and the dispatch
receives a `REJECTED` revision. It must not remain indefinitely retryable.

No existing source event, outbox base row, projection, event, evidence record,
or object is deleted or rewritten.

### Fresh review case

After the repairs pass their checkpoints, create one fresh
`TEST_DETERMINISTIC` case through the real API. Record:

- `tenant_id`
- `incident_id`
- `case_id`
- `run_id`
- `topology_revision`
- `workflow_id`
- `workflow_run_id`

The frontend starts with that case pinned and communicates only through its
same-origin BFF. Backend credentials remain process-side.

## Data flow

```text
Fresh API intake
  -> Temporal initialization
  -> valid canonical graph
  -> durable v1 projection
  -> TEST_DETERMINISTIC Prometheus poll
  -> workflow-open eligibility check
  -> source fact + evidence + outbox
  -> exact Temporal workflow update
  -> atomic v1/v2 projection and event commit
  -> FastAPI V2 projection/SSE
  -> frontend same-origin BFF
  -> Incident review UI
```

Closed workflows leave the flow at the eligibility check and produce no new
provider read or durable fact family.

## Error handling

- Invalid initialization graph: reject initialization; never coerce it into a
  plausible projection.
- Closed workflow: skip new polling and terminally reject already-created
  dispatch work.
- Temporal status unavailable: skip polling for the tick and expose bounded
  diagnostic telemetry.
- Connector unavailable: preserve the canonical `UNAVAILABLE` or degraded
  state; never substitute a fixture under a live label.
- Frontend/BFF unavailable: report the runtime failure; do not bypass the BFF
  with a browser bearer.

## Verification

### Regression checks

1. A deterministic initialization test reproduces the graph-contract failure
   before the repair and passes after it.
2. A scheduler test proves a closed workflow causes zero connector polls and
   zero new source/outbox records.
3. A scheduler test proves one closed case does not prevent an open case from
   polling and dispatching.
4. A dispatch test proves a closed exact execution becomes terminally rejected.

### Runtime checks

1. API, worker, authorization, Temporal, Postgres, MinIO, migrations, and local
   Prometheus are healthy.
2. Running API and worker images identify the repaired backend commit.
3. A fresh case initializes once with the exact canonical identities recorded.
4. Projection revision and case sequence increase while an SSE client remains
   connected.
5. SSE emits connector health, current signal, Monitor or Triage activity,
   incident clock, and citation/evidence-bound records.
6. Heartbeat and resume work.
7. Reload returns the same durable current state.
8. Pending-row count for the known closed case does not increase during a
   bounded observation window.
9. Frontend port 4173 serves the pinned fresh case with no browser console
   errors and no exposed backend bearer.

## Explicit exclusions

- Temporal `continue-as-new` or history rollover
- Rebinding existing product runs to a new workflow run
- Deleting or compacting existing Postgres/MinIO data
- Production connector credentials
- PagerDuty, GitHub, Grafana, or production OTEL activation
- Architecture or Live changes
- Incident visual redesign
- Gate 2, remediation, execution, recovery, verification, or success claims
- Deployment, merge, or publication

## Stop conditions

Stop and report instead of expanding scope if:

- the graph failure cannot be reproduced at the workflow initialization seam;
- the scheduler cannot determine exact workflow execution state without
  creating another lifecycle authority;
- either confirmed failure survives two direct repair attempts;
- recovery would require deleting existing data or changing frozen public
  contracts;
- the fresh case cannot produce new durable events without relying on
  historical replay or frontend fixtures.

# Incident Review Runtime Recovery Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-30-incident-review-runtime-recovery-design.md`

**Goal:** Restore one fresh, continuously updating deterministic Incident case
and serve it through the frontend BFF for UI review.

## Checkpoint 1: Establish red feedback loops

1. Add the project `dev` dependency set to the existing backend image build used
   for tests, without changing production runtime dependencies.
2. Reproduce the initialization failure through the smallest workflow/activity
   seam that emits `connected_node_requires_edge`.
3. Add a scheduler regression test with two cases:
   - one exact Temporal execution is closed;
   - one exact Temporal execution is open.
4. Assert that the closed case performs zero connector polls and creates zero
   source/outbox facts, while the open case proceeds.
5. Record the single focused test command and its red output.

Stop if the observed initialization error cannot be reproduced at the intended
seam; do not patch topology based only on old logs.

## Checkpoint 2: Repair initialization

1. Trace the failing projection to the topology/provider or hydration boundary.
2. Preserve model validation.
3. Apply the smallest producer-side correction so every `CONNECTED` node has a
   canonical edge.
4. Run the focused initialization regression test and existing topology,
   workspace projection, and workflow tests.
5. Commit and push the passing checkpoint.

## Checkpoint 3: Add scheduler eligibility

1. Introduce a worker-owned async eligibility port that checks the exact
   `workflow_id` and `workflow_run_id`.
2. Query Temporal execution status before provider polling.
3. Treat only an open exact execution as eligible.
4. Treat closed, missing, and indeterminate executions as fail-closed for new
   polling.
5. Keep terminal dispatch rejection on the existing
   `TerminalRealtimeDispatchError` path.
6. Run focused scheduler/outbox tests.
7. Commit and push the passing checkpoint.

## Checkpoint 4: Rebuild and verify the backend

1. Build API and worker images from the exact committed backend SHA.
2. Restart only the backend Compose services required by the change; preserve
   volumes.
3. Confirm API, worker, authz, Temporal, Postgres, MinIO, migrations, and local
   Prometheus health and provenance.
4. Observe the known closed case for a bounded interval and prove its source and
   Pending counts no longer increase.
5. Create one fresh `TEST_DETERMINISTIC` case through authenticated FastAPI.
6. Record its complete canonical and Temporal identity.
7. Hold a V2 SSE client open and prove new ordered events, heartbeat, resume,
   projection advancement, and durable evidence/citations.

Stop after two direct repair attempts for the same failing check.

## Checkpoint 5: Start frontend review runtime

1. Verify the frontend branch remains clean and Architecture/Live files are
   unchanged.
2. Start the frontend process with:
   - backend URL `http://127.0.0.1:8090`;
   - backend bearer available only to the Node process;
   - the fresh `case_id` pinned through the existing startup mechanism.
3. Verify `http://127.0.0.1:4173` and the same-origin V2 BFF.
4. Use a browser to confirm:
   - Incident renders the backend-owned graph;
   - signal, clock, health, activity, and citations update from V2 data;
   - reload preserves state;
   - console and network contain no errors;
   - browser runtime contains no backend bearer.
5. Capture desktop and 451×859 screenshots.

## Handoff

Return:

- frontend URL;
- fresh `case_id`;
- backend and frontend SHAs;
- exact runtime provenance;
- checks passed and any bounded exclusions;
- screenshot paths;
- remaining long-term Temporal rollover work.

Do not merge, deploy, delete data, or begin long-term history rollover.

# FlowPulse Realtime Incident Restart Handoff

Copy the prompt below into a new Codex session. The new session should begin
with a read-only audit and should not assume that the current browser screen is
live merely because it renders.

---

## Handoff prompt

You are taking over the FlowPulse Incident Workspace frontend/backend
integration after the previous session stopped to avoid another repair loop.
Start from the verified facts below. Do not repeat broad design work and do not
claim completion from static fixtures, historical SSE replay, or a page that
only renders.

### Product objective

Deliver a truthful Staff on-call incident control room:

1. The backend admits real or explicitly `TEST_DETERMINISTIC` operational
   source facts.
2. Temporal remains the only incident lifecycle and projection authority.
3. Postgres/MinIO retain durable source, evidence, projection, and event
   records.
4. FastAPI publishes canonical V2 projections and ordered V2 SSE.
5. The frontend consumes only its same-origin BFF and renders backend-owned
   signal, graph, clock, connector health, agent activity, citations,
   investigation state, and result.
6. Motion is allowed only when it represents a currently active,
   server-issued pulse or a bounded display interpolation from a fresh server
   clock anchor. Never manufacture activity with browser timers.

Architecture and Live are stable surfaces and must remain behaviorally and
visually unchanged. Incident is the only redesign surface. The currently
approved diagnostic slice stops at Investigate → Decide. Do not add Gate 2,
remediation, execution, recovery, verification, or success claims.

### Repositories and exact checkpoints

Frontend:

- Repo:
  `/Users/danielwan/Documents/Codex/2026-07-24/flowpulse-frontend-architecture-polish-v2`
- Branch: `codex/incident-workspace-unification`
- HEAD: `131899b16e840c0c08fb67c301af2195396cdd86`
- Remote: `origin/codex/incident-workspace-unification`
- Worktree was clean at handoff.
- Relevant recent commits:
  - `131899b` — prioritize pinned incident startup
  - `7f678b8` — tighten V2 realtime contract boundaries
  - `a02f2a2` — wire Incident Workspace to realtime V2 contract
  - `006db6c` — unify Staff incident investigation workspace
  - `b9272a5` — restore Incident Workspace shell
  - `ef13354` — restore responsive Architecture and Live views

Backend:

- Repo:
  `/Users/danielwan/Documents/Codex/2026-07-25/flowpulse-diagnosis-control-plane-p0/repo`
- Branch: `codex/diagnosis-control-plane-p0`
- HEAD: `179355e7fb3e30bfd04a0c7d44d7ffe3bf9ca3a5`
- Worktree was clean at handoff.
- Relevant checkpoints:
  - `99f84dfb84fabc6d0b45148f0bc415d419ba1ff4` — frozen
    Investigate → Decide workspace contract
  - `01bf27e4f78362cdeff78c2439a14e0b50e2d680` — current V2
    realtime OpenAPI producer recorded in the freeze manifest
  - `179355e` — latest outbox head-of-line blocking repair
- At handoff, this backend branch had no configured upstream. Verify remote
  state before editing or pushing.

Do not reset, merge, rebase, or rewrite either branch. Preserve user changes.
Every new commit must be pushed immediately after it passes its checkpoint.

### Current local runtime and verified integration facts

The last local runtime used:

- Frontend: `http://127.0.0.1:4173`
- Backend: `http://127.0.0.1:8090`
- Frontend process configuration:
  - `FLOWPULSE_CONTROL_PLANE_URL=http://127.0.0.1:8090`
  - the local-only backend bearer is process-side only
  - never expose that bearer in browser runtime config, JavaScript, screenshots,
    or browser requests

Canonical case used for the last check:

- `case_id`:
  `workspace-case-41f79eb972d64e7b915de9cda5889843`
- `run_id`: `run-e82cf06ee3bf45a6ba9bcc0c88e13242`
- `workflow_id`:
  `flowpulse.incident-workspace:tenant-minio:run-e82cf06ee3bf45a6ba9bcc0c88e13242`
- `workflow_run_id`: `cb13d94a-6657-4e65-827e-257effbaa5bc`

What passed:

- Frontend port 4173 and backend port 8090 were listening.
- `GET /healthz` returned HTTP 200 with
  `workflow_authority=temporal`.
- Backend
  `GET /v2/incidents/{case_id}/projection` and frontend
  `GET /api/control-plane/v2/incidents/{case_id}/projection` both returned
  HTTP 200.
- Direct backend and BFF projection identity, run, revision, and sequence
  matched.
- The browser rendered Incident mode with six affected nodes, signal,
  connector-health, agent-activity, and citation content.
- The browser error banner was hidden and there were no console warnings or
  errors.
- Historical case SSE replay through the frontend BFF worked. Resuming after
  sequence 907 returned ordered events 908–913 with the exact
  `incident-realtime-event` event name.

What did not pass:

- The projection was frozen at sequence 913 with
  `generated_at=2026-07-30T04:27:26.393666+00:00`.
- A stream opened after sequence 913 produced no new event during the bounded
  verification window.
- The projection reported `status=provider_unavailable` and
  `lifecycle_stage=INVESTIGATE`.
- Prometheus connector freshness was stale.
- Therefore the transport and historical replay path were connected, but a
  genuinely changing realtime E2E path was not proven.

Do not use this frozen case as proof that realtime works.

### Governing design documents

Read these before changing code.

Frontend product/layout authority:

1. `docs/superpowers/specs/2026-07-28-staff-incident-investigation-workspace-design.md`
   - Approved Incident-only design.
   - Six backend-impacted nodes and five backend-audited relations.
   - Staff attention order: what happened → propagation → focus → known and
     unknown → Gate 1 → fresh evidence → critic → Decide.
   - Architecture and Live frozen.
   - Frontend is fail-closed and never creates lifecycle truth.
2. `docs/superpowers/specs/2026-07-25-agent-led-incident-workspace-design.md`
   - Broader product, Temporal, evidence, capability, and safety model.
   - Treat Gate 2/recovery portions as future scope, not current authorization.
3. `docs/superpowers/specs/2026-07-25-incident-focus-workspaces-design.md`
   - Focus workspace layout, motion, failure, accessibility, and verification
     rules.

Backend contract/runtime authority:

1. `docs/specs/2026-07-29-realtime-incident-connectors-and-agent-workspace-design.md`
   - Realtime source-fact plane, V2 projection/SSE, signal bar, clock,
     graph pulses, Monitor/Triage activity, citations, failure modes, and
     Phase 1 acceptance.
   - This document records that named connector enums or fixtures do not prove
     live PagerDuty, Prometheus/Grafana, GitHub, or OTEL connectivity.
2. `docs/architecture/incident-workspace-control-plane-contract.md`
   - Canonical identity, Temporal authority, NodeExplanation boundary,
     Investigate → Decide, same-origin BFF, and frozen v1 contract.
3. `docs/plans/2026-07-25-agent-led-incident-control-plane-integration.md`
   - Backend implementation and full integration checkpoints.
4. `docs/plans/2026-07-25-diagnosis-control-plane-p0.md`
   - P0 loop contract, exclusions, and acceptance boundary.
5. `control_plane/openapi/flowpulse-incident-realtime-v2.openapi.json`
6. `control_plane/openapi/flowpulse-incident-realtime-v2.examples.json`
7. `control_plane/openapi/flowpulse-incident-realtime-v2.freeze.json`
   - Producer: `01bf27e4f78362cdeff78c2439a14e0b50e2d680`
   - OpenAPI SHA-256:
     `fdf98c1b6faa7eb13cad0649730c07ad50d35b9a1a689ae9822188d3aa511741`
   - Examples SHA-256:
     `92a45443e7ba3740d24aae2b70f4420a2517951acafa08c025926bfbf8d72f16`

The generated/frozen OpenAPI bundle is authoritative when prose and code
appear to disagree.

### Required restart sequence

#### Checkpoint 0 — read-only audit

Before editing:

1. Confirm both branches, HEADs, remotes, and clean worktrees.
2. Confirm whether backend commit `179355e` exists on the remote.
3. Inspect the exact Docker Compose services, images, migrations, worker task
   queues, scheduler ownership, Temporal namespace/workflow, Postgres outbox,
   and connector configuration currently running.
4. Prove image/source provenance. Do not assume port 8090 is running code from
   the backend HEAD.
5. Re-run the frozen V2 manifest/hash check.
6. Record a short table of observed versus expected state.

Do not edit frontend code during this checkpoint.

#### Checkpoint 1 — restore backend realtime production

The first implementation goal is not a UI change. It is one fresh,
credential-free, explicitly `TEST_DETERMINISTIC` incident through the real
FastAPI → Postgres/MinIO → outbox → Temporal worker → projection/event
repository → SSE path.

Required proof:

- API, worker, Temporal, Postgres, MinIO, migrations, and authorization healthy.
- The exact backend checkout is running.
- A fresh canonical case/run/workflow identity is recorded.
- Source facts are durable and tenant/run/component bound.
- The outbox advances without head-of-line blocking.
- Temporal accepts each event exactly once.
- Projection revision and case sequence increase while the client remains
  connected.
- Case SSE emits at least:
  - connector health/source state
  - a current signal
  - Monitor or Triage activity start/completion
  - incident clock update
- Signal, activity, and citation reference durable evidence.
- Idle SSE heartbeats and resume work.
- Reload returns the same durable current state.

No production credentials are authorized. Missing optional vendor credentials
must leave that connector `UNAVAILABLE`; they must not silently activate a
fixture under a live label.

If the failure is runtime/configuration drift, repair the runtime only. Change
source code only after proving a reproducible source defect. Limit one failing
check to two direct repair attempts, then stop and report the blocker.

#### Checkpoint 2 — frontend contract verification

Only after Checkpoint 1 passes:

1. Run the frontend against that exact backend runtime through
   `/api/control-plane/v2`.
2. Verify startup with a pinned fresh `case_id`.
3. Verify Architecture and Live are unchanged.
4. Verify Incident renders only the backend-audited incident graph, with no
   dense 22-node grid and no client-created edges.
5. Verify signal, duration, connector health, active pulse, Agent activity,
   citations, investigation result, and lifecycle stage change only from
   canonical projection/SSE.
6. Verify component selection opens or reuses the durable server-owned
   explanation; reload and duplicate clicks must not create a second agent
   turn.
7. Verify stale/disconnected/provider-unavailable states visibly freeze or
   degrade instead of showing current activity.
8. Capture desktop and 451×859 screenshots and review them as a Staff on-call
   workflow, not as a generic dashboard.

The right panel should feel like a restrained live Agent workspace:

- current context and known/unknown state
- Monitor/Triage activity
- cited operational evidence
- one clear next interaction when backend authority permits it
- durable conversation/explanation only when the backend supplies it

Do not add fake typing, fake progress, random pulses, inferred root cause,
locally generated recommendations, or a frontend-owned remediation flow.

#### Checkpoint 3 — cross-stack browser acceptance

Acceptance requires evidence from all layers:

- browser requests and visible DOM
- frontend BFF responses
- backend API/worker logs
- Temporal workflow ID and run ID
- Postgres/outbox/projection/event references
- MinIO/evidence references

Verify:

- passive notification → focus
- impacted-node explanation exactly once
- Gate 1 → accepted read
- fresh durable evidence
- synthesis → independent critic
- Temporal-accepted Investigate → Decide
- realtime connector signal/clock/activity/citation changes
- reload
- duplicate and out-of-order SSE
- stale action
- backend/provider unavailable
- cross-run and cross-tenant negatives

No frontend mock or historical replay may satisfy this acceptance.

### Anti-drift rules

- Do not redesign Architecture or Live.
- Do not replace the page with a generic dashboard.
- Do not infer diagnosis, stage, evidence, graph relation, gate, recommendation,
  recovery, or success in the browser.
- Do not parse lifecycle truth from receipt prose.
- Do not expose backend or connector credentials to the browser.
- Do not add Gate 2, Execute, Recover, or Verify.
- Do not delete volumes or data without Daniel's approval.
- Do not use production credentials.
- Do not merge, deploy, or publish without explicit approval.
- Do not create another broad parser/docs/refactor loop.
- Prefer one bounded checkpoint and one exact SHA at a time.

### First response expected from the new session

Return a compact audit with:

1. frontend and backend HEAD/remote/clean status;
2. exact running image/source provenance;
3. why sequence 913 stopped advancing;
4. whether the fault is runtime configuration or source code;
5. the smallest backend-first repair checkpoint;
6. no frontend edits yet.

Stop after that audit unless the evidence clearly supports the bounded repair.

---

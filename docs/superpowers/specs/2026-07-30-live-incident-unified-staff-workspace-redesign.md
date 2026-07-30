# FlowPulse Live + Incident Unified Staff Workspace Redesign

**Status:** Proposed design for Daniel's review. This document authorizes no
implementation by itself.

**Date:** 2026-07-30

**Frontend baseline:** `972eb3edfc31db66cb96972bf99654d8eef4c719`

**Control-plane baseline:** `b3d975885671e03e610485606a55879891f10b00`

**Supersedes for this scope:**

- `2026-07-28-staff-incident-investigation-workspace-design.md`
- the frontend portions of
  `2026-07-29-realtime-incident-connectors-and-agent-workspace-design.md`

The backend connector, evidence, Temporal, tenant, security, and provenance
rules in the latter specification remain governing constraints unless this
document explicitly strengthens them.

## 1. Product decision

FlowPulse becomes one incident-response system with two complementary
surfaces:

- **Live is the operational radar.** It shows the whole system, active
  incidents, unassigned alert groups, affected components and business
  capabilities, and a fast route into investigation.
- **Incident is the command and investigation workspace.** It coordinates
  people, impact, hypotheses, evidence, mitigation decisions, and the durable
  timeline for one canonical incident.

They consume the same backend-owned incident truth. Live may aggregate that
truth; Incident may expose it in depth. Neither surface may independently
derive lifecycle, affected components, propagation, root cause, evidence
freshness, action safety, or successful execution.

Incident uses a **situation-first** reading order. It is not one large
dashboard and not one overloaded sidebar. It progressively opens detail
through quick peeks, docked investigation panes, and focused full-page flows.

## 2. Why the current system must change

The current running product has four structural failures.

1. **Split authority.** Live reads the legacy `/api/state` run while Incident
   reads the V2 control-plane projection. A component can therefore be
   "Last known" in Live and degraded in Incident at the same time.
2. **Short-lived realtime.** The Temporal workflow exceeds history size after
   roughly one incident session. The scheduler now correctly stops polling a
   closed workflow, but the user experience becomes stale rather than
   continuously live.
3. **Static signal contract.** The V2 projection exposes current values and
   trends, not bounded time-series samples. The browser cannot truthfully draw
   live charts from the current contract.
4. **Interaction revision collision.** Realtime projection ticks invalidate
   action cards that are bound to the projection revision. Gate 1 and later
   actions become unusable during normal realtime updates.

The redesign is incomplete until all four are corrected. A visual-only
frontend rebuild would preserve the underlying contradictions.

## 3. Staff operator model

During an incident, a Staff or Senior Staff engineer needs to maintain four
parallel mental models:

1. **Command:** impact, severity, lifecycle, ownership, communications, next
   update, and escalation.
2. **System:** affected capabilities, components, dependencies, and propagation.
3. **Investigation:** hypotheses, supporting and contradicting evidence,
   uncertainty, and next discriminating test.
4. **Mitigation:** proposed actions, risk, approval, execution, verification,
   rollback, and handoff.

FlowPulse must keep these models connected without putting all of their
contents on screen simultaneously.

The primary attention sequence is:

1. What is happening and how bad is it?
2. Is it still happening, and is the data fresh?
3. Who owns command, operations, and communications?
4. Which user journey, capability, and components are affected?
5. How is the failure propagating?
6. What are the leading hypotheses and contradictions?
7. What evidence would most reduce uncertainty?
8. What is being done now, by whom, and with what risk?
9. Did the mitigation actually improve the system?
10. What must be handed off or learned?

## 4. Canonical domain separation

FlowPulse must not collapse every red signal into an incident.

```text
Operational sample
  -> signal evaluation
  -> alert
  -> correlated alert group
  -> declared incident
  -> affected component / capability projection
  -> investigation and mitigation
```

- An **operational sample** is an immutable measured fact.
- An **alert** is a rule evaluation or admitted external alert.
- An **alert group** correlates related alerts and may remain unassigned.
- An **incident** is a formal coordinated response with lifecycle and roles.
- An **impact projection** is Temporal's accepted interpretation of how one or
  more incidents currently affect canonical topology and business capability.

The browser may display each level but may not promote one level to another.

### 4.1 Normative state machines

Alert state is:

```text
FIRING -> ACKNOWLEDGED -> RESOLVED
   \------------------------^
```

An acknowledged alert may return to `FIRING` only through a new admitted
provider event. A resolved alert does not reopen in place: a later recurrence
creates a new alert occurrence linked by `recurrence_of`.

Alert-group state is:

```text
OPEN -> ACKNOWLEDGED -> RESOLVED
```

Correlation is backend policy owned, tenant scoped, revisioned, and
idempotent by admitted provider identities plus correlation-policy revision.
Zero matches leave an alert unassigned. Multiple equally valid matches leave
it ambiguous and unassigned. Merge and split operations create durable
supersession relations and timeline events; they never rewrite historical
membership.

Incident lifecycle is:

```text
DECLARED -> INVESTIGATING -> MITIGATING -> MONITORING -> RESOLVED -> CLOSED
```

`DECLARED`, `INVESTIGATING`, and `MITIGATING` may move backward when accepted
facts require it. `MONITORING` may return to `MITIGATING` or `INVESTIGATING`.
A `RESOLVED` incident may be reopened to `INVESTIGATING` only by an authorized,
audited command within policy; a `CLOSED` incident never reopens and a
recurrence creates a related incident. Alert state and incident lifecycle are
separate fields and transitions.

Impact state is:

```text
HEALTHY | DEGRADED | CRITICAL | RECOVERING
```

Data quality is an orthogonal field:

```text
FRESH | DELAYED | STALE | UNKNOWN
```

`UNKNOWN` and `STALE` are therefore not competing health values. When data
quality is insufficient, the last accepted impact state may be shown only with
its observed time and a prominent quality state; it cannot be represented as
current health.

## 5. Authority and runtime architecture

```text
Providers / collectors
  -> immutable source facts
  -> identity binding and correlation
  -> durable dispatch outbox
  -> exact Temporal incident workflow
  -> canonical incident + impact projections
  -> snapshot APIs + ordered SSE
  -> Live and Incident
```

### 5.1 Authority

- Provider adapters own admitted external facts, not FlowPulse lifecycle.
- Postgres owns durable normalized records and read projections.
- MinIO owns versioned raw evidence artifacts.
- Temporal owns lifecycle transitions, routing decisions, impact acceptance,
  action orchestration, and projection commits.
- FastAPI owns authenticated query/command boundaries and ordered delivery.
- The browser owns only ephemeral presentation state: selection, pane layout,
  local chart viewport, and resume cursor.

### 5.2 Long-running workflow

Every incident workflow must use deterministic `continue-as-new` before
Temporal history approaches the configured safety threshold.

The identity contract is split explicitly:

- `incident_run_id` is FlowPulse's stable public run identity. It is immutable
  for the life of the Incident Workspace and remains in browser URLs,
  projections, evidence bindings, commands, and authorization assertions.
- `temporal_workflow_id` is the stable Temporal workflow identity used by
  `continue-as-new`.
- `temporal_run_id` identifies one physical Temporal execution generation. It
  is control-plane internal and changes on every rollover.
- `temporal_generation` is a monotonic FlowPulse generation number used for
  audit and compare-and-swap updates.

`IncidentRunBinding` must therefore stop treating one immutable
`workflow_run_id` as both the public run and current execution. It stores the
stable `incident_run_id` and `temporal_workflow_id`, plus an atomically
replaceable `(temporal_run_id, temporal_generation)` current-execution pointer.
The previous execution generations remain append-only audit records.

The workflow writes the next current-execution pointer through an idempotent
Postgres compare-and-swap activity during rollover initialization. The pointer
may advance only from generation `N` to `N+1` for the same tenant, incident,
public run, and workflow ID. Scheduler liveness checks resolve the current
pointer immediately before describing or signalling the exact execution. A
closed generation is never cached as the durable incident identity.

Browser commands and authorization assertions bind to stable
`incident_run_id`, `temporal_workflow_id`, and the appropriate
`decision_revision`; they do not bind to `temporal_run_id`. The control plane
resolves and validates the current execution generation before delivery.
Commands admitted before rollover remain idempotently admissible after
rollover when their decision preconditions still hold. Delivery receipts record
the physical generation that accepted the command.

Carry-forward state is deliberately bounded. It includes canonical identity,
lifecycle, current revision watermarks, role references, active durable-action
references, connector cursor watermarks, and bounded active timer descriptors.
It does **not** include complete receipt maps, samples, timeline items, evidence
bodies, or every historical idempotency key.

Idempotency receipts and realtime dedupe records move to tenant-scoped
Postgres tables with retention and lookup by stable public identity. Workflow
state carries only bounded recent-key fingerprints needed for deterministic
in-flight handling plus durable high-water marks. Raw samples, full activity
history, and evidence bodies remain referenced in Postgres/MinIO.

`continue-as-new` preserves the stable public identity, decision state, and
ordered case event stream. The frontend must not observe a new incident, URL,
sequence reset, or authorization boundary.

### 5.3 Separate revision domains

The system needs independent monotonic revisions:

- `projection_revision`: incident/impact read model
- `signal_revision`: operational samples and chart windows
- `decision_revision`: hypotheses, Gate 1, approvals, and action preconditions
- `workspace_revision`: roles, tasks, timeline annotations, and pane-share
  metadata
- `topology_revision`: canonical component/edge model

A metric tick may advance `signal_revision` and, when accepted as meaningful,
`projection_revision`. It must not automatically invalidate an action issued
against `decision_revision`.

When a changed fact materially alters an action's preconditions, Temporal marks
the action `REVALIDATION_REQUIRED` and explains the invalidated condition.

The minimal `decision_revision` migration is a Phase 0 runtime-correctness
requirement. It includes backend action issuance/validation, authorization
assertions, receipts, and the V3 browser action route. Richer Gate and
execution UX remains Phase 4.

### 5.4 Tenant-global Live ordering

Per-incident workflows do not allocate the Live global sequence themselves.
Every accepted incident/alert/impact change writes, in one Postgres
transaction:

1. its canonical per-case projection/event;
2. its contribution to the tenant Live materialized projection;
3. a tenant-global Live outbox row with a sequence allocated by a
   tenant-scoped database sequence/locked counter; and
4. the resulting Live snapshot watermark.

The Live aggregation transaction applies deterministic precedence using
accepted severity, lifecycle, incident start time, and stable incident ID.
Concurrent workflows affecting the same component serialize only their
materialized Live contribution, not their whole workflows. The committed
tenant-global sequence is the sole order used by Live SSE.

`GET Live snapshot` returns a database-consistent materialized snapshot and
the exact committed global watermark included in that snapshot. Streaming
starts strictly after that watermark. An event committed after the snapshot
transaction is therefore delivered by SSE; one committed before or at the
watermark is already represented in the snapshot. Gap recovery rehydrates a
new snapshot and watermark rather than merging incomparable workflow-local
sequences.

## 6. Unified read contracts

### 6.1 Live operational snapshot

Introduce a versioned upstream endpoint and preserve the same-origin BFF:

```text
FastAPI: GET /v3/live/snapshot
FastAPI: GET /v3/live/events?after=<sequence>

Browser: GET /api/control-plane/v3/live/snapshot
Browser: GET /api/control-plane/v3/live/events?after=<sequence>
```

The snapshot contains:

- canonical topology revision and display graph
- active incidents ordered by severity and start time
- unassigned alert groups
- business capability impact
- per-component and per-edge incident overlays
- connector/data freshness summary
- global sequence and snapshot generation time

Each component overlay contains backend-owned:

- `health_state`: `HEALTHY | DEGRADED | CRITICAL | RECOVERING | UNKNOWN`
- highest accepted severity
- active incident count and ordered incident references
- unassigned alert-group count
- accepted propagation edge references
- most recent material change time
- freshness

Live never joins the legacy `/api/state` identity with V2 incidents in the
browser. During migration, legacy state may be displayed in a separately
labelled compatibility view only; it cannot contribute to the canonical
overlay.

### 6.2 Incident command snapshot

Extend the incident projection with:

- alert state and incident lifecycle as separate fields
- severity, impact, affected capabilities, and user journey
- command/operations/communications roles
- owner, responders, and next required status-update time
- incident clock anchors
- accepted impacted nodes and propagation edges
- current mitigation state
- leading hypotheses and unknowns
- connector and datum-level freshness
- separate revision-domain values

### 6.3 Bounded metric series

Add server-owned series contracts. A series includes:

- metric/series ID, safe display name, unit, authority, and source
- component/edge/capability binding
- query or expression hash
- requested and effective time range
- sample step and downsampling method
- ordered `(timestamp, value)` samples
- threshold bands and annotations
- observed, received, and generated times
- freshness SLA and freshness state
- partial/gap markers
- evidence references and safe deep links

The server returns bounded, downsampled windows appropriate for display.
The browser may interpolate only the incident duration from a server clock
anchor while the clock is fresh. It may not invent metric samples, smooth away
gaps, continue a stale line, or convert a provider failure into zero.

Recommended endpoints:

```text
FastAPI: GET /v3/cases/{case_id}/series?series_id=...&from=...&to=...&step=...
FastAPI: GET /v3/cases/{case_id}/series/events?after=<sequence>

Browser: GET /api/control-plane/v3/cases/{case_id}/series?...
Browser: GET /api/control-plane/v3/cases/{case_id}/series/events?...
```

The main incident snapshot contains only small overview series. Detailed panes
query bounded windows on demand.

Series requests use UTC instants, reject reversed or excessive ranges, cap
series count/sample count/response bytes, and return explicit partial results.
`NaN`, positive infinity, and negative infinity are encoded as typed missing
samples with a reason; they are never emitted as invalid JSON or displayed as
zero.

### 6.4 Datum-level freshness

Every visible operational datum carries:

- authority/source
- observed time
- received time
- freshness SLA
- `FRESH | DELAYED | STALE | UNKNOWN`
- coverage/gap state

Page-level connector health is a summary, not a replacement for datum-level
freshness. A stale Prometheus series must not invalidate a fresh deployment
record, and a fresh low-authority activity message must not make a stale metric
look current.

## 7. Live: operational radar

### 7.1 Default composition

Live shows:

1. compact global state bar
2. active-incident summary
3. full system topology with incident overlays
4. unassigned-alert queue
5. selected component quick peek

The graph remains a system map. It does not become a wall of labels, metrics,
or action buttons.

### 7.2 Aggregate behavior

Live aggregates all active incidents.

- One incident: show its severity and state.
- Multiple incidents: show the highest severity plus incident count.
- Active alert but no incident: show an alert marker distinct from incident
  impact.
- Missing/stale authority: show `UNKNOWN` or `STALE`, never healthy.
- Resolved incident: remove it from the active overlay after the canonical
  event; preserve it in history.

Component and edge state comes from the backend impact projection. Color,
icon, count, and text jointly encode state; color alone is insufficient.

### 7.3 Component quick peek

Clicking an affected component opens a bounded quick peek with:

- current accepted state, duration, and freshness
- affected capability/user path
- one compact key series
- active incidents and unassigned alert groups
- recent material change
- explicit `Open Incident` for each incident

With one incident, the primary CTA opens it. With multiple incidents, the user
selects one. Opening Incident preserves the component as requested initial
focus, while Incident still renders the overall situation first.

Quick peek performs no diagnosis, explanation creation, fresh read, or action.

## 8. Incident Overview: command surface

The Overview is intentionally incomplete. It gives command awareness and
routes deeper work.

### 8.1 Persistent command bar

Always visible on desktop:

- operator title
- severity
- alert state and incident lifecycle
- active duration
- impact summary
- freshness summary and last material update
- Incident Commander, Operations Lead, Communications Lead
- next update deadline
- current mitigation state

Contradictory combinations are rejected or degraded. For example, a stale
signal cannot produce “observed current metrics,” and a resolved alert cannot
remain visually firing without an explicit reconciliation state.

### 8.2 Situation summary

The first content block answers:

- what changed
- customer/business impact
- affected journey/capability
- current scope
- strongest known fact
- most important unknown
- current mitigation

Statements are server-owned and evidence-linked. Agent-generated summaries are
labelled as interpretations and cannot overwrite accepted lifecycle facts.

### 8.3 Signal strip

Show three or four incident-relevant series selected by backend policy:

- current value
- threshold
- direction/change
- bounded sparkline
- time window
- freshness

Typical metrics are error rate, latency, traffic, saturation, and queue lag.
The set is incident-specific; the frontend does not hard-code semantic meaning
from metric names.

### 8.4 Propagation map

Show only accepted impacted nodes and audited propagation edges for the
incident. Directional motion represents new ordered backend observations, not
generic decoration. Reduced-motion mode replaces it with static markers.

Selecting a node opens Quick Peek. `Open in Workspace` creates or focuses a
component investigation pane.

### 8.5 Command summary

The Overview includes concise, bounded sections for:

- leading hypotheses
- active tasks and owners
- recent critical timeline events
- latest internal/stakeholder update
- Gate/action state

Each section links to its complete workspace or full-page flow. The Overview
does not render full evidence, chat history, all tasks, or all timeline items.

## 9. Progressive disclosure and workspace model

### 9.1 Four presentation levels

1. **Overview:** command awareness.
2. **Quick Peek:** temporary read-only inspection without losing context.
3. **Docked Investigation Pane:** persistent working context.
4. **Focused Page:** complex sequential or safety-sensitive workflow.

### 9.2 Docked workspace

Desktop supports a stable split workspace with at most three simultaneously
visible panes. Additional panes remain in a Workspace Tray.

Supported pane types:

- Component Detail
- Metric Explorer
- Logs/Traces/Evidence
- Hypothesis Board
- Agent Investigation
- Task Board
- Timeline Slice

Panes may be focused, reordered, resized within limits, minimized to the tray,
closed, or restored. The product does not create browser popup windows.

Pane state is encoded in safe route/query state so a responder can copy a deep
link. Sensitive filters or raw evidence content are never placed in the URL.
Server-owned incident facts are not persisted as browser workspace state.
Route state is capped in encoded size and pane count. Unknown, unauthorized,
deleted, or version-incompatible panes recover to Overview with a named notice;
they do not prevent the incident from loading.

### 9.3 Shared investigation context

All compatible panes share:

- incident and optional component focus
- environment/region filters
- time cursor and selected time range
- `FOLLOW_LIVE | PAUSED | PINNED` mode
- comparison baseline

Changing the shared time range updates graphs, metrics, logs, traces, evidence,
and timeline slices through new bounded backend queries. A pane can detach from
the shared time range only with an obvious visual indicator.

Useful time controls:

- Follow Live
- Pause
- Jump to incident start
- Compare Before
- Pin Range
- Return to Now

## 10. Hypothesis Board

Known/Unknown becomes a structured hypothesis ledger.

Each hypothesis contains:

- immutable hypothesis ID and revision
- safe statement
- creator: human or agent
- owner
- `OPEN | TESTING | REJECTED | CONFIRMED | SUPERSEDED`
- confidence with declared method
- supporting evidence references
- contradicting evidence references
- explicit unknowns
- next discriminating test
- created and updated times

Agent suggestions enter as `OPEN` and clearly labelled suggestions. They do not
become confirmed because of prose confidence. Confirmation requires the
configured evidence policy and, where required, human acceptance.

Rejecting or superseding a hypothesis preserves it in the timeline. The system
never deletes inconvenient contradictory evidence from the incident record.

## 11. Roles, tasks, communication, and handoff

Incident supports explicit command roles:

- Incident Commander
- Operations Lead
- Communications Lead
- optional Scribe and subject-matter responders

Role assignment, reassignment, and handoff are durable timeline events.
Permissions may be further restricted by role but are never expanded by the
frontend. Tenant/account ACL is evaluated first; an incident role may narrow
available operations or grant only permissions explicitly allowed by the
tenant's role policy. A role can never override a tenant denial, evidence ACL,
capability policy, or separation-of-duty requirement.

Tasks contain owner, status, priority, due/next-check time, related hypothesis
or action, and completion evidence. Core states are:

```text
TODO -> IN_PROGRESS -> BLOCKED -> DONE
```

The command surface highlights unowned, blocked, or overdue tasks instead of
showing a generic activity count.

Internal updates and stakeholder updates are distinct records with audience,
author, timestamp, and next-update commitment. Generated drafts remain drafts
until a permitted human publishes them.

## 12. Timeline as the incident record

The canonical timeline merges ordered, typed references to:

- alert and lifecycle transitions
- material signal and impact changes
- role and ownership changes
- human notes
- agent findings and citations
- hypothesis changes
- task changes
- Gate reviews
- proposed/executed/verified/rolled-back actions
- internal and stakeholder updates
- connector gaps and reconciliation

The default timeline is a curated set of material events, not every metric
sample. Users can filter by category, actor, component, source, and time range.
Every event shows server time, actor/source, provenance, and applicable
freshness.

Manual timeline notes are additive and auditable. They cannot rewrite provider
facts or Temporal transitions.

## 13. Gate and action safety

The action lifecycle is:

```text
PROPOSED
  -> EVIDENCE_READY
  -> HUMAN_APPROVED
  -> EXECUTING
  -> VERIFYING
  -> VERIFIED | FAILED | ROLLED_BACK
```

Any state may move to `REVALIDATION_REQUIRED` when a material precondition
changes. Expired, superseded, or cross-revision actions fail closed.

Each action displays:

- intent and expected outcome
- affected resources and blast radius
- supporting and contradicting evidence
- preconditions
- required approver policy
- executor
- dry-run result when supported
- rollback plan
- verification series and success threshold
- durable receipts and timestamps

Gate 1 is a focused page, not a small sidebar button. It accepts only an opaque
server action ID, canonical identity, `decision_revision`, and idempotency key.
The browser never manufactures permission or optimistic success.

This design does not itself authorize production write capabilities. Read-only
investigation can ship before execution, but its UI must use the final action
state model so it does not require another conceptual rewrite.

## 14. Realtime and failure behavior

### 14.1 Snapshot plus ordered stream

Both Live and Incident use:

1. authenticated canonical snapshot
2. ordered SSE from the snapshot sequence
3. idempotent reducer
4. gap detection
5. canonical rehydrate after a gap, schema mismatch, or expired resume cursor

The UI becomes connected only after a schema-valid snapshot or event. It does
not infer connection from an open socket alone.

### 14.2 Fail-closed presentation

- Fresh data moves; stale data freezes.
- Gaps remain gaps; missing values are not zero.
- Provider unavailability is visible at the affected datum and summary level.
- Partial success identifies which sources remain usable.
- Out-of-order and cross-identity events are discarded and recorded.
- A failed command retains the last confirmed state and displays its receipt.
- Reconnect never duplicates an explanation, task, approval, or action.

## 15. Responsive and accessible behavior

### Desktop

- Overview uses the full page, not a permanent oversized sidebar.
- Quick Peek is bounded and dismissible.
- Investigation supports two or three stable panes plus the tray.
- Command bar remains reachable without covering content.

### Tablet

- One primary pane plus one optional secondary pane.
- Tray and focused pages replace dense multi-column layouts.

### Mobile

Mobile prioritizes awareness and bounded response, not full forensic
multitasking:

```text
status -> impact -> key signals -> propagation -> tasks -> recent timeline
```

Quick Peek and investigation panes become full-screen pages in a navigation
stack. Users can acknowledge, assign, comment, approve when permitted, and
inspect evidence. Dense multi-series comparison and arbitrary pane layout are
desktop-first.

Only the topology region may scroll horizontally. The document must not have
accidental horizontal overflow.

All state uses text/icon equivalents, focus order is deterministic, chart
values have accessible tables/summaries, keyboard operation covers panes and
trays, and reduced-motion mode removes pulses without removing meaning.

## 16. Visual language

- Neutral, information-dense, calm control-room presentation.
- Red is reserved for active critical impact; amber for degraded/delayed;
  green for verified recovery; gray for unknown/stale.
- Motion indicates a new accepted event, propagation direction, or live clock,
  never general “activity.”
- Raw IDs are hidden behind Evidence/Details.
- Charts show axes, unit, range, gaps, threshold, current cursor, and freshness.
- Every card has one job and at most one primary action.
- Empty space is preferred to duplicated summaries.

## 17. API and persistence additions

Backend work is expected in these bounded modules:

1. unified Live projection and ordered global event stream
2. alert/alert-group/incident domain separation
3. bounded metric-series query and streaming updates
4. workflow `continue-as-new`
5. independent revision domains
6. hypothesis ledger
7. role/task/communication records
8. expanded typed timeline
9. action revalidation and verification state
10. workspace-safe deep-link metadata

Every new record is tenant-scoped, revisioned, provenance-bearing, and subject
to existing ACL and audit rules. Raw logs, traces, credentials, and unsafe
provider links are never copied into generic projection fields.

### 17.1 Schema version and compatibility

The frozen `flowpulse.incident-projection.v2` remains immutable. This redesign
introduces `flowpulse.incident-projection.v3`, V3 command/assertion schemas, and
the `/v3` upstream plus `/api/control-plane/v3` browser BFF namespaces.

V2 and V3 run side by side during migration:

- V2 clients continue to receive the frozen V2 projection and V2 event
  envelopes.
- V3 capability discovery declares supported projection, command, series, and
  stream schema versions.
- A V3 client refuses to combine V2 Live state with a V3 incident.
- The BFF validates and redacts each version independently and never forwards
  browser-supplied provider credentials.
- Unsupported or downgraded schemas fail closed with an explicit
  compatibility state.
- V2 removal requires telemetry showing no supported V2 clients and a
  separately approved cutover.

The server may build both versioned projections from the same accepted durable
facts, but one response/envelope has exactly one declared schema.

## 18. Migration sequence

### Phase 0: runtime correctness

- implement and prove `continue-as-new`
- add workflow liveness and history-size observability
- preserve SSE sequence and idempotency across runs
- introduce minimal `decision_revision`
- migrate action issuance, authorization assertions, command validation, and
  receipts off realtime `projection_revision`
- enable the V3 browser/BFF action route
- preserve old-card behavior explicitly across workflow rollover

No “continuous realtime” claim is allowed before Phase 0 passes.

### Phase 1: one source of truth

- introduce unified V2 Live snapshot/stream
- project active incidents and unassigned alerts onto canonical topology
- remove the legacy/V2 browser join
- implement Live quick peek and Incident deep link

### Phase 2: truthful situation-first Incident

- add alert/lifecycle separation, command roles, clock, impact, freshness
- add bounded overview series
- rebuild Overview, signal strip, propagation map, and concise command summary

### Phase 3: investigation workspace

- shared time context
- docked panes and tray
- detailed metric series
- evidence/log/trace panes
- Hypothesis Board and filtered timeline

### Phase 4: coordination and safe decisions

- roles, tasks, communications, handoff
- Gate 1 focused flow
- material-precondition revalidation and rich action UX
- execution/verification UI only for separately authorized capabilities

Each phase must leave Live and Incident internally consistent. Temporary
compatibility states must be explicitly labelled and cannot mix authorities.

## 19. Verification and acceptance

### Backend

- Temporal replay and continue-as-new tests
- history-size soak test longer than the current failure window
- projection/revision invariants
- alert-group/incident correlation and ambiguity tests
- series ordering, gaps, bounds, downsampling, and freshness tests
- SSE resume, gap, duplicate, and rehydrate tests
- cross-tenant/identity rejection
- hypothesis and action state-machine tests
- approval idempotency and material-change revalidation tests

### Frontend

- reducer tests for all revision domains and stale/out-of-order events
- no browser-derived health, propagation, freshness, or success
- Live/Incident identity consistency
- shared time-context synchronization
- pane/tray restoration and safe deep links
- stale freeze and partial-provider behavior
- accessible charts, keyboard navigation, and reduced motion
- mobile page-stack and horizontal-overflow checks

### Cross-stack scenarios

1. Start one real incident and observe the same impacted Checkout component in
   Live and Incident.
2. Add a second incident affecting the same component and verify aggregate
   severity/count plus explicit selection.
3. Stream real bounded series and verify values, chart gaps, duration, and
   freshness change from backend events.
4. Kill one connector and verify only its data freezes and becomes stale.
5. Run beyond the previous Temporal history failure point with no user-visible
   reset.
6. Open Component, Metric, Evidence, and Timeline panes with one shared time
   range and deep-link restoration.
7. Create competing hypotheses with supporting and contradicting evidence.
8. Approve Gate 1 while metric ticks continue; verify the action remains valid
   unless a material precondition changes.
9. Reconnect after dropped SSE and verify no duplicate durable actions.
10. Verify the 451x859 layout has no page-level horizontal overflow.
11. Roll over while a command is in flight; retry it before and after rollover
    and verify one durable receipt against the stable public identity.
12. Reconnect SSE across rollover and verify no sequence reset or event loss.
13. Commit two incident workflows concurrently against one Live component and
    verify deterministic aggregate state and tenant-global order.
14. Commit a Live change during snapshot creation and verify the snapshot
    watermark plus SSE represents it exactly once.
15. Resolve, recur, merge, and split alerts/groups and verify immutable
    historical membership and explicit supersession.
16. Verify the browser BFF rejects direct provider credentials and does not
    expose upstream secrets.
17. Load old V2 clients, unsupported V3 clients, and downgraded envelopes and
    verify the compatibility/fail-closed matrix.
18. Cross retention boundaries for timeline, hypotheses, tasks, and
    idempotency receipts and verify pagination plus duplicate prevention.

Acceptance evidence includes canonical IDs, revisions, sequence ranges,
workflow history/run data, connector health, API request/status records, and
desktop/mobile screenshots. Fixture-only results do not satisfy cross-stack
acceptance.

## 20. Explicit non-goals

- Browser-owned diagnosis, correlation, lifecycle, evidence, or action success.
- Treating a Grafana panel, recent deploy, model confidence, or topology shape
  as current proof by itself.
- Rendering every signal, event, task, and evidence item on Overview.
- Unlimited floating windows or browser popup windows.
- Automatic production remediation without separate capability authorization.
- Hiding stale, unknown, partial, rejected, failed, or contradictory states.
- Replacing the durable incident timeline with transient chat.

## 21. Final design test

The redesign succeeds when a responder can answer, without reconciling two
contradictory pages:

- What is broken and who is affected?
- Is that fact current and where did it come from?
- Which incidents and alerts explain the component state?
- Who is in charge and what happens next?
- Which hypotheses remain plausible, and why?
- Which action is proposed, who approved it, and is it still safe?
- Did the system recover according to live verification evidence?

If any answer depends on browser inference, stale prose, an unrelated run, or
an invisible provider failure, the design has not been implemented.

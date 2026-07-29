# Realtime Incident Connectors and Agent Workspace Design

**Status:** User-approved direction; concrete contract draft pending Daniel's
review and approval

**Date:** 2026-07-29

**Backend baseline:** `d08b4e342ff0044c0bb13a10e32f3442b85c75df`

**Compatibility baseline:** frozen Incident Workspace v1.3 artifacts produced by
`a1ccd415fe8f3e263ae03391f5e6f51fbfb26cd0`

## Loop contract

**Goal.** Turn Incident from a static diagnosis report into a truthful,
continuously changing Staff control room. Phase 1 ingests read-only operational
signals from PagerDuty, Prometheus/Grafana, OpenTelemetry traces/logs, and GitHub
deploy/change data, then projects them through the existing Temporal-authoritative
Incident Workspace. Later phases add bounded operator collaboration and a
separately authorized remediation lifecycle.

**Input scope.** The current FastAPI, Temporal, Postgres, MinIO, evidence,
capability, projection, and SSE contracts at the backend baseline above. No
connector credential, production endpoint, frontend-owned inference, or
automatic write authority is assumed.

**Execute.**

1. Admit authenticated connector deliveries or bounded poll results as immutable
   source facts.
2. Bind each fact to one tenant and an authoritative external identity mapping.
3. Notify the exact Temporal workflow without letting the connector mutate its
   lifecycle or projection.
4. Let Temporal accept, reject, reconcile, or route the fact and commit one
   ordered projection/event transition.
5. Render only backend-issued signal, graph, clock, connector-health, agent
   activity, and citation records.

**Checks.** Connector identity, signature, replay, tenant/ACL, provenance,
freshness, ordering, reconciliation, Temporal replay, projection compatibility,
SSE resume, and unavailable-tool behavior are deterministic and fail closed.

**Feedback rules.**

- Signature, scope, or binding failure -> reject before normalization and record
  a redacted delivery failure.
- Duplicate delivery -> return the original ingest receipt without creating a
  second source event or Temporal transition.
- Provider gap or cursor drift -> mark the connector `DEGRADED`, reconcile a
  bounded overlap, and never fabricate missing events.
- Unbound or stale adapter -> omit its capability from agent tools; expose its
  truthful health state only to authorized connector/status views.
- Ambiguous incident routing -> keep the source event `UNASSIGNED`; do not attach
  it to an arbitrary case or start a workflow.
- Temporal unavailable -> retain a dispatch-pending source event and retry from
  the durable outbox; do not update the browser projection directly.

**Records.** Raw artifact reference, normalized source event, external identity
binding revision, connector health/cursor, dispatch receipt, Temporal decision,
evidence/claim lineage, projection revision, case event sequence, capability
audit, and agent activity/citations.

**Stop conditions.** Phase 1 stops at a read-only, auditable live control room.
Phase 2 requires an explicit product authorization for operator messages and
task assignment. Phase 3 requires a separate implementation authorization,
registered write capability, human approval, dry run, and independent
verification. This specification grants no production write authority.

**Human gates.** Connector credential installation, tenant enablement, new data
retention policy, remediation proposal approval, external write execution, and
production rollout remain human-controlled.

## Product decision

Incident is a live control room, not a component drawer and not a report that is
regenerated after the fact. The UI shows what the backend has durably observed,
what Temporal has accepted, which bounded tool is running, what evidence supports
the current interpretation, and how fresh each signal is. Visual motion is a
rendering of ordered backend events; it is never a browser simulation of
activity.

Three designs were considered:

1. **Browser-to-vendor integrations.** Rejected because credentials, tenant
   routing, replay protection, and evidence provenance would escape the control
   plane.
2. **A connector service that owns a second live state machine.** Rejected
   because it would compete with Temporal for incident lifecycle and projection
   authority.
3. **An immutable connector fact plane feeding the existing Temporal workflow.**
   Selected. Postgres and MinIO retain source facts, while Temporal alone accepts
   incident lifecycle/projection changes.

## Verified current truth

The following are real at the design baseline:

- Temporal is the sole durable workflow and lifecycle-transition authority.
- Postgres stores tenant-scoped append-only records and read projections.
- MinIO/S3-compatible object storage holds versioned raw evidence artifacts.
- OpenTelemetry is a real telemetry and correlation substrate; it is not a
  browser animation fixture.
- FastAPI exposes tenant-scoped incident discovery, canonical projection,
  ordered global and per-case SSE, exactly-once node explanations, Gate 1,
  server-issued actions, and the evidence-backed Investigate-to-Decide handoff.
- The capability registry defines names including `METRICS`, `LOGS`, `TRACES`,
  `TOPOLOGY`, `DEPLOY_CONFIG`, `KAFKA`, `GITHUB_TICKETING`, and `SAFE_ACTION`.

The following are not real and must not be marketed or rendered as connected:

- There is no live PagerDuty connector.
- There is no live Grafana or Prometheus connector.
- There is no live GitHub deploy/change connector.
- Most named external capability adapters are unbound. Today, the production
  registry has only the explicitly configured recorded-context/current-evidence
  paths needed by the existing Incident Workspace.
- A capability enum, test fixture, deterministic provider, dashboard URL, or
  checked-in topology does not prove a live vendor connection.

`ConnectorHealth.state=CONNECTED` therefore requires a configured adapter,
successful credential/endpoint validation, and a fresh successful ingest or
poll. An enum value alone can never satisfy that condition.

## Authority and data-flow architecture

```text
PagerDuty webhook ----\
GitHub webhook --------+--> Connector ingress --> raw artifact (MinIO)
Prometheus poll -------/          |                    |
Grafana metadata poll -/          +--> normalized source event (Postgres)
OTEL collector/exporter ---------/          |
                                             +--> durable dispatch outbox
                                                        |
                                                        v
                                               Temporal workflow update
                                                        |
                                      validate / route / reconcile / abstain
                                                        |
                                                        v
                                projection + evidence + event commit (Postgres)
                                                        |
                                   FastAPI query + ordered case/global SSE
                                                        |
                                                        v
                                          same-origin frontend BFF/browser
```

The connector ingestion boundary may store facts but cannot set incident stage,
component status, graph impact, agent state, recommendation, approval, or
recovery. It publishes a typed `SourceEventAvailable` command carrying immutable
identifiers, not an arbitrary projection patch. Temporal invokes an activity to
read and validate the stored event, decides whether it affects the incident, and
commits the resulting projection/event through the existing repository boundary.

For an event that has no case binding:

- a unique, policy-authorized PagerDuty incident binding may start one new
  Incident Workspace workflow through the existing intake authority;
- a unique existing external binding may signal one exact workflow;
- zero or multiple matches remain `UNASSIGNED` and are visible only in the
  connector reconciliation view.

There is no fuzzy browser-side or model-side case matching.

## Phase 1 connector boundary

### Shared connector contract

Every connector implements a strict server-side descriptor:

```json
{
  "connector_id": "conn-pagerduty-primary",
  "tenant_id": "tenant-123",
  "provider": "PAGERDUTY",
  "adapter_version": "pagerduty-read.v1",
  "ingest_modes": ["SIGNED_WEBHOOK", "BOUNDED_POLL"],
  "data_classes": ["INCIDENT", "ALERT"],
  "capabilities": ["PAGERDUTY_INCIDENT_READ"],
  "freshness_sla_seconds": 120,
  "enabled": true
}
```

The descriptor is backend configuration. It contains no credential or endpoint
secret and is never supplied by the browser or a model. A connector is available
to an agent only when:

1. the descriptor is enabled;
2. a concrete adapter is registered;
3. its tenant binding and credential reference resolve;
4. the latest health state is `CONNECTED`;
5. the capability policy permits the exact subject/run/component/data class;
6. the event or read is within its freshness SLA.

### Delivery and polling rules

Signed webhooks are preferred for PagerDuty and GitHub. The raw request body is
verified before JSON parsing. Signature key ID, provider delivery ID, timestamp,
body SHA-256, connector ID, and receive time form the replay record. The default
timestamp replay window is five minutes; a provider with a stronger native
delivery guarantee may narrow it.

Prometheus, Grafana presentation metadata, and reconciliation use bounded polls:

- interval is server-configured between 15 and 300 seconds;
- request timeout is at most 10 seconds;
- page count is at most 10 and uncompressed response size at most 5 MiB;
- each poll uses a server-owned cursor and a bounded overlap window;
- jitter prevents synchronized polling;
- retries are bounded and recorded; they do not advance the cursor on failure;
- redirects and resolved addresses must remain inside the configured endpoint
  allowlist to prevent SSRF.

OpenTelemetry data arrives through a configured collector/exporter or bounded
query adapter. The FastAPI browser API does not accept arbitrary OTLP payloads.

### Provider responsibilities

#### PagerDuty

Phase 1 reads incident/alert creation, acknowledgment, escalation, reassignment,
status, urgency, service identity, and timestamps. It does not acknowledge,
resolve, reassign, or edit PagerDuty incidents.

External identities include account, service, incident, alert/dedup, escalation
policy, and delivery IDs. PagerDuty incident identity may seed a new FlowPulse
incident only through a tenant routing policy and an idempotent Temporal start.

#### Prometheus and Grafana

Prometheus query results and recording rules are the metrics data authority.
OpenTelemetry metrics may also be an authority when their collector/exporter and
resource identity are configured. Queries record expression hash, time range,
step, series labels after allowlisted normalization, sample timestamps, and
source endpoint identity.

Grafana is a presentation and organization API: dashboard, panel, folder,
annotation, datasource reference, and safe deep-link metadata. Grafana panel
JSON, alert visualization, or dashboard title is not current metric proof by
itself. A Grafana panel citation must resolve to an admitted Prometheus or
OpenTelemetry evidence record before it can support a diagnosis.

The UI may display “Grafana dashboard” as a citation link and “Prometheus
metrics” as the evidence authority. It must never collapse both into a single
ambiguous “Grafana data” source.

#### OpenTelemetry traces and logs

Phase 1 admits bounded trace/span and log records with resource identity,
trace/span IDs, timestamps, severity/status, service name, deployment attributes,
schema/semantic-convention version, content hash, and redaction result.

Trace topology changes and dependency pulses require recorded parent/child or
span-link evidence. Log correlation requires a shared trace/span or an explicit
server-owned entity/time binding. The browser does not infer an edge from
co-occurring text.

#### GitHub deploy and change

Phase 1 reads installation/repository identity, push, deployment,
deployment-status, release, pull-request merge, commit SHA, environment, actor,
and delivery timestamps. GitHub App installation tokens remain server-side.

GitHub change evidence is a deployment/change prior until it is correlated with
current PagerDuty, Prometheus, or OpenTelemetry evidence. A recent commit alone
cannot confirm root cause. Phase 1 never creates issues, comments, reverts,
deploys, merges, or changes repository state.

## Immutable source event and identity contracts

### External identity binding

```json
{
  "binding_id": "binding-01HV...",
  "binding_revision": 3,
  "tenant_id": "tenant-123",
  "provider": "GITHUB",
  "connector_id": "conn-github-prod",
  "external_account_id": "installation:12345",
  "external_resource_type": "repository",
  "external_resource_id": "org/checkout",
  "canonical_entity_type": "COMPONENT",
  "canonical_entity_id": "checkout",
  "valid_from": "2026-07-29T18:00:00Z",
  "valid_to": null,
  "status": "ACTIVE",
  "provenance": {
    "created_by": "subject-123",
    "source": "OWNER_CONFIG",
    "reviewed_at": "2026-07-29T18:00:00Z"
  }
}
```

Bindings are tenant-scoped, revisioned, append-only, non-overlapping for the
same provider resource, and cannot rebind an existing source event. A new
binding revision affects only events whose effective time falls inside its
validity interval.

### Normalized source event

```json
{
  "source_event_id": "src-01HV...",
  "schema_version": "flowpulse.connector-source-event.v1",
  "tenant_id": "tenant-123",
  "connector_id": "conn-prometheus-prod",
  "provider": "PROMETHEUS",
  "provider_event_id": "poll:cursor-882:series-sha256",
  "delivery_id": "delivery-01HV...",
  "raw_artifact_ref": "s3://flowpulse-connector-raw/tenant-123/...",
  "raw_content_hash": "64-hex-sha256",
  "event_kind": "METRIC_THRESHOLD_OBSERVED",
  "external_resource_refs": ["prometheus:cluster-a:checkout_request_errors"],
  "binding_revision": 7,
  "case_id": "workspace-case-...",
  "incident_id": "incident-...",
  "run_id": "run-...",
  "topology_revision": "topology-...",
  "component_ids": ["checkout"],
  "edge_ids": ["frontend->checkout"],
  "observed_at": "2026-07-29T18:03:10Z",
  "effective_at": "2026-07-29T18:03:00Z",
  "received_at": "2026-07-29T18:03:12Z",
  "freshness": "CURRENT",
  "authority": "T0_AUTHORITATIVE_CURRENT",
  "proof_scope": "CURRENT_OBSERVATION",
  "acl_subjects": ["incident-team"],
  "normalizer_version": "prometheus-normalizer.v1",
  "normalization_hash": "64-hex-sha256",
  "routing_state": "BOUND",
  "dispatch_state": "PENDING"
}
```

The unique delivery identity is
`(tenant_id, connector_id, provider_event_id)`. Repeating the same identity and
content hash returns the original receipt. Repeating it with a different hash is
`CONFLICTED` and cannot be dispatched. Source event IDs, hashes, timestamps,
binding revision, and normalized identity are immutable.

Raw payloads live in a dedicated tenant-prefixed object bucket. Projections and
SSE carry only normalized, bounded, redacted fields and artifact/evidence
references.

### Connector health

```json
{
  "connector_id": "conn-otel-prod",
  "provider": "OTEL",
  "state": "CONNECTED",
  "checked_at": "2026-07-29T18:03:15Z",
  "last_success_at": "2026-07-29T18:03:12Z",
  "last_event_observed_at": "2026-07-29T18:03:10Z",
  "fresh_until": "2026-07-29T18:05:10Z",
  "cursor": "opaque-server-cursor",
  "consecutive_failures": 0,
  "lag_seconds": 2,
  "reason_code": null,
  "adapter_version": "otel-read.v1"
}
```

Allowed states are `CONNECTED`, `DEGRADED`, `STALE`, `UNAVAILABLE`,
`MISCONFIGURED`, and `DISABLED`. Only `CONNECTED` may advertise a callable
capability. `DEGRADED` may show last-known signals with a visible warning;
`STALE` preserves history but cannot support current proof.

## Temporal processing and reconciliation

Each accepted source event creates one durable outbox item. Dispatch submits a
typed workflow update keyed by:

```text
connector_event:{tenant_id}:{run_id}:{source_event_id}:{normalization_hash}
```

The workflow:

1. validates public/internal run binding and current case revision;
2. reads the source event and active binding through an activity;
3. verifies tenant, ACL, component/edge, effective time, freshness, authority,
   proof scope, content hash, and connector health;
4. deduplicates against accepted source event IDs;
5. optionally admits an `EvidenceEnvelope` and cited claim/coverage records;
6. lets Monitor/Triage logic propose a bounded projection delta;
7. accepts or rejects the delta deterministically;
8. commits source acceptance, evidence, capability audit, agent activity,
   projection revision, and ordered case event in one idempotent transaction.

The connector event is never considered lifecycle-accepted until step 8.
Activity retry after a lost response returns the exact prior commit.

Reconciliation compares a server cursor with a bounded provider time window.
Missed events use their original provider timestamps and
`ingest_mode=RECONCILIATION`. They enter the same dedupe and Temporal path.
Cursor advance and reconciliation receipt are atomic. A provider gap larger
than the configured overlap marks health `DEGRADED` and requires a bounded
operator-authorized backfill; it does not silently skip.

## Versioned public projection

The frozen `/v1` projection and SSE contracts remain unchanged. The rich live
control-room contract is published as `/v2`; it is not added as unknown fields
to strict v1 models.

`IncidentProjectionV2` carries every v1 identity and revision unchanged, plus:

```json
{
  "schema_version": "flowpulse.incident-projection.v2",
  "tenant_id": "tenant-123",
  "incident_id": "incident-123",
  "run_id": "run-123",
  "topology_revision": "topology-17",
  "case_id": "workspace-case-123",
  "case_revision": 1,
  "workflow_id": "flowpulse.incident-workspace:tenant-123:run-123",
  "workflow_run_id": "temporal-run-uuid",
  "projection_revision": 42,
  "sequence": 108,
  "source_revision": 27,
  "connector_revision": 8,
  "evidence_revision": 14,
  "action_revision": 6,
  "lifecycle_state": "ACTIVE",
  "lifecycle_stage": "INVESTIGATE",
  "incident_clock": {},
  "connector_health": [],
  "realtime_signals": [],
  "graph": {},
  "active_graph_pulses": [],
  "incident_focus": {},
  "agent_workspace": {},
  "investigation_result": null
}
```

V1 and V2 read projections are generated from the same accepted Temporal
transition and committed together. V1 never receives V2-only fields. V2 is not
a second lifecycle state; it is a richer read model.

### Realtime Signal Bar

`realtime_signals` is ordered by backend priority, then observed time, then
signal ID, and is capped at 12:

```json
{
  "signal_id": "signal-01HV...",
  "source_event_id": "src-01HV...",
  "provider": "PROMETHEUS",
  "source_label": "Prometheus",
  "signal_kind": "ERROR_RATE",
  "title": "Checkout error rate",
  "display_value": "8.4%",
  "status": "CRITICAL",
  "trend": "RISING",
  "component_ids": ["checkout"],
  "edge_ids": ["frontend->checkout"],
  "observed_at": "2026-07-29T18:03:10Z",
  "fresh_until": "2026-07-29T18:04:10Z",
  "freshness": "CURRENT",
  "authority": "T0_AUTHORITATIVE_CURRENT",
  "evidence_refs": ["evidence-123"],
  "citation_refs": ["citation-123"],
  "connector_state": "CONNECTED",
  "sequence": 108
}
```

`display_value`, title, status, trend, component/edge bindings, authority, and
freshness are backend projections. The frontend formats layout but does not
parse raw samples, choose thresholds, associate components, or infer health.

### Incident duration

```json
{
  "state": "RUNNING",
  "started_at": "2026-07-29T17:55:00Z",
  "last_signal_at": "2026-07-29T18:03:10Z",
  "resolved_at": null,
  "as_of": "2026-07-29T18:03:15Z",
  "elapsed_seconds": 490,
  "freshness": "CURRENT",
  "fresh_until": "2026-07-29T18:03:45Z",
  "max_interpolation_seconds": 30
}
```

Temporal owns `started_at`, `resolved_at`, and clock state. The query layer
computes `as_of` and `elapsed_seconds` from trusted server time without creating
a lifecycle transition. Allowed clock states are `RUNNING`, `PAUSED`, and
`RESOLVED`; `freshness` is `CURRENT`, `STALE`, or `DISCONNECTED`.

To keep the duration visibly continuous, the frontend may interpolate
display-only elapsed time from the latest trusted
`(as_of, elapsed_seconds)` anchor using a monotonic local clock. Interpolation
is allowed only while:

- backend state is `RUNNING`;
- backend freshness is `CURRENT`;
- the local monotonic delta is no greater than
  `max_interpolation_seconds`; and
- trusted wall time has not passed `fresh_until`.

Every projection or SSE clock update replaces the anchor and resynchronizes the
display. If the freshness window expires, SSE disconnects beyond that window,
or the backend reports `STALE`/`DISCONNECTED`, the UI freezes at the last
bounded value and visibly labels the duration stale or disconnected. A backend
`PAUSED` or `RESOLVED` state immediately stops interpolation and freezes at the
backend-supplied `elapsed_seconds`; `RESOLVED` also renders the authoritative
`resolved_at`.

Interpolation is presentation arithmetic only. It emits no source event,
evidence, stage, recovery, success, agent activity, projection revision, or
projection mutation. The frontend may never infer incident start, pause,
resolution, or lifecycle state from the passage of local time.

### Dynamic impacted graph and pulses

The canonical graph remains connected-or-classified. New source events may
change backend-owned node `runtime_status`/`impact_status` and edge `status`
only through an accepted projection transition.

`active_graph_pulses` is capped at 32:

```json
{
  "pulse_id": "pulse-01HV...",
  "source_event_id": "src-01HV...",
  "event_sequence": 108,
  "edge_ids": ["frontend->checkout", "checkout->payment"],
  "component_ids": ["frontend", "checkout", "payment"],
  "pulse_kind": "ERROR_PROPAGATION",
  "severity": "CRITICAL",
  "started_at": "2026-07-29T18:03:10Z",
  "expires_at": "2026-07-29T18:03:20Z",
  "evidence_refs": ["evidence-123"]
}
```

The browser animates only the listed IDs during the server-issued interval.
There is no random pulse, timer-created fake event, inferred path, or animation
that claims provider activity. Reload uses `active_graph_pulses`; SSE adds or
expires pulses by ID.

### Live Agent Workspace

The V2 projection contains:

```json
{
  "agent_workspace": {
    "workspace_revision": 19,
    "mode": "READ_ONLY",
    "activities": [
      {
        "activity_id": "agent-activity-01HV...",
        "sequence": 108,
        "role": "MONITOR",
        "state": "COMPLETED",
        "trigger": "CONNECTOR_EVENT",
        "capability": "METRICS",
        "capability_version": "prometheus-read.v1",
        "tool_label": "Prometheus metrics",
        "component_ids": ["checkout"],
        "started_at": "2026-07-29T18:03:11Z",
        "completed_at": "2026-07-29T18:03:12Z",
        "summary": "Observed a current checkout error-rate increase.",
        "source_event_ids": ["src-01HV..."],
        "evidence_refs": ["evidence-123"],
        "citation_refs": ["citation-123"],
        "truth_label": "LIVE",
        "external_write_performed": false,
        "degraded_code": null
      }
    ],
    "citations": [
      {
        "citation_id": "citation-123",
        "provider": "PROMETHEUS",
        "evidence_id": "evidence-123",
        "source_event_id": "src-01HV...",
        "label": "Checkout error rate, 18:03 UTC",
        "observed_at": "2026-07-29T18:03:10Z",
        "freshness": "CURRENT",
        "safe_detail_path": "/v2/incidents/workspace-case-123/evidence/evidence-123"
      }
    ]
  }
}
```

Phase 1 roles are `MONITOR` and `TRIAGE`.

- Monitor evaluates incoming normalized facts and connector freshness.
- Triage correlates accepted current evidence with canonical topology and
  deploy/change priors, producing candidates for the existing bounded
  investigation path.

An activity is visible only after its start record is durable. Completion,
degradation, or rejection is a later append-only record with the same ID.
Provider/capability absence yields `DEGRADED` or no activity, never a fake
`COMPLETED`. Every claim-like summary must cite admitted evidence from that
activity. `external_write_performed` is always `false` in Phase 1.

## V2 API contract

All browser-facing requests use the existing same-origin Node BFF. Tenant,
subject, roles, connector credentials, and provider tokens come from trusted
server context.

| Method and route | Contract |
| --- | --- |
| `GET /v2/incidents?state=active&limit=20` | Tenant-scoped summaries including clock, latest signal severity, connector freshness, and V2 projection revision. Read-only. |
| `GET /v2/incidents/{case_id}/projection` | Full `IncidentProjectionV2`. |
| `GET /v2/incidents/events` | Tenant-global V2 incident notification SSE with opaque resume cursor. |
| `GET /v2/incidents/{case_id}/events` | Ordered V2 case SSE; `after`/`Last-Event-ID` resume strictly after a canonical sequence. |
| `GET /v2/incidents/{case_id}/evidence/{evidence_id}` | Safe, redacted citation detail bound to tenant/case/run and ACL. Never returns raw connector credentials or unrestricted payloads. |
| `GET /v2/connectors` | Authorized tenant connector health/configuration summary. Unbound adapters are `UNAVAILABLE`, not `CONNECTED`. |
| `POST /v2/connector-webhooks/pagerduty/{binding_id}` | Signature-authenticated external delivery; returns a bounded ingest receipt. Not a browser route. |
| `POST /v2/connector-webhooks/github/{binding_id}` | Signature-authenticated external delivery; returns a bounded ingest receipt. Not a browser route. |
| `POST /v2/connectors/{connector_id}/reconcile` | Operator/service-authenticated bounded reconciliation command. It cannot patch an incident projection. |

Webhook receipt:

```json
{
  "delivery_id": "delivery-01HV...",
  "source_event_id": "src-01HV...",
  "state": "ACCEPTED",
  "duplicate_of": null,
  "received_at": "2026-07-29T18:03:12Z"
}
```

Allowed states are `ACCEPTED`, `DUPLICATE`, `REJECTED`, and `CONFLICTED`.
Rejected responses expose a stable reason code but no tenant, binding, secret,
or raw-body detail.

## V2 SSE contract

The V2 case stream reuses the existing 15-second heartbeat comment and durable
resume loop. Data events are append-only and ordered by canonical case
`sequence`. New event types are:

- `connector.health.changed`
- `connector.source.accepted`
- `connector.source.rejected`
- `signal.observed`
- `signal.stale`
- `graph.pulse.started`
- `graph.pulse.expired`
- `agent.activity.started`
- `agent.activity.completed`
- `agent.activity.degraded`
- `incident.clock.changed`
- existing explanation, Gate, evidence, investigation, and lifecycle events

Envelope:

```json
{
  "schema_version": "flowpulse.incident-event.v2",
  "event_id": "event-01HV...",
  "sequence": 108,
  "projection_revision": 42,
  "source_revision": 27,
  "tenant_id": "tenant-123",
  "incident_id": "incident-123",
  "run_id": "run-123",
  "topology_revision": "topology-17",
  "case_id": "workspace-case-123",
  "workflow_id": "flowpulse.incident-workspace:tenant-123:run-123",
  "workflow_run_id": "temporal-run-uuid",
  "event_type": "signal.observed",
  "occurred_at": "2026-07-29T18:03:12Z",
  "payload": {
    "signal_id": "signal-01HV...",
    "source_event_id": "src-01HV..."
  },
  "evidence_refs": ["evidence-123"],
  "citation_refs": ["citation-123"]
}
```

The global stream emits only accepted V2 projection summaries. Connector
delivery failures that are not assigned to an incident do not leak into the
global incident stream. Disconnect/reconnect uses the last durable ID and does
not repeat a signal, pulse, activity, or lifecycle transition.

## Phase 2: operator-Agent collaboration

Phase 2 adds bounded operator messages and task assignment; it does not add
external write authority.

The browser command contains only canonical identity, current projection
revision, message text or an opaque backend-issued task type, and an idempotency
key:

```json
{
  "incident_id": "incident-123",
  "run_id": "run-123",
  "topology_revision": "topology-17",
  "projection_revision": 42,
  "client_message_id": "client-message-123",
  "body": "Compare checkout latency before and after the latest deploy.",
  "component_id": "checkout",
  "idempotency_key": "opaque-unique-key"
}
```

`POST /v2/incidents/{case_id}/messages` records a trusted subject, consumes a
one-time server authorization intent, and submits a Temporal update. The browser
cannot select provider, role, tool, query, ACL, evidence scope, or success state.

Temporal may assign `MONITOR`, `TRIAGE`, or existing bounded specialist roles.
Each task has a server-issued scope, capability budget, deadline, evidence set,
projection/run binding, status, and citations. Results are appended to
`agent_workspace.activities` and ordered conversation items. Unavailable tools
return a typed degraded task result. Operator messages cannot bypass Gate 1 for
fresh reads.

## Phase 3: proposal, approval, execution, verification

Phase 3 is a future design boundary, not an implementation authorization.

1. The backend generates a versioned remediation proposal from accepted current
   evidence and a registered write-class capability.
2. The proposal binds tenant, public/internal run identity, exact targets,
   evidence set, policy/capability versions, preconditions, canary, rollback,
   TTL, and idempotency contract.
3. A dry run executes through the existing safe action boundary and records its
   receipt.
4. A human owner explicitly approves the exact proposal and current witness
   through the existing Owner Gate.
5. Temporal alone schedules the registered execution adapter.
6. An independent verifier uses separate read credentials and fresh source
   readback to classify recovery as verified, failed, or needs human.

No model, connector webhook, Monitor/Triage activity, browser message, or this
specification may automatically authorize or execute a write. No production
write adapter is added by Phase 1 or Phase 2.

## Failure and degraded behavior

| Failure | Durable behavior | UI behavior |
| --- | --- | --- |
| Signature invalid/replay expired | Redacted rejected delivery; no source event | No live signal or pulse |
| Duplicate delivery, same hash | Original receipt returned | No duplicate event/activity |
| Duplicate identity, different hash | `CONFLICTED`; no dispatch | Connector degraded warning |
| Credential missing/invalid | Health `MISCONFIGURED` | Connector absent from tools |
| Endpoint unavailable/timeout | Health `DEGRADED`, bounded retry | Last-known signal visibly stale |
| Freshness SLA exceeded | Health/signal `STALE` | Cannot count as current proof |
| Cursor gap | Reconciliation required | Gap warning, no fabricated continuity |
| External binding missing | Source event `UNASSIGNED` | Not attached to an incident |
| Multiple candidate cases | Source event `UNASSIGNED` | Needs operator reconciliation |
| Temporal unavailable | Durable outbox remains pending | Existing projection plus stale status |
| Postgres commit failure | Transaction rolls back | No partial projection/event |
| MinIO raw artifact failure | Delivery rejected/pending by policy | No evidence citation |
| Provider payload malformed/oversized | Rejected before normalization | No signal |
| Agent/provider unavailable | Typed degraded activity | No fake tool success |
| Evidence lineage/ACL mismatch | Temporal rejects candidate | Incident remains at prior stage |
| SSE disconnect | Resume after last durable ID | No synthetic catch-up animation |

## Security and privacy boundaries

- Webhook signatures are checked against the exact raw bytes before parsing.
- Provider credentials are referenced by server-side secret IDs. They never
  appear in Postgres projection JSON, SSE, logs, OpenAPI examples, browser
  runtime config, screenshots, or model context.
- The API service receives only credentials required for signature verification;
  polling credentials remain with connector workers. Artifact writers and source
  readers use separate scoped identities.
- GitHub uses installation-scoped credentials; Prometheus/Grafana endpoints use
  endpoint and certificate allowlists; OpenTelemetry uses configured mTLS or
  collector authentication; PagerDuty keys are tenant/connector scoped.
- Every tenant-bearing table has RLS enabled and forced. Child rows use composite
  tenant/case or tenant/connector constraints.
- Raw payloads are tenant-prefixed, content-addressed, encrypted according to the
  deployment policy, retention-limited, and excluded from browser/model context
  until normalization and redaction succeed.
- Normalizers apply field allowlists, size/cardinality limits, secret scanning,
  and PII redaction. Provider text is untrusted evidence content, never an
  instruction.
- Connector endpoint resolution prevents loopback, link-local, metadata-service,
  DNS-rebinding, and redirect escape unless the deployment explicitly allowlists
  the address.
- Public `run_id` and `topology_revision` remain distinct from `case_id`,
  `workflow_id`, and real `workflow_run_id`. No connector may manufacture or
  rebind them.

## Forward schema and migration inventory

Existing migrations `001` through `011` and their checksums remain unchanged.
Implementation should use forward-only additive migrations:

| Migration | Additive records |
| --- | --- |
| `012_connector_registry.sql` | `connector_registrations`, revisioned `external_identity_bindings`, tenant credential references, connector health snapshots |
| `013_connector_source_events.sql` | delivery receipts, normalized source events, polling cursors, reconciliation runs, durable dispatch outbox, provider identity/hash uniqueness |
| `014_incident_realtime_projection.sql` | V2 projection payloads, realtime signal records, graph pulse records, V2 event/citation indexes |
| `015_agent_workspace_activity.sql` | append-only Monitor/Triage activity, activity status revisions, citations, source/evidence joins |
| `016_operator_agent_messages.sql` | Phase 2 messages, server intents, task assignments, task result revisions |
| `017_remediation_verification.sql` | Phase 3 additive proposal/execution/verification bindings only where existing P0 tables cannot represent them |

Each migration:

- is ledgered by the existing atomic migration runner;
- supports upgrade from the current exact schema;
- forces RLS on tenant-bearing tables;
- grants append/read only to the narrow service role;
- uses composite tenant-aware foreign keys;
- makes event, delivery, activity, citation, and decision records append-only;
- rejects unsupported future versions, gaps, checksum drift, and partial schema;
- has no destructive rewrite or raw-payload backfill.

## Acceptance tests

### Contract and normalization

- Strict schemas reject coercion, unknown fields, over-limit collections, invalid
  timestamps, unknown provider kinds, malformed hashes, and caller-supplied
  tenant/run authority.
- Every checked-in `$ref` resolves for both frozen V1 and generated V2 OpenAPI.
- PagerDuty/GitHub signature fixtures cover valid, invalid, expired, rotated-key,
  duplicate, and conflicting deliveries.
- Prometheus/Grafana/OTEL/GitHub normalizers produce deterministic hashes and
  bounded safe records from frozen fixtures.
- Grafana-only metadata cannot satisfy a current metric-proof gate.

### Persistence and isolation

- Real Postgres tests prove RLS, composite binding constraints, immutable
  external identities, exact duplicate idempotency, conflict rejection, cursor
  atomicity, outbox retry, and no partial artifact set after injected failure.
- Raw object keys and read credentials are tenant-scoped; cross-tenant access is
  denied by both adapter validation and storage policy.
- Capability audit, source event, evidence, citation, and activity reference the
  same tenant/public/internal run mapping.

### Temporal and replay

- A connector event cannot directly mutate a projection.
- Accepted event -> one evidence admission, one agent decision, one projection
  revision, and one ordered case event.
- Duplicate update/retry/restart -> no duplicate signal, pulse, claim, activity,
  or transition.
- Stale, cross-run, cross-component, unbound, or ACL-invalid events remain
  unaccepted.
- Archived histories replay under the new code; any replay-visible workflow
  change uses a patch marker or new workflow type.
- Backfill/reconciliation events preserve original time and never rewrite
  historical lifecycle state without an explicit replay workflow.

### API, SSE, and frontend contract

- V1 frozen schemas/routes/examples/hashes remain unchanged.
- V2 discovery/projection/event schemas carry canonical identity and monotonic
  revisions.
- Both V2 SSE streams remain open, heartbeat while idle, emit newly durable rows
  without reconnect, resume strictly after a cursor, and cancel promptly.
- Realtime Signal Bar content, graph pulses, duration state, Monitor/Triage
  activity, and citations are server-projected.
- Duration tests anchor interpolation to backend `as_of`/`elapsed_seconds`,
  resynchronize on projection and SSE, cap it at the explicit freshness window,
  freeze with a visible stale/disconnected state after that window, and stop
  immediately on backend `PAUSED` or `RESOLVED`.
- Duration interpolation produces no API command, source event, evidence,
  lifecycle/stage/recovery/success claim, or projection revision.
- Reload produces the same active signals/pulses/activities; it does not start a
  connector call or agent turn.
- A pulse references existing graph nodes/edges and admitted evidence.
- Disconnected, stale, or unbound adapters never appear in callable tool lists.
- Browser assets, runtime config, network captures, and screenshots contain no
  connector credential or backend fixture bearer.

### End-to-end Phase 1 matrix

The standard credential-free matrix uses deterministic connector fixtures behind
explicit test mode and labels them `TEST_DETERMINISTIC`. It must still run real
FastAPI, Temporal, Postgres, MinIO, worker, migrations, and SSE.

Optional credentialed local smokes are separate and opt-in for each connector.
They use non-production read-only credentials and are not required for standard
tests. A missing credential skips the smoke and leaves the connector
`UNAVAILABLE`; it never activates a deterministic fallback under a live label.

## Rollout and backfill

1. **Schema-only.** Apply additive tables/RLS with connectors disabled.
2. **Shadow ingest.** Validate signatures/polls, raw artifacts, normalized
   hashes, bindings, and reconciliation without dispatching to Temporal or UI.
3. **Single-tenant read-only canary.** Enable one connector at a time, beginning
   with OpenTelemetry/Prometheus, then GitHub change, then PagerDuty routing.
4. **V2 projection canary.** Materialize V1 and V2 from the same Temporal
   transitions; compare identity, revision, and shared field equality.
5. **Frontend canary.** Enable V2 BFF routes for one tenant after OpenAPI/example
   freeze hashes are recorded in both backend and frontend plans.
6. **General read-only rollout.** Expand tenant by tenant with lag, failure,
   duplicate, reconciliation, and SSE metrics.

Historical import is an explicit bounded backfill job. Backfilled records retain
provider observation/effective time, use `ingest_mode=BACKFILL`, and never emit
historical “live” pulses. They may enrich a timeline or prior, but they cannot
retroactively advance a current incident or become current proof.

Rollback disables dispatch/adapter binding, leaves immutable source/evidence
records intact, marks connector health `DISABLED` or `STALE`, and keeps V1
consumers operational. It does not delete events, rewind Temporal, or rewrite
projection history.

## Frontend handoff contract

Frontend implementation may begin only after the V2 OpenAPI, safe examples,
producer Git SHA, artifact SHA-256 values, and same-origin auth mapping are
committed.

The frontend:

- calls only same-origin `/api/control-plane/v2`;
- renders the server’s connector state, signal order/status/freshness,
  incident-clock state, node/edge impact, pulse IDs/intervals, agent activity,
  and citations;
- may interpolate only the displayed running duration from the latest trusted
  server clock anchor with a monotonic local clock, bounded by
  `fresh_until`/`max_interpolation_seconds`;
- resynchronizes that display on every projection/SSE clock update, freezes and
  visibly marks it stale/disconnected when the bounded freshness window is
  exceeded, and stops immediately when the backend says `PAUSED` or `RESOLVED`;
- never turns duration interpolation into a source fact, command, projection
  mutation, lifecycle/stage decision, recovery claim, or success state;
- uses `display_name`, signal `title`/`display_value`, and citation `label`
  verbatim as bounded operator-facing copy;
- treats projection reload as canonical and SSE as ordered incremental updates;
- deduplicates by server event/pulse/activity ID and revision;
- does not poll vendors, store connector credentials, select tools, parse raw
  payloads, infer graph edges, invent agent typing/tool activity, or infer
  recovery;
- shows Grafana as presentation context and Prometheus/OTEL as the cited data
  authority;
- omits callable tools not present in the backend capability projection;
- preserves the existing browser-no-bearer boundary.

## Non-goals

- No connector is implemented by this document.
- No production credential is requested or authorized.
- No automatic acknowledgment, issue creation, deploy, rollback, remediation,
  or recovery action is authorized.
- No browser-direct vendor API, client-side event correlation, fake pulse,
  decorative connected state, or second lifecycle authority is permitted.
- No change to the frozen V1 contract, migration checksums, or existing workflow
  history is made by this design checkpoint.

## Self-review

- **Static-report drift:** closed. The design requires connector source facts,
  Temporal-accepted transitions, durable signal/activity projections, and live
  ordered SSE rather than a regenerated report.
- **Fake dynamics:** closed. Every pulse, signal, tool activity, and freshness
  state references a durable backend event; unavailable adapters are absent or
  explicitly unavailable. Duration continuity is limited to bounded
  display-only interpolation from a trusted server anchor and freezes when that
  anchor is stale, disconnected, paused, or resolved.
- **Credential leakage:** closed. Credentials remain in scoped server-side
  stores/workers and are excluded from projection, SSE, browser, examples, and
  model context.
- **Cross-tenant/run mixing:** closed. Connector, binding, source, evidence,
  workflow, projection, and citation records carry the same tenant and
  public/internal identity mapping with RLS/composite constraints.
- **Duplicated lifecycle authority:** closed. Connector workers persist facts and
  dispatch commands; only Temporal accepts lifecycle/projection changes.
- **Compatibility:** closed. Frozen V1 remains unchanged; V2 is an additive read
  and event contract produced from the same Temporal transition.
- **Write-authority ambiguity:** closed. Phase 3 is future design only and
  requires separate implementation authorization plus the existing human gate,
  dry run, and independent verification boundaries.

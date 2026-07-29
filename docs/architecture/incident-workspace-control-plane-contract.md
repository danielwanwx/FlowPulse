# Incident Workspace control-plane contract v1.2

## Scope and authority

This is the additive Contract Core for the approved Agent-led Incident
Workspace. FlowPulse is a model-agnostic, company-multiplayer agent operating
system; incident response is its first vertical. Temporal is the only
workflow/state-transition authority. Postgres is an append-only, tenant-scoped
ledger/projection store. Raw artifacts stay behind the versioned object-store
port. The browser and frontend same-origin transport façade are consumers, not
authorities.

The public canonical identity is:

```text
(tenant_id, incident_id, run_id, topology_revision)
```

It is stored with, but is never derived from, the internal correlation:

```text
(case_id, case_revision, workflow_id, workflow_run_id)
```

`workflow_run_id` is the real Temporal run returned after start. `run_id` and
`topology_revision` remain stable product values in projections, SSE events,
NodeExplanation records, evidence bindings, gate records, and later action
cards. A tenant/case/run/topology mapping may not be rebound to a different
Temporal run.

## v1.2 HTTP routes and v2 workflow read model

All routes require trusted authenticated tenant/subject context and return only
tenant-scoped records:

| Route | Contract Core behavior |
| --- | --- |
| `POST /v1/incidents` | Starts `flowpulse.incident-workspace.v2`; waits for its initialization activity and returns the durable `IncidentProjection`. |
| `GET /v1/incidents?state=active` | Returns bounded tenant-scoped `IncidentSummary` records for toast hydration. The authenticated tenant is authoritative; this read does not create a case, conversation, fresh read, or Temporal transition. |
| `GET /v1/incidents/events` | Ordered global tenant notification SSE. `Last-Event-ID` or `after` resumes strictly after its opaque server cursor and carries enough public identity to hydrate a per-case projection. |
| `GET /v1/incidents/{case_id}/projection` | Returns the latest Temporal-authoritative projection. |
| `GET /v1/incidents/{case_id}/components/{component_id}/context` | Returns canonical, recorded context only; `fresh_read_performed=false`. |
| `POST /v1/incidents/{case_id}/node-explanations` | Submits the typed exactly-once Temporal update. The browser supplies only public identity, canonical component, projection revision, and idempotency key. |
| `GET /v1/incidents/{case_id}/node-explanations/{explanation_id}` | Returns a persisted explanation under the same public/internal binding. |
| `GET /v1/incidents/{case_id}/events` | Ordered SSE events. `Last-Event-ID` or `after` resumes strictly after an accepted sequence. |
| `GET /v1/incidents/{case_id}/actions` / `POST /v1/incidents/{case_id}/actions/{action_id}` | Reads server-generated cards and submits the one revalidated Temporal action update; no browser scope or tool payload is accepted. |

`IncidentGraphNode.display_name` is nonempty, server-projected operator text;
the browser must render it and must not prettify `component_id` or
`canonical_identity`. The projection also carries bounded English
`operator_title` and `operator_summary` fields that the discovery summary
uses for toast content. An unavailable provider/capability returns a typed
`DEGRADED` projection with `provider_unavailable`; it never returns fixture
success.

The global notification feed publishes only accepted/updated projection events.
Per-case SSE publishes bounded `node_explanation.started`,
`node_explanation.completed`, or `node_explanation.degraded` status records;
the durable POST/GET `NodeExplanationReceipt` remains the content source. There
is no token-stream API. Toast focus and both discovery feeds are read-only and
cannot create an explanation.

## Investigate to Decide handoff

A successful Gate-1 read appends current evidence but does not itself advance
the lifecycle. The v2 workflow separately schedules schema-bound investigation
synthesis and an independently identified critic Activity. Only a current,
trusted, tenant/run/component-bound result with critic `PASS` is committed as
`IncidentProjection.lifecycle_stage=DECIDE`. The projection exposes the typed
`InvestigationResult` with its observation/hypothesis claims, evidence
freshness and lineage, synthesis/critic identities, revisions, and version
bundle. Provider-unavailable, malformed, stale, abstained, or critic-rejected
outputs remain `INVESTIGATE` with a typed degraded result.

No remediation capability is registered in this slice, so an accepted Decide
handoff intentionally returns zero current action cards. Gate 2, dry-run
execution, and verification remain later lifecycle slices.

## NodeExplanation boundary

The durable selection key is:

```text
node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}
```

It is unique for the public run, not a Temporal ID and not a browser-local
key. The v2 Activity has no provider or fresh-read adapter. It can use only the
canonical projection and previously recorded evidence references, must label
its result degraded, and must set both `fresh_read_performed` and
`fresh_diagnosis_claimed` to `false`. Toast focus and all GET/SSE requests are
read-only and cannot schedule it.

The API first records a server-owned, immutable command intent after it reloads
the binding, projection, and tenant-scoped subject grant. It then mints a
short-lived, one-time assertion bound to the tenant, subject, case, public
identity, projection revision, component, and canonical command hash. The
production Temporal update accepts only that assertion envelope and resolves
the actor through the authorization activity before any Conversation Manager or
provider call. Empty recorded-evidence lists do not bypass the subject grant.
The former actor-less update decoder is retained only in the frozen
`flowpulse.incident-workspace.v1` replay/drain workflow. The production worker
registers that v1 definition only to replay or drain already-open histories.
Temporal patch markers reject every new v1 start or node-explanation update
before it can reach the decoder. The secured
`flowpulse.incident-workspace.v2` definition is the only workflow type used
for new API intake and it never claims the v1 type.

## Frontend transport and contract freeze

The browser points only to its same-origin frontend route
`/api/control-plane/v1`. The frontend Node transport process is configured
with `FLOWPULSE_CONTROL_PLANE_URL=http://127.0.0.1:8090` and, in an explicit
local/test harness only, forwards the fixture session/bearer server-side. The
browser must never receive/store `FLOWPULSE_TEST_OWNER_TOKEN`; frontend E2E
must prove absence in runtime config, browser JavaScript, browser network
evidence, and screenshots. Direct browser bearer is not acceptance.

The OpenAPI document and safe examples are generated from the FastAPI/Pydantic
models, then frozen with a reproducible SHA-256 manifest. Frontend product
integration must wait for the manifest's producer commit and artifact hashes,
plus the exact public/internal identity and same-origin auth mapping. This file
is the narrative companion; the checked-in generated bundle is authoritative
for schemas.

## Workspace contract freeze

The v1.2 producer implementation commit is
`a1ccd415fe8f3e263ae03391f5e6f51fbfb26cd0`. The generated bundle is:

- `control_plane/openapi/flowpulse-incident-workspace-v1.openapi.json` — SHA-256 `be260bc4da0ce19f115acd18a3b2e6cac4fef5317ca657da79812af86e4b6573`
- `control_plane/openapi/flowpulse-incident-workspace-v1.examples.json` — SHA-256 `2ffbc5e19ba54f07219f0b9ca164b4a7c7f7c5e587b248cf27a35f09327e5003`
- `control_plane/openapi/flowpulse-incident-workspace-v1.freeze.json` — SHA-256 `4393b58b3c51bbdf08a26b3b14267cf698444a58765afcd91fe428c812466843`

The frontend product branch must record these values verbatim, together with
the public identity and same-origin process-side authentication boundary,
before it consumes the Contract Core API.

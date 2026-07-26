# Incident Workspace control-plane contract v1

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

## v1 routes and read model

All routes require trusted authenticated tenant/subject context and return only
tenant-scoped records:

| Route | Contract Core behavior |
| --- | --- |
| `POST /v1/incidents` | Starts `flowpulse.incident-workspace.v1`; waits for its initialization activity and returns the durable `IncidentProjection`. |
| `GET /v1/incidents/{case_id}/projection` | Returns the latest Temporal-authoritative projection. |
| `GET /v1/incidents/{case_id}/components/{component_id}/context` | Returns canonical, recorded context only; `fresh_read_performed=false`. |
| `POST /v1/incidents/{case_id}/node-explanations` | Submits the typed exactly-once Temporal update. The browser supplies only public identity, canonical component, projection revision, and idempotency key. |
| `GET /v1/incidents/{case_id}/node-explanations/{explanation_id}` | Returns a persisted explanation under the same public/internal binding. |
| `GET /v1/incidents/{case_id}/events` | Ordered SSE events. `Last-Event-ID` or `after` resumes strictly after an accepted sequence. |

No generic action/NextBestAction route exists in this checkpoint. Those are
explicitly deferred until their capability and Gate 1 contracts are
implemented. An unavailable provider/capability returns a typed `DEGRADED`
projection with `provider_unavailable`; it never returns fixture success.

## NodeExplanation boundary

The durable selection key is:

```text
node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}
```

It is unique for the public run, not a Temporal ID and not a browser-local
key. The v1 Activity has no provider or fresh-read adapter. It can use only the
canonical projection and previously recorded evidence references, must label
its result degraded, and must set both `fresh_read_performed` and
`fresh_diagnosis_claimed` to `false`. Toast focus and all GET/SSE requests are
read-only and cannot schedule it.

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

## Contract Core freeze

The producer implementation commit is
`341033f531a2afa2786cab4fcba37167e6f3d483`. The generated bundle is:

- `control_plane/openapi/flowpulse-incident-workspace-v1.openapi.json` — SHA-256 `ff152ef7e8e4b20fb03fd9f1b7191a558aaae1d0e38c62fe1ca6a9be29a4f4b9`
- `control_plane/openapi/flowpulse-incident-workspace-v1.examples.json` — SHA-256 `85d857e1a73a6a40071e51848e4b08736a703958b808867636a0f8da12d178dd`
- `control_plane/openapi/flowpulse-incident-workspace-v1.freeze.json` — SHA-256 `4994bc07d1d239fb582517d663be0edb1b9a65b83fcab4774d3046c25e648199`

The frontend product branch must record these values verbatim, together with
the public identity and same-origin process-side authentication boundary,
before it consumes the Contract Core API.

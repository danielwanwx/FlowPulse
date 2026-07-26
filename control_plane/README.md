# FlowPulse Diagnosis Control Plane P0

This service is a new, isolated control-plane kernel for FlowPulse: a
model-agnostic, company-multiplayer agent operating system whose first vertical
is incident response. The existing Node app remains its presentation/demo layer
and this directory does not replace its ledger.

## Local deterministic check

Install the declared local development dependencies, then run the deterministic suite:

```bash
cd control_plane
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest discover -s tests -v
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m compileall -q flowpulse_cp
```

The suite uses a deterministic fake Temporal adapter and frozen source readback. It makes no model, production, or external write call.

## Service and integration wiring

The local Compose path starts the API (`0.0.0.0:8090`), an internally reachable
assertion issuer, Temporal, a Temporal worker, Postgres, and MinIO. Only the
API, Postgres, and local MinIO fixture are published to the host: assertion
minting and Temporal are Compose-network-only. The worker registers frozen
`flowpulse.diagnosis.v1` compatibility plus current `flowpulse.diagnosis.v2`
with all seven activity definitions; its Postgres adapter persists append-only
activity/verification records, while the MinIO/S3 content-addressed artifact
store persists the typed activity packet under a tenant prefix. Compose's
non-owner application role uses `FORCE RLS` tenant and evidence-subject ACL
policies.

```bash
cd control_plane
export FLOWPULSE_TEST_OWNER_TOKEN="$(openssl rand -hex 32)"
docker compose down --volumes
docker compose up --build -d
FLOWPULSE_LIVE_COMPOSE=1 FLOWPULSE_LIVE_API_OWNER_TOKEN="$FLOWPULSE_TEST_OWNER_TOKEN" .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_compose_http.py' -v
FLOWPULSE_LIVE_HOST_BOUNDARY=1 .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_host_boundaries.py' -v
FLOWPULSE_LIVE_POSTGRES=1 \
  FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse \
  FLOWPULSE_TEST_POSTGRES_ADMIN_DSN=postgresql://flowpulse:flowpulse@127.0.0.1:5433/postgres \
  .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_postgres_idempotency.py' -v
FLOWPULSE_LIVE_MINIO=1 .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_minio_iam.py' -v
docker compose exec -T authz env \
  FLOWPULSE_LIVE_TEMPORAL=1 \
  FLOWPULSE_TEMPORAL_ADDRESS=temporal:7233 \
  FLOWPULSE_AUTHORIZATION_SERVICE_URL=http://authz:8091 \
  FLOWPULSE_AUTHZ_API_SERVICE_TOKEN=flowpulse-api-authz-local-only \
  FLOWPULSE_AUTHZ_WORKER_SERVICE_TOKEN=flowpulse-worker-authz-local-only \
  FLOWPULSE_TEST_POSTGRES_DSN=postgresql://flowpulse_cp_app:flowpulse-cp-local-only@postgres:5432/flowpulse \
  python -m unittest discover -s tests -p 'test_live_temporal_negative_paths.py' -v
python -m unittest tests.test_live_temporal_replay_compat -v
```

The opt-in live suite starts workflows through the registered worker and
asserts that critic failure stops before verification, verifier failure stops
before Owner Gate, and an Owner Gate witness mismatch returns `BLOCKED`. The
Compose API suite further proves the durable sequence `HTTP command → Temporal
update → AWAITING_OWNER projection → resume`, records rejected approvals only
as candidates, and rejects a tenant subject lacking the owner role. It leaves
the stack available for API replay; stop it later with `docker compose down
--volumes`.

Postgres is published on `127.0.0.1:5433` to avoid colliding with a developer's
local Postgres. Service-to-service connections continue to use `postgres:5432`.

For the host-published Compose API, an explicit, caller-supplied-at-startup
fixture bearer credential maps to one server-configured owner identity. The
credential itself is not committed; Compose refuses to start without
`FLOWPULSE_TEST_OWNER_TOKEN` and sets `FLOWPULSE_RUNTIME_MODE=local`.
`x-flowpulse-test-*` headers are ignored and cannot select a tenant, subject,
or role. Fixture values are rejected at process startup unless the runtime mode
is explicitly `local` or `test`; production must inject
`request.state.flowpulse_auth` from trusted authentication middleware.
`POST /v1/cases` calls `Client.start_workflow`; it does not fall back to an
in-memory workflow. Proposal and dry-run endpoints only submit typed Temporal
updates using the trusted auth subject; they never validate an Owner Gate or
write approval/action rows directly. The worker's Owner Gate activity validates
the exact owner role, TTL, contract hash, ordered target scope, and proposal /
approval witness equality in the same Postgres transaction that writes a
verified approval candidate, accepted approval, and non-executing receipt.

The production verifier reads only fixed `s3://<configured-source-bucket>/...`
case-derived keys through an independent read-only `S3SourceReadback` port;
it never reuses the raw-artifact writer client. A production
`S3CurrentEvidenceAcquirer` reads a similarly case-bound controlled source
manifest before critic evaluation, admitting only its typed current-evidence
bundle. The local Compose profile explicitly selects a
deterministic `local://current/...` adapter for offline integration tests;
neither workflow intake nor activity packets accept caller-provided readback
evidence.

Temporal owner commands carry a short-lived HMAC-signed authorization
assertion minted by the isolated authorization service. Its mint endpoint
accepts only the API service identity; it consumes a one-time, tenant-scoped
command intent created from the authenticated HTTP context and the authoritative
case projection. Callers cannot supply roles, case, proposal, or approval scope
to minting. Assertions are bound to
issuer, audience, key ID, nonce/JTI, expiry, tenant, case/revision/run,
proposal, approval, authenticated subject, and roles; JTI consumption is
durable and one-time. The API and worker have no signing key. The Owner Gate
worker resolves the assertion through the authorization service before any
proposal/approval mutation; roles inside a direct Temporal payload are not
trusted.

An owner command submitted before the workflow reaches its owner wait waits
inside Temporal for the durable `OWNER_WAIT` phase, then validates normally;
it is not rejected on a transient readiness field. The workflow revalidates
case/run, phase, proposal/approval immutability, and expected proposal ID after
the awaited authorization activity and immediately before mutation.

`flowpulse.diagnosis.v1` is frozen to the pre-9d88a7e immediate-rejection
command sequence, while new intakes start `flowpulse.diagnosis.v2` and use the
durable owner-wait command path. The deterministic fixture test consumes only
the committed raw histories generated by an isolated worker at exact parent
`1e4a6c7dec90198dc472c270edf108c112ef3bdf`; it does not start a worker or
generate histories from the current v1 compatibility class. It validates each
fixture's manifest provenance, SHA-256, and event count. The production image
then replays all three through production v1 compatibility. See
`tests/fixtures/temporal_parent_1e4a6c7/README.md` for the parent-image
reproduction procedure.

Compose bootstraps separate MinIO identities: the artifact writer can access
only the evidence bucket, while the verifier/current-source reader is read-only
under one configured tenant's controlled source prefix. Neither identity is
injected into the API. The live IAM test performs raw MinIO requests and proves
that reader writes, writer source reads, cross-bucket reads, and cross-tenant
object/list requests all fail before adapter checks.

`001_control_plane.sql` is preserved as the `88563ce` baseline. The ordered,
forward-only Compose `migrate` service records immutable checksums, preserves
that baseline, then applies `002_authorization_intents.sql` and additive
`003_incident_workspace_projection.sql` exactly once to a pre-existing volume.
`003` adds RLS-forced append-only public run bindings, projections, ordered
events, NodeExplanation selections, and evidence bindings; it does not rewrite
001/002 data. The live Postgres suite creates an exact 001 database, writes a
case, applies the forward migrations, and verifies data preservation, durable
assertion consumption, workspace RLS, and append-only mapping behavior. The
Compose values are local-only fixtures and must not be treated as production
credentials or a production deployment recipe.

## Authority boundary

- In deployment, Temporal is the only workflow/state-transition authority.
- PostgreSQL stores append-only case/domain records and query projections.
- Object storage holds versioned raw artifacts behind the tenant-bound artifact port.
- OpenAI/Responses integrations belong only in typed Temporal activities; P0 tests use deterministic fakes.
- Knowledge retrieval is ACL/version filtered reference evidence. It cannot prove a current incident root cause.
- P0 cannot execute a production action or autonomously promote knowledge.

## Incident Workspace Contract Core

`flowpulse.incident-workspace.v2` is the secured, additive Temporal workflow
for new Incident/Live intake. The retired
`flowpulse.incident-workspace.v1` definition is registered only as an
isolated replay/drain handler: it replays pre-correction histories and rejects
new starts and node-explanation updates with `workspace_v1_draining`. Its
public canonical identity is
`(tenant_id, incident_id, run_id, topology_revision)`. `run_id` is issued by
the backend and `topology_revision` is a versioned graph identity; neither is a
Temporal identifier. The immutable binding also records internal `case_id`,
`case_revision`, `workflow_id`, and the real `workflow_run_id` returned by
Temporal. Every workspace projection, event, and NodeExplanation carries that
binding and its relevant projection/evidence/gate/action revisions.

The v2 workflow uses a Conversation Manager only inside its Temporal node
explanation activity. Standard mode configures no provider, so
`POST /v1/incidents` still returns a durable typed `DEGRADED` projection
(`provider_unavailable`) rather than fabricated model output. A configured
provider result is schema-validated before its NodeExplanation projection is
written; the durable explanation stores only versioned prompt/context hashes,
safe token counters, capability names, and a truthful `DEGRADED`,
`TEST_DETERMINISTIC`, or `LIVE` label. It never stores prompts, credentials,
or raw model payloads. `POST /v1/incidents/{case_id}/node-explanations` is a
Temporal update that selects exactly once by the public run key
`node_explanation:{tenant}:{run}:{projection_revision}:{component}:{schema}`.
Before Gate 1 it can only return recorded projection/evidence context and the
same typed degraded state or a provider explanation with no fresh tools or
fresh diagnosis. The worker constructs one shared capability registry for both
actual autonomous diagnosis and user Q&A: the autonomous current-evidence
adapter is system-gated, while the Q&A adapter can only use already-recorded
context. Disabled or unbound adapters are omitted rather than advertised. Every
invocation uses a capability-specific strict input model, an authoritative
tenant/public-run/internal/revision/component/subject scope, a bounded budget,
and an append-only audit record. Returned evidence is admitted through the
tenant/ACL/lineage boundary before that record can be `COMPLETED`; recorded
context must already be tenant/case/revision/subject-ACL bound. `GET /v1/incidents/{case_id}/events` is an
ordered, strictly-after SSE read projection. A focus toast, hover, drawer
open, or SSE subscription has no command route and creates no workflow/event/
tool side effect.

The deterministic conversation provider is constructible only by explicit
test-mode dependency injection. It is never selected from normal worker
configuration, including local Compose. Demo mode has no implicit provider and
therefore remains truthfully `DEGRADED`; it cannot relabel deterministic output
as demo or live AI. An OpenAI-compatible endpoint is also disabled by default.
The only smoke command is deliberately opt-in and accepts
an explicitly configured loopback endpoint and model; it does not default to
an OpenAI URL or read a credential unless `openai-compatible` mode is selected:

```bash
FLOWPULSE_LIVE_PROVIDER_SMOKE=1 \
FLOWPULSE_PROVIDER_MODE=local-open-source \
FLOWPULSE_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:8080/v1 \
FLOWPULSE_OPENAI_COMPATIBLE_MODEL=local-model \
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache .venv/bin/python -m unittest \
  tests.test_live_provider_smoke -v
```

The API is still tenant-scoped through trusted server authentication. For the
local cross-worktree test harness, the browser uses the frontend same-origin
`/api/control-plane/v1` Node transport façade. Only that Node process receives
the local fixture session/bearer and forwards it server-side; browser runtime
configuration, JavaScript, requests, and screenshots must not expose it. The
façade is transport only and never creates authority or success responses.

The generated contract bundle is checked in under `openapi/`. Its freeze
manifest records producer implementation commit
`b4c49f25204dca664fd13081fc3f4995122bebcf`, OpenAPI SHA-256
`aae3bb9f9dabfef7e7ebd24aa5cdb4a3651fded4421de9249ecf11df727df168`, and safe
examples SHA-256 `c55d57928dd5a6a5b8ad666fab4da08027427d85132a0f7d2fe18aabdc3ecb3d`.
Frontend product integration is blocked
until that committed bundle and identity/auth mapping are reviewed together.

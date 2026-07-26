# FlowPulse Diagnosis Control Plane P0

This service is a new, isolated control-plane kernel. The existing Node app remains its presentation/demo layer and this directory does not replace its ledger.

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
docker compose exec -T authz env FLOWPULSE_LIVE_TEMPORAL=1 \
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
durable owner-wait command path. The opt-in live replay test records
parent-`1e4a6c7` pre-ready, owner-wait, and terminal histories and replays all
three through the production v1 compatibility registration.

Compose bootstraps separate MinIO identities: the artifact writer can access
only the evidence bucket, while the verifier/current-source reader is read-only
under one configured tenant's controlled source prefix. Neither identity is
injected into the API. The live IAM test performs raw MinIO requests and proves
that reader writes, writer source reads, cross-bucket reads, and cross-tenant
object/list requests all fail before adapter checks.

`001_control_plane.sql` is preserved as the `88563ce` baseline. The separate
forward-only `002_authorization_intents.sql` is run by the Compose `migrate`
service on every startup, so a pre-existing Postgres volume receives the new
intent/replay tables without rerunning the initializer. The live Postgres suite
creates an exact 001 database, writes a case, applies 002 twice, and verifies
both data preservation and durable assertion consumption. The Compose values
are local-only fixtures and must not be treated as production credentials or a
production deployment recipe.

## Authority boundary

- In deployment, Temporal is the only workflow/state-transition authority.
- PostgreSQL stores append-only case/domain records and query projections.
- Object storage holds versioned raw artifacts behind the tenant-bound artifact port.
- OpenAI/Responses integrations belong only in typed Temporal activities; P0 tests use deterministic fakes.
- Knowledge retrieval is ACL/version filtered reference evidence. It cannot prove a current incident root cause.
- P0 cannot execute a production action or autonomously promote knowledge.

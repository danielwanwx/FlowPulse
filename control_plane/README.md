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

The local Compose path starts the API (`0.0.0.0:8090`), Temporal, a Temporal
worker, Postgres, and MinIO. The worker registers `flowpulse.diagnosis.v1` and
all seven activity definitions; its Postgres adapter persists append-only
activity/verification records, while the MinIO/S3 content-addressed artifact
store persists the typed activity packet under a tenant prefix. Compose's
non-owner application role uses `FORCE RLS` tenant and evidence-subject ACL
policies.

```bash
cd control_plane
docker compose down --volumes
docker compose up --build -d
FLOWPULSE_LIVE_TEMPORAL=1 .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_temporal_negative_paths.py' -v
FLOWPULSE_LIVE_COMPOSE=1 .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_compose_http.py' -v
FLOWPULSE_LIVE_POSTGRES=1 .venv/bin/python -m unittest \
  discover -s tests -p 'test_live_postgres_idempotency.py' -v
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

For a Compose-only smoke test, the deliberately local test-auth adapter accepts
`x-flowpulse-test-tenant` and `x-flowpulse-test-subject`; production must
inject `request.state.flowpulse_auth` from trusted authentication middleware.
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
assertion minted only by the trusted HTTP auth boundary. The Owner Gate worker
resolves that assertion against its configured authorization authority; roles
inside a direct Temporal payload are not trusted.

The migration is mounted into the local Postgres initializer. A deployment
migration runner must apply the equivalent migration before any worker connects.
The Compose values are local-only and must not be treated as production
credentials or a production deployment recipe.

## Authority boundary

- In deployment, Temporal is the only workflow/state-transition authority.
- PostgreSQL stores append-only case/domain records and query projections.
- Object storage holds versioned raw artifacts behind the tenant-bound artifact port.
- OpenAI/Responses integrations belong only in typed Temporal activities; P0 tests use deterministic fakes.
- Knowledge retrieval is ACL/version filtered reference evidence. It cannot prove a current incident root cause.
- P0 cannot execute a production action or autonomously promote knowledge.

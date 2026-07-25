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
activity/verification records, while the local content-addressed artifact store
persists the typed activity packet. Compose's non-owner application role uses
`FORCE RLS` tenant policies.

```bash
cd control_plane
docker compose up --build
```

For a Compose-only smoke test, the deliberately local test-auth adapter accepts
`x-flowpulse-test-tenant` and `x-flowpulse-test-subject`; production must
inject `request.state.flowpulse_auth` from trusted authentication middleware.
`POST /v1/cases` calls `Client.start_workflow`; it does not fall back to an
in-memory workflow. The `POST /v1/proposals/{proposal_id}/dry-run` path
validates exact owner approval, TTL, contract hash, target scope, proposal and
approval witness equality, then returns a non-executing idempotent receipt.

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

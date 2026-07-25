# FlowPulse Diagnosis Control Plane P0

This service is a new, isolated control-plane kernel. The existing Node app remains its presentation/demo layer and this directory does not replace its ledger.

## Local deterministic check

The focused suite needs only the already available Python runtime plus FastAPI and Pydantic:

```bash
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache PYTHONPATH=control_plane \
  python3 -m unittest discover -s control_plane/tests -v
PYTHONPYCACHEPREFIX=/tmp/flowpulse-pycache python3 -m compileall -q control_plane/flowpulse_cp
```

The suite uses a deterministic fake Temporal adapter and frozen source readback. It makes no model, production, or external write call.

## Service and integration wiring

Install the declared dependencies, then run the API:

```bash
cd control_plane
python3 -m pip install -e .
python3 -m flowpulse_cp.main
```

`POST /v1/cases` accepts only strict intake contracts. The `POST /v1/proposals/{proposal_id}/dry-run` path validates exact owner approval, TTL, contract hash, target scope, and precondition witness, then returns a non-executing idempotent receipt.

`docker compose up --build` starts local API, Temporal, Postgres, and MinIO wiring. Apply `migrations/001_control_plane.sql` with a deployment migration runner before connecting a worker. The Compose file carries local-only defaults and must not be treated as production credentials or a production deployment recipe.

## Authority boundary

- In deployment, Temporal is the only workflow/state-transition authority.
- PostgreSQL stores append-only case/domain records and query projections.
- Object storage holds versioned raw artifacts behind the tenant-bound artifact port.
- OpenAI/Responses integrations belong only in typed Temporal activities; P0 tests use deterministic fakes.
- Knowledge retrieval is ACL/version filtered reference evidence. It cannot prove a current incident root cause.
- P0 cannot execute a production action or autonomously promote knowledge.

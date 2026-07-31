"""Generate the additive V2 OpenAPI/examples bundle without rewriting V1."""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from flowpulse_cp.app import create_app
from flowpulse_cp.realtime_models import (
    AgentWorkspace,
    ConnectorHealth,
    ConnectorHealthState,
    ConnectorProvider,
    ConnectorReconcileRequest,
    ConnectorTruthLabel,
    IncidentClock,
    IncidentClockState,
    IncidentProjectionV2,
)


def _schema_closure(paths: dict, schemas: dict) -> set:
    """Collect every component schema reachable from one route generation."""

    references = set()

    def visit(value):
        if isinstance(value, dict):
            reference = value.get("$ref")
            prefix = "#/components/schemas/"
            if isinstance(reference, str) and reference.startswith(prefix):
                references.add(reference[len(prefix):])
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(paths)
    pending = list(references)
    while pending:
        name = pending.pop()
        before = set(references)
        visit(schemas[name])
        pending.extend(references - before)
    return references


def _write(path: Path, value) -> str:
    encoded = (json.dumps(value, indent=2, sort_keys=True, default=str) + "\n").encode()
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def _examples() -> dict:
    now = datetime(2026, 7, 29, 20, 0, tzinfo=timezone.utc)
    v1_examples = json.loads(
        (SOURCE_ROOT / "openapi" / "flowpulse-incident-workspace-v1.examples.json").read_text()
    )
    base = v1_examples["response_examples"]["IncidentProjection"]
    health = ConnectorHealth(
        connector_id="connector-otel-primary",
        tenant_id=base["tenant_id"],
        provider=ConnectorProvider.OTEL,
        state=ConnectorHealthState.UNAVAILABLE,
        checked_at=now,
        consecutive_failures=0,
        lag_seconds=0,
        reason_code="otel_query_endpoint_unconfigured",
        adapter_version="otel-read.v1",
        health_revision=1,
        truth_label=ConnectorTruthLabel.TEST_DETERMINISTIC,
    )
    projection = IncidentProjectionV2.parse_obj({
        **base,
        "schema_version": "flowpulse.incident-projection.v2",
        "source_revision": 1,
        "connector_revision": 1,
        "incident_clock": IncidentClock(
            state=IncidentClockState.RUNNING,
            started_at=now,
            as_of=now,
            elapsed_seconds=0,
            freshness="CURRENT",
            fresh_until=now + timedelta(seconds=30),
            max_interpolation_seconds=30,
        ).dict(),
        "connector_health": [health.dict()],
        "realtime_signals": [],
        "active_graph_pulses": [],
        "agent_workspace": AgentWorkspace(
            workspace_revision=1, activities=[], citations=[],
        ).dict(),
    })
    return {
        "schema_version": "flowpulse.realtime-contract-examples.v2",
        "request_examples": {
            "ConnectorReconcileRequest": ConnectorReconcileRequest(
                idempotency_key="reconcile-example-1",
            ).dict(),
        },
        "response_examples": {
            "IncidentProjectionV2": projection.dict(),
            "ConnectorHealthUnavailable": health.dict(),
        },
        "truth": {
            "fixture_label": "TEST_DETERMINISTIC",
            "external_write_performed": False,
            "otel_adapter_state": "UNAVAILABLE",
        },
    }


def generate(output: Path, producer_implementation_sha: str) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    openapi_path = output / "flowpulse-incident-realtime-v2.openapi.json"
    examples_path = output / "flowpulse-incident-realtime-v2.examples.json"
    freeze_path = output / "flowpulse-incident-realtime-v2.freeze.json"
    document = create_app().openapi()
    v2_paths = {
        path: value for path, value in document["paths"].items()
        if path.startswith("/v2/")
    }
    v3_paths = {
        path: value for path, value in document["paths"].items()
        if path.startswith("/v3/")
    }
    schemas = document["components"]["schemas"]
    v2_references = _schema_closure(v2_paths, schemas)
    v3_only = _schema_closure(v3_paths, schemas) - v2_references
    # FastAPI returns one application-wide component map.  The additive V3
    # routes must not rewrite the already frozen V2 artifact merely because
    # their unrelated models were registered on the same app.
    document["components"]["schemas"] = {
        name: value for name, value in schemas.items()
        if name not in v3_only
    }
    document["paths"] = v2_paths
    document["info"] = {
        "title": "FlowPulse Realtime Incident Contract",
        "version": "v2-phase1a",
    }
    document["x-flowpulse-realtime-contract"] = {
        "schema_version": "flowpulse.incident-realtime.v2",
        "compatibility": "additive_v2_v1_frozen",
        "lifecycle_authority": "temporal",
        "connector_scope": ["PROMETHEUS", "OTEL_UNAVAILABLE"],
        "external_write_authorized": False,
    }
    hashes = {
        openapi_path.name: _write(openapi_path, document),
        examples_path.name: _write(examples_path, _examples()),
    }
    freeze = {
        "schema_version": "flowpulse.incident-realtime.freeze.v2",
        "producer_implementation_git_sha": producer_implementation_sha,
        "hash_algorithm": "sha256",
        "artifacts": hashes,
        "generated_at": "deterministic-from-source",
    }
    hashes[freeze_path.name] = _write(freeze_path, freeze)
    return hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--producer-implementation-sha", required=True)
    args = parser.parse_args()
    print(json.dumps(
        generate(args.output, args.producer_implementation_sha),
        sort_keys=True,
    ))


if __name__ == "__main__":
    main()

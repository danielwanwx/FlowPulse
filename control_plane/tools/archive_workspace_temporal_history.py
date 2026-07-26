"""Archive a real workspace Temporal history with reproducible provenance."""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from temporalio.client import Client


async def archive(args) -> None:
    client = await Client.connect(args.address)
    history = await client.get_workflow_handle(args.workflow_id, run_id=args.workflow_run_id).fetch_history()
    raw = history.to_json().encode("utf-8")
    started = history.events[0].workflow_execution_started_event_attributes
    if started.workflow_type.name != "flowpulse.incident-workspace.v1":
        raise RuntimeError("unexpected_workspace_history_type")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    filename = "workspace_node_explanation_degraded.json"
    history_path = output / filename
    history_path.write_bytes(raw)
    manifest = {
        "schema_version": 1,
        "producer": {
            "git_sha": args.producer_git_sha,
            "workflow_type": "flowpulse.incident-workspace.v1",
            "workflow_id": args.workflow_id,
            "workflow_run_id": args.workflow_run_id,
            "public_identity": {
                "tenant_id": args.tenant_id,
                "incident_id": args.incident_id,
                "run_id": args.run_id,
                "topology_revision": args.topology_revision,
            },
        },
        "histories": [{
            "name": "workspace_node_explanation_degraded",
            "filename": filename,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "event_count": len(history.events),
            "expected_outcome": "degraded_node_explanation_without_fresh_read_or_diagnosis",
        }],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--workflow-id", required=True)
    parser.add_argument("--workflow-run-id", required=True)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--incident-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--topology-revision", required=True)
    parser.add_argument("--producer-git-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(archive(parser.parse_args()))


if __name__ == "__main__":
    main()

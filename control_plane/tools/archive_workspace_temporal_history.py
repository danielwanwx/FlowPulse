"""Archive a real workspace Temporal history with verified producer provenance."""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from temporalio.client import Client

from flowpulse_cp.workspace_provenance import history_identity, verify_producer_image_attestation


async def archive(args) -> None:
    attestation = json.loads(args.producer_attestation.read_text(encoding="utf-8"))
    producer = verify_producer_image_attestation(args.repo_root, args.producer_image, attestation)
    client = await Client.connect(args.address)
    history = await client.get_workflow_handle(args.workflow_id, run_id=args.workflow_run_id).fetch_history()
    raw = history.to_json().encode("utf-8")
    identity = history_identity(raw)
    if identity["workflow_id"] != args.workflow_id or identity["workflow_run_id"] != args.workflow_run_id:
        raise RuntimeError("workspace_history_fetch_identity_mismatch")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    filename = "workspace_node_explanation_degraded.json"
    history_path = output / filename
    history_path.write_bytes(raw)
    manifest = {
        "schema_version": 2,
        "producer": {**producer, **identity},
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
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--producer-attestation", type=Path, required=True)
    parser.add_argument("--producer-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(archive(parser.parse_args()))


if __name__ == "__main__":
    main()

"""Write a workspace history producer attestation from Docker's inspect output."""

import argparse
import json
from pathlib import Path

from flowpulse_cp.workspace_provenance import (
    write_producer_attestation,
    write_producer_attestation_from_image,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image-inspect", type=Path)
    source.add_argument("--image")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.image:
        attestation = write_producer_attestation_from_image(args.repo_root, args.image, args.output)
    else:
        attestation = write_producer_attestation(args.repo_root, args.image_inspect, args.output)
    print(json.dumps(attestation, sort_keys=True))


if __name__ == "__main__":
    main()

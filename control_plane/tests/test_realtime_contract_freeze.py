"""Integrity and resolvable-reference checks for the additive V2 bundle."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from generate_realtime_contract import generate


ARTIFACTS = ROOT / "openapi"
V1_HASHES = {
    "flowpulse-incident-workspace-v1.examples.json": "2ffbc5e19ba54f07219f0b9ca164b4a7c7f7c5e587b248cf27a35f09327e5003",
    "flowpulse-incident-workspace-v1.freeze.json": "4393b58b3c51bbdf08a26b3b14267cf698444a58765afcd91fe428c812466843",
    "flowpulse-incident-workspace-v1.openapi.json": "be260bc4da0ce19f115acd18a3b2e6cac4fef5317ca657da79812af86e4b6573",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RealtimeContractFreezeTests(unittest.TestCase):
    def test_v1_artifacts_remain_byte_frozen(self):
        self.assertEqual(
            V1_HASHES,
            {name: digest(ARTIFACTS / name) for name in V1_HASHES},
        )

    def test_v2_manifest_hashes_and_all_local_refs_resolve(self):
        manifest = json.loads(
            (ARTIFACTS / "flowpulse-incident-realtime-v2.freeze.json").read_text()
        )
        for filename, expected in manifest["artifacts"].items():
            self.assertEqual(expected, digest(ARTIFACTS / filename))
        document = json.loads(
            (ARTIFACTS / "flowpulse-incident-realtime-v2.openapi.json").read_text()
        )
        schemas = document["components"]["schemas"]

        def visit(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    prefix = "#/components/schemas/"
                    self.assertTrue(value["$ref"].startswith(prefix))
                    self.assertIn(value["$ref"][len(prefix):], schemas)
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(document)
        self.assertEqual(
            {"GET"},
            {
                method.upper()
                for method in document["paths"]["/v2/incidents"].keys()
            },
        )
        self.assertEqual(
            "text/event-stream",
            next(iter(
                document["paths"]["/v2/incidents/{case_id}/events"]["get"]
                ["responses"]["200"]["content"].keys()
            )),
        )

    def test_generator_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temp:
            hashes = generate(Path(temp), "638b120b10eab189a0fae1a115534e8870e2d3e3")
            for filename, expected in hashes.items():
                self.assertEqual(expected, digest(Path(temp) / filename))
            self.assertEqual(
                digest(ARTIFACTS / "flowpulse-incident-realtime-v2.openapi.json"),
                hashes["flowpulse-incident-realtime-v2.openapi.json"],
            )

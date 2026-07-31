import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class WorkspaceV3ExecutionMigrationTests(unittest.TestCase):
    def test_execution_pointer_schema_uses_append_only_generations_and_mutable_pointer(self):
        sql = (
            ROOT / "control_plane" / "migrations" /
            "017_workspace_v3_execution_identity.sql"
        ).read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE incident_execution_identities_v3", sql)
        self.assertIn("CREATE TABLE temporal_execution_generations_v3", sql)
        self.assertIn("CREATE TABLE temporal_execution_pointers_v3", sql)
        self.assertIn("temporal_execution_generations_v3_append_only", sql)
        self.assertNotIn("temporal_execution_pointers_v3_append_only", sql)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE ON temporal_execution_pointers_v3",
            sql,
        )


if __name__ == "__main__":
    unittest.main()

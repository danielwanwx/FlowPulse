"""Opt-in end-to-end proof of the v1 HTTP -> v2 Temporal projection path."""

import asyncio
import json
import os
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from temporalio.client import Client

from flowpulse_cp.postgres import PostgresCaseRepository
from flowpulse_cp.workspace_versions import WORKSPACE_V2_WORKFLOW_TYPE


@unittest.skipUnless(os.environ.get("FLOWPULSE_LIVE_INCIDENT_WORKSPACE") == "1", "requires local Compose")
class LiveIncidentWorkspaceHttpTests(unittest.TestCase):
    base_url = os.environ.get("FLOWPULSE_API_URL", "http://127.0.0.1:8090")
    owner_token = os.environ.get("FLOWPULSE_LIVE_API_OWNER_TOKEN")
    dsn = os.environ.get(
        "FLOWPULSE_TEST_POSTGRES_DSN",
        "postgresql://flowpulse_cp_app:flowpulse-cp-local-only@127.0.0.1:5433/flowpulse",
    )
    temporal_address = os.environ.get("FLOWPULSE_TEMPORAL_ADDRESS", "127.0.0.1:7233")

    @classmethod
    def setUpClass(cls):
        if not cls.owner_token:
            raise unittest.SkipTest("requires FLOWPULSE_LIVE_API_OWNER_TOKEN")

    def request(self, method, path, payload=None, headers=None):
        request = Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            method=method,
        )
        request.add_header("content-type", "application/json")
        request.add_header("authorization", "Bearer " + self.owner_token)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urlopen(request, timeout=15) as response:
                return response.status, response.read().decode("utf-8")
        except HTTPError as error:
            return error.code, error.read().decode("utf-8")

    def test_workspace_intake_projection_exactly_once_node_update_and_sse_resume(self):
        observed_at = datetime.now(timezone.utc).isoformat()
        status, raw = self.request("POST", "/v1/incidents", {
            "incident_id": "workspace-http-{}".format(uuid4().hex), "title": "Workspace Compose smoke",
            "severity": "SEV2", "environment": "local", "affected_entities": ["checkout"],
            "observed_at": observed_at, "summary": "Contract Core live proof.",
        })
        self.assertEqual(202, status, raw)
        projection = json.loads(raw)
        self.assertNotEqual(projection["run_id"], projection["workflow_id"])
        self.assertNotEqual(projection["run_id"], projection["workflow_run_id"])
        self.assertEqual("DEGRADED", projection["lifecycle_state"])
        self.assertEqual("provider_unavailable", projection["degraded_code"])

        async def started_workflow_type():
            client = await Client.connect(self.temporal_address)
            history = await client.get_workflow_handle(
                projection["workflow_id"], run_id=projection["workflow_run_id"],
            ).fetch_history()
            return history.events[0].workflow_execution_started_event_attributes.workflow_type.name

        self.assertEqual(WORKSPACE_V2_WORKFLOW_TYPE, asyncio.run(started_workflow_type()))
        status, current = self.request("GET", "/v1/incidents/{}/projection".format(projection["case_id"]))
        self.assertEqual(200, status, current)
        self.assertEqual(projection["workflow_run_id"], json.loads(current)["workflow_run_id"])

        command = {
            "incident_id": projection["incident_id"], "run_id": projection["run_id"],
            "topology_revision": projection["topology_revision"],
            "projection_revision": projection["projection_revision"], "component_id": "checkout",
            "idempotency_key": "workspace-click-{}".format(uuid4().hex),
        }
        path = "/v1/incidents/{}/node-explanations".format(projection["case_id"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda _: self.request("POST", path, command), range(2)))
        self.assertEqual([202, 202], [item[0] for item in replies], replies)
        bodies = [json.loads(item[1]) for item in replies]
        self.assertEqual(bodies[0]["explanation"]["explanation_id"], bodies[1]["explanation"]["explanation_id"])
        self.assertEqual("DEGRADED", bodies[0]["explanation"]["state"])
        self.assertEqual("DEGRADED", bodies[0]["explanation"]["truth_label"])
        self.assertEqual("provider_unavailable", bodies[0]["explanation"]["degraded_code"])
        trace = bodies[0]["explanation"]["conversation_trace"]
        self.assertEqual("DEGRADED", trace["truth_label"])
        self.assertEqual(0, trace["provider_call_count"])
        self.assertEqual(0, trace["tool_calls"])
        self.assertFalse(bodies[0]["explanation"]["fresh_read_performed"])
        self.assertFalse(bodies[0]["explanation"]["fresh_diagnosis_claimed"])

        forged = dict(command)
        forged["run_id"] = projection["workflow_run_id"]
        status, raw = self.request("POST", path, forged)
        self.assertEqual(409, status, raw)
        status, stream = self.request("GET", "/v1/incidents/{}/events?after=0".format(projection["case_id"]))
        self.assertEqual(200, status, stream)
        event_ids = [line.removeprefix("id: ") for line in stream.splitlines() if line.startswith("id: ")]
        self.assertEqual(["1", "2"], event_ids)
        status, resumed = self.request(
            "GET", "/v1/incidents/{}/events?after=1".format(projection["case_id"]),
            headers={"Last-Event-ID": "1"},
        )
        self.assertEqual(200, status, resumed)
        self.assertNotIn("id: 1", resumed)
        self.assertIn("id: 2", resumed)

        async def counts():
            repository = PostgresCaseRepository(self.dsn)
            await repository.connect()
            try:
                async def operation(connection):
                    events = await connection.fetchval(
                        "SELECT count(*) FROM incident_projection_events WHERE case_id=$1", projection["case_id"],
                    )
                    explanations = await connection.fetchval(
                        "SELECT count(*) FROM node_explanations WHERE case_id=$1", projection["case_id"],
                    )
                    return events, explanations
                return await repository._tenant("tenant-http", operation)
            finally:
                await repository.close()
        self.assertEqual((2, 1), asyncio.run(counts()))


if __name__ == "__main__":
    unittest.main()

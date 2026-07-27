"""Backend-owned deterministic topology snapshots at the durable projection seam."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flowpulse_cp.models import AuthContext
from flowpulse_cp.provider_gateway import ProviderMode
from flowpulse_cp.provider_gateway import ProviderConfigurationError
from flowpulse_cp.workspace_activities import WorkspaceActivityDispatcher
from flowpulse_cp.workspace_models import (
    GraphMembership,
    IncidentRunBinding,
    WorkspaceActivityPacket,
    initial_projection,
)
from flowpulse_cp.workspace_repository import InMemoryWorkspaceRepository
from flowpulse_cp.workspace_topology import CapturedAstronomyTopologyProvider


NOW = datetime(2026, 7, 27, tzinfo=timezone.utc)


def binding():
    return IncidentRunBinding(
        tenant_id="tenant-topology", incident_id="incident-topology",
        run_id="run-topology", topology_revision="topology-v1-topology",
        case_id="case-topology", case_revision=1,
        workflow_id="flowpulse.incident-workspace:tenant-topology:run-topology",
        workflow_run_id="temporal-run-topology", created_at=NOW,
    )


async def initialize(topology_provider=None):
    item = binding()
    repository = InMemoryWorkspaceRepository()
    projection = initial_projection(
        item, ["checkout"], NOW, "Checkout degraded", "Checkout requests are degraded.",
    )
    packet = WorkspaceActivityPacket(
        **item.dict(), stage="workspace_initialize", projection=projection,
        event_sequence=1,
        actor=AuthContext(tenant_id=item.tenant_id, subject_id="subject-a", roles=["viewer"]),
    )
    await WorkspaceActivityDispatcher(
        repository, topology_provider=topology_provider,
    ).dispatch("workspace_initialize_activity", packet.dict())
    return repository, await repository.get_projection(item.tenant_id, item.case_id)


class WorkspaceTopologyProjectionTests(unittest.IsolatedAsyncioTestCase):
    def test_captured_topology_cannot_be_constructed_in_standard_mode(self):
        with self.assertRaisesRegex(
            ProviderConfigurationError, "captured_topology_requires_test_or_demo_mode",
        ):
            CapturedAstronomyTopologyProvider(ProviderMode.STANDARD)

    async def test_explicit_test_mode_persists_the_canonical_astronomy_projection(self):
        repository, projected = await initialize(
            CapturedAstronomyTopologyProvider(ProviderMode.TEST),
        )

        self.assertEqual(22, len(projected.graph.nodes))
        self.assertEqual(26, len(projected.graph.edges))
        self.assertEqual(
            {
                "accounting": "Accounting",
                "ad": "Ad",
                "cart": "Cart",
                "checkout": "Checkout",
                "currency": "Currency",
                "email": "Email",
                "flagd": "Flagd",
                "flagd-ui": "Flagd UI",
                "fraud-detection": "Fraud Detection",
                "frontend": "Frontend",
                "frontend-proxy": "Frontend Proxy",
                "frontend-web": "Frontend Web",
                "image-provider": "Image Provider",
                "kafka": "Kafka",
                "load-generator": "Load Generator",
                "otelcol-contrib": "OTel Collector",
                "payment": "Payment",
                "product-catalog": "Product Catalog",
                "quote": "Quote",
                "recommendation": "Recommendation",
                "shipping": "Shipping",
                "telemetry-docs": "Telemetry Docs",
            },
            {
                node.component_id: node.display_name
                for node in projected.graph.nodes
            },
        )
        self.assertEqual(
            ["frontend", "checkout", "payment", "kafka", "accounting", "fraud-detection"],
            projected.impacted_path,
        )
        edge_ids = {
            edge.edge_id
            for edge in projected.graph.edges
        }
        self.assertEqual(
            {
                "ad->flagd",
                "cart->flagd",
                "checkout->cart",
                "checkout->currency",
                "checkout->email",
                "checkout->payment",
                "checkout->product-catalog",
                "checkout->shipping",
                "fraud-detection->flagd",
                "frontend->ad",
                "frontend->cart",
                "frontend->checkout",
                "frontend->currency",
                "frontend->product-catalog",
                "frontend->recommendation",
                "frontend->shipping",
                "frontend-proxy->flagd",
                "frontend-proxy->frontend",
                "frontend-proxy->image-provider",
                "frontend-web->frontend-proxy",
                "load-generator->flagd",
                "load-generator->frontend-proxy",
                "payment->flagd",
                "recommendation->flagd",
                "recommendation->product-catalog",
                "shipping->quote",
            },
            edge_ids,
        )
        self.assertEqual(
            {"frontend->checkout", "checkout->payment"},
            edge_ids & {
                "frontend->checkout", "checkout->payment", "checkout->kafka",
                "kafka->accounting", "kafka->fraud-detection",
            },
        )
        connected = {
            component_id
            for edge in projected.graph.edges
            for component_id in (edge.source_component_id, edge.target_component_id)
        }
        self.assertTrue(all(
            (
                node.membership == GraphMembership.CONNECTED
                and node.component_id in connected
                and node.classification_reason is None
            )
            or (
                node.membership == GraphMembership.CLASSIFIED
                and node.component_id not in connected
                and node.classification_reason is not None
            )
            for node in projected.graph.nodes
        ))
        events = await repository.events_after("tenant-topology", "case-topology", 0)
        self.assertEqual("TEST_DETERMINISTIC", events[0].payload["topology_truth_label"])
        self.assertEqual("otel-demo-system-v1", events[0].payload["topology_fixture_id"])
        self.assertEqual(
            "frontend,checkout,payment,kafka,accounting,fraud-detection",
            events[0].payload["topology_overlay_node_ids"],
        )
        self.assertEqual(
            (
                "checkout->kafka,checkout->payment,frontend->checkout,"
                "kafka->accounting,kafka->fraud-detection"
            ),
            events[0].payload["topology_overlay_relation_ids"],
        )
        self.assertEqual(64, len(events[0].payload["topology_asset_sha256"]))

    async def test_default_mode_persists_only_the_fail_closed_affected_component(self):
        repository, projected = await initialize()

        self.assertEqual(["checkout"], [node.component_id for node in projected.graph.nodes])
        self.assertEqual(GraphMembership.CLASSIFIED, projected.graph.nodes[0].membership)
        self.assertEqual([], projected.graph.edges)
        self.assertEqual([], projected.impacted_path)
        events = await repository.events_after("tenant-topology", "case-topology", 0)
        self.assertNotIn("topology_truth_label", events[0].payload)

"""Server-owned topology snapshots for explicit test and demo runtimes."""

from hashlib import sha256
import json
from typing import Dict, Tuple

from .provider_gateway import ProviderConfigurationError, ProviderMode
from .workspace_models import (
    ClassifiedNodeReason,
    GraphMembership,
    IncidentGraph,
    IncidentGraphEdge,
    IncidentGraphNode,
    IncidentProjection,
)


FIXTURE_ID = "otel-demo-system-v1"
SOURCE_VERSION = "18b36c73ccc2dbc86759dab2e0ef05175a7a8ca5"
SOURCE_MANIFEST_CONTENT_SHA256 = "d1c10422a982945a9a3fb7a5ccd9bdbc01219af5403de9da55116c60d4b66d9f"

NODES: Tuple[Tuple[str, str], ...] = (
    ("accounting", "Accounting"),
    ("ad", "Ad"),
    ("cart", "Cart"),
    ("checkout", "Checkout"),
    ("currency", "Currency"),
    ("email", "Email"),
    ("flagd", "Flagd"),
    ("flagd-ui", "Flagd UI"),
    ("fraud-detection", "Fraud Detection"),
    ("frontend", "Frontend"),
    ("frontend-proxy", "Frontend Proxy"),
    ("frontend-web", "Frontend Web"),
    ("image-provider", "Image Provider"),
    ("kafka", "Kafka"),
    ("load-generator", "Load Generator"),
    ("otelcol-contrib", "OTel Collector"),
    ("payment", "Payment"),
    ("product-catalog", "Product Catalog"),
    ("quote", "Quote"),
    ("recommendation", "Recommendation"),
    ("shipping", "Shipping"),
    ("telemetry-docs", "Telemetry Docs"),
)

EDGES: Tuple[Tuple[str, str, str], ...] = (
    ("ad->flagd", "ad", "flagd"),
    ("cart->flagd", "cart", "flagd"),
    ("checkout->cart", "checkout", "cart"),
    ("checkout->currency", "checkout", "currency"),
    ("checkout->email", "checkout", "email"),
    ("checkout->payment", "checkout", "payment"),
    ("checkout->product-catalog", "checkout", "product-catalog"),
    ("checkout->shipping", "checkout", "shipping"),
    ("fraud-detection->flagd", "fraud-detection", "flagd"),
    ("frontend->ad", "frontend", "ad"),
    ("frontend->cart", "frontend", "cart"),
    ("frontend->checkout", "frontend", "checkout"),
    ("frontend->currency", "frontend", "currency"),
    ("frontend->product-catalog", "frontend", "product-catalog"),
    ("frontend->recommendation", "frontend", "recommendation"),
    ("frontend->shipping", "frontend", "shipping"),
    ("frontend-proxy->flagd", "frontend-proxy", "flagd"),
    ("frontend-proxy->frontend", "frontend-proxy", "frontend"),
    ("frontend-proxy->image-provider", "frontend-proxy", "image-provider"),
    ("frontend-web->frontend-proxy", "frontend-web", "frontend-proxy"),
    ("load-generator->flagd", "load-generator", "flagd"),
    ("load-generator->frontend-proxy", "load-generator", "frontend-proxy"),
    ("payment->flagd", "payment", "flagd"),
    ("recommendation->flagd", "recommendation", "flagd"),
    ("recommendation->product-catalog", "recommendation", "product-catalog"),
    ("shipping->quote", "shipping", "quote"),
)

INCIDENT_NODE_IDS = frozenset({
    "accounting", "checkout", "fraud-detection", "frontend", "kafka", "payment",
})
INCIDENT_RELATION_IDS = (
    "checkout->kafka",
    "checkout->payment",
    "frontend->checkout",
    "kafka->accounting",
    "kafka->fraud-detection",
)
IMPACTED_PATH = (
    "frontend", "checkout", "payment", "kafka", "accounting", "fraud-detection",
)


def _asset_sha256() -> str:
    encoded = json.dumps(
        {
            "fixture_id": FIXTURE_ID,
            "source_version": SOURCE_VERSION,
            "source_manifest_content_sha256": SOURCE_MANIFEST_CONTENT_SHA256,
            "nodes": NODES,
            "edges": EDGES,
            "incident_node_ids": sorted(INCIDENT_NODE_IDS),
            "incident_relation_ids": INCIDENT_RELATION_IDS,
            "impacted_path": IMPACTED_PATH,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


ASSET_SHA256 = _asset_sha256()


class CapturedAstronomyTopologyProvider:
    """A captured fixture that cannot be constructed in standard/live modes."""

    def __init__(self, mode: ProviderMode) -> None:
        if mode not in {ProviderMode.TEST, ProviderMode.DEMO}:
            raise ProviderConfigurationError("captured_topology_requires_test_or_demo_mode")
        self.mode = mode

    @property
    def truth_label(self) -> str:
        return "TEST_DETERMINISTIC" if self.mode == ProviderMode.TEST else "DEMO"

    def snapshot(self, projection: IncidentProjection) -> IncidentProjection:
        connected = {
            component_id
            for _, source, target in EDGES
            for component_id in (source, target)
        }
        graph = IncidentGraph(
            nodes=[
                IncidentGraphNode(
                    component_id=component_id,
                    canonical_identity="service:{}".format(component_id),
                    display_name=display_name,
                    membership=(
                        GraphMembership.CONNECTED
                        if component_id in connected
                        else GraphMembership.CLASSIFIED
                    ),
                    classification_reason=(
                        None
                        if component_id in connected
                        else ClassifiedNodeReason.RELATIONSHIP_UNAVAILABLE
                    ),
                    runtime_status=(
                        "degraded" if component_id in INCIDENT_NODE_IDS else "observed"
                    ),
                    impact_status=(
                        "impacted" if component_id in INCIDENT_NODE_IDS else "not_impacted"
                    ),
                )
                for component_id, display_name in NODES
            ],
            edges=[
                IncidentGraphEdge(
                    edge_id=edge_id,
                    source_component_id=source,
                    target_component_id=target,
                    status=(
                        "impacted"
                        if edge_id in INCIDENT_RELATION_IDS
                        else "observed"
                    ),
                )
                for edge_id, source, target in EDGES
            ],
        )
        return IncidentProjection.parse_obj({
            **projection.dict(),
            "graph": graph.dict(),
            "impacted_path": list(IMPACTED_PATH),
        })

    def initialized_event_payload(self, projection: IncidentProjection) -> Dict[str, str]:
        return {
            "state": projection.status,
            "topology_truth_label": self.truth_label,
            "topology_fixture_id": FIXTURE_ID,
            "topology_source_version": SOURCE_VERSION,
            "topology_source_manifest_sha256": SOURCE_MANIFEST_CONTENT_SHA256,
            "topology_asset_sha256": ASSET_SHA256,
            "topology_overlay_node_ids": ",".join(IMPACTED_PATH),
            "topology_overlay_relation_ids": ",".join(INCIDENT_RELATION_IDS),
        }

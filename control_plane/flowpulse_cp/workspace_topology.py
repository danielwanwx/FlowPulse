"""Server-owned topology snapshots for explicit test and demo runtimes."""

from hashlib import sha256
import json
from typing import Dict, Iterable, Tuple

from .provider_gateway import ProviderConfigurationError, ProviderMode
from .workspace_models import (
    AffectedUserPathStatus,
    ClassifiedNodeReason,
    GraphMembership,
    IncidentGraph,
    IncidentGraphEdge,
    IncidentFocus,
    IncidentGraphNode,
    IncidentProjection,
)
from .realtime_models import ConfiguredBindingTemplate


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
    "frontend->checkout",
    "checkout->payment",
    "checkout->kafka",
    "kafka->accounting",
    "kafka->fraud-detection",
)
SUPPORTING_RELATIONS: Tuple[Tuple[str, str, str], ...] = (
    ("checkout->kafka", "checkout", "kafka"),
    ("kafka->accounting", "kafka", "accounting"),
    ("kafka->fraud-detection", "kafka", "fraud-detection"),
)
ALL_EDGES = EDGES + SUPPORTING_RELATIONS
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
            "supporting_relations": SUPPORTING_RELATIONS,
            "incident_node_ids": sorted(INCIDENT_NODE_IDS),
            "incident_relation_ids": INCIDENT_RELATION_IDS,
            "impacted_path": IMPACTED_PATH,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


ASSET_SHA256 = _asset_sha256()


class ConfiguredTopologyManifestProvider:
    """Production topology seed built only from deployment-owned bindings.

    This is not the captured demo graph.  It adds exactly the components and
    dependency edges named by the worker's configured connector bindings, with
    neutral status.  Incident impact and runtime status are applied later only
    when a bound OTel/metric fact is committed.
    """

    def __init__(self, bindings: Iterable[ConfiguredBindingTemplate]) -> None:
        self.bindings = tuple(bindings)
        if not self.bindings:
            raise ProviderConfigurationError("configured_topology_manifest_empty")
        edge_sources = {}
        for binding in self.bindings:
            if binding.edge_ids and len(binding.component_ids) < 2:
                raise ProviderConfigurationError(
                    "configured_topology_edge_requires_components",
                )
            for edge_id in binding.edge_ids:
                expected = "{}->{}".format(
                    binding.component_ids[0], binding.component_ids[-1],
                )
                if edge_id != expected:
                    raise ProviderConfigurationError(
                        "configured_topology_edge_identity_mismatch",
                    )
                prior = edge_sources.setdefault(edge_id, expected)
                if prior != expected:
                    raise ProviderConfigurationError(
                        "configured_topology_edge_conflict",
                    )

    @property
    def manifest_sha256(self) -> str:
        payload = [item.dict() for item in self.bindings]
        return sha256(json.dumps(
            payload, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()

    def snapshot(self, projection: IncidentProjection) -> IncidentProjection:
        nodes = {item.component_id: item for item in projection.graph.nodes}
        edges = {item.edge_id: item for item in projection.graph.edges}
        for binding in self.bindings:
            for component_id in binding.component_ids:
                prior = nodes.get(component_id)
                if prior is None:
                    prior = IncidentGraphNode(
                        component_id=component_id,
                        canonical_identity="service:{}".format(component_id),
                        display_name=component_id.replace("-", " ").title(),
                        membership=GraphMembership.CONNECTED,
                        runtime_status="unknown",
                        impact_status="unknown",
                    )
                else:
                    prior = prior.copy(update={
                        "membership": GraphMembership.CONNECTED,
                        "classification_reason": None,
                    })
                nodes[component_id] = prior
            for edge_id in binding.edge_ids:
                edges[edge_id] = IncidentGraphEdge(
                    edge_id=edge_id,
                    source_component_id=binding.component_ids[0],
                    target_component_id=binding.component_ids[-1],
                    status="observed",
                )
        return projection.copy(update={
            "graph": IncidentGraph(
                nodes=list(nodes.values()), edges=list(edges.values()),
            ),
        })

    def initialized_event_payload(self, projection: IncidentProjection) -> Dict[str, str]:
        return {
            "state": projection.status,
            "topology_truth_label": "LIVE_CONFIGURED_MANIFEST",
            "topology_manifest_sha256": self.manifest_sha256,
            "topology_overlay_node_ids": ",".join(
                item.component_id for item in projection.graph.nodes
            ),
            "topology_overlay_relation_ids": ",".join(
                item.edge_id for item in projection.graph.edges
            ),
        }


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
            for _, source, target in ALL_EDGES
            for component_id in (source, target)
        }
        provenance_prefix = "topology-fixture:{}@{}#relation/".format(
            FIXTURE_ID, SOURCE_VERSION,
        )
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
                for edge_id, source, target in ALL_EDGES
            ],
        )
        return IncidentProjection.parse_obj({
            **projection.dict(),
            "graph": graph.dict(),
            "impacted_path": list(IMPACTED_PATH),
            "incident_focus": IncidentFocus(
                component_id="checkout",
                canonical_identity="service:checkout",
                rationale=(
                    "Checkout is the first shared service on the audited affected user path."
                ),
                affected_user_path_status=AffectedUserPathStatus.KNOWN,
                affected_user_path_summary=(
                    "Checkout degradation affects payment processing and downstream "
                    "Kafka-backed accounting and fraud checks."
                ),
                incident_relation_edge_ids=list(INCIDENT_RELATION_IDS),
                incident_relation_provenance_refs=[
                    provenance_prefix + edge_id for edge_id in INCIDENT_RELATION_IDS
                ],
            ).dict(),
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
            "incident_focus_component_id": projection.incident_focus.component_id,
            "incident_focus_relation_edge_ids": ",".join(
                projection.incident_focus.incident_relation_edge_ids,
            ),
        }

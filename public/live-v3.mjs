import { ControlPlaneV3Client } from "./control-plane-v3-client.mjs";
import { topologyLayout } from "./control-plane-topology-layout.mjs";

export function liveIncidentMatchesProjectionV3(incident, projection) {
  if (!incident || !projection) return false;
  const identity = ["case_id", "incident_id", "run_id", "topology_revision"].every((key) => incident[key] === projection[key]);
  const status = incident.severity === projection.severity
    && incident.lifecycle_state === projection.lifecycle_state
    && incident.freshness?.state === projection.freshness?.state
    && incident.current_stage === projection.current_attempt?.current_stage;
  const impacted = sameValues(incident.impacted_components, projection.impacted_path);
  return identity && status && impacted && incident.projection_revision <= projection.projection_revision && incident.sequence <= projection.sequence;
}

export function liveProjectionBelongsToIncidentV3(incident, projection) {
  return Boolean(incident && projection
    && ["case_id", "incident_id", "run_id", "topology_revision"].every((key) => incident[key] === projection[key])
    && projection.projection_revision >= incident.projection_revision
    && projection.sequence >= incident.sequence);
}

export function renderLiveIncidentsV3(snapshot, connection = "connecting") {
  const incidents = snapshot?.incidents || [];
  const retry = ["degraded", "stale"].includes(connection)
    ? '<button type="button" data-live-retry>Retry V3 Live</button>'
    : "";
  return `<div class="lv3-shell" data-connection="${escapeHtml(connection)}"><header><div><span>Active incidents</span><strong>${incidents.length}</strong></div><div><small role="status">${escapeHtml(connectionCopy(connection))}</small>${retry}</div></header><div class="lv3-list">${incidents.map((incident) => `<article class="lv3-card" data-live-case="${escapeHtml(incident.case_id)}"><div class="lv3-card-status"><span>${escapeHtml(incident.severity)}</span><small class="is-${escapeHtml(incident.freshness.state.toLowerCase())}">${escapeHtml(titleCase(incident.freshness.state))}</small></div><div><h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.summary)}</p><ul aria-label="Impacted components">${incident.impacted_components.map((component) => `<li>${escapeHtml(component)}</li>`).join("")}</ul></div><div class="lv3-card-action"><span>${escapeHtml(titleCase(incident.current_stage))}</span><button type="button" data-open-live-case="${escapeHtml(incident.case_id)}">Open incident</button></div></article>`).join("") || '<p class="lv3-empty">No active incident is published by V3.</p>'}</div></div>`;
}

export function liveTopologyProjectionSetV3(projections, now = Date.now()) {
  const values = projections instanceof Map ? [...projections.values()] : [...(projections || [])];
  return values
    .filter((projection) => projection?.lifecycle_state !== "RESOLVED")
    .map((projection) => {
      const nodes = projection.graph.nodes.map((node) => ({ ...node }));
      const positions = topologyLayout(nodes).positions;
      const nodeIds = new Set(nodes.map((node) => node.component_id));
      const impacted = new Set(projection.impacted_path);
      const edges = projection.graph.edges
        .filter((edge) => nodeIds.has(edge.source_component_id) && nodeIds.has(edge.target_component_id))
        .map((edge) => ({ ...edge }));
      const edgeIds = new Set(edges.map((edge) => edge.edge_id));
      const activeEdgeIds = new Set();
      const activePulses = projection.graph.active_pulses.filter((pulse) => Date.parse(pulse.expires_at) > now);
      for (const pulse of activePulses) {
        for (const edgeId of pulse.edge_ids) if (edgeIds.has(edgeId)) activeEdgeIds.add(edgeId);
      }
      return {
        case_id: projection.case_id,
        incident_id: projection.incident_id,
        projection_revision: projection.projection_revision,
        sequence: projection.sequence,
        title: projection.title,
        severity: projection.severity,
        lifecycle_state: projection.lifecycle_state,
        freshness: projection.freshness,
        current_stage: projection.current_attempt.current_stage,
        impacted_path: [...projection.impacted_path],
        nodes: nodes.map((node) => ({ ...node, impacted: impacted.has(node.component_id), position: positions.get(node.component_id) })),
        edges: edges.map((edge) => ({ ...edge, active: activeEdgeIds.has(edge.edge_id) })),
        active_pulses: activePulses.map((pulse) => ({ ...pulse, edge_ids: pulse.edge_ids.filter((edgeId) => edgeIds.has(edgeId)) }))
      };
    })
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
}

export function liveLinkedImpactV3(projections) {
  const values = projections instanceof Map ? [...projections.values()] : [...(projections || [])];
  const componentIds = new Set();
  const edgeIds = new Set();
  for (const projection of values) {
    if (!projection || projection.lifecycle_state === "RESOLVED") continue;
    for (const componentId of projection.impacted_path || []) componentIds.add(componentId);
    for (const node of projection.graph?.nodes || []) {
      if (node.impact_status === "impacted") componentIds.add(node.component_id);
    }
    for (const edge of projection.graph?.edges || []) {
      if (["critical", "degraded", "impacted"].includes(edge.status)
        || componentIds.has(edge.source_component_id) && componentIds.has(edge.target_component_id)) {
        edgeIds.add(edge.edge_id);
      }
    }
  }
  return { componentIds, edgeIds };
}

export function renderLiveTopologyV3(projections, connection = "connecting", now = Date.now()) {
  const graphs = liveTopologyProjectionSetV3(projections, now);
  return `<div class="lv3-topology-shell" data-connection="${escapeHtml(connection)}"><header class="lv3-topology-header"><div><span>V3 live topology</span><h2>Canonical incident graph${graphs.length === 1 ? "" : "s"}</h2><p>Nodes, relations, status and pulses come only from current V3 incident projections.</p></div><div><strong>${graphs.length}</strong><small role="status">${escapeHtml(connectionCopy(connection))}</small></div></header><div class="lv3-topology-grid">${graphs.map(graphMarkup).join("") || `<section class="lv3-topology-empty" role="status"><strong>${connection === "connected" ? "No active V3 incident graph" : "Loading V3 incident topology"}</strong><p>${connection === "connected" ? "The active snapshot contains no incident projection to display." : "The legacy topology is suppressed while the canonical V3 source connects."}</p></section>`}</div></div>`;
}

export function applyLiveEventV3(snapshot, event) {
  const incidents = new Map((snapshot?.incidents || []).map((incident) => [incident.case_id, incident]));
  if (event.event_type === "incident.completed" || event.incident.lifecycle_state === "RESOLVED") incidents.delete(event.incident.case_id);
  else incidents.set(event.incident.case_id, event.incident);
  return { ...snapshot, sequence: event.sequence, generated_at: event.occurred_at, incidents: [...incidents.values()] };
}

export class LiveIncidentAdapterV3 {
  constructor({
    element,
    topologyElement,
    legacyTopology,
    legacySurfaces = [],
    linkedTopology = null,
    legacyRoot = null,
    client = new ControlPlaneV3Client(),
    window: windowImpl = globalThis,
    onOpen
  }) {
    this.element = element;
    this.topologyElement = topologyElement;
    this.topologyCanvas = topologyElement?.parentElement || null;
    this.legacyTopology = legacyTopology;
    this.legacySurfaces = [...new Set([legacyTopology, ...legacySurfaces].filter(Boolean))];
    this.legacyRoot = legacyRoot;
    this.linkedTopology = linkedTopology;
    this.client = client;
    this.window = windowImpl;
    this.onOpen = onOpen;
    this.active = false;
    this.snapshot = null;
    this.projections = new Map();
    this.projectionTokens = new Map();
    this.connection = "connecting";
    this.subscription = null;
    this.hydration = null;
    this.rehydrateRequested = false;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.pulseTimer = null;
    this.legacySurfaceStates = new Map();
    this.legacyRootMarker = null;
    this.canvasMarker = null;
    this.onClick = (event) => {
      if (event.target.closest("[data-live-retry]")) {
        void this.retryNow();
        return;
      }
      const button = event.target.closest("[data-open-live-case]");
      if (button && typeof this.onOpen === "function") this.onOpen(button.dataset.openLiveCase);
    };
    this.element.addEventListener("click", this.onClick);
    this.topologyElement?.addEventListener("click", this.onClick);
  }

  async activate() {
    if (this.active) return;
    this.active = true;
    this.connection = "connecting";
    this.element.hidden = false;
    if (this.topologyElement) this.topologyElement.hidden = false;
    if (this.topologyCanvas) {
      this.canvasMarker = this.topologyCanvas.dataset.v3LiveTopology ?? null;
      this.topologyCanvas.dataset.v3LiveTopology = "true";
    }
    if (this.legacyRoot) {
      this.legacyRootMarker = this.legacyRoot.dataset.v3LiveActive ?? null;
      this.legacyRoot.dataset.v3LiveActive = "true";
    }
    this.suppressLegacySurfaces();
    this.render();
    await this.hydrate();
  }

  deactivate() {
    this.active = false;
    this.rehydrateRequested = false;
    this.subscription?.close();
    this.subscription = null;
    this.invalidateAllProjectionLoads();
    this.projections.clear();
    this.snapshot = null;
    this.clearPulseTimer();
    this.clearRetryTimer();
    this.element.hidden = true;
    if (this.topologyElement) {
      this.topologyElement.hidden = true;
      this.topologyElement.innerHTML = "";
    }
    if (this.topologyCanvas) {
      if (this.canvasMarker === null) delete this.topologyCanvas.dataset.v3LiveTopology;
      else this.topologyCanvas.dataset.v3LiveTopology = this.canvasMarker;
      this.canvasMarker = null;
    }
    if (this.legacyRoot) {
      if (this.legacyRootMarker === null) delete this.legacyRoot.dataset.v3LiveActive;
      else this.legacyRoot.dataset.v3LiveActive = this.legacyRootMarker;
      this.legacyRootMarker = null;
    }
    this.restoreLegacySurfaces();
    this.clearLinkedTopology();
  }

  async hydrate() {
    this.rehydrateRequested = true;
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      while (this.active && this.rehydrateRequested) {
        this.rehydrateRequested = false;
        try {
          const snapshot = await this.client.liveSnapshot();
          if (!this.active) return;
          this.snapshot = snapshot;
          this.reconcileProjectionCases();
          this.connection = "connected";
          this.retryAttempt = 0;
          this.clearRetryTimer();
          this.render();
          this.subscribe();
          await this.refreshAllProjections();
        } catch {
          this.connection = "degraded";
          this.render();
          this.scheduleRetry();
        }
      }
    })().finally(() => { this.hydration = null; });
    return this.hydration;
  }

  async retryNow() {
    if (!this.active) return;
    this.clearRetryTimer();
    this.connection = "connecting";
    this.render();
    return this.hydrate();
  }

  scheduleRetry() {
    if (!this.active || this.retryTimer !== null) return;
    const delay = Math.min(1_000 * (2 ** this.retryAttempt), 30_000);
    this.retryAttempt += 1;
    this.retryTimer = this.window.setTimeout(() => {
      this.retryTimer = null;
      if (this.active) void this.hydrate();
    }, delay);
  }

  clearRetryTimer() {
    if (this.retryTimer !== null) this.window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  subscribe() {
    this.subscription?.close();
    this.subscription = this.client.subscribeLive({
      after: this.snapshot?.sequence ?? null,
      onEvent: (event) => {
        if (this.snapshot && event.sequence <= this.snapshot.sequence) return;
        if (!this.snapshot || event.sequence !== this.snapshot.sequence + 1) {
          this.subscription?.close();
          this.subscription = null;
          this.connection = "stale";
          this.render();
          void this.hydrate();
          return;
        }
        this.snapshot = applyLiveEventV3(this.snapshot, event);
        this.connection = "connected";
        const completed = event.event_type === "incident.completed" || event.incident.lifecycle_state === "RESOLVED";
        if (completed) {
          this.invalidateProjectionLoad(event.incident.case_id);
          this.projections.delete(event.incident.case_id);
          this.render();
        } else {
          this.renderCards();
          void this.refreshProjection(event.incident);
        }
      },
      onConnection: (connection) => {
        if (connection === "stale") {
          this.subscription?.close();
          this.subscription = null;
          this.connection = "stale";
          this.render();
          void this.hydrate();
          return;
        }
        this.connection = connection;
        this.render();
      }
    });
  }

  async refreshAllProjections() {
    const incidents = [...(this.snapshot?.incidents || [])];
    let cursor = 0;
    const worker = async () => {
      while (cursor < incidents.length) {
        const incident = incidents[cursor];
        cursor += 1;
        await this.refreshProjection(incident, { render: false });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, incidents.length) }, worker));
    if (this.active) this.renderTopology();
  }

  async refreshProjection(incident, { render = true } = {}) {
    const token = this.invalidateProjectionLoad(incident.case_id);
    try {
      const projection = await this.client.projection(incident.case_id);
      if (!this.active || this.projectionTokens.get(incident.case_id) !== token) return;
      const current = this.snapshot?.incidents.find((candidate) => candidate.case_id === incident.case_id);
      if (!current || !liveProjectionBelongsToIncidentV3(current, projection)) {
        this.projections.delete(incident.case_id);
        if (render) this.renderTopology();
        return;
      }
      this.projections.set(incident.case_id, projection);
    } catch {
      if (this.projectionTokens.get(incident.case_id) === token) this.projections.delete(incident.case_id);
    }
    if (render && this.active) this.renderTopology();
  }

  reconcileProjectionCases() {
    const activeCases = new Map((this.snapshot?.incidents || []).map((incident) => [incident.case_id, incident]));
    for (const [caseId, projection] of this.projections) {
      if (!activeCases.has(caseId) || !liveProjectionBelongsToIncidentV3(activeCases.get(caseId), projection)) {
        this.invalidateProjectionLoad(caseId);
        this.projections.delete(caseId);
      }
    }
  }

  invalidateProjectionLoad(caseId) {
    const token = (this.projectionTokens.get(caseId) || 0) + 1;
    this.projectionTokens.set(caseId, token);
    return token;
  }

  invalidateAllProjectionLoads() {
    for (const caseId of this.projectionTokens.keys()) this.invalidateProjectionLoad(caseId);
  }

  render() {
    if (!this.active) return;
    this.renderCards();
    this.renderTopology();
  }

  renderCards() {
    if (this.active) this.element.innerHTML = renderLiveIncidentsV3(this.snapshot, this.connection);
  }

  renderTopology() {
    if (!this.active) return;
    this.renderLinkedTopology();
    if (!this.topologyElement) return;
    this.topologyElement.innerHTML = renderLiveTopologyV3(this.projections, this.connection);
    this.schedulePulseExpiry();
  }

  renderLinkedTopology() {
    if (!this.linkedTopology) return;
    const impact = liveLinkedImpactV3(this.projections);
    for (const node of this.linkedTopology.querySelectorAll("[data-node-id]")) {
      const active = impact.componentIds.has(node.dataset.nodeId);
      node.classList.toggle("is-v3-impacted", active);
      if (active) node.dataset.v3Impact = "true";
      else delete node.dataset.v3Impact;
    }
    for (const edge of this.linkedTopology.querySelectorAll("[data-edge-id]")) {
      edge.classList.toggle("is-v3-impacted", impact.edgeIds.has(edge.dataset.edgeId));
    }
  }

  clearLinkedTopology() {
    if (!this.linkedTopology) return;
    for (const element of this.linkedTopology.querySelectorAll(".is-v3-impacted")) {
      element.classList.remove("is-v3-impacted");
      delete element.dataset.v3Impact;
    }
  }

  schedulePulseExpiry() {
    this.clearPulseTimer();
    const now = Date.now();
    const expiries = [...this.projections.values()].flatMap((projection) => projection.graph.active_pulses.map((pulse) => Date.parse(pulse.expires_at))).filter((value) => value > now);
    if (!expiries.length) return;
    const delay = Math.max(1, Math.min(Math.min(...expiries) - now + 10, 2_147_483_647));
    this.pulseTimer = this.window.setTimeout(() => {
      this.pulseTimer = null;
      this.renderTopology();
    }, delay);
  }

  clearPulseTimer() {
    if (this.pulseTimer !== null) this.window.clearTimeout(this.pulseTimer);
    this.pulseTimer = null;
  }

  suppressLegacySurfaces() {
    if (this.legacySurfaceStates.size) return;
    for (const element of this.legacySurfaces) {
      this.legacySurfaceStates.set(element, {
        hidden: element.hidden,
        ariaHidden: element.getAttribute?.("aria-hidden") ?? null
      });
      element.hidden = true;
      element.setAttribute?.("aria-hidden", "true");
    }
  }

  restoreLegacySurfaces() {
    for (const [element, state] of this.legacySurfaceStates) {
      element.hidden = state.hidden;
      if (state.ariaHidden === null) element.removeAttribute?.("aria-hidden");
      else element.setAttribute?.("aria-hidden", state.ariaHidden);
    }
    this.legacySurfaceStates.clear();
  }
}

function graphMarkup(graph) {
  const positions = new Map(graph.nodes.map((node) => [node.component_id, node.position]));
  const edges = graph.edges.map((edge) => {
    const source = positions.get(edge.source_component_id);
    const target = positions.get(edge.target_component_id);
    if (!source || !target) return "";
    const middle = (source.x + target.x) / 2;
    return `<path class="lv3-topology-edge${edge.active ? " is-active" : ""}" data-v3-live-edge="${escapeHtml(edge.edge_id)}" data-edge-status="${escapeHtml(edge.status)}" d="M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const nodes = graph.nodes.map((node) => `<article class="lv3-topology-node${node.impacted ? " is-impacted" : ""}" data-v3-live-node="${escapeHtml(node.component_id)}" data-runtime-status="${escapeHtml(node.runtime_status)}" data-impact-status="${escapeHtml(node.impact_status)}" style="--lv3-x:${node.position.x}%;--lv3-y:${node.position.y}%" role="listitem"><span>${escapeHtml(node.display_name)}</span><strong>${escapeHtml(titleCase(node.runtime_status))}</strong><small>${escapeHtml(titleCase(node.impact_status))}</small></article>`).join("");
  const titleId = `lv3-graph-${safeDomId(graph.case_id)}`;
  return `<section class="lv3-topology-graph" data-v3-live-graph="${escapeHtml(graph.case_id)}" aria-labelledby="${titleId}"><header><div><span>${escapeHtml(graph.severity)} · ${escapeHtml(titleCase(graph.current_stage))}</span><h3 id="${titleId}">${escapeHtml(graph.title)}</h3><small>${escapeHtml(titleCase(graph.freshness.state))} · projection ${graph.projection_revision} · sequence ${graph.sequence}</small></div><button type="button" data-open-live-case="${escapeHtml(graph.case_id)}">Open incident</button></header><div class="lv3-topology-canvas" role="list" aria-label="${escapeHtml(graph.title)} components"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${edges}</svg>${nodes}</div></section>`;
}

function sameValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function connectionCopy(value) {
  return ({ connected: "Realtime incidents connected", connecting: "Connecting to V3 incidents", reconnecting: "Reconnecting to V3 incidents", stale: "Incident list is stale", degraded: "V3 incidents unavailable" })[value] || "V3 incidents unavailable";
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/(^|_)([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function safeDomId(value) {
  return String(value || "graph").replace(/[^A-Za-z0-9_-]/g, "-");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

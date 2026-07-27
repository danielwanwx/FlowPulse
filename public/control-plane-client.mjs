import {
  ControlPlaneContractError,
  parseActionInvocationCommand,
  parseIncidentEvent,
  parseIncidentNotification,
  parseIncidentProjection,
  parseIncidentSummaries,
  parseNextBestActions,
  parseNodeExplanationReceipt,
  parseWorkspaceActionReceipt
} from "./control-plane-contract.mjs";

export const CONTROL_PLANE_API_VERSION = "v1";
const ROOT = `/api/control-plane/${CONTROL_PLANE_API_VERSION}`;

export class ControlPlaneClientError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "ControlPlaneClientError";
    this.code = code;
    this.status = status;
  }
}

// Same-origin browser client. It never receives a bearer and has no route for
// intake, direct tools, actions, gate changes, or generated fallback state.
export class ControlPlaneClient {
  constructor({ fetch: fetchImpl = globalThis.fetch, EventSource: EventSourceImpl = globalThis.EventSource } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
    this.fetch = fetchImpl;
    this.EventSource = EventSourceImpl;
  }

  activeIncidents() {
    return this.json(`${ROOT}/incidents?state=active&limit=20`, {}, parseIncidentSummaries);
  }

  async projection(caseId, expectedIdentity = null) {
    assertPathId(caseId);
    const projection = await this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/projection`, {}, parseIncidentProjection);
    if (expectedIdentity && !matchesSummarySnapshot(expectedIdentity, projection)) throw new ControlPlaneClientError("control_plane_identity_mismatch");
    return projection;
  }

  actions(caseId) {
    assertPathId(caseId);
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/actions`, {}, parseNextBestActions);
  }

  async invokeAction(caseId, actionId, command) {
    assertPathId(caseId);
    assertPathId(actionId);
    let parsed;
    try {
      parsed = parseActionInvocationCommand(command);
    } catch (error) {
      if (error instanceof ControlPlaneContractError) throw new ControlPlaneClientError("control_plane_schema_invalid");
      throw error;
    }
    if (parsed.action_id !== actionId) throw new ControlPlaneClientError("control_plane_identity_mismatch");
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(parsed)
    }, parseWorkspaceActionReceipt);
  }

  async startNodeExplanation(caseId, command) {
    assertPathId(caseId);
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/node-explanations`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(command)
    }, parseNodeExplanationReceipt);
  }

  async nodeExplanationReceipt(caseId, explanationId) {
    assertPathId(caseId);
    assertPathId(explanationId);
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/node-explanations/${encodeURIComponent(explanationId)}`, {}, parseNodeExplanationReceipt);
  }

  subscribeGlobal({ after = null, onNotification, onConnection }) {
    return this.subscribe({
      path: `${ROOT}/incidents/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      eventName: "incident-notification",
      parse: parseIncidentNotification,
      onEvent: onNotification,
      onConnection
    });
  }

  subscribeCase({ caseId, after = 0, onEvent, onConnection }) {
    assertPathId(caseId);
    if (!Number.isSafeInteger(after) || after < 0) throw new ControlPlaneClientError("control_plane_cursor_invalid");
    return this.subscribe({
      path: `${ROOT}/incidents/${encodeURIComponent(caseId)}/events?after=${after}`,
      eventName: "incident-event",
      parse: parseIncidentEvent,
      onEvent,
      onConnection
    });
  }

  async json(path, options, parse) {
    let response;
    try {
      response = await this.fetch.call(globalThis, path, { headers: { accept: "application/json", ...(options.headers || {}) }, ...options });
    } catch {
      throw new ControlPlaneClientError("control_plane_unavailable");
    }
    if (!response?.ok) throw await responseError(response);
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) throw new ControlPlaneClientError("control_plane_schema_invalid", response.status);
    try {
      return parse(await response.json());
    } catch (error) {
      if (error instanceof ControlPlaneClientError) throw error;
      if (error instanceof ControlPlaneContractError || error instanceof SyntaxError) throw new ControlPlaneClientError("control_plane_schema_invalid", response.status);
      throw error;
    }
  }

  subscribe({ path, eventName, parse, onEvent, onConnection }) {
    if (typeof this.EventSource !== "function") throw new ControlPlaneClientError("control_plane_stream_unavailable");
    const source = new this.EventSource(path);
    let lastEventId = null;
    const emitConnection = (state) => { if (typeof onConnection === "function") onConnection(state, lastEventId); };
    source.addEventListener(eventName, (event) => {
      try {
        const parsed = parse(JSON.parse(event.data));
        if (event.lastEventId) lastEventId = event.lastEventId;
        emitConnection("connected");
        if (typeof onEvent === "function") onEvent(parsed, lastEventId);
      } catch {
        emitConnection("degraded");
        source.close();
      }
    });
    source.onopen = () => emitConnection("connected");
    source.onerror = () => emitConnection("stale");
    return { close: () => source.close(), lastEventId: () => lastEventId };
  }
}

async function responseError(response) {
  const status = Number.isInteger(response?.status) ? response.status : null;
  let code = status === 401 || status === 403 ? "control_plane_auth_failed" : status === 404 ? "control_plane_not_found" : status >= 500 ? "control_plane_unavailable" : "control_plane_request_rejected";
  try {
    const value = await response.json();
    if (value && typeof value.error === "string" && /^control_plane_[a-z_]+$/.test(value.error)) code = value.error;
  } catch { /* BFF redacts body; status is enough */ }
  return new ControlPlaneClientError(code, status);
}

function assertPathId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new ControlPlaneClientError("control_plane_path_invalid");
}

function matchesSummarySnapshot(summary, projection) {
  return ["case_id", "incident_id", "run_id", "topology_revision"].every((key) => summary[key] === projection[key])
    && projection.projection_revision >= summary.projection_revision
    && projection.sequence >= summary.sequence;
}

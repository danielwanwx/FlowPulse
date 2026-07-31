import {
  ControlPlaneV3ContractError,
  parseIncidentEventV3,
  parseIncidentProjectionV3,
  parseLiveEventV3,
  parseLiveSnapshotV3,
  parseMetricSeriesCollectionV3,
  parseWorkflowCommandReceiptV3
} from "./control-plane-v3-contract.mjs";
import { INCIDENT_STAGES_V3 } from "./incident-v3-types.mjs";

const ROOT = "/api/control-plane/v3";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export class ControlPlaneV3ClientError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "ControlPlaneV3ClientError";
    this.code = code;
    this.status = status;
  }
}

export class ControlPlaneV3Client {
  constructor({ fetch: fetchImpl = globalThis.fetch, EventSource: EventSourceImpl = globalThis.EventSource } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
    this.fetch = fetchImpl;
    this.EventSource = EventSourceImpl;
  }

  liveSnapshot() {
    return this.json(`${ROOT}/live/snapshot`, {}, parseLiveSnapshotV3);
  }

  projection(caseId) {
    pathId(caseId);
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/projection`, {}, parseIncidentProjectionV3);
  }

  series(caseId) {
    pathId(caseId);
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}/series`, {}, (value) => parseMetricSeriesCollectionV3(value, caseId));
  }

  advance(caseId, command) {
    return this.command(caseId, "/workflow/advance", command, baseCommand);
  }

  rerun(caseId, stage, command) {
    pathId(caseId);
    if (!INCIDENT_STAGES_V3.includes(stage)) throw new ControlPlaneV3ClientError("control_plane_path_invalid");
    return this.command(caseId, `/workflow/stages/${encodeURIComponent(stage)}/rerun`, command, reasonCommand);
  }

  escalate(caseId, command) {
    return this.command(caseId, "/workflow/escalations", command, reasonCommand);
  }

  startAgentRun(caseId, command) {
    return this.command(caseId, "/agent-runs", command, agentCommand);
  }

  approveAction(caseId, actionId, command) {
    pathId(actionId);
    return this.command(caseId, `/actions/${encodeURIComponent(actionId)}/approval`, command, approvalCommand);
  }

  rejectAction(caseId, actionId, command) {
    pathId(actionId);
    return this.command(caseId, `/actions/${encodeURIComponent(actionId)}/approval`, command, approvalCommand);
  }

  command(caseId, suffix, command, validate = baseCommand) {
    pathId(caseId);
    if (!validate(command)) throw new ControlPlaneV3ClientError("control_plane_schema_invalid");
    return this.json(`${ROOT}/incidents/${encodeURIComponent(caseId)}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command)
    }, (value) => parseWorkflowCommandReceiptV3(value, { caseId, attemptId: command.attempt_id }));
  }

  subscribeLive({ after = null, onEvent, onConnection }) {
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new ControlPlaneV3ClientError("control_plane_cursor_invalid");
    return this.subscribe({
      path: `${ROOT}/live/events${after !== null ? `?after=${after}` : ""}`,
      eventName: "live-event-v3",
      parse: parseLiveEventV3,
      onEvent,
      onConnection
    });
  }

  subscribeCase({ caseId, after = 0, onEvent, onConnection }) {
    pathId(caseId);
    if (!Number.isSafeInteger(after) || after < 0) throw new ControlPlaneV3ClientError("control_plane_cursor_invalid");
    return this.subscribe({
      path: `${ROOT}/incidents/${encodeURIComponent(caseId)}/events?after=${after}`,
      eventName: "incident-event-v3",
      parse: (value) => parseIncidentEventV3(value, caseId),
      onEvent,
      onConnection
    });
  }

  async json(path, options, parse) {
    let response;
    try {
      response = await this.fetch.call(globalThis, path, { headers: { accept: "application/json", ...(options.headers || {}) }, ...options });
    } catch {
      throw new ControlPlaneV3ClientError("control_plane_unavailable");
    }
    if (!response?.ok) throw await responseError(response);
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) throw new ControlPlaneV3ClientError("control_plane_schema_invalid", response.status);
    try {
      return parse(await response.json());
    } catch (error) {
      if (error instanceof ControlPlaneV3ClientError) throw error;
      if (error instanceof ControlPlaneV3ContractError || error instanceof SyntaxError) throw new ControlPlaneV3ClientError("control_plane_schema_invalid", response.status);
      throw error;
    }
  }

  subscribe({ path, eventName, parse, onEvent, onConnection }) {
    if (typeof this.EventSource !== "function") throw new ControlPlaneV3ClientError("control_plane_stream_unavailable");
    const source = new this.EventSource(path);
    let lastEventId = null;
    const connection = (state) => { if (typeof onConnection === "function") onConnection(state, lastEventId); };
    source.addEventListener("stream-reset-v3", () => {
      connection("stale");
      source.close();
    });
    source.addEventListener(eventName, (event) => {
      try {
        const value = parse(JSON.parse(event.data));
        if (event.lastEventId) lastEventId = event.lastEventId;
        connection("connected");
        if (typeof onEvent === "function") onEvent(value, lastEventId);
      } catch {
        connection("stale");
        source.close();
      }
    });
    source.onopen = () => connection("connected");
    source.onerror = () => connection("reconnecting");
    return { close: () => source.close(), lastEventId: () => lastEventId };
  }
}

async function responseError(response) {
  const status = Number.isInteger(response?.status) ? response.status : null;
  let code = status === 401 || status === 403 ? "control_plane_auth_failed"
    : status === 404 ? "control_plane_not_found"
      : status === 409 ? "control_plane_conflict"
        : status === 422 ? "control_plane_schema_invalid"
          : status >= 500 ? "control_plane_unavailable"
            : "control_plane_request_rejected";
  try {
    const body = await response.json();
    if (typeof body?.error === "string" && /^control_plane_[a-z_]+$/.test(body.error)
      && body.error !== "control_plane_request_rejected") code = body.error;
  } catch { /* status remains the public failure boundary */ }
  return new ControlPlaneV3ClientError(code, status);
}

function commandObject(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return ["attempt_id", "expected_stage", "expected_workflow_revision", "idempotency_key"].every((key) => Object.hasOwn(value, key))
    && ID.test(value.attempt_id || "") && INCIDENT_STAGES_V3.includes(value.expected_stage)
    && Number.isSafeInteger(value.expected_workflow_revision) && value.expected_workflow_revision >= 1
    && ID.test(value.idempotency_key || "");
}

function baseCommand(value) {
  return commandObject(value, new Set(["attempt_id", "expected_stage", "expected_workflow_revision", "idempotency_key"]));
}

function reasonCommand(value) {
  return commandObject(value, new Set(["attempt_id", "expected_stage", "expected_workflow_revision", "idempotency_key", "reason"]))
    && typeof value.reason === "string" && Boolean(value.reason.trim()) && value.reason.length <= 500;
}

function agentCommand(value) {
  return commandObject(value, new Set(["attempt_id", "expected_stage", "expected_workflow_revision", "idempotency_key", "component_id", "question"]))
    && (value.component_id === undefined || ID.test(value.component_id))
    && (value.question === undefined || (typeof value.question === "string" && Boolean(value.question.trim()) && value.question.length <= 1000));
}

function approvalCommand(value) {
  return commandObject(value, new Set(["attempt_id", "expected_stage", "expected_workflow_revision", "idempotency_key", "decision", "expected_decision_revision", "reason"]))
    && ["APPROVE", "REJECT"].includes(value.decision)
    && Number.isSafeInteger(value.expected_decision_revision) && value.expected_decision_revision >= 0
    && (value.reason === undefined || (typeof value.reason === "string" && Boolean(value.reason.trim()) && value.reason.length <= 500));
}

function pathId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new ControlPlaneV3ClientError("control_plane_path_invalid");
}

import { ControlPlaneV3Client, ControlPlaneV3ClientError } from "./control-plane-v3-client.mjs";
import {
  applyIncidentEventV3,
  buildWorkflowCommandV3,
  parseIncidentWorkspaceUrlV3,
  renderIncidentWorkbenchV3,
  updateIncidentWorkspaceUrlV3,
  workbenchDurationV3,
  workbenchViewV3
} from "./incident-workspace-v3.mjs";

export class TrailingRefreshV3 {
  constructor() {
    this.running = null;
    this.trailing = false;
  }

  request(operation) {
    if (this.running) {
      this.trailing = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.trailing = false;
        await operation();
      } while (this.trailing);
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

export async function loadCoherentIncidentV3(client, caseId, maxSnapshotReads = 3) {
  let [projection, series] = await Promise.all([
    client.projection(caseId),
    client.series(caseId)
  ]);
  const isCoherent = () => series.signal_revision >= projection.signal_revision;
  for (let attempt = 1; !isCoherent() && attempt < maxSnapshotReads; attempt += 1) {
    [projection, series] = await Promise.all([
      client.projection(caseId),
      client.series(caseId)
    ]);
    if (series.case_id !== projection.case_id) {
      throw new ControlPlaneV3ClientError("control_plane_identity_mismatch");
    }
  }
  if (series.case_id !== projection.case_id) {
    throw new ControlPlaneV3ClientError("control_plane_identity_mismatch");
  }
  if (!isCoherent()) {
    throw new ControlPlaneV3ClientError("control_plane_snapshot_unstable");
  }
  const components = new Set((projection.graph?.nodes || []).map((node) => node.component_id));
  const connectors = new Set((projection.connectors || []).map((connector) => connector.connector_id));
  for (const metric of series.series || []) {
    if (!components.has(metric.component_id)) {
      throw new ControlPlaneV3ClientError("control_plane_metric_component_mismatch");
    }
    if (!connectors.has(metric.source_connector_id)) {
      throw new ControlPlaneV3ClientError("control_plane_metric_connector_mismatch");
    }
  }
  return { projection, series };
}

export class IncidentWorkbenchControllerV3 {
  constructor({
    element,
    appShell,
    client = new ControlPlaneV3Client(),
    window: windowImpl = globalThis.window,
    document: documentImpl = globalThis.document,
    onProjection = null
  }) {
    this.element = element;
    this.appShell = appShell;
    this.client = client;
    this.window = windowImpl;
    this.document = documentImpl;
    this.onProjection = onProjection;
    this.active = false;
    this.caseId = null;
    this.projection = null;
    this.series = null;
    this.connection = "connecting";
    this.error = null;
    this.commandPending = null;
    this.subscription = null;
    this.clockTimer = null;
    this.nextGraphPulseExpiry = null;
    this.eventState = { lastSequence: 0, projectionRevision: 0 };
    this.refreshLoop = new TrailingRefreshV3();
    this.previousFocus = null;
    this.ui = { reviewStage: null, panel: null, componentId: null, commandDialog: null };
    this.onClick = (event) => { void this.handleClick(event); };
    this.onInput = (event) => {
      if (event.target.matches?.("[data-command-reason]") && this.ui.commandDialog) {
        this.ui.commandDialog.draft = event.target.value;
      }
    };
    this.onKeyDown = (event) => this.handleKeyDown(event);
    this.element.addEventListener("click", this.onClick);
    this.element.addEventListener("input", this.onInput);
    this.document.addEventListener("keydown", this.onKeyDown);
  }

  async activate(caseId = null) {
    const restored = parseIncidentWorkspaceUrlV3(new URL(this.window.location.href));
    const targetCaseId = caseId || restored.caseId;
    const caseChanged = !targetCaseId || targetCaseId !== this.caseId;
    this.subscription?.close();
    this.subscription = null;
    if (caseChanged) {
      this.projection = null;
      this.series = null;
      this.eventState = { lastSequence: 0, projectionRevision: 0 };
    }
    this.active = true;
    this.connection = "connecting";
    this.error = null;
    this.commandPending = null;
    this.ui = {
      reviewStage: restored.reviewStage,
      panel: restored.panel,
      componentId: restored.componentId,
      commandDialog: null
    };
    this.caseId = targetCaseId;
    this.element.hidden = false;
    this.appShell.dataset.incidentWorkspace = "v3";
    this.startClock();
    this.render();
    try {
      if (!this.caseId) {
        const live = await this.client.liveSnapshot();
        this.caseId = live.incidents[0]?.case_id || null;
      }
      if (!this.caseId) throw new ControlPlaneV3ClientError("control_plane_not_found", 404);
      await this.refresh();
      this.subscribe();
    } catch (error) {
      this.fail(error);
    }
  }

  deactivate() {
    this.active = false;
    this.subscription?.close();
    this.subscription = null;
    if (this.clockTimer) this.window.clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.releaseModal();
    this.element.hidden = true;
    delete this.appShell.dataset.incidentWorkspace;
  }

  refresh() {
    return this.refreshLoop.request(async () => {
      const caseId = this.caseId;
      const { projection, series } = await loadCoherentIncidentV3(this.client, caseId);
      if (!this.active || caseId !== this.caseId) return;
      this.projection = projection;
      if (!this.series || series.signal_revision >= this.series.signal_revision) this.series = series;
      const view = workbenchViewV3(projection, this.ui);
      this.ui.reviewStage = view.reviewingHistory ? view.visibleStage : null;
      if (this.ui.panel === "graph" && view.visibleStage !== "INVESTIGATE") {
        this.ui.panel = null;
        this.ui.componentId = null;
      }
      this.eventState = { lastSequence: projection.sequence, projectionRevision: projection.projection_revision };
      this.connection = "connected";
      this.error = null;
      this.persistUrl();
      this.render();
      if (typeof this.onProjection === "function") this.onProjection(projection);
    });
  }

  subscribe() {
    this.subscription?.close();
    this.subscription = this.client.subscribeCase({
      caseId: this.caseId,
      after: this.eventState.lastSequence,
      onEvent: (event) => {
        const next = applyIncidentEventV3(this.eventState, event);
        if (next.effect === "rehydrate") {
          this.subscription?.close();
          this.subscription = null;
          this.connection = "stale";
          this.render();
          void this.refresh().then(() => this.subscribe()).catch((error) => this.fail(error));
          return;
        }
        this.eventState = next.state;
        if (next.effect === "refresh") void this.refresh().catch((error) => this.fail(error));
      },
      onConnection: (connection) => {
        if (connection === "stale") {
          this.subscription?.close();
          this.subscription = null;
          this.connection = "stale";
          this.render();
          void this.refresh().then(() => this.subscribe()).catch((error) => this.fail(error));
          return;
        }
        this.connection = connection;
        this.render();
      }
    });
  }

  async handleClick(event) {
    if (!this.active) return;
    const retry = event.target.closest("[data-workbench-retry]");
    if (retry) return this.activate(this.caseId);
    const stage = event.target.closest("[data-stage]");
    if (stage && !stage.disabled) {
      this.ui.reviewStage = stage.dataset.stage === this.projection.current_attempt.current_stage ? null : stage.dataset.stage;
      this.ui.panel = null;
      this.persistUrl();
      this.render();
      this.element.querySelector("#incident-stage-surface")?.focus();
      return;
    }
    const open = event.target.closest("[data-open-panel]");
    if (open) {
      this.previousFocus = `[data-open-panel="${cssEscape(open.dataset.openPanel)}"]`;
      this.ui.panel = open.dataset.openPanel;
      this.persistUrl();
      this.render();
      this.focusModal();
      return;
    }
    if (event.target.closest("[data-panel-close], [data-graph-close]")) return this.closePanel();
    const graphNode = event.target.closest("[data-graph-node]");
    if (graphNode) {
      this.ui.componentId = graphNode.dataset.graphNode;
      this.persistUrl();
      this.render();
      this.element.querySelector(`[data-graph-node="${cssEscape(this.ui.componentId)}"]`)?.focus();
      return;
    }
    const investigate = event.target.closest("[data-agent-investigate]");
    if (investigate) {
      if (this.ui.reviewStage) return;
      const base = this.command("START_AGENT_RUN", `agent:${this.projection.current_attempt.attempt_id}:${this.projection.workflow_revision}:${investigate.dataset.agentInvestigate}`);
      await this.execute(() => this.client.startAgentRun(this.caseId, { ...base, component_id: investigate.dataset.agentInvestigate, question: "Investigate this component" }), "START_AGENT_RUN");
      return;
    }
    const action = event.target.closest("[data-action-decision]");
    if (action) {
      const decision = action.dataset.actionDecision === "APPROVE_ACTION" ? "APPROVE" : "REJECT";
      const base = this.command(action.dataset.actionDecision, `${decision.toLowerCase()}:${this.projection.current_attempt.attempt_id}:${this.projection.decision_revision}:${action.dataset.actionId}`);
      await this.execute(() => this.client.approveAction(this.caseId, action.dataset.actionId, { ...base, decision, expected_decision_revision: this.projection.decision_revision }), action.dataset.actionDecision);
      return;
    }
    const workflow = event.target.closest("[data-workflow-command]");
    if (workflow && !workflow.disabled) {
      const command = workflow.dataset.workflowCommand;
      if (["ESCALATE", "RERUN_FROM_STAGE"].includes(command)) {
        this.previousFocus = `[data-workflow-command="${cssEscape(command)}"]`;
        this.ui.commandDialog = {
          command,
          stage: workflow.dataset.rerunStage || this.ui.reviewStage || this.projection.current_attempt.current_stage,
          draft: ""
        };
        this.render();
        this.focusModal();
      } else await this.runWorkflowCommand(command);
      return;
    }
    if (event.target.closest("[data-command-cancel]")) {
      this.ui.commandDialog = null;
      this.render();
      this.restoreFocus();
      return;
    }
    const confirm = event.target.closest("[data-command-confirm]");
    if (confirm) {
      const reason = this.element.querySelector("[data-command-reason]")?.value?.trim();
      if (!reason) {
        this.element.querySelector("[data-command-reason]")?.focus();
        return;
      }
      const dialog = this.ui.commandDialog;
      this.ui.commandDialog = null;
      await this.runWorkflowCommand(dialog.command, { stage: dialog.stage, reason });
    }
  }

  async runWorkflowCommand(command, { stage = null, reason = null } = {}) {
    const attempt = this.projection.current_attempt;
    const idempotency = `${command.toLowerCase()}:${attempt.attempt_id}:${attempt.workflow_revision}:${stage || attempt.current_stage}`;
    if (command === "NEXT" || command === "COMPLETE_INCIDENT") {
      const body = this.command(command, idempotency);
      return this.execute(() => this.client.advance(this.caseId, body), command);
    }
    if (command === "RETRY") {
      const body = buildWorkflowCommandV3(this.projection, "RERUN_FROM_STAGE", { stage: attempt.current_stage, reason: "Retry current stage", idempotencyKey: idempotency });
      return this.execute(() => this.client.rerun(this.caseId, attempt.current_stage, body), command);
    }
    if (command === "RERUN_FROM_STAGE") {
      const body = buildWorkflowCommandV3(this.projection, command, { stage, reason, idempotencyKey: idempotency });
      return this.execute(() => this.client.rerun(this.caseId, stage, body), command);
    }
    if (command === "ESCALATE") {
      const body = buildWorkflowCommandV3(this.projection, command, { reason, idempotencyKey: idempotency });
      return this.execute(() => this.client.escalate(this.caseId, body), command);
    }
  }

  command(command, idempotencyKey) {
    return buildWorkflowCommandV3(this.projection, command, { idempotencyKey });
  }

  async execute(operation, name) {
    if (this.commandPending) return;
    this.commandPending = name;
    this.error = null;
    this.render();
    try {
      const receipt = await operation();
      this.projection = receipt.projection;
      this.eventState = { lastSequence: receipt.projection.sequence, projectionRevision: receipt.projection.projection_revision };
      this.connection = "connected";
      this.error = null;
      this.ui.reviewStage = null;
      await this.refresh();
    } catch (error) {
      if (error instanceof ControlPlaneV3ClientError
        && error.code === "control_plane_revalidation_required") {
        try {
          await this.refresh();
          this.error = error.code;
          this.connection = "degraded";
        } catch (refreshError) {
          this.fail(refreshError);
        }
      } else {
        this.fail(error);
      }
    } finally {
      this.commandPending = null;
      this.render();
    }
  }

  handleKeyDown(event) {
    if (!this.active) return;
    const modal = this.element.querySelector("[data-workbench-modal]");
    if (!modal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.ui.commandDialog) {
        this.ui.commandDialog = null;
        this.render();
        this.restoreFocus();
      } else this.closePanel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && this.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closePanel() {
    this.ui.panel = null;
    this.ui.componentId = null;
    this.persistUrl();
    this.render();
    this.restoreFocus();
  }

  focusModal() {
    this.applyModalInert();
    const modal = this.element.querySelector("[data-workbench-modal]");
    if (!modal) return;
    modal.querySelector("textarea, button:not([disabled]), [tabindex]")?.focus();
  }

  applyModalInert() {
    const modal = this.element.querySelector("[data-workbench-modal]");
    if (!modal) return;
    for (const child of modal.parentElement?.children || []) {
      if (child !== modal) child.setAttribute("inert", "");
    }
  }

  releaseModal() {
    for (const element of this.element.querySelectorAll("[inert]")) element.removeAttribute("inert");
  }

  restoreFocus() {
    if (this.previousFocus) this.element.querySelector(this.previousFocus)?.focus();
    this.previousFocus = null;
  }

  startClock() {
    if (this.clockTimer) return;
    this.clockTimer = this.window.setInterval(() => {
      if (!this.active || !this.projection) return;
      const duration = workbenchDurationV3(this.projection);
      const output = this.element.querySelector("[data-incident-duration]");
      if (output) output.textContent = formatDuration(duration.elapsed_seconds);
      const verification = this.element.querySelector("[data-verification-remaining][data-deadline]");
      if (verification) {
        const deadline = Date.parse(verification.dataset.deadline || "");
        if (Number.isFinite(deadline)) {
          verification.textContent = formatDuration(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        }
      }
      if (this.element.querySelector(".iw3-shell")?.dataset.freshness !== String(duration.freshness).toLowerCase()) this.render();
      if (this.nextGraphPulseExpiry !== null && Date.now() >= this.nextGraphPulseExpiry) this.render();
    }, 1000);
  }

  persistUrl() {
    if (!this.caseId) return;
    const url = updateIncidentWorkspaceUrlV3(new URL(this.window.location.href), {
      caseId: this.caseId,
      reviewStage: this.ui.reviewStage,
      panel: this.ui.panel,
      componentId: this.ui.componentId
    });
    this.window.history.replaceState(null, "", url);
  }

  render() {
    if (!this.active) return;
    const focus = captureFocus(this.element, this.document.activeElement);
    this.releaseModal();
    this.element.innerHTML = `<div class="iw3-controller-root">${renderIncidentWorkbenchV3(this.projection, {
      ...this.ui,
      series: this.series,
      now: Date.now(),
      connection: this.connection,
      error: this.error,
      commandPending: this.commandPending
    })}${commandDialogMarkup(this.ui.commandDialog)}</div>`;
    for (const node of this.element.querySelectorAll("[data-graph-x][data-graph-y]")) {
      node.style.left = `${node.dataset.graphX}%`;
      node.style.top = `${node.dataset.graphY}%`;
    }
    if (this.ui.panel || this.ui.commandDialog) this.applyModalInert();
    restoreCapturedFocus(this.element, focus);
    const now = Date.now();
    const futurePulseExpiries = this.ui.panel === "graph"
      ? (this.projection?.graph?.active_pulses || [])
        .map((pulse) => Date.parse(pulse.expires_at || ""))
        .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now)
      : [];
    this.nextGraphPulseExpiry = futurePulseExpiries.length
      ? Math.min(...futurePulseExpiries)
      : null;
  }

  fail(error) {
    this.error = error instanceof ControlPlaneV3ClientError ? error.code : "control_plane_unavailable";
    this.connection = "degraded";
    this.render();
  }
}

function commandDialogMarkup(dialog) {
  if (!dialog) return "";
  const rerun = dialog.command === "RERUN_FROM_STAGE";
  return `<section class="iw3-confirm-layer" role="dialog" aria-modal="true" aria-labelledby="iw3-confirm-title" data-workbench-modal tabindex="-1"><div class="iw3-confirm-dialog"><span>${rerun ? "Rerun workflow" : "Escalate incident"}</span><h3 id="iw3-confirm-title">${rerun ? `Rerun from ${escapeHtml(titleCase(dialog.stage))}` : "Escalate to a human"}</h3><p>${rerun ? "Downstream stage runs will be superseded or a child attempt will be created after execution." : "Record why the workflow cannot continue automatically."}</p><label>Reason<textarea data-command-reason maxlength="500" required>${escapeHtml(dialog.draft || "")}</textarea></label><div><button type="button" data-command-cancel>Cancel</button><button type="button" class="is-primary" data-command-confirm>Confirm</button></div></div></section>`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/(^|_)([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function captureFocus(root, activeElement) {
  if (!activeElement || (typeof root.contains === "function" && !root.contains(activeElement))) return null;
  const attributes = [
    "data-command-reason", "data-command-confirm", "data-command-cancel",
    "data-panel-close", "data-graph-close", "data-graph-node", "data-stage",
    "data-workflow-command", "data-action-decision", "data-agent-investigate"
  ];
  let selector = activeElement.id ? `#${cssEscape(activeElement.id)}` : null;
  if (!selector && typeof activeElement.hasAttribute === "function") {
    for (const attribute of attributes) {
      if (!activeElement.hasAttribute(attribute)) continue;
      const value = activeElement.getAttribute(attribute);
      selector = value ? `[${attribute}="${cssEscape(value)}"]` : `[${attribute}]`;
      break;
    }
  }
  if (!selector) return null;
  return {
    selector,
    selectionStart: Number.isInteger(activeElement.selectionStart) ? activeElement.selectionStart : null,
    selectionEnd: Number.isInteger(activeElement.selectionEnd) ? activeElement.selectionEnd : null
  };
}

function restoreCapturedFocus(root, captured) {
  if (!captured) return;
  const target = root.querySelector(captured.selector);
  if (!target) return;
  target.focus?.();
  if (captured.selectionStart !== null && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(captured.selectionStart, captured.selectionEnd);
  }
}

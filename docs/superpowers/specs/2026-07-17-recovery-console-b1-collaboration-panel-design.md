# Recovery Console B1 Agent Collaboration Panel

**Date:** 2026-07-17  
**Status:** Proposed for user review  
**Scope:** Recovery Console information architecture and interaction only; existing runtime, incident ledger, agent harness, permissions, and owner gate remain authoritative.

## Goal

Turn Recovery Console into a focused human-and-agent collaboration workspace. The incident graph remains visible while selecting one of six understandable collaborators opens a dedicated right-side panel for that role's responsibility, latest evidence-grounded finding, bounded quick tasks, and continued conversation.

## Approved Product Decisions

- Use the B agent model: six visible conversational collaborators.
- Use the B1 layout: persistent graph on the left and a dedicated selected-agent collaboration panel on the right.
- Preserve specialist isolation in the backend. The six visible collaborators are a product projection over the existing role manifests, permissions, activity, and ledger events; they do not merge authority.
- Keep owner approval outside agent authority. Chat can prepare or request a decision, but it cannot approve or execute consequential remediation.
- Keep the append-only incident ledger as runtime authority. Langfuse remains observability for traces, latency, cost, and scores.

## Collaborator Model

| Visible collaborator | Existing backend projection | User-facing responsibility |
| --- | --- | --- |
| Commander | `manager` | Coordinates the incident, summarizes team state, routes bounded tasks, and identifies the next human decision. |
| Observer | `monitor` + `evidence` | Watches runtime telemetry and assembles cited traces, logs, metrics, deploys, and evidence gaps. |
| Investigator | `diagnosis` | Produces and revises causal hypotheses from the evidence ledger. |
| Critic | `evaluator` / `adversarial_evaluator` | Challenges unsupported claims, exposes counter-evidence, and records evaluation scores. |
| Recovery Engineer | `planner` + `executor` | Drafts bounded repair plans and, only after approval, reports execution progress. |
| Verifier | `verification` | Validates recovery and surfaces regression, offline backtest, and learning outcomes. |

Planner and Executor remain separately permissioned internally even though they share one visible Recovery Engineer surface. Evolve and Test remain isolated post-verification collaborators and appear as internal steps and records inside Verifier, not as conversational nodes. Owner is a human gate, not an Agent. Evidence Ledger and Langfuse appear on an infrastructure rail, not in the conversational team.

## Information Architecture

Recovery Console uses three restrained regions:

1. **Diagnosis band:** a compact incident summary with severity, current grounded diagnosis, confidence/evaluator state, and owner-gate state.
2. **Collaboration graph (65–70%):** six visible collaborators arranged in a stable handoff path. Only meaningful active or completed handoffs are connected; the graph does not render an all-to-all network.
3. **Agent collaboration panel (30–35%):** persistent detail and conversation for the selected collaborator.

Ledger and Langfuse sit on a thin infrastructure rail under the graph with clear labels such as “Authority” and “Observability.” They remain inspectable but visually subordinate to the team workflow.

## Graph and Visual Grammar

- Default selection is Commander.
- Each collaborator has a distinct, unboxed Phosphor icon, role name, one-line responsibility, status word, and status dot.
- Selected state uses a crisp outline, subtle elevation, and `aria-pressed`; it does not recolor the entire card.
- Status is never communicated by color alone. Text distinguishes Standby, Working, Needs review, Waiting for owner, Verified, and Blocked.
- Connections show the current handoff sequence, with one restrained pulse moving from source to destination. The receiving node lifts briefly after the pulse arrives.
- Infrastructure links use a different dashed treatment and never compete with the collaborator handoff path.
- Light and black themes retain the same geometry. Dark-theme borders and connectors use high-contrast white rather than low-contrast gray.
- `prefers-reduced-motion` removes travel animation while preserving static active-path and status cues.

## B1 Interaction Model

Selecting a collaborator updates the right panel without hiding, replacing, or relaying out the graph. The panel contains:

1. Role identity, live status, and responsibility.
2. Latest evidence-grounded finding with evidence IDs or citations when available.
3. Role-specific quick tasks.
4. Recent activity, proposals, work items, and pending human gate relevant to the selected role.
5. A continuing conversation thread and input addressed to that collaborator.

Selection is local UI state and does not append a ledger event. A quick task either prefills the input or submits an explicitly scoped request through the existing agent-control boundary. The Manager routes that request to the mapped backend specialist while preserving that specialist's permissions and evidence requirements.

## Quick Task Catalog

| Collaborator | Bounded quick tasks |
| --- | --- |
| Commander | Summarize incident; recommend next safe step; explain the pending owner decision. |
| Observer | Show first failing trace; compare deployment evidence; show related log clusters. |
| Investigator | Explain root cause; show counter-evidence; request missing evidence. |
| Critic | Explain rejected hypothesis; challenge current diagnosis; explain evaluation score. |
| Recovery Engineer | Draft bounded repair; prepare PR review draft; prepare owner approval request. |
| Verifier | Show recovery checks; inspect regression record; summarize offline backtest. |

Quick tasks never imply an external side effect. PR, Jira, and similar actions are labeled “Draft only” unless an honestly configured connector exists. The first implementation does not add or configure an external connector.

## Data Mapping and Authority

The frontend derives a deterministic collaborator projection from the current `/api/agent-control` response:

- role manifests and graph state determine collaborator availability and status;
- activity and report records determine latest findings and handoffs;
- actions determine quick-task availability;
- work items determine drafts, reviews, and pending decisions;
- ledger references determine citations and provenance;
- Langfuse configuration determines only the observability rail state.

If multiple backend specialists map to one visible collaborator, the panel labels the active internal specialist when useful, for example “Recovery Engineer · Planner.” No backend role, permission, event, or evidence record is discarded by the projection; full details remain reachable from the panel or evidence drawer.

## State, Error, and Empty Behavior

- Missing or stale control-plane data shows the affected collaborator as Standby or Evidence unavailable; it never invents activity.
- Unknown collaborator IDs fall back to Commander without losing the current incident.
- Conversation failure appears inline and preserves the user's draft for retry.
- Missing citations show an explicit Insufficient evidence state.
- Unconfigured Langfuse shows Not configured on the observability rail.
- Unconfigured PR/Jira integration leaves the generated item as a local draft with no external-action language.
- Owner-gated actions remain disabled until the existing approval event is present.

## Responsive Behavior

- At 1440×900 and 1280×800, graph and panel remain side by side with readable text and no node overlap.
- Below 900px, the panel stacks below the graph as an inline region rather than a modal; selecting a node moves focus to its panel heading.
- Graph identity and selection persist across viewport changes and theme changes.

## Accessibility

- Each graph node is a keyboard-reachable button whose accessible name includes role and status.
- Arrow-key or tab navigation reaches all six collaborators in workflow order.
- Selected state uses `aria-pressed`; panel identity is announced through a labeled heading/live region without announcing every animation frame.
- Quick tasks are real buttons with explicit scoped labels.
- Contrast meets WCAG AA in both themes, and status includes text or shape in addition to color.
- Reduced-motion users receive no traveling pulse or node-lift animation.

## Acceptance Tests

- Recovery Console renders exactly six visible conversational collaborator nodes.
- Visible-to-backend role mapping is deterministic and retains existing specialist permissions.
- Owner, Evidence Ledger, and Langfuse do not appear as conversational Agents.
- Clicking each node keeps the graph visible and updates responsibility, latest finding, quick tasks, activity, and chat target in the right panel.
- Quick tasks are scoped to the selected collaborator and do not silently trigger external actions.
- Chat cannot approve or execute owner-gated remediation.
- Existing wrong-Kafka-rejection → evidence replan → checkout/payment root cause → owner rollback gate → recovery verification → regression/evolve story remains intact.
- Existing runtime, ledger, and agent-harness tests remain green; focused deterministic projection and selection tests are added.
- Browser QA passes at 1440×900 and 1280×800 in light and dark themes with zero console errors or warnings.
- Keyboard selection, focus management, contrast, and reduced-motion behavior are verified.

## Non-goals

- No agent framework or backend authority rewrite.
- No new agent permissions or removal of specialist isolation.
- No direct production deploy, PR merge, or Jira creation.
- No new telemetry or LLM vendor integration.
- No replacement of the evidence drawer or immutable ledger details.
- No autonomous bypass of owner approval.

## Human Gates and Stop Conditions

Implementation may proceed after this specification is reviewed. During implementation, stop only if the design requires new backend authority, external credentials, an irreversible external action, or conflicts with ledger truth. Consequential remediation continues to require the existing owner approval gate. Success requires the acceptance tests, representative browser screenshots, a running latest server on port 4310, a committed implementation, and a clean worktree.

## Self-review

This design keeps the graph visible as required by B1, reduces the visible team to the approved six collaborators, and preserves all existing backend role isolation through an explicit projection table. It separates human approval, runtime authority, and observability from conversational Agents. It also defines honest behavior for unavailable evidence and unconfigured external integrations, so the collaboration experience cannot overstate what the current system executed.

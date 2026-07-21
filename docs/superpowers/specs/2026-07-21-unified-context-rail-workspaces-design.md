# Unified Context Rail across operating workspaces

## Purpose

FlowPulse has one contextual interaction surface: the right-side **Unified
Context Rail**. It replaces the previous mode-local Control Plane, Commander,
and Compare review columns without deleting their server-projected facts. The
rail is a projection of the current workspace, selected canonical runtime
component, and active Agent Team session. It is not a second canvas, a modal,
or an authority surface.

This is F3A only. It establishes the common rail controller and removes
duplicate interaction columns. It does not redraw Diagnose, Recovery Console,
or Compare graphs, change lifecycle policy, or add backend data.

## Invariants

- There is exactly one right-side rail surface in each of Architecture, Live,
  Diagnose, Recovery Console, and Compare.
- The existing F2A Node Live Inspector is the only component inspector for a
  canonical runtime/data node. Its graph stays mounted and its Live pulse loop
  is not restarted by rail transitions.
- The Agent Investigation session is the only conversation surface. It uses
  `/api/agent-control/chat` and its existing conversation/SSE endpoints; the
  Unified Context Rail never calls the legacy manager message endpoint.
- Workspace navigation preserves server-owned run, incident, and conversation
  identity. A selection is retained only when its canonical runtime node is
  present in the destination projection; otherwise it is cleared.
- The browser only renders strict server projections. Missing facts render as
  compact awaiting/unavailable state. It never invents health, evidence,
  activities, repair permissions, or data resources.
- Raw prompts, chain-of-thought, unredacted payloads, secrets, and provider
  payloads never enter the rail.

## Rail controller

The rail is driven by one explicit priority order:

1. A valid selected runtime/data node renders Node Live Inspector.
2. An active Agent Team session renders Agent Investigation.
3. Otherwise the current operating workspace renders its summary.
4. Architecture and healthy Live fall back to the existing full five-role Team
   Home; these are the only surfaces that show the full card set by default.

The controller owns `selected`, `agentTeam`, the F2A Inspector snapshot, and a
`railReturn` context. `railReturn` is either `node` with the Inspector scroll
and disclosure snapshot, or `workspace` with the mode that opened the session.
It prevents Agent Back from incorrectly returning to Team Home when a node was
selected and prevents a direct workspace session from creating a fake node
selection.

### Transition table

| Current surface | User event | Next surface | Preserved state |
| --- | --- | --- | --- |
| Workspace summary | Select canonical runtime node | Node Inspector | Selected node; canvas remains mounted |
| Node Inspector | Ask Agent | Agent Investigation | Node ID, Inspector scroll, disclosures, source truth |
| Agent Investigation from node | Back or Escape | Node Inspector | Exact F2A snapshot |
| Node Inspector | Close or repeat selection | Workspace summary | Clears selection only |
| Workspace summary | Ask role | Agent Investigation | Workspace and run/incident/conversation identity |
| Agent Investigation from workspace | Back or Escape | Workspace summary | Workspace identity and summary facts |
| Any surface | Navigate workspace | Destination summary or valid selected Inspector | Run/incident/conversation; only valid runtime selection |

## Workspace summaries

The summaries use fields already projected by IncidentProjection, agent control,
contextual workspaces, and Compare provenance. A value is omitted when the
current projection does not carry it.

### Diagnose: Diagnosis Summary

- Current hypothesis/root-cause statement when projected.
- Evaluator or diagnosis status.
- Evidence coverage and any explicitly projected evidence gap.
- Latest Agent activity or transparent handoff when available.
- Compact actions: Ask Investigator, Ask Evaluator, and View cited evidence.

The summary does not duplicate Investigator, Evaluator, or Ledger cards in the
incident graph. Those identities live in the rail. A graph node remains only
when it is actual incident evidence rather than a role shortcut.

### Recovery Console: Recovery Status

- Proposed repair, risk, evaluator verdict, human gate, execution state, and
  verification state when each exists in the current read model.
- Compact role switcher actions: Ask Orchestrator and Ask Evaluator. A recovery
  role is not exposed as a new public identity because the current backend
  contract does not map one.

Recovery workflow facts remain in the main canvas. The legacy Commander
conversation column and duplicate Incident Team messaging controls are removed;
their safe facts are summarized here or available in Agent Investigation.

### Compare: Verification Summary

- Recovery verdict, passed checks, remaining risks, regression/backtest result,
  before/after evidence, and evaluator conclusion when projected.
- Ask Evaluator is available only through the existing Agent Team route.
- If the backend does not permit Compare, the rail reports an honest unavailable
  prerequisite state and no action is enabled.

The old FlowPulse Control Plane/Investigator/Evaluator/Ledger card set is not
rendered in Compare. Decision and verification evidence remains in the compare
canvas and collapsed evidence details.

## Node detail and Agent Investigation

For any valid runtime/data node in Diagnose, Recovery, or Compare, the same F2A
Inspector replaces the workspace summary. Component detail is requested only
for canonical IDs represented by the strict current topology view. Derived
nodes, annotations, edges, and control/evidence nodes never forge a component
detail request; they open the existing safe workspace evidence detail instead.

Ask Agent carries `selected_component` only for a canonical runtime/data node.
Agent Investigation maintains the compact F2A header, context, timeline,
collapsed capability/run details, citations, and composer. Evidence Ledger is
read-only. Contextual workspace buttons only navigate to server-gated views;
they cannot approve, execute, or repair.

## Shared visual and geometry rules

- `operations-team-rail` remains the sole rail DOM mount and uses the accepted
  272px/Architecture-derived geometry, frosted material, rounded system surface,
  typography, and compact status language.
- No legacy squared `manager-panel`, `recovery-command`, or
  `compare-review-rail` is visible beside it.
- Removing a duplicate column gives its main canvas area back to the workspace;
  the rail never overlays a second rail or forces a canvas remount.
- Diagnose, Recovery, and Compare may retain their current nodes, timeline, and
  slider. Their visual/data redesign is deferred to F3B/F3C/F3D.
- Focus, Escape, keyboard activation, reduced motion, and reduced transparency
  reuse the existing F2A rail semantics.

## Contract boundary and fail-closed behavior

The implementation consumes the existing strict browser projections:

- `componentDetailProjection` / `nodeLiveInspectorProjection` for node detail.
- `agentTeamConversationProjection`, `agentLoopProjection`, and
  `agentTeamProviderProjection` for Agent Investigation.
- `contextual_workspaces` for navigation availability.
- IncidentProjection/agent-control/compare provenance for workspace summaries.

Unknown schema versions, unexpected keys, malformed contextual actions, or
unsupported selected entities produce an unavailable/awaiting rail state. No
v1-to-future reinterpretation or compatibility fallback is allowed.

## Test and review matrix

Tests cover one rail in all five modes; legacy duplicate DOM absence in Diagnose,
Recovery, and Compare; each workspace summary; canonical-only component
selection; exact Agent Back behavior; Close behavior; navigation selection
clearing; no manager endpoint in the rail path; no canvas remount/pulse restart;
backend-gated actions; keyboard/ARIA/reduced-motion hooks; and F2A regressions.

Browser review at 1440x900 captures Diagnose summary and node Inspector,
Recovery Status, Compare Verification Summary, one workspace-started Agent
session with Back restoration, and 1280x800 layout. Console warnings/errors
must be empty.

## Implementation boundaries and stop gate

F3A likely changes `public/app.js`, `public/styles.css`, `public/index.html`,
and focused frontend tests only. It does not modify the dedicated backend
worktree, IncidentProjection, APIs, authority policy, the main workflow graph,
the Compare slider, or unrelated frontend design.

After one F3A commit and browser evidence, stop for Owner screenshot review.
F3B/F3C/F3D require a separate approval and may not start automatically.

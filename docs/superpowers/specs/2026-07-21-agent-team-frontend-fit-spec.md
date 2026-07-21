# FlowPulse Agent Team — Frontend Fit

## Scope and objective

This stage turns the existing FlowPulse Control System rail into one persistent,
contextual Agent Team surface. It is not a general chat page. The same rail and
conversation state appear in Architecture, Live, Diagnose, Recovery Console,
and Compare, using the current light spatial-glass geometry and material.

This stage is limited to backend-contract integration, the shared Team rail and
session panel, Live Component Inspector handoff, SSE recovery, contextual view
gates, focused styling, tests, and browser verification. It does not redraw the
other workspaces, add identities, add authentication, deploy, or change any
repair/approval policy.

## Canonical backend baseline

The accepted backend source is `codex/backend-agent-team-chat` at
`9a92bc3` (`fix interactive agent loop reliability`) in
`/Users/danielwan/Documents/Codex/2026-07-20/flowpulse-agent-backend`.
It is merged into this branch using a non-destructive integration check first
(`git merge-tree` or equivalent). Frontend visual/interaction changes already
accepted on this branch take precedence in conflicts; the backend API contract
and its tests define the API truth. No mock API or browser-created workflow is
allowed.

The demonstrated backend outcomes are server-owned:

- normal `checkout-payment-config`: `recovered`, Observer → Orchestrator →
  Investigator → Evaluator, three visible handoffs, one repair, one
  verification, and codex-local role attribution;
- `insufficient-evidence`: `needs_human`, zero repair, zero verification.

The browser projects those results only. It never advances a stage with timers
or hard-coded states.

## API contract

The frontend uses only these current contracts for the Agent Team:

- `POST /api/demo/agent-loop/run` with `{ case_id, round, idempotency_key }`;
  a `202` response has a strict schema, `run_id`, `incident_id`, `state`,
  `stage`, `events_url`, and `contextual_workspaces`.
- `GET /api/demo/agent-loop?run_id=...` for run recovery.
- `GET /api/demo/agent-loop/events?run_id=...&after=...` for SSE, including
  heartbeat and terminal events. `Last-Event-ID` and `after` are used to resume
  and processed event identities are de-duplicated.
- `POST /api/agent-control/chat`,
  `GET /api/agent-control/conversation?conversation_id=...`,
  `GET /api/agent-control/events?conversation_id=...&after=...`, and
  `GET /api/agent-control/provider` for role conversation and status.

The rail never calls the legacy `/api/agent-control/message` manager/recovery
endpoint. An incompatible, missing, stale, or extra-field contract is explicit
unavailable state; it never falls back to old compatibility state or mock data.

## Identities and authority

The fixed Team identities are:

| Identity | Default behavior | Authority boundary |
| --- | --- | --- |
| Observer | Conversational observation of safe source, anomaly, and signal facts | No repair or approval authority |
| Orchestrator | Conversational explanation of server workflow and routing | Dispatch explanation only; cannot advance the loop |
| Investigator | Conversational cited root-cause analysis | May investigate; cannot approve or repair |
| Evaluator | Conversational evidence challenge and quality-gate explanation | Cannot act as owner approval |
| Evidence Ledger | Read-only citations, hashes, provenance, and append-only record summary | Never receives a composer or chatbot persona |

The server maps these to its actual implementation capabilities. The browser
never creates activity, health, handoffs, citations, gate results, repair,
verification, or provenance. Selecting a tile does not invoke a model or spend
tokens. Only submitting a message or explicitly running the demo loop calls the
server.

## Persistent rail information model

The right rail has stable dimensions across all five workspace modes. Team Home
shows compact tiles. Selecting one of the four conversational roles changes the
same rail into an Agent Session; Evidence Ledger becomes a read-only evidence
surface. The rail does not move or resize the main canvas.

An Agent Session has:

1. fixed header: role glyph, name, server-projected status, responsibility,
   Back control, and provider state without credentials;
2. context strip: workspace, selected canonical component, run/incident IDs
   when present, and source truth;
3. scrollable timeline: user message, `safe_answer`, citations, count-only tool
   activity, working/streaming state, terminal state, repair/verification
   records, and transparent handoffs as `from → to → reason`;
4. a fixed composer for the four conversational roles, disabled while sending
   and constrained with server idempotency; Ledger has no composer;
5. contextual workspace buttons taken verbatim from the backend's
   `contextual_workspaces` projection.

Expanded content omits absent projected fields. It cannot synthesize a success,
timestamp, incident, source health, gate, log, metric, database, or dependency.

## Context, continuity, and view gates

Conversation/run/incident identity continues through Architecture, Live,
Diagnose, Recovery Console, and Compare. Workspace and selected component are
bounded context, not authority. Refresh restores via GET then SSE after the last
processed event; duplicate event IDs/sequences do not render twice.

Contextual buttons only open an existing workspace and never request a repair,
approval, execution, or verification. Their visibility and disabled state come
from the backend prerequisites:

- diagnosis after an incident/diagnosis projection;
- Recovery Console after an evaluated plan or repair projection;
- Compare only after verified recovery;
- `insufficient-evidence`, failure, or no repair/verification leaves Compare
  unavailable.

## Live inspector integration and demo lifecycle

Live retains the existing stable topology canvas: selecting a node must not
remount it or restart connector/pulse animation. The safe Component Inspector
remains first, showing only server-projected current state, source truth,
metrics, redacted event metadata, traces, changes, exact dependencies, and
provenance. It adds **Ask Observer** / **Agent Team** entry points carrying the
canonical selected component ID. The first close returns to that inspector; the
next close returns to Team Home.

Live exposes a clearly labelled **Simulate Incident** control using only
`checkout-payment-config`. The desired demo is server-driven: healthy →
simulation → Live impact → Ask Observer → visible handoffs → diagnosis →
evaluation → bounded low-risk repair → verification → recovered → Compare
available. Duplicate injection, stage skipping, and any browser-authored fault
truth fail closed in the backend.

## Safety and trust boundary

Only `safe_answer`, strict server projections, citation IDs, references, and
hashes render. Raw prompts, reasoning traces, token material, secrets,
credentials, raw log payloads, unredacted trace bodies, and provider responses
never reach the browser. Provider unavailable, stale, failed, `needs_human`,
and completed are explicit states. Existing server policy and human gates remain
the sole authority for consequential actions.

## Visual and interaction requirements

The rail reuses the accepted Architecture/Live shallow-gray background,
translucent white glass, Apple-like typography, rounded hierarchy, and restrained
status language. It is neither a terminal nor a second chat product. Header,
context, and composer stay stable while the timeline scrolls. Citations, tool
counts, and handoffs use compact expandable disclosure. Red is reserved for
server-projected failure; green for verified/recovered.

All interactions are keyboard accessible. Focus moves logically from a tile to
its session header/composer, Back restores the originating tile, and Escape
closes the current safe detail state. Reduced-motion and reduced-transparency
keep all state and hierarchy without decorative movement or unreadable glass.

## Tests and acceptance

Tests precede implementation and prove:

1. five identities, with no Ledger composer;
2. tile selection performs no chat POST;
3. safe answer, citations, and visible handoff `from → to → reason` render;
4. SSE resume deduplicates events;
5. selected component persists through the rail;
6. Live selection preserves its canvas and animation;
7. insufficient-evidence correctly gates Recovery/Compare, while verified
   recovery enables Compare;
8. unavailable/stale/needs-human/provider-error state is explicit;
9. legacy manager endpoint is unused;
10. malformed schemas fail closed.

Browser verification covers Team Home and a role session in Architecture, Live
Inspector plus Ask Observer, a transparent handoff, and workspace gate states.
The merged single app is exercised against both required demo cases, provider
status, SSE, focused/full tests, audit, and diff check.

## Review gates and non-goals

The work stops after this integrated rail stage for Owner review. It does not
advance into broader Diagnose, Recovery, or Compare redesign. Any conflict that
would change authority, introduce fabricated topology/telemetry, use a paid
provider, add a dependency, or alter backend policy stops for a new owner
decision.

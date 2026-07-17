# FlowPulse Agent Control and Transparent Recovery

Date: 2026-07-17
Status: Approved design

## Goal

Extend FlowPulse with a ledger-governed agent team that keeps one human-facing Manager, isolates specialist authority, exposes the team as a synchronized operations graph, and makes recovery visible in both the agent and runtime views. Improve the Live topology so observed dependencies remain readable at 1280x800 and 1440x900.

## Scope

This change stays inside the existing standalone Node application, append-only incident ledger, current Astronomy Shop runtime adapter, deterministic replay, Agent Team Harness, and Langfuse OpenTelemetry integration.

It does not add Temporal, LangGraph, a second workflow database, a direct dependency on Langfuse's internal ClickHouse schema, unrestricted shell tools, autonomous production promotion, or a second source of runtime truth.

## Product flow

1. Architecture shows the observed system in stable semantic layers. Architecture guides use a distinct structural line style and never resemble dependency edges.
2. Live shows the observed service graph with deterministic dependency lanes. Only one causally ordered pulse is active at a time. Selecting a service focuses its immediate dependency path.
3. Diagnose reconstructs the incident from immutable events. Once a repair proposal is available, the primary action becomes Recover.
4. Recover opens the Manager panel with a cited incident report, accepted root cause, rejected hypotheses, bounded remediation proposal, verification plan, and the next required human decision.
5. The owner explicitly approves or rejects the exact proposal. Natural-language chat cannot bypass this control.
6. Approval starts the deterministic repair flow. Agent Operations and Runtime remain synchronized by the same ledger events and timestamps.
7. Agent Operations shows planning, approval, execution, PR merge, deployment, verification, regression creation, and offline test as attributable agent or system states.
8. Runtime shows the corresponding deployment/change component and affected service state in parallel.
9. Evolve creates only quarantined candidates. Test independently records backtest results. Promotion remains a separate human action.

## Information architecture

The main mode switch becomes:

- Architecture
- Live
- Diagnose
- Agents
- Compare

The existing contextual evidence drawer remains available. The Manager is a separate right-side panel because it is a task and decision surface, not evidence navigation.

## Live layout and routing

Live uses four deterministic ranks derived from service identity and topology:

- Entry and delivery
- Commerce and request processing
- Payment and asynchronous processing
- Platform, telemetry, and data

Nodes retain stable identities across modes. Rank placement uses fixed vertical bands and an ordered horizontal spread. Dependency paths use orthogonal or shallow cubic lane routing, terminate at card boundaries, and avoid card interiors.

Architecture guide lines are neutral structural rules with a dashed pattern and labels at the left edge. Runtime dependencies use solid lines. Control-plane paths use a different dash cadence. Evidence paths remain dotted. Color is not the only differentiator.

In Live, background dependency edges are quiet. The ordered pulse schedule is derived from graph depth plus stable edge ID ordering. One pulse travels at a time. Incident edges become red only when authoritative referenced evidence names both endpoints or when a replay frame explicitly marks the causal path.

## Agent Control Service

The service wraps the existing `AgentTeamHarness`. It exposes commands but does not grant agents direct ledger append access.

Supported commands:

- summarize incident
- detect or triage
- collect evidence
- diagnose
- challenge diagnosis
- prepare repair
- request owner approval
- verify recovery
- create regression candidate
- run offline backtest

Each command resolves to a deterministic action catalog entry with:

- allowed source states
- target role
- required parent events
- required evidence references
- proposal budget
- safe next actions
- optional human gate

The Manager may select and explain a command. The service validates it. Consequential execution remains code-owned and owner-gated.

## Manager panel

The Manager panel opens from Recover and may also be opened from the top-level Agents mode.

It shows:

- concise current situation
- confirmed facts and cited evidence IDs
- rejected hypotheses and evaluator scores
- current specialist activity
- bounded next action
- explicit missing evidence or tool-data failure
- Owner approval control when required
- a chronological activity feed

The input supports bounded natural-language questions. In the credential-free judge path, answers are deterministic projections of ledger state and are labeled as such. With GPT configured, the model may summarize or select an allowed command but cannot expand capabilities.

## Agent Operations graph

Nodes:

- Manager
- Monitor
- Evidence
- Diagnosis
- Adversarial Evaluator
- Remediation Planner
- Verification
- Evolve
- Test
- Repair Executor
- Evidence Ledger
- Langfuse

Edges represent actual command, proposal, verdict, approval, execution, verification, score, and backtest events. State is projected from the ledger and never inferred from animation time. The graph supports live updates and deterministic replay using the same event projector.

Selecting a node reveals its role manifest, allowed tools, current input event IDs, evidence references, output event, model and prompt versions, budget, latency, cost when available, and evaluation scores.

## Runtime and agent synchronization

Every agent/control event carries the same `run_id` and incident scope as runtime events. The following mappings drive both graphs:

| Ledger event | Agent graph | Runtime graph |
| --- | --- | --- |
| `repair.proposed` | Planner complete, Manager waiting | Change prepared |
| `approval.requested` | Owner gate active | Change locked |
| `approval.granted` | Executor ready | Deployment queued |
| `repair.executed` | Executor complete | Deployment active |
| `verification.completed` | Verification complete | Affected services verified |
| `regression.created` | Evolve complete | No runtime mutation |
| `policy.evaluated` | Test complete | No runtime mutation |

The PR merge and deployment labels are projections of an execution receipt. They are never shown as real external events unless the development adapter or captured incident bundle contains that receipt.

## Streaming contract

The server exposes a Server-Sent Events endpoint for ledger-derived state changes. Events include monotonic ledger IDs so a reconnect can resume. Polling remains the fallback. No in-memory event stream becomes authoritative.

## Langfuse

Langfuse remains an asynchronous observability and evaluation sink.

- `sessionId`: incident ID or manager conversation ID
- trace metadata: run ID, ledger event ID, agent ID, agent version, prompt hash, policy version, authority marker
- observations: Manager turn, specialist proposal, tool call, evaluator verdict, approval wait, execution adapter, verification, offline backtest
- scores: groundedness, evidence coverage, causal correctness, action safety, tool-data quality, schema validity, latency, and cost

When Langfuse credentials are absent, the product shows a clear unconfigured state while preserving the local ledger projection. FlowPulse never writes to Langfuse ClickHouse tables and never reads Langfuse availability or scores to advance the incident state machine.

## Self-evolve boundary

Evolve is an offline maker. Test is an independent checker. A candidate must pass the frozen deterministic suite and recorded semantic score thresholds. It remains inactive until owner promotion. Neither role may query production tools or emit `policy.promoted`.

## Errors and stop rules

- Unknown evidence reference: reject command and record validation failure.
- Missing prerequisite event: return the exact required step.
- Unsupported Manager request: explain the allowed action boundary.
- Langfuse unavailable: continue with ledger authority and mark observability degraded.
- SSE disconnect: reconnect from the last ledger event ID.
- Owner rejection or approval expiry: stop remediation without mutation.
- Ambiguous execution receipt: stop and escalate. Do not retry another repair automatically.
- Verification failure: classify repair failure and stop.

## Accessibility

- Every mode, node, edge, Manager action, and approval control has an accessible name.
- Keyboard users can open Recover, traverse the Manager report, approve or reject, switch to Agents, and inspect node detail.
- Graph state never relies on color alone. Line style, icon, text, and node state labels remain present.
- Motion honors `prefers-reduced-motion`; state transitions remain understandable without animation.
- Light and black themes retain WCAG AA contrast.

## Acceptance checks

- Existing runtime and harness tests remain green.
- Live has no card overlap and materially fewer long crossing paths at 1280x800 and 1440x900.
- Architecture guides and runtime dependency lines are distinguishable without color.
- Recover opens a cited Manager report at the owner-gate stage.
- Chat cannot directly execute remediation or promotion.
- Approval advances the exact bounded repair and updates Agent Operations and Runtime from the same events.
- Agent Operations deterministically reconstructs the wrong diagnosis, rejection, replan, accepted root cause, owner gate, repair, verification, regression, and test sequence.
- The unconfigured Langfuse state is honest. Configured traces contain correlation metadata and scores without affecting runtime authority.
- Browser console has zero errors and zero warnings.
- Reduced motion, keyboard traversal, accessible names, and both themes pass browser QA.
- Latest server is left open on port 4310.
- Final implementation is committed and the standalone worktree is clean.

## Records

- This design specification
- Changed-file summary
- Automated test results
- Browser console and accessibility QA
- Representative Architecture, Live, Recover/Manager, Agent Operations, deployment, verification, and Compare screenshots
- Explicit real-versus-captured behavior statement

## Human gates

- Owner approval before remediation
- Owner promotion before policy activation
- Credentials or external deployment require separate authorization
- Any direct integration with GitHub merge, production deployment, or Langfuse infrastructure is outside this implementation unless separately approved


# FlowPulse compact architecture and orchestrated live design

Date: 2026-07-17  
Status: Approved design, awaiting implementation

## Goal

Make Architecture a compact, line-free block-stack view; make Live a spacious, zoomable dependency view whose routes never disappear behind unrelated components; and connect Manager actions to the existing typed Agent Team Harness before any deterministic runtime transition is applied.

## Input scope

Work only in the standalone FlowPulse repository and reuse its current OTLP source, captured Astronomy Shop incident, append-only ledger, runtime, Agent Control Service, Agent Team Harness, Langfuse hooks, UI, and tests.

The ledger remains runtime authority. Langfuse remains asynchronous observability. No new graph framework, workflow database, telemetry vendor, credential, external deployment, or unrestricted agent tool is added.

## Selected product direction

The approved visual direction is **A: compact block pyramid plus wide routed Live canvas**.

### Architecture

Architecture answers only “what is the system made of?” It does not show traffic or causal flow.

- Remove dependency SVGs, pulses, horizontal guides, and edge labels from Architecture.
- Arrange complete component cards as a centered stack with a narrow top and wider lower ranks.
- Use stable ranks: Experience, Commerce, Streaming/Processing, and Workers/Data/Platform.
- Keep the existing semantic icons, full labels, source provenance, selection drawer, light theme, and black theme.
- Use the same node identity as Live so the mode transition remains smooth and deterministic.

### Live

Live answers “what is connected and what is happening now?”

- Render inside a logical world wider than the visible viewport.
- Add native Zoom in, Zoom out, Reset, and pointer-drag pan controls. Supported scale is 60–160 percent with a 10 percent step.
- Keep deterministic ranks and stable node order; never use a random or force-directed layout.
- Route dependencies through reserved horizontal and vertical corridors.
- Attach every route to an explicit source/target card boundary port.
- A route may intersect only its source and target cards. It must not pass behind another card or label.
- Continue using one causally ordered pulse at a time. Zoom and pan transform the pulse and route together.
- Keyboard users can operate all zoom controls, and reduced-motion users retain static state and direction markers.

## Connectivity truth rule

FlowPulse must not silently show an apparently broken island and must not invent a relationship.

1. Normalize OTLP service IDs and dependency edge endpoints through one shared mapping.
2. Drop only edges whose endpoint is absent from the authoritative node set, and expose their count as a topology integrity warning.
3. Classify every displayed component as connected or unlinked.
4. Connected components render their authoritative dependency routes.
5. A genuinely unlinked component is placed in an explicit `Unlinked telemetry` area and labeled `Insufficient dependency evidence` in its card and drawer.

Acceptance requires every displayed Live component to be either connected by an authoritative edge or visibly classified as an evidence gap. There are no unexplained islands.

## Agent orchestration backend

The current Agent Operations graph is already projected from ledger events over SSE, but Manager `advance` currently bypasses `AgentTeamHarness`. The implementation must close that gap.

### Command path

1. Manager receives a bounded action request.
2. Agent Control selects exactly one specialist role for the next state.
3. A recorded specialist adapter produces a versioned typed envelope for the credential-free judge path. A configured model may produce the same envelope shape later.
4. `AgentTeamHarness` validates schema, role permission, incident/run scope, evidence references, prerequisites, idempotency, deadline, and proposal budget.
5. The harness appends the accepted proposal with its content hash and agent attribution.
6. The deterministic coordinator applies at most one runtime step and appends an orchestration completion record linked to the proposal and resulting runtime event.
7. Agent Control projects the updated ledger; the SSE endpoint publishes the new monotonic sequence.
8. Agent Operations and Live/Diagnose update from that same projection.

The recorded adapter is deterministic test/demo input, not a simulated external production worker. Its envelope and resulting runtime events are real ledger records.

### Authority and gates

- Agents propose; the harness validates; deterministic code applies state transitions.
- No specialist receives direct ledger or runtime access.
- The Manager can delegate and explain but cannot approve remediation.
- Evaluator cannot plan or execute repair.
- Evolve cannot run its own backtest.
- Test cannot edit or promote a candidate.
- Owner approval remains a separate explicit endpoint and control.
- A failed validation appends no specialist proposal and advances no runtime state.

### Projection contract

Agent Control exposes, for each active step:

- proposal event ID and content hash;
- role, role manifest, model/fixture version, prompt hash, and remaining budget;
- parent event IDs and evidence references;
- validation status;
- resulting runtime event ID when applied;
- owner-gate state;
- Langfuse observation status.

The frontend does not infer work from animation time. Agent node, edge, Manager feed, and runtime change state come from these ledger fields.

## Langfuse boundary

Manager turns, specialist proposals, validation results, tool observations, evaluator verdicts, owner waits, execution, verification, and offline tests receive correlated Langfuse observations when credentials exist.

Correlation metadata includes incident ID, run ID, proposal event ID, resulting runtime event ID, agent ID/version, prompt hash, and ledger-authority marker. Langfuse availability or scores never advance the state machine.

## Error behavior

- Unknown service edge endpoint: omit the invalid edge, surface an integrity warning, and keep the component visibly unlinked.
- Route collision: fail the geometry test and adjust the deterministic corridor; do not hide the edge.
- Unsupported agent action: return the allowed actions for the current state.
- Invalid typed envelope: reject before append and keep runtime sequence unchanged.
- Duplicate idempotency key with the same hash: return the prior proposal.
- Duplicate key with a different hash: fail closed.
- Owner gate: stop before consequential execution.
- SSE disconnect: reconnect from the last ledger sequence.
- Langfuse unavailable: continue under ledger authority and display `not configured` or `degraded`.

## Checks

### Automated

- Architecture renders no edge map or pulse layer.
- Architecture positions are deterministic and form a narrow-to-wide stack.
- Live scale clamps to 60–160 percent and Reset restores 100 percent and centered pan.
- Pan/zoom does not change graph identity or topology state.
- Every Live route avoids all non-endpoint card rectangles at target viewports.
- Every Live component is connected or explicitly unlinked.
- Manager `advance` creates a harness-validated proposal before a linked runtime completion.
- Invalid role, evidence, budget, prerequisite, and idempotency cases do not advance runtime.
- Existing owner, evaluator, Evolve, Test, runtime, API, and replay tests remain green.

### Visible browser

- Verify Architecture, Live, Diagnose, Agents, and Compare at 1440×900 and 1280×800.
- Verify zoom in/out/reset, drag pan, selection drawer, light/black themes, keyboard focus, accessible names, and reduced motion.
- Verify no card overlap, no route crossing a non-endpoint card, no unexplained isolated component, and one visible ordered pulse.
- Run the complete wrong-Kafka → evaluator rejection → replan → checkout/payment root cause → Owner gate → repair → verification → regression/test path.
- Confirm zero browser errors and warnings.

## Records

- This design specification and implementation commit.
- Focused geometry/connectivity/orchestration tests.
- Architecture, Live overview, Live zoom/pan, Owner gate, Agent Operations, recovery, and Compare screenshots.
- Browser console and viewport QA record.
- Explicit real-versus-captured statement.

## Stop conditions

Success requires all checks to pass, latest code served on port 4310, final product page left open, screenshots recorded, implementation committed, and a clean worktree.

Stop and report only for a material backend redesign beyond this contract, credentials/external authority, or three failed attempts at the same blocking issue.

## Self-review

- No placeholders or unresolved choices remain.
- Architecture has no dependency lines; Live owns connectivity and motion.
- Unlinked components are handled without fabricating telemetry.
- The harness, coordinator, ledger, SSE, and UI responsibilities are explicit and non-conflicting.
- Owner approval, Langfuse authority, real/captured boundaries, target viewports, and acceptance checks are bounded.

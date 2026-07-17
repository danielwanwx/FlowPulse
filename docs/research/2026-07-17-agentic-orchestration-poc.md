# FlowPulse agentic orchestration POC

**Status:** architecture recommendation; no runtime or UI changes
**As of:** 2026-07-17
**Decision:** keep the append-only FlowPulse ledger and code-owned state machine as runtime authority; split model work into isolated specialists behind typed contracts. Adopt an agent framework only after the contracts and failure gates are proven.

## Executive recommendation

FlowPulse should become a **ledger-governed agent team**, not an unconstrained group chat and not a single supervisor with every tool.

The smallest useful team is:

1. **Monitor Agent** — reads an already-triggered incident and adds semantic triage; it cannot open, close, or mutate an incident by itself.
2. **Evidence Agent** — fans out read-only telemetry and change queries and returns evidence manifests, not diagnoses.
3. **Diagnosis Agent** — proposes a causal chain from immutable evidence IDs; it has no remediation tool.
4. **Adversarial Evaluator** — independently accepts, rejects, or requests evidence; it has no diagnosis, remediation, or promotion authority.
5. **Remediation Planner** — emits a bounded plan; it cannot execute it.
6. **Verification Agent** — inspects only post-action telemetry and produces a report that is checked by deterministic thresholds.
7. **Evolve Agent** — offline-only maker that proposes a versioned policy or regression candidate.
8. **Test Agent** — offline-only checker that runs frozen replay/backtest cases; it cannot edit the candidate or promote it.

Two non-agent roles remain deliberately deterministic: the **orchestrator** owns transitions, budgets, retries, and stop rules; the **repair executor** runs only an allowlisted command after a valid owner approval. The owner remains the only authority for consequential remediation and policy promotion.

For the bounded POC, implement this with FlowPulse's current Node.js runtime plus strict JSON-schema contracts and separate OpenAI calls. The OpenAI Agents SDK for TypeScript is the best optional near-term library for specialist loops, tool guardrails, and resumable approvals, but it should not replace the FlowPulse ledger or state machine. Temporal becomes attractive only when runs must survive process loss for hours or days across multiple workers. LangGraph, CrewAI, Microsoft Agent Framework, Google ADK, and AutoGen offer useful patterns, but introducing one now would duplicate state and expand the stack before authority boundaries are proven.

## Scope and method

This is a read-only audit of the standalone FlowPulse repository plus primary-source documentation research. No production implementation, dependencies, credentials, deployment, or UI changes are included.

The term **Blueprint** was not specific enough to attribute to a verified product or repository. This report interprets it generically as published multi-agent orchestration blueprints. It does not claim compatibility with, or import from, any previous prototype.

Research Engine was run first, as required. Its run is recorded at:

`docs/research/runs/2026-07-17-current-primary-source-comparison-for-safe-multi-agent-orchestra/`

That run stopped with `failed_no_rows`: all six AnySearch requests returned HTTP 402, so its `evidence.jsonl` is empty. The limitation is preserved rather than hidden. The framework facts below were then collected from current official documentation pages directly. Recommendations are explicitly separated from those facts.

## Current FlowPulse responsibility map

### What exists today

| Responsibility | Current implementation | Isolation today |
| --- | --- | --- |
| Incident state and replay | `IncidentRuntime` derives progress from append-only events and enforces the approval pause (`src/runtime.mjs:30-55`). | Strong deterministic control, one process. |
| Live evidence collection | The live investigator selects metrics, traces, logs, deploys, and commits through five allowlisted tools (`src/openai.mjs:71-120`, `175-204`). | Same agent/context as diagnosis. |
| Diagnosis | The investigator produces a strict causal finding and a repair suggestion in one output (`src/openai.mjs:206-232`). | Maker combines evidence, diagnosis, and repair intent. |
| Adversarial evaluation | A separate model call evaluates the diagnosis against cited evidence (`src/openai.mjs:122-136`). | Separate prompt/call and no tools, but same process, credentials, bundle, model family, and append API. |
| Remediation planning | The accepted live diagnosis is converted directly into `repair.proposed` (`src/openai.mjs:48-60`). | No planner/executor separation at the agent level. |
| Approval | The runtime refuses to advance after `approval.requested` until `approval.granted` exists (`src/runtime.mjs:30-55`). | Strong human gate. |
| Execution | Development mode validates an allowlisted command and recreates only checkout (`src/development-runtime.mjs:94-115`; `src/development-adapter.mjs`). | Deterministic adapter, correctly not an LLM tool. |
| Verification | `DevelopmentRuntime.verify()` queries post-repair evidence and writes verification, classification, regression, and policy events (`src/development-runtime.mjs:118-158`). | Verification, outcome classification, Evolve, and policy gate are coupled in one method. |
| Evolve/backtest | Replay calls deterministic `evaluateCandidate`; development mode writes a passing policy result inline (`src/policy.mjs:8-30`; `src/development-runtime.mjs:140-157`). | Evolve is an actor label, not an isolated maker; there is no independent Test Agent. |
| Truth | SQLite triggers prevent update and delete; each event carries actor, payload, evidence refs, parent, and correlation ID (`src/ledger.mjs:8-34`, `48-83`). | Strong append-only base. |
| Observability | Langfuse receives generations, tools, evaluator spans, latency, and usage (`src/observability.mjs:21-47`). | Correctly non-authoritative. |

### Bottlenecks and coupling

1. **One live maker owns too much.** Evidence selection, evidence collection, causal synthesis, replanning, and the initial repair intent all live in one investigator loop. A single prompt error can therefore bias every downstream artifact.
2. **Logical evaluator separation is not capability isolation.** The evaluator is a separate call, which is good, but it shares the application process, model configuration, evidence bundle, credentials, and ledger append surface with the maker.
3. **Actor labels overstate runtime separation.** Replay events name `investigator`, `evaluator`, `remediation`, `verifier`, and `evolve`, but they are emitted by one static action table in one process (`src/runtime.mjs:98-202`).
4. **Development mode is a monolith.** One class applies the case, performs scripted diagnosis/evaluation, approves and executes repair, verifies, classifies, creates regression data, and marks the policy eligible.
5. **No independent offline checker exists.** The same path that creates a regression candidate also records the policy outcome. This violates maker/checker isolation even though the current deterministic gates are sensible.
6. **Detection is request-driven.** Live OTLP projection exists, but a continuously operating detection/triage role with de-duplication, incident budgets, and suppression policy does not.
7. **No typed inter-agent envelope exists.** Strict model outputs exist for diagnosis and evaluation, but agent identity, prompt/version hash, budget consumption, idempotency key, input event IDs, and capability scope are not yet first-class message fields.
8. **The state machine is already the right safety kernel.** Approval ordering, scope validation, immutable evidence IDs, and deterministic promotion checks should be extended, not replaced by an LLM coordinator.

## Facts from current official documentation

The following are framework facts, not FlowPulse recommendations.

- **OpenAI Agents SDK:** its official orchestration guide documents manager-style agents-as-tools and handoffs, and allows mixing these patterns. Tool guardrails can validate every custom function-tool call. Human-in-the-loop tools pause and resume from serialized `RunState`, including nested agents; the runner also exposes a `maxTurns` safety limit. [OAI-1] [OAI-2] [OAI-3] [OAI-4]
- **CrewAI:** official guidance distinguishes autonomous Crews from deterministic, event-driven Flows and recommends Flows for predictable, auditable decision paths. Crews support sequential and hierarchical processes. Checkpointing can resume crews, flows, and agents, but the current checkpointing page explicitly labels it early release. [CREW-1] [CREW-2] [CREW-3]
- **LangGraph:** it is a low-level graph runtime for durable execution, streaming, and human-in-the-loop. Checkpointers save graph state at each step; interrupts pause indefinitely and resume by thread ID. LangChain's multi-agent docs distinguish routers, handoffs, and supervisor/subagent patterns and explicitly identify context isolation as a main reason for subagents. [LG-1] [LG-2] [LG-3] [LG-4]
- **Microsoft Agent Framework:** official documentation describes typed, graph-based workflows, checkpoints, and human-in-the-loop request/response. The official AutoGen migration guide says Agent Framework is the new foundation developed by the core AutoGen and Semantic Kernel teams and contrasts its typed data-flow workflow with AutoGen's event-driven/team model. [MAF-1] [MAF-2] [MAF-3] [MAF-4]
- **Google ADK:** current ADK documentation offers graph, dynamic, collaborative, and template workflows. Template workflows include deterministic sequential, loop, and parallel agents; collaborative workflows use a coordinator and scoped subagent modes. ADK's A2A integration targets remote agent interoperability. Resume is at-least-once for tools, so side-effecting tools must be idempotent. [ADK-1] [ADK-2] [ADK-3] [ADK-4]
- **AutoGen:** AutoGen Core provides an event-driven actor model and asynchronous messaging, while AgentChat provides teams, handoffs, and explicit termination conditions. Its own HITL page warns that blocking user input during a run can leave a team in a state that cannot be saved or resumed. Microsoft now provides an official migration path to Agent Framework. [AG-1] [AG-2] [AG-3]
- **Temporal:** Temporal is a durable workflow engine rather than an agent framework. TypeScript Signals can change a workflow's state, `workflow.condition` can wait for approval, and retry policies expose maximum attempts, backoff, and non-retryable errors. [TEMP-1] [TEMP-2] [TEMP-3]

## Orchestration mechanism comparison

| Mechanism | Strength | Incident-response risk | FlowPulse use |
| --- | --- | --- | --- |
| LLM supervisor / agents-as-tools | Flexible decomposition and concise context returned from specialists. | Supervisor becomes a single trust and tool-selection bottleneck; a compromised manager can bias every branch. | Use only inside read-only evidence gathering or result synthesis. Never let it own approval, repair execution, or promotion. |
| Router + parallel specialists | Fast fan-out across distinct domains; routing can be rules or a small classifier. | Bad routing can omit evidence; parallel results need deterministic join and provenance. | Best for Telemetry and Change evidence lanes, with a required coverage manifest. |
| Handoffs | Focused prompts and direct transfer to a specialist. | Context and authority can leak between roles; control transfer is too implicit for safety gates. | Use only for user-facing assistance, not the core incident state machine. |
| Hierarchical crew / group chat | Feels like a team and supports emergent collaboration. | Shared chat creates correlated errors, context bloat, unclear ownership, and hard-to-replay decisions. | Not recommended for the authoritative incident path. |
| Explicit graph / state machine | Typed transitions, deterministic stops, clear retries and human gates. | More design work; poorly designed graphs can become rigid. | Primary orchestration mechanism. FlowPulse already has its core. |
| Event-driven ledger / blackboard | Agents are decoupled and every claim is attributable and replayable. | Shared write access can become unsafe; duplicate deliveries require idempotency. | Primary communication mechanism, but agents submit typed proposals through a validating broker rather than writing arbitrary events. |
| Durable workflow engine | Survives restarts and long approval waits; rich retry/timeout semantics. | Adds an additional history/state system and operational dependency. | Add Temporal only when multi-worker, long-lived, restart-safe execution is a proven requirement. |

## Framework decision matrix

Scores are FlowPulse-specific judgments based on the documented facts above.

| Option | Explicit control | Durability / HITL | Isolation model | Current Node fit | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Current ledger + state machine | High | Medium today; durable event truth, limited worker recovery | Whatever FlowPulse enforces | **High** | **Authoritative POC backbone.** Extend schemas, roles, idempotency, and leases. |
| OpenAI Agents SDK (TypeScript) | Medium; native-code orchestration remains available | Medium-high; serialized approvals and sessions | Separate agents, tools, guardrails, handoffs | **High** | **Optional specialist runtime.** Use per-agent calls/guards, never as ledger authority. |
| LangGraph (JavaScript) | High | High; checkpoints and interrupts | Nodes/subgraphs with context controls | Medium-high | Viable alternative when graph complexity exceeds current state machine, but avoid dual truth. |
| CrewAI (Python) | Medium-high with Flows; lower with autonomous Crews | Medium; checkpointing is early release | Roles/tasks/crews, manager process | Low | Use as a design reference, not a POC dependency. Python and a second state system add cost. |
| Microsoft Agent Framework | High; typed data-flow workflows | High in current docs | Executors, agents, functions, sub-workflows | Low-medium | Watchlist. Good conceptual fit, but a stack migration is not justified for this Node POC. |
| Google ADK | High with graphs/templates; medium with coordinator | Medium-high; resumable workflows with at-least-once caveat | Local subagents or remote A2A agents | Low-medium | Consider later for cross-service A2A interoperability, not for initial in-process separation. |
| AutoGen | Medium; Core is flexible, teams are more emergent | Medium; explicit termination, awkward blocking HITL | Actor/runtime or shared team context | Low | Do not start a new adoption; Microsoft positions Agent Framework as the forward foundation. |
| Temporal TypeScript | **High** for workflow mechanics; no agent semantics | **Very high** | Activities/workers/task queues | Medium | Phase-later durability layer if incidents span process restarts, workers, or long approvals. |

## Recommended architecture: Ledger-Governed Agent Team

```text
OTLP / deploy / commit feeds
        |
        v
Deterministic detector ----> incident.detected
        |                           |
        |                     Monitor Agent (read-only triage)
        |                           |
        +---------------------------v
                    code-owned orchestrator
                    (budget + state + stop rules)
                              |
              +---------------+---------------+
              |                               |
      Telemetry evidence lane          Change evidence lane
              +---------------+---------------+
                              v
                       Evidence manifest
                              v
                       Diagnosis Agent
                              v
                 Adversarial Evaluator
                   | reject       | accept
                   v              v
             bounded replan   Remediation Planner
                                     v
                         deterministic policy check
                                     v
                              OWNER APPROVAL
                                     v
                         allowlisted repair executor
                                     v
                          Verification Agent +
                         deterministic thresholds
                                     v
                           outcome classification
                                     v
              offline fork: Evolve Agent (maker)
                                     v
                         Test Agent (checker)
                                     v
                           OWNER PROMOTION GATE
```

### Why this fits FlowPulse

- **Append-only ledger:** every request, response, rejection, retry, approval, receipt, and test result is a new immutable event. Agents exchange event IDs and typed artifacts rather than mutable shared chat history.
- **Deterministic replay:** orchestration decisions depend on event types, contract versions, and deterministic gates. A replay can replace model agents with recorded outputs while preserving the same transition logic.
- **Langfuse:** each agent/model/tool span includes the FlowPulse `run_id`, agent ID, input event IDs, and output event ID. Langfuse remains a mirror; losing a trace cannot advance or block the state machine.
- **Owner approval:** the approval event contains the exact `proposal_hash`, scope, expiry, and expected verification plan. Any changed plan invalidates the approval.
- **Agentic behavior without unsafe autonomy:** agents decide what evidence to request, construct causal candidates, challenge them, and propose bounded actions. Code decides which transitions are legal and which tools exist.

## Agent authority boundaries

| Role | May read | May emit | Tools | Explicitly forbidden |
| --- | --- | --- | --- | --- |
| Monitor Agent | normalized runtime signals, topology, recent incident fingerprints | `triage.annotation.proposed` | read-only topology/metric summaries | opening/closing incident, suppression mutation, remediation |
| Evidence Agent | incident scope, approved evidence plan, source catalog | `evidence.requested`, `evidence.manifest.proposed` | metrics, traces, logs, deploys, commits; read-only | hypotheses, remediation, arbitrary source expansion |
| Diagnosis Agent | evidence manifest and referenced facts | `diagnosis.proposed`, `evidence.gap.proposed` | none by default; requests go through Evidence Agent | repair execution, approval, evaluator result |
| Adversarial Evaluator | candidate diagnosis, cited evidence, counter-evidence catalog, rubric | `evaluation.accepted` or `evaluation.rejected` | read-only evidence verification | maker scratchpad, remediation tools, candidate editing |
| Remediation Planner | accepted diagnosis, allowlist, runbook catalog | `repair.proposed` | read-only runbooks | execution, approval, broadening target |
| Verification Agent | execution receipt, pre/post evidence window, verification plan | `verification.proposed` | post-action telemetry reads only | repair tools, changing thresholds, outcome promotion |
| Evolve Agent | closed incident, false diagnoses, regression schema | `policy.candidate.proposed`, `regression.candidate.proposed` | offline artifact writer in quarantine | production evidence tools, policy activation, test-result writing |
| Test Agent | frozen candidate and versioned replay suite | `backtest.completed` | deterministic replay runner in isolated workspace | candidate modification, production tools, promotion |

Agents should not receive a raw `ledger.append` capability. They return a signed/attributed proposal to the orchestrator, which validates the contract, legal transition, evidence references, budget, and idempotency key before appending the authoritative event.

## Typed contract

The companion file `2026-07-17-agentic-orchestration-contract.json` is the concise machine-readable contract. Every message carries:

- schema and message version;
- run, incident, agent, model, prompt, and policy version IDs;
- parent event IDs and immutable evidence references;
- tool/cost/time budget remaining;
- idempotency key and content hash;
- typed payload and confidence;
- proposed next state, never an unvalidated state mutation.

Key payloads are `IncidentSignal`, `EvidencePlan`, `EvidenceManifest`, `DiagnosisCandidate`, `EvaluationVerdict`, `RemediationProposal`, `ApprovalDecision`, `ExecutionReceipt`, `VerificationReport`, `OutcomeClassification`, `PolicyCandidate`, and `BacktestReport`.

## Online state machine

1. `DETECTED` — deterministic threshold or external incident event opens the run; Monitor Agent annotates priority.
2. `COLLECTING` — Evidence Agent fans out telemetry and change reads. Join requires source coverage or an explicit missing-source result.
3. `DIAGNOSING` — Diagnosis Agent emits one evidence-cited candidate or an evidence-gap request.
4. `EVALUATING` — evaluator uses a clean context containing only the candidate, rubric, cited facts, and counter-evidence.
5. On rejection, return to `COLLECTING` with a maximum of two replan cycles. On unresolved conflict or budget exhaustion, stop as `insufficient_evidence`.
6. `PLANNING_REPAIR` — planner creates a bounded proposal; deterministic policy validates target, action, timeout, abort conditions, and verification plan.
7. `WAITING_OWNER` — no agent runs a side-effecting tool. Owner approval must match the proposal hash and not be expired.
8. `EXECUTING` — a non-LLM adapter executes one allowlisted action with an idempotency key and returns a receipt.
9. `VERIFYING` — verifier collects fresh evidence; deterministic thresholds decide pass/fail.
10. `LEARNING` — classification is written, then an offline run creates a regression/policy candidate and independent backtest report.
11. `CLOSED` — policy promotion remains a separate owner action and is never implied by incident resolution.

## Budgets, retries, and stop rules

| Area | POC budget | Failure behavior |
| --- | --- | --- |
| Monitor | one semantic triage per de-duplicated incident fingerprint | fall back to deterministic priority; record agent failure |
| Evidence tools | max 2 attempts per query, exponential backoff, 8 total calls | `tool_data_failure` if the required source remains unavailable |
| Diagnosis | max 2 candidates, 1,800 output tokens each | `insufficient_evidence` after second rejection |
| Evaluator | one verdict per candidate; one infrastructure retry only | no accepted verdict means no repair planning |
| Replan | max 2 cycles; each must name a new evidence category or counter-claim | repeated plan is rejected deterministically |
| Repair plan | one candidate plus one schema-repair attempt | out-of-allowlist proposal is terminal for the run |
| Owner gate | explicit approve/reject; approval expires after a configured window | rejection/expiry closes without mutation; a changed plan requires new approval |
| Executor | exactly one idempotent command ID; no LLM retry | unknown outcome stops and escalates; never issue an alternative mutation automatically |
| Verification | three bounded post-repair observation windows | threshold failure is `repair_failure`; no second repair automatically |
| Evolve | offline only, one candidate per closed incident classification | candidate remains inactive |
| Test | all frozen deterministic cases plus seeded negative cases | any failed gate blocks promotion |

Global stop conditions are: unknown evidence reference, unresolved source conflict, budget exhaustion, evaluator rejection limit, owner rejection/expiry, scope mismatch, executor ambiguity, failed verification, candidate backtest failure, or any request for a capability outside the agent's allowlist.

## Maker/checker and Evolve/Test isolation

This is a security boundary, not just two different prompts.

- Diagnosis and evaluator use separate contexts and agent IDs. The evaluator receives the maker's **artifact**, not its hidden scratch reasoning or conversation history.
- The evaluator has read-only evidence-verification tools and cannot call the planner or executor.
- Evolve and Test use separate run IDs, process identities, tool registries, output directories, and credentials.
- Evolve writes only to a quarantine candidate namespace. It cannot execute the replay suite or mark its own candidate passing.
- Test mounts the candidate and dataset read-only, writes a `BacktestReport`, and cannot edit the candidate.
- The orchestrator computes deterministic pass/fail from test events. Neither Evolve nor Test can write `policy.promoted`.
- Promotion requires both all deterministic gates and a separate owner approval event.
- A same-model checker is acceptable for the POC only when deterministic gates remain decisive. Production should support model/provider diversity for high-risk semantic evaluations, but diversity is not a substitute for contract and capability isolation.

## Current stack versus optional adoption

### POC with the current stack

No new framework is required to prove the architecture:

1. Extract each role into a separate module with its own strict input/output schema.
2. Add a contract-validating dispatcher that is the only agent-to-ledger write path.
3. Split `DevelopmentRuntime.verify()` into verification, classification, Evolve candidate, and Test gate stages.
4. Add event-level idempotency keys, agent/prompt/model version fields, budget records, and proposal hashes.
5. Run Evidence lanes in parallel using native `Promise.all`, then join deterministically.
6. Keep the repair adapter deterministic and preserve the existing owner gate.
7. Continue exporting spans to Langfuse without reading Langfuse to make runtime decisions.

### Optional OpenAI Agents SDK step

After the contracts pass, the Agents SDK can reduce custom model-loop code:

- use one `Agent` definition per specialist;
- expose read-only collectors as agents-as-tools to the Evidence Agent;
- use tool guardrails on every custom function tool;
- set `maxTurns`, tool concurrency, token ceilings, and approval requirements;
- serialize approval `RunState` only as execution convenience while the FlowPulse ledger remains the source of truth.

Do not use handoffs to transfer authority between evaluator, planner, executor, or Evolve/Test. Their transitions remain code-owned.

### When to adopt Temporal

Adopt a Temporal TypeScript workflow only after at least one of these becomes real: multi-hour owner approvals, multiple workers, process/host failover, schedules, or operational retry/timeout demands that the current runtime cannot safely meet. Map each Temporal activity result to a FlowPulse ledger event and treat the ledger as product truth; document Temporal history as execution infrastructure. Side-effecting activities must be idempotent.

### Why not adopt the others now

- LangGraph would be the strongest graph alternative, but its checkpoint state would overlap FlowPulse's existing ledger projections.
- CrewAI's role metaphor matches the desired team, but Python plus early-release checkpointing adds risk; its own guidance favors deterministic Flows for this use case.
- Microsoft Agent Framework has strong typed workflow concepts, but adopting it means a stack migration and its current distributed story is still evolving.
- Google ADK and A2A are valuable when agents truly become separate services owned by different teams; that is beyond this POC.
- AutoGen remains useful research material, but Microsoft now points new development toward Agent Framework.

## Bounded POC sequence

### P0 — Contracts and replay harness

Add only schemas, role manifests, legal transition rules, and a replay test harness. Replay existing recorded agent outputs through the new contracts. No additional live model calls.

**Exit:** the existing judge incident produces the same causal events and owner gate; invalid actor/event combinations are rejected.

### P1 — Separate online maker/checker

Run Evidence, Diagnosis, Evaluator, Planner, and Verifier as separate in-process agents/calls. Give each a clean context and explicit tool registry. Keep the deterministic executor.

**Exit:** each event records a distinct agent/version, evaluator cannot access repair tools, and a rejected Kafka diagnosis routes only to evidence replan.

### P2 — Isolated offline Evolve/Test

Create a quarantined Evolve candidate artifact and a separate deterministic Test runner over the existing incident bundle plus negative cases.

**Exit:** Evolve cannot self-grade, Test cannot edit candidates, and any failing replay leaves promotion blocked.

### P3 — Durability spike, only if required

Compare a minimal Agents SDK implementation for model loops and a Temporal spike for restart-safe owner waits. Do not migrate product truth.

**Exit:** choose a dependency only if it demonstrably removes code or closes a measured recovery gap without duplicating authority.

## Acceptance tests

1. **False-cause rejection:** a Kafka-root-cause candidate with only lag evidence is rejected; no repair proposal is legal.
2. **Evidence provenance:** unknown or cross-incident evidence IDs fail contract validation before ledger append.
3. **Evaluator independence:** evaluator input contains candidate + cited facts + rubric only; it has no planner/executor tools.
4. **Deterministic replan:** the same rejection event yields the same next legal state and budget decrement.
5. **Budget stop:** a third diagnosis attempt or ninth evidence call yields `insufficient_evidence`/budget exhaustion and no mutation.
6. **Owner gate:** executor is unreachable before a valid approval event matching `proposal_hash`.
7. **Stale approval:** modifying target, command, timeout, or verification plan invalidates prior approval.
8. **Idempotent execution:** retrying the same command ID returns the existing receipt and does not reapply the rollback.
9. **Verification isolation:** verification uses only evidence later than the execution receipt; it cannot change thresholds.
10. **Repair failure:** failed recovery thresholds classify `repair_failure` and stop without a second autonomous mutation.
11. **Evolve/Test separation:** distinct identities, tools, run IDs, and writable namespaces are asserted in tests.
12. **Backtest gate:** one seeded regression failure makes promotion `blocked` even if semantic scores pass.
13. **Langfuse outage:** disabling or failing tracing changes no ledger events or transition result.
14. **Restart replay:** rebuilding state solely from ledger events reproduces the same pending owner gate and next legal action.
15. **Captured/live parity:** recorded specialist outputs and live outputs pass the same schemas and state transitions.

## Risks and remaining decisions

- **Over-agentization:** more personas do not automatically improve quality. Keep deterministic detector, transition, execution, and promotion logic outside LLMs.
- **Correlated model errors:** separate prompts using the same model are not fully independent. Preserve deterministic evidence and policy gates; optionally test a different evaluator model later.
- **Dual state:** any framework checkpoint/session must not become a second product truth. Define recovery precedence before adoption.
- **At-least-once delivery:** agents and durable workflows can repeat work. All tool calls and ledger proposals require idempotency keys.
- **Context leakage:** shared chat histories weaken maker/checker separation. Pass typed artifacts and event IDs, not full conversations.
- **Cost/latency:** parallel evidence workers can increase call volume. Start with one Evidence Agent and native parallel read tools; split workers only when measured.
- **Production tenancy/authentication:** not addressed in this POC. Per-agent credentials and tenant isolation become mandatory before broader write access.

Decisions intentionally deferred: whether to add the OpenAI Agents SDK, when to add Temporal, whether evaluator model diversity is worth the cost, and whether A2A is needed for agents owned by separate services or teams.

## Primary sources

### OpenAI Agents SDK

- [OAI-1] Agent orchestration — https://openai.github.io/openai-agents-js/guides/multi-agent/
- [OAI-2] Human-in-the-loop — https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- [OAI-3] Guardrails — https://openai.github.io/openai-agents-js/guides/guardrails/
- [OAI-4] Running agents and `maxTurns` — https://openai.github.io/openai-agents-js/guides/running-agents/

### CrewAI

- [CREW-1] Introduction: Crews versus Flows — https://docs.crewai.com/en/introduction
- [CREW-2] Flows — https://docs.crewai.com/en/concepts/flows
- [CREW-3] Checkpointing, including early-release notice — https://docs.crewai.com/en/concepts/checkpointing

### LangGraph / LangChain

- [LG-1] LangGraph overview — https://docs.langchain.com/oss/javascript/langgraph/overview
- [LG-2] Persistence — https://docs.langchain.com/oss/javascript/langgraph/persistence
- [LG-3] Interrupts — https://docs.langchain.com/oss/javascript/langgraph/interrupts
- [LG-4] Multi-agent patterns and subagents — https://docs.langchain.com/oss/javascript/langchain/multi-agent and https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents

### Microsoft Agent Framework and AutoGen

- [MAF-1] Agent Framework overview — https://learn.microsoft.com/en-us/agent-framework/overview/
- [MAF-2] Workflow orchestrations — https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- [MAF-3] Human-in-the-loop and checkpoints — https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop and https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
- [MAF-4] AutoGen migration guide — https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/
- [AG-1] AutoGen Core — https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/index.html
- [AG-2] AutoGen termination conditions — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
- [AG-3] AutoGen human-in-the-loop — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html

### Google ADK

- [ADK-1] Workflow types — https://adk.dev/agents/multi-agents/
- [ADK-2] Template workflows — https://adk.dev/agents/workflow-agents/
- [ADK-3] Collaborative workflows — https://adk.dev/workflows/collaboration/
- [ADK-4] Resume behavior and A2A — https://adk.dev/runtime/resume/ and https://adk.dev/a2a/

### Temporal

- [TEMP-1] Temporal documentation overview — https://docs.temporal.io/
- [TEMP-2] TypeScript workflow message passing, Signals, and wait conditions — https://docs.temporal.io/develop/typescript/workflows/message-passing
- [TEMP-3] Retry policies — https://docs.temporal.io/encyclopedia/retry-policies

## Self-review

- Eight orchestration/framework options are compared with official primary sources.
- Framework facts are separated from FlowPulse-specific inference.
- The recommendation preserves the append-only ledger, deterministic replay, Langfuse's observability-only role, and owner approval.
- Evaluator and Evolve/Test maker-checker isolation are explicit capability boundaries.
- Current-stack implementation is distinguished from optional framework adoption.
- POC phases, budgets, checks, feedback, records, stop rules, and human gates are bounded.
- No backend implementation, dependency, credential, deployment, or UI change was made.

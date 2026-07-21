# Interactive Incident Demo Design

## Goal

Deliver a truthful, operable FlowPulse demo in which a presenter starts from a healthy Live graph, injects one reversible checkout/payment fault, inspects the affected component and its evidence, asks the Agent Team what happened, and watches the system diagnose, evaluate, repair, verify, and recover in real time.

The UI must render backend state. It must not simulate backend progress with timers or a prerecorded frontend animation.

## Primary user journey

1. The Live graph starts healthy and shows normal data pulses.
2. The presenter selects **Simulate Incident** and chooses **Checkout → Payment endpoint misconfiguration**.
3. The backend immediately returns a unique run and incident identity, then performs the isolated fault-to-recovery loop asynchronously.
4. Payment becomes unhealthy first. Checkout errors rise and Kafka lag appears later as a downstream symptom.
5. Observer detects the bounded anomaly automatically and creates the incident without receiving a diagnosis prompt.
6. Selecting a red component opens the existing right-side drawer with health, impact, bounded metrics, logs, traces, changes, upstream/downstream context, and the Agent Team conversation.
7. The presenter may ask **Why is this component red?** Observer reports what is observed, cites evidence, and avoids claiming an unverified root cause.
8. The workflow visibly routes causal analysis to Investigator. The same conversation shows an explicit `Observer → Investigator` handoff.
9. Investigator identifies the endpoint-variable mismatch and distinguishes it from the later Kafka lag.
10. Evaluator adversarially checks evidence coverage and causal ordering.
11. The runtime proposes a reversible repair. Because the primary demo repair is low-risk, local-only, and pre-authorized, it executes without a human click. Higher-risk or insufficient-evidence cases stop at `needs_human`.
12. Payment and checkout recover, downstream lag converges, pulses resume, Compare becomes available, and the timeline ends at `recovered` only after independent verification passes.

## Product layout

The Live page remains the primary monitoring workspace:

- **Center:** shared runtime graph and animated data flow.
- **Top action:** `Simulate Incident`; the control is visibly demo-only and cannot target an external system.
- **Right drawer:** selected component evidence plus persistent Agent Team conversation and contextual workspace actions.
- **Timeline:** ordered backend milestones from baseline through recovery.
- **Compare:** unavailable until verification produces a terminal result.

Architecture remains a layered overview. Diagnose, Recovery Console, and Compare remain full deep-inspection workspaces; they are not removed or compressed into Live.

In the healthy state, these workspaces are hidden from the primary navigation because there is no incident to inspect. Once an incident exists, the Agent Team conversation becomes the contextual launcher:

- `View Diagnosis` appears after Observer creates a bounded incident.
- `Open Recovery Console` appears after an evaluated remediation plan exists or repair begins.
- `Compare Recovery` appears only after independent verification reaches a terminal result.

Selecting an action opens the existing workspace as an overlay, expanded canvas, or seamless route transition while preserving the active `run_id`, `incident_id`, selected component, conversation, and timeline position. Returning to Live restores the same graph state.

These actions reveal work; they do not authorize or start it. Observer and the remaining Agent Team continue the approved autonomous low-risk loop even if the presenter never opens a workspace. This preserves the product claim that monitoring, diagnosis, repair, and verification can run without human intervention.

### Diagnosis workspace

Diagnosis focuses on the faulted component and the minimum relevant upstream/downstream subgraph rather than repeating the entire Live topology. It shows:

- initiating node and affected path;
- ordered hypotheses and rejected alternatives;
- exact evidence citations;
- Observer → Orchestrator → Investigator → Evaluator handoffs;
- current agent, task, stage, progress, and bounded tool activity;
- safe agent messages explaining what is known, uncertain, or being checked.

### Recovery Console

Recovery Console shows execution rather than a static remediation card:

- proposed repair, target, risk, reversibility, and authority decision;
- which agent/runtime actor owns each step;
- current action state and safe operational log;
- information passed between agents;
- repair, rollback, retry, and verification events;
- live node and data-flow recovery signals.

Raw prompts, chain of thought, credentials, unrestricted command output, and provider payloads remain excluded. “Transparent” means observable actions, evidence, decisions, handoffs, and safe summaries—not private model reasoning.

### Compare workspace

Compare is the final proof surface. It aligns before/after values for the same run and shows:

- root condition before and after repair;
- direct symptom before and after repair;
- downstream lag/backlog convergence;
- topology and data-flow health;
- verification checks and final result;
- links back to the evidence and actions that produced the change.

Compare remains locked while repair is merely proposed or executed. It unlocks only after backend verification records `recovered`, `needs_human`, or `failed`, and must never imply success for a non-recovered terminal state.

## Role boundaries

- **Observer:** source freshness, signals, anomalies, incident opening; no unsupported root-cause claim.
- **Orchestrator:** workflow selection, role assignment, authority boundary, and visible handoff.
- **Investigator:** causal evidence, topology/change correlation, root cause, and downstream-impact distinction.
- **Evaluator:** adversarial hypothesis review, citation coverage, causal order, confidence, and verification requirements.

The selected role never silently changes. Every handoff records `from`, `to`, and `reason`.

## Backend contract required before frontend implementation

### Asynchronous start

`POST /api/demo/agent-loop/run` must validate the case, reserve identities, append the initial record, start the bounded run in the background, and respond immediately:

```json
{
  "schema_version": "flowpulse.local-fault-loop.v2",
  "run_id": "...",
  "incident_id": "...",
  "state": "running",
  "stage": "monitor",
  "events_url": "/api/demo/agent-loop/events?run_id=...&after=0"
}
```

The HTTP request must not remain open for the duration of four model calls.

### Incremental event stream

The frontend subscribes immediately to the returned `events_url`. SSE must project already-recorded events, append new events as the run advances, support `Last-Event-ID`, emit heartbeats, and finish with a terminal state event.

Required stages:

`monitor → fault → detect → diagnose → evaluate → plan → approve-or-auto → repair → verify → recovered | needs-human | failed`

### Safe role responses

The loop event projection must include bounded user-displayable role output:

```json
{
  "role": "investigator",
  "requested_agent": "investigator",
  "responding_agent": "investigator",
  "state": "completed",
  "safe_answer": "...",
  "citations": ["..."],
  "handoff": null,
  "tools": [{"tool":"read_evidence_summaries","result_count":5}]
}
```

`safe_answer` must be schema-validated, length-bounded, redacted, and free of raw prompts, chain of thought, provider payloads, credentials, and raw unrestricted logs. Hash and byte count may remain for audit but cannot replace the displayable answer.

### Component evidence

Every incident event that changes a node must provide canonical component IDs and bounded evidence references. The right-side drawer must be able to query or derive:

- health and first-failure time;
- affected components;
- bounded metrics/log/trace/change summaries;
- upstream/downstream relationships;
- exact evidence IDs;
- current agent stage and final decision.

## Failure behavior

- Provider unavailable or malformed output → terminal `failed`; never substitute recorded output.
- Verification failure → rollback and retry within the existing two-attempt bound; never emit `recovered` prematurely.
- Insufficient evidence or elevated authority → `needs_human`; no repair event.
- Browser reconnect → resume from `Last-Event-ID` without invoking another model or duplicating the repair.
- Duplicate start/idempotency key → return the original run identity rather than launch a second incident.

## Acceptance

Backend acceptance precedes frontend implementation:

- Start returns in under one second under normal local conditions, before the first role completes.
- A separate client can subscribe immediately and observe events incrementally.
- The stream contains safe displayable answers for all four roles.
- One real `codex-local` checkout/payment run reaches `recovered` with ordered evidence and verification.
- One insufficient-evidence run reaches `needs_human` without repair.
- Reconnect and duplicate-start tests pass.
- Existing 10-run loop and full test suites remain green.

Frontend acceptance follows only after this contract passes independent review:

- Simulate Incident visibly changes the graph from healthy to faulted using backend events.
- Selecting a red component opens its real incident evidence.
- The Agent Team conversation renders live role responses and transparent handoffs.
- The contextual drawer reveals `View Diagnosis`, `Open Recovery Console`, and `Compare Recovery` only when their backend prerequisites exist.
- Each contextual action opens its complete deep workspace with the same run, incident, component, conversation, and timeline context.
- Diagnosis renders the bounded causal subgraph and active Agent Team work; Recovery Console renders safe execution activity; Compare renders verified before/after evidence.
- The autonomous low-risk repair visibly restores the graph.
- Compare unlocks only after backend verification.
- No frontend timer invents a stage or health transition.

## Non-goals

- Production chaos engineering or external cloud mutation.
- A second agent framework.
- Autonomous medium/high-risk remediation.
- Redesigning the accepted Architecture visual system.
- Generalizing the demo beyond the three existing isolated cases before competition submission.

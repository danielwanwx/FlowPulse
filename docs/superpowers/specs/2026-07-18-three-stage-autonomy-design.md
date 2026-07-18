# FlowPulse three-stage autonomy design

Status: approved product design
Date: 2026-07-18
Scope: P0 product and control-plane design; no new remediation authority is granted by this document.

## Objective and competition narrative

FlowPulse presents a production incident as one transparent operating loop rather
than as a collection of dashboards and agent demos:

```text
Monitor -> Agent Workbench -> Decision & Recovery -> Monitor
```

The product continuously makes system state and incident status legible, then
lets a bounded agent harness collect evidence, form and challenge hypotheses,
and decide whether a safe action is even eligible. Humans retain authority over
material risk. Every observation, tool call, evaluator verdict, policy decision,
approval, action, verification, and learning result is traceable to the
append-only ledger.

The competition story remains intentionally narrow and truthful:

- The credential-free judge path is a deterministic captured Astronomy Shop
  replay, including the fixture-supported checkout, payment, retry, Kafka, and
  downstream narrative.
- The real local development path is a narrower checkout-to-payment proof:
  a versioned `paymentUnreachable` change, observed checkout flag consumption,
  direct payment resolver failures, an exact allowlisted rollback, fresh
  verification, and an offline backtest.
- A model may investigate with bounded read-only tools and propose a strict
  repair contract. It never receives free command authority. The evaluator,
  deterministic validators, policy, owner decision, and code-owned executor
  remain separate boundaries.

This design does not claim that GPT has already completed a successful real
production repair. The preserved real GPT workflow failed closed when its
evidence was insufficient; successful local repair evidence is deterministic
and owner-gated.

## Authority principles

1. The append-only ledger is the runtime authority. Langfuse and visual
   projections are observability surfaces, not control-plane authorities.
2. Immutable current evidence and deterministic validators decide whether an
   action is eligible. Model output, a summary, and retrieved historical
   experience never substitute for evidence.
3. A repair can only execute through a checked-in, typed allowlisted contract,
   with idempotency, rollback, receipt, and verification requirements.
4. Policy-bounded progressive autonomy is the approved model. It is not
   severity-based autopilot.
5. The current checkout-to-payment repair remains a per-incident Owner Gate.
   It is not a low-risk auto-remediation example.

## Current-state mapping

| Product concern | Existing FlowPulse primitive | Gap to close in this design |
| --- | --- | --- |
| System visibility | Architecture and Live canvases, source freshness, topology, component drawers | Present them as one Monitor stage; add a first-class monitor trigger and degraded-monitor state. |
| Incident authority | `incident.opened`, append-only run events, captured replay and local development modes | Make trigger source, freshness, and transition reason visible in one Evidence Track. |
| Evidence work | Frozen evidence snapshots, bounded tools, context compiler, evidence IDs/hashes/provenance | Surface the active goal, tool coverage, omissions, and stop reason in Agent Workbench. |
| Diagnosis and challenge | Investigator, independent evaluator, one bounded replan, deterministic Diagnosis Gate | Add an explicit autonomy assessment after diagnosis acceptance; do not treat acceptance as permission to execute. |
| Human control | `repair.proposed`, `approval.requested`, `approval.granted`, exact contract validation | Add explicit reject, defer, escalation, and preauthorization semantics. |
| Execution and recovery | Code-owned allowlisted executor, receipt, fresh verification, regression, backtest, policy | Keep these gates intact; make their decision inputs and outcomes understandable in Decision & Recovery. |
| Learning | Regression artifact and executed offline backtest | Distinguish recorded learning from active promotion; add advisory retrieval only after P0. |
| Agent collaboration | Ledger-governed Manager and specialist projections | Reframe it as one Agent Workbench; do not imply every visual role is a separate LLM process. |
| Notifications | Local UI banners and manager activity | Add ledger-visible notification and escalation intent/receipt events before claiming operational paging. |

## Exactly three top-level stages

The application has exactly these primary navigation stages. Existing canvases
and drawers are retained as stage-local views instead of being removed.

### 1. Monitor

Purpose: continuously show the best available system-health and incident state.

Entry conditions:

- application opens;
- a run is resumed from ledger state;
- a source is connected, replayed, stale, or disconnected.

Views:

- `Architecture` and `Live` are Monitor subviews;
- current source label, freshness, and provenance remain visible;
- topology, components, status, active incidents, changes, and evidence
  summaries remain inspectable.

Exit conditions:

- a deterministic monitor rule records `incident.opened` with source and
  evidence references; or
- a human explicitly opens an investigation against an eligible snapshot.

If source freshness is not sufficient, Monitor remains visible but enters
`degraded`; it must not silently start an investigation or label captured data
as live.

### 2. Agent Workbench

Purpose: make the agent's bounded evidence work, evaluation, and stopping
decision legible before a repair can be considered.

Entry conditions:

- a ledger-backed incident exists; and
- a deterministic source/readiness check permits a frozen evidence snapshot.

Required internal sequence:

```text
goal anchored
  -> snapshot frozen
  -> bounded read-only tools
  -> hypothesis
  -> independent evaluator
  -> at most one evidence replan
  -> deterministic Diagnosis Gate
  -> autonomy decision
```

The Workbench owns Diagnose, agent activity, evidence drawers, evaluator
counter-evidence, and the Manager conversation. The conversation may explain
or select safe read-only work, but cannot approve or execute remediation.

Exit conditions:

- accepted diagnosis plus passed deterministic gate and an
  `autonomy.decision.recorded` event -> Decision & Recovery;
- false positive -> return to Monitor with a resolved/no-action status;
- insufficient evidence, tool failure, stale source, model failure, or
  evaluator rejection after the one allowed replan -> Decision & Recovery in
  an escalation/blocked state, with no repair authority.

### 3. Decision & Recovery

Purpose: expose the policy decision, the exact human decision where required,
the bounded action, recovery checks, and learning result.

Entry conditions:

- `autonomy.decision.recorded`; or
- an Agent Workbench stop that requires human escalation.

Views:

- action options, evidence and counter-evidence, risk factors, blast radius,
  rollback, and verification plan;
- Owner Gate and its exact contract;
- execution receipt, recovery checks, before/after Compare, regression,
  backtest, and policy result.

Exit conditions:

- verified recovery plus a passing executed offline backtest -> Monitor with a
  resolved incident and learning record;
- rejected/deferred action -> Monitor with a watch state or Agent Workbench
  if new evidence is requested;
- repair/verification failure -> human escalation. The run is not allowed to
  try another remediation automatically.

## Compact state machine and exceptions

```text
Monitor.healthy | Monitor.degraded
  -- deterministic trigger / explicit eligible investigation --> AgentWork.collecting

AgentWork.collecting --> AgentWork.evaluating --> AgentWork.replanning (max 1)
  -- accepted + deterministic gate --> Decision.risk_assessed
  -- false positive --> Monitor.no_action
  -- insufficient/tool/model/stale --> Decision.escalated

Decision.risk_assessed
  -- low + exact active preauthorization --> Decision.auto_authorized
  -- medium --> Decision.owner_review
  -- high/blocked --> Decision.explicit_human_decision

Decision.auto_authorized | Decision.owner_review
  -- exact action authority --> Decision.executing --> Decision.verifying
  -- reject/defer/escalate --> Monitor.watch | AgentWork.collecting

Decision.verifying
  -- all recovery + backtest gates --> Monitor.resolved
  -- failed/mixed/absent evidence --> Decision.escalated
```

Exception rules:

| Condition | Required behavior |
| --- | --- |
| Insufficient evidence | Record a safe failure episode and missing evidence classes. Do not propose executable repair or approval. |
| False positive | Record evaluator rejection; permit only one bounded replan; then stop and return to Monitor. |
| Tool/connector failure | Mark source/control state degraded. A fixture cannot replace live evidence silently. |
| Model refusal, malformed output, incomplete output, transport failure | Record one typed safe failure; emit no hypothesis, evaluation, repair, or approval authority events. |
| Stale/disconnected source | Block diagnosis acceptance and all autonomous execution. |
| Active SEV-1 | Notify/escalate to Incident Commander and service owner; no automatic consequential repair. |
| Missing owner | Medium/high actions remain blocked; record escalation. |
| Repair or verification failure | Stop automatic action, block promotion, require explicit human follow-up. |
| Repeated failure | Any prior repair or verification failure forces the next decision to human-required until an owner resets policy through a recorded action. |
| Notification failure | In a production-like low-risk auto path, block execution rather than claim delivery. |

## Progressive autonomy decision

### Decision rule

Autonomy is determined by explicit factor gates, not a single opaque score.
Severity is one input and can block automation, but can never by itself grant
permission.

An action can auto-execute only if every condition below is true:

1. impact is low for the scoped environment;
2. current evidence is complete, fresh, non-contradictory, and has passed the
   independent evaluator plus deterministic causal gate;
3. action risk is low and the action is reversible and idempotent;
4. blast radius is exactly one permitted component in the preauthorized
   environment;
5. the action matches a live versioned allowlist and preauthorization envelope
   exactly;
6. a rollback and fresh verification plan are executable and bounded;
7. no repair or verification failure exists for the active incident/action
   lineage; and
8. required notification targets are available and a notification receipt can
   be recorded.

Any failed, unknown, or stale factor chooses a stricter outcome. There is no
best-effort downgrade from medium/high to automatic execution.

### Factor matrix

| Factor | Low / eligible for preauthorized auto action | Medium / human review | High or blocked / explicit human decision |
| --- | --- | --- | --- |
| Impact severity | Low, non-critical scoped impact | Customer-facing but bounded impact | SEV-1, data integrity, security, or broad customer impact |
| Evidence completeness and confidence | Fresh, complete, evaluator-accepted, deterministic gate passed | Causal mechanism proven but scope/impact needs review | Missing, conflicting, stale, or unsupported |
| Action risk | Typed, idempotent, reversible | Reversible but customer-path or operationally material | Destructive, irreversible, unbounded, or unknown |
| Blast radius | One component and one preauthorized environment | One production service or a bounded dependency group | Multiple services, regions, tenants, or shared data |
| Policy/allowlist | Exact active preauthorization | Exact allowlist but no active preauthorization | Outside allowlist or scope |
| Verification readiness | Fresh thresholds, rollback, and receipt all ready | Verification possible but needs human observation | No trustworthy post-action evidence |
| Failure history | Zero related repair/verification failures | No decisive prior result | Any related repair/verification failure |
| Owner/notification readiness | Required destinations have a recordable receipt | Owner is available for review | Owner/IC unavailable, or notification cannot be delivered |

### Permission matrix

| Risk class | Agent may inspect | Agent may propose | Agent may execute | Notification and human gate | Verification and rollback |
| --- | --- | --- | --- | --- | --- |
| Low | All bounded read-only evidence tools | Exact typed repair contract only | Only exact active preauthorized action; otherwise no | Notify owner/on-call and record receipt. Preauthorization is the human gate made before the incident. | Mandatory fresh verification and tested rollback; any failure escalates. |
| Medium | All bounded read-only evidence tools | Options with evidence, counter-evidence, blast radius, rollback, and verification | No | Explicit per-incident Owner approval is mandatory. | Mandatory fresh verification; failure blocks further automatic repair. |
| High / blocked | All bounded read-only evidence tools | Human-facing options or handoff/runbook only | Never through FlowPulse unless a future separately approved contract exists | Notify Incident Commander and owner; require explicit decision. | No claim of recovery without external receipt and fresh evidence. |

The current `checkout -> payment` case is medium risk: it changes a
customer-path flag and recreates checkout. It therefore retains the existing
per-incident Owner Gate even if its repair is reversible and allowlisted.

## Versioned preauthorization envelope

Preauthorization is a strict policy artifact, not a model preference. It is
created and revoked by a human-owned control-plane process and is evaluated
before any automatic action.

```json
{
  "schema_version": "flowpulse-preauthorization.v1",
  "id": "preauth-example",
  "policy_version": "1",
  "policy_sha256": "sha256:...",
  "status": "active",
  "issued_by": "authorized-owner",
  "issued_at": "RFC3339 timestamp",
  "expires_at": "RFC3339 timestamp",
  "environment": "exact environment identifier",
  "action_contract": {
    "repair_id": "allowlisted repair id",
    "command_id": "allowlisted command id",
    "target": "single component",
    "expected_before": "bounded expected value",
    "expected_after": "bounded expected value"
  },
  "limits": {
    "max_components": 1,
    "max_attempts": 1,
    "require_idempotency": true,
    "require_rollback": true,
    "require_fresh_verification": true,
    "require_notification_receipt": true
  },
  "required_verification_check_ids": ["bounded check ids"],
  "notification_targets": ["owner/on-call routing identifiers"]
}
```

The envelope is invalid if any field is missing, expired, revoked, ambiguous,
or differs from the proposed contract. A model cannot create, broaden, renew,
or select a preauthorization envelope. P0 may implement the schema and gate
with no production auto-remediation contracts enabled. The existing local
flagd/docker recovery remains medium risk and explicitly owner-gated.

## Evidence Track and Decision Ledger

The ledger remains immutable and append-only. The product projects a single
Evidence Track from existing events and the following minimal additions.

Every projected row has:

```text
event_id, run_id, sequence, occurred_at, stage, actor, event_type, status,
parent_event_id, evidence_refs, payload_sha256
```

Existing authoritative events retain their current meanings:

| Track concern | Existing event examples |
| --- | --- |
| Trigger and scope | `incident.opened`, `change.applied`, `evidence.snapshot.created` |
| Evidence work | `context.compiled`, `tool.called`, `evidence.queried` |
| Hypothesis and counter-evidence | `hypothesis.proposed`, `evaluation.rejected`, `evaluation.accepted`, `plan.revised` |
| Deterministic eligibility | `diagnosis.gate.passed` |
| Action and human authority | `repair.proposed`, `approval.requested`, `approval.granted`, `repair.executed` |
| Recovery and learning | `verification.completed`, `regression.created`, `backtest.completed`, `policy.evaluated` |
| Safe stop | `outcome.classified`, `failure.episode.recorded` |

P0 adds one decision event and three closely scoped outcome events:

```text
autonomy.decision.recorded
  schema_version
  policy_version, policy_sha256
  risk_class: low | medium | high | blocked
  factor_results: [{ id, observed, expected, passed, evidence_refs }]
  decision: observe_only | auto_execute_pre_authorized |
            human_review_required | explicit_human_decision_required | blocked
  evaluator_event_ref, diagnosis_gate_event_ref
  action_contract_ref, preauthorization_ref
  blast_radius, rollback_plan_ref, verification_plan_ref
  notification_targets, reason_codes

approval.rejected | approval.deferred
  owner, approval_request_ref, reason_code, requested_evidence_classes

notification.requested | notification.delivered | notification.failed
  route, target_ref, related_decision_ref, bounded receipt/status
```

The UI must show the factors and refs that produced a decision, not merely its
low/medium/high label. Missing or unavailable information is represented as
unknown/failed; it must not be normalized to passing.

## Knowledge and advisory experience

Past regression cases, runbooks, and retrieved knowledge can help the Agent
Workbench choose what to inspect or explain a recommended option. They are
advisory only.

- Advisory material is recorded separately as `advisory_refs` with source,
  version/hash, retrieval time, and relevance explanation.
- `advisory_refs` are never inserted into `evidence_refs`.
- Deterministic causal, repair, verification, and backtest validators resolve
  only immutable current snapshot evidence and checked-in contracts.
- A retrieved historical success cannot increase confidence, unlock repair,
  satisfy a missing precondition, or override counter-evidence.

P0 presents existing regression artifacts as advisory context where available;
P1 may add bounded retrieval. Neither path creates personalized memory.

## Minimal information architecture

Only three primary tabs are exposed:

| Primary tab | Preserved existing visual replay and details |
| --- | --- |
| Monitor | Architecture and Live canvas subviews, topology, freshness, component drawers, active incident strip |
| Agent Workbench | Diagnose replay, evidence drawer, tool/evaluator trace, Manager conversation, agent-role projection, stop reason |
| Decision & Recovery | Owner Gate, action options, execution receipt, verification, Compare, regression/backtest/policy |

The timeline remains available throughout the three stages and is driven by
ledger sequence, not animation time. Compare remains a Decision & Recovery
subview. The right contextual drawer changes emphasis by stage:

- Monitor: health, metrics, logs, traces, dependencies, source freshness.
- Agent Workbench: objective, selected/omitted evidence, tools, hypotheses,
  counter-evidence, evaluator, and why the harness stopped.
- Decision & Recovery: risk factors, exact contract, blast radius, approval,
  receipt, rollback, verification, and learning gates.

## P0 and P1 scope

### P0: competition-sized closure

1. Reorganize existing five primary modes into the three stages above while
   preserving every current replay/evidence surface as a subview.
2. Add deterministic `autonomy.decision.recorded` policy evaluation with the
   factor matrix and fail-closed behavior.
3. Add a versioned preauthorization envelope validator. No current flagship
   repair becomes automatic.
4. Add clear approve, reject, defer, and request-evidence decisions for
   medium/high review.
5. Add bounded Evidence Track projection and a compact Decision & Recovery
   explanation of why a run can or cannot proceed.
6. Add failure lockout after repair/verification failure and truthful
   notification/escalation state.
7. Correct misleading interaction copy and preserve existing Owner Gate,
   causal, verification, regression, and backtest gates.

### P1: after the competition

- Real paging/notification connectors and receipt integrations.
- Bounded advisory retrieval over regression/runbook knowledge.
- Policy authoring, revoke, expiry, and shadow-mode management UI.
- Multi-owner routing, RBAC, and external approval integrations.
- Additional typed Action/Verify connectors and production low-risk rollout.
- Cross-run statistics and policy candidate ranking.

### Explicit non-goals

- Broad severity-based auto-remediation.
- Free-form shell, Kubernetes, database, or production command execution.
- A generic connector marketplace, generic agent framework, or multi-agent
  fan-out requirement.
- Knowledge-base content as runtime evidence or repair authority.
- Automatic SEV-1 remediation.
- Repeated repair retries after a failed repair or verification.
- Replacing the ledger with Langfuse, a chat transcript, or a visual state
  store.
- Rewriting historical ledger rows to add autonomy metadata.

## Copy corrections

The product must not imply a model capability or authority it does not have.

| Current wording or implication | P0 replacement |
| --- | --- |
| `Run GPT-5.6` | `Start investigation` with current source/evidence readiness shown; use model identity only as secondary provenance. |
| `Recover` at the approval boundary | `Review recovery plan`; a separate explicit approval action must state the exact contract. |
| `Recovery Console` as a primary mode | `Agent Workbench` for evidence work, with decision and execution shown in Decision & Recovery. |
| `Live OTLP` without qualification | Show `live`, `captured`, `stale`, or `disconnected` plus freshness. |
| `Learning recorded` | `Regression recorded; policy <state>`. Never imply autonomous promotion. |
| Agent graph labels | Mark ledger-derived role projections separately from actual model/provider calls. |
| Kafka/downstream language in the real local path | Restrict real local claims to the proven checkout-to-payment mechanism; reserve broader Kafka/downstream propagation for the captured fixture. |

## Acceptance criteria and deterministic tests

### Product acceptance

- Exactly three top-level tabs are visible at 1440x900 and 1280x800; every
  existing evidence and replay surface remains reachable through a stage or
  drawer.
- Stage transitions are projected from ledger events and deterministic
  readiness checks.
- Every decision displays its factor results, evidence refs, action scope,
  blast radius, rollback, verification plan, and next human action.
- No current UI path labels captured evidence as live or an evaluator/model
  result as a repair execution.
- The checkout-to-payment action still requires per-incident Owner approval.

### Deterministic and mutation tests

- Changing any one low-risk factor to false/unknown blocks auto-execution.
- Severity alone cannot grant auto-execution.
- Expired, revoked, mismatched, cross-environment, multi-component, or
  over-attempt preauthorization fails closed.
- A medium/high decision has zero `repair.executed` events before an explicit
  `approval.granted` event matching the exact contract.
- Stale, disconnected, insufficient, or model-failure states have zero
  executable proposal/approval/execution events.
- Advisory references cannot satisfy diagnosis, causal, repair, verification,
  or backtest gates.
- A repair or verification failure forces human-required/blocked outcome and
  suppresses automatic retries and policy eligibility.
- Notification failure is visible; a production-like low-risk auto path cannot
  claim notification delivery without a bounded receipt.
- Existing exact-contract, owner-before-repair, fresh recovery, regression,
  executed-backtest, and captured-fixture rejection tests remain green.
- Accessibility checks cover keyboard stage switching, drawer focus, approval
  controls, reduced motion, and state labels that do not depend on color.

### Security tests

- Risk policy, preauthorization, and notification identifiers use strict
  bounded schemas and no untrusted free-form commands.
- New ledger/API projections contain safe IDs/hashes and bounded explanations,
  never raw provider output, credentials, raw OTLP, hidden reasoning, or
  notification secrets.
- A model cannot create/preselect a preauthorization envelope or change risk
  class through natural-language output.

## Rollout and shadow-mode safety

P0 ships decision transparency before broad autonomy:

1. Default every action to `human_review_required` unless an exact active
   preauthorization envelope passes all hard gates.
2. First run the autonomy decision in shadow mode: record the decision and
   explain what would have happened, but do not auto-execute.
3. Enable any low-risk automatic action only in an explicitly scoped
   disposable/development environment after deterministic mutation tests and
   owner review of the envelope.
4. Production-like low-risk automation requires a separate post-competition
   approval, notification receipt, rollback proof, and observed verification
   reliability. It is not enabled by this design.

This rollout preserves the stricter existing boundary whenever implementation
detail is ambiguous: no consequential remediation executes without an exact
allowlist, deterministic gate, and either a valid preauthorization envelope or
an explicit Owner Gate.

## Self-review

This specification has no TBD/TODO placeholders. It preserves the existing
append-only authority model, strong causal and recovery gates, deterministic
judge replay, and checkout Owner Gate. It does not broaden remediation
authority, make severity an authorization shortcut, or allow knowledge/history
to become evidence. P0 is limited to a three-stage product projection, one
deterministic autonomy decision boundary, one preauthorization schema/gate,
and transparent decision/exception states; connectors, production rollout,
and broad automation remain P1 or non-goals.

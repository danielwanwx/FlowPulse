# Agent-led Incident Workspace and Diagnosis Design

**Status:** Design for owner review. No product implementation is authorized by
this document.

**Baseline:** `19fd9ddd4606a92b3c7aac1b3859a6e6d602afa9` on
`codex/incident-workspace-unification`.

## 1. Decision, goals, and boundaries

FlowPulse will present three top-level views: **Architecture**, **Live**, and
**Incident**. Architecture explains the whole system. Live is the operational
graph. Incident is a focused, staged decision workspace for a selected
incident. The graph remains visible while the operator investigates, decides,
executes, and verifies; the right-side workspace is contextual rather than a
second dashboard.

The architecture is a deterministic incident shell with bounded agentic work:
Temporal owns the incident lifecycle; the backend validates agent proposals;
registered tools gather or act on evidence; the Evidence Ledger records the
result; and the browser renders only validated projections. This adopts the
useful role separation, structured outputs, and manager pattern described in
the 2026-07-25 orchestration research, without adding a second workflow engine
or treating an agent framework as authority.

### Goals

1. Make Live immediately legible: every visible node has an explained graph
   relationship or a visible category, and a real incident is perceivable
   without turning the graph into a noisy control plane.
2. Keep incident entry quiet and intentional. A new incident surfaces a small
   notification, not an automatic conversation, automatic investigation, or
   unsolicited agent activity.
3. Make node-scoped diagnosis useful. An operator who selects an impacted node
   gets one stable Conversation Manager, current component context, concise
   evidence-backed guidance, and no forced agent roster.
4. Preserve human authority. Read-only investigation and consequential changes
   have separate, durable approval gates. Neither a chat message, a card, nor
   an agent output can bypass them.
5. Use one shared capability and evidence runtime for autonomous diagnosis and
   interactive questions, so both paths cite the same current evidence and
   obey the same permissions.
6. Make recommendations executable only when a real backend capability,
   current evidence, required permission, and valid preconditions exist.
7. Support durable replay, audit, tenant isolation, and versioned evaluation
   across workflows, prompts, tools, policies, evidence schemas, and cards.

### Non-goals

- This design does not authorize a product-code change, a dependency choice,
  a Temporal migration, a provider migration, or deployment.
- It does not create an autonomous production repair path. All writes remain
  subject to a registered tool, dry run, preconditions, approval, and workflow
  revalidation.
- It does not add a free-form multi-agent debate surface, a second agent
  control plane, a second workflow/checkpoint engine, or a generic chatbot
  page.
- It does not make an agent session, SDK trace, browser cache, prompt, or
  Knowledge Plane entry into lifecycle state, authorization, or current proof.
- It does not require a complete topology to fabricate connection information;
  unavailable relationship data is shown as an explicit category instead.

### Scope

The future implementation includes Live graph presentation, Incident entry and
focus behavior, the right decision workspace, a strict card/recommendation
contract, a shared capability runtime, Temporal workflow boundaries, durable
evidence, API/event contracts, security, migration, and verification. It must
preserve the existing truthfulness rule: no fake success on a real path. A fake
result is permitted only when an explicit, separately labeled `demo` or `test`
mode is part of the validated run contract.

### Success criteria

- An operator can see why every Live node is visible, identify an impacted
  path, and open a node-scoped investigation without a noisy automatic agent
  response.
- The browser can render at most three server-validated, stage-allowed choices
  and never invent a recommendation or call an arbitrary tool.
- Gate 1 precedes fresh read-only investigation. Gate 2 precedes every real
  change, pull request, deployment, configuration mutation, rollback, or
  production mutation.
- Every displayed claim, recommendation, approval, action, and verification
  carries durable incident, component, tenant, version, and evidence lineage.
- A replay can reproduce workflow transitions and the exact versions of the
  prompt, tool schema, policy, context pack, and card schema used at the time.
- Current incident proof, not a historical knowledge answer, is required to
  pass an action or verification gate.

## 2. Product information architecture and Live graph

### Top navigation

The top navigation is exactly three compact controls in this order:

`Architecture | Live | Incident`

The active view has the existing selected treatment. There is no fourth
workspace slot, empty rail slot, placeholder label, or spacing reserved for a
removed view. Navigation does not mutate incident stage or begin an agent run.

### Live graph membership and relation rule

Each visible Live node must satisfy one of these mutually exclusive display
rules:

1. **Connected runtime node:** it has at least one backend-projected upstream
   or downstream relation, rendered with the canonical endpoint and relation
   type.
2. **Explicit classified node:** it has no currently renderable relation and
   exposes one backend-projected category label from this allowlist:
   `External dependency`, `Data store`, `Control plane`, `Observed boundary`,
   or `Relationship unavailable`.

The category is an explanation, not an inferred connection. A node cannot be
shown as a visually orphaned service with no relation and no category. The
backend graph projection contains `display_classification` for every node; the
browser rejects a node whose connection and classification are both absent.

### Status and flow

The graph renders only backend-projected runtime state. Status is perceptible
through a compact label, status dot, and subdued flow treatment. Healthy or
active relations have a sparse moving current; degraded relations slow or
break; unavailable data is static and labeled. The motion illustrates an
already-projected relation and never creates telemetry, a lifecycle transition,
or a claim. Reduced-motion mode renders the final status without moving
packets.

An incident node uses a restrained red glow around the existing node geometry.
Its affected canonical relation(s) receive a matching red path emphasis. The
glow is reserved for a server-projected active impact; it is not a client-side
alert color chosen from text or a stale cached event. Normal service state
continues to use the established visual language.

## 3. Incident entry, focus, and human gates

### Entry behavior

When the backend accepts a new incident, Live remains selected and unchanged.
The product displays one lightweight, dismissible top-left toast with English
only copy, for example:

> **Checkout payment incident detected**
>
> Select to focus the affected path.

The toast has a single `Focus incident` action and expires visually without
discarding the durable incident. It does **not** open a conversation, issue a
tool request, create an agent session, begin an investigation, or change the
user's workspace.

Selecting the toast enters Incident and focuses the exact backend-projected
impacted node and relation IDs. It does not select a node for chat. The
operator may choose the red node to open its scoped context. A global incident
summary remains available from an explicit `Incident summary` control, but is
never automatically opened or pinned over the canvas.

### Node-scoped Agent context

Selecting an impacted red node opens the right-side decision workspace with
that canonical `component_id` and selected incident identity, then creates one
idempotent `node_explanation` Conversation Manager turn. The turn streams a
short component-specific explanation and one clear next step, normally
`Request investigation access` when Gate 1 is absent. This is the only
automatic chat behavior: toast focus alone never creates a conversation,
invokes a model, or begins an investigation.

The node explanation is constrained to the validated canonical projection,
recorded Evidence Ledger entries, and Component Context Pack priors explicitly
labeled as priors. It cannot call a fresh read tool before Gate 1, claim that a
fresh diagnosis has run, infer unrecorded telemetry, or propose an executable
fix. It is a concise explanation of the selected component's recorded state,
not an investigation result.

The backend deduplicates this turn with a durable selection key:

```text
node_explanation:{tenant_id}:{run_id}:{projection_revision}:{component_id}:{conversation_schema_version}
```

One node click creates or resumes at most one turn for that key. Repeated
clicks, reload/hydration, SSE replay, and duplicate events return the recorded
turn rather than starting another model run. A different component or a
user-initiated selection after a different projection revision receives a new
key. The browser renders the server-projected stream and never manufactures a
local explanation.

Before Gate 1, the panel may show the last validated incident projection and
bounded Knowledge Plane priors, explicitly labeled as non-current context. It
cannot obtain fresh metrics, logs, traces, topology expansion, deployment
state, configuration state, Kafka state, or ticketing state. It must present a
single available next step: `Request investigation access`.

### Human gate 1 — investigate

Gate 1 is a Temporal-accepted, tenant-scoped, incident-scoped approval that
must exist before the system performs a fresh read-only investigation. It is
required for automatic diagnosis and for user-initiated queries that would
call a read capability. It records:

- the requester and approving principal;
- `incident_id`, `run_id`, optional `component_id`, tenant, and environment;
- allowed read-capability scopes and data classification;
- policy version, context-pack version, and evidence snapshot revision;
- `approved_at`, `expires_at`, and revocation state.

The default Gate 1 TTL is **30 minutes**. Every read tool invocation checks
that the gate is unexpired, matches the tenant/environment/component scope, and
is permitted by the selected capability. A changed incident revision, changed
scope, revoked approval, or expired TTL invalidates the gate for a new read.
Existing immutable evidence remains viewable but cannot be represented as a
fresh investigation result.

### Human gate 2 — fix and mutation

Gate 2 is the Owner Gate for a specific, validated action plan. It is required
before a real fix, pull request, deployment, configuration change, production
mutation, or rollback execution. The default Gate 2 TTL is **15 minutes** and
is shorter if the capability's policy requires it. It binds:

- action ID, capability ID and version, target component and tenant;
- plan hash, dry-run result hash, rollback plan hash, and risk class;
- exact preconditions and evidence snapshot revision;
- requester, approver, policy version, approval time, expiry, and revocation.

Approval is not reusable after a plan, target, capability version, critical
precondition, tenant, or referenced evidence change. At execution time the
backend reruns validation and the tool adapter reruns live preconditions; any
mismatch, expiry, or failed dry run returns the workflow to Decide with an
explicit invalidation reason. The browser cannot retry execution by replaying a
button click.

## 4. Right-side decision workspace

The right-side workspace is the only persistent interactive surface in
Incident. Its normal width is approximately **430 px**. A report-focused
response may expand it to approximately **560 px**; the expansion is tied to
the active report and returns to normal when the report is closed. The graph
retains the remaining canvas and is never replaced by a full-width chat page.

The persistent structure contains only:

1. current component/incident context;
2. the stable Conversation Manager conversation;
3. a fixed composer for that conversation.

It does not permanently display a Verification Summary, Agent roster, or
Evidence Ledger. Those become compact, on-demand structured cards or
disclosures inside the active conversation only when relevant. There is no
always-open generic team home, no repeated status dashboard, no gray eyebrow
labels, and no exposed model/provider/internal-agent context.

### Content rules

- Start every response with one short, operator-facing sentence.
- Use a rich structured card only when it conveys an actionable claim,
  decision, comparison, approval, action progress, or verification outcome.
- Keep raw technical details, citation metadata, tool count, timestamps, and
  redacted source details behind one `Show evidence` disclosure. The disclosure
  lists readable evidence summaries plus bounded references; it never exposes
  secrets, raw payloads, chain-of-thought, or internal prompts.
- All product-visible copy, labels, examples, cards, errors, and empty states
  are English only. The product never emits localized or mixed-language sample
  copy through this contract.
- Empty or degraded state is explicit and useful: for example, `Current
  telemetry is unavailable. Review the recorded evidence or try again after
  access is restored.`

### Follow-up carousel

The backend may return zero to three follow-ups. They render as large vertical
cards in a horizontal carousel, with one card marked `Recommended` at most.
Each card has one concise title, one useful component-specific sentence, and
one CTA. The carousel never contains a fourth card, a compact chip grid, or a
free-form generated action type. Example English-only cards:

| Title | Useful sentence | CTA |
| --- | --- | --- |
| `Find Cause` | `Collect fresh traces and resolver errors for Payment.` | `Request investigation access` |
| `Review Fix` | `Check the dry-run impact before requesting approval.` | `Review fix` |
| `Compare Recovery` | `Compare the failed and recovered snapshots using fresh verification evidence.` | `Compare recovery` |

Keyboard controls announce the selected card position and recommendation;
touch and pointer navigation preserve the same ordering. A click submits the
server-issued action ID for revalidation; it is never a direct tool call.

## 5. Fixed stage-card taxonomy

Cards have a fixed taxonomy. The agent may select from the current stage's
allowlist, order up to three returned cards, mark at most one recommended, and
fill only the one-sentence component-specific summary. It may select one
registry-compatible CTA behavior, but cannot invent a title, card type, fourth
card, new stage, capability name, CTA behavior, or CTA text.

| Stage | Allowed card types |
| --- | --- |
| Investigate | `Find Cause`, `Map Impact`, `Review Evidence` |
| Decide | `Review Fix`, `Compare Options`, `Approve Plan` |
| Execute | `Apply Fix`, `Track Progress`, `Prepare Rollback` |
| Verify | `Compare Recovery`, `Check Risk`, `Close Incident` |

The backend validates `card_type` against this table and derives the displayed
English title exactly from that type. CTA behavior is also a closed schema,
not model text. The action schema carries one of these behaviors and the
backend derives its fixed English label:

| CTA behavior | Fixed label |
| --- | --- |
| `request_gate_1` | `Request investigation access` |
| `run_read_capability` | `Investigate` |
| `review_evidence` | `Review evidence` |
| `review_fix` | `Review fix` |
| `compare_options` | `Compare options` |
| `request_gate_2` | `Request plan approval` |
| `submit_approved_action` | `Apply approved fix` |
| `track_progress` | `Track progress` |
| `prepare_rollback` | `Prepare rollback` |
| `compare_recovery` | `Compare recovery` |
| `check_risk` | `Check risk` |
| `close_incident` | `Close incident` |

The registry defines which CTA behaviors are compatible with each card type,
stage, capability, and gate state. An agent output that contains an unknown
type, duplicate type, more than three cards, more than one recommendation,
unsafe summary, unsupported CTA behavior, or a CTA without a registered
capability is rejected. The browser renders only the backend-derived fixed
title and CTA label, the validated dynamic summary, and the server-issued
`action_id`.

## 6. UX state machine

The visual state and the authoritative workflow state are deliberately
separate. The browser may change focus/panel state locally; it cannot change
incident lifecycle state. The following is the user-visible state machine:

| UI state | Entry | Allowed user action | Exit |
| --- | --- | --- | --- |
| `LiveNormal` | No active incident focus | Inspect graph | Backend incident signal creates `IncidentToast` |
| `IncidentToast` | New server-projected incident | Dismiss or `Focus incident` | Dismiss returns `LiveNormal`; focus enters `IncidentFocused` |
| `IncidentFocused` | Toast focus or Incident navigation | Select impacted node; open global summary | Node selection enters `NodeExplanationStreaming` |
| `NodeExplanationStreaming` | Impacted node click with a new or resumable selection key | Read the recorded component explanation; request Gate 1 | Server streams/reuses exactly one scoped turn, then enters `NodeContext` |
| `NodeContext` | Node explanation is terminal | Read current projection; request Gate 1; ask bounded non-tool question | Gate 1 grant enables `InvestigateReady` |
| `InvestigateReady` | Valid Gate 1 | Submit question; choose read action | Validated result or invalidation updates projection |
| `DecideReady` | Backend accepts a proposal | Review options; request Gate 2 | Approved, current Owner Gate enables `ExecuteReady` |
| `ExecuteReady` | Valid Gate 2 and preconditions | Submit the approved action | Activity progress or invalidation updates projection |
| `VerifyReady` | Recorded execution completion | Request independent verification | Fresh verdict updates projection |
| `Closed` | Temporal accepts verified closure | Review report | New incident signal creates a new toast |
| `Degraded` | Capability, stream, permission, or schema unavailable | Review recorded evidence; retry an allowed refresh | Valid recovery returns to the prior compatible state |

`IncidentFocused`, `NodeExplanationStreaming`, `NodeContext`, and panel width
are browser presentation state keyed by canonical run and component IDs. The
durable explanation-turn key prevents a reload or duplicate stream frame from
producing another automatic turn. Stage, approval, plan, execution, and
verification states are read from the canonical backend projection only.
Cross-run navigation clears local panel/conversation focus unless the new run
explicitly carries the same valid component identity.

## 7. Domain and data models

All records are tenant-bound, versioned, and immutable or append-only where
their content supports a decision. IDs shown below are opaque; product cards do
not expose raw IDs.

### Canonical incident projection

```text
IncidentProjection
  tenant_id
  incident_id
  run_id
  projection_revision
  lifecycle_stage: investigate | decide | execute | verify | closed | needs_human
  state: active | degraded | recovered | closed | needs_human
  impacted_node_ids[]
  impacted_edge_ids[]
  graph_snapshot_ref
  gate_1: GateProjection
  gate_2: OwnerGateProjection
  proposal_ref?
  execution_ref?
  verification_ref?
  evidence_snapshot_ref
  version_bundle: VersionBundle
```

### Component Context Pack

```text
ComponentContextPack
  tenant_id
  component_id
  component_type
  version
  ownership: team, escalation, environment scope
  slos[]
  dependencies[] and dependents[]
  expected_signals[]
  known_failure_modes[]
  approved_playbooks[]
  allowed_capability_ids[]
  data_classification
  expires_at?
```

The pack is a bounded operational prior. It can explain what a component is,
what it normally depends on, and which tools are eligible. It cannot assert
that a failure exists now, satisfy an action precondition, satisfy verification,
or grant a permission.

### Evidence and claim lineage

```text
EvidenceRecord
  evidence_ref
  tenant_id, incident_id, run_id, component_id?
  capability_id, capability_version, adapter_version
  query_input_hash, normalized_result_hash, raw_result_pointer?
  observed_at, retrieved_at, freshness_expires_at
  source_classification, schema_version
  parent_evidence_refs[]
  trace_id?

Claim
  claim_id
  tenant_id, incident_id, run_id, component_id?
  kind: observation | hypothesis | proposal | action_result | verification_verdict
  statement
  evidence_refs[]
  actor_kind: system | agent | tool | human
  version_bundle
```

An Evidence Ledger record is immutable after append. Large raw data belongs in
approved object storage and is addressed by a protected pointer; its normalized,
redacted result and hash are durable in the ledger. A claim lacking valid,
tenant-matching current evidence references cannot satisfy a lifecycle gate.

### Version bundle

```text
VersionBundle
  workflow_version
  policy_version
  core_policy_version
  role_prompt_version
  context_pack_version
  capability_registry_version
  tool_schema_version
  evidence_schema_version
  card_schema_version
  model_policy_version
```

Temporal history stores this bundle and immutable references/hashes, rather
than raw prompts, raw telemetry, or complete model transcripts.

## 8. Shared capability runtime

Automatic diagnosis and user Q&A use the same runtime. The only distinction is
intent and workflow entry point; neither path gets a hidden privileged tool.

### Capability Registry

Each registered capability declares:

```text
CapabilityDefinition
  capability_id, version, adapter_id
  mode: read | write
  compatible_component_types[]
  allowed_stages[]
  required_permissions[]
  input_schema, output_schema
  data_classification
  freshness_requirement
  timeout, retry_policy, cost_limit
  requires_gate_1
  requires_gate_2
  supports_dry_run
  required_preconditions[]
  rollback_contract?
```

The initial registry family covers metrics, logs, traces, topology,
deploy/configuration state, Kafka, GitHub/ticketing, and explicitly safe
actions. The registry exposes only capabilities with a real adapter, current
tenant authorization, valid schema, and compatible state. It does not expose a
capability solely because an agent mentioned it.

### Tool adapters

Tool adapters make tenant-aware, idempotent calls to the real source and return
typed normalized results. Read adapters require Gate 1 when they fetch fresh
incident data. Write adapters always require dry run when supported, explicit
preconditions, Gate 2, idempotency keys, and an approved rollback contract
where the risk class requires it. A write adapter cannot be selected by the
browser or an agent directly; it is invoked only by a Temporal Activity after
the workflow accepts the action.

Every adapter result creates Evidence Ledger lineage. Every answer and
recommendation cites those evidence references or states that only a bounded
prior is available. Tool failure, redaction, stale data, partial data, and
unavailable credentials are typed results, not permission to fabricate an
answer.

## 9. Agent architecture and layered context

### Tracks and roles

The autonomous diagnosis track contains four independent roles:

| Role | Bounded responsibility | Cannot do |
| --- | --- | --- |
| Orchestrator | Select bounded investigation tasks and synthesize structured proposals | Grant approval, mutate, or advance workflow |
| Investigator | Gather allowed current evidence and form a causal hypothesis | Trust its own hypothesis as verified truth |
| Critic | Independently seek counter-evidence, gaps, and unsupported jumps | Reuse Investigator reasoning as its verdict |
| Verifier | Independently evaluate fresh post-execution recovery criteria | Run before recorded execution or accept stale evidence |

Critic and Verifier use distinct prompts, independent Activity invocation IDs,
and independent structured output schemas. They may cite the same ledger
records, but cannot receive the other role's hidden reasoning or inherit a
pass/fail result. Verifier is invoked only after a recorded execution and uses
fresh evidence under a verification-specific policy.

The interactive track has one stable **Conversation Manager** as the visible
speaker. Investigator, Critic, Verifier, and Component Expert are bounded
agents-as-tools. They return schemas to the Conversation Manager, which
produces the concise user-facing response and candidate cards. There are no
implicit visible handoffs. A specialist may be disclosed as an evidence source
inside `Show evidence`, not as a new chat owner.

### Layered prompt/context assembly

Every agent Activity receives this ordered assembly:

1. **Core Policy** — safety, redaction, evidence, authority, language, and
   output constraints shared by every role.
2. **Role Prompt** — only the role's bounded objective, stop conditions, and
   output schema.
3. **Component Context Pack** — ownership, SLOs, dependencies, signals,
   failure modes, playbooks, and allowed tools for the selected component.
4. **Incident State** — canonical incident/run/stage, impacted identity,
   active gates, accepted claims, and allowed action scope.
5. **Intent State** — user question, requested outcome, selected card, and
   conversation state.
6. **Shared runtime/evidence** — capability availability and bounded current
   evidence references/results permitted to the role.

The system persists the Version Bundle and hashes of each assembled layer for
replay evaluation. The agent receives a constrained output schema; its model
text cannot declare authority, introduce a tool, or emit a browser card outside
the fixed taxonomy.

### Knowledge Plane boundary

The Knowledge Plane contains vetted runbooks, service descriptions, past
incident patterns, and other bounded priors. It may improve a question,
component explanation, investigation hypothesis, or candidate plan. It is
never current incident proof. A Knowledge Plane answer cannot open Gate 2,
satisfy an action precondition, claim current health, mark verification passed,
or close an incident. Those gates require tenant-matching, current, ledgered
evidence from a registered capability or a validated human approval.

## 10. NextBestAction contract and invalidation

The frontend does not hard-code a recommendation. It receives only a
backend-validated `NextBestAction[]` after the backend combines selected
component, current incident state, real evidence, applicable capabilities,
permissions, and explicit user intent.

```text
NextBestAction
  action_id
  tenant_id, incident_id, run_id, projection_revision
  component_id
  stage
  card_type
  recommended: boolean
  title: backend-derived fixed title for card_type
  summary
  cta_behavior
  cta_label: backend-derived fixed label for cta_behavior
  capability_id, capability_version
  evidence_refs[]
  evidence_snapshot_version
  risk_class
  required_permissions[]
  approval_requirement: none | gate_1 | gate_2
  preconditions[]
  dry_run_requirement: required | optional | unsupported
  policy_version, prompt_version, tool_schema_version, card_schema_version
  issued_at, expires_at
  invalidation_keys[]
```

`summary` is the only agent-generated display copy and is a safe English string
bounded by schema length and vocabulary policy. `title` and `cta_label` are
backend-derived fixed strings from the card and CTA behavior tables. `card_type`
must be allowed for the current stage. `capability_id` must resolve to a real,
enabled registry entry. If there is no compatible real capability, the backend
returns no action rather than a decorative button.

The backend invalidates an action when any bound projection revision, evidence
snapshot, gate status, capability/policy/schema version, permission, selected
component, incident stage, dependency state, or TTL changes. The browser drops
expired or revision-mismatched actions before display and requests a refreshed
projection; it never attempts a stale action optimistically.

On click, the browser sends only `action_id`, the current canonical identity,
and an idempotency key to a backend action endpoint. The backend reloads the
action, rechecks tenant scope, stage, capability, evidence freshness,
permissions, TTL, gates, and preconditions, then asks Temporal to accept or
reject the resulting workflow update. The endpoint cannot accept arbitrary
tool names, component IDs, card types, or raw action payloads from the browser.

## 11. Temporal authority and execution model

Temporal is the sole incident lifecycle authority. There is no second
workflow engine, no free-form multi-agent control plane, and no agent-owned
state transition path.

```text
Agent proposes structured result/action
          ↓
Backend validates schema, registry, evidence, policy, and tenant scope
          ↓
Temporal accepts or rejects the legal transition
          ↓
Activity invokes registered tool adapter when authorized
          ↓
Evidence Ledger appends immutable result and lineage
          ↓
Temporal accepts the next lifecycle transition
          ↓
Backend publishes canonical projection to browser
```

### Workflow state and message contracts

The workflow owns legal stages, active gate state, accepted proposal/action
references, idempotency, retry/timeout state, rollback status, and closure.
It uses:

- **Queries** for read-only canonical incident, action, and panel projections.
- **Signals** for asynchronous incident detection, telemetry/source
  availability changes, execution progress, and verified external events.
- **Updates** for validated, durable requests such as `request_gate_1`,
  `grant_gate_1`, `request_owner_gate`, `grant_owner_gate`,
  `submit_action`, `cancel_action`, and `close_incident`.

Each Update validates identity, tenant, authorization, expected lifecycle
stage, expected projection revision, and idempotency before changing state. It
returns a typed accepted, rejected, pending, or invalidated result. A Signal is
asynchronous and never grants approval by itself.

All LLM calls, tool calls, database/API operations, evidence normalization,
and external notifications run in Activities with explicit timeouts, bounded
retries, cancellation handling, and idempotency keys. Workflows store only
references, hashes, compact state, versions, and decisions. Sessions, SDK
guardrails, traces, and provider metadata assist an Activity but are never
lifecycle state, evidence truth, or authorization authority.

## 12. API, event, and projection contracts

The exact routes are an implementation decision, but their semantics are
fixed. Any wire schema is additive/versioned and validates unknown fields
fail-closed at authority boundaries.

| Contract | Purpose | Authority rule |
| --- | --- | --- |
| `IncidentProjection` read | Read canonical graph, stage, gates, evidence and actions | Query-derived; browser may not compose it |
| `ComponentContext` read | Read the bounded pack for selected component | Priors only; no current-proof or authority use |
| `ConversationTurn` submit | Submit a user intent to Conversation Manager | Backend validates identity, language, rate limit, and allowed intent |
| `NodeExplanation` start/reuse | Start or resume the one scoped turn caused by an impacted-node click | Durable selection key permits projection/recorded-evidence/prior context only; no fresh read capability |
| `NextBestAction[]` read | Return backend-validated follow-ups | No action without capability/evidence/permission/TTL |
| `ActionSubmit` update | Submit a server-issued action ID | Backend and Temporal revalidate before Activity work |
| `Approval` update | Grant, reject, edit, revoke a gate | Temporal records scope, TTL, and policy binding |
| `IncidentEvent` stream | Push canonical projection revisions or degraded notices | Sequence/revision bound; stale frames never overwrite current state |

Event envelopes include `tenant_id`, `incident_id`, `run_id`,
`projection_revision`, monotonic `sequence`, `schema_version`, `event_type`,
and a bounded payload. The browser pins the selected run and accepts an event
only when tenant, run, sequence, schema, and revision ownership validate. A
network/SSE failure is an accessible stale state and rehydrates only the pinned
identity with bounded retry; it never swaps in another run's graph or action.

## 13. Security, tenancy, and degraded behavior

### Tenant and authorization isolation

- Tenant identity is resolved server-side from authenticated principal/context,
  not accepted from browser-provided identifiers.
- Every projection, context pack, evidence record, action, gate, Activity,
  adapter call, storage pointer, stream, cache entry, and idempotency key is
  tenant-scoped. Cross-tenant references fail closed.
- Capability Registry evaluation intersects role, user permission, tenant
  policy, environment, component type, data classification, stage, and active
  gate. An unavailable capability is omitted rather than named as usable.
- Evidence access applies source-specific redaction before the model and
  browser. Raw logs, trace bodies, credentials, source code, prompts,
  chain-of-thought, and provider payloads are not product-visible evidence.

### Failure and degraded modes

| Condition | Required behavior |
| --- | --- |
| No Gate 1 | Show recorded projection/priors only; no fresh read tool call |
| Evidence stale, missing, or tenant-mismatched | Invalidate dependent claims/actions; explain that current proof is unavailable |
| Capability unavailable or schema invalid | Omit action, preserve last valid evidence with freshness label, show concise degraded state |
| Agent failure or malformed output | Record a bounded failure event; return no invented card/action; workflow remains authoritative |
| Tool timeout or partial result | Record typed result and lineage; do not convert partial data into passed gate proof |
| Gate 2 expired/precondition failed | Block execution; return to Decide with invalidation reason and no retry button that bypasses revalidation |
| Stream/reload failure | Keep pinned last validated projection marked stale; bounded rehydrate retry; never claim live success |
| Verification inconclusive or failed | Stay in Verify or return to Decide per Temporal policy; never show recovered/closed |

## 14. Observability, durability, and replay

Each workflow transition and Activity links a correlation ID, tenant/run/incident
identity, Version Bundle, capability/tool version, action ID, evidence refs,
idempotency key, and tracing ID. Metrics measure gate latency, recommendation
eligibility/expiry, capability availability, evidence freshness, adapter
latency/error, tool denial, action rejection, stale-stream recovery, and
verification outcomes. Logs are structured and redacted.

Replay uses Temporal event history plus immutable ledger references and pinned
versions. A replay evaluator can reconstruct the allowed context and compare
the original structured output, action eligibility, independent critic/verifier
result, and resulting workflow transition. It must not re-run a write Activity
or use a current Knowledge Plane document as historical proof. Read replay may
use the recorded normalized evidence snapshot only.

## 15. Migration and rollout boundary

This design is a forward contract, not a silent rewrite. Rollout proceeds only
after owner review and an implementation plan.

1. Introduce versioned read models and registry/ledger records behind a
   compatibility boundary. Existing canonical run identity and truth gates
   remain authoritative until an explicit cutover.
2. Add the Live graph classification fields and passive Incident toast first;
   neither starts diagnosis nor changes authority.
3. Add the node-scoped decision workspace in read-only projection mode, then
   Gate 1 and registered read capabilities.
4. Add structured `NextBestAction[]`, fixed card validation, and the
   Conversation Manager only after their schemas, evidence lineage, and
   invalidation tests exist.
5. Add Gate 2, dry-run write capability contracts, and Temporal Updates before
   any real mutation UI is exposed. Start with explicitly labeled demo/test
   actions only until production adapter acceptance is separately approved.
6. Migrate by tenant/environment with dual-read comparison and audit. A
   rollback returns the browser to the last compatible canonical projection;
   it does not discard ledger history or active approvals.

No migration may reinterpret existing replay records as production authority,
retroactively grant a gate, alter an existing evidence hash, or silently map a
legacy approval endpoint to the new Owner Gate.

## 16. Verification plan and acceptance criteria

### Contract and durability tests

1. **Workflow durability/replay:** interrupt before and after each gate,
   restart workers, replay history, and prove the same legal stage/gate/action
   state without duplicate tool or write execution.
2. **Evidence lineage:** reject claims/actions/verification verdicts with
   missing, stale, cross-run, cross-component, cross-tenant, wrong-version, or
   unregistered evidence. Prove displayed `Show evidence` references resolve
   to redacted durable records.
3. **Tenant isolation:** attempt every read, stream, cache, context pack,
   action, approval, and evidence reference across tenants; all must fail
   closed with no metadata leakage.
4. **Knowledge Plane boundary:** demonstrate that a correct historical runbook
   alone cannot open Gate 2, meet an action precondition, pass verification, or
   close an incident; demonstrate that current registered evidence can.
5. **Independent roles:** inject an Investigator false positive and prove
   Critic can reject it; inject a post-action false recovery claim and prove
   Verifier requires independent fresh evidence.
6. **Gate contracts:** verify Gate 1 scope/TTL/revocation and Gate 2 exact
   plan, dry-run, precondition, risk, tenant, version, expiry, and atomic
   revalidation behavior.
7. **Safe action contracts:** prove an unavailable capability yields no card;
   read tools require Gate 1; write tools require dry run, preconditions, Gate
   2, idempotency, and a rollback contract when required; fake paths require
   explicit demo/test mode.
8. **Schema and migration:** reject unknown/malformed contract fields at
   authority boundaries; prove old projection readers do not gain write
   authority and dual-read projections preserve canonical identity.

### Browser and interaction tests

1. Live contains only connected or explicitly classified visible nodes; the
   active incident has a red node glow and affected-path emphasis; reduced
   motion is static and accessible.
2. A new incident produces only the top-left toast. It does not navigate,
   send a chat message, create a conversation, invoke an agent, or collect
   fresh evidence. Selecting it focuses the exact impacted path and still
   creates no conversation or automatic turn.
3. Selecting a red node opens the 430 px node context and creates/streams
   exactly one idempotent, component-scoped Conversation Manager explanation;
   it uses only canonical projection, recorded evidence, and labeled priors,
   with no Gate 1 read tool call or fresh-diagnosis claim. Reload, duplicate
   SSE frames, and repeated node clicks reuse that turn rather than create
   another. Report mode expands to 560 px; neither mode mounts a persistent
   roster, ledger, or verification panel.
4. Gate 1 absence exposes only recorded evidence/priors and `Request
   investigation access`; a fresh tool request remains blocked. A valid grant
   enables only the scoped reads.
5. Follow-ups render zero to three vertical carousel cards, use only the fixed
   taxonomy for the current stage, have at most one recommendation, and use
   English-only copy. Unknown card/action schemas render nothing actionable.
6. Card click submits its server-issued action ID and shows the backend result;
   stale revision, changed evidence, expired TTL, failed precondition, or
   missing permission invalidates it rather than calling a tool.
7. Gate 2 and execution use an approved dry-run plan; failed verification is
   visibly failed with operator guidance and never claims recovery.
8. SSE/reload preserves pinned canonical run/node/edge/revision identity and
   exposes stale/reconnecting status accessibly without cross-run overwrite.

### Final acceptance criteria

- All product-visible examples and generated copy are English only.
- Architecture, Live, and Incident retain a compact three-tab navigation with
  no empty placeholder slot.
- All lifecycle transitions, gates, write actions, and closure outcomes are
  Temporal-accepted and evidence-backed; no agent, browser, session, trace,
  or Knowledge Plane item is an authority shortcut.
- Every recommendation resolves to a real, authorized capability or is absent.
- Full contract, backend, migration, focused UI, browser, accessibility,
  reduced-motion, and replay tests pass before any production rollout.

## 17. Review gate

This commit is intentionally documentation-only. The next permitted step is
owner review of this specification. After approval, a separate implementation
plan may identify bounded milestones, compatibility decisions, test-first
changes, and explicit rollout authority. No implementation, merge, push,
deployment, or capability enablement follows from this document alone.

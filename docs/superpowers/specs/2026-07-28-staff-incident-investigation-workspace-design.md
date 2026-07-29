# Staff Incident Investigation Workspace

**Status:** Approved design. This document authorizes no implementation by
itself.

**Baseline:** frontend `b9272a51d65279a830e2092d8859cce3d06f4d51`; control
plane contract `flowpulse-incident-workspace-v1` v1.2.

## Decision and scope

FlowPulse keeps the same three compact top-level controls in every view:
**Architecture | Live | Incident**. Architecture and Live are frozen. Incident
is the only surface redesigned by this decision, and it stops at
**Investigate → Decide**. There is no Gate 2, recovery, execution,
verification, mutation, or remediation CTA in this slice.

Incident is an accident-reconstruction workspace for a Staff on-call engineer.
It renders server-owned evidence and workflow state; it does not infer a root
cause, manufacture a user path, synthesize a recommendation, or turn an agent
response into lifecycle authority. Temporal remains the only lifecycle
authority. The browser is a strict projection, interaction, and fail-closed
presentation layer.

## The on-call attention sequence

The workspace follows this reading order. Each answer has an explicit owner.

1. **What happened?** The server-provided `operator_title` and
   `operator_summary` state the incident without raw IDs.
2. **How did it propagate?** The incident canvas shows only the server-audited
   impacted nodes and relations.
3. **Where should I look?** The server's current focus recommendation selects
   the starting component and supplies one concise rationale. The browser does
   not choose a root component from graph position, text, or a heuristic.
4. **What does the agent know and not know?** Selecting an impacted component
   displays its durable node explanation, its recorded evidence references,
   and explicit unknowns. It does not claim a fresh diagnosis before one has
   occurred.
5. **Is a fresh read needed?** The backend-issued Gate 1 card states the
   exact scope, TTL, data targets, preconditions, and permission. The browser
   never grants the gate or starts a fresh read.
6. **What changed after the read?** Ordered case SSE causes a canonical
   projection rehydrate. The UI changes only from the resulting projection,
   receipt, and durable evidence—not a simulated timer or receipt prose.
7. **Is the evidence strong enough to decide?** The backend result supplies
   observations, hypotheses, uncertainty, evidence freshness and source, and
   the independent critic outcome.
8. **What is the handoff?** In Decide, the panel summarizes the strongest
   server conclusion, its supporting evidence, residual uncertainty, and why
   the present evidence is safe or unsafe to proceed with. It offers no
   remediation action.

## Incident composition

### Canonical incident graph

The Incident graph contains exactly the six backend-impacted components and
the five backend-audited incident relations for the selected canonical case:

```text
Frontend → Checkout → Payment
             │
             └→ Kafka → Accounting
                     └→ Fraud Detection
```

This diagram is a visual arrangement, not an authority claim. Checkout is the
visual center; Frontend is upstream to its left, Payment is downstream to its
right, Kafka is below Checkout, and Accounting and Fraud Detection branch
directly from Kafka. The actual visible names always come from server `display_name`.
The canvas contains no other system nodes, relationships, or client-created
edges. The remaining 16 projected components remain available only in
Architecture and, when connected, Live.

The graph reuses the former Diagnose composition: generous clear space around
the central Checkout card, smooth directional connectors, restrained status
color, and a red impact treatment for the six incident components and five
relations. It must not reuse the dense 22-node grid. A selected node receives
the visible selection treatment without hiding the propagation path.
Non-graph facts belong in the collaboration panel, not in extra graph cards.

### Desktop and narrow layout

Desktop reading order is **page header → compact stage rail → graph → bounded
right collaboration panel**. The stage rail sits in document flow below the
title; it never overlays or clips the title. The graph remains primary. The
right panel is approximately 430 px wide, with an opaque boundary and its own
clear hierarchy.

At 451 px wide, Incident becomes one vertical document: **header → compact
stage rail → horizontally reachable graph region → collaboration panel**. The
graph and panel never occupy the same painted space. The graph may scroll
inside its own bounded region; the page must not gain accidental horizontal
overflow. The panel follows the graph in normal document flow, has an opaque
background, and all content is reachable with ordinary vertical scrolling.

Reduced-motion mode keeps the same status hierarchy but removes pulses and
animated current markers. Keyboard focus follows the selected component and
stage state. Every interactive graph node, disclosure, and card has a name,
focus treatment, and deterministic tab order.

### Collaboration panel

The panel keeps the current collaboration capabilities but adopts the
restrained former Agent Bar language: one quiet component context, a durable
conversation area, and a single action area. It is not a generic control-plane
dashboard.

The default view is the selected component explanation/dialogue. It shows
`Created` or `Reused` from the durable node-explanation receipt, a concise
known/unknown summary, and the server-provided affected user path when one is
available. Investigation result, evidence, and critic information are
subordinate collapsible sections. Primary copy uses operator-facing text and
server `display_name`; run, tenant, workflow, evidence, and provider IDs stay
behind an explicit evidence/details disclosure.

## Interaction and authority contract

| Operator or system event | Frontend behavior | Backend truth required |
| --- | --- | --- |
| Passive incident notification | Show one quiet toast and prefetch the canonical projection. | Global incident SSE notification and projection. |
| `Focus incident` | Select the already cached case and incident path. It makes zero explanation, tool, action, or fresh-read requests. If the projection is absent, show loading/stale and wait for hydration. | Canonical case identity and audited incident focus data. |
| Click an impacted node | Start or reuse one durable node explanation keyed to tenant, incident, run, revision, and component. Render only the receipt and subsequent ordered case events. | `POST .../node-explanations`, `NodeExplanationReceipt`, and case SSE. |
| View Gate 1 card | Render the server card verbatim, including scope, TTL, targets, preconditions, and expiry. | `NextBestAction` for the canonical action revision. |
| Approve Gate 1 | Submit only the opaque server action ID, canonical identity, and idempotency key. Keep the panel pending until Temporal accepts the action and the projection/SSE changes. | Workspace action receipt plus refreshed projection. |
| Run fresh read | Permit only the newly issued server card after `gate1_state` and action revision validate. Show progress only from ordered SSE. | Server action receipt, updated evidence/result, and canonical projection. |
| Inspect evidence or result | Render evidence references, claim statements, freshness, result disposition, and critic decision from the projection. | `investigation_result` bound to the same identity and revision. |

An explanation click is idempotent. Repeated clicks, reload, and duplicate SSE
may return the same durable explanation but may not create a second agent turn.
Toast focus never creates one. A cross-tenant, cross-run, stale-revision,
unknown-schema, malformed, or out-of-order object is discarded and makes the
affected UI stale/degraded rather than mixing data.

The conversation is server-owned, ordered, and bound to the canonical tenant,
incident, run, component, and projection revision. The browser stores only
display state and resume cursors; it may not create a message, reorder a
message, or treat a local draft as a durable agent record.

## v1.2 contract mapping and minimal deltas

The current v1.2 projection already supplies canonical identity and revision
binding; `operator_title`/`operator_summary`; graph nodes with
`display_name`, `impact_status`, and membership; graph edge IDs/endpoints;
`lifecycle_stage`; `gate1_state`; server-issued `NextBestAction` cards;
`NodeExplanationReceipt`; ordered case/global SSE envelopes; and the
`investigation_result` with claims, evidence references/freshness,
disposition, truth label, and critic decision. These fields are the source for
the initial panel, Gate 1/read flow, evidence disclosure, and
Investigate/Decide state.

Three fields are required before the exact approved graph and dialogue can be
shown without browser inference. They are future contract deltas, not frontend
defaults:

1. **`incident_focus` on `IncidentProjection`**: `component_id`, one-sentence
   `rationale`, `affected_user_path_status` (`KNOWN` or `UNKNOWN`), optional
   `affected_user_path_summary`, and an ordered, unique
   `incident_relation_edge_ids` array. Every listed edge ID resolves to a
   projection graph edge and every endpoint is an impacted graph node. This
   supplies the current focus and exactly five audited relations; the browser
   must not derive either from node degree, card text, or an arbitrary
   impacted-node filter.
2. **`conversation_items` for a node explanation**: immutable entries ordered
   by server sequence, each bound to the same tenant/case/incident/run,
   component, explanation ID, and projection revision, with safe display text,
   known/unknown state, evidence references, and creation time. Until this
   exists, the panel may render only the durable explanation summary/receipt,
   not a fabricated multi-message dialogue.
3. **`critic.operator_status`**: one server-owned value `PASS`, `REVISE`, or
   `ABSTAIN`, bound to the investigation result. v1.2's raw critic decision
   and result disposition remain visible as evidence details; the browser must
   not locally translate `FAIL` or `AMBIGUOUS` into a stronger conclusion.

No further field is required to surface freshness, degraded/provider status, or
investigation acceptance: render v1.2 evidence freshness, `degraded_code`,
disposition, critic decision, and ordered revision changes verbatim. A changed
`evidence_revision` can produce the bounded notice “Evidence updated”; it
must not state why it changed unless the refreshed projection provides that
statement.

## Proactive behavior and fail-closed states

The agent may surface a server-recorded change in evidence revision, stale or
unknown freshness, unsupported coverage, critic rejection or abstention,
provider/degraded availability, and a contradiction reported by the critic.
It does so as a panel notice from the refreshed projection or ordered SSE; it
does not call a fresh-read capability to look for more evidence. Cross-run or
cross-tenant identity mismatch is a client validation failure, not an agent
claim: discard the object, close the stale stream, and show a concise
reconnect/error state.

Backend unavailable, authentication failure, invalid schema, absent canonical
projection, expired/replaced card, invalid Gate 1 lease, stale event, or
missing required `incident_focus` field all fail closed. The graph shows no
invented path, the panel shows no ready/accepted state, and no action becomes
enabled. Reconnection uses the server resume cursor and only returns to
connected after a schema-valid frame or successful canonical hydrate.

## Acceptance and review loop

Contract tests reject unbound focus edges, focus components outside the
impacted set, stale or cross-identity conversation entries, invalid critic
operator status, stale cards, duplicate explanation creation, and unknown
schema fields. Reducer tests prove toast focus causes zero command/read/
explanation requests, SSE ordering never advances from prose, and canonical
rehydration is the only state transition after a read.

Cross-stack browser acceptance uses real BFF responses and records request
URLs/statuses, case/run/revision, and the server workflow/evidence references.
It verifies passive toast, focus, selected Checkout explanation reuse, Gate 1
approval, fresh-read progress, evidence/result, and the Decide handoff. Test
fixtures are contract-only and cannot satisfy this acceptance.

Staff visual QA captures desktop and 451×859 screenshots for initial Incident,
hydrated propagation graph, selected/reused explanation, fresh-read update,
and final Decide state. Review checks: six nodes and five audited relations
only; Checkout central; readable labels; no edge/card collisions; no title/rail
overlap; an opaque, non-overlapping narrow panel; no raw IDs as primary copy;
and no duplicate generic status panels. Architecture and Live screenshots must
remain visually and behaviorally unchanged.

## Non-goals

- Rebuilding Architecture or Live, exposing the other 16 system nodes in
  Incident, or changing the shared three-tab navigation.
- Browser-created incidents, explanations, recommendations, approvals,
  evidence, lifecycle transitions, agent messages, or successful action
  results.
- Fresh reads before Gate 1; any write, Gate 2, remediation, rollback,
  execution, recovery, verification, or recovery comparison.
- Reading raw provider payloads, treating Knowledge Plane priors as current
  proof, or inferring a root cause from topology.

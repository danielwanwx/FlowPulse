# Compare Decision Workspace

## Goal

Turn Compare from a visual before/after demonstration into an evidence-grounded engineering review. An engineer should be able to determine the incident impact, the causal diagnosis, the bounded recovery, and the reusable next action without leaving the view.

## Scope and authority

- Reuse the existing immutable incident ledger, replay frames, evidence, repair, verification, regression, and policy-gate projections.
- Keep the current interactive incident/verified canvas split. It remains the spatial overview, not the source of truth.
- Do not add backend APIs, mutate the ledger, create external tickets, or bypass owner approval.
- Langfuse remains observability only. Missing or unconfigured tracing is displayed honestly.

## Information architecture

The Compare page has three coordinated regions.

1. **Decision header** — concise before/after metrics plus a single verdict: verified recovery or an explicitly incomplete verification state.
2. **Shared canvas** — the existing draggable split shows incident and verified recovery with stable node identities. Selecting a node, path, or metric sets the investigation focus for every other region.
3. **Review rail** — a compact contextual panel with three progressive-disclosure sections:
   - **Causal chain:** rejected Kafka hypothesis, cited root cause, and confidence/evaluator outcome.
   - **Recovery boundary:** target version, owner gate, execution state, abort condition, and verification receipt.
   - **Next time:** entry signal, first evidence query, rejected shortcut, regression case, and policy promotion status.

The bottom rail becomes a compact navigation strip. It retains the split slider and offers focus filters (Impact, Cause, Recovery, Learning) rather than duplicating the canvas explanation.

## Data mapping

| UI element | Authoritative projection |
| --- | --- |
| Incident/verified metrics | `compareFrames()` and verification event payload |
| Causal chain | hypothesis, evaluation, replan, and root-cause ledger events |
| Recovery boundary | repair proposal, approval request/grant, and execution events |
| Verification | `verification.completed` checks and cited evidence IDs |
| Next time | `regression.created`, `policy.evaluated`, and evaluator rejection |
| Detail drill-down | existing contextual drawer and immutable evidence/provenance records |

Every claim must render a ledger sequence, evidence ID, or explicitly state that it is unavailable. The page must not infer a remediation or a policy outcome that the ledger does not contain.

## Interaction model

- Dragging the compare handle updates the canvas only; it never changes incident state.
- Clicking a review rail item focuses its related node/path and opens the existing compact detail drawer on demand.
- Focus filters change emphasis and review copy while preserving the same stable topology and slider position.
- Keyboard users can reach the filter buttons, canvas nodes, review items, split slider, and evidence drawer in a predictable order.
- Reduced-motion users see state differences without pulse or transition-only meaning.

## Visual direction

- Preserve the bright white / pure-black theme system, monochrome transparent icons, semantic status dots, and high-contrast structural lines.
- Avoid a second dashboard: the review rail uses typographic hierarchy, thin separators, and expandable evidence rather than a grid of cards.
- Use red only for incident impact/rejected causal claims, green only for verified recovery, amber only for gated change, and the neutral palette for structure.
- The canvas remains dominant. The review rail must not cover it at desktop widths; at smaller widths it becomes a bottom sheet.

## Failure and empty states

- If verification is absent, show `Not yet verified` and retain the recovery boundary; do not show a green success state.
- If a cited event/evidence record is missing, show `Evidence unavailable` in the rail and preserve the missing-reference identifier.
- If policy evaluation is absent, show the regression record if present and label the promotion state unavailable.
- If the run has not reached a stage, render the section as unavailable rather than fabricating a future outcome.

## Acceptance checks

- The Compare view answers: what failed, what was rejected, what was confirmed, what changed, how it was verified, and what to do next.
- Split dragging remains interactive and deterministic.
- Selecting review content reaches the existing evidence drawer with IDs and payloads still available through disclosure.
- Owner approval and runtime authority remain unchanged.
- Light and dark themes retain contrast; keyboard focus and reduced-motion remain supported.
- Existing automated tests pass; browser QA confirms no console warnings/errors and no overlap at 1440×900 and 1280×800.

## Decision log

- **Chosen:** a combined engineering-decision and learning view, with canvas as orientation and evidence rail as explanation.
- **Rejected:** a purely visual split, because it does not explain causal or operational decisions.
- **Rejected:** a separate retrospective page, because it would break the continuous incident-to-learning workflow.

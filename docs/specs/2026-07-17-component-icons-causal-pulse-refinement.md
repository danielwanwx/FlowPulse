# Component Icons and Causal Pulse Refinement

Date: 2026-07-17

## Goal

Increase component recognition and perceived quality without changing FlowPulse topology, evidence, runtime authority, replay semantics, or the judge path.

## Input scope

- Existing Incident Digital Twin canvas, deterministic node coordinates, ledger-derived stages, and Compare projection.
- User feedback: colored vector icons, no beacon glow, complete component contents, consistent geometry, fewer visible box treatments, and one causal pulse with observable ordering.
- Visual principles inferred from NASA's public Crew Dragon display and Open MCT material: one dominant system view, sparse chrome, precise hierarchy, semantic color, and synchronized time-based state.

## Approaches considered

1. Keep every irregular node silhouette and add icons. Rejected because clip paths already hide content and make icon placement inconsistent.
2. Use one restrained module plaque plus a single icon family and type-specific colors. Selected because it preserves complete content, makes types scannable, and reduces visual noise.
3. Create bespoke illustrated components. Rejected because it adds asset and maintenance scope without improving the incident loop.

## Visual grammar

- Every component uses the same complete white plaque, thin neutral boundary, restrained shadow, and text grid.
- A colored vector icon is the primary type differentiator. Icons come from one maintained family, use a consistent weight, and include a hidden accessible type label through the existing node name.
- Icon colors identify component type, not health state. State remains explicit text plus a small solid status mark.
- Status marks have no halo, outer glow, blur, or expanding ring.
- Deployment, notes, and owner-gate surfaces use the same material rules to avoid a collection of unrelated boxes.

## Causal motion

- Each active edge renders one short pulse segment rather than a repeating dash train.
- The pulse travels from source to destination, exits, then pauses before the next cycle.
- Edge delays encode causal order. Frontend to Checkout precedes Checkout to Payment/Kafka, which precedes Kafka to Accounting/Fraud. Evidence and evaluator edges use their own ordered lane.
- Replay stage changes reset the sequence deterministically because the canvas is rerendered from the ledger projection.
- Compare is static so two time states remain visually inspectable.
- Reduced-motion mode shows a static source-side marker and no travel animation.

## Completeness and layout

- Remove clip paths and decorative pseudo-elements that can mask labels or icons.
- Long labels remain single-line with ellipsis; detail and state rows stay fully visible.
- Node dimensions remain fixed and deterministic. Per-layer overlap checks must return zero at 1440 x 900 and 1280 x 800.

## Checks

- All ten nodes show a visible vector icon, full detail row, and full status row.
- Component types remain distinguishable without state color.
- No status mark has a box shadow or glow.
- Exactly one animated pulse segment exists per active edge; the pulse is not a repeated dash pattern.
- Propagation delays increase in causal order and seeking the same stage reconstructs the same markup.
- Existing tests, owner approval, evaluator rejection, recovery, and evolve stages remain green.
- Browser console has zero errors and warnings.

## Stop conditions

Success means the visual and motion checks pass, QA evidence is recorded, the latest server remains open on port 4310, and the worktree is clean. Stop only for a backend redesign, credentials, paid integration, or repeated inability to render the selected icon family locally.

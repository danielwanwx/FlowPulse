# Architecture flat selection and layer-summary design

## Status

Approved interaction direction pending implementation review. This document is limited to the Architecture page on `codex/frontend-architecture-polish`.

## Problem

The current Architecture surface mixes card feedback styles: runtime component cards use a blue outline or surface change, while FlowPulse control cards inherit a different raised treatment. The result conflicts with the approved flat, alpha-only material system. The overview also provides a component count but not enough immediate technical context for an engineer to understand what each architecture layer is responsible for or whether it is currently healthy.

## Goals

1. Make Architecture card feedback visually uniform and two-dimensional.
2. Add one compact, always-visible role and status summary to each macro layer.
3. Preserve the existing in-place runtime component detail interaction without a right-side drawer.
4. Keep all runtime state, topology identity, and authority semantics backend-owned.

## Scope

### Included

- Architecture overview only.
- Runtime child-component hover, keyboard focus, and click feedback.
- Existing FlowPulse Control System card hover/focus material normalization.
- One line of static, product-owned role copy plus a server-projected status summary for each of the four approved layers.
- The existing runtime component detail face, including only safe projected fields and the checked-in component catalog descriptions already used by the browser.
- Focused Architecture frontend tests.

### Excluded

- Live, Diagnose, Recovery Console, Compare, topology APIs, backend contracts, lifecycle, and authority behavior.
- New relations, inferred causal explanations, raw telemetry, or business facts that are not in the existing safe projection or checked-in component catalog.
- A control-system detail workflow. Control cards remain bounded status representations in this checkpoint; their visual feedback becomes consistent without creating a second, weaker detail model.

## Interaction model

### Shared card feedback

Runtime child cards and FlowPulse control cards share the same visual grammar:

- Rest: alpha-only surface hierarchy, no visible border, outline, color shift, shadow, or inset highlight.
- Hover: translate upward by 2px using a short transform-only transition; no shadow, border, or color change.
- Keyboard focus: the same upward motion plus the browser-accessible focus outline, visible only during keyboard navigation. The focus outline is not a selected-state decoration.
- Runtime click: the card’s own macro layer replaces its thumbnail anatomy with the existing detail face. The rest of the Architecture overview and FlowPulse panel stay in place.
- Control cards: no click-to-detail behavior is added. They remain non-authoritative status representations and must not show a duplicate drawer.

The motion communicates an available detail, not a state change or an authority action. Reduced motion removes the transform transition while keeping click and keyboard behavior intact.

### Layer summaries

Each macro layer shows exactly one concise line below the title/count:

| Layer | Product-owned role copy |
| --- | --- |
| Client applications | Browser entry, storefront composition, and traffic intake |
| Commerce edge & APIs | Cart, checkout, catalogue, pricing, and fulfillment requests |
| Core services | Order event processing, risk screening, and financial posting |
| Async data & platform | Event transport, configuration, telemetry collection, and operational data |

The adjacent status summary is computed only from the layer’s backend-projected member statuses, for example `6/6 healthy` or `1 pending, 5 healthy`. It does not invent an incident, readiness, or causal mechanism. If a status cannot be classified, the summary uses a bounded neutral form such as `status unavailable`.

## Detail information contract

The runtime component detail face may render only:

- product-owned operational role and optional catalog explanation;
- backend-projected status, stable component ID, architecture layer, source health, signal types, and provenance references;
- valid backend-projected runtime relations, labeled by direction: `Depends on` for outgoing dependencies and `Depended on by` for incoming dependencies.

Missing role copy, signals, provenance, source health, or relationships are omitted. No placeholder such as “no signal summary” is shown. The browser must not derive risk, approval, execution, verification, or business causality from these fields.

## Acceptance criteria

1. All Architecture runtime/control cards have no selection border, selected color surface, shadow, or inset highlight.
2. Hover and keyboard focus give the same 2px upward movement; keyboard focus remains accessible.
3. Each of the four overview layers exposes its approved one-line technical role and server-projected status summary.
4. Runtime component click still opens its own layer-local detail face; no Architecture right drawer is shown.
5. Detail facts remain bounded and omit missing data; dependency direction is correct.
6. The view remains a 22 runtime/data node, 22 runtime dependency, and four FlowPulse control/evidence node read-only projection.
7. No frontend code changes authority, topology, lifecycle, or API contracts.

## Verification

- Focused Architecture/twin-state tests cover all four summaries, status aggregation, the zero-shadow/zero-selected-color CSS contract, keyboard focus, runtime layer-local detail, and hidden missing fields.
- Browser review confirms consistent hover feedback, a detail opening in the originating macro layer, and no Architecture right drawer.
- `npm test`, `npm audit --audit-level=high`, and `git diff --check` remain green before implementation handoff.

## Implementation boundary

Likely files are `public/app.js`, `public/styles.css`, and `test/twin-state.test.mjs`. Keep this as one focused frontend commit after this specification is reviewed. No backend or public contract change is permitted.

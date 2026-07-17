# Runtime and Control Plane Visual Hierarchy

Date: 2026-07-17  
Status: Approved

## Goal

Make incident impact, runtime connectivity, FlowPulse control-plane activity, and derived outcomes distinguishable at a glance without changing backend authority, topology facts, replay timing, or evidence provenance.

## Bounded loop

- Goal: clarify the current shared Digital Twin canvas.
- Input scope: existing replay frames, real/captured OTLP topology, immutable ledger, and current native HTML/CSS/JavaScript UI.
- Execute: label semantic planes, strengthen fault state, restyle outcome annotations, and clarify replay controls.
- Check: deterministic state tests, full test suite, 1440x900 and 1280x800 browser QA, reduced-motion inspection, and zero console errors or warnings.
- Feedback: overlap means adjust placement; unclear state means strengthen labels before adding decoration; regression means restore existing behavior.
- Record: this decision note, QA screenshots, test output, and commit.
- Stop: checks pass and port 4310 shows the latest committed UI; stop on backend expansion or external authority.

## Information hierarchy

The shared canvas keeps one deterministic layout with two semantic planes:

1. **Runtime plane** contains client, service, API, stream, and worker nodes. These nodes represent observed or captured production entities and use solid connectors.
2. **FlowPulse control plane** contains the deployment/change record, investigator, evaluator, and append-only evidence ledger. These nodes use a quieter rail treatment and dashed control/evidence connectors.

Every node exposes an origin line:

- Live topology: `RUNTIME · LIVE OTLP`
- Captured local topology: `RUNTIME · HASHED OTLP`
- Deterministic incident runtime: `RUNTIME · CAPTURED OTLP`
- Deployment: `CHANGE RECORD`
- Investigator/evaluator: `FLOWPULSE CONTROL`
- Ledger: `AUTHORITATIVE LEDGER`

## Failure semantics

Only affected runtime nodes receive the red fault halo. The halo has a precise red boundary and two restrained outer rings. When propagation first enters, each node plays one staggered arrival pulse; it then remains in a static red fault state. Evaluator rejection remains red but uses control-plane treatment rather than the runtime fault halo.

Reduced-motion mode removes the arrival animation and retains the static fault rings and text state.

## Outcome semantics

`Recovery verified` and `Regression recorded` are derived outcomes, not topology nodes. They render as icon-led result markers on a thin outcome rail:

- Recovery uses a green verification symbol.
- Regression/evolve uses a violet learning symbol.

Both remain selectable and open the same evidence drawer tabs as before.

## Replay controls

The bottom dock is explicitly labelled `Replay controls`. Timeline stages retain deterministic seeking but gain semantic stage classes so incident, recovery, and learning milestones are visually distinct.

## Light and pure-black themes

The top bar provides one explicit, keyboard-accessible theme toggle. Light remains the first-visit default and the selected theme persists locally. Pure-black mode changes the application, canvas, panels, nodes, and drawer to black or near-black surfaces with white typography and thin neutral borders. Semantic icon colors, fault red, approval amber, verification green, and learning violet remain unchanged. The toggle does not alter runtime state, replay position, or evidence.

## Acceptance

- Runtime and control-plane nodes are distinguishable without relying on color alone.
- Every runtime/control entity states its authority/source.
- Impact and root-cause runtime nodes have a visible red halo.
- Failure arrival is sequential and stops at reduced motion.
- Recovery and regression are visually distinct derived outcomes.
- Existing Live, Replay, Compare, drawer, approval, and evolve behavior remains intact.
- Light and pure-black modes remain readable and preserve every semantic state.
- The full test suite and visible-browser QA pass with no console errors or warnings.

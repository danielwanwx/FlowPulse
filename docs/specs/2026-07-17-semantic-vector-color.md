# Semantic Vector Color

**Status:** Implemented and verified 2026-07-17

## Purpose

Keep FlowPulse structural surfaces and connection geometry monochrome, while making component identity faster to scan through restrained, semantic color applied only to vector icons. Status remains an independent runtime signal.

## Visual contract

- Cards, canvas backgrounds, typography, standard edges, and controls remain black/white neutral in both themes.
- Every component vector is transparent: no coloured icon tile, no icon border, and no background fill.
- A stable component category determines the vector colour across Architecture, Live, Diagnose, Recovery Console, Compare, drawers, and the agent collaboration surface.
- The contextual drawer inherits its selected component category as a thin header/key-tab accent; the Workspace menu uses only four small category dots for its existing view links.
- When authoritative runtime evidence marks a selected node as impacted, warning/evidence-gap, or verified, the drawer temporarily promotes that state colour over the normal semantic category accent.
- The upper-right status dot continues to communicate real runtime/control status only: healthy/verified, warning/approval, impact/rejected, or unavailable/evidence-gap. Icon colour must never imply health.

## Semantic palette

| Category | Use | Vector colour |
| --- | --- | --- |
| Entry | client, frontend, gateway | blue |
| Service | checkout and internal service | indigo |
| API / payment | public API and payment interaction | teal |
| Stream | Kafka/topic/asynchronous transport | amber |
| Worker | downstream processing | violet |
| Data / evidence | database, ledger, evidence source | emerald |
| Change | deploy/change control | orange |
| Agent / evaluator | agent roles and evaluation control | purple |

The existing colour tokens are reused, capped at a single small vector per node. In dark mode, the same family shifts only enough to maintain AA-adjacent contrast against pure black; it does not become neon or glow.

## Behavior and accessibility

- Colour supplements, never replaces, the existing Phosphor vector shape, node label, semantic kind label, and accessible name.
- Selected, impacted, or receiving nodes may gain the existing brief shadow/elevation effect, but their category colour remains stable.
- `prefers-reduced-motion` behavior is unchanged.

## Acceptance checks

1. A component keeps the same vector colour in every canvas mode and its drawer.
2. Status-dot changes do not alter vector colour.
3. No icon receives a coloured box, circular chip, or background fill.
4. Pure-black mode retains visible differentiated vectors and high-contrast node structure.
5. Existing status and deterministic replay tests remain green.
6. Drawer and menu accents never replace their labels or the status-dot contract.
7. A critical status uses the same red, amber, or green meaning in the drawer as on the selected component.

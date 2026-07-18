# Runtime component evidence and live signal refinement

## Goal

Make Architecture useful to both managers and engineers without changing backend truth: every block pairs a business capability with the actual observed `service.name`, runtime language when present in OTLP resource attributes, and observed signal types. Make Live activity visually precise with one small bright signal moving at a shared physical speed and slowing only at its destination.

## Inputs and authority

- `/api/state.source.topology` supplies observed components and dependency endpoints.
- `/api/state.source.evidence` supplies OTLP payloads, `service.name`, `telemetry.sdk.language`, logs, spans, metrics, capture offsets, and SHA-256 provenance.
- The append-only ledger remains authoritative for incident lifecycle. Live incident chrome is allowed only for an unresolved `development` run; captured replay does not masquerade as an active production incident.

## Interaction decisions

- Architecture cards show business capability first, actual service identity second, and remain a compact line-free block stack.
- Selecting any Architecture or Live component opens scoped runtime context: service identity, type, upstream/downstream neighbors, record count, latest timestamp, OTLP messages/spans/metrics, evidence IDs, hashes, and byte offsets.
- Dependency chips navigate to the neighboring component without losing source authority.
- Live uses one 2.6-unit signal core with a restrained halo. Duration is proportional to path length at 520 units/second. The final 16% uses a terminal deceleration curve; no full connector illumination is added.
- Impacted real-development nodes remain red through the existing evidence-grounded failure projection. The bottom incident strip is hidden unless that real incident is unresolved.

## Checks and stop conditions

- No invented languages or runtime technologies: missing attributes fall back to observed signal types.
- Identical duration/path-length ratio across routes, exact path endpoint arrival, and deterministic sequential handoff.
- No Live node overlaps or viewport overflow at 1440×900.
- Source component drawer records match the selected entity and expose immutable provenance.
- Full automated suite green, browser console clean, representative screenshots recorded, final worktree committed and clean.

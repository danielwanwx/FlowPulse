# Realtime workflow continuity

## Goal

Keep a live Incident case current beyond the Temporal history limit and make
the local deterministic proof visibly change without letting the browser
invent data.

## Design

The existing V2 workspace remains the public read-model and API contract. Its
Temporal execution is given a bounded, deterministic rollover point based on
the number of accepted realtime transitions. Before that point, the workflow
persists the existing projection and starts a successor run with the same
case, incident, run, and topology identities. The successor receives the
latest projection and event sequence, so the API continues to expose one case
while the scheduler resolves the current Temporal execution target from the
durable generation record.

No browser timer, generated client sample, or client-side metric interpolation
is introduced. The local `TEST_DETERMINISTIC` Prometheus rule becomes a
repeatable server-side waveform keyed to Prometheus time. It remains labelled
as deterministic test evidence, but successive polls carry distinct observed
values and timestamps.

## Failure behavior and proof

If a rollover cannot be started or correlated, the connector is marked stale
instead of showing invented currentness. The regression proof starts one fresh
case with a deliberately low rollover threshold, observes an SSE sequence on
both sides of the rollover, and asserts that the public case identity stays
constant, the Temporal run changes, and the latest metric value changes.

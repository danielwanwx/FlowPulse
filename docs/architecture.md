# Runtime architecture

## Control-plane North Star

FlowPulse is a model-agnostic, company-multiplayer agent operating system;
incident response is its first vertical. The Node application in this
repository remains a presentation/demo consumer. It must not become a second
workflow or evidence authority as the FastAPI + Temporal control plane is
integrated.

Temporal is the sole durable workflow/state-transition authority. Postgres
stores append-only domain records and tenant-scoped projections; versioned
object storage owns raw artifacts; evidence and policy determine what agents
may claim or propose. A model/provider integration is only a typed Temporal
activity behind a port. No browser, provider, tool output, or knowledge prior
can bypass evidence, critic/verifier, Gate 1, or the Owner Gate.

The Incident Workspace public identity is
`(tenant_id, incident_id, run_id, topology_revision)`. It is product-owned and
persistently mapped to internal `case_id`, `workflow_id`, and real Temporal
`workflow_run_id`; public `run_id` is never derived from a Temporal ID. See
[the versioned workspace contract](architecture/incident-workspace-control-plane-contract.md).

## Authority boundaries

FlowPulse deliberately separates four responsibilities:

1. The SQLite ledger owns incident truth.
2. The state machine owns execution, retries, stop conditions, and human gates.
3. GPT-5.6 proposes evidence queries, causal findings, and bounded repairs.
4. Langfuse observes model and tool activity but cannot control the run.

## Event flow

Every transition appends an immutable event. The event table has database triggers that abort updates and deletes. A new demo run receives a new `run_id`; old runs remain queryable.

The browser requests a projection containing incident status, stage, evidence, topology, and the ordered ledger. It never receives a mutable workflow object.

## Live investigation

The investigator receives five strict function tools scoped to the incident bundle. Tool output includes stable evidence IDs. The application preserves model output items when returning tool results, as required for reasoning-model tool loops.

The final diagnosis uses a strict JSON schema. FlowPulse then validates citations and repair scope in code before appending the claim. A separate evaluator receives the diagnosis and cited evidence through its own structured-output call. A rejection produces one explicit replan; repeated failure stops.

## Deterministic replay

Replay emits the canonical evidence and decision sequence through the same ledger and state machine. It is not labeled as a live model run. This makes the judge path reliable while keeping the live GPT-5.6 integration inspectable and executable when credentials are present.

## Promotion gates

The Evolve record is a candidate, never an automatic runtime change. It must prove false-positive rejection, causal citation coverage, approval ordering, repair bounds, recovery thresholds, and regression creation. Passing changes its status only to `eligible_for_owner_review`.

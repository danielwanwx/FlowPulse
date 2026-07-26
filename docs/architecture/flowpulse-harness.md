# FlowPulse harness boundary

FlowPulse is a domain-specific incident-response harness, not an autonomous
production operator. The model is deliberately thin: it selects bounded
read-only evidence tools and returns a typed diagnosis. Ordinary code owns the
ledger, evidence provenance, causal validators, approval boundary, allowlisted
executor, recovery checks, executed offline backtest, and promotion rule.

## North Star and compatibility status

FlowPulse is a model-agnostic, company-multiplayer agent operating system whose first vertical is Incident. This harness is the checked-in Node **compatibility/demo** implementation; it is not the real FastAPI/Temporal control-plane equivalent and does not grant lifecycle authority.

Temporal is the sole lifecycle authority. In the target architecture, agents propose, backend validators and registered tools act, the Evidence Ledger records current incident proof, and Temporal accepts the next transition. The browser, a model provider, a harness manifest, tracing, SDK guardrails, and a Knowledge Plane item cannot mint an incident state, approval, action, or verification.

Knowledge Plane material supplies bounded priors: it can explain a service, failure mode, or runbook, but cannot establish current incident proof. Current proof requires canonical recorded evidence and its lineage for the selected tenant-scoped incident and run. Gate 1 permits only approved fresh read capabilities within its tenant-scoped, incident-scoped TTL; Gate 2 permits only a dry-run-backed, precondition-checked, owner-approved mutation within its shorter scoped TTL. Neither gate is browser-issued or provider-issued.

## Memory, skills, protocols, and core

`harness/flowpulse-harness.v1.json` is the immutable binding for the current
workflow. It pins the model configuration, response/tool budgets, two
versioned operational procedures, and the tool/handoff/Owner-repair/failure
protocol hashes. A hash mismatch or unknown version stops before a provider
request.

`src/context-compiler.mjs` is working context: it deterministically selects
safe frozen-evidence projections, preserves evidence IDs/provenance/hashes,
and records selected and omitted references. It has 32-record/32 KiB per-tool
and 96-reference/128 KiB per-attempt limits. Summaries are explicitly
non-authoritative; deterministic validators always resolve evidence from the
frozen source.

The append-only ledger is semantic and episodic memory. New failures also emit
one safe `failure.episode.recorded` event with stage, validator, bounded tool
coverage, missing evidence classes, and the next precondition. It never stores
raw provider text, response/call IDs, encrypted reasoning, credentials, or raw
OTLP. Older ledger rows remain immutable and surface as
`legacy_detail_unavailable` rather than receiving invented details.

`/api/state` projects a compact bounded harness object (manifest, current
stage/attempt, last context hash, and safe stop reason). The existing replay
UI is intentionally unchanged in this slice; a dedicated “Why the harness
stopped” panel is a presentation follow-up, not a new authority surface.

## Truth-labelled paths

| Path | Authority and label |
| --- | --- |
| Judge replay | `captured_fixture` deterministic Astronomy Shop replay. It can demonstrate the fixture's Kafka/downstream story but is not live GPT proof. |
| Model-only live | A frozen real-OTLP snapshot may be queried by GPT-5.6, but without a development repair contract it cannot become executable. |
| Development incident | Frozen real OTLP + code/change/baseline/direct failures must pass deterministic causal validation, independent evaluator, Owner Gate, allowlisted local repair, fresh verification, and executed offline backtest before policy becomes eligible. |

The preserved historical paid run keeps its original safe classification and
audit references, but it predates `failure.episode.recorded` and therefore
projects as `legacy_detail_unavailable`. FlowPulse does not reconstruct or
invent finer-grained diagnostics from current code. New runs are safely
diagnosable through their structured failure episode without retaining raw
provider data; the historical run is not represented as a successful GPT
repair.

## Deliberate non-goals

This competition implementation does not add generic subagent fan-out,
personalized user memory, a skill marketplace, or durable provider-turn resume.
Those features would add cost and authority surface without improving the one
bounded checkout-to-payment causal proof. Remote read-only MCP transport can
be added later, but consequential actions must still pass FlowPulse policy,
Owner approval, and the code-owned executor contract.

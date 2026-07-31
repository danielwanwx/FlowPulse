# Diagnosis Control Plane P0 implementation plan

## Loop contract

**Goal.** Deliver a testable, read-only FlowPulse diagnosis control-plane kernel whose only production workflow authority is Temporal. It must admit evidence safely, build an inspectable diagnosis record, distinguish reference knowledge from current proof, independently criticize and verify claims, and stop at an exact owner gate without performing a production write.

**Input scope.** The accepted architecture research, control-plane specification, and evaluation plan supplied by the Control Tower; the existing FlowPulse Node application is a separate presentation baseline. This P0 adds an isolated Python service package and does not alter the Incident Workspace path.

**Execute steps.**

1. Define strict Pydantic contracts and stable ports for incidents, evidence, claims, hypotheses, coverage, conflicts, knowledge, approvals, dry-run actions, metrics, and trace context.
2. Implement a single-Temporal-authority workflow definition plus a deterministic fake Temporal adapter for replay tests. Put model/Responses calls behind typed activity ports only; P0 uses deterministic fakes.
3. Implement append-only repository/event records, a Postgres migration, and a versioned raw-artifact storage port with local content-addressed implementation.
4. Implement the deterministic router, bounded primary/specialist workflow, evidence gateway, knowledge prior retrieval, critic, independent source-readback verifier, needs-human/abstain outcomes, and exact owner gate.
5. Expose these controls through FastAPI routes and dry-run action handling only; add local configuration, Compose wiring, and run documentation.
6. Add deterministic unit/API-level contract tests and replay/evaluation hooks, then run the focused suite and static compilation.

**Checks.**

- Strict models reject additional fields and malformed privileged outputs.
- Evidence admission rejects unknown IDs, missing lineage, cross-tenant references, or an attempt to promote KB evidence to current proof.
- Router produces one primary by default, caps specialists at four, and records fan-out reason.
- Critic and verifier run as different identities; verifier re-reads evidence through an independent source port.
- Claims that require current proof cannot reach verified/owner states from KB-only evidence.
- Conflicts remain durable, block affected owner-gate proposals, and yield a bounded `NEEDS_HUMAN`/`ABSTAIN` outcome.
- Approval binds a canonical proposal hash, case revision, target scope, TTL, and precondition witness; all mismatch paths fail closed.
- Action routes remain idempotent dry-run placeholders and cannot perform external writes.
- Replay/eval records emit the no-KB/KB comparison interface and required workload, grounding, safety, and abstention metrics without claiming improvements.

**Feedback rules.** Invalid model/route/proposal output becomes a structured failure record and `BLOCKED` or `NEEDS_HUMAN`, not a fallback authority grant. Missing current proof or verifier readback becomes abstention. Unavailable Temporal/Compose dependencies are reported as environment blockers while deterministic fake-adapter tests continue. Any test failure is repaired before the next checkpoint.

**Records.** Append-only case events, evidence/claim/coverage/conflict records, trace correlations, decision reasons, fake-workflow history, and evaluation metric snapshots are all inspectable; raw content stays behind the artifact-store port.

**Stop conditions.** A case may stop as verified read-only diagnosis, `AWAITING_OWNER`, `NEEDS_HUMAN`, `ABSTAINED`, or `BLOCKED`. P0 never starts a production remediation. Implementation stops only after all focused checks pass or a reproducible local environment blocker is recorded.

**Human gates.** Owner approval is required for any action proposal and for knowledge promotion. Production credentials, production writes, automatic KB promotion, and action execution are outside this plan.

## Requirement-to-deliverable matrix

| Requirement | Implementation | Deterministic coverage |
| --- | --- | --- |
| FastAPI + strict contracts | `control_plane/flowpulse_cp/models.py`, `app.py` | strict schema and route tests |
| Temporal only durable workflow authority | `temporal_workflow.py`, `workflow.py`, activity contracts | replay/fake-Temporal workflow tests; no LangGraph dependency |
| Durable records and raw evidence port | repositories, artifact store, `migrations/001_control_plane.sql` | append-only/event and content-hash tests |
| Intake → router → investigator → bounded specialists | router + workflow kernel | default, fan-out, and cap tests |
| Evidence lineage, claims, hypotheses, coverage, conflicts | gateway + integrity modules | unknown, cross-tenant, contradiction, proof-scope tests |
| KB as tenant-safe reference prior | knowledge module | ACL/version/supersession and KB-only proof rejection tests |
| Separate critic and source-readback verifier | critic + verifier ports | identity/readback and rejection tests |
| Exact owner gate/dry-run only | owner gate + action service | TTL, witness, hash, target, idempotency tests |
| OTel/evaluation hooks | tracing + eval modules | metric schema and paired replay tests |

## P0 exclusions

- No LangGraph, second durable state machine, live OpenAI/Responses call, live model cost, production credentials, or live production telemetry adapter.
- No production mutation, canary, rollout, shell, SQL write, automatic remediation, or automatic knowledge promotion.
- No large vector store, GraphRAG, automatic postmortem ingestion, or UI-led expansion.
- Docker/Temporal/MinIO are local integration wiring, not required for the deterministic unit test path.

## Acceptance

Focused test commands must pass with no network access and prove the failure paths above. The package must state its Temporal, Postgres, and object-storage production seams explicitly, leaving no alternate workflow authority hidden in P0.

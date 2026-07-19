# Cloud reality demo decision — 2026-07-18

## Decision

**GO for B (a hosted deterministic judge demo); NO-GO for C (a new disposable
cloud incident lab) before this submission.**

This is a competition decision, not a claim that FlowPulse is cloud-proven.
The existing local OTLP proof is valuable technical evidence, but it is not a
currently runnable cloud demonstration. The default demonstration remains the
credential-free, deterministic Astronomy Shop replay.

## Loop record

| Loop element | Record |
| --- | --- |
| Goal | Maximize judge confidence before the July 21, 2026 5:00pm PDT deadline without weakening the reliable under-three-minute path. |
| Inputs inspected | `README.md`, judge script, submission pack, runtime QA record, Docker configuration, local development adapter, and current `live:check`. |
| Execute | Compare the three release choices and three candidate incidents against the actual runtime proof and official submission requirements. |
| Checks | Preserve deterministic fallback and owner gate; do not overclaim GPT; reject work that needs more than one focused day, new vendors, or risks the core demo. |
| Feedback rule | If hosted replay cannot be made reliable quickly, submit the public repository plus recorded deterministic video; do not substitute a cloud lab. |
| Human gate | A hosted URL requires the owner to choose and authorize an existing account/provider. No account, spend, or deployment is approved by this decision. |
| Stop | Stop cloud-lab exploration now. Reconsider only after the hosted replay, public video, and required `/feedback` value are complete with at least a focused workday remaining. |

## Current capability truth

| Capability | Truthful status |
| --- | --- |
| Deterministic replay | **Ready.** The public repository at `60ee32f9fbee3ca2ae8aa367fa56baed2142b89d` has a credential-free captured Astronomy Shop replay, a tested owner gate, and a documented 2:30 judge route. |
| Real local proof | **Completed once and recorded.** A pinned, disposable local Astronomy Shop run produced real `change.applied` → frozen OTLP snapshot → evaluator rejection → accepted causal diagnosis → owner-gated allowlisted rollback → fresh verification → regression/policy. This is local proof, not a hosted service. |
| GPT proof | **Fail-closed proof only.** The latest bounded GPT-5.6 run proved the applied change plus direct-parent checkout flag consumption and payment resolver failure in one trace. The independent evaluator still stopped at `insufficient_evidence` because implementation semantics, controlled comparison, repeated incident evidence, and downstream propagation were not proved. It created no proposal, approval, or repair. The successful local repair was deterministic, not GPT-executed. |
| Missing production/cloud capability | **Not present.** There is no hosted FlowPulse URL, cloud incident lab, production connector, Langfuse credentialed trace, public video, or confirmed `/feedback` value. The current local diagnostic is `docker: true`, `flag_api: false`, `ready: false`; it must not be presented as a ready live demo. |

The official rules require a working, consistently runnable project, public
video under three minutes, code repository, `/feedback` Session ID, and—for a
Developer Tool—installation/platform/testing guidance. Judges may judge from
the description, images, and video rather than testing the project, and the
four Stage Two dimensions are equally weighted: implementation, design,
impact, and idea quality. [Official rules](https://openai.devpost.com/rules)
and [OpenAI Build Week overview](https://openai.com/build-week/) therefore
reward a reliable, clear proof more than an untested cloud claim.

## Option scorecard

Scores are 1–5; time/cost/failure-risk use **5 = favorable**. They are an
owner decision aid, not measured judge scores.

| Option | Judge clarity | Technical credibility | GPT/Codex evidence | Visual impact | End-to-end evidence | Reliability | Time | Cost | Failure risk | Total / 45 | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A. Submit current product and local proof | 3 | 4 | 4 | 4 | 3 | 5 | 5 | 5 | 5 | **38** | Viable fallback |
| B. Add hosted deterministic demo only | 5 | 4 | 4 | 4 | 4 | 5 | 4 | 4 | 4 | **38** | **Recommended** |
| C. Add one disposable cloud incident lab | 3 | 5 if it works | 4 | 5 | 5 | 1 | 1 | 2 | 1 | **27** | Reject now |

The weighted score ties A and B, but B wins the release decision because it
addresses the most concrete submission gap—judge access—without changing the
causal product. The Docker image already launches with development mutation
disabled, so a hosted replay is bounded infrastructure work rather than a new
incident system. If hosting becomes unreliable, A is the immediate fallback.

## Incident candidate assessment

| Candidate | Causal story / evaluator challenge | Repair safety | Demo clarity | Decision |
| --- | --- | --- | --- | --- |
| Kafka crash | Broker health, consumer lag, retries, partitions, and downstream symptoms can create a rich topology, but a crash often makes the root cause obvious or requires disruptive broker operations. The false-blame/replan is harder to explain cleanly in under three minutes. | Restarting or rebalancing a broker is not a credible generic automated repair. | Visually busy; can distract from FlowPulse’s evidence gate. | Reject |
| Database connection or migration failure | A connection failure can support a useful trace/log/change join, but schema/migration rollback is unsafe; a simple database-down fault is too obvious. | Migration reversal/data safety needs stronger guards than the current single repair contract. | Moderate, but the relationship to current checkout/payment incident is weaker. | Reject |
| Bad checkout configuration/deploy makes payment unreachable | Directly matches the existing checked-in change, trace predicate, allowlisted rollback, and local proof. The evaluator can reject Kafka blame because the change predates a checkout→payment network failure and lag is downstream. | Strictly bounded to restoring one known-good flag and recreating checkout after owner approval. | Clear before/after system story and coherent with the existing UI. | **Best candidate, but use it only as the existing local proof / deterministic replay now** |

## Why a new cloud lab is lower expected value

Cloud would add a new claim surface—not just realism: account and IAM setup,
network exposure, secret handling, OpenTelemetry egress/storage, repeatable
fault injection, a stable repair boundary, teardown, and video-proof timing.
It would also duplicate the most important thing already demonstrated locally:
the change-to-failure causal loop with owner approval and fresh verification.

Its marginal benefit is therefore mostly a stronger phrase (“cloud-hosted”)
rather than a stronger judge experience. That benefit is outweighed by three
active release gaps: a hosted deterministic URL, public video, and confirmed
`/feedback` value. The rules explicitly permit judges to evaluate the video,
description, and images without running the project, so the reliable recorded
demo is the better investment right now. [Official rules](https://openai.devpost.com/rules)

## Conditional future cloud design — not approved for this submission

If all release gates above are complete and at least one uninterrupted focused
workday remains, the *only* cloud lab worth considering is the existing
checkout→payment configuration failure on a single disposable VM / small
container host. It would run the pinned Astronomy Shop, its Collector, and
FlowPulse with one external DNS/network failure or the checked-in
`paymentUnreachable` flag; freeze bounded Collector JSONL; execute the same
Detect → evaluator rejects Kafka blame → replan against change + payment trace
→ owner approves the exact rollback → verify fresh health → regression loop.
Langfuse would be best-effort observation only; the append-only ledger stays
authority. The deterministic replay remains the live-demo fallback. Teardown
means `docker compose down --volumes` and deletion of the single disposable
host. This is intentionally *not* a multi-vendor architecture and does not
authorize an account, a provider, a cost, or deployment.

Even this smallest design should be abandoned if it needs a second cloud
vendor, more than 4–6 setup/debug hours, more than roughly US$10 in
unavoidable spend, exposes a public mutation endpoint, cannot produce a fresh
post-repair trace reliably, or threatens the recorded judge path.

## Timeboxed recommendation and next human decision

1. **Within 30 minutes:** choose whether to authorize one hosted deterministic
   FlowPulse instance on an existing account/provider. This is the sole next
   human decision.
2. **If authorized:** timebox hosting, fresh-port smoke, and a static demo
   recording to one focused workday. Deploy only the existing Docker image with
   `FLOWPULSE_DEVELOPMENT_ENABLED=0`; do not host the mutable local adapter.
3. **Abort hosting** if it needs new credentials with uncertain access, a
   database migration, an additional vendor, or more than one focused day.
   Submit using the public repository plus the deterministic video instead.
4. **Do not start C** unless B, video, and `/feedback` are finished and the
   remaining time safely exceeds the abort threshold. Under the current facts,
   C is a **NO-GO**.

## Research note

The local Research Engine run was attempted at
`/tmp/flowpulse-cloud-decision-research/2026-07-18-openai-build-week-2026-official-competition-judging-criteria-sub`
but collected no rows because its web connector returned `URLError`. Official
rules and event requirements above were verified directly from the primary
OpenAI/Devpost pages linked in this document.

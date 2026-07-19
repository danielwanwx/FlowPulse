# Starting new Codex sessions

## 1. Obtain the repository

Shrik needs collaborator access to <https://github.com/danielwanwx/FlowPulse>.
After accepting the invitation:

```bash
git clone git@github.com:danielwanwx/FlowPulse.git
cd FlowPulse
git switch main
git pull --ff-only origin main
```

If collaborator access is unavailable, fork the repository, clone the fork, add
the upstream remote, and open pull requests from the fork. Do not share Daniel's
credentials or put a personal access token in a repository file.

## 2. Open the two sessions

### PM/reviewer session

Create a separate, projectless Codex session in Shrik's account. Paste the
complete contents of
[`PROMPT_PM_REVIEW_SESSION.md`](PROMPT_PM_REVIEW_SESSION.md). It is a reviewer
and coordinator, not an implementation session. It reads repository evidence,
reviews checkpoints, conserves tokens, and pauses after each review.

### Implementation session

Open the cloned `FlowPulse` folder in Codex Desktop or start Codex from that
directory in the CLI. Paste the complete contents of
[`PROMPT_IMPLEMENTATION_SESSION.md`](PROMPT_IMPLEMENTATION_SESSION.md). The
session creates its own collaborator branch, such as
`shrik/flowpulse-integration`, and starts with baseline checks.

## 3. Work in reviewable checkpoints

1. Implementation proposes one small slice to Daniel and the PM session.
2. Daniel/PM approves its exact scope.
3. Implementation commits and pushes it with test and screenshot/URL evidence.
4. Daniel reviews locally or in the PR, then accepts, requests a bounded fix, or
   stops for a product decision.

Never merge a broad frontend rewrite, authority change, and submission change as
one checkpoint.

## 4. Codex `/feedback` provenance

At the beginning of every new Codex session, run `/feedback` and copy the
shown Session ID into the PR description or a dated handoff note as **secondary
provenance**. Do not overwrite the Devpost primary value:

```text
019f6eaf-ded3-78e1-a9c3-8ae4fd6811e2
```

That is the original primary Build Week build session, where most core
functionality was created. Change the required Devpost field only after a
documented, evidence-based team decision that the majority has shifted.

## 5. Verify locally

```bash
npm ci
npm test
npm start
```

Then open <http://127.0.0.1:4310>. The default judge path is deterministic and
credential-free. `npm run submission:check` currently has a known false-positive
test-fixture credential scan; use `npm test` until that separate repair lands.
Do not run live development or GPT paths without the explicit environment gates
in the README.

## 6. Security and publication

- Keep API keys, telemetry credentials, raw OTLP, `.env`, local databases, and
  `outputs/live` out of git.
- Use environment variables for secrets; never paste them into prompts, issues,
  screenshots, logs, or Devpost fields.
- Do not upload telemetry that may contain secrets or customer identifiers.
- The owner alone performs Devpost terms acceptance and final Submit.
- A local review URL is not a hosted demo; never claim it is public.

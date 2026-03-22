# Internal Project Operating Model

## Purpose

This document defines how our team operates inside the OpenClaw repository without changing the public OpenClaw documentation set.

It is a synthesis layer over the repo rules already defined in:

- `AGENTS.md`
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/workflows/auto-response.yml`
- `docs/help/testing.md`
- `docs/reference/RELEASING.md`
- `docs/platforms/mac/release.md`
- `docs/concepts/multi-agent.md`
- `docs/tools/subagents.md`
- `.github/workflows/ci.yml`
- `.github/workflows/openclaw-npm-release.yml`
- `scripts/sync-plugin-versions.ts`
- `src/commands/models/shared.ts`
- `src/wizard/onboarding.ts`
- `src/commands/configure.wizard.ts`
- `package.json`

## Operating principles

- Treat public repo docs as the product-facing or maintainer-facing source of truth for OpenClaw itself.
- Treat this folder as our internal coordination layer.
- Keep claims evidence-based, especially for bug fixes, regressions, and release readiness.
- Prefer small, reviewable work slices with explicit ownership.
- Assume multi-agent concurrency is normal and protect the worktree accordingly.
- Escalate high-impact decisions to the owner through the approved direct channel, not through public issue or PR traffic.

## Organization structure

| Role                  | Primary responsibility                                                                                                         | Typical outputs                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Owner or operator     | Sets priorities, approves high-impact decisions, release actions, version changes, security severity, and external commitments | Priority decisions, release approval, escalation answers    |
| Chief of staff        | Scopes work, assigns experts, tracks status, synthesizes findings, decides when to escalate, and keeps process docs current    | Task breakdown, consolidated status, updated operating docs |
| Domain expert         | Implements a narrow slice of product, infra, auth, docs, or release work                                                       | Focused code or doc changes with local verification         |
| Independent reviewer  | Reviews for behavioral risk, missing evidence, regression risk, and test gaps                                                  | Findings, risk notes, verification challenges               |
| Documentation steward | Keeps internal process docs aligned with reality and ensures product-facing docs are updated when behavior changes             | Updated internal docs, doc follow-ups                       |
| Release maintainer    | Executes release checklists after approval and verifies publication artifacts                                                  | Tags, release validation, publish logs                      |
| Contributor           | Delivers scoped fixes or features with evidence and verification                                                               | PRs, repros, tests, docs, screenshots                       |

Notes:

- One person or agent can hold multiple roles on a small task, but implementation and review should still be separated when the change has meaningful risk.
- The chief of staff owns coordination quality, not all implementation.

## Current state

Today, the repo already has a strong rule set, but it is spread across multiple places:

- `CONTRIBUTING.md` defines the public maintainer roster and the open source contribution path.
- `AGENTS.md` is the practical operations manual for agents and maintainers.
- Issue and PR templates define evidence requirements and review expectations.
- `docs/help/testing.md` and `docs/reference/RELEASING.md` define test and release mechanics.
- Multi-agent behavior is split between `docs/concepts/multi-agent.md` and `docs/tools/subagents.md`.

This means the repo has process depth, but no single internal document that explains how our own team should combine these rules in day-to-day work.

## Governance context

OpenClaw already has a public governance layer:

- a named maintainer roster in `CONTRIBUTING.md`
- a contributor path through issues, discussions, and PRs
- project-wide guardrails in `AGENTS.md`

Our internal operating model sits on top of that public structure. It does not replace upstream maintainership or public contribution rules. It defines how our own team coordinates, staffs work, reviews risk, and escalates decisions while working in this repo.

## Updated working model

### 1. Intake and classification

Every task is classified before work starts:

- Support or user-help request
- Bug or regression
- Feature or workflow improvement
- Release or publish task
- Incident, security, or operational recovery
- Documentation-only or process-only change

Rules:

- Redirect support-shaped GitHub traffic through the existing auto-response label policy instead of hand-written triage.
- Do not treat bug claims as true until there is symptom evidence and a verified code path.
- Separate product behavior changes from internal coordination changes.

### 2. Staffing

The chief of staff assigns work by slice, not by file ownership guesswork:

- One implementation expert per coherent change slice
- One reviewer for risk and evidence
- One documentation owner when the task changes process or user-visible behavior

Default staffing pattern:

1. Explorer gathers current state and affected rules.
2. Implementer changes code or internal docs.
3. Reviewer checks gaps, regressions, and missing proof.
4. Chief of staff consolidates and closes the loop.

### 3. Contributor workflow

Contributor workflow is optimized for focused delivery:

1. Start from a clear bug report, request, or scoped feature idea.
2. Keep changes focused and avoid unrelated refactors.
3. Verify locally with the narrowest commands that prove the change.
4. If logic changed, run the expected local gate of `pnpm build && pnpm check && pnpm test`, or document why a narrower subset was used.
5. Use the PR template fully:
   - problem
   - scope boundary
   - evidence
   - human verification
   - failure recovery
6. Resolve or reply to bot review conversations you addressed.

### 4. Maintainer workflow

Maintainer workflow is stricter than contributor workflow:

1. Re-validate the bug claim against code, not just issue text or PR text.
2. Confirm the change touches the real root-cause path.
3. Require a regression test when feasible; otherwise require manual proof and a reason no test was added.
4. Reject speculative bug fixes and unclear release risks.
5. Use the auto-close label system when the item matches an existing closure reason.
6. Before landing, ensure review conversations are cleaned up by the author.
7. Before release work, require explicit owner approval for version changes, publish steps, or security-sensitive actions.

### 5. Verification gate

Use a three-tier gate so PR work, merge decisions, and release work are not
conflated:

PR minimum:

- Run the smallest proof that validates the changed path.
- Add or update targeted tests for regressions.
- Run format or lint checks on touched files when needed.
- State what was not verified.

Merge-to-main minimum for meaningful code changes:

- `pnpm build`
- `pnpm check`
- `pnpm test`

Release gate:

- Read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md`
- Confirm clean tree for the release branch or release commit
- Run release validation commands from the release checklist
- Do not publish or retag without explicit approval

Environment rule:

- Node 22+ is the repo compatibility baseline.
- Node 24 is the preferred release environment unless the release docs say otherwise.

### 6. Config mutation policy

Config persistence must be explicit about safety semantics.

- Read-modify-write updates should use the locked helper path.
- Direct `writeConfigFile(...)` is reserved for intentional full-replacement
  writes where overwriting concurrent changes is an accepted property of the
  operation.
- Interactive onboarding and configure flows should move toward locked
  delta-apply helpers instead of persisting stale in-memory config.
- Any task touching config writes should state whether it uses a locked update
  path or an intentional full replacement.

### 7. Plugin and publish policy

Plugin operations need separate rules for bundled plugins and npm-published
plugins.

- Treat bundled plugins and npm-published plugins as different operational
  scopes.
- Use `pnpm plugins:sync` for version alignment when release work requires it.
- User-facing changelogs should not absorb internal release-bookkeeping notes.
- If automation produces changelog output that conflicts with policy, track it
  as process debt instead of silently normalizing the conflict.

### 8. Multi-agent safety

These are mandatory when more than one agent may be active:

- Do not create or apply stashes.
- Do not switch branches unless explicitly instructed.
- Do not create or remove worktrees.
- Do not revert unrelated changes.
- Commit only your own changes.
- Treat unknown files and unrelated local edits as in-progress work by someone else unless proven otherwise.
- Report conflicts early instead of overwriting them silently.

Work split rule:

- The chief of staff assigns agents by coherent task slice.
- Each expert should minimize edits outside that slice.
- Shared files require explicit coordination and a final synthesis pass.

### 9. Documentation and process maintenance

When a task changes the product:

- Update user-facing docs in `docs/` when behavior changed.
- Update this internal folder when our coordination method changed.

When a task changes only internal process:

- Update this folder only.
- Record why the process changed and what evidence triggered it.
- Append the operational decision to `process-change-log.md`.

## Decision rules

Escalate to the owner for:

- release and publish approval
- version bumps
- security severity or trust-boundary questions
- destructive repo or environment actions
- external commitments that change roadmap, support posture, or public promises

The chief of staff can decide without escalation for:

- staffing and sequencing
- local verification scope for an active task
- internal documentation structure
- whether a follow-up should be split from the current task

## Current process backlog

These gaps are now tracked as process follow-ups:

1. Keep a repo-local maintainer workflow snapshot or pointer that does not depend on a missing `.agents/skills/PR_WORKFLOW.md`.
2. Clean up stale internal path references such as `docs/testing.md` vs `docs/help/testing.md`.
3. Codify config mutation rules in code-facing guidance and migrate known direct write hotspots in onboarding and configure flows.
4. Keep PR minimum, merge-to-main minimum, and release minimum verification language aligned across local docs, CI, and release docs.
5. Separate bundled-plugin policy from npm-published plugin policy and resolve changelog conflicts in release automation.
6. Clarify the distinction between configured multi-agent isolation and spawned subagent auth fallback.
7. Keep runtime compatibility guidance and release-environment guidance described together in one place.

## Definition of done

A task is not done until all of the following are true:

- The requested outcome is implemented or explicitly scoped out.
- Verification matches the actual risk level of the change.
- Review findings are either fixed, documented, or escalated.
- Relevant internal process docs are updated when the way of working changed.
- Remaining risk is explicit, not implied.

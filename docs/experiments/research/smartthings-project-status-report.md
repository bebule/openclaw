---
summary: "Project status report for the SmartThings milestone 1 branch, covering implementation scope, validation, and readiness"
read_when:
  - Reviewing the current SmartThings branch before deciding merge scope
  - Assessing whether the SmartThings work is launch-ready or still scaffold-only
  - Planning the next execution steps for adapter, plugin, and validation work
title: "SmartThings Project Status Report"
---

# SmartThings project status report

Last updated: 2026-03-21

## Executive summary

The current branch, `codex/smartthings-20260319`, contains a coherent
SmartThings milestone 1 implementation focused on a skill-first integration with
an external adapter. The branch now has:

- design and contract documentation in `docs/architecture.md`,
  `docs/state-model.md`, `docs/api-contract.yaml`, `docs/test-plan.md`, and
  `docs/failure-matrix.md`
- a runnable SmartThings adapter under `adapter/`
- a thin plugin-managed skill pack under `extensions/smartthings/`
- a workspace skill wrapper under `skills/smartthings/`
- targeted validation hooks wired into the repo

This work is best described as a strong milestone 1 scaffold or MVP. It is
merge-reviewable as scaffolding, but it is not launch-ready and not production
ready.

## Current branch and worktree

The active branch is `codex/smartthings-20260319`.

The SmartThings work is still largely uncommitted in the current worktree. The
product-facing changes are concentrated in:

- `adapter/**`
- `extensions/smartthings/**`
- `skills/smartthings/**`
- `fixtures/**`
- `docs/api-contract.yaml`
- `docs/architecture.md`
- `docs/failure-matrix.md`
- `docs/state-model.md`
- `docs/test-plan.md`

Tracked repo-integration updates currently appear in:

- `.github/labeler.yml`
- `src/config/config.plugin-validation.test.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `pnpm-lock.yaml`

There are also local planning artifacts in:

- `codex_openclaw_smartthings_exec_prompt.md`
- `codex_openclaw_smartthings_spec.md`

Management should make an explicit PR-boundary decision on whether those local
planning files are excluded from any final branch submission.

## Active workstreams

The current branch breaks into four active workstreams that can be tracked
separately:

- `adapter/service`:
  In progress. The adapter routes, webhook branching, and TV normalizer exist,
  but production durability and security hardening are still open.
- `skill/plugin`:
  In progress. The plugin-managed skill path is wired and usable for milestone
  1, but the plugin remains intentionally thin and depends on an external
  adapter.
- `repo integration`:
  In progress and mostly green. Type discovery, targeted tests, config-schema
  validation, and label routing are all wired into the repo.
- `packaging/launch path`:
  In progress but not ready. The adapter still has a separate build path and is
  not part of the main packaged OpenClaw delivery path.

## Implementation status

### Architecture and adapter

The SmartThings architecture is documented as a skill-first design that keeps
SmartThings-specific behavior in a separate adapter service rather than in the
OpenClaw core runtime.

The adapter MVP exists in:

- `adapter/src/app.ts`
- `adapter/src/device-normalizer.ts`
- `adapter/src/routes/devices.ts`
- `adapter/src/routes/webhooks.ts`

The implemented adapter surface includes:

- `GET /health`
- `GET /devices`
- `GET /devices/:id/status`
- `POST /devices/:id/commands`
- `POST /subscriptions/bootstrap`
- `POST /webhooks/smartthings`

TV state normalization is also implemented, with the documented four-state model
of `offline`, `standby`, `on`, and `unknown`.

### Plugin and skill wiring

SmartThings is wired into the repo as a thin plugin-managed skill pack, not as a
new core runtime feature.

The key surfaces are:

- `extensions/smartthings/package.json`
- `extensions/smartthings/index.ts`
- `extensions/smartthings/openclaw.plugin.json`
- `extensions/smartthings/README.md`
- `skills/smartthings/SKILL.md`

The workspace skill wrapper delegates to the plugin-shipped helper scripts in
`extensions/smartthings/skills/smartthings/bin/*`, which keeps local-development
behavior aligned with packaged skill behavior.

The plugin itself is intentionally thin. It currently acts as:

- a config schema carrier
- a skill-pack delivery wrapper
- a packaging boundary for the SmartThings skill

It does not currently provide onboarding hooks, adapter reachability checks, or
health surfacing.

### Repo integration

The SmartThings work is now partially wired into repo-level validation and
triage surfaces:

- `src/config/config.plugin-validation.test.ts` validates the SmartThings plugin
  config schema
- `tsconfig.json` includes `adapter/**/*`
- `vitest.config.ts` includes `adapter/src/**/*.test.ts`
- `.github/labeler.yml` adds `extensions: smartthings`

This means the SmartThings work is no longer isolated only in local files. It
already has meaningful hooks into repository validation and review routing.

## Validation status

Targeted validation is currently green.

Verified evidence includes:

- fixture-based normalizer coverage in `adapter/src/device-normalizer.test.ts`
- device route coverage in `adapter/src/routes/devices.test.ts`
- webhook and bootstrap coverage in `adapter/src/routes/webhooks.test.ts`
- SmartThings HTTP client coverage in `adapter/src/smartthings-client.test.ts`
- helper config and command parsing coverage in
  `extensions/smartthings/skills/smartthings/bin/_smartthings-client.test.ts`
- plugin config schema validation in `src/config/config.plugin-validation.test.ts`

The targeted validation run passed, and adapter type-checking passed:

- targeted Vitest suites passed
- `pnpm exec tsc -p adapter/tsconfig.json --noEmit` passed

However, there are still validation gaps that materially affect launch
confidence:

- `GET /health` exists in `adapter/src/app.ts` but does not yet have direct test
  coverage
- there is no automated contract verification against `docs/api-contract.yaml`
- there is no skill-to-adapter end-to-end proof
- the PAT and OAuth dry runs described in `docs/test-plan.md` remain documented
  only
- coverage thresholds in `vitest.config.ts` exclude the adapter from the repo
  coverage gate
- root build packaging does not include the adapter artifact as part of the
  normal packaged delivery path
- timeout, rate-limit, and retry behavior are documented as concerns but not yet
  backed by explicit launch-grade validation

## Key risks and blockers

### 1. OAuth production durability is incomplete

The branch does not yet persist SmartThings OAuth token or installed app state
in a durable production-ready way. That makes refresh, restart recovery, and
subscription repair incomplete.

Relevant files:

- `adapter/src/routes/webhooks.ts`
- `docs/architecture.md`
- `docs/failure-matrix.md`

### 2. Webhook trust boundaries are not complete

Webhook authenticity and replay protection are still deferred. This is an
important security blocker before treating the adapter as production-ready.

Relevant files:

- `docs/architecture.md`
- `docs/test-plan.md`
- `docs/failure-matrix.md`

### 3. Event handling is intentionally incomplete

`EVENT`, `OAUTH_CALLBACK`, and `UNINSTALL` are largely acknowledged but not yet
connected to broader OpenClaw automation or operational workflows.

Relevant file:

- `adapter/src/routes/webhooks.ts`

### 4. State-confidence risk remains

The TV normalizer is intentionally conservative, which is the right direction
for milestone 1. Even so, the fixture set is still shallow and capability drift
across Samsung TV models remains a practical risk.

Relevant files:

- `adapter/src/device-normalizer.ts`
- `fixtures/samsung-tv/*`
- `docs/state-model.md`

### 5. Plugin packaging is not a self-contained delivery path

The plugin is still `private`, remains intentionally thin, and depends on an
external adapter that is not packaged as part of the main OpenClaw artifact.
Plugin enablement alone is not enough to produce a runnable SmartThings setup.

Relevant files:

- `extensions/smartthings/package.json`
- `extensions/smartthings/index.ts`
- `extensions/smartthings/openclaw.plugin.json`
- `extensions/smartthings/README.md`
- `package.json`

### 6. Source-of-truth drift risk exists

The branch currently duplicates some SmartThings definitions across multiple
surfaces. The plugin config schema appears in both the plugin code and the
plugin manifest, and the skill instructions exist in both the workspace skill
and the plugin-shipped skill.

That duplication is manageable in milestone 1, but it creates a maintenance
risk if future changes update only one copy.

Relevant files:

- `extensions/smartthings/index.ts`
- `extensions/smartthings/openclaw.plugin.json`
- `skills/smartthings/SKILL.md`
- `extensions/smartthings/skills/smartthings/SKILL.md`

### 7. Secondary operational reliability risks remain

The branch still lacks clear evidence for rate-limit handling, retry behavior,
and the case where a SmartThings command is accepted but the device state does
not actually converge to the expected result.

These are not the primary blockers for milestone 1 scaffold work, but they are
real launch risks once the branch is treated as an operational integration.

Relevant files:

- `docs/failure-matrix.md`
- `docs/test-plan.md`

## Management decisions pending

The following decisions are now management-facing rather than purely technical.

### Immediate pre-PR decisions

### Decide the branch goal

Choose between:

- merge as a milestone 1 scaffold
- hold for more production hardening before merge

The current implementation clearly supports the first option more than the
second.

### Decide the PR boundary

Confirm whether the final PR should contain only product surfaces or also the
local planning artifacts:

- `codex_openclaw_smartthings_exec_prompt.md`
- `codex_openclaw_smartthings_spec.md`

### Decide the readiness bar

If this branch is going to be described as anything beyond scaffold or MVP, the
team should first add:

- `/health` route tests
- automated contract validation
- skill-to-adapter end-to-end proof
- a clear launch path for the adapter

### Post-M1 design decisions

### Decide plugin scope

Confirm whether `extensions/smartthings/index.ts` should remain a minimal skill
wrapper or should grow lightweight onboarding, adapter health, or operator
guidance behavior.

### Decide the single source of truth

Confirm whether SmartThings plugin schema and skill instructions should continue
to live in multiple copies or move to a clearer single-source model with thin
delegation elsewhere.

## Recommended next steps

### Short-term

1. Keep the current branch scoped as a milestone 1 scaffold.
2. Exclude local planning artifacts from the final PR unless there is a clear
   reason to keep them.
3. Add direct test coverage for `GET /health`.
4. Add automated verification for the API documented in
   `docs/api-contract.yaml`.
5. Add a thin skill-to-adapter integration test path.

### Medium-term

1. Add durable OAuth token and installed-app persistence.
2. Add webhook authenticity and replay protection.
3. Expand fixture diversity across Samsung TV payload variants.
4. Decide whether the plugin remains intentionally thin or grows minimal
   onboarding and health surfaces.
5. Define and document the adapter deployment path separately from plugin
   enablement.

## Readiness verdict

### Development readiness

Good. The branch is coherent enough for active development and incremental
review.

### Merge-review readiness

Good, if the scope is explicitly described as milestone 1 scaffolding or MVP
work.

### Launch readiness

Not ready.

### Production readiness

Not ready.

## Final conclusion

The SmartThings branch has moved beyond planning and into a real, structured
milestone 1 implementation. It already contains working adapter routes, a
documented state model, a plugin-managed skill path, fixtures, and passing
targeted validation. That is strong progress.

The remaining gaps are not small polish items. They are launch-defining gaps:
OAuth durability, webhook trust, event completeness, fixture breadth, and
end-to-end proof. Because of that, the branch should be managed and described as
an MVP scaffold that is appropriate for merge review and continued iteration,
but not yet suitable for launch or production claims.

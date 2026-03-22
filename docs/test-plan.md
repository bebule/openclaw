---
summary: "Test plan for the SmartThings adapter, skill, and TV state normalization"
read_when:
  - Adding tests for the SmartThings adapter or skill
  - Planning milestone 1 validation and production hardening
title: "SmartThings Test Plan"
---

# SmartThings test plan

Last updated: 2026-03-16

## Goal

Validate the SmartThings integration at three layers:

- adapter unit behavior
- adapter route and contract behavior
- skill-to-adapter integration behavior

Milestone 1 should prove that the skill-first flow works against a separate
adapter service and that Samsung TV state normalization is predictable.

## Test layers

### Unit tests

Focus on deterministic logic that does not need live SmartThings credentials.

Targets:

- TV state normalizer
- SmartThings client request construction
- route parameter parsing
- webhook lifecycle payload branching

Priority cases:

- `online + switch=on -> on`
- `online + switch=off -> standby`
- `offline -> offline`
- missing or contradictory capability payloads -> `unknown`
- command payload passthrough preserves component, capability, command, and
  arguments

### Contract tests

Validate the adapter HTTP DTOs against the documented API contract.

Targets:

- `GET /health`
- `GET /devices`
- `GET /devices/:id/status`
- `POST /devices/:id/commands`
- `POST /subscriptions/bootstrap`
- `POST /webhooks/smartthings`

Priority assertions:

- expected success status codes
- expected error status codes
- normalized TV state enum is limited to the four documented values
- raw SmartThings payload is preserved in status responses
- webhook confirmation path returns the expected confirmation body

### Fixture tests

Use representative SmartThings payload snapshots under `fixtures/`.

Minimum fixture set for milestone 1:

- Samsung TV online and powered on
- Samsung TV online and in standby
- Samsung TV offline
- Samsung TV payload with missing health or switch capability

Fixture tests should prove fail-before/pass-after behavior for every new
normalization rule.

### Integration tests

Exercise the helper scripts and adapter together without live SmartThings.

Targets:

- skill helper script points at the adapter base URL
- device list formatting is stable
- TV state lookup returns normalized state and supporting evidence
- command helper handles accepted and failed adapter responses

### Manual tests

Use real credentials only after fixture and unit coverage are in place.

#### PAT local development

- start the adapter with a PAT
- list devices
- fetch TV status repeatedly while toggling TV power
- send a power command and verify status convergence
- capture raw payload fixtures for future regression tests

#### OAuth-In SmartApp production dry run

Automated evidence available now:

- `adapter/src/app.test.ts`
- `adapter/src/api-contract.test.ts`
- `adapter/src/oauth-refresh.test.ts`
- `adapter/src/routes/webhooks.test.ts`
- `extensions/smartthings/skills/smartthings/bin/_smartthings-client.integration.test.ts`

Manual evidence still required:

- bootstrap subscriptions with a real public callback URL
- confirm webhook confirmation flow
- verify event and lifecycle bodies reach the adapter
- verify token refresh and installed app metadata are stored correctly
- verify expired installed-app access tokens recover through refresh during subscription repair

Use `docs/experiments/research/smartthings-production-dry-run.md` as the
operator checklist and evidence pack template.

## Suggested command matrix

These are the minimum milestone 1 validation commands once code exists:

- `pnpm validate:smartthings`
- `pnpm validate:smartthings:release`

Use `pnpm validate:smartthings` for fast iteration. Treat
`pnpm validate:smartthings:release` as the launch-path gate because it adds the
standalone adapter build on top of the targeted test and typecheck bundle.

## Exit criteria

Milestone 1 is ready when all of the following are true:

- the skill can list devices through the adapter
- the skill can read a Samsung TV status through the adapter
- the adapter returns only `offline`, `standby`, `on`, or `unknown`
- at least one regression fixture exists for each normalized state
- the command path is verified with either a regression test or a documented
  manual proof

## Risks to test explicitly

- cached SmartThings status that lags real TV power state
- offline health with stale switch value
- missing capability paths on some TV models
- duplicate or replayed webhook deliveries
- expired PAT or expired OAuth access token

## Deferred test work

- TODO: expand webhook authenticity and replay tests into a live public-callback dry run.
- TODO: add rate-limit and retry tests once the backoff policy is finalized.

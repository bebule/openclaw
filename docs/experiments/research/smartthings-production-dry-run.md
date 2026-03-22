---
summary: "Operational checklist and evidence template for the SmartThings OAuth-In SmartApp dry run"
read_when:
  - Preparing a production-like SmartThings dry run
  - Collecting evidence that the adapter is ready for real SmartApp lifecycle traffic
title: "SmartThings Production Dry Run"
---

# SmartThings production dry run

Last updated: 2026-03-21

## Purpose

Produce a small but credible evidence package that the SmartThings adapter can:

- accept SmartApp confirmation traffic
- persist installed-app OAuth state
- bootstrap subscriptions
- refresh expired installed-app access tokens during subscription repair

## Preconditions

Before starting, provide all of the following:

- `SMARTTHINGS_PUBLIC_URL`
- `SMARTTHINGS_INSTALLED_APP_ID`
- `SMARTTHINGS_CLIENT_ID`
- `SMARTTHINGS_CLIENT_SECRET`
- `SMARTTHINGS_STATE_DIR`

`SMARTTHINGS_TOKEN` is still useful for PAT fallback and local reads, but the
dry run should focus on the OAuth SmartApp path.

Before any manual dry-run step, run:

```bash
pnpm validate:smartthings:release
```

## Preflight

Capture `GET /health` before any live SmartThings action.

Expected readiness:

- `mode: "oauth-smartapp"`
- `readiness.oauthWebhookReady: true`
- `readiness.oauthRefreshReady: true`
- `readiness.installedAppContextReady: true`
- `readiness.webhookVerificationReady: true`
- `readiness.oauthDryRunReady: true`
- `blockers: []`

If any blocker remains, stop and fix configuration before continuing.

## Run Order

1. Start the adapter with the production-like SmartApp env vars.
2. Trigger SmartApp `CONFIRMATION` and save the adapter response.
3. Trigger SmartApp `INSTALL` or `UPDATE` and verify the adapter persisted:
   - redacted `installedAppId`
   - `authToken`
   - `refreshToken`
4. Call `POST /subscriptions/bootstrap` and save the successful response.
5. Force an expired installed-app access token and trigger a repair path.
6. Save evidence that:
   - the first request failed auth
   - refresh ran once
   - the retry succeeded
   - persisted token state was updated
7. Capture `GET /health` again after repair.

## Evidence Pack

The minimum evidence pack should contain:

- pre-run `/health` response
- confirmation response
- redacted persisted installed-app state after `INSTALL` or `UPDATE`
- successful bootstrap response
- refresh repair proof
- post-repair `/health` response

## Pass Criteria

The dry run passes when all of the following are true:

- webhook confirmation succeeds
- installed-app state persists with both access and refresh tokens
- subscription bootstrap succeeds
- one expired-token repair succeeds through refresh and retry
- post-repair readiness remains green

## Not Covered Yet

This first dry run does not try to prove:

- live event fanout into OpenClaw sessions
- multi-installed-app orchestration
- rate-limit and backoff policy
- host restart recovery across machines

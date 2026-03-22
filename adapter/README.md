# SmartThings Adapter

Standalone adapter service for the OpenClaw SmartThings milestone 1 flow.

## Commands

```bash
cd adapter
pnpm dev
pnpm check
pnpm build
pnpm start
```

## Repo-Root Validation

Use this as the canonical SmartThings validation command from the repo root:

```bash
pnpm validate:smartthings
```

Use the local `adapter/` commands only for focused development work.

When you also need build output for launch or manual dry-run work, use:

```bash
pnpm validate:smartthings:release
```

That command runs the targeted SmartThings test/typecheck bundle and then builds
the standalone adapter output under `adapter/dist/`, cleaning stale files first
and rejecting any emitted test files.

## Environment

- `SMARTTHINGS_TOKEN`: SmartThings personal access token for live reads and commands.
- `SMARTTHINGS_API_BASE_URL`: Optional SmartThings API base URL. Default: `https://api.smartthings.com/v1`
- `SMARTTHINGS_BIND_HOST`: Optional bind host. Default: `127.0.0.1`
- `SMARTTHINGS_PORT`: Optional port. Default: `8787`
- `SMARTTHINGS_PUBLIC_URL`: Optional public webhook URL for SmartApp confirmation flows.
- `SMARTTHINGS_INSTALLED_APP_ID`: Optional installed app id for OAuth SmartApp mode.
- `SMARTTHINGS_CLIENT_ID`: SmartApp OAuth client id used for access-token refresh.
- `SMARTTHINGS_CLIENT_SECRET`: SmartApp OAuth client secret used for access-token refresh.
- `SMARTTHINGS_OAUTH_TOKEN_URL`: Optional SmartThings OAuth token endpoint. Default: `https://api.smartthings.com/oauth/token`
- `SMARTTHINGS_STATE_DIR`: Optional directory for persisted SmartApp installed-app state.
- `SMARTTHINGS_REQUEST_TIMEOUT_MS`: Optional upstream timeout in milliseconds.
- `SMARTTHINGS_MAX_BODY_BYTES`: Optional max request body size in bytes.

## Routes

- `GET /health`
- `GET /devices`
- `GET /devices/:id/status`
- `POST /devices/:id/commands`
- `POST /subscriptions/bootstrap`
- `POST /webhooks/smartthings`

## Webhook Trust

- `POST /webhooks/smartthings` now requires SmartThings HTTP Signature verification.
- The adapter validates `Authorization: Signature ...`, `digest`, and `date`, fetches SmartThings public keys from `key.smartthings.com`, and drops replayed lifecycle deliveries without re-running side effects.

## OAuth Refresh

- The adapter persists `authToken` plus `refreshToken` for SmartApp installs.
- Subscription bootstrap and repair can refresh expired installed-app access tokens once when SmartThings returns `401` or `403`.
- Refresh requires `SMARTTHINGS_CLIENT_ID` and `SMARTTHINGS_CLIENT_SECRET`.

## Production Dry Run

Before a production dry run, `/health` should report:

- `readiness.oauthWebhookReady: true`
- `readiness.oauthRefreshReady: true`
- `readiness.installedAppContextReady: true`
- `readiness.webhookVerificationReady: true`
- `readiness.oauthDryRunReady: true`
- `blockers: []`

Suggested run order:

1. Run `pnpm validate:smartthings:release` from the repo root.
2. Start the adapter with SmartApp OAuth env vars populated.
3. Capture `GET /health` before SmartApp install or update.
4. Complete SmartApp confirmation and capture the confirmation response.
5. Capture an `INSTALL` or `UPDATE` lifecycle proving installed-app state persisted.
6. Call `POST /subscriptions/bootstrap` and capture the active subscription response.
7. Force an expired installed-app access token and capture one successful refresh-based repair.
8. Capture `GET /health` again after repair.

Evidence to save:

- pre-run `/health` response
- webhook confirmation proof
- redacted persisted installed-app state showing `installedAppId`, `authToken`, and `refreshToken`
- bootstrap success response
- refresh repair proof showing retry success
- post-repair `/health` response

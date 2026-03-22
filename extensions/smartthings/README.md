# SmartThings Plugin

Thin OpenClaw plugin wrapper for the SmartThings milestone 1 skill pack.

## What it ships

- Ships the `smartthings` skill as a plugin-managed skill pack.
- Keeps SmartThings protocol, auth, webhook, and state-normalization logic in the external adapter.
- Avoids adding a new core tool or gateway-managed SmartThings runtime in milestone 1.

## Canonical sources

This plugin ships a self-contained copy of the `smartthings` skill under `./skills`.

- Author the skill behavior in `skills/smartthings/SKILL.md`.
- Treat `./skills/smartthings/SKILL.md` as the packaged mirror for installs outside the workspace.
- Treat `openclaw.plugin.json` plus `index.ts` as the plugin-owned config surface for `plugins.entries.smartthings.config`.

## Configuration model

Milestone 1 exposes a small plugin-owned adapter config surface under
`plugins.entries.smartthings.config`.

For the canonical command contract, config resolution order, and minimal config
example, use `skills/smartthings/SKILL.md`.

Inside this repo, the workspace skill at `skills/smartthings` has higher
precedence than plugin-shipped skills during local development. The plugin copy
exists for packaged installs and is kept in sync with the workspace skill by
test coverage.

Installing or enabling the plugin is still not sufficient by itself. You need a
reachable external adapter service.

Run `pnpm validate:smartthings:release` from the repo root before treating the
skill pack plus adapter bridge as release-ready for manual dry-run work.

## Runtime guidance

For host runs, prefer `plugins.entries.smartthings.config` for stable adapter
settings. Environment variables still override plugin config when you need a
temporary override. `skills.entries.smartthings.env` remains a host-only fallback.

For sandboxed runs, do not rely on `skills.entries.smartthings.env` alone. Skill
processes running inside Docker do not inherit host-only skill env overrides. Use
`agents.defaults.sandbox.docker.env`, per-agent `agents.list[].sandbox.docker.env`,
or bake the env into the sandbox image instead. If the sandbox can read the same
`openclaw.json`, the plugin config fallback may also work, but env is the safer
path for sandbox isolation.

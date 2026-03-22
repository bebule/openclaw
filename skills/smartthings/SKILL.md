---
name: smartthings
description: Control Samsung SmartThings devices through a separate adapter service. Use when you need to list SmartThings devices, read a normalized Samsung TV power state, or send a SmartThings device command from OpenClaw without adding a core MCP path.
---

# SmartThings Adapter Skill

Use this skill through a separate SmartThings adapter service. Prefer this skill for milestone 1 when the task is:

- Listing SmartThings devices
- Checking Samsung TV power state
- Sending an explicit SmartThings device command

Use one of these subcommands when the user invokes `/smartthings ...`:

- `list_devices`
- `get_tv_state <deviceId>`
- `send_command <deviceId> <capability> <command> [argumentsJson]`
- `send_command <deviceId> <component> <capability> <command> [argumentsJson]`

## Configuration

The helper scripts resolve adapter settings in this order:

1. `SMARTTHINGS_ADAPTER_URL` / `SMARTTHINGS_ADAPTER_TOKEN`
2. `plugins.entries.smartthings.config.adapterUrl` / `adapterToken` from `openclaw.json`
3. `skills.entries.smartthings.env.SMARTTHINGS_ADAPTER_URL` / `SMARTTHINGS_ADAPTER_TOKEN`
4. Default adapter URL `http://127.0.0.1:8787`

For plugin-managed installs, prefer `plugins.entries.smartthings.config`.
Environment variables still override plugin config when needed.

Minimal plugin config:

```json5
{
  plugins: {
    entries: {
      smartthings: {
        enabled: true,
        config: {
          adapterUrl: "http://127.0.0.1:8787",
          adapterToken: "replace-me-if-needed",
        },
      },
    },
  },
}
```

## Execution

Run the helper scripts directly:

```bash
node {baseDir}/bin/list-devices.js
node {baseDir}/bin/get-tv-state.js <deviceId>
node {baseDir}/bin/command-device.js <deviceId> switch on
node {baseDir}/bin/command-device.js <deviceId> main audioVolume setVolume '[15]'
```

## Workflow

1. Resolve the target device with `list_devices` when the device id is unknown.
2. Use `get_tv_state` before mutating a Samsung TV when current power state matters.
3. Use `send_command` only when the user explicitly asked for a device action.
4. Report the adapter response clearly, including normalized state when present.

## Command Mapping

### `list_devices`

Run:

```bash
node {baseDir}/bin/list-devices.js
```

Use this first for discovery. Expect a JSON payload from the adapter. Prefer Samsung TVs when the user asked about TV state or TV power.

### `get_tv_state`

Run:

```bash
node {baseDir}/bin/get-tv-state.js <deviceId>
```

Use this for Samsung TV state checks. The script returns a compact JSON summary and passes through the adapter's normalized state when available.

### `send_command`

Run:

```bash
node {baseDir}/bin/command-device.js <deviceId> <capability> <command> [argumentsJson]
node {baseDir}/bin/command-device.js <deviceId> <component> <capability> <command> [argumentsJson]
```

If you pass `argumentsJson`, make it valid JSON in a single shell-quoted argument.

Examples:

```bash
node {baseDir}/bin/command-device.js tv-living-room switch off
node {baseDir}/bin/command-device.js tv-living-room switch on
node {baseDir}/bin/command-device.js tv-living-room main audioVolume setVolume '[12]'
```

## Guardrails

- Do not invent SmartThings capabilities or command names. Use the values the user supplied or the values discovered from adapter responses.
- Do not send a mutating command unless the user asked for it.
- Treat unknown or missing normalized TV state as `unknown`, not `off`.
- If the adapter is unavailable, surface the HTTP failure and suggest checking `SMARTTHINGS_ADAPTER_URL`, `plugins.entries.smartthings.config.adapterUrl`, or the adapter process.

---
summary: "Samsung TV state normalization rules for SmartThings adapter responses"
read_when:
  - Implementing Samsung TV status parsing
  - Debugging SmartThings TV state mismatches
title: "SmartThings State Model"
---

# SmartThings state model

Last updated: 2026-03-16

## Goal

Normalize SmartThings Samsung TV status payloads into exactly four adapter
states:

- `offline`
- `standby`
- `on`
- `unknown`

The normalized state should be stable enough for skill-driven automation even
when SmartThings capability payloads vary by firmware, region, or bridge state.

## Source data

Milestone 1 should primarily rely on the `main` component and treat these
signals as the highest-value evidence:

- SmartThings device health endpoint `state`
- `healthCheck.DeviceWatch-DeviceStatus`
- `switch.switch`
- `ocf` metadata when present

Other Samsung-specific capabilities can be captured as raw evidence, but should
not become hard state requirements until they are observed consistently in real
fixtures.

## Normalized state definitions

### `offline`

Use when the adapter has strong evidence that the TV is not currently reachable
through SmartThings.

Primary triggers:

- `GET /devices/{id}/health -> state == "OFFLINE"`
- `healthCheck.DeviceWatch-DeviceStatus.value == "offline"`
- SmartThings device health endpoint reports offline
- Status fetch succeeds but clearly reports an offline device

Notes:

- `offline` should win over contradictory switch data because stale switch data
  is common after hard power loss.
- If SmartThings cannot be contacted at all, prefer returning a transport error
  at the HTTP layer rather than silently converting every device to `offline`.

### `standby`

Use when the TV is reachable but not actively on.

Primary trigger:

- device health reports `online` and `switch.switch.value == "off"`

Interpretation:

- This state represents the common SmartThings "soft off" or standby behavior.
- It does **not** guarantee that the panel is fully off.
- It also does **not** distinguish between low-power network standby and user
  intent to power down.

### `on`

Use when the TV is reachable and the power switch reports on.

Primary trigger:

- device health reports `online` and `switch.switch.value == "on"`

Advisory signals that can support diagnosis but should not override health:

- Fresh media input state
- Fresh volume state
- OCF metadata that implies the device is active

### `unknown`

Use when the adapter cannot derive a trustworthy power state.

Primary triggers:

- Required signals are missing
- Health and switch signals conflict in a way that does not fit the priority
  rules
- SmartThings returns a partial payload for a TV that lacks the expected switch
  or health capability

## Priority rules

Apply normalization in this order:

1. If device health explicitly reports `offline`, return `offline`.
2. If device health reports `online` and switch reports `on`, return `on`.
3. If device health reports `online` and switch reports `off`, return
   `standby`.
4. If switch is missing but other signals imply the device is reachable, return
   `unknown`.
5. If the payload is incomplete, stale, or contradictory, return `unknown`.

This ordering is intentionally conservative. The adapter should avoid turning a
weak signal into a false `on`.

## Capability mapping

| Capability path                                              | Example values      | Role in normalization          | Notes                                          |
| ------------------------------------------------------------ | ------------------- | ------------------------------ | ---------------------------------------------- |
| `GET /devices/{id}/health -> state`                          | `ONLINE`, `OFFLINE` | Primary reachability signal    | Highest priority when available                |
| `components.main.healthCheck.DeviceWatch-DeviceStatus.value` | `online`, `offline` | Primary reachability signal    | Fallback when device health endpoint is absent |
| `components.main.switch.switch.value`                        | `on`, `off`         | Primary power intent signal    | Used only after health                         |
| `components.main.ocf.*`                                      | vendor metadata     | Diagnostic only in milestone 1 | Useful for raw evidence                        |

## Raw evidence to keep

The adapter response should keep enough evidence for debugging:

- device ID
- device label
- component name
- capability paths used for normalization
- timestamps for the signals used
- raw payload fragment from SmartThings

This makes it possible to explain why the adapter returned `standby` instead of
`offline` or `on`.

## Known limits

### Hard power loss vs standby

Some Samsung TV states collapse into the same SmartThings shape until health
refresh catches up. A just-unplugged TV may briefly look like `standby` if the
last switch value was cached as `off`.

### Vendor capability drift

Samsung-specific capabilities can vary across models and firmware. Treat them as
secondary evidence until they are captured in fixtures and regression tests.

### Art mode and special low-power states

Milestone 1 does not define a distinct art mode state. If the device still
reports `switch=on`, normalize to `on`. If the device reports `switch=off`,
normalize to `standby`.

### Missing health capability

If a TV payload lacks `healthCheck`, do not infer reachability from switch state
alone unless a future fixture set proves that rule is safe. Return `unknown`.

## Recommended response shape

The adapter status response should include:

- `normalized.tvState`: normalized enum
- `normalized.reasons`: short machine-readable explanation list
- `normalized.capabilitiesSeen`: list of capability paths used
- `raw`: raw SmartThings status and health fragments

For milestone 1 compatibility, the adapter may also expose
`normalizedState.state` as a convenience alias for thin helper scripts.

## Deferred work

- TODO: add fixture-driven rules for Samsung-specific capabilities once real
  payload diversity is known.
- TODO: define a staleness threshold for cached webhook-backed state vs live
  polling.
- TODO: decide whether future production builds should distinguish `transition`
  from `unknown`.

---
summary: "Failure matrix for SmartThings adapter, auth modes, and Samsung TV state handling"
read_when:
  - Reviewing SmartThings integration risks
  - Planning mitigations for milestone 1 and production rollout
title: "SmartThings Failure Matrix"
---

# SmartThings failure matrix

Last updated: 2026-03-16

## Goal

Track the expected failure modes for a skill-first SmartThings integration so
milestone 1 can stay small without hiding production risks.

| Failure mode                                               | Where it shows up                          | Likely impact                               | Expected adapter behavior                                            | Mitigation                                        | Status      |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ----------- |
| PAT missing or revoked                                     | `GET /health`, all SmartThings reads       | No device access                            | Return unhealthy status and upstream auth error                      | Validate env on startup; document PAT setup       | Milestone 1 |
| OAuth access token expired                                 | commands, status reads, bootstrap          | Production outage until refresh succeeds    | Return 401/502-style adapter error, attempt refresh when implemented | Add refresh token flow in adapter                 | TODO        |
| Wrong SmartThings base URL or region mismatch              | reads and commands                         | Requests fail even with valid token         | Surface transport/config error, not fake offline                     | Keep base URL configurable                        | Milestone 1 |
| Device lacks expected `healthCheck` or `switch` capability | TV status reads                            | State cannot be trusted                     | Return `unknown` with raw evidence                                   | Expand fixture coverage before adding heuristics  | Milestone 1 |
| Stale switch value after hard power loss                   | TV status reads                            | False `standby` or false `on` risk          | Let health override switch where possible                            | Prefer health over switch; re-read after command  | Milestone 1 |
| SmartThings API timeout                                    | any live route                             | Skill command stalls or fails               | Return timeout error and keep state unchanged                        | Add timeout and retry budget                      | Milestone 1 |
| SmartThings rate limiting                                  | repeated reads or command bursts           | Temporary unavailability                    | Return retryable error with rate-limit context                       | Add backoff and cache hot paths                   | TODO        |
| Webhook confirmation not completed                         | `POST /webhooks/smartthings` in production | No active subscription                      | Return confirmation response when lifecycle requires it              | Test with public callback URL                     | TODO        |
| Duplicate webhook delivery                                 | webhook event processing                   | Repeated cache updates or noisy logs        | Accept idempotently                                                  | Add event dedupe key storage                      | TODO        |
| Webhook authenticity not verified                          | webhook path                               | Security risk                               | Do not claim strong authenticity guarantees yet                      | Add signature or trust-boundary validation        | TODO        |
| Command accepted but TV state does not change              | `POST /devices/:id/commands`               | User sees false success confidence          | Return command accepted plus follow-up status if possible            | Re-read status and show normalized result         | Milestone 1 |
| Samsung firmware or capability drift                       | status reads, command availability         | Normalizer or commands break on some models | Preserve raw payload and return `unknown` when unsure                | Add model-diverse fixtures and narrow assumptions | Ongoing     |
| Multi-location or multi-home ambiguity                     | device listing and bootstrap               | Wrong device chosen                         | Return location IDs and labels in device summaries                   | Support explicit location filters later           | TODO        |

## Highest-priority risks

### 1. False state confidence

The most dangerous failure is returning `on` or `standby` when the signal is
actually stale or contradictory. The adapter should prefer `unknown` over a bad
automation decision.

### 2. Auth mode drift

Local PAT testing can look healthy while production OAuth installation is still
incomplete. Keep the mode visible in `/health` and in bootstrap responses.

### 3. Webhook incompleteness

The webhook route may exist before production lifecycle behavior is fully
implemented. That is acceptable in milestone 1 only if the adapter clearly
documents the limitation and does not pretend subscriptions are active.

## Operational guidance

- Prefer loopback or a private network for adapter exposure in milestone 1.
- Log SmartThings request IDs and normalized-state reasons.
- Keep raw payload capture available for fixture generation.
- Treat webhook state as advisory until replay protection and authenticity
  checks land.

## Deferred risk work

- TODO: add a security review once webhook trust boundaries are implemented.
- TODO: add persistence failure modes after adapter token storage is chosen.
- TODO: add circuit-breaker behavior once SmartThings retry policy is defined.

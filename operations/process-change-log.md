# Process Change Log

## 2026-03-22

### Added

- Created the `operations/` folder as a separate internal documentation space
  so the open source repo can keep its public docs stable.
- Added `operations/project-operating-model.md` as the internal summary of
  organization structure, ways of working, quality gates, and release/process
  rules.
- Added `operations/review-notes-2026-03-22.md` to preserve the initial expert
  review that led to this operating model.

### Adopted

- Internal process updates must be recorded in `operations/` instead of being
  scattered across ad hoc reports.
- Work is now classified into intake lanes before execution: bug, feature,
  support, security, or docs/process.
- Verification language is now split into `PR minimum`,
  `merge-to-main minimum`, and `release minimum`.
- Config persistence work must state whether it uses a locked update path or an
  intentional full replacement.
- Plugin operations are now described separately for bundled plugins and
  npm-published plugins.
- Multi-agent work must declare ownership and integration responsibility before
  parallel execution starts.
- Bug-fix landing decisions must satisfy the evidence gate documented in
  `operations/project-operating-model.md`.

### Backlog note

- Current open follow-ups are tracked in the `Current process backlog` section
  of `operations/project-operating-model.md`.

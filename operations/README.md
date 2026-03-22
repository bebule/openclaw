# Internal Operations

This folder is our internal operating layer for working inside the OpenClaw repository.

Principles:

- Public product and maintainer docs in `docs/` stay unchanged unless product behavior needs to be documented there.
- `AGENTS.md` remains the execution guardrail for active agent work.
- This folder records how our team organizes work, reviews process health, and updates its operating model over time.

Files:

- `project-operating-model.md`: canonical file for current operating rules,
  role boundaries, verification gates, and the active process backlog.
- `process-change-log.md`: historical log of adopted process changes only.
- `review-notes-2026-03-22.md`: dated review snapshot that explains why this
  operating layer was created and what findings shaped it.

Update rule:

- When our internal way of working changes, update `project-operating-model.md`.
- Record the actual change in `process-change-log.md`.
- Keep unresolved process gaps in the `Current process backlog` section of
  `project-operating-model.md`.
- When the change is driven by review, add the reasoning to a dated review note
  and then promote any lasting conclusion into `project-operating-model.md` or
  `process-change-log.md`.

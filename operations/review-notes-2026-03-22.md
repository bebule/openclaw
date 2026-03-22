# Process Review Notes - 2026-03-22

## Goal

Create an internal operating layer for our team without changing the public OpenClaw documentation set.

## Source set reviewed

- `AGENTS.md`
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/workflows/auto-response.yml`
- `docs/help/testing.md`
- `docs/reference/RELEASING.md`
- `docs/platforms/mac/release.md`
- `docs/concepts/multi-agent.md`
- `docs/tools/subagents.md`

## Review findings from expert subagents

### What is already strong

- The repo already has a high-quality rule set around evidence, testing, release safety, and multi-agent worktree safety.
- Issue and PR intake are structured and evidence-oriented.
- Auto-close labels reduce triage churn for recurring non-actionable categories.
- Testing and release procedures are already detailed in public docs.

### What is missing or fragmented

1. There is no single internal operating document for our own team.
2. Maintainer workflow guidance points to `.agents/skills/PR_WORKFLOW.md`, but that file is not present in this repo.
3. Some path guidance is stale, especially `docs/testing.md` vs `docs/help/testing.md`.
4. Config mutation policy is not expressed clearly enough for onboarding and configure flows.
5. Verification expectations differ between local docs, CI scope rules, and release docs.
6. Plugin release automation and changelog policy can conflict.
7. Auth isolation is easy to misunderstand unless readers distinguish configured peer agents from spawned subagents.
8. Runtime compatibility and release-time environment expectations are documented separately and can look inconsistent without explanation.

## Updates adopted in `project-operating-model.md`

1. Separate contributor workflow from maintainer workflow.
2. Make evidence-first bug handling explicit in our internal operating layer.
3. Adopt a standard staffing model:
   - explorer
   - implementer
   - reviewer
   - chief of staff synthesis
4. Define a three-tier verification gate:
   - PR minimum
   - merge-to-main minimum
   - release minimum
5. Add config mutation policy guidance to the internal operating model.
6. Add plugin and publish policy guidance to the internal operating model.
7. Promote multi-agent safety rules into the internal operating model instead of leaving them only in `AGENTS.md`.
8. Add a decision boundary for when the chief of staff must escalate to the owner.
9. Keep a lightweight `process-change-log.md` so process updates are recorded as decisions, not only as narrative notes.

## Recommended next process follow-ups

1. Add a repo-local maintainer workflow note or snapshot so internal landing rules are self-contained.
2. Fix stale internal references to testing docs and other moved docs.
3. Add an explicit config mutation rule and migrate known direct-write hotspots.
4. Resolve the plugin changelog policy vs release automation conflict.
5. Add a short internal note that explains:
   - configured multi-agent isolation
   - subagent auth fallback
   - when each model applies
6. Re-review this folder whenever release or PR policy changes in `AGENTS.md`.

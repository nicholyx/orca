# Maintenance & Delivery Process

> How this fork is maintained on GitHub: issues, PRs, commits, CI gates, and
> the path to a release. These rules exist so that no session has to remember
> them — they were all learned by doing (Epic Issue #1, PRs #2–#18).

## When to read what

| Situation | Read |
| --- | --- |
| Starting any new work (feature, fix, docs) | [GitHub Workflow](./github-workflow.md) |
| About to merge, or deciding whether something is "done" | [Delivery Gate](./delivery-gate.md) |
| Touching `mobile-harmony/` code | [`../mobile-harmony/index.md`](../mobile-harmony/index.md) |

The operating skills reference these specs:
- `feature-delivery-loop` (`.claude/skills/feature-delivery-loop/SKILL.md`)
  triggers the delivery loop; the normative rules live here.
- `trellis-before-dev` / `trellis-check` / `trellis-update-spec` handle the
  per-task loop around them.

## Non-negotiables (the short version)

1. **Test gate before package**: CI `verify` green is a precondition for any
   HAP artifact (enforced by the workflow's `needs` chain).
2. **Artifact ≠ release**: fully automated runs deliver artifacts only; a
   release is an explicit human decision after the manual device pass.
3. **Small PRs**: one concern per PR, Conventional Commits, squash-merge.
4. **Credentials and signing material never enter git, issues, PRs, or logs.**
5. Anything learned the hard way gets written back here
   (`trellis-update-spec`), not kept in a session's memory.

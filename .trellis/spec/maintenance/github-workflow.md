# GitHub Workflow: Issues, PRs, Commits

> Proven across Epic Issue #1 and PRs #2–#18. Rules here are the "why and how";
> the CI mechanics they depend on are in [`../mobile-harmony/build-and-ci.md`](../mobile-harmony/build-and-ci.md).

## Repo layout facts

- `origin` = `nicholyx/orca` (this fork), `upstream` = `stablyai/orca`.
  All work targets **origin**; never push to upstream, never touch its release
  workflows.
- Issues were disabled by default on the fork — they are enabled now; don't
  turn them off.
- The fork **does not register workflows until they land on the default
  branch**: a new workflow never runs on its own feature branch. Merging the
  CI PR itself (push event) is the first real test of it.

## Issues

- One theme, one Epic Issue: **背景**（real pain, not slogans）·
  **期望**（acceptance checkboxes）· **范围与非目标** · **实施记录**（PR table,
  updated as things merge）. Example: [#1](https://github.com/nicholyx/orca/issues/1).
- PRs reference `Part of #N`; the PR that completes the epic uses `Closes #N`.
- Verify scope before implementing: an issue's premise can be wrong — comment
  and re-scope rather than implement the wrong thing.

## Branches, commits, PRs

- Branch from the **fetched** `origin/main` (a stale local ref silently bases
  your PR on old main — this bit twice on 2026-09-15). Naming:
  `feat/*` `fix/*` `docs/*` `ci/*` `test/*`.
- **One concern per PR.** Layered work lands bottom-up so every intermediate
  main is self-consistent (the HarmonyOS port landed as scaffold → core →
  transport → UI → verification → CI).
- Conventional Commits; the PR title becomes the squash-merge commit message,
  so it must pass the same bar. Body explains **why**, not just what.
- PR body structure (write to a temp file, `gh ... --body-file` — nested
  heredocs have silently dropped bodies before):
  为什么 → 做了什么 → 关键取舍（含被否掉的方案）→ 测试.
- Merge style: `gh pr merge <N> --squash --delete-branch`.
- **Check the PR title when merging by number.** `gh pr merge 6` merged the
  app-UI PR when the verification PR was intended; the missing files only
  surfaced as a CI working-directory failure later.
- PRs touching `mobile-harmony/**` get the `Mobile Harmony Checks` run; other
  PRs get no HarmonyOS check (the workflow is path-filtered — a repo-wide
  always-run summary job is a known gap, tracked in Epic #1).

## Workflow-file rules

- `actionlint` before pushing any `.github/workflows/*.yml` change; multi-line
  `run:` scripts start with `set -euo pipefail`; markdown backticks go in a
  quoted heredoc, never in single-quoted `echo` (SC2016 — cost one build).
- Every step worth keeping has a `Why:` comment, matching the repo's
  existing workflow style.
- Reproduce CI-only failures locally when the failing piece is shell (the
  summary fence bug was verified against a fake `$GITHUB_STEP_SUMMARY`
  before the fix was pushed).

## Network discipline

`gh`/`git push` fail transiently several times a day (EOF / SSL_ERROR_SYSCALL).
Retry 3–5× with a short sleep before diagnosing; a merge that printed an EOF
may still have succeeded — check `gh pr view <N> --json state` before retrying
a non-idempotent call.

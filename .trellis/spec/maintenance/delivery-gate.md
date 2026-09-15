# Delivery Gate: Test → Package → Manual Pass → Release

> The six-stage loop codified in the `feature-delivery-loop` skill, stated as
> testable rules. CI mechanics: [`../mobile-harmony/build-and-ci.md`](../mobile-harmony/build-and-ci.md).

## The loop

```
plan (issue) → implement (small PRs) → verify (full regression, incl. e2e)
   → package (CI artifact) → manual device pass (human) → release (human-approved)
```

## The rules

1. **Full regression, not just new tests.** The gate is the whole suite —
   `run-interop.sh` (2 337 assertions + static checks; see
   [`../mobile-harmony/verification.md`](../mobile-harmony/verification.md)).
   CI enforces it structurally: `build-hap` has `needs: verify`, so a red
   verify means no package exists at all.
2. **End-to-end is mandatory** and its peer is the repo's **own production
   code** (the desktop session modules), never a mock shadow of it.
3. **Automated runs deliver artifacts, never releases.** The HAP lands as the
   `orca-harmony-debug` artifact (14-day retention) plus a run summary with
   the assertion totals and install notes.
4. **Release requires an explicit human go.** The maintainer installs the
   artifact, runs the manual device pass (ArkUI rendering/gestures, ability
   lifecycle, on-device `@kit` behaviour — the parts no host-side harness
   can see), and only then asks for a release. Release tooling is then a
   separate `ci/*` PR (tag-triggered signed build).
5. **A signed package needs secrets; unsigned cannot install.** HarmonyOS
   NEXT has no sideloading. The four `HARMONY_SIGNING_*` secrets activate the
   signing steps; anything less falls back to the unsigned build (never a
   half-signed one). Secrets and signing material never enter git, issues,
   PRs, or logs.
6. **Manual-pass findings are regular bugs.** They come back as `fix/*` PRs
   through the same gate — no "quick patches" bypassing the loop.

## Definition of done (per PR)

- [ ] `run-interop.sh` ALL SUITES PASSED locally before pushing.
- [ ] CI green (verify at minimum; build-hap when packaging matters).
- [ ] Diff self-reviewed against
      [`../mobile-harmony/arkts-subset.md`](../mobile-harmony/arkts-subset.md)
      — the host checks cannot see those classes.
- [ ] Docs updated when behaviour or scope changed
      (`mobile-harmony/docs/*`, this spec via `trellis-update-spec`).
- [ ] The PR's issue links updated (Epic checkbox / 实施记录 table).

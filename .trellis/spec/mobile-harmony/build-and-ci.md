# Build, CI & Delivery

> Source of truth: `.github/workflows/mobile-harmony.yml` and the
> `feature-delivery-loop` skill (`.claude/skills/feature-delivery-loop/SKILL.md`).
> No HarmonyOS toolchain exists on dev machines; CI is the only HAP producer.

## Toolchain

- Project pins `modelVersion 26.0.0` / API 26 (HarmonyOS NEXT). Do not lower it.
- Zip-style toolchain mirrors (e.g. 6.1.0.816) top out at `modelVersion 6.1.0`
  and **cannot build this project**.
- CI builds inside the public container image
  `ghcr.io/dalongzhuazi/harmonyos-ci:api26` — command-line-tools 26.0.0.461 +
  the matching HarmonyOS 26.0.0 SDK, anonymous pull.
- Container default shell is `sh`; the job pins `defaults: run: shell: bash`
  (`set -o pipefail` is illegal in `sh`). In-container actions use `@v4`
  (the image maintainer's proven template); host-side jobs keep the repo's
  `checkout@v6` convention.

## CI shape (`.github/workflows/mobile-harmony.yml`)

```
verify (interop + e2e + static)   # 2337 assertions, oracle deps in isolated prefix
        │ needs
        ▼
build-hap (debug)                 # real hvigor; a red verify means no package
```

- Triggers: PR + push on `mobile-harmony/**` or the workflow file, plus
  `workflow_dispatch` for on-demand packaging.
- Artifact: `orca-harmony-debug` (14-day retention) — this is the deliverable
  for the manual device pass, **not** a release.
- Workflow changes: run `actionlint` before pushing; write summaries with a
  quoted heredoc (markdown backticks inside single-quoted `echo` trip SC2016).

## Signing

`signingConfigs` is empty in the checked-in `build-profile.json5` — signing
material never enters git (`.signing/` and `*.p12`/`*.cer`/`*.p7b` are
gitignored). The workflow activates signing **only when all four secrets
exist**:

`HARMONY_SIGNING_P12`, `HARMONY_SIGNING_CER`, `HARMONY_SIGNING_P7B`
(base64), `HARMONY_SIGNING_P12_PASSWORD`; optional `HARMONY_SIGNING_KEY_ALIAS`
(default `debugKey`), `HARMONY_SIGNING_KEY_PASSWORD` (default = store password).

A partially configured repo falls back to the unsigned build instead of a
half-signed one. Unsigned HAPs cannot be installed on a device (HarmonyOS NEXT
has no sideloading).

## Delivery loop

Follows `feature-delivery-loop`: implement in small PRs → full regression
(`run-interop.sh`) green → CI packages the artifact → maintainer's manual
device pass → **only after human confirmation** a release is produced.
Release work is a separate `ci/*` PR (tag-triggered signed build); it must
not be wired into the automatic path.

## Local verification before pushing

```sh
cd mobile-harmony/tools/interop
ORACLE_NODE_MODULES=<oracle-dir> ./run-interop.sh   # see verification.md
actionlint .github/workflows/mobile-harmony.yml     # only if the workflow changed
```

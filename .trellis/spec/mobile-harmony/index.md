# HarmonyOS (mobile-harmony) Development Guidelines

> Scope: this fork maintains **only** the HarmonyOS companion app
> (`mobile-harmony/`) and its CI. `mobile/` (React Native) and `src/`
> (Electron) are reference material — read them as the wire-contract oracle,
> do not modify them.

---

## Overview

The port is a native HarmonyOS NEXT app (API 26, ArkTS + ArkUI, Stage model)
that pairs with the Orca desktop runtime over a byte-identical E2EE v2
channel. The architectural bet is `core/` with zero platform dependencies —
that is what makes host-side verification possible without DevEco Studio.

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Architecture & Layering](./architecture-layering.md) | The `core/`/`transport/`/`platform/` boundary, swappable seams, ArkUI reactivity constraints |
| [ArkTS Strict-Subset Rules](./arkts-subset.md) | The 41 violations CI's real compiler caught — the pattern checklist to self-review against |
| [Verification Pipeline](./verification.md) | `run-interop.sh`, the 2 337-assertion suite, when to add harness assertions |
| [Build, CI & Delivery](./build-and-ci.md) | API 26 container toolchain, verify→build-hap gate, signing, the delivery loop |
| [Wire Parity & Pairing Contract](./wire-parity.md) | Byte-identical contract with the desktop, parse-layer rules, deliberate non-features |

Cross-package thinking guides live in [`../guides/`](../guides/index.md).
The repo-wide engineering rules in `AGENTS.md` (naming, reuse-before-
reimplementing, type assertions, max-lines) apply to `mobile-harmony/` too.

---

## Pre-Development Checklist

Before writing code under `mobile-harmony/`:

- [ ] Read the relevant guide above for the layer you are touching.
- [ ] Know your layer: pure logic → `core/`, orchestration → `transport/`,
      `@kit` calls → `platform/`, UI → `views/` (see
      [architecture-layering.md](./architecture-layering.md)).
- [ ] If the change touches a shared wire format, read
      [wire-parity.md](./wire-parity.md) — the reference module is the oracle.
- [ ] If it touches a platform adapter or adds one, plan the `kit-stub` fake
      in the same change.
- [ ] Branch + PR per the `feature-delivery-loop` skill; one concern per PR.

## Quality Check

Before opening the PR (and CI will re-run all of it):

- [ ] `ORACLE_NODE_MODULES=<dir> ./run-interop.sh` — all suites PASS
      (see [verification.md](./verification.md) for the oracle setup).
- [ ] Self-review the diff against [arkts-subset.md](./arkts-subset.md) —
      the host checks cannot see those; CI's `CompileArkTS` is the only
      compiler run.
- [ ] `actionlint .github/workflows/mobile-harmony.yml` if the workflow changed.
- [ ] New behaviour has a harness assertion; new `$profile` resources are
      strict JSON; docs (`ARCHITECTURE.md` / `PARITY.md` / `VERIFICATION.md`)
      updated when behaviour or scope changed.

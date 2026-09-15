# Verification Pipeline

> Source of truth: `mobile-harmony/docs/VERIFICATION.md` and
> `mobile-harmony/tools/interop/run-interop.sh`. DevEco Studio / the ArkTS
> compiler do not exist on the dev machine — this pipeline is how the port
> stays correct without one.

## Run it (always, before pushing)

```sh
cd mobile-harmony/tools/interop
ORACLE_NODE_MODULES=<oracle-dir> ./run-interop.sh
```

Oracle deps are installed into an isolated prefix (never the repo's
`node_modules`):

```sh
npm install --prefix ~/.orca-harmony-oracle tweetnacl @noble/hashes@1.8.0 zod@4.5.4 esbuild
export ORACLE_NODE_MODULES=~/.orca-harmony-oracle/node_modules
```

Missing/unreadable `ORACLE_NODE_MODULES` fails closed with install instructions.

## What the 2 337 assertions cover

| Suite | Kind | Covers |
| --- | --- | --- |
| `verify-interop` (1270) | unit ↔ reference | bytes, UTF-8, base64, SHA-256/HMAC/HKDF, Curve25519, Poly1305/secretbox/box, JSON, E2EE v2 framing/schedule/handshake/session |
| `verify-transport-interop` (822) | unit ↔ reference | terminal framing/router, screencast framing, RPC envelope, unsubscribe, backpressure, reconnect, liveness, registry, capability advertisement |
| `verify-pairing-interop` (127) | unit ↔ reference | pairing URL/offer, invite expiry, host naming, stored records |
| `verify-e2e-interop` (47) | **end-to-end** | shipped client stack vs shipped desktop session over a socket |
| `verify-ui-state` (71) | **view-model** | shipped `OrcaConnection` with only the `@kit` boundary stubbed |
| `check-syntax` | static | import resolution, ArkTS subset basics, `core/` layering |
| `check-arkui` | static | pages, structs, resources, `ForEach` keys, strict JSON for `$profile` |

## Non-negotiable practices

1. **Every ported behaviour gets a harness assertion.** "A port that is not
   asserted is a port that will drift" (`docs/PARITY.md`). The comparison peer
   is always the repo's own production module (`mobile/src/transport/*`,
   `src/shared/*`, `src/main/runtime/rpc/*`) — never a re-typed copy of it.
2. **New platform-adapter seams need a kit-stub fake.** Register the fake in
   `tools/interop/kit-stub.ts` with the real API's parameter arity — a
   single-argument fake silently passes `undefined` while unit tests stay green.
3. **The checkers are themselves tested.** Before trusting a new `check-*`
   rule, inject the fault it guards against and confirm a non-zero exit
   (this caught the `$profile` strict-JSON gap that CI's restool then hit in
   PR #14).
4. **`$profile` resources must be strict JSON.** restool rejects comments and
   trailing commas in `resources/base/profile/*.json` even though neighbouring
   `.json5` files allow them. `check-arkui` section 3b enforces this locally.

## What the pipeline cannot see

Type errors that depend on the ArkUI/ArkTS declarations (`CompileArkTS`) —
see [arkts-subset.md](./arkts-subset.md) for the pattern list, and the CI
`build-hap` job for the only real compiler run. ArkUI rendering, ability
lifecycle, and on-device `@kit` behaviour need the manual device pass
(described in [build-and-ci.md](./build-and-ci.md)).

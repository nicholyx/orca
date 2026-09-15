# Architecture & Layering

> Source of truth: `mobile-harmony/docs/ARCHITECTURE.md` and the enforced
> checker `mobile-harmony/tools/interop/check-syntax.mjs`. This file is the
> operational view — what goes where and what the layer boundary forbids.

## The one rule

**`core/` has zero HarmonyOS dependency.** No `@kit` import, no `@ohos` import,
no device-only global. Everything platform-specific lives in `platform/`,
behind an interface declared in `core/` or `transport/`.

Why it is not negotiable: `core/` being dependency-free is what makes it valid
TypeScript, which is what lets the verification harnesses run the shipped code
on the host and compare it byte-for-byte against the desktop. `check-syntax.mjs`
fails the build on any `@kit` import under `core/` — the rule is enforced, not
aspirational.

## Layer map (dependencies point down only)

```
views/  state/  theme/            ArkUI. Reads snapshots, calls OrcaConnection.
services/OrcaConnection           The facade: composition, snapshots, terminal buffer.
transport/                        RpcClient orchestrator, channel state machine, one-dial session.
core/rpc/                         RPC envelope, framing, trackers, policies.
core/e2ee/  core/crypto/          E2EE v2 contract + primitives.
core/pairing/  core/host/         Local state contracts.
platform/                         @kit adapters (socket, secrets, metadata, RNG, scanner).
```

- A view never touches `RpcClient`.
- `core/` never touches `platform/`.
- `RpcClient` sits in `transport/`, not `core/rpc/`, because it needs
  `RpcSocketSession` — putting it in `core/` would invert the layering.

## The swappable seams

Every interface below exists because a harness needs a second implementation
(fake clock, fake socket, Node RNG). When you add a new platform touchpoint,
add the interface on the `core/`/`transport/` side and the adapter in
`platform/` — then register a fake in `tools/interop/kit-stub.ts`.

| Interface | Declared in | Implemented by |
| --- | --- | --- |
| `E2eeV2Socket` | `transport/` | `platform/HarmonyWebSocketHandle` |
| `RpcSocketHandle` | `transport/` | same |
| `RpcSocketSessionFactory` | `transport/RpcClient` | `platform/DirectRpcSocketFactory` |
| `HostMetadataStore` | `core/host/HostStore` | `platform/PreferencesHostMetadataStore` |
| `HostDeviceTokenStore` | `core/host/HostStore` | `platform/AssetDeviceTokenStore` |
| `RandomBytes` | `core/crypto/RandomSource` | `platform/HarmonyRandom` |

## Platform-adapter gotchas (real bugs, already paid for)

- `@ohos.net.webSocket` exposes **neither** `readyState` nor `bufferedAmount`.
  `platform/HarmonyWebSocketHandle` mirrors readyState locally (WHATWG codes)
  and counts buffered bytes as "sent but promise-unsettled" — do not "simplify"
  either away; the outbound backpressure queue parks on that number.
- HarmonyOS callbacks are `(err, value)` two-argument form. A single-argument
  fake passes `undefined` and all unit tests still go green — fakes must
  replicate the real parameter arity (caught by `verify-ui-state`).

## ArkUI reactivity is a hard constraint, not a style choice

- `@State` arrays are diffed by **identity**: return copies
  (`services/OrcaConnection.ets`), never the live array.
- A growing terminal line must be **replaced with a new object** each chunk,
  and the `ForEach` key must include `text.length`
  (`views/TerminalView.ets`, 2 000-line cap in `services/OrcaConnection.ets`).
- Snapshots are immutable and re-read on change; views never observe live
  mutable objects.

## Adding a subsystem

1. Pure logic → `core/<domain>/` with zero imports beyond other `core/` modules.
2. Orchestration that needs a socket or timers → `transport/`.
3. Any `@kit` call → `platform/` behind an interface from (1) or (2).
4. UI → `views/`, wired through `services/OrcaConnection`; state the view reads
   goes into `state/AppState` snapshots.
5. Then add a matching harness section in `tools/interop/` — see
   [verification.md](./verification.md).

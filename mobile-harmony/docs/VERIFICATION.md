# Verification

The hard part of this port is that its correctness is not visible in the app: a
wrong key schedule or an off-by-one in a frame header produces a client that
connects and then silently shows nothing, on a device the development machine
cannot run. And DevEco Studio — the only thing that can compile ArkTS — is not
installed in this repo's development environment.

So the port is verified from the host, at four levels.

```sh
tools/interop/run-interop.sh
```

Runs in about 4 seconds, needs no emulator or device.

## What runs

| Suite                       | Kind             | Covers                                                                 |
| --------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `verify-interop`            | unit ↔ reference | byte helpers, UTF-8, base64, SHA-256/HMAC/HKDF, Curve25519, Poly1305/secretbox/box, JSON, E2EE v2 framing, key schedule, handshake, end-to-end session |
| `verify-transport-interop`  | unit ↔ reference | terminal framing, terminal router, screencast framing, RPC envelope, unsubscribe builders, backpressure queue, reconnect, liveness, stream registry, capability advertisement |
| `verify-pairing-interop`    | unit ↔ reference | pairing URL extraction, offer acceptance, parser robustness, invite-expiry boundary, accepted-offer shape, host naming, stored-record parsing |
| `verify-e2e-interop`        | **end-to-end**   | the whole shipped client stack against the shipped desktop session, over a socket |
| `verify-ui-state`           | **view-model**   | the shipped `OrcaConnection` and its platform adapters, headless       |
| `check-syntax`              | static           | import resolution, ArkTS subset rules, the `core/` layering rule       |
| `check-arkui`               | static           | page registration, `struct`/`build()`, resource references, `ForEach` keys |

Each suite is an entry point that runs its layers in order; the layers
themselves live in sibling modules (`verify-e2ee-*.ts`, `verify-transport-*.ts`,
`e2e-*.ts`), and the shared plumbing is `harness.ts`. Splitting them is what
keeps every file inside the repo's line budget — the entry points are the names
above, so the commands are unchanged.

Current totals:

```
1270 + 822 + 127 + 47 + 71 = 2337 assertions
52 .ets files, 5 ArkUI + 47 plain
27 ArkUI structural checks
```

## Level 1 — unit comparison against the reference

Each ported module is compared to the repo's own implementation on identical
input: byte for byte, or event for event. `core/` takes no `@kit` import, so it
is valid TypeScript, so it runs on Node — bundled by `build.mjs` with
`--loader:.ets=ts` alongside the reference modules and `tweetnacl` /
`@noble/hashes` / `zod` as the primitive oracles.

**This caught a real bug.** HSalsa20 was initially written to reuse the Salsa20
core, which adds the input state back into its output. `core_hsalsa20` must *not*
— it outputs `(x0, x5, x10, x15, x6, x7, x8, x9)` un-fed-forward. Poly1305 and
SHA-256 matched, so the suite failed on exactly one layer. Without it that bug
ships and every E2EE frame fails to open on the desktop, with no local symptom
beyond "nothing arrives".

It also caught the port treating `relay: null` as an absent key, and skipping the
relay `v` / `e2eeFraming` literals.

## Level 2 — end-to-end against the real desktop

`verify-e2e-interop` runs the **shipped** client — `RpcClient` →
`RpcSocketSession` → `E2eeV2PhysicalChannel` → `E2eeV2ClientSession` → crypto —
against the **shipped** desktop side:

- `DesktopMobileE2EEV2Session` — the production v2 handshake and key schedule
- `handleDesktopMobileE2EEV2Inbound` — the production inbound frame router
- `authenticateMobileE2EE` — the production auth validator

Only the socket is simulated (`desktop-peer.ts`): an in-memory duplex that
delivers asynchronously, hands binary to the receiving end as an `ArrayBuffer`,
and notifies a close exactly once.

That matters more than it sounds. `authenticateMobileE2EE` validates the v2 auth
frame's **exact key set** (`deviceToken,transcriptHashB64,type,v`). A
reimplementation on the harness side would have proved nothing about that; the
real validator accepting the real client's frame does.

Ten scenarios:

| Scenario | Asserts                                                             |
| -------- | ------------------------------------------------------------------- |
| E2E-1    | full handshake to `connected`, with `connected` published last       |
| E2E-2    | the capability advisory reaches the desktop, in reference order      |
| E2E-3    | `terminal.list`, `terminal.subscribe` with viewport + viewer id, scrollback reassembly, incremental output |
| E2E-4    | `terminal.send` arrives verbatim                                     |
| E2E-5    | **only the hello is plaintext** — every later frame is sealed, with nonce/tag/header overhead present |
| E2E-6    | a drop reconnects and the subscription is **replayed on the new socket** |
| E2E-7    | a revoked pairing latches `auth-failed` after a bounded 3-dial budget |
| E2E-8    | a host presenting the **wrong pinned key** never reaches `connected` |
| E2E-9    | foregrounding on a live link sends an immediate liveness probe        |
| E2E-10   | an unimplemented method returns a coded refusal, not a hang          |

## Level 3 — the view-model, headless

ArkUI cannot be rendered without a device, so `verify-ui-state` verifies what the
views depend on. It constructs the **shipped** `OrcaConnection` — not a
reimplementation — with only the `@kit` boundary substituted: `build.mjs`
rewrites every `@kit.*` / `@ohos.*` specifier to `kit-stub.ts`, so the real
`DirectRpcSocketFactory`, `AssetDeviceTokenStore` and
`PreferencesHostMetadataStore` execute unchanged against controllable doubles.

Nine scenarios cover what the screens read:

- `snapshot()` → the state pill (label, tone, host, `lastConnectedAt`)
- `hostRows()` → the host list, including the active row
- `log()` → the connection log, and that it never contains the device token
- `terminal()` → the buffer

And the invariants ArkUI silently depends on, which no type checker can catch:

- `terminal()` and `log()` must return **fresh arrays**, because ArkUI decides a
  `@State` array changed by identity — returning the live array freezes the list
  after the first frame.
- A growing final terminal line must be a **new object** with a changed row key,
  or that row never re-renders.
- All row keys must be unique.
- The buffer is capped at 2 000 lines.
- A `scrollback` snapshot **replaces** the buffer; `data` appends. Treating a
  snapshot as an append duplicates the visible history.

Plus the storage contract: the device token never appears in the preferences
file, the credential is written with first-unlock accessibility, a legacy record
carrying an embedded `deviceToken` is dropped, an unreadable list **fails
mutations closed** instead of being overwritten, and an unreadable credential
hides the host.

**This level caught three real bugs**, all of which would have shipped:

1. A stale host-list cache. `saveHostFromOffer` reads the list mid-mutation to
   name a new host, which repopulated the cache from pre-mutation state — so the
   user paired successfully and then saw an empty list.
2. The in-memory token cache defeated the documented "hide a host whose
   credential cannot be read" invariant, so a credential the OS had wiped (which
   removing the lock screen does) left a host listed and permanently failing to
   authenticate, with nothing on screen to explain it.
3. No CRLF normalisation, so every terminal line kept a trailing `\r` — which
   would have corrupted copy/paste and made lines compare unequal.

## Level 4 — static checks

`check-syntax.mjs` — per file:

- **every relative import resolves.** This found four real, build-breaking
  imports (`../bytes/Utf8` instead of `../core/bytes/Utf8`, and `RpcClient`
  reaching across layers); nothing else here could see them, because the ArkTS
  compiler is unavailable and a harness only follows the imports it needs.
- ArkTS subset rules: no `any`/`unknown`, no `var`, no destructuring, no function
  expressions, no unannotated bare object literal, no `eval`, no `delete`.
- The layering rule: **`core/` must not import `@kit`/`@ohos` or `platform/`**.
  This is what makes levels 2 and 3 possible, so it is enforced mechanically.

`check-arkui.mjs` — the class of mistake that shows up as a blank screen:

- every page in `main_pages.json` exists, and every file in `pages/` is
  registered;
- every `struct` has a `build()`, and each page has exactly one `@Entry`;
- every `$string:` / `$media:` / `$color:` / `$profile:` reference and every
  `srcEntry` resolves;
- every view imported from `views/` is actually exported by its module;
- every `ForEach` has a key generator (without one ArkUI matches rows by index
  and reuses the wrong ones);
- `NavDestination` appears only inside a `Navigation`;
- no `readonly` `@State`.

Both checkers were **negative-tested**: injecting a bad import, a `@kit` import
into `core/`, a ghost page, a nonexistent resource and a bogus `srcEntry` all
produce failures and a non-zero exit. A linter that has never failed proves
nothing.

## What this still does not cover

Be clear about the boundary:

- **ArkUI rendering, layout, gestures, and the ability lifecycle.** Nothing here
  exercises them; the view-model tests stop at the data the views read.
- **Type errors that depend on the ArkUI runtime's declarations.** `check-syntax`
  parses and checks the ArkTS subset; it is not the ArkTS compiler. The ArkUI
  `struct` DSL is not parseable by esbuild at all, so those five files get a
  brace-balance check plus `check-arkui`'s structural rules.
- **Device-specific behaviour of `@kit.NetworkKit`.** The adapter mirrors
  `readyState` and tracks in-flight bytes locally because the official API
  exposes neither; that emulation is exercised by the fakes but not by the real
  platform. Whether the device reports close codes as assumed is unverified.
- **Asset Store and preferences on a real device.** The stubs model the
  documented behaviour (unique aliases, error codes, flush semantics); the real
  implementations may differ in ways the documentation does not state.
- **ScanKit.** Faked; the scan flow itself is untested.

An on-device pass against a real desktop is still required before release. This
suite makes that pass a formality rather than a debugging session.

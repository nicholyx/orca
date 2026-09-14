# Orca Mobile for HarmonyOS

A native HarmonyOS companion app for the Orca desktop runtime. It pairs with a
desktop over the LAN (or any reachable address), establishes the same
end-to-end-encrypted channel the iOS/Android client uses, and streams terminals.

This is an **additive** port: nothing in `mobile/` (React Native) or `src/`
(Electron) was modified. It reuses their wire contract — the same E2EE v2
handshake, the same RPC envelope, the same terminal framing — so a desktop that
works with the existing mobile app works with this one, with no server-side
change.

## Stack

| Concern       | Choice                                                                |
| ------------- | --------------------------------------------------------------------- |
| SDK           | HarmonyOS **NEXT API 26.0.0** (`26.0.0`), `runtimeOS: HarmonyOS`       |
| UI            | ArkTS + ArkUI **declarative** (Stage model), `Navigation`/`NavPathStack` |
| Crypto        | Pure-ArkTS X25519 + XSalsa20-Poly1305 + SHA-256/HMAC/HKDF (no native deps) |
| Transport     | `@kit.NetworkKit` `webSocket`                                          |
| Secret store  | `@kit.AssetStoreKit` (Asset Store)                                     |
| Metadata      | `@kit.ArkData` preferences                                             |
| Randomness    | `@kit.CryptoArchitectureKit` `cryptoFramework.createRandom()`           |
| QR scanning   | `@kit.ScanKit` `scanBarcode.startScanForResult()`                       |

No legacy framework is involved: no FA/FA-model config, no `@ohos.` deprecated
module forms where a Kit import exists, no third-party crypto or WebSocket
shim.

## Layout

```
entry/src/main/ets/
  core/          platform-free logic — no @kit import anywhere under here
    bytes/       base64, byte helpers, UTF-8
    crypto/      Salsa20/HSalsa20, Poly1305, Curve25519, SHA-256, HMAC, HKDF
    e2ee/        the E2EE v2 contract, key schedule, framing, client session
    json/        typed JSON narrowing helpers
    rpc/         RPC envelope, terminal/screencast framing, request tracker,
                 stream registry, backpressure queue, reconnect, liveness,
                 capability advertisement, the RpcClient orchestrator
    pairing/     pairing-offer parsing
    host/        host-profile model and store
  transport/     the channel state machine and one-dial socket session
  platform/      the ONLY @kit consumers: socket, secret store, metadata,
                 randomness, QR scanner
  services/      OrcaConnection — the facade the views talk to
  state/         immutable view snapshots
  theme/         design tokens copied from src/renderer/src/assets/main.css
  views/         ArkUI screens
  pages/         the single page + navigation graph
  entryability/  ability entry point
```

The `core/` layer is the point of the whole arrangement: it has no HarmonyOS
dependency at all, so it can be — and is — executed on the host under Node and
compared against the desktop's own implementation. See
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

## Build

Open the `mobile-harmony/` directory in **DevEco Studio** (which bundles
hvigor), or build from the CLI once the toolchain is installed:

```sh
hvigorw assembleHap --mode module -p buildMode=debug
```

Signing must be configured in DevEco Studio (*File → Project Structure →
Signing Configs*) before a device install; the app has no signing material
checked in.

`build-profile.json5` pins `compileSdkVersion` / `compatibleSdkVersion` /
`targetSdkVersion` to `26.0.0`. To widen device coverage, lower
`compatibleSdkVersion` to an older Release string — the code uses no API newer
than what API 12 provides except ScanKit's Kit import form.

## Verify

```sh
tools/interop/run-interop.sh
```

Runs the whole verification pipeline from the host in about 4 seconds — no
emulator and no device needed:

- three harnesses comparing every ported module to the repo's own reference
  implementation, byte for byte;
- an **end-to-end** suite running the shipped client against the shipped desktop
  session (`DesktopMobileE2EEV2Session`, `handleDesktopMobileE2EEV2Inbound`,
  `authenticateMobileE2EE`) over a simulated socket;
- a **view-model** suite running the shipped `OrcaConnection` with only the
  `@kit` boundary substituted;
- static checks for import resolution, the ArkTS subset, the `core/` layering
  rule, and the ArkUI structure (pages, `struct`/`build()`, resources, `ForEach`
  keys).

2 337 assertions. See [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) for what
each level covers — and, importantly, for what it does not: ArkUI rendering,
ability lifecycle, and real-device `@kit` behaviour still need a device pass.

## What works today

- Pairing by QR scan or pasted code (`orca://pair?code=…` or the bare blob).
- Direct WebSocket connection with the full E2EE v2 handshake, capability
  advertisement, liveness probing, and reconnect with backoff.
- Terminal: list, attach, stream output, send input, switch terminal.
- Paired-host management: add, re-pair, forget; credentials in the Asset Store.
- A redacted connection log for diagnosis.

See [`docs/PARITY.md`](./docs/PARITY.md) for what is deliberately not implemented yet.

# Architecture

## The one rule

`core/` has no HarmonyOS dependency. No `@kit` import, no `@ohos` import, no
global that only exists on device. Everything platform-specific lives in
`platform/`, behind an interface declared in `core/` or `transport/`.

That is not tidiness for its own sake. It is what makes the protocol stack
executable on the development machine and comparable, byte for byte, against the
desktop's own implementation — see [`VERIFICATION.md`](./VERIFICATION.md). The
first version of this port had a wrong HSalsa20 that only the harness could see.

## Layers

```
views/  state/  theme/            ArkUI. Reads snapshots, calls OrcaConnection.
services/OrcaConnection           The facade: composition, snapshots, terminal buffer.
transport/                        RpcClient orchestrator, channel state machine, one-dial session.
core/rpc/                         RPC envelope, framing, trackers, policies.
core/e2ee/  core/crypto/          E2EE v2 contract + primitives.
core/pairing/  core/host/         Local state contracts.
platform/                         @kit adapters (socket, secrets, metadata, RNG, scanner).
```

Dependencies point downward only. A view never touches `RpcClient`; `core/` never
touches `platform/`. `RpcClient` sits in `transport/` rather than `core/rpc/`
because it needs `RpcSocketSession` — putting it in `core/` would have inverted
the layering, and the static checker (`check-syntax.mjs`) enforces the rule.

## The interfaces that make it swappable

| Interface                | Declared in               | Implemented by                |
| ------------------------ | ------------------------- | ----------------------------- |
| `E2eeV2Socket`           | `transport/`              | `platform/HarmonyWebSocketHandle` |
| `RpcSocketHandle`        | `transport/`              | same                           |
| `RpcSocketSessionFactory`| `transport/RpcClient`     | `platform/DirectRpcSocketFactory` |
| `HostMetadataStore`      | `core/host/HostStore`     | `platform/PreferencesHostMetadataStore` |
| `HostDeviceTokenStore`   | `core/host/HostStore`     | `platform/AssetDeviceTokenStore` |
| `RandomBytes`            | `core/crypto/RandomSource`| `platform/HarmonyRandom`   |

Each of these exists because a test or a harness needs a second implementation:
a fake clock, a fake socket, Node's RNG. That is not a side effect — it is why
the end-to-end and view-model suites can run the shipped code on the host at
all. `tools/interop/kit-stub.ts` is the `@kit` half of that seam: `build.mjs`
rewrites every kit specifier to it, so the real adapters execute against
controllable doubles.

## Connection lifecycle

```
openConnection()
  publish 'connecting'
  factory.open(preflight)  →  new socket + new E2EE session
        │
        ├─ on('open') ────────► publish 'handshaking'
        │                        send plaintext hello
        │                        arm handshake deadline (5 s)
        │
        ├─ e2ee_ready ────────► channel: awaiting-authenticated
        │                        send sealed e2ee_auth{deviceToken}
        │
        ├─ e2ee_authenticated ► channel: ready
        │                        publish nothing yet
        │                        advertise capabilities (5 s budget)
        │                          └─ settled ──► publish 'connected'
        │                                          reconnect.authenticated()
        │                                          streams.replayAfterAuthentication()
        │
        └─ on('close')/error ─► handleSocketClosed()
                                 requests.rejectAll(deliveryUnknown: true)
                                 streams.markForReplay()
                                 publish 'reconnecting'
                                 reconnect.schedule()
```

Three details in that sequence are load-bearing:

**`connected` is published last.** It is published only after the capability
advisory settles, so anything awaiting `waitForConnected()` can immediately send
a request the host has already been told how to read. Publishing earlier would
make that guarantee false.

**Only a frame that never reached the wire fails the connection.** The advisory's
result is discarded and an unanswered request says nothing about the link, so a
timeout settles as "capabilities unavailable, proceed". The one case that forces
a reconnect is a `send` that could not be written at all — nothing else would
close a socket that cannot carry traffic.

**A new session per dial.** The E2EE v2 key schedule is bound to the client nonce
in the hello, so reusing a session across sockets would reuse an ephemeral key and
defeat forward secrecy. `DirectRpcSocketFactory` is what makes per-dial
construction the only path.

## Terminal data path

Terminal output does not arrive as JSON. It arrives as binary frames, tagged with
a stream id:

```
socket ──► E2eeV2PhysicalChannel (decrypt)
        ──► RpcClient ──► RpcStreamRegistry.handleBinary
                        ──► TerminalStreamRouter (reassemble snapshot / chunks)
                        ──► TerminalStreamEvent ──► subscriber listener
```

`scrollback` and `resized` carry a **whole-screen snapshot** and replace the
buffer; `data` carries a chunk and appends. Treating a snapshot as an append
duplicates the visible history, which is why `OrcaConnection` routes the two
differently.

The buffer is capped at 2 000 lines and the last partial line is rewritten as a
**new object** on each chunk. That second detail is not cosmetic: ArkUI keys
rendered rows by identity, so mutating a line in place leaves a growing final
line invisible. The list key includes the line's text length for the same reason.

## State

Snapshots are immutable and re-read on each change, rather than views observing
live mutable objects. `OrcaConnection` hands out **copies** of its arrays because
ArkUI decides whether a `@State` array changed by identity — returning the live
array would freeze the list after the first frame.

## Storage

A paired host is split in two:

- **metadata** (id, name, endpoint, pinned desktop key, last-connected) → ArkData
  preferences, a plain file that participates in device backups;
- **the device token** → the Asset Store, the platform's integrity-protected
  secret store, with `DEVICE_FIRST_UNLOCKED` accessibility.

The split is the security boundary: preferences is readable by a backup or a
rooted shell, and a device token is a bearer credential for the entire runtime
RPC surface. A host whose token cannot be read is hidden from the list rather
than offered in a state that can never authenticate, and a stored list that
cannot be parsed fails mutations closed instead of being overwritten.

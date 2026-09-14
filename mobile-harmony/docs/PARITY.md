# Parity with the existing mobile client

This app is a port, not a reimplementation. Where behaviour is shared it is
**byte-identical** and proven so by the interop harnesses; where it is not, the
gap is listed here rather than left for a user to discover.

## Wire contract — at parity

Everything below is asserted against the repo's own reference modules in
`tools/interop/`, not just against a written specification.

| Area                       | Reference it matches                                        |
| -------------------------- | ----------------------------------------------------------- |
| E2EE v2 key schedule       | `mobile/src/transport/mobile-e2ee-v2-*`                     |
| E2EE v2 framing            | same                                                        |
| E2EE v2 handshake messages | same                                                        |
| Client session             | `mobile-e2ee-v2-client-session`                             |
| RPC envelope               | `mobile/src/transport/rpc-response-shape`                   |
| Terminal stream framing    | `mobile/src/transport/terminal-stream-protocol`             |
| Browser screencast framing | `mobile/src/transport/browser-screencast-protocol` (decoder) |
| Stream unsubscribe shapes  | `rpc-client-terminal-subscription`, `rpc-client-server-subscription` |
| Reconnect schedule         | `rpc-client-reconnect-schedule` (delays, attempt limit, trickle) |
| Liveness watchdog          | `rpc-session-liveness-watchdog`                             |
| Outbound backpressure      | `src/shared/ws-outbound-backpressure-queue`                 |
| Capability advertisement   | `mobile-runtime-client-capabilities`                        |
| Pairing URL + offer        | `mobile/src/transport/pairing`, `src/shared/mobile-relay-pairing-offer` |
| Host naming + stored record | `host-names`, `StoredHostProfileSchema`                    |

## Implemented

- Pairing: QR scan, pasted URL, pasted blob. All three go through one parser.
- Direct connection: TCP/WS, E2EE v2 handshake, capability advisory, `connected`
  only after the advisory settles, parked subscriptions replayed on reconnect.
- Recovery: connect timeout, handshake timeout, auth-rejection retry budget,
  exponential backoff to 60 s then 90 s trickle, foreground stale-dial reset.
- Liveness: idle probe, miss budget, forced reconnect.
- Terminal: `terminal.list`, `terminal.subscribe` with a per-viewer client id,
  `terminal.send`, snapshot vs incremental handling.
- Host store: credential in the Asset Store, metadata in preferences,
  serialized read-modify-write, fail-closed on an unreadable list, legacy
  records carrying an embedded secret dropped.
- Connection log, redacted to the endpoint host.

## Not implemented (deliberately)

| Feature                          | Why                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| **Relay (`relay:` offers)**      | The offer parser accepts a relay offer — it is a valid offer, and rejecting it there would diverge from the reference validator, which the harness asserts byte for byte. The **app layer** refuses it (`OrcaConnection.pairFromOffer`), with a message telling the user to use a direct code. The relay client would need director/cell URL negotiation, an invite-token lifecycle, and a pairing journal; shipping the parse without the transport would store a pairing that can never connect. Direct links are fully supported. |
| Browser screencast               | The frame decoder is ported and verified; there is no view for it yet.              |
| Native chat / agent session UI   | Out of scope for a first version; the capabilities for it are *still advertised*, because a host that sees a missing capability degrades to the legacy carrier rather than failing. |
| Session tabs                     | Not surfaced; `session.tabs.*` is not subscribed.                                   |
| Terminal query replies           | `terminal.send` is used for input. `mobile-terminal-query-reply` (OSC colour/CSI replies) is not ported, so a program that queries the terminal for its colours will not get an answer. |
| Git / worktree / files screens   | Not part of the mobile client either.                                               |
| Relay failover, endpoint supervisor | Belongs to the relay path.                                                      |

## Intentional divergences

Two, both narrow, both asserted in the harness so they cannot drift silently:

1. **`parseStoredHostProfileList('')`** returns "unreadable" where the reference
   returns "empty". Unreachable in practice: the preferences layer maps "no
   stored value" to `null` before the parser runs.

2. **`validatePairingOffer` rejects `relay: null`** exactly as the reference
   does (a present key with a null value is not an absent key). It is listed
   because the harness caught this as a real bug in an earlier revision of the
   port: the first version treated `null` as absent and silently downgraded an
   offer the desktop had flagged.

## Client-side choices (not covered by the harness)

These are decisions this app makes that have no reference counterpart to be
byte-compared against. They are called out here so they are not mistaken for
verified parity:

- **Terminal input appends `\n`.** The host writes the text into the PTY
  verbatim, so the trailing newline is what makes a typed command execute —
  the same thing a physical Enter key produces.
- **Terminal output is normalised to LF.** A completed line's trailing `\r` is
  dropped, because this list renders plain text rather than a terminal grid: a
  stray CR would corrupt copy/paste and make every line compare unequal. A line
  that is still being written is left alone, so a CRLF split across two chunks
  is handled correctly.
- **The terminal buffer keeps 2 000 lines.** A bounded buffer is required: an
  unbounded one lets a long-running session exhaust the renderer's heap.
- **Backups are disabled** (`backup_config.json`). The host list names machines
  on a private network and the Asset Store holds bearer credentials; neither
  belongs in a cloud backup.
- **A relay pairing code is refused at the app layer**, not the parse layer. See
  the table above.


## Adding a feature

If you port another subsystem, add a matching section to a harness in
`tools/interop/` and compare against the reference module on identical input.
A port that is not asserted is a port that will drift.

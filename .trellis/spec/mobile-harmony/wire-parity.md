# Wire Parity & Pairing Contract

> Source of truth: `mobile-harmony/docs/PARITY.md` and the harnesses in
> `mobile-harmony/tools/interop/`. The port reuses the desktop's wire contract;
> it does not reinterpret it.

## The parity principle

This app is a port, not a reimplementation. Where behaviour is shared it is
**byte-identical** and proven so by the interop harnesses; where it is not,
the gap is listed in `docs/PARITY.md` rather than left for a user to discover.

## Hard rules

1. **The parse layer never diverges from the reference validator.**
   `core/pairing/PairingOffer.ets` mirrors `src/shared/mobile-relay-pairing-offer.ts`
   exactly — including `relay: null` being rejected as a present key with a
   null value (the harness caught the first version silently downgrading an
   offer the desktop had flagged). Behaviour decisions that need UI context
   (e.g. refusing a relay offer) belong in the app layer
   (`services/OrcaConnection.pairFromOffer`), with a message telling the user
   what to do instead.

2. **Client-side choices must be written down.** Decisions with no reference
   counterpart (terminal input appends `\n`; completed lines are CR-normalised;
   the 2 000-line buffer cap; backups disabled; credentials in the Asset Store
   with `DEVICE_FIRST_UNLOCKED`) are listed in `docs/PARITY.md` so they are not
   mistaken for verified parity.

3. **Deliberate non-features stay listed.** Relay transport, browser screencast
   view, session tabs, terminal query replies — each has a reason in the
   `docs/PARITY.md` table. When one gets implemented, it moves out of the table
   and gains harness assertions in the same PR.

4. **Capability advertisement is load-bearing.** The client advertises
   capabilities even for unimplemented UI (chat/agent sessions) because a host
   that sees a missing capability degrades to the legacy carrier instead of
   failing — see `core/rpc/MobileRuntimeCapabilities.ets`.

## When you touch a shared module

Changing anything under `mobile/src/transport/` or `src/shared/mobile-*` on the
desktop side will silently desynchronise the port unless the harness catches
it — the harnesses import those production modules as their oracle, so a
reference change that alters behaviour makes `run-interop.sh` fail. If it
fails, port the change and add/adjust the byte-level assertion in the same PR;
never loosen an assertion to make it pass.

## Failure vocabulary

Connection diagnostics use the desktop's verdict vocabulary (`live` /
`unverifiable` / `exited` — see AGENTS.md → SSH Use Case). Loss of contact is
never reported as process death; `RpcSocketSession` logs protocol errors
distinctly from network closes for the same reason.

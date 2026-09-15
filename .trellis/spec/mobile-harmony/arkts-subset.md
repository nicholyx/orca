# ArkTS Strict-Subset Rules

> Source of truth: PR #15 / #16 — the real `CompileArkTS` pass in CI caught 41
> violations that every host-side check (esbuild parse, `check-syntax.mjs`
> patterns) cannot see. Every rule below is one of those 41, with the file that
> paid for it. When you write ArkTS, scan for these patterns **before** pushing,
> because the compiler only runs in CI.

---

## The rules

### 1. No string-indexed access (`arkts-no-props-by-index`)

`STANDARD_ALPHABET[i]` is illegal — strings are not indexable in ArkTS.

**Fix pattern** (from `mobile-harmony/entry/src/main/ets/core/bytes/Base64.ets`):
pre-compute a numeric table once and read it with a numeric index.

```ts
let ENCODE_TABLE: Uint8Array | null = null;
function encodeTable(): Uint8Array {
  if (ENCODE_TABLE === null) {
    const table = new Uint8Array(64);
    for (let index = 0; index < table.length; index++) {
      table[index] = STANDARD_ALPHABET.charCodeAt(index);
    }
    ENCODE_TABLE = table;
  }
  return ENCODE_TABLE;
}
// out += String.fromCharCode(table[(chunk >> 18) & 0x3f]);
```

### 2. Object literals must bind to a declared interface

Both the parameter type and the call site count:

- `function f(args: { a: string })` — **illegal** (`arkts-no-obj-literals-as-types`); declare `interface FArgs { a: string }`.
- `f({ a: x })` where the parameter type was broken — **illegal** (`arkts-no-untyped-obj-literals`).

**Fix pattern** (from `E2eeV2Framing.ets` / `E2eeV2ClientSession.ets`):

```ts
export interface E2eeV2FrameSealArgs extends E2eeV2FrameArgs {
  payload: Uint8Array;
}
const sealArgs: E2eeV2FrameSealArgs = { payload, key, sessionId, direction, payloadKind, counter };
const frame = sealE2eeV2Frame(sealArgs);
```

### 3. Only `Error` instances may be thrown (`arkts-limited-throw`)

`throw error;` fails when `error` is `Object` or a kit interface (e.g. `BusinessError`).

**Fix pattern** (from `platform/AssetDeviceTokenStore.ets`): keep real errors,
wrap the rest, preserve the code.

```ts
throw error instanceof Error
  ? error
  : new Error(`asset add failed with code ${code}`);
```

### 4. `struct` properties need initializers (`strictPropertyInitialization`)

ArkUI structs have no constructor, so a plain `connection: OrcaConnection;` is
"never assigned". Definite-assignment (`!:`) is not available.

**Fix pattern** (from all four `views/*.ets`): nullable default + fail-closed
accessor — never a dummy instance that masks a missing injection.

```ts
connection: OrcaConnection | null = null;

/** Fail-closed access: the view is inert until the page injects a connection. */
private conn(): OrcaConnection {
  if (this.connection === null) {
    throw new Error('TerminalView used before its connection was injected');
  }
  return this.connection;
}
```

### 5. No call signatures in interfaces (`arkts-no-call-signatures`)

```ts
// illegal                          // legal
interface ConnectionLogSink {       export type ConnectionLogSink =
  (entry: ConnectionLogEntry): void;  (entry: ConnectionLogEntry) => void;
}
```

### 6. No indexed type aliases (`arkts-no-aliases-by-index`)

`RpcClientOptions['onLog']` is illegal. Write the concrete type out
(`((entry: ConnectionLogEntry) => void) | null`, as `platform/DirectRpcSocketFactory.ets` does).

### 7. `typeof` narrowing does not survive `Record` typing

```ts
const transportValue = record.transport;      // typed Object
if (transportValue !== 'direct') return null; // narrows in TS, NOT in ArkTS
use(transportValue);                          // still Object → compiler error
```

**Fix pattern** (from `E2eeV2Contract.ets` `parseContext`): validate, then
convert once, explicitly.

```ts
const transport = String(transportValue);  // after null/undefined/enum checks
```

### 8. Verify platform API signatures against the API 26 declarations

Two real incidents from PR #15:

- `setWindowBackgroundColor` is **synchronous** on this API — chaining `.catch()`
  on `void` is a compile error. Use `try/catch` (`entryability/EntryAbility.ets`).
- `promptAction.showActionMenu` buttons are a **6-slot tuple** of
  `promptAction.Button` (not `ActionMenuButton`). A dynamic list must be sliced
  to six and materialized slot-by-slot (`views/TerminalView.ets` `showTerminalPicker`).

### 9. Null-aware member access

`RpcResponse.error` is `RpcErrorBody | null` — `response.error.code` is a
compile error; write `response.error?.code` (`transport/RpcClient.ets:330`).

---

## Known-legal exceptions

- `as const` is allowed (see AGENTS.md). Any other `as` cast needs a
  line-specific `SAFETY:` comment — e.g. the `(error as BusinessError).code`
  casts in `platform/AssetDeviceTokenStore.ets`.
- Numeric indexing (`bytes[index]`, `table[code]`) is fine; only field-style
  access through a non-number key is banned.

## Where violations surface

| Layer | Catches | Misses |
| --- | --- | --- |
| `check-syntax.mjs` (host) | imports, regex literals, `any`, layering | everything on this page |
| `run-interop.sh` (host) | behaviour regressions, wire drift | types — the harness bundles with `--loader:.ets=ts`, type errors are not checked |
| CI `build-hap` (`CompileArkTS`) | **this whole page** | nothing, but only after you push |

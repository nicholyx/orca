/*
 * Runtime substitutes for the `@kit.*` platform modules.
 *
 * `core/` needs no stub — it imports nothing platform-specific. This file exists
 * for the layer above it: every `platform/*` adapter and `OrcaConnection`
 * import their kit module at the top, and those cannot resolve under Node.
 * `build.mjs` aliases every `@kit.*` / `@ohos.*` specifier to this module, so the
 * REAL adapter code runs unchanged against a controllable double.
 *
 * That is the whole point: the tests exercise the shipped `OrcaConnection`,
 * `DirectRpcSocketFactory` and `AssetDeviceTokenStore`, substituting only the
 * boundary the architecture already isolates. A test against a reimplemented
 * facade would prove nothing.
 *
 * Fakes are installed through `installKit(...)` before the code under test is
 * constructed, and every one of them is deterministic — a failing run must
 * reproduce byte for byte.
 */
import nacl from 'tweetnacl'

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

/** In-memory key-value store standing in for ArkData preferences. */
export class FakePreferences {
  private readonly values = new Map<string, string>()
  putSync(key: string, value: string): void {
    this.values.set(key, value)
  }
  getSync(key: string, fallback: string): string {
    const value = this.values.get(key)
    return value === undefined ? fallback : value
  }
  flush(): Promise<void> {
    this.flushCount++
    return Promise.resolve()
  }
  flushCount = 0
  /** Test hook: corrupt the stored payload to exercise the fail-closed path. */
  poison(value: string): void {
    this.values.set('hosts.v1', value)
  }
  raw(): Map<string, string> {
    return this.values
  }
}

export interface FakeAssetEntry {
  alias: string
  secret: Uint8Array
  accessibility: number
}

/** In-memory Asset Store: aliases are unique, and re-adding one is an error. */
export class FakeAssetStore {
  readonly entries = new Map<string, FakeAssetEntry>()
  readonly accessibilities: number[] = []
  /** Test hook: make every read fail, as an unreadable secret store would. */
  readsFail = false

  add(attributes: Map<number, unknown>): Promise<void> {
    const alias = decodeUtf8(attributes.get(TAG_ALIAS))
    if (this.entries.has(alias)) {
      const error: Error & { code?: number } = new Error('duplicated')
      error.code = ASSET_DUPLICATED
      return Promise.reject(error)
    }
    this.entries.set(alias, {
      alias,
      secret: toBytes(attributes.get(TAG_SECRET)),
      accessibility: Number(attributes.get(TAG_ACCESSIBILITY))
    })
    this.accessibilities.push(Number(attributes.get(TAG_ACCESSIBILITY)))
    return Promise.resolve()
  }

  query(query: Map<number, unknown>): Promise<Map<number, unknown>[]> {
    if (this.readsFail) {
      return Promise.reject(new Error('asset store unavailable'))
    }
    const alias = decodeUtf8(query.get(TAG_ALIAS))
    const entry = this.entries.get(alias)
    if (entry === undefined) {
      const error: Error & { code?: number } = new Error('not found')
      error.code = ASSET_NOT_FOUND
      return Promise.reject(error)
    }
    const result = new Map<number, unknown>()
    result.set(TAG_SECRET, entry.secret)
    result.set(TAG_ALIAS, encodeUtf8(entry.alias))
    result.set(TAG_ACCESSIBILITY, entry.accessibility)
    return Promise.resolve([result])
  }

  remove(query: Map<number, unknown>): Promise<void> {
    this.entries.delete(decodeUtf8(query.get(TAG_ALIAS)))
    return Promise.resolve()
  }
}

function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0)
}

function decodeUtf8(value: unknown): string {
  const bytes = toBytes(value)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return out
}

function encodeUtf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff
  }
  return out
}

// Asset Store tag values, from the official documentation.
const TAG_SECRET = 0x01
const TAG_ALIAS = 0x02
const TAG_ACCESSIBILITY = 0x03
const TAG_RETURN_TYPE = 0x40
const ASSET_DUPLICATED = 24000001
const ASSET_NOT_FOUND = 24000002

// ---------------------------------------------------------------------------
// Installed kit doubles
// ---------------------------------------------------------------------------

export interface KitHooks {
  /** Opens the client end of a fresh link; called once per dial. */
  openSocket: (endpoint: string) => SocketLike
  preferences?: FakePreferences
  assetStore?: FakeAssetStore
  random?: (length: number) => Uint8Array
  /** Records every promptAction call so tests can assert user-visible feedback. */
  dialogs?: { title: string; message: string; buttons: string[] }[]
  toasts?: string[]
  actionMenus?: { title: string; buttons: string[] }[]
  /** Result index to "choose" for the next dialog / action menu. */
  nextChoice?: () => number
  /** Payload the next QR scan returns; null rejects as a user cancellation. */
  scanResult?: string | null
}

export interface SocketLike {
  onOpen: (handler: () => void) => void
  onMessage: (handler: (data: string | ArrayBuffer) => void) => void
  onClose: (handler: (code: number) => void) => void
  onError: (handler: (message: string) => void) => void
  send: (frame: string | ArrayBuffer) => void
  close: () => void
}

let hooks: KitHooks | null = null

export function installKit(next: KitHooks): void {
  hooks = next
}

function requireHooks(): KitHooks {
  if (hooks === null) {
    throw new Error('kit stub used before installKit()')
  }
  return hooks
}

function defaultRandom(length: number): Uint8Array {
  return nacl.randomBytes(length)
}

// --- @kit.NetworkKit -------------------------------------------------------

/**
 * The real adapter subscribes before calling `connect`, so the fake defers
 * "opening" until the connect call — matching the platform's ordering contract
 * rather than the adapter's.
 *
 * Every callback is invoked with the platform's `(error, value)` arity. That
 * matters: the adapter's handlers are written as `(_error, value) => …`, so a
 * fake that passes the payload as the *first* argument leaves `value`
 * `undefined` — and the app then reports "Expected a plaintext E2EE v2 ready"
 * while every unit test still passes.
 */
class StubWebSocket {
  private readonly handlers: {
    open?: (error: unknown, value: unknown) => void
    message?: (error: unknown, value: string | ArrayBuffer) => void
    close?: (error: unknown, value: { code: number; reason: string }) => void
    error?: (error: unknown) => void
  } = {}
  private socket: SocketLike | null = null
  private connected = false

  on(type: string, callback: (...args: never[]) => void): void {
    if (type === 'open') {
      this.handlers.open = callback as unknown as (error: unknown, value: unknown) => void
    }
    if (type === 'message') {
      this.handlers.message = callback as unknown as (
        error: unknown,
        value: string | ArrayBuffer
      ) => void
    }
    if (type === 'close') {
      this.handlers.close = callback as unknown as (
        error: unknown,
        value: { code: number; reason: string }
      ) => void
    }
    if (type === 'error') {
      this.handlers.error = callback as unknown as (error: unknown) => void
    }
  }

  off(_type: string): void {}

  connect(url: string): Promise<boolean> {
    const socket = requireHooks().openSocket(url)
    this.socket = socket
    socket.onOpen(() => {
      this.connected = true
      const handler = this.handlers.open
      if (handler !== undefined) handler(undefined, { status: 0, message: '' })
    })
    socket.onMessage((data) => {
      const handler = this.handlers.message
      if (handler !== undefined) handler(undefined, data)
    })
    socket.onClose((code) => {
      const handler = this.handlers.close
      if (handler !== undefined) handler(undefined, { code, reason: '' })
    })
    socket.onError((message) => {
      const handler = this.handlers.error
      if (handler !== undefined) handler({ code: 0, message })
    })
    return Promise.resolve(true)
  }

  send(frame: string | ArrayBuffer): Promise<boolean> {
    if (!this.connected || this.socket === null) {
      return Promise.reject(new Error('socket is not open'))
    }
    this.socket.send(frame)
    return Promise.resolve(true)
  }

  close(): Promise<boolean> {
    this.socket?.close()
    return Promise.resolve(true)
  }
}

export const webSocket = {
  createWebSocket: (): StubWebSocket => new StubWebSocket(),
  CloseResult: class CloseResult {}
}

// --- @kit.ArkData ----------------------------------------------------------

export const preferences = {
  getPreferences: (_context: unknown, options: { name: string }): Promise<FakePreferences> => {
    return Promise.resolve(requireHooks().preferences ?? new FakePreferences())
  },
  Options: class Options {}
}

// --- @kit.AssetStoreKit ----------------------------------------------------

export const asset = {
  Tag: {
    SECRET: TAG_SECRET,
    ALIAS: TAG_ALIAS,
    ACCESSIBILITY: TAG_ACCESSIBILITY,
    RETURN_TYPE: TAG_RETURN_TYPE
  },
  ReturnType: { ALL: 0, ATTRIBUTES: 1 },
  Accessibility: { DEVICE_FIRST_UNLOCKED: 2, DEVICE_UNLOCKED: 1, DEVICE_POWERED_ON: 0 },
  add: (attributes: Map<number, unknown>): Promise<void> =>
    (requireHooks().assetStore ?? new FakeAssetStore()).add(attributes),
  query: (query: Map<number, unknown>): Promise<Map<number, unknown>[]> =>
    (requireHooks().assetStore ?? new FakeAssetStore()).query(query),
  remove: (query: Map<number, unknown>): Promise<void> =>
    (requireHooks().assetStore ?? new FakeAssetStore()).remove(query),
  update: (): Promise<void> => Promise.resolve()
}

// --- @kit.CryptoArchitectureKit -------------------------------------------

export const cryptoFramework = {
  createRandom: (): { generateRandomSync: (length: number) => { data: Uint8Array } } => ({
    generateRandomSync: (length: number): { data: Uint8Array } => ({
      data: (requireHooks().random ?? defaultRandom)(length)
    })
  })
}

// --- @kit.ArkTS ------------------------------------------------------------

export const util = {
  TextEncoder: class TextEncoder {
    encodeInto(text: string): Uint8Array {
      const bytes: number[] = []
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code < 0x80) {
          bytes.push(code)
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
        }
      }
      return new Uint8Array(bytes)
    }
  },
  TextDecoder: class TextDecoder {
    constructor(_encoding?: string) {}
    decodeToString(bytes: Uint8Array): string {
      return Buffer.from(bytes).toString('utf8')
    }
  }
}

// --- @kit.ArkUI ------------------------------------------------------------

export const promptAction = {
  showDialog: (options: {
    title: string
    message: string
    buttons: { text: string }[]
  }): Promise<{ index: number }> => {
    const kit = requireHooks()
    kit.dialogs?.push({
      title: options.title,
      message: options.message,
      buttons: options.buttons.map((button) => button.text)
    })
    const index = kit.nextChoice === undefined ? 0 : kit.nextChoice()
    return Promise.resolve({ index })
  },
  showToast: (options: { message: string }): void => {
    requireHooks().toasts?.push(options.message)
  },
  showActionMenu: (options: {
    title: string
    buttons: { text: string }[]
  }): Promise<{ index: number }> => {
    const kit = requireHooks()
    kit.actionMenus?.push({
      title: options.title,
      buttons: options.buttons.map((button) => button.text)
    })
    const index = kit.nextChoice === undefined ? 0 : kit.nextChoice()
    return Promise.resolve({ index })
  }
}

// --- @kit.ScanKit ----------------------------------------------------------

export const scanCore = {
  ScanType: { ALL: 0, QR_CODE: 1 }
}

export const scanBarcode = {
  startScanForResult: (): Promise<{ originalValue: string }> => {
    const outcome = requireHooks().scanResult
    if (outcome === null) {
      return Promise.reject(new Error('user cancelled'))
    }
    return Promise.resolve({ originalValue: outcome })
  },
  ScanOptions: class ScanOptions {}
}

// --- @kit.PerformanceAnalysisKit ------------------------------------------

export const hilog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {}
}

// --- @kit.CoreFileKit ------------------------------------------------------

export class BackupExtensionAbility {
  async onBackup(): Promise<void> {}
  async onRestore(_version: unknown): Promise<void> {}
}

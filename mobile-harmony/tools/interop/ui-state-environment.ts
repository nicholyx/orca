/*
 * The installed `@kit` environment the view-model scenarios run against.
 *
 * Re-created per scenario so a scenario cannot inherit another's preferences,
 * credentials or dialogs. This is the seam that lets the *shipped*
 * `OrcaConnection` run on the host: everything the app reaches the platform
 * through is replaced here, and nothing above it is.
 */
import nacl from 'tweetnacl'
import { DesktopPeer } from './desktop-peer'
import type { SocketLike } from './kit-stub';
import {
  FakeAssetStore,
  FakePreferences,
  installKit
} from './kit-stub'
import { createPipe, type PipeSide } from './pipe-side'
import { OrcaConnection } from '../../entry/src/main/ets/services/OrcaConnection.ets'

export const DEVICE_TOKEN = 'device-token-ui'
export const ENDPOINT = 'ws://192.168.1.20:7788'
export const DESKTOP_SECRET = new Uint8Array(32).fill(0x33)

export const desktopPublicKeyB64 = Buffer.from(
  nacl.box.keyPair.fromSecretKey(DESKTOP_SECRET).publicKey
).toString('base64')

export const TERMINALS = [
  { id: 'term-1', title: 'Shell 1' },
  { id: 'term-2', title: 'Shell 2' }
]

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(label: string, predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {return true}
    await sleep(5)
  }
  console.error(`  … timed out waiting for: ${label}`)
  return predicate()
}

/** A pairing code in the shape the desktop's QR would carry. */
export function pairingCode(overrides: Record<string, unknown> = {}): string {
  const json = JSON.stringify({
    v: 2,
    endpoint: ENDPOINT,
    deviceToken: DEVICE_TOKEN,
    publicKeyB64: desktopPublicKeyB64,
    ...overrides
  })
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// The installed environment, re-created per scenario
// ---------------------------------------------------------------------------

export type Environment = {
  connection: OrcaConnection
  preferences: FakePreferences
  assetStore: FakeAssetStore
  peers: DesktopPeer[]
  dialogs: { title: string; message: string; buttons: string[] }[]
  toasts: string[]
  actionMenus: { title: string; buttons: string[] }[]
  setNextChoice: (index: number) => void
  setScanResult: (value: string | null) => void
  latestPeer: () => DesktopPeer | null
}

export function createEnvironment(): Environment {
  const preferences = new FakePreferences()
  const assetStore = new FakeAssetStore()
  const peers: DesktopPeer[] = []
  const dialogs: { title: string; message: string; buttons: string[] }[] = []
  const toasts: string[] = []
  const actionMenus: { title: string; buttons: string[] }[] = []
  let choice = 0
  let scanResult: string | null = null
  let seed = 0x1234

  const random = (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    for (let index = 0; index < length; index++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      out[index] = (seed >> 16) & 0xff
    }
    return out
  }

  const openSocket = (_endpoint: string): SocketLike => {
    const pipe = createPipe()
    const peer = new DesktopPeer({
      serverSecret: DESKTOP_SECRET,
      deviceToken: DEVICE_TOKEN,
      terminals: TERMINALS
    })
    peer.attach(pipe.desktop)
    peers.push(peer)
    return socketLikeFor(pipe.client)
  }

  installKit({
    openSocket,
    preferences,
    assetStore,
    random,
    dialogs,
    toasts,
    actionMenus,
    nextChoice: () => choice,
    scanResult
  })

  const connection = new OrcaConnection({} as never)
  return {
    connection,
    preferences,
    assetStore,
    peers,
    dialogs,
    toasts,
    actionMenus,
    setNextChoice: (index: number) => {
      choice = index
    },
    setScanResult: (value: string | null) => {
      scanResult = value
      installKit({
        openSocket,
        preferences,
        assetStore,
        random,
        dialogs,
        toasts,
        actionMenus,
        nextChoice: () => choice,
        scanResult
      })
    },
    latestPeer: () => (peers.length === 0 ? null : peers.at(-1))
  }
}

/** Adapts one end of the pipe to the surface `@kit.NetworkKit`'s stub expects. */
function socketLikeFor(side: PipeSide): SocketLike {
  let openHandler: () => void = () => {}
  let messageHandler: (data: string | ArrayBuffer) => void = () => {}
  let closeHandler: (code: number) => void = () => {}

  side.setMessageHandler((data) => messageHandler(data))
  side.setCloseHandler(() => closeHandler(-1))
  // A real socket opens asynchronously, after the adapter has subscribed.
  queueMicrotask(() => openHandler())

  return {
    onOpen: (handler) => {
      openHandler = handler
    },
    onMessage: (handler) => {
      messageHandler = handler
    },
    onClose: (handler) => {
      closeHandler = handler
    },
    // Accepted and ignored: PipeSide models a drop and a close but has no fault
    // path, so nothing in these scenarios can drive the socket into an error.
    onError: () => {},
    send: (frame) => side.send(frame),
    close: () => side.close()
  }
}

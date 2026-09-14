/*
 * UI-layer verification, run headlessly.
 *
 * ArkUI cannot be rendered without a device, so this suite verifies what the
 * views actually depend on: the view-model. It constructs the SHIPPED
 * `OrcaConnection` — not a reimplementation — with only the `@kit` boundary
 * substituted (see kit-stub.ts), drives it, and asserts the exact values the
 * views read:
 *
 *   snapshot()  → the header's state pill
 *   hostRows()  → the host list
 *   log()       → the connection log
 *   terminal()  → the terminal list
 *
 * It also asserts the reactivity invariants that ArkUI silently depends on and
 * that no type checker can catch: arrays handed to `@State` must be fresh
 * identities, and a growing final terminal line must be a new object whose
 * key changes — otherwise the list renders once and then freezes.
 *
 * The ArkUI DSL itself is checked separately by check-arkui.mjs.
 */
import { check, section, finish, jsonEqual } from './harness'
import { DesktopPeer } from './desktop-peer'
import {
  FakeAssetStore,
  FakePreferences,
  SocketLike,
  installKit
} from './kit-stub'

import { OrcaConnection } from '../../entry/src/main/ets/services/OrcaConnection.ets'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../entry/src/main/ets/core/rpc/MobileRuntimeCapabilities.ets'
import { createPipe, PipeSide } from './desktop-peer'
import nacl from 'tweetnacl'

const DEVICE_TOKEN = 'device-token-ui'
const ENDPOINT = 'ws://192.168.1.20:7788'
const DESKTOP_SECRET = new Uint8Array(32).fill(0x33)

const desktopPublicKeyB64 = Buffer.from(
  nacl.box.keyPair.fromSecretKey(DESKTOP_SECRET).publicKey
).toString('base64')

const TERMINALS = [
  { id: 'term-1', title: 'Shell 1' },
  { id: 'term-2', title: 'Shell 2' }
]

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  console.error(`  … timed out waiting for: ${label}`)
  return predicate()
}

/** A pairing code in the shape the desktop's QR would carry. */
function pairingCode(overrides: Record<string, unknown> = {}): string {
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

interface Environment {
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

function createEnvironment(): Environment {
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
    latestPeer: () => (peers.length === 0 ? null : peers[peers.length - 1])
  }
}

/** Adapts one end of the pipe to the surface `@kit.NetworkKit`'s stub expects. */
function socketLikeFor(side: PipeSide): SocketLike {
  let openHandler: () => void = () => {}
  let messageHandler: (data: string | ArrayBuffer) => void = () => {}
  let closeHandler: (code: number) => void = () => {}
  let errorHandler: (message: string) => void = () => {}

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
    onError: (handler) => {
      errorHandler = handler
    },
    send: (frame) => side.send(frame),
    close: () => side.close()
  }
}

/** Scenario driver. A single async body, so the bundle needs no top-level await. */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // UI-1. Pairing, and the metadata/credential split
  // -------------------------------------------------------------------------

  section('UI-1. pairing writes a host and splits the secret')

{
  const env = createEnvironment()
  await env.connection.initialize()
  check('an unpaired app starts with no hosts', env.connection.hostRows().length === 0)

  const bad = await env.connection.pairFromInput('not a pairing code at all')
  check('a malformed code is refused', !bad.ok, JSON.stringify(bad))
  check('the refusal explains itself to the user', bad.message.length > 0, bad.message)
  check('a malformed code stores nothing', env.connection.hostRows().length === 0)

  const good = await env.connection.pairFromInput(pairingCode())
  check('a valid code is accepted', good.ok, JSON.stringify(good))
  check('the outcome names the new host', good.hostName === 'Host 1', JSON.stringify(good))

  const rows = env.connection.hostRows()
  check('a host row appears', rows.length === 1, JSON.stringify(rows))
  check('the row shows the endpoint', rows.length === 1 && rows[0].endpoint === ENDPOINT)
  check('the row is default-named sequentially', rows.length === 1 && rows[0].name === 'Host 1')
  check('the new host is not yet active', rows.length === 1 && !rows[0].isActive)

  // The whole point of the split: the token must not be in the metadata file.
  const stored = env.preferences.raw().get('hosts.v1') ?? ''
  check('metadata was persisted', stored.length > 0)
  check('the metadata file does NOT contain the device token', stored.indexOf(DEVICE_TOKEN) === -1)
  check('the metadata file carries the pinned key', stored.indexOf(desktopPublicKeyB64) !== -1, stored)

  const secrets = Array.from(env.assetStore.entries.values())
  check('the credential was written to the secret store', secrets.length === 1, `entries=${secrets.length}`)
  check(
    'the credential is the device token',
    secrets.length === 1 && Buffer.from(secrets[0].secret).toString('utf8') === DEVICE_TOKEN
  )
  check(
    'the credential was stored with first-unlock accessibility',
    env.assetStore.accessibilities.length === 1 && env.assetStore.accessibilities[0] === 2,
    JSON.stringify(env.assetStore.accessibilities)
  )
  check('flushes were awaited', env.preferences.flushCount >= 1)

  // Pairing the same endpoint again must refresh, not duplicate.
  const again = await env.connection.pairFromInput(pairingCode())
  check('re-pairing the same endpoint succeeds', again.ok)
  check('re-pairing refreshes instead of duplicating', env.connection.hostRows().length === 1, `${env.connection.hostRows().length} rows`)
  check('re-pairing did not append a second credential', env.assetStore.entries.size === 1)

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-2. The pairing URL form and the scanner both route through one parser
// ---------------------------------------------------------------------------

section('UI-2. all pairing inputs share one validator')

{
  const env = createEnvironment()
  await env.connection.initialize()

  const viaUrl = await env.connection.pairFromInput(`orca://pair?code=${pairingCode()}`)
  check('an orca://pair URL pairs the host', viaUrl.ok, JSON.stringify(viaUrl))

  // A relay offer must be refused: this client has no relay transport.
  const relayOffer = pairingCode({
    scope: 'mobile',
    relay: {
      v: 1,
      directorUrl: 'https://relay.example.com',
      cellUrl: 'https://cell.example.com',
      assignmentEpoch: 1,
      relayHostId: 'ABCDEFGHIJKLMNOP',
      inviteToken: 'A'.repeat(43),
      inviteExpiresAt: Date.now() + 60_000,
      e2eeFraming: 2
    }
  })
  const relay = await env.connection.pairFromInput(relayOffer)
  check('a relay offer is refused, not half-honoured', !relay.ok, JSON.stringify(relay))

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-3. Connect, and the state the header renders
// ---------------------------------------------------------------------------

section('UI-3. connect and the state pill')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())

  const idle = env.connection.snapshot()
  check('before connecting the pill reads disconnected', idle.label === 'Disconnected' && idle.tone === 'idle', JSON.stringify(idle))
  check('the pill knows there is one host', idle.hostCount === 1)

  const rows = env.connection.hostRows()
  env.connection.connect(rows[0].id)

  const connected = await waitFor('the view-model to report connected', () => env.connection.isConnected())
  check('the view-model reaches connected', connected, env.connection.snapshot().label)

  const snapshot = env.connection.snapshot()
  check('the pill reads Connected in the ok tone', snapshot.label === 'Connected' && snapshot.tone === 'ok', JSON.stringify(snapshot))
  check('the snapshot names the active host', snapshot.hostName === 'Host 1', snapshot.hostName)
  check('the snapshot carries the endpoint', snapshot.hostEndpoint === ENDPOINT)
  check('lastConnectedAt is populated', snapshot.lastConnectedAt > 0)
  check('the active row is marked', env.connection.hostRows()[0].isActive)
  check('the connection log recorded the transition', env.connection.log().length > 0, `${env.connection.log().length} rows`)
  check(
    'the log lines carry a level and a message',
    env.connection.log().every((row) => row.level.length > 0 && row.message.length > 0)
  )
  check(
    'the log does not leak the device token',
    env.connection.log().every((row) => row.detail.indexOf(DEVICE_TOKEN) === -1)
  )
  check(
    'the capability advisory was sent on connect',
    env.latestPeer() !== null &&
      jsonEqual(env.latestPeer()?.capabilityAdvertisements[0], MOBILE_RUNTIME_CLIENT_CAPABILITIES)
  )

  env.connection.disconnect()
  check('disconnecting returns the pill to idle', env.connection.snapshot().tone === 'idle')
}

// ---------------------------------------------------------------------------
// UI-4. The terminal list, and snapshot-vs-append semantics
// ---------------------------------------------------------------------------

section('UI-4. terminal buffer semantics')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.connection.connect(env.connection.hostRows()[0].id)
  await waitFor('connected', () => env.connection.isConnected())

  const terminals = await env.connection.listTerminals()
  check('the terminal list is parsed into descriptors', terminals.length === 2, JSON.stringify(terminals))
  check('a descriptor keeps its title', terminals[0].title === 'Shell 1')

  env.connection.openTerminal('term-1', 80, 24)
  const peer = env.latestPeer()
  await waitFor('subscribe', () => peer !== null && peer.terminalSubscribeParams.length === 1)
  check('opening a terminal subscribes on the wire', peer !== null && peer.terminalSubscribeParams.length === 1)
  check('the active terminal id is exposed', env.connection.activeTerminalId() === 'term-1')

  // A whole-screen snapshot REPLACES the buffer.
  peer?.sendScrollback('term-1', 'alpha\r\nbeta', 'scrollback')
  await waitFor('scrollback to land', () => env.connection.terminal().length >= 2)
  const afterSnapshot = env.connection.terminal()
  check('the snapshot populated the buffer', afterSnapshot.length === 2, JSON.stringify(afterSnapshot))
  check('the snapshot is split into lines', afterSnapshot[0].text === 'alpha' && afterSnapshot[1].text === 'beta')

  // Incremental output APPENDS.
  peer?.sendOutput('term-1', '\ngamma')
  await waitFor('output to land', () => env.connection.terminal().some((line) => line.text === 'gamma'))
  const afterAppend = env.connection.terminal()
  check('incremental output appended rather than replaced', afterAppend.length === 3, JSON.stringify(afterAppend))
  check('the earlier lines survived the append', afterAppend[0].text === 'alpha')

  // A second snapshot must not duplicate the screen.
  peer?.sendScrollback('term-1', 'delta', 'scrollback')
  await waitFor('second scrollback', () => env.connection.terminal().some((line) => line.text === 'delta'))
  const afterResync = env.connection.terminal()
  check('a resync snapshot replaced the buffer instead of appending', afterResync.length === 1, JSON.stringify(afterResync))
  check('the resynced buffer holds only the new screen', afterResync[0].text === 'delta')

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-5. The ArkUI reactivity invariants
// ---------------------------------------------------------------------------

section('UI-5. reactivity invariants the list rendering depends on')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.connection.connect(env.connection.hostRows()[0].id)
  await waitFor('connected', () => env.connection.isConnected())
  env.connection.openTerminal('term-1', 80, 24)
  const peer = env.latestPeer()
  await waitFor('subscribe', () => peer !== null && peer.terminalSubscribeParams.length === 1)

  const first = env.connection.terminal()
  const second = env.connection.terminal()
  check('terminal() hands back a fresh array each call (ArkUI diffs by identity)', first !== second)

  const logsA = env.connection.log()
  const logsB = env.connection.log()
  check('log() hands back a fresh array each call', logsA !== logsB)

  // A growing final line must be a NEW object, or the row never re-renders.
  peer?.sendOutput('term-1', 'partial', 20)
  await waitFor('first partial', () => env.connection.terminal().length >= 1)
  const beforeGrow = env.connection.terminal()
  const lastBefore = beforeGrow[beforeGrow.length - 1]

  peer?.sendOutput('term-1', '-more', 21)
  await waitFor('growth', () =>
    env.connection.terminal().some((line) => line.text.endsWith('-more'))
  )
  const afterGrow = env.connection.terminal()
  const lastAfter = afterGrow[afterGrow.length - 1]

  check('the growing line kept its identity by id', lastBefore.id === lastAfter.id, `${lastBefore.id} → ${lastAfter.id}`)
  check('the growing line is a NEW object, so the row re-renders', lastBefore !== lastAfter)
  check(
    'the growing line accumulated the text',
    lastAfter.text === `${lastBefore.text}-more`,
    `${JSON.stringify(lastBefore.text)} → ${JSON.stringify(lastAfter.text)}`
  )
  check(
    'the row key the view builds changes when the line grows (key = id:textLength)',
    `${lastBefore.id}:${lastBefore.text.length}` !== `${lastAfter.id}:${lastAfter.text.length}`
  )

  // Every rendered key must be unique, or ArkUI reuses the wrong rows.
  const lines = env.connection.terminal()
  const keys = new Set(lines.map((line, index) => `${line.id}:${line.text.length}`))
  check('all terminal row keys are unique', keys.size === lines.length, `${keys.size} keys for ${lines.length} lines`)
  const ids = new Set(lines.map((line) => line.id))
  check('all terminal line ids are unique', ids.size === lines.length)

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-6. Terminal input
// ---------------------------------------------------------------------------

section('UI-6. terminal input from the composer')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.connection.connect(env.connection.hostRows()[0].id)
  await waitFor('connected', () => env.connection.isConnected())
  env.connection.openTerminal('term-1', 80, 24)
  const peer = env.latestPeer()
  await waitFor('subscribe', () => peer !== null && peer.terminalSubscribeParams.length === 1)

  await env.connection.sendTerminalInput('echo hi\n')
  check(
    'the desktop received the composed line',
    peer !== null && peer.terminalSendTexts.includes('echo hi\n'),
    JSON.stringify(peer?.terminalSendTexts)
  )
  check(
    'the input carried the active terminal id',
    peer !== null && peer.rpcRequests.some((r) => r.method === 'terminal.send' && (r.params as Record<string, Object>)?.terminal === 'term-1')
  )

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-7. Forgetting a host
// ---------------------------------------------------------------------------

section('UI-7. forgetting a host removes the credential too')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.setNextChoice(1) // "Forget"

  await env.connection.removeHost(env.connection.hostRows()[0].id)

  check('the host disappears from the list', env.connection.hostRows().length === 0)
  check('the credential was removed from the secret store', env.assetStore.entries.size === 0)
  const stored = env.preferences.raw().get('hosts.v1') ?? '[]'
  check('the metadata no longer lists the host', stored.indexOf('host-') === -1 || stored === '[]', stored)

  env.connection.disconnect()
}

// ---------------------------------------------------------------------------
// UI-8. Fail-closed behaviour on unreadable state
// ---------------------------------------------------------------------------

section('UI-8. unreadable state fails closed')

{
  // (a) A corrupt metadata payload must show nothing and must NOT be overwritten.
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.connection.disconnect()

  env.preferences.poison('{ this is not json')
  const afterCorrupt = await env.connection.reloadHosts()
  check('a corrupt host list shows no hosts rather than throwing', afterCorrupt.length === 0)
  check('the corrupt payload was left on disk, not overwritten', env.preferences.raw().get('hosts.v1') === '{ this is not json')

  const mutation = await env.connection.pairFromInput(pairingCode())
  check('a mutation over an unreadable list fails closed', !mutation.ok, JSON.stringify(mutation))
  check(
    'the unreadable payload still survives the failed mutation',
    env.preferences.raw().get('hosts.v1') === '{ this is not json'
  )

  // (b) A legacy record with an embedded secret must be dropped, not migrated.
  const legacy = createEnvironment()
  await legacy.connection.initialize()
  legacy.preferences.poison(
    JSON.stringify([
      {
        id: 'host-legacy',
        name: 'Host 1',
        endpoint: ENDPOINT,
        publicKeyB64: desktopPublicKeyB64,
        lastConnected: 1,
        deviceToken: 'legacy-embedded-secret'
      }
    ])
  )
  legacy.assetStore.entries.set('orca.host.device-token.host-legacy', {
    alias: 'orca.host.device-token.host-legacy',
    secret: new TextEncoder().encode('legacy-embedded-secret'),
    accessibility: 2
  })
  const migrated = await legacy.connection.reloadHosts()
  check('a pre-v0.0.3 record carrying a deviceToken is dropped', migrated.length === 0, JSON.stringify(migrated))

  // (c) An unreadable credential store hides the host instead of offering a
  //     pairing that can never authenticate.
  const broken = createEnvironment()
  await broken.connection.initialize()
  await broken.connection.pairFromInput(pairingCode())
  broken.connection.disconnect()
  broken.assetStore.readsFail = true
  const hidden = await broken.connection.reloadHosts()
  check('an unreadable credential hides the host', hidden.length === 0, JSON.stringify(hidden))
  check(
    'the host metadata is preserved for a later retry',
    (broken.preferences.raw().get('hosts.v1') ?? '').indexOf(desktopPublicKeyB64) !== -1
  )

  // (d) A re-pair after a credential wipe must overwrite in place, not duplicate.
  broken.assetStore.readsFail = false
  const repaired = await broken.connection.pairFromInput(pairingCode())
  check('re-pairing repairs a missing credential', repaired.ok, JSON.stringify(repaired))
  check('the repair reused the existing host row', broken.connection.hostRows().length === 1)
  check('the repair wrote exactly one credential', broken.assetStore.entries.size === 1)
}

// ---------------------------------------------------------------------------
// UI-9. The terminal buffer is bounded
// ---------------------------------------------------------------------------

section('UI-9. terminal buffer cannot grow without limit')

{
  const env = createEnvironment()
  await env.connection.initialize()
  await env.connection.pairFromInput(pairingCode())
  env.connection.connect(env.connection.hostRows()[0].id)
  await waitFor('connected', () => env.connection.isConnected())
  env.connection.openTerminal('term-1', 80, 24)
  const peer = env.latestPeer()
  await waitFor('subscribe', () => peer !== null && peer.terminalSubscribeParams.length === 1)

  // 5 000 lines through the real path; the cap is 2 000.
  const chunk = new Array(500).fill('x').join('\n')
  for (let index = 0; index < 10; index++) {
    peer?.sendOutput('term-1', `\n${chunk}`, 100 + index)
  }
  await waitFor('the buffer to exceed the cap', () => env.connection.terminal().length >= 2000, 8000)

  const lines = env.connection.terminal()
  check('the buffer is capped', lines.length <= 2000, `${lines.length} lines`)
  check('the cap is actually reached (the stream was long enough)', lines.length >= 1900, `${lines.length} lines`)
  check('line ids keep increasing after trimming (no key reuse)', lines[lines.length - 1].id > lines[0].id)

  env.connection.disconnect()
}

  finish('the shipped view-model produces the state the views render.')
}

main().catch((error: Object) => {
  console.error(`\nHARNESS ERROR  ${String(error)}`)
  process.exit(1)
})

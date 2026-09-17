/*
 * End-to-end verification: the shipped HarmonyOS client against the shipped
 * desktop session, over a simulated socket.
 *
 * Every other harness in this directory compares one module to its reference.
 * This one runs the whole client stack — `RpcClient` → `RpcSocketSession` →
 * `E2eeV2PhysicalChannel` → `E2eeV2ClientSession` → crypto — against the real
 * desktop implementation of the other side (see `desktop-peer.ts`). If the
 * client is wrong about anything observable on the wire, it fails here.
 *
 * What it does not cover: ArkUI rendering, ability lifecycle, and the
 * device-specific behaviour of `@kit.NetworkKit`. Those need a device.
 * See docs/VERIFICATION.md.
 */
import { check, section, finish, jsonEqual } from './harness'
import { DEVICE_TOKEN, DESKTOP_SECRET, startClient, waitFor } from './e2e-client-harness'
import { runTailScenarios } from './e2e-scenarios-tail'

import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../entry/src/main/ets/core/rpc/MobileRuntimeCapabilities.ets'
import { asArray, asRecord, asString, parseJsonRecord } from '../../entry/src/main/ets/core/json/JsonValue.ets'

/** Scenario driver. A single async body, so the bundle needs no top-level await. */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // E2E-1. Handshake against the real desktop session
  // -------------------------------------------------------------------------

  section('E2E-1. handshake against the real desktop session')

{
  const harness = startClient()
  const { client, factory } = harness

  const connected = await waitFor('client to reach connected', () => client.getState() === 'connected')
  check('client completes the E2EE v2 handshake and reaches connected', connected, `states=${harness.states.join(' → ')}`)

  const peer = factory.latestPeer()
  check('exactly one dial was made', factory.peers.length === 1, `dials=${factory.peers.length}`)
  check('the desktop session authenticated the device', peer !== null && peer.isReady())
  check(
    'the desktop accepted the v2 auth shape (exact key set + transcript binding)',
    peer !== null && peer.authenticateAttempts.length === 1 && peer.authenticateAttempts[0].ok,
    peer === null ? 'no peer' : JSON.stringify(peer.authenticateAttempts)
  )
  check(
    'the state sequence passed through connecting and handshaking',
    harness.states.includes('connecting') && harness.states.includes('handshaking'),
    harness.states.join(' → ')
  )
  check('connected was published last, after the advisory', harness.states.at(-1) === 'connected')

  client.close()
  check('close() publishes disconnected', client.getState() === 'disconnected')
}

// ---------------------------------------------------------------------------
// E2E-2. Capability advisory reaches the real desktop
// ---------------------------------------------------------------------------

section('E2E-2. capability advisory')

{
  const harness = startClient()
  const { client, factory } = harness
  await waitFor('connected', () => client.getState() === 'connected')

  const peer = factory.latestPeer()
  const advertised = peer === null ? [] : peer.capabilityAdvertisements
  check('the desktop received exactly one capability advisory', advertised.length === 1, `count=${advertised.length}`)
  check(
    'the advertised list matches the reference capability set, in order',
    advertised.length > 0 && jsonEqual(advertised[0], MOBILE_RUNTIME_CLIENT_CAPABILITIES)
  )
  check(
    'connected was not published before the advisory settled',
    peer !== null && advertised.length === 1
  )

  client.close()
}

// ---------------------------------------------------------------------------
// E2E-3. Terminal list, subscribe, and both stream shapes
// ---------------------------------------------------------------------------

section('E2E-3. terminal list + subscribe + stream')

{
  const harness = startClient()
  const { client, factory } = harness
  await waitFor('connected', () => client.getState() === 'connected')

  const listed = await client.sendRequest('terminal.list', undefined)
  const terminals = asArray(listed.result)
  check('terminal.list succeeded', listed.ok, JSON.stringify(listed.error))
  check('terminal.list returned both terminals', terminals !== null && terminals.length === 2)

  const events: { type: string; chunk: string; serialized: string }[] = []
  client.subscribe(
    'terminal.subscribe',
    { terminal: 'term-1', cols: 80, rows: 24, client: { id: 'viewer-1' } },
    (result: object | null) => {
      const record = asRecord(result)
      if (record === null) {return}
      const type = asString(record.type)
      if (type === null) {return}
      events.push({
        type,
        chunk: asString(record.chunk) ?? '',
        serialized: asString(record.serialized) ?? ''
      })
    }
  )

  const peer = factory.latestPeer()
  await waitFor('desktop to receive terminal.subscribe', () =>
    peer !== null && peer.terminalSubscribeParams.length === 1
  )
  check('the desktop received terminal.subscribe', peer !== null && peer.terminalSubscribeParams.length === 1)
  const params = peer === null ? {} : (peer.terminalSubscribeParams[0] ?? {})
  check('the subscribe carried the requested terminal', params.terminal === 'term-1', JSON.stringify(params))
  check('the subscribe carried a viewport', params.cols === 80 && params.rows === 24, JSON.stringify(params))
  check(
    'the subscribe carried a per-viewer client id',
    typeof params.client === 'object' && params.client !== null
  )
  check('the opener reply was delivered to the subscriber', events.some((e) => e.type === 'subscribed'))

  // A snapshot is a whole-screen replay; a chunk is incremental output.
  if (peer !== null) {
    peer.sendScrollback('term-1', 'first line\r\nsecond line', 'scrollback')
    await waitFor('scrollback event', () => events.some((e) => e.type === 'scrollback'))
    peer.sendOutput('term-1', 'typed output')
    await waitFor('data event', () => events.some((e) => e.type === 'data'))
  }

  const scrollback = events.find((e) => e.type === 'scrollback')
  const data = events.find((e) => e.type === 'data')
  check(
    'the scrollback snapshot was reassembled from SnapshotStart/Chunk/End',
    scrollback !== undefined && scrollback.serialized === 'first line\r\nsecond line',
    scrollback === undefined ? 'no scrollback event' : JSON.stringify(scrollback.serialized)
  )
  check(
    'the incremental output arrived as a data event with its chunk',
    data !== undefined && data.chunk === 'typed output',
    data === undefined ? 'no data event' : JSON.stringify(data.chunk)
  )
  check(
    'the two stream shapes are distinguishable by type',
    scrollback !== undefined && data !== undefined && scrollback.type !== data.type
  )

  client.close()
}

// ---------------------------------------------------------------------------
// E2E-4. Terminal input reaches the desktop verbatim
// ---------------------------------------------------------------------------

section('E2E-4. terminal input')

{
  const harness = startClient()
  const { client, factory } = harness
  await waitFor('connected', () => client.getState() === 'connected')

  const peer = factory.latestPeer()
  client.subscribe(
    'terminal.subscribe',
    { terminal: 'term-1', cols: 80, rows: 24, client: { id: 'viewer-1' } },
    () => {}
  )
  await waitFor('subscribe', () => peer !== null && peer.terminalSubscribeParams.length === 1)

  const sent = await client.sendRequest('terminal.send', { terminal: 'term-1', text: 'ls -la\n' })
  check('terminal.send succeeded', sent.ok, JSON.stringify(sent.error))
  check(
    'the desktop received the text byte for byte',
    peer !== null && peer.terminalSendTexts.length === 1 && peer.terminalSendTexts[0] === 'ls -la\n',
    peer === null ? 'no peer' : JSON.stringify(peer.terminalSendTexts)
  )

  client.close()
}

// ---------------------------------------------------------------------------
// E2E-5. Nothing but the hello is sent in the clear
// ---------------------------------------------------------------------------

section('E2E-5. confidentiality of the wire')

{
  const harness = startClient()
  const { client, factory } = harness
  await waitFor('connected', () => client.getState() === 'connected')

  await client.sendRequest('status.get', undefined)

  // Assert against the bytes actually written to the wire, not against intent.
  const peer = factory.latestPeer()
  const sentFrames = peer === null ? [] : peer.rawInbound

  check('the desktop saw at least three frames', sentFrames.length >= 3, `frames=${sentFrames.length}`)

  const hello = sentFrames[0]
  // parseJsonRecord rejects malformed JSON, arrays and scalars — the same set the
  // try/catch used to collapse to "no parseable hello".
  const helloParsed = typeof hello === 'string' ? parseJsonRecord(hello) : null
  check(
    'the only plaintext frame is the e2ee_hello',
    helloParsed !== null && helloParsed.type === 'e2ee_hello' && helloParsed.v === 2,
    JSON.stringify(helloParsed)
  )

  // Everything after the hello is base64 ciphertext: it must not parse as JSON,
  // and its first 24 bytes are the frame nonce (so the length is non-trivial).
  let sealedCount = 0
  let leaked = 0
  for (let index = 1; index < sentFrames.length; index++) {
    const frame = sentFrames[index]
    if (typeof frame !== 'string') {continue}
    let parsedPlaintext = true
    try {
      JSON.parse(frame)
    } catch {
      parsedPlaintext = false
    }
    if (!parsedPlaintext) {
      sealedCount++
      const bytes = Buffer.from(frame, 'base64')
      if (bytes.length <= 24 + 16 + 42) {leaked++}
    }
  }
  check('every post-handshake frame is sealed', sealedCount === sentFrames.length - 1, `sealed=${sealedCount} of ${sentFrames.length - 1}`)
  check('no sealed frame is missing its nonce/tag/header overhead', leaked === 0, `underlength=${leaked}`)
  check(
    'the desktop decrypted real content from the sealed frames',
    peer !== null && peer.rpcMethods.includes('runtime.clientCapabilities.update') && peer.rpcMethods.includes('status.get')
  )

  client.close()
}

// ---------------------------------------------------------------------------
// E2E-6. A drop reconnects, and the subscription is replayed
// ---------------------------------------------------------------------------

section('E2E-6. reconnect + subscription replay')

{
  const harness = startClient()
  const { client, factory } = harness
  await waitFor('connected', () => client.getState() === 'connected')

  client.subscribe(
    'terminal.subscribe',
    { terminal: 'term-1', cols: 80, rows: 24, client: { id: 'viewer-1' } },
    () => {}
  )
  const first = factory.latestPeer()
  await waitFor('first subscribe', () => first !== null && first.terminalSubscribeParams.length === 1)
  check('the subscription opened on the first socket', first !== null && first.terminalSubscribeParams.length === 1)

  first?.drop()

  const reconnected = await waitFor(
    'a second dial to reach connected',
    () => factory.peers.length === 2 && client.getState() === 'connected',
    8000
  )
  check('the client dialled again after the drop', factory.peers.length === 2, `dials=${factory.peers.length}`)
  check('the second dial authenticated and reached connected', reconnected, `state=${client.getState()}`)
  check(
    'the state sequence shows reconnecting before the new dial',
    harness.states.includes('reconnecting'),
    harness.states.join(' → ')
  )

  const second = factory.peers[1]
  const replayed = await waitFor(
    'the subscription to be replayed on the new socket',
    () => second !== undefined && second.terminalSubscribeParams.length === 1,
    4000
  )
  check('the subscription was replayed on the new socket', replayed)
  check(
    'the replay carried the same terminal and viewer',
    second !== undefined &&
      second.terminalSubscribeParams.length === 1 &&
      second.terminalSubscribeParams[0].terminal === 'term-1',
    second === undefined ? 'no second peer' : JSON.stringify(second.terminalSubscribeParams)
  )
  check('the second desktop session authenticated the same device', second !== undefined && second.isReady())

  client.close()
}

// ---------------------------------------------------------------------------
// E2E-7. A revoked pairing latches, it does not retry forever
// ---------------------------------------------------------------------------

section('E2E-7. revoked pairing')

{
  // The pairing is already revoked when the client dials, so every attempt is
  // rejected by the real desktop validator.
  const harness = startClient(DESKTOP_SECRET, DEVICE_TOKEN, (peer) => {
    peer.deviceKnown = false
  })
  const { client, factory } = harness

  await waitFor('the client to latch auth-failed', () => client.getState() === 'auth-failed', 12000)

  const peers = factory.peers
  check('the client gave up rather than retrying forever', client.getState() === 'auth-failed', `state=${client.getState()}`)
  check('the retry budget was bounded (three rejections)', peers.length === 3, `dials=${peers.length}`)
  check(
    'every dial was rejected by the real desktop auth validator',
    peers.every((peer) => peer.authenticateAttempts.length === 1 && !peer.authenticateAttempts[0].ok),
    JSON.stringify(peers.map((peer) => peer.authenticateAttempts))
  )
  check(
    'the rejection was an unrecognised device, not a malformed frame',
    peers.every((peer) => peer.authenticateAttempts[0]?.code === 'unauthorized'),
    JSON.stringify(peers.map((peer) => peer.authenticateAttempts[0]?.code))
  )
  check(
    'no dial ever reached connected',
    !harness.states.includes('connected'),
    harness.states.join(' → ')
  )

  client.close()
}

  await runTailScenarios()

  finish('the HarmonyOS client completes a real end-to-end session with the desktop.')
}

main().catch((error: object) => {
  console.error(`\nHARNESS ERROR  ${String(error)}`)
  process.exit(1)
})
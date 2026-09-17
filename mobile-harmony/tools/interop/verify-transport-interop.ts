/*
 * Interop verification for the HarmonyOS RPC/transport core.
 *
 * Same idea as verify-interop.ts: every ported module is compared against the
 * repo's own reference implementation, on identical inputs, byte for byte or
 * event for event. Nothing here is part of the shipped app.
 */
import { check, section, bytesEqualCheck, fixture, finish, equalHex, hex, jsonEqual } from './harness'

import * as hTerminal from '../../entry/src/main/ets/core/rpc/TerminalStreamProtocol.ets'
import * as hScreencast from '../../entry/src/main/ets/core/rpc/BrowserScreencastProtocol.ets'
import * as hRpc from '../../entry/src/main/ets/core/rpc/RpcProtocol.ets'
import * as hUnsub from '../../entry/src/main/ets/core/rpc/RpcStreamUnsubscribe.ets'
import { OutboundBackpressureQueue } from '../../entry/src/main/ets/core/rpc/OutboundQueue.ets'
import { ReconnectSchedule } from '../../entry/src/main/ets/core/rpc/ReconnectSchedule.ets'
import { LivenessWatchdog } from '../../entry/src/main/ets/core/rpc/LivenessWatchdog.ets'
import { TerminalStreamRouter } from '../../entry/src/main/ets/core/rpc/TerminalStreamRouter.ets'
import { RpcStreamRegistry } from '../../entry/src/main/ets/core/rpc/RpcStreamRegistry.ets'
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITIES,
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from '../../entry/src/main/ets/core/rpc/MobileRuntimeCapabilities.ets'

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from '../../../mobile/src/transport/terminal-stream-protocol'
import { decodeBrowserScreencastFrame } from '../../../mobile/src/transport/browser-screencast-protocol'
import { isRpcResponse } from '../../../mobile/src/transport/rpc-response-shape'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams
} from '../../../mobile/src/transport/rpc-client-terminal-subscription'
import { buildReadyStreamUnsubscribe } from '../../../mobile/src/transport/rpc-client-server-subscription'
import {
  RPC_RECONNECT_ATTEMPT_LIMIT,
  RpcClientReconnectSchedule
} from '../../../mobile/src/transport/rpc-client-reconnect-schedule'
import { RpcSessionLivenessWatchdog } from '../../../mobile/src/transport/rpc-session-liveness-watchdog'
import { createWsOutboundBackpressureQueue } from '../../../src/shared/ws-outbound-backpressure-queue'
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITIES as REFERENCE_CAPABILITIES,
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD as REFERENCE_CAPABILITY_METHOD,
  mobileRuntimeClientCapabilityUpdateParams as referenceCapabilityParams
} from '../../../mobile/src/transport/mobile-runtime-client-capabilities'

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// A deterministic timer queue, so both implementations see the same clock.
// ---------------------------------------------------------------------------

class FakeClock {
  now = 0
  private timers: { id: number; at: number; callback: () => void }[] = []
  private nextId = 1

  set = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.push({ id, at: this.now + Math.max(0, delayMs), callback })
    return id
  }

  clear = (id: number): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id)
  }

  /** Runs every timer due within `ms`, in firing order, advancing `now`. */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const next = due[0]
      this.timers = this.timers.filter((timer) => timer.id !== next.id)
      this.now = Math.max(this.now, next.at)
      next.callback()
    }
    this.now = target
  }
}

// ---------------------------------------------------------------------------
// 12. Terminal stream protocol
// ---------------------------------------------------------------------------

section('12. terminal stream protocol')

{
  for (const opcode of [1, 2, 3, 4, 5, 6, 12]) {
    for (const streamId of [0, 1, 255, 65535, 0x7fffffff, 0xffffffff]) {
      for (const seq of [0, 1, 255, 65535, 0x100000000, 2 ** 40, 0xffffffffffff]) {
        const payload = fixture(13, opcode * 31 + (seq % 97))
        const frame = { opcode, streamId, seq, payload }

        const ours = hTerminal.encodeTerminalStreamFrame(frame)
        const reference = encodeTerminalStreamFrame(frame)
        const label = `opcode=${opcode} streamId=${streamId} seq=${seq}`
        check(`encode matches reference ${label}`, equalHex(ours, reference), `${hex(ours)} vs ${hex(reference)}`)

        const decodedOurs = hTerminal.decodeTerminalStreamFrame(reference)
        const decodedReference = decodeTerminalStreamFrame(ours)
        check(
          `round-trip matches reference ${label}`,
          decodedOurs !== null &&
            decodedReference !== null &&
            decodedOurs.opcode === decodedReference.opcode &&
            decodedOurs.streamId === decodedReference.streamId &&
            decodedOurs.seq === decodedReference.seq &&
            equalHex(decodedOurs.payload, decodedReference.payload)
        )
      }
    }
  }

  // Header is parsed by offset on the host, so byte positions are frozen.
  {
    const frame = { opcode: 3, streamId: 0x01020304, seq: 0x0000aabbccddeeff, payload: new Uint8Array([1, 2, 3]) }
    const bytes = hTerminal.encodeTerminalStreamFrame(frame)
    check('kind byte is 0x74', bytes[0] === 0x74)
    check('version byte is 1', bytes[1] === 1)
    check('opcode byte', bytes[2] === 3)
    check('reserved byte', bytes[3] === 0)
    check('streamId is little-endian', hex(bytes.subarray(4, 8)) === '04030201')
    // seq = 0x0000aabbccddeeff → high half 0x0000aabb, low half 0xccddeeff.
    check('seq high is little-endian', hex(bytes.subarray(8, 12)) === 'bbaa0000', hex(bytes.subarray(8, 12)))
    check('seq low is little-endian', hex(bytes.subarray(12, 16)) === 'ffeeddcc', hex(bytes.subarray(12, 16)))
    check('payload follows the header', hex(bytes.subarray(16)) === '010203')
  }

  check('output opcode mirrors the reference', TerminalStreamOpcode.Output === hTerminal.TERMINAL_OPCODE_OUTPUT)
  check('metadata opcode value', hTerminal.TERMINAL_OPCODE_METADATA === 12)
  check('kind constant', hTerminal.TERMINAL_STREAM_KIND === 0x74)

  const badFrames: [string, Uint8Array][] = [
    ['short frame', fixture(15, 1)],
    ['empty frame', new Uint8Array(0)],
    ['wrong kind', (() => { const b = fixture(32, 2); b[0] = 0x62; return b })()],
    ['wrong version', (() => { const b = fixture(32, 3); b[1] = 2; return b })()],
    ['unknown opcode', (() => { const b = fixture(32, 4); b[2] = 99; return b })()]
  ]
  for (const [label, bytes] of badFrames) {
    const ours = hTerminal.decodeTerminalStreamFrame(bytes)
    const reference = decodeTerminalStreamFrame(bytes)
    check(`both reject ${label}`, (ours === null) === (reference === null), `ours=${ours === null} ref=${reference === null}`)
  }

  check('opcode guard accepts 1..6 and 12', [1, 2, 3, 4, 5, 6, 12].every((v) => hTerminal.isTerminalStreamOpcode(v)))
  check('opcode guard rejects 0 and 13', !hTerminal.isTerminalStreamOpcode(0) && !hTerminal.isTerminalStreamOpcode(13))
}

// ---------------------------------------------------------------------------
// 13. Terminal stream router
// ---------------------------------------------------------------------------

section('13. terminal stream router')

{
  const router = new TerminalStreamRouter()
  const events: string[] = []
  router.register('rpc-1', 7, (event) => {
    events.push(`${event.type}:${event.streamId}:${event.chunk}${event.serialized}`)
  })

  const output = (seq: number, text: string): Uint8Array =>
    hTerminal.encodeTerminalStreamFrame({ opcode: 1, streamId: 7, seq, payload: encoder.encode(text) })
  const json = (opcode: number, seq: number, value: unknown): Uint8Array =>
    hTerminal.encodeTerminalStreamFrame({ opcode, streamId: 7, seq, payload: encoder.encode(JSON.stringify(value)) })
  const chunk = (seq: number, text: string): Uint8Array =>
    hTerminal.encodeTerminalStreamFrame({ opcode: 3, streamId: 7, seq, payload: encoder.encode(text) })
  const empty = (opcode: number, seq: number): Uint8Array =>
    hTerminal.encodeTerminalStreamFrame({ opcode, streamId: 7, seq, payload: new Uint8Array(0) })

  router.handle(output(0, 'hello '))
  router.handle(output(1, 'world'))
  check('output frames emit data events', events.join('|') === 'data:7:hello |data:7:world', events.join('|'))

  // A snapshot is reassembled across frames and emitted once, at the end.
  router.handle(json(2, 2, { kind: 'scrollback', cols: 120 }))
  router.handle(chunk(3, 'line1\n'))
  router.handle(chunk(4, 'line2\n'))
  check('snapshot chunks emit nothing before the end', events.length === 2)
  router.handle(empty(4, 5))
  check('snapshot end emits one assembled event', events[2] === 'scrollback:7:line1\nline2\n', events[2])

  // `kind: resized` replays as `resized`, not `scrollback`.
  router.handle(json(2, 6, { kind: 'resized' }))
  router.handle(chunk(7, 'r'))
  router.handle(empty(4, 8))
  check('resized snapshot emits resized', events[3] === 'resized:7:r', events[3])

  router.handle(json(5, 9, { cols: 80, rows: 24 }))
  check('resized opcode emits resized event', events[4] === 'resized:7:', events[4])
  router.handle(json(12, 10, { title: 'zsh' }))
  check('metadata opcode emits metadata event', events[5] === 'metadata:7:', events[5])
  router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 6, streamId: 7, seq: 11, payload: encoder.encode('boom') }))
  check('error opcode emits error event', events[6] === 'error:7:', events[6])

  const before = events.length
  router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 1, streamId: 999, seq: 0, payload: encoder.encode('nope') }))
  check('frames for unknown streams are ignored', events.length === before)
  router.handle(chunk(12, 'orphan'))
  check('a chunk with no snapshot start is ignored', events.length === before)
  router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 2, streamId: 7, seq: 13, payload: encoder.encode('{oops') }))
  check('a malformed snapshot start is ignored', events.length === before)

  check('router tracks one stream', router.trackedStreamCount() === 1)
  router.reset('rpc-1')
  check('reset drops the stream', router.trackedStreamCount() === 0)
  router.handle(output(14, 'after reset'))
  check('frames after reset are ignored', events.length === before)
}

// ---------------------------------------------------------------------------
// 14. Browser screencast protocol
// ---------------------------------------------------------------------------

section('14. browser screencast protocol')

{
  const metadata = { offsetTop: 12.5, pageScaleFactor: 1.25, imageWidth: 800, imageHeight: 600, timestamp: 12345 }
  const metadataBytes = encoder.encode(JSON.stringify(metadata))
  const image = fixture(64, 5)

  const frame = new Uint8Array(16 + metadataBytes.length + image.length)
  frame[0] = 0x62
  frame[1] = 1
  frame[2] = 1
  frame[3] = 1 // jpeg
  const view = new DataView(frame.buffer)
  view.setUint32(4, 42, true)
  view.setUint32(8, metadataBytes.length, true)
  view.setUint32(12, 0, true)
  frame.set(metadataBytes, 16)
  frame.set(image, 16 + metadataBytes.length)

  const ours = hScreencast.decodeBrowserScreencastFrame(frame)
  const reference = decodeBrowserScreencastFrame(frame)
  check('decodes a frame', ours !== null && reference !== null)
  check('seq matches reference', ours!.seq === reference!.seq && ours!.seq === 42)
  check('format matches reference', ours!.format === reference!.format && ours!.format === 'jpeg')
  check('metadata matches reference', jsonEqual(ours!.metadata, reference!.metadata))
  bytesEqualCheck('image matches reference', ours!.image, reference!.image)

  const png = Uint8Array.from(frame)
  png[3] = 2
  check('png format', hScreencast.decodeBrowserScreencastFrame(png)!.format === 'png')

  const badFrames: [string, Uint8Array][] = [
    ['short frame', frame.subarray(0, 15)],
    ['wrong kind', (() => { const b = Uint8Array.from(frame); b[0] = 0x74; return b })()],
    ['wrong version', (() => { const b = Uint8Array.from(frame); b[1] = 2; return b })()],
    ['wrong opcode', (() => { const b = Uint8Array.from(frame); b[2] = 2; return b })()],
    ['unknown format', (() => { const b = Uint8Array.from(frame); b[3] = 9; return b })()],
    ['non-zero reserved', (() => { const b = Uint8Array.from(frame); new DataView(b.buffer).setUint32(12, 1, true); return b })()],
    [
      'metadata length past the end',
      (() => {
        const b = Uint8Array.from(frame)
        new DataView(b.buffer).setUint32(8, b.length, true)
        return b
      })()
    ],
    [
      'metadata that is not JSON',
      (() => {
        const b = Uint8Array.from(frame)
        b[16] = 0x7b
        b[17] = 0x6f
        return b
      })()
    ]
  ]
  for (const [label, bytes] of badFrames) {
    const oursBad = hScreencast.decodeBrowserScreencastFrame(bytes)
    const referenceBad = decodeBrowserScreencastFrame(bytes)
    check(`both reject ${label}`, (oursBad === null) === (referenceBad === null), `ours=${oursBad === null} ref=${referenceBad === null}`)
  }

  const extraBytes = encoder.encode(JSON.stringify({ ...metadata, bogusKey: 7 }))
  const extraFrame = new Uint8Array(16 + extraBytes.length)
  extraFrame[0] = 0x62
  extraFrame[1] = 1
  extraFrame[2] = 1
  extraFrame[3] = 2
  new DataView(extraFrame.buffer).setUint32(8, extraBytes.length, true)
  extraFrame.set(extraBytes, 16)
  const extraOurs = hScreencast.decodeBrowserScreencastFrame(extraFrame)!
  const extraReference = decodeBrowserScreencastFrame(extraFrame)!
  check('unknown metadata keys are dropped', !('bogusKey' in extraOurs.metadata))
  check('known metadata survives', jsonEqual(extraOurs.metadata, extraReference.metadata))
}

// ---------------------------------------------------------------------------
// 15. RPC response shape
// ---------------------------------------------------------------------------

section('15. rpc response shape')

{
  const corpus: [string, string][] = [
    ['success with result', '{"id":"rpc-1","ok":true,"result":{"a":1},"_meta":{"runtimeId":"r"}}'],
    ['success with null result', '{"id":"rpc-1","ok":true,"result":null}'],
    ['success with array result', '{"id":"rpc-1","ok":true,"result":[]}'],
    ['success with streaming', '{"id":"rpc-1","ok":true,"result":{},"streaming":true}'],
    ['success without result', '{"id":"rpc-1","ok":true}'],
    ['success with a falsy result', '{"id":"rpc-1","ok":true,"result":0}'],
    ['failure', '{"id":"rpc-1","ok":false,"error":{"code":"boom","message":"bad"}}'],
    ['failure with data', '{"id":"rpc-1","ok":false,"error":{"code":"boom","message":"bad","data":[1]}}'],
    ['failure missing message', '{"id":"rpc-1","ok":false,"error":{"code":"boom"}}'],
    ['failure missing error', '{"id":"rpc-1","ok":false}'],
    ['missing id', '{"ok":true,"result":1}'],
    ['numeric id', '{"id":1,"ok":true,"result":1}'],
    ['missing ok', '{"id":"rpc-1","result":1}'],
    ['ok as a string', '{"id":"rpc-1","ok":"true","result":1}'],
    ['array document', '[1,2]'],
    ['scalar document', '42'],
    ['null document', 'null'],
    ['empty object', '{}']
  ]

  for (const [label, text] of corpus) {
    const parsed = JSON.parse(text)
    const ours = hRpc.readRpcResponse(parsed)
    const reference = isRpcResponse(parsed)
    check(
      `readRpcResponse agrees with isRpcResponse: ${label}`,
      (ours !== null) === reference,
      `ours=${ours !== null} reference=${reference}`
    )
    if (ours !== null && reference) {
      check(`response id is preserved: ${label}`, ours.id === (parsed as { id: string }).id)
    }
  }

  check('streaming flag is read', hRpc.readRpcResponse(JSON.parse(corpus[3][1]))!.streaming)
  check('a plain success is not flagged streaming', !hRpc.readRpcResponse(JSON.parse(corpus[0][1]))!.streaming)
  check('failure error body is read', hRpc.readRpcResponse(JSON.parse(corpus[6][1]))!.error!.code === 'boom')
  check('parseRpcResponseText matches readRpcResponse', hRpc.parseRpcResponseText(corpus[0][1]) !== null)
  check('parseRpcResponseText rejects garbage', hRpc.parseRpcResponseText('{oops') === null)

  check('isStreamingOpenerReply true', hRpc.isStreamingOpenerReply(hRpc.readRpcResponse(JSON.parse(corpus[3][1]))!))
  check('isStreamingOpenerReply false for a plain success', !hRpc.isStreamingOpenerReply(hRpc.readRpcResponse(JSON.parse(corpus[0][1]))!))
  check('isMethodNotFoundRefusal', hRpc.isMethodNotFoundRefusal(hRpc.readRpcResponse(JSON.parse('{"id":"i","ok":false,"error":{"code":"method_not_found","message":"m"}}'))!))
  check('isUnauthorizedRefusal', hRpc.isUnauthorizedRefusal(hRpc.readRpcResponse(JSON.parse('{"id":"i","ok":false,"error":{"code":"unauthorized","message":"m"}}'))!))
  check(
    'requireRpcResultOrThrowCodedError returns the result',
    (hRpc.requireRpcResultOrThrowCodedError(hRpc.readRpcResponse(JSON.parse(corpus[0][1]))!) as Record<string, Object>).a === 1
  )
  check(
    'requireRpcResultOrThrowCodedError throws on failure',
    (() => {
      try {
        hRpc.requireRpcResultOrThrowCodedError(hRpc.readRpcResponse(JSON.parse(corpus[6][1]))!)
        return false
      } catch (error) {
        return (error as Error).message === 'boom: bad'
      }
    })()
  )
  check('rpcObjectResultOrNull rejects a scalar result', hRpc.rpcObjectResultOrNull(hRpc.readRpcResponse(JSON.parse(corpus[5][1]))!) === null)
  check('rpcObjectResultOrNull accepts an array result', hRpc.rpcObjectResultOrNull(hRpc.readRpcResponse(JSON.parse(corpus[2][1]))!) !== null)

  check('readTerminalSubscribedStreamId', hRpc.readTerminalSubscribedStreamId(JSON.parse('{"type":"subscribed","streamId":9}')) === 9)
  check('readTerminalSubscribedStreamId rejects a missing id', hRpc.readTerminalSubscribedStreamId(JSON.parse('{"type":"subscribed"}')) === null)
  check('readStreamingReadySubscriptionId', hRpc.readStreamingReadySubscriptionId(JSON.parse('{"type":"ready","subscriptionId":"s1"}')) === 's1')
  check('readStreamResultType', hRpc.readStreamResultType(JSON.parse('{"type":"end"}')) === 'end')
  check('readStreamResultType on a non-object', hRpc.readStreamResultType(null) === null)

  check('isRpcDeliveryUnknown true', hRpc.isRpcDeliveryUnknown(new hRpc.RpcDeliveryUnknownError('x')))
  check('isRpcDeliveryUnknown false for a plain error', !hRpc.isRpcDeliveryUnknown(new Error('x')))
  check('isRpcDeliveryUnknown false for null', !hRpc.isRpcDeliveryUnknown(null))
}

// ---------------------------------------------------------------------------
// 16. Unsubscribe builders
// ---------------------------------------------------------------------------

section('16. unsubscribe builders')

{
  const terminalCorpus: unknown[] = [
    { terminal: 't1' },
    { terminal: 't1', client: { id: 'c9' } },
    { terminal: 't1', client: {} },
    { terminal: 't1', client: { id: 7 } },
    { client: { id: 'c9' } },
    {},
    null
  ]
  for (const params of terminalCorpus) {
    const ours = hUnsub.buildTerminalUnsubscribeParams(params as Object | null)
    const reference = buildTerminalUnsubscribeParams(params)
    check(
      `terminal unsubscribe params match for ${JSON.stringify(params)}`,
      jsonEqual(ours, reference),
      `${JSON.stringify(ours)} vs ${JSON.stringify(reference)}`
    )
  }

  const streamCorpus: [string | undefined, unknown][] = [
    ['session.tabs.subscribe', { worktree: '/w/1' }],
    ['session.tabs.subscribe', {}],
    ['nativeChat.subscribe', { subscriptionId: 'a:b' }],
    ['nativeChat.subscribe', { agent: 'claude', sessionId: 's1' }],
    ['nativeChat.subscribe', {}],
    ['terminal.subscribe', { terminal: 't1' }],
    ['browser.screencast', { tab: 1 }],
    ['unknown.method', { x: 1 }],
    [undefined, { x: 1 }],
    ['session.tabs.subscribe', null]
  ]
  for (const [method, params] of streamCorpus) {
    const ours = hUnsub.buildStreamUnsubscribe(method as string, params as Object | null)
    const reference = buildStreamUnsubscribe(method, params)
    check(
      `stream unsubscribe matches for ${method} ${JSON.stringify(params)}`,
      jsonEqual(ours, reference),
      `${JSON.stringify(ours)} vs ${JSON.stringify(reference)}`
    )
  }

  const readyCorpus: [string, string][] = [
    ['browser.screencast', 'sub-1'],
    ['runtime.clientEvents.subscribe', 'sub-2'],
    ['terminal.subscribe', 'sub-3'],
    ['unknown', 'sub-4']
  ]
  for (const [method, subscriptionId] of readyCorpus) {
    const ours = hUnsub.buildReadyStreamUnsubscribe(method, subscriptionId)
    const reference = buildReadyStreamUnsubscribe(method, subscriptionId)
    check(
      `ready unsubscribe matches for ${method}`,
      jsonEqual(ours, reference),
      `${JSON.stringify(ours)} vs ${JSON.stringify(reference)}`
    )
  }

  check('native chat token shape', hUnsub.buildNativeChatSubscriptionId('claude', 's1') === 'claude:s1')
}

// ---------------------------------------------------------------------------
// 17. Outbound backpressure queue
// ---------------------------------------------------------------------------

section('17. outbound backpressure queue')

{
  interface Wire {
    buffered: number
    writable: boolean
    sent: string[]
  }

  const wire = (buffered: number, writable: boolean): Wire => ({ buffered, writable, sent: [] })

  const options = (target: Wire, clock: FakeClock, overflow: { count: number }) => ({
    send: (frame: string) => {
      target.sent.push(frame)
    },
    byteLengthOf: (frame: string) => frame.length,
    getBufferedAmount: () => target.buffered,
    isWritable: () => target.writable,
    onOverflow: () => {
      overflow.count++
    },
    softCapBytes: 100,
    maxQueuedBytes: 400,
    maxQueuedFrames: 8,
    drainPollMs: 25,
    setTimer: clock.set,
    clearTimer: clock.clear
  })

  const pair = (buffered: number, writable: boolean) => {
    const ourWire = wire(buffered, writable)
    const ourClock = new FakeClock()
    const ourOverflow = { count: 0 }
    const refWire = wire(buffered, writable)
    const refClock = new FakeClock()
    const refOverflow = { count: 0 }
    return {
      ourWire,
      ourClock,
      ourOverflow,
      refWire,
      refClock,
      refOverflow,
      ours: new OutboundBackpressureQueue<string>(options(ourWire, ourClock, ourOverflow)),
      reference: createWsOutboundBackpressureQueue<string>(options(refWire, refClock, refOverflow))
    }
  }

  // Under the cap, frames go straight out in order.
  {
    const p = pair(0, true)
    for (const frame of ['a', 'bb', 'ccc']) {
      check(`under-cap enqueue accepted: ${frame}`, p.ours.enqueue(frame) === p.reference.enqueue(frame))
    }
    check('direct sends match', p.ourWire.sent.join(',') === p.refWire.sent.join(','), `${p.ourWire.sent} vs ${p.refWire.sent}`)
    check('nothing is queued', p.ours.queuedBytes() === 0 && p.ours.queuedFrames() === 0)
  }

  // Over the soft cap, frames park and then flush in order.
  {
    const p = pair(500, true)
    for (const frame of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      check(`parked enqueue accepted: ${frame}`, p.ours.enqueue(frame) === p.reference.enqueue(frame))
    }
    check('parked frame counts match', p.ours.queuedFrames() === p.reference.evidence().queuedFrames)
    check('parked byte counts match', p.ours.queuedBytes() === p.reference.evidence().queuedBytes)
    check('nothing is sent while parked', p.ourWire.sent.length === 0 && p.refWire.sent.length === 0)

    p.ourWire.buffered = 0
    p.refWire.buffered = 0
    p.ourClock.advance(25)
    p.refClock.advance(25)
    check('drain order matches', p.ourWire.sent.join(',') === p.refWire.sent.join(','), `${p.ourWire.sent} vs ${p.refWire.sent}`)
    check('drain emptied both queues', p.ours.queuedFrames() === 0 && p.reference.evidence().queuedFrames === 0)
  }

  // Exceeding the hard cap raises overflow exactly once in both.
  {
    const p = pair(500, true)
    const big = 'x'.repeat(150)
    for (let i = 0; i < 5; i++) {
      const oursResult = p.ours.enqueue(big)
      const referenceResult = p.reference.enqueue(big)
      check(`overflow enqueue #${i} agrees`, oursResult === referenceResult, `ours=${oursResult} ref=${referenceResult}`)
    }
    check('our overflow fired once', p.ourOverflow.count === 1, String(p.ourOverflow.count))
    check('reference overflow fired once', p.refOverflow.count === 1, String(p.refOverflow.count))
    check('both queues dropped the backlog', p.ours.queuedFrames() === 0 && p.reference.evidence().queuedFrames === 0)
    check('further enqueues are refused', p.ours.enqueue('small') === false && p.reference.enqueue('small') === false)
  }

  // An oversized single frame overflows immediately and is never sent.
  {
    const p = pair(0, true)
    const huge = 'y'.repeat(500)
    check('oversized frame refused by both', p.ours.enqueue(huge) === p.reference.enqueue(huge))
    check('oversized frame raised overflow in both', p.ourOverflow.count === 1 && p.refOverflow.count === 1)
    check('oversized frame was never sent', p.ourWire.sent.length === 0 && p.refWire.sent.length === 0)
  }

  // A socket that is not writable parks frames; the drain then discards them.
  {
    const p = pair(0, false)
    check('not-writable enqueue parks in both', p.ours.enqueue('z') === p.reference.enqueue('z'))
    check('nothing sent while unwritable', p.ourWire.sent.length === 0 && p.refWire.sent.length === 0)
    p.ourClock.advance(25)
    p.refClock.advance(25)
    check('drain dropped the backlog in both', p.ours.queuedFrames() === 0 && p.reference.evidence().queuedFrames === 0)
    check('no send after the socket went away', p.ourWire.sent.length === 0 && p.refWire.sent.length === 0)
  }

  // dispose clears everything and refuses further work.
  {
    const p = pair(500, true)
    p.ours.enqueue('a')
    p.ours.dispose()
    check('dispose drops the backlog', p.ours.queuedFrames() === 0 && p.ours.queuedBytes() === 0)
    check('dispose refuses further enqueues', p.ours.enqueue('b') === false)
  }
}

// ---------------------------------------------------------------------------
// 18. Reconnect schedule
// ---------------------------------------------------------------------------

section('18. reconnect schedule')

{
  check('attempt limit constant matches', RPC_RECONNECT_ATTEMPT_LIMIT === 12)

  const make = () => {
    const clock = new FakeClock()
    const opened: number[] = []
    const rejections: string[] = []
    const schedule = new ReconnectSchedule({
      openConnection: () => opened.push(clock.now),
      rejectConnectWaiters: (reason) => rejections.push(reason),
      onScheduled: () => undefined,
      setTimer: clock.set,
      clearTimer: clock.clear
    })
    return { clock, opened, rejections, schedule }
  }

  {
    const { clock, opened, schedule } = make()
    const expectedDelays = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000]
    let elapsed = 0
    for (let i = 0; i < expectedDelays.length; i++) {
      schedule.schedule()
      clock.advance(expectedDelays[i])
      elapsed += expectedDelays[i]
      check(`reconnect #${i} fired at the cumulative delay`, opened[i] === elapsed, `${opened[i]} vs ${elapsed}`)
      check(`reconnect #${i} attempt counter`, schedule.getAttempt() === i + 1, String(schedule.getAttempt()))
    }
    schedule.authenticated()
    check('authentication resets the attempt counter', schedule.getAttempt() === 0)
  }

  // Past the attempt limit the schedule must switch to a slow trickle and stop
  // promising a connection to anyone waiting on it.
  {
    const { clock, rejections, schedule } = make()
    for (let i = 0; i < RPC_RECONNECT_ATTEMPT_LIMIT; i++) {
      schedule.schedule()
      clock.advance(60000)
    }
    check('no rejection before the limit', rejections.length === 0, String(rejections.length))
    schedule.schedule()
    check('trickle reconnect rejects waiters', rejections.length === 1 && rejections[0] === 'Connection retry limit reached', JSON.stringify(rejections))
    check('trickle does not advance the attempt counter', schedule.getAttempt() === RPC_RECONNECT_ATTEMPT_LIMIT, String(schedule.getAttempt()))
    schedule.cancel()
  }

  // redialNow reconnects immediately and can restart the backoff.
  {
    const { clock, opened, schedule } = make()
    schedule.schedule()
    clock.advance(500)
    check('one reconnect before the redial', opened.length === 1)
    schedule.redialNow(true)
    check('redialNow opens immediately', opened.length === 2 && opened[1] === clock.now)
    check('redialNow resets attempts', schedule.getAttempt() === 0)
    schedule.schedule()
    clock.advance(500)
    check('backoff restarts from the shortest delay', opened.length === 3 && opened[2] === clock.now)
    schedule.cancel()
    check('cancel clears the timer', !schedule.hasTimer())
  }

  // redialNow without resetting keeps the counter, so a broken link cannot spin.
  {
    const { clock, opened, schedule } = make()
    schedule.schedule()
    clock.advance(500)
    schedule.redialNow(false)
    check('redialNow keeps the attempt counter when asked', schedule.getAttempt() === 1, String(schedule.getAttempt()))
    schedule.schedule()
    clock.advance(1000)
    check('the next delay is the second step', opened.length === 3, String(opened.length))
    schedule.cancel()
  }
}

// ---------------------------------------------------------------------------
// 19. Liveness watchdog — parity against the reference watchdog
// ---------------------------------------------------------------------------

section('19. liveness watchdog')

{
  // The reference watchdog logs on every tolerated miss, which would drown the
  // summary; its behaviour is what is under test, not its logging.
  const realLog = console.log
  console.log = () => undefined

  interface ProbeLog {
    probes: number
    terminated: string[]
    timeouts: string[]
  }

  const makeWatchdogs = (sendable: boolean) => {
    const clock = new FakeClock()
    const clockRef = new FakeClock()
    const ourLog: ProbeLog = { probes: 0, terminated: [], timeouts: [] }
    const refLog: ProbeLog = { probes: 0, terminated: [], timeouts: [] }
    const ours = new LivenessWatchdog({
      transport: 'direct',
      sendProbe: () => {
        ourLog.probes++
        return sendable
      },
      terminate: () => ourLog.terminated.push('t'),
      onTimeout: (evidence) => ourLog.timeouts.push(evidence.reason),
      idleProbeMs: 20_000,
      probeTimeoutMs: 8_000,
      missedProbeLimit: 3,
      now: () => clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear
    })
    const reference = new RpcSessionLivenessWatchdog({
      transport: 'direct',
      sendProbe: () => {
        refLog.probes++
        return sendable
      },
      terminate: () => refLog.terminated.push('t'),
      onTimeout: (evidence) => refLog.timeouts.push(evidence.reason),
      now: () => clockRef.now,
      setTimer: clockRef.set,
      clearTimer: clockRef.clear
    })
    return { clock, clockRef, ours, reference, ourLog, refLog }
  }

  // Idle for the whole window, then let every probe time out.
  {
    const w = makeWatchdogs(true)
    const identity = { id: 1 }
    w.ours.start(identity)
    w.reference.start(identity)

    w.clock.advance(20_000)
    w.clockRef.advance(20_000)
    check('one idle probe fires (ours)', w.ourLog.probes === 1, String(w.ourLog.probes))
    check('one idle probe fires (reference)', w.refLog.probes === 1, String(w.refLog.probes))

    for (let i = 0; i < 4; i++) {
      w.clock.advance(8_000)
      w.clockRef.advance(8_000)
    }
    check('probe counts match', w.ourLog.probes === w.refLog.probes, `${w.ourLog.probes} vs ${w.refLog.probes}`)
    check('termination matches', w.ourLog.terminated.length === w.refLog.terminated.length, `${w.ourLog.terminated.length} vs ${w.refLog.terminated.length}`)
    check('timeout reasons match', jsonEqual(w.ourLog.timeouts, w.refLog.timeouts), `${JSON.stringify(w.ourLog.timeouts)} vs ${JSON.stringify(w.refLog.timeouts)}`)
    check('probe-timeout was the reason', w.ourLog.timeouts[0] === 'probe-timeout', String(w.ourLog.timeouts[0]))
  }

  // Inbound traffic keeps resetting the idle timer, so no probe may fire.
  {
    const w = makeWatchdogs(true)
    const identity = { id: 2 }
    w.ours.start(identity)
    w.reference.start(identity)
    for (let i = 0; i < 6; i++) {
      w.clock.advance(5_000)
      w.clockRef.advance(5_000)
      w.ours.noteAuthenticatedInbound(identity)
      w.reference.noteAuthenticatedInbound(identity)
    }
    check('no probe while traffic flows (ours)', w.ourLog.probes === 0, String(w.ourLog.probes))
    check('no probe while traffic flows (reference)', w.refLog.probes === 0, String(w.refLog.probes))
    check('last inbound is tracked (ours)', w.ours.getLastInboundAt() === w.clock.now)
    check('last inbound is tracked (reference)', w.reference.getLastInboundAt() === w.clockRef.now)
  }

  // A single missed probe is tolerated; recovery re-arms a fresh idle window.
  {
    const w = makeWatchdogs(true)
    const identity = { id: 3 }
    w.ours.start(identity)
    w.reference.start(identity)
    w.clock.advance(20_000)
    w.clockRef.advance(20_000)
    w.clock.advance(8_000)
    w.clockRef.advance(8_000)
    check('one missed probe is tolerated (ours)', w.ourLog.terminated.length === 0 && w.ourLog.probes === 2, `${w.ourLog.terminated.length}/${w.ourLog.probes}`)
    check('one missed probe is tolerated (reference)', w.refLog.terminated.length === 0 && w.refLog.probes === 2, `${w.refLog.terminated.length}/${w.refLog.probes}`)
    w.ours.noteAuthenticatedInbound(identity)
    w.reference.noteAuthenticatedInbound(identity)
    w.clock.advance(20_000)
    w.clockRef.advance(20_000)
    check('recovery re-arms a fresh probe (ours)', w.ourLog.probes === 3, String(w.ourLog.probes))
    check('recovery re-arms a fresh probe (reference)', w.refLog.probes === 3, String(w.refLog.probes))
  }

  // A probe that cannot be written terminates immediately, with no timeout wait.
  {
    const w = makeWatchdogs(false)
    const identity = { id: 4 }
    w.ours.start(identity)
    w.reference.start(identity)
    w.clock.advance(20_000)
    w.clockRef.advance(20_000)
    check('an unsendable probe terminates immediately (ours)', w.ourLog.terminated.length === 1, String(w.ourLog.terminated.length))
    check('an unsendable probe terminates immediately (reference)', w.refLog.terminated.length === 1, String(w.refLog.terminated.length))
    check('no retry after a send failure (ours)', w.ourLog.probes === 1, String(w.ourLog.probes))
    check('no retry after a send failure (reference)', w.refLog.probes === 1, String(w.refLog.probes))
    check('a send failure is not reported as a probe timeout (ours)', w.ourLog.timeouts[0] === 'probe-send-failed', String(w.ourLog.timeouts[0]))
  }

  // stop() releases the identity so later events are ignored.
  {
    const w = makeWatchdogs(true)
    const identity = { id: 5 }
    const other = { id: 6 }
    w.ours.start(identity)
    w.reference.start(identity)
    w.ours.stop(identity)
    w.reference.stop(identity)
    w.clock.advance(60_000)
    w.clockRef.advance(60_000)
    check('stop prevents probing (ours)', w.ourLog.probes === 0, String(w.ourLog.probes))
    check('stop prevents probing (reference)', w.refLog.probes === 0, String(w.refLog.probes))
    w.ours.noteAuthenticatedInbound(other)
    w.reference.noteAuthenticatedInbound(other)
    check('stop clears the tracked identity (ours)', w.ours.getLastInboundAt() === 0, String(w.ours.getLastInboundAt()))
    check('stop clears the tracked identity (reference)', w.reference.getLastInboundAt() === 0, String(w.reference.getLastInboundAt()))
  }

  console.log = realLog
}

// ---------------------------------------------------------------------------
// 20. Stream registry routing
// ---------------------------------------------------------------------------

section('20. stream registry routing')

{
  interface SentRequest {
    id: string
    method: string
    params: Record<string, Object>
  }

  const makeRegistry = (connected: boolean) => {
    const sent: SentRequest[] = []
    let counter = 0
    const results: (Object | null)[] = []
    const registry = new RpcStreamRegistry({
      nextId: () => `rpc-${++counter}`,
      deviceToken: 'token',
      isConnected: () => connected,
      sendEncrypted: (request) => {
        sent.push({
          id: request.id,
          method: request.method,
          params: (request.params ?? {}) as Record<string, Object>
        })
        return true
      }
    })
    return { registry, sent, results }
  }

  // A terminal subscription: the opener reply registers the stream id, then
  // binary frames reach the listener as `data` events.
  {
    const { registry, sent, results } = makeRegistry(true)
    const cancel = registry.subscribe(
      'terminal.subscribe',
      { terminal: 't1' },
      (result) => results.push(result)
    )
    check('subscribe sent one request', sent.length === 1 && sent[0].method === 'terminal.subscribe')
    check('subscribe carried the terminal param', sent[0].params.terminal === 't1')
    check('the request id was used verbatim', sent[0].id === 'rpc-1')

    const opener = hRpc.readRpcResponse({ id: 'rpc-1', ok: true, streaming: true, result: { type: 'subscribed', streamId: 33 } })!
    check('the opener reply is consumed by the registry', registry.handleResponse(opener))
    check('the opener result reached the listener', results.length === 1)

    registry.handleBinary(
      hTerminal.encodeTerminalStreamFrame({ opcode: 1, streamId: 33, seq: 0, payload: encoder.encode('hi') })
    )
    check('a binary frame reached the listener', results.length === 2 && (results[1] as { chunk: string }).chunk === 'hi')

    cancel()
    check('cancel sent the terminal unsubscribe', sent.length === 2 && sent[1].method === 'terminal.unsubscribe')
    check('the unsubscribe echoed the terminal as its subscription id', sent[1].params.subscriptionId === 't1')
    check('the stream was dropped', registry.size() === 0)
  }

  // A server-side subscription: `ready` records the subscriptionId, and cancel
  // must unsubscribes with that id rather than the method-specific default.
  {
    const { registry, sent } = makeRegistry(true)
    const cancel = registry.subscribe('runtime.clientEvents.subscribe', {}, () => undefined)
    const opener = hRpc.readRpcResponse({
      id: sent[0].id,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'sub-9' }
    })!
    check('the ready opener is consumed', registry.handleResponse(opener))
    cancel()
    check('ready unsubscribe uses the host subscription id', sent[1].method === 'runtime.clientEvents.unsubscribe' && sent[1].params.subscriptionId === 'sub-9')
  }

  // Subscribing while disconnected parks the request; authentication replays it.
  {
    const { registry, sent } = makeRegistry(false)
    registry.subscribe('session.tabs.subscribe', { worktree: '/w' }, () => undefined)
    check('nothing is sent while disconnected', sent.length === 0)
    registry.replayAfterAuthentication()
    check('the parked subscription is replayed', sent.length === 1 && sent[0].method === 'session.tabs.subscribe')
    check('replaying twice does not resend', (() => {
      registry.replayAfterAuthentication()
      return sent.length === 1
    })())
  }

  // A non-streaming reply must fall through to the request tracker.
  {
    const { registry } = makeRegistry(true)
    const plain = hRpc.readRpcResponse({ id: 'unknown-id', ok: true, result: { a: 1 } })!
    check('an unrelated success is not consumed', !registry.handleResponse(plain))
    const failure = hRpc.readRpcResponse({ id: 'unknown-id', ok: false, error: { code: 'x', message: 'y' } })!
    check('an unrelated failure is not consumed', !registry.handleResponse(failure))
  }

  // A stream whose opener fails must be surfaced as an error event and dropped.
  {
    const { registry, sent, results } = makeRegistry(true)
    registry.subscribe('terminal.subscribe', { terminal: 't2' }, (result) => results.push(result))
    const failure = hRpc.readRpcResponse({ id: sent[0].id, ok: false, error: { code: 'nope', message: 'no terminal' } })!
    check('a failed opener is consumed', registry.handleResponse(failure))
    check('a failed opener became an error event', results.length === 1 && (results[0] as { type: string }).type === 'error')
    check('the failed stream was dropped', registry.size() === 0)
  }

  // A scrollback result on a live stream is forwarded without closing it.
  {
    const { registry, sent, results } = makeRegistry(true)
    registry.subscribe('session.tabs.subscribe', { worktree: '/w' }, (result) => results.push(result))
    const scrollback = hRpc.readRpcResponse({ id: sent[0].id, ok: true, result: { type: 'scrollback', lines: [] } })!
    check('a scrollback result is consumed', registry.handleResponse(scrollback))
    check('a scrollback result is forwarded', results.length === 1)
    check('the stream stays open after scrollback', registry.size() === 1)
    const end = hRpc.readRpcResponse({ id: sent[0].id, ok: true, result: { type: 'end' } })!
    check('an end result is consumed', registry.handleResponse(end))
    check('the stream is dropped after end', registry.size() === 0)
  }

  // Viewport updates retarget only the matching terminal.
  {
    const { registry, sent } = makeRegistry(true)
    registry.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined)
    registry.subscribe('terminal.subscribe', { terminal: 't2' }, () => undefined)
    registry.updateTerminalViewport('t1', 120, 40)
    const t1 = sent.find((request) => request.params.terminal === 't1')!
    const t2 = sent.find((request) => request.params.terminal === 't2')!
    check('the matching terminal got a viewport', jsonEqual(t1.params.viewport, { cols: 120, rows: 40 }))
    check('the other terminal was untouched', t2.params.viewport === undefined)
  }

  // markForReplay arms every live subscription for a resend.
  {
    const { registry, sent } = makeRegistry(true)
    registry.subscribe('session.tabs.subscribe', { worktree: '/w' }, () => undefined)
    check('one request before the replay', sent.length === 1)
    registry.markForReplay()
    registry.replayAfterAuthentication()
    check('markForReplay caused a resend', sent.length === 2)
  }
}

// ---------------------------------------------------------------------------
// 21. Runtime capability advertisement
// ---------------------------------------------------------------------------

section('21. runtime capability advertisement')

{
  // The ArkTS list is a hand-maintained copy, so this is the guard that keeps it
  // honest: any upstream capability change fails here until the copy is updated.
  check(
    'capability list matches the reference exactly, in order',
    jsonEqual(MOBILE_RUNTIME_CLIENT_CAPABILITIES, REFERENCE_CAPABILITIES),
    `ours=${JSON.stringify(MOBILE_RUNTIME_CLIENT_CAPABILITIES)}\n     reference=${JSON.stringify(REFERENCE_CAPABILITIES)}`
  )
  check('capability list has no duplicates', new Set(MOBILE_RUNTIME_CLIENT_CAPABILITIES).size === MOBILE_RUNTIME_CLIENT_CAPABILITIES.length)
  check(
    'capability update method matches',
    MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD === REFERENCE_CAPABILITY_METHOD,
    `${MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD} vs ${REFERENCE_CAPABILITY_METHOD}`
  )
  check(
    'capability update params match',
    jsonEqual(mobileRuntimeClientCapabilityUpdateParams(), referenceCapabilityParams())
  )
  check(
    'advertised params do not alias the constant',
    (() => {
      const params = mobileRuntimeClientCapabilityUpdateParams()
      const list = params.clientCapabilities as string[]
      // Measured against our own length, not the reference's: comparing to the
      // reference only proved the two lists were the same size, so this check
      // failed for an unrelated reason whenever the copy was one entry behind
      // the capability change it was meant to report.
      const before = MOBILE_RUNTIME_CLIENT_CAPABILITIES.length
      list.push('mutated')
      return MOBILE_RUNTIME_CLIENT_CAPABILITIES.length === before
    })()
  )
}

finish('the ArkTS RPC/transport core matches the reference implementation.')

/*
 * The RPC response shape, the stream-unsubscribe builders, and the outbound backpressure queue.
 *
 * Split out of `verify-transport-interop.ts`; the entry point runs every module
 * so the assertions still report through one counters and one summary.
 */
import { check, section, jsonEqual } from './harness'
import * as hRpc from '../../entry/src/main/ets/core/rpc/RpcProtocol.ets'
import * as hUnsub from '../../entry/src/main/ets/core/rpc/RpcStreamUnsubscribe.ets'
import { OutboundBackpressureQueue } from '../../entry/src/main/ets/core/rpc/OutboundQueue.ets'
import { isRpcResponse } from '../../../mobile/src/transport/rpc-response-shape'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams
} from '../../../mobile/src/transport/rpc-client-terminal-subscription'
import { buildReadyStreamUnsubscribe } from '../../../mobile/src/transport/rpc-client-server-subscription'
import { createWsOutboundBackpressureQueue } from '../../../src/shared/ws-outbound-backpressure-queue'
import { FakeClock } from './verify-transport-clock'

export function runRpcShapeSections(): void {
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
      (hRpc.requireRpcResultOrThrowCodedError(hRpc.readRpcResponse(JSON.parse(corpus[0][1]))!) as Record<string, object>).a === 1
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
      const ours = hUnsub.buildTerminalUnsubscribeParams(params as object | null)
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
      const ours = hUnsub.buildStreamUnsubscribe(method as string, params as object | null)
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
    type Wire = {
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

}

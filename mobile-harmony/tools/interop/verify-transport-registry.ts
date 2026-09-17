/*
 * Stream-registry routing and the runtime capability advertisement.
 *
 * Split out of `verify-transport-interop.ts`; the entry point runs every module
 * so the assertions still report through one counters and one summary.
 */
import { check, section, jsonEqual } from './harness'
import * as hTerminal from '../../entry/src/main/ets/core/rpc/TerminalStreamProtocol.ets'
import * as hRpc from '../../entry/src/main/ets/core/rpc/RpcProtocol.ets'
import { RpcStreamRegistry } from '../../entry/src/main/ets/core/rpc/RpcStreamRegistry.ets'
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITIES,
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from '../../entry/src/main/ets/core/rpc/MobileRuntimeCapabilities.ets'
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITIES as REFERENCE_CAPABILITIES,
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD as REFERENCE_CAPABILITY_METHOD,
  mobileRuntimeClientCapabilityUpdateParams as referenceCapabilityParams
} from '../../../mobile/src/transport/mobile-runtime-client-capabilities'

const encoder = new TextEncoder()

export function runRegistrySections(): void {
  // ---------------------------------------------------------------------------
  // 20. Stream registry routing
  // ---------------------------------------------------------------------------

  section('20. stream registry routing')

  {
    type SentRequest = {
      id: string
      method: string
      params: Record<string, unknown>
    }

    const makeRegistry = (connected: boolean) => {
      const sent: SentRequest[] = []
      let counter = 0
      const results: (object | null)[] = []
      const registry = new RpcStreamRegistry({
        nextId: () => `rpc-${++counter}`,
        deviceToken: 'token',
        isConnected: () => connected,
        sendEncrypted: (request) => {
          sent.push({
            id: request.id,
            method: request.method,
            params: (request.params ?? {}) as Record<string, object>
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

}

/*
 * The last three end-to-end scenarios: key pinning, the foreground probe, and
 * an unknown method.
 *
 * Split out of the main driver purely to keep each file readable. Each block is
 * self-contained — it dials its own client through the shared harness — so the
 * split changes no behaviour.
 */
import type { RpcClientOptions } from '../../entry/src/main/ets/transport/RpcClient.ets';
import { RpcClient } from '../../entry/src/main/ets/transport/RpcClient.ets'
import type { RpcResponse } from '../../entry/src/main/ets/core/rpc/RpcProtocol.ets'
import { check, section } from './harness'
import { DesktopPeer } from './desktop-peer'
import { PipeSocketFactory } from './client-link'
import {
  CLIENT_RANDOM_SEED,
  DEVICE_TOKEN,
  OTHER_DESKTOP_SECRET,
  TERMINALS,
  desktopPublicKeyB64,
  seedRandom,
  sleep,
  startClient,
  waitFor
} from './e2e-client-harness'

export async function runTailScenarios(): Promise<void> {
  // ---------------------------------------------------------------------------
  // E2E-8. A wrong pinned key must never connect
  // ---------------------------------------------------------------------------

  section('E2E-8. pinned key enforcement')

  {
    // The client is pinned to DESKTOP_SECRET's key but the peer answers with a
    // different one, which is exactly what a man-in-the-middle would do.
    const states: string[] = []
    const factory = new PipeSocketFactory({
      desktopPublicKeyB64,
      random: seedRandom(CLIENT_RANDOM_SEED),
      onPeer: () => {},
      makePeer: () =>
        new DesktopPeer({
          serverSecret: OTHER_DESKTOP_SECRET,
          deviceToken: DEVICE_TOKEN,
          terminals: TERMINALS
        })
    })
    const options: RpcClientOptions = {
      endpoint: 'ws://192.168.1.20:7788',
      deviceToken: DEVICE_TOKEN,
      serverPublicKeyB64: desktopPublicKeyB64,
      factory,
      onStateChange: (state: string) => states.push(state),
      onLog: () => {}
    }
    const client = new RpcClient(options)

    await sleep(900)
    check('a host presenting the wrong key never reaches connected', client.getState() !== 'connected', `state=${client.getState()}`)
    check('the mismatch is not published as a successful connect', !states.includes('connected'), states.join(' → '))
    check(
      'the client retried (it treats the mismatch as a failed dial)',
      factory.peers.length >= 2,
      `dials=${factory.peers.length}`
    )

    client.close()
  }

  // ---------------------------------------------------------------------------
  // E2E-9. A foreground nudge probes the live link
  // ---------------------------------------------------------------------------

  section('E2E-9. foreground liveness probe')

  {
    const harness = startClient()
    const { client, factory } = harness
    await waitFor('connected', () => client.getState() === 'connected')
    const peer = factory.latestPeer()
    const before = peer === null ? 0 : peer.rpcRequests.length

    client.notifyForeground()

    const probed = await waitFor(
      'a liveness probe to reach the desktop',
      () =>
        peer !== null &&
        peer.rpcRequests.length > before &&
        peer.rpcRequests.some((request) => request.method === 'status.get' && request.id.startsWith('mobile-liveness-')),
      4000
    )
    check('foregrounding on a live link sends an immediate liveness probe', probed)
    check(
      'the probe is a status.get carrying the liveness request-id prefix',
      peer !== null &&
        peer.rpcRequests.some(
          (request) => request.method === 'status.get' && request.id.startsWith('mobile-liveness-')
        )
    )
    check(
      'the probe did not disturb the connection state',
      client.getState() === 'connected',
      `state=${client.getState()}`
    )

    client.close()
  }

  // ---------------------------------------------------------------------------
  // E2E-10. A method the desktop does not implement is reported, not swallowed
  // ---------------------------------------------------------------------------

  section('E2E-10. unknown method is refused')

  {
    const harness = startClient()
    const { client } = harness
    await waitFor('connected', () => client.getState() === 'connected')

    const response: RpcResponse = await client.sendRequest('does.not.exist', undefined)
    check('an unknown method returns a refusal rather than hanging', response.ok === false)
    check(
      'the refusal carries the desktop error code',
      response.error !== null && response.error.code === 'method_not_found',
      JSON.stringify(response.error)
    )

    client.close()
  }
}
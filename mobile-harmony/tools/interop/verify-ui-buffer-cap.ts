/*
 * UI-9: the terminal buffer is bounded.
 *
 * Split out of `verify-ui-state.ts`; it drives the same shipped view-model, so it
 * belongs in the same suite and reports through the same counters.
 */
import { check, section } from './harness'
import { createEnvironment, pairingCode, waitFor } from './ui-state-environment'

export async function runBufferCapScenario(): Promise<void> {
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
    const chunk = Array.from({ length: 500 }, () => 'x').join('\n')
    for (let index = 0; index < 10; index++) {
      peer?.sendOutput('term-1', `\n${chunk}`, 100 + index)
    }
    await waitFor('the buffer to exceed the cap', () => env.connection.terminal().length >= 2000, 8000)

    const lines = env.connection.terminal()
    check('the buffer is capped', lines.length <= 2000, `${lines.length} lines`)
    check('the cap is actually reached (the stream was long enough)', lines.length >= 1900, `${lines.length} lines`)
    check('line ids keep increasing after trimming (no key reuse)', lines.at(-1).id > lines[0].id)

    env.connection.disconnect()
  }
}

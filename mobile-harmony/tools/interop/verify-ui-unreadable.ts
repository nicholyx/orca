/*
 * UI-8: the unreadable state fails closed.
 *
 * Split out of `verify-ui-state.ts`; it drives the same shipped view-model, so it
 * belongs in the same suite and reports through the same counters.
 */
import { check, section } from './harness'
import { ENDPOINT, createEnvironment, desktopPublicKeyB64, pairingCode } from './ui-state-environment'

export async function runUnreadableStateScenario(): Promise<void> {
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
      (broken.preferences.raw().get('hosts.v1') ?? '').includes(desktopPublicKeyB64)
    )

    // (d) A re-pair after a credential wipe must overwrite in place, not duplicate.
    broken.assetStore.readsFail = false
    const repaired = await broken.connection.pairFromInput(pairingCode())
    check('re-pairing repairs a missing credential', repaired.ok, JSON.stringify(repaired))
    check('the repair reused the existing host row', broken.connection.hostRows().length === 1)
    check('the repair wrote exactly one credential', broken.assetStore.entries.size === 1)
  }
}

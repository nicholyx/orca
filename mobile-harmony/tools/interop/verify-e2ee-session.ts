/*
 * The whole client session, driven through a real handshake and a real frame exchange.
 *
 * Split out of `verify-interop.ts`; the entry point runs every module, so all
 * assertions still report through one counter and one summary.
 */
import { check, section, bytesEqualCheck, fixture, equalHex } from './harness'
import nacl from 'tweetnacl'
import * as hBase64 from '../../entry/src/main/ets/core/bytes/Base64.ets'
import { sequenceRandomBytes } from '../../entry/src/main/ets/core/crypto/RandomSource.ets'
import { E2eeV2ClientSession } from '../../entry/src/main/ets/core/e2ee/E2eeV2ClientSession.ets'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../src/shared/mobile-e2ee-v2-framing'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from '../../../src/shared/mobile-e2ee-v2-contract'
import { deriveMobileE2EEV2KeySchedule } from '../../../mobile/src/transport/mobile-e2ee-v2-key-schedule'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function runSessionSections(): void {
  section('11. End-to-end client session')

  {
    // The desktop side is played by the reference implementation, so a successful
    // run proves the ArkTS client and the desktop derive the same keys and can
    // exchange frames in both directions.
    const desktopSecret = fixture(32, 61000)
    const desktopKeyPair = nacl.box.keyPair.fromSecretKey(desktopSecret)
    const desktopPublicKeyB64 = Buffer.from(desktopKeyPair.publicKey).toString('base64')

    const clientNonce = fixture(32, 62000)
    const clientSecret = fixture(32, 61500)
    const clientKeyPair = nacl.box.keyPair.fromSecretKey(clientSecret)

    const session = E2eeV2ClientSession.create(sequenceRandomBytes(1), {
      desktopPublicKeyB64,
      transport: 'direct',
      clientNonce,
      clientKeyPair
    })
    check('session hello is an e2ee_hello', session.hello.type === 'e2ee_hello')
    check('session hello omits relayHostId for direct', session.hello.context.relayHostId === undefined)
    check(
      'session hello serializes to the expected key set',
      JSON.stringify(Object.keys(JSON.parse(session.encodeHelloText()))) ===
        JSON.stringify(['type', 'v', 'clientPublicKeyB64', 'clientNonceB64', 'capabilities', 'context'])
    )
    check(
      'session hello publishes the given client key',
      session.hello.clientPublicKeyB64 === Buffer.from(clientKeyPair.publicKey).toString('base64')
    )
    check('session is not ready before the handshake', !session.isReady)
    check(
      'sealing before the handshake throws',
      (() => {
        try {
          session.sealText('too early')
          return false
        } catch {
          return true
        }
      })()
    )

    const desktopNonce = fixture(32, 63000)
    const readyDocument = {
      type: 'e2ee_ready',
      v: 2,
      desktopPublicKeyB64,
      clientNonceB64: Buffer.from(clientNonce).toString('base64'),
      desktopNonceB64: Buffer.from(desktopNonce).toString('base64'),
      selection: { framing: 2, payloadKinds: ['text', 'binary'] },
      context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
    }

    check('session accepts the ready', session.acceptReady(readyDocument))
    check('session reports ready after the handshake', session.isReady)

    // Re-delivering the same ready is idempotent here, exactly as in the
    // reference: both re-validate against the same hello and the same pinned key,
    // so the schedule cannot change. Rejecting a duplicate is the channel state
    // machine's job, not the session's.
    check('session tolerates a repeated ready', session.acceptReady(readyDocument))

    // Independent desktop-side derivation, using the reference modules only.
    // SAFETY: the reference validator is typed for the React Native client's own
    // document types; this harness hands it the same bytes the ArkTS session built.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cross-implementation equality is the test; only the nominal type differs.
    const referenceHandshake = validateMobileE2EEV2Handshake(session.hello as never, readyDocument as never)!
    const referenceSchedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: nacl.box.before(clientKeyPair.publicKey, desktopSecret),
      transcript: encodeMobileE2EEV2Transcript(referenceHandshake),
      clientNonce,
      desktopNonce
    })

    check(
      'session transcript hash matches reference',
      session.transcriptHashB64 === Buffer.from(referenceSchedule.transcriptHash).toString('base64')
    )

    // Mobile -> desktop: our seal, the reference opens. Text goes on the wire as
    // canonical base64, so the wire bytes are compared through the decoder.
    {
      const text = 'hello from harmony, 你好 📱'
      const sealedB64 = session.sealText(text)
      // The bytes we actually put on the wire must equal the reference seal.
      bytesEqualCheck(
        'wire text frame matches reference seal',
        hBase64.decodeCanonicalBase64(sealedB64),
        sealMobileE2EEV2Frame({
          payload: encoder.encode(text),
          key: referenceSchedule.mobileToDesktopKey,
          sessionId: referenceSchedule.sessionId,
          direction: 'mobile-to-desktop',
          payloadKind: 'text',
          counter: 0n
        })
      )
      const opened = openMobileE2EEV2Frame({
        frame: hBase64.decodeCanonicalBase64(sealedB64)!,
        key: referenceSchedule.mobileToDesktopKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'text',
        expectedCounter: 0n
      })
      check('desktop opens the harmony text frame', opened !== null && decoder.decode(opened) === text)

      const binary = fixture(300, 64000)
      const binaryFrame = session.sealBinary(binary)
      bytesEqualCheck(
        'wire binary frame matches reference seal',
        binaryFrame,
        sealMobileE2EEV2Frame({
          payload: binary,
          key: referenceSchedule.mobileToDesktopKey,
          sessionId: referenceSchedule.sessionId,
          direction: 'mobile-to-desktop',
          payloadKind: 'binary',
          counter: 1n
        })
      )
      const openedBinary = openMobileE2EEV2Frame({
        frame: binaryFrame,
        key: referenceSchedule.mobileToDesktopKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'binary',
        expectedCounter: 1n
      })
      check('desktop opens the harmony binary frame', openedBinary !== null && equalHex(openedBinary, binary))
    }

    // Desktop -> mobile: the reference seals, we open.
    {
      const payload = fixture(128, 65000)
      const frame = sealMobileE2EEV2Frame({
        payload,
        key: referenceSchedule.desktopToMobileKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'binary',
        counter: 0n
      })
      const openedBinary = session.openBinary(frame)
      check('harmony opens the desktop binary frame', openedBinary !== null && equalHex(openedBinary, payload))

      // A replay of the same counter must be refused, and must not advance state.
      const replay = sealMobileE2EEV2Frame({
        payload,
        key: referenceSchedule.desktopToMobileKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'binary',
        counter: 0n
      })
      check('harmony rejects a replayed frame', session.openBinary(replay) === null)

      const desktopText = 'reply from desktop'
      const textFrame = sealMobileE2EEV2Frame({
        payload: encoder.encode(desktopText),
        key: referenceSchedule.desktopToMobileKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'text',
        counter: 1n
      })
      check(
        'harmony opens the desktop text frame',
        session.openText(Buffer.from(textFrame).toString('base64')) === desktopText
      )

      const wrongDirection = sealMobileE2EEV2Frame({
        payload,
        key: referenceSchedule.desktopToMobileKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'mobile-to-desktop',
        payloadKind: 'binary',
        counter: 2n
      })
      check('harmony rejects a mis-directioned frame', session.openBinary(wrongDirection) === null)

      const wrongKey = sealMobileE2EEV2Frame({
        payload,
        key: fixture(32, 66000),
        sessionId: referenceSchedule.sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'binary',
        counter: 2n
      })
      check('harmony rejects a frame sealed with the wrong key', session.openBinary(wrongKey) === null)

      check('harmony rejects malformed base64 text', session.openText('not base64!!') === null)

      // Counters are per direction and per socket: a frame two ahead must fail.
      const gap = sealMobileE2EEV2Frame({
        payload,
        key: referenceSchedule.desktopToMobileKey,
        sessionId: referenceSchedule.sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'binary',
        counter: 5n
      })
      check('harmony rejects an out-of-order frame', session.openBinary(gap) === null)
    }

    // Pinning: a ready naming a different desktop key must be refused.
    {
      const otherDesktop = nacl.box.keyPair.fromSecretKey(fixture(32, 67000))
      const pinned = E2eeV2ClientSession.create(sequenceRandomBytes(2), {
        desktopPublicKeyB64,
        transport: 'direct',
        clientNonce,
        clientKeyPair
      })
      check(
        'session refuses an unpinned desktop key',
        !pinned.acceptReady({ ...readyDocument, desktopPublicKeyB64: Buffer.from(otherDesktop.publicKey).toString('base64') })
      )
      check('a refused handshake leaves the session unready', !pinned.isReady)
      check(
        'a refused handshake never exposes a transcript hash',
        (() => {
          try {
            void pinned.transcriptHashB64
            return false
          } catch {
            return true
          }
        })()
      )
    }

    // A relay session must advertise the relay host id.
    {
      const relaySession = E2eeV2ClientSession.create(sequenceRandomBytes(3), {
        desktopPublicKeyB64,
        transport: 'relay',
        relayHostId: 'AbCd-_0123456789',
        clientNonce,
        clientKeyPair
      })
      check('relay session hello transport', relaySession.hello.context.transport === 'relay')
      check('relay session hello relayHostId', relaySession.hello.context.relayHostId === 'AbCd-_0123456789')
      check(
        'relay session never exposes a transcript hash',
        (() => {
          try {
            void relaySession.transcriptHashB64
            return false
          } catch {
            return true
          }
        })()
      )
    }
  }
}

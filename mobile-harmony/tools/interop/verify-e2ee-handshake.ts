/*
 * The e2ee_hello / e2ee_ready contract and the handshake transcript.
 *
 * Split out of `verify-interop.ts`; the entry point runs every module, so all
 * assertions still report through one counter and one summary.
 */
import { check, section, bytesEqualCheck, fixture, equalHex } from './harness'
import nacl from 'tweetnacl'
import * as hContract from '../../entry/src/main/ets/core/e2ee/E2eeV2Contract.ets'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from '../../../src/shared/mobile-e2ee-v2-contract'

export function runHandshakeSections(): void {
  section('10. Handshake contract')

  {
    const clientSecret = fixture(32, 51000)
    const desktopSecret = fixture(32, 51001)
    const clientKeyPair = nacl.box.keyPair.fromSecretKey(clientSecret)
    const desktopKeyPair = nacl.box.keyPair.fromSecretKey(desktopSecret)
    const clientNonce = fixture(32, 52000)
    const desktopNonce = fixture(32, 53000)
    const clientPublicKeyB64 = Buffer.from(clientKeyPair.publicKey).toString('base64')
    const clientNonceB64 = Buffer.from(clientNonce).toString('base64')
    const desktopPublicKeyB64 = Buffer.from(desktopKeyPair.publicKey).toString('base64')
    const desktopNonceB64 = Buffer.from(desktopNonce).toString('base64')

    const hello = hContract.buildDirectHello({ clientPublicKeyB64, clientNonceB64 })
    check('hello type', hello.type === 'e2ee_hello')
    check('hello version', hello.v === 2)
    check('hello capabilities framing', JSON.stringify(hello.capabilities.framing) === '[2]')
    check('hello capabilities kinds', JSON.stringify(hello.capabilities.payloadKinds) === '["text","binary"]')
    check('hello context transport', hello.context.transport === 'direct')
    check('hello context has no relayHostId', hello.context.relayHostId === undefined)

    const relayHello = hContract.buildRelayHello({ clientPublicKeyB64, clientNonceB64, relayHostId: 'AbCd-_0123456789' })
    check('relay hello transport', relayHello.context.transport === 'relay')
    check('relay hello relayHostId', relayHello.context.relayHostId === 'AbCd-_0123456789')

    const parsedHello = JSON.parse(hContract.encodeHello(hello))
    check(
      'encoded hello key set',
      JSON.stringify(Object.keys(parsedHello)) ===
        JSON.stringify(['type', 'v', 'clientPublicKeyB64', 'clientNonceB64', 'capabilities', 'context'])
    )
    check(
      'encoded hello context key set',
      JSON.stringify(Object.keys(parsedHello.context)) ===
        JSON.stringify(['protocol', 'initiator', 'responder', 'transport'])
    )
    check(
      'encoded relay hello context has relayHostId',
      JSON.stringify(Object.keys(JSON.parse(hContract.encodeHello(relayHello)).context)) ===
        JSON.stringify(['protocol', 'initiator', 'responder', 'transport', 'relayHostId'])
    )

    const readyDocument = {
      type: 'e2ee_ready',
      v: 2,
      desktopPublicKeyB64,
      clientNonceB64,
      desktopNonceB64,
      selection: { framing: 2, payloadKinds: ['text', 'binary'] },
      context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
    }

    const validated = hContract.validateReady(hello, readyDocument)
    check('validateReady accepts a well-formed ready', validated !== null)
    check('validateReady decodes client key', validated !== null && equalHex(validated.clientPublicKey, clientKeyPair.publicKey))
    check('validateReady decodes desktop key', validated !== null && equalHex(validated.desktopPublicKey, desktopKeyPair.publicKey))
    check('validateReady decodes client nonce', validated !== null && equalHex(validated.clientNonce, clientNonce))
    check('validateReady decodes desktop nonce', validated !== null && equalHex(validated.desktopNonce, desktopNonce))

    {
      const referenceHandshake: MobileE2EEV2Handshake = validateMobileE2EEV2Handshake(
        hello as never,
        readyDocument as never
      )!
      check('reference accepts the same ready', referenceHandshake !== null)
      const expectedTranscript = encodeMobileE2EEV2Transcript(referenceHandshake)
      bytesEqualCheck('transcript matches reference', validated!.transcript, expectedTranscript)

      const oursDirect = hContract.encodeTranscript({
        hello,
        ready: validated!.ready,
        readyContext: validated!.ready.context,
        clientPublicKey: clientKeyPair.publicKey,
        desktopPublicKey: desktopKeyPair.publicKey,
        clientNonce,
        desktopNonce
      })
      bytesEqualCheck('encodeTranscript matches reference', oursDirect, expectedTranscript)
    }

    {
      const relayReady = {
        ...readyDocument,
        context: {
          protocol: 'orca-mobile-e2ee',
          initiator: 'mobile',
          responder: 'desktop',
          transport: 'relay',
          relayHostId: 'AbCd-_0123456789'
        }
      }
      const relayValidated = hContract.validateReady(relayHello, relayReady)
      check('validateReady accepts relay ready', relayValidated !== null)
      const referenceRelay = validateMobileE2EEV2Handshake(relayHello as never, relayReady as never)!
      bytesEqualCheck('relay transcript matches reference', relayValidated!.transcript, encodeMobileE2EEV2Transcript(referenceRelay))
      check('direct and relay transcripts differ', !equalHex(validated!.transcript, relayValidated!.transcript))
    }

    // Every rejection the reference performs must also be performed here, and
    // both implementations must agree on the verdict.
    const rejections: [string, unknown][] = [
      ['an extra key', { ...readyDocument, extra: 1 }],
      ['a removed key', { type: 'e2ee_ready' }],
      ['the wrong type', { ...readyDocument, type: 'e2ee_hello' }],
      ['the wrong version', { ...readyDocument, v: 1 }],
      ['a nonce echo mismatch', { ...readyDocument, clientNonceB64: Buffer.from(fixture(32, 55)).toString('base64') }],
      ['a non-32-byte desktop key', { ...readyDocument, desktopPublicKeyB64: Buffer.from(fixture(31, 56)).toString('base64') }],
      ['a non-base64 desktop key', { ...readyDocument, desktopPublicKeyB64: 'not base64!!' }],
      ['selection framing 1', { ...readyDocument, selection: { framing: 1, payloadKinds: ['text', 'binary'] } }],
      ['reordered selection kinds', { ...readyDocument, selection: { framing: 2, payloadKinds: ['binary', 'text'] } }],
      ['an extra selection key', { ...readyDocument, selection: { framing: 2, payloadKinds: ['text', 'binary'], extra: 1 } }],
      [
        'a context transport mismatch',
        {
          ...readyDocument,
          context: {
            protocol: 'orca-mobile-e2ee',
            initiator: 'mobile',
            responder: 'desktop',
            transport: 'relay',
            relayHostId: 'AbCd-_0123456789'
          }
        }
      ],
      ['a wrong context protocol', { ...readyDocument, context: { protocol: 'other', initiator: 'mobile', responder: 'desktop', transport: 'direct' } }],
      ['a wrong context initiator', { ...readyDocument, context: { protocol: 'orca-mobile-e2ee', initiator: 'desktop', responder: 'desktop', transport: 'direct' } }],
      [
        'a direct context carrying relayHostId',
        {
          ...readyDocument,
          context: {
            protocol: 'orca-mobile-e2ee',
            initiator: 'mobile',
            responder: 'desktop',
            transport: 'direct',
            relayHostId: 'AbCd-_0123456789'
          }
        }
      ],
      ['a non-object', 42]
    ]
    for (const [label, candidate] of rejections) {
      const ours = hContract.validateReady(hello, candidate as object)
      let referenceRejects = false
      try {
        referenceRejects = validateMobileE2EEV2Handshake(hello as never, candidate as never) === null
      } catch {
        referenceRejects = true
      }
      check(`validateReady rejects ${label}`, ours === null, ours === null ? undefined : 'accepted')
      check(`reference agrees on rejecting ${label}`, referenceRejects, 'reference accepted')
    }

    for (const bad of ['short', 'AbCd-_0123456789x', 'AbCd+/0123456789', 'AbCd _0123456789']) {
      const candidate = {
        ...readyDocument,
        context: {
          protocol: 'orca-mobile-e2ee',
          initiator: 'mobile',
          responder: 'desktop',
          transport: 'relay',
          relayHostId: bad
        }
      }
      check(`validateReady rejects relayHostId ${JSON.stringify(bad)}`, hContract.validateReady(relayHello, candidate) === null)
    }

    check('encodePublicKeyB64 matches Buffer', hContract.encodePublicKeyB64(clientKeyPair.publicKey) === clientPublicKeyB64)
    check('publicKeysEqual true', hContract.publicKeysEqual(clientKeyPair.publicKey, Uint8Array.from(clientKeyPair.publicKey)))
    check('publicKeysEqual false', !hContract.publicKeysEqual(clientKeyPair.publicKey, desktopKeyPair.publicKey))
  }
}

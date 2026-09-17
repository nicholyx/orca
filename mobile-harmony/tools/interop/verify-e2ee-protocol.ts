/*
 * The JSON narrowing helpers, the E2EE v2 frame format and the key schedule.
 *
 * Split out of `verify-interop.ts`; the entry point runs every module, so all
 * assertions still report through one counter and one summary.
 */
import { check, section, bytesEqualCheck, fixture, equalHex, hex } from './harness'
import * as hJson from '../../entry/src/main/ets/core/json/JsonValue.ets'
import * as hFrame from '../../entry/src/main/ets/core/e2ee/E2eeV2Framing.ets'
import * as hSchedule from '../../entry/src/main/ets/core/e2ee/E2eeV2KeySchedule.ets'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../src/shared/mobile-e2ee-v2-framing'
import { deriveMobileE2EEV2KeySchedule } from '../../../mobile/src/transport/mobile-e2ee-v2-key-schedule'

export function runProtocolSections(): void {
  section('7. JSON helpers')

  {
    const record = hJson.parseJsonRecord('{"type":"e2ee_ready","v":2,"ok":true,"n":3.5,"list":[1,2],"strs":["a","b"]}')
    check('parseJsonRecord accepts object', record !== null)
    check('parseJsonRecord rejects arrays', hJson.parseJsonRecord('[1,2]') === null)
    check('parseJsonRecord rejects garbage', hJson.parseJsonRecord('{oops') === null)
    check('asString', hJson.asString(record!.type) === 'e2ee_ready')
    check('asNumber', hJson.asNumber(record!.v) === 2)
    check('asBoolean', hJson.asBoolean(record!.ok) === true)
    check('asArray', (hJson.asArray(record!.list) ?? []).length === 2)
    check('asNumberArray', JSON.stringify(hJson.asNumberArray(record!.list)) === '[1,2]')
    check('asStringArray', JSON.stringify(hJson.asStringArray(record!.strs)) === '["a","b"]')
    check('asString on number is null', hJson.asString(record!.v) === null)
    check('asNumber on string is null', hJson.asNumber(record!.type) === null)
    check('asNumberArray rejects non-numbers', hJson.asNumberArray(hJson.parseJsonRecord('{"list":["a","b"]}')!.list) === null)
    check('asStringArray rejects numbers', hJson.asStringArray(record!.list) === null)

    check('hasExactKeys true', hJson.hasExactKeys(record!, ['type', 'v', 'ok', 'n', 'list', 'strs']))
    check('hasExactKeys false on extra key', !hJson.hasExactKeys(record!, ['type']))
    check('hasExactKeys false on missing key', !hJson.hasExactKeys(record!, ['type', 'v', 'ok', 'n', 'list', 'strs', 'zzz']))
    check('hasExactKeys ignores order', hJson.hasExactKeys(record!, ['strs', 'list', 'n', 'ok', 'v', 'type']))

    check('stringListsEqual', hJson.stringListsEqual(['a', 'b'], ['a', 'b']))
    check('stringListsEqual false on order', !hJson.stringListsEqual(['a', 'b'], ['b', 'a']))
    check('numberListsEqual', hJson.numberListsEqual([2], [2]))
    check('numberListsEqual false on value', !hJson.numberListsEqual([2], [3]))
  }

  // ---------------------------------------------------------------------------
  // 8. E2EE v2 framing — cross-implementation
  // ---------------------------------------------------------------------------

  section('8. E2EE v2 framing')

  {
    const key = fixture(32, 31000)
    const sessionId = fixture(32, 31001)
    const directions: MobileE2EEDirection[] = ['mobile-to-desktop', 'desktop-to-mobile']
    const kinds: ('text' | 'binary')[] = ['text', 'binary']
    const counters = [0, 1, 255, 256, 65535, 0x1_0000_0000, 2 ** 40, Number.MAX_SAFE_INTEGER]

    for (const direction of directions) {
      for (const kind of kinds) {
        for (const counter of counters) {
          for (const payloadLength of [0, 1, 42, 200, 4096]) {
            const payload = fixture(payloadLength, 32000 + payloadLength)
            const ours = hFrame.sealE2eeV2Frame({ payload, key, sessionId, direction, payloadKind: kind, counter })
            const reference = sealMobileE2EEV2Frame({
              payload,
              key,
              sessionId,
              direction,
              payloadKind: kind,
              counter: BigInt(counter)
            })
            const label = `${direction}/${kind}/counter=${counter}/len=${payloadLength}`
            check(`seal matches reference ${label}`, equalHex(ours, reference), `${hex(ours)} vs ${hex(reference)}`)

            const openedFromReference = hFrame.openE2eeV2Frame({
              frame: reference,
              key,
              sessionId,
              direction,
              payloadKind: kind,
              expectedCounter: counter
            })
            check(
              `open accepts reference frame ${label}`,
              openedFromReference !== null && equalHex(openedFromReference, payload)
            )

            const referenceOpenedOurs = openMobileE2EEV2Frame({
              frame: ours,
              key,
              sessionId,
              direction,
              payloadKind: kind,
              expectedCounter: BigInt(counter)
            })
            check(
              `reference accepts our frame ${label}`,
              referenceOpenedOurs !== null && equalHex(referenceOpenedOurs, payload)
            )
          }
        }
      }
    }

    {
      const payload = fixture(64, 33000)
      const args = { payload, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', counter: 7 }
      const frame = hFrame.sealE2eeV2Frame(args)
      const reject = (
        label: string,
        mutation: { key?: Uint8Array; sessionId?: Uint8Array; direction?: string; payloadKind?: string; frame?: Uint8Array; expectedCounter?: number }
      ): void => {
        const opened = hFrame.openE2eeV2Frame({
          frame: mutation.frame ?? frame,
          key: mutation.key ?? key,
          sessionId: mutation.sessionId ?? sessionId,
          direction: mutation.direction ?? 'mobile-to-desktop',
          payloadKind: mutation.payloadKind ?? 'text',
          expectedCounter: mutation.expectedCounter ?? 7
        })
        check(`open rejects ${label}`, opened === null)
      }
      reject('wrong counter', { expectedCounter: 8 })
      reject('wrong direction', { direction: 'desktop-to-mobile' })
      reject('wrong payload kind', { payloadKind: 'binary' })
      reject('wrong session id', { sessionId: fixture(32, 33001) })
      reject('wrong key', { key: fixture(32, 33002) })
      reject('truncated frame', { frame: frame.subarray(0, 30) })
      reject('zero-length frame', { frame: new Uint8Array(0) })
      reject('bit-flipped frame', {
        frame: (() => {
          const copy = Uint8Array.from(frame)
          copy[copy.length - 1] ^= 0x01
          return copy
        })()
      })

      const malformed: [string, typeof args][] = [
        ['a short key', { ...args, key: new Uint8Array(31) }],
        ['a short session id', { ...args, sessionId: new Uint8Array(31) }],
        ['a fractional counter', { ...args, counter: 1.5 }],
        ['a negative counter', { ...args, counter: -1 }],
        ['an unsafe counter', { ...args, counter: 2 ** 53 }]
      ]
      for (const [label, bad] of malformed) {
        check(
          `seal rejects ${label}`,
          (() => {
            try {
              hFrame.sealE2eeV2Frame(bad)
              return false
            } catch {
              return true
            }
          })()
        )
      }
    }

    // Header/nonce layout is parsed by offset on the desktop, so it is frozen.
    {
      const args = { key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'binary', counter: 0x0001020304050607 }
      const header = hFrame.encodeHeader(args)
      check('header length is 42', header.length === 42)
      check('header session id prefix', equalHex(header.subarray(0, 32), sessionId))
      check('header direction byte', header[32] === 0)
      check('header payload-kind byte', header[33] === 1)
      check('header counter is big-endian', hex(header.subarray(34, 42)) === '0001020304050607')

      const nonce = hFrame.encodeNonce(args)
      check('nonce length is 24', nonce.length === 24)
      check('nonce session id prefix', equalHex(nonce.subarray(0, 12), sessionId.subarray(0, 12)))
      check('nonce version byte', nonce[12] === 2)
      check('nonce direction byte', nonce[13] === 0)
      check('nonce payload-kind byte', nonce[14] === 1)
      check('nonce reserved byte', nonce[15] === 0)
      check('nonce counter is big-endian', hex(nonce.subarray(16, 24)) === '0001020304050607')
    }
  }

  // ---------------------------------------------------------------------------
  // 9. E2EE v2 key schedule
  // ---------------------------------------------------------------------------

  section('9. E2EE v2 key schedule')

  {
    for (let i = 0; i < 8; i++) {
      const sharedSecret = fixture(32, 41000 + i)
      const transcript = fixture(37 + i, 42000 + i)
      const clientNonce = fixture(32, 43000 + i)
      const desktopNonce = fixture(32, 44000 + i)

      const ours = hSchedule.deriveE2eeV2KeySchedule({ sharedSecret, transcript, clientNonce, desktopNonce })
      const reference = deriveMobileE2EEV2KeySchedule({ sharedSecret, transcript, clientNonce, desktopNonce })

      bytesEqualCheck(`schedule.mobileToDesktopKey #${i}`, ours.mobileToDesktopKey, reference.mobileToDesktopKey)
      bytesEqualCheck(`schedule.desktopToMobileKey #${i}`, ours.desktopToMobileKey, reference.desktopToMobileKey)
      bytesEqualCheck(`schedule.sessionId #${i}`, ours.sessionId, reference.sessionId)
      bytesEqualCheck(`schedule.transcriptHash #${i}`, ours.transcriptHash, reference.transcriptHash)
      check(`schedule keys differ #${i}`, !equalHex(ours.mobileToDesktopKey, ours.desktopToMobileKey))
      check(`schedule length #${i}`, ours.sessionId.length === 32 && ours.transcriptHash.length === 32)
    }

    check(
      'schedule rejects a 31-byte shared secret',
      (() => {
        try {
          hSchedule.deriveE2eeV2KeySchedule({
            sharedSecret: new Uint8Array(31),
            transcript: new Uint8Array(1),
            clientNonce: new Uint8Array(32),
            desktopNonce: new Uint8Array(32)
          })
          return false
        } catch {
          return true
        }
      })()
    )
  }
}

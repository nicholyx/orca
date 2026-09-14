/*
 * Interop verification for the HarmonyOS ArkTS E2EE core.
 *
 * The HarmonyOS client is a second implementation of a protocol the desktop and
 * the React Native client already speak. A porting bug here is invisible until a
 * real device fails to pair, so this harness pins every layer against an
 * independent oracle:
 *
 *   - tweetnacl / @noble hashes for the primitives
 *   - the repo's own reference modules for the handshake, transcript and framing
 *
 * Both sides are fed identical vectors and compared byte for byte. esbuild
 * bundles the .ets sources (see run-interop.sh); Node executes the result.
 */
import nacl from 'tweetnacl'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'
import { hmac as nobleHmac } from '@noble/hashes/hmac'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf'

import * as hBytes from '../../entry/src/main/ets/core/bytes/Bytes.ets'
import * as hUtf8 from '../../entry/src/main/ets/core/bytes/Utf8.ets'
import * as hBase64 from '../../entry/src/main/ets/core/bytes/Base64.ets'
import * as hSha from '../../entry/src/main/ets/core/crypto/Sha256.ets'
import * as hHkdf from '../../entry/src/main/ets/core/crypto/Hkdf.ets'
import * as hSecretBox from '../../entry/src/main/ets/core/crypto/SecretBox.ets'
import * as hCurve from '../../entry/src/main/ets/core/crypto/Curve25519.ets'
import * as hBox from '../../entry/src/main/ets/core/crypto/Box.ets'
import { sequenceRandomBytes } from '../../entry/src/main/ets/core/crypto/RandomSource.ets'
import * as hJson from '../../entry/src/main/ets/core/json/JsonValue.ets'
import * as hFrame from '../../entry/src/main/ets/core/e2ee/E2eeV2Framing.ets'
import * as hSchedule from '../../entry/src/main/ets/core/e2ee/E2eeV2KeySchedule.ets'
import * as hContract from '../../entry/src/main/ets/core/e2ee/E2eeV2Contract.ets'
import { E2eeV2ClientSession } from '../../entry/src/main/ets/core/e2ee/E2eeV2ClientSession.ets'

import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame,
  type MobileE2EEDirection
} from '../../../src/shared/mobile-e2ee-v2-framing'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Handshake
} from '../../../src/shared/mobile-e2ee-v2-contract'
import { deriveMobileE2EEV2KeySchedule } from '../../../mobile/src/transport/mobile-e2ee-v2-key-schedule'

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let assertions = 0
let failures = 0
const failedChecks: string[] = []

function check(name: string, condition: boolean, detail?: string): void {
  assertions++
  if (condition) return
  failures++
  failedChecks.push(name)
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function equalHex(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

function bytesEqualCheck(label: string, actual: Uint8Array | null, expected: Uint8Array): void {
  if (actual === null) {
    check(label, false, 'got null')
    return
  }
  const same = equalHex(actual, expected)
  check(label, same, same ? undefined : `got ${hex(actual)} want ${hex(expected)}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** Deterministic byte stream so both implementations see the same input. */
function fixture(length: number, seed: number): Uint8Array {
  let state = seed >>> 0
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out[i] = state & 0xff
  }
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ---------------------------------------------------------------------------
// 1. Byte helpers
// ---------------------------------------------------------------------------

section('1. byte helpers')

{
  const parts = [fixture(7, 11), fixture(0, 12), fixture(33, 13)]
  const expected = Buffer.concat(parts.map((p) => Buffer.from(p)))
  bytesEqualCheck('concatBytes matches Buffer.concat', hBytes.concatBytes(parts), expected)

  const source = fixture(40, 21)
  bytesEqualCheck('copyOf is a detached copy', hBytes.copyOf(source), source)
  check(
    'copyOf does not alias the source',
    (() => {
      const copy = hBytes.copyOf(source)
      copy[0] = (copy[0] + 1) & 0xff
      return copy[0] !== source[0]
    })()
  )
  check('equalBytes true for identical', hBytes.equalBytes(source, hBytes.copyOf(source)))
  check('equalBytes false on length mismatch', !hBytes.equalBytes(source, source.subarray(1)))
  check('isAllZero', hCurve.isAllZero(new Uint8Array(32)) && !hCurve.isAllZero(source.subarray(0, 32)))

  const buf = new Uint8Array(8)
  hBytes.writeUint32BE(buf, 0, 0xdeadbeef)
  hBytes.writeUint32BE(buf, 4, 1)
  check('writeUint32BE matches DataView', hex(buf) === 'deadbeef00000001', hex(buf))

  const buf64 = new Uint8Array(8)
  // The counter is a JS number, so the ceiling is 2^53 - 1, not 2^64 - 1.
  for (const value of [0, 1, 255, 256, 65535, 0x100000000, 2 ** 52, Number.MAX_SAFE_INTEGER]) {
    hBytes.writeUint64BE(buf64, 0, value)
    const view = new DataView(buf64.buffer)
    check(
      `writeUint64BE(${value}) matches BigInt`,
      view.getBigUint64(0) === BigInt(value),
      `${view.getBigUint64(0)} vs ${value}`
    )
    check(`readUint64BE(${value}) round-trips`, hBytes.readUint64BE(buf64, 0) === value)
  }
  check(
    'writeUint64BE rejects unsafe integers',
    (() => {
      try {
        hBytes.writeUint64BE(buf64, 0, 2 ** 53)
        return false
      } catch {
        return true
      }
    })()
  )

  const view32 = new Uint8Array([0x01, 0x02, 0x03, 0x04])
  check('readUint32LE', hBytes.readUint32LE(view32, 0) === 0x04030201)
  check('readUint16LE', hBytes.readUint16LE(view32, 0) === 0x0201)
  check('combineUint32Pair', hBytes.combineUint32Pair(0x0000_0001, 0xffff_ffff) === 0x0001_ffff_ffff)

  for (const seed of [1, 2, 3]) {
    const bytes = fixture(37, seed)
    bytesEqualCheck(`toHex/fromHex round-trip (seed ${seed})`, hBytes.fromHex(hBytes.toHex(bytes)), bytes)
  }
  check('fromHex rejects odd length', hBytes.fromHex('abc') === null)
  check('fromHex rejects non-hex', hBytes.fromHex('zz') === null)
  check('fromHex accepts empty', hBytes.fromHex('') !== null && hBytes.fromHex('')!.length === 0)
}

// ---------------------------------------------------------------------------
// 2. UTF-8
// ---------------------------------------------------------------------------

section('2. UTF-8')

{
  const samples = [
    '',
    'ascii only',
    'orca://pair?code=AbCd-_1234',
    '中文测试：鸿蒙客户端',
    'emoji 🐋🔐 and mixed 汉字',
    '\u0000\u0001\u007f',
    '\u0080\u07ff\u0800\uffff',
    '𝅘𝅥𝅮',
    '\ud800',
    '\udfff',
    'trailing\ud83d',
    'inter\ud83dstitial',
    'reversed \ud83d\ude00 pair'
  ]
  for (const sample of samples) {
    const label = sample.length > 20 ? `${sample.slice(0, 20)}…` : sample
    bytesEqualCheck(
      `encodeUtf8(${JSON.stringify(label)}) matches TextEncoder`,
      hUtf8.encodeUtf8(sample),
      encoder.encode(sample)
    )
    const encoded = encoder.encode(sample)
    check(
      `decodeUtf8(${JSON.stringify(label)}) matches TextDecoder`,
      hUtf8.decodeUtf8(encoded) === decoder.decode(encoded),
      `${JSON.stringify(hUtf8.decodeUtf8(encoded))} vs ${JSON.stringify(decoder.decode(encoded))}`
    )
  }

  // Every BMP code point, as one long string, to catch table gaps.
  let sweep = ''
  for (let cp = 0; cp <= 0xffff; cp++) sweep += String.fromCharCode(cp)
  const swept = encoder.encode(sweep)
  bytesEqualCheck('encodeUtf8 full BMP sweep', hUtf8.encodeUtf8(sweep), swept)
  check('decodeUtf8 full BMP sweep', hUtf8.decodeUtf8(swept) === decoder.decode(swept))
}

// ---------------------------------------------------------------------------
// 3. base64
// ---------------------------------------------------------------------------

section('3. base64')

{
  for (let length = 0; length <= 70; length++) {
    const bytes = fixture(length, 100 + length)
    const expected = Buffer.from(bytes).toString('base64')
    check(`encodeBase64 length ${length}`, hBase64.encodeBase64(bytes) === expected)
    bytesEqualCheck(`decodeBase64 length ${length}`, hBase64.decodeBase64(expected), bytes)
    bytesEqualCheck(`decodeCanonicalBase64 length ${length}`, hBase64.decodeCanonicalBase64(expected), bytes)
    bytesEqualCheck(
      `decodeCanonicalBase64Bytes length ${length}`,
      hBase64.decodeCanonicalBase64Bytes(expected, length),
      bytes
    )
  }

  const bytes32 = fixture(32, 777)
  const std = Buffer.from(bytes32).toString('base64')
  const url = Buffer.from(bytes32).toString('base64url')
  check('encodeBase64Url matches Buffer base64url', hBase64.encodeBase64Url(bytes32) === url)
  bytesEqualCheck('decodeBase64Url round-trip', hBase64.decodeBase64Url(url), bytes32)

  // The canonical decoder guards key material, so it must be strict.
  check('decodeCanonicalBase64 rejects wrong length', hBase64.decodeCanonicalBase64Bytes(std, 31) === null)
  check('decodeCanonicalBase64 rejects illegal char', hBase64.decodeCanonicalBase64('AA*=') === null)
  {
    const urlOnly = Buffer.from(fixture(48, 778)).toString('base64url')
    const stdEquivalent = Buffer.from(fixture(48, 778)).toString('base64')
    if (urlOnly !== stdEquivalent) {
      check('decodeCanonicalBase64 rejects url-safe alphabet', hBase64.decodeCanonicalBase64(urlOnly) === null)
    }
  }

  // The pairing code is variable-length, accepts both base64 alphabets, and
  // permits at most two trailing '=' — mirroring `src/shared/pairing.ts`.
  const pairingBodyPattern = new RegExp('^[A-Za-z0-9+/_-]+={0,2}$')
  const pairingCorpus = [
    'A',
    'AbCd-_0123456789',
    'AbCd+/0123456789',
    'AbCd-_012345678',
    'AbCd-_0123456789x',
    'AbCd-_0123456789==',
    'AbCd-_0123456789===',
    'AbCd-_0123456789=',
    '=AbCd',
    'AbCd=12',
    'Ab Cd',
    'Ab*Cd',
    'Ab.Cd',
    '',
    'orça',
    'AB=='
  ]
  for (const sample of pairingCorpus) {
    const ours = hBase64.isPairingCodeAlphabet(sample)
    const reference = pairingBodyPattern.test(sample)
    check(
      `isPairingCodeAlphabet(${JSON.stringify(sample)}) matches the reference pattern`,
      ours === reference,
      `ours=${ours} reference=${reference}`
    )
  }
}

// ---------------------------------------------------------------------------
// 4. SHA-256 / HMAC / HKDF
// ---------------------------------------------------------------------------

section('4. SHA-256 / HMAC / HKDF')

{
  for (const length of [0, 1, 31, 32, 55, 56, 57, 63, 64, 65, 100, 119, 120, 127, 128, 200, 1000]) {
    const message = fixture(length, 300 + length)
    bytesEqualCheck(`sha256 length ${length}`, hSha.sha256(message), nobleSha256(message))
  }
  for (const keyLength of [0, 1, 32, 63, 64, 65, 200]) {
    for (const msgLength of [0, 1, 64, 200]) {
      const key = fixture(keyLength, 500 + keyLength)
      const message = fixture(msgLength, 600 + msgLength)
      bytesEqualCheck(
        `hmacSha256 key ${keyLength} msg ${msgLength}`,
        hSha.hmacSha256(key, message),
        nobleHmac(nobleSha256, key, message)
      )
    }
  }

  {
    const ikm = fixture(32, 900)
    const salt = fixture(32, 901)
    const info = fixture(48, 902)
    // hkdfExtract is RFC 5869's extract step, i.e. HMAC(salt, ikm) — not the
    // one-shot hkdf(), which also expands.
    bytesEqualCheck('hkdfExtract', hHkdf.hkdfExtract(salt, ikm), nobleHmac(nobleSha256, salt, ikm))

    const prk = hHkdf.hkdfExtract(salt, ikm)
    bytesEqualCheck('hkdfExpand 96 bytes', hHkdf.hkdfExpand(prk, info, 96), nobleHkdf(nobleSha256, ikm, salt, info, 96))
    bytesEqualCheck('hkdf one-shot 96 bytes', hHkdf.hkdf(ikm, salt, info, 96), nobleHkdf(nobleSha256, ikm, salt, info, 96))
    bytesEqualCheck('hkdf one-shot 32 bytes', hHkdf.hkdf(ikm, salt, info, 32), nobleHkdf(nobleSha256, ikm, salt, info, 32))
    bytesEqualCheck(
      'hkdf handles empty info',
      hHkdf.hkdf(ikm, salt, new Uint8Array(0), 64),
      nobleHkdf(nobleSha256, ikm, salt, new Uint8Array(0), 64)
    )
    bytesEqualCheck(
      'hkdfExtract tolerates an empty salt',
      hHkdf.hkdfExtract(new Uint8Array(0), ikm),
      nobleHmac(nobleSha256, new Uint8Array(0), ikm)
    )
    check(
      'hkdfExpand rejects over-long output',
      (() => {
        try {
          hHkdf.hkdfExpand(prk, info, 255 * 32 + 1)
          return false
        } catch {
          return true
        }
      })()
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Curve25519
// ---------------------------------------------------------------------------

section('5. Curve25519')

{
  for (let i = 0; i < 12; i++) {
    const secret = fixture(32, 1000 + i)
    const peerSecret = fixture(32, 2000 + i)
    const peerPublic = nacl.scalarMult.base(peerSecret)

    bytesEqualCheck(`scalarMultBase #${i}`, hCurve.scalarMultBase(secret), nacl.scalarMult.base(secret))
    bytesEqualCheck(`scalarMult #${i}`, hCurve.scalarMult(secret, peerPublic), nacl.scalarMult(secret, peerPublic))

    const ours = hCurve.scalarMult(secret, nacl.scalarMult.base(peerSecret))
    const theirs = hCurve.scalarMult(peerSecret, hCurve.scalarMultBase(secret))
    bytesEqualCheck(`DH symmetry #${i}`, ours, theirs)
  }

  // tweetnacl clamps the scalar, so low-entropy keys must match too.
  const edgeKeys = [
    new Uint8Array(32),
    (() => {
      const k = new Uint8Array(32)
      k.fill(0xff)
      return k
    })(),
    (() => {
      const k = new Uint8Array(32)
      k[0] = 1
      return k
    })()
  ]
  for (let i = 0; i < edgeKeys.length; i++) {
    bytesEqualCheck(
      `scalarMultBase edge key #${i}`,
      hCurve.scalarMultBase(edgeKeys[i]),
      nacl.scalarMult.base(edgeKeys[i])
    )
  }

  // BASE_POINT_9 is the raw curve base point (u = 9), not a clamped scalar
  // multiple of it — scalarMultBase clamps, so it cannot be used as the oracle.
  check(
    'BASE_POINT_9 encodes u = 9',
    hCurve.BASE_POINT_9[0] === 9 && hCurve.BASE_POINT_9.subarray(1).every((byte) => byte === 0)
  )
  check('ZERO_32 is 32 zero bytes', hCurve.ZERO_32.length === 32 && hCurve.isAllZero(hCurve.ZERO_32))
  check(
    'scalarMult of a low-order point is all zero',
    (() => {
      const lowOrder = new Uint8Array(32)
      lowOrder[0] = 1
      return hCurve.isAllZero(hCurve.scalarMult(fixture(32, 7), lowOrder))
    })()
  )
}

// ---------------------------------------------------------------------------
// 6. Poly1305 / secretbox / box
// ---------------------------------------------------------------------------

section('6. Poly1305 / secretbox / box')

{
  for (const length of [0, 1, 2, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 500, 1000]) {
    const message = fixture(length, 3000 + length)
    const nonce = fixture(24, 4000 + length)
    const key = fixture(32, 5000 + length)

    bytesEqualCheck(`secretbox length ${length}`, hSecretBox.secretbox(message, nonce, key), nacl.secretbox(message, nonce, key))

    const sealed = nacl.secretbox(message, nonce, key)
    bytesEqualCheck(`secretboxOpen length ${length}`, hSecretBox.secretboxOpen(sealed, nonce, key), message)

    const tampered = Uint8Array.from(sealed)
    tampered[tampered.length - 1] ^= 0x01
    check(`secretboxOpen rejects tampered tag length ${length}`, hSecretBox.secretboxOpen(tampered, nonce, key) === null)

    const flipped = Uint8Array.from(sealed)
    flipped[0] ^= 0x80
    check(`secretboxOpen rejects tampered ciphertext length ${length}`, hSecretBox.secretboxOpen(flipped, nonce, key) === null)

    check(`secretboxOpen rejects truncated length ${length}`, hSecretBox.secretboxOpen(sealed.subarray(0, 15), nonce, key) === null)
    check(
      `secretboxOpen rejects wrong nonce length ${length}`,
      hSecretBox.secretboxOpen(sealed, fixture(24, 6000 + length), key) === null
    )
  }

  check(
    'secretbox constants',
    hSecretBox.SECRETBOX_KEY_BYTES === 32 &&
      hSecretBox.SECRETBOX_NONCE_BYTES === 24 &&
      hSecretBox.SECRETBOX_TAG_BYTES === 16
  )

  for (let i = 0; i < 8; i++) {
    const aSecret = fixture(32, 7000 + i)
    const bSecret = fixture(32, 8000 + i)
    const aPublic = nacl.scalarMult.base(aSecret)
    const bPublic = nacl.scalarMult.base(bSecret)

    bytesEqualCheck(`boxBefore #${i} matches tweetnacl`, hBox.boxBefore(aSecret, bPublic), nacl.box.before(bPublic, aSecret))
    bytesEqualCheck(`boxBefore symmetric #${i}`, hBox.boxBefore(aSecret, bPublic), hBox.boxBefore(bSecret, aPublic))

    const nonce = fixture(24, 9000 + i)
    const payload = fixture(100 + i, 9500 + i)
    const shared = hBox.boxBefore(aSecret, bPublic)
    bytesEqualCheck(`boxAfter #${i} matches nacl.box.after`, hBox.boxAfter(payload, nonce, shared), nacl.box.after(payload, nonce, shared))
    bytesEqualCheck(
      `boxOpenAfter #${i} round-trip`,
      hBox.boxOpenAfter(hBox.boxAfter(payload, nonce, shared), nonce, shared),
      payload
    )
    check(
      `boxOpenAfter #${i} rejects wrong key`,
      hBox.boxOpenAfter(
        hBox.boxAfter(payload, nonce, shared),
        nonce,
        hBox.boxBefore(aSecret, nacl.scalarMult.base(fixture(32, 11111)))
      ) === null
    )
  }

  {
    const secret = fixture(32, 12345)
    const pair = hBox.boxKeyPair(() => Uint8Array.from(secret))
    const expected = nacl.box.keyPair.fromSecretKey(secret)
    bytesEqualCheck('boxKeyPair secretKey passthrough', pair.secretKey, expected.secretKey)
    bytesEqualCheck('boxKeyPair publicKey matches nacl', pair.publicKey, expected.publicKey)
    check('boxKeyPair public key length', pair.publicKey.length === 32)
  }

  {
    const first = sequenceRandomBytes(4242)
    const second = sequenceRandomBytes(4242)
    bytesEqualCheck('sequenceRandomBytes is deterministic', first(64), second(64))
    const whole = sequenceRandomBytes(1)(8)
    const split = sequenceRandomBytes(1)
    const head = split(3)
    const tail = split(5)
    bytesEqualCheck('sequenceRandomBytes continues across calls', head, whole.subarray(0, 3))
    bytesEqualCheck('sequenceRandomBytes split tail', tail, whole.subarray(3, 8))
  }
}

// ---------------------------------------------------------------------------
// 7. JSON helpers
// ---------------------------------------------------------------------------

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
  const kinds = ['text', 'binary']
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
            payloadKind: kind as 'text' | 'binary',
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
            payloadKind: kind as 'text' | 'binary',
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

    for (const [label, bad] of [
      ['a short key', { ...args, key: new Uint8Array(31) }],
      ['a short session id', { ...args, sessionId: new Uint8Array(31) }],
      ['a fractional counter', { ...args, counter: 1.5 }],
      ['a negative counter', { ...args, counter: -1 }],
      ['an unsafe counter', { ...args, counter: 2 ** 53 }]
    ] as [string, typeof args][]) {
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

// ---------------------------------------------------------------------------
// 10. Handshake contract
// ---------------------------------------------------------------------------

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
    const ours = hContract.validateReady(hello, candidate as Object)
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

// ---------------------------------------------------------------------------
// 11. End-to-end client session
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(64)}`)
if (failures === 0) {
  console.log(`PASS  ${assertions} assertions across 11 layers — the ArkTS core is byte-compatible.`)
} else {
  console.error(`FAIL  ${failures} of ${assertions} assertions failed:`)
  for (const name of failedChecks.slice(0, 40)) console.error(`  · ${name}`)
  if (failedChecks.length > 40) console.error(`  … and ${failedChecks.length - 40} more`)
}
process.exit(failures === 0 ? 0 : 1)

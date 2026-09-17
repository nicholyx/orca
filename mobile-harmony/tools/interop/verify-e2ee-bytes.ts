/*
 * Byte helpers, UTF-8 and base64 — the encodings every frame is built on.
 *
 * Split out of `verify-interop.ts`; the entry point runs every module, so all
 * assertions still report through one counter and one summary.
 */
import { check, section, bytesEqualCheck, fixture, hex } from './harness'
import * as hBytes from '../../entry/src/main/ets/core/bytes/Bytes.ets'
import * as hUtf8 from '../../entry/src/main/ets/core/bytes/Utf8.ets'
import * as hBase64 from '../../entry/src/main/ets/core/bytes/Base64.ets'
import * as hCurve from '../../entry/src/main/ets/core/crypto/Curve25519.ets'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function runByteSections(): void {
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
    for (let cp = 0; cp <= 0xffff; cp++) {sweep += String.fromCharCode(cp)}
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
}

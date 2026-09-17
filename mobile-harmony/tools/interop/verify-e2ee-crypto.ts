/*
 * SHA-256 / HMAC / HKDF, Curve25519, Poly1305 and the secretbox/box wrappers,
 * each compared against tweetnacl and @noble/hashes on identical input.
 *
 * Split out of `verify-interop.ts`; the entry point runs every module, so all
 * assertions still report through one counter and one summary.
 */
import { check, section, bytesEqualCheck, fixture } from './harness'
import nacl from 'tweetnacl'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'
import { hmac as nobleHmac } from '@noble/hashes/hmac'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf'

import * as hSha from '../../entry/src/main/ets/core/crypto/Sha256.ets'
import * as hHkdf from '../../entry/src/main/ets/core/crypto/Hkdf.ets'
import * as hSecretBox from '../../entry/src/main/ets/core/crypto/SecretBox.ets'
import * as hCurve from '../../entry/src/main/ets/core/crypto/Curve25519.ets'
import * as hBox from '../../entry/src/main/ets/core/crypto/Box.ets'
import { sequenceRandomBytes } from '../../entry/src/main/ets/core/crypto/RandomSource.ets'

export function runCryptoSections(): void {
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
}

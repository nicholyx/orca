/*
 * NaCl `box`: Curve25519-XSalsa20-Poly1305, matching `nacl.box.before` /
 * `nacl.box.after` / `nacl.box.open.after` from tweetnacl.
 *
 * E2EE v2 uses the raw `before`/`after` pair rather than the one-shot `box`:
 * the shared key is derived once per socket and reused for every frame, which is
 * what makes the transcript-bound handshake cheap.
 */
import { RandomBytes } from './RandomSource';
import { coreHSalsa20, SIGMA } from './Salsa20';
import { scalarMult, scalarMultBase, ZERO_32 } from './Curve25519';
import { secretbox, secretboxOpen } from './SecretBox';

export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const BOX_PUBLIC_KEY_BYTES = 32;
export const BOX_SECRET_KEY_BYTES = 32;
export const BOX_SHARED_KEY_BYTES = 32;

/** Fresh Curve25519 key pair, mirroring `nacl.box.keyPair()`. */
export function boxKeyPair(random: RandomBytes): BoxKeyPair {
  const secretKey = random(BOX_SECRET_KEY_BYTES);
  const publicKey = scalarMultBase(secretKey);
  return { publicKey, secretKey };
}

/**
 * Derives the 32-byte shared key from our secret key and the peer's public key:
 * Curve25519 scalar multiplication followed by HSalsa20 with a zero nonce.
 * Matches `crypto_box_beforenm`.
 */
export function boxBefore(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  const sharedPoint = scalarMult(ourSecretKey, peerPublicKey);
  const sharedKey = new Uint8Array(BOX_SHARED_KEY_BYTES);
  coreHSalsa20(sharedKey, ZERO_32, sharedPoint, SIGMA);
  return sharedKey;
}

/** Authenticated encryption under a precomputed shared key (`crypto_box_afternm`). */
export function boxAfter(
  plaintext: Uint8Array,
  nonce: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  return secretbox(plaintext, nonce, sharedKey);
}

/** Authenticated decryption; null when the tag does not verify. */
export function boxOpenAfter(
  box: Uint8Array,
  nonce: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array | null {
  return secretboxOpen(box, nonce, sharedKey);
}

/*
 * NaCl `secretbox`: XSalsa20-Poly1305 authenticated encryption.
 *
 * Layout matches tweetnacl's high-level `nacl.secretbox` — the 16-byte tag is
 * prepended to the ciphertext, and the Poly1305 one-time key is the first 32
 * bytes of the XSalsa20 keystream.
 *
 * Used by E2EE v2 framing (see core/e2ee/E2eeV2Framing.ets).
 */
import { concatBytes, equalBytes } from '../bytes/Bytes';
import { poly1305 } from './Poly1305';
import { streamXSalsa20 } from './Salsa20';

export const SECRETBOX_KEY_BYTES = 32;
export const SECRETBOX_NONCE_BYTES = 24;
export const SECRETBOX_TAG_BYTES = 16;
export const SECRETBOX_ZERO_BYTES = 32;

/** Returns tag(16) || ciphertext(message.length). */
export function secretbox(
  message: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Uint8Array {
  if (nonce.length !== SECRETBOX_NONCE_BYTES) {
    throw new Error(`secretbox: nonce must be ${SECRETBOX_NONCE_BYTES} bytes`);
  }
  if (key.length !== SECRETBOX_KEY_BYTES) {
    throw new Error(`secretbox: key must be ${SECRETBOX_KEY_BYTES} bytes`);
  }
  const keystream = streamXSalsa20(SECRETBOX_ZERO_BYTES + message.length, nonce, key);
  const ciphertext = new Uint8Array(message.length);
  for (let index = 0; index < message.length; index++) {
    ciphertext[index] = message[index] ^ keystream[SECRETBOX_ZERO_BYTES + index];
  }
  const tag = poly1305(ciphertext, keystream.subarray(0, SECRETBOX_ZERO_BYTES));
  return concatBytes([tag, ciphertext]);
}

/** Returns the plaintext, or null when the tag does not verify. */
export function secretboxOpen(
  box: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): Uint8Array | null {
  if (box.length < SECRETBOX_TAG_BYTES) {
    return null;
  }
  if (nonce.length !== SECRETBOX_NONCE_BYTES || key.length !== SECRETBOX_KEY_BYTES) {
    return null;
  }
  const tag = box.subarray(0, SECRETBOX_TAG_BYTES);
  const ciphertext = box.subarray(SECRETBOX_TAG_BYTES);
  const keystream = streamXSalsa20(SECRETBOX_ZERO_BYTES + ciphertext.length, nonce, key);
  const expected = poly1305(ciphertext, keystream.subarray(0, SECRETBOX_ZERO_BYTES));
  if (!equalBytes(tag, expected)) {
    return null;
  }
  const message = new Uint8Array(ciphertext.length);
  for (let index = 0; index < ciphertext.length; index++) {
    message[index] = ciphertext[index] ^ keystream[SECRETBOX_ZERO_BYTES + index];
  }
  return message;
}

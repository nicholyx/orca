/*
 * HKDF-SHA256 (RFC 5869), matching @noble/hashes' `hkdf(sha256, ikm, salt, info, l)`.
 *
 * The E2EE v2 key schedule derives 96 bytes: two directional keys and a session id.
 */
import { concatBytes } from '../bytes/Bytes';
import { hmacSha256 } from './Sha256';

const HASH_BYTES = 32;

export function hkdfExtract(salt: Uint8Array, inputKeyMaterial: Uint8Array): Uint8Array {
  return hmacSha256(salt, inputKeyMaterial);
}

export function hkdfExpand(
  pseudoRandomKey: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  if (length > 255 * HASH_BYTES) {
    throw new Error(`hkdfExpand: requested length too large: ${length}`);
  }
  const blocks: Uint8Array[] = [];
  let previous = new Uint8Array(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    const input = concatBytes([previous, info, new Uint8Array([counter])]);
    previous = hmacSha256(pseudoRandomKey, input);
    blocks.push(previous);
    produced += previous.length;
    counter++;
  }
  const expanded = concatBytes(blocks);
  return expanded.slice(0, length);
}

export function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  return hkdfExpand(hkdfExtract(salt, inputKeyMaterial), info, length);
}

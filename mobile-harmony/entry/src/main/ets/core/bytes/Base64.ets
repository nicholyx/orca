/*
 * Base64 / base64url, dependency-free.
 *
 * Mirrors `btoa`/`atob` semantics used by the reference implementation:
 *   - encodeBase64 produces the standard alphabet with padding.
 *   - decodeCanonicalBase64 accepts only canonical spellings (the value must
 *     survive an encode/decode round trip), so a re-spelled frame is rejected
 *     instead of silently accepted.
 *
 * ArkTS bans RegExp literals, so alphabet checks are character scans and the
 * alphabet swaps use split/join.
 */

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PADDING_CODE = 0x3d;
const PLUS_CODE = 0x2b;
const SLASH_CODE = 0x2f;
const MINUS_CODE = 0x2d;
const UNDERSCORE_CODE = 0x5f;

let DECODE_TABLE: Int16Array | null = null;

function decodeTable(): Int16Array {
  if (DECODE_TABLE === null) {
    const table = new Int16Array(128);
    for (let index = 0; index < table.length; index++) {
      table[index] = -1;
    }
    for (let index = 0; index < STANDARD_ALPHABET.length; index++) {
      table[STANDARD_ALPHABET.charCodeAt(index)] = index;
    }
    DECODE_TABLE = table;
  }
  return DECODE_TABLE;
}

function isBase64Code(code: number, allowUrlSafe: boolean): boolean {
  if (code >= 0x41 && code <= 0x5a) {
    return true;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return true;
  }
  if (code >= 0x30 && code <= 0x39) {
    return true;
  }
  if (code === PLUS_CODE || code === SLASH_CODE) {
    return true;
  }
  if (allowUrlSafe && (code === MINUS_CODE || code === UNDERSCORE_CODE)) {
    return true;
  }
  return false;
}

/** Standard base64 with padding — byte-for-byte equal to `btoa(binary)`. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  while (index + 2 < bytes.length) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += STANDARD_ALPHABET[(chunk >> 18) & 0x3f];
    out += STANDARD_ALPHABET[(chunk >> 12) & 0x3f];
    out += STANDARD_ALPHABET[(chunk >> 6) & 0x3f];
    out += STANDARD_ALPHABET[chunk & 0x3f];
    index += 3;
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    out += STANDARD_ALPHABET[(chunk >> 18) & 0x3f];
    out += STANDARD_ALPHABET[(chunk >> 12) & 0x3f];
    out += '==';
  } else if (remaining === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out += STANDARD_ALPHABET[(chunk >> 18) & 0x3f];
    out += STANDARD_ALPHABET[(chunk >> 12) & 0x3f];
    out += STANDARD_ALPHABET[(chunk >> 6) & 0x3f];
    out += '=';
  }
  return out;
}

/**
 * Decodes base64 (and, when `allowUrlSafe`, base64url) tolerating missing
 * padding. Returns null on malformed input instead of throwing.
 */
export function decodeBase64With(value: string, allowUrlSafe: boolean): Uint8Array | null {
  const table = decodeTable();
  let payload = value.length;
  let padding = 0;
  while (payload > 0 && value.charCodeAt(payload - 1) === PADDING_CODE) {
    payload--;
    padding++;
  }
  if (padding > 2) {
    return null;
  }
  for (let index = 0; index < payload; index++) {
    if (!isBase64Code(value.charCodeAt(index), allowUrlSafe)) {
      return null;
    }
  }
  const groups = Math.floor(payload / 4);
  const leftover = payload - groups * 4;
  if (padding > 0 && leftover + padding !== 4) {
    return null;
  }
  if (leftover === 1) {
    return null;
  }
  const out = new Uint8Array(groups * 3 + (leftover === 0 ? 0 : leftover - 1));
  let outIndex = 0;
  for (let group = 0; group < groups; group++) {
    const base = group * 4;
    const a = table[value.charCodeAt(base)];
    const b = table[value.charCodeAt(base + 1)];
    const c = table[value.charCodeAt(base + 2)];
    const d = table[value.charCodeAt(base + 3)];
    out[outIndex] = ((a << 2) | (b >> 4)) & 0xff;
    out[outIndex + 1] = (((b & 0x0f) << 4) | (c >> 2)) & 0xff;
    out[outIndex + 2] = (((c & 0x03) << 6) | d) & 0xff;
    outIndex += 3;
  }
  if (leftover === 2) {
    const base = groups * 4;
    const a = table[value.charCodeAt(base)];
    const b = table[value.charCodeAt(base + 1)];
    out[outIndex] = ((a << 2) | (b >> 4)) & 0xff;
  } else if (leftover === 3) {
    const base = groups * 4;
    const a = table[value.charCodeAt(base)];
    const b = table[value.charCodeAt(base + 1)];
    const c = table[value.charCodeAt(base + 2)];
    out[outIndex] = ((a << 2) | (b >> 4)) & 0xff;
    out[outIndex + 1] = (((b & 0x0f) << 4) | (c >> 2)) & 0xff;
  }
  return out;
}

/** Standard-alphabet base64; returns null on malformed input. */
export function decodeBase64(value: string): Uint8Array | null {
  return decodeBase64With(value, false);
}

/**
 * Canonical base64 decode. Equivalent to the reference helper: only the exact
 * standard spelling (correct padding, no stray trailing bits) round-trips, so
 * anything else is rejected.
 */
export function decodeCanonicalBase64(value: string): Uint8Array | null {
  const bytes = decodeBase64(value);
  if (bytes === null) {
    return null;
  }
  return encodeBase64(bytes) === value ? bytes : null;
}

/** Canonical base64 of an exactly-`length`-byte value, or null. */
export function decodeCanonicalBase64Bytes(value: string, length: number): Uint8Array | null {
  if (value.length !== Math.ceil(length / 3) * 4) {
    return null;
  }
  const bytes = decodeCanonicalBase64(value);
  if (bytes === null || bytes.length !== length) {
    return null;
  }
  return bytes;
}

/** Encodes to the URL-safe, unpadded alphabet used by pairing codes. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let value = encodeBase64(bytes).split('+').join('-').split('/').join('_');
  while (value.length > 0 && value.charCodeAt(value.length - 1) === PADDING_CODE) {
    value = value.substring(0, value.length - 1);
  }
  return value;
}

/** Decodes the URL-safe alphabet, tolerating missing padding. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }
  return decodeBase64With(value.split('-').join('+').split('_').join('/'), true);
}

/** Shape test for the pairing payload alphabet: base64url with optional padding. */
export function isPairingCodeAlphabet(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  let body = value.length;
  let padding = 0;
  while (body > 0 && value.charCodeAt(body - 1) === PADDING_CODE) {
    body--;
    padding++;
  }
  if (padding > 2) {
    return false;
  }
  for (let index = 0; index < body; index++) {
    if (!isBase64Code(value.charCodeAt(index), true)) {
      return false;
    }
  }
  return true;
}

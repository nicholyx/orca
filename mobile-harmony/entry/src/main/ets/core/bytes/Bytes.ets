/*
 * Byte-level helpers shared by the crypto and framing layers.
 *
 * Dependency-free on purpose: everything under core/ compiles as plain
 * TypeScript, so the Node interop harness in tools/ can execute the exact same
 * source and compare it against the reference implementation in mobile/.
 */

/** Concatenates byte arrays into one new array. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (let index = 0; index < parts.length; index++) {
    total += parts[index].length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Copies into a fresh Uint8Array with the canonical prototype. */
export function copyOf(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  out.set(source);
  return out;
}

/** Constant-time-ish equality; mirrors the reference `equalBytes`. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/** Big-endian uint32 write, matching `DataView.setUint32(offset, value, false)`. */
export function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/**
 * Big-endian uint64 write.
 *
 * The reference uses `BigInt`; frame counters never approach 2^53 in a real
 * session, so a double carries the same bytes and keeps the hot path free of
 * BigInt allocation. Values above Number.MAX_SAFE_INTEGER are rejected rather
 * than silently truncated.
 */
export function writeUint64BE(target: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > Number.MAX_SAFE_INTEGER || Math.floor(value) !== value) {
    throw new Error(`writeUint64BE: value out of range: ${value}`);
  }
  let remaining = value;
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}

/** Reads a big-endian uint64 as a double (exact below 2^53). */
export function readUint64BE(source: Uint8Array, offset: number): number {
  let value = 0;
  for (let index = 0; index < 8; index++) {
    value = value * 256 + source[offset + index];
  }
  return value;
}

/** Reads a little-endian uint32. */
export function readUint32LE(source: Uint8Array, offset: number): number {
  return (
    (source[offset] |
      (source[offset + 1] << 8) |
      (source[offset + 2] << 16) |
      (source[offset + 3] << 24)) >>>
    0
  );
}

/** Reads a little-endian uint16. */
export function readUint16LE(source: Uint8Array, offset: number): number {
  return source[offset] | (source[offset + 1] << 8);
}

/** Lowercase hex, used by tests and the pairing fingerprint display. */
export function toHex(source: Uint8Array): string {
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const byte = source[index];
    out += byte < 16 ? `0${byte.toString(16)}` : byte.toString(16);
  }
  return out;
}

/** Parses hex (either case); returns null on any malformed input. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    const high = hexDigit(hex.charCodeAt(index * 2));
    const low = hexDigit(hex.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) {
      return null;
    }
    out[index] = (high << 4) | low;
  }
  return out;
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  return -1;
}

/**
 * Recombines the high/low 32-bit halves of a 64-bit value.
 * Used by the terminal stream header, whose `seq` is split that way.
 */
export function combineUint32Pair(high: number, low: number): number {
  return high * 0x100000000 + low;
}

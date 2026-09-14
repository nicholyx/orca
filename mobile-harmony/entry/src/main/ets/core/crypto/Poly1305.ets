/*
 * Poly1305 one-time authenticator (RFC 8439 §2.5).
 *
 * Radix-2^13 limbs with 10 limbs, so the 2^130 = 5 (mod p) reduction folds
 * limb k >= 10 back into limb k-10 with a factor of 5, exactly as the reference
 * implementations do. 2^13 limbs keep every intermediate product far below
 * 2^53, which is what makes this safe in a runtime without 64-bit integers.
 *
 * Verified against tweetnacl by tools/verify-e2ee-interop.mjs.
 */

const MASK13 = 0x1fff;
const RADIX_BITS = 13;
const RADIX = 8192;
const LIMBS = 10;

/** Extracts 10 radix-2^13 limbs from a little-endian byte string. */
function limbsFromBytes(bytes: Uint8Array): Uint16Array {
  const limbs = new Uint16Array(LIMBS);
  let accumulator = 0;
  let accumulatorBits = 0;
  let index = 0;
  for (let limb = 0; limb < LIMBS; limb++) {
    while (accumulatorBits < RADIX_BITS && index < bytes.length) {
      accumulator |= bytes[index] << accumulatorBits;
      accumulatorBits += 8;
      index++;
    }
    limbs[limb] = accumulator & MASK13;
    accumulator >>>= RADIX_BITS;
    accumulatorBits -= RADIX_BITS;
  }
  return limbs;
}

/** Serializes 10 radix-2^13 limbs back to little-endian bytes (17 bytes max). */
function bytesFromLimbs(limbs: Uint16Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let accumulator = 0;
  let accumulatorBits = 0;
  let outIndex = 0;
  for (let limb = 0; limb < LIMBS; limb++) {
    accumulator |= limbs[limb] << accumulatorBits;
    accumulatorBits += RADIX_BITS;
    while (accumulatorBits >= 8) {
      if (outIndex < length) {
        out[outIndex] = accumulator & 0xff;
      }
      outIndex++;
      accumulator >>>= 8;
      accumulatorBits -= 8;
    }
  }
  if (accumulatorBits > 0 && outIndex < length) {
    out[outIndex] = accumulator & 0xff;
  }
  return out;
}

/** Clamps the Poly1305 `r` value in place on the 16 raw key bytes. */
function clampR(bytes: Uint8Array): void {
  bytes[3] &= 15;
  bytes[7] &= 15;
  bytes[11] &= 15;
  bytes[15] &= 15;
  bytes[4] &= 252;
  bytes[8] &= 252;
  bytes[12] &= 252;
}

/** h += block (radix-2^13 limb add), with `hibit` set for full 16-byte blocks. */
function addBlock(h: Uint16Array, block: Uint16Array, hibit: number): void {
  h[0] += block[0];
  h[1] += block[1];
  h[2] += block[2];
  h[3] += block[3];
  h[4] += block[4];
  h[5] += block[5];
  h[6] += block[6];
  h[7] += block[7];
  h[8] += block[8];
  h[9] += block[9] | hibit;
}

/** h = (h * r) mod (2^130 - 5), then renormalized to 13-bit limbs. */
function multiplyByR(h: Uint16Array, r: Uint16Array): void {
  const d = new Float64Array(LIMBS);
  for (let i = 0; i < LIMBS; i++) {
    const hi = h[i];
    if (hi === 0) {
      continue;
    }
    for (let j = 0; j < LIMBS; j++) {
      const product = hi * r[j];
      const index = i + j;
      if (index < LIMBS) {
        d[index] += product;
      } else {
        // 2^(13*10) = 2^130 = 5 (mod 2^130 - 5).
        d[index - LIMBS] += 5 * product;
      }
    }
  }

  let carry = 0;
  for (let i = 0; i < LIMBS; i++) {
    const value = d[i] + carry;
    const next = Math.floor(value / RADIX);
    h[i] = value - next * RADIX;
    carry = next;
  }
  // Fold the residual carry out of limb 9 back through limb 0 until it dies;
  // it shrinks by a factor of the radix each pass, so this is at most a few
  // iterations.
  let guard = 0;
  while (carry > 0 && guard < 8) {
    let extra = carry * 5;
    for (let i = 0; i < LIMBS; i++) {
      const value = h[i] + extra;
      const next = Math.floor(value / RADIX);
      h[i] = value - next * RADIX;
      extra = next;
    }
    carry = extra;
    guard++;
  }
}

/**
 * Computes the 16-byte Poly1305 tag of `message` under the 32-byte one-time
 * `key`. Matches `crypto_onetimeauth` in tweetnacl.
 */
export function poly1305(message: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`poly1305: key must be 32 bytes, got ${key.length}`);
  }
  const rBytes = new Uint8Array(16);
  rBytes.set(key.subarray(0, 16));
  clampR(rBytes);

  const r = limbsFromBytes(rBytes);
  const h = new Uint16Array(LIMBS);

  let offset = 0;
  let remaining = message.length;
  while (remaining >= 16) {
    addBlock(h, limbsFromBytes(message.subarray(offset, offset + 16)), 1 << 11);
    multiplyByR(h, r);
    offset += 16;
    remaining -= 16;
  }
  if (remaining > 0) {
    const tail = new Uint8Array(16);
    tail.set(message.subarray(offset, offset + remaining));
    tail[remaining] = 1;
    addBlock(h, limbsFromBytes(tail), 0);
    multiplyByR(h, r);
  }

  // Fully reduce mod (2^130 - 5): h < 2^130, so h >= p exactly when h + 5
  // overflows limb 9.
  const candidate = new Uint16Array(LIMBS);
  candidate.set(h);
  let carry = 5;
  for (let i = 0; i < LIMBS; i++) {
    const value = candidate[i] + carry;
    const next = Math.floor(value / RADIX);
    candidate[i] = value - next * RADIX;
    carry = next;
  }
  if (carry > 0) {
    h.set(candidate);
  }

  const reduced = bytesFromLimbs(h, 17);
  const tag = new Uint8Array(16);
  let addCarry = 0;
  for (let index = 0; index < 16; index++) {
    const value = reduced[index] + key[16 + index] + addCarry;
    tag[index] = value & 0xff;
    addCarry = value >>> 8;
  }
  return tag;
}

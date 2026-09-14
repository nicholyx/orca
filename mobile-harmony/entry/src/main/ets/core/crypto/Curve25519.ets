/*
 * Curve25519 scalar multiplication (X25519), ported from tweetnacl's
 * `crypto_scalarmult` / `crypto_scalarmult_base`.
 *
 * The field arithmetic uses tweetnacl's radix-2^16 limb layout in Float64Array
 * (16 limbs). All intermediate values stay well inside the exact-integer range
 * of a double, which is why the JS implementation works and this port works
 * with it. Verified against tweetnacl by tools/verify-e2ee-interop.mjs.
 */

function gf(): Float64Array {
  return new Float64Array(16);
}

function gfOf(values: number[]): Float64Array {
  const out = gf();
  for (let index = 0; index < values.length; index++) {
    out[index] = values[index];
  }
  return out;
}

/** 121665 = (2^255 - 19 - 1) / 2, as two radix-2^16 limbs. */
const GF_121665: Float64Array = gfOf([0xdb41, 1]);

export const ZERO_32: Uint8Array = new Uint8Array(32);

function makeBasePoint(): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = 9;
  return out;
}

/** The standard Curve25519 base point (u = 9). */
export const BASE_POINT_9: Uint8Array = makeBasePoint();

export function car25519(o: Float64Array): void {
  let carry = 1;
  for (let index = 0; index < 16; index++) {
    const value = o[index] + carry + 65535;
    carry = Math.floor(value / 65536);
    o[index] = value - carry * 65536;
  }
  o[0] += carry - 1 + 37 * (carry - 1);
}

/** Conditional swap of p and q in constant time-ish, mirroring tweetnacl. */
export function sel25519(p: Float64Array, q: Float64Array, swap: number): void {
  const mask = ~(swap - 1);
  for (let index = 0; index < 16; index++) {
    const t = mask & (p[index] ^ q[index]);
    p[index] ^= t;
    q[index] ^= t;
  }
}

export function pack25519(o: Uint8Array, n: Float64Array): void {
  const m = gf();
  const t = gf();
  for (let index = 0; index < 16; index++) {
    t[index] = n[index];
  }
  car25519(t);
  car25519(t);
  car25519(t);
  for (let round = 0; round < 2; round++) {
    m[0] = t[0] - 0xffed;
    for (let index = 1; index < 15; index++) {
      m[index] = t[index] - 0xffff - ((m[index - 1] >> 16) & 1);
      m[index - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    const borrow = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - borrow);
  }
  for (let index = 0; index < 16; index++) {
    o[2 * index] = t[index] & 0xff;
    o[2 * index + 1] = (t[index] >> 8) & 0xff;
  }
}

export function unpack25519(o: Float64Array, n: Uint8Array): void {
  for (let index = 0; index < 16; index++) {
    o[index] = n[2 * index] + (n[2 * index + 1] << 8);
  }
  o[15] &= 0x7fff;
}

export function fieldAdd(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let index = 0; index < 16; index++) {
    o[index] = a[index] + b[index];
  }
}

export function fieldSub(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let index = 0; index < 16; index++) {
    o[index] = a[index] - b[index];
  }
}

/**
 * Field multiply. `o` may alias `a` or `b`: the accumulators are fully built
 * before `o` is written.
 */
export function fieldMul(o: Float64Array, a: Float64Array, b: Float64Array): void {
  const t = new Float64Array(31);
  for (let i = 0; i < 16; i++) {
    const ai = a[i];
    if (ai === 0) {
      continue;
    }
    for (let j = 0; j < 16; j++) {
      t[i + j] += ai * b[j];
    }
  }
  for (let i = 0; i < 15; i++) {
    // 2^256 = 38 (mod 2^255 - 19)
    t[i] += 38 * t[i + 16];
  }
  for (let pass = 0; pass < 2; pass++) {
    let carry = 1;
    for (let i = 0; i < 16; i++) {
      const value = t[i] + carry + 65535;
      carry = Math.floor(value / 65536);
      t[i] = value - carry * 65536;
    }
    t[0] += carry - 1 + 37 * (carry - 1);
  }
  for (let index = 0; index < 16; index++) {
    o[index] = t[index];
  }
}

export function fieldSquare(o: Float64Array, a: Float64Array): void {
  fieldMul(o, a, a);
}

function invert25519(o: Float64Array, i: Float64Array): void {
  const c = gf();
  for (let index = 0; index < 16; index++) {
    c[index] = i[index];
  }
  for (let exponent = 253; exponent >= 0; exponent--) {
    fieldSquare(c, c);
    if (exponent !== 2 && exponent !== 4) {
      fieldMul(c, c, i);
    }
  }
  for (let index = 0; index < 16; index++) {
    o[index] = c[index];
  }
}

/**
 * X25519: multiplies the clamped `secretKey` scalar by the u-coordinate
 * `peerPublicKey`. Returns 32 bytes.
 */
export function scalarMult(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32 || peerPublicKey.length !== 32) {
    throw new Error('scalarMult: key material must be 32 bytes');
  }
  const scalar = new Uint8Array(32);
  for (let index = 0; index < 31; index++) {
    scalar[index] = secretKey[index];
  }
  scalar[31] = (secretKey[31] & 127) | 64;
  scalar[0] &= 248;

  // 80 doubles: u[0..16) plus the four intermediate points a, c, b, d.
  const x = new Float64Array(80);
  unpack25519(x, peerPublicKey);

  const a = gf();
  const b = gf();
  const c = gf();
  const d = gf();
  const e = gf();
  const f = gf();
  for (let index = 0; index < 16; index++) {
    b[index] = x[index];
    a[index] = 0;
    c[index] = 0;
    d[index] = 0;
  }
  a[0] = 1;
  d[0] = 1;
  const xBase = x.subarray(0, 16);

  for (let bit = 254; bit >= 0; bit--) {
    const swap = (scalar[bit >>> 3] >>> (bit & 7)) & 1;
    sel25519(a, b, swap);
    sel25519(c, d, swap);
    fieldAdd(e, a, c);
    fieldSub(a, a, c);
    fieldAdd(c, b, d);
    fieldSub(b, b, d);
    fieldSquare(d, e);
    fieldSquare(f, a);
    fieldMul(a, c, a);
    fieldMul(c, b, e);
    fieldAdd(e, a, c);
    fieldSub(a, a, c);
    fieldSquare(b, a);
    fieldSub(c, d, f);
    fieldMul(a, c, GF_121665);
    fieldAdd(a, a, d);
    fieldMul(c, c, a);
    fieldMul(a, d, f);
    fieldMul(d, b, xBase);
    fieldSquare(b, e);
    sel25519(a, b, swap);
    sel25519(c, d, swap);
  }

  for (let index = 0; index < 16; index++) {
    x[index + 16] = a[index];
    x[index + 32] = c[index];
    x[index + 48] = b[index];
    x[index + 64] = d[index];
  }
  const x32 = x.subarray(32);
  const x16 = x.subarray(16);
  invert25519(x32, x32);
  fieldMul(x16, x16, x32);

  const out = new Uint8Array(32);
  pack25519(out, x16);
  return out;
}

/** X25519 with the standard base point — the public key for a secret key. */
export function scalarMultBase(secretKey: Uint8Array): Uint8Array {
  return scalarMult(secretKey, BASE_POINT_9);
}

/** True for the all-zero output, which marks a low-order public key. */
export function isAllZero(bytes: Uint8Array): boolean {
  let accumulator = 0;
  for (let index = 0; index < bytes.length; index++) {
    accumulator |= bytes[index];
  }
  return accumulator === 0;
}

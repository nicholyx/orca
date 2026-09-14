/*
 * Salsa20 / HSalsa20 / XSalsa20 — the stream cipher behind NaCl's `secretbox`
 * and `box` (Curve25519 + HSalsa20).
 *
 * A direct port of tweetnacl's `core_salsa20`, `core_hsalsa20`,
 * `crypto_stream_salsa20_xor` and `crypto_stream_xsalsa20_xor`, so the keystream
 * is identical to the JS implementation the desktop already speaks.
 *
 * The one non-obvious difference between the two cores: Salsa20 adds the input
 * state back after the rounds (feed-forward) and HSalsa20 does not. Sharing the
 * round function is fine, sharing the output step is not.
 */

/** "expand 32-byte k" */
export const SIGMA: Uint8Array = new Uint8Array([
  101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107
]);

const STATE_WORDS = 16;
const BLOCK_BYTES = 64;
const ROUNDS = 20;

function load32(source: Uint8Array, offset: number): number {
  return (
    (source[offset] |
      (source[offset + 1] << 8) |
      (source[offset + 2] << 16) |
      (source[offset + 3] << 24)) >>>
    0
  );
}

function store32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Builds the shared initial state: constants at 0/5/10/15, key at 1-4 and 11-14,
 * and the 16-byte input block at 6-9.
 */
function loadState(input: Uint8Array, key: Uint8Array, constants: Uint8Array): Int32Array {
  const state = new Int32Array(STATE_WORDS);
  state[0] = load32(constants, 0);
  state[1] = load32(key, 0);
  state[2] = load32(key, 4);
  state[3] = load32(key, 8);
  state[4] = load32(key, 12);
  state[5] = load32(constants, 4);
  state[6] = load32(input, 0);
  state[7] = load32(input, 4);
  state[8] = load32(input, 8);
  state[9] = load32(input, 12);
  state[10] = load32(constants, 8);
  state[11] = load32(key, 16);
  state[12] = load32(key, 20);
  state[13] = load32(key, 24);
  state[14] = load32(key, 28);
  state[15] = load32(constants, 12);
  return state;
}

/** The 20-round Salsa20 permutation, in place. Column round then row round. */
function permute(x: Int32Array): void {
  let u = 0;
  for (let round = 0; round < ROUNDS; round += 2) {
    u = (x[0] + x[12]) | 0;
    x[4] ^= (u << 7) | (u >>> 25);
    u = (x[4] + x[0]) | 0;
    x[8] ^= (u << 9) | (u >>> 23);
    u = (x[8] + x[4]) | 0;
    x[12] ^= (u << 13) | (u >>> 19);
    u = (x[12] + x[8]) | 0;
    x[0] ^= (u << 18) | (u >>> 14);

    u = (x[5] + x[1]) | 0;
    x[9] ^= (u << 7) | (u >>> 25);
    u = (x[9] + x[5]) | 0;
    x[13] ^= (u << 9) | (u >>> 23);
    u = (x[13] + x[9]) | 0;
    x[1] ^= (u << 13) | (u >>> 19);
    u = (x[1] + x[13]) | 0;
    x[5] ^= (u << 18) | (u >>> 14);

    u = (x[10] + x[6]) | 0;
    x[14] ^= (u << 7) | (u >>> 25);
    u = (x[14] + x[10]) | 0;
    x[2] ^= (u << 9) | (u >>> 23);
    u = (x[2] + x[14]) | 0;
    x[6] ^= (u << 13) | (u >>> 19);
    u = (x[6] + x[2]) | 0;
    x[10] ^= (u << 18) | (u >>> 14);

    u = (x[15] + x[11]) | 0;
    x[3] ^= (u << 7) | (u >>> 25);
    u = (x[3] + x[15]) | 0;
    x[7] ^= (u << 9) | (u >>> 23);
    u = (x[7] + x[3]) | 0;
    x[11] ^= (u << 13) | (u >>> 19);
    u = (x[11] + x[7]) | 0;
    x[15] ^= (u << 18) | (u >>> 14);

    u = (x[0] + x[3]) | 0;
    x[1] ^= (u << 7) | (u >>> 25);
    u = (x[1] + x[0]) | 0;
    x[2] ^= (u << 9) | (u >>> 23);
    u = (x[2] + x[1]) | 0;
    x[3] ^= (u << 13) | (u >>> 19);
    u = (x[3] + x[2]) | 0;
    x[0] ^= (u << 18) | (u >>> 14);

    u = (x[5] + x[4]) | 0;
    x[6] ^= (u << 7) | (u >>> 25);
    u = (x[6] + x[5]) | 0;
    x[7] ^= (u << 9) | (u >>> 23);
    u = (x[7] + x[6]) | 0;
    x[4] ^= (u << 13) | (u >>> 19);
    u = (x[4] + x[7]) | 0;
    x[5] ^= (u << 18) | (u >>> 14);

    u = (x[10] + x[9]) | 0;
    x[11] ^= (u << 7) | (u >>> 25);
    u = (x[11] + x[10]) | 0;
    x[8] ^= (u << 9) | (u >>> 23);
    u = (x[8] + x[11]) | 0;
    x[9] ^= (u << 13) | (u >>> 19);
    u = (x[9] + x[8]) | 0;
    x[10] ^= (u << 18) | (u >>> 14);

    u = (x[15] + x[14]) | 0;
    x[12] ^= (u << 7) | (u >>> 25);
    u = (x[12] + x[15]) | 0;
    x[13] ^= (u << 9) | (u >>> 23);
    u = (x[13] + x[12]) | 0;
    x[14] ^= (u << 13) | (u >>> 19);
    u = (x[14] + x[13]) | 0;
    x[15] ^= (u << 18) | (u >>> 14);
  }
}

/** The Salsa20 core: permute, then add the input state back, writing 64 bytes. */
export function coreSalsa20(
  out: Uint8Array,
  input: Uint8Array,
  key: Uint8Array,
  constants: Uint8Array
): void {
  const original = loadState(input, key, constants);
  const x = copyOf32(original);
  permute(x);
  for (let word = 0; word < STATE_WORDS; word++) {
    store32(out, word * 4, (x[word] + original[word]) | 0);
  }
}

/**
 * HSalsa20: the 32-byte subkey derivation.
 *
 * Identical rounds, but no feed-forward, and the output is words
 * (0, 5, 10, 15, 6, 7, 8, 9) rather than the full state.
 */
export function coreHSalsa20(
  out: Uint8Array,
  input: Uint8Array,
  key: Uint8Array,
  constants: Uint8Array
): Uint8Array {
  const x = loadState(input, key, constants);
  permute(x);
  store32(out, 0, x[0]);
  store32(out, 4, x[5]);
  store32(out, 8, x[10]);
  store32(out, 12, x[15]);
  store32(out, 16, x[6]);
  store32(out, 20, x[7]);
  store32(out, 24, x[8]);
  store32(out, 28, x[9]);
  return out.subarray(0, 32);
}

/**
 * Salsa20 keystream XOR with an 8-byte nonce.
 * A null `message` yields the raw keystream, matching
 * `c[cpos+i] = (m ? m[mpos+i] : 0) ^ x[i]`.
 */
export function streamSalsa20Xor(
  message: Uint8Array | null,
  messageOffset: number,
  length: number,
  nonce8: Uint8Array,
  key: Uint8Array
): Uint8Array {
  const output = new Uint8Array(length);
  if (length === 0) {
    return output;
  }
  const blockInput = new Uint8Array(16);
  blockInput.set(nonce8.subarray(0, 8), 0);
  const block = new Uint8Array(BLOCK_BYTES);

  let written = 0;
  let remaining = length;
  while (remaining > 0) {
    coreSalsa20(block, blockInput, key, SIGMA);
    const span = remaining < BLOCK_BYTES ? remaining : BLOCK_BYTES;
    for (let index = 0; index < span; index++) {
      const messageByte = message === null ? 0 : message[messageOffset + written + index];
      output[written + index] = messageByte ^ block[index];
    }
    incrementCounter(blockInput);
    remaining -= span;
    written += span;
  }
  return output;
}

/** XSalsa20: HSalsa20 derives the subkey from the first 16 bytes of the 24-byte nonce. */
export function streamXSalsa20Xor(
  message: Uint8Array | null,
  messageOffset: number,
  length: number,
  nonce24: Uint8Array,
  key: Uint8Array
): Uint8Array {
  if (length === 0) {
    return new Uint8Array(0);
  }
  const subkey = new Uint8Array(32);
  coreHSalsa20(subkey, nonce24.subarray(0, 16), key, SIGMA);
  return streamSalsa20Xor(message, messageOffset, length, nonce24.subarray(16, 24), subkey);
}

/** Raw XSalsa20 keystream; also the Poly1305 one-time key source. */
export function streamXSalsa20(length: number, nonce24: Uint8Array, key: Uint8Array): Uint8Array {
  return streamXSalsa20Xor(null, 0, length, nonce24, key);
}

function copyOf32(source: Int32Array): Int32Array {
  const target = new Int32Array(source.length);
  target.set(source);
  return target;
}

/** Little-endian 64-bit increment over bytes 8..15 of the block input. */
function incrementCounter(blockInput: Uint8Array): void {
  let carry = 1;
  for (let index = 8; index < 16; index++) {
    carry = carry + blockInput[index];
    blockInput[index] = carry & 0xff;
    carry >>>= 8;
  }
}

/*
 * Randomness source injected into the crypto helpers.
 *
 * core/ never imports a platform module: the ArkTS app passes a
 * CryptoArchitectureKit-backed generator, while tools/verify-e2ee-interop.mjs
 * passes Node's crypto RNG so the same source can run on the host.
 */
export type RandomBytes = (length: number) => Uint8Array;

/** Deterministic generator used by tests and fixtures. */
export function sequenceRandomBytes(seed: number): RandomBytes {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      // xorshift32, only ever used to build reproducible test vectors.
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[index] = state & 0xff;
    }
    return out;
  };
}

/*
 * Randomness and identifiers from the platform.
 *
 * The crypto core takes a `RandomBytes` injection rather than reaching for a
 * global, so the same code can run against the host's RNG in the interop
 * harness. This is the real generator the app passes in.
 *
 * HarmonyOS generates a `DataBlob` per call, so a request is served from the
 * platform in one shot and copied out — never cached, because a reused nonce
 * would break the E2EE v2 key schedule it feeds.
 */
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { RandomBytes } from '../core/crypto/RandomSource';

export function harmonyRandomBytes(length: number): Uint8Array {
  const generator = cryptoFramework.createRandom();
  const blob = generator.generateRandomSync(length);
  return blob.data;
}

/**
 * A short, collision-resistant id; not a security boundary, only a key.
 * 16 random bytes rendered in a lowercase alphanumeric alphabet.
 */
export function newHostId(): string {
  const bytes = harmonyRandomBytes(16);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < bytes.length; index++) {
    out += alphabet.charAt(bytes[index] % alphabet.length);
  }
  return `host-${out}`;
}

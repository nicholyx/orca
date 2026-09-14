/*
 * E2EE v2 key schedule — the HarmonyOS port of
 * `mobile/src/transport/mobile-e2ee-v2-key-schedule.ts`.
 *
 * HKDF-SHA256 over the Curve25519 shared secret, salted with both nonces and
 * bound to the handshake transcript hash, expanding to 96 bytes:
 *   [0,32)  mobile -> desktop key
 *   [32,64) desktop -> mobile key
 *   [64,96) session id (feeds the frame nonce and header)
 */
import { concatBytes } from '../bytes/Bytes';
import { encodeUtf8 } from '../bytes/Utf8';
import { hkdf } from '../crypto/Hkdf';
import { sha256 } from '../crypto/Sha256';

const SALT_LABEL: Uint8Array = encodeUtf8('orca-mobile-e2ee/v2/salt\u0000');
const INFO_LABEL: Uint8Array = encodeUtf8('orca-mobile-e2ee/v2/session\u0000');

const KEY_BYTES = 32;
const SCHEDULE_BYTES = 96;

export interface E2eeV2KeySchedule {
  mobileToDesktopKey: Uint8Array;
  desktopToMobileKey: Uint8Array;
  sessionId: Uint8Array;
  transcriptHash: Uint8Array;
}

export interface E2eeV2KeyScheduleArgs {
  sharedSecret: Uint8Array;
  transcript: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
}

export function deriveE2eeV2KeySchedule(args: E2eeV2KeyScheduleArgs): E2eeV2KeySchedule {
  requireLength(args.sharedSecret, KEY_BYTES, 'shared secret');
  requireLength(args.clientNonce, KEY_BYTES, 'client nonce');
  requireLength(args.desktopNonce, KEY_BYTES, 'desktop nonce');

  const transcriptHash = sha256(args.transcript);
  const salt = sha256(concatBytes([SALT_LABEL, args.clientNonce, args.desktopNonce]));
  const info = concatBytes([INFO_LABEL, transcriptHash]);
  const expanded = hkdf(args.sharedSecret, salt, info, SCHEDULE_BYTES);

  const schedule: E2eeV2KeySchedule = {
    mobileToDesktopKey: expanded.slice(0, KEY_BYTES),
    desktopToMobileKey: expanded.slice(KEY_BYTES, KEY_BYTES * 2),
    sessionId: expanded.slice(KEY_BYTES * 2, SCHEDULE_BYTES),
    transcriptHash: transcriptHash
  };
  return schedule;
}

function requireLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new Error(`Invalid ${label}: expected ${expected} bytes, got ${bytes.length}`);
  }
}

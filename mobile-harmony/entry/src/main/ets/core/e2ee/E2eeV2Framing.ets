/*
 * E2EE v2 frame sealing — the HarmonyOS port of
 * `src/shared/mobile-e2ee-v2-framing.ts`.
 *
 * Frame layout:  nonce(24) || secretbox(header(42) || payload)
 * with
 *   header = sessionId(32) || direction(1) || payloadKind(1) || counter(8, BE)
 *   nonce  = sessionId[0,12) || 0x02 || direction || payloadKind || 0x00 || counter(8, BE)
 *
 * The header is authenticated (it is inside the AEAD plaintext) and the nonce is
 * derived from the position in the stream, so a replayed or reordered frame
 * fails to open rather than being accepted twice.
 */
import { concatBytes, equalBytes, writeUint64BE } from '../bytes/Bytes';
import { secretbox, secretboxOpen } from '../crypto/SecretBox';

export const E2EE_V2_NONCE_LENGTH = 24;
export const E2EE_V2_SESSION_ID_LENGTH = 32;
export const E2EE_V2_PAYLOAD_KIND_TEXT = 'text';
export const E2EE_V2_PAYLOAD_KIND_BINARY = 'binary';
export const E2EE_V2_DIRECTION_MOBILE_TO_DESKTOP = 'mobile-to-desktop';
export const E2EE_V2_DIRECTION_DESKTOP_TO_MOBILE = 'desktop-to-mobile';

const HEADER_LENGTH = E2EE_V2_SESSION_ID_LENGTH + 1 + 1 + 8;
const FRAME_VERSION = 2;
// secretbox prepends a 16-byte Poly1305 tag.
const TAG_LENGTH = 16;
const MIN_FRAME_LENGTH = E2EE_V2_NONCE_LENGTH + TAG_LENGTH + HEADER_LENGTH;

export interface E2eeV2FrameArgs {
  key: Uint8Array;
  sessionId: Uint8Array;
  direction: string;
  payloadKind: string;
  counter: number;
}

export interface E2eeV2FrameSealArgs extends E2eeV2FrameArgs {
  payload: Uint8Array;
}

export interface E2eeV2FrameOpenArgs {
  frame: Uint8Array;
  key: Uint8Array;
  sessionId: Uint8Array;
  direction: string;
  payloadKind: string;
  expectedCounter: number;
}

export function sealE2eeV2Frame(args: E2eeV2FrameSealArgs): Uint8Array {
  validateFrameArgs(args.key, args.sessionId, args.counter);
  const header = encodeHeader(args);
  const nonce = encodeNonce(args);
  const plaintext = concatBytes([header, args.payload]);
  const ciphertext = secretbox(plaintext, nonce, args.key);
  return concatBytes([nonce, ciphertext]);
}

export function openE2eeV2Frame(args: E2eeV2FrameOpenArgs): Uint8Array | null {
  validateFrameArgs(args.key, args.sessionId, args.expectedCounter);
  if (args.frame.length < MIN_FRAME_LENGTH) {
    return null;
  }
  const expected: E2eeV2FrameArgs = {
    key: args.key,
    sessionId: args.sessionId,
    direction: args.direction,
    payloadKind: args.payloadKind,
    counter: args.expectedCounter
  };
  const nonce = encodeNonce(expected);
  if (!equalBytes(args.frame.subarray(0, E2EE_V2_NONCE_LENGTH), nonce)) {
    return null;
  }

  const plaintext = secretboxOpen(args.frame.subarray(E2EE_V2_NONCE_LENGTH), nonce, args.key);
  if (plaintext === null) {
    return null;
  }
  const header = encodeHeader(expected);
  if (!equalBytes(plaintext.subarray(0, HEADER_LENGTH), header)) {
    return null;
  }
  return plaintext.slice(HEADER_LENGTH);
}

export function encodeHeader(args: E2eeV2FrameArgs): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(args.sessionId, 0);
  header[E2EE_V2_SESSION_ID_LENGTH] = directionByte(args.direction);
  header[E2EE_V2_SESSION_ID_LENGTH + 1] = payloadKindByte(args.payloadKind);
  writeUint64BE(header, E2EE_V2_SESSION_ID_LENGTH + 2, args.counter);
  return header;
}

export function encodeNonce(args: E2eeV2FrameArgs): Uint8Array {
  const nonce = new Uint8Array(E2EE_V2_NONCE_LENGTH);
  // Why: v2 keys and session ids are fresh per socket, so deriving the nonce
  // from (sessionId, direction, kind, counter) keeps every nonce unique without
  // another RNG draw.
  nonce.set(args.sessionId.subarray(0, 12), 0);
  nonce[12] = FRAME_VERSION;
  nonce[13] = directionByte(args.direction);
  nonce[14] = payloadKindByte(args.payloadKind);
  nonce[15] = 0;
  writeUint64BE(nonce, 16, args.counter);
  return nonce;
}

function directionByte(direction: string): number {
  return direction === E2EE_V2_DIRECTION_MOBILE_TO_DESKTOP ? 0 : 1;
}

function payloadKindByte(payloadKind: string): number {
  return payloadKind === E2EE_V2_PAYLOAD_KIND_TEXT ? 0 : 1;
}

function validateFrameArgs(key: Uint8Array, sessionId: Uint8Array, counter: number): void {
  if (key.length !== 32) {
    throw new Error(`Invalid E2EE v2 key length: ${key.length}`);
  }
  if (sessionId.length !== E2EE_V2_SESSION_ID_LENGTH) {
    throw new Error(`Invalid E2EE v2 session ID length: ${sessionId.length}`);
  }
  if (counter < 0 || Math.floor(counter) !== counter) {
    throw new Error(`Invalid E2EE v2 counter: ${counter}`);
  }
}

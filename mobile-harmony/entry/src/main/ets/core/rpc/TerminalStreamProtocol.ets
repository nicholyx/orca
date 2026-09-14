/*
 * Binary terminal stream framing.
 *
 * Every binary frame the host pushes is
 *   kind(1)=0x74 || version(1)=1 || opcode(1) || reserved(1) || streamId(4 LE)
 *   || seqHigh(4 LE) || seqLow(4 LE) || payload
 *
 * The sequence number is split into two 32-bit halves so it stays exact in a
 * runtime without 64-bit integers, as `readUint64BE`'s counterpart does for the
 * E2EE frame counter.
 */
import { readUint32LE } from '../bytes/Bytes';
import { decodeUtf8 } from '../bytes/Utf8';

export const TERMINAL_STREAM_KIND = 0x74;
export const TERMINAL_STREAM_VERSION = 1;
const HEADER_BYTES = 16;

export const TERMINAL_OPCODE_OUTPUT = 1;
export const TERMINAL_OPCODE_SNAPSHOT_START = 2;
export const TERMINAL_OPCODE_SNAPSHOT_CHUNK = 3;
export const TERMINAL_OPCODE_SNAPSHOT_END = 4;
export const TERMINAL_OPCODE_RESIZED = 5;
export const TERMINAL_OPCODE_ERROR = 6;
export const TERMINAL_OPCODE_METADATA = 12;

export interface TerminalStreamFrame {
  opcode: number;
  streamId: number;
  seq: number;
  payload: Uint8Array;
}

export function isTerminalStreamOpcode(value: number): boolean {
  return (
    value === TERMINAL_OPCODE_OUTPUT ||
    value === TERMINAL_OPCODE_SNAPSHOT_START ||
    value === TERMINAL_OPCODE_SNAPSHOT_CHUNK ||
    value === TERMINAL_OPCODE_SNAPSHOT_END ||
    value === TERMINAL_OPCODE_RESIZED ||
    value === TERMINAL_OPCODE_ERROR ||
    value === TERMINAL_OPCODE_METADATA
  );
}

export function encodeTerminalStreamFrame(frame: TerminalStreamFrame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + frame.payload.length);
  out[0] = TERMINAL_STREAM_KIND;
  out[1] = TERMINAL_STREAM_VERSION;
  out[2] = frame.opcode;
  out[3] = 0;
  // Little-endian 32-bit stream id and sequence halves.
  writeUint32LE(out, 4, frame.streamId);
  const seq = frame.seq < 0 ? 0 : Math.floor(frame.seq);
  writeUint32LE(out, 8, Math.floor(seq / 0x100000000));
  writeUint32LE(out, 12, seq >>> 0);
  out.set(frame.payload, HEADER_BYTES);
  return out;
}

export function decodeTerminalStreamFrame(bytes: Uint8Array): TerminalStreamFrame | null {
  if (bytes.length < HEADER_BYTES) {
    return null;
  }
  if (bytes[0] !== TERMINAL_STREAM_KIND || bytes[1] !== TERMINAL_STREAM_VERSION) {
    return null;
  }
  const opcode = bytes[2];
  if (!isTerminalStreamOpcode(opcode)) {
    return null;
  }
  const streamId = readUint32LE(bytes, 4);
  const high = readUint32LE(bytes, 8);
  const low = readUint32LE(bytes, 12);
  const frame: TerminalStreamFrame = {
    opcode: opcode,
    streamId: streamId,
    seq: high * 0x100000000 + low,
    payload: bytes.slice(HEADER_BYTES)
  };
  return frame;
}

/** Decodes a JSON payload, or null when the bytes are not a JSON object. */
export function decodeTerminalStreamRecord(payload: Uint8Array): Record<string, Object> | null {
  let parsed: Record<string, Object>;
  try {
    parsed = JSON.parse(decodeUtf8(payload));
  } catch (error) {
    return null;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

export function decodeTerminalStreamText(payload: Uint8Array): string {
  return decodeUtf8(payload);
}

/** Little-endian 32-bit write; local because the shared writer is big-endian. */
function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  const normalized = value >>> 0;
  target[offset] = normalized & 0xff;
  target[offset + 1] = (normalized >>> 8) & 0xff;
  target[offset + 2] = (normalized >>> 16) & 0xff;
  target[offset + 3] = (normalized >>> 24) & 0xff;
}

/*
 * Browser screencast frame decoding.
 *
 * Header layout (all 32-bit fields little-endian):
 *   kind(1)=0x62 || version(1)=1 || opcode(1)=1 || format(1) || seq(4)
 *   || metadataLength(4) || reserved(4)=0 || metadata JSON || image bytes
 *
 * The metadata blob is length-prefixed rather than fixed-width so the host can
 * grow it without a version bump; unknown keys are ignored.
 */
import { readUint32LE } from '../bytes/Bytes';
import { decodeUtf8 } from '../bytes/Utf8';
import { asNumber, asRecord } from '../json/JsonValue';

export const BROWSER_SCREENCAST_KIND = 0x62;
export const BROWSER_SCREENCAST_VERSION = 1;
export const BROWSER_SCREENCAST_OPCODE_FRAME = 1;
const HEADER_BYTES = 16;

export const BROWSER_FORMAT_JPEG = 'jpeg';
export const BROWSER_FORMAT_PNG = 'png';

/** Numeric metadata the client positions the image with. */
export const BROWSER_METADATA_KEYS: string[] = [
  'offsetTop',
  'pageScaleFactor',
  'deviceWidth',
  'deviceHeight',
  'imageWidth',
  'imageHeight',
  'scrollOffsetX',
  'scrollOffsetY',
  'timestamp'
];

export interface BrowserScreencastFrame {
  seq: number;
  format: string;
  /** Only the keys listed in BROWSER_METADATA_KEYS that were present. */
  metadata: Record<string, Object>;
  image: Uint8Array;
}

function formatFromByte(value: number): string | null {
  if (value === 1) {
    return BROWSER_FORMAT_JPEG;
  }
  if (value === 2) {
    return BROWSER_FORMAT_PNG;
  }
  return null;
}

export function decodeBrowserScreencastFrame(bytes: Uint8Array): BrowserScreencastFrame | null {
  if (bytes.length < HEADER_BYTES) {
    return null;
  }
  if (bytes[0] !== BROWSER_SCREENCAST_KIND || bytes[1] !== BROWSER_SCREENCAST_VERSION) {
    return null;
  }
  if (bytes[2] !== BROWSER_SCREENCAST_OPCODE_FRAME) {
    return null;
  }
  const format = formatFromByte(bytes[3]);
  if (format === null) {
    return null;
  }
  const seq = readUint32LE(bytes, 4);
  const metadataLength = readUint32LE(bytes, 8);
  if (readUint32LE(bytes, 12) !== 0) {
    return null;
  }
  const imageStart = HEADER_BYTES + metadataLength;
  if (imageStart > bytes.length) {
    return null;
  }
  const metadata = readMetadata(bytes.subarray(HEADER_BYTES, imageStart));
  if (metadata === null) {
    return null;
  }
  const frame: BrowserScreencastFrame = {
    seq: seq,
    format: format,
    metadata: metadata,
    image: bytes.slice(imageStart)
  };
  return frame;
}

function readMetadata(bytes: Uint8Array): Record<string, Object> | null {
  let parsed: Record<string, Object>;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  const metadata: Record<string, Object> = {};
  for (let index = 0; index < BROWSER_METADATA_KEYS.length; index++) {
    const key = BROWSER_METADATA_KEYS[index];
    const value = asNumber(record[key]);
    if (value !== null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

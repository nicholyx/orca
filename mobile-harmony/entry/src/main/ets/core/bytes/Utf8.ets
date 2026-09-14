/*
 * UTF-8 encode/decode without relying on TextEncoder/TextDecoder.
 *
 * Kept in core/ so the transcript encoder is byte-exact and testable outside
 * the device runtime. Handles lone surrogates the way WHATWG encoding does
 * (U+FFFD), which is what TextEncoder does for unpaired code units.
 */

const REPLACEMENT = 0xfffd;

export function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    let codePoint = value.charCodeAt(index);
    index++;
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      if (index < value.length) {
        const low = value.charCodeAt(index);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          index++;
        } else {
          codePoint = REPLACEMENT;
        }
      } else {
        codePoint = REPLACEMENT;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = REPLACEMENT;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  const out = new Uint8Array(bytes.length);
  for (let at = 0; at < bytes.length; at++) {
    out[at] = bytes[at];
  }
  return out;
}

/**
 * Decodes UTF-8. Malformed sequences become U+FFFD, matching TextDecoder's
 * non-fatal behaviour so a truncated terminal frame still renders.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    let codePoint = 0;
    let width = 0;
    if (first < 0x80) {
      codePoint = first;
      width = 1;
    } else if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      width = 2;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      width = 3;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      width = 4;
    } else {
      out += String.fromCharCode(REPLACEMENT);
      index++;
      continue;
    }

    if (index + width > bytes.length) {
      out += String.fromCharCode(REPLACEMENT);
      break;
    }
    let valid = true;
    for (let offset = 1; offset < width; offset++) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (!valid) {
      out += String.fromCharCode(REPLACEMENT);
      index++;
      continue;
    }
    index += width;

    const overlong =
      (width === 2 && codePoint < 0x80) ||
      (width === 3 && codePoint < 0x800) ||
      (width === 4 && codePoint < 0x10000);
    if (overlong || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      out += String.fromCharCode(REPLACEMENT);
      continue;
    }

    if (codePoint <= 0xffff) {
      out += String.fromCharCode(codePoint);
    } else {
      const adjusted = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10));
      out += String.fromCharCode(0xdc00 + (adjusted & 0x3ff));
    }
  }
  return out;
}

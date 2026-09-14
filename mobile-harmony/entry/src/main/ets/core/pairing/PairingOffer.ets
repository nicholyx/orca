/*
 * Pairing-offer parsing: turns whatever the user actually has — a scanned QR,
 * a pasted `orca://pair?...` URL, or a bare base64 blob — into one validated
 * offer, or null.
 *
 * This mirrors `src/shared/mobile-relay-pairing-offer.ts` field for field, and
 * the limits in `mobile-pairing-protocol-limits.ts`. It is a hand port because
 * ArkTS cannot consume the zod schema, so the two must be kept in step: the
 * rules that matter are asserted in tools/interop/verify-pairing-interop.ts.
 *
 * Base64url is decoded by hand rather than with `atob`, because desktop strips
 * QR padding on purpose — restoring it is exactly where mobile runtimes and
 * our own encoder diverge. Character tests are explicit rather than regex
 * literals, matching the rest of the `.ets` tree.
 */
import { decodeBase64, encodeBase64 } from '../bytes/Base64';

export const PAIRING_OFFER_VERSION = 2;

export const PAIRING_CODE_MAX_CHARACTERS = 128 * 1024;
export const PAIRING_ENDPOINT_MAX_CHARACTERS = 16 * 1024;
export const PAIRING_DEVICE_TOKEN_MAX_CHARACTERS = 64 * 1024;
export const PAIRING_PUBLIC_KEY_MAX_CHARACTERS = 4 * 1024;
export const PAIRING_RELAY_URL_MAX_CHARACTERS = 2048;
const MAX_INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_EXPIRY_CLOCK_SKEW_MS = 30 * 1000;

export const PAIRING_SCOPE_MOBILE = 'mobile';
export const PAIRING_SCOPE_RUNTIME = 'runtime';

export interface PairingRelay {
  v: number;
  directorUrl: string;
  cellUrl: string;
  assignmentEpoch: number;
  relayHostId: string;
  inviteToken: string;
  inviteExpiresAt: number;
  e2eeFraming: number;
}

export interface PairingOffer {
  v: number;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
  pairedDeviceId?: string;
  scope?: string;
  relay?: PairingRelay;
}

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Standard base64 alphabet (A-Z a-z 0-9 + /). */
function isStandardBase64Code(code: number): boolean {
  if (isUpper(code) || isLower(code) || isDigit(code)) {
    return true;
  }
  return code === 43 || code === 47;
}

/** base64url alphabet (A-Z a-z 0-9 - _). */
function isBase64UrlCode(code: number): boolean {
  if (isUpper(code) || isLower(code) || isDigit(code)) {
    return true;
  }
  return code === 45 || code === 95;
}

function isBase64UrlExact(value: string, length: number): boolean {
  if (value.length !== length) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    if (!isBase64UrlCode(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function isCanonicalBase64Key32(value: string): boolean {
  if (value.length !== 44) {
    return false;
  }
  for (let index = 0; index < 43; index++) {
    if (!isStandardBase64Code(value.charCodeAt(index))) {
      return false;
    }
  }
  if (value.charCodeAt(43) !== 61) {
    return false;
  }
  const decoded = decodeBase64(value);
  if (decoded === null || decoded.length !== 32) {
    return false;
  }
  // Canonical: re-encoding must reproduce the input exactly, which rejects the
  // permissive legacy aliases that decode to the same 32 bytes.
  return encodeBase64(decoded) === value;
}

/** A canonical HTTPS origin: scheme, host, and nothing else. */
function isCanonicalHttpsOrigin(value: string): boolean {
  if (value.length > PAIRING_RELAY_URL_MAX_CHARACTERS) {
    return false;
  }
  if (value.length <= 8) {
    return false;
  }
  if (value.substring(0, 8).toLowerCase() !== 'https://') {
    return false;
  }
  const body = value.substring(8);
  if (body.length === 0) {
    return false;
  }
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    if (code === 47 || code === 63 || code === 35) {
      return false;
    }
  }
  return true;
}

function asStringOrNull(value: Object | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function isFiniteInt(value: Object | undefined): boolean {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readRelay(value: Object | undefined, now: () => number): PairingRelay | null {
  if (value === undefined || value === null || typeof value !== 'object') {
    return null;
  }
  // SAFETY: value proven to be a non-null object by the guard above.
  const record = value as Record<string, Object>;
  if (record.v !== 1) {
    return null;
  }
  if (record.e2eeFraming !== 2) {
    return null;
  }
  const directorUrl = asStringOrNull(record.directorUrl);
  const cellUrl = asStringOrNull(record.cellUrl);
  const relayHostId = asStringOrNull(record.relayHostId);
  const inviteToken = asStringOrNull(record.inviteToken);
  if (directorUrl === null || cellUrl === null) {
    return null;
  }
  if (relayHostId === null || inviteToken === null) {
    return null;
  }
  if (!isCanonicalHttpsOrigin(directorUrl) || !isCanonicalHttpsOrigin(cellUrl)) {
    return null;
  }
  if (!isBase64UrlExact(relayHostId, 16) || !isBase64UrlExact(inviteToken, 43)) {
    return null;
  }
  const assignmentEpoch = record.assignmentEpoch;
  const inviteExpiresAt = record.inviteExpiresAt;
  if (!isFiniteInt(assignmentEpoch) || !isFiniteInt(inviteExpiresAt)) {
    return null;
  }
  // SAFETY: both proven numeric integers by isFiniteInt above.
  const epoch = assignmentEpoch as number;
  const expiresAt = inviteExpiresAt as number;
  if (epoch < 0 || epoch > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  const currentTime = now();
  if (
    !(expiresAt > currentTime) ||
    !(expiresAt <= currentTime + MAX_INVITE_TTL_MS + INVITE_EXPIRY_CLOCK_SKEW_MS)
  ) {
    return null;
  }
  const relay: PairingRelay = {
    v: 1,
    directorUrl: directorUrl,
    cellUrl: cellUrl,
    assignmentEpoch: epoch,
    relayHostId: relayHostId,
    inviteToken: inviteToken,
    inviteExpiresAt: expiresAt,
    e2eeFraming: 2
  };
  return relay;
}

/**
 * Validates a decoded offer object. Null on any violation — a partially trusted
 * offer is worse than none, since the pinned key decides whether the session is
 * actually with the intended desktop.
 */
export function validatePairingOffer(value: Object | null, now: () => number): PairingOffer | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  // SAFETY: value proven non-null and object-typed directly above.
  const record = value as Record<string, Object>;
  if (record.v !== PAIRING_OFFER_VERSION) {
    return null;
  }
  const endpoint = asStringOrNull(record.endpoint);
  const deviceToken = asStringOrNull(record.deviceToken);
  const publicKeyB64 = asStringOrNull(record.publicKeyB64);
  if (endpoint === null || deviceToken === null || publicKeyB64 === null) {
    return null;
  }
  if (endpoint.length === 0 || endpoint.length > PAIRING_ENDPOINT_MAX_CHARACTERS) {
    return null;
  }
  if (deviceToken.length === 0 || deviceToken.length > PAIRING_DEVICE_TOKEN_MAX_CHARACTERS) {
    return null;
  }
  if (publicKeyB64.length === 0 || publicKeyB64.length > PAIRING_PUBLIC_KEY_MAX_CHARACTERS) {
    return null;
  }

  const offer: PairingOffer = {
    v: PAIRING_OFFER_VERSION,
    endpoint: endpoint,
    deviceToken: deviceToken,
    publicKeyB64: publicKeyB64
  };

  const pairedDeviceId = asStringOrNull(record.pairedDeviceId);
  if (pairedDeviceId !== null) {
    if (pairedDeviceId.length === 0 || pairedDeviceId.length > 128) {
      return null;
    }
    offer.pairedDeviceId = pairedDeviceId;
  }

  const scope = asStringOrNull(record.scope);
  if (scope !== null) {
    if (scope !== PAIRING_SCOPE_MOBILE && scope !== PAIRING_SCOPE_RUNTIME) {
      return null;
    }
    offer.scope = scope;
  }

  // Present-but-invalid fails the whole offer rather than being ignored: an
  // explicit `relay: null` is not the same as an absent key, and silently
  // dropping a relay the desktop meant to advertise would downgrade the link.
  if (record.relay !== undefined) {
    const relay = readRelay(record.relay, now);
    if (relay === null) {
      return null;
    }
    if (offer.scope === PAIRING_SCOPE_RUNTIME) {
      // Relay v1 is mobile-only; accepting it on a runtime offer would imply
      // routing the client does not implement.
      return null;
    }
    if (!isCanonicalBase64Key32(publicKeyB64)) {
      // relayHostId is derived from the decoded key, so relay offers cannot
      // tolerate the permissive legacy base64 aliases.
      return null;
    }
    offer.relay = relay;
  }

  return offer;
}

// ---------------------------------------------------------------------------
// URL + base64 decoding
// ---------------------------------------------------------------------------

interface OrcaUrlParts {
  host: string;
  pathname: string;
  rest: string;
}

const ORCA_SCHEME = 'orca://';

function splitOrcaUrl(trimmed: string): OrcaUrlParts | null {
  if (trimmed.length < ORCA_SCHEME.length) {
    return null;
  }
  if (trimmed.substring(0, ORCA_SCHEME.length).toLowerCase() !== ORCA_SCHEME) {
    return null;
  }
  const start = ORCA_SCHEME.length;
  let hostEnd = start;
  while (hostEnd < trimmed.length) {
    const code = trimmed.charCodeAt(hostEnd);
    if (code === 47 || code === 63 || code === 35) {
      break;
    }
    hostEnd++;
  }
  let pathnameEnd = hostEnd;
  while (pathnameEnd < trimmed.length) {
    const code = trimmed.charCodeAt(pathnameEnd);
    if (code === 63 || code === 35) {
      break;
    }
    pathnameEnd++;
  }
  const parts: OrcaUrlParts = {
    host: trimmed.substring(start, hostEnd).toLowerCase(),
    pathname: trimmed.substring(hostEnd, pathnameEnd),
    rest: trimmed.substring(pathnameEnd)
  };
  return parts;
}

export function extractPairingCodeFromUrl(url: string): string | null {
  const trimmed = url.trim();
  const parts = splitOrcaUrl(trimmed);
  if (parts === null) {
    return null;
  }
  if (parts.host !== 'pair' || (parts.pathname !== '' && parts.pathname !== '/')) {
    return null;
  }
  const queryIndex = parts.rest.indexOf('?');
  if (queryIndex !== -1) {
    const rawQuery = parts.rest.substring(queryIndex + 1);
    const hashIndex = rawQuery.indexOf('#');
    const query = hashIndex === -1 ? rawQuery : rawQuery.substring(0, hashIndex);
    const code = readQueryParam(query, 'code');
    if (code !== null && code.length > 0) {
      return code;
    }
  }
  const restHashIndex = parts.rest.indexOf('#');
  if (restHashIndex !== -1) {
    const fragment = parts.rest.substring(restHashIndex + 1);
    return fragment.length === 0 ? null : fragment;
  }
  return null;
}

/** Minimal `?a=b&c=d` reader, matching `URLSearchParams` decoding semantics. */
function readQueryParam(query: string, key: string): string | null {
  const pairs = query.split('&');
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    const equalsIndex = pair.indexOf('=');
    const rawKey = equalsIndex === -1 ? pair : pair.substring(0, equalsIndex);
    if (rawKey !== key) {
      continue;
    }
    const rawValue = equalsIndex === -1 ? '' : pair.substring(equalsIndex + 1);
    // form-urlencoded: '+' is a space before percent-decoding.
    return decodePercent(rawValue.split('+').join(' '));
  }
  return null;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  return -1;
}

function decodePercent(value: string): string {
  if (value.indexOf('%') === -1) {
    return value;
  }
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 37 && index + 2 < value.length) {
      const high = hexValue(value.charCodeAt(index + 1));
      const low = hexValue(value.charCodeAt(index + 2));
      if (high >= 0 && low >= 0) {
        bytes.push((high << 4) | low);
        index += 3;
        continue;
      }
    }
    bytes.push(code & 0xff);
    index++;
  }
  return utf8DecodeBytes(bytes);
}

function utf8DecodeBytes(bytes: number[]): string {
  let out = '';
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xc0 && byte < 0xe0) {
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      out += String.fromCharCode(((byte & 0x1f) << 6) | (second & 0x3f));
      index++;
    } else if (byte >= 0xe0 && byte < 0xf0) {
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      );
      index += 2;
    } else {
      out += '\ufffd';
    }
  }
  return out;
}

/** Restores the padding desktop strips from QR payloads, then decodes base64url. */
export function decodePairingBase64(base64url: string): string | null {
  let normalized = '';
  for (let index = 0; index < base64url.length; index++) {
    const char = base64url.charAt(index);
    if (char === '-') {
      normalized += '+';
    } else if (char === '_') {
      normalized += '/';
    } else {
      normalized += char;
    }
  }
  const remainder = normalized.length % 4;
  if (remainder === 1) {
    return null;
  }
  if (remainder !== 0) {
    let padding = '';
    for (let count = 0; count < 4 - remainder; count++) {
      padding += '=';
    }
    normalized += padding;
  }
  const bytes = decodeBase64(normalized);
  if (bytes === null) {
    return null;
  }
  const codes: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    codes.push(bytes[index]);
  }
  return utf8DecodeBytes(codes);
}

export function parsePairingOfferJson(json: string, now: () => number): PairingOffer | null {
  if (json.length > PAIRING_CODE_MAX_CHARACTERS) {
    return null;
  }
  let parsed: Object;
  try {
    parsed = JSON.parse(json) as Object;
  } catch (error) {
    return null;
  }
  return validatePairingOffer(parsed, now);
}

export function decodePairingUrl(url: string, now: () => number): PairingOffer | null {
  const code = extractPairingCodeFromUrl(url);
  if (code === null || code.length === 0) {
    return null;
  }
  const json = decodePairingBase64(code);
  if (json === null) {
    return null;
  }
  return parsePairingOfferJson(json, now);
}

/** Accepts an `orca://pair?...` URL, a bare base64 blob, or raw JSON. */
export function parsePairingCode(input: string, now: () => number): PairingOffer | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    if (trimmed.length >= ORCA_SCHEME.length) {
      if (trimmed.substring(0, ORCA_SCHEME.length).toLowerCase() === ORCA_SCHEME) {
        return decodePairingUrl(trimmed, now);
      }
    }
    const json = decodePairingBase64(trimmed);
    if (json === null) {
      return null;
    }
    return parsePairingOfferJson(json, now);
  } catch (error) {
    return null;
  }
}

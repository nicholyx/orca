/*
 * E2EE v2 handshake contract — the HarmonyOS port of
 * `src/shared/mobile-e2ee-v2-contract.ts`.
 *
 * Wire compatibility is exact: the same field names, the same canonical base64
 * alphabet, the same "no unknown keys" validation, and the same transcript byte
 * layout. The desktop cannot tell this client apart from the React Native one.
 */
import { concatBytes, copyOf, equalBytes, writeUint32BE } from '../bytes/Bytes';
import { decodeCanonicalBase64Bytes, encodeBase64 } from '../bytes/Base64';
import { encodeUtf8 } from '../bytes/Utf8';
import { hasExactKeys, numberListsEqual, stringListsEqual } from '../json/JsonValue';

export const MOBILE_E2EE_V2_PROTOCOL = 'orca-mobile-e2ee';
export const MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript';
export const MOBILE_E2EE_V2_VERSION = 2;
export const MOBILE_E2EE_V2_KEY_BYTES = 32;

const BASE64URL_16_PATTERN = '^[A-Za-z0-9_-]{16}$';

/** Hello context as serialized. `relayHostId` is omitted entirely for direct links. */
export interface E2eeV2HelloContext {
  protocol: string;
  initiator: string;
  responder: string;
  transport: string;
  relayHostId?: string;
}

export interface E2eeV2Capabilities {
  framing: number[];
  payloadKinds: string[];
}

export interface E2eeV2Hello {
  type: string;
  v: number;
  clientPublicKeyB64: string;
  clientNonceB64: string;
  capabilities: E2eeV2Capabilities;
  context: E2eeV2HelloContext;
}

/** Context decoded from a received frame. `relayHostId` is empty when absent. */
export interface E2eeV2DecodedContext {
  protocol: string;
  initiator: string;
  responder: string;
  transport: string;
  relayHostId: string;
}

export interface E2eeV2Selection {
  framing: number;
  payloadKinds: string[];
}

export interface E2eeV2Ready {
  type: string;
  v: number;
  desktopPublicKeyB64: string;
  clientNonceB64: string;
  desktopNonceB64: string;
  selection: E2eeV2Selection;
  context: E2eeV2DecodedContext;
}

/** Everything the transcript encoder and key schedule need from a verified `e2ee_ready`. */
export interface E2eeV2ValidatedHandshake {
  ready: E2eeV2Ready;
  helloContext: E2eeV2DecodedContext;
  clientPublicKey: Uint8Array;
  desktopPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
  transcript: Uint8Array;
}

/** Builds an `e2ee_hello` document for a direct (non-relay) transport. */
export function buildDirectHello(args: {
  clientPublicKeyB64: string;
  clientNonceB64: string;
}): E2eeV2Hello {
  const capabilities: E2eeV2Capabilities = { framing: [2], payloadKinds: ['text', 'binary'] };
  const context: E2eeV2HelloContext = {
    protocol: MOBILE_E2EE_V2_PROTOCOL,
    initiator: 'mobile',
    responder: 'desktop',
    transport: 'direct'
  };
  const hello: E2eeV2Hello = {
    type: 'e2ee_hello',
    v: MOBILE_E2EE_V2_VERSION,
    clientPublicKeyB64: args.clientPublicKeyB64,
    clientNonceB64: args.clientNonceB64,
    capabilities: capabilities,
    context: context
  };
  return hello;
}

/** Builds an `e2ee_hello` document for a relay transport. */
export function buildRelayHello(args: {
  clientPublicKeyB64: string;
  clientNonceB64: string;
  relayHostId: string;
}): E2eeV2Hello {
  const capabilities: E2eeV2Capabilities = { framing: [2], payloadKinds: ['text', 'binary'] };
  const context: E2eeV2HelloContext = {
    protocol: MOBILE_E2EE_V2_PROTOCOL,
    initiator: 'mobile',
    responder: 'desktop',
    transport: 'relay',
    relayHostId: args.relayHostId
  };
  const hello: E2eeV2Hello = {
    type: 'e2ee_hello',
    v: MOBILE_E2EE_V2_VERSION,
    clientPublicKeyB64: args.clientPublicKeyB64,
    clientNonceB64: args.clientNonceB64,
    capabilities: capabilities,
    context: context
  };
  return hello;
}

/** Serializes the hello exactly as the desktop expects to receive it. */
export function encodeHello(hello: E2eeV2Hello): string {
  return JSON.stringify(hello);
}

/**
 * Validates a received `e2ee_ready` against the hello we sent and returns the
 * handshake material. Null means "reject the socket" — the caller must not fall
 * back to an unauthenticated connection.
 */
export function validateReady(
  hello: E2eeV2Hello,
  rawReadyValue: Object
): E2eeV2ValidatedHandshake | null {
  const rawReady: Record<string, Object> = rawReadyValue as Record<string, Object>;
  if (
    !hasExactKeys(rawReady, [
      'type',
      'v',
      'desktopPublicKeyB64',
      'clientNonceB64',
      'desktopNonceB64',
      'selection',
      'context'
    ])
  ) {
    return null;
  }
  const readyType = rawReady.type;
  const readyVersion = rawReady.v;
  if (readyType !== 'e2ee_ready' || readyVersion !== MOBILE_E2EE_V2_VERSION) {
    return null;
  }
  if (hello.type !== 'e2ee_hello' || hello.v !== MOBILE_E2EE_V2_VERSION) {
    return null;
  }

  const selection = parseSelection(rawReady.selection);
  if (selection === null) {
    return null;
  }
  if (!hasExactCapabilities(hello.capabilities)) {
    return null;
  }

  const helloContext = parseContext(hello.context as Object);
  const readyContext = parseContext(rawReady.context);
  if (helloContext === null || readyContext === null) {
    return null;
  }
  if (!contextsEqual(helloContext, readyContext)) {
    return null;
  }

  const readyClientNonceB64 = rawReady.clientNonceB64;
  if (readyClientNonceB64 !== hello.clientNonceB64) {
    return null;
  }

  const clientPublicKeyB64 = hello.clientPublicKeyB64;
  const desktopPublicKeyB64 = rawReady.desktopPublicKeyB64;
  const desktopNonceB64 = rawReady.desktopNonceB64;
  if (
    typeof clientPublicKeyB64 !== 'string' ||
    typeof desktopPublicKeyB64 !== 'string' ||
    typeof readyClientNonceB64 !== 'string' ||
    typeof desktopNonceB64 !== 'string'
  ) {
    return null;
  }

  const clientPublicKey = decodeCanonicalBase64Bytes(clientPublicKeyB64, MOBILE_E2EE_V2_KEY_BYTES);
  const desktopPublicKey = decodeCanonicalBase64Bytes(
    desktopPublicKeyB64,
    MOBILE_E2EE_V2_KEY_BYTES
  );
  const clientNonce = decodeCanonicalBase64Bytes(readyClientNonceB64, MOBILE_E2EE_V2_KEY_BYTES);
  const desktopNonce = decodeCanonicalBase64Bytes(desktopNonceB64, MOBILE_E2EE_V2_KEY_BYTES);
  if (
    clientPublicKey === null ||
    desktopPublicKey === null ||
    clientNonce === null ||
    desktopNonce === null
  ) {
    return null;
  }

  const ready: E2eeV2Ready = {
    type: 'e2ee_ready',
    v: MOBILE_E2EE_V2_VERSION,
    desktopPublicKeyB64: desktopPublicKeyB64,
    clientNonceB64: readyClientNonceB64,
    desktopNonceB64: desktopNonceB64,
    selection: selection,
    context: readyContext
  };
  const transcript = encodeTranscript({
    hello: hello,
    ready: ready,
    readyContext: readyContext,
    clientPublicKey: clientPublicKey,
    desktopPublicKey: desktopPublicKey,
    clientNonce: clientNonce,
    desktopNonce: desktopNonce
  });

  const validated: E2eeV2ValidatedHandshake = {
    ready: ready,
    helloContext: helloContext,
    clientPublicKey: clientPublicKey,
    desktopPublicKey: desktopPublicKey,
    clientNonce: clientNonce,
    desktopNonce: desktopNonce,
    transcript: transcript
  };
  return validated;
}

/**
 * Byte layout of the handshake transcript. Each field is
 * length-prefixed so a field boundary cannot be shifted by attacker-controlled
 * content.
 */
export function encodeTranscript(args: {
  hello: E2eeV2Hello;
  ready: E2eeV2Ready;
  readyContext: E2eeV2DecodedContext;
  clientPublicKey: Uint8Array;
  desktopPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  desktopNonce: Uint8Array;
}): Uint8Array {
  const helloContext: E2eeV2HelloContext = args.hello.context;
  const helloRelayHostId =
    helloContext.relayHostId === undefined ? '' : helloContext.relayHostId;
  const readyContext = args.readyContext;

  const fields: Uint8Array[] = [];
  fields.push(transcriptField('domain', encodeUtf8(MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN)));

  fields.push(transcriptField('mobile-to-desktop.type', encodeUtf8(args.hello.type)));
  fields.push(transcriptField('mobile-to-desktop.version', uint32(args.hello.v)));
  fields.push(
    transcriptField('mobile-to-desktop.client-public-key', args.clientPublicKey)
  );
  fields.push(transcriptField('mobile-to-desktop.client-nonce', args.clientNonce));
  fields.push(
    transcriptField(
      'mobile-to-desktop.capabilities.framing',
      encodeNumberList(args.hello.capabilities.framing)
    )
  );
  fields.push(
    transcriptField(
      'mobile-to-desktop.capabilities.payload-kinds',
      encodeStringList(args.hello.capabilities.payloadKinds)
    )
  );
  fields.push(
    transcriptField('mobile-to-desktop.context.protocol', encodeUtf8(helloContext.protocol))
  );
  fields.push(
    transcriptField('mobile-to-desktop.context.initiator', encodeUtf8(helloContext.initiator))
  );
  fields.push(
    transcriptField('mobile-to-desktop.context.responder', encodeUtf8(helloContext.responder))
  );
  fields.push(
    transcriptField('mobile-to-desktop.context.transport', encodeUtf8(helloContext.transport))
  );
  fields.push(
    transcriptField('mobile-to-desktop.context.relay-host-id', encodeUtf8(helloRelayHostId))
  );

  fields.push(transcriptField('desktop-to-mobile.type', encodeUtf8(args.ready.type)));
  fields.push(transcriptField('desktop-to-mobile.version', uint32(args.ready.v)));
  fields.push(
    transcriptField('desktop-to-mobile.desktop-public-key', args.desktopPublicKey)
  );
  fields.push(
    transcriptField('desktop-to-mobile.client-nonce-echo', args.clientNonce)
  );
  fields.push(transcriptField('desktop-to-mobile.desktop-nonce', args.desktopNonce));
  fields.push(
    transcriptField('desktop-to-mobile.selection.framing', uint32(args.ready.selection.framing))
  );
  fields.push(
    transcriptField(
      'desktop-to-mobile.selection.payload-kinds',
      encodeStringList(args.ready.selection.payloadKinds)
    )
  );
  fields.push(
    transcriptField('desktop-to-mobile.context.protocol', encodeUtf8(readyContext.protocol))
  );
  fields.push(
    transcriptField('desktop-to-mobile.context.initiator', encodeUtf8(readyContext.initiator))
  );
  fields.push(
    transcriptField('desktop-to-mobile.context.responder', encodeUtf8(readyContext.responder))
  );
  fields.push(
    transcriptField('desktop-to-mobile.context.transport', encodeUtf8(readyContext.transport))
  );
  fields.push(
    transcriptField('desktop-to-mobile.context.relay-host-id', encodeUtf8(readyContext.relayHostId))
  );

  return concatBytes(fields);
}

/** Base64 of the raw client public key, as it appears on the wire. */
export function encodePublicKeyB64(publicKey: Uint8Array): string {
  return encodeBase64(copyOf(publicKey));
}

/** Constant-time byte comparison, exposed for the pinned-key check. */
export function publicKeysEqual(left: Uint8Array, right: Uint8Array): boolean {
  return equalBytes(left, right);
}

function transcriptField(name: string, value: Uint8Array): Uint8Array {
  const nameBytes = encodeUtf8(name);
  return concatBytes([
    uint32(nameBytes.length),
    nameBytes,
    uint32(value.length),
    value
  ]);
}

function encodeNumberList(values: number[]): Uint8Array {
  const parts: Uint8Array[] = [uint32(values.length)];
  for (let index = 0; index < values.length; index++) {
    parts.push(uint32(values[index]));
  }
  return concatBytes(parts);
}

function encodeStringList(values: string[]): Uint8Array {
  const parts: Uint8Array[] = [uint32(values.length)];
  for (let index = 0; index < values.length; index++) {
    const bytes = encodeUtf8(values[index]);
    parts.push(uint32(bytes.length));
    parts.push(bytes);
  }
  return concatBytes(parts);
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  writeUint32BE(bytes, 0, value);
  return bytes;
}

function parseSelection(value: Object | null | undefined): E2eeV2Selection | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const record: Record<string, Object> = value as Record<string, Object>;
  if (!hasExactKeys(record, ['framing', 'payloadKinds'])) {
    return null;
  }
  if (record.framing !== MOBILE_E2EE_V2_VERSION) {
    return null;
  }
  const payloadKinds = record.payloadKinds;
  if (
    !Array.isArray(payloadKinds) ||
    payloadKinds.length !== 2 ||
    payloadKinds[0] !== 'text' ||
    payloadKinds[1] !== 'binary'
  ) {
    return null;
  }
  const selection: E2eeV2Selection = { framing: 2, payloadKinds: ['text', 'binary'] };
  return selection;
}

function hasExactCapabilities(capabilities: E2eeV2Capabilities): boolean {
  return (
    capabilities.framing.length === 1 &&
    capabilities.framing[0] === MOBILE_E2EE_V2_VERSION &&
    stringListsEqual(capabilities.payloadKinds, ['text', 'binary'])
  );
}

function parseContext(value: Object | null | undefined): E2eeV2DecodedContext | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const record: Record<string, Object> = value as Record<string, Object>;
  const transport = record.transport;
  if (transport === null || transport === undefined) {
    return null;
  }
  if (transport !== 'direct' && transport !== 'relay') {
    return null;
  }
  const isRelay = transport === 'relay';
  if (isRelay) {
    if (!hasExactKeys(record, ['protocol', 'initiator', 'responder', 'transport', 'relayHostId'])) {
      return null;
    }
  } else {
    if (!hasExactKeys(record, ['protocol', 'initiator', 'responder', 'transport'])) {
      return null;
    }
  }
  if (
    record.protocol !== MOBILE_E2EE_V2_PROTOCOL ||
    record.initiator !== 'mobile' ||
    record.responder !== 'desktop'
  ) {
    return null;
  }
  let relayHostId = '';
  if (isRelay) {
    const relayValue = record.relayHostId;
    if (typeof relayValue !== 'string' || !new RegExp(BASE64URL_16_PATTERN).test(relayValue)) {
      return null;
    }
    relayHostId = relayValue;
  }
  const context: E2eeV2DecodedContext = {
    protocol: MOBILE_E2EE_V2_PROTOCOL,
    initiator: 'mobile',
    responder: 'desktop',
    transport: transport,
    relayHostId: relayHostId
  };
  return context;
}

function contextsEqual(left: E2eeV2DecodedContext, right: E2eeV2DecodedContext): boolean {
  return (
    left.protocol === right.protocol &&
    left.initiator === right.initiator &&
    left.responder === right.responder &&
    left.transport === right.transport &&
    left.relayHostId === right.relayHostId
  );
}

/** Exposed for the interop harness, which asserts list encoding parity. */
export function encodeCapabilitiesForTest(framing: number[], payloadKinds: string[]): Uint8Array {
  return concatBytes([
    encodeNumberList(framing),
    encodeStringList(payloadKinds)
  ]);
}

/** Exposed for tests: the reference `numberListsEqual` behaviour. */
export function numberListsMatch(left: number[], right: number[]): boolean {
  return numberListsEqual(left, right);
}

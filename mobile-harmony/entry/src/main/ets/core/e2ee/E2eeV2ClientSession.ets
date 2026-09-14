/*
 * E2EE v2 client session — the HarmonyOS port of
 * `mobile/src/transport/mobile-e2ee-v2-client-session.ts`.
 *
 * Owns one socket's handshake and frame counters. Counters are strictly
 * sequential per direction and payload kind, and both sides verify the position
 * they expect, so a dropped or replayed frame surfaces as a failure to open
 * rather than as silently reordered output.
 */
import { decodeCanonicalBase64, encodeBase64 } from '../bytes/Base64';
import { decodeUtf8, encodeUtf8 } from '../bytes/Utf8';
import { BoxKeyPair, boxBefore, boxKeyPair } from '../crypto/Box';
import { RandomBytes } from '../crypto/RandomSource';
import {
  E2eeV2Hello,
  E2eeV2ValidatedHandshake,
  buildDirectHello,
  buildRelayHello,
  encodeHello,
  encodePublicKeyB64,
  publicKeysEqual,
  validateReady
} from './E2eeV2Contract';
import {
  E2EE_V2_DIRECTION_DESKTOP_TO_MOBILE,
  E2EE_V2_DIRECTION_MOBILE_TO_DESKTOP,
  E2EE_V2_PAYLOAD_KIND_BINARY,
  E2EE_V2_PAYLOAD_KIND_TEXT,
  openE2eeV2Frame,
  sealE2eeV2Frame
} from './E2eeV2Framing';
import { E2eeV2KeySchedule, deriveE2eeV2KeySchedule } from './E2eeV2KeySchedule';

const NONCE_BYTES = 32;

export interface E2eeV2ClientSessionOptions {
  desktopPublicKeyB64: string;
  transport: string;
  relayHostId?: string;
  clientNonce?: Uint8Array;
  clientKeyPair?: BoxKeyPair;
}

export class E2eeV2ClientSession {
  readonly hello: E2eeV2Hello;

  private readonly clientSecretKey: Uint8Array;
  private readonly pinnedDesktopPublicKey: Uint8Array;
  private inboundCounter: number = 0;
  private outboundCounter: number = 0;
  private schedule: E2eeV2KeySchedule | null = null;
  private transcriptHashB64Value: string = '';

  constructor(clientSecretKey: Uint8Array, pinnedDesktopPublicKey: Uint8Array, hello: E2eeV2Hello) {
    this.clientSecretKey = clientSecretKey;
    this.pinnedDesktopPublicKey = pinnedDesktopPublicKey;
    this.hello = hello;
  }

  /** Creates a session for one socket. The pinned key comes from the pairing offer. */
  static create(random: RandomBytes, options: E2eeV2ClientSessionOptions): E2eeV2ClientSession {
    const keyPair: BoxKeyPair =
      options.clientKeyPair === undefined ? boxKeyPair(random) : options.clientKeyPair;
    const clientNonce: Uint8Array =
      options.clientNonce === undefined ? random(NONCE_BYTES) : options.clientNonce;
    if (clientNonce.length !== NONCE_BYTES) {
      throw new Error(`Invalid client nonce length: ${clientNonce.length}`);
    }
    const clientPublicKeyB64 = encodePublicKeyB64(keyPair.publicKey);
    const clientNonceB64 = encodeBase64(clientNonce);
    const relayHostId = options.relayHostId;
    const hello: E2eeV2Hello =
      options.transport === 'relay' && relayHostId !== undefined
        ? buildRelayHello({
            clientPublicKeyB64: clientPublicKeyB64,
            clientNonceB64: clientNonceB64,
            relayHostId: relayHostId
          })
        : buildDirectHello({
            clientPublicKeyB64: clientPublicKeyB64,
            clientNonceB64: clientNonceB64
          });

    // The pinned key arrives as canonical base64 in the pairing offer; decode it
    // eagerly so a malformed offer fails here rather than at the first frame.
    const pinned = decodeCanonicalBase64(options.desktopPublicKeyB64);
    if (pinned === null || pinned.length !== 32) {
      throw new Error('Invalid desktop public key in pairing offer');
    }
    return new E2eeV2ClientSession(keyPair.secretKey, pinned, hello);
  }

  /** The exact bytes to send on the wire as the opening frame. */
  encodeHelloText(): string {
    return encodeHello(this.hello);
  }

  /**
   * Validates the desktop's `e2ee_ready` and derives the key schedule.
   * Returns false — leaving the session unusable — on any mismatch.
   */
  acceptReady(readyValue: Object): boolean {
    const handshake: E2eeV2ValidatedHandshake | null = validateReady(this.hello, readyValue);
    if (handshake === null) {
      return false;
    }
    if (!publicKeysEqual(handshake.desktopPublicKey, this.pinnedDesktopPublicKey)) {
      return false;
    }
    this.schedule = deriveE2eeV2KeySchedule({
      sharedSecret: boxBefore(this.clientSecretKey, this.pinnedDesktopPublicKey),
      transcript: handshake.transcript,
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    });
    this.transcriptHashB64Value = encodeBase64(this.schedule.transcriptHash);
    return true;
  }

  get transcriptHashB64(): string {
    if (this.transcriptHashB64Value === '') {
      throw new Error('E2EE v2 ready has not been accepted');
    }
    return this.transcriptHashB64Value;
  }

  get isReady(): boolean {
    return this.schedule !== null;
  }

  /** Opens a base64 text frame. Null means tampering, replay or a bad position. */
  openText(frameB64: string): string | null {
    const frame = decodeCanonicalBase64(frameB64);
    if (frame === null) {
      return null;
    }
    const plaintext = this.open(frame, E2EE_V2_PAYLOAD_KIND_TEXT);
    return plaintext === null ? null : decodeUtf8(plaintext);
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    return this.open(frame, E2EE_V2_PAYLOAD_KIND_BINARY);
  }

  /** Seals a JSON-RPC text frame into base64 for the wire. */
  sealText(plaintext: string): string {
    return encodeBase64(this.seal(encodeUtf8(plaintext), E2EE_V2_PAYLOAD_KIND_TEXT));
  }

  sealBinary(plaintext: Uint8Array): Uint8Array {
    return this.seal(plaintext, E2EE_V2_PAYLOAD_KIND_BINARY);
  }

  private open(frame: Uint8Array, payloadKind: string): Uint8Array | null {
    const schedule = this.schedule;
    if (schedule === null) {
      return null;
    }
    const plaintext = openE2eeV2Frame({
      frame: frame,
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: E2EE_V2_DIRECTION_DESKTOP_TO_MOBILE,
      payloadKind: payloadKind,
      expectedCounter: this.inboundCounter
    });
    if (plaintext !== null) {
      this.inboundCounter++;
    }
    return plaintext;
  }

  private seal(plaintext: Uint8Array, payloadKind: string): Uint8Array {
    const schedule = this.schedule;
    if (schedule === null) {
      throw new Error('E2EE v2 ready has not been accepted');
    }
    const frame = sealE2eeV2Frame({
      payload: plaintext,
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: E2EE_V2_DIRECTION_MOBILE_TO_DESKTOP,
      payloadKind: payloadKind,
      counter: this.outboundCounter
    });
    this.outboundCounter++;
    return frame;
  }
}

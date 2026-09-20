/*
 * The E2EE v2 channel state machine for one socket.
 *
 *   awaiting-ready        → hello sent, waiting for the host's e2ee_ready
 *   awaiting-authenticated → ready accepted, e2ee_auth sent, waiting for the ack
 *   ready                 → application frames flow in both directions
 *
 * Nothing above this layer may write to the socket: `sendText`/`sendBinary` only
 * accept while `ready`, so an application frame can never be emitted in the clear
 * or before the host has proven it holds the same session keys.
 *
 * The state is per socket. `dispose()` bumps a generation counter, which makes
 * every in-flight continuation from the old socket a no-op — a late binary frame
 * that needs async unwrapping cannot leak into the replacement socket's state.
 */
import { concatBytes } from '../core/bytes/Bytes';
import { encodeUtf8 } from '../core/bytes/Utf8';
import { hasExactKeys, parseJsonRecord, asString, asNumber } from '../core/json/JsonValue';
import { E2eeV2ClientSession } from '../core/e2ee/E2eeV2ClientSession';
import { OutboundBackpressureQueue, OutboundOverflowEvidence } from '../core/rpc/OutboundQueue';

export const E2EE_V2_CHANNEL_STATE_AWAITING_READY = 'awaiting-ready';
export const E2EE_V2_CHANNEL_STATE_AWAITING_AUTHENTICATED = 'awaiting-authenticated';
export const E2EE_V2_CHANNEL_STATE_READY = 'ready';

/** The host refused the device token; retrying with the same token cannot help. */
export class E2eeV2AuthenticationError extends Error {
  constructor() {
    super('E2EE device authentication rejected');
  }
}

/** The minimal socket surface the channel needs; a HarmonyOS adapter implements it. */
export interface E2eeV2Socket {
  /** Matches the platform's OPEN readyState constant. */
  readonly openState: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(frame: string | ArrayBuffer): void;
}

/** One outbound frame, kept in its plaintext form until it reaches the wire. */
interface OutboundItem {
  binary: boolean;
  text: string;
  bytes: Uint8Array | null;
}

export interface E2eeV2PhysicalChannelOptions {
  session: E2eeV2ClientSession;
  socket: E2eeV2Socket;
  deviceToken: string;
  /** Unwraps a platform binary payload into bytes; null when it is not binary. */
  decodeBinary: (raw: string | ArrayBuffer) => Promise<Uint8Array | null>;
  onAuthenticated: () => void;
  onText: (plaintext: string) => void;
  onBinary: (plaintext: Uint8Array) => void;
  onError: (error: Error) => void;
}

export class E2eeV2PhysicalChannel {
  private readonly session: E2eeV2ClientSession;
  private readonly socket: E2eeV2Socket;
  private readonly deviceToken: string;
  private readonly decodeBinary: (raw: string | ArrayBuffer) => Promise<Uint8Array | null>;
  private readonly onAuthenticated: () => void;
  private readonly onText: (plaintext: string) => void;
  private readonly onBinary: (plaintext: Uint8Array) => void;
  private readonly onError: (error: Error) => void;
  private readonly outboundQueue: OutboundBackpressureQueue<OutboundItem>;

  private state: string = E2EE_V2_CHANNEL_STATE_AWAITING_READY;
  private generation: number = 0;
  private inboundChain: Promise<void> = Promise.resolve();

  constructor(options: E2eeV2PhysicalChannelOptions) {
    this.session = options.session;
    this.socket = options.socket;
    this.deviceToken = options.deviceToken;
    this.decodeBinary = options.decodeBinary;
    this.onAuthenticated = options.onAuthenticated;
    this.onText = options.onText;
    this.onBinary = options.onBinary;
    this.onError = options.onError;

    this.outboundQueue = new OutboundBackpressureQueue<OutboundItem>({
      // Why: encryption happens only once an admitted item reaches the wire, so a
      // bounded-queue rejection cannot burn an ordered v2 counter.
      send: (item: OutboundItem) => {
        if (item.binary) {
          const bytes = item.bytes;
          if (bytes !== null) {
            this.socket.send(exactBuffer(bytes));
          }
        } else {
          this.socket.send(this.session.sealText(item.text));
        }
      },
      byteLengthOf: (item: OutboundItem) => {
        const payloadBytes = item.binary
          ? (item.bytes === null ? 0 : item.bytes.length)
          : encodeUtf8(item.text).length;
        // 82 = nonce(24) + tag(16) + header(42): the per-frame seal overhead.
        return payloadBytes + 82;
      },
      getBufferedAmount: () => this.socket.bufferedAmount,
      isWritable: () => this.socket.readyState === this.socket.openState,
      // The bound that tripped and the backlog it held, because the connection
      // log is the only diagnostic a phone user can reach.
      onOverflow: (evidence: OutboundOverflowEvidence) =>
        this.onError(
          new Error(
            `E2EE v2 outbound buffer overflow (${evidence.cap}): ` +
              `${evidence.queuedBytes}B/${evidence.maxQueuedBytes}B, ` +
              `${evidence.queuedFrames}/${evidence.maxQueuedFrames} frames`
          )
        )
    });
  }

  /** Sends the plaintext hello. The only frame written before authentication. */
  start(): void {
    this.socket.send(JSON.stringify(this.session.hello));
  }

  /**
   * Feeds one inbound frame through the state machine. Messages are chained so
   * two frames can never be processed concurrently, which would reorder them
   * relative to their counters.
   */
  handleMessage(raw: string | ArrayBuffer): Promise<void> {
    const generation = this.generation;
    this.inboundChain = this.inboundChain
      .then(() => this.processMessage(raw, generation))
      .catch((error: Object) => {
        if (generation === this.generation) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    return this.inboundChain;
  }

  /** Sends an application text frame; false when the channel is not ready. */
  sendText(plaintext: string): boolean {
    const item: OutboundItem = { binary: false, text: plaintext, bytes: null };
    return this.enqueueReady(item);
  }

  /** Sends an application binary frame; false when the channel is not ready. */
  sendBinary(plaintext: Uint8Array): boolean {
    const item: OutboundItem = { binary: true, text: '', bytes: plaintext };
    return this.enqueueReady(item);
  }

  dispose(): void {
    this.generation++;
    this.outboundQueue.dispose();
  }

  private enqueueReady(item: OutboundItem): boolean {
    if (this.state !== E2EE_V2_CHANNEL_STATE_READY) {
      return false;
    }
    this.outboundQueue.enqueue(item);
    return true;
  }

  private async processMessage(raw: string | ArrayBuffer, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    if (this.state === E2EE_V2_CHANNEL_STATE_AWAITING_READY) {
      this.acceptReady(raw);
      return;
    }

    // From here on the host's frames are E2EE-sealed; a plaintext frame is a
    // protocol violation, not something to fall back to.
    let plaintextText: string | null = null;
    let plaintextBytes: Uint8Array | null = null;
    if (typeof raw === 'string') {
      plaintextText = this.session.openText(raw);
    } else {
      plaintextBytes = await this.openBinary(raw, generation);
    }
    if (generation !== this.generation) {
      return;
    }
    if (plaintextText === null && plaintextBytes === null) {
      return;
    }

    if (this.state === E2EE_V2_CHANNEL_STATE_AWAITING_AUTHENTICATED) {
      if (plaintextText === null) {
        throw new Error('Invalid E2EE v2 authenticated response');
      }
      if (isAuthenticationRejection(plaintextText)) {
        throw new E2eeV2AuthenticationError();
      }
      if (!this.isAuthenticated(plaintextText)) {
        throw new Error('Invalid E2EE v2 authenticated response');
      }
      this.state = E2EE_V2_CHANNEL_STATE_READY;
      this.onAuthenticated();
      return;
    }

    if (plaintextText !== null) {
      this.onText(plaintextText);
    } else if (plaintextBytes !== null) {
      this.onBinary(plaintextBytes);
    }
  }

  private acceptReady(raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') {
      throw new Error('Expected a plaintext E2EE v2 ready');
    }
    const ready = parseJsonRecord(raw);
    if (ready === null) {
      throw new Error('Invalid E2EE v2 ready JSON');
    }
    if (!this.session.acceptReady(ready)) {
      throw new Error('Invalid E2EE v2 ready');
    }
    this.state = E2EE_V2_CHANNEL_STATE_AWAITING_AUTHENTICATED;
    // The auth frame is built here but sealed and ordered by the queue, so it
    // cannot overtake a frame the caller submitted earlier.
    const auth: Record<string, Object> = {};
    auth.type = 'e2ee_auth';
    auth.v = 2;
    auth.transcriptHashB64 = this.session.transcriptHashB64;
    auth.deviceToken = this.deviceToken;
    const item: OutboundItem = { binary: false, text: JSON.stringify(auth), bytes: null };
    this.outboundQueue.enqueue(item);
  }

  private async openBinary(raw: ArrayBuffer, generation: number): Promise<Uint8Array | null> {
    const bytes = await this.decodeBinary(raw);
    if (bytes === null || generation !== this.generation) {
      return null;
    }
    return this.session.openBinary(bytes);
  }

  private isAuthenticated(plaintext: string): boolean {
    const message = parseJsonRecord(plaintext);
    if (message === null) {
      return false;
    }
    // Exact key set: a host that adds a field must not be silently accepted.
    if (!hasExactKeys(message, ['transcriptHashB64', 'type', 'v'])) {
      return false;
    }
    return (
      asString(message.type) === 'e2ee_authenticated' &&
      asNumber(message.v) === 2 &&
      asString(message.transcriptHashB64) === this.session.transcriptHashB64
    );
  }
}

function isAuthenticationRejection(plaintext: string): boolean {
  const message = parseJsonRecord(plaintext);
  if (message === null) {
    return false;
  }
  return asString(message.type) === 'e2ee_error';
}

/**
 * Platform send APIs take an ArrayBuffer, but a sealed frame may be a view into
 * a larger buffer; sending `view.buffer` as-is would leak the neighbouring bytes,
 * so the view is copied when it does not already span its buffer exactly.
 */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

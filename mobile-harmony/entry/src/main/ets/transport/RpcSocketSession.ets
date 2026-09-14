/*
 * One dial attempt: owns the socket, the connect/handshake deadlines, and the
 * E2EE channel that turns it into an authenticated RPC transport.
 *
 * Deadlines are separate on purpose. A socket that never opens is an
 * endpoint/network problem; a socket that opens but never completes the
 * handshake is a protocol or credential problem, and the two lead the user to
 * different fixes.
 */
import { parseRpcResponseText, RpcResponse } from '../core/rpc/RpcProtocol';
import {
  E2eeV2AuthenticationError,
  E2eeV2PhysicalChannel,
  E2eeV2Socket
} from './E2eeV2PhysicalChannel';
import { E2eeV2ClientSession } from '../core/e2ee/E2eeV2ClientSession';

export const CONNECT_TIMEOUT_MS = 12_000;
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Platform socket events, normalized away from any one runtime's WebSocket API. */
export interface RpcSocketHandle extends E2eeV2Socket {
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onClose(handler: (code: number) => void): void;
  onError(handler: (message: string) => void): void;
  close(): void;
}

export interface RpcSocketPreflight {
  endpoint: string;
  deviceToken: string;
  getCurrentSocket: () => RpcSocketHandle | null;
  getReconnectAttempt: () => number;
  isIntentionallyClosed: () => boolean;
  onHandshakeStarted: () => void;
  onAuthenticated: (session: RpcSocketSession) => void;
  onAuthRejected: (reason: string) => void;
  onRpcResponse: (response: RpcResponse) => void;
  onBinary: (bytes: Uint8Array) => void;
  onAnyInbound: (receivedAt: number) => void;
  onClosed: (session: RpcSocketSession, closeCode: number) => void;
  onForcedClose: (session: RpcSocketSession) => void;
  /** Emits a connection-log line: level, message, detail, code. */
  emitLog: (level: string, message: string, detail: string, code: string) => void;
}

export class RpcSocketSession {
  readonly socket: RpcSocketHandle;
  readonly constructedAt: number = Date.now();

  private readonly preflight: RpcSocketPreflight;
  private readonly channel: E2eeV2PhysicalChannel;
  private authenticated: boolean = false;
  private lastInboundAt: number = 0;
  private connectTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private disposed: boolean = false;

  constructor(preflight: RpcSocketPreflight, socket: RpcSocketHandle, session: E2eeV2ClientSession) {
    this.preflight = preflight;
    this.socket = socket;
    this.channel = new E2eeV2PhysicalChannel({
      session: session,
      socket: socket,
      deviceToken: preflight.deviceToken,
      decodeBinary: (raw: string | ArrayBuffer) => this.decodeBinary(raw),
      onAuthenticated: () => this.handleAuthenticated(),
      onText: (plaintext: string) => this.handleText(plaintext),
      onBinary: (plaintext: Uint8Array) => {
        this.noteInbound();
        this.preflight.onBinary(plaintext);
      },
      onError: (error: Error) => this.handleChannelError(error)
    });
    this.attachHandlers();
    this.armConnectTimeout();
  }

  /** Writes an application request through the sealed channel. */
  sendEncrypted(request: Object): boolean {
    if (this.socket.readyState !== this.socket.openState) {
      return false;
    }
    return this.channel.sendText(JSON.stringify(request));
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getLastInboundAt(): number {
    return this.lastInboundAt;
  }

  close(): void {
    this.clearTimers();
    this.channel.dispose();
    this.socket.close();
  }

  /** Detaches this session without closing the socket (used on forced teardown). */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.channel.dispose();
  }

  clearTimers(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private attachHandlers(): void {
    this.socket.onOpen(() => {
      if (this.disposed) {
        return;
      }
      this.clearConnectTimer();
      this.preflight.onHandshakeStarted();
      this.preflight.emitLog('success', 'WebSocket open', 'Starting E2EE handshake', '');
      try {
        // Only the hello is plaintext; everything after it is sealed.
        this.channel.start();
      } catch (error) {
        this.preflight.onForcedClose(this);
        return;
      }
      this.preflight.emitLog('info', 'Sent e2ee_hello', 'Awaiting host e2ee_ready', '');
      this.armHandshakeTimeout();
    })

    this.socket.onMessage((data: string | ArrayBuffer) => {
      if (this.disposed) {
        return;
      }
      this.noteInbound();
      // Fire-and-forget: the channel serializes its own inbound chain.
      this.channel.handleMessage(data);
    })

    this.socket.onClose((code: number) => {
      if (this.disposed) {
        return;
      }
      this.clearTimers();
      this.preflight.onClosed(this, code);
    })

    this.socket.onError((message: string) => {
      if (this.disposed) {
        return;
      }
      this.preflight.emitLog('error', 'WebSocket error', message, 'socket-closed');
    })
  }

  private handleAuthenticated(): void {
    this.clearHandshakeTimer();
    this.authenticated = true;
    this.preflight.emitLog('success', 'E2EE authenticated', '', 'direct-connected');
    this.preflight.onAuthenticated(this);
  }

  private handleChannelError(error: Error): void {
    if (this.disposed) {
      return;
    }
    if (error instanceof E2eeV2AuthenticationError) {
      this.clearHandshakeTimer();
      // The host rejected this device token: reconnecting with it cannot help.
      this.preflight.onAuthRejected('Unauthorized — pairing may be revoked');
      return;
    }
    // A protocol failure otherwise reaches the user as a bare "WebSocket
    // closed", which is indistinguishable from a network drop. Naming it is the
    // difference between a five-minute and a one-hour diagnosis on a device.
    this.preflight.emitLog('error', 'E2EE handshake failed', error.message, 'handshake-failed');
    this.preflight.onForcedClose(this);
  }

  private handleText(plaintext: string): void {
    this.noteInbound();
    const response = parseRpcResponseText(plaintext);
    if (response !== null) {
      this.preflight.onRpcResponse(response)
    }
  }

  private noteInbound(): void {
    const receivedAt = Date.now();
    this.lastInboundAt = receivedAt;
    this.preflight.onAnyInbound(receivedAt);
  }

  /** Binary payloads arrive as an ArrayBuffer; the channel wants exact bytes. */
  private async decodeBinary(raw: string | ArrayBuffer): Promise<Uint8Array | null> {
    if (typeof raw === 'string') {
      return null;
    }
    if (raw instanceof ArrayBuffer) {
      return new Uint8Array(raw);
    }
    return null;
  }

  private armConnectTimeout(): void {
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      // Still the current dial and still connecting: the transport never opened.
      if (
        this.preflight.getCurrentSocket() === this.socket &&
        this.socket.readyState === 0 &&
        !this.preflight.isIntentionallyClosed()
      ) {
        this.preflight.emitLog(
          'error',
          'WebSocket connect timeout',
          `No TCP/WS handshake within ${CONNECT_TIMEOUT_MS / 1000}s — endpoint unreachable?`,
          'connect-timeout'
        )
        this.preflight.onForcedClose(this)
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private armHandshakeTimeout(): void {
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.preflight.getCurrentSocket() !== this.socket || this.authenticated) {
        return;
      }
      this.preflight.emitLog(
        'error',
        'Handshake timeout',
        `No e2ee_ready/e2ee_authenticated within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
        'handshake-timeout'
      )
      this.preflight.onForcedClose(this)
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null;
    }
  }
}

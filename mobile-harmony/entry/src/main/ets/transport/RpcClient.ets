/*
 * The direct (LAN/tailnet) RPC client: one live socket plus the four policies
 * that keep it usable — authenticate, keep-alive, reconnect, and replay.
 *
 * The class is a pure orchestrator. Every decision it makes is delegated to a
 * module that has its own tests (`ReconnectSchedule`, `LivenessWatchdog`,
 * `RpcStreamRegistry`, `ConnectionStateStore`); what lives here is the wiring
 * and the ordering that nothing else can own:
 *
 *   open → socket open → handshake → authenticate → advertise capabilities
 *        → publish `connected` → replay parked subscriptions
 *
 * `connected` is published only after the capability advisory has settled, so a
 * caller that awaited `waitForConnected` can immediately issue a request that
 * the host is guaranteed to have been told how to read.
 */
import { ConnectionLog, ConnectionLogEntry } from '../core/rpc/ConnectionLog';
import { ConnectionStateStore } from '../core/rpc/ConnectionStateStore';
import {
  CONNECTION_STATE_AUTH_FAILED,
  CONNECTION_STATE_CONNECTED,
  CONNECTION_STATE_CONNECTING,
  CONNECTION_STATE_DISCONNECTED,
  CONNECTION_STATE_HANDSHAKING,
  CONNECTION_STATE_RECONNECTING
} from '../core/rpc/ConnectionStateStore';
import { negotiateMobileRuntimeCapabilities } from '../core/rpc/CapabilityNegotiation';
import {
  LIVENESS_IDLE_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  LivenessTimeoutEvidence,
  LivenessWatchdog,
  MISSED_PROBE_LIMIT
} from '../core/rpc/LivenessWatchdog';
import {
  RPC_RECONNECT_ATTEMPT_LIMIT,
  ReconnectSchedule
} from '../core/rpc/ReconnectSchedule';
import { RpcRequestTracker, SendRequestOptions } from '../core/rpc/RpcRequestTracker';
import { RpcResponse } from '../core/rpc/RpcProtocol';
import {
  RpcStreamRegistry,
  RpcStreamSubscribeOptions,
  RpcStreamingListener
} from '../core/rpc/RpcStreamRegistry';
import { RpcSocketPreflight, RpcSocketSession } from './RpcSocketSession';

const LIVENESS_REQUEST_ID_PREFIX = 'mobile-liveness-';
const AUTH_RETRY_BUDGET = 3;
const UNAUTHORIZED_CLOSE_CODE = 4001;
/** A dial older than this predates the foreground signal and may be dead. */
const STALE_DIAL_AGE_MS = 2_000;
const CAPABILITY_ADVISORY_TIMEOUT_MS = 5_000;

/** Platform layer: opens one socket. Implemented by the HarmonyOS adapter. */
export interface RpcSocketSessionFactory {
  open(preflight: RpcSocketPreflight): RpcSocketSession | null;
}

export interface RpcClientOptions {
  endpoint: string;
  deviceToken: string;
  serverPublicKeyB64: string;
  factory: RpcSocketSessionFactory;
  onStateChange: ((state: string) => void) | null;
  onLog: ((entry: ConnectionLogEntry) => void) | null;
}

export class RpcClient {
  private readonly endpoint: string;
  private readonly deviceToken: string;
  private readonly factory: RpcSocketSessionFactory;
  private readonly connectionState: ConnectionStateStore;
  private readonly reconnect: ReconnectSchedule;
  private readonly requests: RpcRequestTracker;
  private readonly streams: RpcStreamRegistry;
  private readonly liveness: LivenessWatchdog;
  private readonly log: ConnectionLog;

  private socketSession: RpcSocketSession | null = null;
  private livenessSession: RpcSocketSession | null = null;
  private readonly handledSessions: Set<RpcSocketSession> = new Set();
  private requestCounter: number = 0;
  private intentionallyClosed: boolean = false;
  private authenticationGeneration: number = 0;
  private authRejectionCount: number = 0;
  private dialStartedAt: number = 0;

  constructor(options: RpcClientOptions) {
    this.endpoint = options.endpoint;
    this.deviceToken = options.deviceToken;
    this.factory = options.factory;
    this.log = new ConnectionLog(options.endpoint, options.onLog);

    this.reconnect = new ReconnectSchedule({
      openConnection: () => this.openConnection(),
      rejectConnectWaiters: (reason: string) => this.connectionState.rejectWaiters(reason),
      onScheduled: (delayMs: number, attempt: number, trickle: boolean) => {
        this.log.emit(
          'info',
          'Reconnect scheduled',
          `attempt ${attempt} in ${delayMs}ms${trickle ? ' (trickle)' : ''}`,
          'retry-scheduled'
        );
      }
    });

    this.connectionState = new ConnectionStateStore({
      endpoint: options.endpoint,
      getReconnectAttempt: () => this.reconnect.getAttempt(),
      isClosed: () => this.intentionallyClosed,
      emitLog: (level: string, message: string, detail: string, code: string) =>
        this.log.emit(level, message, detail, code)
    });
    if (options.onStateChange !== null) {
      this.connectionState.addListener(options.onStateChange);
    }

    this.streams = new RpcStreamRegistry({
      nextId: () => this.nextId(),
      deviceToken: options.deviceToken,
      isConnected: () => this.getState() === CONNECTION_STATE_CONNECTED,
      sendEncrypted: (request) => this.sendEncrypted(request)
    });

    this.requests = new RpcRequestTracker({
      nextId: () => this.nextId(),
      deviceToken: options.deviceToken,
      isConnected: () => this.getState() === CONNECTION_STATE_CONNECTED,
      waitForConnected: (timeoutMs?: number) => this.waitForConnected(timeoutMs),
      sendEncrypted: (request) => this.sendEncrypted(request)
    });

    this.liveness = new LivenessWatchdog({
      transport: 'direct',
      sendProbe: (identity: Object) => this.sendLivenessProbe(identity),
      terminate: (identity: Object) => {
        if (identity === this.livenessSession && this.socketSession === this.livenessSession) {
          if (this.livenessSession !== null) {
            this.forceClose(this.livenessSession);
          }
        }
      },
      onTimeout: (evidence: LivenessTimeoutEvidence) => {
        this.log.emit(
          'warn',
          'Liveness probe unanswered',
          `${evidence.reason} (${evidence.missedProbes}/${evidence.missedProbeLimit} missed, last inbound ${evidence.lastInboundAgeMs}ms ago)`,
          'liveness-timeout'
        );
      },
      idleProbeMs: LIVENESS_IDLE_MS,
      probeTimeoutMs: LIVENESS_PROBE_TIMEOUT_MS,
      missedProbeLimit: MISSED_PROBE_LIMIT,
      now: () => Date.now(),
      setTimer: (callback: () => void, delayMs: number): number => setTimeout(callback, delayMs),
      clearTimer: (handle: number): void => clearTimeout(handle)
    });

    this.openConnection();
  }

  sendRequest(
    method: string,
    params: Object | undefined,
    options?: SendRequestOptions
  ): Promise<RpcResponse> {
    return this.requests.sendRequest(method, params, options);
  }

  subscribe(
    method: string,
    params: Record<string, Object>,
    onData: RpcStreamingListener,
    options?: RpcStreamSubscribeOptions
  ): () => void {
    return this.streams.subscribe(method, params, onData, options);
  }

  updateTerminalSubscriptionViewport(terminal: string, cols: number, rows: number): void {
    this.streams.updateTerminalViewport(terminal, cols, rows);
  }

  getState(): string {
    return this.connectionState.get();
  }

  getReconnectAttempt(): number {
    return this.reconnect.getAttempt();
  }

  getLastConnectedAt(): number {
    return this.connectionState.getLastConnectedAt();
  }

  getLastInboundAt(): number {
    return this.liveness.getLastInboundAt();
  }

  getHost(): string {
    return this.log.getHost();
  }

  connectionLogEntries(): ConnectionLogEntry[] {
    return this.log.entriesSnapshot();
  }

  onStateChange(listener: (state: string) => void): () => void {
    return this.connectionState.addListener(listener);
  }

  /** App resumed: verify a live link, or stop waiting on a dial that went stale. */
  notifyForeground(): void {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.getState() === CONNECTION_STATE_CONNECTED) {
      this.log.emit('info', 'App foregrounded', 'Probing the live connection', 'foreground');
      if (this.livenessSession !== null) {
        this.liveness.probeNow(this.livenessSession);
      }
      return;
    }
    const dialing = this.socketSession;
    const dialAgeMs = Date.now() - this.dialStartedAt;
    let abandoned = false;
    if (dialing !== null && isStaleForegroundDial(this.getState(), dialAgeMs)) {
      this.log.emit(
        'info',
        'Foregrounded mid-dial',
        `Abandoning a ${dialAgeMs}ms-old dial`,
        'stale-dial'
      );
      this.forceClose(dialing);
      abandoned = true;
    }
    if (this.getState() === CONNECTION_STATE_RECONNECTING) {
      this.log.emit(
        'info',
        'Foregrounded while reconnecting',
        `Restarting the reconnect loop (attempt ${this.getReconnectAttempt()})`,
        'foreground'
      );
      this.reconnect.redialNow(!abandoned);
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.reconnect.cancel();
    const session = this.socketSession;
    if (session !== null) {
      session.clearTimers();
    }
    if (this.livenessSession !== null) {
      this.liveness.stop(this.livenessSession);
      this.livenessSession = null;
    }
    if (session !== null) {
      this.handledSessions.add(session);
      session.close();
    }
    this.socketSession = null;
    this.connectionState.publish(CONNECTION_STATE_DISCONNECTED);
    this.requests.rejectAll('Client closed', true);
  }

  // -------------------------------------------------------------------------
  // Dial + handshake
  // -------------------------------------------------------------------------

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return;
    }
    this.connectionState.publish(CONNECTION_STATE_CONNECTING);
    this.dialStartedAt = Date.now();
    const session = this.factory.open(this.buildPreflight());
    this.socketSession = session;
  }

  private buildPreflight(): RpcSocketPreflight {
    return {
      endpoint: this.endpoint,
      deviceToken: this.deviceToken,
      getCurrentSocket: () => (this.socketSession === null ? null : this.socketSession.socket),
      getReconnectAttempt: () => this.reconnect.getAttempt(),
      isIntentionallyClosed: () => this.intentionallyClosed,
      onHandshakeStarted: () => this.connectionState.publish(CONNECTION_STATE_HANDSHAKING),
      onAuthenticated: (session: RpcSocketSession) => this.handleAuthenticated(session),
      onAuthRejected: (reason: string) => this.handleAuthRejected(reason),
      onRpcResponse: (response: RpcResponse) => this.handleRpcResponse(response),
      onBinary: (bytes: Uint8Array) => this.streams.handleBinary(bytes),
      onAnyInbound: () => {
        // The watchdog reads `lastInboundAt` from its own counter; nothing to do.
      },
      onClosed: (session: RpcSocketSession, closeCode: number) =>
        this.handleSocketClosed(session, closeCode),
      onForcedClose: (session: RpcSocketSession) => this.forceClose(session),
      emitLog: (level: string, message: string, detail: string, code: string) =>
        this.log.emit(level, message, detail, code)
    };
  }

  private handleAuthenticated(session: RpcSocketSession): void {
    this.livenessSession = session;
    this.liveness.start(session);
    const generation = ++this.authenticationGeneration;
    negotiateMobileRuntimeCapabilities({
      sendRequest: (method: string, params: Object) =>
        this.requests.sendAuthenticatedRequest(method, params, CAPABILITY_ADVISORY_TIMEOUT_MS),
      isCurrent: () =>
        this.socketSession === session && this.authenticationGeneration === generation,
      onReady: () => {
        this.reconnect.authenticated();
        this.authRejectionCount = 0;
        this.connectionState.publish(CONNECTION_STATE_CONNECTED);
        this.streams.replayAfterAuthentication();
      },
      onFailure: () => this.forceClose(session),
      emitLog: (level: string, message: string, detail: string, code: string) =>
        this.log.emit(level, message, detail, code)
    });
  }

  private handleRpcResponse(response: RpcResponse): void {
    if (response.id.indexOf(LIVENESS_REQUEST_ID_PREFIX) === 0) {
      return;
    }
    if (!response.ok && response.error?.code === 'unauthorized') {
      this.handleAuthRejected('Unauthorized — pairing may be revoked');
      return;
    }
    if (!this.streams.handleResponse(response)) {
      this.requests.resolve(response);
    }
  }

  private handleAuthRejected(reason: string): void {
    this.stopLiveness();
    this.authRejectionCount++;
    if (this.authRejectionCount < AUTH_RETRY_BUDGET) {
      this.log.emit(
        'warn',
        'Authentication rejected',
        `Retrying (${this.authRejectionCount}/${AUTH_RETRY_BUDGET})`,
        'authentication-rejected'
      );
      this.retryAuthentication(reason);
      return;
    }
    this.log.emit(
      'error',
      'Authentication rejected',
      'Retry budget exhausted — pairing must be renewed',
      'authentication-rejected'
    );
    this.latchAuthenticationFailure(reason);
  }

  private retryAuthentication(reason: string): void {
    const closing = this.socketSession;
    this.socketSession = null;
    if (closing !== null) {
      this.handledSessions.add(closing);
      closing.clearTimers();
      closing.close();
    }
    this.streams.markForReplay();
    this.requests.rejectAll(reason, false);
    this.connectionState.publish(CONNECTION_STATE_RECONNECTING);
    this.reconnect.schedule();
  }

  private latchAuthenticationFailure(reason: string): void {
    this.intentionallyClosed = true;
    const session = this.socketSession;
    if (session !== null) {
      this.handledSessions.add(session);
      session.clearTimers();
      session.close();
    }
    this.socketSession = null;
    this.connectionState.publish(CONNECTION_STATE_AUTH_FAILED);
    this.requests.rejectAll(reason, false);
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private forceClose(session: RpcSocketSession): void {
    session.close();
    if (this.socketSession === session) {
      this.handleSocketClosed(session, undefined);
    }
  }

  private handleSocketClosed(session: RpcSocketSession, closeCode?: number): void {
    if (this.handledSessions.has(session) || this.socketSession !== session) {
      return;
    }
    this.handledSessions.add(session);
    session.clearTimers();
    if (this.livenessSession === session) {
      this.stopLiveness();
    }
    this.socketSession = null;
    this.streams.markForReplay();

    if (this.intentionallyClosed) {
      this.connectionState.publish(CONNECTION_STATE_DISCONNECTED);
      this.requests.rejectAll('Connection closed', true);
      return;
    }
    if (closeCode === UNAUTHORIZED_CLOSE_CODE) {
      this.handleAuthRejected('Unauthorized — pairing may be revoked');
      return;
    }
    this.log.emit(
      'warn',
      'WebSocket closed',
      `${
        closeCode === undefined ? 'Close code unavailable' : `Close code ${closeCode}`
      }; reconnect scheduled`,
      'socket-closed'
    );
    this.requests.rejectAll('Connection interrupted', true);
    this.connectionState.publish(CONNECTION_STATE_RECONNECTING);
    this.reconnect.schedule();
  }

  private stopLiveness(): void {
    if (this.livenessSession !== null) {
      this.liveness.stop(this.livenessSession);
      this.livenessSession = null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private sendEncrypted(request: Object): boolean {
    const session = this.socketSession;
    if (session !== null) {
      return session.sendEncrypted(request);
    }
    this.log.emit(
      'warn',
      'Send dropped',
      `No authenticated channel (state: ${this.getState()})`,
      'send-dropped'
    );
    return false;
  }

  private sendLivenessProbe(identity: Object): boolean {
    if (identity !== this.livenessSession || this.getState() !== CONNECTION_STATE_CONNECTED) {
      return false;
    }
    const request: Record<string, Object> = {};
    request.id = `${LIVENESS_REQUEST_ID_PREFIX}${this.nextId()}`;
    request.deviceToken = this.deviceToken;
    request.method = 'status.get';
    return this.sendEncrypted(request);
  }

  private waitForConnected(timeoutMs?: number): Promise<void> {
    if (
      this.getState() === CONNECTION_STATE_RECONNECTING &&
      this.getReconnectAttempt() >= RPC_RECONNECT_ATTEMPT_LIMIT
    ) {
      return Promise.reject(new Error('Connection retry limit reached'));
    }
    return this.connectionState.waitForConnected(timeoutMs);
  }

  private nextId(): string {
    this.requestCounter++;
    return `rpc-${this.requestCounter}-${Date.now()}`;
  }
}

/** A dial that outlived the foreground signal may be sitting on a dead path. */
export function isStaleForegroundDial(state: string, dialAgeMs: number): boolean {
  return (
    (state === CONNECTION_STATE_CONNECTING || state === CONNECTION_STATE_HANDSHAKING) &&
    dialAgeMs >= STALE_DIAL_AGE_MS
  );
}

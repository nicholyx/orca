/*
 * The one place that knows what the link is doing right now.
 *
 * State transitions are the only source of "connected" for everyone else:
 * `waitForConnected` resolves on the transition, never on a timer, so a caller
 * that awaited it can trust the channel is usable when it wakes up.
 *
 * `disconnected` and `auth-failed` fail every waiter, because neither can be
 * fixed by waiting. `auth-failed` is terminal for the pairing; `disconnected`
 * is not (a reconnect may still restore the link), but a waiter cannot tell how
 * long that will take, so it must fail rather than hang.
 */

export const CONNECTION_STATE_DISCONNECTED = 'disconnected';
export const CONNECTION_STATE_CONNECTING = 'connecting';
export const CONNECTION_STATE_HANDSHAKING = 'handshaking';
export const CONNECTION_STATE_CONNECTED = 'connected';
export const CONNECTION_STATE_RECONNECTING = 'reconnecting';
export const CONNECTION_STATE_AUTH_FAILED = 'auth-failed';

interface ConnectWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number | null;
}

export interface ConnectionStateStoreOptions {
  endpoint: string;
  getReconnectAttempt: () => number;
  isClosed: () => boolean;
  /** Emits a connection-log line: level, message, detail, code. */
  emitLog: (level: string, message: string, detail: string, code: string) => void;
}

export class ConnectionStateStore {
  private readonly options: ConnectionStateStoreOptions;
  private state: string = CONNECTION_STATE_DISCONNECTED;
  private lastConnectedAt: number = 0;
  private stateEnteredAt: number = Date.now();
  private readonly listeners: Set<(state: string) => void> = new Set();
  private readonly waiters: ConnectWaiter[] = [];

  constructor(options: ConnectionStateStoreOptions) {
    this.options = options;
  }

  get(): string {
    return this.state;
  }

  getLastConnectedAt(): number {
    return this.lastConnectedAt;
  }

  getStateDweltMs(): number {
    return Date.now() - this.stateEnteredAt;
  }

  publish(next: string): void {
    if (this.state === next) {
      return;
    }
    const previous = this.state;
    const dweltMs = Date.now() - this.stateEnteredAt;
    this.state = next;
    this.stateEnteredAt = Date.now();
    this.options.emitLog(
      'info',
      `Connection ${next}`,
      `${previous} → ${next} after ${dweltMs}ms (attempt ${this.options.getReconnectAttempt()})`,
      'state-change'
    );
    if (next === CONNECTION_STATE_CONNECTED) {
      this.lastConnectedAt = Date.now();
      this.resolveWaiters();
    } else if (next === CONNECTION_STATE_DISCONNECTED || next === CONNECTION_STATE_AUTH_FAILED) {
      this.rejectWaiters(
        next === CONNECTION_STATE_AUTH_FAILED
          ? 'Unauthorized — pairing may be revoked'
          : 'Connection closed'
      );
    }
    const snapshot = Array.from(this.listeners);
    for (let index = 0; index < snapshot.length; index++) {
      snapshot[index](next);
    }
  }

  /** Resolves only once the link is connected; rejects if that can never happen. */
  waitForConnected(timeoutMs?: number): Promise<void> {
    if (this.state === CONNECTION_STATE_CONNECTED) {
      return Promise.resolve();
    }
    if (this.options.isClosed()) {
      return Promise.reject(new Error('Client closed'));
    }
    return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
      const waiter: ConnectWaiter = { resolve: resolve, reject: reject, timeout: null };
      if (timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error('Timed out while connecting to the remote Orca runtime.'));
        }, Math.max(0, timeoutMs));
      }
      this.waiters.push(waiter);
    });
  }

  /** Fails every waiter; used when a retry limit or teardown makes waiting futile. */
  rejectWaiters(reason: string): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (let index = 0; index < pending.length; index++) {
      const waiter = pending[index];
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.reject(new Error(reason));
    }
  }

  addListener(listener: (state: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private removeWaiter(waiter: ConnectWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) {
      this.waiters.splice(index, 1);
    }
  }

  private resolveWaiters(): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (let index = 0; index < pending.length; index++) {
      const waiter = pending[index];
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve();
    }
  }
}

/*
 * Reconnect backoff for the direct socket.
 *
 * Delays grow 0.5s → 60s and then flatten; past the attempt limit the client
 * switches to a slow "trickle" retry instead of giving up, so a laptop that was
 * asleep for an hour still reconnects without a manual nudge. Every delay is
 * reset the moment a handshake authenticates.
 */

const RECONNECT_DELAYS_MS: number[] = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
export const RPC_RECONNECT_ATTEMPT_LIMIT = 12;
const TRICKLE_RECONNECT_DELAY_MS = 90_000;

export interface ReconnectScheduleOptions {
  openConnection: () => void;
  rejectConnectWaiters: (reason: string) => void;
  onScheduled: (delayMs: number, attempt: number, trickle: boolean) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
}

export class ReconnectSchedule {
  private readonly openConnection: () => void;
  private readonly rejectConnectWaiters: (reason: string) => void;
  private readonly onScheduled: (delayMs: number, attempt: number, trickle: boolean) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private attempt: number = 0;
  private timer: number | null = null;

  constructor(options: ReconnectScheduleOptions) {
    this.openConnection = options.openConnection;
    this.rejectConnectWaiters = options.rejectConnectWaiters;
    this.onScheduled = options.onScheduled;
    this.setTimer =
      options.setTimer === undefined
        ? (callback: () => void, delayMs: number): number => setTimeout(callback, delayMs)
        : options.setTimer;
    this.clearTimer =
      options.clearTimer === undefined
        ? (handle: number): void => clearTimeout(handle)
        : options.clearTimer;
  }

  getAttempt(): number {
    return this.attempt;
  }

  /** A successful authentication clears the backoff. */
  authenticated(): void {
    this.attempt = 0;
  }

  schedule(): void {
    const trickle = this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT;
    let delayMs: number;
    if (trickle) {
      delayMs = TRICKLE_RECONNECT_DELAY_MS;
      // Past the limit a reconnect is a slow retry, not a promise: callers
      // waiting on the connection must fail rather than hang.
      this.rejectConnectWaiters('Connection retry limit reached');
    } else {
      const index = Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1);
      delayMs = RECONNECT_DELAYS_MS[index];
      this.attempt++;
    }
    this.onScheduled(delayMs, this.attempt, trickle);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.openConnection();
    }, delayMs);
  }

  /** Reconnects immediately, optionally resetting the attempt counter. */
  redialNow(resetAttempts: boolean): void {
    this.cancel();
    if (resetAttempts) {
      this.attempt = 0;
    }
    this.openConnection();
  }

  hasTimer(): boolean {
    return this.timer !== null;
  }

  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

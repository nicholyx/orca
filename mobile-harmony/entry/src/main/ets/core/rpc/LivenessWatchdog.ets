/*
 * Detects a half-open socket that the platform never reports as closed.
 *
 * A link can stay "open" for minutes after the peer is gone, which looks exactly
 * like a quiet session. The watchdog probes with a normal RPC once the link has
 * been idle, tolerates a few missed probes (probes share the link with real
 * traffic, so a slow moment is not evidence of death), and forces a reconnect
 * only after the miss limit is reached.
 *
 * `lastInboundAt` is a wall-clock stamp rather than a timer deadline so it
 * survives a JS suspension: a backgrounded app can still tell how stale its
 * knowledge of the peer actually is.
 */
export const LIVENESS_IDLE_MS = 20_000;
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000;
export const MISSED_PROBE_LIMIT = 3;

/** Probe was never written / probe went unanswered. */
export const LIVENESS_REASON_PROBE_SEND_FAILED = 'probe-send-failed';
export const LIVENESS_REASON_PROBE_TIMEOUT = 'probe-timeout';

export interface LivenessTimeoutEvidence {
  transport: string;
  reason: string;
  missedProbes: number;
  missedProbeLimit: number;
  lastInboundAgeMs: number;
}

export interface LivenessWatchdogOptions {
  transport: string;
  sendProbe: (identity: Object) => boolean;
  terminate: (identity: Object) => void;
  onTimeout: ((evidence: LivenessTimeoutEvidence) => void) | null;
  /** Null disables idle probing entirely. */
  idleProbeMs: number | null;
  probeTimeoutMs: number;
  missedProbeLimit: number;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
}

export class LivenessWatchdog {
  private readonly transport: string;
  private readonly sendProbe: (identity: Object) => boolean;
  private readonly terminate: (identity: Object) => void;
  private readonly onTimeout: ((evidence: LivenessTimeoutEvidence) => void) | null;
  private readonly idleProbeMs: number | null;
  private readonly probeTimeoutMs: number;
  private readonly missedProbeLimit: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private identity: Object | null = null;
  private timer: number | null = null;
  private probing: boolean = false;
  private missedProbes: number = 0;
  private lastInboundAt: number = 0;

  constructor(options: LivenessWatchdogOptions) {
    this.transport = options.transport;
    this.sendProbe = options.sendProbe;
    this.terminate = options.terminate;
    this.onTimeout = options.onTimeout;
    this.idleProbeMs = options.idleProbeMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
    this.missedProbeLimit = options.missedProbeLimit;
    this.now = options.now;
    this.setTimer = options.setTimer;
    this.clearTimer = options.clearTimer;
  }

  /** Begins watching one socket. Passing a new identity resets all state. */
  start(identity: Object): void {
    this.clearActiveTimer();
    this.identity = identity;
    this.probing = false;
    this.missedProbes = 0;
    this.lastInboundAt = this.now();
    this.armIdle(identity, this.idleProbeMs);
  }

  getLastInboundAt(): number {
    return this.lastInboundAt;
  }

  /** Any authenticated inbound frame counts as proof the peer is alive. */
  noteAuthenticatedInbound(identity: Object): void {
    if (this.identity !== identity) {
      return;
    }
    this.lastInboundAt = this.now();
    if (!this.probing && this.missedProbes === 0) {
      return;
    }
    this.missedProbes = 0;
    this.probing = false;
    this.armIdle(identity, this.idleProbeMs);
  }

  /** Probes immediately, e.g. when the app returns to the foreground. */
  probeNow(identity: Object): void {
    if (this.identity !== identity || this.probing) {
      return;
    }
    this.startProbe(identity);
  }

  stop(identity: Object): void {
    if (this.identity !== identity) {
      return;
    }
    this.clearActiveTimer();
    this.identity = null;
    this.probing = false;
    this.missedProbes = 0;
    this.lastInboundAt = 0;
  }

  private armIdle(identity: Object, delayMs: number | null): void {
    this.clearActiveTimer();
    if (delayMs === null) {
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.identity !== identity) {
        return;
      }
      const idleMs = this.now() - this.lastInboundAt;
      // A timer that fired early (clock skew, suspension) re-arms for the rest.
      if (this.idleProbeMs !== null && idleMs < this.idleProbeMs) {
        const remainder = Math.max(0, this.idleProbeMs - idleMs);
        this.armIdle(identity, Math.max(1, remainder));
      } else {
        this.startProbe(identity);
      }
    }, delayMs);
  }

  private startProbe(identity: Object): void {
    if (this.identity !== identity) {
      return;
    }
    this.clearActiveTimer();
    this.probing = true;
    const sentAt = this.now();
    let sent = false;
    try {
      sent = this.sendProbe(identity);
    } catch (error) {
      sent = false;
    }
    if (!sent) {
      // The probe never reached the wire: nothing about the link is ambiguous.
      this.terminateCurrent(identity, LIVENESS_REASON_PROBE_SEND_FAILED);
      return;
    }
    this.timer = this.setTimer(() => this.handleProbeTimeout(identity, sentAt), this.probeTimeoutMs);
  }

  private handleProbeTimeout(identity: Object, sentAt: number): void {
    this.timer = null;
    if (this.identity !== identity) {
      return;
    }
    const elapsedMs = this.now() - sentAt;
    // A window far longer than the timeout means the timer was delayed, not that
    // the peer is dead — re-probe instead of counting a miss against the socket.
    if (elapsedMs < 0 || elapsedMs > this.probeTimeoutMs * 1.5) {
      this.startProbe(identity);
      return;
    }
    this.missedProbes += 1;
    if (this.missedProbes >= this.missedProbeLimit) {
      this.terminateCurrent(identity, LIVENESS_REASON_PROBE_TIMEOUT);
      return;
    }
    this.startProbe(identity);
  }

  private terminateCurrent(identity: Object, reason: string): void {
    if (this.identity !== identity) {
      return;
    }
    this.clearActiveTimer();
    this.identity = null;
    this.probing = false;
    if (this.onTimeout !== null) {
      const evidence: LivenessTimeoutEvidence = {
        transport: this.transport,
        reason: reason,
        missedProbes: this.missedProbes,
        missedProbeLimit: this.missedProbeLimit,
        lastInboundAgeMs: Math.max(0, this.now() - this.lastInboundAt)
      };
      this.onTimeout(evidence);
    }
    this.terminate(identity);
  }

  private clearActiveTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

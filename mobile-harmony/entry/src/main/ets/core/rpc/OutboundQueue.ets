/*
 * Ordered outbound queue with backpressure, for the E2EE socket.
 *
 * A fast producer over a slow link otherwise balloons the socket's own buffer
 * without bound. Frames are held in order while the socket is over a soft cap
 * and flushed as it drains, so nothing is dropped or reordered. Only exceeding a
 * hard bound — the link is effectively dead — raises `onOverflow`, which the
 * caller answers by tearing the connection down and replaying subscriptions
 * against a fresh authoritative snapshot.
 *
 * Why encryption stays inside `send`: the E2EE v2 counter must only advance for
 * frames that actually reach the wire. Because a rejected enqueue never calls
 * `send`, a bounded-queue rejection cannot burn an ordered counter.
 */
import { isFiniteNumber } from '../json/JsonValue';

const DEFAULT_SOFT_CAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 4096;
const DEFAULT_DRAIN_POLL_MS = 25;

/** Which hard bound tripped. Mirrors `WsOutboundOverflowEvidence['cap']`. */
export type OutboundOverflowCap =
  'maxQueuedBytes' | 'maxQueuedFrames' | 'maxFrameBytes' | 'sendFailed';

/** Which bound tripped, plus the backlog held when it did. */
export interface OutboundOverflowEvidence {
  cap: OutboundOverflowCap;
  queuedBytes: number;
  queuedFrames: number;
  maxQueuedBytes: number;
  maxQueuedFrames: number;
  maxFrameBytes: number;
}

export interface OutboundQueueOptions<T> {
  /** Hands one frame to the wire. Called in order, at most once per frame. */
  send: (frame: T) => void;
  /** Serialized byte length of a frame, for cap accounting. */
  byteLengthOf: (frame: T) => number;
  /** Current socket buffered amount in bytes. */
  getBufferedAmount: () => number;
  /** True while the socket can still accept sends. */
  isWritable: () => boolean;
  /**
   * The link is wedged; the caller should force a clean reconnect. Receives the
   * backlog measured before the drop, so the caller can report what tripped.
   */
  onOverflow: (evidence: OutboundOverflowEvidence) => void;
  softCapBytes?: number;
  maxQueuedBytes?: number;
  maxFrameBytes?: number;
  maxQueuedFrames?: number;
  drainPollMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
}

export class OutboundBackpressureQueue<T> {
  private readonly send: (frame: T) => void;
  private readonly byteLengthOf: (frame: T) => number;
  private readonly getBufferedAmount: () => number;
  private readonly isWritable: () => boolean;
  private readonly onOverflow: (evidence: OutboundOverflowEvidence) => void;
  private readonly softCapBytes: number;
  private readonly maxQueuedBytes: number;
  private readonly maxFrameBytes: number;
  private readonly maxQueuedFrames: number;
  private readonly drainPollMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private readonly frames: T[] = [];
  private queuedBytesValue: number = 0;
  private queuedFramesValue: number = 0;
  private drainTimer: number | null = null;
  private overflowed: boolean = false;
  private disposed: boolean = false;

  constructor(options: OutboundQueueOptions<T>) {
    this.send = options.send;
    this.byteLengthOf = options.byteLengthOf;
    this.getBufferedAmount = options.getBufferedAmount;
    this.isWritable = options.isWritable;
    this.onOverflow = options.onOverflow;
    this.softCapBytes = options.softCapBytes === undefined ? DEFAULT_SOFT_CAP_BYTES : options.softCapBytes;
    this.maxQueuedBytes =
      options.maxQueuedBytes === undefined ? DEFAULT_MAX_QUEUED_BYTES : options.maxQueuedBytes;
    this.maxFrameBytes = options.maxFrameBytes === undefined ? this.maxQueuedBytes : options.maxFrameBytes;
    this.maxQueuedFrames =
      options.maxQueuedFrames === undefined ? DEFAULT_MAX_QUEUED_FRAMES : options.maxQueuedFrames;
    this.drainPollMs = options.drainPollMs === undefined ? DEFAULT_DRAIN_POLL_MS : options.drainPollMs;
    this.setTimer =
      options.setTimer === undefined
        ? (callback: () => void, delayMs: number): number => setTimeout(callback, delayMs)
        : options.setTimer;
    this.clearTimer =
      options.clearTimer === undefined
        ? (handle: number): void => clearTimeout(handle)
        : options.clearTimer;
  }

  /** Queues or sends a frame, preserving order across all prior frames. */
  enqueue(frame: T): boolean {
    if (this.disposed || this.overflowed) {
      return false;
    }
    const bytes = this.byteLengthOf(frame);
    // A transport that cannot report bufferedAmount must not strand frames.
    if (!isFiniteNumber(bytes) || bytes < 0 || bytes > this.maxFrameBytes) {
      this.failOverflow('maxFrameBytes');
      return false;
    }

    // Fast path: nothing parked and the wire is under the cap.
    if (this.queuedFramesValue === 0 && this.isWritable() && this.bufferedAmount() <= this.softCapBytes) {
      return this.sendFrame(frame);
    }

    this.frames.push(frame);
    this.queuedBytesValue += bytes;
    this.queuedFramesValue += 1;
    if (this.queuedBytesValue > this.maxQueuedBytes || this.queuedFramesValue > this.maxQueuedFrames) {
      this.failOverflow(
        this.queuedBytesValue > this.maxQueuedBytes ? 'maxQueuedBytes' : 'maxQueuedFrames'
      );
      return false;
    }
    if (this.drainTimer === null) {
      this.drainTimer = this.setTimer(() => this.drain(), this.drainPollMs);
    }
    return true;
  }

  queuedBytes(): number {
    return this.queuedBytesValue;
  }

  queuedFrames(): number {
    return this.queuedFramesValue;
  }

  /** Drops the backlog and stops the drain timer (call on close). */
  dispose(): void {
    this.disposed = true;
    this.dropBacklog();
  }

  private bufferedAmount(): number {
    const value = this.getBufferedAmount();
    return isFiniteNumber(value) ? value : 0;
  }

  private sendFrame(frame: T): boolean {
    try {
      this.send(frame);
      return true;
    } catch (error) {
      this.failOverflow('sendFailed');
      return false;
    }
  }

  /**
   * Moves as many frames to the wire as the socket will take without crossing
   * the soft cap, then re-arms the poll if anything remains.
   */
  private drain(): void {
    this.drainTimer = null;
    if (this.disposed || this.overflowed) {
      return;
    }
    if (!this.isWritable()) {
      // Socket went away mid-park; the transport's close path owns cleanup.
      this.dropBacklog();
      return;
    }
    while (this.queuedFramesValue > 0 && this.bufferedAmount() <= this.softCapBytes) {
      const frame = this.frames.shift();
      if (frame === undefined) {
        this.queuedBytesValue = 0;
        this.queuedFramesValue = 0;
        break;
      }
      this.queuedFramesValue -= 1;
      if (!this.sendFrame(frame)) {
        return;
      }
    }
    if (this.queuedFramesValue > 0) {
      this.drainTimer = this.setTimer(() => this.drain(), this.drainPollMs);
    }
  }

  private dropBacklog(): void {
    this.frames.length = 0;
    this.queuedBytesValue = 0;
    this.queuedFramesValue = 0;
    if (this.drainTimer !== null) {
      this.clearTimer(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private failOverflow(cap: OutboundOverflowCap): void {
    if (this.disposed || this.overflowed) {
      return;
    }
    this.overflowed = true;
    // Snapshot before dropBacklog() zeroes the counters.
    const evidence: OutboundOverflowEvidence = {
      cap: cap,
      queuedBytes: this.queuedBytesValue,
      queuedFrames: this.queuedFramesValue,
      maxQueuedBytes: this.maxQueuedBytes,
      maxQueuedFrames: this.maxQueuedFrames,
      maxFrameBytes: this.maxFrameBytes
    };
    this.dropBacklog();
    this.onOverflow(evidence);
  }
}

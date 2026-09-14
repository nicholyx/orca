/*
 * Routes decrypted binary frames to the terminal listener that owns the stream.
 *
 * A terminal subscription is opened by an RPC whose reply carries
 * `{ type: 'subscribed', streamId }`; from then on every binary frame tagged with
 * that stream id is decoded here and handed to the same listener as a typed
 * event. Screen snapshots arrive split across SnapshotStart/Chunk/End frames and
 * are reassembled before being emitted as one event.
 */
import {
  TERMINAL_OPCODE_ERROR,
  TERMINAL_OPCODE_METADATA,
  TERMINAL_OPCODE_OUTPUT,
  TERMINAL_OPCODE_RESIZED,
  TERMINAL_OPCODE_SNAPSHOT_CHUNK,
  TERMINAL_OPCODE_SNAPSHOT_END,
  TERMINAL_OPCODE_SNAPSHOT_START,
  decodeTerminalStreamFrame,
  decodeTerminalStreamRecord,
  decodeTerminalStreamText
} from './TerminalStreamProtocol';
import { asString } from '../json/JsonValue';

export const TERMINAL_EVENT_DATA = 'data';
export const TERMINAL_EVENT_SCROLLBACK = 'scrollback';
export const TERMINAL_EVENT_RESIZED = 'resized';
export const TERMINAL_EVENT_METADATA = 'metadata';
export const TERMINAL_EVENT_ERROR = 'error';

/** One decoded terminal event. Unused fields are empty, never null-ish. */
export interface TerminalStreamEvent {
  type: string;
  streamId: number;
  /** Output text, for `data`. */
  chunk: string;
  /** Reassembled snapshot body, for `scrollback` and `resized`. */
  serialized: string;
  /** Failure text, for `error`. */
  message: string;
  /** Frame metadata for the non-`data` events. */
  meta: Record<string, Object> | null;
}

export type TerminalStreamListener = (event: TerminalStreamEvent) => void;

interface TerminalSnapshotState {
  streamId: number;
  meta: Record<string, Object>;
  chunks: string[];
}

function emptyEvent(type: string, streamId: number): TerminalStreamEvent {
  return {
    type: type,
    streamId: streamId,
    chunk: '',
    serialized: '',
    message: '',
    meta: null
  };
}

export class TerminalStreamRouter {
  private readonly listeners: Map<number, TerminalStreamListener> = new Map();
  private readonly idsByRequest: Map<string, Set<number>> = new Map();
  private readonly snapshots: Map<number, TerminalSnapshotState> = new Map();

  /** Binds a request id and its subscribed stream id to one listener. */
  register(requestId: string, streamId: number, listener: TerminalStreamListener): void {
    let ids = this.idsByRequest.get(requestId);
    if (ids === undefined) {
      ids = new Set<number>();
      this.idsByRequest.set(requestId, ids);
    }
    ids.add(streamId);
    this.listeners.set(streamId, listener);
  }

  /** Drops every stream id a request owned, along with its partial snapshots. */
  reset(requestId: string): void {
    const ids = this.idsByRequest.get(requestId);
    if (ids === undefined) {
      return;
    }
    ids.forEach((streamId: number) => {
      this.listeners.delete(streamId);
      this.snapshots.delete(streamId);
    });
    this.idsByRequest.delete(requestId);
  }

  /** Decodes one decrypted binary frame and emits a listener event. */
  handle(bytes: Uint8Array): void {
    const frame = decodeTerminalStreamFrame(bytes);
    if (frame === null) {
      return;
    }
    const listener = this.listeners.get(frame.streamId);
    if (listener === undefined) {
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_OUTPUT) {
      const event = emptyEvent(TERMINAL_EVENT_DATA, frame.streamId);
      event.chunk = decodeTerminalStreamText(frame.payload);
      listener(event);
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_SNAPSHOT_START) {
      const meta = decodeTerminalStreamRecord(frame.payload);
      if (meta === null) {
        return;
      }
      this.snapshots.set(frame.streamId, {
        streamId: frame.streamId,
        meta: meta,
        chunks: []
      });
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_SNAPSHOT_CHUNK) {
      const snapshot = this.snapshots.get(frame.streamId);
      if (snapshot === undefined) {
        return;
      }
      snapshot.chunks.push(decodeTerminalStreamText(frame.payload));
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_SNAPSHOT_END) {
      const snapshot = this.snapshots.get(frame.streamId);
      if (snapshot === undefined) {
        return;
      }
      this.snapshots.delete(frame.streamId);
      // Why: the host tags a resize replay with `kind: 'resized'`; everything
      // else is a scrollback snapshot. The UI distinguishes the two.
      const kind =
        asString(snapshot.meta.kind) === TERMINAL_EVENT_RESIZED
          ? TERMINAL_EVENT_RESIZED
          : TERMINAL_EVENT_SCROLLBACK;
      const event = emptyEvent(kind, frame.streamId);
      event.serialized = snapshot.chunks.join('');
      event.meta = snapshot.meta;
      listener(event);
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_RESIZED) {
      const meta = decodeTerminalStreamRecord(frame.payload);
      if (meta === null) {
        return;
      }
      const event = emptyEvent(TERMINAL_EVENT_RESIZED, frame.streamId);
      event.meta = meta;
      listener(event);
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_METADATA) {
      const meta = decodeTerminalStreamRecord(frame.payload);
      if (meta === null) {
        return;
      }
      const event = emptyEvent(TERMINAL_EVENT_METADATA, frame.streamId);
      event.meta = meta;
      listener(event);
      return;
    }

    if (frame.opcode === TERMINAL_OPCODE_ERROR) {
      const event = emptyEvent(TERMINAL_EVENT_ERROR, frame.streamId);
      event.message = decodeTerminalStreamText(frame.payload);
      listener(event);
    }
  }

  trackedStreamCount(): number {
    return this.listeners.size;
  }
}

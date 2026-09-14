/*
 * The connection log: a bounded, redacted ring of what the transport did.
 *
 * The endpoint is reduced to its host before it is ever stored, because a
 * pairing URL can carry a token in its query string and this log is user-facing
 * (it is rendered in the connection screen and copied into bug reports).
 */

export const CONNECTION_LOG_LEVEL_INFO = 'info';
export const CONNECTION_LOG_LEVEL_SUCCESS = 'success';
export const CONNECTION_LOG_LEVEL_WARN = 'warn';
export const CONNECTION_LOG_LEVEL_ERROR = 'error';

const MAX_ENTRIES = 200;

export interface ConnectionLogEntry {
  /** Sequential id, so the UI can key rows without relying on a timestamp. */
  id: number;
  at: number;
  level: string;
  message: string;
  detail: string;
  code: string;
}

export interface ConnectionLogSink {
  (entry: ConnectionLogEntry): void;
}

/** Strips everything but the host, since a pairing URL may carry a token. */
export function redactSocketEndpoint(endpoint: string): string {
  let rest = endpoint;
  const schemeIndex = rest.indexOf('://');
  if (schemeIndex !== -1) {
    rest = rest.substring(schemeIndex + 3);
  }
  const slashIndex = rest.indexOf('/');
  if (slashIndex !== -1) {
    rest = rest.substring(0, slashIndex);
  }
  return rest.length === 0 ? 'unknown' : rest;
}

export class ConnectionLog {
  private readonly endpointHost: string;
  private readonly sink: ConnectionLogSink | null;
  private readonly entries: ConnectionLogEntry[] = [];
  private nextId: number = 1;

  constructor(endpoint: string, sink: ConnectionLogSink | null) {
    this.endpointHost = redactSocketEndpoint(endpoint);
    this.sink = sink;
  }

  emit(level: string, message: string, detail: string, code: string): void {
    const entry: ConnectionLogEntry = {
      id: this.nextId,
      at: Date.now(),
      level: level,
      message: message,
      detail: detail,
      code: code
    };
    this.nextId++;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (this.sink !== null) {
      this.sink(entry);
    }
  }

  entriesSnapshot(): ConnectionLogEntry[] {
    return this.entries.slice();
  }

  getHost(): string {
    return this.endpointHost;
  }

  clear(): void {
    this.entries.splice(0, this.entries.length);
  }
}

/** Bound emitter: `log.emit` can be handed around without rebinding `this`. */
export type ConnectionLogEmitter = (
  level: string,
  message: string,
  detail: string,
  code: string
) => void;

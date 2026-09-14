/*
 * The shapes the views render.
 *
 * Everything here is an immutable snapshot. Views re-read a snapshot whenever
 * the service signals a change instead of observing live mutable objects, which
 * keeps ArkUI's diffing honest: a view can never be showing half of one state
 * and half of another.
 */
import { ConnectionLogEntry } from '../core/rpc/ConnectionLog';

export const CONNECTION_LABEL_DISCONNECTED = 'Disconnected';
export const CONNECTION_LABEL_CONNECTING = 'Connecting…';
export const CONNECTION_LABEL_HANDSHAKING = 'Handshaking…';
export const CONNECTION_LABEL_CONNECTED = 'Connected';
export const CONNECTION_LABEL_RECONNECTING = 'Reconnecting…';
export const CONNECTION_LABEL_AUTH_FAILED = 'Pairing rejected';

/** State → the label the connection pill shows. */
export function connectionLabel(state: string): string {
  if (state === 'connected') {
    return CONNECTION_LABEL_CONNECTED;
  }
  if (state === 'connecting') {
    return CONNECTION_LABEL_CONNECTING;
  }
  if (state === 'handshaking') {
    return CONNECTION_LABEL_HANDSHAKING;
  }
  if (state === 'reconnecting') {
    return CONNECTION_LABEL_RECONNECTING;
  }
  if (state === 'auth-failed') {
    return CONNECTION_LABEL_AUTH_FAILED;
  }
  return CONNECTION_LABEL_DISCONNECTED;
}

/** State → the pill's colour token name, resolved by the view. */
export function connectionTone(state: string): string {
  if (state === 'connected') {
    return 'ok';
  }
  if (state === 'connecting' || state === 'handshaking' || state === 'reconnecting') {
    return 'pending';
  }
  if (state === 'auth-failed') {
    return 'error';
  }
  return 'idle';
}

export interface HostRow {
  id: string;
  name: string;
  endpoint: string;
  lastConnected: number;
  isActive: boolean;
}

export interface ConnectionSnapshot {
  state: string;
  label: string;
  tone: string;
  reconnectAttempt: number;
  lastConnectedAt: number;
  hostId: string;
  hostName: string;
  hostEndpoint: string;
  hostCount: number;
}

export interface LogRow {
  id: number;
  clock: string;
  level: string;
  message: string;
  detail: string;
  code: string;
}

/** A terminal line is kept as text: the desktop already renders ANSI escapes. */
export interface TerminalLine {
  id: number;
  text: string;
}

export interface PairOutcome {
  ok: boolean;
  message: string;
  hostName: string;
}

export function toLogRow(entry: ConnectionLogEntry): LogRow {
  const date = new Date(entry.at);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const row: LogRow = {
    id: entry.id,
    clock: clock,
    level: entry.level,
    message: entry.message,
    detail: entry.detail,
    code: entry.code
  };
  return row;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/*
 * Teardown RPCs for streaming subscriptions.
 *
 * The host keeps per-subscription state (a transcript fs-watcher, a screencast
 * session, a terminal feed), so closing the socket is not enough — each stream
 * must be explicitly told to tear down, or the host leaks that state per
 * session-switch. The exact token to echo differs by method, so every shape
 * lives here rather than being hand-rolled at each call site.
 */
import { asRecord, asString } from '../json/JsonValue';

export const RPC_METHOD_TERMINAL_SUBSCRIBE = 'terminal.subscribe';
export const RPC_METHOD_TERMINAL_UNSUBSCRIBE = 'terminal.unsubscribe';
export const RPC_METHOD_SESSION_TABS_SUBSCRIBE = 'session.tabs.subscribe';
export const RPC_METHOD_SESSION_TABS_UNSUBSCRIBE = 'session.tabs.unsubscribe';
export const RPC_METHOD_NATIVE_CHAT_SUBSCRIBE = 'nativeChat.subscribe';
export const RPC_METHOD_NATIVE_CHAT_UNSUBSCRIBE = 'nativeChat.unsubscribe';
export const RPC_METHOD_BROWSER_SCREENCAST = 'browser.screencast';
export const RPC_METHOD_BROWSER_SCREENCAST_UNSUBSCRIBE = 'browser.screencast.unsubscribe';
export const RPC_METHOD_CLIENT_EVENTS_SUBSCRIBE = 'runtime.clientEvents.subscribe';
export const RPC_METHOD_CLIENT_EVENTS_UNSUBSCRIBE = 'runtime.clientEvents.unsubscribe';

export interface RpcStreamUnsubscribe {
  method: string;
  params: Record<string, Object>;
}

/** The cleanup token the runtime keys a native-chat transcript watcher under. */
export function buildNativeChatSubscriptionId(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export function buildNativeChatUnsubscribe(
  agent: string,
  sessionId: string,
  subscriptionId: string
): RpcStreamUnsubscribe {
  const params: Record<string, Object> = {};
  params.subscriptionId = subscriptionId === '' ? buildNativeChatSubscriptionId(agent, sessionId) : subscriptionId;
  const rpc: RpcStreamUnsubscribe = { method: RPC_METHOD_NATIVE_CHAT_UNSUBSCRIBE, params: params };
  return rpc;
}

/**
 * Terminal unsubscribe params. The client id is appended to the terminal name so
 * two viewers of the same terminal do not close each other's feed.
 */
export function buildTerminalUnsubscribeParams(
  params: Object | null
): Record<string, Object> | null {
  const record = asRecord(params);
  if (record === null) {
    return null;
  }
  const terminal = asString(record.terminal);
  if (terminal === null) {
    return null;
  }
  const client = asRecord(record.client);
  const clientId = client === null ? null : asString(client.id);
  const out: Record<string, Object> = {};
  out.subscriptionId = clientId === null ? terminal : `${terminal}:${clientId}`;
  if (clientId !== null) {
    const clientRef: Record<string, Object> = {};
    clientRef.id = clientId;
    out.client = clientRef;
  }
  return out;
}

/**
 * Unsubscribe for a streaming method that needs the host told to tear down, or
 * null when the method has no server-side teardown.
 */
export function buildStreamUnsubscribe(
  method: string,
  params: Object | null
): RpcStreamUnsubscribe | null {
  const record = asRecord(params);
  if (record === null) {
    return null;
  }
  if (method === RPC_METHOD_SESSION_TABS_SUBSCRIBE) {
    const worktree = asString(record.worktree);
    if (worktree === null) {
      return null;
    }
    const unsubscribeParams: Record<string, Object> = {};
    unsubscribeParams.worktree = worktree;
    const rpc: RpcStreamUnsubscribe = {
      method: RPC_METHOD_SESSION_TABS_UNSUBSCRIBE,
      params: unsubscribeParams
    };
    return rpc;
  }
  if (method === RPC_METHOD_NATIVE_CHAT_SUBSCRIBE) {
    const subscriptionId = asString(record.subscriptionId);
    if (subscriptionId !== null) {
      const unsubscribeParams: Record<string, Object> = {};
      unsubscribeParams.subscriptionId = subscriptionId;
      const rpc: RpcStreamUnsubscribe = {
        method: RPC_METHOD_NATIVE_CHAT_UNSUBSCRIBE,
        params: unsubscribeParams
      };
      return rpc;
    }
    // Backward compatibility with callers that predate explicit cleanup tokens.
    const agent = asString(record.agent);
    const sessionId = asString(record.sessionId);
    if (agent === null || sessionId === null) {
      return null;
    }
    return buildNativeChatUnsubscribe(agent, sessionId, '');
  }
  return null;
}

/** Unsubscribe for a stream that was accepted with a `ready` + subscriptionId. */
export function buildReadyStreamUnsubscribe(
  method: string,
  subscriptionId: string
): RpcStreamUnsubscribe | null {
  let unsubscribeMethod = '';
  if (method === RPC_METHOD_BROWSER_SCREENCAST) {
    unsubscribeMethod = RPC_METHOD_BROWSER_SCREENCAST_UNSUBSCRIBE;
  } else if (method === RPC_METHOD_CLIENT_EVENTS_SUBSCRIBE) {
    unsubscribeMethod = RPC_METHOD_CLIENT_EVENTS_UNSUBSCRIBE;
  } else {
    return null;
  }
  const params: Record<string, Object> = {};
  params.subscriptionId = subscriptionId;
  const rpc: RpcStreamUnsubscribe = { method: unsubscribeMethod, params: params };
  return rpc;
}

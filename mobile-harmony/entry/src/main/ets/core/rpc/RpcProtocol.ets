/*
 * JSON-RPC envelope shared by every request the mobile client makes.
 *
 * Wire shapes are identical to the desktop/React Native clients:
 *   request   { id, deviceToken, method, params? }
 *   success   { id, ok: true,  result, streaming?, _meta: { runtimeId } }
 *   failure   { id, ok: false, error: { code, message, data? }, _meta }
 *
 * `_meta` is written by the host and is never validated on the way in, so it is
 * typed as optional: the transport only needs `id`, `ok`, `result` and `error`
 * to route a reply.
 */
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  parseJsonRecord
} from '../json/JsonValue';

export const RPC_METHOD_NOT_FOUND = 'method_not_found';
export const RPC_CODE_UNAUTHORIZED = 'unauthorized';

/** Marks a failure where the request may or may not have been delivered. */
export class RpcDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function isRpcDeliveryUnknown(error: Object | null | undefined): boolean {
  return error instanceof RpcDeliveryUnknownError;
}

export interface RpcRequest {
  id: string;
  deviceToken: string;
  method: string;
  params?: Object;
}

/** Serialized shape of an outbound request. `params` is omitted when undefined. */
export interface RpcRequestDocument {
  id: string;
  deviceToken: string;
  method: string;
  params?: Object;
}

export interface RpcErrorBody {
  code: string;
  message: string;
  data?: Object;
}

export interface RpcSuccess {
  id: string;
  ok: true;
  result: Object;
  streaming?: boolean;
}

export interface RpcFailure {
  id: string;
  ok: false;
  error: RpcErrorBody;
}

export interface RpcResponse {
  id: string;
  ok: boolean;
  result: Object | null;
  streaming: boolean;
  error: RpcErrorBody | null;
}

/** Narrows an already-parsed JSON object to an RPC response, or null. */
export function readRpcResponse(value: Object | null | undefined): RpcResponse | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const id = asString(record.id);
  if (id === null) {
    return null;
  }
  const ok = asBoolean(record.ok);
  if (ok === true) {
    // A success must carry `result`; its presence is the frame's only signal
    // that the host actually produced a value. JSON cannot encode `undefined`,
    // so an absent key is simply `undefined` after parsing.
    if (record.result === undefined) {
      return null;
    }
    const response: RpcResponse = {
      id: id,
      ok: true,
      result: record.result,
      streaming: asBoolean(record.streaming) === true,
      error: null
    };
    return response;
  }
  if (ok !== false) {
    return null;
  }
  const error = readErrorBody(record.error);
  if (error === null) {
    return null;
  }
  const response: RpcResponse = {
    id: id,
    ok: false,
    result: null,
    streaming: false,
    error: error
  };
  return response;
}

/** Parses a decrypted text frame into an RPC response, or null. */
export function parseRpcResponseText(plaintext: string): RpcResponse | null {
  return readRpcResponse(parseJsonRecord(plaintext));
}

function readErrorBody(value: Object | null | undefined): RpcErrorBody | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const code = asString(record.code);
  const message = asString(record.message);
  if (code === null || message === null) {
    return null;
  }
  const body: RpcErrorBody = { code: code, message: message };
  if (record.data !== undefined) {
    body.data = record.data;
  }
  return body;
}

/** A success that opened a stream rather than delivering a terminal result. */
export function isStreamingOpenerReply(response: RpcResponse): boolean {
  return response.ok && response.streaming;
}

export function isMethodNotFoundRefusal(response: RpcResponse): boolean {
  return !response.ok && response.error !== null && response.error.code === RPC_METHOD_NOT_FOUND;
}

export function isUnauthorizedRefusal(response: RpcResponse): boolean {
  return !response.ok && response.error !== null && response.error.code === RPC_CODE_UNAUTHORIZED;
}

/** Throws `code: message` on refusal. Diagnostic text; not user-facing. */
export function requireRpcResultOrThrowCodedError(response: RpcResponse): Object | null {
  // `error` is null precisely when `ok` is true, so the refusal test must key
  // off `ok` alone — testing `error === null` would reject every success.
  if (!response.ok) {
    const code = response.error === null ? 'unknown' : response.error.code;
    const message = response.error === null ? 'request failed' : response.error.message;
    throw new Error(`${code}: ${message}`);
  }
  return response.result;
}

/**
 * Accepts only a success whose result is a non-null object. Arrays qualify —
 * the reference predicate is a bare `typeof result === 'object'` check, and
 * several callers pass arrays through it.
 */
export function rpcObjectResultOrNull(response: RpcResponse): Record<string, Object> | null {
  if (!response.ok) {
    return null;
  }
  const result = response.result;
  if (result === null || typeof result !== 'object') {
    return null;
  }
  // SAFETY: guarded above by the same `typeof result === 'object'` test the
  // reference implementation uses; arrays are deliberately included.
  return result as Record<string, Object>;
}

/** `{ type: 'subscribed', streamId }` — a terminal subscription was accepted. */
export function readTerminalSubscribedStreamId(result: Object | null | undefined): number | null {
  const record = asRecord(result);
  if (record === null || asString(record.type) !== 'subscribed') {
    return null;
  }
  return asNumber(record.streamId);
}

/** `{ type: 'ready', subscriptionId }` — a server-side subscription was accepted. */
export function readStreamingReadySubscriptionId(result: Object | null | undefined): string | null {
  const record = asRecord(result);
  if (record === null || asString(record.type) !== 'ready') {
    return null;
  }
  return asString(record.subscriptionId);
}

/** Reads the `type` discriminator of a streamed result object. */
export function readStreamResultType(result: Object | null | undefined): string | null {
  const record = asRecord(result);
  return record === null ? null : asString(record.type);
}

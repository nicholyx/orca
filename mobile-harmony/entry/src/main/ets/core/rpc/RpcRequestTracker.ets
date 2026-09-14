/*
 * Tracks in-flight unary RPC requests: one pending entry per request id, each
 * with its own timeout.
 *
 * A request is only written to the wire once the channel is authenticated, so
 * `sendRequest` waits for the connected state first (unless the caller opts out
 * with `failWhenDisconnected`). Rejections carry `deliveryUnknown` when the
 * request may already have reached the host — a retry then risks duplicating a
 * side effect, so callers must be able to tell the two cases apart.
 */
import {
  RpcDeliveryUnknownError,
  RpcRequestDocument,
  RpcResponse
} from './RpcProtocol';

const REQUEST_TIMEOUT_MS = 30_000;

export interface SendRequestOptions {
  timeoutMs?: number;
  failWhenDisconnected?: boolean;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: number;
}

export interface RpcRequestTrackerOptions {
  nextId: () => string;
  deviceToken: string;
  isConnected: () => boolean;
  waitForConnected: (timeoutMs?: number) => Promise<void>;
  sendEncrypted: (request: Object) => boolean;
}

export class RpcRequestTracker {
  private readonly nextId: () => string;
  private readonly deviceToken: string;
  private readonly isConnected: () => boolean;
  private readonly waitForConnected: (timeoutMs?: number) => Promise<void>;
  private readonly sendEncrypted: (request: Object) => boolean;
  private readonly pending: Map<string, PendingRequest> = new Map();

  constructor(options: RpcRequestTrackerOptions) {
    this.nextId = options.nextId;
    this.deviceToken = options.deviceToken;
    this.isConnected = options.isConnected;
    this.waitForConnected = options.waitForConnected;
    this.sendEncrypted = options.sendEncrypted;
  }

  async sendRequest(
    method: string,
    params: Object | undefined,
    options?: SendRequestOptions
  ): Promise<RpcResponse> {
    const wasConnected = this.isConnected();
    if (options !== undefined && options.failWhenDisconnected === true && !wasConnected) {
      throw new Error(`Not connected: ${method}`);
    }
    const waitTimeout = options === undefined ? undefined : options.timeoutMs;
    await this.waitForConnected(waitTimeout);
    const timeoutMs = options === undefined || options.timeoutMs === undefined
      ? REQUEST_TIMEOUT_MS
      : options.timeoutMs;
    return this.sendConnectedRequest(method, params, timeoutMs);
  }

  /** Sends without waiting for the connected state; used during negotiation. */
  sendAuthenticatedRequest(method: string, params: Object, timeoutMs: number): Promise<RpcResponse> {
    return this.sendConnectedRequest(method, params, timeoutMs);
  }

  /** Resolves the pending request for this id; false when nothing was waiting. */
  resolve(response: RpcResponse): boolean {
    const request = this.pending.get(response.id);
    if (request === undefined) {
      return false;
    }
    this.pending.delete(response.id);
    clearTimeout(request.timer);
    request.resolve(response);
    return true;
  }

  /**
   * Fails every pending request. `deliveryUnknown` marks them as possibly
   * already delivered, which changes whether a caller may safely retry.
   */
  rejectAll(reason: string, deliveryUnknown: boolean): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (let index = 0; index < pending.length; index++) {
      const request = pending[index];
      clearTimeout(request.timer);
      const error: Error = deliveryUnknown
        ? new RpcDeliveryUnknownError(reason)
        : new Error(reason);
      // Defer so a rejection is never delivered synchronously from teardown.
      Promise.resolve().then(() => request.reject(error));
    }
  }

  size(): number {
    return this.pending.size;
  }

  private sendConnectedRequest(
    method: string,
    params: Object | undefined,
    timeoutMs: number
  ): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve: (value: RpcResponse) => void, reject: (error: Error) => void) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcDeliveryUnknownError(`Request timed out: ${method}`));
      }, timeoutMs);
      const entry: PendingRequest = {
        resolve: resolve,
        reject: reject,
        timer: timer
      };
      this.pending.set(id, entry);

      const request: RpcRequestDocument = {
        id: id,
        deviceToken: this.deviceToken,
        method: method,
        params: params
      };
      if (!this.sendEncrypted(request)) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('Connection interrupted'));
      }
    });
  }
}

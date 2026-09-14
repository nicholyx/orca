/*
 * Owns every subscription the client holds open.
 *
 * Two subscription shapes exist and they are routed differently:
 *   - "opener" streams: the RPC reply carries `streaming: true`, then either
 *     `{type:'ready', subscriptionId}` (host pushes results under that id) or
 *     `{type:'subscribed', streamId}` (host pushes binary terminal frames).
 *   - plain streams: results keep arriving, tagged `scrollback` / `end`.
 *
 * A subscription made before the socket is authenticated is held unsent and
 * replayed once authentication completes, so callers never have to know whether
 * the link was up when they subscribed.
 */
import { decodeBrowserScreencastFrame, BrowserScreencastFrame } from './BrowserScreencastProtocol';
import {
  RpcRequestDocument,
  RpcResponse,
  isStreamingOpenerReply,
  readStreamResultType,
  readStreamingReadySubscriptionId,
  readTerminalSubscribedStreamId
} from './RpcProtocol';
import {
  RPC_METHOD_BROWSER_SCREENCAST,
  RPC_METHOD_TERMINAL_SUBSCRIBE,
  RPC_METHOD_NATIVE_CHAT_SUBSCRIBE,
  RPC_METHOD_CLIENT_EVENTS_SUBSCRIBE,
  RpcStreamUnsubscribe,
  buildReadyStreamUnsubscribe,
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams
} from './RpcStreamUnsubscribe';
import { TerminalStreamRouter, TerminalStreamEvent } from './TerminalStreamRouter';

export const STREAM_RESULT_TYPE_END = 'end';
export const STREAM_RESULT_TYPE_ERROR = 'error';
export const STREAM_RESULT_TYPE_SCROLLBACK = 'scrollback';

export type RpcStreamingListener = (result: Object | null) => void;
export type BrowserFrameListener = (frame: BrowserScreencastFrame) => void;

export interface RpcStreamSubscribeOptions {
  onBinaryFrame?: BrowserFrameListener;
}

export interface RpcStreamRegistryOptions {
  nextId: () => string;
  deviceToken: string;
  isConnected: () => boolean;
  sendEncrypted: (request: RpcRequestDocument) => boolean;
}

interface StreamRequest {
  method: string;
  params: Record<string, Object>;
  listener: RpcStreamingListener;
  onBinaryFrame: BrowserFrameListener | null;
  subscriptionId: string;
  cancelled: boolean;
  sent: boolean;
}

/** A streamed result carrying `{ type: 'error', message }`. */
function errorResult(message: string): Record<string, Object> {
  const result: Record<string, Object> = {};
  result.type = STREAM_RESULT_TYPE_ERROR;
  result.message = message;
  return result;
}

export class RpcStreamRegistry {
  private readonly nextId: () => string;
  private readonly deviceToken: string;
  private readonly isConnected: () => boolean;
  private readonly sendEncrypted: (request: RpcRequestDocument) => boolean;

  private readonly streams: Map<string, StreamRequest> = new Map();
  private readonly terminalRouter: TerminalStreamRouter = new TerminalStreamRouter();
  private activeBrowserRequestId: string = '';
  private pendingBrowserRequestId: string = '';

  constructor(options: RpcStreamRegistryOptions) {
    this.nextId = options.nextId;
    this.deviceToken = options.deviceToken;
    this.isConnected = options.isConnected;
    this.sendEncrypted = options.sendEncrypted;
  }

  /** Opens a subscription and returns its cancel handle. */
  subscribe(
    method: string,
    params: Record<string, Object>,
    listener: RpcStreamingListener,
    options?: RpcStreamSubscribeOptions
  ): () => void {
    const id = this.nextId();
    const onBinaryFrame =
      options === undefined || options.onBinaryFrame === undefined ? null : options.onBinaryFrame;
    const stream: StreamRequest = {
      method: method,
      params: params,
      listener: listener,
      onBinaryFrame: onBinaryFrame,
      subscriptionId: '',
      cancelled: false,
      sent: false
    };
    this.streams.set(id, stream);
    if (method === RPC_METHOD_BROWSER_SCREENCAST) {
      this.replaceBrowserStream(id);
    }
    if (this.isConnected()) {
      if (this.send(id, stream)) {
        stream.sent = true;
      } else {
        this.emitError(stream, 'Connection interrupted');
        this.remove(id);
      }
    }
    // Not connected: parked unsent and replayed by replayAfterAuthentication().
    return () => this.dispose(id);
  }

  /** Sends every subscription that has not reached the wire yet. */
  replayAfterAuthentication(): void {
    const entries = Array.from(this.streams.entries());
    for (let index = 0; index < entries.length; index++) {
      const id = entries[index][0];
      const stream = entries[index][1];
      if (stream.cancelled) {
        this.remove(id);
        continue;
      }
      if (stream.sent) {
        continue;
      }
      if (stream.method === RPC_METHOD_BROWSER_SCREENCAST) {
        this.pendingBrowserRequestId = id;
        this.activeBrowserRequestId = '';
      }
      this.terminalRouter.reset(id);
      if (this.send(id, stream)) {
        stream.sent = true;
      } else {
        this.markForReplay();
        break;
      }
    }
  }

  /** Marks every subscription as needing a resend after a reconnect. */
  markForReplay(): void {
    this.activeBrowserRequestId = '';
    this.pendingBrowserRequestId = '';
    const entries = Array.from(this.streams.entries());
    for (let index = 0; index < entries.length; index++) {
      const id = entries[index][0];
      const stream = entries[index][1];
      stream.sent = false;
      this.terminalRouter.reset(id);
    }
  }

  /** True when the response belonged to a subscription and was consumed here. */
  handleResponse(response: RpcResponse): boolean {
    if (isStreamingOpenerReply(response)) {
      this.handleStreamingResponse(response);
      return true;
    }
    const stream = this.streams.get(response.id);
    if (response.ok) {
      const resultType = readStreamResultType(response.result);
      if (stream !== undefined && resultType === STREAM_RESULT_TYPE_END) {
        if (!stream.cancelled) {
          stream.listener(response.result);
        }
        this.remove(response.id);
        return true;
      }
      if (stream !== undefined && resultType === STREAM_RESULT_TYPE_SCROLLBACK) {
        stream.listener(response.result);
        return true;
      }
    }
    if (stream === undefined) {
      // Not a stream reply: let the request tracker resolve it.
      return false;
    }
    if (response.ok) {
      this.emitError(stream, 'Streaming request ended before it was ready.');
    } else {
      this.emitError(stream, response.error === null ? 'Subscription failed' : response.error.message);
    }
    this.remove(response.id);
    return true;
  }

  /** Routes a decrypted binary frame to the screencast or terminal path. */
  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes);
    if (browserFrame !== null) {
      this.handleBrowserFrame(browserFrame);
      return;
    }
    this.terminalRouter.handle(bytes);
  }

  /** Updates the viewport of every live subscription for this terminal. */
  updateTerminalViewport(terminal: string, cols: number, rows: number): void {
    const entries = Array.from(this.streams.values());
    for (let index = 0; index < entries.length; index++) {
      const stream = entries[index];
      if (stream.method !== RPC_METHOD_TERMINAL_SUBSCRIBE) {
        continue;
      }
      if (stream.params.terminal !== terminal) {
        continue;
      }
      const viewport: Record<string, Object> = {};
      viewport.cols = cols;
      viewport.rows = rows;
      stream.params.viewport = viewport;
    }
  }

  size(): number {
    return this.streams.size;
  }

  private handleStreamingResponse(response: RpcResponse): void {
    const stream = this.streams.get(response.id);
    if (stream === undefined) {
      return;
    }
    const subscriptionId = readStreamingReadySubscriptionId(response.result);
    if (subscriptionId !== null) {
      stream.subscriptionId = subscriptionId;
      if (stream.cancelled) {
        this.sendServerSubscriptionUnsubscribe(stream);
        this.remove(response.id);
        return;
      }
      if (stream.method === RPC_METHOD_BROWSER_SCREENCAST) {
        if (this.pendingBrowserRequestId !== response.id && this.activeBrowserRequestId !== response.id) {
          this.sendBrowserUnsubscribe(subscriptionId);
          this.remove(response.id);
          return;
        }
        this.pendingBrowserRequestId = '';
        this.activeBrowserRequestId = response.id;
      }
    }
    const streamId = readTerminalSubscribedStreamId(response.result);
    if (streamId !== null) {
      this.terminalRouter.register(response.id, streamId, (event: TerminalStreamEvent): void => {
        stream.listener(event);
      });
    }
    if (!stream.cancelled) {
      stream.listener(response.result);
    }
  }

  private dispose(id: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined) {
      return;
    }
    if (
      stream.method === RPC_METHOD_BROWSER_SCREENCAST ||
      stream.method === RPC_METHOD_CLIENT_EVENTS_SUBSCRIBE
    ) {
      stream.cancelled = true;
      this.clearBrowserRequest(id);
      this.disposeServerSubscription(id, stream);
      return;
    }
    if (stream.method === RPC_METHOD_TERMINAL_SUBSCRIBE) {
      const params = buildTerminalUnsubscribeParams(stream.params);
      if (params !== null) {
        this.sendRpc('terminal.unsubscribe', params);
      }
    } else {
      const unsubscribe = buildStreamUnsubscribe(stream.method, stream.params);
      if (unsubscribe !== null) {
        this.sendRpc(unsubscribe.method, unsubscribe.params);
      }
    }
    this.remove(id);
  }

  private replaceBrowserStream(id: string): void {
    if (this.activeBrowserRequestId !== '' && this.activeBrowserRequestId !== id) {
      this.dispose(this.activeBrowserRequestId);
    }
    if (this.pendingBrowserRequestId !== '' && this.pendingBrowserRequestId !== id) {
      this.dispose(this.pendingBrowserRequestId);
    }
    this.pendingBrowserRequestId = id;
    this.activeBrowserRequestId = '';
  }

  private disposeServerSubscription(id: string, stream: StreamRequest): void {
    stream.cancelled = true;
    if (stream.subscriptionId !== '') {
      this.sendServerSubscriptionUnsubscribe(stream);
      this.remove(id);
    } else if (!stream.sent) {
      this.remove(id);
    }
  }

  private sendServerSubscriptionUnsubscribe(stream: StreamRequest): void {
    if (stream.subscriptionId === '') {
      return;
    }
    const unsubscribe = buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId);
    if (unsubscribe !== null) {
      this.sendRpc(unsubscribe.method, unsubscribe.params);
    }
  }

  private sendBrowserUnsubscribe(subscriptionId: string): void {
    const params: Record<string, Object> = {};
    params.subscriptionId = subscriptionId;
    this.sendRpc('browser.screencast.unsubscribe', params);
  }

  private sendRpc(method: string, params: Record<string, Object>): boolean {
    const request: RpcRequestDocument = {
      id: this.nextId(),
      deviceToken: this.deviceToken,
      method: method,
      params: params
    };
    return this.sendEncrypted(request);
  }

  private send(id: string, stream: StreamRequest): boolean {
    const request: RpcRequestDocument = {
      id: id,
      deviceToken: this.deviceToken,
      method: stream.method,
      params: stream.params
    };
    return this.sendEncrypted(request);
  }

  private remove(id: string): void {
    const stream = this.streams.get(id);
    this.streams.delete(id);
    this.clearBrowserRequest(id);
    this.terminalRouter.reset(id);
    if (stream !== undefined && stream.method === RPC_METHOD_BROWSER_SCREENCAST) {
      stream.cancelled = true;
    }
  }

  private clearBrowserRequest(id: string): void {
    if (this.activeBrowserRequestId === id) {
      this.activeBrowserRequestId = '';
    }
    if (this.pendingBrowserRequestId === id) {
      this.pendingBrowserRequestId = '';
    }
  }

  private handleBrowserFrame(frame: BrowserScreencastFrame): void {
    if (this.activeBrowserRequestId === '') {
      return;
    }
    const stream = this.streams.get(this.activeBrowserRequestId);
    if (stream === undefined || stream.cancelled || stream.method !== RPC_METHOD_BROWSER_SCREENCAST) {
      return;
    }
    if (stream.onBinaryFrame !== null) {
      stream.onBinaryFrame(frame);
    }
  }

  private emitError(stream: StreamRequest, message: string): void {
    if (!stream.cancelled) {
      stream.listener(errorResult(message));
    }
  }
}

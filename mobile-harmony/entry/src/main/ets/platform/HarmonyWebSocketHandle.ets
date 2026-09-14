/*
 * HarmonyOS WebSocket adapter: the one file that knows about `@kit.NetworkKit`.
 *
 * The official `@ohos.net.webSocket` surface has no `readyState` and no
 * `bufferedAmount` — connection state is only observable through the
 * `open`/`close`/`error` events, and `send()` returns a promise per frame. Both
 * are therefore tracked here:
 *
 *   readyState    — a local mirror updated by those events, using the WHATWG
 *                   numbering (0/1/2/3) the platform-neutral layer compares
 *                   against, so the core never has to know which runtime it is
 *                   running on.
 *   bufferedAmount — the number of bytes handed to `send()` whose promise has
 *                   not settled. That is a real measure of in-flight bytes,
 *                   unlike a constant 0, and it is what lets the outbound
 *                   backpressure queue actually park under load.
 *
 * Events are subscribed *before* `connect()`, because HarmonyOS will drop an
 * `open` that arrives before a listener is attached.
 */
import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { RpcSocketHandle } from '../transport/RpcSocketSession';

/** WHATWG readyState values, mirrored locally (HarmonyOS does not expose them). */
const STATE_CONNECTING = 0;
const STATE_OPEN = 1;
const STATE_CLOSING = 2;
const STATE_CLOSED = 3;

export class HarmonyWebSocketHandle implements RpcSocketHandle {
  readonly openState: number = STATE_OPEN;

  private readonly socket: webSocket.WebSocket;
  private state: number = STATE_CONNECTING;
  private inFlightBytes: number = 0;
  private closed: boolean = false;

  private openHandler: () => void = () => {};
  private messageHandler: (data: string | ArrayBuffer) => void = () => {};
  private closeHandler: (code: number) => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  constructor(url: string) {
    this.socket = webSocket.createWebSocket();
    this.attach(url);
  }

  get readyState(): number {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.inFlightBytes;
  }

  /**
   * Sends one frame. Never throws: a failed write is reported through the close
   * path, which is what the caller actually reacts to.
   */
  send(frame: string | ArrayBuffer): void {
    if (this.state !== STATE_OPEN) {
      return;
    }
    const bytes = typeof frame === 'string' ? frame.length : frame.byteLength;
    this.inFlightBytes += bytes;
    this.socket
      .send(frame)
      .then(() => {
        this.inFlightBytes -= bytes;
        if (this.inFlightBytes < 0) {
          this.inFlightBytes = 0;
        }
      })
      .catch((error: BusinessError) => {
        this.inFlightBytes -= bytes;
        if (this.inFlightBytes < 0) {
          this.inFlightBytes = 0;
        }
        this.errorHandler(`send failed: ${error.code} ${error.message}`);
      });
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state = STATE_CLOSING;
    this.socket
      .close()
      .then(() => {
        // The platform `close` event does the state transition; this is a
        // fallback for the case where the socket was already gone.
        if (this.state !== STATE_CLOSED) {
          this.state = STATE_CLOSED;
        }
      })
      .catch((error: BusinessError) => {
        this.state = STATE_CLOSED;
        this.errorHandler(`close failed: ${error.code} ${error.message}`);
      });
  }

  /** Detaches every platform listener so a replaced handle cannot leak events. */
  detach(): void {
    this.socket.off('open');
    this.socket.off('message');
    this.socket.off('close');
    this.socket.off('error');
  }

  private attach(url: string): void {
    this.socket.on('open', (_error: BusinessError, _value: Object) => {
      this.state = STATE_OPEN;
      this.openHandler();
    });
    this.socket.on('message', (_error: BusinessError, value: string | ArrayBuffer) => {
      this.messageHandler(value);
    });
    this.socket.on('close', (_error: BusinessError, value: webSocket.CloseResult) => {
      this.state = STATE_CLOSED;
      this.inFlightBytes = 0;
      this.closeHandler(value === undefined ? -1 : value.code);
    });
    this.socket.on('error', (error: BusinessError) => {
      // An error is a symptom; the socket lifecycle ends through `close`.
      this.errorHandler(`${error.code} ${error.message}`);
    });
    // Fire-and-forget: the connect result is reported by the `open`/`error`
    // events, and the promise rejects for a launch that never started.
    this.socket.connect(url).catch((error: BusinessError) => {
      this.state = STATE_CLOSED;
      this.errorHandler(`connect failed: ${error.code} ${error.message}`);
    });
  }
}

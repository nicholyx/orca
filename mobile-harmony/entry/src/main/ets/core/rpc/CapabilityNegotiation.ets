/*
 * Advertises this client's runtime capabilities once the channel is up.
 *
 * The advisory is one-way and its result is discarded, so an unanswered request
 * says nothing about the link — only a frame that never reached the wire proves
 * the socket cannot carry traffic. Everything else (timeout, mid-flight drop)
 * settles like an explicit rejection: capabilities unavailable, proceed.
 *
 * The unsent case is therefore the only one that may fail the connection, and
 * it must: nothing else force-closes a socket that cannot send, and publishing
 * `connected` over such a socket would strand every later request.
 */
import { isRpcDeliveryUnknown, RpcResponse } from './RpcProtocol';
import {
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from './MobileRuntimeCapabilities';

export interface CapabilityNegotiationOptions {
  sendRequest: (method: string, params: Object) => Promise<RpcResponse>;
  /** False once this socket/generation is no longer the live one. */
  isCurrent: () => boolean;
  onReady: () => void;
  onFailure: () => void;
  /** Emits a connection-log line: level, message, detail, code. */
  emitLog: (level: string, message: string, detail: string, code: string) => void;
}

/** Resolves when the advisory settled; rejects only when it never reached the wire. */
export async function settleMobileRuntimeCapabilities(
  sendRequest: (method: string, params: Object) => Promise<RpcResponse>,
  emitLog: (level: string, message: string, detail: string, code: string) => void
): Promise<void> {
  let response: RpcResponse;
  try {
    response = await sendRequest(
      MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
      mobileRuntimeClientCapabilityUpdateParams()
    );
  } catch (error) {
    if (!isRpcDeliveryUnknown(error)) {
      // ArkTS only throws Error instances; keep real Errors as-is.
      throw error instanceof Error ? error : new Error(`capability advisory failed: ${JSON.stringify(error)}`);
    }
    emitLog(
      'warn',
      'Capability negotiation unanswered',
      'Advisory never confirmed — proceeding anyway',
      'capability-unanswered'
    );
    return;
  }
  if (!response.ok) {
    emitLog(
      'warn',
      'Capability negotiation unavailable',
      `Host refused the advisory: ${response.error?.code}`,
      'capability-unavailable'
    );
  }
}

export function negotiateMobileRuntimeCapabilities(options: CapabilityNegotiationOptions): void {
  settleMobileRuntimeCapabilities(options.sendRequest, options.emitLog)
    .then(() => {
      if (options.isCurrent()) {
        options.onReady();
      }
    })
    .catch((error: Object) => {
      if (!options.isCurrent()) {
        return;
      }
      // Unreachable wire: reconnecting is the only recovery.
      options.emitLog(
        'error',
        'Capability negotiation could not be sent',
        String(error),
        'capability-unsent'
      );
      options.onFailure();
    });
}

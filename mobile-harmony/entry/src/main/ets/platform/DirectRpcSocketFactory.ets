/*
 * Builds one dial's worth of transport: a fresh HarmonyOS socket, a fresh E2EE
 * v2 client session, and the session object that binds them.
 *
 * A new session per dial is not incidental — the E2EE v2 key schedule is bound
 * to the client nonce in the hello, so reusing a session across sockets would
 * reuse an ephemeral key and defeat forward secrecy. The factory exists to make
 * that per-dial construction the only path.
 *
 * The pinned desktop key comes from the pairing offer and is the sole basis for
 * trusting the peer: the session refuses a hello whose host key differs, so a
 * mismatched `e2ee_ready` fails the handshake instead of silently proceeding.
 */
import { RandomBytes } from '../core/crypto/RandomSource';
import { E2eeV2ClientSession } from '../core/e2ee/E2eeV2ClientSession';
import { RpcClientOptions, RpcSocketSessionFactory } from '../transport/RpcClient';
import { RpcSocketPreflight, RpcSocketSession } from '../transport/RpcSocketSession';
import { HarmonyWebSocketHandle } from './HarmonyWebSocketHandle';

/** The E2EE v2 hello's transport discriminator for a direct (non-relay) link. */
export const E2EE_V2_TRANSPORT_DIRECT = 'direct';

export class DirectRpcSocketFactory implements RpcSocketSessionFactory {
  private readonly random: RandomBytes;
  private readonly desktopPublicKeyB64: string;

  constructor(random: RandomBytes, desktopPublicKeyB64: string) {
    this.random = random;
    this.desktopPublicKeyB64 = desktopPublicKeyB64;
  }

  open(preflight: RpcSocketPreflight): RpcSocketSession | null {
    const session = E2eeV2ClientSession.create(this.random, {
      desktopPublicKeyB64: this.desktopPublicKeyB64,
      transport: E2EE_V2_TRANSPORT_DIRECT
    });
    const socket = new HarmonyWebSocketHandle(preflight.endpoint);
    return new RpcSocketSession(preflight, socket, session);
  }
}

/** Convenience: the client options for a direct link to one paired host. */
export function buildDirectClientOptions(args: {
  endpoint: string;
  deviceToken: string;
  desktopPublicKeyB64: string;
  random: RandomBytes;
  onStateChange: ((state: string) => void) | null;
  onLog: RpcClientOptions['onLog'];
}): RpcClientOptions {
  return {
    endpoint: args.endpoint,
    deviceToken: args.deviceToken,
    serverPublicKeyB64: args.desktopPublicKeyB64,
    factory: new DirectRpcSocketFactory(args.random, args.desktopPublicKeyB64),
    onStateChange: args.onStateChange,
    onLog: args.onLog
  };
}

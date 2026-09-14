/*
 * The client-side link: an ArkTS `RpcSocketHandle` on one end of an in-memory
 * pipe, with a real `DesktopPeer` on the other, re-created on every dial.
 *
 * This is what makes the end-to-end tests end-to-end. The client under test is
 * the shipped stack — `RpcClient`, `RpcSocketSession`, `E2eeV2PhysicalChannel`,
 * `E2eeV2ClientSession` — driven through its real `RpcSocketSessionFactory`
 * seam. Only the socket bytes are simulated.
 *
 * `readyState` and `bufferedAmount` are emulated here for the same reason the
 * HarmonyOS adapter emulates them: the underlying platform exposes neither.
 * Emulating them in the test as well means the emulation is exercised rather
 * than assumed — if the ordering is wrong, the outbound queue misbehaves here
 * exactly as it would on a device.
 */
import { E2eeV2ClientSession } from '../../entry/src/main/ets/core/e2ee/E2eeV2ClientSession.ets'
import { RandomBytes } from '../../entry/src/main/ets/core/crypto/RandomSource.ets'
import {
  RpcSocketHandle,
  RpcSocketPreflight,
  RpcSocketSession
} from '../../entry/src/main/ets/transport/RpcSocketSession.ets'
import { RpcSocketSessionFactory } from '../../entry/src/main/ets/transport/RpcClient.ets'
import { DesktopPeer, PipeSide, createPipe } from './desktop-peer'

const STATE_CONNECTING = 0
const STATE_OPEN = 1
const STATE_CLOSING = 2
const STATE_CLOSED = 3

/** The ArkTS socket contract, backed by one end of the simulated pipe. */
export class PipeSocketHandle implements RpcSocketHandle {
  readonly openState: number = STATE_OPEN

  private readonly side: PipeSide
  private state: number = STATE_CONNECTING
  private inFlight: number = 0
  private openHandler: () => void = () => {}
  private messageHandler: (data: string | ArrayBuffer) => void = () => {}
  private closeHandler: (code: number) => void = () => {}
  private errorHandler: (message: string) => void = () => {}

  constructor(side: PipeSide) {
    this.side = side
    side.setMessageHandler((data) => {
      if (this.state === STATE_OPEN) this.messageHandler(data)
    })
    side.setCloseHandler(() => {
      if (this.state === STATE_CLOSED) return
      this.state = STATE_CLOSED
      this.closeHandler(-1)
    })
    // A real socket opens asynchronously, after the caller has attached handlers.
    queueMicrotask(() => {
      if (this.state !== STATE_CONNECTING) return
      this.state = STATE_OPEN
      this.openHandler()
    })
  }

  get readyState(): number {
    return this.state
  }

  get bufferedAmount(): number {
    return this.inFlight
  }

  send(frame: string | ArrayBuffer): void {
    if (this.state !== STATE_OPEN) return
    const bytes = typeof frame === 'string' ? frame.length : frame.byteLength
    this.inFlight += bytes
    this.side.send(frame)
    // Settle on the next microtask: the queue's soft cap is meant to react to
    // bytes that were accepted but not yet drained.
    queueMicrotask(() => {
      this.inFlight -= bytes
      if (this.inFlight < 0) this.inFlight = 0
    })
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: (code: number) => void): void {
    this.closeHandler = handler
  }

  onError(handler: (message: string) => void): void {
    this.errorHandler = handler
  }

  close(): void {
    if (this.state === STATE_CLOSED) return
    this.state = STATE_CLOSING
    this.side.close()
  }

  /** Test hook: report a transport-level failure without a close event. */
  reportError(message: string): void {
    this.errorHandler(message)
  }
}

export interface LinkOptions {
  desktopPublicKeyB64: string
  random: RandomBytes
  /** Called with each new desktop peer, so a test can inspect every dial. */
  onPeer: (peer: DesktopPeer) => void
  makePeer: () => DesktopPeer
}

/**
 * The production factory seam, re-pointed at the simulated link. A new pipe and
 * a new desktop peer per dial, so a reconnect is a genuinely new socket.
 */
export class PipeSocketFactory implements RpcSocketSessionFactory {
  readonly peers: DesktopPeer[] = []
  readonly sockets: PipeSocketHandle[] = []
  private readonly options: LinkOptions

  constructor(options: LinkOptions) {
    this.options = options
  }

  latestPeer(): DesktopPeer | null {
    return this.peers.length === 0 ? null : this.peers[this.peers.length - 1]
  }

  /** Every desktop peer, so a test can assert across a reconnect. */
  open(preflight: RpcSocketPreflight): RpcSocketSession | null {
    const pipe = createPipe()
    const peer = this.options.makePeer()
    // The peer needs the far end; rebind it before anything is written.
    peer.attach(pipe.desktop)
    this.peers.push(peer)
    this.options.onPeer(peer)

    const socket = new PipeSocketHandle(pipe.client)
    this.sockets.push(socket)

    const session = E2eeV2ClientSession.create(this.options.random, {
      desktopPublicKeyB64: this.options.desktopPublicKeyB64,
      transport: 'direct'
    })
    return new RpcSocketSession(preflight, socket, session)
  }
}

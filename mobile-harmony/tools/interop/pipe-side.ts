/*
 * One end of the simulated socket the end-to-end harnesses dial through.
 *
 * Kept apart from `desktop-peer.ts` because it is the transport half of that
 * file: it knows nothing about the E2EE handshake or the RPC envelope, only how
 * a real socket sequences delivery — asynchronously, and with a close that
 * notifies both ends exactly once.
 */

/** One end of the simulated link. */
export class PipeSide {
  private messageHandler: (data: string | ArrayBuffer) => void = () => {}
  private closeHandler: () => void = () => {}
  private other: PipeSide | null = null
  private open: boolean = true
  /** Everything this side put on the wire, for "was it sealed?" assertions. */
  readonly sent: (string | ArrayBuffer)[] = []

  link(peer: PipeSide): void {
    this.other = peer
  }

  setMessageHandler(handler: (data: string | ArrayBuffer) => void): void {
    this.messageHandler = handler
  }

  setCloseHandler(handler: () => void): void {
    this.closeHandler = handler
  }

  isOpen(): boolean {
    return this.open
  }

  send(data: string | ArrayBuffer): void {
    if (!this.open) {return}
    this.sent.push(data)
    const peer = this.other
    if (peer === null || !peer.open) {return}
    // Asynchronous delivery: a real socket never re-enters the sender's stack.
    queueMicrotask(() => {
      if (peer.open) {peer.messageHandler(data)}
    })
  }

  /** Simulates the peer going away (network drop, not a graceful close). */
  drop(): void {
    this.open = false
    const peer = this.other
    if (peer !== null && peer.open) {
      peer.open = false
      queueMicrotask(() => peer.closeHandler())
    }
    queueMicrotask(() => this.closeHandler())
  }

  close(): void {
    this.drop()
  }
}

export function createPipe(): { client: PipeSide; desktop: PipeSide } {
  const client = new PipeSide()
  const desktop = new PipeSide()
  client.link(desktop)
  desktop.link(client)
  return { client, desktop }
}
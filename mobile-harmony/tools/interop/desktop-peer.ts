/*
 * An end-to-end peer: the REAL desktop side of a mobile session, wired to a
 * real client over an in-memory duplex.
 *
 * This file deliberately imports the desktop's own modules rather than
 * reimplementing them:
 *
 *   DesktopMobileE2EEV2Session        the production v2 handshake + key schedule
 *   handleDesktopMobileE2EEV2Inbound  the production inbound frame router
 *   authenticateMobileE2EE            the production auth validator
 *
 * So when `verify-e2e-interop.ts` passes, the ArkTS client has completed a real
 * handshake with a real desktop session object, sent frames the real desktop
 * decrypted, and had its auth frame accepted by the real validator — including
 * the exact-key-set check on the v2 auth shape. A reimplementation on the
 * harness side would prove nothing about that.
 *
 * The only thing simulated is the socket itself, and it is simulated honestly:
 * delivery is asynchronous (a microtask), binary arrives as an `ArrayBuffer`,
 * and a close notifies both ends exactly once.
 */
import nacl from 'tweetnacl'
import { DesktopMobileE2EEV2Session } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import { handleDesktopMobileE2EEV2Inbound } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-inbound'
import { authenticateMobileE2EE } from '../../../src/main/runtime/rpc/mobile-e2ee-auth-validation'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame
} from '../../../mobile/src/transport/terminal-stream-protocol'
import type { PipeSide } from './pipe-side'

const encoder = new TextEncoder()

export type DesktopRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type DesktopPeerOptions = {
  /** Fixed 32-byte secret so a failing run reproduces. */
  serverSecret: Uint8Array
  deviceToken: string
  /** Advertised terminals; `terminal.list` reports these. */
  terminals?: { id: string; title: string }[]
}

/**
 * The desktop's side of one connection.
 *
 * `resolveDevice` mirrors the runtime's device registry: it returns the device
 * for a token, which is what makes the "revoked pairing" scenario real rather
 * than a special case bolted onto the peer.
 */
export class DesktopPeer {
  private side: PipeSide | null = null
  private readonly options: DesktopPeerOptions
  private session: DesktopMobileE2EEV2Session | null = null
  private state: 'awaiting_hello' | 'awaiting_auth' | 'ready' = 'awaiting_hello'

  /** Set to false to simulate a revoked pairing. */
  deviceKnown: boolean = true

  /**
   * Why the peer tore the link down, empty while it is healthy. The desktop
   * closes a socket it cannot parse or decrypt, so a failing end-to-end test
   * needs this to report the cause instead of a bare "socket closed".
   */
  dropReason: string = ''

  private fail(reason: string): void {
    if (this.dropReason === '') {this.dropReason = reason}
    this.side?.drop()
  }

  // --- recordings ---------------------------------------------------------
  readonly rawInbound: (string | ArrayBuffer)[] = []
  readonly rpcMethods: string[] = []
  readonly rpcRequests: DesktopRequest[] = []
  readonly capabilityAdvertisements: string[][] = []
  readonly terminalSubscribeParams: Record<string, object>[] = []
  readonly terminalUnsubscribeParams: Record<string, object>[] = []
  readonly terminalSendTexts: string[] = []
  readonly authenticateAttempts: { ok: boolean; code: string }[] = []
  readonly outboundTextFrames: string[] = []
  readonly outboundBinaryFrames: number[] = []
  /** Stream ids the peer has been asked to stream, in order. */
  readonly subscribedStreamIds: number[] = []

  private nextStreamId = 1
  private readonly streamIdByTerminal = new Map<string, number>()

  constructor(options: DesktopPeerOptions) {
    this.options = options
  }

  /**
   * Binds this peer to an endpoint. Kept separate from the constructor because
   * the pipe is created first and the peer has to be recorded before any frame
   * can arrive.
   */
  attach(side: PipeSide): void {
    this.side = side
    side.setMessageHandler((data) => this.handleRaw(data))
    side.setCloseHandler(() => this.destroy())
  }

  /** The pinned key the client must have received from the pairing offer. */
  get publicKeyB64(): string {
    return Buffer.from(nacl.box.keyPair.fromSecretKey(this.options.serverSecret).publicKey).toString(
      'base64'
    )
  }

  isReady(): boolean {
    return this.state === 'ready'
  }

  private handleRaw(data: string | ArrayBuffer): void {
    this.rawInbound.push(data)

    if (this.state === 'awaiting_hello') {
      if (typeof data !== 'string') {
        return
      }
      this.handleHello(data)
      return
    }
    const session = this.session
    if (session === null) {return}
    handleDesktopMobileE2EEV2Inbound({
      session,
      raw: typeof data === 'string' ? data : new Uint8Array(data),
      awaitingAuth: this.state === 'awaiting_auth',
      onDecryptFailure: () => {
        // The desktop closes a socket it cannot decrypt; mirror the error path.
        this.fail('decrypt failure')
      },
      onDecryptSuccess: () => {},
      onAuth: (plaintext) => this.handleAuth(plaintext),
      onBinary: (plaintext) => this.handleBinary(plaintext),
      onText: (plaintext) => this.handleText(plaintext),
      onProtocolError: () => this.fail('binary frame before authentication')
    })
  }

  private handleHello(raw: string): void {
    let hello: object
    try {
      hello = JSON.parse(raw) as object
    } catch {
      this.fail('hello was not JSON')
      return
    }
    // Only v2 is accepted: the client under test must never fall back to legacy.
    const record = hello as Record<string, object>
    if (record.type !== 'e2ee_hello' || record.v !== 2) {
      this.fail(`unexpected hello type/version: ${String(record.type)}/${String(record.v)}`)
      return
    }
    const session = DesktopMobileE2EEV2Session.create({
      hello,
      serverSecretKey: this.options.serverSecret,
      expectedContext: { transport: 'direct' }
    })
    if (session === null) {
      this.fail(`DesktopMobileE2EEV2Session.create rejected the hello: ${raw.slice(0, 400)}`)
      return
    }
    this.session = session
    this.state = 'awaiting_auth'
    this.side?.send(JSON.stringify(session.ready))
  }

  private handleAuth(plaintext: string): void {
    const result = authenticateMobileE2EE({
      plaintext,
      v2Session: this.session,
      resolveDevice: (token) =>
        this.deviceKnown && token === this.options.deviceToken
          ? { deviceId: 'device-e2e', deviceToken: this.options.deviceToken, scope: 'mobile' }
          : null
    })
    this.authenticateAttempts.push(
      result.ok ? { ok: true, code: '' } : { ok: false, code: result.code }
    )
    if (!result.ok) {
      this.sendSealedText(
        JSON.stringify({ type: 'e2ee_error', error: { code: result.code } })
      )
      return
    }
    this.state = 'ready'
    this.sendSealedText(
      JSON.stringify({
        type: 'e2ee_authenticated',
        v: 2,
        transcriptHashB64: this.session === null ? '' : this.session.transcriptHashB64
      })
    )
  }

  private handleText(plaintext: string): void {
    let request: DesktopRequest
    try {
      request = JSON.parse(plaintext) as DesktopRequest
    } catch {
      return
    }
    if (typeof request.method !== 'string') {
      return
    }
    this.rpcMethods.push(request.method)
    this.rpcRequests.push(request)
    if (request.method === 'runtime.clientCapabilities.update') {
      const params = request.params as Record<string, object> | undefined
      const list = params === undefined ? [] : params.clientCapabilities
      this.capabilityAdvertisements.push(Array.isArray(list) ? (list as string[]) : [])
    }
    this.reply(request)
  }

  private handleBinary(_plaintext: Uint8Array): void {
    // The client does not stream binary to the desktop in this app.
  }

  /** Dispatches one RPC request and answers it, mirroring the runtime's shape. */
  private reply(request: DesktopRequest): void {
    const meta = { runtimeId: 'runtime-e2e' }
    if (request.method === 'status.get') {
      this.sendSealedText(
        JSON.stringify({ id: request.id, ok: true, result: { status: 'ok' }, _meta: meta })
      )
      return
    }
    if (request.method === 'terminal.list') {
      const terminals = this.options.terminals ?? []
      this.sendSealedText(
        JSON.stringify({ id: request.id, ok: true, result: terminals, _meta: meta })
      )
      return
    }
    if (request.method === 'terminal.subscribe') {
      const params = (request.params ?? {}) as Record<string, object>
      this.terminalSubscribeParams.push(params)
      const terminal = typeof params.terminal === 'string' ? (params.terminal as string) : ''
      const streamId = this.nextStreamId++
      this.streamIdByTerminal.set(terminal, streamId)
      this.subscribedStreamIds.push(streamId)
      this.sendSealedText(
        JSON.stringify({
          id: request.id,
          ok: true,
          streaming: true,
          result: { type: 'subscribed', streamId },
          _meta: meta
        })
      )
      return
    }
    if (request.method === 'terminal.unsubscribe') {
      this.terminalUnsubscribeParams.push((request.params ?? {}) as Record<string, object>)
      this.sendSealedText(
        JSON.stringify({ id: request.id, ok: true, result: {}, _meta: meta })
      )
      return
    }
    if (request.method === 'terminal.send') {
      const params = (request.params ?? {}) as Record<string, object>
      this.terminalSendTexts.push(typeof params.text === 'string' ? (params.text as string) : '')
      this.sendSealedText(JSON.stringify({ id: request.id, ok: true, result: {}, _meta: meta }))
      return
    }
    this.sendSealedText(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: 'method_not_found', message: `Unknown method: ${request.method}` },
        _meta: meta
      })
    )
  }

  // --- outbound terminal frames -------------------------------------------

  /** Pushes a whole-screen snapshot; the client must REPLACE its buffer. */
  sendScrollback(terminal: string, text: string, kind: string = 'scrollback'): boolean {
    const streamId = this.streamIdByTerminal.get(terminal)
    if (streamId === undefined) {return false}
    const metadata = encoder.encode(JSON.stringify({ kind }))
    this.sendTerminalFrame(streamId, TerminalStreamOpcode.SnapshotStart, metadata, 1)
    this.sendTerminalFrame(streamId, TerminalStreamOpcode.SnapshotChunk, encoder.encode(text), 2)
    this.sendTerminalFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array(0), 3)
    return true
  }

  /** Pushes incremental output; the client must APPEND it. */
  sendOutput(terminal: string, text: string, seq: number = 10): boolean {
    const streamId = this.streamIdByTerminal.get(terminal)
    if (streamId === undefined) {return false}
    this.sendTerminalFrame(streamId, TerminalStreamOpcode.Output, encoder.encode(text), seq)
    return true
  }

  private sendTerminalFrame(
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array,
    seq: number
  ): void {
    const session = this.session
    const side = this.side
    if (session === null || side === null || this.state !== 'ready') {return}
    const frame = encodeTerminalStreamFrame({ opcode, streamId, seq, payload })
    const sealed = session.sealBinary(frame)
    this.outboundBinaryFrames.push(sealed.byteLength)
    const buffer = new ArrayBuffer(sealed.byteLength)
    new Uint8Array(buffer).set(sealed)
    side.send(buffer)
  }

  private sendSealedText(plaintext: string): void {
    const session = this.session
    const side = this.side
    if (session === null || side === null) {return}
    const frame = session.sealText(plaintext)
    this.outboundTextFrames.push(frame)
    side.send(frame)
  }

  /** Test hook: tear the link down from the desktop's side. */
  drop(): void {
    this.side?.drop()
  }

  destroy(): void {
    this.session = null
    this.state = 'awaiting_hello'
  }
}

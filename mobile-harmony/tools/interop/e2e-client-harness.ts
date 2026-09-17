/*
 * Setup shared by the end-to-end scenario blocks.
 *
 * `startClient` is the whole point: it wires the shipped client stack to a
 * `PipeSocketFactory`, so every scenario dials the real desktop code over a
 * simulated socket rather than a mock. The secrets are fixed so a failing run
 * reproduces exactly.
 */
import nacl from 'tweetnacl'
import type { RpcClientOptions } from '../../entry/src/main/ets/transport/RpcClient.ets';
import { RpcClient } from '../../entry/src/main/ets/transport/RpcClient.ets'
import type { ConnectionLogEntry } from '../../entry/src/main/ets/core/rpc/ConnectionLog.ets'
import { DesktopPeer } from './desktop-peer'
import { PipeSocketFactory } from './client-link'

export const DEVICE_TOKEN = 'device-token-e2e'

/** Fixed secrets so a failing run reproduces exactly. */
export const DESKTOP_SECRET = new Uint8Array(32).fill(0x11)
export const OTHER_DESKTOP_SECRET = new Uint8Array(32).fill(0x22)
export const CLIENT_RANDOM_SEED = 0x5eed

/** Deterministic client randomness: xorshift32, mirroring the interop fixtures. */
export function seedRandom(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    for (let index = 0; index < length; index++) {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      out[index] = state & 0xff
    }
    return out
  }
}

export const desktopPublicKeyB64 = Buffer.from(
  nacl.box.keyPair.fromSecretKey(DESKTOP_SECRET).publicKey
).toString('base64')

export const TERMINALS = [
  { id: 'term-1', title: 'Shell 1' },
  { id: 'term-2', title: 'Shell 2' }
]

export async function waitFor(label: string, predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {return true}
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  console.error(`  … timed out waiting for: ${label}`)
  return predicate()
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export type Harness = {
  client: RpcClient
  factory: PipeSocketFactory
  states: string[]
  logs: ConnectionLogEntry[]
}

export function startClient(
  serverSecret: Uint8Array = DESKTOP_SECRET,
  deviceToken: string = DEVICE_TOKEN,
  configurePeer?: (peer: DesktopPeer) => void
): Harness {
  const states: string[] = []
  const logs: ConnectionLogEntry[] = []
  const factory = new PipeSocketFactory({
    desktopPublicKeyB64: Buffer.from(
      nacl.box.keyPair.fromSecretKey(serverSecret).publicKey
    ).toString('base64'),
    random: seedRandom(CLIENT_RANDOM_SEED),
    onPeer: (peer) => {
      if (configurePeer !== undefined) {configurePeer(peer)}
    },
    makePeer: () =>
      new DesktopPeer({
        serverSecret,
        deviceToken,
        terminals: TERMINALS
      })
  })
  const options: RpcClientOptions = {
    endpoint: 'ws://192.168.1.20:7788',
    deviceToken,
    serverPublicKeyB64: desktopPublicKeyB64,
    factory,
    onStateChange: (state: string) => {
      states.push(state)
    },
    onLog: (entry: ConnectionLogEntry) => {
      logs.push(entry)
    }
  }
  return { client: new RpcClient(options), factory, states, logs }
}
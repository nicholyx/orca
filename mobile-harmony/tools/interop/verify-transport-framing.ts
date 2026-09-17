/*
 * Terminal stream framing, the terminal router, and the browser-screencast decoder.
 *
 * Split out of `verify-transport-interop.ts`; the entry point runs every module
 * so the assertions still report through one counters and one summary.
 */
import { check, section, bytesEqualCheck, fixture, equalHex, hex, jsonEqual } from './harness'
import * as hTerminal from '../../entry/src/main/ets/core/rpc/TerminalStreamProtocol.ets'
import * as hScreencast from '../../entry/src/main/ets/core/rpc/BrowserScreencastProtocol.ets'
import { TerminalStreamRouter } from '../../entry/src/main/ets/core/rpc/TerminalStreamRouter.ets'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame
} from '../../../mobile/src/transport/terminal-stream-protocol'
import { decodeBrowserScreencastFrame } from '../../../mobile/src/transport/browser-screencast-protocol'

const encoder = new TextEncoder()

export function runFramingSections(): void {
  // ---------------------------------------------------------------------------
  // 12. Terminal stream protocol
  // ---------------------------------------------------------------------------

  section('12. terminal stream protocol')

  {
    for (const opcode of [1, 2, 3, 4, 5, 6, 12]) {
      for (const streamId of [0, 1, 255, 65535, 0x7fffffff, 0xffffffff]) {
        for (const seq of [0, 1, 255, 65535, 0x100000000, 2 ** 40, 0xffffffffffff]) {
          const payload = fixture(13, opcode * 31 + (seq % 97))
          const frame = { opcode, streamId, seq, payload }

          const ours = hTerminal.encodeTerminalStreamFrame(frame)
          const reference = encodeTerminalStreamFrame(frame)
          const label = `opcode=${opcode} streamId=${streamId} seq=${seq}`
          check(`encode matches reference ${label}`, equalHex(ours, reference), `${hex(ours)} vs ${hex(reference)}`)

          const decodedOurs = hTerminal.decodeTerminalStreamFrame(reference)
          const decodedReference = decodeTerminalStreamFrame(ours)
          check(
            `round-trip matches reference ${label}`,
            decodedOurs !== null &&
              decodedReference !== null &&
              decodedOurs.opcode === decodedReference.opcode &&
              decodedOurs.streamId === decodedReference.streamId &&
              decodedOurs.seq === decodedReference.seq &&
              equalHex(decodedOurs.payload, decodedReference.payload)
          )
        }
      }
    }

    // Header is parsed by offset on the host, so byte positions are frozen.
    {
      const frame = { opcode: 3, streamId: 0x01020304, seq: 0x0000aabbccddeeff, payload: new Uint8Array([1, 2, 3]) }
      const bytes = hTerminal.encodeTerminalStreamFrame(frame)
      check('kind byte is 0x74', bytes[0] === 0x74)
      check('version byte is 1', bytes[1] === 1)
      check('opcode byte', bytes[2] === 3)
      check('reserved byte', bytes[3] === 0)
      check('streamId is little-endian', hex(bytes.subarray(4, 8)) === '04030201')
      // seq = 0x0000aabbccddeeff → high half 0x0000aabb, low half 0xccddeeff.
      check('seq high is little-endian', hex(bytes.subarray(8, 12)) === 'bbaa0000', hex(bytes.subarray(8, 12)))
      check('seq low is little-endian', hex(bytes.subarray(12, 16)) === 'ffeeddcc', hex(bytes.subarray(12, 16)))
      check('payload follows the header', hex(bytes.subarray(16)) === '010203')
    }

    check('output opcode mirrors the reference', TerminalStreamOpcode.Output === hTerminal.TERMINAL_OPCODE_OUTPUT)
    check('metadata opcode value', hTerminal.TERMINAL_OPCODE_METADATA === 12)
    check('kind constant', hTerminal.TERMINAL_STREAM_KIND === 0x74)

    const badFrames: [string, Uint8Array][] = [
      ['short frame', fixture(15, 1)],
      ['empty frame', new Uint8Array(0)],
      ['wrong kind', (() => { const b = fixture(32, 2); b[0] = 0x62; return b })()],
      ['wrong version', (() => { const b = fixture(32, 3); b[1] = 2; return b })()],
      ['unknown opcode', (() => { const b = fixture(32, 4); b[2] = 99; return b })()]
    ]
    for (const [label, bytes] of badFrames) {
      const ours = hTerminal.decodeTerminalStreamFrame(bytes)
      const reference = decodeTerminalStreamFrame(bytes)
      check(`both reject ${label}`, (ours === null) === (reference === null), `ours=${ours === null} ref=${reference === null}`)
    }

    check('opcode guard accepts 1..6 and 12', [1, 2, 3, 4, 5, 6, 12].every((v) => hTerminal.isTerminalStreamOpcode(v)))
    check('opcode guard rejects 0 and 13', !hTerminal.isTerminalStreamOpcode(0) && !hTerminal.isTerminalStreamOpcode(13))
  }

  // ---------------------------------------------------------------------------
  // 13. Terminal stream router
  // ---------------------------------------------------------------------------

  section('13. terminal stream router')

  {
    const router = new TerminalStreamRouter()
    const events: string[] = []
    router.register('rpc-1', 7, (event) => {
      events.push(`${event.type}:${event.streamId}:${event.chunk}${event.serialized}`)
    })

    const output = (seq: number, text: string): Uint8Array =>
      hTerminal.encodeTerminalStreamFrame({ opcode: 1, streamId: 7, seq, payload: encoder.encode(text) })
    const json = (opcode: number, seq: number, value: unknown): Uint8Array =>
      hTerminal.encodeTerminalStreamFrame({ opcode, streamId: 7, seq, payload: encoder.encode(JSON.stringify(value)) })
    const chunk = (seq: number, text: string): Uint8Array =>
      hTerminal.encodeTerminalStreamFrame({ opcode: 3, streamId: 7, seq, payload: encoder.encode(text) })
    const empty = (opcode: number, seq: number): Uint8Array =>
      hTerminal.encodeTerminalStreamFrame({ opcode, streamId: 7, seq, payload: new Uint8Array(0) })

    router.handle(output(0, 'hello '))
    router.handle(output(1, 'world'))
    check('output frames emit data events', events.join('|') === 'data:7:hello |data:7:world', events.join('|'))

    // A snapshot is reassembled across frames and emitted once, at the end.
    router.handle(json(2, 2, { kind: 'scrollback', cols: 120 }))
    router.handle(chunk(3, 'line1\n'))
    router.handle(chunk(4, 'line2\n'))
    check('snapshot chunks emit nothing before the end', events.length === 2)
    router.handle(empty(4, 5))
    check('snapshot end emits one assembled event', events[2] === 'scrollback:7:line1\nline2\n', events[2])

    // `kind: resized` replays as `resized`, not `scrollback`.
    router.handle(json(2, 6, { kind: 'resized' }))
    router.handle(chunk(7, 'r'))
    router.handle(empty(4, 8))
    check('resized snapshot emits resized', events[3] === 'resized:7:r', events[3])

    router.handle(json(5, 9, { cols: 80, rows: 24 }))
    check('resized opcode emits resized event', events[4] === 'resized:7:', events[4])
    router.handle(json(12, 10, { title: 'zsh' }))
    check('metadata opcode emits metadata event', events[5] === 'metadata:7:', events[5])
    router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 6, streamId: 7, seq: 11, payload: encoder.encode('boom') }))
    check('error opcode emits error event', events[6] === 'error:7:', events[6])

    const before = events.length
    router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 1, streamId: 999, seq: 0, payload: encoder.encode('nope') }))
    check('frames for unknown streams are ignored', events.length === before)
    router.handle(chunk(12, 'orphan'))
    check('a chunk with no snapshot start is ignored', events.length === before)
    router.handle(hTerminal.encodeTerminalStreamFrame({ opcode: 2, streamId: 7, seq: 13, payload: encoder.encode('{oops') }))
    check('a malformed snapshot start is ignored', events.length === before)

    check('router tracks one stream', router.trackedStreamCount() === 1)
    router.reset('rpc-1')
    check('reset drops the stream', router.trackedStreamCount() === 0)
    router.handle(output(14, 'after reset'))
    check('frames after reset are ignored', events.length === before)
  }

  // ---------------------------------------------------------------------------
  // 14. Browser screencast protocol
  // ---------------------------------------------------------------------------

  section('14. browser screencast protocol')

  {
    const metadata = { offsetTop: 12.5, pageScaleFactor: 1.25, imageWidth: 800, imageHeight: 600, timestamp: 12345 }
    const metadataBytes = encoder.encode(JSON.stringify(metadata))
    const image = fixture(64, 5)

    const frame = new Uint8Array(16 + metadataBytes.length + image.length)
    frame[0] = 0x62
    frame[1] = 1
    frame[2] = 1
    frame[3] = 1 // jpeg
    const view = new DataView(frame.buffer)
    view.setUint32(4, 42, true)
    view.setUint32(8, metadataBytes.length, true)
    view.setUint32(12, 0, true)
    frame.set(metadataBytes, 16)
    frame.set(image, 16 + metadataBytes.length)

    const ours = hScreencast.decodeBrowserScreencastFrame(frame)
    const reference = decodeBrowserScreencastFrame(frame)
    check('decodes a frame', ours !== null && reference !== null)
    check('seq matches reference', ours!.seq === reference!.seq && ours!.seq === 42)
    check('format matches reference', ours!.format === reference!.format && ours!.format === 'jpeg')
    check('metadata matches reference', jsonEqual(ours!.metadata, reference!.metadata))
    bytesEqualCheck('image matches reference', ours!.image, reference!.image)

    const png = Uint8Array.from(frame)
    png[3] = 2
    check('png format', hScreencast.decodeBrowserScreencastFrame(png)!.format === 'png')

    const badFrames: [string, Uint8Array][] = [
      ['short frame', frame.subarray(0, 15)],
      ['wrong kind', (() => { const b = Uint8Array.from(frame); b[0] = 0x74; return b })()],
      ['wrong version', (() => { const b = Uint8Array.from(frame); b[1] = 2; return b })()],
      ['wrong opcode', (() => { const b = Uint8Array.from(frame); b[2] = 2; return b })()],
      ['unknown format', (() => { const b = Uint8Array.from(frame); b[3] = 9; return b })()],
      ['non-zero reserved', (() => { const b = Uint8Array.from(frame); new DataView(b.buffer).setUint32(12, 1, true); return b })()],
      [
        'metadata length past the end',
        (() => {
          const b = Uint8Array.from(frame)
          new DataView(b.buffer).setUint32(8, b.length, true)
          return b
        })()
      ],
      [
        'metadata that is not JSON',
        (() => {
          const b = Uint8Array.from(frame)
          b[16] = 0x7b
          b[17] = 0x6f
          return b
        })()
      ]
    ]
    for (const [label, bytes] of badFrames) {
      const oursBad = hScreencast.decodeBrowserScreencastFrame(bytes)
      const referenceBad = decodeBrowserScreencastFrame(bytes)
      check(`both reject ${label}`, (oursBad === null) === (referenceBad === null), `ours=${oursBad === null} ref=${referenceBad === null}`)
    }

    const extraBytes = encoder.encode(JSON.stringify({ ...metadata, bogusKey: 7 }))
    const extraFrame = new Uint8Array(16 + extraBytes.length)
    extraFrame[0] = 0x62
    extraFrame[1] = 1
    extraFrame[2] = 1
    extraFrame[3] = 2
    new DataView(extraFrame.buffer).setUint32(8, extraBytes.length, true)
    extraFrame.set(extraBytes, 16)
    const extraOurs = hScreencast.decodeBrowserScreencastFrame(extraFrame)!
    const extraReference = decodeBrowserScreencastFrame(extraFrame)!
    check('unknown metadata keys are dropped', !('bogusKey' in extraOurs.metadata))
    check('known metadata survives', jsonEqual(extraOurs.metadata, extraReference.metadata))
  }

}

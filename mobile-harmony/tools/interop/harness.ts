/*
 * Shared assertion plumbing for the interop harnesses.
 *
 * Kept in its own module so both entry points report through the same counters
 * and the same PASS/FAIL summary format.
 */

let assertions = 0
let failures = 0
const failedChecks: string[] = []

export function check(name: string, condition: boolean, detail?: string): void {
  assertions++
  if (condition) return
  failures++
  failedChecks.push(name)
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

export function section(title: string): void {
  console.log(`\n${title}`)
}

export function equalHex(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

export function bytesEqualCheck(label: string, actual: Uint8Array | null, expected: Uint8Array): void {
  if (actual === null) {
    check(label, false, 'got null')
    return
  }
  const same = equalHex(actual, expected)
  check(label, same, same ? undefined : `got ${hex(actual)} want ${hex(expected)}`)
}

/** Deterministic byte stream so both implementations see the same input. */
export function fixture(length: number, seed: number): Uint8Array {
  let state = seed >>> 0
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out[i] = state & 0xff
  }
  return out
}

/** Deep structural comparison that tolerates key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
    return out
  }
  return value
}

export function finish(label: string): never {
  console.log(`\n${'─'.repeat(64)}`)
  if (failures === 0) {
    console.log(`PASS  ${assertions} assertions — ${label}`)
  } else {
    console.error(`FAIL  ${failures} of ${assertions} assertions failed:`)
    for (const name of failedChecks.slice(0, 40)) console.error(`  · ${name}`)
    if (failedChecks.length > 40) console.error(`  … and ${failedChecks.length - 40} more`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

export function counts(): { assertions: number; failures: number } {
  return { assertions, failures }
}

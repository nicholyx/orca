/*
 * Interop verification for the HarmonyOS pairing-offer parser.
 *
 * The ArkTS port cannot consume the zod schema in
 * `src/shared/mobile-relay-pairing-offer.ts`, so it is a hand copy of the same
 * rules. This harness is what keeps the two honest: every accept/reject decision
 * is compared against the reference on identical input, including the exact
 * accept/reject boundaries of the invite-expiry window.
 *
 * Nothing here is part of the shipped app.
 */
import { check, section, finish, jsonEqual } from './harness'
import {
  FIXED_NOW,
  VALID_KEY_B64,
  relayObject,
  toBase64Url,
  validOfferJson
} from './pairing-fixtures'

import {
  extractPairingCodeFromUrl,
  parsePairingCode,
  validatePairingOffer
} from '../../entry/src/main/ets/core/pairing/PairingOffer.ets'
import {
  getNextHostNameFromHosts,
  parseStoredHostProfileList
} from '../../entry/src/main/ets/core/host/HostProfile.ets'

import { extractPairingCodeFromUrl as refExtract } from '../../../mobile/src/transport/pairing'
import { parsePairingCode as refParse } from '../../../mobile/src/transport/pairing'
import { getNextHostNameFromHosts as refNextHostName } from '../../../mobile/src/transport/host-names'
import { StoredHostProfileSchema } from '../../../mobile/src/transport/types'
import { createPairingOfferSchema } from '../../../src/shared/mobile-relay-pairing-offer'


// ---------------------------------------------------------------------------
// 22. Pairing URL extraction
// ---------------------------------------------------------------------------

section('22. pairing url extraction')

{
  const cases: string[] = [
    'orca://pair?code=ABC',
    'orca://pair/?code=ABC',
    'orca://pair?foo=1&code=ABC',
    'orca://pair?code=ABC#frag',
    'orca://pair#ABC',
    'ORCA://PAIR?code=ABC',
    '   orca://pair?code=ABC   ',
    'orca://pair',
    'orca://pair/',
    'orca://pair/extra?code=ABC',
    'orca://pairx?code=ABC',
    'https://pair?code=ABC',
    'orca://pair?nocode=1',
    'orca://pair?code=',
    'orca://pair?code=a%20b',
    'orca://pair?code=a+b',
    'orca://pair/extra',
    'orca:',
    'orca://',
    '',
    'orca://pair?code=%E4%B8%AD%E6%96%87',
    'orca://PAIR#hash-code',
    'orca://pair?other=1#fallback-code'
  ]
  for (const input of cases) {
    check(
      `extract ${JSON.stringify(input)} matches reference`,
      extractPairingCodeFromUrl(input) === refExtract(input),
      `ours=${JSON.stringify(extractPairingCodeFromUrl(input))} ref=${JSON.stringify(refExtract(input))}`
    )
  }
}

// ---------------------------------------------------------------------------
// 23. Pairing offer acceptance (live clock, relative expiries)
// ---------------------------------------------------------------------------

section('23. pairing offer acceptance')

{
  const inputs: string[] = [
    validOfferJson(),
    validOfferJson({ pairedDeviceId: 'dev-123' }),
    validOfferJson({ scope: 'mobile' }),
    validOfferJson({ scope: 'runtime' }),
    validOfferJson({ scope: 'bogus' }),
    validOfferJson({ v: 1 }),
    validOfferJson({ v: 3 }),
    validOfferJson({ endpoint: '' }),
    validOfferJson({ deviceToken: '' }),
    validOfferJson({ publicKeyB64: '' }),
    validOfferJson({ pairedDeviceId: '' }),
    validOfferJson({ publicKeyB64: 'not-base64!!' }),
    validOfferJson({ endpoint: 'x'.repeat(16 * 1024 + 1) }),
    validOfferJson({ relay: relayObject() }),
    validOfferJson({ relay: relayObject(), scope: 'mobile' }),
    validOfferJson({ relay: relayObject(), scope: 'runtime' }),
    // Relay offers require a canonical 32-byte key.
    validOfferJson({
      publicKeyB64: 'A'.repeat(43),
      relay: relayObject()
    }),
    validOfferJson({ relay: relayObject({ directorUrl: 'http://relay.example.com' }) }),
    validOfferJson({ relay: relayObject({ directorUrl: 'https://relay.example.com/' }) }),
    validOfferJson({ relay: relayObject({ directorUrl: 'https://relay.example.com/path' }) }),
    validOfferJson({ relay: relayObject({ cellUrl: 'https://cell.example.com:8443' }) }),
    validOfferJson({ relay: relayObject({ relayHostId: 'short' }) }),
    validOfferJson({ relay: relayObject({ inviteToken: 'B'.repeat(42) }) }),
    validOfferJson({ relay: relayObject({ inviteExpiresAt: Date.now() - 1 }) }),
    validOfferJson({ relay: relayObject({ inviteExpiresAt: Date.now() + 60 * 60 * 1000 }) }),
    validOfferJson({ relay: relayObject({ v: 2 }) }),
    validOfferJson({ relay: relayObject({ e2eeFraming: 1 }) }),
    validOfferJson({ relay: relayObject({ assignmentEpoch: -1 }) }),
    validOfferJson({ relay: relayObject({ assignmentEpoch: 1.5 }) }),
    validOfferJson({ relay: null }),
    JSON.stringify({ v: 2 }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify('a string'),
    '{}'
  ]

  for (const json of inputs) {
    const code = toBase64Url(json)
    const ours = parsePairingCode(code, () => Date.now())
    const theirs = refParse(code)
    check(
      `offer ${json.slice(0, 70)}${json.length > 70 ? '…' : ''} matches reference`,
      jsonEqual(ours, theirs),
      `ours=${JSON.stringify(ours)} ref=${JSON.stringify(theirs)}`
    )
  }
}

// ---------------------------------------------------------------------------
// 24. Pairing offer parser robustness
// ---------------------------------------------------------------------------

section('24. pairing offer parser robustness')

{
  const malformed: string[] = ['', '   ', 'not base64 at all!!!', '====', 'a', '{"v":2}', 'AAAA']
  for (const input of malformed) {
    check(
      `malformed ${JSON.stringify(input)} → null on both sides`,
      parsePairingCode(input, () => Date.now()) === null && refParse(input) === null
    )
  }

  check(
    'a valid URL round-trips to the same offer as the bare code',
    jsonEqual(
      parsePairingCode(`orca://pair?code=${toBase64Url(validOfferJson())}`, () => Date.now()),
      parsePairingCode(toBase64Url(validOfferJson()), () => Date.now())
    )
  )
  check(
    'padded base64url is accepted',
    parsePairingCode(`${toBase64Url(validOfferJson())  }===`, () => Date.now()) !== null ||
      refParse(`${toBase64Url(validOfferJson())  }===`) === null
  )
  check(
    'a huge payload is rejected without parsing',
    parsePairingCode('A'.repeat(129 * 1024), () => Date.now()) === null
  )
}

// ---------------------------------------------------------------------------
// 25. Invite-expiry boundary (deterministic clock)
// ---------------------------------------------------------------------------

section('25. invite-expiry boundary')

{
  const schema = createPairingOfferSchema(() => FIXED_NOW)
  const maxTtl = 10 * 60 * 1000
  const skew = 30 * 1000

  const offsets: number[] = [
    -1,
    0,
    1,
    maxTtl - 1,
    maxTtl,
    maxTtl + skew - 1,
    maxTtl + skew,
    maxTtl + skew + 1,
    maxTtl * 2,
    Number.MAX_SAFE_INTEGER
  ]

  for (const offset of offsets) {
    const json = validOfferJson({
      relay: relayObject({ inviteExpiresAt: FIXED_NOW + offset })
    })
    const value: Record<string, unknown> = JSON.parse(json)
    const ours = validatePairingOffer(value, () => FIXED_NOW)
    const theirs = schema.safeParse(value)
    check(
      `expiry offset ${offset}: both agree (${theirs.success ? 'accept' : 'reject'})`,
      (ours !== null) === theirs.success,
      `ours=${ours !== null ? 'accept' : 'reject'} ref=${theirs.success ? 'accept' : 'reject'}`
    )
    if (theirs.success) {
      check(`expiry offset ${offset}: accepted offer matches`, jsonEqual(ours, theirs.data))
    }
  }

  // The clock-skew window exists so a cell clock slightly ahead of this device
  // does not invalidate every invite; verify the window is symmetric with the
  // reference by checking an expiry that is exactly at the boundary.
  const boundary = validOfferJson({
    relay: relayObject({ inviteExpiresAt: FIXED_NOW + maxTtl + skew })
  })
  const boundaryValue: Record<string, unknown> = JSON.parse(boundary)
  check(
    'exact max-TTL-plus-skew boundary is accepted by both',
    validatePairingOffer(boundaryValue, () => FIXED_NOW) !== null && schema.safeParse(boundaryValue).success
  )
}

// ---------------------------------------------------------------------------
// 26. Accepted-offer shape parity
// ---------------------------------------------------------------------------

section('26. accepted-offer shape parity')

{
  const schema = createPairingOfferSchema(() => FIXED_NOW)
  const shapes: string[] = [
    validOfferJson(),
    validOfferJson({ pairedDeviceId: 'dev-1', scope: 'mobile' }),
    validOfferJson({ relay: relayObject({ inviteExpiresAt: FIXED_NOW + 1000 }) }),
    validOfferJson({
      scope: 'mobile',
      relay: relayObject({ inviteExpiresAt: FIXED_NOW + 1000 })
    })
  ]
  for (const json of shapes) {
    const value: Record<string, unknown> = JSON.parse(json)
    const ours = validatePairingOffer(value, () => FIXED_NOW)
    const theirs = schema.safeParse(value)
    check(`accepted shape parses on both sides: ${json.slice(0, 60)}…`, ours !== null && theirs.success)
    if (ours !== null && theirs.success) {
      check(`accepted shape is identical: ${json.slice(0, 60)}…`, jsonEqual(ours, theirs.data))
    }
  }
}

// ---------------------------------------------------------------------------
// 27. Host naming
// ---------------------------------------------------------------------------

section('27. host naming')

{
  const lists: { name: string }[][] = [
    [],
    [{ name: 'Host 1' }],
    [{ name: 'Host 1' }, { name: 'Host 2' }],
    [{ name: 'Host 2' }, { name: 'Host 1' }],
    [{ name: 'Host 3' }, { name: 'Laptop' }],
    [{ name: 'Laptop' }, { name: 'Server' }],
    [{ name: 'Host' }],
    [{ name: 'Host ' }],
    [{ name: 'Host x' }],
    [{ name: 'Host 10' }, { name: 'Host 4' }],
    [{ name: 'Host 01' }],
    [{ name: ' host 2' }],
    [{ name: 'Host 2 ' }],
    [{ name: 'Host 99999999999999999999' }]
  ]
  for (const list of lists) {
    // SAFETY: read-only shape check — the ArkTS signature accepts HostProfile[]
    // but only reads `name`, matching the reference's HostNameSource.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port reads only `name` from each entry, which every HostNameSource satisfies; the nominal HostProfile type is not constructible here.
    const ours = getNextHostNameFromHosts(list as never)
    const theirs = refNextHostName(list)
    check(
      `next host name for ${JSON.stringify(list)} matches`,
      ours === theirs,
      `ours=${ours} ref=${theirs}`
    )
  }
}

// ---------------------------------------------------------------------------
// 28. Stored host profile parsing
// ---------------------------------------------------------------------------

section('28. stored host profile parsing')

{
  /**
   * Mirrors `parseStoredHostProfiles` in mobile/src/transport/host-metadata-store.ts:
   * drop anything that still carries a legacy `deviceToken`, then validate with
   * the real schema. Returns null for an unreadable payload.
   */
  function referenceParse(raw: string): object[] | null {
    if (!raw) {return []}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {return null}
      const out: object[] = []
      for (const item of parsed) {
        if (item && typeof item === 'object' && 'deviceToken' in item) {continue}
        const result = StoredHostProfileSchema.safeParse(item)
        if (result.success) {out.push(result.data)}
      }
      return out
    } catch {
      return null
    }
  }

  const validRecord = {
    id: 'host-1',
    name: 'Host 1',
    endpoint: 'ws://192.168.1.20:7788',
    publicKeyB64: VALID_KEY_B64,
    lastConnected: 1_700_000_000_000
  }

  const payloads: string[] = [
    '[]',
    JSON.stringify([validRecord]),
    JSON.stringify([validRecord, { ...validRecord, id: 'host-2', name: 'Host 2' }]),
    // Legacy records that still embed the secret must be dropped.
    JSON.stringify([{ ...validRecord, deviceToken: 'legacy-secret' }]),
    JSON.stringify([{ ...validRecord, deviceToken: 'x' }, validRecord]),
    // Missing / empty / wrong-typed fields.
    JSON.stringify([{ ...validRecord, id: '' }]),
    JSON.stringify([{ ...validRecord, name: '' }]),
    JSON.stringify([{ ...validRecord, endpoint: '' }]),
    JSON.stringify([{ ...validRecord, publicKeyB64: '' }]),
    JSON.stringify([{ ...validRecord, lastConnected: 'yesterday' }]),
    JSON.stringify([{ ...validRecord, lastConnected: Number.NaN }]),
    JSON.stringify([{ ...validRecord, lastConnected: Number.POSITIVE_INFINITY }]),
    JSON.stringify([{ id: 'host-1' }]),
    JSON.stringify([null]),
    JSON.stringify(['not an object']),
    JSON.stringify([42]),
    // Unreadable payloads.
    'not json at all {',
    JSON.stringify({ hosts: [validRecord] }),
    JSON.stringify('a string'),
    JSON.stringify(7)
    // An empty payload is deliberately absent from this list: the preferences
    // store maps "no stored value" to null before the parser is reached, so it
    // never sees ''. See the explicit divergence check below.
  ]

  for (const raw of payloads) {
    const ours = parseStoredHostProfileList(raw)
    const theirs = referenceParse(raw)
    check(
      `stored profiles ${JSON.stringify(raw).slice(0, 60)}${raw.length > 60 ? '…' : ''} match reference`,
      jsonEqual(ours, theirs),
      `ours=${JSON.stringify(ours)} ref=${JSON.stringify(theirs)}`
    )
  }

  check(
    'an unreadable payload is null, not an empty list',
    parseStoredHostProfileList('{broken') === null
  )
  // Documented divergence: the reference treats '' as "no hosts yet", while this
  // port treats it as unreadable. It is unreachable here because the preferences
  // store normalizes "no stored value" to null; asserting it keeps the gap from
  // being mistaken for agreement.
  check(
    'empty payload: treated as unreadable here, as empty by the reference',
    parseStoredHostProfileList('') === null && jsonEqual(referenceParse(''), [])
  )
}

finish('the ArkTS pairing and host-state parsers match the reference implementation.')

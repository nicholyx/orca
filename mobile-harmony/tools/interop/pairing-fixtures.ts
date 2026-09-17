/*
 * Offer fixtures shared by the pairing harness sections.
 *
 * `validOfferJson` and `relayObject` exist so every section can perturb exactly
 * one field of an otherwise-accepted offer — that is what makes the accept/reject
 * boundaries meaningful rather than a pile of unrelated literals.
 */

export const FIXED_NOW = 1_800_000_000_000

/** A canonical 32-byte Curve25519 key, standard base64 with padding. */
export const VALID_KEY_B64 = Buffer.from(Uint8Array.from({ length: 32 }, (_v, i) => i)).toString('base64')

export function toBase64Url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function validOfferJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    endpoint: 'ws://192.168.1.20:7788',
    deviceToken: 'device-token-abc',
    publicKeyB64: VALID_KEY_B64,
    ...overrides
  })
}

export function relayObject(overrides: Record<string, unknown> = {}, now = Date.now()): Record<string, unknown> {
  return {
    v: 1,
    directorUrl: 'https://relay.example.com',
    cellUrl: 'https://cell.example.com',
    assignmentEpoch: 7,
    relayHostId: 'ABCDEFGHIJKLMNOP',
    inviteToken: 'A'.repeat(43),
    inviteExpiresAt: now + 60_000,
    e2eeFraming: 2,
    ...overrides
  }
}
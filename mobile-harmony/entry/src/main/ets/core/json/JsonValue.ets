/*
 * Typed JSON access for ArkTS.
 *
 * ArkTS bans `any`/`unknown`, so `JSON.parse` must be pinned to a concrete type
 * and every dynamic read narrowed with `typeof`. Keeping that in one place
 * stops the wire decoders from growing ad-hoc casts.
 *
 * The extracted value then gets copied into a declared interface, so the rest of
 * the app deals in real types rather than index lookups.
 */

/** Parses a JSON object; null for arrays, scalars and malformed input. */
export function parseJsonRecord(text: string): Record<string, Object> | null {
  let parsed: Record<string, Object>;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return null;
  }
  if (parsed === null || parsed === undefined) {
    return null;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

export function asRecord(value: Object | null | undefined): Record<string, Object> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, Object> = value as Record<string, Object>;
  return record;
}

export function asString(value: Object | null | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: Object | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Non-nullable finite-number test, for internal range and cap checks. */
export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function asBoolean(value: Object | null | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function asArray(value: Object | null | undefined): Object[] | null {
  return Array.isArray(value) ? value : null;
}

/** Reads a number array, or null when any element is not a finite number. */
export function asNumberArray(value: Object | null | undefined): number[] | null {
  const array = asArray(value);
  if (array === null) {
    return null;
  }
  const out: number[] = [];
  for (let index = 0; index < array.length; index++) {
    const element = asNumber(array[index]);
    if (element === null) {
      return null;
    }
    out.push(element);
  }
  return out;
}

/** Reads a string array, or null when any element is not a string. */
export function asStringArray(value: Object | null | undefined): string[] | null {
  const array = asArray(value);
  if (array === null) {
    return null;
  }
  const out: string[] = [];
  for (let index = 0; index < array.length; index++) {
    const element = asString(array[index]);
    if (element === null) {
      return null;
    }
    out.push(element);
  }
  return out;
}

/**
 * True when the record carries exactly `expected` keys — no missing field and no
 * additive one. The reference protocol rejects unknown keys so a field added on
 * one side cannot be silently reinterpreted by the other.
 */
export function hasExactKeys(
  record: Record<string, Object>,
  expected: string[]
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = expected.slice();
  wanted.sort();
  if (actual.length !== wanted.length) {
    return false;
  }
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== wanted[index]) {
      return false;
    }
  }
  return true;
}

/** Structural equality for the two-element string lists the handshake uses. */
export function stringListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Structural equality for the number lists the handshake uses. */
export function numberListsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/*
 * The paired-host record, and the split that keeps the device token out of
 * ordinary storage.
 *
 * A host is persisted in two halves. The metadata half — id, name, endpoint,
 * pinned desktop key, last-connected stamp — is plain JSON in preferences. The
 * credential half — the device token — goes to the HarmonyOS Asset Store, which
 * is the platform's integrity-protected secret store, and is joined back in by
 * `HostStore` at load time.
 *
 * The split is not cosmetic: preferences files are readable by a backup or a
 * rooted shell, and a device token is a bearer credential for the whole runtime
 * RPC surface. Keeping the token out of the metadata file is what makes the
 * metadata safe to write in the clear.
 *
 * Field names and validation mirror `HostProfileSchema` /
 * `StoredHostProfileSchema` in `mobile/src/transport/types.ts`.
 */

export interface HostProfile {
  id: string;
  name: string;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
  lastConnected: number;
}

/** The persisted half: everything except the credential. */
export interface StoredHostProfile {
  id: string;
  name: string;
  endpoint: string;
  publicKeyB64: string;
  lastConnected: number;
}

/** Hosts matching this shape get a sequential default name. */
const HOST_NAME_PREFIX = 'Host ';

/**
 * Picks the next free `Host N`. Numbers already in use are never reused, so a
 * deleted host does not free its name for a different machine.
 */
export function getNextHostNameFromHosts(hosts: HostProfile[]): string {
  let largest = 0;
  for (let index = 0; index < hosts.length; index++) {
    const name = hosts[index].name;
    if (name.length <= HOST_NAME_PREFIX.length) {
      continue;
    }
    if (name.substring(0, HOST_NAME_PREFIX.length) !== HOST_NAME_PREFIX) {
      continue;
    }
    const digits = name.substring(HOST_NAME_PREFIX.length);
    if (!isAllDigits(digits)) {
      continue;
    }
    const parsed = parseInt(digits, 10);
    if (!isNaN(parsed) && parsed > largest) {
      largest = parsed;
    }
  }
  return `${HOST_NAME_PREFIX}${largest + 1}`;
}

function isAllDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

export function toStoredHostProfile(profile: HostProfile): StoredHostProfile {
  return {
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    publicKeyB64: profile.publicKeyB64,
    lastConnected: profile.lastConnected
  };
}

function readNonEmptyString(record: Record<string, Object>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') {
    return null;
  }
  // SAFETY: typeof check directly above narrowed the value to string.
  const text = value as string;
  return text.length === 0 ? null : text;
}

/**
 * Validates one persisted record. Null on any violation, so a corrupt entry is
 * dropped rather than surfacing as a host that can never connect.
 *
 * A record that still carries a `deviceToken` is rejected outright: pre-v0.0.3
 * builds embedded the secret in this file, and the only safe migration is to
 * make the user re-pair. Returning it would re-import a credential that has
 * been sitting in a backup-visible file.
 */
export function parseStoredHostProfile(value: Object | null): StoredHostProfile | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  // SAFETY: value proven non-null and object-typed directly above.
  const record = value as Record<string, Object>;
  if (record.deviceToken !== undefined) {
    return null;
  }
  const id = readNonEmptyString(record, 'id');
  const name = readNonEmptyString(record, 'name');
  const endpoint = readNonEmptyString(record, 'endpoint');
  const publicKeyB64 = readNonEmptyString(record, 'publicKeyB64');
  if (id === null || name === null || endpoint === null || publicKeyB64 === null) {
    return null;
  }
  const lastConnected = record.lastConnected;
  if (typeof lastConnected !== 'number' || !isFinite(lastConnected)) {
    return null;
  }
  // SAFETY: typeof + isFinite checks directly above narrowed the value to a finite number.
  const profile: StoredHostProfile = {
    id: id,
    name: name,
    endpoint: endpoint,
    publicKeyB64: publicKeyB64,
    lastConnected: lastConnected as number
  };
  return profile;
}

/**
 * Parses the persisted list. `null` means "unreadable" — malformed JSON, or a
 * payload that is not an array — which callers must treat differently from an
 * empty list: an empty list is a user with no hosts, while unreadable is data
 * that a blind rewrite would destroy. Reads show nothing; mutations fail closed.
 */
export function parseStoredHostProfileList(json: string): StoredHostProfile[] | null {
  let parsed: Object;
  try {
    parsed = JSON.parse(json) as Object;
  } catch (error) {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Object[];
  const out: StoredHostProfile[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = parseStoredHostProfile(raw[index]);
    if (entry !== null) {
      out.push(entry);
    }
  }
  return out;
}

export function serializeStoredHostProfiles(profiles: StoredHostProfile[]): string {
  return JSON.stringify(profiles);
}

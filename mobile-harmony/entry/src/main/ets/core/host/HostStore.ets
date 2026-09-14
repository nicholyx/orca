/*
 * The paired-host store: a read-through cache over the metadata file plus the
 * credential store.
 *
 * Two invariants drive the design:
 *
 *  1. A host with no credential is not a host. If the token cannot be read —
 *     cleared by the user, or wiped because the lock screen was removed — the
 *     profile is dropped from the result instead of being returned in a state
 *     that can never authenticate. The stored record is left alone, so a
 *     transient read failure does not destroy the pairing.
 *
 *  2. Mutations are serialized. Every writer holds one chain across its full
 *     read-modify-write, because the metadata file is a whole-list replace and
 *     two concurrent writers would otherwise lose one of the two updates.
 *
 * `HostProfile.deviceToken` is populated only in memory; it is never written
 * back into the metadata file.
 */
import {
  HostProfile,
  StoredHostProfile,
  getNextHostNameFromHosts,
  parseStoredHostProfileList,
  serializeStoredHostProfiles,
  toStoredHostProfile
} from './HostProfile';
import { PairingOffer } from '../pairing/PairingOffer';

export interface HostMetadataStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

/** The secret half of a host, backed by the platform's protected secret store. */
export interface HostDeviceTokenStore {
  read(hostId: string): Promise<string | null>;
  write(hostId: string, token: string): Promise<void>;
  remove(hostId: string): Promise<void>;
}

export class HostStore {
  private readonly metadata: HostMetadataStore;
  private readonly tokens: HostDeviceTokenStore;
  private readonly newId: () => string;

  /** In-memory token cache: a secret-store read costs tens of milliseconds. */
  private readonly tokenCache: Map<string, string> = new Map();
  private mutationChain: Promise<void> = Promise.resolve();
  private cachedProfiles: HostProfile[] | null = null;

  constructor(metadata: HostMetadataStore, tokens: HostDeviceTokenStore, newId: () => string) {
    this.metadata = metadata;
    this.tokens = tokens;
    this.newId = newId;
  }

  async loadHosts(): Promise<HostProfile[]> {
    // A half-written list must never be observed, so readers wait out writers.
    await this.mutationChain;
    return this.loadHostsUnlocked();
  }

  /** Adds or refreshes the host described by a pairing offer. */
  async saveHostFromOffer(offer: PairingOffer, name: string | null): Promise<HostProfile> {
    // Collected rather than assigned, so the result needs no type assertion
    // after the mutation chain hands control back.
    const saved: HostProfile[] = [];
    await this.mutate(async () => {
      const stored = await this.readStoredForMutation();
      const existingIndex = findHostIndexByEndpoint(stored, offer.endpoint);
      const now = Date.now();
      const existing = existingIndex === -1 ? null : stored[existingIndex];
      const hostId = existing === null ? this.newId() : existing.id;
      const hostName =
        name !== null
          ? name
          : existing === null
            ? getNextHostNameFromHosts(await this.loadHostsUnlocked())
            : existing.name;
      const storedProfile: StoredHostProfile = {
        id: hostId,
        name: hostName,
        endpoint: offer.endpoint,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: now
      };
      if (existingIndex === -1) {
        // Re-pairing the same endpoint refreshes the pin and the token rather
        // than creating a second entry the user cannot tell apart.
        stored.push(storedProfile);
      } else {
        stored[existingIndex] = storedProfile;
      }
      await this.tokens.write(hostId, offer.deviceToken);
      this.tokenCache.set(hostId, offer.deviceToken);
      await this.metadata.save(serializeStoredHostProfiles(stored));
      saved.push({
        id: hostId,
        name: hostName,
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: now
      });
    });
    if (saved.length === 0) {
      throw new Error('Host save did not complete');
    }
    return saved[0];
  }

  async renameHost(hostId: string, name: string): Promise<void> {
    await this.mutate(async () => {
      const stored = await this.readStoredForMutation();
      const index = findHostIndexById(stored, hostId);
      if (index === -1) {
        return;
      }
      stored[index].name = name;
      await this.metadata.save(serializeStoredHostProfiles(stored));
    });
  }

  async markConnected(hostId: string, at: number): Promise<void> {
    await this.mutate(async () => {
      const stored = await this.readStoredForMutation();
      const index = findHostIndexById(stored, hostId);
      if (index === -1) {
        return;
      }
      stored[index].lastConnected = at;
      await this.metadata.save(serializeStoredHostProfiles(stored));
    });
  }

  /** Forgets a host: the credential goes first, so no orphaned token remains. */
  async removeHost(hostId: string): Promise<void> {
    await this.mutate(async () => {
      const stored = await this.readStoredForMutation();
      const index = findHostIndexById(stored, hostId);
      if (index !== -1) {
        stored.splice(index, 1);
        await this.metadata.save(serializeStoredHostProfiles(stored));
      }
      await this.tokens.remove(hostId);
      this.tokenCache.delete(hostId);
    });
  }

  /**
   * Drops every cache so the next read comes from storage.
   *
   * The token cache has to go with the profile cache. It exists to avoid a slow
   * secret-store read per host per screen mount, but a cached token also masks
   * a credential the OS has since wiped (removing the lock screen does exactly
   * that) — the host would stay listed and keep failing to authenticate, with
   * nothing on screen to explain it, until the app restarted.
   */
  invalidate(): void {
    this.cachedProfiles = null;
    this.tokenCache.clear();
  }

  // -------------------------------------------------------------------------

  private async loadHostsUnlocked(): Promise<HostProfile[]> {
    if (this.cachedProfiles !== null) {
      return this.cachedProfiles;
    }
    const stored = await this.readStoredOrNull();
    if (stored === null) {
      // Unreadable list: show nothing rather than throw, and leave the data for
      // a later attempt instead of overwriting it.
      this.cachedProfiles = [];
      return this.cachedProfiles;
    }
    const profiles: HostProfile[] = [];
    for (let index = 0; index < stored.length; index++) {
      const entry = stored[index];
      const token = await this.readToken(entry.id);
      if (token === null) {
        // No credential: the pairing is unusable, so hide it rather than offer
        // a host that would fail authentication every single time.
        continue;
      }
      profiles.push({
        id: entry.id,
        name: entry.name,
        endpoint: entry.endpoint,
        deviceToken: token,
        publicKeyB64: entry.publicKeyB64,
        lastConnected: entry.lastConnected
      });
    }
    this.cachedProfiles = profiles;
    return profiles;
  }

  private async readToken(hostId: string): Promise<string | null> {
    const cached = this.tokenCache.get(hostId);
    if (cached !== undefined) {
      return cached;
    }
    const token = await this.tokens.read(hostId);
    if (token !== null) {
      this.tokenCache.set(hostId, token);
    }
    return token;
  }

  private async readStoredForMutation(): Promise<StoredHostProfile[]> {
    const stored = await this.readStoredOrNull();
    if (stored === null) {
      // Fail closed: writing a fresh list over data we could not parse would
      // silently delete every pairing on the device.
      throw new Error('host list storage unreadable');
    }
    return stored;
  }

  private async readStoredOrNull(): Promise<StoredHostProfile[] | null> {
    const json = await this.metadata.load();
    if (json === null) {
      return [];
    }
    return parseStoredHostProfileList(json);
  }

  private async mutate(body: () => Promise<void>): Promise<void> {
    // Cleared before AND after. Clearing before is not enough: the body itself
    // may read the list (naming a new host needs the current one), which
    // repopulates the cache from pre-mutation state and leaves every later read
    // stale — the user pairs successfully and then sees an empty list.
    this.cachedProfiles = null;
    const run = this.mutationChain.then(body, body);
    // `settled` also keeps the chain alive after a failure, so one bad write
    // cannot wedge every later mutation behind a rejected promise.
    const settled = (): void => {
      this.cachedProfiles = null;
    };
    this.mutationChain = run.then(settled, settled);
    return run;
  }
}

function findHostIndexById(stored: StoredHostProfile[], hostId: string): number {
  for (let index = 0; index < stored.length; index++) {
    if (stored[index].id === hostId) {
      return index;
    }
  }
  return -1;
}

function findHostIndexByEndpoint(stored: StoredHostProfile[], endpoint: string): number {
  for (let index = 0; index < stored.length; index++) {
    if (stored[index].endpoint === endpoint) {
      return index;
    }
  }
  return -1;
}

/** Convenience view for the host list screen. */
export function toStoredProfiles(profiles: HostProfile[]): StoredHostProfile[] {
  const out: StoredHostProfile[] = [];
  for (let index = 0; index < profiles.length; index++) {
    out.push(toStoredHostProfile(profiles[index]));
  }
  return out;
}

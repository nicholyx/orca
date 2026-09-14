/*
 * Host metadata storage on ArkData preferences.
 *
 * Preferences is the right home for this and the wrong home for the credential:
 * it is a plain key-value file that participates in device backups, so only the
 * non-secret half of a host record is written here. The device token lives in
 * the Asset Store (see `AssetDeviceTokenStore`).
 *
 * Writes are flushed explicitly. `putSync` only mutates the in-memory instance,
 * and an unflushed write is lost if the process dies — which, for a pairing the
 * user just completed, is exactly the failure they would never forgive.
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { HostMetadataStore } from '../core/host/HostStore';

const STORE_NAME = 'orca_hosts';
const HOSTS_KEY = 'hosts.v1';

export class PreferencesHostMetadataStore implements HostMetadataStore {
  private readonly context: common.Context;
  private store: preferences.Preferences | null = null;

  constructor(context: common.Context) {
    this.context = context;
  }

  async load(): Promise<string | null> {
    const store = await this.open();
    const value = store.getSync(HOSTS_KEY, '');
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    // SAFETY: getSync was given a string default, so the stored value can only
    // be a string for this key.
    return value as string;
  }

  async save(json: string): Promise<void> {
    const store = await this.open();
    store.putSync(HOSTS_KEY, json);
    await store.flush();
  }

  /** Opens preferences once; concurrent callers share the instance. */
  private async open(): Promise<preferences.Preferences> {
    if (this.store !== null) {
      return this.store;
    }
    const options: preferences.Options = { name: STORE_NAME };
    const store = await preferences.getPreferences(this.context, options);
    this.store = store;
    return store;
  }
}

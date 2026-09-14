/*
 * Device-token storage on the HarmonyOS Asset Store (`@kit.AssetStoreKit`).
 *
 * This is the platform's integrity-protected secret store — the closest
 * equivalent to the iOS Keychain the RN client uses — and it is the only place
 * a device token is ever written.
 *
 * `DEVICE_FIRST_UNLOCKED` is deliberate. `DEVICE_UNLOCKED` would be stricter,
 * but it makes the credential unreadable whenever the screen locks, which would
 * break a reconnect that happens while the phone is in a pocket. First-unlock
 * keeps the store inaccessible before boot-time unlock while allowing a
 * backgrounded app to reuse the pairing, which is the actual threat model here.
 *
 * The alias is namespaced per host so removing one pairing cannot disturb
 * another. Note that the alias is not secret — it is derived from a host id —
 * so a replaced pairing must overwrite in place rather than append.
 */
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { HostDeviceTokenStore } from '../core/host/HostStore';

const ALIAS_PREFIX = 'orca.host.device-token.';

/** The Asset Store reports a duplicate alias with this code. */
const ASSET_ERROR_DUPLICATED = 24000001;

function toBytes(text: string): Uint8Array {
  const encoder = new util.TextEncoder();
  return encoder.encodeInto(text);
}

function fromBytes(bytes: Uint8Array): string {
  const decoder = new util.TextDecoder('utf-8');
  return decoder.decodeToString(bytes);
}

function aliasFor(hostId: string): string {
  return `${ALIAS_PREFIX}${hostId}`;
}

export class AssetDeviceTokenStore implements HostDeviceTokenStore {
  async read(hostId: string): Promise<string | null> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, toBytes(aliasFor(hostId)));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const results: asset.AssetMap[] = await asset.query(query);
      if (results.length === 0) {
        return null;
      }
      const secret = results[0].get(asset.Tag.SECRET);
      if (secret === undefined) {
        return null;
      }
      // SAFETY: Tag.SECRET is declared as TagType.BYTES, so the stored value is
      // always a Uint8Array; the Asset Store has no other representation for it.
      return fromBytes(secret as Uint8Array);
    } catch (error) {
      // NOT_FOUND is the normal "this host was never paired" path.
      return null;
    }
  }

  async write(hostId: string, token: string): Promise<void> {
    const alias = aliasFor(hostId);
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, toBytes(alias));
    attributes.set(asset.Tag.SECRET, toBytes(token));
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    try {
      await asset.add(attributes);
      return;
    } catch (error) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every rejection from the Asset Store is a BusinessError carrying a numeric code.
      const code = (error as BusinessError).code;
      if (code !== ASSET_ERROR_DUPLICATED) {
        // ArkTS only throws Error instances; BusinessError is an interface.
        throw error instanceof Error
          ? error
          : new Error(`asset add failed with code ${code}`);
      }
    }
    // Re-pairing replaces the credential in place; remove-then-add is the only
    // way to change SECRET on the Asset Store.
    await asset.remove(this.aliasQuery(alias));
    await asset.add(attributes);
  }

  async remove(hostId: string): Promise<void> {
    try {
      await asset.remove(this.aliasQuery(aliasFor(hostId)));
    } catch (error) {
      // Already gone is success: the caller's intent is "no token for this host".
    }
  }

  private aliasQuery(alias: string): asset.AssetMap {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, toBytes(alias));
    return query;
  }
}

/*
 * Backup extension.
 *
 * Nothing to do by design: `backup_config.json` sets `allowToBackupRestore` to
 * false, so this ability never receives a restore. That is the intended posture
 * — the host list names machines on the user's private network, and the device
 * tokens are bearer credentials. Both would end up in a cloud backup if this
 * were enabled, and neither is recoverable-value data worth that trade.
 *
 * The override exists so the module's `extensionAbilities` entry resolves.
 */
import { BackupExtensionAbility, BundleVersion } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'OrcaBackup';

export default class EntryBackupAbility extends BackupExtensionAbility {
  async onBackup(): Promise<void> {
    hilog.info(DOMAIN, TAG, 'backup requested, but backups are disabled for this module');
  }

  async onRestore(bundleVersion: BundleVersion): Promise<void> {
    hilog.info(DOMAIN, TAG, 'restore requested at %{public}s, but backups are disabled', JSON.stringify(bundleVersion));
  }
}

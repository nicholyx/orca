/*
 * The entry ability.
 *
 * It creates the connection service once, at process start, and parks it in
 * `AppStorage` so every page shares one instance — one socket, one reconnection
 * schedule, one log. Creating it per page would let two pages hold two sockets
 * to the same host, each with its own E2EE session, which is both wasteful and
 * confusing to reason about when the connection pill disagrees with itself.
 *
 * `onForeground` is wired to `notifyForeground()` because HarmonyOS does not
 * reliably report a socket that died while the app was suspended: the probe in
 * the foreground path is what turns a silent half-open link into a reconnect.
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { OrcaConnection } from '../services/OrcaConnection';

const DOMAIN = 0x0000;
const TAG = 'OrcaEntry';
export const ORCA_CONNECTION_KEY = 'orca.connection';

export default class EntryAbility extends UIAbility {
  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    const connection = new OrcaConnection(this.context);
    AppStorage.setOrCreate<OrcaConnection>(ORCA_CONNECTION_KEY, connection);
    try {
      await connection.initialize();
    } catch (error) {
      hilog.error(DOMAIN, TAG, 'host store initialisation failed: %{public}s', String(error));
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      // The app is dark-only: the palette in ThemeTokens has no light variant,
      // and forcing it here keeps the system light theme from washing out the
      // terminal surface.
      const mainWindow = windowStage.getMainWindowSync();
      mainWindow
        .setWindowBackgroundColor('#0a0a0a')
        .catch((error: Object) => hilog.warn(DOMAIN, TAG, 'background set failed: %{public}s', String(error)));
    });
  }

  onForeground(): void {
    const connection = AppStorage.get<OrcaConnection>(ORCA_CONNECTION_KEY);
    if (connection !== undefined) {
      connection.notifyForeground();
    }
  }

  onBackground(): void {
    // Nothing to tear down: the reconnect schedule already handles a link that
    // dies while suspended, and closing here would cost the user a re-handshake
    // every time they check a notification.
  }

  onDestroy(): void {
    const connection = AppStorage.get<OrcaConnection>(ORCA_CONNECTION_KEY);
    if (connection !== undefined) {
      connection.disconnect();
    }
  }
}

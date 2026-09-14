/*
 * The app's only page.
 *
 * Routing is a `NavPathStack` with four destinations rather than one component
 * that swaps its body, so the system back gesture behaves the way the user
 * expects — including the swipe that must pop the terminal, not the app.
 *
 * The connection service is read from `AppStorage` (it is created by
 * `EntryAbility`) instead of being constructed here. That is what makes the
 * service outlive a page recreation: a rotation or a back-then-forward must not
 * drop the socket.
 */
import { ORCA_CONNECTION_KEY } from '../entryability/EntryAbility';
import { OrcaConnection } from '../services/OrcaConnection';
import { ConnectionLogView } from '../views/ConnectionLogView';
import { HostListView } from '../views/HostListView';
import { PairView } from '../views/PairView';
import { TerminalView } from '../views/TerminalView';
import { OrcaColors, OrcaSpace } from '../theme/ThemeTokens';

const ROUTE_HOSTS = 'hosts';
const ROUTE_PAIR = 'pair';
const ROUTE_TERMINAL = 'terminal';
const ROUTE_LOG = 'log';

@Entry
@Component
struct Index {
  @State pathStack: NavPathStack = new NavPathStack();
  @State ready: boolean = false;

  private connection: OrcaConnection | null = null;

  aboutToAppear(): void {
    const existing = AppStorage.get<OrcaConnection>(ORCA_CONNECTION_KEY);
    if (existing !== undefined) {
      this.connection = existing;
      this.ready = true;
      return;
    }
    // Reached only if the ability was torn down without clearing AppStorage;
    // constructing here keeps the page usable instead of showing a blank shell.
    const fallback = new OrcaConnection(getContext(this));
    AppStorage.setOrCreate<OrcaConnection>(ORCA_CONNECTION_KEY, fallback);
    fallback
      .initialize()
      .then(() => {
        this.connection = fallback;
        this.ready = true;
      })
      .catch(() => {
        this.connection = fallback;
        this.ready = true;
      });
  }

  build() {
    Navigation(this.pathStack) {
      if (this.ready && this.connection !== null) {
        this.home(this.connection)
      } else {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(OrcaColors.background)
      }
    }
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
    .backgroundColor(OrcaColors.background)
    .navDestination(this.destination)
  }

  /** Home: the host list, plus the two ways out of an empty state. */
  @Builder
  home(connection: OrcaConnection) {
    Column() {
      HostListView({
        connection: connection,
        onOpenTerminal: () => {
          this.pathStack.pushPathByName(ROUTE_TERMINAL, null);
        }
      })

      Row() {
        Button('Pair a host')
          .layoutWeight(1)
          .height(44)
          .backgroundColor(OrcaColors.primary)
          .fontColor(OrcaColors.primaryForeground)
          .onClick(() => {
            this.pathStack.pushPathByName(ROUTE_PAIR, null);
          })
        Button('Log')
          .height(44)
          .margin({ left: OrcaSpace.sm })
          .backgroundColor(OrcaColors.secondary)
          .fontColor(OrcaColors.secondaryForeground)
          .onClick(() => {
            this.pathStack.pushPathByName(ROUTE_LOG, null);
          })
      }
      .width('100%')
      .padding({ left: OrcaSpace.xl, right: OrcaSpace.xl, bottom: OrcaSpace.xl })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(OrcaColors.background)
  }

  @Builder
  destination(name: string, _param: Object) {
    if (name === ROUTE_PAIR) {
      NavDestination() {
        if (this.connection !== null) {
          PairView({
            connection: this.connection,
            onPaired: () => {
              this.pathStack.pop();
            }
          })
        }
      }
      .hideTitleBar(true)
    } else if (name === ROUTE_TERMINAL) {
      NavDestination() {
        if (this.connection !== null) {
          TerminalView({ connection: this.connection })
        }
      }
      .hideTitleBar(true)
    } else if (name === ROUTE_LOG) {
      NavDestination() {
        if (this.connection !== null) {
          ConnectionLogView({ connection: this.connection })
        }
      }
      .hideTitleBar(true)
    }
  }
}

/*
 * The connection log.
 *
 * This screen exists because a pairing failure is otherwise invisible: the user
 * sees "Reconnecting…" and has no way to tell a wrong endpoint from a revoked
 * token from a TLS-blocking network. Every line is already redacted at the
 * source (`ConnectionLog` strips the endpoint to its host), so this view can
 * render the rows as-is and can be copied into a bug report verbatim.
 */
import { OrcaConnection } from '../services/OrcaConnection';
import { LogRow } from '../state/AppState';
import { MONO_FAMILY, OrcaColors, OrcaRadius, OrcaSpace, OrcaType } from '../theme/ThemeTokens';

@Component
export struct ConnectionLogView {
  connection: OrcaConnection | null = null;

  /** Fail-closed access: the view is inert until the page injects a connection. */
  private conn(): OrcaConnection {
    if (this.connection === null) {
      throw new Error('ConnectionLogView used before its connection was injected');
    }
    return this.connection;
  }

  @State revision: number = 0;
  @State rows: LogRow[] = [];

  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    this.rows = this.conn().log();
    this.unsubscribe = this.conn().onChange(() => {
      this.rows = this.conn().log();
      this.revision++;
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private levelColor(level: string): string {
    if (level === 'error') {
      return OrcaColors.destructive;
    }
    if (level === 'warn') {
      return OrcaColors.stateConnecting;
    }
    if (level === 'success') {
      return OrcaColors.stateConnected;
    }
    return OrcaColors.mutedForeground;
  }

  build() {
    Column() {
      Row() {
        Text('Connection log')
          .fontSize(OrcaType.title)
          .fontColor(OrcaColors.foreground)
          .layoutWeight(1)
        Button('Clear')
          .fontSize(OrcaType.caption)
          .backgroundColor(OrcaColors.secondary)
          .fontColor(OrcaColors.secondaryForeground)
          .onClick(() => {
            // Only the rendered copy is cleared; the service keeps its own ring
            // so nothing is lost from the diagnostic record mid-session.
            this.rows = [];
            this.revision++;
          })
      }
      .width('100%')
      .padding({ bottom: OrcaSpace.md })

      if (this.rows.length === 0) {
        Column() {
          Text('No connection activity yet.')
            .fontSize(OrcaType.body)
            .fontColor(OrcaColors.mutedForeground)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List({ space: OrcaSpace.xs }) {
          ForEach(this.rows, (row: LogRow) => {
            ListItem() {
              Column() {
                Row() {
                  if (row.clock.length > 0) {
                    Text(row.clock)
                      .fontSize(OrcaType.caption)
                      .fontFamily(MONO_FAMILY)
                      .fontColor(OrcaColors.mutedForeground)
                      .margin({ right: OrcaSpace.sm })
                  }
                  Text(row.message)
                    .fontSize(OrcaType.label)
                    .fontColor(this.levelColor(row.level))
                    .layoutWeight(1)
                }
                .width('100%')
                if (row.detail.length > 0) {
                  Text(row.detail)
                    .fontSize(OrcaType.caption)
                    .fontFamily(MONO_FAMILY)
                    .fontColor(OrcaColors.mutedForeground)
                    .width('100%')
                    .margin({ top: OrcaSpace.xs })
                }
              }
              .alignItems(HorizontalAlign.Start)
              .width('100%')
              .padding(OrcaSpace.sm)
              .backgroundColor(OrcaColors.card)
              .borderRadius(OrcaRadius.sm)
            }
          }, (row: LogRow) => `${row.id}-${row.clock}-${row.message}`)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .height('100%')
    .padding(OrcaSpace.lg)
    .backgroundColor(OrcaColors.background)
  }
}

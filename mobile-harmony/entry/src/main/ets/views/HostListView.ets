/*
 * The paired-host list — the app's home screen.
 *
 * Tapping a host connects and opens its terminal; the tap target is the whole
 * row, because the only thing a user ever wants from a row is to get into it.
 * Destructive removal is a long-press, so it cannot be hit by accident, and it
 * is the only action here that asks for confirmation.
 */
import { promptAction } from '@kit.ArkUI';
import { OrcaConnection } from '../services/OrcaConnection';
import { HostRow } from '../state/AppState';
import { OrcaColors, OrcaRadius, OrcaSpace, OrcaType, toneColor } from '../theme/ThemeTokens';

@Component
export struct HostListView {
  connection: OrcaConnection;
  onOpenTerminal: () => void = () => {};

  @State revision: number = 0;
  @State hosts: HostRow[] = [];
  @State stateLabel: string = '';
  @State stateTone: string = 'idle';

  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    this.refresh();
    this.unsubscribe = this.connection.onChange(() => {
      this.refresh();
    });
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private refresh(): void {
    this.hosts = this.connection.hostRows();
    const snapshot = this.connection.snapshot();
    this.stateLabel = snapshot.label;
    this.stateTone = snapshot.tone;
    this.revision++;
  }

  private confirmRemove(row: HostRow): void {
    promptAction.showDialog({
      title: 'Forget this host?',
      message: `${row.name} will be removed, along with its stored credential. You will need to pair again to reconnect.`,
      buttons: [
        { text: 'Cancel', color: OrcaColors.secondaryForeground },
        { text: 'Forget', color: OrcaColors.destructive }
      ]
    }).then((result: promptAction.ShowDialogSuccessResponse) => {
      if (result.index === 1) {
        this.connection.removeHost(row.id).catch((error: Object) => {
          promptAction.showToast({ message: `Could not remove host: ${String(error)}` });
        });
      }
    }).catch(() => {});
  }

  build() {
    Column() {
      Row() {
        Text('Orca')
          .fontSize(OrcaType.title)
          .fontColor(OrcaColors.foreground)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Row() {
          Circle()
            .width(8)
            .height(8)
            .fill(toneColor(this.stateTone))
          Text(this.stateLabel)
            .fontSize(OrcaType.caption)
            .fontColor(OrcaColors.mutedForeground)
            .margin({ left: OrcaSpace.xs })
        }
      }
      .width('100%')
      .padding({ bottom: OrcaSpace.lg })

      if (this.hosts.length === 0) {
        this.emptyState()
      } else {
        List({ space: OrcaSpace.sm }) {
          ForEach(this.hosts, (row: HostRow) => {
            ListItem() {
              this.hostRow(row)
            }
            .gesture(LongPressGesture().onAction(() => {
              this.confirmRemove(row);
            }))
          }, (row: HostRow) => row.id)
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .padding(OrcaSpace.xl)
    .backgroundColor(OrcaColors.background)
  }

  @Builder
  emptyState() {
    Column() {
      Text('No paired hosts yet')
        .fontSize(OrcaType.subtitle)
        .fontColor(OrcaColors.foreground)
      Text('Pair with a desktop running the Orca runtime to continue.')
        .fontSize(OrcaType.body)
        .fontColor(OrcaColors.mutedForeground)
        .margin({ top: OrcaSpace.sm })
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  hostRow(row: HostRow) {
    Row() {
      Column() {
        Text(row.name)
          .fontSize(OrcaType.subtitle)
          .fontColor(OrcaColors.foreground)
        Text(row.endpoint)
          .fontSize(OrcaType.caption)
          .fontColor(OrcaColors.mutedForeground)
          .margin({ top: OrcaSpace.xs })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (row.isActive) {
        Text('Active')
          .fontSize(OrcaType.caption)
          .fontColor(toneColor('ok'))
      }
    }
    .width('100%')
    .padding(OrcaSpace.lg)
    .backgroundColor(OrcaColors.card)
    .borderRadius(OrcaRadius.md)
    .border({ width: 1, color: row.isActive ? OrcaColors.ring : OrcaColors.border })
    .onClick(() => {
      this.connection.connect(row.id);
      const snapshot = this.connection.snapshot();
      this.stateLabel = snapshot.label;
      this.stateTone = snapshot.tone;
      this.onOpenTerminal();
    })
  }
}

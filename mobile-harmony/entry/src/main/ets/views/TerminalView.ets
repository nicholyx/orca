/*
 * The terminal screen: one streamed terminal, with an input line.
 *
 * The output is an append-only `List` rather than a single wrapping `Text`,
 * because a terminal that has been running for hours produces tens of thousands
 * of lines and a single Text node would be re-laid-out on every chunk. The list
 * lets ArkUI render only what is on screen.
 *
 * Input is sent with a trailing newline: the host writes the text into the PTY
 * verbatim, so the shell's line discipline is what decides whether it executes.
 * Appending it here rather than at the host keeps the RPC payload identical to
 * what a physical keyboard would produce.
 */
import { promptAction } from '@kit.ArkUI';
import { OrcaConnection, TerminalDescriptor } from '../services/OrcaConnection';
import { TerminalLine, connectionLabel, connectionTone } from '../state/AppState';
import { MONO_FAMILY, OrcaColors, OrcaRadius, OrcaSpace, OrcaType, toneColor } from '../theme/ThemeTokens';

/** Default viewport; the desktop is told this so the PTY wraps to it. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

@Component
export struct TerminalView {
  connection: OrcaConnection | null = null;

  /** Fail-closed access: the view is inert until the page injects a connection. */
  private conn(): OrcaConnection {
    if (this.connection === null) {
      throw new Error('TerminalView used before its connection was injected');
    }
    return this.connection;
  }

  @State revision: number = 0;
  @State lines: TerminalLine[] = [];
  @State terminals: TerminalDescriptor[] = [];
  @State title: string = '';
  @State stateLabel: string = '';
  @State stateTone: string = 'idle';
  @State draft: string = '';
  @State notice: string = '';

  private unsubscribe: (() => void) | null = null;
  private scroller: Scroller = new Scroller();
  private opened: boolean = false;

  aboutToAppear(): void {
    this.refresh();
    this.unsubscribe = this.conn().onChange(() => {
      this.refresh();
    });
    this.openInitialTerminal();
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.conn().closeTerminal();
  }

  private refresh(): void {
    const previous = this.lines.length;
    this.lines = this.conn().terminal();
    const snapshot = this.conn().snapshot();
    this.title = snapshot.hostName;
    this.stateLabel = connectionLabel(snapshot.state);
    this.stateTone = connectionTone(snapshot.state);
    this.revision++;
    if (this.lines.length !== previous) {
      // Deferred so the list has laid out the new rows before we scroll.
      setTimeout(() => {
        this.scroller.scrollEdge(Edge.Bottom);
      }, 0);
    }
  }

  private openInitialTerminal(): void {
    if (this.opened) {
      return;
    }
    if (!this.conn().isConnected()) {
      this.notice = 'Not connected yet. Waiting for the host…';
      return;
    }
    this.conn()
      .listTerminals()
      .then((terminals: TerminalDescriptor[]) => {
        this.terminals = terminals;
        if (terminals.length === 0) {
          this.notice = 'This host has no terminals to attach to.';
          return;
        }
        this.opened = true;
        this.notice = '';
        this.conn().openTerminal(terminals[0].id, DEFAULT_COLS, DEFAULT_ROWS);
      })
      .catch((error: Object) => {
        this.notice = `Could not list terminals: ${String(error)}`;
      });
  }

  private send(): void {
    const text = this.draft;
    if (text.length === 0) {
      return;
    }
    this.draft = '';
    this.conn().sendTerminalInput(`${text}\n`).catch((error: Object) => {
      this.notice = `Send failed: ${String(error)}`;
    });
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text(this.title.length > 0 ? this.title : 'Terminal')
            .fontSize(OrcaType.subtitle)
            .fontColor(OrcaColors.foreground)
          Text(this.stateLabel)
            .fontSize(OrcaType.caption)
            .fontColor(toneColor(this.stateTone))
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        if (this.terminals.length > 1) {
          Button(`${this.terminals.length} terminals`)
            .fontSize(OrcaType.caption)
            .backgroundColor(OrcaColors.secondary)
            .fontColor(OrcaColors.secondaryForeground)
            .onClick(() => {
              this.showTerminalPicker();
            })
        }
      }
      .width('100%')
      .padding({ bottom: OrcaSpace.md })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(OrcaType.label)
          .fontColor(OrcaColors.mutedForeground)
          .width('100%')
          .padding({ bottom: OrcaSpace.sm })
      }

      List({ space: 0, scroller: this.scroller }) {
        ForEach(this.lines, (line: TerminalLine) => {
          ListItem() {
            Text(line.text.length === 0 ? ' ' : line.text)
              .fontSize(OrcaType.mono)
              .fontFamily(MONO_FAMILY)
              .fontColor(OrcaColors.foreground)
              .width('100%')
              .textAlign(TextAlign.Start)
          }
        }, (line: TerminalLine) => `${line.id}:${line.text.length}`)
      }
      .layoutWeight(1)
      .width('100%')
      .padding(OrcaSpace.sm)
      .backgroundColor(OrcaColors.card)
      .borderRadius(OrcaRadius.md)
      .border({ width: 1, color: OrcaColors.border })
      .scrollBar(BarState.Auto)

      Row() {
        TextInput({ placeholder: 'Type a command', text: this.draft })
          .fontSize(OrcaType.mono)
          .fontFamily(MONO_FAMILY)
          .fontColor(OrcaColors.foreground)
          .placeholderColor(OrcaColors.mutedForeground)
          .backgroundColor(OrcaColors.input)
          .borderRadius(OrcaRadius.sm)
          .layoutWeight(1)
          .height(44)
          .onChange((value: string) => {
            this.draft = value;
          })
          .onSubmit(() => {
            this.send();
          })
        Button('Send')
          .height(44)
          .margin({ left: OrcaSpace.sm })
          .backgroundColor(OrcaColors.primary)
          .fontColor(OrcaColors.primaryForeground)
          .enabled(this.draft.length > 0)
          .onClick(() => {
            this.send();
          })
      }
      .width('100%')
      .margin({ top: OrcaSpace.md })
    }
    .width('100%')
    .height('100%')
    .padding(OrcaSpace.lg)
    .backgroundColor(OrcaColors.background)
  }

  private showTerminalPicker(): void {
    const names: string[] = [];
    for (let index = 0; index < this.terminals.length; index++) {
      names.push(this.terminals[index].title);
    }
    // A submenu of titles: picking one re-opens the feed on that terminal, which
    // is the only way to switch, because a terminal stream cannot be retargeted.
    // showActionMenu caps the button list at six slots, so a longer terminal
    // list is truncated to the first six.
    const shown = names.length > 6 ? names.slice(0, 6) : names;
    const buttons: promptAction.Button[] = shown.map((name: string): promptAction.Button => {
      const button: promptAction.Button = {
        text: name,
        color: OrcaColors.foreground
      };
      return button;
    });
    promptAction.showActionMenu({
      title: 'Attach to terminal',
      buttons: [
        buttons[0], buttons[1], buttons[2], buttons[3], buttons[4], buttons[5]
      ]
    }).then((result: promptAction.ActionMenuSuccessResponse) => {
      const index = result.index;
      if (index < 0 || index >= this.terminals.length) {
        return;
      }
      this.opened = true;
      this.conn().openTerminal(this.terminals[index].id, DEFAULT_COLS, DEFAULT_ROWS);
    }).catch(() => {});
  }
}

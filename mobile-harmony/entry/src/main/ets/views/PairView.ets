/*
 * The pairing screen: scan a QR, or paste the code the desktop shows.
 *
 * Both routes end at `OrcaConnection.pairFromInput`, so there is exactly one
 * validator for the payload and exactly one place that can be wrong. The paste
 * field is not trimmed of internal whitespace — pairing codes are base64 and a
 * stray space is a real corruption worth surfacing rather than papering over.
 */
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { OrcaConnection } from '../services/OrcaConnection';
import { SCAN_CANCELLED, scanPairingCode } from '../platform/ScanKitPairingScanner';
import { OrcaColors, OrcaRadius, OrcaSpace, OrcaType } from '../theme/ThemeTokens';

@Component
export struct PairView {
  connection: OrcaConnection | null = null;

  /** Fail-closed access: the view is inert until the page injects a connection. */
  private conn(): OrcaConnection {
    if (this.connection === null) {
      throw new Error('PairView used before its connection was injected');
    }
    return this.connection;
  }
  onPaired: () => void = () => {};

  @State input: string = '';
  @State busy: boolean = false;
  @State error: string = '';

  private context(): common.UIAbilityContext {
    // SAFETY: this component is only ever hosted by the entry page, whose ability
    // context is a UIAbilityContext; getContext resolves to that same instance.
    return getContext(this) as common.UIAbilityContext;
  }

  private async submit(text: string): Promise<void> {
    if (this.busy || text.trim().length === 0) {
      return;
    }
    this.busy = true;
    this.error = '';
    const outcome = await this.conn().pairFromInput(text);
    this.busy = false;
    if (outcome.ok) {
      this.input = '';
      promptAction.showToast({ message: outcome.message });
      this.onPaired();
      return;
    }
    this.error = outcome.message;
  }

  private async scan(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.error = '';
    const outcome = await scanPairingCode(this.context());
    if (!outcome.ok) {
      this.busy = false;
      // Backing out of the scanner is not a failure the user needs told about.
      if (outcome.reason !== SCAN_CANCELLED) {
        this.error = 'The scanner did not return a code. Try pasting it instead.';
      }
      return;
    }
    await this.submit(outcome.value);
  }

  build() {
    Column() {
      Text('Pair a host')
        .fontSize(OrcaType.title)
        .fontColor(OrcaColors.foreground)
        .width('100%')
      Text('On your desktop, open Settings → Mobile and show the pairing code.')
        .fontSize(OrcaType.body)
        .fontColor(OrcaColors.mutedForeground)
        .margin({ top: OrcaSpace.sm, bottom: OrcaSpace.xl })
        .width('100%')

      Button('Scan QR code')
        .width('100%')
        .height(48)
        .backgroundColor(OrcaColors.primary)
        .fontColor(OrcaColors.primaryForeground)
        .borderRadius(OrcaRadius.md)
        .enabled(!this.busy)
        .onClick(() => {
          this.scan().catch((error: Object) => {
            this.busy = false;
            this.error = String(error);
          });
        })

      TextInput({ placeholder: 'orca://pair?code=… or the code itself', text: this.input })
        .type(InputType.Normal)
        .fontSize(OrcaType.body)
        .fontColor(OrcaColors.foreground)
        .placeholderColor(OrcaColors.mutedForeground)
        .backgroundColor(OrcaColors.card)
        .borderRadius(OrcaRadius.md)
        .border({ width: 1, color: OrcaColors.input })
        .height(48)
        .margin({ top: OrcaSpace.md })
        .onChange((value: string) => {
          this.input = value;
        })

      Button('Pair with pasted code')
        .width('100%')
        .height(48)
        .backgroundColor(OrcaColors.secondary)
        .fontColor(OrcaColors.secondaryForeground)
        .borderRadius(OrcaRadius.md)
        .margin({ top: OrcaSpace.md })
        .enabled(!this.busy && this.input.trim().length > 0)
        .onClick(() => {
          this.submit(this.input).catch((error: Object) => {
            this.busy = false;
            this.error = String(error);
          });
        })

      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(OrcaType.label)
          .fontColor(OrcaColors.destructive)
          .margin({ top: OrcaSpace.md })
          .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(OrcaSpace.xl)
    .backgroundColor(OrcaColors.background)
  }
}

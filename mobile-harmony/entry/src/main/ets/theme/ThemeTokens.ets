/*
 * Design tokens for the HarmonyOS app.
 *
 * Values are copied from the canonical `src/renderer/src/assets/main.css`
 * `.dark` block — the same palette the desktop and the RN mobile client use —
 * so the companion app reads as the same product rather than a third-party
 * client. Only the roles the app actually uses are mirrored here; a token that
 * has no consumer would be dead weight following a light/dark change upstream.
 *
 * HarmonyOS has no CSS variables, so these are plain constants. That makes the
 * copy explicit and auditable, which is the point: the alternative is hex
 * literals scattered through the views, where a palette change cannot find them.
 */

export class OrcaColors {
  static readonly background: string = '#0a0a0a';
  static readonly foreground: string = '#fafafa';
  static readonly card: string = '#171717';
  static readonly cardForeground: string = '#fafafa';
  static readonly popover: string = '#171717';
  static readonly popoverForeground: string = '#fafafa';
  static readonly primary: string = '#e5e5e5';
  static readonly primaryForeground: string = '#171717';
  static readonly secondary: string = '#262626';
  static readonly secondaryForeground: string = '#fafafa';
  static readonly muted: string = '#262626';
  static readonly mutedForeground: string = '#a1a1a1';
  static readonly accent: string = '#404040';
  static readonly accentForeground: string = '#fafafa';
  static readonly destructive: string = '#ff6568';
  static readonly destructiveForeground: string = '#df2225';
  static readonly border: string = '#272727';
  static readonly input: string = '#333333';
  static readonly ring: string = '#737373';

  /** Connection state chrome — the only place colour carries meaning here. */
  static readonly stateConnected: string = '#22c55e';
  static readonly stateConnecting: string = '#eab308';
  static readonly stateError: string = '#ff6568';
  static readonly stateIdle: string = '#737373';
}

/**
 * Maps the tone names the snapshot carries to actual colours, so the state
 * layer never has to know a hex value.
 */
export function toneColor(tone: string): string {
  if (tone === 'ok') {
    return OrcaColors.stateConnected;
  }
  if (tone === 'pending') {
    return OrcaColors.stateConnecting;
  }
  if (tone === 'error') {
    return OrcaColors.stateError;
  }
  return OrcaColors.stateIdle;
}

/** Spacing scale: a 4vp base, matching the desktop's Tailwind rhythm. */export class OrcaSpace {
  static readonly xs: number = 4;
  static readonly sm: number = 8;
  static readonly md: number = 12;
  static readonly lg: number = 16;
  static readonly xl: number = 24;
  static readonly xxl: number = 32;
}

export class OrcaRadius {
  static readonly sm: number = 6;
  static readonly md: number = 8;
  static readonly lg: number = 12;
  static readonly pill: number = 999;
}

/**
 * Type scale. `body` is the app default; `mono` is reserved for terminal
 * output and identifiers, where proportional digits hurt readability.
 */
export class OrcaType {
  static readonly title: number = 22;
  static readonly subtitle: number = 17;
  static readonly body: number = 15;
  static readonly label: number = 13;
  static readonly caption: number = 12;
  static readonly mono: number = 13;
}

export const MONO_FAMILY = 'HarmonyOS Sans Mono, monospace';

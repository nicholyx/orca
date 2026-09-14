/*
 * QR pairing via ScanKit.
 *
 * ScanKit is used rather than a camera preview built on the camera kit: it is
 * the platform's own scanner, so it inherits the system's low-light tuning, its
 * code-type coverage, and its accessibility, and it needs no preview surface of
 * our own. The alternative means owning camera lifecycle, permissions timing,
 * and rotation — none of which is product work here.
 *
 * The scan result is handed back as a raw string and parsed by the same
 * `parsePairingCode` path a pasted URL takes. That is deliberate: a QR payload
 * and a pasted payload are the same untrusted input, so they must not have two
 * validators that can drift apart.
 */
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'OrcaScan';

export const SCAN_CANCELLED = 'scan-cancelled';
export const SCAN_FAILED = 'scan-failed';

export interface ScanOutcome {
  /** True only when a code was actually read. */
  ok: boolean;
  /** The raw payload, or an empty string. */
  value: string;
  /** A short reason when `ok` is false. */
  reason: string;
}

/**
 * Opens the system scanner and returns its payload.
 *
 * A user backing out is not an error, so it is reported separately from a
 * failure — the caller should stay quiet for one and explain the other.
 */
export async function scanPairingCode(context: common.UIAbilityContext): Promise<ScanOutcome> {
  const options: scanBarcode.ScanOptions = {
    scanTypes: [scanCore.ScanType.ALL],
    enableMultiMode: true,
    enableAlbum: true
  };
  try {
    const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(context, options);
    const value = result.originalValue;
    if (value === undefined || value.length === 0) {
      return { ok: false, value: '', reason: SCAN_FAILED };
    }
    return { ok: true, value: value, reason: '' };
  } catch (error) {
    // ScanKit reports a user-initiated dismissal through the error channel, so
    // the reason string is the only way to tell it apart from a real failure.
    const message = String(error);
    hilog.info(DOMAIN, TAG, 'scan ended: %{public}s', message);
    if (message.indexOf('cancel') !== -1 || message.indexOf('CANCEL') !== -1) {
      return { ok: false, value: '', reason: SCAN_CANCELLED };
    }
    return { ok: false, value: '', reason: SCAN_FAILED };
  }
}

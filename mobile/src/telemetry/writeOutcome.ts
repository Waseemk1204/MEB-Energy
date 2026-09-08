import type { TelemetrySource, WriteResult } from './types';
import { logInfo, logWarn } from '../diagnostics/fieldLog';

/**
 * What actually happened to a write, told honestly.
 *
 * The outcome that matters here is `indeterminate`. If the command goes out and
 * the link dies before a confirmation comes back, the app does not know whether
 * the BMS applied it. Reporting that as success would put a wrong value in the
 * audit trail; reporting it as failure would invite a technician to write it
 * again, possibly twice. The only safe answer is to say we do not know, and to
 * refuse to update the displayed value until someone re-reads the parameter.
 */
export type WriteOutcome =
  | 'success'
  | 'adjusted'
  | 'rejected'
  | 'timeout'
  | 'indeterminate';

/** A BMS write is a radio round trip; it does not get to hang forever. */
export const WRITE_TIMEOUT_MS = 8000;

/** Floating-point read-back is compared at the parameter's own precision. */
export function valuesMatch(a: number, b: number, precision: number): boolean {
  const epsilon = Math.pow(10, -precision) / 2;
  return Math.abs(a - b) < epsilon;
}

export interface Classified {
  outcome: WriteOutcome;
  /** The value now believed to be on the BMS, or null when unknown. */
  confirmedValue: number | null;
  message: string | null;
}

export function classifyWrite(
  requested: number,
  precision: number,
  result: WriteResult | undefined,
  error: unknown
): Classified {
  if (error instanceof WriteTimeoutError) {
    return {
      outcome: 'timeout',
      confirmedValue: null,
      message:
        'The BMS did not respond in time. The change may or may not have been applied — ' +
        'reconnect and check the current value before trying again.',
    };
  }

  if (error instanceof LinkLostError) {
    return {
      outcome: 'indeterminate',
      confirmedValue: null,
      message:
        'The connection dropped after the command was sent. The parameter may or may not ' +
        'have changed — reconnect and check its current value before writing again.',
    };
  }

  if (error) {
    return {
      outcome: 'rejected',
      confirmedValue: null,
      message: error instanceof Error ? error.message : 'The write failed.',
    };
  }

  if (!result || !result.ok) {
    return {
      outcome: 'rejected',
      confirmedValue: null,
      message: result?.error ?? 'The BMS rejected the write.',
    };
  }

  // Accepted, but with nothing read back we cannot claim the value is confirmed.
  if (result.readBack === undefined) {
    return {
      outcome: 'indeterminate',
      confirmedValue: null,
      message:
        'The BMS accepted the command but did not return the stored value. ' +
        'Re-read the parameter to confirm what it now holds.',
    };
  }

  // Accepted, but the BMS stored something else — a clamp or a rounding rule.
  // This is a success for the write and a surprise for the user, so say both.
  if (!valuesMatch(result.readBack, requested, precision)) {
    return {
      outcome: 'adjusted',
      confirmedValue: result.readBack,
      message:
        `The BMS stored ${result.readBack.toFixed(precision)} rather than ` +
        `${requested.toFixed(precision)}. The stored value is what now applies.`,
    };
  }

  return { outcome: 'success', confirmedValue: result.readBack, message: null };
}

export class WriteTimeoutError extends Error {
  constructor() {
    super('Write timed out');
    this.name = 'WriteTimeoutError';
  }
}

export class LinkLostError extends Error {
  constructor() {
    super('Link lost during write');
    this.name = 'LinkLostError';
  }
}

/** True when a transport error means the command may already be in flight. */
export function isLinkLoss(error: unknown): boolean {
  if (error instanceof LinkLostError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return /disconnect|link|connection|cancelled|not connected/.test(message);
}

/**
 * Runs a write with a deadline. A timeout does not cancel the command — the
 * radio may still deliver it — which is precisely why the outcome is reported
 * as unknown rather than as a failure.
 */
export async function executeWrite(
  source: TelemetrySource | null,
  key: string,
  value: number,
  precision: number,
  timeoutMs: number = WRITE_TIMEOUT_MS
): Promise<Classified> {
  if (!source) {
    return {
      outcome: 'rejected',
      confirmedValue: null,
      message: 'Not connected to a battery.',
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<WriteResult>([
      source.writeSetting(key, value),
      new Promise<WriteResult>((_, reject) => {
        timer = setTimeout(() => reject(new WriteTimeoutError()), timeoutMs);
      }),
    ]);
    const classified = classifyWrite(value, precision, result, null);
    logInfo('write', `Write ${classified.outcome}`, { key, requested: value });
    return classified;
  } catch (error) {
    const normalized = isLinkLoss(error) ? new LinkLostError() : error;
    const classified = classifyWrite(value, precision, undefined, normalized);
    logWarn('write', `Write ${classified.outcome}`, {
      key,
      requested: value,
      reason: normalized instanceof Error ? normalized.name : 'unknown',
    });
    return classified;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

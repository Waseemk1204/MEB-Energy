/**
 * A bounded record of what the app was doing, for diagnosing failures reported
 * from the field.
 *
 * A pilot technician saying "it didn't connect" is not actionable. The same
 * technician exporting a log that shows three authentication failures followed
 * by a timeout is. This exists to turn the first into the second.
 *
 * Deliberately in memory: it is diagnostic, not evidential. The audit trail is
 * the record that must survive, and it persists separately.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'ble' | 'write' | 'session' | 'ui' | 'app' | 'profile';

export interface LogEntry {
  at: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  /** Small, non-sensitive context only. Never credentials, tokens or PINs. */
  detail?: Record<string, string | number | boolean | null>;
}

/** Roughly the last few minutes of activity at realistic event rates. */
export const LOG_CAP = 300;

const buffer: LogEntry[] = [];
const listeners = new Set<() => void>();

/**
 * Keys whose values must never reach a log or a crash report, whatever a caller
 * passes. Redaction happens here rather than at call sites, because a call site
 * that forgets is exactly how secrets leak.
 */
const REDACT = /pin|token|password|secret|passphrase|auth/i;

function redact(detail: LogEntry['detail']): LogEntry['detail'] {
  if (!detail) return undefined;
  const safe: NonNullable<LogEntry['detail']> = {};
  for (const [key, value] of Object.entries(detail)) {
    safe[key] = REDACT.test(key) ? '[redacted]' : value;
  }
  return safe;
}

export function log(
  level: LogLevel,
  category: LogCategory,
  message: string,
  detail?: LogEntry['detail']
): void {
  buffer.push({ at: Date.now(), level, category, message, detail: redact(detail) });
  if (buffer.length > LOG_CAP) buffer.splice(0, buffer.length - LOG_CAP);
  listeners.forEach((fn) => fn());
}

export const logDebug = (c: LogCategory, m: string, d?: LogEntry['detail']) => log('debug', c, m, d);
export const logInfo = (c: LogCategory, m: string, d?: LogEntry['detail']) => log('info', c, m, d);
export const logWarn = (c: LogCategory, m: string, d?: LogEntry['detail']) => log('warn', c, m, d);
export const logError = (c: LogCategory, m: string, d?: LogEntry['detail']) => log('error', c, m, d);

export function getLog(): readonly LogEntry[] {
  return buffer;
}

export function clearLog(): void {
  buffer.length = 0;
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Plain text, because it has to survive being pasted into an email or a ticket. */
export function formatLog(entries: readonly LogEntry[] = buffer): string {
  if (!entries.length) return 'No diagnostic entries recorded.';
  return entries
    .map((e) => {
      const time = new Date(e.at).toISOString();
      const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : '';
      return `${time} ${e.level.toUpperCase().padEnd(5)} ${e.category.padEnd(7)} ${e.message}${detail}`;
    })
    .join('\n');
}

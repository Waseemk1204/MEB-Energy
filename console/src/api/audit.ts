import type { ApiClient } from './client';

/**
 * The audit ledger (PRD §7.12, §8.1).
 *
 * This is the record of what changed on physical batteries and who asked for
 * it. Two things follow from that, and they shape everything below:
 *
 * · **Refusals are shown, not filtered out.** A trail of successes cannot
 *   answer "what did someone try to do", which is usually the question.
 * · **`indeterminate` is not a failure.** It means the app could not tell
 *   whether the BMS applied the change. Rendering it as either outcome would
 *   be inventing the one fact the record exists to be honest about.
 */

export type WriteResult = 'success' | 'adjusted' | 'rejected' | 'timeout' | 'indeterminate';
export type WriteSource = 'local' | 'admin_remote' | 'admin_force_push';

export interface AuditEvent {
  id: string;
  actorUserId: string;
  actorRole: string;
  batteryId: string | null;
  parameterKey: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  source: WriteSource;
  result: WriteResult;
  supportSessionId: string | null;
  occurredAt: number;
  recordedAt: number;
  seq: number;
}

interface AuditRow {
  id: string;
  actor_user_id: string;
  actor_role: string;
  battery_id: string | null;
  parameter_key: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  source: WriteSource;
  result: WriteResult;
  support_session_id: string | null;
  occurred_at: number;
  recorded_at: number;
  seq: number;
}

export function fromRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    batteryId: row.battery_id,
    parameterKey: row.parameter_key,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    source: row.source,
    result: row.result,
    supportSessionId: row.support_session_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    seq: row.seq,
  };
}

export interface AuditFilter {
  batteryId?: string;
  source?: WriteSource;
  result?: WriteResult;
  limit?: number;
}

/**
 * The server caps this at 200 rows by default and 1000 at most, and orders by
 * `occurred_at DESC, seq DESC`.
 *
 * That cap is why filtering has to happen **server-side**. Fetching the
 * newest 200 events fleet-wide and narrowing them here would silently miss
 * everything older — a battery whose changes fall outside that window would
 * report "nothing has been changed", which is a false statement about an audit
 * trail rather than an empty one.
 */
export async function listAudit(api: ApiClient, filter: AuditFilter = {}): Promise<AuditEvent[]> {
  const query = new URLSearchParams();
  if (filter.batteryId) query.set('batteryId', filter.batteryId);
  if (filter.source) query.set('source', filter.source);
  if (filter.result) query.set('result', filter.result);
  if (filter.limit) query.set('limit', String(filter.limit));

  const suffix = query.toString();
  const body = await api.get<{ events: AuditRow[] }>(`/audit${suffix ? `?${suffix}` : ''}`);
  return body.events.map(fromRow);
}

/** What the server will return at most, so a full page can say so. */
export const MAX_AUDIT_ROWS = 1000;
export const DEFAULT_AUDIT_ROWS = 200;

/**
 * How each outcome reads.
 *
 * `adjusted` is deliberately a warning rather than a success: the BMS accepted
 * something other than what was asked for, and someone should look at why.
 * `indeterminate` is a warning rather than a failure for the opposite reason —
 * calling it failed would assert something nobody knows.
 */
export const RESULT_LABEL: Record<WriteResult, string> = {
  success: 'Applied',
  adjusted: 'Adjusted by BMS',
  rejected: 'Refused',
  timeout: 'Timed out',
  indeterminate: 'Unconfirmed',
};

export const RESULT_TONE: Record<WriteResult, 'good' | 'warn' | 'critical' | 'neutral'> = {
  success: 'good',
  adjusted: 'warn',
  rejected: 'critical',
  timeout: 'critical',
  indeterminate: 'warn',
};

/** Where the change came from. Mode 1 (§7.3) makes this the important column. */
export const SOURCE_LABEL: Record<WriteSource, string> = {
  local: 'On site',
  admin_remote: 'Remote',
  admin_force_push: 'Force Push',
};

/**
 * `occurred_at` is the device's clock and `recorded_at` is the server's. They
 * are kept apart on purpose — an event uploaded three hours late did not happen
 * three hours late — so where they disagree materially, say so rather than
 * silently picking one.
 */
export const LATE_UPLOAD_MS = 5 * 60 * 1000;

export function wasUploadedLate(event: AuditEvent): boolean {
  return event.recordedAt - event.occurredAt > LATE_UPLOAD_MS;
}

export function formatWhen(at: number, now = Date.now()): string {
  const elapsed = now - at;
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** A change with no reason recorded is a fact worth showing, not a blank cell. */
export function describeChange(event: AuditEvent): string {
  if (!event.parameterKey) return '—';
  const from = event.oldValue ?? '?';
  const to = event.newValue ?? '?';
  return `${from} → ${to}`;
}

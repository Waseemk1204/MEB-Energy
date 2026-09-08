import { randomUUID } from 'node:crypto';
import type { Param, Store } from '../db/client.js';
import { tenantQuery, type Principal } from '../db/tenancy.js';

/**
 * The audit ledger (PRD §7.12).
 *
 * Every attempted write lands here, successful or not. A trail that records
 * only successes cannot answer "what did someone try to do", and since admin
 * remote writes never prompt the Company or User (§6.3), this record is the
 * primary safety-relevant account of what changed on a physical battery.
 *
 * Writing is append-only at the database. There is deliberately no update or
 * delete function in this module — not because callers would be trusted not to
 * use one, but so that the absence is visible.
 */

export type WriteSource = 'local' | 'admin_remote' | 'admin_force_push';
export type WriteResult = 'success' | 'adjusted' | 'rejected' | 'timeout' | 'indeterminate';

export interface AuditRecord {
  companyId: string;
  actorUserId: string;
  actorRole: string;
  batteryId?: string | null;
  deviceId?: string | null;
  parameterKey?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  source: WriteSource;
  result: WriteResult;
  bmsResponse?: string | null;
  appVersion?: string | null;
  deviceFirmware?: string | null;
  bmsFirmware?: string | null;
  supportSessionId?: string | null;
  occurredAt?: number;
  /**
   * Set by the app for a write it performed itself, over BLE, possibly while
   * offline. It makes an upload retry idempotent — see {@link ingestClientAudit}.
   */
  clientEventId?: string | null;
}

export interface AuditRow {
  id: string;
  company_id: string;
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

export function recordAudit(store: Store, record: AuditRecord, now = Date.now()): string {
  const id = randomUUID();
  store.run(
    `INSERT INTO audit_events
     (id, company_id, actor_user_id, actor_role, battery_id, device_id, parameter_key,
      old_value, new_value, reason, source, result, bms_response, app_version,
      device_firmware, bms_firmware, support_session_id, client_event_id,
      occurred_at, recorded_at, seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_events))`,
    id,
    record.companyId,
    record.actorUserId,
    record.actorRole,
    record.batteryId ?? null,
    record.deviceId ?? null,
    record.parameterKey ?? null,
    record.oldValue ?? null,
    record.newValue ?? null,
    record.reason ?? null,
    record.source,
    record.result,
    record.bmsResponse ?? null,
    record.appVersion ?? null,
    record.deviceFirmware ?? null,
    record.bmsFirmware ?? null,
    record.supportSessionId ?? null,
    record.clientEventId ?? null,
    record.occurredAt ?? now,
    now
  );
  return id;
}

/**
 * Ingest an event the app recorded itself.
 *
 * A technician performs Mode 2 writes over BLE, on site, sometimes with no
 * signal at all. Those changes happened to a physical battery whether or not
 * the phone could reach the server, so the app buffers them and uploads later
 * — which means this path must tolerate being called twice with the same
 * event. It is idempotent on `clientEventId`: a repeat returns the id of the
 * row already stored and writes nothing.
 *
 * `occurredAt` is the technician's clock and `recorded_at` is the server's.
 * They are kept apart on purpose: an event uploaded three hours late is not an
 * event that happened three hours late, and a device with a wrong clock must
 * not be able to backdate the ledger's own ordering, which `seq` governs.
 */
export function ingestClientAudit(
  store: Store,
  record: AuditRecord & { clientEventId: string },
  now = Date.now()
): { auditId: string; duplicate: boolean } {
  return store.transaction(() => {
    const existing = store.get<{ id: string }>(
      'SELECT id FROM audit_events WHERE company_id = ? AND client_event_id = ?',
      record.companyId,
      record.clientEventId
    );
    if (existing) return { auditId: existing.id, duplicate: true };

    return { auditId: recordAudit(store, record, now), duplicate: false };
  });
}

export interface AuditFilter {
  batteryId?: string;
  source?: WriteSource;
  result?: WriteResult;
  since?: number;
  limit?: number;
}

/**
 * Reading the trail is tenant-scoped like everything else — a company sees its
 * own history, an admin sees the platform's.
 */
export function queryAudit(
  store: Store,
  principal: Principal,
  filter: AuditFilter = {}
): AuditRow[] {
  const clauses: string[] = [];
  const params: Param[] = [];

  if (filter.batteryId) {
    clauses.push('battery_id = ?');
    params.push(filter.batteryId);
  }
  if (filter.source) {
    clauses.push('source = ?');
    params.push(filter.source);
  }
  if (filter.result) {
    clauses.push('result = ?');
    params.push(filter.result);
  }
  if (filter.since !== undefined) {
    clauses.push('occurred_at >= ?');
    params.push(filter.since);
  }

  const q = tenantQuery(principal, 'audit_events', {
    where: clauses.length ? clauses.join(' AND ') : undefined,
    params,
    orderBy: 'occurred_at DESC, seq DESC',
  });

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return store.all<AuditRow>(`${q.sql} LIMIT ?`, ...q.params, limit);
}

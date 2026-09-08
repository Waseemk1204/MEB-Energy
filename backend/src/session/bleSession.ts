import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';

/**
 * Server-side tracking of the user's BLE session (PRD §9.3, enforcing §7.3).
 *
 * This exists because the alternative was letting the client assert
 * `bleSessionActive: true` in a request body — which makes Mode 1 decorative.
 * The whole constraint is that no command reaches a BMS unless a user is
 * physically present with a live link, and a caller claiming to be present is
 * not evidence of presence.
 *
 * It matters most for admin remote writes: an administrator's browser has no
 * idea whether a technician three counties away still has a link. Only the
 * server, receiving that technician's heartbeats, does.
 */

/**
 * A session with no heartbeat for this long is treated as gone. The comparison
 * is strict — at exactly this age the link is already considered dead, matching
 * the staleness convention the mobile app uses for telemetry.
 */
export const SESSION_STALE_MS = 30_000;

export interface BleSessionRow {
  id: string;
  company_id: string;
  battery_id: string;
  user_id: string;
  device_id: string | null;
  started_at: number;
  last_heartbeat_at: number;
  ended_at: number | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  batteryId: string;
  lastHeartbeatAt: number;
}

/**
 * Opens or refreshes this user's session on a battery. Idempotent: reconnecting
 * after a dropped link should not accumulate sessions.
 */
export function openSession(
  store: Store,
  principal: Principal,
  batteryId: string,
  companyId: string,
  deviceId: string | null = null,
  now = Date.now()
): string {
  const existing = store.get<BleSessionRow>(
    'SELECT * FROM ble_sessions WHERE battery_id = ? AND user_id = ? AND ended_at IS NULL',
    batteryId,
    principal.userId
  );

  if (existing) {
    store.run('UPDATE ble_sessions SET last_heartbeat_at = ? WHERE id = ?', now, existing.id);
    return existing.id;
  }

  const id = randomUUID();
  store.run(
    `INSERT INTO ble_sessions
     (id, company_id, battery_id, user_id, device_id, started_at, last_heartbeat_at)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    companyId,
    batteryId,
    principal.userId,
    deviceId,
    now,
    now
  );
  return id;
}

/** Returns false when the session has already ended or never existed. */
export function heartbeat(
  store: Store,
  principal: Principal,
  batteryId: string,
  now = Date.now()
): boolean {
  const row = store.get<BleSessionRow>(
    'SELECT id FROM ble_sessions WHERE battery_id = ? AND user_id = ? AND ended_at IS NULL',
    batteryId,
    principal.userId
  );
  if (!row) return false;
  store.run('UPDATE ble_sessions SET last_heartbeat_at = ? WHERE id = ?', now, row.id);
  return true;
}

export function closeSession(
  store: Store,
  principal: Principal,
  batteryId: string,
  now = Date.now()
): void {
  store.run(
    'UPDATE ble_sessions SET ended_at = ? WHERE battery_id = ? AND user_id = ? AND ended_at IS NULL',
    now,
    batteryId,
    principal.userId
  );
}

/**
 * The question the policy engine actually needs answered: is *someone* on site
 * with a live link to this battery right now?
 *
 * Note it is deliberately not "does this caller have a session". An admin
 * writing remotely has no session of their own and never will — what makes
 * their command deliverable is the technician's.
 */
export function activeSessionFor(
  store: Store,
  batteryId: string,
  now = Date.now()
): ActiveSession | null {
  const row = store.get<BleSessionRow>(
    `SELECT * FROM ble_sessions
     WHERE battery_id = ? AND ended_at IS NULL AND last_heartbeat_at > ?
     ORDER BY last_heartbeat_at DESC`,
    batteryId,
    now - SESSION_STALE_MS
  );
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        batteryId: row.battery_id,
        lastHeartbeatAt: row.last_heartbeat_at,
      }
    : null;
}

export const isSessionActive = (store: Store, batteryId: string, now = Date.now()): boolean =>
  activeSessionFor(store, batteryId, now) !== null;

/** Housekeeping: mark timed-out sessions as ended so they stop being listed. */
export function reapStaleSessions(store: Store, now = Date.now()): void {
  store.run(
    'UPDATE ble_sessions SET ended_at = last_heartbeat_at WHERE ended_at IS NULL AND last_heartbeat_at <= ?',
    now - SESSION_STALE_MS
  );
}

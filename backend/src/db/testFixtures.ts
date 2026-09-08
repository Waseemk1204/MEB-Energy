import { randomUUID } from 'node:crypto';
import type { Store } from './client.js';

/**
 * A company that can actually be used.
 *
 * Sign-in now checks the company's own entitlement, not only the user's
 * status — so a company row on its own is a company nobody can log into. That
 * is the correct behaviour and it broke fourteen test fixtures, every one of
 * which was creating exactly that state and had never noticed.
 *
 * Exported from `src/` rather than a test directory because the test runner
 * compiles the whole tree; it is used only by tests.
 */
export function seedCompany(
  store: Store,
  id: string,
  name: string,
  options: {
    seatLimit?: number;
    deviceLimit?: number;
    sessionDeviceLimit?: number;
    batteryLimit?: number | null;
  } = {},
  now = Date.now()
): void {
  store.run(
    'INSERT INTO companies (id, name, status, created_at) VALUES (?,?,?,?)',
    id,
    name,
    'active',
    now
  );
  store.run(
    `INSERT INTO subscriptions
     (id, company_id, plan_type, start_date, renewal_date, seat_limit, device_limit,
      session_device_limit, battery_limit, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    id,
    'yearly',
    now,
    now + 365 * 24 * 60 * 60 * 1000,
    options.seatLimit ?? 100,
    options.deviceLimit ?? 10,
    options.sessionDeviceLimit ?? 2,
    options.batteryLimit ?? null,
    'active',
    now
  );
}

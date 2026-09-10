import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { DEFAULT_SESSION_DEVICES } from '../auth/sessionDevices.js';

/**
 * What a company is currently allowed to do.
 *
 * Payment happens outside this system — an administrator takes it however they
 * take it and then switches access on here. So an entitlement is a deliberate
 * act with a date on it, not something inferred from a billing integration
 * that does not exist.
 *
 * Everything below was previously stored and never read. A company could be
 * suspended, or its plan could have lapsed a year ago, and every one of its
 * users would carry on working — because the only thing sign-in checked was
 * whether the *user* was active.
 */

/** One year from the moment access is granted. The only plan there is. */
export const TERM_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The tiers an administrator picks from.
 *
 * Offered rather than free-typed so that "50" means the same thing in every
 * conversation about it — but `grantAccess` accepts any positive integer,
 * because a number nobody anticipated should not require a code change.
 */
export const SEAT_TIERS = [5, 20, 50, 100, 250, 500] as const;

/** Two, unless an administrator says otherwise. */
export const DEFAULT_DEVICE_LIMIT = 2;

export type EntitlementCode =
  | 'ok'
  | 'company_suspended'
  | 'no_subscription'
  | 'subscription_expired'
  | 'subscription_cancelled';

export interface Entitlement {
  code: EntitlementCode;
  ok: boolean;
  /** Present when there is a subscription at all, expired or not. */
  expiresAt?: number;
  seatLimit?: number;
  /**
   * KnowyourEV gateways the company may register; null means no limit.
   *
   * Reported exactly as stored. This used to substitute DEFAULT_DEVICE_LIMIT
   * for a null, while `deviceUsage` — the reader enforcement actually uses —
   * reported null as "no limit". So the console showed a cap of two on a
   * company the server would let register a thousand gateways. A displayed
   * limit that enforcement does not share is worse than no limit shown.
   */
  deviceLimit?: number | null;
  /** Phones and browsers the owner account may be signed in on at once. */
  sessionDeviceLimit?: number;
  batteryLimit?: number | null;
}

interface CompanyRow {
  id: string;
  status: string;
}

interface SubscriptionRow {
  id: string;
  renewal_date: number;
  seat_limit: number;
  device_limit: number | null;
  session_device_limit: number | null;
  battery_limit: number | null;
  status: string;
}

/**
 * Whether this company may be used right now.
 *
 * Called on every sign-in and every refresh, so a company suspended or expired
 * mid-session loses access at the next token renewal — within fifteen minutes
 * rather than whenever somebody happens to sign out.
 */
export function entitlementOf(store: Store, companyId: string, now = Date.now()): Entitlement {
  const company = store.get<CompanyRow>('SELECT id, status FROM companies WHERE id = ?', companyId);
  if (!company || company.status !== 'active') {
    return { code: 'company_suspended', ok: false };
  }

  const subscription = store.get<SubscriptionRow>(
    `SELECT id, renewal_date, seat_limit, device_limit, session_device_limit, battery_limit, status
     FROM subscriptions WHERE company_id = ?
     ORDER BY renewal_date DESC LIMIT 1`,
    companyId
  );

  if (!subscription) return { code: 'no_subscription', ok: false };

  const limits = {
    expiresAt: subscription.renewal_date,
    seatLimit: subscription.seat_limit,
    deviceLimit: subscription.device_limit,
    sessionDeviceLimit: subscription.session_device_limit ?? DEFAULT_SESSION_DEVICES,
    batteryLimit: subscription.battery_limit,
  };

  if (subscription.status !== 'active') {
    return { code: 'subscription_cancelled', ok: false, ...limits };
  }

  // Strictly past the date, so a plan is usable up to its final moment.
  if (subscription.renewal_date <= now) {
    return { code: 'subscription_expired', ok: false, ...limits };
  }

  return { code: 'ok', ok: true, ...limits };
}

/**
 * An administrator has taken payment and is switching access on.
 *
 * Replaces whatever came before rather than stacking: a company has one live
 * entitlement, and a second overlapping row is a question nobody wants to
 * answer when a technician cannot sign in.
 *
 * The term always runs from *now*. Renewing early therefore forfeits the
 * remainder of the old term — which is a deliberate choice worth naming, and
 * the alternative (extending from the old expiry) is a one-line change here if
 * it turns out to be what is wanted.
 */
export function grantAccess(
  store: Store,
  companyId: string,
  input: {
    seatLimit: number;
    deviceLimit?: number;
    sessionDeviceLimit?: number;
    batteryLimit?: number | null;
  },
  now = Date.now()
): { subscriptionId: string; expiresAt: number } {
  const expiresAt = now + TERM_MS;
  const id = randomUUID();

  store.transaction(() => {
    // Previous subscriptions are closed, not deleted: what a company was
    // entitled to last year is part of the record.
    store.run(
      "UPDATE subscriptions SET status = 'superseded' WHERE company_id = ? AND status = 'active'",
      companyId
    );
    store.run(
      `INSERT INTO subscriptions
       (id, company_id, plan_type, start_date, renewal_date, seat_limit, device_limit,
        session_device_limit, battery_limit, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      companyId,
      'yearly',
      now,
      expiresAt,
      input.seatLimit,
      input.deviceLimit ?? DEFAULT_DEVICE_LIMIT,
      input.sessionDeviceLimit ?? DEFAULT_SESSION_DEVICES,
      input.batteryLimit ?? null,
      'active',
      now
    );
  });

  return { subscriptionId: id, expiresAt };
}

/**
 * Switch access off without deleting anything.
 *
 * Distinct from letting a plan lapse: this is somebody deciding, and the code
 * the user is refused with says which it was.
 */
export function revokeAccess(store: Store, companyId: string): void {
  store.run(
    "UPDATE subscriptions SET status = 'cancelled' WHERE company_id = ? AND status = 'active'",
    companyId
  );
}

/**
 * Raise or lower what a live plan allows, without restarting its term.
 *
 * Adding seats mid-year should not silently buy another year, and a company
 * that has paid for ten months should not lose them because somebody adjusted
 * a limit.
 */
export function adjustLimits(
  store: Store,
  companyId: string,
  input: {
    seatLimit?: number;
    deviceLimit?: number;
    sessionDeviceLimit?: number;
    batteryLimit?: number | null;
  }
): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.seatLimit !== undefined) {
    sets.push('seat_limit = ?');
    params.push(input.seatLimit);
  }
  if (input.deviceLimit !== undefined) {
    sets.push('device_limit = ?');
    params.push(input.deviceLimit);
  }
  if (input.sessionDeviceLimit !== undefined) {
    sets.push('session_device_limit = ?');
    params.push(input.sessionDeviceLimit);
  }
  if (input.batteryLimit !== undefined) {
    sets.push('battery_limit = ?');
    params.push(input.batteryLimit);
  }
  if (sets.length === 0) return;

  store.run(
    `UPDATE subscriptions SET ${sets.join(', ')} WHERE company_id = ? AND status = 'active'`,
    ...params,
    companyId
  );
}

/** How long is left, for a console that has to say something useful. */
export function describeRemaining(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';

  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days <= 60) return `${days} day${days === 1 ? '' : 's'} left`;
  return `${Math.round(days / 30)} months left`;
}

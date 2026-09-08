import type { Store } from '../db/client.js';

/**
 * How many devices a company account may be signed in on at once.
 *
 * A company owner's login is the one credential most likely to be shared —
 * passed around an office, kept on a spare tablet, given to somebody covering
 * a shift. Capping concurrent devices is what stops one paid account becoming
 * a floating licence for a depot.
 *
 * Distinct from the gateway `device_limit`, which counts knowyourEV hardware.
 * Two different things called "device" is how the two get confused, so they
 * are named apart everywhere.
 *
 * **A third sign-in signs out the oldest rather than being refused.** That is a
 * deliberate trade and worth stating:
 *
 * · There is no email and no self-service recovery, so a refusal would lock an
 *   owner out of their own account the day they replace a phone, with no way
 *   back except contacting an administrator.
 * · Being signed out unexpectedly is a *signal*. Somebody who did not sign in
 *   anywhere new has just learned that somebody else did — which is the thing
 *   they would want to know, and which a refusal hides from them entirely.
 *
 * So the constraint holds either way, and this way the person who notices is
 * the legitimate one.
 */

/** Two, unless an administrator raises it. */
export const DEFAULT_SESSION_DEVICES = 2;

/** Only the company-owner account is capped; technicians hold their own seats. */
export const CAPPED_ROLES = new Set(['company']);

export interface EvictedDevice {
  label: string | null;
  /**
   * When this session was last renewed, not when it first signed in.
   *
   * A refresh token rotates roughly every fifteen minutes while the app is in
   * use, and each rotation writes a new row — so `created_at` tracks last
   * activity. That makes the eviction below least-recently-*used*, which is
   * the policy you want: the device to drop is the one nobody has touched in
   * a week, not whichever was signed into first. The wording says "last used"
   * for the same reason.
   */
  lastUsedAt: number;
}

interface TokenRow {
  id: string;
  created_at: number;
  device_label: string | null;
}

export function sessionDeviceLimit(store: Store, companyId: string | null): number | null {
  if (companyId === null) return null;

  const row = store.get<{ session_device_limit: number | null }>(
    "SELECT session_device_limit FROM subscriptions WHERE company_id = ? AND status = 'active'",
    companyId
  );
  return row?.session_device_limit ?? DEFAULT_SESSION_DEVICES;
}

/** Live sessions, newest first. One row per device currently signed in. */
export function liveSessions(store: Store, userId: string, now = Date.now()): TokenRow[] {
  return store.all<TokenRow>(
    `SELECT id, created_at, device_label FROM refresh_tokens
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC`,
    userId,
    now
  );
}

/**
 * Make room for a sign-in that is about to happen.
 *
 * Called *before* the new token is issued, so the limit counts devices that
 * will exist rather than devices that did. Returns whatever was signed out, so
 * the person signing in can be told — a silent eviction is the same event with
 * the useful half removed.
 */
export function enforceDeviceLimit(
  store: Store,
  user: { id: string; role: string; company_id: string | null },
  now = Date.now()
): EvictedDevice[] {
  if (!CAPPED_ROLES.has(user.role)) return [];

  const limit = sessionDeviceLimit(store, user.company_id);
  if (limit === null) return [];

  const live = liveSessions(store, user.id, now);
  // One slot for the sign-in in progress.
  const excess = live.length - (limit - 1);
  if (excess <= 0) return [];

  // The device nobody has used in longest is the one to go. See EvictedDevice.
  const evicting = live.slice(-excess);
  for (const token of evicting) {
    store.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', now, token.id);
  }

  return evicting.map((t) => ({ label: t.device_label, lastUsedAt: t.created_at }));
}

/**
 * A readable name for whatever is signing in.
 *
 * From the User-Agent, which is neither reliable nor unique — two identical
 * phones look the same. It is here so that "you were signed out on Safari on
 * iPhone" is possible instead of "you were signed out somewhere", not as an
 * identifier anything depends on.
 */
export function labelFor(userAgent: string | undefined): string | null {
  if (!userAgent) return null;

  const platform =
    /iPhone/i.test(userAgent) ? 'iPhone'
    : /iPad/i.test(userAgent) ? 'iPad'
    : /Android/i.test(userAgent) ? 'Android'
    : /Macintosh|Mac OS/i.test(userAgent) ? 'Mac'
    : /Windows/i.test(userAgent) ? 'Windows'
    : /Linux/i.test(userAgent) ? 'Linux'
    : null;

  const browser =
    /Edg\//i.test(userAgent) ? 'Edge'
    : /OPR\//i.test(userAgent) ? 'Opera'
    : /Chrome\//i.test(userAgent) ? 'Chrome'
    : /Firefox\//i.test(userAgent) ? 'Firefox'
    : /Safari\//i.test(userAgent) ? 'Safari'
    : /Expo|okhttp|CFNetwork/i.test(userAgent) ? 'knowyourEV app'
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? userAgent.slice(0, 40);
}

/**
 * How many devices the company's owner accounts are signed in on right now,
 * against what the plan allows.
 *
 * The limit is per account, not per company: two owners each get the cap. The
 * count is across all of them, which is what an administrator looking at one
 * row wants to see.
 */
export function sessionDeviceUsage(
  store: Store,
  companyId: string,
  now = Date.now()
): { used: number; limit: number | null } {
  const roles = [...CAPPED_ROLES];
  const placeholders = roles.map(() => '?').join(',');
  const row = store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM refresh_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE u.company_id = ? AND u.role IN (${placeholders})
       AND t.revoked_at IS NULL AND t.expires_at > ?`,
    companyId,
    ...roles,
    now
  );

  return { used: row?.n ?? 0, limit: sessionDeviceLimit(store, companyId) };
}

/** For a console that lists somebody's signed-in devices. */
export function describeDevice(device: EvictedDevice, now = Date.now()): string {
  const minutes = Math.floor((now - device.lastUsedAt) / 60_000);
  const when =
    minutes < 60
      ? `${Math.max(1, minutes)} min ago`
      : minutes < 60 * 24
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(device.lastUsedAt).toISOString().slice(0, 10);

  return `${device.label ?? 'an unrecognised device'}, last used ${when}`;
}

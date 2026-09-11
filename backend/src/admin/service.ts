import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { canManageUsers, tenantQuery, type Principal, type Role } from '../db/tenancy.js';
import { hashPassword } from '../auth/password.js';
import { NO_PASSWORD, createInvitation } from '../auth/invitations.js';
import { revokeAllForUser } from '../auth/tokens.js';
import { DEFAULT_SESSION_DEVICES } from '../auth/sessionDevices.js';
import { DEFAULT_PERMISSIONS, type PermissionPatch } from '../auth/permissions.js';
import { DEFAULT_DEVICE_LIMIT } from './entitlement.js';

/**
 * Company, user and device administration (PRD §6.4, §6.5, §7.6, §7.8).
 *
 * The rules that matter here are the ones that stop a tenant escalating out of
 * its own boundary: who may create whom, in which company, with which role.
 * Every one of them is checked here rather than at the route, so a second
 * caller of these functions cannot skip them.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'forbidden'
      | 'device_limit_reached'
      | 'has_history'
      | 'email_taken'
      | 'not_found'
      | 'invalid_role'
      | 'last_admin'
      | 'invitation_pending'
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/* ------------------------------------------------------------- companies */

export interface NewCompany {
  name: string;
  seatLimit: number;
  deviceLimit?: number | null;
  sessionDeviceLimit?: number;
  batteryLimit?: number | null;
  /** Yearly only; the PRD offers no monthly plan. */
  renewalDate?: number;
}

export function createCompany(
  store: Store,
  principal: Principal,
  input: NewCompany,
  now = Date.now()
): { companyId: string; subscriptionId: string } {
  // Only the platform creates tenants. A company creating a company would be a
  // tenant escaping its own boundary.
  if (principal.role !== 'admin') {
    throw new AdminError('Only an administrator may create a company', 'forbidden');
  }

  const companyId = randomUUID();
  const subscriptionId = randomUUID();
  const renewalDate = input.renewalDate ?? now + 365 * 24 * 60 * 60 * 1000;

  store.transaction(() => {
    store.run(
      'INSERT INTO companies (id, name, status, created_at) VALUES (?,?,?,?)',
      companyId,
      input.name,
      'active',
      now
    );
    store.run(
      `INSERT INTO subscriptions
       (id, company_id, plan_type, start_date, renewal_date, seat_limit, device_limit,
        session_device_limit, battery_limit, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      subscriptionId,
      companyId,
      'yearly',
      now,
      renewalDate,
      input.seatLimit,
      // Undefined means "not asked" and takes the same default granting access
      // does; an explicit null is an administrator saying "no limit" and is
      // kept. Without this a company created from the console had no gateway
      // cap at all while its plan claimed one.
      input.deviceLimit === undefined ? DEFAULT_DEVICE_LIMIT : input.deviceLimit,
      input.sessionDeviceLimit ?? DEFAULT_SESSION_DEVICES,
      input.batteryLimit ?? null,
      'active',
      now
    );
  });

  return { companyId, subscriptionId };
}

/* ------------------------------------------------------------------ users */

export interface NewUser {
  companyId: string | null;
  email: string;
  displayName: string;
  role: Role;
  /**
   * What this person may do. Anything omitted takes the default: they can
   * read, see location and see health, and they cannot write.
   */
  permissions?: PermissionPatch;
  /**
   * Omit to create the account by invitation, which is the normal path: the
   * new user sets their own first password and nobody else ever sees it.
   *
   * Supplying one directly is kept for the bootstrap case and for tests. It
   * means whoever calls this knows that person's password, which is exactly
   * what invitations exist to avoid — see auth/invitations.ts.
   */
  password?: string;
}

export interface CreatedUser {
  id: string;
  /** Present only when the account was created by invitation. */
  invitation?: { token: string; expiresAt: number };
}

interface SeatUsage {
  used: number;
  limit: number | null;
}

/** Only active users consume a seat; a suspended account frees one. */
export function seatUsage(store: Store, companyId: string): SeatUsage {
  const used = store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND status = 'active'",
    companyId
  );
  const subscription = store.get<{ seat_limit: number }>(
    "SELECT seat_limit FROM subscriptions WHERE company_id = ? AND status = 'active'",
    companyId
  );
  return { used: used?.n ?? 0, limit: subscription?.seat_limit ?? null };
}

export async function createUser(
  store: Store,
  principal: Principal,
  input: NewUser,
  now = Date.now()
): Promise<CreatedUser> {
  // An admin is platform-wide and tenantless; everyone else belongs to exactly
  // one company. The schema enforces this too, but failing here gives a usable
  // message rather than a constraint violation.
  if (input.role === 'admin') {
    if (principal.role !== 'admin') {
      throw new AdminError('Only an administrator may create administrators', 'forbidden');
    }
    if (input.companyId !== null) {
      throw new AdminError('An administrator cannot belong to a company', 'invalid_role');
    }
  } else {
    if (!input.companyId) {
      throw new AdminError(`Role '${input.role}' must belong to a company`, 'invalid_role');
    }
    // A company principal may create users only inside its own tenant.
    if (!canManageUsers(principal, input.companyId)) {
      throw new AdminError('Not permitted to create users in that company', 'forbidden');
    }
  }

  /*
   * There is no seat cap. What a company pays is settled outside the product,
   * so the only commercial control left is whether their access is on at all.
   * `seatUsage` survives as a count for the admin dashboard -- a number to
   * look at, not a rule to trip over.
   */

  const perms = { ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) };

  const email = input.email.trim().toLowerCase();
  if (store.get('SELECT id FROM users WHERE email = ?', email)) {
    throw new AdminError('That email address is already in use', 'email_taken');
  }

  const id = randomUUID();
  const byInvitation = input.password === undefined;

  // An invited account carries a placeholder that is not a valid scrypt hash.
  // `verifyPassword` fails closed on a malformed hash, so it cannot be signed
  // into even if the status check were somehow bypassed — two independent
  // reasons for the same refusal.
  const passwordHash = byInvitation ? NO_PASSWORD : await hashPassword(input.password!);

  return store.transaction(() => {
    store.run(
      `INSERT INTO users
       (id, company_id, email, display_name, role, password_hash, status, created_at,
        can_read, can_write, can_location, can_health)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.companyId,
      email,
      input.displayName,
      input.role,
      passwordHash,
      byInvitation ? 'invited' : 'active',
      now,
      // Spelled out rather than left to the column defaults, so what a new
      // user can do is visible where the user is made.
      perms.read ? 1 : 0,
      perms.write ? 1 : 0,
      perms.location ? 1 : 0,
      perms.health ? 1 : 0
    );

    if (!byInvitation) return { id };

    const invitation = createInvitation(store, id, principal.userId, now);
    return { id, invitation: { token: invitation.token, expiresAt: invitation.expiresAt } };
  });
}

interface UserRow {
  id: string;
  company_id: string | null;
  email: string;
  display_name: string;
  role: Role;
  status: string;
  password_hash?: string;
}

export function listUsers(store: Store, principal: Principal): UserRow[] {
  const q = tenantQuery(principal, 'users', {
    columns: 'id, company_id, email, display_name, role, status',
    orderBy: 'email ASC',
  });
  return store.all<UserRow>(q.sql, ...q.params);
}

/**
 * Deactivation revokes every refresh token for the account.
 *
 * Without that, a suspended user keeps working until their refresh token
 * expires — up to a fortnight of access after being told they no longer have
 * any. Deactivation has to mean it immediately.
 */
/**
 * The user this principal is allowed to act on, or null.
 *
 * One rule, used by everything that reaches for somebody else's account. A
 * company principal sees only its own tenant, and platform administrators are
 * invisible to them entirely — "not yours" and "not there" are the same answer
 * on purpose, so the endpoint cannot be used to discover who exists.
 */
export function visibleUser(store: Store, principal: Principal, userId: string): UserRow | null {
  const target = store.get<UserRow>(
    'SELECT id, company_id, role, status, password_hash FROM users WHERE id = ?',
    userId
  );
  if (!target) return null;

  if (target.role === 'admin') return principal.role === 'admin' ? target : null;
  return canManageUsers(principal, target.company_id ?? '') ? target : null;
}

export function setUserStatus(
  store: Store,
  principal: Principal,
  userId: string,
  status: 'active' | 'suspended',
  now = Date.now()
): void {
  const target = visibleUser(store, principal, userId);
  // Same message for "not yours" and "not there" — see tenancy.assertOwned.
  if (!target) throw new AdminError('User not found', 'not_found');

  // An invited account has no password yet. Flipping it to 'active' would
  // produce an account that looks usable and cannot be signed into, which is
  // a worse state than the honest one it is already in.
  if (status === 'active' && target.password_hash === NO_PASSWORD) {
    throw new AdminError(
      'That invitation has not been accepted yet, so there is no password to sign in with',
      'invitation_pending'
    );
  }

  if (target.role === 'admin') {
    if (status === 'suspended') {
      const others = store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?",
        userId
      );
      // Locking every administrator out of the platform is not a state anyone
      // can recover from through the product.
      if ((others?.n ?? 0) === 0) {
        throw new AdminError('Cannot suspend the last active administrator', 'last_admin');
      }
    }
  }

  store.run('UPDATE users SET status = ? WHERE id = ?', status, userId);
  if (status === 'suspended') revokeAllForUser(store, userId, now);
}

/**
 * Remove a user outright.
 *
 * For the guest case: somebody is brought in to help with a problem and taken
 * off the account when it is solved. Suspension keeps the row and frees the
 * seat, which is right for an employee who might come back — but a contractor
 * who is gone should be gone.
 *
 * **A user who has changed anything is suspended instead, never deleted.** The
 * audit ledger references its actor, and a trail that cannot say who made a
 * change is not an audit trail. The caller is told which happened.
 */
export function removeUser(
  store: Store,
  principal: Principal,
  userId: string,
  now = Date.now()
): { removed: boolean; reason?: 'has_history' } {
  const target = store.get<UserRow>(
    'SELECT id, company_id, role, status FROM users WHERE id = ?',
    userId
  );
  if (!target) throw new AdminError('User not found', 'not_found');

  if (target.id === principal.userId) {
    throw new AdminError('You cannot remove your own account', 'forbidden');
  }
  if (target.role === 'admin') {
    // Platform administrators are not a tenant's to delete.
    if (principal.role !== 'admin') throw new AdminError('User not found', 'not_found');
    throw new AdminError('An administrator cannot be removed, only suspended', 'last_admin');
  }
  if (!canManageUsers(principal, target.company_id ?? '')) {
    throw new AdminError('User not found', 'not_found');
  }

  /*
   * Everything in the schema that points at a user, split into two kinds.
   *
   * **History** must outlive the account. An audit row whose actor has been
   * deleted cannot say who made a change, and a support session with no
   * administrator is a record of nobody doing something. Anyone referenced
   * this way is suspended instead — the caller is told which happened rather
   * than being told "removed" when it was not.
   *
   * **Session state** goes with them: tokens, links, their own invitation.
   *
   * Enumerated rather than discovered. The first version revoked tokens
   * without deleting them and hit a foreign key error on any user who had ever
   * signed in — and its test passed, because that user never had.
   */
  const referencedBy = (sql: string) => (store.get<{ n: number }>(sql, userId)?.n ?? 0) > 0;

  const isHistory =
    referencedBy('SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?') ||
    referencedBy('SELECT COUNT(*) AS n FROM commands WHERE issued_by = ?') ||
    referencedBy('SELECT COUNT(*) AS n FROM support_sessions WHERE admin_user_id = ?') ||
    referencedBy('SELECT COUNT(*) AS n FROM support_sessions WHERE target_user_id = ?') ||
    referencedBy('SELECT COUNT(*) AS n FROM user_invitations WHERE invited_by = ?');

  if (isHistory) {
    setUserStatus(store, principal, userId, 'suspended', now);
    return { removed: false, reason: 'has_history' };
  }

  store.transaction(() => {
    // Deleted, not revoked: the account is going, and a revoked row would
    // still hold a foreign key against it.
    store.run('DELETE FROM refresh_tokens WHERE user_id = ?', userId);
    store.run('DELETE FROM ble_sessions WHERE user_id = ?', userId);
    store.run('DELETE FROM user_invitations WHERE user_id = ?', userId);
    store.run('DELETE FROM users WHERE id = ?', userId);
  });

  return { removed: true };
}

/* ---------------------------------------------------------------- devices */

export interface NewDevice {
  companyId: string;
  serial: string;
  hardwareRevision: string;
  firmwareVersion: string;
  assignedBatteryId?: string | null;
}

/** Counted against the plan, the same way seats and batteries are. */
export function deviceUsage(store: Store, companyId: string): SeatUsage {
  const used = store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM devices WHERE company_id = ? AND security_status <> 'revoked'",
    companyId
  );
  const subscription = store.get<{ device_limit: number | null }>(
    "SELECT device_limit FROM subscriptions WHERE company_id = ? AND status = 'active'",
    companyId
  );
  return { used: used?.n ?? 0, limit: subscription?.device_limit ?? null };
}

export function registerDevice(
  store: Store,
  principal: Principal,
  input: NewDevice,
  now = Date.now()
): string {
  if (!canManageUsers(principal, input.companyId)) {
    throw new AdminError('Not permitted to register devices for that company', 'forbidden');
  }
  if (store.get('SELECT id FROM devices WHERE serial = ?', input.serial)) {
    throw new AdminError('That device serial is already registered', 'email_taken');
  }

  // A revoked gateway is out of service and does not hold a slot — otherwise a
  // company that lost a device would have to raise its plan to replace it.
  const { used, limit } = deviceUsage(store, input.companyId);
  if (limit !== null && used >= limit) {
    throw new AdminError(
      `Device limit reached (${used}/${limit}). Revoke a gateway or raise the plan.`,
      'device_limit_reached'
    );
  }

  const id = randomUUID();
  store.run(
    `INSERT INTO devices
     (id, company_id, serial, hardware_revision, firmware_version, assigned_battery_id, security_status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.companyId,
    input.serial,
    input.hardwareRevision,
    input.firmwareVersion,
    input.assignedBatteryId ?? null,
    'valid',
    now
  );
  return id;
}

/* ------------------------------------------------------------- batteries */

export interface NewBattery {
  companyId: string;
  serial: string;
  chemistry: string;
  cellCount: number;
  bmsModel: string;
  capacityAh?: number | null;
}

/** Counted against the plan's battery limit the same way seats are. */
export function batteryUsage(store: Store, companyId: string): SeatUsage {
  const used = store.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM batteries WHERE company_id = ?',
    companyId
  );
  const subscription = store.get<{ battery_limit: number | null }>(
    "SELECT battery_limit FROM subscriptions WHERE company_id = ? AND status = 'active'",
    companyId
  );
  return { used: used?.n ?? 0, limit: subscription?.battery_limit ?? null };
}

/**
 * Onboard a battery.
 *
 * The serial is unique platform-wide rather than per tenant, deliberately: a
 * pack is a physical object that can be sold on or moved between fleets, and
 * two companies each holding a record for serial `BAT-00042` would make its
 * history impossible to follow across that move.
 */
export function registerBattery(
  store: Store,
  principal: Principal,
  input: NewBattery,
  now = Date.now()
): string {
  if (!canManageUsers(principal, input.companyId)) {
    throw new AdminError('Not permitted to register batteries for that company', 'forbidden');
  }

  const serial = input.serial.trim();
  if (store.get('SELECT id FROM batteries WHERE serial = ?', serial)) {
    throw new AdminError('That battery serial is already registered', 'email_taken');
  }

  // No battery cap either, for the same reason as seats. `batteryUsage`
  // remains a count for the dashboard.

  const id = randomUUID();
  store.run(
    `INSERT INTO batteries
     (id, company_id, serial, chemistry, cell_count, capacity_ah, bms_model, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.companyId,
    serial,
    input.chemistry,
    input.cellCount,
    input.capacityAh ?? null,
    input.bmsModel,
    now
  );
  return id;
}

/**
 * Revocation and quarantine (PRD §8.1). The app refuses to talk to a device
 * that is not `valid`, so this is how a suspect gateway is taken out of service.
 */
export function setDeviceSecurityStatus(
  store: Store,
  principal: Principal,
  deviceId: string,
  status: 'valid' | 'revoked' | 'quarantined'
): void {
  const device = store.get<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM devices WHERE id = ?',
    deviceId
  );
  if (!device) throw new AdminError('Device not found', 'not_found');
  if (!canManageUsers(principal, device.company_id)) {
    throw new AdminError('Device not found', 'not_found');
  }
  store.run('UPDATE devices SET security_status = ? WHERE id = ?', status, deviceId);
}

export function listDevices(store: Store, principal: Principal) {
  const q = tenantQuery(principal, 'devices', { orderBy: 'serial ASC' });
  return store.all(q.sql, ...q.params);
}

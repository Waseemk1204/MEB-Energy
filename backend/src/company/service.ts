import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { canManageUsers, isRole, tenantQuery, type Principal, type Role } from '../db/tenancy.js';
import { hashPassword } from '../auth/password.js';
import { NO_PASSWORD, createInvitation } from '../auth/invitations.js';
import { revokeAllForUser } from '../auth/tokens.js';
import { DEFAULT_PERMISSIONS, type PermissionPatch } from '../auth/permissions.js';

/**
 * The company, its people, its packs and its gateways (PRD §6.4, §6.5, §7.6,
 * §7.8).
 *
 * The rules that matter here are the ones that decide who may change whom:
 * an administrator manages the company, a technician manages nothing. Every
 * one of them is checked here rather than at the route, so a second caller of
 * these functions cannot skip them.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'forbidden'
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

/* --------------------------------------------------------------- company */

export interface CompanyRow {
  id: string;
  name: string;
  created_at: number;
}

/** The company this principal belongs to. */
export async function companyOf(store: Store, principal: Principal): Promise<CompanyRow> {
  const row = await store.get<CompanyRow>(
    'SELECT id, name, created_at FROM companies WHERE id = ?',
    principal.companyId
  );
  if (!row) throw new AdminError('Company not found', 'not_found');
  return row;
}

/**
 * Rename the company. The name is the one thing about the company that is
 * the company's own to decide; it appears in every header and every invitation.
 */
export async function renameCompany(store: Store, principal: Principal, name: string): Promise<CompanyRow> {
  if (!canManageUsers(principal, principal.companyId)) {
    throw new AdminError('Only an administrator may rename the company', 'forbidden');
  }
  const trimmed = name.trim();
  await store.run('UPDATE companies SET name = ? WHERE id = ?', trimmed, principal.companyId);
  return companyOf(store, principal);
}

export interface CompanyOverview {
  people: { total: number; active: number; invited: number; administrators: number };
  batteries: { total: number; inService: number; reportingWithin24Hours: number };
  gateways: { total: number; inService: number };
}

/**
 * The numbers an administrator opens the app to see.
 *
 * Counted in SQL rather than by listing and measuring in JavaScript: a fleet
 * that has grown past a page would otherwise report the size of the page.
 */
export async function companyOverview(store: Store, companyId: string, now = Date.now()): Promise<CompanyOverview> {
  const count = async (sql: string, ...params: (string | number)[]): Promise<number> =>
    (await store.get<{ n: number }>(sql, ...params))?.n ?? 0;

  return {
    people: {
      total: await count('SELECT COUNT(*) AS n FROM users WHERE company_id = ?', companyId),
      active: await count("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND status = 'active'", companyId),
      invited: await count("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND status = 'invited'", companyId),
      administrators: await count(
        "SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'company' AND status = 'active'",
        companyId
      ),
    },
    batteries: {
      total: await count('SELECT COUNT(*) AS n FROM batteries WHERE company_id = ?', companyId),
      inService: await count(
        "SELECT COUNT(*) AS n FROM batteries WHERE company_id = ? AND status = 'active'",
        companyId
      ),
      // "Connected" is not a state a pack holds; it is a recent reading.
      reportingWithin24Hours: await count(
        `SELECT COUNT(DISTINCT battery_id) AS n FROM telemetry_readings
         WHERE company_id = ? AND recorded_at > ?`,
        companyId,
        now - 24 * 60 * 60 * 1000
      ),
    },
    gateways: {
      total: await count('SELECT COUNT(*) AS n FROM devices WHERE company_id = ?', companyId),
      inService: await count(
        "SELECT COUNT(*) AS n FROM devices WHERE company_id = ? AND security_status = 'valid'",
        companyId
      ),
    },
  };
}

/* ------------------------------------------------------------------ users */

export interface NewUser {
  companyId: string;
  email: string;
  displayName: string;
  role: Role;
  /**
   * What this person may do. Anything omitted takes the default: they can
   * read, see location and see health, and they cannot write. Ignored for an
   * administrator, who holds every permission implicitly.
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

export async function createUser(
  store: Store,
  principal: Principal,
  input: NewUser,
  now = Date.now()
): Promise<CreatedUser> {
  if (!isRole(input.role)) {
    throw new AdminError(`'${String(input.role)}' is not a role`, 'invalid_role');
  }
  if (!input.companyId) {
    throw new AdminError(`Role '${input.role}' must belong to the company`, 'invalid_role');
  }
  // Only an administrator creates accounts, and only inside their own company.
  if (!canManageUsers(principal, input.companyId)) {
    throw new AdminError('Not permitted to create users in that company', 'forbidden');
  }

  // There is no seat cap. How many people a company has is the company's own
  // business.
  const perms = { ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) };

  const email = input.email.trim().toLowerCase();
  if (await store.get('SELECT id FROM users WHERE email = ?', email)) {
    throw new AdminError('That email address is already in use', 'email_taken');
  }

  const id = randomUUID();
  const byInvitation = input.password === undefined;

  // An invited account carries a placeholder that is not a valid scrypt hash.
  // `verifyPassword` fails closed on a malformed hash, so it cannot be signed
  // into even if the status check were somehow bypassed — two independent
  // reasons for the same refusal.
  const passwordHash = byInvitation ? NO_PASSWORD : await hashPassword(input.password!);

  return await store.transaction(async () => {
    await store.run(
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

    const invitation = await createInvitation(store, id, principal.userId, now);
    return { id, invitation: { token: invitation.token, expiresAt: invitation.expiresAt } };
  });
}

interface UserRow {
  id: string;
  company_id: string;
  email: string;
  display_name: string;
  role: Role;
  status: string;
  password_hash?: string;
}

/**
 * The users this principal can see.
 *
 * Permissions come back with the row. The screen that lists people is the
 * screen that shows what they may do, and a second round trip per user to find
 * out would make a list of twenty into twenty-one requests.
 */
export async function listUsers(store: Store, principal: Principal): Promise<UserRow[]> {
  const q = tenantQuery(principal, 'users', {
    columns:
      'id, company_id, email, display_name, role, status, created_at, ' +
      'can_read, can_write, can_location, can_health',
    orderBy: 'email ASC',
  });
  return await store.all<UserRow>(q.sql, ...q.params);
}

/**
 * The user this principal is allowed to act on, or null.
 *
 * One rule, used by everything that reaches for somebody else's account. Only
 * an administrator manages people, and only inside their company — "not
 * yours" and "not there" are the same answer on purpose, so the endpoint
 * cannot be used to discover who exists.
 */
export async function visibleUser(store: Store, principal: Principal, userId: string): Promise<UserRow | null> {
  const target = await store.get<UserRow>(
    'SELECT id, company_id, email, display_name, role, status, password_hash FROM users WHERE id = ?',
    userId
  );
  if (!target) return null;
  return canManageUsers(principal, target.company_id) ? target : null;
}

export interface UserPatch {
  displayName?: string;
  email?: string;
}

/** Edit who somebody is. What they may do is `setPermissions`. */
export async function updateUser(
  store: Store,
  principal: Principal,
  userId: string,
  patch: UserPatch
): Promise<void> {
  const target = await visibleUser(store, principal, userId);
  if (!target) throw new AdminError('User not found', 'not_found');

  const sets: string[] = [];
  const params: string[] = [];

  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(patch.displayName.trim());
  }
  if (patch.email !== undefined) {
    const email = patch.email.trim().toLowerCase();
    const clash = await store.get<{ id: string }>(
      'SELECT id FROM users WHERE email = ? AND id <> ?',
      email,
      userId
    );
    if (clash) throw new AdminError('That email address is already in use', 'email_taken');
    sets.push('email = ?');
    params.push(email);
  }
  if (sets.length === 0) return;

  await store.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, userId);
}

/**
 * Deactivation revokes every refresh token for the account.
 *
 * Without that, a suspended user keeps working until their refresh token
 * expires — up to a fortnight of access after being told they no longer have
 * any. Deactivation has to mean it immediately.
 */
export async function setUserStatus(
  store: Store,
  principal: Principal,
  userId: string,
  status: 'active' | 'suspended',
  now = Date.now()
): Promise<void> {
  const target = await visibleUser(store, principal, userId);
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

  if (target.role === 'company' && status === 'suspended') {
    const others = await store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users
       WHERE company_id = ? AND role = 'company' AND status = 'active' AND id <> ?`,
      target.company_id,
      userId
    );
    // Locking every administrator out of the company is not a state anyone
    // can recover from through the product.
    if ((others?.n ?? 0) === 0) {
      throw new AdminError('Cannot suspend the last active administrator', 'last_admin');
    }
  }

  await store.run('UPDATE users SET status = ? WHERE id = ?', status, userId);
  if (status === 'suspended') await revokeAllForUser(store, userId, now);
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
export async function removeUser(
  store: Store,
  principal: Principal,
  userId: string,
  now = Date.now()
): Promise<{ removed: boolean; reason?: 'has_history' }> {
  const target = await visibleUser(store, principal, userId);
  if (!target) throw new AdminError('User not found', 'not_found');

  if (target.id === principal.userId) {
    throw new AdminError('You cannot remove your own account', 'forbidden');
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
  const referencedBy = async (sql: string) => ((await store.get<{ n: number }>(sql, userId))?.n ?? 0) > 0;

  // Each awaited in turn rather than `||`-chained: a promise is always
  // truthy, and the chain would have called everyone "history".
  let isHistory = false;
  for (const sql of [
    'SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id = ?',
    'SELECT COUNT(*) AS n FROM commands WHERE issued_by = ?',
    'SELECT COUNT(*) AS n FROM support_sessions WHERE admin_user_id = ?',
    'SELECT COUNT(*) AS n FROM support_sessions WHERE target_user_id = ?',
    'SELECT COUNT(*) AS n FROM user_invitations WHERE invited_by = ?',
  ]) {
    if (await referencedBy(sql)) {
      isHistory = true;
      break;
    }
  }

  if (isHistory) {
    await setUserStatus(store, principal, userId, 'suspended', now);
    return { removed: false, reason: 'has_history' };
  }

  await store.transaction(async () => {
    // Deleted, not revoked: the account is going, and a revoked row would
    // still hold a foreign key against it.
    await store.run('DELETE FROM refresh_tokens WHERE user_id = ?', userId);
    await store.run('DELETE FROM ble_sessions WHERE user_id = ?', userId);
    await store.run('DELETE FROM user_invitations WHERE user_id = ?', userId);
    await store.run('DELETE FROM users WHERE id = ?', userId);
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

export async function registerDevice(
  store: Store,
  principal: Principal,
  input: NewDevice,
  now = Date.now()
): Promise<string> {
  if (!canManageUsers(principal, input.companyId)) {
    throw new AdminError('Not permitted to register devices for that company', 'forbidden');
  }
  const serial = input.serial.trim();
  if (await store.get('SELECT id FROM devices WHERE serial = ?', serial)) {
    throw new AdminError('That device serial is already registered', 'email_taken');
  }

  // A gateway is assigned to one of the company's own packs or to none. An id
  // from elsewhere is simply not a pack, so the same answer as a typo.
  if (input.assignedBatteryId) {
    const pack = await store.get<{ company_id: string }>(
      'SELECT company_id FROM batteries WHERE id = ?',
      input.assignedBatteryId
    );
    if (!pack || pack.company_id !== input.companyId) {
      throw new AdminError('Battery not found', 'not_found');
    }
  }

  // No gateway cap. How much hardware a company runs is the company's own
  // business.
  const id = randomUUID();
  await store.run(
    `INSERT INTO devices
     (id, company_id, serial, hardware_revision, firmware_version, assigned_battery_id, security_status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.companyId,
    serial,
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

/**
 * Onboard a battery.
 *
 * The serial is unique across the database, deliberately: a pack is a physical
 * object, and two records for serial `BAT-00042` would make its history
 * impossible to follow.
 */
export async function registerBattery(
  store: Store,
  principal: Principal,
  input: NewBattery,
  now = Date.now()
): Promise<string> {
  if (!canManageUsers(principal, input.companyId)) {
    throw new AdminError('Not permitted to register batteries for that company', 'forbidden');
  }

  const serial = input.serial.trim();
  if (await store.get('SELECT id FROM batteries WHERE serial = ?', serial)) {
    throw new AdminError('That battery serial is already registered', 'email_taken');
  }

  // No battery cap, for the same reason as people and gateways.
  const id = randomUUID();
  await store.run(
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
export async function setDeviceSecurityStatus(
  store: Store,
  principal: Principal,
  deviceId: string,
  status: 'valid' | 'revoked' | 'quarantined'
): Promise<void> {
  const device = await store.get<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM devices WHERE id = ?',
    deviceId
  );
  if (!device || !canManageUsers(principal, device.company_id)) {
    throw new AdminError('Device not found', 'not_found');
  }
  await store.run('UPDATE devices SET security_status = ? WHERE id = ?', status, deviceId);
}

export async function listDevices(store: Store, principal: Principal) {
  const q = tenantQuery(principal, 'devices', { orderBy: 'serial ASC' });
  return await store.all(q.sql, ...q.params);
}

/* ------------------------------------------------------ editing batteries */

export interface BatteryPatch {
  serial?: string;
  chemistry?: string;
  cellCount?: number;
  nominalVoltage?: number | null;
  capacityAh?: number | null;
  ratedCurrentA?: number | null;
  bmsManufacturer?: string | null;
  bmsModel?: string | null;
  bmsFirmware?: string | null;
}

/**
 * The battery this principal may edit, or not-found.
 *
 * Only an administrator edits packs, and "not yours" is the same answer as
 * "not there" so the route cannot be used to discover serials.
 */
async function ownedBattery(
  store: Store,
  principal: Principal,
  batteryId: string
): Promise<{ id: string; company_id: string }> {
  const row = await store.get<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM batteries WHERE id = ?',
    batteryId
  );
  if (!row || !canManageUsers(principal, row.company_id)) {
    throw new AdminError('Battery not found', 'not_found');
  }
  return row;
}

const BATTERY_COLUMN: Record<keyof BatteryPatch, string> = {
  serial: 'serial',
  chemistry: 'chemistry',
  cellCount: 'cell_count',
  nominalVoltage: 'nominal_voltage',
  capacityAh: 'capacity_ah',
  ratedCurrentA: 'rated_current_a',
  bmsManufacturer: 'bms_manufacturer',
  bmsModel: 'bms_model',
  bmsFirmware: 'bms_firmware',
};

export async function updateBattery(
  store: Store,
  principal: Principal,
  batteryId: string,
  patch: BatteryPatch
): Promise<void> {
  await ownedBattery(store, principal, batteryId);

  if (patch.serial !== undefined) {
    const serial = patch.serial.trim();
    const clash = await store.get<{ id: string }>('SELECT id FROM batteries WHERE serial = ? AND id <> ?', serial, batteryId);
    if (clash) throw new AdminError('That battery serial is already registered', 'email_taken');
    patch = { ...patch, serial };
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const key of Object.keys(BATTERY_COLUMN) as (keyof BatteryPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${BATTERY_COLUMN[key]} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return;

  await store.run(`UPDATE batteries SET ${sets.join(', ')} WHERE id = ?`, ...params, batteryId);
}

/**
 * Take a pack out of service.
 *
 * It leaves the technician's list and stays in the record, because the audit
 * ledger references it by id and a ledger entry pointing at nothing is a
 * ledger with a hole in it. Any live BLE session on it is ended.
 */
export async function retireBattery(
  store: Store,
  principal: Principal,
  batteryId: string,
  now = Date.now()
): Promise<void> {
  await ownedBattery(store, principal, batteryId);
  await store.transaction(async () => {
    await store.run("UPDATE batteries SET status = 'retired' WHERE id = ?", batteryId);
    await store.run(
      'UPDATE ble_sessions SET ended_at = ? WHERE battery_id = ? AND ended_at IS NULL',
      now,
      batteryId
    );
  });
}

export async function reinstateBattery(store: Store, principal: Principal, batteryId: string): Promise<void> {
  await ownedBattery(store, principal, batteryId);
  await store.run("UPDATE batteries SET status = 'active' WHERE id = ?", batteryId);
}

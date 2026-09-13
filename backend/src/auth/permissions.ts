import type { Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';
import { forbidden } from '../http/errors.js';

/**
 * What a person may do inside their company.
 *
 * Distinct from their role. The role decides which tenant's rows they can
 * reach at all — that boundary is enforced in SQL and is not negotiable. These
 * decide what they may do with the rows they can already see, and the company
 * owner sets them per user.
 *
 * **Read from the database on every request, never carried in the token.**
 * That is deliberate and it costs a query. An access token lives fifteen
 * minutes; if permissions rode inside it, revoking write from somebody would
 * leave them able to write for up to fifteen minutes more. Revocation that
 * takes effect "soon" is not revocation, and the person you are revoking is
 * usually the person you most want stopped now.
 *
 * The company's administrator has every permission implicitly. They are the
 * one who grants and removes them, and nobody sits above them to do the same
 * for them, so there is nothing for a flag to express.
 */

export interface Permissions {
  read: boolean;
  write: boolean;
  location: boolean;
  health: boolean;
}

export type PermissionName = keyof Permissions;

/** What a user gets when nobody has said otherwise. */
export const DEFAULT_PERMISSIONS: Permissions = {
  read: true,
  write: false,
  location: true,
  health: true,
};

const ADMINISTRATOR_PERMISSIONS: Permissions = {
  read: true,
  write: true,
  location: true,
  health: true,
};

interface PermissionRow {
  can_read: number;
  can_write: number;
  can_location: number;
  can_health: number;
  status: string;
}

/**
 * The live permissions for a principal.
 *
 * A suspended account has none, whatever its columns say. Suspension already
 * revokes sessions, but a token issued moments before must not outlive it.
 */
export async function permissionsOf(store: Store, principal: Principal): Promise<Permissions> {
  if (principal.role === 'company') return ADMINISTRATOR_PERMISSIONS;

  const row = await store.get<PermissionRow>(
    'SELECT can_read, can_write, can_location, can_health, status FROM users WHERE id = ?',
    principal.userId
  );

  // No row means the account was removed between issuing the token and using
  // it. Nothing is the only safe answer.
  if (!row || row.status !== 'active') {
    return { read: false, write: false, location: false, health: false };
  }

  return {
    read: row.can_read === 1,
    write: row.can_write === 1,
    location: row.can_location === 1,
    health: row.can_health === 1,
  };
}

const REFUSAL: Record<PermissionName, string> = {
  read: 'You do not have permission to read this battery. Ask your company administrator.',
  write: 'You do not have permission to change parameters. Ask your company administrator.',
  location: 'You do not have permission to see battery locations. Ask your company administrator.',
  health: 'You do not have permission to see battery health history. Ask your company administrator.',
};

/**
 * Refuse unless the principal holds the permission.
 *
 * The message names the permission and who can grant it, because "forbidden"
 * on its own sends somebody to the wrong person.
 */
export async function requirePermission(
  store: Store,
  principal: Principal,
  name: PermissionName
): Promise<void> {
  if (!(await permissionsOf(store, principal))[name]) throw forbidden(REFUSAL[name]);
}

/** The columns, for writing. Undefined fields are left as they are. */
export interface PermissionPatch {
  read?: boolean;
  write?: boolean;
  location?: boolean;
  health?: boolean;
}

const COLUMN: Record<PermissionName, string> = {
  read: 'can_read',
  write: 'can_write',
  location: 'can_location',
  health: 'can_health',
};

export async function setPermissions(store: Store, userId: string, patch: PermissionPatch): Promise<void> {
  const sets: string[] = [];
  const params: number[] = [];

  for (const name of Object.keys(COLUMN) as PermissionName[]) {
    const value = patch[name];
    if (value === undefined) continue;
    sets.push(`${COLUMN[name]} = ?`);
    params.push(value ? 1 : 0);
  }
  if (sets.length === 0) return;

  await store.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, userId);
}

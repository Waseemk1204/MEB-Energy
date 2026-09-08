import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';

/**
 * The first administrator.
 *
 * A fresh database has no users, and every route that could create one already
 * requires an administrator — so without this a deployment is unreachable by
 * design. The escape is deliberately narrow:
 *
 * · It only fires when the users table is **completely empty**. Once anyone
 *   exists, the environment can no longer mint an account; that closes the
 *   obvious abuse, where someone who can set an env var grants themselves
 *   admin on a live system.
 * · It never rotates an existing password, for the same reason.
 * · It refuses a weak password rather than accepting one, because the first
 *   account is the one that can create all the others.
 */

/** Long enough that it was not typed twice from memory. */
export const MIN_BOOTSTRAP_PASSWORD = 12;

export type BootstrapOutcome =
  | { kind: 'created'; userId: string; email: string }
  | { kind: 'skipped'; reason: 'users_exist' | 'not_configured' };

export class BootstrapError extends Error {}

export async function bootstrapAdmin(
  store: Store,
  env: { email?: string; password?: string }
): Promise<BootstrapOutcome> {
  const existing = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  if ((existing?.n ?? 0) > 0) return { kind: 'skipped', reason: 'users_exist' };

  const email = env.email?.trim().toLowerCase();
  const password = env.password;
  if (!email || !password) return { kind: 'skipped', reason: 'not_configured' };

  if (!email.includes('@')) {
    throw new BootstrapError('BOOTSTRAP_ADMIN_EMAIL is not an email address');
  }
  if (password.length < MIN_BOOTSTRAP_PASSWORD) {
    throw new BootstrapError(
      `BOOTSTRAP_ADMIN_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD} characters`
    );
  }

  const id = randomUUID();
  store.run(
    `INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    // An administrator is platform-wide and belongs to no tenant; the users
    // table has a CHECK constraint that enforces exactly this.
    null,
    email,
    'Platform administrator',
    'admin',
    await hashPassword(password),
    'active',
    Date.now()
  );

  return { kind: 'created', userId: id, email };
}

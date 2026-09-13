import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';

/**
 * The company, and its first administrator.
 *
 * A fresh database has no company and no users, and every route that could
 * create a user already requires an administrator — so without this a
 * deployment is unreachable by design. The escape is deliberately narrow:
 *
 * · It only fires when the users table is **completely empty**. Once anyone
 *   exists, the environment can no longer mint an account; that closes the
 *   obvious abuse, where someone who can set an env var grants themselves
 *   administrator on a live system.
 * · It never rotates an existing password, for the same reason.
 * · It refuses a weak password rather than accepting one, because the first
 *   account is the one that can create all the others.
 *
 * The company row is created alongside, named from the environment. If a
 * company already exists — a database that was emptied of users but not of
 * everything — the administrator joins it rather than a second one being
 * made: there is exactly one company, and two rows would be a question nobody
 * wants to answer when a technician cannot sign in.
 */

/** Long enough that it was not typed twice from memory. */
export const MIN_BOOTSTRAP_PASSWORD = 12;

/** What the company is called until somebody renames it. */
export const DEFAULT_COMPANY_NAME = 'MEB Energy';

export type BootstrapOutcome =
  | { kind: 'created'; userId: string; email: string; companyId: string; companyName: string }
  | { kind: 'skipped'; reason: 'users_exist' | 'not_configured' };

export class BootstrapError extends Error {}

export async function bootstrapCompany(
  store: Store,
  env: { companyName?: string; email?: string; password?: string },
  now = Date.now()
): Promise<BootstrapOutcome> {
  const existing = await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
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

  const companyName = env.companyName?.trim() || DEFAULT_COMPANY_NAME;
  const passwordHash = await hashPassword(password);

  return await store.transaction(async () => {
    const company =
      await store.get<{ id: string; name: string }>(
        'SELECT id, name FROM companies ORDER BY created_at ASC LIMIT 1'
      ) ?? null;

    const companyId = company?.id ?? randomUUID();
    if (!company) {
      await store.run(
        'INSERT INTO companies (id, name, status, created_at) VALUES (?,?,?,?)',
        companyId,
        companyName,
        'active',
        now
      );
    }

    const id = randomUUID();
    await store.run(
      `INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      companyId,
      email,
      'Administrator',
      'company',
      passwordHash,
      'active',
      now
    );

    return {
      kind: 'created',
      userId: id,
      email,
      companyId,
      companyName: company?.name ?? companyName,
    };
  });
}

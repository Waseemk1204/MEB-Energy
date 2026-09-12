import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';

/**
 * A database from before this was one company's application.
 *
 * Its `users` table admits a tenantless `admin` row — the schema is applied
 * with IF NOT EXISTS, so an old table keeps its old CHECK — and such a row
 * may still be in it. Two things must hold: startup suspends it, and even if
 * somebody reactivates it by hand, sign-in refuses a role the application no
 * longer knows.
 */

const SECRET = secretFrom('a-legacy-admin-test-signing-secret!!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

// The users table exactly as the platform era created it.
const OLD_USERS = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','company','user')),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  CHECK ((role = 'admin' AND company_id IS NULL) OR (role <> 'admin' AND company_id IS NOT NULL))
);`;

let dir: string;
let store: Store;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-admin-'));
  const file = join(dir, 'old.db');
  const hash = await hashPassword(PASSWORD, CHEAP);

  const old = new DatabaseSync(file);
  old.exec(OLD_USERS);
  old
    .prepare(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run('u-platform', null, 'ops@platform.example', 'Platform', 'admin', hash, 'active', Date.now());
  old.close();

  store = createStore(file);
  app = buildServer({
    store,
    secret: SECRET,
    dispatcher: { send: async ({ value }) => ({ result: 'success', readBack: value }) },
    loginLimiter: createLimiter(50, 60_000),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = () =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'ops@platform.example', password: PASSWORD },
  });

describe('a platform administrator left in an old database', () => {
  it('is suspended on startup', () => {
    const row = store.get<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u-platform');
    assert.equal(row?.status, 'suspended');
  });

  it('cannot sign in', async () => {
    assert.equal((await login()).statusCode, 401);
  });

  /** Reactivated by hand, the role itself is still one the application refuses. */
  it('cannot sign in even when reactivated', async () => {
    store.run("UPDATE users SET status = 'active' WHERE id = ?", 'u-platform');
    const res = await login();
    assert.equal(res.statusCode, 401);
    // The same message as a wrong password: nothing to enumerate.
    assert.match(res.json().message, /Email or password is incorrect/);
  });
});

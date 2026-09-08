import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { verifyPassword } from '../auth/password.js';
import { BootstrapError, bootstrapAdmin } from './bootstrap.js';

let store: Store;
const GOOD = { email: 'ops@knowyourev.example', password: 'first-admin-passphrase' };

beforeEach(() => {
  store = createStore();
});
afterEach(() => store.close());

const users = () => store.all<{ id: string; email: string; role: string }>('SELECT * FROM users');

describe('the first administrator', () => {
  it('is created on an empty database', async () => {
    const outcome = await bootstrapAdmin(store, GOOD);
    assert.equal(outcome.kind, 'created');
    assert.equal(users().length, 1);
    assert.equal(users()[0]!.role, 'admin');
  });

  it('belongs to no company, as an administrator must', async () => {
    await bootstrapAdmin(store, GOOD);
    const row = store.get<{ company_id: string | null }>('SELECT company_id FROM users');
    assert.equal(row?.company_id, null);
  });

  it('can actually sign in with the configured password', async () => {
    await bootstrapAdmin(store, GOOD);
    const row = store.get<{ password_hash: string }>('SELECT password_hash FROM users');
    assert.equal(await verifyPassword(GOOD.password, row!.password_hash), true);
  });

  it('stores the email lowercased, since login looks it up that way', async () => {
    await bootstrapAdmin(store, { ...GOOD, email: '  OPS@KnowYourEV.example ' });
    assert.equal(users()[0]!.email, 'ops@knowyourev.example');
  });
});

describe('what it refuses to do', () => {
  /**
   * The important one. Anyone who can set an environment variable must not be
   * able to mint themselves an admin account on a running system.
   */
  it('does nothing once any user exists', async () => {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u1', null, 'someone@x.example', 'Someone', 'admin', 'hash', 'active', Date.now()
    );
    const outcome = await bootstrapAdmin(store, { email: 'attacker@x.example', password: 'a-long-enough-password' });
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'users_exist' });
    assert.equal(users().length, 1);
    assert.equal(users()[0]!.email, 'someone@x.example');
  });

  /** Even a single ordinary technician is enough to close the window. */
  it('is closed by a non-admin user existing', async () => {
    store.run('INSERT INTO companies (id,name,status,created_at) VALUES (?,?,?,?)', 'c1', 'C', 'active', Date.now());
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u1', 'c1', 'tech@x.example', 'Tech', 'user', 'hash', 'active', Date.now()
    );
    const outcome = await bootstrapAdmin(store, GOOD);
    assert.equal(outcome.kind, 'skipped');
    assert.equal(users().length, 1);
  });

  it('skips quietly when nothing is configured', async () => {
    assert.deepEqual(await bootstrapAdmin(store, {}), { kind: 'skipped', reason: 'not_configured' });
  });

  it('refuses a short password rather than accepting one', async () => {
    await assert.rejects(
      () => bootstrapAdmin(store, { ...GOOD, password: 'short' }),
      BootstrapError
    );
    assert.equal(users().length, 0);
  });

  it('refuses something that is not an email address', async () => {
    await assert.rejects(() => bootstrapAdmin(store, { ...GOOD, email: 'admin' }), BootstrapError);
    assert.equal(users().length, 0);
  });
});

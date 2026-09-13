import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../db/client.js';
import { verifyPassword } from '../auth/password.js';
import { BootstrapError, DEFAULT_COMPANY_NAME, bootstrapCompany } from './bootstrap.js';
import { createTestStore } from '../db/testFixtures.js';

let store: Store;
const GOOD = { email: 'ops@mebenergy.example', password: 'first-admin-passphrase' };

beforeEach(async () => {
  store = await createTestStore();
});
afterEach(() => store.close());

const users = async () =>
  await store.all<{ id: string; email: string; role: string; company_id: string }>('SELECT * FROM users');
const companies = async () => await store.all<{ id: string; name: string }>('SELECT * FROM companies');

describe('the company and its first administrator', () => {
  it('are created together on an empty database', async () => {
    const outcome = await bootstrapCompany(store, GOOD);
    assert.equal(outcome.kind, 'created');
    assert.equal((await users()).length, 1);
    assert.equal((await users())[0]!.role, 'company');
    assert.equal((await companies()).length, 1);
  });

  it('puts the administrator inside the company', async () => {
    await bootstrapCompany(store, GOOD);
    assert.equal((await users())[0]!.company_id, (await companies())[0]!.id);
  });

  it('names the company from the environment', async () => {
    const outcome = await bootstrapCompany(store, { ...GOOD, companyName: 'Northern Haulage' });
    assert.equal(outcome.kind === 'created' && outcome.companyName, 'Northern Haulage');
    assert.equal((await companies())[0]!.name, 'Northern Haulage');
  });

  it('falls back to the default name when none is configured', async () => {
    await bootstrapCompany(store, GOOD);
    assert.equal((await companies())[0]!.name, DEFAULT_COMPANY_NAME);
  });

  /**
   * One company, always. A database that lost its users but not its company
   * row gets its administrator back inside the existing company rather than
   * a second company appearing beside it.
   */
  it('joins an existing company rather than creating a second one', async () => {
    await store.run(
      'INSERT INTO companies (id,name,status,created_at) VALUES (?,?,?,?)',
      'c-existing',
      'Already Here',
      'active',
      1
    );
    const outcome = await bootstrapCompany(store, { ...GOOD, companyName: 'Ignored' });
    assert.equal(outcome.kind, 'created');
    assert.equal((await companies()).length, 1);
    assert.equal((await users())[0]!.company_id, 'c-existing');
    assert.equal(outcome.kind === 'created' && outcome.companyName, 'Already Here');
  });

  it('can actually sign in with the configured password', async () => {
    await bootstrapCompany(store, GOOD);
    const row = await store.get<{ password_hash: string }>('SELECT password_hash FROM users');
    assert.equal(await verifyPassword(GOOD.password, row!.password_hash), true);
  });

  it('stores the email lowercased, since login looks it up that way', async () => {
    await bootstrapCompany(store, { ...GOOD, email: '  OPS@MEBEnergy.example ' });
    assert.equal((await users())[0]!.email, 'ops@mebenergy.example');
  });
});

describe('what it refuses to do', () => {
  /**
   * The important one. Anyone who can set an environment variable must not be
   * able to mint themselves an administrator account on a running system.
   */
  it('does nothing once any user exists', async () => {
    await store.run('INSERT INTO companies (id,name,status,created_at) VALUES (?,?,?,?)', 'c1', 'C', 'active', Date.now());
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u1', 'c1', 'someone@x.example', 'Someone', 'company', 'hash', 'active', Date.now()
    );
    const outcome = await bootstrapCompany(store, { email: 'attacker@x.example', password: 'a-long-enough-password' });
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'users_exist' });
    assert.equal((await users()).length, 1);
    assert.equal((await users())[0]!.email, 'someone@x.example');
  });

  /** Even a single ordinary technician is enough to close the window. */
  it('is closed by a technician existing', async () => {
    await store.run('INSERT INTO companies (id,name,status,created_at) VALUES (?,?,?,?)', 'c1', 'C', 'active', Date.now());
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u1', 'c1', 'tech@x.example', 'Tech', 'user', 'hash', 'active', Date.now()
    );
    const outcome = await bootstrapCompany(store, GOOD);
    assert.equal(outcome.kind, 'skipped');
    assert.equal((await users()).length, 1);
  });

  it('skips quietly when nothing is configured', async () => {
    assert.deepEqual(await bootstrapCompany(store, {}), { kind: 'skipped', reason: 'not_configured' });
    assert.equal((await companies()).length, 0);
  });

  it('refuses a short password rather than accepting one', async () => {
    await assert.rejects(
      async () => await bootstrapCompany(store, { ...GOOD, password: 'short' }),
      BootstrapError
    );
    assert.equal((await users()).length, 0);
    assert.equal((await companies()).length, 0);
  });

  it('refuses something that is not an email address', async () => {
    await assert.rejects(async () => await bootstrapCompany(store, { ...GOOD, email: 'admin' }), BootstrapError);
    assert.equal((await users()).length, 0);
  });
});

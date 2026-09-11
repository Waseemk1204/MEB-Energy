import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';
import { issueRefreshToken, rotateRefreshToken } from '../auth/tokens.js';
import {
  AdminError,
  createCompany,
  createUser,
  listDevices,
  listUsers,
  registerDevice,
  seatUsage,
  deviceUsage,
  setDeviceSecurityStatus,
  setUserStatus,
} from './service.js';
import { DEFAULT_DEVICE_LIMIT } from './entitlement.js';
import { seedCompany } from '../db/testFixtures.js';

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';

const admin: Principal = { userId: 'u-admin', role: 'admin', companyId: null };
const acmeOwner: Principal = { userId: 'u-acme-owner', role: 'company', companyId: ACME };
const acmeField: Principal = { userId: 'u-acme-field', role: 'user', companyId: ACME };
const rivalOwner: Principal = { userId: 'u-rival-owner', role: 'company', companyId: RIVAL };

const newUser = (over: Partial<Parameters<typeof createUser>[2]> = {}) => ({
  companyId: ACME,
  email: `new-${Math.random().toString(36).slice(2)}@acme.example`,
  displayName: 'New Person',
  role: 'user' as const,
  password: 'a-perfectly-fine-password',
  ...over,
});

const codeOf = async (fn: () => unknown): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof AdminError ? e.code : `unexpected:${(e as Error).name}`;
  }
};

beforeEach(() => {
  store = createStore();
  const now = Date.now();

  for (const [id, name, seats] of [
    [ACME, 'Acme EV', 3],
    [RIVAL, 'Rival Fleet', 10],
  ] as const) {
    seedCompany(store, id, name, { seatLimit: seats }, now);
  }

  const insert = (id: string, company: string | null, email: string, role: string) =>
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, 'x', 'active', now
    );
  insert('u-admin', null, 'admin@knowyourev.example', 'admin');
  insert('u-acme-owner', ACME, 'owner@acme.example', 'company');
  insert('u-acme-field', ACME, 'field@acme.example', 'user');
  insert('u-rival-owner', RIVAL, 'owner@rival.example', 'company');
});

afterEach(() => store.close());

describe('creating companies', () => {
  it('lets an administrator create one with a subscription', () => {
    const { companyId } = createCompany(store, admin, { name: 'New Co', seatLimit: 5 });
    assert.ok(store.get('SELECT id FROM companies WHERE id = ?', companyId));
    assert.equal(seatUsage(store, companyId).limit, 5);
  });

  /**
   * A company created here and a company granted access later must end up with
   * the same gateway cap. Without this, one made from the console had none at
   * all — and its plan still displayed a limit of two, because the two readers
   * disagreed about what a null column meant.
   */
  it('gives it the same gateway cap that granting access does', () => {
    const { companyId } = createCompany(store, admin, { name: 'Capped Co', seatLimit: 5 });
    assert.equal(deviceUsage(store, companyId).limit, DEFAULT_DEVICE_LIMIT);
  });

  it('takes an explicit gateway cap over the default', () => {
    const { companyId } = createCompany(store, admin, {
      name: 'Big Co', seatLimit: 5, deviceLimit: 40,
    });
    assert.equal(deviceUsage(store, companyId).limit, 40);
  });

  /** An administrator saying "no limit" is different from not being asked. */
  it('keeps an explicit no-limit rather than substituting the default', () => {
    const { companyId } = createCompany(store, admin, {
      name: 'Open Co', seatLimit: 5, deviceLimit: null,
    });
    assert.equal(deviceUsage(store, companyId).limit, null);
  });

  /** A tenant creating a tenant would be a tenant escaping its own boundary. */
  it('refuses a company principal', () => {
    assert.throws(() => createCompany(store, acmeOwner, { name: 'Sneaky', seatLimit: 5 }), AdminError);
  });

  it('refuses a field user', () => {
    assert.throws(() => createCompany(store, acmeField, { name: 'Sneaky', seatLimit: 5 }), AdminError);
  });
});

describe('creating users', () => {
  it('lets a company create its own field user', async () => {
    const id = await createUser(store, acmeOwner, newUser());
    assert.ok(id);
  });

  it('lets an administrator create a user in any company', async () => {
    assert.ok(await createUser(store, admin, newUser({ companyId: RIVAL })));
  });

  /* --- the escalation paths --- */

  it('stops a company creating a user in another tenant', async () => {
    assert.equal(await codeOf(() => createUser(store, acmeOwner, newUser({ companyId: RIVAL }))), 'forbidden');
  });

  it('stops a company minting a platform administrator', async () => {
    assert.equal(
      await codeOf(() => createUser(store, acmeOwner, newUser({ role: 'admin', companyId: null }))),
      'forbidden'
    );
  });

  it('stops a field user creating anyone', async () => {
    assert.equal(await codeOf(() => createUser(store, acmeField, newUser())), 'forbidden');
  });

  it('refuses an administrator bound to a company', async () => {
    assert.equal(
      await codeOf(() => createUser(store, admin, newUser({ role: 'admin', companyId: ACME }))),
      'invalid_role'
    );
  });

  it('refuses a non-admin with no company', async () => {
    assert.equal(
      await codeOf(() => createUser(store, admin, newUser({ role: 'user', companyId: null }))),
      'invalid_role'
    );
  });

  it('refuses a duplicate email', async () => {
    assert.equal(
      await codeOf(() => createUser(store, acmeOwner, newUser({ email: 'field@acme.example' }))),
      'email_taken'
    );
  });

  it('normalises the email before storing it', async () => {
    const { id } = await createUser(store, acmeOwner, newUser({ email: '  MiXeD@Acme.Example ' }));
    const row = store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', id);
    assert.equal(row?.email, 'mixed@acme.example');
  });

  it('never stores the password itself', async () => {
    const { id } = await createUser(store, acmeOwner, newUser({ password: 'hunter2' }));
    const row = store.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id);
    assert.ok(!row!.password_hash.includes('hunter2'));
  });
});

/**
 * Seats are counted, not capped.
 *
 * The cap is gone deliberately: what a company pays is settled outside the
 * product, so the only commercial control is whether their access is on.
 * Counting stays because the admin dashboard reports a total.
 */
describe('counting seats', () => {
  it('counts only active users', async () => {
    assert.equal(seatUsage(store, ACME).used, 2);
    setUserStatus(store, admin, 'u-acme-field', 'suspended');
    assert.equal(seatUsage(store, ACME).used, 1);
  });

  /** The plan says three. That is now a number, not a gate. */
  it('does not refuse a user beyond the plan', async () => {
    for (let i = 0; i < 6; i += 1) {
      assert.equal(await codeOf(() => createUser(store, acmeOwner, newUser())), null);
    }
    assert.equal(seatUsage(store, ACME).used, 8);
  });

  it('still reports the plan figure, for the dashboard to show', () => {
    assert.equal(seatUsage(store, ACME).limit, 3);
  });

  /** An administrator is platform-wide and consumes no tenant's seat. */
  it('does not charge a seat for a platform administrator', async () => {
    const before = seatUsage(store, ACME).used;
    await createUser(store, admin, newUser({ role: 'admin', companyId: null }));
    assert.equal(seatUsage(store, ACME).used, before);
  });

  it('applies each company’s own limit', () => {
    assert.equal(seatUsage(store, ACME).limit, 3);
    assert.equal(seatUsage(store, RIVAL).limit, 10);
  });
});

/**
 * Without revocation a suspended user keeps working until their refresh token
 * expires — up to a fortnight after being told they no longer have access.
 */
describe('suspending a user', () => {
  it('revokes their sessions immediately', () => {
    const { token } = issueRefreshToken(store, 'u-acme-field');
    setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    assert.throws(() => rotateRefreshToken(store, token), /already been used|not recognised/);
  });

  it('leaves other users’ sessions alone', () => {
    const mine = issueRefreshToken(store, 'u-acme-field');
    const theirs = issueRefreshToken(store, 'u-acme-owner');
    setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    assert.doesNotThrow(() => rotateRefreshToken(store, theirs.token));
    assert.throws(() => rotateRefreshToken(store, mine.token));
  });

  it('does not revoke when reactivating', () => {
    setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    setUserStatus(store, acmeOwner, 'u-acme-field', 'active');
    const { token } = issueRefreshToken(store, 'u-acme-field');
    assert.doesNotThrow(() => rotateRefreshToken(store, token));
  });

  it('stops a company suspending another tenant’s user', () => {
    assert.throws(() => setUserStatus(store, rivalOwner, 'u-acme-field', 'suspended'), /not found/);
  });

  it('hides an administrator from a company principal', () => {
    assert.throws(() => setUserStatus(store, acmeOwner, 'u-admin', 'suspended'), /not found/);
  });

  /** Locking every administrator out is not recoverable through the product. */
  it('refuses to suspend the last active administrator', async () => {
    assert.equal(await codeOf(() => setUserStatus(store, admin, 'u-admin', 'suspended')), 'last_admin');
  });

  it('allows it once another administrator exists', async () => {
    await createUser(store, admin, newUser({ role: 'admin', companyId: null }));
    assert.equal(await codeOf(() => setUserStatus(store, admin, 'u-admin', 'suspended')), null);
  });
});

describe('listing users', () => {
  it('shows a company only its own', () => {
    const rows = listUsers(store, acmeOwner);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('shows an administrator everyone', () => {
    assert.equal(listUsers(store, admin).length, 4);
  });

  it('never returns password hashes', () => {
    const rows = listUsers(store, admin) as unknown as Record<string, unknown>[];
    assert.ok(rows.every((r) => !('password_hash' in r)));
  });
});

describe('devices', () => {
  const device = (over = {}) => ({
    companyId: ACME,
    serial: `KYE-${Math.random().toString(36).slice(2, 8)}`,
    hardwareRevision: 'HW 1.0',
    firmwareVersion: 'FW 1.2.4',
    ...over,
  });

  it('registers one for your own company', () => {
    assert.ok(registerDevice(store, acmeOwner, device()));
  });

  it('stops a company registering into another tenant', () => {
    assert.throws(() => registerDevice(store, acmeOwner, device({ companyId: RIVAL })), AdminError);
  });

  it('refuses a duplicate serial', () => {
    const d = device();
    registerDevice(store, acmeOwner, d);
    assert.throws(() => registerDevice(store, acmeOwner, d), AdminError);
  });

  it('starts valid', () => {
    const id = registerDevice(store, acmeOwner, device());
    const row = store.get<{ security_status: string }>('SELECT security_status FROM devices WHERE id = ?', id);
    assert.equal(row?.security_status, 'valid');
  });

  /** The app refuses any gateway that is not `valid`, so this takes one out of service. */
  it('can be quarantined and revoked', () => {
    const id = registerDevice(store, acmeOwner, device());
    for (const status of ['quarantined', 'revoked'] as const) {
      setDeviceSecurityStatus(store, acmeOwner, id, status);
      const row = store.get<{ security_status: string }>('SELECT security_status FROM devices WHERE id = ?', id);
      assert.equal(row?.security_status, status);
    }
  });

  it('hides another tenant’s device', () => {
    const id = registerDevice(store, rivalOwner, device({ companyId: RIVAL }));
    assert.throws(() => setDeviceSecurityStatus(store, acmeOwner, id, 'revoked'), /not found/);
  });

  it('lists only your own', () => {
    registerDevice(store, acmeOwner, device());
    registerDevice(store, rivalOwner, device({ companyId: RIVAL }));
    assert.equal(listDevices(store, acmeOwner).length, 1);
    assert.equal(listDevices(store, admin).length, 2);
  });
});

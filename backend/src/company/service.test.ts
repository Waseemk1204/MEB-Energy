import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';
import { issueRefreshToken, rotateRefreshToken } from '../auth/tokens.js';
import {
  AdminError,
  companyOf,
  companyOverview,
  createUser,
  listDevices,
  listUsers,
  registerDevice,
  renameCompany,
  rotateDeviceKey,
  setDeviceSecurityStatus,
  setUserStatus,
  updateUser,
} from './service.js';
import { createTestStore, seedCompany } from '../db/testFixtures.js';

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';

/** The company's administrator: the top of the hierarchy, inside the company. */
const admin: Principal = { userId: 'u-admin', role: 'company', companyId: ACME };
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

beforeEach(async () => {
  store = await createTestStore();
  const now = Date.now();

  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    await seedCompany(store, id, name, now);
  }

  const insert = async (id: string, company: string, email: string, role: string) =>
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, 'x', 'active', now
    );
  await insert('u-admin', ACME, 'admin@acme.example', 'company');
  await insert('u-acme-owner', ACME, 'owner@acme.example', 'company');
  await insert('u-acme-field', ACME, 'field@acme.example', 'user');
  await insert('u-rival-owner', RIVAL, 'owner@rival.example', 'company');
});

afterEach(() => store.close());

describe('the company', () => {
  it('is the principal’s own', async () => {
    assert.equal((await companyOf(store, acmeOwner)).name, 'Acme EV');
    assert.equal((await companyOf(store, rivalOwner)).name, 'Rival Fleet');
  });

  it('can be renamed by an administrator', async () => {
    await renameCompany(store, acmeOwner, '  Acme Electric  ');
    assert.equal((await companyOf(store, acmeOwner)).name, 'Acme Electric');
  });

  it('cannot be renamed by a technician', async () => {
    await assert.rejects(async () => await renameCompany(store, acmeField, 'Sneaky'), AdminError);
    assert.equal((await companyOf(store, acmeOwner)).name, 'Acme EV');
  });

  it('renames only its own', async () => {
    await renameCompany(store, acmeOwner, 'Acme Electric');
    assert.equal((await companyOf(store, rivalOwner)).name, 'Rival Fleet');
  });
});

describe('the overview', () => {
  it('counts the company’s people by status and role', async () => {
    const o = await companyOverview(store, ACME);
    assert.deepEqual(o.people, { total: 3, active: 3, invited: 0, administrators: 2 });
  });

  it('counts only the company’s own', async () => {
    assert.equal((await companyOverview(store, RIVAL)).people.total, 1);
  });

  it('counts an invitation as invited, not active', async () => {
    await createUser(store, acmeOwner, newUser({ password: undefined }));
    const o = await companyOverview(store, ACME);
    assert.equal(o.people.invited, 1);
    assert.equal(o.people.active, 3);
  });

  it('counts gateways in service separately', async () => {
    const { id } = await registerDevice(store, acmeOwner, {
      companyId: ACME, serial: 'KYE-1', hardwareRevision: 'HW 1.0', firmwareVersion: 'FW 1',
    });
    await registerDevice(store, acmeOwner, {
      companyId: ACME, serial: 'KYE-2', hardwareRevision: 'HW 1.0', firmwareVersion: 'FW 1',
    });
    await setDeviceSecurityStatus(store, acmeOwner, id, 'revoked');
    assert.deepEqual((await companyOverview(store, ACME)).gateways, { total: 2, inService: 1 });
  });
});

describe('creating users', () => {
  it('lets an administrator create a technician', async () => {
    const id = await createUser(store, acmeOwner, newUser());
    assert.ok(id);
  });

  /** A second administrator, so the first is not the only one who can do anything. */
  it('lets an administrator create another administrator', async () => {
    const { id } = await createUser(store, acmeOwner, newUser({ role: 'company' }));
    const row = await store.get<{ role: string; company_id: string }>('SELECT role, company_id FROM users WHERE id = ?', id);
    assert.equal(row?.role, 'company');
    assert.equal(row?.company_id, ACME);
  });

  /* --- the escalation paths --- */

  it('stops an administrator creating a user in another company', async () => {
    assert.equal(await codeOf(async () => await createUser(store, acmeOwner, newUser({ companyId: RIVAL }))), 'forbidden');
  });

  it('stops a technician creating anyone', async () => {
    assert.equal(await codeOf(async () => await createUser(store, acmeField, newUser())), 'forbidden');
  });

  /** The platform-administrator role is gone; asking for it is not a role. */
  it('refuses the retired platform-admin role', async () => {
    assert.equal(
      await codeOf(async () => await createUser(store, acmeOwner, newUser({ role: 'admin' as never }))),
      'invalid_role'
    );
  });

  it('refuses a user with no company', async () => {
    assert.equal(
      await codeOf(async () => await createUser(store, acmeOwner, newUser({ companyId: '' }))),
      'invalid_role'
    );
  });

  it('refuses a duplicate email', async () => {
    assert.equal(
      await codeOf(async () => await createUser(store, acmeOwner, newUser({ email: 'field@acme.example' }))),
      'email_taken'
    );
  });

  it('normalises the email before storing it', async () => {
    const { id } = await createUser(store, acmeOwner, newUser({ email: '  MiXeD@Acme.Example ' }));
    const row = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', id);
    assert.equal(row?.email, 'mixed@acme.example');
  });

  it('never stores the password itself', async () => {
    const { id } = await createUser(store, acmeOwner, newUser({ password: 'hunter2' }));
    const row = await store.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id);
    assert.ok(!row!.password_hash.includes('hunter2'));
  });

  /** There is no cap. How many people the company has is its own business. */
  it('has no seat limit', async () => {
    for (let i = 0; i < 25; i += 1) {
      assert.equal(await codeOf(async () => await createUser(store, acmeOwner, newUser())), null);
    }
    assert.equal((await companyOverview(store, ACME)).people.total, 28);
  });
});

describe('editing a user', () => {
  it('changes their name', async () => {
    await updateUser(store, acmeOwner, 'u-acme-field', { displayName: '  Priya Raman ' });
    const row = await store.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', 'u-acme-field');
    assert.equal(row?.display_name, 'Priya Raman');
  });

  it('changes their email, normalised', async () => {
    await updateUser(store, acmeOwner, 'u-acme-field', { email: ' Priya@Acme.Example' });
    const row = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', 'u-acme-field');
    assert.equal(row?.email, 'priya@acme.example');
  });

  it('refuses an email somebody else already has', async () => {
    assert.equal(
      await codeOf(async () => await updateUser(store, acmeOwner, 'u-acme-field', { email: 'owner@acme.example' })),
      'email_taken'
    );
  });

  it('is refused to a technician', async () => {
    assert.equal(await codeOf(async () => await updateUser(store, acmeField, 'u-acme-owner', { displayName: 'X' })), 'not_found');
  });

  it('cannot reach another company’s people', async () => {
    assert.equal(await codeOf(async () => await updateUser(store, rivalOwner, 'u-acme-field', { displayName: 'X' })), 'not_found');
  });

  it('does nothing when asked to change nothing', async () => {
    await assert.doesNotReject(async () => await updateUser(store, acmeOwner, 'u-acme-field', {}));
  });
});

/**
 * Without revocation a suspended user keeps working until their refresh token
 * expires — up to a fortnight after being told they no longer have access.
 */
describe('suspending a user', () => {
  it('revokes their sessions immediately', async () => {
    const { token } = await issueRefreshToken(store, 'u-acme-field');
    await setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    await assert.rejects(async () => await rotateRefreshToken(store, token), /already been used|not recognised/);
  });

  it('leaves other users’ sessions alone', async () => {
    const mine = await issueRefreshToken(store, 'u-acme-field');
    const theirs = await issueRefreshToken(store, 'u-acme-owner');
    await setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    await assert.doesNotReject(async () => await rotateRefreshToken(store, theirs.token));
    await assert.rejects(async () => await rotateRefreshToken(store, mine.token));
  });

  it('does not revoke when reactivating', async () => {
    await setUserStatus(store, acmeOwner, 'u-acme-field', 'suspended');
    await setUserStatus(store, acmeOwner, 'u-acme-field', 'active');
    const { token } = await issueRefreshToken(store, 'u-acme-field');
    await assert.doesNotReject(async () => await rotateRefreshToken(store, token));
  });

  it('stops an administrator suspending another company’s user', async () => {
    await assert.rejects(async () => await setUserStatus(store, rivalOwner, 'u-acme-field', 'suspended'), /not found/);
  });

  it('is refused to a technician', async () => {
    await assert.rejects(async () => await setUserStatus(store, acmeField, 'u-acme-owner', 'suspended'), /not found/);
  });

  /** Locking every administrator out is not recoverable through the product. */
  it('refuses to suspend the last active administrator', async () => {
    await setUserStatus(store, admin, 'u-acme-owner', 'suspended');
    assert.equal(await codeOf(async () => await setUserStatus(store, admin, 'u-admin', 'suspended')), 'last_admin');
  });

  it('allows it while another administrator remains', async () => {
    assert.equal(await codeOf(async () => await setUserStatus(store, admin, 'u-acme-owner', 'suspended')), null);
  });

  /** Another company's administrators do not count towards this one's. */
  it('counts only this company’s administrators', async () => {
    assert.equal(await codeOf(async () => await setUserStatus(store, rivalOwner, 'u-rival-owner', 'suspended')), 'last_admin');
  });
});

describe('listing users', () => {
  it('shows a company only its own', async () => {
    const rows = await listUsers(store, acmeOwner);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('shows the other company only its own', async () => {
    assert.equal((await listUsers(store, rivalOwner)).length, 1);
  });

  it('never returns password hashes', async () => {
    const rows = await listUsers(store, admin) as unknown as Record<string, unknown>[];
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

  it('registers one for your own company', async () => {
    assert.ok((await registerDevice(store, acmeOwner, device())).id);
  });

  /** docs/BLE_CONTRACT.md §5 and §8: the key the gateway is provisioned with. */
  it('gives every gateway a 32-byte key and the console line to provision it', async () => {
    const d = device({ serial: 'GW-000184' });
    const registered = await registerDevice(store, acmeOwner, d);
    assert.match(registered.authKey, /^[0-9a-f]{64}$/);
    assert.equal(registered.provisioning, `provision GW-000184 ${registered.authKey}`);
    const listed = (await listDevices(store, acmeOwner)) as { serial: string; auth_key: string }[];
    assert.equal(listed.find((x) => x.serial === 'GW-000184')?.auth_key, registered.authKey);
  });

  it('gives each gateway its own key', async () => {
    const a = await registerDevice(store, acmeOwner, device());
    const b = await registerDevice(store, acmeOwner, device());
    assert.notEqual(a.authKey, b.authKey);
  });

  it('rotates a key, and the old one is gone', async () => {
    const first = await registerDevice(store, acmeOwner, device());
    const rotated = await rotateDeviceKey(store, acmeOwner, first.id);
    assert.notEqual(rotated.authKey, first.authKey);
    assert.match(rotated.provisioning, /^provision KYE-/);
    const listed = (await listDevices(store, acmeOwner)) as { id: string; auth_key: string }[];
    assert.equal(listed.find((x) => x.id === first.id)?.auth_key, rotated.authKey);
  });

  it('will not rotate another company’s key', async () => {
    const theirs = await registerDevice(store, rivalOwner, device({ companyId: RIVAL }));
    await assert.rejects(() => rotateDeviceKey(store, acmeOwner, theirs.id), /not found/);
  });

  it('stops an administrator registering into another company', async () => {
    await assert.rejects(async () => await registerDevice(store, acmeOwner, device({ companyId: RIVAL })), AdminError);
  });

  it('is refused to a technician', async () => {
    await assert.rejects(async () => await registerDevice(store, acmeField, device()), AdminError);
  });

  it('refuses a duplicate serial', async () => {
    const d = device();
    await registerDevice(store, acmeOwner, d);
    await assert.rejects(async () => await registerDevice(store, acmeOwner, d), AdminError);
  });

  /** There is no gateway cap. */
  it('has no limit', async () => {
    for (let i = 0; i < 12; i += 1) await assert.doesNotReject(async () => await registerDevice(store, acmeOwner, device()));
    assert.equal((await listDevices(store, acmeOwner)).length, 12);
  });

  it('starts valid', async () => {
    const { id } = await registerDevice(store, acmeOwner, device());
    const row = await store.get<{ security_status: string }>('SELECT security_status FROM devices WHERE id = ?', id);
    assert.equal(row?.security_status, 'valid');
  });

  it('can be assigned to one of the company’s own packs', async () => {
    await store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      'bat-1', ACME, 'BAT-1', 'LiFePO4', 24, Date.now()
    );
    const { id } = await registerDevice(store, acmeOwner, device({ assignedBatteryId: 'bat-1' }));
    const row = await store.get<{ assigned_battery_id: string }>('SELECT assigned_battery_id FROM devices WHERE id = ?', id);
    assert.equal(row?.assigned_battery_id, 'bat-1');
  });

  it('cannot be assigned to another company’s pack', async () => {
    await store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      'bat-rival', RIVAL, 'BAT-R', 'LiFePO4', 24, Date.now()
    );
    await assert.rejects(
      async () => await registerDevice(store, acmeOwner, device({ assignedBatteryId: 'bat-rival' })),
      /not found/
    );
  });

  /** The app refuses any gateway that is not `valid`, so this takes one out of service. */
  it('can be quarantined and revoked', async () => {
    const { id } = await registerDevice(store, acmeOwner, device());
    for (const status of ['quarantined', 'revoked'] as const) {
      await setDeviceSecurityStatus(store, acmeOwner, id, status);
      const row = await store.get<{ security_status: string }>('SELECT security_status FROM devices WHERE id = ?', id);
      assert.equal(row?.security_status, status);
    }
  });

  it('hides another company’s device', async () => {
    const { id } = await registerDevice(store, rivalOwner, device({ companyId: RIVAL }));
    await assert.rejects(async () => await setDeviceSecurityStatus(store, acmeOwner, id, 'revoked'), /not found/);
  });

  it('lists only your own', async () => {
    await registerDevice(store, acmeOwner, device());
    await registerDevice(store, rivalOwner, device({ companyId: RIVAL }));
    assert.equal((await listDevices(store, acmeOwner)).length, 1);
    assert.equal((await listDevices(store, rivalOwner)).length, 1);
  });
});

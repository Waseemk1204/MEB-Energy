import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../db/client.js';
import { createTestStore, seedCompany } from '../db/testFixtures.js';
import type { Principal } from '../db/tenancy.js';
import {
  DEFAULT_PERMISSIONS,
  permissionsOf,
  requirePermission,
  setPermissions,
} from './permissions.js';

/**
 * What a person may do inside their company.
 *
 * The role decides which tenant's rows they can reach, and that is enforced in
 * SQL. These decide what they may do with the rows they can already see.
 */

let store: Store;
const NOW = 1_700_000_000_000;
const ACME = 'c-acme';

const tech: Principal = { userId: 'u-tech', role: 'user', companyId: ACME };
const tech2: Principal = { userId: 'u-tech2', role: 'user', companyId: ACME };
const admin: Principal = { userId: 'u-admin', role: 'company', companyId: ACME };

const insert = async (id: string, role: string, company: string, status = 'active') =>
  await store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, company, `${id}@acme.example`, id, role, 'x', status, NOW
  );

const codeOf = async (fn: () => unknown): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

beforeEach(async () => {
  store = await createTestStore();
  await seedCompany(store, ACME, 'Acme EV', NOW);
  await insert('u-tech', 'user', ACME);
  await insert('u-tech2', 'user', ACME);
  await insert('u-admin', 'company', ACME);
});

afterEach(() => store.close());

describe('what a new account may do', () => {
  /**
   * Write is the only one off. Granting it should be a decision somebody made,
   * not something that happened because an account was created.
   */
  it('can read, see location and see health, but not write', async () => {
    assert.deepEqual(await permissionsOf(store, tech), {
      read: true,
      write: false,
      location: true,
      health: true,
    });
  });

  it('matches the documented defaults', async () => {
    assert.deepEqual(await permissionsOf(store, tech), DEFAULT_PERMISSIONS);
  });

  /** Accounts that existed before the columns did must land on the same set. */
  it('gives an account created before permissions existed the same defaults', async () => {
    await store.run('INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-legacy', ACME, 'legacy@acme.example', 'Legacy', 'user', 'x', 'active', NOW);
    assert.deepEqual(
      await permissionsOf(store, { userId: 'u-legacy', role: 'user', companyId: ACME }),
      DEFAULT_PERMISSIONS
    );
  });
});

describe('the company administrator', () => {
  /**
   * An administrator is the one who grants and removes permissions, and nobody
   * sits above them to do the same for them. A flag would have nobody to set
   * it.
   */
  it('holds every permission without carrying columns', async () => {
    assert.deepEqual(await permissionsOf(store, admin), {
      read: true, write: true, location: true, health: true,
    });
  });

  it('keeps them even if the columns say otherwise', async () => {
    await setPermissions(store, 'u-admin', { read: false, write: false, location: false, health: false });
    assert.equal((await permissionsOf(store, admin)).write, true);
  });
});

describe('changing what somebody may do', () => {
  it('grants write', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    assert.equal((await permissionsOf(store, tech)).write, true);
  });

  it('leaves the others alone when only one changes', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    assert.deepEqual(await permissionsOf(store, tech), {
      read: true, write: true, location: true, health: true,
    });
  });

  it('takes them away again', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    await setPermissions(store, 'u-tech', { write: false });
    assert.equal((await permissionsOf(store, tech)).write, false);
  });

  it('does nothing when asked to change nothing', async () => {
    await setPermissions(store, 'u-tech', {});
    assert.deepEqual(await permissionsOf(store, tech), DEFAULT_PERMISSIONS);
  });

  it('changes only the user named', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    assert.equal((await permissionsOf(store, tech2)).write, false);
  });
});

/**
 * The reason these are read from the database on every request rather than
 * carried in the access token. A token lives fifteen minutes; if permissions
 * rode inside one, this would still be true fifteen minutes after it was
 * revoked — and the person being revoked is usually the one you most want
 * stopped now.
 */
describe('revocation takes effect immediately', () => {
  it('refuses the very next check after write is taken away', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    assert.equal(await codeOf(async () => await requirePermission(store, tech, 'write')), null);

    await setPermissions(store, 'u-tech', { write: false });
    assert.equal(await codeOf(async () => await requirePermission(store, tech, 'write')), 'forbidden');
  });

  /** A suspended account has none, whatever its columns still say. */
  it('gives a suspended account nothing', async () => {
    await setPermissions(store, 'u-tech', { write: true });
    await store.run("UPDATE users SET status = 'suspended' WHERE id = ?", 'u-tech');

    assert.deepEqual(await permissionsOf(store, tech), {
      read: false, write: false, location: false, health: false,
    });
  });

  /** A token outliving its account must not outlive its permissions. */
  it('gives a deleted account nothing', async () => {
    await store.run('DELETE FROM users WHERE id = ?', 'u-tech');
    assert.equal((await permissionsOf(store, tech)).read, false);
  });
});

describe('what a refusal says', () => {
  it('names the permission and who can grant it', async () => {
    let message = '';
    try {
      await requirePermission(store, tech, 'write');
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /change parameters/);
    assert.match(message, /company administrator/);
  });

  it('does not refuse a permission the user holds', async () => {
    assert.equal(await codeOf(async () => await requirePermission(store, tech, 'read')), null);
  });
});

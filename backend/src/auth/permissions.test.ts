import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { seedCompany } from '../db/testFixtures.js';
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
const owner: Principal = { userId: 'u-owner', role: 'company', companyId: ACME };
const admin: Principal = { userId: 'u-admin', role: 'admin', companyId: null };

const insert = (id: string, role: string, company: string | null, status = 'active') =>
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, company, `${id}@acme.example`, id, role, 'x', status, NOW
  );

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

beforeEach(() => {
  store = createStore();
  seedCompany(store, ACME, 'Acme EV', {}, NOW);
  insert('u-tech', 'user', ACME);
  insert('u-owner', 'company', ACME);
  insert('u-admin', 'admin', null);
});

afterEach(() => store.close());

describe('what a new account may do', () => {
  /**
   * Write is the only one off. Granting it should be a decision somebody made,
   * not something that happened because an account was created.
   */
  it('can read, see location and see health, but not write', () => {
    assert.deepEqual(permissionsOf(store, tech), {
      read: true,
      write: false,
      location: true,
      health: true,
    });
  });

  it('matches the documented defaults', () => {
    assert.deepEqual(permissionsOf(store, tech), DEFAULT_PERMISSIONS);
  });

  /** Accounts that existed before the columns did must land on the same set. */
  it('gives an account created before permissions existed the same defaults', () => {
    store.run('INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-legacy', ACME, 'legacy@acme.example', 'Legacy', 'user', 'x', 'active', NOW);
    assert.deepEqual(
      permissionsOf(store, { userId: 'u-legacy', role: 'user', companyId: ACME }),
      DEFAULT_PERMISSIONS
    );
  });
});

describe('a platform administrator', () => {
  /**
   * An administrator sits outside every company, so there is no company owner
   * who could grant or remove anything from them. A flag would have nobody to
   * set it.
   */
  it('holds every permission without carrying columns', () => {
    assert.deepEqual(permissionsOf(store, admin), {
      read: true, write: true, location: true, health: true,
    });
  });

  it('keeps them even if the columns say otherwise', () => {
    setPermissions(store, 'u-admin', { read: false, write: false, location: false, health: false });
    assert.equal(permissionsOf(store, admin).write, true);
  });
});

describe('changing what somebody may do', () => {
  it('grants write', () => {
    setPermissions(store, 'u-tech', { write: true });
    assert.equal(permissionsOf(store, tech).write, true);
  });

  it('leaves the others alone when only one changes', () => {
    setPermissions(store, 'u-tech', { write: true });
    assert.deepEqual(permissionsOf(store, tech), {
      read: true, write: true, location: true, health: true,
    });
  });

  it('takes them away again', () => {
    setPermissions(store, 'u-tech', { write: true });
    setPermissions(store, 'u-tech', { write: false });
    assert.equal(permissionsOf(store, tech).write, false);
  });

  it('does nothing when asked to change nothing', () => {
    setPermissions(store, 'u-tech', {});
    assert.deepEqual(permissionsOf(store, tech), DEFAULT_PERMISSIONS);
  });

  it('changes only the user named', () => {
    setPermissions(store, 'u-tech', { write: true });
    assert.equal(permissionsOf(store, owner).write, false);
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
  it('refuses the very next check after write is taken away', () => {
    setPermissions(store, 'u-tech', { write: true });
    assert.equal(codeOf(() => requirePermission(store, tech, 'write')), null);

    setPermissions(store, 'u-tech', { write: false });
    assert.equal(codeOf(() => requirePermission(store, tech, 'write')), 'forbidden');
  });

  /** A suspended account has none, whatever its columns still say. */
  it('gives a suspended account nothing', () => {
    setPermissions(store, 'u-tech', { write: true });
    store.run("UPDATE users SET status = 'suspended' WHERE id = ?", 'u-tech');

    assert.deepEqual(permissionsOf(store, tech), {
      read: false, write: false, location: false, health: false,
    });
  });

  /** A token outliving its account must not outlive its permissions. */
  it('gives a deleted account nothing', () => {
    store.run('DELETE FROM users WHERE id = ?', 'u-tech');
    assert.equal(permissionsOf(store, tech).read, false);
  });
});

describe('what a refusal says', () => {
  it('names the permission and who can grant it', () => {
    let message = '';
    try {
      requirePermission(store, tech, 'write');
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /change parameters/);
    assert.match(message, /company administrator/);
  });

  it('does not refuse a permission the user holds', () => {
    assert.equal(codeOf(() => requirePermission(store, tech, 'read')), null);
  });
});

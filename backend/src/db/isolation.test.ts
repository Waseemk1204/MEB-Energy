import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, type Store } from './client.js';
import {
  TenantScopeError,
  assertOwned,
  canManageUsers,
  canWriteParameters,
  platformWide,
  tenantQuery,
  type Principal,
} from './tenancy.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Adversarial isolation testing, from the first table rather than after the
 * fact. The PRD's build plan calls retrofitting tenant isolation the riskiest
 * item on the programme; these are the tests that stop it needing a retrofit.
 */

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';

const principal = (role: Principal['role'], companyId: string | null): Principal => ({
  userId: `user-${role}-${companyId ?? 'platform'}`,
  role,
  companyId,
});

const acmeUser = principal('user', ACME);
const acmeCompany = principal('company', ACME);
const rivalUser = principal('user', RIVAL);
const admin = principal('admin', null);

interface BatteryRow {
  id: string;
  company_id: string;
  serial: string;
}

const batteriesFor = (p: Principal, where?: string, params: (string | number)[] = []) => {
  const q = tenantQuery(p, 'batteries', where ? { where, params } : {});
  return store.all<BatteryRow>(q.sql, ...q.params);
};

beforeEach(() => {
  store = createStore();
  const now = Date.now();

  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    seedCompany(store, id, name, {}, now);
  }

  for (const [companyId, serial] of [
    [ACME, 'BAT-ACME-1'],
    [ACME, 'BAT-ACME-2'],
    [RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      companyId,
      serial,
      'LiFePO4',
      24,
      now
    );
  }
});

afterEach(() => store.close());

describe('scoped queries', () => {
  it('returns only the caller’s own batteries', () => {
    const rows = batteriesFor(acmeUser);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('shows a rival nothing of ours', () => {
    assert.deepEqual(
      batteriesFor(rivalUser).map((r) => r.serial),
      ['BAT-RIVAL-1']
    );
  });

  it('keeps the scope when another condition is added', () => {
    // The failure mode this prevents: someone adds a filter and displaces the
    // company clause while rewriting the WHERE.
    const rows = batteriesFor(acmeUser, 'chemistry = ?', ['LiFePO4']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  /** An OR in a caller's condition must not be able to widen the scope. */
  it('cannot be widened by an injected OR in the extra condition', () => {
    const rows = batteriesFor(acmeUser, "chemistry = ? OR 1=1", ['nonsense']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('lets a platform admin see every tenant', () => {
    assert.equal(batteriesFor(admin).length, 3);
  });

  it('binds values rather than interpolating them', () => {
    const q = tenantQuery(acmeUser, 'batteries', { where: 'serial = ?', params: ["'; DROP TABLE batteries; --"] });
    assert.doesNotThrow(() => store.all(q.sql, ...q.params));
    assert.equal(batteriesFor(admin).length, 3); // table intact
  });
});

describe('the scoping API refuses to be misused', () => {
  it('rejects a non-admin principal with no company', () => {
    const rootless = { userId: 'x', role: 'user', companyId: null } as Principal;
    assert.throws(() => tenantQuery(rootless, 'batteries'), /no company/);
  });

  it('rejects a table that is not tenant-scoped', () => {
    assert.throws(
      () => tenantQuery(acmeUser, 'parameter_definitions' as never),
      /not a tenant-scoped table/
    );
  });

  it('refuses a cross-tenant query from a non-admin', () => {
    assert.throws(() => platformWide(acmeCompany), /cannot query platform-wide/);
    assert.throws(() => platformWide(acmeUser), TenantScopeError);
  });

  it('allows it for an admin', () => {
    assert.doesNotThrow(() => platformWide(admin));
  });
});

/** The ID-guessing attack: a valid id from another tenant, fetched by key. */
describe('ownership checks on direct id lookups', () => {
  const bySerial = (serial: string) =>
    store.get<BatteryRow>('SELECT * FROM batteries WHERE serial = ?', serial);

  it('refuses another tenant’s row', () => {
    assert.throws(() => assertOwned(acmeUser, bySerial('BAT-RIVAL-1'), 'Battery'), TenantScopeError);
  });

  it('allows your own row', () => {
    assert.doesNotThrow(() => assertOwned(acmeUser, bySerial('BAT-ACME-1'), 'Battery'));
  });

  it('allows an admin any row', () => {
    assert.doesNotThrow(() => assertOwned(admin, bySerial('BAT-RIVAL-1'), 'Battery'));
  });

  /** Confirming existence is itself a disclosure, so the cases are identical. */
  it('does not reveal that a foreign row exists', () => {
    const messageFor = (row: BatteryRow | undefined) => {
      try {
        assertOwned(acmeUser, row, 'Battery');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    assert.equal(messageFor(bySerial('BAT-RIVAL-1')), messageFor(undefined));
  });
});

describe('role permissions', () => {
  it('lets a company manage its own users', () => {
    assert.equal(canManageUsers(acmeCompany, ACME), true);
  });

  it('stops a company managing another tenant’s users', () => {
    assert.equal(canManageUsers(acmeCompany, RIVAL), false);
  });

  it('stops a field user managing anyone', () => {
    assert.equal(canManageUsers(acmeUser, ACME), false);
  });

  it('lets an admin manage any company', () => {
    assert.equal(canManageUsers(admin, RIVAL), true);
  });

  it('stops any role writing parameters on another tenant’s battery', () => {
    assert.equal(canWriteParameters(acmeUser, RIVAL), false);
    assert.equal(canWriteParameters(acmeCompany, RIVAL), false);
  });

  it('lets a field user write on their own company’s battery', () => {
    assert.equal(canWriteParameters(acmeUser, ACME), true);
  });
});

/**
 * PRD §8.1 requires append-only audit records. Enforced by database triggers
 * rather than by service code, because the trail has to hold even when
 * something is actively trying to rewrite it.
 */
describe('the audit ledger is append-only', () => {
  const seedAudit = () => {
    const id = randomUUID();
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      'actor-1',
      ACME,
      'a@acme.example',
      'A',
      'user',
      'x',
      Date.now()
    );
    store.run(
      `INSERT INTO audit_events
       (id, company_id, actor_user_id, actor_role, parameter_key, old_value, new_value,
        source, result, occurred_at, recorded_at, seq)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_events))`,
      id,
      ACME,
      'actor-1',
      'user',
      'cell_ovp',
      '3.750 V',
      '3.800 V',
      'local',
      'success',
      Date.now(),
      Date.now()
    );
    return id;
  };

  it('accepts new entries', () => {
    const id = seedAudit();
    assert.ok(store.get('SELECT id FROM audit_events WHERE id = ?', id));
  });

  it('refuses to let an entry be altered', () => {
    const id = seedAudit();
    assert.throws(
      () => store.run('UPDATE audit_events SET result = ? WHERE id = ?', 'rejected', id),
      /append-only/
    );
  });

  it('refuses to let an entry be deleted', () => {
    const id = seedAudit();
    assert.throws(() => store.run('DELETE FROM audit_events WHERE id = ?', id), /append-only/);
  });

  it('holds against a bulk statement too', () => {
    seedAudit();
    assert.throws(() => store.exec('DELETE FROM audit_events'), /append-only/);
    assert.throws(() => store.exec("UPDATE audit_events SET reason = 'tampered'"), /append-only/);
  });

  /** An unknown result value would let a caller invent an outcome. */
  it('only accepts the defined outcomes', () => {
    assert.throws(
      () =>
        store.run(
          `INSERT INTO audit_events
           (id, company_id, actor_user_id, actor_role, source, result, occurred_at, recorded_at, seq)
           VALUES (?,?,?,?,?,?,?,?,1)`,
          randomUUID(),
          ACME,
          'actor-1',
          'user',
          'local',
          'probably-fine',
          Date.now(),
          Date.now()
        ),
      /CHECK/i
    );
  });
});

/** A rootless non-admin would be a principal the scoping rules cannot classify. */
describe('the schema refuses impossible principals', () => {
  const insertUser = (companyId: string | null, role: Principal['role']) =>
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      randomUUID(),
      companyId,
      `${role}-${companyId ?? 'none'}@example.com`,
      'Test',
      role,
      'x',
      Date.now()
    );

  it('rejects a non-admin user with no company', () => {
    assert.throws(() => insertUser(null, 'user'), /CHECK/i);
  });

  it('rejects an admin bound to a company', () => {
    assert.throws(() => insertUser(ACME, 'admin'), /CHECK/i);
  });

  it('accepts a properly scoped user', () => {
    assert.doesNotThrow(() => insertUser(ACME, 'user'));
  });

  it('accepts a platform admin', () => {
    assert.doesNotThrow(() => insertUser(null, 'admin'));
  });
});

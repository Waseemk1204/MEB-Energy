import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, type Store } from './client.js';
import {
  TenantScopeError,
  assertOwned,
  canManageUsers,
  canWriteParameters,
  tenantQuery,
  type Principal,
} from './tenancy.js';
import { createTestStore, seedCompany } from '../db/testFixtures.js';

/**
 * Adversarial isolation testing, from the first table rather than after the
 * fact. The PRD's build plan calls retrofitting tenant isolation the riskiest
 * item on the programme; these are the tests that stop it needing a retrofit.
 */

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';

const principal = (role: Principal['role'], companyId: string): Principal => ({
  userId: `user-${role}-${companyId}`,
  role,
  companyId,
});

const acmeUser = principal('user', ACME);
const acmeCompany = principal('company', ACME);
const rivalUser = principal('user', RIVAL);

/** Every row across both companies, for asserting the table itself. */
const everyBattery = async () => await store.all<BatteryRow>('SELECT * FROM batteries');

interface BatteryRow {
  id: string;
  company_id: string;
  serial: string;
}

const batteriesFor = async (p: Principal, where?: string, params: (string | number)[] = []) => {
  const q = tenantQuery(p, 'batteries', where ? { where, params } : {});
  return await store.all<BatteryRow>(q.sql, ...q.params);
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

  for (const [companyId, serial] of [
    [ACME, 'BAT-ACME-1'],
    [ACME, 'BAT-ACME-2'],
    [RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    await store.run(
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
  it('returns only the caller’s own batteries', async () => {
    const rows = await batteriesFor(acmeUser);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('shows a rival nothing of ours', async () => {
    assert.deepEqual(
      (await batteriesFor(rivalUser)).map((r) => r.serial),
      ['BAT-RIVAL-1']
    );
  });

  it('keeps the scope when another condition is added', async () => {
    // The failure mode this prevents: someone adds a filter and displaces the
    // company clause while rewriting the WHERE.
    const rows = await batteriesFor(acmeUser, 'chemistry = ?', ['LiFePO4']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  /** An OR in a caller's condition must not be able to widen the scope. */
  it('cannot be widened by an injected OR in the extra condition', async () => {
    const rows = await batteriesFor(acmeUser, "chemistry = ? OR 1=1", ['nonsense']);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  /**
   * Nobody is platform-wide. The company's administrator sees the company's
   * rows and nothing else — there is no principal a scoped query widens for.
   */
  it('gives an administrator the same scope as everyone else', async () => {
    const rows = await batteriesFor(acmeCompany);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.company_id === ACME));
  });

  it('binds values rather than interpolating them', async () => {
    const q = tenantQuery(acmeUser, 'batteries', { where: 'serial = ?', params: ["'; DROP TABLE batteries; --"] });
    await assert.doesNotReject(async () => store.all(q.sql, ...q.params));
    assert.equal((await everyBattery()).length, 3); // table intact
  });

  it('never emits an unscoped query', () => {
    for (const p of [acmeUser, acmeCompany, rivalUser]) {
      assert.match(tenantQuery(p, 'batteries').sql, /WHERE batteries\.company_id = \?/);
    }
  });
});

describe('the scoping API refuses to be misused', () => {
  it('rejects a principal with no company', () => {
    const rootless = { userId: 'x', role: 'user', companyId: '' } as Principal;
    assert.throws(() => tenantQuery(rootless, 'batteries'), /no company/);
  });

  it('rejects a table that is not tenant-scoped', () => {
    assert.throws(
      () => tenantQuery(acmeUser, 'parameter_definitions' as never),
      /not a tenant-scoped table/
    );
  });

});

/** The ID-guessing attack: a valid id from another tenant, fetched by key. */
describe('ownership checks on direct id lookups', () => {
  const bySerial = async (serial: string) =>
    await store.get<BatteryRow>('SELECT * FROM batteries WHERE serial = ?', serial);

  it('refuses another tenant’s row', async () => {
    await assert.rejects(async () => assertOwned(acmeUser, await bySerial('BAT-RIVAL-1'), 'Battery'), TenantScopeError);
  });

  it('allows your own row', async () => {
    await assert.doesNotReject(async () => assertOwned(acmeUser, await bySerial('BAT-ACME-1'), 'Battery'));
  });

  it('refuses even an administrator another company’s row', async () => {
    await assert.rejects(async () => assertOwned(acmeCompany, await bySerial('BAT-RIVAL-1'), 'Battery'), TenantScopeError);
  });

  /** Confirming existence is itself a disclosure, so the cases are identical. */
  it('does not reveal that a foreign row exists', async () => {
    const messageFor = async (row: BatteryRow | undefined) => {
      try {
        assertOwned(acmeUser, row, 'Battery');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    assert.equal(await messageFor(await bySerial('BAT-RIVAL-1')), await messageFor(undefined));
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

  it('has nobody who manages every company', () => {
    assert.equal(canManageUsers(acmeCompany, RIVAL), false);
    assert.equal(canManageUsers(rivalUser, ACME), false);
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
  const seedAudit = async () => {
    const id = randomUUID();
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      'actor-1',
      ACME,
      'a@acme.example',
      'A',
      'user',
      'x',
      Date.now()
    );
    await store.run(
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

  it('accepts new entries', async () => {
    const id = await seedAudit();
    assert.ok(await store.get('SELECT id FROM audit_events WHERE id = ?', id));
  });

  it('refuses to let an entry be altered', async () => {
    const id = await seedAudit();
    await assert.rejects(
      () => store.run('UPDATE audit_events SET result = ? WHERE id = ?', 'rejected', id),
      /append-only/
    );
  });

  it('refuses to let an entry be deleted', async () => {
    const id = await seedAudit();
    await assert.rejects(() => store.run('DELETE FROM audit_events WHERE id = ?', id), /append-only/);
  });

  it('holds against a bulk statement too', async () => {
    await seedAudit();
    await assert.rejects(() => store.exec('DELETE FROM audit_events'), /append-only/);
    await assert.rejects(() => store.exec("UPDATE audit_events SET reason = 'tampered'"), /append-only/);
  });

  /** An unknown result value would let a caller invent an outcome. */
  it('only accepts the defined outcomes', async () => {
    await assert.rejects(
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

/** A rootless user would be a principal the scoping rules cannot classify. */
describe('the schema refuses impossible principals', () => {
  const insertUser = async (companyId: string | null, role: string) =>
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      randomUUID(),
      companyId,
      `${role}-${companyId ?? 'none'}@example.com`,
      'Test',
      role,
      'x',
      Date.now()
    );

  it('rejects a user with no company', async () => {
    await assert.rejects(async () => await insertUser(null, 'user'), /NOT NULL|not-null/i);
  });

  it('rejects an administrator with no company', async () => {
    await assert.rejects(async () => await insertUser(null, 'company'), /NOT NULL|not-null/i);
  });

  /** The platform-administrator role is gone from the schema, not only from the code. */
  it('rejects the retired platform-admin role', async () => {
    await assert.rejects(async () => await insertUser(ACME, 'admin'), /CHECK/i);
  });

  it('accepts a properly scoped user', async () => {
    await assert.doesNotReject(async () => await insertUser(ACME, 'user'));
  });

  it('accepts a properly scoped administrator', async () => {
    await assert.doesNotReject(async () => await insertUser(ACME, 'company'));
  });
});

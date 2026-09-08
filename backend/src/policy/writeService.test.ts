import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { TenantScopeError, type Principal } from '../db/tenancy.js';
import { queryAudit, type AuditRow } from '../audit/service.js';
import { JBD_SP24S004, capabilityProfile, seedParameterDefinitions } from './seed.js';
import { performWrite, type Dispatcher, type WriteContext } from './writeService.js';
import { closeSession, openSession } from '../session/bleSession.js';
import { seedCompany } from '../db/testFixtures.js';

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const ACME_BATTERY = 'bat-acme';
const RIVAL_BATTERY = 'bat-rival';

const user: Principal = { userId: 'u1', role: 'user', companyId: ACME };
const admin: Principal = { userId: 'a1', role: 'admin', companyId: null };

const ok = (readBack?: number): Dispatcher => ({
  send: async ({ value }) => ({ result: 'success', readBack: readBack ?? value }),
});
const rejects: Dispatcher = { send: async () => ({ result: 'rejected', bmsResponse: 'NAK' }) };
const throws: Dispatcher = {
  send: async () => {
    throw new Error('link dropped mid-command');
  },
};

const context = (over: Partial<WriteContext> = {}): WriteContext => ({
  batteryId: ACME_BATTERY,
  reason: 'Vendor bulletin 2026-114',
  ...over,
});

/** Presence is a server-side fact now, so tests establish it the real way. */
const withSession = (batteryId: string, companyId: string) =>
  openSession(store, user, batteryId, companyId);
const withoutSession = (batteryId: string) => closeSession(store, user, batteryId);

const auditFor = (p: Principal): AuditRow[] => queryAudit(store, p);

beforeEach(() => {
  store = createStore();
  const now = Date.now();
  seedParameterDefinitions(store);

  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    seedCompany(store, id, name, {}, now);
  }
  for (const [id, company, serial] of [
    [ACME_BATTERY, ACME, 'BAT-ACME-1'],
    [RIVAL_BATTERY, RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    store.run(
      `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, bms_firmware, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      company,
      serial,
      'LiFePO4',
      24,
      JBD_SP24S004,
      'FW 1.2.4',
      now
    );
  }
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    'u1',
    ACME,
    'u1@acme.example',
    'U',
    'user',
    'x',
    now
  );
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    'a1',
    null,
    'a1@knowyourev.example',
    'A',
    'admin',
    'x',
    now
  );

  // A technician is on site with a live link to each battery unless a test
  // says otherwise.
  withSession(ACME_BATTERY, ACME);
  store.run(
    `INSERT INTO ble_sessions (id, company_id, battery_id, user_id, device_id, started_at, last_heartbeat_at)
     VALUES ('sess-rival', ?, ?, 'u1', NULL, ?, ?)`,
    RIVAL,
    RIVAL_BATTERY,
    now,
    now
  );
});

afterEach(() => store.close());

describe('the datasheet seed', () => {
  it('loads the full JBD profile', () => {
    assert.equal(capabilityProfile(store, JBD_SP24S004).length, 29);
  });

  it('is idempotent', () => {
    seedParameterDefinitions(store);
    assert.equal(capabilityProfile(store, JBD_SP24S004).length, 29);
  });

  it('marks the SKU-fixed over-current table as non-writable', () => {
    const profile = capabilityProfile(store, JBD_SP24S004);
    for (const key of ['charge_ocp', 'discharge_ocp_1', 'discharge_ocp_2', 'short_circuit']) {
      assert.equal(profile.find((d) => d.parameterKey === key)?.writable, false, key);
    }
  });

  it('offers nothing for an unknown BMS', () => {
    assert.equal(capabilityProfile(store, 'JK BD6A20S').length, 0);
  });
});

describe('a permitted write', () => {
  it('succeeds and reports the read-back', async () => {
    const out = await performWrite(store, ok(), user, 'cell_ovp', 3.8, context());
    assert.equal(out.ok, true);
    assert.equal(out.result, 'success');
    assert.equal(out.readBack, 3.8);
  });

  it('records the value the BMS actually kept, not the one requested', async () => {
    const out = await performWrite(store, ok(3.75), user, 'cell_ovp', 3.8, context());
    assert.equal(out.readBack, 3.75);
    assert.equal(auditFor(user)[0]?.new_value, '3.75');
  });

  it('attributes a field user’s write as local', async () => {
    await performWrite(store, ok(), user, 'cell_ovp', 3.8, context());
    assert.equal(auditFor(user)[0]?.source, 'local');
  });

  it('attributes an admin write as admin_remote', async () => {
    await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context());
    assert.equal(auditFor(admin)[0]?.source, 'admin_remote');
  });

  it('attributes a forced admin write distinctly', async () => {
    await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context({ forcePush: true }));
    assert.equal(auditFor(admin)[0]?.source, 'admin_force_push');
  });
});

/**
 * PRD §7.12: every attempt is recorded, "successful or rejected". A trail of
 * successes cannot answer what someone tried to do.
 */
describe('a refused write is still audited', () => {
  it('records a policy denial', async () => {
    const out = await performWrite(store, ok(), user, 'cell_ovp', 4.2, context());
    assert.equal(out.ok, false);
    assert.equal(out.denialCode, 'out_of_range');
    const [entry] = auditFor(user);
    assert.equal(entry?.result, 'rejected');
    assert.equal(entry?.parameter_key, 'cell_ovp');
  });

  it('records why it was refused', async () => {
    await performWrite(store, ok(), user, 'cell_ovp', 4.2, context());
    const row = store.get<{ bms_response: string }>(
      'SELECT bms_response FROM audit_events LIMIT 1'
    );
    assert.match(row!.bms_response, /policy:out_of_range/);
  });

  it('records a missing reason on a critical parameter', async () => {
    const out = await performWrite(store, ok(), user, 'cell_ovp', 3.8, context({ reason: undefined }));
    assert.equal(out.denialCode, 'reason_required');
    assert.equal(auditFor(user).length, 1);
  });

  it('records an attempt to write a SKU-fixed parameter', async () => {
    const out = await performWrite(store, ok(), user, 'charge_ocp', 220, context());
    assert.equal(out.denialCode, 'not_writable');
    assert.equal(auditFor(user).length, 1);
  });

  it('never reaches the dispatcher when policy refuses', async () => {
    let called = false;
    const spy: Dispatcher = {
      send: async () => {
        called = true;
        return { result: 'success' as const };
      },
    };
    await performWrite(store, spy, user, 'cell_ovp', 4.2, context());
    assert.equal(called, false);
  });
});

/** Mode 1, enforced on the path that actually dispatches. */
describe('the active-session requirement', () => {
  it('refuses and audits a write with no live session', async () => {
    withoutSession(ACME_BATTERY);
    const out = await performWrite(store, ok(), user, 'cell_ovp', 3.8, context());
    assert.equal(out.denialCode, 'no_active_session');
    assert.equal(auditFor(user)[0]?.result, 'rejected');
  });

  it('refuses a Force Push with no live session', async () => {
    withoutSession(ACME_BATTERY);
    const out = await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context({ forcePush: true }));
    assert.equal(out.denialCode, 'session_required_for_admin_write');
  });
});

describe('tenant isolation on the write path', () => {
  it('refuses a write to another company’s battery', async () => {
    await assert.rejects(
      () => performWrite(store, ok(), user, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY })),
      TenantScopeError
    );
  });

  it('writes no audit row into the victim’s ledger', async () => {
    await performWrite(store, ok(), user, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY })).catch(
      () => undefined
    );
    const rival: Principal = { userId: 'r1', role: 'user', companyId: RIVAL };
    assert.equal(auditFor(rival).length, 0);
  });

  it('does not reveal that the battery exists', async () => {
    const message = await performWrite(store, ok(), user, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY }))
      .then(() => null)
      .catch((e: Error) => e.message);
    assert.match(message!, /not found/);
  });

  it('lets an admin write across tenants', async () => {
    const out = await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY }));
    assert.equal(out.ok, true);
  });

  it('files the audit row against the battery’s company, not the actor’s', async () => {
    await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY }));
    const rival: Principal = { userId: 'r1', role: 'user', companyId: RIVAL };
    assert.equal(auditFor(rival).length, 1);
  });
});

describe('dispatch outcomes', () => {
  it('records a BMS rejection', async () => {
    const out = await performWrite(store, rejects, user, 'cell_ovp', 3.8, context());
    assert.equal(out.ok, false);
    assert.equal(out.result, 'rejected');
  });

  /**
   * A dispatch that throws may still have reached the BMS. Recording failure
   * would be a claim the server cannot support.
   */
  it('records a thrown dispatch as unknown, not as failure', async () => {
    const out = await performWrite(store, throws, user, 'cell_ovp', 3.8, context());
    assert.equal(out.result, 'indeterminate');
    assert.equal(out.ok, false);
    assert.equal(auditFor(user)[0]?.result, 'indeterminate');
  });

  it('keeps the dispatch error for diagnosis', async () => {
    await performWrite(store, throws, user, 'cell_ovp', 3.8, context());
    const row = store.get<{ bms_response: string }>('SELECT bms_response FROM audit_events LIMIT 1');
    assert.match(row!.bms_response, /link dropped/);
  });
});

describe('reading the ledger', () => {
  const write = (key: string, value: number, ctx?: Partial<WriteContext>) =>
    performWrite(store, ok(), user, key, value, context(ctx));

  it('is scoped to the caller’s tenant', async () => {
    await write('cell_ovp', 3.8);
    await performWrite(store, ok(), admin, 'cell_ovp', 3.8, context({ batteryId: RIVAL_BATTERY }));
    assert.equal(auditFor(user).length, 1);
    assert.equal(auditFor(admin).length, 2);
  });

  it('filters by result', async () => {
    await write('cell_ovp', 3.8);
    await write('cell_ovp', 4.2);
    assert.equal(queryAudit(store, user, { result: 'rejected' }).length, 1);
    assert.equal(queryAudit(store, user, { result: 'success' }).length, 1);
  });

  it('filters by source', async () => {
    await write('cell_ovp', 3.8);
    await performWrite(store, ok(), admin, 'cell_ovp', 3.75, context());
    assert.equal(queryAudit(store, admin, { source: 'admin_remote' }).length, 1);
    assert.equal(queryAudit(store, admin, { source: 'local' }).length, 1);
  });

  it('returns newest first', async () => {
    await write('cell_ovp', 3.8);
    await write('balance_start_v', 3.4);
    assert.equal(auditFor(user)[0]?.parameter_key, 'balance_start_v');
  });

  /**
   * Two writes can land in the same millisecond. Without a monotonic
   * tiebreaker their order is arbitrary, and a trail that cannot say which
   * change came first cannot answer the question it exists for.
   */
  it('orders events written in the same millisecond deterministically', async () => {
    for (let i = 0; i < 12; i++) await write('cell_ovp', 3.7 + i * 0.005);
    const rows = auditFor(user);
    assert.equal(rows.length, 12);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1]!.seq > rows[i]!.seq, 'sequence must strictly decrease');
    }
    assert.equal(rows[0]!.new_value, String(3.7 + 11 * 0.005));
  });

  it('caps an absurd limit rather than trusting it', async () => {
    await write('cell_ovp', 3.8);
    assert.doesNotThrow(() => queryAudit(store, user, { limit: 10_000_000 }));
  });
});

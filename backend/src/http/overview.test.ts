import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { seedCompany } from '../db/testFixtures.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';

/**
 * The platform overview.
 *
 * Asserted against a seeded database rather than a fixture object, so a query
 * that counts the wrong thing fails here. Counting in SQL matters: a fleet
 * past one page would otherwise report the size of the page.
 */

const SECRET = secretFrom('an-overview-signing-secret-of-length');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const DAY = 24 * 60 * 60 * 1000;

let store: Store;
let app: FastifyInstance;
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

const addBattery = (id: string, company: string, serial: string) =>
  store.run(
    'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
    id, company, serial, 'LiFePO4', 24, Date.now()
  );

const addReading = (batteryId: string, company: string, at: number) =>
  store.run(
    `INSERT INTO telemetry_readings
       (id, company_id, battery_id, recorded_at, soc, pack_voltage, pack_current, temperature_c,
        min_cell_v, max_cell_v, delta_mv, fault_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    `r-${batteryId}-${at}`, company, batteryId, at, 80, 79.2, 0.4, 24, 3.29, 3.33, 40, 0
  );

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  // Two companies with live access, one whose access lapses in a fortnight,
  // and one whose plan already ended.
  seedCompany(store, 'c-live-1', 'Live One', {}, now);
  seedCompany(store, 'c-live-2', 'Live Two', {}, now);
  seedCompany(store, 'c-lapsing', 'Lapsing', {}, now);
  store.run(
    "UPDATE subscriptions SET renewal_date = ? WHERE company_id = ?", now + 14 * DAY, 'c-lapsing'
  );
  seedCompany(store, 'c-expired', 'Expired', {}, now);
  store.run("UPDATE subscriptions SET renewal_date = ? WHERE company_id = ?", now - DAY, 'c-expired');

  for (const [id, company, email, role, status] of [
    ['u-admin', null, 'ops@knowyourev.example', 'admin', 'active'],
    ['u-owner', 'c-live-1', 'owner@one.example', 'company', 'active'],
    ['u-tech', 'c-live-1', 'tech@one.example', 'user', 'active'],
    ['u-gone', 'c-live-2', 'gone@two.example', 'user', 'suspended'],
  ] as const) {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, status, now
    );
  }

  addBattery('b-1', 'c-live-1', 'BAT-0001');
  addBattery('b-2', 'c-live-1', 'BAT-0002');
  addBattery('b-3', 'c-live-2', 'BAT-0003');
  addReading('b-1', 'c-live-1', now - 60_000);   // an hour ago: reporting
  addReading('b-2', 'c-live-1', now - 3 * DAY);  // three days ago: not

  store.run(
    'INSERT INTO devices (id, company_id, serial, hardware_revision, firmware_version, security_status, created_at) VALUES (?,?,?,?,?,?,?)',
    'd-1', 'c-live-1', 'KYE-1', 'rev-C', '1.4.2', 'valid', now
  );
  store.run(
    'INSERT INTO devices (id, company_id, serial, hardware_revision, firmware_version, security_status, created_at) VALUES (?,?,?,?,?,?,?)',
    'd-2', 'c-live-1', 'KYE-2', 'rev-C', '1.4.2', 'revoked', now
  );

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(99, 60_000) });
});

afterEach(() => store.close());

const overviewAs = async (email: string) => {
  const token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
  ).json().accessToken as string;
  return app.inject({
    method: 'GET',
    url: '/platform/overview',
    headers: { authorization: `Bearer ${token}` },
  });
};

describe('what the overview counts', () => {
  it('counts every company, lapsed ones included', async () => {
    assert.equal((await overviewAs('ops@knowyourev.example')).json().companies.total, 4);
  });

  it('counts only those whose access is live', async () => {
    assert.equal((await overviewAs('ops@knowyourev.example')).json().companies.withAccess, 3);
  });

  /** The figure that asks somebody to act: these stop working next month. */
  it('counts those lapsing within thirty days, and not those already lapsed', async () => {
    const c = (await overviewAs('ops@knowyourev.example')).json().companies;
    assert.equal(c.lapsingWithin30Days, 1);
  });

  it('counts users but not platform administrators', async () => {
    const u = (await overviewAs('ops@knowyourev.example')).json().users;
    assert.equal(u.total, 3);
    assert.equal(u.active, 2);
  });

  it('counts every battery', async () => {
    assert.equal((await overviewAs('ops@knowyourev.example')).json().batteries.total, 3);
  });

  /**
   * "Connected" is not a state a pack holds — it is a recent reading. A pack
   * last heard from three days ago is not connected, whatever a status column
   * might have said.
   */
  it('counts a battery as reporting only if it has been heard from today', async () => {
    const b = (await overviewAs('ops@knowyourev.example')).json().batteries;
    assert.equal(b.reportingWithin24Hours, 1);
  });

  it('counts gateways, and separately those still in service', async () => {
    const g = (await overviewAs('ops@knowyourev.example')).json().gateways;
    assert.equal(g.total, 2);
    assert.equal(g.inService, 1);
  });

  /** Two readings from one pack are one pack, not two. */
  it('does not double-count a battery that reported twice', async () => {
    addReading('b-1', 'c-live-1', Date.now() - 30_000);
    assert.equal(
      (await overviewAs('ops@knowyourev.example')).json().batteries.reportingWithin24Hours,
      1
    );
  });
});

describe('who may see it', () => {
  /** 404 rather than 403: the route does not confirm it exists. */
  it('hides it from a company owner', async () => {
    assert.equal((await overviewAs('owner@one.example')).statusCode, 404);
  });

  it('hides it from a field user', async () => {
    assert.equal((await overviewAs('tech@one.example')).statusCode, 404);
  });

  it('refuses it without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/overview' });
    assert.equal(res.statusCode, 401);
  });
});

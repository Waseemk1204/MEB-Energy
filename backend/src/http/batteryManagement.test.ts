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
 * A company looking after its own packs: adding, editing, and taking them out
 * of service. Retiring is not deleting — the audit ledger references packs by
 * id, and a ledger entry pointing at nothing is a ledger with a hole in it.
 */

const SECRET = secretFrom('a-battery-mgmt-signing-secret-of-len');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ACME = 'company-acme';
const RIVAL = 'company-rival';

let store: Store;
let app: FastifyInstance;
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  seedCompany(store, ACME, 'Acme EV', now);
  seedCompany(store, RIVAL, 'Rival', now);
  for (const [id, company, email, role] of [
    ['u-owner', ACME, 'owner@acme.example', 'company'],
    ['u-tech', ACME, 'tech@acme.example', 'user'],
    ['u-rival', RIVAL, 'owner@rival.example', 'company'],
  ] as const) {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, 'active', now
    );
  }
  store.run(
    'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
    'b-acme', ACME, 'BAT-0001', 'LiFePO4', 24, now
  );
  store.run(
    'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
    'b-rival', RIVAL, 'BAT-9001', 'LiFePO4', 16, now
  );

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(99, 60_000) });
});

afterEach(() => store.close());

const tokenFor = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } }))
    .json().accessToken as string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const patch = async (email: string, id: string, body: object) =>
  app.inject({ method: 'PATCH', url: `/batteries/${id}`, headers: auth(await tokenFor(email)), payload: body });
const retire = async (email: string, id: string) =>
  app.inject({ method: 'DELETE', url: `/batteries/${id}`, headers: auth(await tokenFor(email)) });
const list = async (email: string, includeRetired = false) =>
  (await app.inject({
    method: 'GET',
    url: includeRetired ? '/batteries?includeRetired=1' : '/batteries',
    headers: auth(await tokenFor(email)),
  })).json().batteries as { id: string; serial: string }[];

const serialOf = (id: string) =>
  store.get<{ serial: string; status: string }>('SELECT serial, status FROM batteries WHERE id = ?', id);

describe('editing a pack', () => {
  it('lets the company owner change its details', async () => {
    assert.equal((await patch('owner@acme.example', 'b-acme', { serial: 'BAT-0001-R', cellCount: 24 })).statusCode, 204);
    assert.equal(serialOf('b-acme')?.serial, 'BAT-0001-R');
  });

  it('lets the other company’s administrator change its own pack', async () => {
    assert.equal((await patch('owner@rival.example', 'b-rival', { bmsFirmware: 'FW 2.0' })).statusCode, 204);
  });

  /** Same answer as a pack that does not exist, so serials cannot be probed. */
  it('hides another tenant’s pack behind a 404', async () => {
    assert.equal((await patch('owner@acme.example', 'b-rival', { serial: 'X' })).statusCode, 404);
    assert.equal(serialOf('b-rival')?.serial, 'BAT-9001');
  });

  it('refuses a technician', async () => {
    const res = await patch('tech@acme.example', 'b-acme', { serial: 'X' });
    assert.equal(res.statusCode, 404);
  });

  it('refuses a serial another pack already has', async () => {
    store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      'b-acme-2', ACME, 'BAT-0002', 'LiFePO4', 24, Date.now()
    );
    assert.equal((await patch('owner@acme.example', 'b-acme', { serial: 'BAT-0002' })).statusCode, 409);
  });

  it('refuses a request that changes nothing', async () => {
    assert.equal((await patch('owner@acme.example', 'b-acme', {})).statusCode, 400);
  });
});

describe('retiring a pack', () => {
  it('takes it out of the technician’s list', async () => {
    assert.equal((await retire('owner@acme.example', 'b-acme')).statusCode, 204);
    assert.ok(!(await list('tech@acme.example')).some((b) => b.id === 'b-acme'));
  });

  /** Retired, not deleted: the row and everything referencing it survive. */
  it('keeps the row', async () => {
    await retire('owner@acme.example', 'b-acme');
    assert.equal(serialOf('b-acme')?.status, 'retired');
  });

  it('still shows it to a management screen that asks', async () => {
    await retire('owner@acme.example', 'b-acme');
    assert.ok((await list('owner@acme.example', true)).some((b) => b.id === 'b-acme'));
  });

  it('ends any live session on it', async () => {
    const tech = await tokenFor('tech@acme.example');
    await app.inject({ method: 'POST', url: '/batteries/b-acme/session', headers: auth(tech) });
    await retire('owner@acme.example', 'b-acme');

    const open = store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ble_sessions WHERE battery_id = ? AND ended_at IS NULL',
      'b-acme'
    );
    assert.equal(open?.n, 0);
  });

  it('hides another tenant’s pack behind a 404', async () => {
    assert.equal((await retire('owner@acme.example', 'b-rival')).statusCode, 404);
    assert.equal(serialOf('b-rival')?.status, 'active');
  });

  it('can be reinstated', async () => {
    await retire('owner@acme.example', 'b-acme');
    const res = await app.inject({
      method: 'POST',
      url: '/batteries/b-acme/reinstate',
      headers: auth(await tokenFor('owner@acme.example')),
    });
    assert.equal(res.statusCode, 204);
    assert.equal(serialOf('b-acme')?.status, 'active');
  });
});

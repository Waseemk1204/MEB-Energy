import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { seedCompany } from '../db/testFixtures.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { JBD_SP24S004, seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';

/**
 * Permissions over HTTP.
 *
 * Separate from permissions.test.ts deliberately. That file proves the rule;
 * this one proves the routes apply it. They are two different changes, and a
 * passing test of the first has more than once sat beside a call site that
 * never called it.
 */

const SECRET = secretFrom('a-permissions-signing-secret-of-len!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ACME = 'company-acme';

let store: Store;
let app: FastifyInstance;
let batteryId: string;
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  seedCompany(store, ACME, 'Acme EV', {}, now);
  for (const [id, company, email, role] of [
    ['u-admin', null, 'ops@knowyourev.example', 'admin'],
    ['u-owner', ACME, 'owner@acme.example', 'company'],
    ['u-tech', ACME, 'tech@acme.example', 'user'],
  ] as const) {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, 'active', now
    );
  }

  batteryId = 'bat-1';
  // The BMS model matters: parameter definitions are scoped to it, and a
  // battery without one has no writable parameters at all.
  store.run(
    `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, bms_firmware, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    batteryId, ACME, 'BAT-0001', 'LiFePO4', 24, JBD_SP24S004, 'FW 1.2.4', now
  );

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(99, 60_000) });
});

afterEach(() => store.close());

const tokenFor = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } }))
    .json().accessToken as string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const readBattery = async (email: string) =>
  app.inject({ method: 'GET', url: `/batteries/${batteryId}`, headers: auth(await tokenFor(email)) });

/**
 * A write needs three things, and they are separate on purpose: a token, an
 * open session at the pack (PRD 7.3 -- presence is architectural, somebody has
 * to be standing there), and the write permission. This helper supplies the
 * first two so the tests below vary only the third.
 */
const writeParam = async (email: string, value = 3.8) => {
  const token = await tokenFor(email);
  await app.inject({ method: 'POST', url: `/batteries/${batteryId}/session`, headers: auth(token) });
  return app.inject({
    method: 'POST',
    url: `/batteries/${batteryId}/parameters/cell_ovp`,
    headers: auth(token),
    payload: { value, reason: 'Vendor bulletin' },
  });
};

const setPerms = async (asEmail: string, userId: string, patch: Record<string, boolean>) =>
  app.inject({
    method: 'PATCH',
    url: `/users/${userId}/permissions`,
    headers: auth(await tokenFor(asEmail)),
    payload: patch,
  });

describe('a new technician', () => {
  it('may read a battery', async () => {
    assert.equal((await readBattery('tech@acme.example')).statusCode, 200);
  });

  /** Write is off by default. The route must say so, not the app. */
  it('may not write a parameter', async () => {
    assert.equal((await writeParam('tech@acme.example')).statusCode, 403);
  });

  it('is told which permission is missing and who grants it', async () => {
    const body = (await writeParam('tech@acme.example')).json();
    assert.match(body.message, /change parameters/);
    assert.match(body.message, /company administrator/);
  });
});

describe('the company owner granting write', () => {
  it('lets the technician write afterwards', async () => {
    assert.equal((await setPerms('owner@acme.example', 'u-tech', { write: true })).statusCode, 200);
    assert.equal((await writeParam('tech@acme.example')).statusCode, 200);
  });

  /**
   * The reason permissions are read per request rather than carried in the
   * token: revoking has to bite now, not at the next renewal.
   */
  it('stops them again on the very next request', async () => {
    await setPerms('owner@acme.example', 'u-tech', { write: true });
    assert.equal((await writeParam('tech@acme.example')).statusCode, 200);

    await setPerms('owner@acme.example', 'u-tech', { write: false });
    assert.equal((await writeParam('tech@acme.example')).statusCode, 403);
  });

  it('can take read away, which closes the battery too', async () => {
    await setPerms('owner@acme.example', 'u-tech', { read: false });
    assert.equal((await readBattery('tech@acme.example')).statusCode, 403);
  });
});

describe('who may change permissions', () => {
  /**
   * 404 rather than 403: a technician cannot manage users at all, so the route
   * does not admit that the user exists. The self-edit rule below is what
   * catches the roles that *can* reach it.
   */
  it('refuses a technician changing their own, without confirming they exist', async () => {
    const res = await setPerms('tech@acme.example', 'u-tech', { write: true });
    assert.equal(res.statusCode, 404);
  });

  /** Otherwise the setting is decorative: anyone could grant themselves write. */
  it('refuses an owner changing their own', async () => {
    const res = await setPerms('owner@acme.example', 'u-owner', { write: true });
    assert.equal(res.statusCode, 403);
  });

  it('lets a platform administrator change anyone', async () => {
    assert.equal((await setPerms('ops@knowyourev.example', 'u-tech', { write: true })).statusCode, 200);
  });

  /**
   * A company reaching into another tenant gets 404, not 403 — the same answer
   * as an id that does not exist, so the endpoint cannot be used to find out
   * who does.
   */
  it('hides another tenant’s user behind a 404', async () => {
    seedCompany(store, 'company-rival', 'Rival', {}, Date.now());
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-rival', 'company-rival', 'tech@rival.example', 'R', 'user', 'x', 'active', Date.now()
    );
    const res = await setPerms('owner@acme.example', 'u-rival', { write: true });
    assert.equal(res.statusCode, 404);
  });

  it('hides a platform administrator from a company owner', async () => {
    const res = await setPerms('owner@acme.example', 'u-admin', { write: false });
    assert.equal(res.statusCode, 404);
  });

  it('refuses a request that changes nothing', async () => {
    const res = await setPerms('owner@acme.example', 'u-tech', {});
    assert.equal(res.statusCode, 400);
  });
});

describe('an administrator', () => {
  /**
   * Permissions do not apply to an administrator, but presence still does.
   * An admin write happens inside a support session with a technician at the
   * pack (PRD 7.3), so this is refused for that reason and not for want of a
   * permission -- which is exactly the distinction worth pinning.
   */
  it('is never refused for lacking a permission', async () => {
    const res = await writeParam('ops@knowyourev.example');
    assert.notEqual(res.statusCode, 403);
    assert.equal(res.json().denialCode, 'session_required_for_admin_write');
  });
});

/**
 * The user list is what the drill-down reads. It carries permissions so that
 * showing twenty people does not become twenty-one requests, and the company
 * filter narrows what is already scoped rather than replacing the scope.
 */
describe('listing users for the drill-down', () => {
  const listAs = async (email: string, companyId?: string) => {
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json().accessToken as string;
    return app.inject({
      method: 'GET',
      url: companyId ? `/users?companyId=${companyId}` : '/users',
      headers: auth(token),
    });
  };

  it('carries each person’s permissions', async () => {
    const users = (await listAs('ops@knowyourev.example')).json().users as Record<string, number>[];
    const tech = users.find((u) => u.id === ('u-tech' as unknown as number))!;
    assert.equal(tech.can_read, 1);
    assert.equal(tech.can_write, 0);
  });

  it('narrows to one company for an administrator', async () => {
    const users = (await listAs('ops@knowyourev.example', ACME)).json().users as { id: string }[];
    assert.deepEqual(users.map((u) => u.id).sort(), ['u-owner', 'u-tech']);
  });

  /**
   * The filter sits on top of the tenant scope. A company asking for somebody
   * else's id gets their own rows back, not an error and not the other
   * company's — the scope clause is still in the query.
   */
  it('cannot be used by a company to reach another tenant', async () => {
    seedCompany(store, 'company-rival', 'Rival', {}, Date.now());
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-rival', 'company-rival', 'tech@rival.example', 'R', 'user', 'x', 'active', Date.now()
    );

    const users = (await listAs('owner@acme.example', 'company-rival')).json().users as {
      id: string;
    }[];
    assert.ok(!users.some((u) => u.id === 'u-rival'));
  });
});

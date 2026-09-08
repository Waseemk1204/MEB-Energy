import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Administration over HTTP. The service tests prove the rules; these prove the
 * rules are actually reachable — and that the escalation paths are closed at
 * the edge a caller can actually touch.
 */

const SECRET = secretFrom('an-admin-integration-signing-secret!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

const ACME = 'company-acme';
const RIVAL = 'company-rival';

let store: Store;
let app: FastifyInstance;

const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  for (const [id, name, seats] of [
    [ACME, 'Acme EV', 3],
    [RIVAL, 'Rival Fleet', 10],
  ] as const) {
    seedCompany(store, id, name, { seatLimit: seats }, now);
  }

  const insert = (id: string, company: string | null, email: string, role: string) =>
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, 'active', now
    );
  insert('u-admin', null, 'admin@knowyourev.example', 'admin');
  insert('u-admin-2', null, 'admin2@knowyourev.example', 'admin');
  insert('u-acme-owner', ACME, 'owner@acme.example', 'company');
  insert('u-acme-field', ACME, 'field@acme.example', 'user');
  insert('u-rival-owner', RIVAL, 'owner@rival.example', 'company');

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(50, 60_000) });
});

afterEach(() => store.close());

const tokenFor = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  return (res.json() as { accessToken: string }).accessToken;
};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const newUserPayload = (over: Record<string, unknown> = {}) => ({
  companyId: ACME,
  email: `new-${Math.random().toString(36).slice(2)}@acme.example`,
  displayName: 'New Person',
  role: 'user',
  password: 'a-perfectly-fine-password',
  ...over,
});

describe('companies', () => {
  it('lets an administrator create one', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: auth(token),
      payload: { name: 'New Co', seatLimit: 5 },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().companyId);
  });

  it('refuses a company principal with 403', async () => {
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: auth(token),
      payload: { name: 'Sneaky', seatLimit: 5 },
    });
    assert.equal(res.statusCode, 403);
  });

  /**
   * 404 rather than 403, consistent with every other authorisation failure
   * here: a tenant has no business learning that a platform-wide fleet listing
   * exists at all.
   */
  it('hides the platform-wide list from a tenant', async () => {
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({ method: 'GET', url: '/companies', headers: auth(token) });
    assert.equal(res.statusCode, 404);
  });

  it('lists them for an administrator', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({ method: 'GET', url: '/companies', headers: auth(token) });
    assert.equal(res.json().companies.length, 2);
  });

  it('validates the body', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({
      method: 'POST',
      url: '/companies',
      headers: auth(token),
      payload: { name: '', seatLimit: 0 },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('creating users over HTTP', () => {
  const create = async (email: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/users', headers: auth(await tokenFor(email)), payload });

  it('lets a company create its own field user', async () => {
    const res = await create('owner@acme.example', newUserPayload());
    assert.equal(res.statusCode, 201);
  });

  /** The escalation paths, closed at the edge a caller can actually reach. */
  it('stops a company creating into another tenant', async () => {
    const res = await create('owner@acme.example', newUserPayload({ companyId: RIVAL }));
    assert.equal(res.statusCode, 403);
  });

  it('stops a company minting an administrator', async () => {
    const res = await create('owner@acme.example', newUserPayload({ role: 'admin', companyId: null }));
    assert.equal(res.statusCode, 403);
  });

  it('stops a field user creating anyone', async () => {
    const res = await create('field@acme.example', newUserPayload());
    assert.equal(res.statusCode, 403);
  });

  it('returns 409 for a duplicate email', async () => {
    const res = await create('owner@acme.example', newUserPayload({ email: 'field@acme.example' }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'email_taken');
  });

  it('returns 409 when the plan is full', async () => {
    await create('owner@acme.example', newUserPayload()); // third of three
    const res = await create('owner@acme.example', newUserPayload());
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'seat_limit_reached');
  });

  it('rejects a weak password at the boundary', async () => {
    const res = await create('owner@acme.example', newUserPayload({ password: 'short' }));
    assert.equal(res.statusCode, 400);
  });

  /** A password must never come back out of the API, in any shape. */
  it('never echoes the password', async () => {
    const res = await create('owner@acme.example', newUserPayload({ password: 'a-distinctive-password' }));
    assert.ok(!res.body.includes('a-distinctive-password'));
    assert.ok(!('password' in res.json()));
  });
});

describe('listing users over HTTP', () => {
  it('shows a company only its own', async () => {
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.equal(res.json().users.length, 2);
  });

  it('shows an administrator everyone', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.equal(res.json().users.length, 5);
  });

  it('never includes password hashes', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.ok(!res.body.includes('password_hash'));
    assert.ok(!res.body.includes('scrypt$'));
  });
});

describe('suspending over HTTP', () => {
  const setStatus = async (email: string, target: string, status: string) =>
    app.inject({
      method: 'PATCH',
      url: `/users/${target}/status`,
      headers: auth(await tokenFor(email)),
      payload: { status },
    });

  it('suspends a user in your own company', async () => {
    assert.equal((await setStatus('owner@acme.example', 'u-acme-field', 'suspended')).statusCode, 204);
  });

  /** Suspension takes effect on the next request, not at token expiry. */
  it('locks the suspended user out immediately', async () => {
    const victim = await tokenFor('field@acme.example');
    assert.equal((await app.inject({ method: 'GET', url: '/me', headers: auth(victim) })).statusCode, 200);
    await setStatus('owner@acme.example', 'u-acme-field', 'suspended');
    assert.equal((await app.inject({ method: 'GET', url: '/me', headers: auth(victim) })).statusCode, 401);
  });

  it('returns 404 for another tenant’s user', async () => {
    assert.equal((await setStatus('owner@rival.example', 'u-acme-field', 'suspended')).statusCode, 404);
  });

  it('hides an administrator from a company principal', async () => {
    assert.equal((await setStatus('owner@acme.example', 'u-admin', 'suspended')).statusCode, 404);
  });

  it('refuses to suspend the last administrator', async () => {
    await setStatus('admin@knowyourev.example', 'u-admin-2', 'suspended');
    const res = await setStatus('admin@knowyourev.example', 'u-admin', 'suspended');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'last_admin');
  });

  it('validates the status value', async () => {
    assert.equal((await setStatus('admin@knowyourev.example', 'u-acme-field', 'deleted')).statusCode, 400);
  });
});

describe('seat usage', () => {
  it('reports a company its own usage', async () => {
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({ method: 'GET', url: `/companies/${ACME}/seats`, headers: auth(token) });
    assert.deepEqual(res.json(), { used: 2, limit: 3 });
  });

  it('hides another tenant’s usage', async () => {
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({ method: 'GET', url: `/companies/${RIVAL}/seats`, headers: auth(token) });
    assert.equal(res.statusCode, 404);
  });

  it('lets an administrator see any company', async () => {
    const token = await tokenFor('admin@knowyourev.example');
    const res = await app.inject({ method: 'GET', url: `/companies/${RIVAL}/seats`, headers: auth(token) });
    assert.equal(res.statusCode, 200);
  });
});

describe('devices over HTTP', () => {
  const register = async (email: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/devices',
      headers: auth(await tokenFor(email)),
      payload: {
        companyId: ACME,
        serial: `KYE-${Math.random().toString(36).slice(2, 8)}`,
        hardwareRevision: 'HW 1.0',
        firmwareVersion: 'FW 1.2.4',
        ...over,
      },
    });

  it('registers one for your own company', async () => {
    assert.equal((await register('owner@acme.example')).statusCode, 201);
  });

  it('stops registration into another tenant', async () => {
    assert.equal((await register('owner@acme.example', { companyId: RIVAL })).statusCode, 403);
  });

  it('lists only your own', async () => {
    await register('owner@acme.example');
    await register('admin@knowyourev.example', { companyId: RIVAL });
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({ method: 'GET', url: '/devices', headers: auth(token) });
    assert.equal(res.json().devices.length, 1);
  });

  it('quarantines a device', async () => {
    const { id } = (await register('owner@acme.example')).json();
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: `/devices/${id}/security`,
      headers: auth(token),
      payload: { securityStatus: 'quarantined' },
    });
    assert.equal(res.statusCode, 204);
  });

  it('returns 404 for another tenant’s device', async () => {
    const { id } = (await register('admin@knowyourev.example', { companyId: RIVAL })).json();
    const token = await tokenFor('owner@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: `/devices/${id}/security`,
      headers: auth(token),
      payload: { securityStatus: 'revoked' },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('every admin route needs authentication', () => {
  const routes: [string, string][] = [
    ['POST', '/companies'],
    ['GET', '/companies'],
    ['POST', '/users'],
    ['GET', '/users'],
    ['PATCH', '/users/u-acme-field/status'],
    ['POST', '/devices'],
    ['GET', '/devices'],
    ['PATCH', '/devices/anything/security'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url} refuses an anonymous caller`, async () => {
      const res = await app.inject({ method: method as 'GET', url, payload: {} });
      assert.equal(res.statusCode, 401);
    });
  }
});

/**
 * Onboarding a battery — the product's core entity, and until now the one
 * thing an administrator could not create through the API at all.
 */
describe('registering batteries', () => {
  const battery = (over: Record<string, unknown> = {}) => ({
    companyId: ACME,
    serial: 'BAT-NEW-0001',
    chemistry: 'LiFePO4',
    cellCount: 24,
    bmsModel: 'JBD SP24S004',
    ...over,
  });

  const register = async (email: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/batteries',
      headers: { authorization: `Bearer ${await tokenFor(email)}` },
      payload: body,
    });

  it('an administrator can register one', async () => {
    const res = await register('admin@knowyourev.example', battery());
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().batteryId);
  });

  it('the new battery is then visible to that company', async () => {
    await register('admin@knowyourev.example', battery());
    const accessToken = await tokenFor('field@acme.example');
    const res = await app.inject({
      method: 'GET',
      url: '/batteries',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const serials = (res.json().batteries as { serial: string }[]).map((b) => b.serial);
    assert.ok(serials.includes('BAT-NEW-0001'));
  });

  it('and invisible to another company', async () => {
    await register('admin@knowyourev.example', battery());
    const accessToken = await tokenFor('owner@rival.example');
    const res = await app.inject({
      method: 'GET',
      url: '/batteries',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const serials = (res.json().batteries as { serial: string }[]).map((b) => b.serial);
    assert.ok(!serials.includes('BAT-NEW-0001'));
  });

  it('an ordinary technician cannot register one', async () => {
    const res = await register('field@acme.example', battery());
    assert.equal(res.statusCode, 403);
  });

  /**
   * Serials are unique platform-wide, not per tenant: a pack is a physical
   * object that can move between fleets, and two records for one serial would
   * make its history impossible to follow across that move.
   */
  it('refuses a serial another company already holds', async () => {
    await register('admin@knowyourev.example', battery());
    const res = await register('admin@knowyourev.example', battery({ companyId: RIVAL }));
    assert.equal(res.statusCode, 409);
  });

  it('rejects a nonsensical cell count rather than storing it', async () => {
    assert.equal((await register('admin@knowyourev.example', battery({ cellCount: 0 }))).statusCode, 400);
    assert.equal(
      (await register('admin@knowyourev.example', battery({ cellCount: 2.5 }))).statusCode,
      400
    );
  });
});

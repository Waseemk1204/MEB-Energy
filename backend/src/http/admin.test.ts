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
 * Company administration over HTTP. The service tests prove the rules; these
 * prove the rules are actually reachable — and that the escalation paths are
 * closed at the edge a caller can actually touch.
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

  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    seedCompany(store, id, name, now);
  }

  const insert = (id: string, company: string, email: string, role: string) =>
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, 'active', now
    );
  insert('u-admin', ACME, 'admin@acme.example', 'company');
  insert('u-admin-2', ACME, 'admin2@acme.example', 'company');
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
  email: `new-${Math.random().toString(36).slice(2)}@acme.example`,
  displayName: 'New Person',
  role: 'user',
  password: 'a-perfectly-fine-password',
  ...over,
});

describe('the company', () => {
  it('is readable by anyone in it, with its overview', async () => {
    const token = await tokenFor('field@acme.example');
    const res = await app.inject({ method: 'GET', url: '/company', headers: auth(token) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Acme EV');
    assert.equal(res.json().overview.people.total, 3);
  });

  it('can be renamed by an administrator', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: '/company',
      headers: auth(token),
      payload: { name: 'Acme Electric' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().name, 'Acme Electric');
  });

  it('refuses a rename from a technician with 403', async () => {
    const token = await tokenFor('field@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: '/company',
      headers: auth(token),
      payload: { name: 'Sneaky' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('validates the name', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'PATCH', url: '/company', headers: auth(token), payload: { name: '  ' } });
    assert.equal(res.statusCode, 400);
  });

  /** There is no platform-wide listing any more: the route is simply gone. */
  it('has no cross-company listing', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/companies', headers: auth(token) });
    assert.equal(res.statusCode, 404);
  });

  it('has no platform overview', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/platform/overview', headers: auth(token) });
    assert.equal(res.statusCode, 404);
  });
});

describe('creating users over HTTP', () => {
  const create = async (email: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/users', headers: auth(await tokenFor(email)), payload });

  it('lets an administrator create a technician', async () => {
    const res = await create('admin@acme.example', newUserPayload());
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().role, 'user');
  });

  it('defaults the role to technician', async () => {
    const res = await create('admin@acme.example', newUserPayload({ role: undefined }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().role, 'user');
  });

  it('lets an administrator create another administrator', async () => {
    const res = await create('admin@acme.example', newUserPayload({ role: 'company' }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().role, 'company');
  });

  it('accepts the caller’s own company id, for older clients', async () => {
    const res = await create('admin@acme.example', newUserPayload({ companyId: ACME }));
    assert.equal(res.statusCode, 201);
  });

  /** The escalation paths, closed at the edge a caller can actually reach. */
  it('refuses another company’s id as not found', async () => {
    const res = await create('admin@acme.example', newUserPayload({ companyId: RIVAL }));
    assert.equal(res.statusCode, 404);
  });

  it('rejects the retired platform-admin role at the boundary', async () => {
    const res = await create('admin@acme.example', newUserPayload({ role: 'admin' }));
    assert.equal(res.statusCode, 400);
  });

  it('stops a technician creating anyone', async () => {
    const res = await create('field@acme.example', newUserPayload());
    assert.equal(res.statusCode, 403);
  });

  it('returns 409 for a duplicate email', async () => {
    const res = await create('admin@acme.example', newUserPayload({ email: 'field@acme.example' }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'email_taken');
  });

  /** No seat cap: how many people the company has is its own business. */
  it('has no seat limit', async () => {
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await create('admin@acme.example', newUserPayload())).statusCode, 201);
    }
  });

  it('rejects a weak password at the boundary', async () => {
    const res = await create('admin@acme.example', newUserPayload({ password: 'short' }));
    assert.equal(res.statusCode, 400);
  });

  /** A password must never come back out of the API, in any shape. */
  it('never echoes the password', async () => {
    const res = await create('admin@acme.example', newUserPayload({ password: 'a-distinctive-password' }));
    assert.ok(!res.body.includes('a-distinctive-password'));
    assert.ok(!('password' in res.json()));
  });
});

describe('listing users over HTTP', () => {
  it('shows the company its own people', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.equal(res.json().users.length, 3);
  });

  it('shows the other company only its own', async () => {
    const token = await tokenFor('owner@rival.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.equal(res.json().users.length, 1);
  });

  it('never includes password hashes', async () => {
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    assert.ok(!res.body.includes('password_hash'));
    assert.ok(!res.body.includes('scrypt$'));
  });
});

describe('editing a user over HTTP', () => {
  const edit = async (email: string, target: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/users/${target}`, headers: auth(await tokenFor(email)), payload });

  it('renames a person', async () => {
    assert.equal((await edit('admin@acme.example', 'u-acme-field', { displayName: 'Priya' })).statusCode, 204);
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(token) });
    const person = (res.json().users as { id: string; display_name: string }[]).find((u) => u.id === 'u-acme-field');
    assert.equal(person?.display_name, 'Priya');
  });

  it('changes an email', async () => {
    assert.equal((await edit('admin@acme.example', 'u-acme-field', { email: 'priya@acme.example' })).statusCode, 204);
  });

  it('returns 409 for an email already in use', async () => {
    assert.equal((await edit('admin@acme.example', 'u-acme-field', { email: 'admin2@acme.example' })).statusCode, 409);
  });

  it('is refused to a technician', async () => {
    assert.equal((await edit('field@acme.example', 'u-admin', { displayName: 'X' })).statusCode, 404);
  });

  it('returns 404 for another company’s person', async () => {
    assert.equal((await edit('owner@rival.example', 'u-acme-field', { displayName: 'X' })).statusCode, 404);
  });

  it('validates the body', async () => {
    assert.equal((await edit('admin@acme.example', 'u-acme-field', {})).statusCode, 400);
    assert.equal((await edit('admin@acme.example', 'u-acme-field', { email: 'nope' })).statusCode, 400);
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
    assert.equal((await setStatus('admin@acme.example', 'u-acme-field', 'suspended')).statusCode, 204);
  });

  /** Suspension takes effect on the next request, not at token expiry. */
  it('locks the suspended user out immediately', async () => {
    const victim = await tokenFor('field@acme.example');
    assert.equal((await app.inject({ method: 'GET', url: '/me', headers: auth(victim) })).statusCode, 200);
    await setStatus('admin@acme.example', 'u-acme-field', 'suspended');
    assert.equal((await app.inject({ method: 'GET', url: '/me', headers: auth(victim) })).statusCode, 401);
  });

  it('returns 404 for another company’s user', async () => {
    assert.equal((await setStatus('owner@rival.example', 'u-acme-field', 'suspended')).statusCode, 404);
  });

  it('is refused to a technician', async () => {
    assert.equal((await setStatus('field@acme.example', 'u-admin', 'suspended')).statusCode, 404);
  });

  it('refuses to suspend the last administrator', async () => {
    await setStatus('admin@acme.example', 'u-admin-2', 'suspended');
    const res = await setStatus('admin@acme.example', 'u-admin', 'suspended');
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'last_admin');
  });

  it('validates the status value', async () => {
    assert.equal((await setStatus('admin@acme.example', 'u-acme-field', 'deleted')).statusCode, 400);
  });
});

describe('devices over HTTP', () => {
  const register = async (email: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/devices',
      headers: auth(await tokenFor(email)),
      payload: {
        serial: `KYE-${Math.random().toString(36).slice(2, 8)}`,
        hardwareRevision: 'HW 1.0',
        firmwareVersion: 'FW 1.2.4',
        ...over,
      },
    });

  it('registers one for your own company', async () => {
    assert.equal((await register('admin@acme.example')).statusCode, 201);
  });

  it('refuses another company’s id as not found', async () => {
    assert.equal((await register('admin@acme.example', { companyId: RIVAL })).statusCode, 404);
  });

  it('is refused to a technician', async () => {
    assert.equal((await register('field@acme.example')).statusCode, 403);
  });

  it('lists only your own', async () => {
    await register('admin@acme.example');
    await register('owner@rival.example');
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({ method: 'GET', url: '/devices', headers: auth(token) });
    assert.equal(res.json().devices.length, 1);
  });

  it('quarantines a device', async () => {
    const { id } = (await register('admin@acme.example')).json();
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: `/devices/${id}/security`,
      headers: auth(token),
      payload: { securityStatus: 'quarantined' },
    });
    assert.equal(res.statusCode, 204);
  });

  it('returns 404 for another company’s device', async () => {
    const { id } = (await register('owner@rival.example')).json();
    const token = await tokenFor('admin@acme.example');
    const res = await app.inject({
      method: 'PATCH',
      url: `/devices/${id}/security`,
      headers: auth(token),
      payload: { securityStatus: 'revoked' },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('every administration route needs authentication', () => {
  const routes: [string, string][] = [
    ['GET', '/company'],
    ['PATCH', '/company'],
    ['POST', '/users'],
    ['GET', '/users'],
    ['PATCH', '/users/u-acme-field'],
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

/** Onboarding a battery — the product's core entity. */
describe('registering batteries', () => {
  const battery = (over: Record<string, unknown> = {}) => ({
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
    const res = await register('admin@acme.example', battery());
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().batteryId);
  });

  it('the new battery is then visible to the company', async () => {
    await register('admin@acme.example', battery());
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
    await register('admin@acme.example', battery());
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

  it('refuses another company’s id as not found', async () => {
    const res = await register('admin@acme.example', battery({ companyId: RIVAL }));
    assert.equal(res.statusCode, 404);
  });

  /**
   * Serials are unique across the database: a pack is a physical object, and
   * two records for one serial would make its history impossible to follow.
   */
  it('refuses a serial another company already holds', async () => {
    await register('owner@rival.example', battery());
    const res = await register('admin@acme.example', battery());
    assert.equal(res.statusCode, 409);
  });

  it('rejects a nonsensical cell count rather than storing it', async () => {
    assert.equal((await register('admin@acme.example', battery({ cellCount: 0 }))).statusCode, 400);
    assert.equal(
      (await register('admin@acme.example', battery({ cellCount: 2.5 }))).statusCode,
      400
    );
  });
});

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { seedCompany } from '../db/testFixtures.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { TERM_MS } from '../admin/entitlement.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';

/**
 * Entitlement over HTTP: an administrator switching a company on and off,
 * and what that does to the people who work there.
 */

const SECRET = secretFrom('an-entitlement-signing-secret-length!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ACME = 'company-acme';

let store: Store;
let app: FastifyInstance;
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  seedCompany(store, ACME, 'Acme EV', { seatLimit: 3, deviceLimit: 2 }, now);
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

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(99, 60_000) });
});

afterEach(() => store.close());

const login = (email: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });

const tokenFor = async (email: string) => (await login(email)).json().accessToken as string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const expire = () =>
  store.run(
    'UPDATE subscriptions SET renewal_date = ? WHERE company_id = ?',
    Date.now() - 1000,
    ACME
  );

/**
 * The gap this closes. A suspended company or a lapsed plan left every one of
 * its users working normally, because sign-in only checked the user.
 */
describe('signing in against a company that cannot be used', () => {
  it('works normally while the plan is live', async () => {
    assert.equal((await login('tech@acme.example')).statusCode, 200);
  });

  it('is refused once the plan has expired', async () => {
    expire();
    assert.equal((await login('tech@acme.example')).statusCode, 403);
  });

  it('is refused when the company is suspended', async () => {
    store.run("UPDATE companies SET status = 'suspended' WHERE id = ?", ACME);
    assert.equal((await login('tech@acme.example')).statusCode, 403);
  });

  it('is refused when access was revoked', async () => {
    const token = await tokenFor('ops@knowyourev.example');
    await app.inject({ method: 'DELETE', url: `/companies/${ACME}/access`, headers: auth(token) });
    assert.equal((await login('tech@acme.example')).statusCode, 403);
  });

  /**
   * 403, not 401. The credentials were right and re-typing them will not help;
   * this person needs to call their administrator. That is not the enumeration
   * concern that makes login deliberately vague — they have already proved who
   * they are.
   */
  it('says the plan has expired rather than that the password is wrong', async () => {
    expire();
    const body = (await login('tech@acme.example')).json();
    assert.match(body.message, /plan has expired/i);
    assert.match(body.message, /administrator/i);
    assert.doesNotMatch(body.message, /password/i);
  });

  it('still says nothing useful about a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'tech@acme.example', password: 'wrong-password-entirely' },
    });
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.json().message, /plan|company|subscription/i);
  });

  /** An administrator belongs to no company and is never locked out by one. */
  it('does not lock out the administrator', async () => {
    expire();
    store.run("UPDATE companies SET status = 'suspended' WHERE id = ?", ACME);
    assert.equal((await login('ops@knowyourev.example')).statusCode, 200);
  });
});

/**
 * Checked on renewal too, so a company switched off mid-session loses access
 * within the access token's fifteen minutes rather than whenever somebody
 * happens to sign out.
 */
describe('a session that is already open', () => {
  it('cannot be renewed once the plan has expired', async () => {
    const refreshToken = (await login('tech@acme.example')).json().refreshToken;
    expire();

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    assert.equal(res.statusCode, 403);
  });

  it('renews normally while the plan is live', async () => {
    const refreshToken = (await login('tech@acme.example')).json().refreshToken;
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    assert.equal(res.statusCode, 200);
  });
});

describe('granting access', () => {
  const grant = async (body: Record<string, unknown>, as = 'ops@knowyourev.example') =>
    app.inject({
      method: 'POST',
      url: `/companies/${ACME}/access`,
      headers: auth(await tokenFor(as)),
      payload: body,
    });

  it('an administrator can switch a company on for a year', async () => {
    expire();
    const res = await grant({ seatLimit: 50 });

    assert.equal(res.statusCode, 201);
    assert.ok(res.json().expiresAt > Date.now() + TERM_MS - 60_000);
    assert.equal((await login('tech@acme.example')).statusCode, 200);
  });

  it('sets the seats the administrator chose', async () => {
    await grant({ seatLimit: 100 });
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${ACME}/entitlement`,
      headers: auth(await tokenFor('ops@knowyourev.example')),
    });
    assert.equal(res.json().seatLimit, 100);
  });

  it('defaults devices to two and lets that be raised', async () => {
    assert.equal((await grant({ seatLimit: 20 })).json().deviceLimit, 2);
    assert.equal((await grant({ seatLimit: 20, deviceLimit: 6 })).json().deviceLimit, 6);
  });

  /** Not something a company can do for itself. */
  it('a company owner cannot grant their own access', async () => {
    assert.equal((await grant({ seatLimit: 500 }, 'owner@acme.example')).statusCode, 404);
  });

  it('a technician cannot either', async () => {
    assert.equal((await grant({ seatLimit: 500 }, 'tech@acme.example')).statusCode, 404);
  });

  it('refuses a company that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/companies/no-such-company/access',
      headers: auth(await tokenFor('ops@knowyourev.example')),
      payload: { seatLimit: 20 },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('adjusting limits mid-term', () => {
  const patch = async (body: Record<string, unknown>, as = 'ops@knowyourev.example') =>
    app.inject({
      method: 'PATCH',
      url: `/companies/${ACME}/limits`,
      headers: auth(await tokenFor(as)),
      payload: body,
    });

  it('raises seats', async () => {
    assert.equal((await patch({ seatLimit: 100 })).json().seatLimit, 100);
  });

  it('does not restart the term', async () => {
    const before = (await patch({ seatLimit: 100 })).json().expiresAt;
    const after = (await patch({ seatLimit: 200 })).json().expiresAt;
    assert.equal(before, after);
  });

  it('is refused to a company owner', async () => {
    assert.equal((await patch({ seatLimit: 100 }, 'owner@acme.example')).statusCode, 404);
  });

  it('refuses an empty change rather than doing nothing quietly', async () => {
    assert.equal((await patch({})).statusCode, 400);
  });
});

/**
 * A company owner about to add somebody needs to know whether they can, so
 * they can read their own entitlement — but nobody else's.
 */
describe('reading an entitlement', () => {
  const read = async (companyId: string, as: string) =>
    app.inject({
      method: 'GET',
      url: `/companies/${companyId}/entitlement`,
      headers: auth(await tokenFor(as)),
    });

  it('a company owner can read their own', async () => {
    const res = await read(ACME, 'owner@acme.example');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  it('it reports usage against each limit', async () => {
    const body = (await read(ACME, 'owner@acme.example')).json();
    assert.equal(body.seats.limit, 3);
    assert.equal(body.seats.used, 2);
    assert.equal(body.devices.limit, 2);
  });

  it('a technician cannot read it', async () => {
    assert.equal((await read(ACME, 'tech@acme.example')).statusCode, 404);
  });

  it('an administrator can read anyone’s', async () => {
    assert.equal((await read(ACME, 'ops@knowyourev.example')).statusCode, 200);
  });
});

/** The third gap: stored, displayed, and enforced nowhere. */
describe('the device limit', () => {
  const registerDevice = async (serial: string, as = 'owner@acme.example') =>
    app.inject({
      method: 'POST',
      url: '/devices',
      headers: auth(await tokenFor(as)),
      payload: { companyId: ACME, serial, hardwareRevision: 'rev-C', firmwareVersion: '1.4.2' },
    });

  it('allows gateways up to the plan', async () => {
    assert.equal((await registerDevice('KYE-1')).statusCode, 201);
    assert.equal((await registerDevice('KYE-2')).statusCode, 201);
  });

  it('refuses the one past it', async () => {
    await registerDevice('KYE-1');
    await registerDevice('KYE-2');

    const res = await registerDevice('KYE-3');
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /Device limit reached \(2\/2\)/);
  });

  /**
   * A revoked gateway is out of service. Holding a slot would mean a company
   * that lost a device had to raise its plan to replace it.
   */
  it('frees a slot when a gateway is revoked', async () => {
    const first = (await registerDevice('KYE-1')).json().id;
    await registerDevice('KYE-2');

    await app.inject({
      method: 'PATCH',
      url: `/devices/${first}/security`,
      headers: auth(await tokenFor('ops@knowyourev.example')),
      payload: { securityStatus: 'revoked' },
    });

    assert.equal((await registerDevice('KYE-3')).statusCode, 201);
  });

  it('a quarantined gateway still holds its slot', async () => {
    const first = (await registerDevice('KYE-1')).json().id;
    await registerDevice('KYE-2');

    await app.inject({
      method: 'PATCH',
      url: `/devices/${first}/security`,
      headers: auth(await tokenFor('ops@knowyourev.example')),
      payload: { securityStatus: 'quarantined' },
    });

    assert.equal((await registerDevice('KYE-3')).statusCode, 409);
  });

  it('follows the limit when an administrator raises it', async () => {
    await registerDevice('KYE-1');
    await registerDevice('KYE-2');

    await app.inject({
      method: 'PATCH',
      url: `/companies/${ACME}/limits`,
      headers: auth(await tokenFor('ops@knowyourev.example')),
      payload: { deviceLimit: 5 },
    });

    assert.equal((await registerDevice('KYE-3')).statusCode, 201);
  });
});

/**
 * The guest case: somebody brought in to help with a problem, taken off the
 * account when it is solved.
 */
describe('removing a user', () => {
  const remove = async (userId: string, as = 'owner@acme.example') =>
    app.inject({ method: 'DELETE', url: `/users/${userId}`, headers: auth(await tokenFor(as)) });

  it('a company owner can remove one of their own', async () => {
    const res = await remove('u-tech');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed, true);
    assert.equal(store.get('SELECT id FROM users WHERE id = ?', 'u-tech'), undefined);
  });

  it('frees the seat', async () => {
    await remove('u-tech');
    const res = await app.inject({
      method: 'GET',
      url: `/companies/${ACME}/entitlement`,
      headers: auth(await tokenFor('owner@acme.example')),
    });
    assert.equal(res.json().seats.used, 1);
  });

  it('signs them out immediately', async () => {
    const refreshToken = (await login('tech@acme.example')).json().refreshToken;
    await remove('u-tech');

    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    assert.notEqual(res.statusCode, 200);
  });

  /**
   * The audit ledger references its actor. A trail that cannot say who made a
   * change is not an audit trail, so somebody with history is suspended and
   * the caller is told which happened rather than being told "removed".
   */
  it('suspends rather than deletes somebody who has changed something', async () => {
    store.run(
      `INSERT INTO audit_events
       (id, company_id, actor_user_id, actor_role, source, result, occurred_at, recorded_at, seq)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      'e1', ACME, 'u-tech', 'user', 'local', 'success', Date.now(), Date.now()
    );

    const res = await remove('u-tech');
    assert.equal(res.json().removed, false);
    assert.equal(res.json().reason, 'has_history');
    assert.ok(store.get('SELECT id FROM users WHERE id = ?', 'u-tech'));
    assert.equal(
      store.get<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u-tech')?.status,
      'suspended'
    );
  });

  it('refuses to remove somebody in another company', async () => {
    seedCompany(store, 'rival', 'Rival', {}, Date.now());
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-rival', 'rival', 'x@rival.example', 'X', 'user', 'h', 'active', Date.now()
    );
    assert.equal((await remove('u-rival')).statusCode, 404);
  });

  it('refuses to remove an administrator', async () => {
    // A second administrator, so this is not caught by the self-removal rule.
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-admin-2', null, 'ops2@knowyourev.example', 'Ops Two', 'admin', 'h', 'active', Date.now()
    );
    assert.equal((await remove('u-admin-2', 'ops@knowyourev.example')).statusCode, 409);
  });

  /**
   * Enumerated because the first version of this hit a foreign key error on
   * anybody who had ever signed in — and its test passed, because the user in
   * it never had.
   */
  it('removes somebody who has signed in', async () => {
    await login('tech@acme.example');
    const res = await remove('u-tech');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().removed, true);
  });

  it('takes their live link with them', async () => {
    const token = await tokenFor('tech@acme.example');
    const battery = store.get<{ id: string }>('SELECT id FROM batteries LIMIT 1');
    if (battery) {
      await app.inject({
        method: 'POST',
        url: `/batteries/${battery.id}/session`,
        headers: auth(token),
      });
    }
    assert.equal((await remove('u-tech')).statusCode, 200);
    assert.equal(
      store.all('SELECT id FROM ble_sessions WHERE user_id = ?', 'u-tech').length,
      0
    );
  });

  it('refuses to remove yourself', async () => {
    assert.equal((await remove('u-owner', 'owner@acme.example')).statusCode, 403);
  });

  it('a technician cannot remove anybody', async () => {
    assert.equal((await remove('u-owner', 'tech@acme.example')).statusCode, 404);
  });
});

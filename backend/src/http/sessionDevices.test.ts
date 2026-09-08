import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { seedCompany } from '../db/testFixtures.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { liveSessions } from '../auth/sessionDevices.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';

/**
 * The concurrent-device cap over HTTP.
 *
 * Separate from sessionDevices.test.ts on purpose. That file proves the rule;
 * this one proves the real sign-in route applies it. Those are two different
 * changes, and a passing test of the first has more than once sat next to a
 * call site that never called it.
 */

const SECRET = secretFrom('a-session-device-signing-secret-yes!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ACME = 'company-acme';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64) Firefox/121.0';

let store: Store;
let app: FastifyInstance;
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  seedCompany(store, ACME, 'Acme EV', { seatLimit: 10 }, now);
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

const login = (email: string, userAgent = IPHONE, password = PASSWORD) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'user-agent': userAgent },
    payload: { email, password },
  });

const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

const adminToken = async () =>
  (await login('ops@knowyourev.example')).json().accessToken as string;

const setLimit = async (limit: number) =>
  app.inject({
    method: 'PATCH',
    url: `/companies/${ACME}/limits`,
    headers: { authorization: `Bearer ${await adminToken()}` },
    payload: { sessionDeviceLimit: limit },
  });

describe('signing the company account in on a third device', () => {
  it('lets two devices in', async () => {
    assert.equal((await login('owner@acme.example', IPHONE)).statusCode, 200);
    assert.equal((await login('owner@acme.example', MAC)).statusCode, 200);
    assert.equal(liveSessions(store, 'u-owner').length, 2);
  });

  /** The route must apply the cap, not merely be able to. */
  it('holds the account at two however many sign in', async () => {
    for (const agent of [IPHONE, MAC, WINDOWS, IPHONE, MAC]) {
      assert.equal((await login('owner@acme.example', agent)).statusCode, 200);
    }
    assert.equal(liveSessions(store, 'u-owner').length, 2);
  });

  it('succeeds rather than refusing the newest device', async () => {
    await login('owner@acme.example', IPHONE);
    await login('owner@acme.example', MAC);
    assert.equal((await login('owner@acme.example', WINDOWS)).statusCode, 200);
  });

  /** Signed out, and told so — a silent eviction is the useless half of this. */
  it('reports what it signed out', async () => {
    await login('owner@acme.example', IPHONE);
    await login('owner@acme.example', MAC);
    const third = await login('owner@acme.example', WINDOWS);

    const signedOut = third.json().signedOut as string[];
    assert.equal(signedOut.length, 1);
    assert.match(signedOut[0]!, /Safari on iPhone/);
  });

  it('says nothing was signed out when nothing was', async () => {
    assert.deepEqual((await login('owner@acme.example', IPHONE)).json().signedOut, []);
  });

  /** The evicted device stops working at its next renewal, not a fortnight on. */
  it('stops the evicted device renewing', async () => {
    const first = (await login('owner@acme.example', IPHONE)).json().refreshToken as string;
    await login('owner@acme.example', MAC);
    await login('owner@acme.example', WINDOWS);

    assert.equal((await refresh(first)).statusCode, 401);
  });

  it('leaves the two survivors renewing normally', async () => {
    await login('owner@acme.example', IPHONE);
    const second = (await login('owner@acme.example', MAC)).json().refreshToken as string;
    await login('owner@acme.example', WINDOWS);

    assert.equal((await refresh(second)).statusCode, 200);
  });

  /**
   * Renewing is the same device carrying on. If it counted as a new sign-in,
   * an owner's two devices would evict each other every fifteen minutes.
   */
  it('does not treat a renewal as a new device', async () => {
    const first = (await login('owner@acme.example', IPHONE)).json().refreshToken as string;
    const second = (await login('owner@acme.example', MAC)).json().refreshToken as string;

    const rotated = (await refresh(first)).json().refreshToken as string;
    assert.equal((await refresh(second)).statusCode, 200);
    assert.equal((await refresh(rotated)).statusCode, 200);
    assert.equal(liveSessions(store, 'u-owner').length, 2);
  });
});

/**
 * The cap must never be reachable by someone who cannot sign in. Otherwise a
 * stranger guessing at an owner's address could sign that owner out of every
 * device, over and over — a denial of service with no password required.
 */
describe('what a failed sign-in must not do', () => {
  it('signs nobody out on a wrong password', async () => {
    await login('owner@acme.example', IPHONE);
    await login('owner@acme.example', MAC);

    assert.equal((await login('owner@acme.example', WINDOWS, 'wrong-password')).statusCode, 401);
    assert.equal(liveSessions(store, 'u-owner').length, 2);
  });

  it('signs nobody out when the company’s plan has lapsed', async () => {
    await login('owner@acme.example', IPHONE);
    await login('owner@acme.example', MAC);
    store.run('UPDATE subscriptions SET renewal_date = ? WHERE company_id = ?', Date.now() - 1, ACME);

    assert.equal((await login('owner@acme.example', WINDOWS)).statusCode, 403);
    assert.equal(liveSessions(store, 'u-owner').length, 2);
  });
});

describe('who it applies to', () => {
  it('leaves a field user alone', async () => {
    for (const agent of [IPHONE, MAC, WINDOWS]) await login('tech@acme.example', agent);
    assert.equal(liveSessions(store, 'u-tech').length, 3);
  });

  it('leaves a platform administrator alone', async () => {
    for (const agent of [IPHONE, MAC, WINDOWS]) await login('ops@knowyourev.example', agent);
    assert.equal(liveSessions(store, 'u-admin').length, 3);
  });
});

describe('an administrator changing the cap', () => {
  it('lets more devices in once raised', async () => {
    assert.equal((await setLimit(4)).statusCode, 200);
    for (const agent of [IPHONE, MAC, WINDOWS, IPHONE]) await login('owner@acme.example', agent);
    assert.equal(liveSessions(store, 'u-owner').length, 4);
  });

  it('reports the cap and what is against it', async () => {
    await login('owner@acme.example', IPHONE);
    const response = await app.inject({
      method: 'GET',
      url: `/companies/${ACME}/entitlement`,
      headers: { authorization: `Bearer ${await adminToken()}` },
    });

    assert.deepEqual(response.json().sessionDevices, { used: 1, limit: 2 });
  });

  /**
   * The gateway limit counts knowyourEV hardware and this one counts phones.
   * Two different things called "device" is how they get conflated, so the
   * route must keep them apart.
   */
  it('does not move the gateway limit with it', async () => {
    await setLimit(9);
    const response = await app.inject({
      method: 'GET',
      url: `/companies/${ACME}/entitlement`,
      headers: { authorization: `Bearer ${await adminToken()}` },
    });

    const body = response.json();
    assert.equal(body.sessionDeviceLimit, 9);
    assert.equal(body.deviceLimit, 10);
  });

  it('is not something a company can raise for itself', async () => {
    const owner = (await login('owner@acme.example')).json().accessToken as string;
    const response = await app.inject({
      method: 'PATCH',
      url: `/companies/${ACME}/limits`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { sessionDeviceLimit: 50 },
    });

    assert.equal(response.statusCode, 404);
  });
});

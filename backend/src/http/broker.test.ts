import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { JBD_SP24S004, seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';
import { createTestStore, seedCompany } from '../db/testFixtures.js';

/**
 * Assisted remote control over HTTP, driven the way the admin console and the
 * technician's app actually would.
 */

const SECRET = secretFrom('a-broker-integration-signing-secret!!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const REASON = 'Vendor bulletin 2026-114';

const ACME = 'company-acme';
const BATTERY = 'bat-acme';

let store: Store;
let app: FastifyInstance;

const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = await createTestStore();
  await seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  await seedCompany(store, ACME, 'Acme EV', now);
  await store.run(
    `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    BATTERY, ACME, 'BAT-ACME-1', 'LiFePO4', 24, JBD_SP24S004, now
  );
  for (const [id, company, email, role] of [
    ['u-admin', ACME, 'admin@acme.example', 'company'],
    ['u-tech', ACME, 'tech@acme.example', 'user'],
    ['u-tech-2', ACME, 'tech2@acme.example', 'user'],
  ] as const) {
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, company, email, role, role, hash, 'active', now
    );
  }

  app = buildServer({ store, secret: SECRET, dispatcher, loginLimiter: createLimiter(50, 60_000) });
});

afterEach(() => store.close());

const tokenFor = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  return (res.json() as { accessToken: string }).accessToken;
};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const openTicket = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/support-sessions',
    headers: auth(token),
    payload: { batteryId: BATTERY },
  });

const issue = (token: string, sessionId: string, body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/support-sessions/${sessionId}/commands`,
    headers: auth(token),
    payload: { parameterKey: 'cell_ovp', value: 3.8, reason: REASON, ...body },
  });

const goOnSite = (token: string) =>
  app.inject({ method: 'POST', url: `/batteries/${BATTERY}/session`, headers: auth(token) });

const claim = (token: string) =>
  app.inject({ method: 'POST', url: `/batteries/${BATTERY}/commands/claim`, headers: auth(token) });

describe('support sessions over HTTP', () => {
  it('an administrator can open one', async () => {
    const res = await openTicket(await tokenFor('admin@acme.example'));
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().supportSessionId);
  });

  it('a technician cannot', async () => {
    const res = await openTicket(await tokenFor('tech@acme.example'));
    assert.equal(res.statusCode, 403);
  });

  it('closing reports how much queued work it voided', async () => {
    const token = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(token)).json();
    await issue(token, supportSessionId, {});
    await issue(token, supportSessionId, { parameterKey: 'balance_start_v', value: 3.4 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/support-sessions/${supportSessionId}`,
      headers: auth(token),
      payload: { outcome: 'resolved' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cancelledCommands, 2);
  });

  it('returns 409 for a command on a closed session', async () => {
    const token = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(token)).json();
    await app.inject({
      method: 'PATCH',
      url: `/support-sessions/${supportSessionId}`,
      headers: auth(token),
      payload: { outcome: 'resolved' },
    });
    const res = await issue(token, supportSessionId, {});
    assert.equal(res.statusCode, 409);
  });

  it('returns 422 for a policy refusal', async () => {
    const token = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(token)).json();
    const res = await issue(token, supportSessionId, { value: 4.2 });
    assert.equal(res.statusCode, 422);
  });

  it('returns 404 for someone else’s session', async () => {
    const admin = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    const res = await issue(await tokenFor('tech@acme.example'), supportSessionId, {});
    assert.equal(res.statusCode, 404);
  });
});

/**
 * The full Mode 1 path, end to end: an administrator issues a change, it waits
 * in the cloud, and it only moves once a technician is physically present.
 */
describe('the whole assisted-write journey', () => {
  it('queues, waits for a technician, delivers, and lands in the audit trail', async () => {
    const admin = await tokenFor('admin@acme.example');
    const tech = await tokenFor('tech@acme.example');

    // 1. Admin opens a session and issues a change. Nobody is on site.
    const { supportSessionId } = (await openTicket(admin)).json();
    const issued = await issue(admin, supportSessionId, { value: 3.8 });
    assert.equal(issued.statusCode, 202);
    assert.equal(issued.json().disposition, 'queued');

    // 2. The technician's app asks for work before connecting: nothing doing.
    assert.deepEqual((await claim(tech)).json().commands, []);

    // 3. The technician arrives and links to the pack.
    assert.equal((await goOnSite(tech)).statusCode, 200);

    // 4. Now the command is collectable.
    const claimed = (await claim(tech)).json().commands;
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].parameter_key, 'cell_ovp');

    // 5. The app performs it over BLE and reports what the BMS did.
    const reported = await app.inject({
      method: 'POST',
      url: `/commands/${claimed[0].id}/result`,
      headers: auth(tech),
      payload: { result: 'success' },
    });
    assert.equal(reported.statusCode, 200);

    // 6. The change is attributable to the administrator who asked for it.
    const audit = (await app.inject({ method: 'GET', url: '/audit', headers: auth(admin) })).json();
    const completion = audit.events.find((e: { result: string }) => e.result === 'success');
    assert.equal(completion.actor_user_id, 'u-admin');
    assert.equal(completion.source, 'admin_remote');
    assert.equal(completion.support_session_id, supportSessionId);
  });

  /** The technician sees the change without ever being asked to approve it. */
  it('never asks the technician for approval', async () => {
    const admin = await tokenFor('admin@acme.example');
    const tech = await tokenFor('tech@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    await goOnSite(tech);
    await issue(admin, supportSessionId, {});

    // Claiming is collection, not consent: there is no accept/reject step.
    const claimed = (await claim(tech)).json().commands;
    assert.equal(claimed.length, 1);
    assert.ok(!('approved' in claimed[0]));
  });
});

describe('Mode 1 over HTTP', () => {
  it('hands out nothing while nobody is on site', async () => {
    const admin = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    await issue(admin, supportSessionId, {});
    assert.deepEqual((await claim(await tokenFor('tech@acme.example'))).json().commands, []);
  });

  /** Force Push jumps the queue; it does not conjure a technician. */
  it('will not deliver a Force Push to an empty site', async () => {
    const admin = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    const issued = await issue(admin, supportSessionId, { forcePush: true });
    assert.equal(issued.json().disposition, 'queued');
    assert.deepEqual((await claim(await tokenFor('tech@acme.example'))).json().commands, []);
  });

  it('delivers a Force Push ahead of older work once someone arrives', async () => {
    const admin = await tokenFor('admin@acme.example');
    const tech = await tokenFor('tech@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    await issue(admin, supportSessionId, { parameterKey: 'balance_start_v', value: 3.4 });
    await issue(admin, supportSessionId, { forcePush: true });

    await goOnSite(tech);
    const claimed = (await claim(tech)).json().commands;
    assert.equal(claimed[0].parameter_key, 'cell_ovp');
    assert.equal(claimed[0].force_push, 1);
  });

  it('gives a different technician nothing', async () => {
    const admin = await tokenFor('admin@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    await issue(admin, supportSessionId, {});
    await goOnSite(await tokenFor('tech@acme.example'));
    // tech-2 holds no session of their own, so collects nothing.
    assert.deepEqual((await claim(await tokenFor('tech2@acme.example'))).json().commands, []);
  });

  it('hands a command out exactly once', async () => {
    const admin = await tokenFor('admin@acme.example');
    const tech = await tokenFor('tech@acme.example');
    const { supportSessionId } = (await openTicket(admin)).json();
    await issue(admin, supportSessionId, {});
    await goOnSite(tech);
    assert.equal((await claim(tech)).json().commands.length, 1);
    assert.equal((await claim(tech)).json().commands.length, 0);
  });
});

describe('every broker route needs authentication', () => {
  const routes: [string, string][] = [
    ['POST', '/support-sessions'],
    ['GET', '/support-sessions'],
    ['PATCH', '/support-sessions/anything'],
    ['POST', '/support-sessions/anything/commands'],
    ['POST', `/batteries/${BATTERY}/commands/claim`],
    ['POST', '/commands/anything/result'],
    ['GET', '/commands'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url} refuses an anonymous caller`, async () => {
      const res = await app.inject({ method: method as 'GET', url, payload: {} });
      assert.equal(res.statusCode, 401);
    });
  }
});

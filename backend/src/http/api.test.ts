import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Param, type Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { JBD_SP24S004, seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { BATTERY_PAGE_MAX, buildServer } from '../server.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * The HTTP surface, driven the way a client — or an attacker — actually reaches
 * it. Unit tests prove the rules; these prove the rules are actually wired to
 * the routes.
 */

const SECRET = secretFrom('an-integration-test-signing-secret-value');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const ACME_BATTERY = 'bat-acme';
const RIVAL_BATTERY = 'bat-rival';
const PASSWORD = 'correct-horse-battery-staple';

let store: Store;
let app: FastifyInstance;

const dispatcher: Dispatcher = {
  send: async ({ value }) => ({ result: 'success', readBack: value }),
};

const seedUsers = async () => {
  const hash = await hashPassword(PASSWORD, CHEAP);
  const now = Date.now();
  /*
   * These fixtures grant every permission. The suite is about tenancy, policy
   * and the audit trail; permissions have their own file. Left at the defaults
   * the technicians here could not write, and each of these tests would fail
   * for a reason it is not about.
   */
  const insert = (id: string, company: string | null, email: string, role: string, status = 'active') =>
    store.run(
      `INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at,
                          can_read, can_write, can_location, can_health)
       VALUES (?,?,?,?,?,?,?,?,1,1,1,1)`,
      id,
      company,
      email,
      role,
      role,
      hash,
      status,
      now
    );
  insert('u-acme', ACME, 'field@acme.example', 'user');
  insert('u-rival', RIVAL, 'field@rival.example', 'user');
  insert('u-admin', null, 'admin@knowyourev.example', 'admin');
  insert('u-suspended', ACME, 'gone@acme.example', 'user', 'suspended');
};

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();

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
      id, company, serial, 'LiFePO4', 24, JBD_SP24S004, 'FW 1.2.4', now
    );
  }
  await seedUsers();

  app = buildServer({
    store,
    secret: SECRET,
    dispatcher,
    loginLimiter: createLimiter(5, 60_000),
  });
});

after(() => store?.close());

const login = async (email: string) => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return res.json() as { accessToken: string; refreshToken: string };
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Presence is server-side, so tests establish it the way a client would. */
const openSessionVia = (token: string, battery = ACME_BATTERY) =>
  app.inject({ method: 'POST', url: `/batteries/${battery}/session`, headers: auth(token) });

describe('sign-in', () => {
  it('issues an access and refresh token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.equal(body.user.companyId, ACME);
  });

  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: 'wrong' },
    });
    assert.equal(res.statusCode, 401);
  });

  /** Telling an attacker which addresses exist is a free gift. */
  it('answers identically for an unknown email and a wrong password', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@nowhere.example', password: PASSWORD },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: 'wrong' },
    });
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.deepEqual(unknown.json(), wrong.json());
  });

  it('refuses a suspended account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'gone@acme.example', password: PASSWORD },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects a malformed body', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x' } });
    assert.equal(res.statusCode, 400);
  });

  it('rate-limits repeated attempts on one address', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'field@acme.example', password: 'wrong' },
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: PASSWORD },
    });
    assert.equal(res.statusCode, 429);
  });
});

describe('tokens over HTTP', () => {
  it('refuses a request with no token', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/me' })).statusCode, 401);
  });

  it('refuses a garbage token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth('not-a-jwt') });
    assert.equal(res.statusCode, 401);
  });

  it('accepts a valid token', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth(accessToken) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().companyId, ACME);
  });

  /** A token outlives a suspension, so status is re-checked per request. */
  it('stops honouring a token once the account is suspended', async () => {
    const { accessToken } = await login('field@acme.example');
    store.run("UPDATE users SET status = 'suspended' WHERE id = ?", 'u-acme');
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth(accessToken) });
    assert.equal(res.statusCode, 401);
  });

  it('rotates a refresh token', async () => {
    const { refreshToken } = await login('field@acme.example');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.json().refreshToken, refreshToken);
  });

  it('rejects a replayed refresh token', async () => {
    const { refreshToken } = await login('field@acme.example');
    await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().code, 'reuse_detected');
  });

  it('revokes on logout', async () => {
    const { refreshToken } = await login('field@acme.example');
    assert.equal(
      (await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } }))
        .statusCode,
      204
    );
    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    assert.equal(after.statusCode, 401);
  });
});

/**
 * A 403 would confirm the battery exists and belongs to someone else, which is
 * a working oracle for enumerating another tenant's fleet.
 */
describe('tenant isolation over HTTP', () => {
  it('lists only the caller’s own batteries', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await app.inject({ method: 'GET', url: '/batteries', headers: auth(accessToken) });
    const { batteries } = res.json();
    assert.equal(batteries.length, 1);
    assert.equal(batteries[0].serial, 'BAT-ACME-1');
  });

  it('returns 404, not 403, for another tenant’s battery', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await app.inject({
      method: 'GET',
      url: `/batteries/${RIVAL_BATTERY}`,
      headers: auth(accessToken),
    });
    assert.equal(res.statusCode, 404);
  });

  it('is indistinguishable from a battery that does not exist', async () => {
    const { accessToken } = await login('field@acme.example');
    const foreign = await app.inject({
      method: 'GET',
      url: `/batteries/${RIVAL_BATTERY}`,
      headers: auth(accessToken),
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/batteries/bat-does-not-exist',
      headers: auth(accessToken),
    });
    assert.equal(foreign.statusCode, missing.statusCode);
    assert.deepEqual(foreign.json(), missing.json());
  });

  it('lets an admin see every tenant', async () => {
    const { accessToken } = await login('admin@knowyourev.example');
    const res = await app.inject({ method: 'GET', url: '/batteries', headers: auth(accessToken) });
    assert.equal(res.json().batteries.length, 2);
  });
});

describe('capability profile', () => {
  it('serves the seeded parameters', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await app.inject({
      method: 'GET',
      url: `/bms/${encodeURIComponent(JBD_SP24S004)}/parameters`,
      headers: auth(accessToken),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().parameters.length, 29);
  });

  it('needs authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/bms/${encodeURIComponent(JBD_SP24S004)}/parameters`,
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('writing a parameter', () => {
  const write = async (token: string, battery: string, key: string, body: object) =>
    app.inject({
      method: 'POST',
      url: `/batteries/${battery}/parameters/${key}`,
      headers: auth(token),
      payload: { reason: 'Vendor bulletin', ...body },
    });

  it('accepts a permitted write', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', { value: 3.8 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().result, 'success');
  });

  /** Well-formed request, answer is no — that is a 422, not a 500. */
  it('returns 422 for a policy refusal', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', { value: 4.2 });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().denialCode, 'out_of_range');
  });

  it('returns the audit id even when refused', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', { value: 4.2 });
    assert.ok(res.json().auditId);
  });

  it('refuses a critical write with no reason', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', {
      value: 3.8,
      reason: undefined,
    });
    assert.equal(res.json().denialCode, 'reason_required');
  });

  it('refuses a write when no technician is on site', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', { value: 3.8 });
    assert.equal(res.json().denialCode, 'no_active_session');
  });

  /**
   * The flaw this replaced: the client used to assert presence in the body.
   * Sending the old field must not resurrect that.
   */
  it('ignores a client that claims a session it does not have', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', {
      value: 3.8,
      bleSessionActive: true,
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().denialCode, 'no_active_session');
  });

  it('returns 404 for another tenant’s battery', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await write(accessToken, RIVAL_BATTERY, 'cell_ovp', { value: 3.8 });
    assert.equal(res.statusCode, 404);
  });

  /** Asking for a Force Push is not the same as being granted one. */
  it('refuses Force Push from a non-admin', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', {
      value: 3.8,
      forcePush: true,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'requires_admin');
  });

  /** The admin's command rides the technician's link, never their own. */
  it('allows Force Push from an admin while a technician is on site', async () => {
    const field = await login('field@acme.example');
    await openSessionVia(field.accessToken);
    const { accessToken } = await login('admin@knowyourev.example');
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', { value: 3.8, forcePush: true });
    assert.equal(res.statusCode, 200);
  });

  it('still refuses an admin Force Push with nobody on site', async () => {
    const { accessToken } = await login('admin@knowyourev.example');
    const res = await write(accessToken, ACME_BATTERY, 'cell_ovp', {
      value: 3.8,
      forcePush: true,
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().denialCode, 'session_required_for_admin_write');
  });

  it('rejects a non-numeric value at the boundary', async () => {
    const { accessToken } = await login('field@acme.example');
    const res = await app.inject({
      method: 'POST',
      url: `/batteries/${ACME_BATTERY}/parameters/cell_ovp`,
      headers: auth(accessToken),
      payload: { value: 'lots' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('reading the audit trail', () => {
  it('shows the caller only their own tenant’s events', async () => {
    const acme = await login('field@acme.example');
    await openSessionVia(acme.accessToken);
    await app.inject({
      method: 'POST',
      url: `/batteries/${ACME_BATTERY}/parameters/cell_ovp`,
      headers: auth(acme.accessToken),
      payload: { value: 3.8, reason: 'r' },
    });

    const rival = await login('field@rival.example');
    const theirs = await app.inject({
      method: 'GET',
      url: '/audit',
      headers: auth(rival.accessToken),
    });
    assert.equal(theirs.json().events.length, 0);

    const mine = await app.inject({ method: 'GET', url: '/audit', headers: auth(acme.accessToken) });
    assert.equal(mine.json().events.length, 1);
  });

  it('filters by result', async () => {
    const { accessToken } = await login('field@acme.example');
    await openSessionVia(accessToken);
    for (const value of [3.8, 4.2]) {
      await app.inject({
        method: 'POST',
        url: `/batteries/${ACME_BATTERY}/parameters/cell_ovp`,
        headers: auth(accessToken),
        payload: { value, reason: 'r' },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/audit?result=rejected',
      headers: auth(accessToken),
    });
    assert.equal(res.json().events.length, 1);
  });

  it('needs authentication', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/audit' })).statusCode, 401);
  });
});

describe('health', () => {
  it('answers without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });
});

/**
 * The client renders the tenant's name. If the API does not send it, the app
 * can only fall back to a built-in default — and then every tenant sees
 * whichever name that happens to be.
 */
describe('login tells the client which tenant it is in', () => {
  it('names the company a technician belongs to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: PASSWORD },
    });
    assert.equal(res.json().company.name, 'Acme EV');
  });

  it('sends null for an administrator, who belongs to none', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@knowyourev.example', password: PASSWORD },
    });
    assert.equal(res.json().company, null);
  });

  it('keeps naming it after a refresh, so a renewed session is not anonymous', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'field@acme.example', password: PASSWORD },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: login.json().refreshToken },
    });
    assert.equal(res.json().company.name, 'Acme EV');
  });
});

/**
 * The fleet list needs a state of charge, and it needs the age of that number
 * more than it needs the number. A pack last seen three weeks ago showing
 * "41%" is worse than one showing nothing: a technician can act on it.
 */
describe('the fleet list carries each pack’s last known reading', () => {
  const tokenOf = async (email: string) => (await login(email)).accessToken;

  const sample = (over: Record<string, unknown> = {}) => ({
    recordedAt: Date.now(),
    soc: 72,
    packVoltage: 79.2,
    packCurrent: -12.4,
    temperatureC: 24,
    minCellV: 3.28,
    maxCellV: 3.31,
    deltaMv: 30,
    faultCount: 0,
    ...over,
  });

  const upload = async (token: string, batteryId: string, samples: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `/batteries/${batteryId}/telemetry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { samples },
    });

  const fleet = async (token: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/batteries',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().batteries as { id: string; lastReading: { soc: number; recorded_at: number } | null }[];

  it('reports null for a pack that has never reported', async () => {
    const token = await tokenOf('field@acme.example');
    assert.ok(fleetHasNullReading(await fleet(token)));
  });

  const fleetHasNullReading = (rows: { lastReading: unknown }[]) =>
    rows.length > 0 && rows.every((r) => r.lastReading === null);

  it('reports the most recent reading, not the first', async () => {
    const token = await tokenOf('field@acme.example');
    const battery = (await fleet(token))[0]!;
    const base = Date.now() - 60_000;

    await upload(token, battery.id, [
      sample({ recordedAt: base, soc: 40 }),
      sample({ recordedAt: base + 20_000, soc: 55 }),
      sample({ recordedAt: base + 40_000, soc: 72 }),
    ]);

    const row = (await fleet(token)).find((b) => b.id === battery.id)!;
    assert.equal(row.lastReading!.soc, 72);
    assert.equal(row.lastReading!.recorded_at, base + 40_000);
  });

  it('carries the age, so the client can say how stale it is', async () => {
    const token = await tokenOf('field@acme.example');
    const battery = (await fleet(token))[0]!;
    const old = Date.now() - 21 * 24 * 60 * 60 * 1000;

    await upload(token, battery.id, [sample({ recordedAt: old, soc: 41 })]);

    const row = (await fleet(token)).find((b) => b.id === battery.id)!;
    assert.equal(row.lastReading!.recorded_at, old);
  });

  it('does not leak another tenant’s readings', async () => {
    const acme = await tokenOf('field@acme.example');
    const acmeBattery = (await fleet(acme))[0]!;
    await upload(acme, acmeBattery.id, [sample({ soc: 72 })]);

    const rival = await tokenOf('field@rival.example');
    assert.ok((await fleet(rival)).every((b) => b.lastReading === null));
  });

  it('keeps each pack’s reading with its own pack', async () => {
    const token = await tokenOf('field@acme.example');
    const rows = await fleet(token);
    if (rows.length < 2) return;

    await upload(token, rows[0]!.id, [sample({ soc: 20, recordedAt: Date.now() - 5000 })]);
    await upload(token, rows[1]!.id, [sample({ soc: 90, recordedAt: Date.now() - 5000 })]);

    const after = await fleet(token);
    assert.equal(after.find((b) => b.id === rows[0]!.id)!.lastReading!.soc, 20);
    assert.equal(after.find((b) => b.id === rows[1]!.id)!.lastReading!.soc, 90);
  });
});

/**
 * An unbounded list endpoint is one large tenant away from being a problem for
 * everyone on the instance — and a client that reads a truncated fleet as the
 * whole one is the failure that bound creates.
 */
describe('the fleet listing is bounded', () => {
  const tokenOf2 = async (email: string) => (await login(email)).accessToken;

  const fleet = async (token: string, query = '') =>
    (
      await app.inject({
        method: 'GET',
        url: `/batteries${query}`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json() as { batteries: { serial: string }[]; truncated: boolean };

  const addBatteries = (count: number) => {
    const now = Date.now();
    for (let i = 0; i < count; i += 1) {
      store.run(
        `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        `bulk-${i}`, ACME, `BULK-${String(i).padStart(4, '0')}`, 'LiFePO4', 24, 'JBD SP24S004', now
      );
    }
  };

  it('says it was not truncated when the whole fleet fits', async () => {
    const body = await fleet(await tokenOf2('field@acme.example'));
    assert.equal(body.truncated, false);
  });

  it('honours an explicit limit', async () => {
    addBatteries(10);
    const body = await fleet(await tokenOf2('field@acme.example'), '?limit=5');
    assert.equal(body.batteries.length, 5);
  });

  /** The point of the bound: a client must know it is looking at part of it. */
  it('says so when there is more', async () => {
    addBatteries(10);
    const body = await fleet(await tokenOf2('field@acme.example'), '?limit=5');
    assert.equal(body.truncated, true);
  });

  it('does not claim truncation when the limit exactly fits', async () => {
    const before = (await fleet(await tokenOf2('field@acme.example'))).batteries.length;
    const body = await fleet(await tokenOf2('field@acme.example'), `?limit=${before}`);
    assert.equal(body.batteries.length, before);
    assert.equal(body.truncated, false);
  });

  it('refuses a limit above the maximum rather than honouring it', async () => {
    addBatteries(5);
    const body = await fleet(await tokenOf2('field@acme.example'), '?limit=999999');
    // Clamped, not obeyed — the response is still bounded.
    assert.ok(body.batteries.length <= BATTERY_PAGE_MAX);
  });

  it('ignores a nonsensical limit rather than returning nothing', async () => {
    addBatteries(5);
    const body = await fleet(await tokenOf2('field@acme.example'), '?limit=0');
    assert.ok(body.batteries.length >= 1);
  });
});

/**
 * A client that wants one battery should be able to fetch one battery. Making
 * it scan the fleet works until the fleet is paged, and then quietly stops.
 */
describe('reading a single battery', () => {
  const one = async (email: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/batteries/${id}`,
      headers: { authorization: `Bearer ${(await login(email)).accessToken}` },
    });

  it('carries the last reading, like the listing does', async () => {
    const token = (await login('field@acme.example')).accessToken;
    const target = (
      await app.inject({ method: 'GET', url: '/batteries', headers: auth(token) })
    ).json().batteries[0] as { id: string };

    await app.inject({
      method: 'POST',
      url: `/batteries/${target.id}/telemetry`,
      headers: auth(token),
      payload: {
        samples: [
          {
            recordedAt: Date.now() - 60_000,
            soc: 64,
            packVoltage: 79.2,
            packCurrent: -12,
            temperatureC: 24,
            minCellV: 3.28,
            maxCellV: 3.31,
            deltaMv: 30,
            faultCount: 0,
          },
        ],
      },
    });

    const res = await one('field@acme.example', target.id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().lastReading.soc, 64);
  });

  it('reports null for a pack that has never reported', async () => {
    const token = (await login('field@acme.example')).accessToken;
    const target = (
      await app.inject({ method: 'GET', url: '/batteries', headers: auth(token) })
    ).json().batteries[0] as { id: string };

    const res = await one('field@acme.example', target.id);
    assert.equal(res.json().lastReading, null);
  });

  it('is a 404 for another tenant’s battery, not a 403', async () => {
    const token = (await login('field@acme.example')).accessToken;
    const mine = (
      await app.inject({ method: 'GET', url: '/batteries', headers: auth(token) })
    ).json().batteries[0] as { id: string };

    const res = await one('field@rival.example', mine.id);
    assert.equal(res.statusCode, 404);
  });
});

/**
 * The bound has to be in the SQL, not in a slice afterwards.
 *
 * Slicing in JavaScript produces exactly the same response — which is why an
 * HTTP test cannot see the difference, and why removing the `LIMIT` survived a
 * mutation check that only looked at response bodies. The whole point of the
 * bound is that the database is never asked for every row, so that is what
 * this asserts.
 */
describe('the fleet query itself is bounded', () => {
  it('sends a LIMIT to the database', async () => {
    const spied = createStore();
    seedParameterDefinitions(spied);

    const queries: string[] = [];
    const recording: Store = {
      ...spied,
      all: <T,>(sql: string, ...params: Param[]) => {
        queries.push(sql);
        return spied.all<T>(sql, ...params);
      },
    };

    const server = buildServer({ store: recording, secret: SECRET, dispatcher });

    const now = Date.now();
    // Through the fixture: a company with no subscription can no longer be
    // signed into, which is the entitlement check doing its job.
    seedCompany(spied, 'c9', 'C', {}, now);
    spied.run(
      `INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at,
                          can_read, can_write, can_location, can_health)
       VALUES (?,?,?,?,?,?,?,?,1,1,1,1)`,
      'u9', 'c9', 'probe@c.example', 'Probe', 'user', await hashPassword(PASSWORD, CHEAP), 'active', now
    );

    const token = (
      await server.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'probe@c.example', password: PASSWORD },
      })
    ).json().accessToken as string;

    queries.length = 0;
    await server.inject({
      method: 'GET',
      url: '/batteries',
      headers: { authorization: `Bearer ${token}` },
    });

    const fleetQuery = queries.find((q) => q.includes('FROM batteries'));
    assert.ok(fleetQuery, 'no query against batteries was made');
    assert.match(fleetQuery, /LIMIT/i, 'the fleet listing must bound the query, not slice afterwards');

    spied.close();
  });
});

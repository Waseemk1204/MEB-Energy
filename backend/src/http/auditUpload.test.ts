import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { JBD_SP24S004, seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer, clientAuditEvent } from '../server.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Uploading writes a technician performed on site, over BLE, offline.
 */

const SECRET = secretFrom('an-audit-upload-signing-secret!!!!!!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const BATTERY = 'bat-acme';
const RIVAL_BATTERY = 'bat-rival';

let store: Store;
let app: FastifyInstance;

const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  for (const [id, name] of [[ACME, 'Acme EV'], [RIVAL, 'Rival Ltd']] as const) {
    seedCompany(store, id, name, now);
  }
  for (const [id, company, serial] of [
    [BATTERY, ACME, 'BAT-ACME-1'],
    [RIVAL_BATTERY, RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    store.run(
      `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      id, company, serial, 'LiFePO4', 24, JBD_SP24S004, now
    );
  }
  for (const [id, company, email, role] of [
    ['u-tech', ACME, 'tech@acme.example', 'user'],
    ['u-tech-2', ACME, 'tech2@acme.example', 'user'],
    ['u-rival', RIVAL, 'tech@rival.example', 'user'],
  ] as const) {
    store.run(
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

const event = (over: Record<string, unknown> = {}) => ({
  clientEventId: 'evt-00000001',
  parameterKey: 'cell_ovp',
  oldValue: '3.75',
  newValue: '3.80',
  result: 'success',
  occurredAt: Date.now() - 60_000,
  appVersion: '1.0.0',
  ...over,
});

const upload = (token: string, events: unknown[], battery = BATTERY) =>
  app.inject({
    method: 'POST',
    url: `/batteries/${battery}/audit`,
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  });

const rows = () =>
  store.all<{ id: string; source: string; actor_user_id: string; company_id: string; occurred_at: number; recorded_at: number; client_event_id: string | null }>(
    'SELECT * FROM audit_events ORDER BY seq'
  );

describe('uploading on-site writes', () => {
  it('stores an event the app recorded itself', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), [event()]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().stored, 1);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0]!.source, 'local');
  });

  it('accepts a batch', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), [
      event({ clientEventId: 'evt-1000000a' }),
      event({ clientEventId: 'evt-1000000b' }),
      event({ clientEventId: 'evt-1000000c' }),
    ]);
    assert.equal(res.json().stored, 3);
  });

  it('records refused and timed-out attempts, not only successes', async () => {
    await upload(await tokenFor('tech@acme.example'), [
      event({ clientEventId: 'evt-2000000a', result: 'rejected' }),
      event({ clientEventId: 'evt-2000000b', result: 'timeout' }),
      event({ clientEventId: 'evt-2000000c', result: 'indeterminate' }),
    ]);
    assert.deepEqual(
      store.all<{ result: string }>('SELECT result FROM audit_events ORDER BY seq').map((r) => r.result),
      ['rejected', 'timeout', 'indeterminate']
    );
  });

  /**
   * The technician's clock and the server's are different facts. An event
   * uploaded three hours late did not happen three hours late.
   */
  it('keeps when it happened apart from when it arrived', async () => {
    const happened = Date.now() - 3 * 60 * 60 * 1000;
    await upload(await tokenFor('tech@acme.example'), [event({ occurredAt: happened })]);
    const row = rows()[0]!;
    assert.equal(row.occurred_at, happened);
    assert.ok(row.recorded_at > happened + 60_000);
  });

  /** A wrong device clock must not be able to reorder the ledger. */
  it('orders by arrival, not by the device’s claim about the past', async () => {
    const token = await tokenFor('tech@acme.example');
    await upload(token, [event({ clientEventId: 'evt-late00001', occurredAt: 1_000_000 })]);
    await upload(token, [event({ clientEventId: 'evt-early0001', occurredAt: 2_000_000 })]);
    assert.deepEqual(rows().map((r) => r.client_event_id), ['evt-late00001', 'evt-early0001']);
  });
});

describe('retrying an upload', () => {
  /**
   * The technician most likely to retry is the one with the worst signal.
   * A duplicate here would be a change recorded twice in the ledger.
   */
  it('does not store the same event twice', async () => {
    const token = await tokenFor('tech@acme.example');
    const first = await upload(token, [event()]);
    const second = await upload(token, [event()]);

    assert.equal(rows().length, 1);
    assert.equal(second.json().stored, 0);
    assert.equal(second.json().duplicates, 1);
    assert.equal(second.json().accepted[0].auditId, first.json().accepted[0].auditId);
    assert.equal(second.json().accepted[0].duplicate, true);
  });

  it('stores the new events in a batch that partly repeats an earlier one', async () => {
    const token = await tokenFor('tech@acme.example');
    await upload(token, [event({ clientEventId: 'evt-3000000a' })]);
    const res = await upload(token, [
      event({ clientEventId: 'evt-3000000a' }),
      event({ clientEventId: 'evt-3000000b' }),
    ]);
    assert.equal(res.json().stored, 1);
    assert.equal(res.json().duplicates, 1);
    assert.equal(rows().length, 2);
  });

  it('reports each event’s stored id so the app can retire it with certainty', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), [
      event({ clientEventId: 'evt-4000000a' }),
      event({ clientEventId: 'evt-4000000b' }),
    ]);
    const accepted = res.json().accepted as { clientEventId: string; auditId: string }[];
    assert.deepEqual(accepted.map((a) => a.clientEventId), ['evt-4000000a', 'evt-4000000b']);
    assert.ok(accepted.every((a) => typeof a.auditId === 'string' && a.auditId.length > 0));
  });

  /** Two tenants' apps may generate the same id; neither may see the other. */
  it('scopes the duplicate check to the tenant', async () => {
    await upload(await tokenFor('tech@acme.example'), [event({ clientEventId: 'evt-collide01' })]);
    const res = await upload(
      await tokenFor('tech@rival.example'),
      [event({ clientEventId: 'evt-collide01' })],
      RIVAL_BATTERY
    );
    assert.equal(res.json().stored, 1);
    assert.equal(rows().length, 2);
  });
});

/**
 * These properties are enforced in two places, and it is worth being precise
 * about which one does the work: the request schema **strips** unknown keys,
 * so `actorUserId` and `source` cannot reach the handler at all. The handler's
 * explicit assignment from the token is a second layer behind that.
 *
 * The stripping is tested directly below, because it is the layer that would
 * actually be removed — by someone adding a field to the schema, or relaxing
 * it — and a behavioural test alone cannot see the difference.
 */
describe('what the payload is not allowed to decide', () => {
  it('strips fields the client must not control before they reach the handler', () => {
    const parsed = clientAuditEvent.parse({
      ...event(),
      actorUserId: 'u-tech-2',
      actorRole: 'admin',
      companyId: RIVAL,
      source: 'admin_force_push',
      batteryId: RIVAL_BATTERY,
      recordedAt: 1,
      seq: 999,
    });
    for (const forbidden of [
      'actorUserId',
      'actorRole',
      'companyId',
      'source',
      'batteryId',
      'recordedAt',
      'seq',
    ]) {
      assert.ok(!(forbidden in parsed), `${forbidden} must not survive parsing`);
    }
  });

  it('attributes the event to the token’s user, not the body’s', async () => {
    await upload(await tokenFor('tech@acme.example'), [
      event({ actorUserId: 'u-tech-2', companyId: RIVAL }),
    ]);
    assert.equal(rows()[0]!.actor_user_id, 'u-tech');
    assert.equal(rows()[0]!.company_id, ACME);
  });

  /** An app must not be able to file a change as an administrator's push. */
  it('files every uploaded event as a local write', async () => {
    await upload(await tokenFor('tech@acme.example'), [
      event({ source: 'admin_force_push' }),
    ]);
    assert.equal(rows()[0]!.source, 'local');
  });

  it('refuses an upload against another tenant’s battery', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), [event()], RIVAL_BATTERY);
    assert.equal(res.statusCode, 404);
    assert.equal(rows().length, 0);
  });

  it('refuses an anonymous upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/batteries/${BATTERY}/audit`,
      payload: { events: [event()] },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects an empty batch rather than treating it as success', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), []);
    assert.equal(res.statusCode, 400);
  });

  it('rejects a result the ledger does not define', async () => {
    const res = await upload(await tokenFor('tech@acme.example'), [event({ result: 'maybe' })]);
    assert.equal(res.statusCode, 400);
  });
});

describe('uploaded events reach the audit trail', () => {
  it('shows up in GET /audit for the technician’s own company', async () => {
    const token = await tokenFor('tech@acme.example');
    await upload(token, [event({ newValue: '3.80' })]);
    const res = await app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${token}` },
    });
    const events = res.json().events as { new_value: string; source: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0]!.new_value, '3.80');
    assert.equal(events[0]!.source, 'local');
  });

  it('is invisible to another tenant', async () => {
    await upload(await tokenFor('tech@acme.example'), [event()]);
    const res = await app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${await tokenFor('tech@rival.example')}` },
    });
    assert.deepEqual(res.json().events, []);
  });
});

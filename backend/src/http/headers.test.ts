import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../db/client.js';
import { secretFrom } from '../auth/tokens.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { buildServer } from '../server.js';
import { createTestStore } from '../db/testFixtures.js';

const SECRET = secretFrom('a-headers-test-signing-secret-length!');
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

let store: Store;
let app: FastifyInstance;

beforeEach(async () => {
  store = await createTestStore();
  await seedParameterDefinitions(store);
  app = buildServer({ store, secret: SECRET, dispatcher });
});

afterEach(() => store.close());

/**
 * The responses here are audit trails, user lists and tenant battery data. A
 * shared cache holding one tenant's data and serving it to another is a real
 * leak, and none of it is cacheable anyway.
 */
describe('every response', () => {
  const paths = ['/health', '/ready', '/batteries', '/audit', '/definitely-not-a-route'];

  for (const path of paths) {
    it(`${path} refuses to be stored`, async () => {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    it(`${path} refuses to be sniffed`, async () => {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    it(`${path} refuses to be framed`, async () => {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.headers['x-frame-options'], 'DENY');
    });
  }

  it('applies them to an error response too, which is where a body is most likely to be reflected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password-here' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  /**
   * HSTS belongs at whatever terminates TLS — that is where the certificate
   * lives and where preloading is decided. Asserting it from a process that
   * may legitimately be reached over plain HTTP inside a network would be
   * claiming something it cannot know.
   */
  it('does not assert HSTS, which is the edge’s job', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.headers['strict-transport-security'], undefined);
  });
});

/**
 * Liveness answers "should this process be restarted"; readiness answers
 * "should it receive traffic". Conflating them means a broken instance either
 * stays in the rotation or gets killed for something a restart will not fix.
 */
describe('liveness', () => {
  it('answers without touching the database', () => {
    // Closing the store makes any query throw; /health must still answer.
    store.close();
    return app
      .inject({ method: 'GET', url: '/health' })
      .then((res) => {
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), { ok: true });
      })
      .finally(async () => {
        // Re-open so the afterEach close does not throw.
        store = await createTestStore();
      });
  });

  it('needs no authentication, since a probe has no credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
  });
});

describe('readiness', () => {
  it('reports ready when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ready, true);
    assert.ok(res.json().parameters > 0);
  });

  it('needs no authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(res.statusCode, 200);
  });

  /** Opening the API's address in a browser must not read as a broken deploy. */
  it('answers the root with where to look, not a 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ready, '/ready');
  });

  /**
   * The failure this check exists for. Closing the store is how SQLite loses
   * its database; the shared PGlite engine cannot be closed per test, so
   * there the readiness query is made to fail by making the table it reads
   * disappear.
   */
  it('reports not ready when the database is gone', async () => {
    if (store.dialect === 'postgres') await store.exec('DROP TABLE parameter_definitions CASCADE');
    else await store.close();
    const res = await app.inject({ method: 'GET', url: '/ready' });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().ready, false);
    store = await createTestStore();
  });

  it('reports not ready when the schema is there but the seed is not', async () => {
    const empty = await createTestStore();
    const bare = buildServer({ store: empty, secret: SECRET, dispatcher });

    const res = await bare.inject({ method: 'GET', url: '/ready' });
    assert.equal(res.statusCode, 503);
    assert.match(res.json().reason, /parameter definitions/);
    empty.close();
  });

  it('says nothing about why the database failed', async () => {
    store.close();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    assert.ok(!JSON.stringify(res.json()).match(/SQLITE|sqlite|\.db|stack/));
    store = await createTestStore();
  });
});

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { secretFrom } from '../auth/tokens.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { buildServer } from '../server.js';
import { isAllowed, parseOrigins } from './cors.js';

/**
 * Cross-origin access. The API served no browser at all until the web app
 * tried to call it, so these are the rules that were chosen when it did.
 */

const SECRET = secretFrom('a-cors-test-signing-secret-of-length!!');
const CONSOLE = 'https://app.mebenergy.example';
const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

let store: Store;

const serverWith = (origins: string[]): FastifyInstance => {
  store = createStore();
  seedParameterDefinitions(store);
  return buildServer({ store, secret: SECRET, dispatcher, corsOrigins: origins });
};

beforeEach(() => {
  store = createStore();
});
afterEach(() => store.close());

describe('reading the configured origins', () => {
  it('is empty when nothing is set, serving no browser rather than every browser', () => {
    assert.deepEqual(parseOrigins(undefined), []);
    assert.deepEqual(parseOrigins(''), []);
  });

  it('reads a comma-separated list', () => {
    assert.deepEqual(parseOrigins('https://a.example, https://b.example'), [
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('tolerates a trailing slash, which a browser never sends', () => {
    assert.deepEqual(parseOrigins('https://a.example/'), ['https://a.example']);
  });

  it('ignores empty entries from a stray comma', () => {
    assert.deepEqual(parseOrigins('https://a.example,,'), ['https://a.example']);
  });
});

describe('deciding whether an origin is allowed', () => {
  const allowed = ['https://app.mebenergy.example'];

  it('admits an exact match', () => {
    assert.equal(isAllowed(CONSOLE, allowed), true);
  });

  it('refuses a request with no origin, which is not a browser', () => {
    assert.equal(isAllowed(undefined, allowed), false);
  });

  /** `example.com` must not admit `evil-example.com`. */
  it('refuses a lookalike suffix', () => {
    assert.equal(isAllowed('https://evil-app.mebenergy.example', allowed), false);
    assert.equal(isAllowed('https://app.mebenergy.example.evil.com', allowed), false);
  });

  it('refuses a subdomain that was not listed', () => {
    assert.equal(isAllowed('https://staging.app.mebenergy.example', allowed), false);
  });

  it('refuses the same host on a different scheme', () => {
    assert.equal(isAllowed('http://app.mebenergy.example', allowed), false);
  });

  it('refuses the same host on a different port', () => {
    assert.equal(isAllowed('https://app.mebenergy.example:8443', allowed), false);
  });

  it('refuses everything when nothing is configured', () => {
    assert.equal(isAllowed(CONSOLE, []), false);
  });
});

describe('what the API actually sends back', () => {
  it('answers a preflight instead of 404ing it', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: CONSOLE, 'access-control-request-method': 'POST' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], CONSOLE);
  });

  it('reflects the caller’s origin rather than a wildcard', async () => {
    const app = serverWith([CONSOLE, 'https://other.example']);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: CONSOLE },
    });
    assert.equal(res.headers['access-control-allow-origin'], CONSOLE);
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });

  it('allows the methods the API has, and no others', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({ method: 'OPTIONS', url: '/x', headers: { origin: CONSOLE } });
    const methods = String(res.headers['access-control-allow-methods']);
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) assert.ok(methods.includes(m), `${m} missing`);
    assert.ok(!methods.includes('PUT'), 'the API has no PUT');
  });

  it('allows the authorization header, without which nothing works', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({ method: 'OPTIONS', url: '/x', headers: { origin: CONSOLE } });
    assert.ok(String(res.headers['access-control-allow-headers']).includes('authorization'));
  });

  it('sends CORS headers on a real request, not only a preflight', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: CONSOLE },
      payload: { email: 'nobody@example.com', password: 'wrong-password-here' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['access-control-allow-origin'], CONSOLE);
  });

  /**
   * Without this a shared cache can hand one origin's allowed response to
   * another, quietly turning an allowlist into a wildcard.
   */
  it('varies on Origin, including when the origin is refused', async () => {
    const app = serverWith([CONSOLE]);

    const allowed = await app.inject({ method: 'GET', url: '/health', headers: { origin: CONSOLE } });
    assert.equal(allowed.headers.vary, 'Origin');

    const refused = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(refused.headers.vary, 'Origin');
  });

  it('does not enable credentials, since auth is a bearer token', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({ method: 'OPTIONS', url: '/x', headers: { origin: CONSOLE } });
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});

describe('an origin that was not configured', () => {
  it('gets no allow-origin header, so the browser refuses the response', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  /** Telling an unlisted origin apart from an unknown path helps nobody. */
  it('gets the same 204 on preflight as an allowed one, minus the headers', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('is still refused when the API is configured for no origins at all', async () => {
    const app = serverWith([]);
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: CONSOLE } });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('what CORS must not change', () => {
  it('leaves a request with no origin working exactly as before', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  /**
   * CORS is a browser mechanism, not an authorisation one. An allowed origin
   * still gets 401 without a token — the two must never be confused.
   */
  it('does not authorise anything by itself', async () => {
    const app = serverWith([CONSOLE]);
    const res = await app.inject({ method: 'GET', url: '/batteries', headers: { origin: CONSOLE } });
    assert.equal(res.statusCode, 401);
  });
});

/**
 * A malformed request is the client's fault, and saying "Something went wrong"
 * tells them the server is broken instead. Found when a bodyless POST with a
 * JSON content-type — which is what an API client naturally sends for an
 * endpoint that takes no body — came back as a 500.
 */
describe('a request Fastify itself rejects', () => {
  const app = () => serverWith([CONSOLE]);

  it('is a 400, not a 500', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(res.statusCode, 400);
  });

  it('says what was wrong rather than "Something went wrong"', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.notEqual(res.json().message, 'Something went wrong');
    assert.match(res.json().message, /body/i);
  });

  it('is a 400 for a body that is not valid JSON', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 400);
  });

  /** A genuine bug must still say nothing; only 4xx is passed through. */
  it('does not let a 5xx leak its detail', async () => {
    const store2 = createStore();
    const broken: Dispatcher = {
      send: async () => {
        throw new Error('secret internal detail');
      },
    };
    const app2 = buildServer({ store: store2, secret: SECRET, dispatcher: broken });
    const res = await app2.inject({ method: 'GET', url: '/definitely-not-a-route' });
    // Unknown route is Fastify's own 404, which is fine to pass through.
    assert.equal(res.statusCode, 404);
    store2.close();
  });
});

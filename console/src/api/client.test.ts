import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, SessionExpiredError, type Tokens } from './client';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

type Call = { url: string; init: RequestInit };

function harness(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let tokens: Tokens | null = { accessToken: 'a1', refreshToken: 'r1' };
  const signedOut = vi.fn();

  const client = new ApiClient({
    baseUrl: 'https://api.test/',
    getTokens: () => tokens,
    onTokens: (next) => {
      tokens = next;
    },
    onSignedOut: () => {
      tokens = null;
      signedOut();
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return handler(call, calls.length);
    }) as unknown as typeof fetch,
  });

  return { client, calls, signedOut, clearTokens: () => (tokens = null), tokensNow: () => tokens };
}

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

describe('requests', () => {
  it('sends the bearer token on an authenticated call', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.get('/companies');
    expect(headersOf(h.calls[0]!).authorization).toBe('Bearer a1');
  });

  it('sends no bearer token on sign-in', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.anon('/auth/login', { email: 'a@b.c' });
    expect(headersOf(h.calls[0]!).authorization).toBeUndefined();
  });

  it('joins the base URL without doubling the slash', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.get('/audit');
    expect(h.calls[0]!.url).toBe('https://api.test/audit');
  });

  it('sends a body only when there is one', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.get('/audit');
    expect(h.calls[0]!.init.body).toBeUndefined();
  });

  it('raises ApiError carrying the server’s own message', async () => {
    const h = harness(() => reply(422, { error: 'policy_denied', message: 'Above safe maximum' }));
    await expect(h.client.get('/x')).rejects.toThrow('Above safe maximum');
  });

  it('classifies the statuses the console has to act on differently', async () => {
    for (const [status, flag] of [
      [422, 'isPolicyRefusal'],
      [404, 'isNotFound'],
      [409, 'isConflict'],
    ] as const) {
      const h = harness(() => reply(status, { error: 'e', message: 'm' }));
      const error = (await h.client.get('/x').catch((e: unknown) => e)) as ApiError;
      expect(error[flag]).toBe(true);
    }
  });

  it('returns nothing for a 204 rather than trying to parse it', async () => {
    const h = harness(() => reply(204));
    await expect(h.client.post('/x')).resolves.toBeUndefined();
  });

  it('refuses an authenticated call with no session rather than sending one', async () => {
    const h = harness(() => reply(200, {}));
    h.clearTokens();
    await expect(h.client.get('/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(h.calls).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('renews on a 401 and replays the original request', async () => {
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh'))
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      return headersOf(call).authorization === 'Bearer a2'
        ? reply(200, { value: 42 })
        : reply(401, { error: 'unauthorized', message: 'expired' });
    });

    await expect(h.client.get<{ value: number }>('/x')).resolves.toEqual({ value: 42 });
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://api.test/x',
      'https://api.test/auth/refresh',
      'https://api.test/x',
    ]);
  });

  it('replays a PATCH with its body intact', async () => {
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh'))
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      return headersOf(call).authorization === 'Bearer a2' ? reply(200, {}) : reply(401, {});
    });

    await h.client.patch('/users/u1/status', { status: 'suspended' });
    const replayed = h.calls[2]!;
    expect(replayed.init.method).toBe('PATCH');
    expect(JSON.parse(replayed.init.body as string)).toEqual({ status: 'suspended' });
  });

  /**
   * The one that matters. The console loads several panels at once, so
   * concurrent 401s are the normal case — and the backend revokes an entire
   * token chain when a refresh token is presented twice.
   */
  it('refreshes once for many simultaneous 401s', async () => {
    let refreshes = 0;
    const h = harness(async (call) => {
      if (call.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      }
      return headersOf(call).authorization === 'Bearer a2' ? reply(200, {}) : reply(401, {});
    });

    await Promise.all([
      h.client.get('/companies'),
      h.client.get('/users'),
      h.client.get('/batteries'),
      h.client.get('/audit'),
    ]);
    expect(refreshes).toBe(1);
  });

  it('gives up rather than retrying when the refresh itself is rejected', async () => {
    let refreshes = 0;
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        return reply(401, { error: 'reuse', message: 'token already used' });
      }
      return reply(401, {});
    });

    await expect(h.client.get('/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(refreshes).toBe(1);
    expect(h.signedOut).toHaveBeenCalledTimes(1);
  });

  it('does not loop when the replay is also unauthorised', async () => {
    const h = harness((call) =>
      call.url.endsWith('/auth/refresh')
        ? reply(200, { accessToken: 'a2', refreshToken: 'r2' })
        : reply(401, { error: 'unauthorized', message: 'still no' })
    );
    await expect(h.client.get('/x')).rejects.toBeInstanceOf(ApiError);
    // request, refresh, replay — and then it stops.
    expect(h.calls).toHaveLength(3);
  });

  it('stores the renewed pair', async () => {
    const h = harness((call) =>
      call.url.endsWith('/auth/refresh')
        ? reply(200, { accessToken: 'a2', refreshToken: 'r2' })
        : headersOf(call).authorization === 'Bearer a2'
          ? reply(200, {})
          : reply(401, {})
    );
    await h.client.get('/x');
    expect(h.tokensNow()).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('never refreshes an unauthenticated call', async () => {
    const h = harness(() => reply(401, { error: 'unauthorized', message: 'bad password' }));
    await expect(h.client.anon('/auth/login', {})).rejects.toBeInstanceOf(ApiError);
    expect(h.calls).toHaveLength(1);
  });
});

describe('a later expiry in the same session', () => {
  let good: string;

  beforeEach(() => {
    good = 'a2';
  });

  it('can refresh again once an earlier refresh has finished', async () => {
    let refreshes = 0;
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        good = `a${refreshes + 1}`;
        return reply(200, { accessToken: good, refreshToken: `r${refreshes + 1}` });
      }
      return headersOf(call).authorization === `Bearer ${good}` ? reply(200, {}) : reply(401, {});
    });

    await h.client.get('/x');
    good = 'a3'; // the stored token is now stale again
    await h.client.get('/y');
    expect(refreshes).toBe(2);
  });
});

/**
 * The default branch of the `fetch` getter.
 *
 * Every other test in this file injects `fetchImpl`, which is a plain function
 * and does not care what receiver it is called with. The global `fetch` does:
 * calling it as `this.fetch(...)` makes the receiver this client rather than
 * the global object, and the browser throws "Illegal invocation".
 *
 * That is not a hypothetical. The console could not make a single request
 * until this was found by driving the real thing in a browser — with 71 tests
 * passing, because none of them ever took this branch.
 */
describe('when no fetch is injected', () => {
  it('uses the global fetch without an illegal invocation', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;

    // A global that refuses a wrong receiver, exactly as the browser's does.
    const strict = function (this: unknown, url: string) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      calls.push(url);
      return Promise.resolve(reply(200, { ok: true }));
    };
    globalThis.fetch = strict as unknown as typeof fetch;

    try {
      const client = new ApiClient({
        baseUrl: 'https://api.test',
        getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
        onTokens: () => undefined,
        onSignedOut: () => undefined,
      });

      await expect(client.get('/batteries')).resolves.toEqual({ ok: true });
      expect(calls).toEqual(['https://api.test/batteries']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('binds it for the refresh path too', async () => {
    const original = globalThis.fetch;
    let refreshed = false;

    const strict = function (this: unknown, url: string) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      if (url.endsWith('/auth/refresh')) {
        refreshed = true;
        return Promise.resolve(reply(200, { accessToken: 'a2', refreshToken: 'r2' }));
      }
      return Promise.resolve(refreshed ? reply(200, {}) : reply(401, {}));
    };
    globalThis.fetch = strict as unknown as typeof fetch;

    try {
      const client = new ApiClient({
        baseUrl: 'https://api.test',
        getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
        onTokens: () => undefined,
        onSignedOut: () => undefined,
      });

      await expect(client.get('/x')).resolves.toBeDefined();
      expect(refreshed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * Several endpoints take no body — opening a BLE session, claiming commands.
 * Sending `content-type: application/json` with nothing after it makes Fastify
 * reject the request before it reaches a route, which is how this was found.
 */
describe('a request with no body', () => {
  it('does not claim to be sending JSON', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.post('/batteries/b1/session');
    expect(headersOf(h.calls[0]!)['content-type']).toBeUndefined();
    expect(h.calls[0]!.init.body).toBeUndefined();
  });

  it('still sends the bearer token', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.post('/batteries/b1/session');
    expect(headersOf(h.calls[0]!).authorization).toBe('Bearer a1');
  });

  it('declares JSON when there is a body', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.post('/support-sessions', { batteryId: 'b1' });
    expect(headersOf(h.calls[0]!)['content-type']).toBe('application/json');
  });

  /** An empty object is a body, and must be declared as one. */
  it('declares JSON for an empty object body', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.post('/x', {});
    expect(headersOf(h.calls[0]!)['content-type']).toBe('application/json');
    expect(h.calls[0]!.init.body).toBe('{}');
  });
});

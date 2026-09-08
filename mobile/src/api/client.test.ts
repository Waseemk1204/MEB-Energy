import { ApiClient, ApiError, SessionExpiredError, type Tokens } from './client';

jest.mock('../diagnostics/fieldLog', () => ({ logWarn: jest.fn(), logInfo: jest.fn() }));

/** Minimal stand-in for the fetch Response shape the client actually reads. */
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
  const signedOut = jest.fn();

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

  return { client, calls, signedOut, tokensNow: () => tokens };
}

describe('requests', () => {
  it('sends the bearer token on an authenticated call', async () => {
    const h = harness(() => reply(200, { ok: true }));
    await h.client.get('/batteries');
    expect((h.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer a1');
  });

  it('sends no bearer token on sign-in', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.post('/auth/login', { email: 'a@b.c' });
    expect((h.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('joins the base URL without doubling the slash', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.get('/audit');
    expect(h.calls[0].url).toBe('https://api.test/audit');
  });

  it('raises ApiError carrying the server’s own message', async () => {
    const h = harness(() => reply(422, { error: 'policy_denied', message: 'Above safe maximum' }));
    await expect(h.client.get('/x')).rejects.toThrow('Above safe maximum');
  });

  it('marks a 422 as a policy refusal and a 404 as not-found', async () => {
    const denied = harness(() => reply(422, { error: 'e', message: 'm' }));
    await denied.client.get('/x').catch((e: ApiError) => {
      expect(e.isPolicyRefusal).toBe(true);
      expect(e.isNotFound).toBe(false);
    });
    const missing = harness(() => reply(404, { error: 'e', message: 'm' }));
    await missing.client.get('/x').catch((e: ApiError) => expect(e.isNotFound).toBe(true));
  });

  it('refuses an authenticated call with no session rather than sending one', async () => {
    const h = harness(() => reply(200, {}));
    h.client['options'].getTokens = () => null;
    await expect(h.client.get('/x')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(h.calls).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('renews on a 401 and replays the original request', async () => {
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh'))
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      return (call.init.headers as Record<string, string>).authorization === 'Bearer a2'
        ? reply(200, { value: 42 })
        : reply(401, { error: 'unauthorized', message: 'expired' });
    });

    expect(await h.client.get<{ value: number }>('/x')).toEqual({ value: 42 });
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://api.test/x',
      'https://api.test/auth/refresh',
      'https://api.test/x',
    ]);
  });

  it('stores the renewed pair', async () => {
    const h = harness((call) =>
      call.url.endsWith('/auth/refresh')
        ? reply(200, { accessToken: 'a2', refreshToken: 'r2' })
        : (call.init.headers as Record<string, string>).authorization === 'Bearer a2'
          ? reply(200, {})
          : reply(401, {})
    );
    await h.client.get('/x');
    expect(h.tokensNow()).toEqual({ accessToken: 'a2', refreshToken: 'r2' });
  });

  /**
   * The one that matters. Concurrent 401s must not each spend the refresh
   * token: the backend revokes a whole chain when one is presented twice, so
   * racing refreshes would log the technician out for doing nothing wrong.
   */
  it('refreshes once for many simultaneous 401s', async () => {
    let refreshes = 0;
    const h = harness(async (call) => {
      if (call.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      }
      return (call.init.headers as Record<string, string>).authorization === 'Bearer a2'
        ? reply(200, { ok: true })
        : reply(401, {});
    });

    await Promise.all([
      h.client.get('/a'),
      h.client.get('/b'),
      h.client.get('/c'),
      h.client.get('/d'),
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

  it('can refresh again after an earlier refresh finished', async () => {
    let refreshes = 0;
    let good = 'a2';
    const h = harness((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        good = `a${refreshes + 1}`;
        return reply(200, { accessToken: good, refreshToken: `r${refreshes + 1}` });
      }
      return (call.init.headers as Record<string, string>).authorization === `Bearer ${good}`
        ? reply(200, {})
        : reply(401, {});
    });

    await h.client.get('/x');
    // A second expiry later in the session must not be blocked by the first.
    h.client['options'].onTokens({ accessToken: 'stale', refreshToken: 'r2' });
    await h.client.get('/y');
    expect(refreshes).toBe(2);
  });

  it('never refreshes an unauthenticated call', async () => {
    const h = harness(() => reply(401, { error: 'unauthorized', message: 'bad password' }));
    await expect(h.client.post('/auth/login', {})).rejects.toBeInstanceOf(ApiError);
    expect(h.calls).toHaveLength(1);
  });
});

/**
 * The default branch of the `fetch` getter — the one that runs in production
 * and the one every other test in this file skips by injecting `fetchImpl`.
 *
 * React Native's polyfilled fetch does not check its receiver, so this passed
 * unnoticed on device; a browser does, and Expo web fails with "Illegal
 * invocation". Found by driving the admin console, which shares this shape.
 */
describe('when no fetch is injected', () => {
  const strictGlobal = (handler: (url: string) => Response) =>
    function (this: unknown, url: string) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(handler(url));
    } as unknown as typeof fetch;

  it('calls the global fetch with a receiver it accepts', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = strictGlobal((url) => {
      seen.push(url);
      return reply(200, { ok: true });
    });

    try {
      const client = new ApiClient({
        baseUrl: 'https://api.test',
        getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
        onTokens: () => undefined,
        onSignedOut: () => undefined,
      });
      await expect(client.get('/batteries')).resolves.toEqual({ ok: true });
      expect(seen).toEqual(['https://api.test/batteries']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does the same on the refresh path', async () => {
    const original = globalThis.fetch;
    let refreshed = false;
    globalThis.fetch = strictGlobal((url) => {
      if (url.endsWith('/auth/refresh')) {
        refreshed = true;
        return reply(200, { accessToken: 'a2', refreshToken: 'r2' });
      }
      return refreshed ? reply(200, {}) : reply(401, {});
    });

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
 * Announcing `application/json` and then sending nothing makes Fastify reject
 * the request before it reaches a route.
 */
describe('a request with no body', () => {
  it('does not claim to be sending JSON', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.authedPost('/batteries/b1/session');
    const headers = h.calls[0].init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(h.calls[0].init.body).toBeUndefined();
  });

  it('still sends the bearer token', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.authedPost('/batteries/b1/session');
    expect((h.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer a1');
  });

  it('declares JSON when there is a body', async () => {
    const h = harness(() => reply(200, {}));
    await h.client.authedPost('/batteries/b1/audit', { events: [] });
    expect((h.calls[0].init.headers as Record<string, string>)['content-type']).toBe(
      'application/json'
    );
  });
});

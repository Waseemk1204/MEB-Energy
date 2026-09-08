import { ApiClient } from './client';
import { LoginError, login } from './auth';

jest.mock('../diagnostics/fieldLog', () => ({ logWarn: jest.fn(), logInfo: jest.fn() }));

const clientReturning = (impl: () => Response | Promise<Response>) =>
  new ApiClient({
    baseUrl: 'https://api.test',
    getTokens: () => null,
    onTokens: () => undefined,
    onSignedOut: () => undefined,
    fetchImpl: (async () => impl()) as unknown as typeof fetch,
  });

const status = (code: number, body: unknown = { error: 'e', message: 'server wording' }) =>
  clientReturning(
    () =>
      ({
        status: code,
        ok: code < 300,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as Response
  );

const failureOf = async (client: ApiClient) =>
  login(client, 'a@b.c', 'pw').then(
    () => null,
    (e: LoginError) => e.failure.kind
  );

describe('login', () => {
  it('returns the session on success', async () => {
    const client = status(200, {
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: 'u', email: 'a@b.c', displayName: 'W Khan', role: 'user' },
      company: { id: 'c', name: 'Aurora Fleet' },
    });
    const result = await login(client, 'a@b.c', 'pw');
    expect(result.user.displayName).toBe('W Khan');
    expect(result.company?.name).toBe('Aurora Fleet');
  });

  it('trims the email so a stray space is not a failed login', async () => {
    let sent = '';
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      getTokens: () => null,
      onTokens: () => undefined,
      onSignedOut: () => undefined,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string).email;
        return { status: 200, ok: true, text: async () => '{}', json: async () => ({}) } as Response;
      }) as unknown as typeof fetch,
    });
    await login(client, '  a@b.c ', 'pw');
    expect(sent).toBe('a@b.c');
  });

  it('maps 401 and 400 to the same wording', async () => {
    const a = await login(status(401), 'a@b.c', 'p').catch((e: LoginError) => e.message);
    const b = await login(status(400), 'a@b.c', 'p').catch((e: LoginError) => e.message);
    expect(a).toBe(b);
  });

  it('does not reveal whether the account exists', async () => {
    const message = await login(status(401), 'a@b.c', 'p').catch((e: LoginError) => e.message);
    expect(message).not.toMatch(/no account|not found|unknown user|no such/i);
  });

  /**
   * A *suspended account* answers 401, exactly as a wrong password does. That
   * is the enumeration defence and it must not acquire its own wording — this
   * asserts on the 401 path, where an account may or may not exist.
   */
  it('says nothing different about a suspended account', async () => {
    const suspended = await login(
      status(401, { error: 'unauthorized', message: 'This account has been suspended' }),
      'a@b.c',
      'p'
    ).catch((e: LoginError) => e.message);

    expect(suspended).not.toMatch(/suspend|disabled|deactivated/i);
    expect(suspended).toBe('Email or password is incorrect.');
  });

  it('classifies each status', async () => {
    expect(await failureOf(status(401))).toBe('credentials');
    expect(await failureOf(status(403))).toBe('blocked');
    expect(await failureOf(status(429))).toBe('rate_limited');
    expect(await failureOf(status(500))).toBe('unreachable');
  });

  /**
   * A company whose plan has lapsed, been cancelled, or been suspended.
   *
   * The one case where the server's own wording is passed through, and it is
   * safe precisely because 403 is only reachable *after* the password has been
   * proved: it says nothing to anyone who does not already hold the account.
   * Without this the message fell through to "check your connection", sending
   * a technician to debug their signal instead of ringing the one person who
   * can fix it.
   */
  describe('a company that cannot be used', () => {
    const blocked = (message: string) =>
      login(status(403, { error: 'forbidden', message }), 'a@b.c', 'p').catch(
        (e: LoginError) => e.message
      );

    it('is not reported as a network problem', async () => {
      const message = await blocked("This company's plan has expired.");
      expect(message).not.toMatch(/connection|reach|try again/i);
    });

    it('is not reported as a wrong password', async () => {
      const message = await blocked("This company's plan has expired.");
      expect(message).not.toMatch(/password|incorrect/i);
    });

    it('passes the server’s reason through, since it is the actionable part', async () => {
      const message = await blocked(
        "This company's plan has expired. Contact your administrator to renew it."
      );
      expect(message).toBe(
        "This company's plan has expired. Contact your administrator to renew it."
      );
    });

    it('still says something useful when the server sends no reason', async () => {
      const message = await login(
        status(403, { error: 'forbidden', message: '' }),
        'a@b.c',
        'p'
      ).catch((e: LoginError) => e.message);

      expect(message).toMatch(/administrator/i);
    });
  });

  it('treats a transport failure as unreachable, not as bad credentials', async () => {
    const client = clientReturning(() => {
      throw new TypeError('Network request failed');
    });
    expect(await failureOf(client)).toBe('unreachable');
  });

  /**
   * Never let a raw server or transport string reach the sign-in screen —
   * except the 403 above, which is post-authentication and covered separately.
   */
  it('does not surface the server’s own wording to the user', async () => {
    for (const code of [400, 401, 429, 500]) {
      const message = await login(status(code), 'a@b.c', 'p').catch((e: LoginError) => e.message);
      expect(message).not.toContain('server wording');
    }
  });

  /** Absent on an older backend; absent must read as "nothing was signed out". */
  describe('devices this sign-in signed out', () => {
    const succeeding = (over: Record<string, unknown>) =>
      login(
        status(200, {
          accessToken: 'a',
          refreshToken: 'r',
          user: { id: 'u', email: 'a@b.c', displayName: 'W Khan', role: 'company' },
          company: { id: 'c', name: 'Aurora Fleet' },
          ...over,
        }),
        'a@b.c',
        'pw'
      );

    it('carries them through', async () => {
      const result = await succeeding({ signedOut: ['Safari on iPhone, last used 3h ago'] });
      expect(result.signedOut).toEqual(['Safari on iPhone, last used 3h ago']);
    });

    it('is undefined rather than invented when the server omits it', async () => {
      const result = await succeeding({});
      expect(result.signedOut).toBeUndefined();
    });
  });
});

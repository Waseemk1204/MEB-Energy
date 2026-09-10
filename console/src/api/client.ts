/**
 * Typed client for the KnowyourEV backend.
 *
 * Deliberately a sibling of the app's client rather than a shared package: the
 * two run on different platforms with different storage and different failure
 * modes, and the amount actually in common is this file's shape, not its
 * substance. What *is* shared is the rule that matters:
 *
 * **Refresh is serialised.** The console polls several endpoints at once, so
 * concurrent 401s are normal. Each one spending the refresh token would trip
 * the backend's reuse detection and revoke the whole chain, signing out an
 * administrator mid-task for doing nothing wrong. Only the first refreshes;
 * the rest await it.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody
  ) {
    super(body.message);
    this.name = 'ApiError';
  }

  /** Well-formed, and the answer is no. */
  get isPolicyRefusal(): boolean {
    return this.status === 422;
  }

  /** Not yours, or not there — the backend refuses to distinguish. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** A limit or a state conflict, not a malformed request. */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  getTokens: () => Tokens | null;
  onTokens: (tokens: Tokens) => void;
  onSignedOut: () => void;
  fetchImpl?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ApiClient {
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: ClientOptions) {}

  /**
   * The global `fetch` must be called with the global object as its receiver.
   * Resolving it through a getter and calling `this.fetch(...)` makes the
   * receiver this client instead, and the browser refuses with "Illegal
   * invocation" — so it is bound here, once.
   *
   * This was invisible to the tests for a long time because every one of them
   * injected `fetchImpl`, which is a plain function and does not care about
   * its receiver. The default branch — the only one that runs in production —
   * had no coverage at all until `uses the global fetch when none is injected`
   * below was written.
   */
  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Unauthenticated — sign-in only. */
  anon<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, body, false);
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path, undefined, true);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body, true);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('PATCH', path, body, true);
  }

  delete<T>(path: string): Promise<T> {
    return this.send<T>('DELETE', path, undefined, true);
  }

  private async send<T>(
    method: Method,
    path: string,
    body: unknown,
    authenticated: boolean,
    isRetry = false
  ): Promise<T> {
    // Only declare a JSON body when there is one. Sending
    // `content-type: application/json` with no body makes Fastify reject the
    // request outright — several endpoints here take no body at all, so this
    // is the normal case rather than an edge one.
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';

    if (authenticated) {
      const tokens = this.options.getTokens();
      if (!tokens) throw new SessionExpiredError();
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }

    const response = await this.fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 && authenticated && !isRetry) {
      await this.refreshOnce();
      return this.send<T>(method, path, body, authenticated, true);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) throw new ApiError(response.status, parsed as ApiErrorBody);
    return parsed as T;
  }

  /** At most one refresh in flight — see the note at the top of the file. */
  private refreshOnce(): Promise<void> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const tokens = this.options.getTokens();
      if (!tokens) throw new SessionExpiredError();

      const response = await this.fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/auth/refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        }
      );

      if (!response.ok) {
        // The session is over. Retrying would turn one expired session into a
        // revoked chain.
        this.options.onSignedOut();
        throw new SessionExpiredError();
      }

      this.options.onTokens((await response.json()) as Tokens);
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }
}

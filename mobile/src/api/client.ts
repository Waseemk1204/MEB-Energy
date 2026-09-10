import { logWarn } from '../diagnostics/fieldLog';

/**
 * Typed client for the KnowyourEV backend.
 *
 * Two behaviours are worth knowing about:
 *
 * · **Refresh is serialised.** When several requests hit a 401 at once — which
 *   is the normal case, since the dashboard polls — they must not each spend
 *   the refresh token. Only the first refreshes; the rest wait on that same
 *   promise. Racing them would trip the backend's reuse detection and log the
 *   technician out for doing nothing wrong.
 *
 * · **A failed refresh signs out rather than retrying.** If the refresh token
 *   is gone the session is over, and hammering the endpoint turns one expired
 *   session into a lockout.
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

  /** Refused by policy: well-formed, and the answer is no. */
  get isPolicyRefusal(): boolean {
    return this.status === 422;
  }

  /** Not ours, or not there — the backend deliberately does not distinguish. */
  get isNotFound(): boolean {
    return this.status === 404;
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

export class ApiClient {
  private refreshing: Promise<string> | null = null;

  constructor(private readonly options: ClientOptions) {}

  /**
   * The global `fetch` has to be called with the global object as its
   * receiver. Calling it as `this.fetch(...)` makes the receiver this client,
   * which React Native's polyfill tolerates and a browser does not — Expo web
   * fails with "Illegal invocation". Bound here so both behave the same.
   *
   * Found in the console, which shares this shape and could not make a single
   * request, while every test passed: they all inject `fetchImpl`, so the
   * default branch had no coverage.
   */
  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /** Unauthenticated — used for sign-in itself. */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, { method: 'POST', body }, false);
  }

  async get<T>(path: string): Promise<T> {
    return this.send<T>(path, { method: 'GET' }, true);
  }

  async authedPost<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>(path, { method: 'POST', body }, true);
  }

  async authedPatch<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>(path, { method: 'PATCH', body }, true);
  }

  async authedDelete<T>(path: string): Promise<T> {
    return this.send<T>(path, { method: 'DELETE' }, true);
  }

  private async send<T>(
    path: string,
    init: { method: string; body?: unknown },
    authenticated: boolean,
    isRetry = false
  ): Promise<T> {
    // Only declare a JSON body when there is one. Fastify rejects a request
    // that announces `application/json` and then sends nothing — and several
    // endpoints (opening a BLE session, claiming commands) take no body.
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    if (authenticated) {
      const tokens = this.options.getTokens();
      if (!tokens) throw new SessionExpiredError();
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }

    const response = await this.fetch(this.url(path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (response.status === 401 && authenticated && !isRetry) {
      await this.refreshOnce();
      return this.send<T>(path, init, authenticated, true);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new ApiError(response.status, parsed as ApiErrorBody);
    }
    return parsed as T;
  }

  /**
   * At most one refresh in flight. Concurrent callers await the same promise
   * rather than each spending the token — see the note at the top of the file.
   */
  private async refreshOnce(): Promise<string> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const tokens = this.options.getTokens();
      if (!tokens) throw new SessionExpiredError();

      const response = await this.fetch(this.url('/auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });

      if (!response.ok) {
        // The session is over. Retrying would turn an expired session into a
        // lockout via the backend's reuse detection.
        logWarn('session', 'Refresh rejected; signing out', { status: response.status });
        this.options.onSignedOut();
        throw new SessionExpiredError();
      }

      const next = (await response.json()) as Tokens;
      this.options.onTokens(next);
      return next.accessToken;
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }
}

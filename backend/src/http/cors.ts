import type { FastifyInstance } from 'fastify';

/**
 * Cross-origin access for the web app.
 *
 * The API had none until a browser tried to call it: every prior exercise was
 * curl or `app.inject`, neither of which is a browser. Adding it raised the
 * question of how permissive to be, and the answers here are deliberate.
 *
 * · **An allowlist, never `*`.** The reply reflects the caller's origin only
 *   when it is one we were configured for. An unlisted origin gets no CORS
 *   headers at all and the browser refuses the response — which is the correct
 *   outcome for an API that can suspend accounts and change parameters on
 *   physical batteries.
 *
 * · **`Vary: Origin` on everything.** Without it, a shared cache can hand one
 *   origin's allowed response to another, which quietly turns an allowlist
 *   into a wildcard.
 *
 * · **No credentials.** Authentication is a bearer token the app holds
 *   itself, not a cookie, so `Access-Control-Allow-Credentials` stays off. That
 *   also means a future mistake that widened the allowlist could not be
 *   combined with ambient cookie auth to make requests on a user's behalf.
 *
 * · **Only the methods and headers actually used.** The API sends no custom
 *   headers; advertising any would be describing a surface that does not
 *   exist. DELETE is listed because retiring a pack, removing a person and
 *   ending a BLE session all use it — the first version of this list left it
 *   out, and a browser refused every one of those at the preflight while the
 *   Node-side live check, which sends no preflight, passed.
 */

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'content-type, authorization';

/** Preflight results are stable; a day saves a round trip per session. */
const MAX_AGE_SECONDS = 86_400;

/**
 * Parse the configured origins.
 *
 * Empty by default, and that is the safe default: a deployment that forgets to
 * configure this serves no browser rather than serving every browser.
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter((o) => o.length > 0);
}

export function isAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  // Exact match only. No suffix or wildcard matching: `example.com` must not
  // admit `evil-example.com`, and a subdomain rule is a footgun this API has
  // no need for.
  return allowed.includes(origin.replace(/\/$/, ''));
}

export function registerCors(app: FastifyInstance, allowed: string[]): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;

    // Always vary, even when the origin is refused: the *absence* of CORS
    // headers is itself an origin-dependent response.
    void reply.header('vary', 'Origin');

    if (isAllowed(origin, allowed)) {
      void reply.header('access-control-allow-origin', origin!);
      void reply.header('access-control-allow-methods', ALLOWED_METHODS);
      void reply.header('access-control-allow-headers', ALLOWED_HEADERS);
      void reply.header('access-control-max-age', String(MAX_AGE_SECONDS));
    }

    // A preflight is answered here rather than falling through to the router,
    // which would 404 it — no route declares OPTIONS. 204 either way: telling
    // an unlisted origin apart from an unknown path is not information worth
    // handing out, and the missing headers already refuse it.
    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }
    return undefined;
  });
}

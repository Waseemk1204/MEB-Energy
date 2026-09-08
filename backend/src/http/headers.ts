import type { FastifyInstance } from 'fastify';

/**
 * Response headers.
 *
 * This is a JSON API, so most of the usual browser hardening does not apply —
 * there is no HTML to inject into and no scripts to constrain. Three headers
 * do matter:
 *
 * · **`Cache-Control: no-store`** on everything. The responses here are audit
 *   trails, user lists and tenant battery data. A shared cache, a corporate
 *   proxy or the browser's own back-forward cache holding one tenant's data
 *   and serving it to another is a real leak, and none of it is cacheable
 *   anyway — every response is either private or a single-use token.
 *
 * · **`X-Content-Type-Options: nosniff`**. A browser that sniffs a JSON body
 *   as HTML can be induced to execute part of it. The bodies here contain
 *   user-supplied strings (display names, battery serials, refusal reasons),
 *   so this is not theoretical.
 *
 * · **`X-Frame-Options: DENY`**. Nothing here is meant to be framed, and a
 *   JSON response rendered in a frame is only ever part of an attack.
 *
 * Deliberately absent: `Strict-Transport-Security`. It belongs at whatever
 * terminates TLS, which is where the certificate lives and where the decision
 * about preloading is actually made. Setting it from an application that may
 * legitimately be reached over plain HTTP inside a network would be asserting
 * something this process cannot know.
 */

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    return payload;
  });
}

#!/usr/bin/env node
/**
 * Serve the exported web app the way a static host would.
 *
 *   npm run build:web && npm run serve:web        # http://localhost:4173
 *
 * Two things a plain file server would get wrong, and this gets right:
 *
 * · Any path that is not a file gets `index.html`. The app is a single page
 *   with client-side routes, so `/company/people` and `/accept-invite?token=`
 *   must load the page and let the router take it from there. A host that
 *   404s those breaks every link anyone shares. (Netlify, Vercel, nginx and
 *   the rest all have a one-line setting for this; see README.)
 *
 * · `sw.js` is sent with `Cache-Control: no-cache`, so a new build's worker is
 *   picked up on the next open rather than whenever a cached copy expires.
 *
 * No dependencies, on purpose: this is what `npx serve` would do, without an
 * install step between a build and looking at it.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function fileAt(urlPath) {
  const safe = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(root, safe);
  if (!candidate.startsWith(root)) return null;
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

createServer((req, res) => {
  const file = fileAt(req.url ?? '/') ?? join(root, 'index.html');
  const ext = extname(file);
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
  // Hashed bundles may be cached forever; the page and the worker may not.
  headers['cache-control'] =
    file.endsWith('index.html') || file.endsWith('sw.js')
      ? 'no-cache'
      : file.includes('/_expo/static/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});

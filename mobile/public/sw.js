/*
 * The service worker: what makes the app open with no signal.
 *
 * Two rules, kept deliberately simple so they can be read in one sitting:
 *
 * · The app shell — the HTML page, the JavaScript bundle, fonts, icons — is
 *   cached the first time it is fetched and served from the cache afterwards.
 *   Bundle and font files carry a content hash in their name, so a stale copy
 *   is impossible: a new build has new names, and the old cache is dropped
 *   when a new worker takes over.
 *
 * · The API is never cached. Every request to another origin, and every
 *   request that is not a GET, goes straight to the network. A cached battery
 *   reading shown as current would be exactly the kind of invented fact the
 *   app refuses to show; the telemetry buffer and audit outbox already handle
 *   offline for the things that are safe to hold.
 *
 * Navigation requests fall back to the cached page when the network is gone,
 * which is what lets the installed app open at all without signal. The page
 * itself is network-first, so a deploy is picked up on the next open rather
 * than the one after.
 */

const VERSION = 'meb-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.png', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * What to answer when there is neither a cached copy nor a network. A
 * rejected promise here surfaces as "Uncaught (in promise) TypeError: Failed
 * to fetch" in the console and the browser shows its own error page; a plain
 * 503 is the honest answer and is what the app's own error handling expects.
 */
const offline = () =>
  new Response('Offline', { status: 503, statusText: 'Offline', headers: { 'content-type': 'text/plain' } });

/** Only the app's own origin, and only reads. */
function isShellRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isShellRequest(request)) return;

  // The page: network first, so a new build lands on the next open; cache
  // when the network is gone, so the app opens at all.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? offline()))
    );
    return;
  }

  // Everything else on this origin: cache first. Hashed filenames make a
  // stale hit impossible; anything unhashed is an icon or the manifest, which
  // change with a build and are refetched when the worker version changes.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(offline)
    )
  );
});

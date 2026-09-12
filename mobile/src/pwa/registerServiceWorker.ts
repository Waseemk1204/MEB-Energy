import { Platform } from 'react-native';

/**
 * Register the service worker, on the web, in a production build.
 *
 * Not in development: Metro serves a fresh bundle on every edit, and a worker
 * caching the shell would hand back the previous one. The app still installs
 * and runs in development — it just does not open offline until it is built.
 */
export function registerServiceWorker(): void {
  if (Platform.OS !== 'web' || __DEV__) return;
  const nav = (globalThis as { navigator?: { serviceWorker?: { register: (u: string) => Promise<unknown> } } })
    .navigator;
  if (!nav?.serviceWorker) return;
  nav.serviceWorker.register('/sw.js').catch(() => {
    // A worker that fails to register leaves a working app that does not
    // open offline. Not worth interrupting anyone over.
  });
}

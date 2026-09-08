import Constants from 'expo-constants';

/**
 * Where the backend lives.
 *
 * A phone on Wi-Fi cannot reach the laptop's `localhost`, so in development the
 * host is taken from the Expo dev server's own address — the same machine that
 * served the bundle is the machine running the API. That makes `expo start`
 * work on a real device with no manual IP editing, which is the setup this app
 * is actually developed in.
 */

const DEV_PORT = 3000;

function devHost(): string | null {
  // e.g. "192.168.1.24:8081" — the LAN address Metro is reachable at.
  const host = Constants.expoConfig?.hostUri ?? null;
  if (!host) return null;
  return host.split(':')[0] ?? null;
}

export function resolveBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit;

  const host = devHost();
  if (host) return `http://${host}:${DEV_PORT}`;

  // No dev server and no configured URL. Requests will fail fast and visibly
  // rather than silently pointing at nothing.
  return `http://localhost:${DEV_PORT}`;
}

export const API_BASE_URL = resolveBaseUrl();

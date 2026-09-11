import { ApiClient, type Tokens } from './client';
import { API_BASE_URL } from './config';
import { type SessionRole, saveSession } from '../store/sessionStorage';

/**
 * The app's single API client.
 *
 * It owns the live token pair itself rather than reading the session store,
 * which keeps the dependency pointing one way: store → api, never back. When
 * the client decides a session is over it calls out through a registered
 * handler, so the store learns about it without the client importing it.
 */

let tokens: Tokens | null = null;
let identity: { operator: string; company: string; role: SessionRole } | null = null;
let onExpired: (() => void) | null = null;

/** Called by the session store once, at startup. */
export function onSessionExpired(handler: () => void): void {
  onExpired = handler;
}

export function setTokens(
  next: Tokens | null,
  who?: { operator: string; company: string; role: SessionRole }
): void {
  tokens = next;
  if (who) identity = who;
  if (next === null) identity = null;
}

export function currentTokens(): Tokens | null {
  return tokens;
}

export const api = new ApiClient({
  baseUrl: API_BASE_URL,
  getTokens: () => tokens,
  onTokens: (next) => {
    tokens = next;
    // A refreshed pair must reach storage, or a relaunch resurrects the spent
    // refresh token and the backend's reuse detection kills the whole chain.
    if (identity) {
      void saveSession({
        token: next.accessToken,
        refreshToken: next.refreshToken,
        operator: identity.operator,
        company: identity.company,
        role: identity.role,
        issuedAt: Date.now(),
      });
    }
  },
  onSignedOut: () => {
    tokens = null;
    identity = null;
    onExpired?.();
  },
});

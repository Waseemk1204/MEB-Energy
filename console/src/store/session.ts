import type { Tokens } from '../api/client';

/**
 * Where the console keeps its tokens.
 *
 * `sessionStorage`, not `localStorage`, and the difference is deliberate:
 *
 * · It is scoped to the tab. Closing the tab ends the session, which is the
 *   behaviour an administrator expects from a console that can suspend
 *   accounts and push parameter changes to physical batteries.
 * · It does not follow the user to a second tab or survive a browser restart,
 *   so an unattended machine leaks less.
 *
 * What this does **not** do is defend against XSS. Any script running on this
 * origin can read `sessionStorage`, exactly as it could read `localStorage`.
 * The only real fix is an httpOnly, SameSite cookie issued by the backend, and
 * that is a backend change this console cannot make on its own. Recording it
 * here rather than implying the current arrangement is sufficient:
 *
 *   → Before this console is exposed beyond an internal network, `/auth/login`
 *     should set the refresh token as an httpOnly cookie and this module
 *     should hold only the short-lived access token in memory.
 */

const KEY = 'knowyourev.console.session';

export interface StoredSession extends Tokens {
  user: SessionUser;
  company: { id: string; name: string } | null;
  issuedAt: number;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'company' | 'user';
}

/** Matches the app: a session older than this restores as signed out. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Who the console is for.
 *
 * A technician's account can sign in to the API perfectly well — it simply has
 * no business here. Turning them away at the door is a courtesy, not a control:
 * every route they could reach is enforced server-side regardless, and this
 * check exists so they get an explanation instead of a wall of empty panels.
 */
export function mayUseConsole(role: SessionUser['role']): boolean {
  return role === 'admin' || role === 'company';
}

type Backend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function backend(): Backend | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Storage disabled entirely. The session lives in memory for this page.
    return null;
  }
}

export function loadSession(now = Date.now()): StoredSession | null {
  try {
    const raw = backend()?.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      !parsed?.accessToken ||
      !parsed.refreshToken ||
      !parsed.user?.id ||
      !parsed.user.role ||
      typeof parsed.issuedAt !== 'number'
    ) {
      clearSession();
      return null;
    }

    if (now - parsed.issuedAt > SESSION_MAX_AGE_MS) {
      clearSession();
      return null;
    }

    // A stored session for a role that cannot use the console is not a session.
    if (!mayUseConsole(parsed.user.role)) {
      clearSession();
      return null;
    }

    return parsed as StoredSession;
  } catch {
    // Corrupt storage fails closed to signed-out rather than half-valid.
    clearSession();
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    backend()?.setItem(KEY, JSON.stringify(session));
  } catch {
    /* best effort — the in-memory session still works for this page */
  }
}

export function clearSession(): void {
  try {
    backend()?.removeItem(KEY);
  } catch {
    /* already gone */
  }
}

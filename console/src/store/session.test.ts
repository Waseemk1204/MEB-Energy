import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_MAX_AGE_MS,
  clearSession,
  loadSession,
  mayUseConsole,
  saveSession,
  type StoredSession,
} from './session';

const KEY = 'knowyourev.console.session';
const NOW = 1_700_000_000_000;

const session = (over: Partial<StoredSession> = {}): StoredSession => ({
  accessToken: 'access-abc',
  refreshToken: 'refresh-abc',
  user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
  company: null,
  issuedAt: NOW,
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
});

describe('who the console is for', () => {
  it('admits an administrator', () => {
    expect(mayUseConsole('admin')).toBe(true);
  });

  it('admits a company owner', () => {
    expect(mayUseConsole('company')).toBe(true);
  });

  /**
   * A technician's account signs in to the API fine — it just has no business
   * here. This is a courtesy so they get an explanation rather than a wall of
   * empty panels; every route is enforced server-side regardless.
   */
  it('turns away a technician', () => {
    expect(mayUseConsole('user')).toBe(false);
  });
});

describe('storing a session', () => {
  it('round-trips', () => {
    saveSession(session());
    expect(loadSession(NOW)?.user.email).toBe('ops@knowyourev.example');
  });

  it('keeps the company for a company owner', () => {
    saveSession(
      session({
        user: { id: 'u2', email: 'owner@acme.example', displayName: 'Owner', role: 'company' },
        company: { id: 'c1', name: 'Acme EV' },
      })
    );
    expect(loadSession(NOW)?.company?.name).toBe('Acme EV');
  });

  it('uses sessionStorage, so closing the tab ends the session', () => {
    saveSession(session());
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('clears on request', () => {
    saveSession(session());
    clearSession();
    expect(loadSession(NOW)).toBeNull();
  });
});

describe('sessions that must not be restored', () => {
  it('rejects one past its maximum age', () => {
    saveSession(session({ issuedAt: NOW - SESSION_MAX_AGE_MS - 1 }));
    expect(loadSession(NOW)).toBeNull();
  });

  it('accepts one just inside it', () => {
    saveSession(session({ issuedAt: NOW - SESSION_MAX_AGE_MS + 1000 }));
    expect(loadSession(NOW)).not.toBeNull();
  });

  it('clears an expired one rather than leaving it to fail again', () => {
    saveSession(session({ issuedAt: NOW - SESSION_MAX_AGE_MS - 1 }));
    loadSession(NOW);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('rejects one with no refresh token, which could never be renewed', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...session(), refreshToken: undefined })
    );
    expect(loadSession(NOW)).toBeNull();
  });

  /** A role that cannot use the console is not a console session. */
  it('rejects a stored technician session', () => {
    saveSession(
      session({ user: { id: 'u3', email: 'tech@acme.example', displayName: 'T', role: 'user' } })
    );
    expect(loadSession(NOW)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('survives corrupt storage rather than throwing', () => {
    sessionStorage.setItem(KEY, '{"accessToken":"a"');
    expect(loadSession(NOW)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(loadSession(NOW)).toBeNull();
  });
});

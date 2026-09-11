/**
 * Storage-backed session rules. Mocks both backends so the test is meaningful
 * whichever platform jest resolves Platform.OS to.
 */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

// The web branch reads globalThis.localStorage.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mockStore.get(k) ?? null,
    setItem: (k: string, v: string) => mockStore.set(k, v),
    removeItem: (k: string) => mockStore.delete(k),
  },
});

/* eslint-disable import/first -- the mock factories above capture module-scope
   variables, so they must be defined before the module under test is imported. */
import {
  SESSION_MAX_AGE_MS,
  clearSession,
  loadSession,
  saveSession,
  type PersistedSession,
} from './sessionStorage';

const KEY = 'knowyourev.session';

const valid = (over: Partial<PersistedSession> = {}): PersistedSession => ({
  token: 'access-abc',
  refreshToken: 'refresh-abc',
  operator: 'w.khan@aurorafleet.example',
  company: 'Aurora Fleet',
  role: 'user',
  issuedAt: Date.now(),
  ...over,
});

beforeEach(() => mockStore.clear());

describe('loadSession', () => {
  it('returns null when nothing is stored', async () => {
    expect(await loadSession()).toBeNull();
  });

  it('round-trips a valid session', async () => {
    const s = valid();
    await saveSession(s);
    expect(await loadSession()).toEqual(s);
  });

  it('restores a session just inside the max age', async () => {
    await saveSession(valid({ issuedAt: Date.now() - (SESSION_MAX_AGE_MS - 60_000) }));
    expect(await loadSession()).not.toBeNull();
  });

  /** PRD §8.1 — short-lived tokens. An old session must not silently persist. */
  it('rejects and purges a session past the max age', async () => {
    await saveSession(valid({ issuedAt: Date.now() - (SESSION_MAX_AGE_MS + 60_000) }));
    expect(await loadSession()).toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  it('rejects and purges a record with no token', async () => {
    mockStore.set(KEY, JSON.stringify({ operator: 'x', issuedAt: Date.now() }));
    expect(await loadSession()).toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  it('rejects and purges a record with no operator', async () => {
    mockStore.set(KEY, JSON.stringify({ token: 't', issuedAt: Date.now() }));
    expect(await loadSession()).toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  it('rejects a record whose issuedAt is not a number', async () => {
    mockStore.set(KEY, JSON.stringify({ token: 't', operator: 'x', issuedAt: 'yesterday' }));
    expect(await loadSession()).toBeNull();
  });

  it('fails closed on unparseable JSON rather than throwing', async () => {
    mockStore.set(KEY, '{"token":"x","oper');
    await expect(loadSession()).resolves.toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  /**
   * A missing company must not drop the session — but it must not be filled in
   * either. A plausible default here is how every tenant came to see the same
   * wrong name in their header.
   */
  it('keeps a session whose company is missing', async () => {
    mockStore.set(
      KEY,
      JSON.stringify({ token: 't', refreshToken: 'r', operator: 'x', issuedAt: Date.now() })
    );
    expect(await loadSession()).not.toBeNull();
  });

  it('invents no company name for one', async () => {
    mockStore.set(
      KEY,
      JSON.stringify({ token: 't', refreshToken: 'r', operator: 'x', issuedAt: Date.now() })
    );
    const loaded = await loadSession();
    expect(loaded?.company).toBe('');
  });
});

describe('clearSession', () => {
  it('removes the stored record', async () => {
    await saveSession(valid());
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it('is safe to call when nothing is stored', async () => {
    await expect(clearSession()).resolves.toBeUndefined();
  });
});

/**
 * The stored role decides which screen a restored session opens on. It is not
 * a permission: every route it reaches is checked again on the server against
 * the token, so tampering with it changes what the app shows and nothing else.
 */
describe('the stored role', () => {
  it('comes back as it went in', async () => {
    await saveSession(valid({ role: 'admin' }));
    expect((await loadSession())?.role).toBe('admin');
  });

  /** A session stored before roles existed must not open an admin screen. */
  it('falls back to the least privileged role when absent', async () => {
    const { role: _role, ...withoutRole } = valid();
    mockStore.set(KEY, JSON.stringify(withoutRole));
    expect((await loadSession())?.role).toBe('user');
  });

  it('refuses a role nobody defined', async () => {
    mockStore.set(KEY, JSON.stringify({ ...valid(), role: 'superuser' }));
    expect((await loadSession())?.role).toBe('user');
  });
});

describe('what is deliberately not persisted', () => {
  /**
   * A BLE link cannot survive process death. Restoring one would open the
   * Dashboard on live-looking gauges for a pack the phone is not talking to.
   */
  it('never stores a connected battery id', async () => {
    await saveSession(valid());
    const raw = mockStore.get(KEY)!;
    expect(raw).not.toMatch(/BAT-/);
    // The exact set, so that persisting anything new is a deliberate act with
    // this test in front of it rather than something that drifted in.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'company',
      'issuedAt',
      'operator',
      'refreshToken',
      'role',
      'token',
    ]);
  });
});

describe('sessions that predate refresh tokens', () => {
  it('does not restore one, because it could never be renewed', async () => {
    // Shape written by an earlier build: an access token and nothing to renew
    // it with. Restoring it would look fine until the first 401.
    mockStore.set(
      KEY,
      JSON.stringify({
        token: 'access-abc',
        operator: 'w.khan@aurorafleet.example',
        company: 'Aurora Fleet',
        issuedAt: Date.now(),
      })
    );
    expect(await loadSession()).toBeNull();
  });

  it('clears it rather than leaving it to fail again next launch', async () => {
    mockStore.set(
      KEY,
      JSON.stringify({ token: 'access-abc', operator: 'w', issuedAt: Date.now() })
    );
    await loadSession();
    expect(mockStore.get(KEY)).toBeUndefined();
  });
});

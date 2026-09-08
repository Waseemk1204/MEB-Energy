import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Persisted session.
 *
 * What is deliberately NOT here: `connectedBatteryId`. A BLE link cannot
 * survive process death — restoring one would open the Dashboard on live-looking
 * gauges for a pack the phone is no longer talking to. On relaunch the user
 * always lands on the Battery List and re-establishes the link, which is both
 * honest and what the Mode 1 architecture assumes.
 */
export interface PersistedSession {
  /** Short-lived (15 min) bearer token from POST /auth/login. */
  token: string;
  /**
   * Long-lived, single-use. The backend revokes an entire token chain if one
   * is presented twice, so this must never be copied or replayed.
   */
  refreshToken: string;
  operator: string;
  company: string;
  /** Epoch ms. */
  issuedAt: number;
}

const KEY = 'knowyourev.session';

/** Sessions older than this restore as signed out (PRD §8.1: short-lived tokens). */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * expo-secure-store is native-only. On web it is unavailable, so the dev/web
 * target falls back to localStorage — which is NOT secure storage and must
 * never hold a real production token. Web is a development surface for this
 * app; iOS and Android are the shipping targets and use the Keychain/Keystore.
 */
export const secureBackend = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* private mode, storage disabled — session simply won't persist */
      }
      return;
    }
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* nothing to clean up */
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export async function loadSession(): Promise<PersistedSession | null> {
  try {
    const raw = await secureBackend.get(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    // A session stored before refresh tokens existed cannot be renewed, so it
    // is not a usable session. Fail closed: one re-login beats a stored
    // credential that silently cannot survive its first expiry.
    if (
      !parsed?.token ||
      !parsed.refreshToken ||
      !parsed.operator ||
      typeof parsed.issuedAt !== 'number'
    ) {
      await secureBackend.remove(KEY);
      return null;
    }
    if (Date.now() - parsed.issuedAt > SESSION_MAX_AGE_MS) {
      await secureBackend.remove(KEY);
      return null;
    }
    return {
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      operator: parsed.operator,
      // No invented name. A stored session without one is restored without
      // one, and the header says so — putting a plausible company here means
      // every tenant that hit this path would see the same wrong name.
      company: parsed.company ?? '',
      issuedAt: parsed.issuedAt,
    };
  } catch {
    // Corrupt or unreadable store: fail closed to signed-out rather than
    // guessing at a half-valid session.
    await secureBackend.remove(KEY).catch(() => undefined);
    return null;
  }
}

export async function saveSession(session: PersistedSession): Promise<void> {
  try {
    await secureBackend.set(KEY, JSON.stringify(session));
  } catch {
    /* persistence is best-effort; the in-memory session still works */
  }
}

export async function clearSession(): Promise<void> {
  try {
    await secureBackend.remove(KEY);
  } catch {
    /* already gone */
  }
}

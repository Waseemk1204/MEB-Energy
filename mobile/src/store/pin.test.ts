const mockStore = new Map<string, string>();
let mockRandomByte = 7;

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

jest.mock('expo-crypto', () => ({
  // Not real SHA-256, but order-sensitive and collision-free for these inputs,
  // which is all that is needed to prove the salting and comparison wiring.
  digestStringAsync: jest.fn(async (_alg: string, data: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      h ^= data.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(64, '0');
  }),
  getRandomBytes: jest.fn((n: number) => new Uint8Array(n).fill(mockRandomByte)),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

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
import { PIN_DIGITS, clearPin, isValidPinFormat, loadPin, savePin, verifyPin } from './pin';

const KEY = 'knowyourev.pin';

beforeEach(() => {
  mockStore.clear();
  mockRandomByte = 7;
});

describe('isValidPinFormat', () => {
  it('accepts exactly the required number of digits', () => {
    expect(isValidPinFormat('4'.repeat(PIN_DIGITS))).toBe(true);
  });

  it('rejects a short or long PIN', () => {
    expect(isValidPinFormat('4'.repeat(PIN_DIGITS - 1))).toBe(false);
    expect(isValidPinFormat('4'.repeat(PIN_DIGITS + 1))).toBe(false);
  });

  it('rejects anything that is not digits', () => {
    expect(isValidPinFormat('12a456')).toBe(false);
    expect(isValidPinFormat('12 456')).toBe(false);
    expect(isValidPinFormat('')).toBe(false);
  });
});

describe('storage', () => {
  /** A Keychain dump must not hand over the digits themselves. */
  it('never writes the PIN in the clear', async () => {
    await savePin('481902');
    const raw = mockStore.get(KEY)!;
    expect(raw).not.toContain('481902');
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({ salt: expect.any(String), hash: expect.any(String) })
    );
  });

  it('records when the PIN was set', async () => {
    const before = Date.now();
    await savePin('481902');
    const stored = await loadPin();
    expect(stored!.setAt).toBeGreaterThanOrEqual(before);
  });

  it('salts each PIN, so the same digits do not produce the same hash', async () => {
    await savePin('481902');
    const first = JSON.parse(mockStore.get(KEY)!);

    mockRandomByte = 9; // a different random salt next time
    await savePin('481902');
    const second = JSON.parse(mockStore.get(KEY)!);

    expect(second.salt).not.toBe(first.salt);
    expect(second.hash).not.toBe(first.hash);
  });

  it('replaces the PIN rather than accumulating records', async () => {
    await savePin('481902');
    await savePin('730154');
    expect(await verifyPin('481902')).toBe(false);
    expect(await verifyPin('730154')).toBe(true);
  });
});

describe('verifyPin', () => {
  it('accepts the PIN that was set', async () => {
    await savePin('481902');
    expect(await verifyPin('481902')).toBe(true);
  });

  it('rejects a wrong PIN', async () => {
    await savePin('481902');
    expect(await verifyPin('000000')).toBe(false);
  });

  it('rejects everything when no PIN is stored', async () => {
    expect(await verifyPin('481902')).toBe(false);
  });

  it('rejects after the PIN is cleared', async () => {
    await savePin('481902');
    await clearPin();
    expect(await verifyPin('481902')).toBe(false);
  });

  it('is not fooled by a prefix or suffix of the real PIN', async () => {
    await savePin('481902');
    expect(await verifyPin('48190')).toBe(false);
    expect(await verifyPin('4819021')).toBe(false);
  });
});

describe('loadPin', () => {
  it('returns null when nothing is stored', async () => {
    expect(await loadPin()).toBeNull();
  });

  it('purges a record missing its salt', async () => {
    mockStore.set(KEY, JSON.stringify({ hash: 'abc', setAt: Date.now() }));
    expect(await loadPin()).toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  it('purges a record missing its hash', async () => {
    mockStore.set(KEY, JSON.stringify({ salt: 'abc', setAt: Date.now() }));
    expect(await loadPin()).toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });

  it('fails closed on unparseable JSON', async () => {
    mockStore.set(KEY, '{"salt":"a","ha');
    await expect(loadPin()).resolves.toBeNull();
    expect(mockStore.get(KEY)).toBeUndefined();
  });
});

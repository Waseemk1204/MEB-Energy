let mockStoredPin: string | null = null;

jest.mock('./pin', () => ({
  loadPin: jest.fn(async () =>
    mockStoredPin ? { salt: 's', hash: `h:${mockStoredPin}`, setAt: 1_700_000_000_000 } : null
  ),
  savePin: jest.fn(async (pin: string) => {
    mockStoredPin = pin;
  }),
  clearPin: jest.fn(async () => {
    mockStoredPin = null;
  }),
  verifyPin: jest.fn(async (pin: string) => mockStoredPin !== null && pin === mockStoredPin),
}));

/* eslint-disable import/first -- the mock factories above capture module-scope
   variables, so they must be defined before the module under test is imported. */
import { MAX_PIN_ATTEMPTS, lockoutSecondsLeft, useSecurityStore } from './useSecurityStore';

const reset = () => {
  mockStoredPin = null;
  useSecurityStore.setState({
    hydrated: false,
    pinSet: false,
    pinSetAt: null,
    failedAttempts: 0,
    lockedUntil: null,
  });
};

beforeEach(reset);

describe('hydration', () => {
  it('reports no PIN when none is stored', async () => {
    await useSecurityStore.getState().hydrate();
    expect(useSecurityStore.getState()).toMatchObject({ hydrated: true, pinSet: false });
  });

  it('reports a stored PIN and when it was set', async () => {
    mockStoredPin = '481902';
    await useSecurityStore.getState().hydrate();
    expect(useSecurityStore.getState().pinSet).toBe(true);
    expect(useSecurityStore.getState().pinSetAt).toBe(1_700_000_000_000);
  });
});

describe('set and remove', () => {
  it('marks the PIN set and clears any prior lockout', async () => {
    useSecurityStore.setState({ failedAttempts: 3, lockedUntil: Date.now() + 10_000 });
    await useSecurityStore.getState().setPin('481902');
    expect(useSecurityStore.getState()).toMatchObject({
      pinSet: true,
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  it('removing the PIN also clears the lockout', async () => {
    await useSecurityStore.getState().setPin('481902');
    useSecurityStore.setState({ failedAttempts: 2 });
    await useSecurityStore.getState().removePin();
    expect(useSecurityStore.getState()).toMatchObject({
      pinSet: false,
      pinSetAt: null,
      failedAttempts: 0,
    });
  });
});

describe('check', () => {
  beforeEach(async () => {
    await useSecurityStore.getState().setPin('481902');
  });

  it('accepts the correct PIN', async () => {
    await expect(useSecurityStore.getState().check('481902')).resolves.toBe(true);
  });

  it('rejects a wrong PIN', async () => {
    await expect(useSecurityStore.getState().check('000000')).resolves.toBe(false);
  });

  it('counts failures', async () => {
    await useSecurityStore.getState().check('000000');
    await useSecurityStore.getState().check('111111');
    expect(useSecurityStore.getState().failedAttempts).toBe(2);
  });

  it('resets the counter on success', async () => {
    await useSecurityStore.getState().check('000000');
    await useSecurityStore.getState().check('481902');
    expect(useSecurityStore.getState().failedAttempts).toBe(0);
    expect(useSecurityStore.getState().lockedUntil).toBeNull();
  });

  it('locks out after the maximum attempts', async () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      await useSecurityStore.getState().check('000000');
    }
    expect(useSecurityStore.getState().failedAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(useSecurityStore.getState().lockedUntil).toBeGreaterThan(Date.now());
  });

  /** The lockout must hold even against the correct PIN, or it is decorative. */
  it('refuses the correct PIN while locked out', async () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      await useSecurityStore.getState().check('000000');
    }
    await expect(useSecurityStore.getState().check('481902')).resolves.toBe(false);
  });

  it('accepts the correct PIN once the lockout has expired', async () => {
    useSecurityStore.setState({ failedAttempts: MAX_PIN_ATTEMPTS, lockedUntil: Date.now() - 1 });
    await expect(useSecurityStore.getState().check('481902')).resolves.toBe(true);
  });

  it('never verifies when no PIN is stored', async () => {
    await useSecurityStore.getState().removePin();
    await expect(useSecurityStore.getState().check('481902')).resolves.toBe(false);
  });
});

describe('lockoutSecondsLeft', () => {
  it('is zero when not locked', () => {
    expect(lockoutSecondsLeft(null)).toBe(0);
  });

  it('is zero once the deadline has passed', () => {
    expect(lockoutSecondsLeft(Date.now() - 5000)).toBe(0);
  });

  it('rounds up remaining time', () => {
    expect(lockoutSecondsLeft(Date.now() + 4200)).toBe(5);
  });
});

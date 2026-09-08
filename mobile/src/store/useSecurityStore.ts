import { create } from 'zustand';
import { clearPin, loadPin, savePin, verifyPin } from './pin';

/**
 * Whether a PIN guards critical writes, and the lockout that stops the prompt
 * being brute-forced by repeated guessing at a bench.
 */

export const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

type SecurityState = {
  hydrated: boolean;
  pinSet: boolean;
  pinSetAt: number | null;
  failedAttempts: number;
  lockedUntil: number | null;

  hydrate: () => Promise<void>;
  setPin: (pin: string) => Promise<void>;
  removePin: () => Promise<void>;
  /** Returns true on success; increments the lockout counter on failure. */
  check: (pin: string) => Promise<boolean>;
  resetAttempts: () => void;
};

export const useSecurityStore = create<SecurityState>((set, get) => ({
  hydrated: false,
  pinSet: false,
  pinSetAt: null,
  failedAttempts: 0,
  lockedUntil: null,

  hydrate: async () => {
    const stored = await loadPin();
    set({ hydrated: true, pinSet: !!stored, pinSetAt: stored?.setAt ?? null });
  },

  setPin: async (pin) => {
    await savePin(pin);
    set({ pinSet: true, pinSetAt: Date.now(), failedAttempts: 0, lockedUntil: null });
  },

  removePin: async () => {
    await clearPin();
    set({ pinSet: false, pinSetAt: null, failedAttempts: 0, lockedUntil: null });
  },

  check: async (pin) => {
    const { lockedUntil } = get();
    if (lockedUntil && Date.now() < lockedUntil) return false;

    const ok = await verifyPin(pin);
    if (ok) {
      set({ failedAttempts: 0, lockedUntil: null });
      return true;
    }

    const failedAttempts = get().failedAttempts + 1;
    set({
      failedAttempts,
      lockedUntil: failedAttempts >= MAX_PIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : null,
    });
    return false;
  },

  resetAttempts: () => set({ failedAttempts: 0, lockedUntil: null }),
}));

/** Seconds left on a lockout, or 0. */
export function lockoutSecondsLeft(lockedUntil: number | null): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
}

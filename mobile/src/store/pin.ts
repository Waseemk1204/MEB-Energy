import * as Crypto from 'expo-crypto';
import { secureBackend } from './sessionStorage';

/**
 * Local PIN for critical writes (PRD §6.2's optional PIN/re-authentication step).
 *
 * WHAT THIS IS: a deliberate-action gate. It stops a mistap from weakening a
 * protection threshold, and stops someone who picks up an unlocked phone on a
 * workshop bench from doing the same.
 *
 * WHAT THIS IS NOT: authentication, or a security boundary. The real boundary
 * is server-side policy enforcement (PRD §5.2 — "UI hiding of controls is never
 * the security boundary"). A determined attacker with the device is not stopped
 * by this, and nothing in the backend should ever trust it.
 *
 * The PIN is stored salted and hashed rather than in the clear, so a Keychain
 * dump does not hand over the digits themselves.
 */

const PIN_KEY = 'knowyourev.pin';

interface StoredPin {
  salt: string;
  hash: string;
  /** Epoch ms, for "PIN set on ..." in Settings. */
  setAt: number;
}

const PIN_LENGTH = 6;

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

export const PIN_DIGITS = PIN_LENGTH;

async function hashPin(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

export async function loadPin(): Promise<StoredPin | null> {
  try {
    const raw = await secureBackend.get(PIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin>;
    if (!parsed?.salt || !parsed.hash) {
      await secureBackend.remove(PIN_KEY);
      return null;
    }
    return { salt: parsed.salt, hash: parsed.hash, setAt: parsed.setAt ?? 0 };
  } catch {
    await secureBackend.remove(PIN_KEY).catch(() => undefined);
    return null;
  }
}

export async function savePin(pin: string): Promise<void> {
  const salt = Array.from(Crypto.getRandomBytes(16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hash = await hashPin(pin, salt);
  await secureBackend.set(PIN_KEY, JSON.stringify({ salt, hash, setAt: Date.now() }));
}

export async function clearPin(): Promise<void> {
  await secureBackend.remove(PIN_KEY).catch(() => undefined);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await loadPin();
  if (!stored) return false;
  const hash = await hashPin(pin, stored.salt);
  // Constant-time-ish compare. Both operands are fixed-length hex digests, so
  // this leaks nothing useful about the PIN either way.
  if (hash.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

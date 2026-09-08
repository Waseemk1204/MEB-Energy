import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard and built into Node, which matters here for a reason
 * beyond cryptography: it needs no native compilation. bcrypt and argon2 both
 * ship prebuilt binaries, and a prebuilt binary is exactly what segfaulted this
 * project's first database driver.
 *
 * Parameters are stored alongside the hash, so they can be raised later without
 * invalidating existing passwords — an old hash keeps verifying with the cost it
 * was created at, and can be upgraded on next successful sign-in.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** ~64 MB, ~100 ms. Raise N as hardware improves; stored hashes stay valid. */
export const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Headroom over N·r·128 so raising the cost does not hit the default cap. */
const maxmemFor = (N: number, r: number) => 256 * N * r;

export async function hashPassword(
  password: string,
  cost: { N: number; r: number; p: number } = DEFAULT_COST
): Promise<string> {
  if (!password) throw new Error('Password must not be empty');

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    ...cost,
    maxmem: maxmemFor(cost.N, cost.r),
  });

  return [
    'scrypt',
    cost.N,
    cost.r,
    cost.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time comparison. Returns false rather than throwing on a malformed
 * stored hash: a corrupt record must fail closed, not crash the sign-in path.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(
  stored: string,
  cost: { N: number; r: number; p: number } = DEFAULT_COST
): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < cost.N || Number(parts[2]) < cost.r;
}

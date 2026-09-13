import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Store } from '../db/client.js';
import { isRole, type Principal, type Role } from '../db/tenancy.js';

/**
 * Short-lived access tokens with rotating refresh tokens (PRD §8.1).
 *
 * The property worth the complexity is **reuse detection**. Refresh tokens
 * rotate on every use, and presenting one that has already been rotated means
 * either an attacker replayed a stolen token or the legitimate client did — and
 * we cannot tell which. So the whole chain for that user is revoked, forcing a
 * fresh sign-in. Losing a session is a small cost; leaving a stolen refresh
 * token live is not.
 */

/** Deliberately short — a leaked access token should expire before it is useful. */
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const ISSUER = 'meb-energy';
const AUDIENCE = 'meb-energy-app';

export interface AccessClaims extends JWTPayload {
  sub: string;
  role: Role;
  /** The company. Every principal is tenant-bound. */
  cid: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_token'
      | 'expired_token'
      | 'reuse_detected'
      | 'revoked'
      | 'unknown_token'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function secretFrom(value: string): Uint8Array {
  if (value.length < 32) {
    throw new Error('Signing secret must be at least 32 characters');
  }
  return new TextEncoder().encode(value);
}

export async function issueAccessToken(
  principal: Principal,
  secret: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  return new SignJWT({ role: principal.role, cid: principal.companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ACCESS_TTL_SECONDS)
    .sign(secret);
}

export async function verifyAccessToken(token: string, secret: Uint8Array): Promise<Principal> {
  try {
    const { payload } = await jwtVerify<AccessClaims>(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });

    if (!payload.sub || !payload.role || !payload.cid) {
      throw new AuthError('Token is missing required claims', 'invalid_token');
    }

    // The same rule the schema enforces: every account belongs to the company
    // and holds one of the two roles. A token from before that was true — a
    // platform administrator's, say — is malformed regardless of a valid
    // signature.
    if (!isRole(payload.role)) {
      throw new AuthError('Token carries an unknown role', 'invalid_token');
    }

    return { userId: payload.sub, role: payload.role, companyId: payload.cid };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const code = (error as { code?: string }).code;
    throw new AuthError(
      'Access token is not valid',
      code === 'ERR_JWT_EXPIRED' ? 'expired_token' : 'invalid_token'
    );
  }
}

/* --------------------------------------------------------- refresh tokens */

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

interface RefreshRow {
  id: string;
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
  replaced_by: string | null;
  device_label: string | null;
}

export interface IssuedRefresh {
  token: string;
  id: string;
  userId: string;
  expiresAt: number;
}

/** Raw token is returned once and never stored — only its hash is kept. */
export async function issueRefreshToken(
  store: Store,
  userId: string,
  now = Date.now(),
  /**
   * What the person is signing in on, so a session can be named. Carried
   * across rotation so a device keeps its name for the life of the session
   * rather than becoming anonymous the first time its token renews.
   */
  deviceLabel: string | null = null
): Promise<IssuedRefresh> {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expiresAt = now + REFRESH_TTL_MS;

  await store.run(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, device_label) VALUES (?,?,?,?,?,?)',
    id,
    userId,
    hashToken(token),
    expiresAt,
    now,
    deviceLabel
  );

  return { token, id, userId, expiresAt };
}

export async function revokeAllForUser(store: Store, userId: string, now = Date.now()): Promise<void> {
  await store.run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    now,
    userId
  );
}

/**
 * Exchanges a refresh token for a new one.
 *
 * Presenting an already-rotated token is treated as compromise: every token for
 * that user is revoked. We cannot distinguish a replayed steal from a confused
 * client, and only one of those is safe to assume.
 */
export async function rotateRefreshToken(
  store: Store,
  rawToken: string,
  now = Date.now()
): Promise<IssuedRefresh> {
  const row = await store.get<RefreshRow>(
    'SELECT id, user_id, expires_at, revoked_at, replaced_by, device_label FROM refresh_tokens WHERE token_hash = ?',
    hashToken(rawToken)
  );

  if (!row) throw new AuthError('Refresh token is not recognised', 'unknown_token');

  if (row.revoked_at !== null) {
    await revokeAllForUser(store, row.user_id, now);
    throw new AuthError(
      'Refresh token has already been used; all sessions for this user were revoked',
      'reuse_detected'
    );
  }

  if (row.expires_at <= now) {
    throw new AuthError('Refresh token has expired', 'expired_token');
  }

  return await store.transaction(async () => {
    // Rotation is the same device continuing, not a new one, so it keeps the
    // label.
    const next = await issueRefreshToken(store, row.user_id, now, row.device_label ?? null);
    await store.run(
      'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?',
      now,
      next.id,
      row.id
    );
    return next;
  });
}

/** Sign-out. Idempotent: an unknown token is not an error worth surfacing. */
export async function revokeRefreshToken(store: Store, rawToken: string, now = Date.now()): Promise<void> {
  await store.run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    now,
    hashToken(rawToken)
  );
}

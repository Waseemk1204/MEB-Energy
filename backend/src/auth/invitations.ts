import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from '../db/client.js';
import { hashPassword } from './password.js';

/**
 * Invitations — letting a new user set their own first password.
 *
 * Before this, creating a user meant an administrator choosing that person's
 * password and then knowing it. Generating it and showing it once removed the
 * weak-and-reused failure modes but not the fundamental one: somebody else's
 * credential passed through a third party's hands.
 *
 * An invitation replaces that. The account is created with no usable password
 * and cannot sign in; a single-use link lets the person set one themselves,
 * and nobody else ever sees it.
 *
 * **What this does not fix, and cannot yet.** There is no email delivery, so an
 * administrator still has to hand the link over — and whoever holds an unused
 * link can claim that account. Single use and a short expiry bound the damage:
 * once the invited person accepts, the link is spent, and an administrator who
 * used it first would be visible as an account that was accepted before the
 * person was told about it. When email delivery exists, only the delivery
 * changes; nothing here does.
 */

/** Long enough that guessing is not a strategy. 32 bytes, base64url. */
const TOKEN_BYTES = 32;

/** A week is long enough for a new starter and short enough to matter. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The placeholder in `password_hash` for an account that has never had one.
 *
 * The column is NOT NULL, and this value is deliberately not a valid scrypt
 * hash — `verifyPassword` fails closed on a malformed hash, so an invited
 * account cannot be signed into even if the status check were somehow missed.
 * Two independent reasons for the same refusal.
 */
export const NO_PASSWORD = '$invited$';

export class InvitationError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'expired' | 'already_used' | 'weak_password'
  ) {
    super(message);
    this.name = 'InvitationError';
  }
}

/** Matches the console's generated passwords and the bootstrap minimum. */
export const MIN_PASSWORD_LENGTH = 12;

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export interface Invitation {
  token: string;
  invitationId: string;
  expiresAt: number;
}

export async function createInvitation(
  store: Store,
  userId: string,
  invitedBy: string,
  now = Date.now()
): Promise<Invitation> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const invitationId = randomUUID();
  const expiresAt = now + INVITATION_TTL_MS;

  await store.run(
    `INSERT INTO user_invitations (id, user_id, token_hash, invited_by, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
    invitationId,
    userId,
    // Stored hashed, like a refresh token: a database dump must not hand
    // someone every outstanding invitation.
    hashToken(token),
    invitedBy,
    expiresAt,
    now
  );

  return { token, invitationId, expiresAt };
}

interface InvitationRow {
  id: string;
  user_id: string;
  expires_at: number;
  accepted_at: number | null;
}

/**
 * Accept an invitation and set the account's first password.
 *
 * Every failure — unknown token, expired, already used — is reported with the
 * same shape, and the caller maps them all to one message. Distinguishing them
 * would let someone with a guessed token learn whether it ever existed.
 */
export async function acceptInvitation(
  store: Store,
  rawToken: string,
  password: string,
  now = Date.now()
): Promise<{ userId: string }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new InvitationError(
      `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
      'weak_password'
    );
  }

  const row = await store.get<InvitationRow>(
    'SELECT id, user_id, expires_at, accepted_at FROM user_invitations WHERE token_hash = ?',
    hashToken(rawToken)
  );

  if (!row) throw new InvitationError('That invitation is not valid', 'not_found');
  if (row.accepted_at !== null) {
    throw new InvitationError('That invitation has already been used', 'already_used');
  }
  if (row.expires_at <= now) {
    throw new InvitationError('That invitation has expired', 'expired');
  }

  const hash = await hashPassword(password);

  await store.transaction(async () => {
    // Marking the invitation and activating the account must happen together:
    // an account activated without its invitation being spent would leave a
    // working link behind it.
    await store.run('UPDATE user_invitations SET accepted_at = ? WHERE id = ?', now, row.id);
    await store.run(
      "UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?",
      hash,
      row.user_id
    );
  });

  return { userId: row.user_id };
}

/** For the console: what is still outstanding, without exposing any token. */
export interface PendingInvitation {
  userId: string;
  expiresAt: number;
  invitedBy: string;
}

export async function pendingInvitations(store: Store, userIds: string[]): Promise<Map<string, PendingInvitation>> {
  if (userIds.length === 0) return new Map();

  const placeholders = userIds.map(() => '?').join(',');
  const rows = await store.all<{
    user_id: string;
    expires_at: number;
    invited_by: string;
  }>(
    `SELECT user_id, expires_at, invited_by FROM user_invitations
     WHERE user_id IN (${placeholders}) AND accepted_at IS NULL
     ORDER BY created_at DESC`,
    ...userIds
  );

  const byUser = new Map<string, PendingInvitation>();
  for (const row of rows) {
    // Rows are newest-first, so the first one seen for a user is the live one.
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        expiresAt: row.expires_at,
        invitedBy: row.invited_by,
      });
    }
  }
  return byUser;
}

/**
 * Constant-time comparison, exported for tests that assert the token is not
 * compared with `===`. Not used on the hash lookup above, which is a database
 * index rather than a comparison.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

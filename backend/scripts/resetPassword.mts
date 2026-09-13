#!/usr/bin/env -S npx tsx
/**
 * Set an account's password, from outside the product.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/resetPassword.mts you@example.com 'a-new-password'
 *   DATABASE_FILE=company.db  npx tsx scripts/resetPassword.mts you@example.com 'a-new-password'
 *
 * There is no self-service recovery in the product, deliberately: it has no
 * email. This is the operator's path -- somebody who holds the database
 * connection string already holds everything, so nothing new is granted.
 * The bootstrap never touches an existing account, so a changed
 * BOOTSTRAP_ADMIN_PASSWORD does not change anybody's password; this does.
 *
 * Every session for the account is revoked, the same as a suspension: a
 * password that was reset because it may have been known must not leave the
 * old sessions signed in.
 */
import { openStore } from '../src/db/open.js';
import { hashPassword } from '../src/auth/password.js';
import { revokeAllForUser } from '../src/auth/tokens.js';
import { MIN_PASSWORD_LENGTH } from '../src/auth/invitations.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: npx tsx scripts/resetPassword.mts <email> <new password>');
  process.exit(2);
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(2);
}

const { store } = await openStore(process.env);
const user = await store.get<{ id: string; status: string; role: string }>(
  'SELECT id, status, role FROM users WHERE email = ?',
  email.trim().toLowerCase()
);
if (!user) {
  console.error(`No account with the email ${email.trim().toLowerCase()}.`);
  await store.close();
  process.exit(1);
}

await store.run('UPDATE users SET password_hash = ?, status = ? WHERE id = ?', await hashPassword(password), 'active', user.id);
await revokeAllForUser(store, user.id);
console.log(`Password set for ${email.trim().toLowerCase()} (${user.role === 'company' ? 'administrator' : 'technician'}); every existing session signed out.`);
await store.close();

import { ApiClient, ApiError } from './client';
import type { LoginResponse } from './auth';

/**
 * Accepting an invitation: setting your own first password.
 *
 * Unauthenticated by necessity — the person has no credentials yet — so it
 * uses the client's plain `post`. The server signs the person straight in on
 * success and returns the same shape as a login.
 */

/** The server's rule, restated so the screen can say it before the round trip. */
export const MIN_PASSWORD_LENGTH = 12;

export async function acceptInvitation(
  client: ApiClient,
  token: string,
  password: string
): Promise<LoginResponse> {
  try {
    return await client.post<LoginResponse>('/auth/accept-invite', { token, password });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
      // The server folds unknown, expired and already-used into one message
      // on purpose; a weak password is the only failure it names.
      throw new Error(error.body.message || 'That invitation is not valid or has already been used.');
    }
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
}

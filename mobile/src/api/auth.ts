import { ApiClient, ApiError, type Tokens } from './client';

/**
 * Sign-in against the backend (PRD §8.1).
 *
 * There is deliberately no offline fallback. If the server cannot be reached,
 * sign-in fails — an app that logs you in when the network is down is an app
 * where cutting the network is the way in. The dev bypass in config.ts is a
 * build-time switch, visible in the source, not a runtime degradation.
 */

export interface LoginResponse extends Tokens {
  /** 'company' is an administrator, 'user' a technician. */
  user: { id: string; email: string; displayName: string; role: 'company' | 'user' };
  company: { id: string; name: string } | null;
}

export type LoginFailure =
  | { kind: 'credentials' }
  | { kind: 'rate_limited' }
  /** Correct password, but the account may not be used right now. */
  | { kind: 'blocked'; detail: string }
  | { kind: 'unreachable' };

export class LoginError extends Error {
  constructor(
    readonly failure: LoginFailure,
    message: string
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

const MESSAGES: Record<LoginFailure['kind'], string> = {
  // Wrong email and wrong password read identically: telling them apart turns
  // the login form into a directory of who holds an account.
  credentials: 'Email or password is incorrect.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  // Replaced by the server's own wording when it sends one.
  blocked: 'This account cannot be used right now. Contact your administrator.',
  unreachable: 'Cannot reach the server. Check your connection and try again.',
};

export async function login(
  client: ApiClient,
  email: string,
  password: string
): Promise<LoginResponse> {
  try {
    return await client.post<LoginResponse>('/auth/login', { email: email.trim(), password });
  } catch (error) {
    const failure = classify(error);
    // The server's message for a refusal is more useful than ours: it says
    // what to do. Fall back to the generic one only when it sent nothing.
    const message = failure.kind === 'blocked' ? failure.detail : MESSAGES[failure.kind];
    throw new LoginError(failure, message);
  }
}

function classify(error: unknown): LoginFailure {
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: 'rate_limited' };
    // A suspended account answers 401 like any other refusal. The backend
    // will not say "that account exists but is disabled", and neither can
    // this — so there is no 'suspended' outcome to map. A technician locked
    // out this way learns why from their administrator, not from a login form.
    if (error.status === 401 || error.status === 400) return { kind: 'credentials' };

    /*
     * The credentials were right and the server still said no. "Email or
     * password is incorrect" would be both false and unactionable, and
     * "check your connection" sends a technician to debug their signal
     * instead of calling the person who can actually fix it.
     */
    if (error.status === 403) {
      return { kind: 'blocked', detail: error.body.message || MESSAGES.blocked };
    }
  }
  // A transport failure, a 500, or anything unrecognised. All of them mean the
  // same thing to a technician standing in a depot: try again.
  return { kind: 'unreachable' };
}

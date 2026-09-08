import { TenantScopeError } from '../db/tenancy.js';
import { AuthError } from '../auth/tokens.js';
import { AdminError } from '../admin/service.js';
import { BrokerError } from '../broker/commands.js';
import { InvitationError } from '../auth/invitations.js';

/**
 * Error to HTTP mapping.
 *
 * The load-bearing decision here is that a {@link TenantScopeError} becomes
 * **404, not 403**. A 403 confirms the resource exists and belongs to someone
 * else, which hands an attacker a working oracle for enumerating other tenants'
 * batteries. The status, the body and the message are all identical to a
 * genuine miss.
 */

export interface ApiError {
  status: number;
  body: { error: string; message: string; code?: string };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof TenantScopeError) {
    return {
      status: 404,
      body: { error: 'not_found', message: error.message },
    };
  }

  if (error instanceof AuthError) {
    return {
      status: 401,
      body: { error: 'unauthorized', message: error.message, code: error.code },
    };
  }

  if (error instanceof AdminError) {
    return { status: ADMIN_STATUS[error.code], body: { error: error.code, message: error.message } };
  }

  if (error instanceof BrokerError) {
    return {
      status: BROKER_STATUS[error.code],
      body: { error: error.code, message: error.message },
    };
  }

  /**
   * Only `weak_password` reaches here — the route folds every other outcome
   * into one indistinguishable message so a guessed token cannot learn whether
   * it ever existed. This one is safe to name because the caller already holds
   * a valid invitation, and "too short" is the only actionable failure.
   */
  if (error instanceof InvitationError) {
    return {
      status: 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message },
    };
  }

  // Fastify's own errors — a malformed body, an unparseable content type, a
  // payload over the limit — already carry the right status. Letting them fall
  // through to 500 tells a client "the server is broken" when the request was
  // at fault, and buries a fixable client bug under an unhelpful message.
  //
  // Only 4xx is honoured: a Fastify 5xx is still a bug and still says nothing.
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: 'bad_request',
        message: error instanceof Error ? error.message : 'Malformed request',
      },
    };
  }

  // Anything unrecognised is a bug, and its detail is not the caller's business.
  return {
    status: 500,
    body: { error: 'internal_error', message: 'Something went wrong' },
  };
}

/**
 * Seat limits and duplicate emails are conflicts with existing state, not
 * malformed requests — 409 rather than 400, so a client can tell "you asked for
 * something impossible right now" from "you asked wrongly".
 */
const ADMIN_STATUS: Record<AdminError['code'], number> = {
  forbidden: 403,
  seat_limit_reached: 409,
  battery_limit_reached: 409,
  device_limit_reached: 409,
  has_history: 409,
  email_taken: 409,
  last_admin: 409,
  invitation_pending: 409,
  not_found: 404,
  invalid_role: 400,
};

/**
 * A policy refusal is 422: the request was well formed and the answer is no.
 * A closed session is 409: the state changed under the caller.
 */
const BROKER_STATUS: Record<BrokerError['code'], number> = {
  forbidden: 403,
  no_open_session: 409,
  session_closed: 409,
  not_found: 404,
  policy_denied: 422,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new HttpError(400, code, message);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message: string, code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const tooManyRequests = (message: string) =>
  new HttpError(429, 'too_many_requests', message);

/**
 * Why a company cannot be used right now.
 *
 * 403 rather than 401: the credentials were correct and re-entering them will
 * not help. Somebody in this position needs to contact their administrator,
 * and a message telling them their password is wrong sends them nowhere.
 *
 * This is not the enumeration concern that makes login deliberately vague —
 * the caller has already proved who they are.
 */
export const entitlementRefusal = (code: string) =>
  new HttpError(
    403,
    code,
    {
      company_suspended: 'This company’s access has been suspended. Contact your administrator.',
      no_subscription: 'This company has no active plan. Contact your administrator.',
      subscription_expired:
        'This company’s plan has expired. Contact your administrator to renew it.',
      subscription_cancelled:
        'This company’s plan has been cancelled. Contact your administrator.',
    }[code] ?? 'This company cannot be used right now. Contact your administrator.'
  );

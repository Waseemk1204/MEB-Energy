import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from './db/client.js';
import { tenantQuery, type Principal } from './db/tenancy.js';
import {
  AuthError,
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyAccessToken,
} from './auth/tokens.js';
import { requirePermission, permissionsOf, setPermissions } from './auth/permissions.js';
import {
  DEFAULT_SESSION_DEVICES,
  describeDevice,
  enforceDeviceLimit,
  labelFor,
  sessionDeviceUsage,
} from './auth/sessionDevices.js';
import { needsRehash, hashPassword, verifyPassword } from './auth/password.js';
import { capabilityProfile } from './policy/seed.js';
import { performWrite, type Dispatcher } from './policy/writeService.js';
import { ingestClientAudit, queryAudit } from './audit/service.js';
import {
  closeSession,
  heartbeat,
  isSessionActive,
  openSession,
} from './session/bleSession.js';
import {
  badRequest,
  forbidden,
  notFound,
  toApiError,
  tooManyRequests,
  entitlementRefusal,
  unauthorized,
} from './http/errors.js';
import { createLimiter, type Limiter } from './http/rateLimit.js';
import { InvitationError, acceptInvitation } from './auth/invitations.js';
import { registerCors } from './http/cors.js';
import {
  DEFAULT_DEVICE_LIMIT,
  adjustLimits,
  entitlementOf,
  grantAccess,
  revokeAccess,
} from './admin/entitlement.js';
import { registerSecurityHeaders } from './http/headers.js';
import {
  batteryUsage,
  createCompany,
  deviceUsage,
  removeUser,
  createUser,
  listDevices,
  listUsers,
  registerBattery,
  registerDevice,
  seatUsage,
  platformOverview,
  visibleUser,
  setDeviceSecurityStatus,
  setUserStatus,
} from './admin/service.js';
import { canManageUsers, platformWide } from './db/tenancy.js';
import { ingestSamples, lastReadings, queryHistory, type Sample } from './telemetry/service.js';
import {
  claimCommands,
  completeCommand,
  endSupportSession,
  issueCommand,
  listCommands,
  startSupportSession,
} from './broker/commands.js';

/**
 * How many batteries a listing returns by default, and at most.
 *
 * Generous, because a fleet page that pages is a worse experience than one
 * that loads a few hundred rows — but bounded, because unbounded is not an
 * option on a shared instance.
 */
export const BATTERY_PAGE_DEFAULT = 500;
export const BATTERY_PAGE_MAX = 2000;

export interface ServerDeps {
  store: Store;
  secret: Uint8Array;
  dispatcher: Dispatcher;
  loginLimiter?: Limiter;
  inviteLimiter?: Limiter;
  /**
   * Origins the admin console may be served from. Empty by default, which
   * serves no browser at all — see http/cors.ts for why that is the safe
   * default rather than an oversight.
   */
  corsOrigins?: string[];
}

interface UserRow {
  id: string;
  company_id: string | null;
  email: string;
  display_name: string;
  role: Principal['role'];
  password_hash: string;
  status: string;
}

const loginBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

const refreshBody = z.object({ refreshToken: z.string().min(10).max(512) });

/**
 * `bleSessionActive` is deliberately NOT accepted here. Presence is established
 * from the server's own record of the user's heartbeats — a caller claiming to
 * be at the battery is not evidence of it.
 */
const writeBody = z.object({
  value: z.number().finite(),
  reason: z.string().max(2000).optional(),
  forcePush: z.boolean().optional(),
  supportSessionId: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
});

const batteryBody = z.object({
  companyId: z.string().min(1),
  serial: z.string().min(1).max(64),
  chemistry: z.string().min(1).max(64),
  cellCount: z.number().int().min(1).max(512),
  bmsModel: z.string().min(1).max(64),
  capacityAh: z.number().positive().nullable().optional(),
});

/**
 * Switching a company's access on. Payment happened elsewhere; this is the
 * administrator recording that it did.
 */
const grantBody = z.object({
  seatLimit: z.number().int().min(1).max(100_000),
  deviceLimit: z.number().int().min(1).max(1_000).optional(),
  sessionDeviceLimit: z.number().int().min(1).max(100).optional(),
  batteryLimit: z.number().int().min(1).nullable().optional(),
});

/** Raising or lowering limits mid-term, without restarting the term. */
const limitsBody = z
  .object({
    seatLimit: z.number().int().min(1).max(100_000).optional(),
    deviceLimit: z.number().int().min(1).max(1_000).optional(),
    sessionDeviceLimit: z.number().int().min(1).max(100).optional(),
    batteryLimit: z.number().int().min(1).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

const companyBody = z.object({
  name: z.string().min(1).max(200),
  seatLimit: z.number().int().min(1).max(100_000),
  deviceLimit: z.number().int().min(1).nullable().optional(),
  batteryLimit: z.number().int().min(1).nullable().optional(),
  renewalDate: z.number().int().positive().optional(),
});

const permissionsBody = z
  .object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    location: z.boolean().optional(),
    health: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

const userBody = z.object({
  companyId: z.string().min(1).nullable(),
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
  role: z.enum(['admin', 'company', 'user']),
  /**
   * Omit for the normal path: the account is created by invitation and the new
   * user sets their own first password, which nobody else ever sees.
   *
   * Supplying one means the caller knows that person's password. It is kept
   * for scripted setup, and never logged or echoed back.
   */
  password: z.string().min(12).max(1024).optional(),
});

const statusBody = z.object({ status: z.enum(['active', 'suspended']) });

const sampleSchema = z.object({
  recordedAt: z.number().int().positive(),
  soc: z.number().min(0).max(100),
  packVoltage: z.number().finite(),
  packCurrent: z.number().finite(),
  temperatureC: z.number().finite(),
  minCellV: z.number().finite(),
  maxCellV: z.number().finite(),
  deltaMv: z.number().finite(),
  faultCount: z.number().int().min(0),
  balancing: z.boolean().optional(),
});

// Batched because the app buffers while offline and uploads on reconnect.
const telemetryBody = z.object({ samples: z.array(sampleSchema).min(1).max(2000) });

/**
 * One write the app performed itself, over BLE.
 *
 * Note what is absent: no company, no actor, no role. Those come from the
 * token. A client that could name its own tenant or actor could write another
 * company's history, or sign a change as someone else — in the one table the
 * whole product relies on being truthful.
 *
 * `source` is fixed to 'local' for the same reason: an app must not be able to
 * file a change as though an administrator had pushed it remotely.
 */
export const clientAuditEvent = z.object({
  clientEventId: z.string().min(8).max(64),
  parameterKey: z.string().min(1).max(64),
  oldValue: z.string().max(64).nullable().optional(),
  newValue: z.string().max(64),
  reason: z.string().max(2000).nullable().optional(),
  result: z.enum(['success', 'adjusted', 'rejected', 'timeout', 'indeterminate']),
  bmsResponse: z.string().max(2000).nullable().optional(),
  appVersion: z.string().max(64).nullable().optional(),
  deviceFirmware: z.string().max(64).nullable().optional(),
  bmsFirmware: z.string().max(64).nullable().optional(),
  occurredAt: z.number().int().positive(),
});

const auditUploadBody = z.object({ events: z.array(clientAuditEvent).min(1).max(200) });

const acceptInviteBody = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(200),
});

const supportSessionBody = z.object({
  batteryId: z.string().min(1),
  targetUserId: z.string().min(1).nullable().optional(),
});

const endSessionBody = z.object({ outcome: z.string().min(1).max(2000) });

const commandBody = z.object({
  parameterKey: z.string().min(1).max(64),
  value: z.number().finite(),
  reason: z.string().max(2000).optional(),
  forcePush: z.boolean().optional(),
});

const commandResultBody = z.object({
  result: z.enum(['success', 'adjusted', 'rejected', 'timeout', 'indeterminate']),
  bmsResponse: z.string().max(1000).nullable().optional(),
});

const deviceBody = z.object({
  companyId: z.string().min(1),
  serial: z.string().min(1).max(64),
  hardwareRevision: z.string().min(1).max(64),
  firmwareVersion: z.string().min(1).max(64),
  assignedBatteryId: z.string().min(1).nullable().optional(),
});

const deviceStatusBody = z.object({
  securityStatus: z.enum(['valid', 'revoked', 'quarantined']),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  // Request logging is opt-in; unhandled errors are reported regardless, in
  // the error handler below.
  const app = Fastify({ logger: process.env.LOG_REQUESTS === '1' });
  const { store, secret, dispatcher } = deps;
  // Five attempts per email per fifteen minutes.
  const loginLimiter = deps.loginLimiter ?? createLimiter(5, 15 * 60 * 1000);
  // A stolen link should not be brute-forceable into a working account.
  const inviteLimiter = deps.inviteLimiter ?? createLimiter(10, 15 * 60 * 1000);

  registerCors(app, deps.corsOrigins ?? []);
  registerSecurityHeaders(app);

  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toApiError(error);

    // A 500 means an error nothing recognised — a bug. The caller is told
    // nothing, deliberately, but the server must record it: a 500 that leaves
    // no trace anywhere cannot be diagnosed in production, which is exactly
    // when it matters. Handled errors stay quiet; they are not bugs.
    if (status === 500) {
      request.log.error(
        { err: error, route: `${request.method} ${request.url}` },
        'Unhandled error'
      );
      console.error(`Unhandled error on ${request.method} ${request.url}:`, error);
    }

    void reply.status(status).send(body);
  });

  /** Every authenticated route resolves its principal here and nowhere else. */
  const principalOf = async (request: FastifyRequest): Promise<Principal> => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    const principal = await verifyAccessToken(header.slice(7), secret);

    // A token outlives a suspension, so status is re-checked per request rather
    // than trusted from the claims.
    const user = store.get<UserRow>('SELECT status FROM users WHERE id = ?', principal.userId);
    if (!user || user.status !== 'active') {
      throw new AuthError('Account is not active', 'revoked');
    }
    return principal;
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw badRequest(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return result.data;
  };

  /* ------------------------------------------------------------------ auth */

  /** The tenant a user belongs to, as the client needs to display it. */
  const companyOf = (s: Store, companyId: string | null) =>
    companyId === null
      ? null
      : (s.get<{ id: string; name: string }>(
          'SELECT id, name FROM companies WHERE id = ?',
          companyId
        ) ?? null);

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = parse(loginBody, request.body);
    const key = email.toLowerCase();

    if (!loginLimiter.take(key)) {
      throw tooManyRequests('Too many sign-in attempts. Try again shortly.');
    }

    const user = store.get<UserRow>('SELECT * FROM users WHERE email = ?', key);

    // The same failure for an unknown email and a wrong password, and the hash
    // is verified either way so the two paths take comparable time. Telling an
    // attacker which addresses exist is a free gift.
    const hash = user?.password_hash ?? '$scrypt$0$0$0$aaaa$bbbb';
    const valid = await verifyPassword(password, hash);

    if (!user || !valid || user.status !== 'active') {
      throw unauthorized('Email or password is incorrect');
    }

    /*
     * Whether the *company* may be used, which sign-in never asked before. A
     * suspended company or a lapsed plan left every one of its users working
     * normally.
     *
     * Told apart from a wrong password on purpose. Credentials read
     * identically whether or not an account exists, because that is an
     * enumeration oracle — but somebody whose employer's subscription has
     * lapsed has already proved who they are, and "your password is wrong" is
     * both false and unactionable. They need to know to call their
     * administrator.
     */
    if (user.company_id !== null) {
      const entitlement = entitlementOf(store, user.company_id);
      if (!entitlement.ok) throw entitlementRefusal(entitlement.code);
    }

    loginLimiter.reset(key);

    // Opportunistic upgrade when the stored cost is below current policy.
    if (needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(password);
      store.run('UPDATE users SET password_hash = ? WHERE id = ?', upgraded, user.id);
    }

    const principal: Principal = {
      userId: user.id,
      role: user.role,
      companyId: user.company_id,
    };
    /*
     * The concurrent-device cap. A company owner's login is the credential most
     * likely to end up shared, and this is what stops one paid account becoming
     * a floating licence for a whole depot.
     *
     * Signing out the oldest rather than refusing the newest: there is no email
     * and no self-service recovery here, so a refusal would strand an owner the
     * day they replace a phone. And an unexpected sign-out is a signal worth
     * having — somebody who did not sign in anywhere new has just learned that
     * somebody else did.
     *
     * Runs after the password and the entitlement, never before: a failed
     * sign-in must not be able to sign anybody out.
     */
    const label = labelFor(request.headers['user-agent']);
    const evicted = enforceDeviceLimit(store, user);
    const refresh = issueRefreshToken(store, user.id, Date.now(), label);

    return reply.send({
      accessToken: await issueAccessToken(principal, secret),
      refreshToken: refresh.token,
      expiresAt: refresh.expiresAt,
      // Told, not hidden. The whole value of evicting rather than refusing is
      // that the person who did not expect it finds out.
      signedOut: evicted.map((device) => describeDevice(device)),
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        companyId: user.company_id,
      },
      // The client shows the tenant's name in its header. Without this it can
      // only fall back to a built-in default, which means every tenant sees
      // whichever name that happens to be. An administrator belongs to no
      // company, so null here is a real answer, not a missing one.
      company: companyOf(store, user.company_id),
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = parse(refreshBody, request.body);
    const rotated = rotateRefreshToken(store, refreshToken);

    const user = store.get<UserRow>('SELECT * FROM users WHERE id = ?', rotated.userId);
    if (!user || user.status !== 'active') throw new AuthError('Account is not active', 'revoked');

    // Re-checked on every renewal, so a company suspended or expired mid-session
    // loses access within the access token's fifteen minutes rather than
    // whenever somebody happens to sign out.
    if (user.company_id !== null) {
      const entitlement = entitlementOf(store, user.company_id);
      if (!entitlement.ok) throw entitlementRefusal(entitlement.code);
    }

    const principal: Principal = { userId: user.id, role: user.role, companyId: user.company_id };
    return reply.send({
      accessToken: await issueAccessToken(principal, secret),
      refreshToken: rotated.token,
      expiresAt: rotated.expiresAt,
      company: companyOf(store, user.company_id),
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = parse(refreshBody, request.body);
    revokeRefreshToken(store, refreshToken);
    return reply.status(204).send();
  });

  app.get('/me', async (request, reply) => {
    const principal = await principalOf(request);
    const user = store.get<UserRow>('SELECT * FROM users WHERE id = ?', principal.userId);
    return reply.send({
      id: user!.id,
      email: user!.email,
      displayName: user!.display_name,
      role: user!.role,
      companyId: user!.company_id,
    });
  });

  /* -------------------------------------------------------------- batteries */

  /**
   * The fleet.
   *
   * Bounded, because an unbounded list endpoint is one large tenant away from
   * being a problem for everyone on the instance. The response says when it was
   * truncated rather than leaving a client to read a partial fleet as the whole
   * one — the same reason the audit trail says when a page is full.
   */
  app.get<{ Querystring: { limit?: string } }>('/batteries', async (request, reply) => {
    const principal = await principalOf(request);
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? BATTERY_PAGE_DEFAULT), 1),
      BATTERY_PAGE_MAX
    );

    const q = tenantQuery(principal, 'batteries', { orderBy: 'serial ASC' });
    // One more than asked for, purely to detect truncation without a COUNT.
    const rows = store.all<{ id: string }>(`${q.sql} LIMIT ?`, ...q.params, limit + 1);
    const truncated = rows.length > limit;
    const batteries = truncated ? rows.slice(0, limit) : rows;

    // Each pack's last known reading, with the time it was taken. The client
    // needs the age as much as the value: a state of charge shown without one
    // reads as current, and a pack last seen three weeks ago is not.
    const readings = lastReadings(store, principal, batteries.map((b) => b.id));

    return reply.send({
      batteries: batteries.map((b) => ({ ...b, lastReading: readings.get(b.id) ?? null })),
      truncated,
    });
  });

  app.get<{ Params: { id: string } }>('/batteries/:id', async (request, reply) => {
    const principal = await principalOf(request);
    requirePermission(store, principal, 'read');
    // Scoped rather than fetched-then-checked, so a foreign id is simply absent.
    const q = tenantQuery(principal, 'batteries', { where: 'id = ?', params: [request.params.id] });
    const battery = store.all<{ id: string }>(q.sql, ...q.params)[0];
    if (!battery) throw notFound('Battery');

    // The same shape the list returns. Without this a client that wants one
    // battery has to fetch the whole fleet and pick it out — which works until
    // the fleet is paged, and then quietly stops working.
    const readings = lastReadings(store, principal, [battery.id]);
    return reply.send({ ...battery, lastReading: readings.get(battery.id) ?? null });
  });

  /* --------------------------------------------------------- BLE sessions */

  /** Returns the battery scoped to the caller, or throws 404. */
  const ownBattery = (principal: Principal, id: string) => {
    const q = tenantQuery(principal, 'batteries', { where: 'id = ?', params: [id] });
    const row = store.all<{ id: string; company_id: string }>(q.sql, ...q.params)[0];
    if (!row) throw notFound('Battery');
    return row;
  };

  app.post<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    // An admin has no BLE link of their own and never will; the session that
    // matters belongs to the technician standing at the pack.
    if (principal.role === 'admin') {
      throw forbidden('Administrators do not hold BLE sessions', 'admin_has_no_session');
    }
    const battery = ownBattery(principal, request.params.id);
    const id = openSession(store, principal, battery.id, battery.company_id);
    return reply.send({ sessionId: id, batteryId: battery.id });
  });

  app.post<{ Params: { id: string } }>(
    '/batteries/:id/session/heartbeat',
    async (request, reply) => {
      const principal = await principalOf(request);
      const battery = ownBattery(principal, request.params.id);
      if (!heartbeat(store, principal, battery.id)) throw notFound('Session');
      return reply.status(204).send();
    }
  );

  app.delete<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = ownBattery(principal, request.params.id);
    closeSession(store, principal, battery.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = ownBattery(principal, request.params.id);
    return reply.send({ active: isSessionActive(store, battery.id) });
  });

  /* ------------------------------------------------------------- parameters */

  app.get<{ Params: { model: string } }>('/bms/:model/parameters', async (request, reply) => {
    await principalOf(request);
    const profile = capabilityProfile(store, decodeURIComponent(request.params.model));
    return reply.send({ parameters: profile });
  });

  app.post<{ Params: { id: string; key: string } }>(
    '/batteries/:id/parameters/:key',
    async (request, reply) => {
      const principal = await principalOf(request);

      /*
       * Read fresh from the database on every write, never from the token.
       * A token lives fifteen minutes; if this rode inside one, revoking
       * write from somebody would leave them writing for up to fifteen
       * minutes more, and the person being revoked is usually the one you
       * most want stopped now.
       */
      requirePermission(store, principal, 'write');

      const body = parse(writeBody, request.body);

      // Only an admin may claim a force push; asking for one is not a grant.
      if (body.forcePush && principal.role !== 'admin') {
        throw forbidden('Force Push is available to administrators only', 'requires_admin');
      }

      const outcome = await performWrite(
        store,
        dispatcher,
        principal,
        request.params.key,
        body.value,
        {
          batteryId: request.params.id,
          reason: body.reason,
          supportSessionId: body.supportSessionId,
          forcePush: body.forcePush,
          appVersion: body.appVersion,
        }
      );

      // A refused write is a 422, not a 500: the request was well-formed and the
      // answer is no. The audit id is returned either way so a client can point
      // at the record of its own attempt.
      return reply.status(outcome.ok ? 200 : 422).send(outcome);
    }
  );

  /**
   * Writes performed on site, uploaded when there is signal again.
   *
   * Idempotent per event, because the upload that matters most is the one from
   * a technician whose connection is unreliable — a retry must not duplicate a
   * change in the ledger. The response reports each event's stored id so the
   * app can retire it from its outbox with certainty rather than by assuming.
   */
  app.post<{ Params: { id: string } }>('/batteries/:id/audit', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = ownBattery(principal, request.params.id);
    const body = parse(auditUploadBody, request.body);

    const results = body.events.map((event) =>
      ingestClientAudit(store, {
        ...event,
        // Tenant and actor come from the token, never from the payload.
        companyId: battery.company_id,
        actorUserId: principal.userId,
        actorRole: principal.role,
        batteryId: battery.id,
        source: 'local',
      })
    );

    return reply.send({
      accepted: results.map((r, i) => ({
        clientEventId: body.events[i]!.clientEventId,
        auditId: r.auditId,
        duplicate: r.duplicate,
      })),
      stored: results.filter((r) => !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
    });
  });

  /* ------------------------------------------------- assisted remote control */

  app.post('/support-sessions', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(supportSessionBody, request.body);
    const id = startSupportSession(store, principal, body.batteryId, body.targetUserId ?? null);
    return reply.status(201).send({ supportSessionId: id });
  });

  app.patch<{ Params: { id: string } }>('/support-sessions/:id', async (request, reply) => {
    const principal = await principalOf(request);
    const { outcome } = parse(endSessionBody, request.body);
    const cancelled = endSupportSession(store, principal, request.params.id, outcome);
    // Reported because closing a session silently voiding queued work would be
    // a surprise worth surfacing to whoever closed it.
    return reply.send({ ended: true, cancelledCommands: cancelled });
  });

  app.get('/support-sessions', async (request, reply) => {
    const principal = await principalOf(request);
    const q = tenantQuery(principal, 'support_sessions', { orderBy: 'started_at DESC' });
    return reply.send({ sessions: store.all(q.sql, ...q.params) });
  });

  app.post<{ Params: { id: string } }>('/support-sessions/:id/commands', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(commandBody, request.body);
    const result = issueCommand(store, principal, request.params.id, body.parameterKey, body.value, {
      reason: body.reason,
      forcePush: body.forcePush,
    });
    // 202: accepted for delivery, which may mean queued until someone is on site.
    return reply.status(202).send(result);
  });

  /**
   * The technician's app collects work for a battery it is currently linked to.
   * A POST because claiming mutates: a command is handed out exactly once.
   */
  app.post<{ Params: { id: string } }>('/batteries/:id/commands/claim', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = ownBattery(principal, request.params.id);
    return reply.send({ commands: claimCommands(store, principal, battery.id) });
  });

  app.post<{ Params: { id: string } }>('/commands/:id/result', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(commandResultBody, request.body);
    const auditId = completeCommand(
      store,
      principal,
      request.params.id,
      body.result,
      body.bmsResponse ?? null
    );
    return reply.send({ auditId });
  });

  app.get<{ Querystring: { batteryId?: string } }>('/commands', async (request, reply) => {
    const principal = await principalOf(request);
    return reply.send({ commands: listCommands(store, principal, request.query.batteryId) });
  });

  /* -------------------------------------------------------------- telemetry */

  app.post<{ Params: { id: string } }>('/batteries/:id/telemetry', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = ownBattery(principal, request.params.id);
    const { samples } = parse(telemetryBody, request.body);
    const result = ingestSamples(store, battery.company_id, battery.id, samples as Sample[]);
    return reply.status(202).send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: string } }>(
    '/batteries/:id/telemetry',
    async (request, reply) => {
      const principal = await principalOf(request);
      const battery = ownBattery(principal, request.params.id);
      const { from, to, limit } = request.query;
      return reply.send({
        readings: queryHistory(store, principal, {
          batteryId: battery.id,
          from: from ? Number(from) : undefined,
          to: to ? Number(to) : undefined,
          limit: limit ? Number(limit) : undefined,
        }),
      });
    }
  );

  /* -------------------------------------------------------------- companies */

  app.post('/companies', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(companyBody, request.body);
    const created = createCompany(store, principal, body);
    return reply.status(201).send(created);
  });

  app.get('/companies', async (request, reply) => {
    const principal = await principalOf(request);
    // Not a tenant-scoped table: the listing is cross-tenant by definition, so
    // the admin check is explicit rather than implied by a scope. A tenant gets
    // 404, not 403 — it has no business learning this endpoint exists.
    if (principal.role !== 'admin') throw notFound('Resource');
    platformWide(principal);
    return reply.send({
      companies: store.all('SELECT id, name, status, created_at FROM companies ORDER BY name ASC'),
    });
  });

  /* ------------------------------------------------------------------ users */

  /**
   * The platform at a glance. Administrators only — a company owner asking
   * gets 404 rather than 403, so the route does not confirm it exists.
   */
  app.get('/platform/overview', async (request, reply) => {
    const principal = await principalOf(request);
    if (principal.role !== 'admin') throw notFound('Overview');
    return reply.send(platformOverview(store));
  });

  /**
   * Grant a company a year's access.
   *
   * Administrators only, and deliberately not something a company can do for
   * itself — this is the point where taking payment outside the system becomes
   * access inside it.
   */
  app.post<{ Params: { id: string } }>('/companies/:id/access', async (request, reply) => {
    const principal = await principalOf(request);
    if (principal.role !== 'admin') throw notFound('Company');

    const body = parse(grantBody, request.body);
    if (!store.get('SELECT id FROM companies WHERE id = ?', request.params.id)) {
      throw notFound('Company');
    }

    const granted = grantAccess(store, request.params.id, body);
    return reply.status(201).send({
      ...granted,
      seatLimit: body.seatLimit,
      deviceLimit: body.deviceLimit ?? DEFAULT_DEVICE_LIMIT,
      sessionDeviceLimit: body.sessionDeviceLimit ?? DEFAULT_SESSION_DEVICES,
    });
  });

  /** Switch it off. Distinct from letting a term lapse, and refused as such. */
  app.delete<{ Params: { id: string } }>('/companies/:id/access', async (request, reply) => {
    const principal = await principalOf(request);
    if (principal.role !== 'admin') throw notFound('Company');

    revokeAccess(store, request.params.id);
    return reply.status(204).send();
  });

  /** Change what a live plan allows without buying another year. */
  app.patch<{ Params: { id: string } }>('/companies/:id/limits', async (request, reply) => {
    const principal = await principalOf(request);
    if (principal.role !== 'admin') throw notFound('Company');

    adjustLimits(store, request.params.id, parse(limitsBody, request.body));
    return reply.send(entitlementOf(store, request.params.id));
  });

  /**
   * What a company is entitled to and how much of it is used.
   *
   * Readable by the company itself as well as an administrator: a company owner
   * about to add a user needs to know whether they can.
   */
  app.get<{ Params: { id: string } }>('/companies/:id/entitlement', async (request, reply) => {
    const principal = await principalOf(request);
    if (!canManageUsers(principal, request.params.id)) throw notFound('Company');

    return reply.send({
      ...entitlementOf(store, request.params.id),
      seats: seatUsage(store, request.params.id),
      devices: deviceUsage(store, request.params.id),
      sessionDevices: sessionDeviceUsage(store, request.params.id),
      batteries: batteryUsage(store, request.params.id),
    });
  });

  app.post('/users', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(userBody, request.body);
    const created = await createUser(store, principal, body);

    // Deliberately does not echo the request: never reflect a password back.
    // The invitation token is returned exactly once, here, and is never
    // readable again — it is stored hashed, like a refresh token.
    return reply.status(201).send({
      id: created.id,
      email: body.email.toLowerCase(),
      role: body.role,
      status: created.invitation ? 'invited' : 'active',
      invitation: created.invitation ?? null,
    });
  });

  /**
   * Accepting an invitation. Unauthenticated by necessity — the whole point is
   * that the person has no credentials yet.
   *
   * Rate-limited on the token, so a stolen or guessed link cannot be brute
   * forced, and every failure reads identically so a guess cannot learn
   * whether a token ever existed.
   */
  app.post('/auth/accept-invite', async (request, reply) => {
    const body = parse(acceptInviteBody, request.body);

    if (!inviteLimiter.take(body.token.slice(0, 16))) {
      throw tooManyRequests('Too many attempts. Try again shortly.');
    }

    try {
      const { userId } = await acceptInvitation(store, body.token, body.password);
      const user = store.get<UserRow>('SELECT * FROM users WHERE id = ?', userId)!;
      const principal: Principal = {
        userId: user.id,
        role: user.role,
        companyId: user.company_id,
      };
      const refresh = issueRefreshToken(store, user.id);

      // Signed straight in: making someone set a password and then immediately
      // type it again is friction with no security value.
      return reply.status(200).send({
        accessToken: await issueAccessToken(principal, secret),
        refreshToken: refresh.token,
        expiresAt: refresh.expiresAt,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
          companyId: user.company_id,
        },
        company: companyOf(store, user.company_id),
      });
    } catch (error) {
      if (error instanceof InvitationError && error.code !== 'weak_password') {
        // Unknown, expired and already-used all read the same: telling them
        // apart lets a guessed token learn whether it ever existed.
        throw badRequest('That invitation is not valid or has already been used');
      }
      throw error;
    }
  });

  app.get('/users', async (request, reply) => {
    const principal = await principalOf(request);
    return reply.send({ users: listUsers(store, principal) });
  });

  app.patch<{ Params: { id: string } }>('/users/:id/status', async (request, reply) => {
    const principal = await principalOf(request);
    const { status } = parse(statusBody, request.body);
    setUserStatus(store, principal, request.params.id, status);
    return reply.status(204).send();
  });

  /**
   * What a user may do, set by their company.
   *
   * Scoped through the same rule that guards status changes, so a company can
   * only reach its own people and an administrator can reach anyone. Takes
   * effect on the next request the user makes, not at their next token
   * renewal, because permissions are read per request rather than carried.
   */
  app.patch<{ Params: { id: string } }>('/users/:id/permissions', async (request, reply) => {
    const principal = await principalOf(request);
    const patch = parse(permissionsBody, request.body);

    // Reuse the visibility rule rather than restating it: if this principal
    // cannot see the user, the user is simply not found.
    const target = visibleUser(store, principal, request.params.id);
    if (!target) throw notFound('User');

    /*
     * Nobody edits their own permissions. A company owner who could grant
     * themselves write would make the setting decorative, and an owner who
     * could remove their own read would lock themselves out with no way back.
     */
    if (target.id === principal.userId) {
      throw forbidden('You cannot change your own permissions');
    }

    setPermissions(store, target.id, patch);
    return reply.send(permissionsOf(store, { ...principal, userId: target.id, role: target.role }));
  });

  /**
   * Remove a user — the guest case: brought in for a problem, taken off when it
   * is solved. Somebody who has changed anything is suspended instead, because
   * the audit ledger references its actor.
   */
  app.delete<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const principal = await principalOf(request);
    const result = removeUser(store, principal, request.params.id);
    return reply.send(result);
  });

  app.get<{ Params: { id: string } }>('/companies/:id/seats', async (request, reply) => {
    const principal = await principalOf(request);
    if (principal.role !== 'admin' && principal.companyId !== request.params.id) {
      throw notFound('Company');
    }
    return reply.send(seatUsage(store, request.params.id));
  });

  /* ---------------------------------------------------------------- devices */

  app.post('/batteries', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(batteryBody, request.body);
    const id = registerBattery(store, principal, body);
    return reply.status(201).send({ batteryId: id });
  });

  app.get<{ Params: { id: string } }>('/companies/:id/batteries', async (request, reply) => {
    const principal = await principalOf(request);
    if (!canManageUsers(principal, request.params.id)) {
      throw forbidden('Not permitted to view that company', 'forbidden');
    }
    return reply.send(batteryUsage(store, request.params.id));
  });

  app.post('/devices', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(deviceBody, request.body);
    return reply.status(201).send({ id: registerDevice(store, principal, body) });
  });

  app.get('/devices', async (request, reply) => {
    const principal = await principalOf(request);
    return reply.send({ devices: listDevices(store, principal) });
  });

  app.patch<{ Params: { id: string } }>('/devices/:id/security', async (request, reply) => {
    const principal = await principalOf(request);
    const { securityStatus } = parse(deviceStatusBody, request.body);
    setDeviceSecurityStatus(store, principal, request.params.id, securityStatus);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------------ audit */

  app.get<{ Querystring: { batteryId?: string; source?: string; result?: string; limit?: string } }>(
    '/audit',
    async (request, reply) => {
      const principal = await principalOf(request);
      const { batteryId, source, result, limit } = request.query;
      return reply.send({
        events: queryAudit(store, principal, {
          batteryId,
          source: source as never,
          result: result as never,
          limit: limit ? Number(limit) : undefined,
        }),
      });
    }
  );

  /**
   * Liveness. The process is running and can answer.
   *
   * Deliberately touches nothing: an orchestrator uses this to decide whether
   * to *restart* the process, and restarting because a database is unreachable
   * would be the wrong response to the wrong problem.
   */
  app.get('/health', async (_request, reply) => reply.send({ ok: true }));

  /**
   * Readiness. The process can actually do its job.
   *
   * This is the one an orchestrator uses to decide whether to send traffic, so
   * it verifies the thing every request depends on: that the database answers.
   * A `/health` that returns ok while the database is gone means a broken
   * instance stays in the rotation, which is exactly the failure readiness
   * checks exist to prevent.
   */
  app.get('/ready', async (_request, reply) => {
    try {
      // A real query against a real table, not `SELECT 1`: an open handle to a
      // file that has been truncated or replaced will answer `SELECT 1` quite
      // happily and fail on anything that reads a page.
      const row = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM parameter_definitions');

      if ((row?.n ?? 0) === 0) {
        // The schema exists but the seed does not, so no write could be
        // evaluated against a policy. Not ready.
        return reply.status(503).send({ ready: false, reason: 'parameter definitions are missing' });
      }
      return reply.send({ ready: true, parameters: row!.n });
    } catch {
      // The reason is not the caller's business, and the detail is in the log.
      return reply.status(503).send({ ready: false, reason: 'database is not answering' });
    }
  });

  return app;
}

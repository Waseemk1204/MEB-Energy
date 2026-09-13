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
import { labelFor } from './auth/deviceLabel.js';
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
  unauthorized,
} from './http/errors.js';
import { createLimiter, type Limiter } from './http/rateLimit.js';
import { InvitationError, acceptInvitation } from './auth/invitations.js';
import { registerCors } from './http/cors.js';
import { registerSecurityHeaders } from './http/headers.js';
import {
  companyOf,
  companyOverview,
  createUser,
  listDevices,
  listUsers,
  registerBattery,
  registerDevice,
  reinstateBattery,
  removeUser,
  renameCompany,
  retireBattery,
  updateBattery,
  updateUser,
  visibleUser,
  setDeviceSecurityStatus,
  setUserStatus,
} from './company/service.js';
import { isRole } from './db/tenancy.js';
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
   * Origins the web app may be served from. Empty by default, which serves no
   * browser at all — see http/cors.ts for why that is the safe default rather
   * than an oversight.
   */
  corsOrigins?: string[];
}

interface UserRow {
  id: string;
  company_id: string;
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
  // Optional: the caller's own company is the only one there is. Accepted so
  // an older client that still sends it keeps working, and checked so a
  // client that sends somebody else's is refused rather than quietly
  // redirected.
  companyId: z.string().min(1).optional(),
  serial: z.string().min(1).max(64),
  chemistry: z.string().min(1).max(64),
  cellCount: z.number().int().min(1).max(512),
  bmsModel: z.string().min(1).max(64),
  capacityAh: z.number().positive().nullable().optional(),
});

const companyBody = z.object({
  name: z.string().trim().min(1).max(200),
});

const permissionsBody = z
  .object({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    location: z.boolean().optional(),
    health: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

const batteryPatchBody = z
  .object({
    serial: z.string().min(1).max(64).optional(),
    chemistry: z.string().min(1).max(32).optional(),
    cellCount: z.number().int().min(1).max(512).optional(),
    nominalVoltage: z.number().positive().nullable().optional(),
    capacityAh: z.number().positive().nullable().optional(),
    ratedCurrentA: z.number().positive().nullable().optional(),
    bmsManufacturer: z.string().max(64).nullable().optional(),
    bmsModel: z.string().max(64).nullable().optional(),
    bmsFirmware: z.string().max(64).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

const userBody = z.object({
  companyId: z.string().min(1).optional(),
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
  /** 'company' is an administrator, 'user' a technician. */
  role: z.enum(['company', 'user']).default('user'),
  permissions: z
    .object({
      read: z.boolean().optional(),
      write: z.boolean().optional(),
      location: z.boolean().optional(),
      health: z.boolean().optional(),
    })
    .optional(),
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

const userPatchBody = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

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
  companyId: z.string().min(1).optional(),
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
    const user = await store.get<UserRow>('SELECT status FROM users WHERE id = ?', principal.userId);
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

  /** The company, as the client needs to display it. */
  const companyNamed = async (s: Store, companyId: string) =>
    await s.get<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = ?', companyId) ??
    null;

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = parse(loginBody, request.body);
    const key = email.toLowerCase();

    if (!loginLimiter.take(key)) {
      throw tooManyRequests('Too many sign-in attempts. Try again shortly.');
    }

    const user = await store.get<UserRow>('SELECT * FROM users WHERE email = ?', key);

    // The same failure for an unknown email and a wrong password, and the hash
    // is verified either way so the two paths take comparable time. Telling an
    // attacker which addresses exist is a free gift.
    const hash = user?.password_hash ?? '$scrypt$0$0$0$aaaa$bbbb';
    const valid = await verifyPassword(password, hash);

    // A role this application does not know — a platform administrator from
    // before it was one company's — reads as a wrong password. Same message,
    // for the same enumeration reason.
    if (!user || !valid || user.status !== 'active' || !isRole(user.role)) {
      throw unauthorized('Email or password is incorrect');
    }

    loginLimiter.reset(key);

    // Opportunistic upgrade when the stored cost is below current policy.
    if (needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(password);
      await store.run('UPDATE users SET password_hash = ? WHERE id = ?', upgraded, user.id);
    }

    const principal: Principal = {
      userId: user.id,
      role: user.role,
      companyId: user.company_id,
    };
    // There is no cap on how many devices anybody is signed in on. The label
    // is kept so a session can be named, nothing more.
    const label = labelFor(request.headers['user-agent']);
    const refresh = await issueRefreshToken(store, user.id, Date.now(), label);

    return reply.send({
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
      // The client shows the company's name in its header. Without this it can
      // only fall back to a built-in default.
      company: await companyNamed(store, user.company_id),
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = parse(refreshBody, request.body);
    const rotated = await rotateRefreshToken(store, refreshToken);

    const user = await store.get<UserRow>('SELECT * FROM users WHERE id = ?', rotated.userId);
    if (!user || user.status !== 'active' || !isRole(user.role)) {
      throw new AuthError('Account is not active', 'revoked');
    }

    const principal: Principal = { userId: user.id, role: user.role, companyId: user.company_id };
    return reply.send({
      accessToken: await issueAccessToken(principal, secret),
      refreshToken: rotated.token,
      expiresAt: rotated.expiresAt,
      company: await companyNamed(store, user.company_id),
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = parse(refreshBody, request.body);
    await revokeRefreshToken(store, refreshToken);
    return reply.status(204).send();
  });

  app.get('/me', async (request, reply) => {
    const principal = await principalOf(request);
    const user = await store.get<UserRow>('SELECT * FROM users WHERE id = ?', principal.userId);
    return reply.send({
      id: user!.id,
      email: user!.email,
      displayName: user!.display_name,
      role: user!.role,
      companyId: user!.company_id,
      permissions: await permissionsOf(store, principal),
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
  app.get<{ Querystring: { limit?: string; includeRetired?: string } }>(
    '/batteries',
    async (request, reply) => {
    const principal = await principalOf(request);
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? BATTERY_PAGE_DEFAULT), 1),
      BATTERY_PAGE_MAX
    );

    // A technician picking a pack to connect to should not be offered one
    // that has been taken out of service. Management screens ask for them.
    const includeRetired = request.query.includeRetired === '1';
    const q = tenantQuery(principal, 'batteries', {
      orderBy: 'serial ASC',
      ...(includeRetired ? {} : { where: "status = 'active'", params: [] }),
    });
    // One more than asked for, purely to detect truncation without a COUNT.
    const rows = await store.all<{ id: string }>(`${q.sql} LIMIT ?`, ...q.params, limit + 1);
    const truncated = rows.length > limit;
    const batteries = truncated ? rows.slice(0, limit) : rows;

    // Each pack's last known reading, with the time it was taken. The client
    // needs the age as much as the value: a state of charge shown without one
    // reads as current, and a pack last seen three weeks ago is not.
    const readings = await lastReadings(store, principal, batteries.map((b) => b.id));

    return reply.send({
      batteries: batteries.map((b) => ({ ...b, lastReading: readings.get(b.id) ?? null })),
      truncated,
    });
  }
  );

  app.get<{ Params: { id: string } }>('/batteries/:id', async (request, reply) => {
    const principal = await principalOf(request);
    await requirePermission(store, principal, 'read');
    // Scoped rather than fetched-then-checked, so a foreign id is simply absent.
    const q = tenantQuery(principal, 'batteries', { where: 'id = ?', params: [request.params.id] });
    const battery = (await store.all<{ id: string }>(q.sql, ...q.params))[0];
    if (!battery) throw notFound('Battery');

    // The same shape the list returns. Without this a client that wants one
    // battery has to fetch the whole fleet and pick it out — which works until
    // the fleet is paged, and then quietly stops working.
    const readings = await lastReadings(store, principal, [battery.id]);
    return reply.send({ ...battery, lastReading: readings.get(battery.id) ?? null });
  });

  /* --------------------------------------------------------- BLE sessions */

  /** Returns the battery scoped to the caller, or throws 404. */
  const ownBattery = async (principal: Principal, id: string) => {
    const q = tenantQuery(principal, 'batteries', { where: 'id = ?', params: [id] });
    const row = (await store.all<{ id: string; company_id: string }>(q.sql, ...q.params))[0];
    if (!row) throw notFound('Battery');
    return row;
  };

  app.post<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = await ownBattery(principal, request.params.id);
    const id = await openSession(store, principal, battery.id, battery.company_id);
    return reply.send({ sessionId: id, batteryId: battery.id });
  });

  app.post<{ Params: { id: string } }>(
    '/batteries/:id/session/heartbeat',
    async (request, reply) => {
      const principal = await principalOf(request);
      const battery = await ownBattery(principal, request.params.id);
      if (!await heartbeat(store, principal, battery.id)) throw notFound('Session');
      return reply.status(204).send();
    }
  );

  app.delete<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = await ownBattery(principal, request.params.id);
    await closeSession(store, principal, battery.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/batteries/:id/session', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = await ownBattery(principal, request.params.id);
    return reply.send({ active: await isSessionActive(store, battery.id) });
  });

  /* ------------------------------------------------------------- parameters */

  app.get<{ Params: { model: string } }>('/bms/:model/parameters', async (request, reply) => {
    await principalOf(request);
    const profile = await capabilityProfile(store, decodeURIComponent(request.params.model));
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
      await requirePermission(store, principal, 'write');

      const body = parse(writeBody, request.body);

      // Only an administrator may claim a force push; asking for one is not a
      // grant.
      if (body.forcePush && principal.role !== 'company') {
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
    const battery = await ownBattery(principal, request.params.id);
    const body = parse(auditUploadBody, request.body);

    // In order, one at a time: each is idempotent on its own id, and two
    // uploads of the same batch racing each other is the case that matters.
    const results = [];
    for (const event of body.events) {
      results.push(
        await ingestClientAudit(store, {
          ...event,
          // Tenant and actor come from the token, never from the payload.
          companyId: battery.company_id,
          actorUserId: principal.userId,
          actorRole: principal.role,
          batteryId: battery.id,
          source: 'local',
        })
      );
    }

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
    const id = await startSupportSession(store, principal, body.batteryId, body.targetUserId ?? null);
    return reply.status(201).send({ supportSessionId: id });
  });

  app.patch<{ Params: { id: string } }>('/support-sessions/:id', async (request, reply) => {
    const principal = await principalOf(request);
    const { outcome } = parse(endSessionBody, request.body);
    const cancelled = await endSupportSession(store, principal, request.params.id, outcome);
    // Reported because closing a session silently voiding queued work would be
    // a surprise worth surfacing to whoever closed it.
    return reply.send({ ended: true, cancelledCommands: cancelled });
  });

  app.get('/support-sessions', async (request, reply) => {
    const principal = await principalOf(request);
    const q = tenantQuery(principal, 'support_sessions', { orderBy: 'started_at DESC' });
    return reply.send({ sessions: await store.all(q.sql, ...q.params) });
  });

  app.post<{ Params: { id: string } }>('/support-sessions/:id/commands', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(commandBody, request.body);
    const result = await issueCommand(store, principal, request.params.id, body.parameterKey, body.value, {
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
    const battery = await ownBattery(principal, request.params.id);
    return reply.send({ commands: await claimCommands(store, principal, battery.id) });
  });

  app.post<{ Params: { id: string } }>('/commands/:id/result', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(commandResultBody, request.body);
    const auditId = await completeCommand(
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
    return reply.send({ commands: await listCommands(store, principal, request.query.batteryId) });
  });

  /* -------------------------------------------------------------- telemetry */

  app.post<{ Params: { id: string } }>('/batteries/:id/telemetry', async (request, reply) => {
    const principal = await principalOf(request);
    const battery = await ownBattery(principal, request.params.id);
    const { samples } = parse(telemetryBody, request.body);
    const result = await ingestSamples(store, battery.company_id, battery.id, samples as Sample[]);
    return reply.status(202).send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: string } }>(
    '/batteries/:id/telemetry',
    async (request, reply) => {
      const principal = await principalOf(request);
      const battery = await ownBattery(principal, request.params.id);
      const { from, to, limit } = request.query;
      return reply.send({
        readings: await queryHistory(store, principal, {
          batteryId: battery.id,
          from: from ? Number(from) : undefined,
          to: to ? Number(to) : undefined,
          limit: limit ? Number(limit) : undefined,
        }),
      });
    }
  );

  /* ---------------------------------------------------------------- company */

  /**
   * The company itself: its name, and the numbers an administrator opens the
   * app to see. Readable by everyone who belongs to it — a technician's header
   * shows the same name.
   */
  app.get('/company', async (request, reply) => {
    const principal = await principalOf(request);
    const company = await companyOf(store, principal);
    return reply.send({
      id: company.id,
      name: company.name,
      createdAt: company.created_at,
      overview: await companyOverview(store, company.id),
    });
  });

  /** Rename the company. Administrators only. */
  app.patch('/company', async (request, reply) => {
    const principal = await principalOf(request);
    const { name } = parse(companyBody, request.body);
    const company = await renameCompany(store, principal, name);
    return reply.send({ id: company.id, name: company.name, createdAt: company.created_at });
  });

  /* ------------------------------------------------------------------ users */

  /**
   * The caller's own company is the only one a request may name. A body that
   * names another is refused as not found rather than corrected — a client
   * that thinks it is somewhere else should find out.
   */
  const ownCompanyId = (principal: Principal, named: string | undefined): string => {
    if (named !== undefined && named !== principal.companyId) throw notFound('Company');
    return principal.companyId;
  };

  app.post('/users', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(userBody, request.body);
    const created = await createUser(store, principal, {
      ...body,
      companyId: ownCompanyId(principal, body.companyId),
    });

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
      const user = (await store.get<UserRow>('SELECT * FROM users WHERE id = ?', userId))!;
      const principal: Principal = {
        userId: user.id,
        role: user.role,
        companyId: user.company_id,
      };
      const refresh = await issueRefreshToken(
        store,
        user.id,
        Date.now(),
        labelFor(request.headers['user-agent'])
      );

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
        company: await companyNamed(store, user.company_id),
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
    return reply.send({ users: await listUsers(store, principal) });
  });

  /** Who somebody is. Administrators only, and only inside the company. */
  app.patch<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const principal = await principalOf(request);
    await updateUser(store, principal, request.params.id, parse(userPatchBody, request.body));
    return reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>('/users/:id/status', async (request, reply) => {
    const principal = await principalOf(request);
    const { status } = parse(statusBody, request.body);
    await setUserStatus(store, principal, request.params.id, status);
    return reply.status(204).send();
  });

  /**
   * What a user may do, set by an administrator.
   *
   * Scoped through the same rule that guards status changes. Takes effect on
   * the next request the user makes, not at their next token renewal, because
   * permissions are read per request rather than carried.
   */
  app.patch<{ Params: { id: string } }>('/users/:id/permissions', async (request, reply) => {
    const principal = await principalOf(request);
    const patch = parse(permissionsBody, request.body);

    // Reuse the visibility rule rather than restating it: if this principal
    // cannot see the user, the user is simply not found.
    const target = await visibleUser(store, principal, request.params.id);
    if (!target) throw notFound('User');

    /*
     * Nobody edits their own permissions. An administrator who could grant
     * themselves write would make the setting decorative, and one who could
     * remove their own read would lock themselves out with no way back.
     */
    if (target.id === principal.userId) {
      throw forbidden('You cannot change your own permissions');
    }

    /*
     * An administrator holds every permission implicitly; the columns are
     * ignored for them. Writing to those columns would produce a screen that
     * says one thing and a server that does another.
     */
    if (target.role === 'company') {
      throw forbidden(
        'An administrator holds every permission. Make them a technician to limit what they may do.',
        'administrator'
      );
    }

    await setPermissions(store, target.id, patch);
    return reply.send(
      await permissionsOf(store, { ...principal, userId: target.id, role: target.role })
    );
  });

  /**
   * Remove a user — the guest case: brought in for a problem, taken off when it
   * is solved. Somebody who has changed anything is suspended instead, because
   * the audit ledger references its actor.
   */
  app.delete<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const principal = await principalOf(request);
    const result = await removeUser(store, principal, request.params.id);
    return reply.send(result);
  });

  /* ---------------------------------------------------------------- devices */

  app.post('/batteries', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(batteryBody, request.body);
    const id = await registerBattery(store, principal, {
      ...body,
      companyId: ownCompanyId(principal, body.companyId),
    });
    return reply.status(201).send({ batteryId: id });
  });

  /** Edit a pack's details. Administrators only. */
  app.patch<{ Params: { id: string } }>('/batteries/:id', async (request, reply) => {
    const principal = await principalOf(request);
    await updateBattery(store, principal, request.params.id, parse(batteryPatchBody, request.body));
    return reply.status(204).send();
  });

  /**
   * Take a pack out of service. Not a delete: the audit ledger references it.
   * It leaves the technician's list and stays in the record.
   */
  app.delete<{ Params: { id: string } }>('/batteries/:id', async (request, reply) => {
    const principal = await principalOf(request);
    await retireBattery(store, principal, request.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/batteries/:id/reinstate', async (request, reply) => {
    const principal = await principalOf(request);
    await reinstateBattery(store, principal, request.params.id);
    return reply.status(204).send();
  });

  app.post('/devices', async (request, reply) => {
    const principal = await principalOf(request);
    const body = parse(deviceBody, request.body);
    const id = await registerDevice(store, principal, {
      ...body,
      companyId: ownCompanyId(principal, body.companyId),
    });
    return reply.status(201).send({ id });
  });

  app.get('/devices', async (request, reply) => {
    const principal = await principalOf(request);
    return reply.send({ devices: await listDevices(store, principal) });
  });

  app.patch<{ Params: { id: string } }>('/devices/:id/security', async (request, reply) => {
    const principal = await principalOf(request);
    const { securityStatus } = parse(deviceStatusBody, request.body);
    await setDeviceSecurityStatus(store, principal, request.params.id, securityStatus);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------------ audit */

  app.get<{ Querystring: { batteryId?: string; source?: string; result?: string; limit?: string } }>(
    '/audit',
    async (request, reply) => {
      const principal = await principalOf(request);
      const { batteryId, source, result, limit } = request.query;
      return reply.send({
        events: await queryAudit(store, principal, {
          batteryId,
          source: source as never,
          result: result as never,
          limit: limit ? Number(limit) : undefined,
        }),
      });
    }
  );

  /**
   * The front door. The API has no user interface of its own; somebody who
   * opens its address in a browser is checking that it is there, and a
   * Fastify "Route GET:/ not found" reads as though it is not.
   */
  app.get('/', async (_request, reply) =>
    reply.send({
      name: 'MEB Energy API',
      ready: '/ready',
      health: '/health',
      hint: 'The app talks to this; there is nothing to see here by hand.',
    })
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
      const row = await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM parameter_definitions');

      if ((row?.n ?? 0) === 0) {
        // The schema exists but the seed does not, so no write could be
        // evaluated against a policy. Not ready.
        return reply.status(503).send({ ready: false, reason: 'parameter definitions are missing' });
      }
      // Whether anyone can sign in. A fresh deployment whose bootstrap never
      // ran answers every login with 401, which looks like a wrong password
      // from outside; this says which it is without naming anybody.
      const users = await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
      return reply.send({ ready: true, parameters: row!.n, bootstrapped: (users?.n ?? 0) > 0 });
    } catch {
      // The reason is not the caller's business, and the detail is in the log.
      return reply.status(503).send({ ready: false, reason: 'database is not answering' });
    }
  });

  return app;
}

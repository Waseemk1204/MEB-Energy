import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import { assertOwned, tenantQuery, type Principal } from '../db/tenancy.js';
import { recordAudit, type WriteResult } from '../audit/service.js';
import { evaluateWrite, type CompanyPolicy } from '../policy/engine.js';
import { findDefinition } from '../policy/seed.js';
import { activeSessionFor } from '../session/bleSession.js';

/**
 * Assisted remote control — the cloud half (PRD §7.10, §7.13, Mode 1 §7.3).
 *
 * An administrator issues structured commands, never raw packets. A command
 * reaches a BMS only by being claimed by the technician's app while their BLE
 * session is live; with nobody on site it queues or is refused, and no amount of
 * urgency changes that.
 *
 * Force Push overrides queue order and soft-holds. It does not override the
 * session requirement — the PRD calls that constraint architectural, and it is
 * the thing most likely to be quietly weakened for support convenience.
 */

/** A queued command that nobody collects is a command nobody expected. */
export const COMMAND_TTL_MS = 10 * 60 * 1000;

export type CommandState = 'queued' | 'claimed' | 'completed' | 'cancelled' | 'expired';

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'forbidden'
      | 'no_open_session'
      | 'session_closed'
      | 'not_found'
      | 'policy_denied'
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

/* -------------------------------------------------------- support sessions */

export interface SupportSessionRow {
  id: string;
  company_id: string;
  admin_user_id: string;
  target_user_id: string | null;
  battery_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
}

export function startSupportSession(
  store: Store,
  principal: Principal,
  batteryId: string,
  targetUserId: string | null = null,
  now = Date.now()
): string {
  if (principal.role !== 'company') {
    throw new BrokerError('Only an administrator may open a support session', 'forbidden');
  }

  const battery = store.get<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM batteries WHERE id = ?',
    batteryId
  );
  assertOwned(principal, battery, 'Battery');

  const id = randomUUID();
  store.run(
    `INSERT INTO support_sessions
     (id, company_id, admin_user_id, target_user_id, battery_id, started_at)
     VALUES (?,?,?,?,?,?)`,
    id,
    battery.company_id,
    principal.userId,
    targetUserId,
    battery.id,
    now
  );
  return id;
}

/**
 * Ending a session cancels everything it queued.
 *
 * Otherwise a command issued during a call could fire hours later, after the
 * conversation that justified it has ended and with nobody expecting it. A
 * queued command is only ever as live as the session that raised it.
 */
export function endSupportSession(
  store: Store,
  principal: Principal,
  sessionId: string,
  outcome: string,
  now = Date.now()
): number {
  const session = store.get<SupportSessionRow>(
    'SELECT * FROM support_sessions WHERE id = ?',
    sessionId
  );
  if (!session) throw new BrokerError('Support session not found', 'not_found');
  if (principal.role !== 'company' || session.admin_user_id !== principal.userId) {
    throw new BrokerError('Support session not found', 'not_found');
  }

  return store.transaction(() => {
    store.run(
      'UPDATE support_sessions SET ended_at = ?, outcome = ? WHERE id = ?',
      now,
      outcome,
      sessionId
    );
    const queued = store.all<{ id: string }>(
      "SELECT id FROM commands WHERE support_session_id = ? AND state = 'queued'",
      sessionId
    );
    for (const row of queued) {
      store.run("UPDATE commands SET state = 'cancelled', settled_at = ? WHERE id = ?", now, row.id);
    }
    return queued.length;
  });
}

/* ----------------------------------------------------------------- commands */

export interface CommandRow {
  id: string;
  company_id: string;
  support_session_id: string;
  battery_id: string;
  parameter_key: string;
  value: number;
  issued_by: string;
  force_push: number;
  state: CommandState;
  created_at: number;
  claimed_at: number | null;
  settled_at: number | null;
  result: WriteResult | null;
}

export interface IssueResult {
  commandId: string;
  /** 'delivered' means a technician is on site and can collect it now. */
  disposition: 'deliverable' | 'queued';
  auditId: string;
}

export function issueCommand(
  store: Store,
  principal: Principal,
  sessionId: string,
  parameterKey: string,
  value: number,
  options: { reason?: string; forcePush?: boolean } = {},
  policy: CompanyPolicy = {},
  now = Date.now()
): IssueResult {
  const session = store.get<SupportSessionRow>(
    'SELECT * FROM support_sessions WHERE id = ?',
    sessionId
  );
  if (!session) throw new BrokerError('Support session not found', 'not_found');
  if (principal.role !== 'company' || session.admin_user_id !== principal.userId) {
    throw new BrokerError('Support session not found', 'not_found');
  }
  if (session.ended_at !== null) {
    throw new BrokerError('That support session has ended', 'session_closed');
  }

  const battery = store.get<{ id: string; company_id: string; bms_model: string | null }>(
    'SELECT id, company_id, bms_model FROM batteries WHERE id = ?',
    session.battery_id
  );
  assertOwned(principal, battery, 'Battery');

  const bmsModel = battery.bms_model ?? 'unknown';
  const definition = findDefinition(store, parameterKey, bmsModel);
  const present = activeSessionFor(store, battery.id, now) !== null;

  // Policy is evaluated at issue time against the situation as it stands. A
  // command with nobody on site is still refused rather than queued when the
  // refusal is about the command itself rather than about presence.
  const decision = evaluateWrite(
    principal,
    definition,
    {
      parameterKey,
      value,
      bmsModel,
      targetCompanyId: battery.company_id,
      reason: options.reason,
      supportSessionId: sessionId,
      // Queueing is a legitimate outcome, so presence is evaluated separately
      // below rather than being folded into the policy denial.
      bleSessionActive: true,
      forcePush: options.forcePush,
    },
    policy
  );

  const base = {
    companyId: battery.company_id,
    actorUserId: principal.userId,
    actorRole: principal.role,
    batteryId: battery.id,
    parameterKey,
    newValue: String(value),
    reason: options.reason ?? null,
    supportSessionId: sessionId,
    source: options.forcePush ? ('admin_force_push' as const) : ('admin_remote' as const),
  };

  if (!decision.allowed) {
    const auditId = recordAudit(store, {
      ...base,
      result: 'rejected',
      bmsResponse: `policy:${decision.code}`,
    });
    throw Object.assign(new BrokerError(decision.message, 'policy_denied'), { auditId });
  }

  const commandId = randomUUID();
  store.run(
    `INSERT INTO commands
     (id, company_id, support_session_id, battery_id, parameter_key, value, issued_by,
      force_push, state, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    commandId,
    battery.company_id,
    sessionId,
    battery.id,
    parameterKey,
    value,
    principal.userId,
    options.forcePush ? 1 : 0,
    'queued',
    now
  );

  // Issuing is itself auditable, separately from the eventual outcome — an
  // administrator asking for something is a fact even if it never lands.
  const auditId = recordAudit(store, {
    ...base,
    result: present ? 'indeterminate' : 'indeterminate',
    bmsResponse: present ? 'broker:deliverable' : 'broker:queued_no_session',
  });

  return { commandId, disposition: present ? 'deliverable' : 'queued', auditId };
}

/**
 * The technician's app collects work for a battery it is currently linked to.
 *
 * This is the only way a command leaves the cloud, and it is gated on the
 * caller genuinely holding the live session — not on them saying so.
 */
export function claimCommands(
  store: Store,
  principal: Principal,
  batteryId: string,
  now = Date.now()
): CommandRow[] {
  const battery = store.get<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM batteries WHERE id = ?',
    batteryId
  );
  assertOwned(principal, battery, 'Battery');

  const live = activeSessionFor(store, battery.id, now);
  if (!live || live.userId !== principal.userId) {
    // No live link of this caller's own: nothing is collectable. Mode 1.
    return [];
  }

  expireStaleCommands(store, now);

  // Force Push jumps the queue; that is what the flag is for.
  const rows = store.all<CommandRow>(
    `SELECT * FROM commands
     WHERE battery_id = ? AND state = 'queued'
     ORDER BY force_push DESC, created_at ASC`,
    battery.id
  );

  for (const row of rows) {
    store.run("UPDATE commands SET state = 'claimed', claimed_at = ? WHERE id = ?", now, row.id);
  }
  return rows.map((r) => ({ ...r, state: 'claimed' as const }));
}

/** The app reports what the BMS actually did, and that becomes the audit row. */
export function completeCommand(
  store: Store,
  principal: Principal,
  commandId: string,
  result: WriteResult,
  bmsResponse: string | null = null,
  now = Date.now()
): string {
  const command = store.get<CommandRow>('SELECT * FROM commands WHERE id = ?', commandId);
  if (!command) throw new BrokerError('Command not found', 'not_found');
  assertOwned(principal, command, 'Command');

  store.run(
    "UPDATE commands SET state = 'completed', settled_at = ?, result = ? WHERE id = ?",
    now,
    result,
    commandId
  );

  return recordAudit(store, {
    companyId: command.company_id,
    actorUserId: command.issued_by,
    actorRole: 'company',
    batteryId: command.battery_id,
    parameterKey: command.parameter_key,
    newValue: String(command.value),
    source: command.force_push ? 'admin_force_push' : 'admin_remote',
    result,
    bmsResponse,
    supportSessionId: command.support_session_id,
  });
}

export function expireStaleCommands(store: Store, now = Date.now()): void {
  store.run(
    "UPDATE commands SET state = 'expired', settled_at = ? WHERE state = 'queued' AND created_at < ?",
    now,
    now - COMMAND_TTL_MS
  );
}

export function listCommands(store: Store, principal: Principal, batteryId?: string): CommandRow[] {
  const q = tenantQuery(principal, 'commands', {
    where: batteryId ? 'battery_id = ?' : undefined,
    params: batteryId ? [batteryId] : [],
    orderBy: 'created_at DESC',
  });
  return store.all<CommandRow>(q.sql, ...q.params);
}

import type { Store } from '../db/client.js';
import { assertOwned, type Principal } from '../db/tenancy.js';
import { recordAudit, type WriteResult } from '../audit/service.js';
import { evaluateWrite, type CompanyPolicy, type WriteRequest } from './engine.js';
import { findDefinition } from './seed.js';
import { activeSessionFor } from '../session/bleSession.js';

/**
 * The one path a BMS write may take.
 *
 * Order matters and is not negotiable:
 *   resolve battery → check ownership → evaluate policy → dispatch → audit
 *
 * A denied write is audited too. PRD §7.12 requires every attempt to be
 * recorded, "successful or rejected" — a trail of successes alone cannot answer
 * what someone tried to do, which is usually the question being asked.
 */

export interface Dispatcher {
  /**
   * Hands a structured command to the device path. Never a raw packet: PRD
   * §7.11 keeps packet construction inside the firmware adapter.
   *
   * With Mode 1 this only ever succeeds while the user's BLE session is live,
   * which the policy engine has already established by the time this is called.
   */
  send(command: {
    batteryId: string;
    parameterKey: string;
    value: number;
  }): Promise<{ result: WriteResult; readBack?: number; bmsResponse?: string }>;
}

export interface WriteContext {
  batteryId: string;
  reason?: string;
  supportSessionId?: string;
  forcePush?: boolean;
  appVersion?: string;
}

export interface WriteOutcome {
  ok: boolean;
  auditId: string;
  result: WriteResult;
  denialCode?: string;
  message?: string;
  readBack?: number;
}

interface BatteryRow {
  id: string;
  company_id: string;
  bms_model: string | null;
  bms_firmware: string | null;
}

export async function performWrite(
  store: Store,
  dispatcher: Dispatcher,
  principal: Principal,
  parameterKey: string,
  value: number,
  context: WriteContext,
  policy: CompanyPolicy = {}
): Promise<WriteOutcome> {
  const battery = store.get<BatteryRow>(
    'SELECT id, company_id, bms_model, bms_firmware FROM batteries WHERE id = ?',
    context.batteryId
  );

  // Ownership before anything else. This throws rather than returning, because
  // a caller poking at another tenant's id gets no audit row in that tenant's
  // ledger and no confirmation the battery exists.
  assertOwned(principal, battery, 'Battery');

  // Established from the server's own record of heartbeats, never from the
  // request. A caller asserting presence is not evidence of presence, and for
  // an admin remote write the caller could not know in any case.
  const session = activeSessionFor(store, battery.id);

  const bmsModel = battery.bms_model ?? 'unknown';
  const definition = findDefinition(store, parameterKey, bmsModel);

  const request: WriteRequest = {
    parameterKey,
    value,
    bmsModel,
    targetCompanyId: battery.company_id,
    reason: context.reason,
    supportSessionId: context.supportSessionId,
    bleSessionActive: session !== null,
    forcePush: context.forcePush,
  };

  const decision = evaluateWrite(principal, definition, request, policy);

  const base = {
    companyId: battery.company_id,
    actorUserId: principal.userId,
    actorRole: principal.role,
    batteryId: battery.id,
    parameterKey,
    newValue: String(value),
    reason: context.reason ?? null,
    appVersion: context.appVersion ?? null,
    bmsFirmware: battery.bms_firmware,
    supportSessionId: context.supportSessionId ?? null,
    deviceId: null,
  };

  if (!decision.allowed) {
    // Refused before the radio. Still recorded, still attributable.
    const auditId = recordAudit(store, {
      ...base,
      source: principal.role === 'company' ? 'admin_remote' : 'local',
      result: 'rejected',
      bmsResponse: `policy:${decision.code}`,
    });
    return {
      ok: false,
      auditId,
      result: 'rejected',
      denialCode: decision.code,
      message: decision.message,
    };
  }

  let result: WriteResult;
  let readBack: number | undefined;
  let bmsResponse: string | undefined;

  try {
    const dispatched = await dispatcher.send({
      batteryId: battery.id,
      parameterKey,
      value,
    });
    result = dispatched.result;
    readBack = dispatched.readBack;
    bmsResponse = dispatched.bmsResponse;
  } catch (error) {
    // The command may already have reached the BMS. Recording this as a failure
    // would be a claim the server cannot support, so it is recorded as unknown.
    result = 'indeterminate';
    bmsResponse = error instanceof Error ? error.message : 'dispatch failed';
  }

  const auditId = recordAudit(store, {
    ...base,
    newValue: readBack !== undefined ? String(readBack) : String(value),
    source: decision.source,
    result,
    bmsResponse: bmsResponse ?? null,
  });

  return {
    ok: result === 'success' || result === 'adjusted',
    auditId,
    result,
    readBack,
  };
}

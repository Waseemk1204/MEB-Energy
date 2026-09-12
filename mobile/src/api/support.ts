import type { ApiClient } from './client';

/**
 * Assisted remote control — the administrator's half of Mode 1 (PRD §7.3,
 * §7.10). The technician's half, which reads these sessions, is in
 * supportSessions.ts.
 *
 * The one thing this module exists to keep honest: **issuing a change is not
 * making a change.** A command reaches a BMS only when a technician's app
 * claims it while their BLE session is live. With nobody on site it sits in a
 * queue, and the screen must say so rather than showing a tick.
 *
 * That is not a limitation to be smoothed over in the UI — it is the safety
 * property the whole architecture is built on. An administrator who believes
 * a change has landed when it has not is exactly the failure Mode 1 prevents.
 */

export type Disposition = 'deliverable' | 'queued';

export interface RemoteParameter {
  parameterKey: string;
  displayName: string;
  unit: string;
  minValue: number;
  maxValue: number;
  dangerLevel: 'Normal' | 'Warning' | 'Critical';
  writable: boolean;
  requiresAdmin: boolean;
  requiresConfirmation: boolean;
}

export interface IssueResult {
  commandId: string;
  disposition: Disposition;
  auditId: string;
}

export async function openSession(api: ApiClient, batteryId: string): Promise<string> {
  const body = await api.authedPost<{ supportSessionId: string }>('/support-sessions', { batteryId });
  return body.supportSessionId;
}

/**
 * Closing a session cancels everything it queued, and reports how much. That
 * count is not a detail: a command issued during a call could otherwise fire
 * hours later, after the conversation that justified it has ended.
 */
export async function closeSession(
  api: ApiClient,
  sessionId: string,
  outcome: string
): Promise<number> {
  const body = await api.authedPatch<{ cancelledCommands: number }>(
    `/support-sessions/${sessionId}`,
    { outcome }
  );
  return body.cancelledCommands;
}

export async function issueCommand(
  api: ApiClient,
  sessionId: string,
  input: { parameterKey: string; value: number; reason: string; forcePush?: boolean }
): Promise<IssueResult> {
  return api.authedPost<IssueResult>(`/support-sessions/${sessionId}/commands`, input);
}

/** Whether a technician currently holds a live link to this pack. */
export async function isSomeoneOnSite(api: ApiClient, batteryId: string): Promise<boolean> {
  const body = await api.get<{ active: boolean }>(`/batteries/${batteryId}/session`);
  return body.active;
}

export async function parametersFor(api: ApiClient, bmsModel: string): Promise<RemoteParameter[]> {
  const body = await api.get<{ parameters: RemoteParameter[] }>(
    `/bms/${encodeURIComponent(bmsModel)}/parameters`
  );
  return body.parameters;
}

/**
 * What the administrator is told after issuing a change.
 *
 * Neither wording claims the battery changed. `deliverable` means a technician
 * can collect it now; `queued` means nobody is there and it will wait.
 */
export function describeDisposition(disposition: Disposition): { text: string; tone: 'good' | 'warn' } {
  return disposition === 'deliverable'
    ? {
        text: 'Sent. A technician is on site and their app will collect it.',
        tone: 'good',
      }
    : {
        text: 'Queued. Nobody is linked to this pack, so it will wait until someone is.',
        tone: 'warn',
      };
}

/**
 * Force Push overrides queue order and soft holds. It does **not** override the
 * requirement that a technician be present — the PRD calls that constraint
 * architectural, and it is the one most likely to be quietly weakened for
 * support convenience. The screen says so at the point of use.
 */
export const FORCE_PUSH_CAVEAT =
  'Force Push moves this ahead of other queued changes. It does not deliver it any sooner: a technician still has to be linked to the pack.';

/** A reason is required for every remote change; the ledger is worth nothing without it. */
export const MIN_REASON_LENGTH = 8;

export function reasonIsSufficient(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LENGTH;
}

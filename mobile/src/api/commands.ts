import type { ApiClient } from './client';
import { logInfo, logWarn } from '../diagnostics/fieldLog';
import type { WriteOutcome } from '../telemetry/writeOutcome';

/**
 * Collecting the changes an administrator issued (PRD §7.3, Mode 1).
 *
 * This is the half of assisted remote control that runs on the technician's
 * phone, and without it the cloud half is decorative: an administrator issues
 * a change, the console reports it as collectable, and nothing ever collects
 * it.
 *
 * Three properties matter here, and each is the reason for a specific choice
 * below.
 *
 * · **Claiming is collection, not consent.** There is no accept step and no
 *   prompt. PRD §6.3 is explicit that an admin remote write never asks the
 *   technician — they are told afterwards, by the passive banner and the
 *   activity timeline. A confirmation dialog here would quietly turn Mode 1
 *   into something else.
 *
 * · **A claimed command must be reported.** The server marks it `claimed` the
 *   moment it hands it over, so a command claimed and then dropped — app
 *   killed, BLE lost — is stuck: it will never be re-issued and never
 *   completed. Every claim is therefore followed by a report, including for
 *   outcomes nobody likes, and `indeterminate` is a real report rather than
 *   silence.
 *
 * · **Only while linked.** The server refuses to hand anything over unless the
 *   caller holds the live BLE session, so polling with no link is pointless
 *   traffic. The poller runs with the link and stops with it.
 */

export interface QueuedCommand {
  id: string;
  parameterKey: string;
  value: number;
  forcePush: boolean;
  supportSessionId: string;
}

interface CommandRow {
  id: string;
  parameter_key: string;
  value: number;
  force_push: number;
  support_session_id: string;
}

export function fromRow(row: CommandRow): QueuedCommand {
  return {
    id: row.id,
    parameterKey: row.parameter_key,
    value: row.value,
    forcePush: row.force_push === 1,
    supportSessionId: row.support_session_id,
  };
}

/** How often the app asks for work while linked to a pack. */
export const CLAIM_INTERVAL_MS = 10_000;

/**
 * Ask for anything queued for this battery.
 *
 * A failure returns nothing rather than throwing: an administrator's change
 * not arriving for another ten seconds is not worth interrupting a technician
 * over, and the next poll will pick it up.
 */
export async function claimCommands(
  client: ApiClient,
  batteryId: string
): Promise<QueuedCommand[]> {
  try {
    const body = await client.authedPost<{ commands: CommandRow[] }>(
      `/batteries/${encodeURIComponent(batteryId)}/commands/claim`
    );
    const commands = body.commands.map(fromRow);
    if (commands.length > 0) {
      logInfo('write', 'Claimed remote changes', { count: commands.length });
    }
    return commands;
  } catch (error) {
    logWarn('write', 'Could not check for remote changes', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return [];
  }
}

/**
 * Report what the BMS actually did.
 *
 * This is what turns a claimed command into a completed one and writes the
 * audit row, so it is attempted even when the outcome is bad — a silent
 * failure leaves the command claimed forever, which is worse than a recorded
 * refusal.
 */
export async function reportResult(
  client: ApiClient,
  commandId: string,
  result: WriteOutcome,
  bmsResponse?: string
): Promise<boolean> {
  try {
    await client.authedPost(`/commands/${encodeURIComponent(commandId)}/result`, {
      result,
      bmsResponse: bmsResponse ?? null,
    });
    return true;
  } catch (error) {
    // The command stays `claimed` server-side. Recording that here is the only
    // way anyone finds out; the alternative is a command that silently never
    // completes.
    logWarn('write', 'Could not report a remote change result', {
      commandId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

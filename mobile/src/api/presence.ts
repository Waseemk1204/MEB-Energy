import type { ApiClient } from './client';
import { logInfo, logWarn } from '../diagnostics/fieldLog';

/**
 * Telling the cloud a technician is standing at this pack.
 *
 * This is the fact the whole of Mode 1 turns on. The server refuses to hand a
 * queued command to anyone who does not hold a live BLE session, and it takes
 * that from its own records rather than from anything the caller asserts —
 * which is correct, and means an app that never registers its session can
 * never collect anything.
 *
 * Registering it is therefore not bookkeeping. It is the difference between an
 * administrator's change reaching a battery and sitting in a queue forever
 * while the console reports it as collectable.
 *
 * The session goes stale after {@link PRESENCE_STALE_MS} without a heartbeat,
 * so it is refreshed on a shorter interval — a link that is genuinely alive
 * must never look dead to an administrator deciding whether to issue a change.
 */

/** Matches the server's `SESSION_STALE_MS`. Duplicated across a network. */
export const PRESENCE_STALE_MS = 30_000;

/**
 * Comfortably inside the staleness window, so one dropped request does not
 * make a live technician disappear.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

export interface Presence {
  sessionId: string;
  batteryId: string;
}

/**
 * Open or refresh the session. The server treats a repeat as a heartbeat, so
 * there is one call for both and no way for the two to disagree.
 */
export async function announcePresence(
  client: ApiClient,
  batteryId: string
): Promise<Presence | null> {
  try {
    const body = await client.authedPost<{ sessionId: string; batteryId: string }>(
      `/batteries/${encodeURIComponent(batteryId)}/session`
    );
    return { sessionId: body.sessionId, batteryId: body.batteryId };
  } catch (error) {
    // Not fatal to the link: the technician is still connected to the pack and
    // can still work. What they lose is the ability to receive remote changes,
    // which the next heartbeat restores.
    logWarn('ble', 'Could not register presence with the cloud', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/**
 * End it deliberately rather than letting it time out.
 *
 * Thirty seconds during which an administrator believes somebody is standing
 * at a pack they have walked away from is thirty seconds in which a change can
 * be issued as deliverable and then wait indefinitely.
 */
export async function endPresence(client: ApiClient, batteryId: string): Promise<void> {
  try {
    await client.authedDelete(`/batteries/${encodeURIComponent(batteryId)}/session`);
    logInfo('ble', 'Cloud presence ended');
  } catch (error) {
    // It will age out on its own within the staleness window, so this is a
    // tidiness failure rather than a correctness one.
    logWarn('ble', 'Could not end cloud presence; it will time out', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

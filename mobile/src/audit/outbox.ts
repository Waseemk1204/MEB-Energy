import type { ApiClient } from '../api/client';
import type { ActivityEntry } from '../store/useActivityStore';
import { logInfo, logWarn } from '../diagnostics/fieldLog';

/**
 * Getting on-site writes into the server ledger.
 *
 * A technician performs writes over BLE in places with no signal, so the app
 * records them locally and uploads later. The rules that make that safe:
 *
 * · **Nothing is retired without an acknowledgement naming it.** An entry is
 *   marked sent only when the server's response says it stored *that* event.
 *   Assuming a 200 covered everything sent would lose whatever it did not.
 * · **The upload is idempotent.** Each entry carries a stable id, and the
 *   server treats a repeat as already-stored. A technician whose connection
 *   drops mid-upload retries safely — and that technician is precisely the one
 *   whose connection drops.
 * · **A failure changes nothing.** Entries stay queued and are tried again.
 */

/** Kept well under the server's 200 so one bad batch is small. */
export const UPLOAD_BATCH = 50;

export interface UploadAck {
  clientEventId: string;
  auditId: string;
  duplicate: boolean;
}

export interface FlushResult {
  /** Ids the server has confirmed it holds. Safe to mark synced. */
  confirmed: string[];
  stored: number;
  duplicates: number;
  /** Set when the upload failed; entries remain queued. */
  error?: string;
}

/** Oldest first: the ledger reads better when history arrives in order. */
export function pending(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.filter((e) => e.synced !== true).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * The server requires an id of at least 8 characters and some of the app's own
 * ids are short. Padding here rather than changing the id format keeps
 * existing local history uploadable.
 */
export function eventIdFor(entry: ActivityEntry): string {
  return entry.id.length >= 8 ? entry.id : `local-${entry.id}`;
}

function toEvent(entry: ActivityEntry) {
  return {
    clientEventId: eventIdFor(entry),
    parameterKey: entry.parameterKey,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    reason: entry.reason ?? null,
    result: entry.result,
    occurredAt: entry.timestamp,
  };
}

/**
 * Upload one batch. Returns the entry ids the server confirmed, so the caller
 * can mark exactly those and no others.
 */
export async function flushOnce(
  client: ApiClient,
  batteryId: string,
  entries: ActivityEntry[]
): Promise<FlushResult> {
  const batch = pending(entries).slice(0, UPLOAD_BATCH);
  if (batch.length === 0) return { confirmed: [], stored: 0, duplicates: 0 };

  try {
    const response = await client.authedPost<{
      accepted: UploadAck[];
      stored: number;
      duplicates: number;
    }>(`/batteries/${encodeURIComponent(batteryId)}/audit`, {
      events: batch.map(toEvent),
    });

    // Map the server's ids back to local ones, and confirm only what it named.
    const acknowledged = new Set(response.accepted.map((a) => a.clientEventId));
    const confirmed = batch.filter((e) => acknowledged.has(eventIdFor(e))).map((e) => e.id);

    logInfo('write', 'Uploaded audit entries', {
      stored: response.stored,
      duplicates: response.duplicates,
    });
    return { confirmed, stored: response.stored, duplicates: response.duplicates };
  } catch (error) {
    // Nothing is retired. The entries are still the only copy that exists.
    const message = error instanceof Error ? error.message : 'upload failed';
    logWarn('write', 'Audit upload failed; entries stay queued', { reason: message });
    return { confirmed: [], stored: 0, duplicates: 0, error: message };
  }
}

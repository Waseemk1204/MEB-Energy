import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ActivityEntry } from './useActivityStore';

/**
 * Local persistence for the write history.
 *
 * This is NOT the ledger of record — PRD §7.12 puts that server-side, append-only
 * and tamper-evident. Until that exists, this is the only account of what a
 * technician changed on a real pack, and losing it with the process is not
 * acceptable for a pilot.
 *
 * Two rules it keeps:
 *  · the app never edits or deletes an entry, only appends
 *  · when the cap is reached the oldest entries are dropped, and the fact that
 *    they were dropped is recorded — a silently truncated audit trail is worse
 *    than a short one, because it looks complete
 *  · an entry the backend has not yet accepted is never dropped, whatever the
 *    cap says. Those are the only copy in existence; a technician working a
 *    week offsite must not lose the start of their work to the end of it
 */

const KEY = 'meb.audit.v1';

/** Bounded so a long-lived install cannot grow without limit. */
export const AUDIT_CAP = 500;

export interface AuditLog {
  entries: ActivityEntry[];
  /** How many entries have been dropped to stay under the cap, ever. */
  droppedCount: number;
}

const EMPTY: AuditLog = { entries: [], droppedCount: 0 };

function isEntry(value: unknown): value is ActivityEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<ActivityEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.timestamp === 'number' &&
    typeof e.parameterKey === 'string' &&
    typeof e.result === 'string'
  );
}

export async function loadAudit(): Promise<AuditLog> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return EMPTY;

    const parsed = JSON.parse(raw) as Partial<AuditLog>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];

    // Newest first, matching how the timeline reads.
    entries.sort((a, b) => b.timestamp - a.timestamp);

    return {
      entries,
      droppedCount: typeof parsed.droppedCount === 'number' ? parsed.droppedCount : 0,
    };
  } catch {
    // A corrupt log must not take the app down with it. Losing local history is
    // recoverable; a technician unable to open the app at a live pack is not.
    return EMPTY;
  }
}

export async function saveAudit(log: AuditLog): Promise<AuditLog> {
  const trimmed = trim(log);

  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* best effort — the in-memory log still works this session */
  }
  return trimmed;
}

/**
 * Enforce the cap, but only ever on entries the backend already holds.
 *
 * Entries are newest-first, so the candidates for dropping are at the end. An
 * unsynced entry there is skipped and kept: it is the only copy that exists,
 * and the log growing past the cap while offline is a far smaller problem than
 * a write to a physical battery going unrecorded.
 */
export function trim(log: AuditLog): AuditLog {
  if (log.entries.length <= AUDIT_CAP) return log;

  const kept: typeof log.entries = [];
  let dropped = 0;

  // Walk oldest-first so the oldest synced entries go first.
  for (let i = log.entries.length - 1; i >= 0; i -= 1) {
    const entry = log.entries[i]!;
    const overCap = log.entries.length - dropped > AUDIT_CAP;

    if (overCap && entry.synced === true) {
      dropped += 1;
      continue;
    }
    kept.push(entry);
  }

  return { entries: kept.reverse(), droppedCount: log.droppedCount + dropped };
}

export async function clearAudit(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* already gone */
  }
}

/**
 * Everything needed to reconstruct what happened, in a form someone can email
 * out of the field while there is no backend to receive it.
 */
export function exportAudit(log: AuditLog, context: { battery: string; operator: string }): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      battery: context.battery,
      operator: context.operator,
      note:
        'Local write history from the app. Not the authoritative audit ' +
        'ledger; entries may be missing if the cap was reached.',
      droppedCount: log.droppedCount,
      entryCount: log.entries.length,
      entries: log.entries,
    },
    null,
    2
  );
}

/** Entries not yet accepted by the backend ledger. */
export function pendingSync(log: AuditLog): ActivityEntry[] {
  return log.entries.filter((e) => !e.synced);
}

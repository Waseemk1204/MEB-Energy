import type { ApiClient } from './client';
import { logWarn } from '../diagnostics/fieldLog';

/**
 * Support sessions, as the technician's app reads them.
 *
 * The Support screen used to show a fabricated one — a session id, an
 * administrator's name, "started 4 minutes ago", and a pulsing *Live*
 * indicator — none of which corresponded to anything. A technician reading it
 * would have believed somebody was in a session with the pack beside them at
 * that moment.
 *
 * The listing is tenant-scoped server-side, so a technician sees their own
 * company's sessions and nobody else's.
 */

export interface SupportSession {
  id: string;
  batteryId: string;
  adminUserId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
}

interface SessionRow {
  id: string;
  battery_id: string;
  admin_user_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
}

export function fromRow(row: SessionRow): SupportSession {
  return {
    id: row.id,
    batteryId: row.battery_id,
    adminUserId: row.admin_user_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
  };
}

/** Open, and for this pack. A closed session is history, not a live one. */
export function activeFor(sessions: SupportSession[], batteryId: string): SupportSession | null {
  return (
    sessions
      .filter((s) => s.batteryId === batteryId && s.endedAt === null)
      // Newest first: if two are somehow open, the later one is the live one.
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  );
}

/**
 * A failure returns nothing rather than throwing.
 *
 * "We could not check" and "there is no session" are different, and the caller
 * distinguishes them — but neither is worth interrupting somebody standing at
 * a pack, and inventing a session to fill the gap is what this replaced.
 */
export async function listSupportSessions(client: ApiClient): Promise<SupportSession[] | null> {
  try {
    const body = await client.get<{ sessions: SessionRow[] }>('/support-sessions');
    return body.sessions.map(fromRow);
  } catch (error) {
    logWarn('session', 'Could not read support sessions', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

export function formatStarted(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toISOString().slice(0, 10);
}

import { create } from 'zustand';
import type { DangerLevel } from '../theme/tokens';
import { loadAudit, saveAudit, type AuditLog } from './auditStorage';
import { flushOnce, pending } from '../audit/outbox';
import { DEMO_ACTIVITY } from '../config';
import { api } from '../api/session';

/**
 * Write history. Mirrors the server-side audit ledger's user-visible subset.
 *
 * `source` is the field that answers "who actually initiated this" at a glance.
 * Admin remote writes never prompt the user (PRD §6.3) — this record and the
 * passive banner are the only way they learn a parameter changed on hardware
 * they are standing next to, so neither is optional.
 */
export type WriteSource = 'local' | 'admin_remote' | 'admin_force_push';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  parameterKey: string;
  displayName: string;
  oldValue: string;
  newValue: string;
  actor: string;
  reason?: string;
  source: WriteSource;
  dangerLevel: DangerLevel;
  /**
   * `indeterminate` is not a failure — it means the app cannot tell whether the
   * BMS applied the change. It must never be recorded as either outcome.
   */
  result: 'success' | 'adjusted' | 'rejected' | 'timeout' | 'indeterminate';
  supportSessionId?: string;
  /** False until the backend ledger has accepted this entry. */
  synced?: boolean;
}

export const SOURCE_LABEL: Record<WriteSource, string> = {
  local: 'Local',
  admin_remote: 'Admin remote',
  admin_force_push: 'Admin Force Push',
};

type ActivityState = {
  entries: ActivityEntry[];
  /** The most recent admin-sourced entry the user has not yet seen on the dashboard. */
  unseenAdminEntryId: string | null;
  hydrated: boolean;
  /** Entries dropped to stay under the storage cap. Surfaced, never hidden. */
  droppedCount: number;
  /** True while an upload to the server ledger is in flight. */
  uploading: boolean;
  /** How many entries the server has not accepted yet. Shown, never hidden. */
  pendingCount: () => number;

  hydrate: () => Promise<void>;
  add: (e: Omit<ActivityEntry, 'id' | 'timestamp'>) => void;
  dismissBanner: () => void;
  /** Push whatever the server has not accepted. Safe to call repeatedly. */
  sync: (batteryId: string) => Promise<void>;
};

/**
 * Example entries for looking at the timeline before any real write exists.
 *
 * Every one is marked `synced: true`. That is not cosmetic: `sync` uploads
 * anything not yet accepted, and the ledger it uploads to is append-only, so
 * an unmarked seed entry would become a permanent fabrication in the record of
 * what happened to a physical battery. Marking them means the outbox skips
 * them however the flag is set.
 */
const EXAMPLES: ActivityEntry[] = [
  {
    id: 'a3',
    timestamp: Date.now() - 1000 * 60 * 4,
    parameterKey: 'balance_start_v',
    displayName: 'Balance turn-on voltage',
    oldValue: '3.400 V',
    newValue: '3.420 V',
    actor: 'R. Mehta (Admin)',
    source: 'admin_remote',
    dangerLevel: 'Normal',
    result: 'success',
    supportSessionId: 'SS-4471',
    synced: true,
  },
  {
    id: 'a2',
    timestamp: Date.now() - 1000 * 60 * 52,
    parameterKey: 'charge_htp',
    displayName: 'Charge high-temp protection',
    oldValue: '68 °C',
    newValue: '65 °C',
    actor: 'You',
    reason: 'Derating for summer depot conditions',
    source: 'local',
    dangerLevel: 'Warning',
    result: 'success',
    synced: true,
  },
  {
    id: 'a1',
    timestamp: Date.now() - 1000 * 60 * 60 * 19,
    parameterKey: 'cell_ovp',
    displayName: 'Cell over-voltage',
    oldValue: '3.750 V',
    newValue: '3.800 V',
    actor: 'You',
    reason: 'Requested by pack vendor',
    source: 'local',
    dangerLevel: 'Critical',
    result: 'rejected',
    synced: true,
  },
];

/**
 * What a fresh install starts with.
 *
 * A function of the flag rather than a constant folded against `__DEV__`,
 * because `__DEV__` is true under test — so a guard written directly against
 * it is indistinguishable from no guard at all, and a mutation removing it
 * passes. Taking the flag as an argument makes both branches testable.
 */
export function initialEntries(demo: boolean): ActivityEntry[] {
  return demo ? EXAMPLES : [];
}

export function initialBanner(demo: boolean): string | null {
  return demo ? 'a3' : null;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  entries: initialEntries(DEMO_ACTIVITY),
  unseenAdminEntryId: initialBanner(DEMO_ACTIVITY),
  hydrated: false,
  droppedCount: 0,
  uploading: false,

  pendingCount: () => pending(get().entries).length,

  /**
   * Stored history replaces the seed entirely. Merging the two would invent
   * writes that never happened, which in an audit trail is the worst outcome.
   */
  hydrate: async () => {
    if (get().hydrated) return;
    const log = await loadAudit();
    set(
      log.entries.length
        ? { hydrated: true, entries: log.entries, droppedCount: log.droppedCount }
        : { hydrated: true, droppedCount: log.droppedCount }
    );
  },

  add: (e) => {
    const entry: ActivityEntry = {
      ...e,
      id: `w${Date.now()}`,
      timestamp: Date.now(),
      synced: false,
    };
    const entries = [entry, ...get().entries];
    set({
      entries,
      unseenAdminEntryId: e.source === 'local' ? get().unseenAdminEntryId : entry.id,
    });

    // Persist immediately: the write already reached the battery, so the record
    // of it must not depend on the app closing cleanly.
    void saveAudit({ entries, droppedCount: get().droppedCount } as AuditLog).then((trimmed) =>
      set({ entries: trimmed.entries, droppedCount: trimmed.droppedCount })
    );
  },

  dismissBanner: () => set({ unseenAdminEntryId: null }),

  /**
   * Only entries the server names in its response are marked accepted. A
   * failure marks nothing and leaves everything queued — these entries are the
   * only record that a change reached a physical battery.
   */
  sync: async (batteryId) => {
    if (get().uploading) return;
    const queued = pending(get().entries);
    if (queued.length === 0) return;

    set({ uploading: true });
    const result = await flushOnce(api, batteryId, get().entries);

    if (result.confirmed.length > 0) {
      const accepted = new Set(result.confirmed);
      const entries = get().entries.map((e) =>
        accepted.has(e.id) ? { ...e, synced: true } : e
      );
      set({ entries });
      // Persist the accepted marks, and let the cap reclaim what is now safe
      // to drop — which it could not do while these were the only copy.
      void saveAudit({ entries, droppedCount: get().droppedCount } as AuditLog).then((trimmed) =>
        set({ entries: trimmed.entries, droppedCount: trimmed.droppedCount })
      );
    }

    set({ uploading: false });
  },
}));

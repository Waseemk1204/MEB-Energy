const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore.set(k, v);
    }),
    removeItem: jest.fn(async (k: string) => {
      mockStore.delete(k);
    }),
  },
}));

/* eslint-disable import/first -- the mock factory above captures a module-scope
   variable, so it must be defined before the module under test is imported. */
import {
  AUDIT_CAP,
  clearAudit,
  exportAudit,
  loadAudit,
  pendingSync,
  saveAudit,
  type AuditLog,
} from './auditStorage';
import type { ActivityEntry } from './useActivityStore';

const KEY = 'knowyourev.audit.v1';

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'w1',
  timestamp: 1_800_000_000_000,
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  oldValue: '3.750 V',
  newValue: '3.800 V',
  actor: 'You',
  source: 'local',
  dangerLevel: 'Critical',
  result: 'success',
  synced: false,
  ...over,
});

const log = (entries: ActivityEntry[], droppedCount = 0): AuditLog => ({ entries, droppedCount });

beforeEach(() => mockStore.clear());

describe('round trip', () => {
  it('returns an empty log when nothing is stored', async () => {
    expect(await loadAudit()).toEqual({ entries: [], droppedCount: 0 });
  });

  it('persists and restores entries', async () => {
    await saveAudit(log([entry()]));
    const restored = await loadAudit();
    expect(restored.entries).toHaveLength(1);
    expect(restored.entries[0].parameterKey).toBe('cell_ovp');
  });

  it('restores newest first, whatever order it was written in', async () => {
    await saveAudit(
      log([entry({ id: 'old', timestamp: 1000 }), entry({ id: 'new', timestamp: 9000 })])
    );
    const restored = await loadAudit();
    expect(restored.entries.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('clears', async () => {
    await saveAudit(log([entry()]));
    await clearAudit();
    expect((await loadAudit()).entries).toEqual([]);
  });
});

/**
 * A truncated audit trail that looks complete is worse than a short one, so the
 * count of dropped entries is kept and surfaced.
 */
describe('the cap', () => {
  /** Newest first, and already accepted by the backend so the cap applies. */
  const many = (n: number, synced = true) =>
    Array.from({ length: n }, (_, i) =>
      entry({ id: `w${i}`, timestamp: 2_000_000 - i, synced })
    );

  it('keeps everything below the cap', async () => {
    const saved = await saveAudit(log(many(10)));
    expect(saved.entries).toHaveLength(10);
    expect(saved.droppedCount).toBe(0);
  });

  it('trims the oldest entries once over', async () => {
    const saved = await saveAudit(log(many(AUDIT_CAP + 7)));
    expect(saved.entries).toHaveLength(AUDIT_CAP);
    expect(saved.droppedCount).toBe(7);
  });

  it('keeps the newest entries, not the oldest', async () => {
    const saved = await saveAudit(log(many(AUDIT_CAP + 5)));
    expect(saved.entries[0].id).toBe('w0');
    expect(saved.entries.some((e) => e.id === `w${AUDIT_CAP + 4}`)).toBe(false);
  });

  it('accumulates the dropped count across saves', async () => {
    const first = await saveAudit(log(many(AUDIT_CAP + 3)));
    const second = await saveAudit(log(many(AUDIT_CAP + 4), first.droppedCount));
    expect(second.droppedCount).toBe(7);
  });
});

/**
 * An entry the backend has not accepted is the only copy in existence. A
 * technician working a week with no signal must not lose the start of that
 * week to the end of it.
 */
describe('entries the backend has not accepted yet', () => {
  const many = (n: number, synced: boolean) =>
    Array.from({ length: n }, (_, i) =>
      entry({ id: `w${i}`, timestamp: 2_000_000 - i, synced })
    );

  it('keeps them past the cap rather than dropping them', async () => {
    const saved = await saveAudit(log(many(AUDIT_CAP + 40, false)));
    expect(saved.entries).toHaveLength(AUDIT_CAP + 40);
    expect(saved.droppedCount).toBe(0);
  });

  it('drops the synced ones and keeps the unsynced ones in the same log', async () => {
    // Oldest 30 are unsynced; everything newer has been accepted.
    const entries = Array.from({ length: AUDIT_CAP + 30 }, (_, i) =>
      entry({
        id: `w${i}`,
        timestamp: 2_000_000 - i,
        synced: i < AUDIT_CAP,
      })
    );

    const saved = await saveAudit(log(entries));

    expect(saved.entries.filter((e) => e.synced === false)).toHaveLength(30);
    expect(saved.droppedCount).toBe(30);
    expect(saved.entries).toHaveLength(AUDIT_CAP);
  });

  it('treats an entry with no sync flag as unsent, not as sent', async () => {
    const entries = Array.from({ length: AUDIT_CAP + 5 }, (_, i) => {
      const e = entry({ id: `w${i}`, timestamp: 2_000_000 - i });
      delete (e as { synced?: boolean }).synced;
      return e;
    });
    const saved = await saveAudit(log(entries));
    expect(saved.entries).toHaveLength(AUDIT_CAP + 5);
    expect(saved.droppedCount).toBe(0);
  });

  it('still keeps the newest entries at the front', async () => {
    const saved = await saveAudit(log(many(AUDIT_CAP + 10, false)));
    expect(saved.entries[0].id).toBe('w0');
    expect(saved.entries[saved.entries.length - 1].id).toBe(`w${AUDIT_CAP + 9}`);
  });
});

describe('resilience', () => {
  /** Losing local history is recoverable; a technician locked out at a live pack is not. */
  it('returns an empty log rather than throwing on corrupt data', async () => {
    mockStore.set(KEY, '{"entries":[{"id":"a"');
    await expect(loadAudit()).resolves.toEqual({ entries: [], droppedCount: 0 });
  });

  it('drops malformed entries rather than the whole log', async () => {
    mockStore.set(
      KEY,
      JSON.stringify({ entries: [entry(), { id: 'broken' }, null, 'nope'], droppedCount: 0 })
    );
    const restored = await loadAudit();
    expect(restored.entries).toHaveLength(1);
  });

  it('survives a log with no droppedCount field', async () => {
    mockStore.set(KEY, JSON.stringify({ entries: [entry()] }));
    expect((await loadAudit()).droppedCount).toBe(0);
  });
});

describe('pendingSync', () => {
  it('lists entries the ledger has not accepted', () => {
    const l = log([entry({ id: 'a', synced: true }), entry({ id: 'b', synced: false })]);
    expect(pendingSync(l).map((e) => e.id)).toEqual(['b']);
  });

  it('treats an entry with no sync flag as pending', () => {
    const l = log([entry({ id: 'a', synced: undefined })]);
    expect(pendingSync(l)).toHaveLength(1);
  });
});

describe('export', () => {
  const parsed = () =>
    JSON.parse(exportAudit(log([entry()], 3), { battery: 'BAT-00042', operator: 'w.khan' }));

  it('carries the battery and operator the entries belong to', () => {
    expect(parsed()).toMatchObject({ battery: 'BAT-00042', operator: 'w.khan' });
  });

  it('states that entries may be missing rather than implying completeness', () => {
    const p = parsed();
    expect(p.droppedCount).toBe(3);
    expect(p.note).toMatch(/not the authoritative audit ledger/i);
  });

  it('includes the entries themselves', () => {
    expect(parsed().entries).toHaveLength(1);
    expect(parsed().entryCount).toBe(1);
  });
});

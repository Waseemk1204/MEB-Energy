import { useActivityStore } from './useActivityStore';
import * as outbox from '../audit/outbox';
import type { ActivityEntry } from './useActivityStore';

jest.mock('../api/session', () => ({ api: {} }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));
jest.mock('./auditStorage', () => ({
  ...jest.requireActual('./auditStorage'),
  saveAudit: jest.fn(async (log: unknown) => log),
  loadAudit: jest.fn(async () => ({ entries: [], droppedCount: 0 })),
}));

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'w17000000001',
  timestamp: 1_700_000_000_001,
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  oldValue: '3.750 V',
  newValue: '3.800 V',
  actor: 'You',
  source: 'local',
  dangerLevel: 'Critical',
  result: 'success',
  ...over,
});

const seed = (entries: ActivityEntry[]) =>
  useActivityStore.setState({ entries, uploading: false, droppedCount: 0 });

beforeEach(() => {
  jest.restoreAllMocks();
  seed([]);
});

describe('what still needs uploading', () => {
  it('counts entries the server has not accepted', () => {
    seed([entry({ id: 'a', synced: true }), entry({ id: 'b' }), entry({ id: 'c' })]);
    expect(useActivityStore.getState().pendingCount()).toBe(2);
  });

  it('is zero once everything is accepted', () => {
    seed([entry({ id: 'a', synced: true })]);
    expect(useActivityStore.getState().pendingCount()).toBe(0);
  });
});

describe('syncing', () => {
  it('marks exactly the entries the server confirmed', async () => {
    jest.spyOn(outbox, 'flushOnce').mockResolvedValue({
      confirmed: ['a'],
      stored: 1,
      duplicates: 0,
    });
    seed([entry({ id: 'a' }), entry({ id: 'b' })]);

    await useActivityStore.getState().sync('BAT-1');

    const byId = Object.fromEntries(useActivityStore.getState().entries.map((e) => [e.id, e]));
    expect(byId.a!.synced).toBe(true);
    expect(byId.b!.synced).toBeUndefined();
  });

  /** These entries are the only record that a change reached a real battery. */
  it('marks nothing when the upload fails', async () => {
    jest.spyOn(outbox, 'flushOnce').mockResolvedValue({
      confirmed: [],
      stored: 0,
      duplicates: 0,
      error: 'Network request failed',
    });
    seed([entry({ id: 'a' }), entry({ id: 'b' })]);

    await useActivityStore.getState().sync('BAT-1');

    expect(useActivityStore.getState().entries.every((e) => e.synced !== true)).toBe(true);
    expect(useActivityStore.getState().pendingCount()).toBe(2);
  });

  it('does not call the server when there is nothing queued', async () => {
    const spy = jest.spyOn(outbox, 'flushOnce');
    seed([entry({ id: 'a', synced: true })]);

    await useActivityStore.getState().sync('BAT-1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not start a second upload while one is running', async () => {
    const spy = jest.spyOn(outbox, 'flushOnce').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { confirmed: [], stored: 0, duplicates: 0 };
    });
    seed([entry({ id: 'a' })]);

    await Promise.all([
      useActivityStore.getState().sync('BAT-1'),
      useActivityStore.getState().sync('BAT-1'),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight flag after a failure, so a retry is possible', async () => {
    jest.spyOn(outbox, 'flushOnce').mockResolvedValue({
      confirmed: [],
      stored: 0,
      duplicates: 0,
      error: 'offline',
    });
    seed([entry({ id: 'a' })]);

    await useActivityStore.getState().sync('BAT-1');
    expect(useActivityStore.getState().uploading).toBe(false);
  });

  it('leaves the entries themselves untouched apart from the accepted mark', async () => {
    jest.spyOn(outbox, 'flushOnce').mockResolvedValue({
      confirmed: ['a'],
      stored: 1,
      duplicates: 0,
    });
    const original = entry({ id: 'a', reason: 'Vendor bulletin 2026-114' });
    seed([original]);

    await useActivityStore.getState().sync('BAT-1');

    expect(useActivityStore.getState().entries[0]).toEqual({ ...original, synced: true });
  });
});

import type { ApiClient } from './client';
import { describeChange, formatWhen, fromRow, listLedger, wasUploadedLate } from './ledger';

/**
 * The filter has to reach the server. The server returns the newest page, so
 * narrowing it here would report "nothing changed" about any pack whose
 * changes are older than that page — a false statement about an audit trail.
 */
const capturing = () => {
  const paths: string[] = [];
  const api = {
    get: async (path: string) => {
      paths.push(path);
      return { events: [] };
    },
  } as unknown as ApiClient;
  return { api, paths };
};

describe('listing the ledger', () => {
  it('sends the pack filter to the server', async () => {
    const { api, paths } = capturing();
    await listLedger(api, { batteryId: 'b1' });
    expect(paths[0]).toBe('/audit?batteryId=b1');
  });

  it('sends source and outcome too', async () => {
    const { api, paths } = capturing();
    await listLedger(api, { source: 'admin_remote', result: 'rejected', limit: 50 });
    expect(paths[0]).toContain('source=admin_remote');
    expect(paths[0]).toContain('result=rejected');
    expect(paths[0]).toContain('limit=50');
  });

  it('asks for everything when there is no filter', async () => {
    const { api, paths } = capturing();
    await listLedger(api);
    expect(paths[0]).toBe('/audit');
  });

  it('escapes an id', async () => {
    const { api, paths } = capturing();
    await listLedger(api, { batteryId: 'a b' });
    expect(paths[0]).toBe('/audit?batteryId=a%20b');
  });
});

describe('reading an event', () => {
  const row = {
    id: 'e1', actor_user_id: 'u', actor_role: 'user', battery_id: 'b', parameter_key: 'cell_ovp',
    old_value: '3.750 V', new_value: '3.800 V', reason: null, source: 'local' as const,
    result: 'success' as const, support_session_id: null, occurred_at: 1_000, recorded_at: 1_000, seq: 1,
  };

  it('describes the change as from → to', () => {
    expect(describeChange(fromRow(row))).toBe('3.750 V → 3.800 V');
  });

  it('shows a missing old value rather than inventing one', () => {
    expect(describeChange(fromRow({ ...row, old_value: null }))).toBe('? → 3.800 V');
  });

  /** An event uploaded three hours late did not happen three hours late. */
  it('flags a late upload only past the threshold', () => {
    expect(wasUploadedLate(fromRow(row))).toBe(false);
    expect(wasUploadedLate(fromRow({ ...row, recorded_at: 1_000 + 6 * 60_000 }))).toBe(true);
  });

  it('formats age in words', () => {
    const now = 10_000_000;
    expect(formatWhen(now - 30_000, now)).toBe('Just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
});

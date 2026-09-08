import { initialBanner, initialEntries, useActivityStore } from './useActivityStore';
import { useSessionStore } from './useSessionStore';
import { useRemoteChangeStore } from './useRemoteChangeStore';
import * as outbox from '../audit/outbox';
import { pending } from '../audit/outbox';
import { DEMO_ACTIVITY } from '../config';
import type { ActivityEntry } from './useActivityStore';

jest.mock('../api/session', () => ({ api: {}, onSessionExpired: jest.fn(), setTokens: jest.fn() }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));
jest.mock('./auditStorage', () => ({
  ...jest.requireActual('./auditStorage'),
  saveAudit: jest.fn(async (log: unknown) => log),
  loadAudit: jest.fn(async () => ({ entries: [], droppedCount: 0 })),
}));
jest.mock('./useProfileStore', () => ({
  useProfileStore: { getState: () => ({ sync: jest.fn(), reset: jest.fn() }) },
}));
jest.mock('./useFleetStore', () => ({
  useFleetStore: { getState: () => ({ clear: jest.fn() }) },
}));

/**
 * **When** an audit entry is uploaded, not just whether the uploader works.
 *
 * The pieces were all tested — the outbox, the store's sync, the server's
 * ingest — and the whole was still wrong: sync only ran on connect. A
 * technician who linked to a pack, made five changes and disconnected left the
 * only record of those changes on their phone until they happened to link to
 * that same pack again.
 *
 * That is the shape of bug component tests cannot see, so these tests are
 * about the sequence rather than the parts.
 */

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

let flush: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  flush = jest
    .spyOn(outbox, 'flushOnce')
    .mockResolvedValue({ confirmed: [], stored: 0, duplicates: 0 });

  useActivityStore.setState({ entries: [], uploading: false, droppedCount: 0 });
  useSessionStore.setState({
    hydrated: true,
    authenticated: true,
    connectedBatteryId: 'BAT-00042',
    connectingBatteryId: null,
    stage: 'connected',
  });
});

describe('closing a link', () => {
  it('pushes what was recorded during it', async () => {
    useActivityStore.setState({ entries: [entry()] });

    useSessionStore.getState().disconnect();
    await Promise.resolve();

    expect(flush).toHaveBeenCalled();
    expect(flush.mock.calls[0]![1]).toBe('BAT-00042');
  });

  it('does not try when there is nothing recorded', async () => {
    useSessionStore.getState().disconnect();
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
  });

  it('still closes the link when the upload fails', async () => {
    flush.mockResolvedValue({ confirmed: [], stored: 0, duplicates: 0, error: 'offline' });
    useActivityStore.setState({ entries: [entry()] });

    useSessionStore.getState().disconnect();
    await Promise.resolve();

    expect(useSessionStore.getState().connectedBatteryId).toBeNull();
  });

  /** A failed upload must leave the entries queued, not discard them. */
  it('keeps the entries when the upload fails', async () => {
    flush.mockResolvedValue({ confirmed: [], stored: 0, duplicates: 0, error: 'offline' });
    useActivityStore.setState({ entries: [entry()] });

    await useActivityStore.getState().sync('BAT-00042');

    expect(useActivityStore.getState().pendingCount()).toBe(1);
  });

  it('does nothing when no pack was linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    useActivityStore.setState({ entries: [entry()] });

    useSessionStore.getState().disconnect();
    await Promise.resolve();

    expect(flush).not.toHaveBeenCalled();
  });
});

describe('opening a link', () => {
  it('pushes anything left over from before', async () => {
    useSessionStore.setState({ connectedBatteryId: null, connectingBatteryId: null });
    useActivityStore.setState({ entries: [entry()] });

    await useSessionStore.getState().connect('BAT-00042');
    await Promise.resolve();

    expect(flush).toHaveBeenCalled();
  });
});

/**
 * Signing out must not silently discard entries the server has not accepted.
 * They are the only record that a change reached a physical battery.
 */
describe('signing out', () => {
  it('leaves unsent entries in place rather than dropping them', () => {
    useActivityStore.setState({ entries: [entry()] });
    useSessionStore.getState().signOut();

    expect(useActivityStore.getState().pendingCount()).toBe(1);
  });
});


/**
 * Collecting an administrator's changes has to be wired to the link, not just
 * implemented. The store existed and worked; nothing started it, so a change
 * issued from the console was reported as collectable and never collected.
 */
describe('collecting remote changes', () => {
  beforeEach(() => {
    useRemoteChangeStore.getState().stop();
    jest.spyOn(useRemoteChangeStore.getState(), 'poll').mockResolvedValue();
  });

  afterEach(() => useRemoteChangeStore.getState().stop());

  it('starts when a link opens', async () => {
    useSessionStore.setState({ connectedBatteryId: null, connectingBatteryId: null });
    await useSessionStore.getState().connect('BAT-00042');

    expect(useRemoteChangeStore.getState().timer).not.toBeNull();
  });

  /** The server hands nothing over without a live session. */
  it('stops when the link closes', async () => {
    useSessionStore.setState({ connectedBatteryId: null, connectingBatteryId: null });
    await useSessionStore.getState().connect('BAT-00042');

    useSessionStore.getState().disconnect();
    expect(useRemoteChangeStore.getState().timer).toBeNull();
  });

  it('stops when the user signs out', async () => {
    useSessionStore.setState({ connectedBatteryId: null, connectingBatteryId: null });
    await useSessionStore.getState().connect('BAT-00042');

    useSessionStore.getState().signOut();
    expect(useRemoteChangeStore.getState().timer).toBeNull();
  });
});

/**
 * The audit ledger is append-only — a database trigger forbids updates and
 * there is no delete path — so anything fabricated that reaches it is
 * permanent.
 *
 * The app seeds its timeline with example entries so the screen and the
 * passive banner can be looked at before any real write exists. Before this
 * was guarded, a fresh install would have pushed three invented changes into
 * the ledger on its first connect, one of them attributed to a person who does
 * not exist. The seed became dangerous the moment `sync` started firing on
 * connect and after every write.
 */
describe('example entries', () => {
  /**
   * Read from `getInitialState()`, **not** from the live store.
   *
   * The `beforeEach` above empties `entries`, so asserting against the current
   * state would be asserting `pending([]) === []` — trivially true whatever
   * the seed contains. The first version of these tests did exactly that and
   * caught none of three mutations, including the original bug.
   */
  const freshInstall = () => useActivityStore.getInitialState();

  // `connect` starts the remote-change poller on a real interval. Left running
  // it keeps the process alive and the suite never exits.
  afterEach(() => useRemoteChangeStore.getState().stop());

  it('are marked as already accepted, so the outbox skips them', () => {
    const seeded = freshInstall().entries;
    expect(seeded.every((e) => e.synced === true)).toBe(true);
  });

  it('leave a fresh install with nothing to upload', () => {
    expect(pending(freshInstall().entries)).toEqual([]);
  });

  /**
   * Both branches, explicitly. `__DEV__` is true under jest, so a test that
   * asks the module-level flag what it is can only agree with itself — the
   * first version of these did exactly that and caught neither of two
   * mutations. `initialEntries` takes the flag so both answers are reachable.
   */
  it('are absent in a release build', () => {
    expect(initialEntries(false)).toEqual([]);
    expect(initialBanner(false)).toBeNull();
  });

  it('are present when the demo flag is on', () => {
    expect(initialEntries(true).length).toBeGreaterThan(0);
    expect(initialBanner(true)).not.toBeNull();
  });

  it('are marked accepted in the demo branch too', () => {
    expect(initialEntries(true).every((e) => e.synced === true)).toBe(true);
    expect(pending(initialEntries(true))).toEqual([]);
  });

  it('matches what the live store actually started with', () => {
    expect(freshInstall().entries).toEqual(initialEntries(DEMO_ACTIVITY));
  });

  it('cause no upload when a link opens on a fresh install', async () => {
    useActivityStore.setState({
      entries: freshInstall().entries,
      hydrated: false,
      uploading: false,
    });
    await useActivityStore.getState().hydrate();

    useSessionStore.setState({ connectedBatteryId: null, connectingBatteryId: null });
    await useSessionStore.getState().connect('BAT-00042');
    await Promise.resolve();

    expect(flush).not.toHaveBeenCalled();
  });

  /** A real write must still go up — the guard must not silence everything. */
  it('do not stop a real write from being uploaded', async () => {
    useActivityStore.setState({
      entries: [...freshInstall().entries, entry({ id: 'real-1' })],
    });

    await useActivityStore.getState().sync('BAT-00042');
    expect(flush).toHaveBeenCalled();
  });
});

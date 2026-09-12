import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/session';
import { describeReading, fromRow, useFleetStore } from './useFleetStore';

jest.mock('../api/session', () => ({ api: { get: jest.fn() } }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

const CACHE_KEY = 'meb.fleet.v1';
const get = api.get as jest.Mock;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  serial: 'BAT-00042',
  chemistry: 'LiFePO4',
  cell_count: 24,
  bms_model: 'JBD SP24S004',
  lastReading: null,
  ...over,
});

const reading = (over: Record<string, unknown> = {}) => ({
  soc: 72,
  pack_voltage: 79.2,
  fault_count: 0,
  recorded_at: 1_700_000_000_000,
  ...over,
});

const reset = () =>
  useFleetStore.setState({
    batteries: [],
    loading: false,
    stale: false,
    fetchedAt: null,
    error: null,
    hydrated: false,
  });

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  reset();
});

describe('reading the wire shape', () => {
  it('maps a battery row', () => {
    expect(fromRow(row())).toEqual({
      id: 'b1',
      serial: 'BAT-00042',
      chemistry: 'LiFePO4',
      cellCount: 24,
      bmsModel: 'JBD SP24S004',
      lastReading: null,
    });
  });

  it('keeps the reading’s timestamp, which the list needs as much as the value', () => {
    const mapped = fromRow(row({ lastReading: reading() }));
    expect(mapped.lastReading).toEqual({
      soc: 72,
      packVoltage: 79.2,
      faultCount: 0,
      recordedAt: 1_700_000_000_000,
    });
  });

  it('leaves a pack that has never reported with no reading at all', () => {
    expect(fromRow(row()).lastReading).toBeNull();
  });
});

describe('refreshing', () => {
  it('shows what the server sent', async () => {
    get.mockResolvedValue({ batteries: [row(), row({ id: 'b2', serial: 'BAT-00043' })] });
    await useFleetStore.getState().refresh();

    const s = useFleetStore.getState();
    expect(s.batteries.map((b) => b.serial)).toEqual(['BAT-00042', 'BAT-00043']);
    expect(s.stale).toBe(false);
    expect(s.error).toBeNull();
  });

  it('shows an empty fleet as empty, not as something else', async () => {
    get.mockResolvedValue({ batteries: [] });
    await useFleetStore.getState().refresh();
    expect(useFleetStore.getState().batteries).toEqual([]);
    expect(useFleetStore.getState().error).toBeNull();
  });

  it('caches the result for a launch with no signal', async () => {
    get.mockResolvedValue({ batteries: [row()] });
    await useFleetStore.getState().refresh();

    const raw = await AsyncStorage.getItem(CACHE_KEY);
    expect(JSON.parse(raw!).batteries[0].serial).toBe('BAT-00042');
  });

  it('does not run two refreshes at once', async () => {
    get.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { batteries: [row()] };
    });
    await Promise.all([useFleetStore.getState().refresh(), useFleetStore.getState().refresh()]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('when the server cannot be reached', () => {
  /**
   * The rule that matters. There is no seeded fleet and no fallback list —
   * a technician hunting for a pack the app invented is worse off than one
   * looking at an empty screen.
   */
  it('invents nothing', async () => {
    get.mockRejectedValue(new Error('Network request failed'));
    await useFleetStore.getState().refresh();

    const s = useFleetStore.getState();
    expect(s.batteries).toEqual([]);
    expect(s.error).toBe('Network request failed');
  });

  it('keeps the cached list and says it is stale', async () => {
    get.mockResolvedValue({ batteries: [row()] });
    await useFleetStore.getState().refresh();
    expect(useFleetStore.getState().stale).toBe(false);

    get.mockRejectedValue(new Error('offline'));
    await useFleetStore.getState().refresh();

    const s = useFleetStore.getState();
    expect(s.batteries.map((b) => b.serial)).toEqual(['BAT-00042']);
    expect(s.stale).toBe(true);
  });

  it('does not claim staleness when there was nothing to keep', async () => {
    get.mockRejectedValue(new Error('offline'));
    await useFleetStore.getState().refresh();
    expect(useFleetStore.getState().stale).toBe(false);
  });

  it('clears the in-flight flag so a retry is possible', async () => {
    get.mockRejectedValue(new Error('offline'));
    await useFleetStore.getState().refresh();
    expect(useFleetStore.getState().loading).toBe(false);
  });
});

describe('hydrating from cache', () => {
  it('restores the last fetch and marks it stale until refreshed', async () => {
    await AsyncStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ batteries: [fromRow(row())], fetchedAt: 1_700_000_000_000 })
    );
    await useFleetStore.getState().hydrate();

    const s = useFleetStore.getState();
    expect(s.batteries).toHaveLength(1);
    expect(s.stale).toBe(true);
    expect(s.fetchedAt).toBe(1_700_000_000_000);
  });

  it('starts empty when there is no cache', async () => {
    await useFleetStore.getState().hydrate();
    expect(useFleetStore.getState().batteries).toEqual([]);
    expect(useFleetStore.getState().hydrated).toBe(true);
  });

  it('survives a corrupt cache rather than failing to open', async () => {
    await AsyncStorage.setItem(CACHE_KEY, '{"batteries":[{');
    await useFleetStore.getState().hydrate();

    expect(useFleetStore.getState().hydrated).toBe(true);
    expect(useFleetStore.getState().batteries).toEqual([]);
  });

  it('reads the cache only once', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem');
    await useFleetStore.getState().hydrate();
    await useFleetStore.getState().hydrate();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('signing out', () => {
  /** The next user may be in a different company entirely. */
  it('leaves no trace of the previous fleet', async () => {
    get.mockResolvedValue({ batteries: [row()] });
    await useFleetStore.getState().refresh();

    await useFleetStore.getState().clear();

    expect(useFleetStore.getState().batteries).toEqual([]);
    expect(await AsyncStorage.getItem(CACHE_KEY)).toBeNull();
  });
});

describe('the reading age shown on each row', () => {
  const now = 1_700_000_000_000;
  const at = (ms: number) => ({ soc: 41, packVoltage: 76, faultCount: 0, recordedAt: now - ms });

  it('says a pack has never reported rather than showing zero', () => {
    expect(describeReading(null, now)).toMatchObject({ soc: null, age: 'Never reported' });
  });

  it('calls the last hour recent', () => {
    expect(describeReading(at(10 * 60 * 1000), now).age).toBe('Reported recently');
  });

  it('counts hours within a day', () => {
    expect(describeReading(at(5 * 60 * 60 * 1000), now).age).toBe('5h ago');
  });

  it('counts days beyond one', () => {
    expect(describeReading(at(3 * 24 * 60 * 60 * 1000), now).age).toBe('3d ago');
  });

  /** Never round an age down to zero — "0h ago" would read as live. */
  it('never reports an age of zero', () => {
    for (const ms of [61 * 60 * 1000, 23.6 * 60 * 60 * 1000, 25 * 60 * 60 * 1000]) {
      expect(describeReading(at(ms), now).age).not.toMatch(/^0[hd]/);
    }
  });

  it('still reports the value alongside the age, however old', () => {
    expect(describeReading(at(400 * 24 * 60 * 60 * 1000), now).soc).toBe(41);
  });
});

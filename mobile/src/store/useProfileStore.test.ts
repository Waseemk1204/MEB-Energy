import { useProfileStore } from './useProfileStore';
import { profile } from '../bms/capabilityProfile';
import * as parameters from '../api/parameters';
import type { ServerDefinition } from '../api/parameters';

jest.mock('../api/session', () => ({ api: {} }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

const asServer = (over: Partial<ServerDefinition> = {}) =>
  profile.parameters.map((p) => ({
    parameterKey: p.parameter_key,
    displayName: p.display_name,
    unit: p.unit,
    dataType: p.data_type,
    minValue: p.min,
    maxValue: p.max,
    dangerLevel: p.danger_level,
    supportedBms: profile.bmsModel,
    readable: p.readable,
    writable: p.writable,
    requiresConfirmation: p.requires_confirmation,
    requiresAdmin: p.requires_admin,
    ...(p.parameter_key === 'cell_ovp' ? over : {}),
  })) as ServerDefinition[];

beforeEach(() => {
  useProfileStore.getState().reset();
  jest.restoreAllMocks();
});

describe('before the server has been reached', () => {
  it('renders from the bundled profile', () => {
    expect(useProfileStore.getState().source).toBe('bundled');
    expect(useProfileStore.getState().parameters).toEqual(profile.parameters);
  });

  it('can still look a parameter up, so Settings works offline', () => {
    expect(useProfileStore.getState().parameterFor('cell_ovp')).toBeDefined();
  });
});

describe('after a successful sync', () => {
  it('puts the server’s bounds in force', async () => {
    jest.spyOn(parameters, 'fetchDefinitions').mockResolvedValue(asServer({ maxValue: 3.75 }));
    await useProfileStore.getState().sync();

    const s = useProfileStore.getState();
    expect(s.source).toBe('server');
    expect(s.parameterFor('cell_ovp')!.max).toBe(3.75);
    expect(s.syncedAt).toEqual(expect.any(Number));
  });

  it('keeps the disagreement rather than resolving it silently', async () => {
    jest.spyOn(parameters, 'fetchDefinitions').mockResolvedValue(asServer({ maxValue: 3.75 }));
    await useProfileStore.getState().sync();
    expect(useProfileStore.getState().drift).toEqual([
      { parameterKey: 'cell_ovp', field: 'max', bundled: '3.8', server: '3.75' },
    ]);
  });

  it('reports no drift when the shipped file already matches', async () => {
    jest.spyOn(parameters, 'fetchDefinitions').mockResolvedValue(asServer());
    await useProfileStore.getState().sync();
    expect(useProfileStore.getState().drift).toEqual([]);
    expect(useProfileStore.getState().source).toBe('server');
  });
});

describe('when the server cannot be reached', () => {
  it('stays on the bundled profile instead of emptying the screen', async () => {
    jest.spyOn(parameters, 'fetchDefinitions').mockRejectedValue(new Error('offline'));
    await useProfileStore.getState().sync();

    const s = useProfileStore.getState();
    expect(s.source).toBe('bundled');
    expect(s.parameters).toEqual(profile.parameters);
    expect(s.syncing).toBe(false);
  });
});

describe('signing out', () => {
  /** The next user may be in a different tenant, under different limits. */
  it('drops the previous tenant’s limits', async () => {
    jest.spyOn(parameters, 'fetchDefinitions').mockResolvedValue(asServer({ maxValue: 3.75 }));
    await useProfileStore.getState().sync();
    expect(useProfileStore.getState().source).toBe('server');

    useProfileStore.getState().reset();
    expect(useProfileStore.getState().source).toBe('bundled');
    expect(useProfileStore.getState().parameterFor('cell_ovp')!.max).toBe(3.8);
    expect(useProfileStore.getState().drift).toEqual([]);
  });
});

describe('concurrent syncs', () => {
  it('does not run a second fetch while one is in flight', async () => {
    const fetchSpy = jest
      .spyOn(parameters, 'fetchDefinitions')
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return asServer();
      });

    await Promise.all([useProfileStore.getState().sync(), useProfileStore.getState().sync()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

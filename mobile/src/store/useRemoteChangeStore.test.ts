import { useRemoteChangeStore } from './useRemoteChangeStore';
import { useActivityStore } from './useActivityStore';
import { useSettingsStore } from './useSettingsStore';
import { useTelemetryStore } from './useTelemetryStore';
import { useProfileStore } from './useProfileStore';
import * as commands from '../api/commands';
import * as presence from '../api/presence';
import * as writeOutcome from '../telemetry/writeOutcome';
import type { QueuedCommand } from '../api/commands';

jest.mock('../api/session', () => ({ api: {}, onSessionExpired: jest.fn(), setTokens: jest.fn() }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));
jest.mock('./auditStorage', () => ({
  ...jest.requireActual('./auditStorage'),
  saveAudit: jest.fn(async (log: unknown) => log),
  loadAudit: jest.fn(async () => ({ entries: [], droppedCount: 0 })),
}));

/**
 * Applying an administrator's change on the technician's phone.
 *
 * This is the half of Mode 1 that did not exist. The console would report a
 * change as collectable, the server would hold it, and nothing would ever
 * collect it — every component worked and the loop was open.
 */

const command = (over: Partial<QueuedCommand> = {}): QueuedCommand => ({
  id: 'c1',
  parameterKey: 'cell_ovp',
  value: 3.78,
  forcePush: false,
  supportSessionId: 's1',
  ...over,
});

let claim: jest.SpyInstance;
let report: jest.SpyInstance;
let write: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();

  claim = jest.spyOn(commands, 'claimCommands').mockResolvedValue([]);
  report = jest.spyOn(commands, 'reportResult').mockResolvedValue(true);
  write = jest.spyOn(writeOutcome, 'executeWrite').mockResolvedValue({
    outcome: 'success',
    confirmedValue: 3.78,
    message: null,
  });

  useRemoteChangeStore.setState({
    applying: false,
    appliedCount: 0,
    timer: null,
    batteryId: null,
    present: false,
  });
  jest.spyOn(presence, 'announcePresence').mockResolvedValue({ sessionId: 's1', batteryId: 'BAT-00042' });
  jest.spyOn(presence, 'endPresence').mockResolvedValue();
  useActivityStore.setState({ entries: [], unseenAdminEntryId: null, droppedCount: 0 });
  useTelemetryStore.setState({ source: {} as never });
  useProfileStore.getState().reset();
});

afterEach(() => useRemoteChangeStore.getState().stop());

describe('collecting work', () => {
  it('does nothing when nothing is queued', async () => {
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(write).not.toHaveBeenCalled();
    expect(useActivityStore.getState().entries).toHaveLength(0);
  });

  it('applies a queued change to the BMS', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![1]).toBe('cell_ovp');
    expect(write.mock.calls[0]![2]).toBe(3.78);
  });

  /**
   * PRD §6.3: an admin remote write never prompts the technician. A
   * confirmation step here would quietly turn Mode 1 into something else.
   */
  it('asks the technician nothing before applying it', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');
    // The write happened on the same pass that claimed it, with no gate.
    expect(write).toHaveBeenCalled();
  });

  it('applies several one at a time, in the order they were handed over', async () => {
    claim.mockResolvedValue([
      command({ id: 'c1', parameterKey: 'cell_ovp' }),
      command({ id: 'c2', parameterKey: 'cell_uvp', value: 2.4 }),
    ]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(write.mock.calls.map((c) => c[1])).toEqual(['cell_ovp', 'cell_uvp']);
  });

  it('does not start a second pass while one is running', async () => {
    claim.mockResolvedValue([command()]);
    write.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { outcome: 'success', confirmedValue: 3.78, message: null };
    });

    await Promise.all([
      useRemoteChangeStore.getState().poll('BAT-00042'),
      useRemoteChangeStore.getState().poll('BAT-00042'),
    ]);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

/**
 * The server marks a command `claimed` the moment it hands it over. A claim
 * that is never reported is stuck: never re-issued, never completed.
 */
describe('reporting back', () => {
  it('reports what the BMS did', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(report).toHaveBeenCalledWith(expect.anything(), 'c1', 'success', undefined);
  });

  it('reports a refusal rather than staying silent', async () => {
    claim.mockResolvedValue([command()]);
    write.mockResolvedValue({ outcome: 'rejected', confirmedValue: null, message: 'Out of range' });

    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(report).toHaveBeenCalledWith(expect.anything(), 'c1', 'rejected', 'Out of range');
  });

  /** Nobody knows is a real answer, and the one most worth not losing. */
  it('reports an unconfirmed write as unconfirmed', async () => {
    claim.mockResolvedValue([command()]);
    write.mockResolvedValue({ outcome: 'indeterminate', confirmedValue: null, message: null });

    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(report).toHaveBeenCalledWith(expect.anything(), 'c1', 'indeterminate', undefined);
  });

  it('reports every command in a batch, not just the first', async () => {
    claim.mockResolvedValue([command({ id: 'c1' }), command({ id: 'c2' })]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(report.mock.calls.map((c) => c[1])).toEqual(['c1', 'c2']);
  });

  /**
   * A parameter the server knows and this build does not. Reporting it
   * rejected releases the command; dropping it silently leaves it claimed
   * forever.
   */
  it('releases a command naming a parameter this build does not have', async () => {
    claim.mockResolvedValue([command({ parameterKey: 'not_a_real_parameter' })]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(write).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'rejected',
      'app:unknown_parameter'
    );
  });

  it('keeps going after one command fails to report', async () => {
    claim.mockResolvedValue([command({ id: 'c1' }), command({ id: 'c2' })]);
    report.mockResolvedValueOnce(false).mockResolvedValue(true);

    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(write).toHaveBeenCalledTimes(2);
  });
});

/**
 * The technician is never prompted, so the banner and the timeline are the
 * only way they learn a protection threshold on the pack beside them changed.
 */
describe('telling the technician', () => {
  it('records the change in the activity timeline', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    const entry = useActivityStore.getState().entries[0]!;
    expect(entry.parameterKey).toBe('cell_ovp');
    expect(entry.actor).toBe('Administrator');
  });

  it('marks it as a remote change, not a local one', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(useActivityStore.getState().entries[0]!.source).toBe('admin_remote');
  });

  it('distinguishes a Force Push', async () => {
    claim.mockResolvedValue([command({ forcePush: true })]);
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(useActivityStore.getState().entries[0]!.source).toBe('admin_force_push');
  });

  /** This is what makes the passive banner appear. */
  it('raises the banner, which is the only notice they get', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    const state = useActivityStore.getState();
    expect(state.unseenAdminEntryId).toBe(state.entries[0]!.id);
  });

  it('records a refused remote change too', async () => {
    claim.mockResolvedValue([command()]);
    write.mockResolvedValue({ outcome: 'rejected', confirmedValue: null, message: 'no' });

    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(useActivityStore.getState().entries[0]!.result).toBe('rejected');
  });

  it('carries the support session it came from', async () => {
    claim.mockResolvedValue([command({ supportSessionId: 's9' })]);
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(useActivityStore.getState().entries[0]!.supportSessionId).toBe('s9');
  });
});

/**
 * The same rule a local write follows: only a confirmed read-back may change
 * what the app claims is on the BMS.
 */
describe('what the app claims is on the pack', () => {
  it('updates it on a confirmed write', async () => {
    claim.mockResolvedValue([command()]);
    await useRemoteChangeStore.getState().poll('BAT-00042');

    const parameter = useProfileStore.getState().parameterFor('cell_ovp')!;
    expect(useSettingsStore.getState().currentValue(parameter)).toBe(3.78);
  });

  it('leaves it alone when the write was not confirmed', async () => {
    const parameter = useProfileStore.getState().parameterFor('cell_ovp')!;
    const before = useSettingsStore.getState().currentValue(parameter);

    claim.mockResolvedValue([command({ value: 3.79 })]);
    write.mockResolvedValue({ outcome: 'indeterminate', confirmedValue: null, message: null });
    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(useSettingsStore.getState().currentValue(parameter)).toBe(before);
  });
});

describe('the poller', () => {
  it('checks immediately rather than waiting a full interval', async () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    await Promise.resolve();
    expect(claim).toHaveBeenCalled();
  });

  it('does not start twice for the same link', () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    const first = useRemoteChangeStore.getState().timer;
    useRemoteChangeStore.getState().start('BAT-00042');
    expect(useRemoteChangeStore.getState().timer).toBe(first);
  });

  /** The server hands nothing over without a live session. */
  it('stops when the link closes', () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    useRemoteChangeStore.getState().stop();
    expect(useRemoteChangeStore.getState().timer).toBeNull();
  });

  it('can be started again after stopping', async () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    useRemoteChangeStore.getState().stop();
    useRemoteChangeStore.getState().start('BAT-00042');
    expect(useRemoteChangeStore.getState().timer).not.toBeNull();
  });
});

/**
 * The precondition the whole of Mode 1 rests on.
 *
 * The server hands a queued command only to a caller whose live BLE session it
 * holds, and it takes that from its own records rather than from anything the
 * caller asserts. An app that never registers its session can never collect
 * anything — which is exactly what was happening: the claim was implemented,
 * wired and tested, and returned nothing forever because nobody had told the
 * cloud the technician was there.
 */
describe('telling the cloud a technician is here', () => {
  let announce: jest.SpyInstance;
  let end: jest.SpyInstance;

  beforeEach(() => {
    announce = jest
      .spyOn(presence, 'announcePresence')
      .mockResolvedValue({ sessionId: 's1', batteryId: 'BAT-00042' });
    end = jest.spyOn(presence, 'endPresence').mockResolvedValue();
  });

  it('announces presence on every pass', async () => {
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(announce).toHaveBeenCalledWith(expect.anything(), 'BAT-00042');
  });

  /**
   * Order matters. Claiming before announcing means the first pass of every
   * link comes back empty, because the server does not yet believe anyone is
   * at the pack.
   */
  it('announces before it claims', async () => {
    const order: string[] = [];
    announce.mockImplementation(async () => {
      order.push('announce');
      return { sessionId: 's1', batteryId: 'BAT-00042' };
    });
    claim.mockImplementation(async () => {
      order.push('claim');
      return [];
    });

    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(order).toEqual(['announce', 'claim']);
  });

  it('keeps announcing so the session never goes stale', async () => {
    await useRemoteChangeStore.getState().poll('BAT-00042');
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('records whether the cloud believes it', async () => {
    await useRemoteChangeStore.getState().poll('BAT-00042');
    expect(useRemoteChangeStore.getState().present).toBe(true);
  });

  /** A failed announce is not fatal: the technician can still work locally. */
  it('carries on when the announce fails', async () => {
    announce.mockResolvedValue(null);
    claim.mockResolvedValue([]);

    await useRemoteChangeStore.getState().poll('BAT-00042');

    expect(useRemoteChangeStore.getState().present).toBe(false);
    expect(claim).toHaveBeenCalled();
  });

  /**
   * Ended deliberately rather than left to age out. Thirty seconds in which an
   * administrator believes somebody is at a pack they have walked away from is
   * thirty seconds in which a change is issued as deliverable and then waits.
   */
  it('ends the session when the link closes', () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    useRemoteChangeStore.getState().stop();
    expect(end).toHaveBeenCalledWith(expect.anything(), 'BAT-00042');
  });

  it('does not try to end one it never opened', () => {
    useRemoteChangeStore.getState().stop();
    expect(end).not.toHaveBeenCalled();
  });

  it('forgets the pack once stopped, so a later stop is a no-op', () => {
    useRemoteChangeStore.getState().start('BAT-00042');
    useRemoteChangeStore.getState().stop();
    end.mockClear();

    useRemoteChangeStore.getState().stop();
    expect(end).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { render } from '@testing-library/react-native';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

import Dashboard from '../app/(tabs)/index';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useActivityStore } from '../src/store/useActivityStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { useSupportStore } from '../src/store/useSupportStore';
import * as supportSessions from '../src/api/supportSessions';
import type { BatterySnapshot } from '../src/telemetry/types';

const wrap = () => render(<ThemeProvider><Dashboard /></ThemeProvider>);

/*
 * A fixed clock, because this screen hides its readings once they go stale.
 *
 * Telemetry counts as stale after three seconds, and these fixtures stamp
 * themselves with the current time. That is fine until the machine is loaded
 * enough that three seconds pass between building the fixture and the render
 * reading it — at which point the charge state correctly renders "Unknown"
 * and a test asserting "Idle" fails for a reason that has nothing to do with
 * what it is testing. It happened once in four runs of the full gate.
 *
 * The staleness tests below still work: they set timestamps at explicit
 * offsets from now, and an offset from a frozen now is exactly as stale.
 */
const FROZEN_NOW = 1_760_000_000_000;

const snapshot = (over: Partial<BatterySnapshot> = {}): BatterySnapshot => {
  const cells = Array.from({ length: 24 }, () => 3.3);
  return {
    timestamp: Date.now(),
    soc: 72,
    packVoltage: 79.2,
    packCurrent: 168,
    temperatures: [24, 22.6],
    cellVoltages: cells,
    cellCount: 24,
    minCellV: 3.29,
    maxCellV: 3.33,
    deltaMv: 40,
    chargeMos: true,
    dischargeMos: true,
    balancing: false,
    balancingCells: [],
    faults: [],
    cycles: 142,
    soh: 96,
    bmsModel: 'JBD SP24S004',
    bmsFirmware: 'FW 1.2.4',
    bleState: 'connected',
    location: null,
    ...over,
  };
};

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
  mockPush.mockClear();
  useTelemetryStore.setState({ snapshot: snapshot(), history: [] });
  useActivityStore.setState({ entries: [], unseenAdminEntryId: null });
});

afterEach(() => {
  jest.spyOn(Date, 'now').mockRestore();
});

describe('primary instrumentation', () => {
  it('shows all three live readings as numbers', async () => {
    const q = await wrap();
    expect(q.getAllByText('72').length).toBeGreaterThan(0); // SOC
    expect(q.getByText('+168')).toBeTruthy(); // pack current
    expect(q.getByText('79.2')).toBeTruthy(); // pack voltage
  });

  it('labels the three instruments', async () => {
    const q = await wrap();
    expect(q.getByText('SOC')).toBeTruthy();
    expect(q.getByText('Pack Current')).toBeTruthy();
    expect(q.getByText('Pack Voltage')).toBeTruthy();
  });

  it('reads charge direction from the sign of the current', async () => {
    const q = await wrap();
    // "Charging" is the fact's label as well as its value, so charging shows it
    // twice while any other state shows it once.
    expect(q.getAllByText('Charging')).toHaveLength(2);
    expect(q.queryByText('Discharging')).toBeNull();
  });

  it('reads discharge from a negative current', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ packCurrent: -142 }) });
    const q = await wrap();
    expect(q.getByText('Discharging')).toBeTruthy();
    expect(q.getAllByText('Charging')).toHaveLength(1); // the label only
  });

  it('reads idle from a near-zero current', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ packCurrent: 0.4 }) });
    const q = await wrap();
    // Charge state and the balancing row both read "Idle" here.
    expect(q.getAllByText('Idle')).toHaveLength(2);
    // Named explicitly: when this count was wrong it was because the reading
    // had gone stale and the charge state said "Unknown", which "expected 2,
    // got 1" does not tell you.
    expect(q.queryByText('Unknown')).toBeNull();
    expect(q.queryByText('Discharging')).toBeNull();
  });
});

/**
 * PRD §7.16 reserves a Location section that stays visible, and disabled, until
 * GPS-capable hardware exists. It is easy to delete as "unused" — this stops that.
 */
describe('reserved location section', () => {
  it('always shows the placeholder', async () => {
    const q = await wrap();
    expect(q.getByText('Location unavailable — requires GPS-enabled hardware.')).toBeTruthy();
  });

  it('shows it even though the snapshot carries no location', async () => {
    expect(useTelemetryStore.getState().snapshot?.location).toBeNull();
    const q = await wrap();
    expect(q.getByText('Location')).toBeTruthy();
  });
});

describe('protection summary', () => {
  it('says so plainly when there are no faults', async () => {
    const q = await wrap();
    expect(q.getByText('No active faults')).toBeTruthy();
  });

  it('counts critical faults', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({
        faults: [{ code: 'CELL_OVP', label: 'Cell over-voltage', level: 'Critical' }],
      }),
    });
    const q = await wrap();
    expect(q.getByText('1 active fault')).toBeTruthy();
  });

  it('pluralises more than one', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({
        faults: [
          { code: 'A', label: 'One', level: 'Critical' },
          { code: 'B', label: 'Two', level: 'Critical' },
        ],
      }),
    });
    const q = await wrap();
    expect(q.getByText('2 active faults')).toBeTruthy();
  });

  it('distinguishes a warning from a critical fault', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({
        faults: [{ code: 'PACK_HTP', label: 'Pack temperature high', level: 'Warning' }],
      }),
    });
    const q = await wrap();
    expect(q.getByText('1 warning')).toBeTruthy();
  });
});

/**
 * PRD §6.3 step 8: an admin remote write never prompts the user, so this banner
 * is the only thing telling someone stood next to a live pack that it changed.
 */
describe('passive change banner', () => {
  it('is absent when nothing has changed remotely', async () => {
    const q = await wrap();
    expect(q.queryByText(/nothing for you to approve/)).toBeNull();
  });

  it('appears for an unseen admin write, naming the actor and value', async () => {
    useActivityStore.setState({
      entries: [
        {
          id: 'a1',
          timestamp: Date.now(),
          parameterKey: 'balance_start_v',
          displayName: 'Balance turn-on voltage',
          oldValue: '3.400 V',
          newValue: '3.420 V',
          actor: 'R. Mehta (Admin)',
          source: 'admin_remote',
          dangerLevel: 'Normal',
          result: 'success',
          supportSessionId: 'SS-4471',
        },
      ],
      unseenAdminEntryId: 'a1',
    });
    const q = await wrap();
    expect(q.getByText(/Balance turn-on voltage changed to 3.420 V/)).toBeTruthy();
    expect(q.getByText(/R. Mehta \(Admin\)/)).toBeTruthy();
    expect(q.getByText(/nothing for you to approve/)).toBeTruthy();
  });

  it('offers no dismiss control — it must never require an action', async () => {
    useActivityStore.setState({
      entries: [
        {
          id: 'a1',
          timestamp: Date.now(),
          parameterKey: 'cell_ovp',
          displayName: 'Cell over-voltage',
          oldValue: '3.750 V',
          newValue: '3.800 V',
          actor: 'R. Mehta (Admin)',
          source: 'admin_force_push',
          dangerLevel: 'Critical',
          result: 'success',
        },
      ],
      unseenAdminEntryId: 'a1',
    });
    const q = await wrap();
    const labels = q.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));
    expect(labels.some((l) => /dismiss|close|ok|got it/i.test(l))).toBe(false);
  });
});

/**
 * PRD safety: a reading that has stopped updating must never look current.
 * The mock emits every 500 ms, so this could not be caught on the web target —
 * only by moving the snapshot's timestamp into the past.
 */
describe('stale telemetry', () => {
  it('says nothing when the data is live', async () => {
    const q = await wrap();
    expect(q.queryByText(/No live data/)).toBeNull();
  });

  it('warns as soon as the link has been quiet too long', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ timestamp: Date.now() - 12_000 }) });
    const q = await wrap();
    expect(q.getByText(/No live data — last reading 12 s ago/)).toBeTruthy();
  });

  it('tells the user the readings are frozen, not merely late', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ timestamp: Date.now() - 20_000 }) });
    const q = await wrap();
    expect(q.getByText(/frozen at their last value/)).toBeTruthy();
  });

  it('stops claiming a charge state it can no longer observe', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({ packCurrent: 168, timestamp: Date.now() - 30_000 }),
    });
    const q = await wrap();
    expect(q.getByText('Unknown')).toBeTruthy();
    expect(q.getAllByText('Charging')).toHaveLength(1); // the label only
  });

  it('marks every instrument as not live for screen readers', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ timestamp: Date.now() - 10_000 }) });
    const q = await wrap();
    expect(q.getByLabelText(/SOC: 72 %, not live/)).toBeTruthy();
    expect(q.getByLabelText(/Pack Current: .*, not live/)).toBeTruthy();
    expect(q.getByLabelText(/Pack Voltage: .*, not live/)).toBeTruthy();
  });

  it('does not mark instruments when data is live', async () => {
    const q = await wrap();
    expect(q.queryByLabelText(/not live/)).toBeNull();
  });
});

describe('pack detail', () => {
  it('reports cell delta and the min/max pair', async () => {
    const q = await wrap();
    expect(q.getByText('40 mV')).toBeTruthy();
    expect(q.getByText('3.290 / 3.330 V')).toBeTruthy();
  });

  it('reports temperature in both scales', async () => {
    const q = await wrap();
    expect(q.getByText('24°C')).toBeTruthy();
    expect(q.getByText('75°F')).toBeTruthy();
  });
});

/**
 * Three rows on the busiest screen in the app were literals: an invented
 * gateway serial, a hardcoded write count, and `SS-4471 active` — asserting a
 * live support session that corresponded to nothing.
 *
 * The store behind them is tested separately; this is the wiring, which is
 * what was actually broken and what a mutation of the row would otherwise pass.
 */
describe('the navigation rows show real state', () => {
  // The screen refreshes support state on mount, so seeding the store is not
  // enough — the fetch behind it decides what the row ends up showing.
  const openSession = {
    id: 's1',
    battery_id: 'BAT-00042',
    admin_user_id: 'u1',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    useSessionStore.setState({ connectedBatteryId: 'BAT-00042' });
    useSupportStore.getState().reset();
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);
  });

  it('invents no gateway serial', async () => {
    const q = await wrap();
    expect(q.queryByText('KYE-000184')).toBeNull();
  });

  it('names the pack actually linked', async () => {
    const q = await wrap();
    expect(q.getByText('BAT-00042')).toBeTruthy();
  });

  it('says so when nothing is linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    const q = await wrap();
    expect(q.getByText('Not connected')).toBeTruthy();
  });

  it('counts the changes that actually happened', async () => {
    useActivityStore.setState({
      entries: [
        { id: 'e1', timestamp: 1, parameterKey: 'k', displayName: 'K', oldValue: 'a',
          newValue: 'b', actor: 'You', source: 'local', dangerLevel: 'Normal', result: 'success' },
        { id: 'e2', timestamp: 2, parameterKey: 'k2', displayName: 'K2', oldValue: 'a',
          newValue: 'b', actor: 'You', source: 'local', dangerLevel: 'Normal', result: 'success' },
      ],
    });
    const q = await wrap();
    expect(q.getByText('2 changes')).toBeTruthy();
  });

  it('uses the singular for one', async () => {
    useActivityStore.setState({
      entries: [
        { id: 'e1', timestamp: 1, parameterKey: 'k', displayName: 'K', oldValue: 'a',
          newValue: 'b', actor: 'You', source: 'local', dangerLevel: 'Normal', result: 'success' },
      ],
    });
    const q = await wrap();
    expect(q.getByText('1 change')).toBeTruthy();
  });

  /** The row this section exists for. */
  it('does not claim a support session is open when none is', async () => {
    const q = await wrap();
    expect(q.queryByText(/SS-4471/)).toBeNull();
    expect(await q.findByText('None')).toBeTruthy();
  });

  it('says one is open when one is', async () => {
    jest
      .spyOn(supportSessions, 'listSupportSessions')
      .mockResolvedValue([supportSessions.fromRow(openSession)]);

    const q = await wrap();
    expect(await q.findByText('Session open')).toBeTruthy();
  });

  it('says it could not check, rather than none', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue(null);

    const q = await wrap();
    expect(await q.findByText('Could not check')).toBeTruthy();
    expect(q.queryByText('None')).toBeNull();
  });
});

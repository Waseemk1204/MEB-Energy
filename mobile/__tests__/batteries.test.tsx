import React from 'react';
import { render } from '@testing-library/react-native';

const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

import Batteries from '../app/batteries';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useFleetStore, type FleetBattery } from '../src/store/useFleetStore';

const wrap = () => render(<ThemeProvider><Batteries /></ThemeProvider>);
type Queries = Awaited<ReturnType<typeof wrap>>;

const rowLabels = (q: Queries) =>
  q.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));

const rowFor = (q: Queries, id: string) =>
  q.getAllByRole('button').find((b) => String(b.props.accessibilityLabel ?? '').startsWith(id))!;

const HOUR = 60 * 60 * 1000;

const battery = (over: Partial<FleetBattery> = {}): FleetBattery => ({
  id: 'BAT-00042',
  serial: 'BAT-00042',
  chemistry: 'LiFePO4',
  cellCount: 24,
  bmsModel: 'JBD SP24S004',
  lastReading: null,
  ...over,
});

/** A fleet the server has reported, with readings of varying age. */
const FLEET: FleetBattery[] = [
  battery({
    lastReading: { soc: 72, packVoltage: 79.2, faultCount: 0, recordedAt: Date.now() - 60_000 },
  }),
  battery({
    id: 'BAT-00043',
    serial: 'BAT-00043',
    lastReading: {
      soc: 41,
      packVoltage: 76.1,
      faultCount: 0,
      recordedAt: Date.now() - 5 * HOUR,
    },
  }),
  battery({
    id: 'BAT-00051',
    serial: 'BAT-00051',
    cellCount: 16,
    lastReading: {
      soc: 88,
      packVoltage: 53.4,
      faultCount: 0,
      recordedAt: Date.now() - 3 * 24 * HOUR,
    },
  }),
  battery({ id: 'BAT-00028', serial: 'BAT-00028', chemistry: 'NMC', cellCount: 20 }),
];

beforeEach(() => {
  mockReplace.mockClear();
  useFleetStore.setState({
    batteries: FLEET,
    hydrated: true,
    loading: false,
    stale: false,
    error: null,
    fetchedAt: Date.now(),
    // The screen calls these on mount; neither should touch the network here.
    hydrate: async () => undefined,
    refresh: async () => undefined,
  });
  useSessionStore.setState({
    hydrated: true,
    authenticated: true,
    company: 'Aurora Fleet',
    connectedBatteryId: null,
    connectingBatteryId: null,
    stage: 'idle',
  });
  useTelemetryStore.setState({ snapshot: null });
});

describe('the fleet list', () => {
  it('lists every battery with its chemistry and cell count', async () => {
    const q = await wrap();
    expect(q.getByText('BAT-00042')).toBeTruthy();
    expect(q.getByText('BAT-00028')).toBeTruthy();
    // BAT-00042 and BAT-00043 are both 24S LiFePO4.
    expect(q.getAllByText('24S LiFePO4')).toHaveLength(2);
    expect(q.getByText('16S LiFePO4')).toBeTruthy();
    expect(q.getByText('20S NMC')).toBeTruthy();
  });

  it('shows the company and how many batteries', async () => {
    const q = await wrap();
    expect(q.getByText('Aurora Fleet · 4 batteries')).toBeTruthy();
  });

  it('says one battery in the singular', async () => {
    useFleetStore.setState({ batteries: [FLEET[0]] });
    const q = await wrap();
    expect(q.getByText('Aurora Fleet · 1 battery')).toBeTruthy();
  });

  it('prints the state of charge as a number beside its dial', async () => {
    const q = await wrap();
    expect(q.getByText('41%')).toBeTruthy();
    expect(q.getByText('88%')).toBeTruthy();
  });

  it('announces each row with its reading and how old that reading is', async () => {
    const q = await wrap();
    expect(rowLabels(q)).toContain('BAT-00043, 41 percent, 5h ago');
  });

  it('explains why the list is scoped the way it is', async () => {
    const q = await wrap();
    expect(q.getByText(/registered to your company/)).toBeTruthy();
  });
});

/**
 * A state of charge with no age beside it reads as current. The most
 * dangerous row on this screen is a pack last heard from weeks ago showing a
 * confident number, because a technician can act on it.
 */
describe('how old each reading is', () => {
  it('never shows a reading without saying when it was taken', async () => {
    const q = await wrap();
    for (const label of rowLabels(q)) {
      expect(label).toMatch(/never reported|ago|live|percent, Reported recently/i);
    }
  });

  it('shows a dash, not a number, for a pack that has never reported', async () => {
    useFleetStore.setState({ batteries: [FLEET[3]] });
    const q = await wrap();
    expect(q.getByText('—')).toBeTruthy();
    expect(q.getByText('Never reported')).toBeTruthy();
  });

  it('says how many hours old a same-day reading is', async () => {
    const q = await wrap();
    expect(q.getByText('5h ago')).toBeTruthy();
  });

  it('says how many days old an older one is', async () => {
    const q = await wrap();
    expect(q.getByText('3d ago')).toBeTruthy();
  });

  it('calls a recent reading recent, not live', async () => {
    const q = await wrap();
    // Only the pack this phone is linked to may read as live.
    expect(q.queryByText('Linked · live')).toBeNull();
    expect(q.getByText('Reported recently')).toBeTruthy();
  });

  it('reads live only for the pack this phone is linked to', async () => {
    useSessionStore.setState({ connectedBatteryId: 'BAT-00042', stage: 'connected' });
    useTelemetryStore.setState({ snapshot: { soc: 64 } as never });
    const q = await wrap();
    expect(q.getByText('Linked · live')).toBeTruthy();
    expect(rowLabels(q)).toContain('BAT-00042, 64 percent, live');
  });
});

describe('when the fleet could not be loaded', () => {
  it('invents no batteries', async () => {
    useFleetStore.setState({ batteries: [], error: 'Network request failed', stale: false });
    const q = await wrap();
    expect(q.queryByText('BAT-00042')).toBeNull();
    expect(q.getByText(/Could not load your batteries/)).toBeTruthy();
  });

  it('distinguishes an empty fleet from a failed load', async () => {
    useFleetStore.setState({ batteries: [], error: null, stale: false });
    const q = await wrap();
    expect(q.getByText(/No batteries are registered/)).toBeTruthy();
  });

  it('says plainly when the list on screen is not confirmed', async () => {
    useFleetStore.setState({ stale: true });
    const q = await wrap();
    expect(q.getByText(/not confirmed with the server/)).toBeTruthy();
  });

  it('does not claim staleness for a freshly loaded list', async () => {
    const q = await wrap();
    expect(q.queryByText(/not confirmed with the server/)).toBeNull();
  });
});

describe('connection state', () => {
  /**
   * There is no "in range" or "offline" here. Reachability is a BLE fact this
   * phone learns only by scanning, and the server cannot know it — so every
   * registered pack is selectable and the connect sequence reports the truth.
   */
  it('lets any registered battery be selected', async () => {
    const q = await wrap();
    for (const id of ['BAT-00042', 'BAT-00043', 'BAT-00051', 'BAT-00028']) {
      expect(rowFor(q, id).props.accessibilityState).toMatchObject({ disabled: false });
    }
  });

  it('marks the linked battery', async () => {
    useSessionStore.setState({ connectedBatteryId: 'BAT-00042', stage: 'connected' });
    const q = await wrap();
    expect(q.getByText(/^Linked/)).toBeTruthy();
  });
});

/**
 * PRD §7.4: Connect gateway → Authenticate Device → Detect BMS.
 * The steps are shown so a failure names the stage it failed at.
 */
describe('the connect sequence', () => {
  it('is hidden before a battery is selected', async () => {
    const q = await wrap();
    expect(q.queryByText('Authenticate device')).toBeNull();
  });

  it('shows all three stages on the battery being linked', async () => {
    useSessionStore.setState({ connectingBatteryId: 'BAT-00051', stage: 'authenticating' });
    const q = await wrap();
    expect(q.getByText('Connect gateway')).toBeTruthy();
    expect(q.getByText('Authenticate device')).toBeTruthy();
    expect(q.getByText('Detect BMS')).toBeTruthy();
  });

  it('shows the sequence only on the selected battery', async () => {
    useSessionStore.setState({ connectingBatteryId: 'BAT-00051', stage: 'connecting' });
    const q = await wrap();
    expect(q.getAllByText('Detect BMS')).toHaveLength(1);
  });

  it('locks the other rows while a link is being established', async () => {
    useSessionStore.setState({ connectingBatteryId: 'BAT-00051', stage: 'connecting' });
    const q = await wrap();
    expect(rowFor(q, 'BAT-00043').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

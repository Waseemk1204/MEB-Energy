import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

import Protection from '../app/protection';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import type { BatterySnapshot } from '../src/telemetry/types';

const wrap = () => render(<ThemeProvider><Protection /></ThemeProvider>);

const snapshot = (over: Partial<BatterySnapshot> = {}): BatterySnapshot => ({
  timestamp: Date.now(),
  soc: 72,
  packVoltage: 79.2,
  packCurrent: 168,
  temperatures: [24, 22.6],
  cellVoltages: Array.from({ length: 24 }, () => 3.3),
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
});

beforeEach(() => useTelemetryStore.setState({ snapshot: snapshot() }));

describe('clean state', () => {
  it('says so plainly rather than showing an empty list', async () => {
    const q = await wrap();
    expect(q.getByText('No active faults')).toBeTruthy();
    expect(q.getByText('All protection thresholds are within limits.')).toBeTruthy();
  });
});

/**
 * A fault must print the value that tripped it. "Cell over-voltage" alone tells
 * a technician nothing actionable; the cell and the reading do.
 */
describe('active faults', () => {
  const ovp = {
    code: 'CELL_OVP',
    label: 'Cell over-voltage',
    level: 'Critical' as const,
    detail: 'Cell 14 · 3.771 V vs 3.750 V limit',
  };

  it('names the fault and its severity', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ faults: [ovp] }) });
    const q = await wrap();
    expect(q.getByText('Cell over-voltage')).toBeTruthy();
    expect(q.getByText('Critical')).toBeTruthy();
  });

  it('prints the triggering value and the limit it crossed', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ faults: [ovp] }) });
    const q = await wrap();
    expect(q.getByText('Cell 14 · 3.771 V vs 3.750 V limit')).toBeTruthy();
  });

  it('replaces the clean-state card', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ faults: [ovp] }) });
    const q = await wrap();
    expect(q.queryByText('No active faults')).toBeNull();
  });

  it('separates a warning from a critical fault', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({
        faults: [
          ovp,
          {
            code: 'PACK_HTP',
            label: 'Pack temperature high',
            level: 'Warning',
            detail: '41 °C approaching the 65 °C charge limit',
          },
        ],
      }),
    });
    const q = await wrap();
    expect(q.getByText('Critical')).toBeTruthy();
    expect(q.getByText('Warning')).toBeTruthy();
    expect(q.getByText('Pack temperature high')).toBeTruthy();
  });
});

describe('MOS state', () => {
  it('shows both switches on', async () => {
    const q = await wrap();
    expect(q.getAllByText('ON')).toHaveLength(2);
  });

  it('shows a tripped discharge switch', async () => {
    useTelemetryStore.setState({ snapshot: snapshot({ dischargeMos: false }) });
    const q = await wrap();
    expect(q.getByText('OFF')).toBeTruthy();
    expect(q.getAllByText('ON')).toHaveLength(1);
  });

  it('labels which switch is which', async () => {
    const q = await wrap();
    expect(q.getByText('Charge MOS')).toBeTruthy();
    expect(q.getByText('Discharge MOS')).toBeTruthy();
  });
});

describe('balancing', () => {
  it('reports idle balancing with the cell delta', async () => {
    const q = await wrap();
    expect(q.getByText('Idle')).toBeTruthy();
    expect(q.getByText('40 mV')).toBeTruthy();
  });

  it('reports active balancing and how many cells', async () => {
    useTelemetryStore.setState({
      snapshot: snapshot({ balancing: true, balancingCells: [3, 7, 11] }),
    });
    const q = await wrap();
    expect(q.getByText('Active')).toBeTruthy();
    expect(q.getByText('3')).toBeTruthy();
  });
});

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

import History from '../app/(tabs)/history';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useTelemetryStore, type HistoryPoint } from '../src/store/useTelemetryStore';

const wrap = () => render(<ThemeProvider><History /></ThemeProvider>);

/** The chart's own readout, distinct from the summary rows that also end in a unit. */
const readout = (q: Awaited<ReturnType<typeof wrap>>) =>
  String(q.getByTestId('chart-readout').props.children);

const point = (over: Partial<HistoryPoint> = {}): HistoryPoint => ({
  t: Date.now(),
  soc: 72,
  packVoltage: 79.2,
  packCurrent: 140,
  temp: 24,
  ...over,
});

const series = (n: number, make: (i: number) => Partial<HistoryPoint>) =>
  Array.from({ length: n }, (_, i) => point(make(i)));

beforeEach(() => {
  useTelemetryStore.setState({
    history: series(30, (i) => ({ soc: 60 + i * 0.4, packCurrent: 120 + i, temp: 24 + i * 0.1 })),
  });
});

describe('metric selection', () => {
  it('offers every metric', async () => {
    const q = await wrap();
    for (const label of ['SOC', 'Voltage', 'Current', 'Temp']) {
      expect(q.getByText(label)).toBeTruthy();
    }
  });

  it('starts on SOC, at whole-percent precision', async () => {
    const q = await wrap();
    expect(readout(q)).toBe('72 %');
  });

  it('switches the readout unit and precision when another metric is chosen', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByText('Voltage'));
    expect(readout(q)).toBe('79.2 V');
  });

  it('switches to current', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByText('Current'));
    expect(readout(q)).toBe('149 A');
  });
});

describe('range chips', () => {
  it('offers the buffered ranges', async () => {
    const q = await wrap();
    for (const label of ['30s', '1m', '2m']) {
      expect(q.getByText(label)).toBeTruthy();
    }
  });

  it('is honest that longer trends come from the cloud, not the device', async () => {
    const q = await wrap();
    expect(q.getByText(/Longer trends come from the cloud telemetry history service/)).toBeTruthy();
  });
});

/**
 * A chart obeys the same rule as a gauge: no value without a number. The
 * readout is what makes the trace safe to act on.
 */
describe('numeric readout', () => {
  it('prints the latest value with its unit', async () => {
    const q = await wrap();
    expect(readout(q)).toBe('72 %');
  });

  it('shows an em dash rather than a blank when there is no data', async () => {
    useTelemetryStore.setState({ history: [] });
    const q = await wrap();
    expect(readout(q)).toBe('— %');
  });
});

/**
 * With a buffer holding only charge current there is no discharge peak.
 * Reporting Math.min regardless would label a charge current as a discharge peak.
 */
describe('session summary', () => {
  it('reports both peaks when the pack has done both', async () => {
    useTelemetryStore.setState({
      history: [...series(5, () => ({ packCurrent: 186 })), ...series(5, () => ({ packCurrent: -214 }))],
    });
    const q = await wrap();
    expect(q.getByText('+186 A')).toBeTruthy();
    expect(q.getByText('-214 A')).toBeTruthy();
  });

  it('says "none yet" for a discharge peak that has not happened', async () => {
    useTelemetryStore.setState({ history: series(5, () => ({ packCurrent: 150 })) });
    const q = await wrap();
    expect(q.getByText('+150 A')).toBeTruthy();
    expect(q.getByText('none yet')).toBeTruthy();
  });

  it('says "none yet" for a charge peak that has not happened', async () => {
    useTelemetryStore.setState({ history: series(5, () => ({ packCurrent: -150 })) });
    const q = await wrap();
    expect(q.getByText('-150 A')).toBeTruthy();
    expect(q.getByText('none yet')).toBeTruthy();
  });

  it('reports the maximum temperature and how many samples are held', async () => {
    const q = await wrap();
    expect(q.getByText('26.9 °C')).toBeTruthy();
    expect(q.getByText('30')).toBeTruthy();
  });

  it('handles an empty buffer without crashing', async () => {
    useTelemetryStore.setState({ history: [] });
    const q = await wrap();
    expect(q.getByText('Samples held')).toBeTruthy();
    expect(q.getByText('0')).toBeTruthy();
  });
});

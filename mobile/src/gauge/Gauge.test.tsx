import React from 'react';
import { render } from '@testing-library/react-native';
import { Gauge, type GaugeProps } from './Gauge';
import { ThemeProvider } from '../theme/ThemeProvider';

/** RNTL v14's render is async — it resolves to the query object. */
const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

/**
 * Tick labels are drawn as SVG text, not React Native <Text>, so getByText
 * cannot see them. Walk the rendered tree and collect them directly.
 */
function tickLabels(tree: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: unknown;
      props?: { content?: unknown };
      children?: unknown;
    };
    // react-native-svg carries the string on the tspan's `content` prop rather
    // than as a child node, so neither getByText nor a children walk finds it.
    if (n.type === 'RNSVGTSpan' && typeof n.props?.content === 'string') {
      found.push(n.props.content);
    }
    visit(n.children);
  };
  visit(tree);
  return found;
}

const hero = (over: Partial<GaugeProps> = {}) => (
  <Gauge
    variant="hero"
    value={72}
    min={0}
    max={100}
    major={10}
    minor={2}
    label="SOC"
    unit="%"
    size={262}
    {...over}
  />
);

const metric = (over: Partial<GaugeProps> = {}) => (
  <Gauge
    variant="metric"
    value={168}
    min={-400}
    max={400}
    major={100}
    label="Pack Current"
    unit="A"
    size={150}
    bipolar
    {...over}
  />
);

/**
 * PRD §7.17: a needle position is an approximation by nature, so every gauge
 * must carry a precise numeric readout. These tests are that rule's enforcement
 * — it is meant to be impossible to remove by accident.
 */
describe('the numeric readout is not optional', () => {
  it('renders the value on the hero variant', async () => {
    const { getByText } = await wrap(hero());
    expect(getByText('72')).toBeTruthy();
    expect(getByText('%')).toBeTruthy();
    expect(getByText('SOC')).toBeTruthy();
  });

  it('renders the value on the metric variant', async () => {
    const { getByText } = await wrap(metric());
    expect(getByText('168')).toBeTruthy();
    expect(getByText('A')).toBeTruthy();
    expect(getByText('Pack Current')).toBeTruthy();
  });

  it('exposes no prop that could hide the readout', () => {
    // A `showValue`-style escape hatch is exactly what this rule exists to stop.
    const forbidden = ['showValue', 'hideValue', 'gaugeOnly', 'needleOnly', 'showReadout'];
    const passed = Object.keys(hero().props);
    for (const key of forbidden) expect(passed).not.toContain(key);
  });

  it('shows a number at the bottom of the scale', async () => {
    const { getByText } = await wrap(hero({ value: 0 }));
    expect(getByText('0')).toBeTruthy();
  });

  it('shows a number at the top of the scale', async () => {
    const { getByText } = await wrap(hero({ value: 100 }));
    expect(getByText('100')).toBeTruthy();
  });

  it('shows a number for an out-of-range reading rather than blanking', async () => {
    const { getByText } = await wrap(metric({ value: 999 }));
    expect(getByText('999')).toBeTruthy();
  });

  it('puts the reading in the accessibility label, not just on screen', async () => {
    const { getByLabelText } = await wrap(metric({ value: -140 }));
    expect(getByLabelText('Pack Current: -140 A')).toBeTruthy();
  });
});

describe('formatting', () => {
  it('applies the caller format to the readout', async () => {
    const { getByText } = await wrap(
      metric({
        value: 81.42,
        min: 62,
        max: 90,
        major: 4,
        bipolar: false,
        unit: 'V',
        label: 'Pack Voltage',
        format: (v) => v.toFixed(1),
      })
    );
    expect(getByText('81.4')).toBeTruthy();
  });

  it('signs a bipolar current reading', async () => {
    const { getByText } = await wrap(
      metric({ value: 168, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}` })
    );
    expect(getByText('+168')).toBeTruthy();
  });

  it('labels bipolar ticks with their sign', async () => {
    const r = await wrap(
      metric({ formatTick: (v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`) })
    );
    const labels = tickLabels(r.toJSON());
    expect(labels).toContain('+300');
    expect(labels).toContain('-300');
    expect(labels).toContain('0');
  });
});

describe('tick ladder', () => {
  it('labels every major tick on the hero sweep', async () => {
    const r = await wrap(hero());
    const labels = tickLabels(r.toJSON());
    for (const v of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      expect(labels).toContain(String(v));
    }
  });

  it('lands the last tick on the axis maximum', async () => {
    const r = await wrap(
      metric({ min: 62, max: 90, major: 4, bipolar: false, unit: 'V', label: 'Pack Voltage' })
    );
    const labels = tickLabels(r.toJSON());
    expect(labels).toContain('62');
    expect(labels).toContain('90');
  });
});

describe('strip variant', () => {
  /** Used in list rows, where the parent prints the number beside it. */
  it('renders an arc with no tick ladder', async () => {
    const { getByLabelText, queryByText } = await wrap(
      <Gauge
        variant="strip"
        value={72}
        min={0}
        max={100}
        major={25}
        label="BAT-00042 state of charge"
        unit="%"
        size={44}
      />
    );
    expect(getByLabelText('BAT-00042 state of charge')).toBeTruthy();
    expect(queryByText('25')).toBeNull();
  });
});

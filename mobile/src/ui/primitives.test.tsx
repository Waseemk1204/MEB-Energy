import React from 'react';
import { render } from '@testing-library/react-native';
import { DangerDot, DataRow, FactStrip, FixedTag, RowGroup, StatusChip } from './primitives';
import { ThemeProvider } from '../theme/ThemeProvider';
import { palette } from '../theme/tokens';

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

/** Flatten RN style props, which may be arrays or nested arrays. */
function flatten(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (s: unknown): void => {
    if (Array.isArray(s)) return s.forEach(visit);
    if (s && typeof s === 'object') Object.assign(out, s);
  };
  visit(style);
  return out;
}

describe('DataRow', () => {
  it('shows label and value', async () => {
    const { getByText } = await wrap(<DataRow label="Cell over-voltage" value="3.750 V" />);
    expect(getByText('Cell over-voltage')).toBeTruthy();
    expect(getByText('3.750 V')).toBeTruthy();
  });

  it('is not a button when it has no action', async () => {
    const { queryByRole } = await wrap(<DataRow label="Firmware" value="FW 1.2.4" />);
    expect(queryByRole('button')).toBeNull();
  });

  it('becomes a button when it has an action, labelled with its value', async () => {
    const { getByRole } = await wrap(
      <DataRow label="Cell over-voltage" value="3.750 V" onPress={() => {}} />
    );
    expect(getByRole('button')).toBeTruthy();
  });

  it('announces label and value together for screen readers', async () => {
    const { getByLabelText } = await wrap(
      <DataRow label="Cell over-voltage" value="3.750 V" onPress={() => {}} />
    );
    expect(getByLabelText('Cell over-voltage, 3.750 V')).toBeTruthy();
  });
});

/**
 * A read-only parameter must read as a stated fact, not a broken control —
 * so it carries a reason tag and, critically, is not pressable.
 */
describe('read-only rows', () => {
  it('renders the fixed tag', async () => {
    const { getByText } = await wrap(<FixedTag />);
    expect(getByText('SKU-fixed')).toBeTruthy();
  });

  it('a dimmed row with no action cannot be pressed', async () => {
    const { queryByRole } = await wrap(
      <DataRow label="Charge over-current" value="220 ± 5 A" dimmed trailing={<FixedTag />} />
    );
    expect(queryByRole('button')).toBeNull();
  });
});

describe('DangerDot', () => {
  const colorOf = (tree: unknown): unknown => {
    let found: unknown;
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== 'object') return;
      const node = n as { props?: { style?: unknown }; children?: unknown };
      const style = flatten(node.props?.style);
      if (style.borderRadius === 99 && style.backgroundColor) found ??= style.backgroundColor;
      visit(node.children);
    };
    visit(tree);
    return found;
  };

  it('paints critical red', async () => {
    const r = await wrap(<DangerDot level="Critical" />);
    expect(colorOf(r.toJSON())).toBe(palette.light.critical);
  });

  it('paints warning amber', async () => {
    const r = await wrap(<DangerDot level="Warning" />);
    expect(colorOf(r.toJSON())).toBe(palette.light.warn);
  });

  it('paints normal green', async () => {
    const r = await wrap(<DangerDot level="Normal" />);
    expect(colorOf(r.toJSON())).toBe(palette.light.good);
  });

  /**
   * good and warn are near-identical in luminance, so the colour alone cannot
   * carry severity. The label is the channel that works for everyone.
   */
  it.each(['Normal', 'Warning', 'Critical'] as const)(
    'announces %s severity rather than relying on the colour',
    async (level) => {
      const { getByLabelText } = await wrap(<DangerDot level={level} />);
      expect(getByLabelText(`${level} severity`)).toBeTruthy();
    }
  );
});

describe('severity in rows', () => {
  it('includes the level in the row announcement', async () => {
    const { getByLabelText } = await wrap(
      <DataRow label="Cell over-voltage" value="3.750 V" level="Critical" onPress={() => {}} />
    );
    expect(getByLabelText('Cell over-voltage, 3.750 V, Critical severity')).toBeTruthy();
  });

  it('omits severity when a row has none', async () => {
    const { getByLabelText } = await wrap(
      <DataRow label="Firmware" value="FW 1.2.4" onPress={() => {}} />
    );
    expect(getByLabelText('Firmware, FW 1.2.4')).toBeTruthy();
  });
});

describe('StatusChip', () => {
  it('renders its label', async () => {
    const { getByText } = await wrap(<StatusChip tone="good" label="Connected" />);
    expect(getByText('Connected')).toBeTruthy();
  });
});

describe('FactStrip', () => {
  it('renders every fact with its label, value and sub', async () => {
    const { getByText, getAllByText } = await wrap(
      <FactStrip
        facts={[
          { label: 'Battery health', value: '96%', sub: 'Good', tone: 'good' },
          { label: 'Temp', value: '24°C', sub: '75°F' },
          { label: 'Charging', value: 'Charging', sub: 'JBD SP24S004' },
        ]}
      />
    );
    for (const t of ['Battery health', '96%', 'Good', 'Temp', '24°C', '75°F', 'JBD SP24S004']) {
      expect(getByText(t)).toBeTruthy();
    }
    // "Charging" is legitimately both the label and the value of the third cell.
    expect(getAllByText('Charging')).toHaveLength(2);
  });
});

describe('RowGroup', () => {
  it('renders all its rows', async () => {
    const { getByText } = await wrap(
      <RowGroup>
        <DataRow label="One" value="1" />
        <DataRow label="Two" value="2" />
        <DataRow label="Three" value="3" />
      </RowGroup>
    );
    expect(getByText('One')).toBeTruthy();
    expect(getByText('Three')).toBeTruthy();
  });

  it('survives a conditional child that renders nothing', async () => {
    const show = false;
    const { getByText } = await wrap(
      <RowGroup>
        <DataRow label="One" value="1" />
        {show ? <DataRow label="Hidden" value="x" /> : null}
      </RowGroup>
    );
    expect(getByText('One')).toBeTruthy();
  });
});

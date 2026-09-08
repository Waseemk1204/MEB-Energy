import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, canGoBack: () => true }),
}));

import { ThemeProvider } from '../src/theme/ThemeProvider';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { StitchBorder } from '../src/ui/StitchBorder';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { StaleBanner } from '../src/ui/StaleBanner';
import { palette, stitch } from '../src/theme/tokens';
import type { Freshness } from '../src/telemetry/freshness';

/**
 * The chrome the whole app is built out of.
 *
 * These carry the design language's two load-bearing rules — leather never
 * scrolls, and the stitch is the only border — and until now none of them had
 * a test. A rule nothing checks is a convention, not a rule.
 */

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

/** Every style on a node, flattened, whether it was an array or not. */
const stylesOf = (node: { props?: { style?: unknown } }): Record<string, unknown> => {
  const flatten = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
  };
  return flatten(node?.props?.style);
};

type Rendered = Awaited<ReturnType<typeof render>>;

interface Node {
  type?: string;
  props?: { style?: unknown; pointerEvents?: string };
  children?: (Node | string)[] | null;
}

/**
 * Walk the rendered tree.
 *
 * `toJSON()` rather than the query API, because these are style facts — a
 * dashed border, an inset, a background — and there is no accessible name to
 * find them by. Adding a `testID` purely so a test could locate them would be
 * testing the marker rather than the thing; the stitch is identifiable
 * precisely because it is the only dashed border in the app.
 */
const walk = (node: Node | string | null | undefined, visit: (n: Node) => void): void => {
  if (!node || typeof node === 'string') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const nodesWhere = (q: Rendered, predicate: (s: Record<string, unknown>) => boolean): Node[] => {
  const found: Node[] = [];
  walk(q.toJSON() as Node, (n) => {
    if (predicate(stylesOf(n))) found.push(n);
  });
  return found;
};

const theStitch = (q: Rendered) => {
  const found = nodesWhere(q, (s) => s.borderStyle === 'dashed');
  expect(found.length).toBeGreaterThan(0);
  return stylesOf(found[0]!);
};

/** ScrollView renders as `RCTScrollView` in the host tree. */
const scrollersIn = (q: Rendered): Node[] => {
  const found: Node[] = [];
  walk(q.toJSON() as Node, (n) => {
    if (n.type === 'RCTScrollView') found.push(n);
  });
  return found;
};

const freshness = (over: Partial<Freshness> = {}): Freshness =>
  ({ stale: true, ageMs: 8000, ageLabel: '8 seconds', ...over }) as Freshness;

describe('the stitch', () => {
  it('is dashed, which is what makes it a stitch rather than a line', async () => {
    const q = await wrap(<StitchBorder color="#EFE0C4" radius={18} />);
    expect(theStitch(q).borderStyle).toBe('dashed');
  });

  it('is inset from the panel edge rather than sitting on it', async () => {
    const q = await wrap(<StitchBorder color="#EFE0C4" radius={18} />);
    expect(theStitch(q).margin).toBe(stitch.inset);
  });

  /**
   * A stitch that used the panel's own radius would bow outward at the
   * corners, because it sits inside the edge.
   */
  it('takes a radius derived from the panel, not the panel’s own', async () => {
    const q = await wrap(<StitchBorder color="#EFE0C4" radius={18} />);
    expect(theStitch(q).borderRadius).toBe(18 - stitch.inset);
  });

  it('never goes below a corner radius that still reads as a corner', async () => {
    const q = await wrap(<StitchBorder color="#EFE0C4" radius={0} />);
    expect(theStitch(q).borderRadius).toBeGreaterThanOrEqual(4);
  });

  /** It is decoration. Swallowing a tap meant for the panel would be a bug. */
  it('does not intercept touches', async () => {
    const q = await wrap(<StitchBorder color="#EFE0C4" radius={18} />);
    const node = nodesWhere(q, (s) => s.borderStyle === 'dashed')[0]!;
    expect(node.props?.pointerEvents).toBe('none');
  });
});

describe('the panel', () => {
  it('renders its children', async () => {
    await wrap(
      <LeatherPanel>
        <Text>Inside</Text>
      </LeatherPanel>
    );
    expect(screen.getByText('Inside')).toBeTruthy();
  });

  // One render per test: rendering repeatedly inside a single test, with
  // unmounts between, returns null on the third — so each tone gets its own.
  it.each(['hero', 'panel', 'alt'] as const)('draws a stitch on the %s tone', async (tone) => {
    const q = await wrap(
      <LeatherPanel tone={tone}>
        <Text>{tone}</Text>
      </LeatherPanel>
    );
    expect(nodesWhere(q, (st) => st.borderStyle === 'dashed').length).toBeGreaterThan(0);
  });

  /**
   * Leather is the material of live instrumentation; cream is data. Rendering
   * one as the other is the single mistake that breaks the language.
   */
  it('uses the leather stitch on leather', async () => {
    const q = await wrap(<LeatherPanel tone="hero" />);
    expect(theStitch(q).borderColor).toBe(palette.light.leatherStitch);
  });

  it('uses the panel stitch on cream', async () => {
    const q = await wrap(<LeatherPanel tone="panel" />);
    expect(theStitch(q).borderColor).toBe(palette.light.panelStitch);
  });

  it('gives the alternate tone its own ground, so grouped rows read as grouped', async () => {
    const q = await wrap(<LeatherPanel tone="alt" />);
    expect(
      nodesWhere(q, (s) => s.backgroundColor === palette.light.panelAlt).length
    ).toBeGreaterThan(0);
  });

  it('does not use that ground for an ordinary panel', async () => {
    const q = await wrap(<LeatherPanel tone="panel" />);
    expect(nodesWhere(q, (s) => s.backgroundColor === palette.light.panelAlt)).toHaveLength(0);
    expect(
      nodesWhere(q, (s) => s.backgroundColor === palette.light.panelBase).length
    ).toBeGreaterThan(0);
  });

  it('honours an explicit radius over the tone’s default', async () => {
    const q = await wrap(<LeatherPanel tone="panel" radius={0} />);
    // The stitch radius is derived from the panel's, so it moves with it.
    expect(theStitch(q).borderRadius).toBe(4);
  });
});

describe('the screen scaffold', () => {
  const scaffold = (over: Partial<React.ComponentProps<typeof ScreenScaffold>> = {}) =>
    wrap(
      <ScreenScaffold title="Protection" sub="Thresholds" {...over}>
        <Text>Body</Text>
      </ScreenScaffold>
    );

  beforeEach(() => mockBack.mockClear());

  it('shows its title, subtitle and children', async () => {
    await scaffold();
    expect(screen.getByText('Protection')).toBeTruthy();
    expect(screen.getByText('Thresholds')).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('offers a way back by default', async () => {
    await scaffold();
    expect(screen.getByLabelText('Back')).toBeTruthy();
  });

  it('goes back when it is used', async () => {
    const q = await scaffold();
    // fireEvent is async in RNTL v14; an unawaited press leaks into the next
    // test and makes the failure look like an ordering bug.
    await fireEvent.press(q.getByLabelText('Back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('omits it where there is nowhere to go', async () => {
    await scaffold({ back: false });
    expect(screen.queryByLabelText('Back')).toBeNull();
  });

  /**
   * Declared outright rather than relying on content height plus hitSlop,
   * because content height changes with the font and hitSlop does not show up
   * in a layout audit.
   */
  it('gives the back control a 44pt target', async () => {
    const q = await scaffold();
    expect(stylesOf(q.getByLabelText('Back')).minHeight).toBe(44);
  });

  it('places anything passed as `right` in the header', async () => {
    await scaffold({ right: <Text>Action</Text> });
    expect(screen.getByText('Action')).toBeTruthy();
  });

  /**
   * The rule the whole design rests on: leather is pinned, cream scrolls. A
   * scaffold that scrolled its header would break it on every screen at once.
   */
  it('scrolls the body, not the header', async () => {
    const q = await scaffold();
    expect(scrollersIn(q).length).toBeGreaterThan(0);

    // The title sits outside every scroller. Walk each one and confirm the
    // header text is not among its descendants.
    const textUnder = (node: Node): string[] => {
      const out: string[] = [];
      walk(node, (n) => {
        for (const c of n.children ?? []) if (typeof c === 'string') out.push(c);
      });
      return out;
    };

    for (const scroller of scrollersIn(q)) {
      expect(textUnder(scroller)).not.toContain('Protection');
    }
    // And the body text is.
    expect(scrollersIn(q).some((s) => textUnder(s).includes('Body'))).toBe(true);
  });

  it('can hold a body that must not scroll at all', async () => {
    const q = await wrap(
      <ScreenScaffold title="Cells" sub="24 in series" scroll={false}>
        <Text>Grid</Text>
      </ScreenScaffold>
    );
    expect(scrollersIn(q)).toHaveLength(0);
    expect(screen.getByText('Grid')).toBeTruthy();
  });
});

/**
 * An instrument that has stopped updating without saying so is more dangerous
 * than no instrument. This is the thing that says so.
 */
describe('the stale banner', () => {
  it('says nothing while the data is live', async () => {
    const q = await wrap(<StaleBanner freshness={freshness({ stale: false })} />);
    expect(q.toJSON()).toBeNull();
  });

  it('says the readings are not live once they are stale', async () => {
    await wrap(<StaleBanner freshness={freshness()} />);
    expect(screen.getByText(/No live data/)).toBeTruthy();
  });

  it('says how old they are', async () => {
    await wrap(<StaleBanner freshness={freshness({ ageLabel: '8 seconds' })} />);
    expect(screen.getByLabelText(/8 seconds old/)).toBeTruthy();
  });

  /** Never received is a different statement from went stale. */
  it('distinguishes never having received data from having lost it', async () => {
    await wrap(<StaleBanner freshness={freshness({ ageMs: Number.POSITIVE_INFINITY })} />);
    expect(screen.getByLabelText(/No telemetry received/)).toBeTruthy();
    expect(screen.queryByLabelText(/Live data lost/)).toBeNull();
  });

  it('announces itself as an alert rather than as decoration', async () => {
    const q = await wrap(<StaleBanner freshness={freshness()} />);
    expect(q.getByLabelText(/not live|old/).props.accessibilityRole).toBe('alert');
  });

  it('tells the reader what to do about it', async () => {
    await wrap(<StaleBanner freshness={freshness()} />);
    expect(screen.getByText(/Reconnect before acting on them/)).toBeTruthy();
  });

  /** Deliberately not dismissible: it stays until real data returns. */
  it('offers no way to dismiss it', async () => {
    const q = await wrap(
      <View>
        <StaleBanner freshness={freshness()} />
      </View>
    );
    expect(q.queryAllByRole('button')).toHaveLength(0);
  });
});

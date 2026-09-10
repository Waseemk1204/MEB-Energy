import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { PinPad } from '../src/ui/PinPad';
import { StepList } from '../src/ui/StepList';
import { PIN_DIGITS } from '../src/store/pin';

/**
 * Two components that had no tests, found by mutation rather than by reading:
 * every guard in `PinPad` could be removed and every step in `StepList` marked
 * complete, and the whole suite stayed green.
 */

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

/** Type a sequence, threading `value` the way a real caller does. */
const typeDigits = async (
  digits: string,
  onComplete?: (pin: string) => void,
  disabled = false
) => {
  let value = '';
  const q = await wrap(
    <PinPad value={value} onChange={(v) => (value = v)} onComplete={onComplete} disabled={disabled} />
  );

  for (const digit of digits) {
    await fireEvent.press(q.getByLabelText(digit));
    await q.rerender(
      <ThemeProvider>
        <PinPad
          value={value}
          onChange={(v) => (value = v)}
          onComplete={onComplete}
          disabled={disabled}
        />
      </ThemeProvider>
    );
  }
  return { q, value: () => value };
};

describe('entering a PIN', () => {
  it('offers every digit', async () => {
    const q = await wrap(<PinPad value="" onChange={() => undefined} />);
    for (const d of '0123456789') {
      expect(q.getByLabelText(d)).toBeTruthy();
    }
  });

  it('collects what was typed', async () => {
    const { value } = await typeDigits('1234');
    expect(value()).toBe('1234');
  });

  it('says how much of the PIN has been entered', async () => {
    const q = await wrap(<PinPad value="12" onChange={() => undefined} />);
    expect(q.getByLabelText(`2 of ${PIN_DIGITS} digits entered`)).toBeTruthy();
  });
});

/**
 * The guard that matters most. `onComplete` runs the PIN check, and a failed
 * check spends one of a small number of attempts — so firing it on every
 * keypress would lock a legitimate user out partway through typing their own
 * PIN. A weakened availability guarantee on a security control is still a
 * weakened security control.
 */
describe('when the PIN is considered complete', () => {
  it('does not fire before the full length is entered', async () => {
    const onComplete = jest.fn();
    await typeDigits('1'.repeat(PIN_DIGITS - 1), onComplete);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('fires exactly once, at the full length', async () => {
    const onComplete = jest.fn();
    await typeDigits('1'.repeat(PIN_DIGITS), onComplete);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('1'.repeat(PIN_DIGITS));
  });

  it('accepts no more digits once it is full', async () => {
    const onComplete = jest.fn();
    const { value } = await typeDigits('1'.repeat(PIN_DIGITS + 3), onComplete);

    expect(value()).toHaveLength(PIN_DIGITS);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

/**
 * Disabled while a check is in flight, and while the user is locked out. A pad
 * that keeps accepting input during either would queue attempts against a
 * counter that is already spent.
 */
describe('while disabled', () => {
  it('accepts nothing', async () => {
    const { value } = await typeDigits('123', undefined, true);
    expect(value()).toBe('');
  });

  it('never reports completion', async () => {
    const onComplete = jest.fn();
    await typeDigits('1'.repeat(PIN_DIGITS), onComplete, true);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('correcting a mistake', () => {
  it('offers a way to delete', async () => {
    const q = await wrap(<PinPad value="123" onChange={() => undefined} />);
    expect(q.getByLabelText('Delete')).toBeTruthy();
  });

  it('removes the last digit', async () => {
    let value = '123';
    const q = await wrap(<PinPad value={value} onChange={(v) => (value = v)} />);
    await fireEvent.press(q.getByLabelText('Delete'));
    expect(value).toBe('12');
  });

  it('does nothing when there is nothing to delete', async () => {
    let value = '';
    const q = await wrap(<PinPad value={value} onChange={(v) => (value = v)} />);
    await fireEvent.press(q.getByLabelText('Delete'));
    expect(value).toBe('');
  });

  /** Deleting must not re-fire the check on the way back down. */
  it('does not report completion on the way back down', async () => {
    const onComplete = jest.fn();
    let value = '1'.repeat(PIN_DIGITS);
    const q = await wrap(
      <PinPad value={value} onChange={(v) => (value = v)} onComplete={onComplete} />
    );
    await fireEvent.press(q.getByLabelText('Delete'));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/**
 * The connect sequence and the safe-write flow both use this, and both exist so
 * somebody can see *which* stage failed rather than only that something did.
 * Every step reading complete would defeat the entire reason for the component.
 */
describe('the step list', () => {
  const steps = [
    { label: 'Connect KnowyourEV device', done: true, active: false },
    { label: 'Authenticate device', done: false, active: true },
    { label: 'Detect BMS', done: false, active: false },
  ];

  const dotsOf = (q: Awaited<ReturnType<typeof wrap>>) => {
    const found: Record<string, unknown>[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n === 'string') return;
      const node = n as { children?: unknown[]; props?: { style?: unknown } };
      const style = Array.isArray(node.props?.style)
        ? Object.assign({}, ...node.props.style.filter(Boolean))
        : ((node.props?.style ?? {}) as Record<string, unknown>);
      // The step dots are the only round bordered views in this component.
      if (style.borderColor && style.borderRadius) found.push(style);
      for (const c of node.children ?? []) walk(c);
    };
    walk(q.toJSON());
    return found;
  };

  it('shows every step', async () => {
    await wrap(<StepList steps={steps} />);
    for (const s of steps) expect(screen.getByText(s.label)).toBeTruthy();
  });

  /**
   * A completed step is filled; a pending one is not. If they looked alike, a
   * failure at stage two would be indistinguishable from success.
   */
  it('distinguishes a completed step from a pending one', async () => {
    const q = await wrap(<StepList steps={steps} />);
    const dots = dotsOf(q);

    const filled = dots.filter((d) => d.backgroundColor !== 'transparent');
    const empty = dots.filter((d) => d.backgroundColor === 'transparent');

    expect(filled).toHaveLength(1);
    expect(empty).toHaveLength(2);
  });

  it('marks nothing complete when nothing is', async () => {
    const q = await wrap(
      <StepList steps={steps.map((s) => ({ ...s, done: false, active: false }))} />
    );
    expect(dotsOf(q).every((d) => d.backgroundColor === 'transparent')).toBe(true);
  });

  it('marks everything complete when everything is', async () => {
    const q = await wrap(<StepList steps={steps.map((s) => ({ ...s, done: true }))} />);
    expect(dotsOf(q).every((d) => d.backgroundColor !== 'transparent')).toBe(true);
  });

  it('gives the active step its own treatment, distinct from both', async () => {
    const q = await wrap(<StepList steps={steps} />);
    const borders = new Set(dotsOf(q).map((d) => d.borderColor));
    // done, active and pending are three different states, not two.
    expect(borders.size).toBe(3);
  });
});

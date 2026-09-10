import { Platform, StatusBar } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import { useBottomInset, useTopInset } from '../src/ui/safeArea';

/**
 * The top inset decides whether a screen's title sits below the status bar or
 * behind the clock. It is one number, and it is wrong in exactly one direction
 * that matters.
 */

// Prefixed `mock` so jest allows the factory below to close over it.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const setPlatform = (os: 'ios' | 'android') => {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
};

const setStatusBarHeight = (height: number | undefined) => {
  Object.defineProperty(StatusBar, 'currentHeight', {
    get: () => height,
    configurable: true,
  });
};

const topInset = async () => (await renderHook(() => useTopInset())).result.current;

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  setPlatform('ios');
  setStatusBarHeight(undefined);
});

describe('on iOS', () => {
  it('uses the inset, which already covers the notch', async () => {
    mockInsets = { ...mockInsets, top: 59 };
    expect(await topInset()).toBe(59);
  });

  /**
   * An iPhone SE has a status bar and no notch. Twenty is a real answer, not a
   * missing one, and must not be floored up to something taller.
   */
  it('keeps a short inset short', async () => {
    mockInsets = { ...mockInsets, top: 20 };
    expect(await topInset()).toBe(20);
  });

  /** currentHeight is Android-only; reading it on iOS must not leak in. */
  it('ignores a status bar height even if one is somehow present', async () => {
    mockInsets = { ...mockInsets, top: 44 };
    setStatusBarHeight(9999);
    expect(await topInset()).toBe(44);
  });
});

describe('on Android', () => {
  beforeEach(() => setPlatform('android'));

  /**
   * The failure this exists for: the window draws under the status bar while
   * the inset reports nothing, and the screen's title lands behind the clock.
   */
  it('falls back to the measured status bar when the inset is zero', async () => {
    mockInsets = { ...mockInsets, top: 0 };
    setStatusBarHeight(24);
    expect(await topInset()).toBe(24);
  });

  it('keeps the inset when it is the larger of the two', async () => {
    mockInsets = { ...mockInsets, top: 48 };
    setStatusBarHeight(24);
    expect(await topInset()).toBe(48);
  });

  /** Never shrink a correct inset down to the bar height. */
  it('does not reduce a tall inset to the status bar', async () => {
    mockInsets = { ...mockInsets, top: 30 };
    setStatusBarHeight(24);
    expect(await topInset()).toBe(30);
  });

  /**
   * A device genuinely without a top bar has a zero inset and reports zero.
   * The floor must not invent padding out of nothing.
   */
  it('stays at zero when there is nothing to clear', async () => {
    setStatusBarHeight(0);
    expect(await topInset()).toBe(0);
  });

  it('survives currentHeight being unavailable', async () => {
    mockInsets = { ...mockInsets, top: 31 };
    setStatusBarHeight(undefined);
    expect(await topInset()).toBe(31);
  });

  it('is zero rather than NaN when both are unavailable', async () => {
    setStatusBarHeight(undefined);
    expect(await topInset()).toBe(0);
  });
});

describe('the bottom edge', () => {
  it('reports the inset as given', async () => {
    mockInsets = { ...mockInsets, bottom: 34 };
    expect((await renderHook(() => useBottomInset())).result.current).toBe(34);
  });

  it('is zero on a device with no gesture bar', async () => {
    expect((await renderHook(() => useBottomInset())).result.current).toBe(0);
  });
});

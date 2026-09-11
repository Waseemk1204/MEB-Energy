import React, { createContext, useContext, useMemo } from 'react';
import { palette, type Palette, type ThemeMode } from './tokens';

/**
 * One theme: olive and white.
 *
 * There was a dark palette and an OS-scheme listener here. Both are gone
 * rather than left switched off -- a mode nothing selects is a mode nobody
 * looks at, and it would drift from the one that ships.
 *
 * `mode` survives so call sites read unchanged, and so that reintroducing a
 * second theme later is a change to this file rather than to every screen.
 */
type ThemeContextValue = {
  mode: ThemeMode;
  p: Palette;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<ThemeContextValue>(() => ({ mode: 'light', p: palette.light }), []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

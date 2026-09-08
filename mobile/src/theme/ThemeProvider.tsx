import React, { createContext, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { palette, type Palette, type ThemeMode } from './tokens';

type ThemeContextValue = {
  mode: ThemeMode;
  p: Palette;
  /** null = follow the OS. */
  override: ThemeMode | null;
  setOverride: (m: ThemeMode | null) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [override, setOverride] = useState<ThemeMode | null>(null);

  const mode: ThemeMode = override ?? (system === 'dark' ? 'dark' : 'light');

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      p: palette[mode] as Palette,
      override,
      setOverride,
      toggle: () => setOverride(mode === 'light' ? 'dark' : 'light'),
    }),
    [mode, override]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
